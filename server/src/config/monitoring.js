// Parametros de monitoramento em um lugar so.
//
// Filas e atendentes ficam em services/queue-filter.js e
// services/attendant-filter.js, que ja sao a fonte unica desses dois.

// Alerta: o pop-up da extensao e o aviso no WhatsApp disparam depois disso.
const DEFAULT_INACTIVITY_THRESHOLD_MINUTES = 15;
// Registro: relatorios, inativos e padrao de atendimento so contam o ticket
// depois disso. A diferenca para o alerta e a margem para o atendente responder
// o cliente antes de a parada virar ocorrencia.
const DEFAULT_INACTIVITY_RECORD_MINUTES = 18;
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
// Dias de historico de coletas no banco. Cada coleta grava de novo todos os
// tickets em atendimento, entao sem limite o banco so cresce.
const DEFAULT_RETENTION_DAYS = 60;
// Cliente sem TAG cuja ultima leitura e mais velha que isso sai sozinho da
// "Lista de tickets sem TAG". O historico continua no banco (RETENTION_DAYS)
// para os outros relatorios.
const DEFAULT_MISSING_TAG_LIST_DAYS = 10;
// Por quanto tempo uma resposta de relatorio do painel fica em cache na API.
const DEFAULT_REPORT_CACHE_SECONDS = 300;
// Analise de atendimento por IA (desligada por padrao). Teto de GETs em
// /messages/{ticketId} por coleta: a leitura e incremental e nunca pode virar
// "uma chamada por ticket a cada minuto".
const DEFAULT_MAX_MESSAGE_FETCHES = 20;
// Mensagens mascaradas ficam pouco tempo: sao o dado mais sensivel do banco.
const DEFAULT_MESSAGE_RETENTION_DAYS = 30;
// Conversa parada ha tanto tempo (ou ticket fechado) entra na fila da IA.
const DEFAULT_AI_ANALYSIS_IDLE_MINUTES = 20;
const DEFAULT_AI_ANALYSIS_MIN_MESSAGES = 4;
const DEFAULT_AI_ANALYSIS_MAX_MESSAGES = 80;
const DEFAULT_AI_ANALYSIS_MAX_PER_HOUR = 30;

// Limite do ALERTA (pop-up e WhatsApp).
function getInactivityThresholdMinutes() {
  return readPositiveInteger(process.env.INACTIVITY_THRESHOLD_MINUTES, DEFAULT_INACTIVITY_THRESHOLD_MINUTES);
}

// Limite do REGISTRO (relatorios e padrao de atendimento). Nunca fica abaixo do
// limite do alerta: o que alerta aos 15 min so vira ocorrencia depois da margem.
function getInactivityRecordMinutes() {
  const record = readPositiveInteger(process.env.INACTIVITY_RECORD_MINUTES, DEFAULT_INACTIVITY_RECORD_MINUTES);
  return Math.max(record, getInactivityThresholdMinutes());
}

// Minutos parado em que a nota de inatividade do "padrao de atendimento" chega a
// zero (ver service-standard.js). Padrao: 4x o limite do alerta. Valor menor ou
// igual ao limite de registro nao faz sentido e volta ao padrao.
function getServiceStandardZeroMinutes() {
  const record = getInactivityRecordMinutes();
  const fallback = Math.max(getInactivityThresholdMinutes() * 4, record + 1);
  const configured = readPositiveInteger(process.env.SERVICE_STANDARD_ZERO_MINUTES, fallback);
  return configured > record ? configured : fallback;
}

// Peso da INATIVIDADE (em %) no "Resultados" (ver results.js); a TAG leva o
// resto. Tem de ficar acima de 50 (inatividade pesa mais) e abaixo de 100: fora
// disso volta ao padrao.
const DEFAULT_RESULT_INACTIVITY_WEIGHT = 70;

function getResultInactivityWeight() {
  const configured = readPositiveInteger(process.env.RESULT_INACTIVITY_WEIGHT, DEFAULT_RESULT_INACTIVITY_WEIGHT);
  return configured > 50 && configured < 100 ? configured : DEFAULT_RESULT_INACTIVITY_WEIGHT;
}

function getTimeZone() {
  return String(process.env.MONITOR_TIME_ZONE || "").trim() || DEFAULT_TIME_ZONE;
}

// Zero e valido: desliga a limpeza e guarda tudo.
function getRetentionDays() {
  return readNonNegativeInteger(process.env.RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
}

// Zero desliga a limpeza: a lista volta a mostrar todo o historico.
function getMissingTagListDays() {
  return readNonNegativeInteger(process.env.MISSING_TAG_LIST_DAYS, DEFAULT_MISSING_TAG_LIST_DAYS);
}

// Zero desliga o cache: toda consulta vai direto ao banco.
function getReportCacheTtlMs() {
  return readNonNegativeInteger(process.env.REPORT_CACHE_SECONDS, DEFAULT_REPORT_CACHE_SECONDS) * 1000;
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

// Analise de atendimento por IA. Com AI_ATTENDANCE_ANALYSIS diferente de "1"
// o sistema se comporta como antes: nenhuma chamada a /messages e nenhuma
// tabela nova preenchida.
function getAttendanceConfig() {
  return {
    enabled: String(process.env.AI_ATTENDANCE_ANALYSIS || "").trim() === "1",
    // Zero e valido: liga a analise sem ler mensagens novas.
    maxMessageFetches: readNonNegativeInteger(process.env.MTALK_MAX_MESSAGE_FETCHES, DEFAULT_MAX_MESSAGE_FETCHES),
    // Aqui zero NAO desliga a limpeza (ao contrario de RETENTION_DAYS): guardar
    // mensagem para sempre nunca pode ser um descuido de configuracao.
    messageRetentionDays: readPositiveInteger(process.env.MESSAGE_RETENTION_DAYS, DEFAULT_MESSAGE_RETENTION_DAYS),
    idleMinutes: readPositiveInteger(process.env.AI_ANALYSIS_IDLE_MINUTES, DEFAULT_AI_ANALYSIS_IDLE_MINUTES),
    minMessages: readPositiveInteger(process.env.AI_ANALYSIS_MIN_MESSAGES, DEFAULT_AI_ANALYSIS_MIN_MESSAGES),
    maxMessages: readPositiveInteger(process.env.AI_ANALYSIS_MAX_MESSAGES, DEFAULT_AI_ANALYSIS_MAX_MESSAGES),
    // Zero pausa a analise automatica; o botao do painel continua funcionando.
    maxPerHour: readNonNegativeInteger(process.env.AI_ANALYSIS_MAX_PER_HOUR, DEFAULT_AI_ANALYSIS_MAX_PER_HOUR),
    // Vazio = OPENAI_MODEL.
    model: String(process.env.AI_ANALYSIS_MODEL || "").trim()
  };
}

// Alertas de inatividade no WhatsApp (whatsapp-alerts.service.js). Com
// WHATSAPP_ALERTS diferente de "1" nada e enviado.
const WHATSAPP_PROVIDERS = ["evolution", "waha", "callmebot"];
const DEFAULT_WHATSAPP_MAX_PER_HOUR = 20;
const DEFAULT_WHATSAPP_TIMEOUT_MS = 10000;

function getWhatsappConfig() {
  const provider = String(process.env.WHATSAPP_PROVIDER || "").trim().toLowerCase() || "evolution";

  return {
    enabled: String(process.env.WHATSAPP_ALERTS || "").trim() === "1",
    provider: WHATSAPP_PROVIDERS.includes(provider) ? provider : "",
    providerName: provider,
    apiUrl: String(process.env.WHATSAPP_API_URL || "").trim().replace(/\/+$/, ""),
    apiKey: String(process.env.WHATSAPP_API_KEY || "").trim(),
    // Evolution: nome da instancia. WAHA: nome da sessao.
    instance: String(process.env.WHATSAPP_INSTANCE || "").trim() || "default",
    recipients: String(process.env.WHATSAPP_RECIPIENTS || "")
      .split(/[,;\n]+/)
      .map((item) => item.trim())
      .filter(Boolean),
    // O nome do cliente e dado pessoal e sai do servidor para o provedor:
    // so vai na mensagem quando alguem liga de proposito.
    includeClientName: String(process.env.WHATSAPP_INCLUDE_CLIENT_NAME || "").trim() === "1",
    // Zero: um aviso por parada. Com valor, repete o aviso enquanto o ticket
    // continuar parado.
    reminderMinutes: readNonNegativeInteger(process.env.WHATSAPP_REMINDER_MINUTES, 0),
    // Mensagens por destinatario por hora (aviso + teste). Zero pausa os avisos.
    maxPerHour: readNonNegativeInteger(process.env.WHATSAPP_MAX_PER_HOUR, DEFAULT_WHATSAPP_MAX_PER_HOUR),
    timeoutMs: readPositiveInteger(process.env.WHATSAPP_TIMEOUT_MS, DEFAULT_WHATSAPP_TIMEOUT_MS)
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
  getAttendanceConfig,
  getInactivityRecordMinutes,
  getInactivityThresholdMinutes,
  getMissingTagListDays,
  getMtalkConfig,
  getReportCacheTtlMs,
  getResultInactivityWeight,
  getRetentionDays,
  getServiceStandardZeroMinutes,
  getTimeZone,
  getWhatsappConfig
};
