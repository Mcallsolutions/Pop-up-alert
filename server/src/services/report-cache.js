// Cache em memoria das respostas de relatorio do painel.
//
// Os relatorios varrem o historico de leituras (uma linha por ticket a cada
// coleta) com funcoes de janela, e o node:sqlite e sincrono: enquanto uma
// consulta dessas roda, a API inteira espera — inclusive os alertas da
// extensao. O Dashboard sozinho dispara tres consultas e os Relatorios repetem
// duas delas. Aqui a resposta de cada combinacao de rota + filtros fica
// guardada por REPORT_CACHE_SECONDS (padrao 5 min; 0 desliga):
// - `fresh` (botao Atualizar e a atualizacao automatica do Dashboard) ignora o
//   que esta guardado e grava o resultado novo;
// - erro nunca fica em cache;
// - a coleta manual do painel e a limpeza do historico esvaziam o cache.
// Fica so em memoria, por processo: reiniciar a API comeca do zero.

const { getReportCacheTtlMs } = require("../config/monitoring");

// Teto de respostas guardadas. Passando dele saem as vencidas e, se ainda
// precisar, as mais antigas.
const MAX_ENTRIES = 200;

// Campos que mudam o resultado de algum relatorio. Qualquer outro parametro da
// query string fica de fora da chave, para nao virar uma entrada nova a cada
// valor inventado.
const KEY_FIELDS = [
  "day",
  "startDate",
  "endDate",
  "attendant",
  "queue",
  "company",
  "clientName",
  "limit",
  "page",
  "pageSize",
  "scopeAttendant"
];

const entries = new Map();

async function getCachedReport(name, filters, loader, { fresh = false } = {}) {
  const ttlMs = getReportCacheTtlMs();
  const key = buildCacheKey(name, filters);
  const cached = entries.get(key);

  if (ttlMs && !fresh && cached && cached.expiresAt > Date.now()) {
    return { value: cached.value, hit: true, storedAt: cached.storedAt };
  }

  const value = await loader();
  const storedAt = Date.now();
  if (ttlMs) {
    store(key, { value, storedAt, expiresAt: storedAt + ttlMs });
  }
  return { value, hit: false, storedAt };
}

function buildCacheKey(name, filters = {}) {
  const parts = KEY_FIELDS.map((field) => [field, String(filters[field] ?? "").trim()]).filter(([, value]) => value);
  return `${name}?${new URLSearchParams(parts).toString()}`;
}

function store(key, entry) {
  // O Map guarda a ordem de insercao: reinserir manda a chave para o fim.
  entries.delete(key);
  entries.set(key, entry);

  if (entries.size <= MAX_ENTRIES) {
    return;
  }

  const now = Date.now();
  for (const [candidate, value] of entries) {
    if (value.expiresAt <= now) {
      entries.delete(candidate);
    }
  }
  while (entries.size > MAX_ENTRIES) {
    entries.delete(entries.keys().next().value);
  }
}

function clearReportCache() {
  entries.clear();
}

function describeReportCache() {
  return { ttlSeconds: getReportCacheTtlMs() / 1000, entradas: entries.size, maxEntradas: MAX_ENTRIES };
}

module.exports = {
  buildCacheKey,
  clearReportCache,
  describeReportCache,
  getCachedReport
};
