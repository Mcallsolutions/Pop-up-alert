// Leitura incremental das mensagens dos tickets monitorados, para a analise de
// atendimento por IA. So roda com AI_ATTENDANCE_ANALYSIS=1.
//
// Roda depois de cada coleta gravada, fora do caminho dos alertas: a coleta nao
// espera por ela e uma falha aqui nunca derruba a coleta. Tem trava propria:
// se a leitura anterior ainda esta rodando, esta e pulada.
//
// Custo com teto: no maximo MTALK_MAX_MESSAGE_FETCHES GETs em
// /messages/{ticketId} por coleta, contados no diagnostico da propria coleta
// (requisicoesPorEndpoint). Ordem de prioridade:
//   1. tickets que sairam de open/pending desde a coleta anterior: uma busca
//      final (despedida, "obrigado") e depois closed_at;
//   2. tickets cujo updatedAt mudou, do mais antigo para o mais novo.
// Com cursor (last_message_updated_at) a busca pede so o que mudou
// (minUpdatedAt). Sem cursor, comeca pela pagina mais recente e nunca volta
// alem de AI_ANALYSIS_MAX_MESSAGES mensagens.
//
// Cada mensagem e mascarada ANTES de tocar o banco (mtalk.messages.js). Upsert
// por id: edicao e exclusao atualizam a linha.

const { getAttendanceConfig, getMtalkConfig } = require("../../config/monitoring");
const { getDatabase } = require("../../database");
const { toZonedIso } = require("../time-zone");
const { listMessages } = require("./mtalk.client");
const { mapApiMessage } = require("./mtalk.messages");

const ENDPOINT = "GET /messages/{ticketId}";
// Atendentes das leituras recentes, para o mascaramento trocar o nome deles
// por [ATENDENTE]. A consulta varre um dia de leituras: fica em cache.
const ATTENDANT_NAMES_TTL_MS = 30 * 60 * 1000;
const ATTENDANT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MAX_ATTENDANT_NAMES = 500;
// Ticket lido pela ultima vez ha menos que isso ainda esta em atendimento.
const RECENT_READING_MS = 10 * 60 * 1000;

let running = null;
let lastSync = null;
let attendantNames = { names: new Set(), expiresAt: 0 };

const UPSERT_MESSAGE_SQL = `
  INSERT INTO messages (
    id, ticket_id, from_me, sender_kind, attendant, media_type, body_masked, body_length,
    pii_found, flags, is_deleted, is_edited, created_at, updated_at, collected_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    media_type = excluded.media_type,
    body_masked = excluded.body_masked,
    body_length = excluded.body_length,
    pii_found = excluded.pii_found,
    flags = excluded.flags,
    is_deleted = excluded.is_deleted,
    is_edited = excluded.is_edited,
    updated_at = excluded.updated_at,
    collected_at = excluded.collected_at`;

// Chamado pela coleta, sem await. O contador do endpoint entra no diagnostico
// antes do primeiro await: a coleta que acabou de terminar ja mostra a chave.
function syncMessagesAfterCollection({ tickets = [], collectedAt, now = new Date(), diagnostics = null } = {}) {
  const config = getAttendanceConfig();
  if (!config.enabled) {
    return Promise.resolve(null);
  }

  if (diagnostics?.requisicoesPorEndpoint) {
    diagnostics.requisicoesPorEndpoint[ENDPOINT] = diagnostics.requisicoesPorEndpoint[ENDPOINT] || 0;
  }

  if (running) {
    return Promise.resolve({ pulada: true });
  }

  running = runSync({ tickets, collectedAt, now, diagnostics, config }).finally(() => {
    running = null;
  });
  return running;
}

async function runSync({ tickets, collectedAt, now, diagnostics, config }) {
  const stats = { inicio: new Date().toISOString(), requisicoes: 0, ticketsLidos: 0, mensagensGravadas: 0 };
  const budget = createBudget(config.maxMessageFetches, stats, diagnostics);

  try {
    const database = await getDatabase();
    const mtalkConfig = getMtalkConfig();
    const current = tickets.filter((ticket) => /^\d+$/.test(String(ticket?.externalTicketId || "")));
    rememberAttendants(current.map((ticket) => ticket.attendant));

    const syncRows = await markSeen(database, current, collectedAt);
    const gone = await database
      .prepare(
        `SELECT ticket_id AS "ticketId", last_message_updated_at AS cursor
         FROM message_sync
         WHERE closed_at IS NULL AND last_seen_at < ?
         ORDER BY last_seen_at`
      )
      .all(collectedAt);
    const changed = current
      .filter((ticket) => ticketChanged(ticket, syncRows.get(String(ticket.externalTicketId))))
      .sort((a, b) => Date.parse(a.lastMessageAt || 0) - Date.parse(b.lastMessageAt || 0));
    const names = await loadAttendantNames(database, now);

    // 1. Busca final de quem saiu da listagem.
    for (const row of gone) {
      if (!budget.left()) break;
      const info = await loadLatestReading(database, row.ticketId);
      const result = await fetchAndStore({
        database,
        mtalkConfig,
        config,
        ticketId: row.ticketId,
        cursor: row.cursor,
        clientName: info?.clientName || "",
        names,
        budget,
        collectedAt,
        stats
      });
      // Busca cortada pelo teto fica para a proxima coleta; erro do MTalk
      // naquele ticket fecha assim mesmo, para nao gastar o teto em loop.
      if (!result.complete && result.ok) break;
      await database
        .prepare("UPDATE message_sync SET closed_at = ?, last_message_updated_at = COALESCE(?, last_message_updated_at) WHERE ticket_id = ?")
        .run(collectedAt, result.cursor, row.ticketId);
    }

    // 2. Tickets que mudaram, do mais antigo para o mais novo.
    for (const ticket of changed) {
      if (!budget.left()) break;
      const ticketId = String(ticket.externalTicketId);
      const result = await fetchAndStore({
        database,
        mtalkConfig,
        config,
        ticketId,
        cursor: syncRows.get(ticketId)?.cursor || null,
        clientName: ticket.clientName || "",
        names,
        budget,
        collectedAt,
        stats
      });
      // Com erro, a mudanca e dada por vista do mesmo jeito: o cursor fica, e a
      // proxima mudanca do ticket busca tudo desde ele.
      await database
        .prepare(
          "UPDATE message_sync SET last_ticket_updated_at = ?, last_message_updated_at = COALESCE(?, last_message_updated_at) WHERE ticket_id = ?"
        )
        .run(zonedOrNull(ticket.lastMessageAt), result.cursor, ticketId);
    }

    lastSync = { ...stats, fim: new Date().toISOString(), ok: true, erro: null };
    return lastSync;
  } catch (error) {
    lastSync = { ...stats, fim: new Date().toISOString(), ok: false, erro: error.publicMessage || error.message };
    throw error;
  }
}

// Leitura avulsa de um ticket, pedida pela analise manual do painel. Usa o
// mesmo teto por chamada, fora da trava da coleta.
async function syncTicketMessages(ticketId, { now = new Date() } = {}) {
  const config = getAttendanceConfig();
  const database = await getDatabase();
  const id = String(ticketId);
  const collectedAt = toZonedIso(now);
  const stats = { inicio: now.toISOString(), requisicoes: 0, ticketsLidos: 0, mensagensGravadas: 0 };
  const budget = createBudget(config.maxMessageFetches, stats, null);

  const syncRow = await database
    .prepare(`SELECT ticket_id, last_message_updated_at AS cursor, closed_at AS "closedAt" FROM message_sync WHERE ticket_id = ?`)
    .get(id);
  const info = await loadLatestReading(database, id);
  const names = await loadAttendantNames(database, now);

  const result = budget.left()
    ? await fetchAndStore({
        database,
        mtalkConfig: getMtalkConfig(),
        config,
        ticketId: id,
        cursor: syncRow?.cursor || null,
        clientName: info?.clientName || "",
        names,
        budget,
        collectedAt,
        stats
      })
    : { ok: false, cursor: null };

  if (syncRow) {
    await database
      .prepare("UPDATE message_sync SET last_message_updated_at = COALESCE(?, last_message_updated_at) WHERE ticket_id = ?")
      .run(result.cursor, id);
  } else {
    // Ticket fora da listagem atual (ja fechado): entra ja com closed_at, para
    // a coleta nao gastar uma "busca final" com ele.
    const aberto = isRecentReading(info, now);
    await database
      .prepare("INSERT INTO message_sync (ticket_id, last_message_updated_at, last_seen_at, closed_at) VALUES (?, ?, ?, ?)")
      .run(id, result.cursor, aberto ? collectedAt : null, aberto ? null : collectedAt);
  }

  return { ...stats, ok: result.ok };
}

async function fetchAndStore({ database, mtalkConfig, config, ticketId, cursor, clientName, names, budget, collectedAt, stats }) {
  const collected = [];
  let nextId = null;
  let complete = true;
  const minUpdatedAt = cursor ? toUtcIso(cursor) : undefined;

  try {
    for (;;) {
      if (!budget.take()) {
        complete = false;
        break;
      }

      const page = await listMessages({ config: mtalkConfig, ticketId, minUpdatedAt, nextId });
      const own = page.messages.filter((message) => belongsToTicket(message, ticketId));
      collected.push(...own);

      // Pagina so com historico de outro ticket do mesmo contato: acabou.
      if (!page.hasMore || page.nextId === null || !own.length || collected.length >= config.maxMessages) {
        break;
      }
      nextId = page.nextId;
    }
  } catch (error) {
    // Token recusado derruba a etapa inteira; o resto e problema daquele ticket.
    if (error.sessionRejected || error.statusCode === 503) {
      throw error;
    }
    console.warn(`[Atendimento] Nao foi possivel ler as mensagens do ticket ${ticketId}:`, error.publicMessage || error.message);
    return { ok: false, complete: true, cursor: null };
  }

  stats.ticketsLidos += 1;
  const saved = await storeMessages(database, { ticketId, apiMessages: collected, clientName, names, collectedAt });
  stats.mensagensGravadas += saved.count;

  return { ok: true, complete, cursor: saved.maxUpdatedMs ? toZonedIso(new Date(saved.maxUpdatedMs)) : null };
}

async function storeMessages(database, { ticketId, apiMessages, clientName, names, collectedAt }) {
  if (!apiMessages.length) {
    return { count: 0, maxUpdatedMs: 0 };
  }

  const times = apiMessages.map((message) => Date.parse(message?.createdAt)).filter(Number.isFinite);
  const timeline = times.length ? await loadAttendantTimeline(database, ticketId, Math.min(...times), Math.max(...times)) : [];
  const attendantList = [...names];

  const rows = apiMessages
    .map((message) => mapApiMessage(message, { ticketId, clientName, attendantNames: attendantList, timeline, collectedAt }))
    .filter(Boolean)
    .sort((a, b) => a.createdMs - b.createdMs);

  await database.transaction(async (transaction) => {
    const upsert = transaction.prepare(UPSERT_MESSAGE_SQL);
    for (const row of rows) {
      await upsert.run(
        row.id,
        row.ticketId,
        row.fromMe,
        row.senderKind,
        row.attendant,
        row.mediaType,
        row.bodyMasked,
        row.bodyLength,
        JSON.stringify(row.piiFound || {}),
        JSON.stringify(row.flags || []),
        row.isDeleted,
        row.isEdited,
        row.createdAt,
        row.updatedAt,
        row.collectedAt
      );
    }
  });

  // O cursor considera tudo o que veio (inclusive reacao e historico
  // descartados): o que ja foi visto nao precisa voltar.
  const updatedTimes = apiMessages
    .map((message) => Date.parse(message?.updatedAt || message?.createdAt))
    .filter(Number.isFinite);

  return { count: rows.length, maxUpdatedMs: updatedTimes.length ? Math.max(...updatedTimes) : 0 };
}

// Marca os tickets da coleta como vistos agora (e reabre quem tinha fechado) e
// devolve o cursor de cada um.
async function markSeen(database, tickets, collectedAt) {
  const ids = [...new Set(tickets.map((ticket) => String(ticket.externalTicketId)))];
  const rows = new Map();
  if (!ids.length) {
    return rows;
  }

  await database.transaction(async (transaction) => {
    const upsert = transaction.prepare(
      `INSERT INTO message_sync (ticket_id, last_seen_at) VALUES (?, ?)
       ON CONFLICT(ticket_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, closed_at = NULL`
    );
    for (const id of ids) {
      await upsert.run(id, collectedAt);
    }
  });

  const found = await database
    .prepare(
      `SELECT ticket_id AS "ticketId", last_ticket_updated_at AS "ticketUpdatedAt", last_message_updated_at AS cursor
       FROM message_sync
       WHERE ticket_id IN (${ids.map(() => "?").join(", ")})`
    )
    .all(...ids);

  for (const row of found) {
    rows.set(String(row.ticketId), row);
  }
  return rows;
}

function ticketChanged(ticket, syncRow) {
  if (!syncRow?.ticketUpdatedAt) {
    return true;
  }
  const current = zonedOrNull(ticket.lastMessageAt);
  return Boolean(current) && current !== syncRow.ticketUpdatedAt;
}

// Leituras do ticket em volta das mensagens: a ultima antes da primeira
// mensagem e todas ate a ultima. As linhas repetidas (mesmo atendente) viram
// uma so.
async function loadAttendantTimeline(database, ticketId, fromMs, toMs) {
  const from = toZonedIso(new Date(fromMs));
  const to = toZonedIso(new Date(toMs));

  const before = await database
    .prepare(
      `SELECT collected_at AS at, trim(coalesce(attendant, '')) AS attendant
       FROM tickets
       WHERE external_ticket_id = ? AND collected_at <= ?
       ORDER BY collected_at DESC, id DESC
       LIMIT 1`
    )
    .get(ticketId, from);
  const during = await database
    .prepare(
      `SELECT collected_at AS at, trim(coalesce(attendant, '')) AS attendant
       FROM tickets
       WHERE external_ticket_id = ? AND collected_at > ? AND collected_at <= ?
       ORDER BY collected_at, id`
    )
    .all(ticketId, from, to);

  const timeline = [];
  for (const row of before ? [before, ...during] : during) {
    const at = Date.parse(row.at);
    if (!Number.isFinite(at)) continue;
    if (!timeline.length || timeline[timeline.length - 1].attendant !== row.attendant) {
      timeline.push({ at, attendant: row.attendant });
    }
  }
  return timeline;
}

async function loadLatestReading(database, ticketId) {
  return database
    .prepare(
      `SELECT trim(coalesce(client_name, '')) AS "clientName", queue_name AS queue, trim(coalesce(attendant, '')) AS attendant,
              company, ticket_uuid AS "ticketUuid", ticket_status AS "ticketStatus", collected_at AS "collectedAt"
       FROM tickets
       WHERE external_ticket_id = ?
       ORDER BY collected_at DESC, id DESC
       LIMIT 1`
    )
    .get(String(ticketId));
}

function isRecentReading(reading, now = new Date()) {
  const at = Date.parse(reading?.collectedAt || "");
  return Number.isFinite(at) && now.getTime() - at <= RECENT_READING_MS;
}

async function loadAttendantNames(database, now) {
  if (attendantNames.expiresAt > now.getTime()) {
    return attendantNames.names;
  }

  const rows = await database
    .prepare(
      `SELECT DISTINCT trim(attendant) AS attendant
       FROM tickets
       WHERE collected_at >= ? AND trim(coalesce(attendant, '')) <> ''
       LIMIT ${MAX_ATTENDANT_NAMES}`
    )
    .all(toZonedIso(new Date(now.getTime() - ATTENDANT_LOOKBACK_MS)));

  rememberAttendants(rows.map((row) => row.attendant));
  attendantNames.expiresAt = now.getTime() + ATTENDANT_NAMES_TTL_MS;
  return attendantNames.names;
}

function rememberAttendants(values) {
  for (const value of values) {
    const name = String(value || "").trim();
    if (name && attendantNames.names.size < MAX_ATTENDANT_NAMES) {
      attendantNames.names.add(name);
    }
  }
}

// Teto de GETs: cada chamada conta, com ou sem sucesso, como no resto da coleta.
function createBudget(limit, stats, diagnostics) {
  let used = 0;
  return {
    left: () => used < limit,
    take() {
      if (used >= limit) {
        return false;
      }
      used += 1;
      stats.requisicoes += 1;
      if (diagnostics?.requisicoesPorEndpoint) {
        diagnostics.requisicoesPorEndpoint[ENDPOINT] = (diagnostics.requisicoesPorEndpoint[ENDPOINT] || 0) + 1;
        diagnostics.requisicoes = Number(diagnostics.requisicoes || 0) + 1;
      }
      return true;
    }
  };
}

function belongsToTicket(message, ticketId) {
  return message?.ticketId === undefined || message?.ticketId === null || String(message.ticketId) === String(ticketId);
}

// O cursor e gravado no fuso da operacao, como as outras datas; ao MTalk ele
// volta em UTC. toZonedIso corta os milissegundos, entao a ultima mensagem
// pode vir de novo — o upsert absorve.
function toUtcIso(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function zonedOrNull(value) {
  const date = new Date(value || "");
  return value && !Number.isNaN(date.getTime()) ? toZonedIso(date) : null;
}

function describeMessageSync() {
  return { emAndamento: Boolean(running), ultima: lastSync };
}

// Para os testes: espera a leitura em andamento, se houver.
function waitForMessageSync() {
  return running ? running.catch(() => undefined) : Promise.resolve();
}

module.exports = {
  describeMessageSync,
  isRecentReading,
  loadLatestReading,
  syncMessagesAfterCollection,
  syncTicketMessages,
  waitForMessageSync
};
