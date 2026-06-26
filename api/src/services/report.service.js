const { getDatabase } = require("../database");
const { getAllowedQueues } = require("./queue-filter");
const { getKnownAttendants, isKnownAttendant, normalizeAttendantName } = require("./attendant-filter");

const SANITIZED_CLIENT_KEY_SQL = `
  CASE
    WHEN client_name IS NULL OR trim(client_name) = '' THEN ''
    WHEN UPPER(TRIM(client_name)) IN (
      'STEPHANIE',
      'GABRIEL OLIVEIRA',
      'GABRIELL CARVALHO',
      'GUILHERME GOMES',
      'LUIS',
      'ALL',
      'ABERTO',
      'FECHADO',
      'PENDENTE',
      'RESOLVIDO',
      'ATENDENTE',
      'CLIENTE',
      'FILA',
      'TAG',
      'TAGS',
      'NAO IDENTIFICADO',
      'NãO IDENTIFICADO',
      'NÃO IDENTIFICADO',
      'CLIENTE NAO IDENTIFICADO',
      'CLIENTE NãO IDENTIFICADO',
      'CLIENTE NÃO IDENTIFICADO'
    ) THEN ''
    WHEN UPPER(TRIM(client_name)) LIKE 'SUPORTE-%' THEN ''
    WHEN UPPER(TRIM(client_name)) LIKE 'NETFIBRA%' THEN ''
    WHEN UPPER(TRIM(client_name)) LIKE 'MIX%' THEN ''
    WHEN UPPER(TRIM(client_name)) LIKE 'IDEZ%' THEN ''
    WHEN UPPER(TRIM(client_name)) LIKE 'TERRA%' THEN ''
    WHEN UPPER(TRIM(client_name)) LIKE 'PLANET%' THEN ''
    ELSE lower(trim(client_name))
  END
`;

const TICKET_KEY_SQL = `
  CASE
    WHEN (${SANITIZED_CLIENT_KEY_SQL}) = ''
      AND trim(coalesce(attendant, '')) = ''
      AND trim(coalesce(company, '')) = ''
      AND trim(coalesce(source_url, '')) LIKE 'https://s11.mtalk.com.br/tickets/%'
      AND length(trim(coalesce(source_url, ''))) > length('https://s11.mtalk.com.br/tickets/')
    THEN
      lower(trim(coalesce(source_url, ''))) || '|' ||
      lower(trim(coalesce(queue_name, '')))
    ELSE
      ${SANITIZED_CLIENT_KEY_SQL} || '|' ||
      lower(trim(coalesce(queue_name, ''))) || '|' ||
      lower(trim(coalesce(attendant, ''))) || '|' ||
      lower(trim(coalesce(company, ''))) || '|' ||
      lower(trim(coalesce(display_time, '')))
  END
`;

function getSummary() {
  const database = getDatabase();
  const { where, params } = buildTicketFilters();
  const readings = database.prepare(`SELECT COUNT(DISTINCT snapshot_id) AS totalReadings FROM tickets ${where}`).get(...params);
  const row = database
    .prepare(
      `
      WITH filtered AS (
        SELECT *, ${TICKET_KEY_SQL} AS dedupeKey
        FROM tickets
        ${where}
      ),
      ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY dedupeKey
            ORDER BY datetime(collected_at) DESC, id DESC
          ) AS rowNumber
        FROM filtered
      )
      SELECT
        COUNT(*) AS totalTicketsProcessed,
        SUM(CASE WHEN tag_status = 'COM_TAG' THEN 1 ELSE 0 END) AS totalWithTag,
        SUM(CASE WHEN tag_status = 'SEM_TAG' THEN 1 ELSE 0 END) AS totalWithoutTag,
        MAX(collected_at) AS lastCollectedAt
      FROM ranked
      WHERE rowNumber = 1
    `
    )
    .get(...params);

  const totalTicketsProcessed = Number(row.totalTicketsProcessed || 0);
  const totalWithTag = Number(row.totalWithTag || 0);
  const compliancePercent = totalTicketsProcessed ? Number(((totalWithTag / totalTicketsProcessed) * 100).toFixed(2)) : 0;

  return {
    totalReadings: Number(readings.totalReadings || 0),
    totalTicketsProcessed,
    totalWithTag,
    totalWithoutTag: Number(row.totalWithoutTag || 0),
    compliancePercent,
    lastCollectedAt: row.lastCollectedAt || null
  };
}

function getMissingTags(filters = {}) {
  const { where, params } = buildTicketFilters(filters);
  const limit = Math.min(Number(filters.limit || 500), 1000);
  const rows = getDatabase()
    .prepare(
      `
      WITH filtered AS (
        SELECT *, ${TICKET_KEY_SQL} AS dedupeKey
        FROM tickets
        ${where}
      ),
      ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY dedupeKey
            ORDER BY datetime(collected_at) DESC, id DESC
          ) AS rowNumber
        FROM filtered
      )
      SELECT
        id,
        snapshot_id AS snapshotId,
        client_name AS clientName,
        queue_name AS queue,
        attendant,
        company,
        display_time AS displayTime,
        tag,
        tag_status AS tagStatus,
        source_url AS url,
        collected_at AS collectedAt
      FROM ranked
      WHERE rowNumber = 1
        AND tag_status = 'SEM_TAG'
      ORDER BY datetime(collected_at) DESC, id DESC
      LIMIT ?
    `
    )
    .all(...params, limit);

  return { items: rows.map(sanitizeTicketRow) };
}

function getReportByAttendant(filters = {}) {
  const { where, params } = buildTicketFilters(filters);
  const caseSql = buildAttendantCaseSql();
  const rows = getDatabase()
    .prepare(
      `
      WITH filtered AS (
        SELECT *, ${TICKET_KEY_SQL} AS dedupeKey
        FROM tickets
        ${where}
      ),
      ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY dedupeKey
            ORDER BY datetime(collected_at) DESC, id DESC
          ) AS rowNumber
        FROM filtered
      ),
      normalized AS (
        SELECT
          *,
          ${caseSql} AS normalizedAttendant
        FROM ranked
        WHERE rowNumber = 1
      )
      SELECT
        normalizedAttendant AS attendant,
        COUNT(*) AS totalTickets,
        SUM(CASE WHEN tag_status = 'COM_TAG' THEN 1 ELSE 0 END) AS totalWithTag,
        SUM(CASE WHEN tag_status = 'SEM_TAG' THEN 1 ELSE 0 END) AS totalWithoutTag
      FROM normalized
      WHERE normalizedAttendant <> ''
      GROUP BY normalizedAttendant
      ORDER BY totalWithoutTag DESC, totalTickets DESC
    `
    )
    .all(...params);

  return { items: rows.map(withFailurePercent) };
}

function getReportByQueue(filters = {}) {
  const { where, params } = buildTicketFilters(filters);
  const rows = getDatabase()
    .prepare(
      `
      WITH filtered AS (
        SELECT *, ${TICKET_KEY_SQL} AS dedupeKey
        FROM tickets
        ${where}
      ),
      ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY dedupeKey
            ORDER BY datetime(collected_at) DESC, id DESC
          ) AS rowNumber
        FROM filtered
      )
      SELECT
        COALESCE(NULLIF(queue_name, ''), 'Nao identificada') AS queue,
        COUNT(*) AS totalTickets,
        SUM(CASE WHEN tag_status = 'COM_TAG' THEN 1 ELSE 0 END) AS totalWithTag,
        SUM(CASE WHEN tag_status = 'SEM_TAG' THEN 1 ELSE 0 END) AS totalWithoutTag
      FROM ranked
      WHERE rowNumber = 1
      GROUP BY COALESCE(NULLIF(queue_name, ''), 'Nao identificada')
      ORDER BY totalWithoutTag DESC, totalTickets DESC
    `
    )
    .all(...params);

  return { items: rows.map(withFailurePercent) };
}

function buildTicketFilters(filters = {}, initialWhere = "") {
  const conditions = [];
  const params = [];
  const allowedQueues = getAllowedQueues();

  conditions.push(`queue_name IN (${allowedQueues.map(() => "?").join(", ")})`);
  params.push(...allowedQueues);

  if (initialWhere) {
    conditions.push(initialWhere.replace(/^WHERE\s+/i, ""));
  }

  if (filters.startDate) {
    conditions.push("datetime(collected_at) >= datetime(?)");
    params.push(filters.startDate);
  }

  if (filters.endDate) {
    conditions.push("datetime(collected_at) <= datetime(?)");
    params.push(filters.endDate);
  }

  addLikeFilter(conditions, params, "attendant", filters.attendant);
  addLikeFilter(conditions, params, "queue_name", filters.queue);
  addLikeFilter(conditions, params, "company", filters.company);
  addLikeFilter(conditions, params, "client_name", filters.clientName);

  return {
    where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    params
  };
}

function addLikeFilter(conditions, params, column, value) {
  const cleanValue = String(value || "").trim();
  if (!cleanValue) {
    return;
  }
  conditions.push(`${column} LIKE ?`);
  params.push(`%${cleanValue}%`);
}

function sanitizeTicketRow(row) {
  return {
    ...row,
    clientName: sanitizeClientName(row.clientName),
    attendant: sanitizeAttendantName(row.attendant)
  };
}

function buildAttendantCaseSql() {
  const knownAttendants = getKnownAttendants();
  if (!knownAttendants.length) {
    return "''";
  }

  const clauses = knownAttendants
    .map((name) => {
      const canonical = escapeSqlLiteral(name);
      const upper = escapeSqlLiteral(name.toUpperCase());
      const companyClauses = ["NETFIBRA", "MIX", "IDEZ", "TERRA", "PLANET"]
        .map((prefix) => {
          const escapedPrefix = escapeSqlLiteral(prefix);
          return `OR UPPER(TRIM(attendant)) LIKE '${upper}${escapedPrefix}%' OR UPPER(TRIM(attendant)) LIKE '${upper} ${escapedPrefix}%'`;
        })
        .join(" ");
      return `WHEN UPPER(TRIM(attendant)) = '${upper}' ${companyClauses} THEN '${canonical}'`;
    })
    .join(" ");
  return `CASE ${clauses} ELSE '' END`;
}

function escapeSqlLiteral(value) {
  return String(value || "").replace(/'/g, "''");
}

function sanitizeClientName(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (isKnownAttendant(text)) return "";
  if (/^Suporte\s*-/i.test(text)) return "";
  if (/^(NETFIBRA|MIX|IDEZ|TERRA|PLANET)\b/i.test(text)) return "";
  if (/^(All|Aberto|Fechado|Pendente|Resolvido|Atendente|Cliente|Fila|Tags?|N[aãÃ]o identificado|Cliente n[aãÃ]o identificado)$/i.test(text)) {
    return "";
  }
  if (/[.!?]/.test(text) && calculateUppercaseRatio(text) < 0.7) return "";
  if (/[a-z]{2,}\s+[a-z]{2,}/.test(text) && calculateUppercaseRatio(text) < 0.55) return "";
  return text;
}

function sanitizeAttendantName(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || !isKnownAttendant(text)) return "";
  return normalizeAttendantName(text);
}

function calculateUppercaseRatio(text) {
  const letters = Array.from(String(text || "")).filter((char) => /[A-Za-z]/.test(char));
  if (!letters.length) return 0;
  const upper = letters.filter((char) => char === char.toUpperCase() && char !== char.toLowerCase()).length;
  return upper / letters.length;
}

function withFailurePercent(row) {
  const totalTickets = Number(row.totalTickets || 0);
  const totalWithoutTag = Number(row.totalWithoutTag || 0);
  return {
    ...row,
    totalTickets,
    totalWithTag: Number(row.totalWithTag || 0),
    totalWithoutTag,
    failurePercent: totalTickets ? Number(((totalWithoutTag / totalTickets) * 100).toFixed(2)) : 0
  };
}

module.exports = {
  getSummary,
  getMissingTags,
  getReportByAttendant,
  getReportByQueue
};
