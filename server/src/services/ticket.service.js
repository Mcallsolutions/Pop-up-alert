const { getDatabase } = require("../database");
const { normalizeQueueName } = require("./queue-filter");
const { isKnownAttendant, normalizeAttendantName, sanitizeClientName } = require("./attendant-filter");

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
        client_name,
        queue_name,
        attendant,
        company,
        display_time,
        inactivity_minutes,
        tag,
        tag_status,
        source_url,
        collected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        ticket.clientName,
        ticket.queue,
        ticket.attendant,
        ticket.company,
        ticket.displayTime,
        ticket.inactivityMinutes,
        ticket.tag,
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

  if (!url || !/^https:\/\/s11\.mtalk\.com\.br\/tickets/i.test(url)) {
    throwValidation("URL de origem invalida");
  }

  if (!collectedAt || Number.isNaN(new Date(collectedAt).getTime())) {
    throwValidation("Data de coleta invalida");
  }

  if (!Array.isArray(payload.tickets)) {
    throwValidation("Lista de tickets invalida");
  }

  if (payload.tickets.length > 200) {
    throwValidation("Snapshot excede o limite de 200 tickets");
  }

  return {
    source,
    url,
    collectedAt,
    tickets: uniqueTickets(payload.tickets.map(validateTicket).filter((ticket) => ticket.queue))
  };
}

function validateTicket(ticket) {
  const tag = cleanText(ticket?.tag, 120) || null;
  const queue = normalizeQueueName(ticket?.queue);

  const normalizedTicket = {
    clientName: cleanClientName(ticket?.clientName),
    queue,
    attendant: cleanAttendantName(ticket?.attendant),
    company: cleanText(ticket?.company, 120),
    displayTime: cleanText(ticket?.displayTime, 20),
    inactivityMinutes: cleanInactivityMinutes(ticket?.inactivityMinutes),
    tag,
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

function buildTicketKey(ticket) {
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
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanClientName(value) {
  return sanitizeClientName(cleanText(value, 160));
}

function cleanAttendantName(value) {
  const text = cleanText(value, 100);
  if (!text || !isKnownAttendant(text)) return "";
  return normalizeAttendantName(text).slice(0, 100);
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
