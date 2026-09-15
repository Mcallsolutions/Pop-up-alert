const { getDatabase } = require("../database");
const { MAX_TICKETS_PER_SNAPSHOT } = require("../config/monitoring");

// Grava uma coleta feita pelo proprio servidor na API do MTalk. Os tickets ja
// chegam mapeados por mtalk.mapper, entao aqui ficam so a gravacao e os tetos
// de tamanho de cada campo.
async function saveSnapshot({ source = "mtalk-api", url, collectedAt, tickets }) {
  if (!Array.isArray(tickets)) {
    throw new Error("Lista de tickets invalida");
  }

  const rows = tickets.slice(0, MAX_TICKETS_PER_SNAPSHOT).map(toRow);
  const totalWithTag = rows.filter((row) => row.tagStatus === "COM_TAG").length;
  const totals = {
    totalTickets: rows.length,
    totalWithTag,
    totalWithoutTag: rows.length - totalWithTag
  };

  const database = await getDatabase();
  const snapshotId = await database.transaction(async (transaction) => {
    const result = await transaction
      .prepare(
        `INSERT INTO snapshots (source, source_url, collected_at, total_tickets, total_with_tag, total_without_tag)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(source, url, collectedAt, totals.totalTickets, totals.totalWithTag, totals.totalWithoutTag);

    const insertTicket = transaction.prepare(`
      INSERT INTO tickets (
        snapshot_id,
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const row of rows) {
      await insertTicket.run(
        result.lastInsertRowid,
        row.externalTicketId,
        row.ticketUuid,
        row.ticketStatus,
        row.clientName,
        row.queue,
        row.attendant,
        row.company,
        row.displayTime,
        row.lastMessageAt,
        row.unreadMessages,
        row.inactivityMinutes,
        row.tag,
        row.tags,
        row.tagStatus,
        row.ticketUrl || url,
        collectedAt
      );
    }

    return result.lastInsertRowid;
  });

  return { id: snapshotId, ...totals };
}

function toRow(ticket) {
  const tags = (Array.isArray(ticket.tags) ? ticket.tags : [])
    .map((tag) => cleanText(tag, 120))
    .filter(Boolean)
    .slice(0, 10);

  return {
    externalTicketId: cleanText(ticket.externalTicketId, 40),
    ticketUuid: cleanText(ticket.ticketUuid, 60) || null,
    ticketStatus: cleanText(ticket.ticketStatus, 20) || null,
    clientName: cleanText(ticket.clientName, 160),
    queue: cleanText(ticket.queue, 60),
    attendant: cleanText(ticket.attendant, 100),
    company: cleanText(ticket.company, 120),
    displayTime: cleanText(ticket.displayTime, 20),
    lastMessageAt: cleanText(ticket.lastMessageAt, 40) || null,
    unreadMessages: Number.isFinite(ticket.unreadMessages) ? ticket.unreadMessages : null,
    inactivityMinutes: Number.isFinite(ticket.inactivityMinutes) ? ticket.inactivityMinutes : null,
    tag: tags[0] || null,
    tags: tags.length ? tags.join(" | ").slice(0, 500) : null,
    tagStatus: tags.length ? "COM_TAG" : "SEM_TAG",
    ticketUrl: cleanText(ticket.ticketUrl, 500)
  };
}

function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

module.exports = {
  saveSnapshot
};
