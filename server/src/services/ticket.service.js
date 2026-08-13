const { getDatabase } = require("../database");
const { MAX_TICKETS_PER_SNAPSHOT, getMtalkConfig } = require("../config/monitoring");
const { normalizeQueueName } = require("./queue-filter");
const { isKnownAttendant, normalizeAttendantName, sanitizeClientName } = require("./attendant-filter");

// Origem "mtalk-api": dados vindos da API oficial, com cada campo em sua
// propria propriedade. Origem "mtalk": leitura de tela (legado), onde tudo saia
// de texto solto e precisava passar pelas heuristicas de limpeza.
const API_SOURCE = "mtalk-api";

async function saveSnapshot(payload) {
  const snapshot = validateSnapshotPayload(payload);
  const totals = snapshot.tickets.reduce(
    (acc, ticket) => {
      if (ticket.tagStatus === "COM_TAG") {
        acc.withTag += 1;
      } else {
        acc.withoutTag += 1;
      }
      return acc;
    },
    { withTag: 0, withoutTag: 0 }
  );

  const database = await getDatabase();
  const snapshotId = await database.transaction(async (transaction) => {
    const insertSnapshot = transaction.prepare(`
      INSERT INTO snapshots (
        source,
        source_url,
        collected_at,
        total_tickets,
        total_with_tag,
        total_without_tag
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertTicket = transaction.prepare(`
      INSERT INTO tickets (
        snapshot_id,
        ticket_key,
        external_ticket_id,
        ticket_uuid,
        ticket_status,
        client_name,
        queue_name,
        attendant,
        company,
        display_time,
        last_message_at,
        unread_messages,
        inactivity_minutes,
        tag,
        tags,
        tag_status,
        source_url,
        collected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = await insertSnapshot.run(
      snapshot.source,
      snapshot.url,
      snapshot.collectedAt,
      snapshot.tickets.length,
      totals.withTag,
      totals.withoutTag,
      { returning: "id" }
    );

    for (const ticket of snapshot.tickets) {
      await insertTicket.run(
        result.lastInsertRowid,
        ticket.ticketKey,
        ticket.externalTicketId,
        ticket.ticketUuid,
        ticket.ticketStatus,
        ticket.clientName,
        ticket.queue,
        ticket.attendant,
        ticket.company,
        ticket.displayTime,
        ticket.lastMessageAt,
        ticket.unreadMessages,
        ticket.inactivityMinutes,
        ticket.tag,
        ticket.tags,
        ticket.tagStatus,
        snapshot.url,
        snapshot.collectedAt
      );
    }
    return result.lastInsertRowid;
  });

  return {
    id: snapshotId,
    totalTickets: snapshot.tickets.length,
    totalWithTag: totals.withTag,
    totalWithoutTag: totals.withoutTag
  };
}

function validateSnapshotPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throwValidation("Payload invalido");
  }

  const source = cleanText(payload.source || "mtalk", 40);
  const url = cleanText(payload.url, 500);
  const collectedAt = cleanText(payload.collectedAt, 40);

  if (!isMtalkUrl(url)) {
    throwValidation("URL de origem invalida");
  }

  if (!collectedAt || Number.isNaN(new Date(collectedAt).getTime())) {
    throwValidation("Data de coleta invalida");
  }

  if (!Array.isArray(payload.tickets)) {
    throwValidation("Lista de tickets invalida");
  }

  if (payload.tickets.length > MAX_TICKETS_PER_SNAPSHOT) {
    throwValidation(`Snapshot excede o limite de ${MAX_TICKETS_PER_SNAPSHOT} tickets`);
  }

  const fromApi = source === API_SOURCE;

  return {
    source,
    url,
    collectedAt,
    tickets: uniqueTickets(payload.tickets.map((ticket) => validateTicket(ticket, fromApi)).filter((ticket) => ticket.queue))
  };
}

// A URL identifica a tela de tickets da instancia monitorada. O host sai da
// configuracao para que uma instancia diferente de MTALK_BASE_URL nao precise
// de alteracao de codigo.
function isMtalkUrl(url) {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    const expected = new URL(getMtalkConfig().panelUrl);
    return parsed.protocol === "https:" && parsed.host === expected.host && parsed.pathname.startsWith("/tickets");
  } catch (_error) {
    return false;
  }
}

function validateTicket(ticket, fromApi) {
  const tags = cleanTags(ticket?.tags);
  const tag = cleanText(ticket?.tag, 120) || tags[0] || null;
  const queue = normalizeQueueName(ticket?.queue);

  const normalizedTicket = {
    externalTicketId: cleanText(ticket?.externalTicketId, 40) || null,
    ticketUuid: cleanText(ticket?.ticketUuid, 60) || null,
    ticketStatus: cleanText(ticket?.ticketStatus, 20).toLowerCase() || null,
    clientName: cleanClientName(ticket?.clientName, fromApi),
    queue,
    attendant: cleanAttendantName(ticket?.attendant, fromApi),
    company: cleanText(ticket?.company, 120),
    displayTime: cleanText(ticket?.displayTime, 20),
    lastMessageAt: cleanIsoDate(ticket?.lastMessageAt),
    unreadMessages: cleanInteger(ticket?.unreadMessages, 0, 9999),
    inactivityMinutes: cleanInactivityMinutes(ticket?.inactivityMinutes),
    tag,
    tags: tags.length ? tags.join(" | ").slice(0, 500) : null,
    tagStatus: tag ? "COM_TAG" : "SEM_TAG"
  };

  return {
    ...normalizedTicket,
    ticketKey: buildTicketKey(normalizedTicket)
  };
}

function uniqueTickets(tickets) {
  const seen = new Set();
  return tickets.filter((ticket) => {
    if (seen.has(ticket.ticketKey)) {
      return false;
    }
    seen.add(ticket.ticketKey);
    return true;
  });
}

// Com o id da API a chave e exata. Sem ele (leitura de tela antiga) continua
// valendo a combinacao de cliente, fila, atendente, empresa e horario.
function buildTicketKey(ticket) {
  if (ticket.externalTicketId) {
    return `mtalk:${ticket.externalTicketId}`;
  }

  return [ticket.clientName, ticket.queue, ticket.attendant, ticket.company, ticket.displayTime]
    .map((part) => normalizeKeyPart(part))
    .join("|");
}

function normalizeKeyPart(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanTags(value) {
  const list = Array.isArray(value) ? value : String(value || "").split("|");
  return list
    .map((tag) => cleanText(typeof tag === "string" ? tag : tag?.name, 120))
    .filter(Boolean)
    .filter((tag, index, tagList) => tagList.indexOf(tag) === index)
    .slice(0, 10);
}

// contact.name vem do cadastro do contato, entao nao passa pelas heuristicas
// que existiam para separar nome de cliente do resto do texto da tela.
function cleanClientName(value, fromApi) {
  const text = cleanText(value, 160);
  return fromApi ? text : sanitizeClientName(text);
}

// Idem para o atendente: user.name e o cadastro do usuario. A normalizacao
// segue valendo para unificar as variacoes conhecidas do mesmo atendente.
function cleanAttendantName(value, fromApi) {
  const text = cleanText(value, 100);
  if (!text) return "";
  if (!fromApi && !isKnownAttendant(text)) return "";
  return normalizeAttendantName(text).slice(0, 100);
}

function cleanIsoDate(value) {
  const text = cleanText(value, 40);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function cleanInteger(value, min, max) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(parsed, min), max);
}

function cleanInactivityMinutes(value) {
  if (value === null || value === undefined || value === "") return null;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  return Math.min(Math.floor(minutes), 24 * 60);
}

function throwValidation(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.publicMessage = message;
  throw error;
}

module.exports = {
  saveSnapshot
};
