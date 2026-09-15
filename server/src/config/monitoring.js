// Parametros de monitoramento em um lugar so.
//
// Filas e atendentes ficam em services/queue-filter.js e
// services/attendant-filter.js, que ja sao a fonte unica desses dois.

const DEFAULT_INACTIVITY_THRESHOLD_MINUTES = 15;
// Teto de tickets por snapshot: maxPages x pageSize por status monitorado.
const MAX_TICKETS_PER_SNAPSHOT = 500;
const DEFAULT_MTALK_BASE_URL = "https://s11.mtalk.com.br/backend";
// O backend do MTalk pagina os tickets de 40 em 40 (valor fixo do servidor).
const DEFAULT_PAGE_SIZE = 40;
const DEFAULT_MAX_PAGES = 5;
// Intervalo entre coletas automaticas. Cada coleta custa 2 requisicoes no caso
// comum (tickets open + pending).
const DEFAULT_COLLECT_INTERVAL_SECONDS = 60;
// Os ids das filas so mudam quando uma fila e recriada no MTalk.
const DEFAULT_QUEUE_CACHE_TTL_MS = 60 * 60 * 1000;
// Vale quando o catalogo de TAGs (GET /backend/tags/list) e necessario: ele so
// e consultado se algum vinculo de TAG chegar sem o nome.
const DEFAULT_TAG_CACHE_TTL_MS = 10 * 60 * 1000;
// Teto de consultas NOVAS a GET /backend/contacts/{id} por coleta. So sao
// gastas com ticket que continuaria no alerta e cujo contato veio sem o campo
// de TAGs na listagem — o objetivo e nunca virar "uma chamada por ticket".
const DEFAULT_MAX_CONTACT_LOOKUPS = 20;
// Cache por contato do resultado de GET /backend/contacts/{id}. Cliente ja
// marcado raramente perde a TAG; cliente sem TAG e rechecado mais cedo, para o
// alerta sumir pouco depois de o atendente registrar a TAG no contato.
const CONTACT_TAGGED_CACHE_TTL_MS = 30 * 60 * 1000;
const CONTACT_UNTAGGED_CACHE_TTL_MS = 3 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 12000;
// Tickets que ainda estao em atendimento. "closed" fica de fora de proposito:
// ticket encerrado nao gera alerta de TAG nem de inatividade.
const DEFAULT_TICKET_STATUSES = ["open", "pending"];
// A API do MTalk devolve datas em UTC e o painel do MTalk mostra em BRT. O
// mesmo fuso define o "dia" dos filtros do painel.
const DEFAULT_TIME_ZONE = "America/Sao_Paulo";

function getInactivityThresholdMinutes() {
  return readPositiveInteger(process.env.INACTIVITY_THRESHOLD_MINUTES, DEFAULT_INACTIVITY_THRESHOLD_MINUTES);
}

function getTimeZone() {
  return String(process.env.MONITOR_TIME_ZONE || "").trim() || DEFAULT_TIME_ZONE;
}

function getMtalkConfig() {
  const baseUrl = normalizeBaseUrl(process.env.MTALK_BASE_URL || DEFAULT_MTALK_BASE_URL);
  const token = normalizeToken(process.env.MTALK_TOKEN);

  return {
    baseUrl,
    // Origem do painel (sem "/backend"), usada para montar o link dos tickets.
    panelUrl: baseUrl.replace(/\/backend\/?$/, ""),
    token,
    isConfigured: Boolean(token),
    collectIntervalMs:
      readNonNegativeInteger(process.env.MTALK_COLLECT_INTERVAL_SECONDS, DEFAULT_COLLECT_INTERVAL_SECONDS) * 1000,
    statuses: readStatuses(process.env.MTALK_TICKET_STATUSES),
    pageSize: readPositiveInteger(process.env.MTALK_PAGE_SIZE, DEFAULT_PAGE_SIZE),
    maxPages: readPositiveInteger(process.env.MTALK_MAX_PAGES, DEFAULT_MAX_PAGES),
    queueCacheTtlMs: readPositiveInteger(process.env.MTALK_QUEUE_CACHE_MINUTES, DEFAULT_QUEUE_CACHE_TTL_MS / 60000) * 60000,
    tagCacheTtlMs: readPositiveInteger(process.env.MTALK_TAG_CACHE_MINUTES, DEFAULT_TAG_CACHE_TTL_MS / 60000) * 60000,
    // Zero e valido aqui: desliga a consulta extra ao contato.
    maxContactLookups: readNonNegativeInteger(process.env.MTALK_MAX_CONTACT_LOOKUPS, DEFAULT_MAX_CONTACT_LOOKUPS),
    contactTaggedCacheTtlMs: CONTACT_TAGGED_CACHE_TTL_MS,
    contactUntaggedCacheTtlMs: CONTACT_UNTAGGED_CACHE_TTL_MS,
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

function readNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// Aceita a URL do painel ("https://s11.mtalk.com.br") ou a do backend
// ("https://s11.mtalk.com.br/backend"): sem caminho, o backend fica em /backend.
function normalizeBaseUrl(value) {
  const text = String(value || "").trim().replace(/\/+$/, "");

  try {
    const url = new URL(text);
    return url.pathname === "/" ? `${url.origin}/backend` : text;
  } catch (_error) {
    return text;
  }
}

// Aceita o token colado de varios jeitos: cru, com "Bearer " na frente ou entre
// aspas, como fica em localStorage["token"] no painel do MTalk.
function normalizeToken(value) {
  return String(value || "")
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

module.exports = {
  MAX_TICKETS_PER_SNAPSHOT,
  getInactivityThresholdMinutes,
  getMtalkConfig,
  getTimeZone
};
