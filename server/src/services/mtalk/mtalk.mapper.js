// Traduz um ticket da API oficial do MTalk para o formato interno.
//
// A API entrega os campos ja separados (contact, queue, user, whatsapp, tags),
// entao aqui ha so normalizacao dos parametros monitorados — filas,
// atendentes, empresas, tags e o tempo de inatividade.

const { normalizeQueueName } = require("../queue-filter");
const { normalizeAttendantName } = require("../attendant-filter");
const { formatTime } = require("../time-zone");
const { EMPTY_CATALOG, collectTicketTagNames } = require("./mtalk.tags");

const MAX_INACTIVITY_MINUTES = 24 * 60;

// Devolve null quando o ticket esta fora das filas monitoradas.
//
// tagCatalog e contactTags vem do coletor: o catalogo de /tags/list resolve os
// vinculos que chegam so com o id, e contactTags carrega as TAGs do cliente
// quando a listagem de tickets nao as devolveu. panelUrl monta o link do ticket.
function mapApiTicket(apiTicket, { now = new Date(), tagCatalog = EMPTY_CATALOG, contactTags = [], panelUrl = "" } = {}) {
  const queue = normalizeQueueName(apiTicket?.queue?.name || "");
  if (!queue) {
    return null;
  }

  const externalTicketId = cleanText(apiTicket?.id, 40);
  if (!externalTicketId) {
    return null;
  }

  // TAG do atendimento E TAG do cliente: as duas tiram o ticket do alerta.
  const tags = collectTicketTagNames(apiTicket, tagCatalog, contactTags);
  const lastActivityAt = parseDate(apiTicket?.updatedAt) || parseDate(apiTicket?.createdAt);
  const ticketUuid = cleanText(apiTicket?.uuid, 60);

  return {
    externalTicketId,
    ticketUuid,
    ticketUrl: ticketUuid ? `${panelUrl}/tickets/${encodeURIComponent(ticketUuid)}` : `${panelUrl}/tickets`,
    ticketStatus: cleanText(apiTicket?.status, 20).toLowerCase(),
    clientName: cleanText(apiTicket?.contact?.name, 160),
    queue,
    attendant: cleanAttendant(apiTicket?.user?.name),
    company: cleanText(apiTicket?.whatsapp?.name, 120),
    displayTime: formatTime(lastActivityAt),
    lastMessageAt: lastActivityAt ? lastActivityAt.toISOString() : "",
    inactivityMinutes: calculateInactivityMinutes(lastActivityAt, now),
    unreadMessages: cleanNonNegativeInteger(apiTicket?.unreadMessages),
    tag: tags[0] || null,
    tags,
    tagStatus: tags.length ? "COM_TAG" : "SEM_TAG"
  };
}

// Um ticket aberto e um ticket pendente podem voltar nas duas consultas de
// status; o id resolve a duplicidade.
function dedupeApiTickets(apiTickets) {
  const seen = new Set();
  return apiTickets.filter((apiTicket) => {
    const id = cleanText(apiTicket?.id, 40);
    if (!id || seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

// A normalizacao unifica as variacoes ja conhecidas do mesmo atendente
// ("Alek", "Alek NETFIBRA" -> "Aleksandro").
function cleanAttendant(value) {
  const text = cleanText(value, 100);
  return text ? normalizeAttendantName(text).slice(0, 100) : "";
}

function calculateInactivityMinutes(lastActivityAt, now) {
  if (!lastActivityAt) {
    return null;
  }

  const diffMinutes = Math.floor((now.getTime() - lastActivityAt.getTime()) / 60000);
  if (!Number.isFinite(diffMinutes) || diffMinutes < 0) {
    return 0;
  }

  return Math.min(diffMinutes, MAX_INACTIVITY_MINUTES);
}

function parseDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cleanNonNegativeInteger(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

module.exports = {
  dedupeApiTickets,
  mapApiTicket
};
