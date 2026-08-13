// Parametros de monitoramento em um lugar so. O limite de inatividade estava
// repetido no content script e no report.service; com a leitura vindo da API
// oficial do MTalk, os dois lados passam a ler daqui.
//
// Filas e atendentes continuam em services/queue-filter.js e
// services/attendant-filter.js, que ja sao a fonte unica desses dois.

const DEFAULT_INACTIVITY_THRESHOLD_MINUTES = 15;
// Teto de tickets por snapshot. Serve de guarda contra payload absurdo, mas
// precisa caber uma coleta legitima: maxPages x pageSize por status monitorado.
const MAX_TICKETS_PER_SNAPSHOT = 500;
const DEFAULT_MTALK_BASE_URL = "https://s11.mtalk.com.br/backend";
// O backend do MTalk pagina os tickets de 40 em 40 (valor fixo do servidor).
const DEFAULT_PAGE_SIZE = 40;
// 5 paginas x 40 = 200 tickets, o mesmo teto aceito pelo snapshot.
const DEFAULT_MAX_PAGES = 5;
const DEFAULT_QUEUE_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 12000;
// Tickets que ainda estao em atendimento. "closed" fica de fora de proposito:
// ticket encerrado nao gera alerta de TAG nem de inatividade.
const DEFAULT_TICKET_STATUSES = ["open", "pending"];

function getInactivityThresholdMinutes() {
  return readPositiveInteger(process.env.INACTIVITY_THRESHOLD_MINUTES, DEFAULT_INACTIVITY_THRESHOLD_MINUTES);
}

function getMtalkConfig() {
  const baseUrl = normalizeBaseUrl(process.env.MTALK_BASE_URL || DEFAULT_MTALK_BASE_URL);
  const token = String(process.env.MTALK_TOKEN || "").trim();

  return {
    baseUrl,
    // Origem do painel (sem "/backend"), usada como source_url do snapshot.
    panelUrl: baseUrl.replace(/\/backend\/?$/, ""),
    token,
    isConfigured: Boolean(token),
    statuses: readStatuses(process.env.MTALK_TICKET_STATUSES),
    pageSize: readPositiveInteger(process.env.MTALK_PAGE_SIZE, DEFAULT_PAGE_SIZE),
    maxPages: readPositiveInteger(process.env.MTALK_MAX_PAGES, DEFAULT_MAX_PAGES),
    queueCacheTtlMs: readPositiveInteger(process.env.MTALK_QUEUE_CACHE_MINUTES, DEFAULT_QUEUE_CACHE_TTL_MS / 60000) * 60000,
    timeoutMs: readPositiveInteger(process.env.MTALK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  };
}

function readStatuses(value) {
  const statuses = String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^[a-z]+$/.test(item));

  return statuses.length ? statuses : [...DEFAULT_TICKET_STATUSES];
}

// O limite de inatividade e interpolado direto no SQL dos relatorios, entao
// so pode virar numero inteiro — nunca texto vindo do ambiente.
function readPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

module.exports = {
  DEFAULT_INACTIVITY_THRESHOLD_MINUTES,
  MAX_TICKETS_PER_SNAPSHOT,
  getInactivityThresholdMinutes,
  getMtalkConfig
};
