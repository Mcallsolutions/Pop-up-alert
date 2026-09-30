const { getDatabase } = require("../database");
const { getInactivityThresholdMinutes } = require("../config/monitoring");
const { getAllowedQueues } = require("./queue-filter");
const { normalizeAttendantName } = require("./attendant-filter");

const INACTIVITY_THRESHOLD_MINUTES = getInactivityThresholdMinutes();
const DAY_MS = 24 * 60 * 60 * 1000;

// Um ticket so entra nas listas quando o contato tem nome: sem ele o painel e
// o alerta nao conseguem dizer de quem e o atendimento.
const IDENTIFIED_TICKET_SQL = `(trim(coalesce(client_name, '')) <> '')`;

// Existe alguem a quem cobrar a TAG. Atendente vazio e um FATO na API: o
// ticket esta aguardando na fila e ninguem o assumiu (o MTalk devolve
// user/userId nulos). Ele sai dos relatorios de TAG, mas continua inteiro nos
// de inatividade, onde "parado e sem responsavel" e o caso mais grave.
const HAS_RESPONSIBLE_SQL = `(trim(coalesce(attendant, '')) <> '')`;

// Prefixo das consultas de TAG: aplica os filtros e mantem, de cada ticket
// repetido entre coletas, apenas a leitura mais recente.
//
// Sao dois niveis de proposito. O recorte do token NAO pode entrar no ranking:
// se entrasse, um ticket que hoje e de outro atendente — mas que ja esteve sem
// atendente — teria como "leitura mais recente visivel" a leitura velha, e
// voltaria a aparecer como aguardando na fila. Primeiro decidimos qual e a
// leitura atual de cada ticket, depois filtramos por ela.
function buildRankedTicketsSql(where, scopeSql) {
  return `
      WITH todas_leituras AS (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY external_ticket_id
            ORDER BY datetime(collected_at) DESC, id DESC
          ) AS rowNumber
        FROM tickets
        ${where}
      ),
      ranked AS (
        SELECT * FROM todas_leituras
        WHERE rowNumber = 1${scopeSql ? ` AND ${scopeSql}` : ""}
      )`;
}

// Prefixo das consultas de INATIVIDADE: de cada ticket, a leitura em que ele
// passou mais tempo parado dentro do periodo. Pela leitura mais recente, quem
// esperou 50 min de manha e depois foi atendido sumia do relatorio do dia.
//
// O atendente sai dessa mesma leitura: e quem estava com o ticket enquanto ele
// ficou parado, mesmo que o ticket tenha sido transferido depois. O recorte do
// token entra depois da escolha da leitura, pelo mesmo motivo do ranked.
function buildPeakInactivitySql(where, scopeSql) {
  return `
      WITH leituras_por_parada AS (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY external_ticket_id
            ORDER BY COALESCE(inactivity_minutes, 0) DESC, datetime(collected_at) DESC, id DESC
          ) AS rowNumber
        FROM tickets
        ${where}
      ),
      pico AS (
        SELECT * FROM leituras_por_parada
        WHERE rowNumber = 1${scopeSql ? ` AND ${scopeSql}` : ""}
      )`;
}

const TICKET_COLUMNS_SQL = `
        id,
        snapshot_id AS "snapshotId",
        external_ticket_id AS "externalTicketId",
        ticket_uuid AS "ticketUuid",
        ticket_status AS "ticketStatus",
        trim(coalesce(client_name, '')) AS "clientName",
        queue_name AS queue,
        trim(coalesce(attendant, '')) AS attendant,
        company,
        display_time AS "displayTime",
        last_message_at AS "lastMessageAt",
        inactivity_minutes AS "inactivityMinutes",
        tag,
        tags,
        tag_status AS "tagStatus",
        source_url AS url,
        collected_at AS "collectedAt"`;

async function getSummary(filters = {}) {
  const database = await getDatabase();
  const { where, params, rankedSql, peakSql } = buildTicketFilters(filters);
  const readings = await database
    .prepare(`SELECT COUNT(DISTINCT snapshot_id) AS "totalReadings" FROM tickets ${where}`)
    .get(...params);
  const row = await database
    .prepare(
      `
      ${rankedSql}
      SELECT
        COUNT(*) AS "totalTicketsProcessed",
        SUM(CASE WHEN tag_status = 'COM_TAG' AND ${HAS_RESPONSIBLE_SQL} THEN 1 ELSE 0 END) AS "totalWithTag",
        SUM(CASE WHEN tag_status = 'SEM_TAG' AND ${HAS_RESPONSIBLE_SQL} THEN 1 ELSE 0 END) AS "totalWithoutTag",
        SUM(CASE WHEN NOT ${HAS_RESPONSIBLE_SQL} THEN 1 ELSE 0 END) AS "totalWithoutAttendant",
        MAX(collected_at) AS "lastCollectedAt"
      FROM ranked
      WHERE rowNumber = 1
    `
    )
    .get(...params);
  // Inatividade conta pela maior parada de cada ticket no periodo, como nos
  // relatorios de inatividade (buildPeakInactivitySql).
  const inactive = await database
    .prepare(
      `
      ${peakSql}
      SELECT COUNT(*) AS "totalInactive"
      FROM pico
      WHERE COALESCE(inactivity_minutes, 0) > ?
    `
    )
    .get(...params, INACTIVITY_THRESHOLD_MINUTES);

  const totalTicketsProcessed = Number(row?.totalTicketsProcessed || 0);
  const totalWithTag = Number(row?.totalWithTag || 0);
  const totalWithoutTag = Number(row?.totalWithoutTag || 0);
  // Conformidade so olha o que da para cobrar: ticket aguardando na fila nao
  // conta nem a favor nem contra.
  const totalCobravel = totalWithTag + totalWithoutTag;
  const compliancePercent = totalCobravel ? Number(((totalWithTag / totalCobravel) * 100).toFixed(2)) : 0;

  return {
    totalReadings: Number(readings?.totalReadings || 0),
    // totalTicketsProcessed = totalWithTag + totalWithoutTag + totalWithoutAttendant.
    totalTicketsProcessed,
    totalWithTag,
    totalWithoutTag,
    totalWithoutAttendant: Number(row?.totalWithoutAttendant || 0),
    totalInactive: Number(inactive?.totalInactive || 0),
    thresholdMinutes: INACTIVITY_THRESHOLD_MINUTES,
    compliancePercent,
    lastCollectedAt: row?.lastCollectedAt || null
  };
}

// Tickets sem nome de contato sao contados em "incompletosOcultos" e os que
// aguardam atendente em "semAtendenteOcultos", em vez de virarem linhas.
async function getMissingTags(filters = {}) {
  const database = await getDatabase();
  const { where, params, rankedSql } = buildTicketFilters(filters);
  const limit = readLimit(filters.limit);

  const rows = await database
    .prepare(
      `
      ${rankedSql}
      SELECT ${TICKET_COLUMNS_SQL}
      FROM ranked
      WHERE rowNumber = 1
        AND tag_status = 'SEM_TAG'
        AND ${IDENTIFIED_TICKET_SQL}
        AND ${HAS_RESPONSIBLE_SQL}
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
        SUM(CASE WHEN ${IDENTIFIED_TICKET_SQL} THEN 1 ELSE 0 END) AS "totalIdentificados",
        SUM(CASE WHEN ${IDENTIFIED_TICKET_SQL} AND ${HAS_RESPONSIBLE_SQL} THEN 1 ELSE 0 END) AS "totalCobraveis"
      FROM ranked
      WHERE rowNumber = 1
        AND tag_status = 'SEM_TAG'
    `
    )
    .get(...params);

  const totalSemTag = Number(counters?.totalSemTag || 0);
  const totalIdentificados = Number(counters?.totalIdentificados || 0);
  const totalCobraveis = Number(counters?.totalCobraveis || 0);

  return {
    items: rows.map(normalizeTicketRow),
    total: totalCobraveis,
    incompletosOcultos: totalSemTag - totalIdentificados,
    semAtendenteOcultos: totalIdentificados - totalCobraveis
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
    endDate: filters.endDate,
    scopeAttendant: filters.scopeAttendant
  });

  const [attendants, companies, queues, clients] = await Promise.all([
    selectDistinctValues(database, "attendant", where, params),
    selectDistinctValues(database, "company", where, params),
    selectDistinctValues(database, "queue_name", where, params),
    selectDistinctValues(database, "client_name", where, params)
  ]);

  return { attendants, companies, queues, clients };
}

async function selectDistinctValues(database, column, where, params) {
  const rows = await database
    .prepare(
      `
      SELECT value
      FROM (
        SELECT trim(coalesce(${column}, '')) AS value
        FROM tickets
        ${where}
      ) AS valores
      WHERE value <> ''
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
  const { where, params, peakSql } = buildTicketFilters(filters);
  const row = await database
    .prepare(
      `
      ${peakSql}
      SELECT
        COUNT(*) AS "inactiveTickets",
        MAX(COALESCE(inactivity_minutes, 0)) AS "maxInactivityMinutes",
        AVG(COALESCE(inactivity_minutes, 0)) AS "averageInactivityMinutes"
      FROM pico
      WHERE COALESCE(inactivity_minutes, 0) > ?
        AND ${IDENTIFIED_TICKET_SQL}
    `
    )
    .get(...params, INACTIVITY_THRESHOLD_MINUTES);
  // A leitura de pico de um ticket pode ser antiga: a ultima coleta vem da
  // tabela, no mesmo recorte.
  const last = await database
    .prepare(`SELECT MAX(collected_at) AS "lastCollectedAt" FROM tickets ${where}`)
    .get(...params);

  return {
    thresholdMinutes: INACTIVITY_THRESHOLD_MINUTES,
    inactiveTickets: Number(row?.inactiveTickets || 0),
    maxInactivityMinutes: Number(row?.maxInactivityMinutes || 0),
    averageInactivityMinutes: roundAverage(row?.averageInactivityMinutes),
    lastCollectedAt: last?.lastCollectedAt || null
  };
}

async function getInactiveTickets(filters = {}) {
  const database = await getDatabase();
  const { params, peakSql } = buildTicketFilters(filters);
  const rows = await database
    .prepare(
      `
      ${peakSql}
      SELECT ${TICKET_COLUMNS_SQL}
      FROM pico
      WHERE COALESCE(inactivity_minutes, 0) > ?
        AND ${IDENTIFIED_TICKET_SQL}
      ORDER BY COALESCE(inactivity_minutes, 0) DESC, datetime(collected_at) DESC, id DESC
      LIMIT ?
    `
    )
    .all(...params, INACTIVITY_THRESHOLD_MINUTES, readLimit(filters.limit));

  return { items: rows.map(normalizeTicketRow) };
}

async function getInactivityByAttendant(filters = {}) {
  return getInactivityGroupedBy(filters, "attendant", "attendant", `${HAS_RESPONSIBLE_SQL}`);
}

async function getInactivityByCompany(filters = {}) {
  return getInactivityGroupedBy(filters, "COALESCE(NULLIF(trim(company), ''), 'Nao identificada')", "company");
}

async function getInactivityGroupedBy(filters, expression, alias, extraCondition = "1 = 1") {
  const database = await getDatabase();
  const { params, peakSql } = buildTicketFilters(filters);
  const rows = await database
    .prepare(
      `
      ${peakSql}
      SELECT
        ${expression} AS ${alias},
        COUNT(*) AS "inactiveTickets",
        MAX(COALESCE(inactivity_minutes, 0)) AS "maxInactivityMinutes",
        AVG(COALESCE(inactivity_minutes, 0)) AS "averageInactivityMinutes"
      FROM pico
      WHERE COALESCE(inactivity_minutes, 0) > ?
        AND ${IDENTIFIED_TICKET_SQL}
        AND ${extraCondition}
      GROUP BY ${expression}
      ORDER BY "inactiveTickets" DESC, "maxInactivityMinutes" DESC
    `
    )
    .all(...params, INACTIVITY_THRESHOLD_MINUTES);

  return { items: rows.map(withInactivityStats) };
}

async function getReportByAttendant(filters = {}) {
  return getTagReportGroupedBy(filters, "trim(attendant)", "attendant");
}

async function getReportByQueue(filters = {}) {
  return getTagReportGroupedBy(filters, "COALESCE(NULLIF(queue_name, ''), 'Nao identificada')", "queue");
}

// Relatorio de TAG agrupado. Ticket aguardando atendente fica de fora.
async function getTagReportGroupedBy(filters, expression, alias) {
  const database = await getDatabase();
  const { where, params, rankedSql } = buildTicketFilters(filters);
  const rows = await database
    .prepare(
      `
      ${rankedSql}
      SELECT
        ${expression} AS ${alias},
        COUNT(*) AS "totalTickets",
        SUM(CASE WHEN tag_status = 'COM_TAG' THEN 1 ELSE 0 END) AS "totalWithTag",
        SUM(CASE WHEN tag_status = 'SEM_TAG' THEN 1 ELSE 0 END) AS "totalWithoutTag"
      FROM ranked
      WHERE rowNumber = 1
        AND ${HAS_RESPONSIBLE_SQL}
      GROUP BY ${expression}
      ORDER BY "totalWithoutTag" DESC, "totalTickets" DESC
    `
    )
    .all(...params);

  return { items: rows.map(withFailurePercent) };
}

function buildTicketFilters(filters = {}) {
  const conditions = [];
  const params = [];
  const allowedQueues = getAllowedQueues();

  // O "+" tira esta condicao da escolha de indice. A coleta so grava tickets das
  // filas monitoradas, entao ela casa com quase todas as linhas — e sem o "+" o
  // SQLite preferia o indice de fila ao de data e varria a tabela inteira.
  conditions.push(`+queue_name IN (${allowedQueues.map(() => "?").join(", ")})`);
  params.push(...allowedQueues);

  appendDateRange(conditions, params, "collected_at", filters);
  addAttendantFilter(conditions, params, filters.attendant);
  addLikeFilter(conditions, params, "queue_name", filters.queue);
  addNormalizedLikeFilter(conditions, params, "company", filters.company);
  addLikeFilter(conditions, params, "client_name", filters.clientName);

  // O recorte do token entra por ultimo nas duas formas, entao a ordem dos
  // parametros e a mesma para `where` e para `rankedSql`: primeiro os filtros,
  // depois o atendente do token.
  const scope = buildScopeCondition(filters.scopeAttendant);
  const baseWhere = `WHERE ${conditions.join(" AND ")}`;

  // Sempre ha ao menos o recorte de filas monitoradas.
  return {
    // Ja com o recorte: serve as consultas que leem a tabela direto.
    where: scope.sql ? `WHERE ${[...conditions, scope.sql].join(" AND ")}` : baseWhere,
    params: [...params, ...scope.params],
    // Consultas de TAG: a leitura mais recente de cada ticket.
    rankedSql: buildRankedTicketsSql(baseWhere, scope.sql),
    // Consultas de inatividade: a leitura de maior parada de cada ticket.
    peakSql: buildPeakInactivitySql(baseWhere, scope.sql)
  };
}

// Filtro de dia/intervalo sobre uma coluna gravada com toZonedIso. Tambem usado
// pela analise de atendimento (attendance_analyses.created_at).
//
// A coluna e gravada na hora local da operacao com o offset
// ("2026-09-15T21:40:05-03:00"), e os limites vao no mesmo formato sem o
// offset: a leitura das 00:00:00 em ponto fica "maior" que o limite so pelo
// offset e cai no dia certo. Comparar a coluna crua — e nao
// substr(coluna, ...) — e o que deixa o SQLite usar o indice de data.
function appendDateRange(conditions, params, column, filters = {}) {
  const day = normalizeDateOnly(filters.day);
  if (day) {
    const inicio = checkedDateTime(`${day}T00:00:00`);
    conditions.push(`${column} >= ?`, `${column} < ?`);
    params.push(inicio, shiftDateTime(inicio, DAY_MS));
  }

  const startDate = normalizeDateTimeFilter(filters.startDate, "start");
  if (!day && startDate) {
    conditions.push(`${column} >= ?`);
    params.push(checkedDateTime(startDate));
  }

  // O fim inclui o segundo informado inteiro: tudo antes do segundo seguinte.
  const endDate = normalizeDateTimeFilter(filters.endDate, "end");
  if (!day && endDate) {
    conditions.push(`${column} < ?`);
    params.push(shiftDateTime(checkedDateTime(endDate), 1000));
  }
}

// Recorte do token de atendente: os tickets dele mais TODOS os que estao sem
// atendente — ninguem e dono de um ticket parado na fila, e e justamente esse
// que nao pode ficar sem resposta.
//
// Aqui a comparacao e exata (attendant ja e gravado canonico), nao LIKE: com
// LIKE, o token de "Gabriel" abriria os tickets de "Gabriell Carvalho".
function buildScopeCondition(value) {
  const canonical = normalizeAttendantName(value);
  if (!canonical) {
    return { sql: "", params: [] };
  }

  return {
    sql: `(NOT ${HAS_RESPONSIBLE_SQL} OR UPPER(trim(attendant)) = UPPER(?))`,
    params: [canonical]
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

// O atendente ja e gravado normalizado ("Alek" vira "Aleksandro"), entao a
// busca tenta o texto digitado e tambem o nome canonico dele.
function addAttendantFilter(conditions, params, value, column = "attendant") {
  const cleanValue = String(value || "").trim();
  if (!cleanValue) {
    return;
  }

  const normalized = normalizeAttendantName(cleanValue) || cleanValue;
  conditions.push(`(UPPER(${column}) LIKE UPPER(?) OR UPPER(${column}) LIKE UPPER(?))`);
  params.push(`%${cleanValue}%`, `%${normalized}%`);
}

function addNormalizedLikeFilter(conditions, params, column, value) {
  const cleanValue = String(value || "").trim();
  if (!cleanValue) {
    return;
  }

  const normalized = normalizeComparableText(cleanValue);
  conditions.push(
    `(UPPER(${column}) LIKE UPPER(?) OR UPPER(REPLACE(REPLACE(REPLACE(${column}, ' ', ''), '-', ''), '_', '')) LIKE ?)`
  );
  params.push(`%${cleanValue}%`, `%${normalized}%`);
}

function normalizeDateOnly(value) {
  const match = String(value || "").trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || "";
}

// Sempre "YYYY-MM-DDTHH:MM:SS", o mesmo tamanho de substr(collected_at, 1, 19).
function normalizeDateTimeFilter(value, boundary) {
  const cleanValue = String(value || "").trim();
  if (!cleanValue) {
    return "";
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(cleanValue)) {
    return `${cleanValue}T${boundary === "end" ? "23:59:59" : "00:00:00"}`;
  }

  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/.test(cleanValue)) {
    return `${cleanValue.replace(" ", "T")}:${boundary === "end" ? "59" : "00"}`;
  }

  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(cleanValue)) {
    return cleanValue.replace(" ", "T").slice(0, 19);
  }

  return "";
}

// Data com o formato certo mas impossivel ("2026-09-31") vira 400: o Date do
// JavaScript "arredondaria" para 01/10 e o filtro traria o dia errado.
function checkedDateTime(value) {
  const date = new Date(`${value}Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 19) !== value) {
    const error = new Error(`Data invalida no filtro: ${value.replace("T", " ")}`);
    error.statusCode = 400;
    error.publicMessage = error.message;
    throw error;
  }
  return value;
}

// Soma ms a um "YYYY-MM-DDTHH:MM:SS" ja validado. O texto e tratado como UTC so
// para a conta de calendario: nenhum fuso entra aqui.
function shiftDateTime(value, ms) {
  return new Date(new Date(`${value}Z`).getTime() + ms).toISOString().slice(0, 19);
}

function normalizeComparableText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[\s_-]+/g, "")
    .toUpperCase();
}

function readLimit(value) {
  return Math.min(Math.max(Number(value) || 500, 1), 1000);
}

function normalizeTicketRow(row) {
  return {
    ...row,
    tags: String(row.tags || "")
      .split("|")
      .map((tag) => tag.trim())
      .filter(Boolean),
    inactivityMinutes: row.inactivityMinutes === null || row.inactivityMinutes === undefined ? null : Number(row.inactivityMinutes)
  };
}

function roundAverage(value) {
  return value ? Number(Number(value).toFixed(1)) : 0;
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
    averageInactivityMinutes: roundAverage(row.averageInactivityMinutes)
  };
}

module.exports = {
  addAttendantFilter,
  addLikeFilter,
  addNormalizedLikeFilter,
  appendDateRange,
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
