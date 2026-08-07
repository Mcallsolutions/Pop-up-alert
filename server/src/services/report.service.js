const { getDatabase } = require("../database");
const { getAllowedQueues } = require("./queue-filter");
const { getKnownAttendants, isKnownAttendant, normalizeAttendantName } = require("./attendant-filter");

const INACTIVITY_THRESHOLD_MINUTES = 15;

// Mesma limpeza aplicada na escrita (ticket.service), porem em SQL: descarta
// nomes que na verdade sao atendente, empresa ou rotulo da tela do MTalk.
const SANITIZED_CLIENT_NAME_SQL = `
  CASE
    WHEN client_name IS NULL OR trim(client_name) = '' THEN ''
    WHEN UPPER(TRIM(client_name)) IN (
      'STEPHANIE',
      'GABRIEL OLIVEIRA',
      'GABRIELL CARVALHO',
      'GUILHERME GOMES',
      'LUIS',
      'ALEK',
      'ALEKSANDRO',
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
    ELSE trim(client_name)
  END
`;

const SANITIZED_CLIENT_KEY_SQL = `lower(${SANITIZED_CLIENT_NAME_SQL})`;

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

const REPORT_DEDUPE_KEY_SQL = `
  CASE
    WHEN (${SANITIZED_CLIENT_KEY_SQL}) <> ''
    THEN 'client|' || ${SANITIZED_CLIENT_KEY_SQL}
    ELSE ${TICKET_KEY_SQL}
  END
`;

// Um ticket so entra nos relatorios de lista quando os cinco campos que o
// identificam foram lidos. Sem isso a tela mostra linhas em que apenas a fila
// foi reconhecida e todo o resto vira "-".
const COMPLETE_TICKET_SQL = `(
  (${SANITIZED_CLIENT_NAME_SQL}) <> ''
  AND (${buildAttendantCaseSql()}) <> ''
  AND trim(coalesce(queue_name, '')) <> ''
  AND trim(coalesce(company, '')) <> ''
  AND trim(coalesce(display_time, '')) <> ''
)`;

// Prefixo comum das consultas: aplica os filtros e mantem, de cada ticket
// repetido entre snapshots, apenas a leitura mais recente.
function buildRankedTicketsSql(where) {
  return `
      WITH filtered AS (
        SELECT *, ${REPORT_DEDUPE_KEY_SQL} AS dedupeKey
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
      )`;
}

async function getSummary(filters = {}) {
  const database = await getDatabase();
  const { where, params } = buildTicketFilters(filters);
  const readings = await database.prepare(`SELECT COUNT(DISTINCT snapshot_id) AS "totalReadings" FROM tickets ${where}`).get(...params);
  const row = await database
    .prepare(
      `
      ${buildRankedTicketsSql(where)}
      SELECT
        COUNT(*) AS "totalTicketsProcessed",
        SUM(CASE WHEN tag_status = 'COM_TAG' THEN 1 ELSE 0 END) AS "totalWithTag",
        SUM(CASE WHEN tag_status = 'SEM_TAG' THEN 1 ELSE 0 END) AS "totalWithoutTag",
        SUM(CASE WHEN COALESCE(inactivity_minutes, 0) > ${INACTIVITY_THRESHOLD_MINUTES} THEN 1 ELSE 0 END) AS "totalInactive",
        MAX(collected_at) AS "lastCollectedAt"
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
    totalInactive: Number(row.totalInactive || 0),
    compliancePercent,
    lastCollectedAt: row.lastCollectedAt || null
  };
}

// A lista so entrega tickets com o cadastro completo (cliente, fila, atendente,
// empresa e horario). Registros parciais — tipicamente uma linha do MTalk lida
// pela metade, em que so a fila foi reconhecida — sao contados em
// "incompletosOcultos" em vez de virarem linhas cheias de "-".
async function getMissingTags(filters = {}) {
  const database = await getDatabase();
  const { where, params } = buildTicketFilters(filters);
  const limit = Math.min(Number(filters.limit || 500), 1000);
  const rankedSql = buildRankedTicketsSql(where);
  const attendantSql = buildAttendantCaseSql();

  const rows = await database
    .prepare(
      `
      ${rankedSql}
      SELECT
        id,
        snapshot_id AS "snapshotId",
        ${SANITIZED_CLIENT_NAME_SQL} AS "clientName",
        queue_name AS queue,
        ${attendantSql} AS attendant,
        company,
        display_time AS "displayTime",
        inactivity_minutes AS "inactivityMinutes",
        tag,
        tag_status AS "tagStatus",
        source_url AS url,
        collected_at AS "collectedAt"
      FROM ranked
      WHERE rowNumber = 1
        AND tag_status = 'SEM_TAG'
        AND ${COMPLETE_TICKET_SQL}
      ORDER BY datetime(collected_at) DESC, id DESC
      LIMIT ?
    `
    )
    .all(...params, limit);

  const counters = await database
    .prepare(
      `
      ${rankedSql}
      SELECT
        COUNT(*) AS "totalSemTag",
        SUM(CASE WHEN ${COMPLETE_TICKET_SQL} THEN 1 ELSE 0 END) AS "totalCompletos"
      FROM ranked
      WHERE rowNumber = 1
        AND tag_status = 'SEM_TAG'
    `
    )
    .get(...params);

  const totalSemTag = Number(counters?.totalSemTag || 0);
  const totalCompletos = Number(counters?.totalCompletos || 0);

  return {
    items: rows.map(sanitizeTicketRow),
    total: totalCompletos,
    incompletosOcultos: totalSemTag - totalCompletos
  };
}

// Valores distintos que realmente existem nos dados, para alimentar os filtros
// do painel. Considera apenas o recorte de datas: se dependesse tambem dos
// filtros de texto, escolher um atendente esvaziaria a lista de empresas.
async function getFilterOptions(filters = {}) {
  const database = await getDatabase();
  const { where, params } = buildTicketFilters({
    day: filters.day,
    startDate: filters.startDate,
    endDate: filters.endDate
  });

  const [attendants, companies, queues, clients] = await Promise.all([
    selectDistinctValues(database, buildAttendantCaseSql(), where, params),
    selectDistinctValues(database, "trim(coalesce(company, ''))", where, params),
    selectDistinctValues(database, "trim(coalesce(queue_name, ''))", where, params),
    selectDistinctValues(database, SANITIZED_CLIENT_NAME_SQL, where, params)
  ]);

  return { attendants, companies, queues, clients };
}

async function selectDistinctValues(database, expression, where, params) {
  const rows = await database
    .prepare(
      `
      SELECT value
      FROM (
        SELECT ${expression} AS value
        FROM tickets
        ${where}
      ) AS valores
      WHERE value IS NOT NULL AND trim(value) <> ''
      GROUP BY value
      ORDER BY value
      LIMIT 500
    `
    )
    .all(...params);

  return rows.map((row) => row.value);
}

async function getInactivitySummary(filters = {}) {
  const database = await getDatabase();
  const { where, params } = buildTicketFilters(filters);
  const row = await database
    .prepare(
      `
      ${buildRankedTicketsSql(where)}
      SELECT
        COUNT(*) AS "inactiveTickets",
        MAX(COALESCE(inactivity_minutes, 0)) AS "maxInactivityMinutes",
        AVG(COALESCE(inactivity_minutes, 0)) AS "averageInactivityMinutes",
        MAX(collected_at) AS "lastCollectedAt"
      FROM ranked
      WHERE rowNumber = 1
        AND COALESCE(inactivity_minutes, 0) > ?
        AND ${COMPLETE_TICKET_SQL}
    `
    )
    .get(...params, INACTIVITY_THRESHOLD_MINUTES);

  return {
    thresholdMinutes: INACTIVITY_THRESHOLD_MINUTES,
    inactiveTickets: Number(row.inactiveTickets || 0),
    maxInactivityMinutes: Number(row.maxInactivityMinutes || 0),
    averageInactivityMinutes: row.averageInactivityMinutes ? Number(Number(row.averageInactivityMinutes).toFixed(1)) : 0,
    lastCollectedAt: row.lastCollectedAt || null
  };
}

async function getInactiveTickets(filters = {}) {
  const database = await getDatabase();
  const { where, params } = buildTicketFilters(filters);
  const limit = Math.min(Number(filters.limit || 500), 1000);
  const rows = await database
    .prepare(
      `
      ${buildRankedTicketsSql(where)}
      SELECT
        id,
        snapshot_id AS "snapshotId",
        ${SANITIZED_CLIENT_NAME_SQL} AS "clientName",
        queue_name AS queue,
        ${buildAttendantCaseSql()} AS attendant,
        company,
        display_time AS "displayTime",
        inactivity_minutes AS "inactivityMinutes",
        tag,
        tag_status AS "tagStatus",
        source_url AS url,
        collected_at AS "collectedAt"
      FROM ranked
      WHERE rowNumber = 1
        AND COALESCE(inactivity_minutes, 0) > ?
        AND ${COMPLETE_TICKET_SQL}
      ORDER BY COALESCE(inactivity_minutes, 0) DESC, datetime(collected_at) DESC, id DESC
      LIMIT ?
    `
    )
    .all(...params, INACTIVITY_THRESHOLD_MINUTES, limit);

  return { items: rows.map(sanitizeTicketRow) };
}

async function getInactivityByAttendant(filters = {}) {
  const database = await getDatabase();
  const { where, params } = buildTicketFilters(filters);
  const caseSql = buildAttendantCaseSql();
  const rows = await database
    .prepare(
      `
      ${buildRankedTicketsSql(where)},
      normalized AS (
        SELECT
          *,
          ${caseSql} AS normalizedAttendant
        FROM ranked
        WHERE rowNumber = 1
      )
      SELECT
        normalizedAttendant AS attendant,
        COUNT(*) AS "inactiveTickets",
        MAX(COALESCE(inactivity_minutes, 0)) AS "maxInactivityMinutes",
        AVG(COALESCE(inactivity_minutes, 0)) AS "averageInactivityMinutes"
      FROM normalized
      WHERE normalizedAttendant <> ''
        AND COALESCE(inactivity_minutes, 0) > ?
        AND ${COMPLETE_TICKET_SQL}
      GROUP BY normalizedAttendant
      ORDER BY "inactiveTickets" DESC, "maxInactivityMinutes" DESC
    `
    )
    .all(...params, INACTIVITY_THRESHOLD_MINUTES);

  return { items: rows.map(withInactivityStats) };
}

async function getInactivityByCompany(filters = {}) {
  const database = await getDatabase();
  const { where, params } = buildTicketFilters(filters);
  const rows = await database
    .prepare(
      `
      ${buildRankedTicketsSql(where)}
      SELECT
        COALESCE(NULLIF(company, ''), 'Nao identificada') AS company,
        COUNT(*) AS "inactiveTickets",
        MAX(COALESCE(inactivity_minutes, 0)) AS "maxInactivityMinutes",
        AVG(COALESCE(inactivity_minutes, 0)) AS "averageInactivityMinutes"
      FROM ranked
      WHERE rowNumber = 1
        AND COALESCE(inactivity_minutes, 0) > ?
        AND ${COMPLETE_TICKET_SQL}
      GROUP BY COALESCE(NULLIF(company, ''), 'Nao identificada')
      ORDER BY "inactiveTickets" DESC, "maxInactivityMinutes" DESC
    `
    )
    .all(...params, INACTIVITY_THRESHOLD_MINUTES);

  return { items: rows.map(withInactivityStats) };
}

async function getReportByAttendant(filters = {}) {
  const database = await getDatabase();
  const { where, params } = buildTicketFilters(filters);
  const caseSql = buildAttendantCaseSql();
  const rows = await database
    .prepare(
      `
      ${buildRankedTicketsSql(where)},
      normalized AS (
        SELECT
          *,
          ${caseSql} AS normalizedAttendant
        FROM ranked
        WHERE rowNumber = 1
      )
      SELECT
        normalizedAttendant AS attendant,
        COUNT(*) AS "totalTickets",
        SUM(CASE WHEN tag_status = 'COM_TAG' THEN 1 ELSE 0 END) AS "totalWithTag",
        SUM(CASE WHEN tag_status = 'SEM_TAG' THEN 1 ELSE 0 END) AS "totalWithoutTag"
      FROM normalized
      WHERE normalizedAttendant <> ''
      GROUP BY normalizedAttendant
      ORDER BY "totalWithoutTag" DESC, "totalTickets" DESC
    `
    )
    .all(...params);

  return { items: rows.map(withFailurePercent) };
}

async function getReportByQueue(filters = {}) {
  const database = await getDatabase();
  const { where, params } = buildTicketFilters(filters);
  const rows = await database
    .prepare(
      `
      ${buildRankedTicketsSql(where)}
      SELECT
        COALESCE(NULLIF(queue_name, ''), 'Nao identificada') AS queue,
        COUNT(*) AS "totalTickets",
        SUM(CASE WHEN tag_status = 'COM_TAG' THEN 1 ELSE 0 END) AS "totalWithTag",
        SUM(CASE WHEN tag_status = 'SEM_TAG' THEN 1 ELSE 0 END) AS "totalWithoutTag"
      FROM ranked
      WHERE rowNumber = 1
      GROUP BY COALESCE(NULLIF(queue_name, ''), 'Nao identificada')
      ORDER BY "totalWithoutTag" DESC, "totalTickets" DESC
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

  const day = normalizeDateOnly(filters.day);
  if (day) {
    conditions.push("substr(collected_at, 1, 10) = ?");
    params.push(day);
  }

  const startDate = normalizeDateTimeFilter(filters.startDate, "start");
  if (!day && startDate) {
    conditions.push("datetime(collected_at) >= datetime(?)");
    params.push(startDate);
  }

  const endDate = normalizeDateTimeFilter(filters.endDate, "end");
  if (!day && endDate) {
    conditions.push("datetime(collected_at) <= datetime(?)");
    params.push(endDate);
  }

  addAttendantFilter(conditions, params, filters.attendant);
  addLikeFilter(conditions, params, "queue_name", filters.queue);
  addNormalizedLikeFilter(conditions, params, "company", filters.company);
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
  conditions.push(`UPPER(${column}) LIKE UPPER(?)`);
  params.push(`%${cleanValue}%`);
}

function addAttendantFilter(conditions, params, value) {
  const cleanValue = String(value || "").trim();
  if (!cleanValue) {
    return;
  }

  const normalized = normalizeAttendantName(cleanValue) || cleanValue;
  conditions.push(`(UPPER(attendant) LIKE UPPER(?) OR UPPER(${buildAttendantCaseSql()}) LIKE UPPER(?))`);
  params.push(`%${cleanValue}%`, `%${normalized}%`);
}

function addNormalizedLikeFilter(conditions, params, column, value) {
  const cleanValue = String(value || "").trim();
  if (!cleanValue) {
    return;
  }

  const normalized = normalizeComparableText(cleanValue);
  conditions.push(`(UPPER(${column}) LIKE UPPER(?) OR ${normalizeComparableSql(column)} LIKE ?)`);
  params.push(`%${cleanValue}%`, `%${normalized}%`);
}

function normalizeDateOnly(value) {
  const match = String(value || "").trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || "";
}

function normalizeDateTimeFilter(value, boundary) {
  const cleanValue = String(value || "").trim();
  if (!cleanValue) {
    return "";
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(cleanValue)) {
    return `${cleanValue}T${boundary === "end" ? "23:59:59" : "00:00:00"}`;
  }

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(cleanValue)) {
    return `${cleanValue}:00`;
  }

  return cleanValue;
}

function normalizeComparableSql(column) {
  return `UPPER(REPLACE(REPLACE(REPLACE(${column}, ' ', ''), '-', ''), '_', ''))`;
}

function normalizeComparableText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s_-]+/g, "")
    .toUpperCase();
}

function sanitizeTicketRow(row) {
  return {
    ...row,
    clientName: sanitizeClientName(row.clientName),
    attendant: sanitizeAttendantName(row.attendant),
    inactivityMinutes: row.inactivityMinutes === null || row.inactivityMinutes === undefined ? null : Number(row.inactivityMinutes || 0)
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

function withInactivityStats(row) {
  return {
    ...row,
    inactiveTickets: Number(row.inactiveTickets || 0),
    maxInactivityMinutes: Number(row.maxInactivityMinutes || 0),
    averageInactivityMinutes: row.averageInactivityMinutes ? Number(Number(row.averageInactivityMinutes).toFixed(1)) : 0
  };
}

module.exports = {
  getSummary,
  getFilterOptions,
  getMissingTags,
  getInactivitySummary,
  getInactiveTickets,
  getInactivityByAttendant,
  getInactivityByCompany,
  getReportByAttendant,
  getReportByQueue
};
