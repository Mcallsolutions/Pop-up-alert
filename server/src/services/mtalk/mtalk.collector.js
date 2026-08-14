// Coleta os tickets pela API oficial do MTalk e grava um snapshot.
//
// Custo por coleta (o objetivo e manter isso baixo):
//   - 1 chamada GET /queue a cada MTALK_QUEUE_CACHE_MINUTES (padrao 10 min);
//   - 1 chamada GET /tickets por status monitorado (padrao "open" e "pending");
//   - paginas extras so quando ha mais tickets que o tamanho de pagina.
// Nao ha nenhuma chamada por ticket: fila, atendente, empresa e tags ja vem
// dentro da propria listagem.

const { MAX_TICKETS_PER_SNAPSHOT, getInactivityThresholdMinutes, getMtalkConfig } = require("../../config/monitoring");
const { getAllowedQueues, normalizeQueueName } = require("../queue-filter");
const { saveSnapshot } = require("../ticket.service");
const { listQueues, listTickets } = require("./mtalk.client");
const { dedupeApiTickets, mapApiTicket } = require("./mtalk.mapper");

let queueCache = { ids: [], expiresAt: 0, resolvedNames: [] };
let useShowAll = true;

async function collectFromMtalk({ token, persist = true } = {}) {
  const config = getMtalkConfig();
  const startedAt = Date.now();
  const now = new Date();
  const requests = { queues: 0, tickets: 0 };

  const queues = await resolveMonitoredQueues({ token, config, requests });
  const apiTickets = await fetchMonitoredTickets({ token, config, queueIds: queues.ids, requests });

  const monitorados = dedupeApiTickets(apiTickets)
    .map((apiTicket) => mapApiTicket(apiTicket, { now }))
    .filter(Boolean);

  // Truncar aqui e melhor do que ver o snapshot inteiro ser recusado por
  // tamanho la na gravacao.
  const tickets = monitorados.slice(0, MAX_TICKETS_PER_SNAPSHOT);
  if (monitorados.length > tickets.length) {
    console.warn(`[MTalk] ${monitorados.length} tickets monitorados; gravando apenas os ${tickets.length} primeiros.`);
  }

  const threshold = getInactivityThresholdMinutes();
  const payload = {
    source: "mtalk-api",
    url: `${config.panelUrl}/tickets`,
    collectedAt: now.toISOString(),
    tickets,
    diagnostics: {
      origem: "api-oficial",
      filasResolvidas: queues.resolvedNames,
      ticketsRecebidos: apiTickets.length,
      ticketsMonitorados: tickets.length,
      requisicoes: requests.queues + requests.tickets,
      duracaoMs: Date.now() - startedAt
    }
  };

  // Mesma divisao dos relatorios: TAG so conta onde ha atendente vinculado;
  // inatividade conta tudo, inclusive quem esta aguardando na fila.
  const comResponsavel = tickets.filter((ticket) => String(ticket.attendant || "").trim());
  const totals = {
    totalTickets: tickets.length,
    totalWithTag: comResponsavel.filter((ticket) => ticket.tagStatus === "COM_TAG").length,
    totalWithoutTag: comResponsavel.filter((ticket) => ticket.tagStatus === "SEM_TAG").length,
    totalWithoutAttendant: tickets.length - comResponsavel.length,
    totalInactive: tickets.filter((ticket) => Number(ticket.inactivityMinutes || 0) > threshold).length
  };

  const saved = persist ? await saveSnapshot(payload) : null;

  return {
    ...totals,
    thresholdMinutes: threshold,
    snapshot: saved,
    diagnostics: payload.diagnostics,
    tickets
  };
}

// Os ids das filas monitoradas mudam pouco, entao ficam em cache: sem isso
// cada coleta gastaria uma chamada extra so para redescobrir os mesmos ids.
async function resolveMonitoredQueues({ token, config, requests }) {
  if (queueCache.expiresAt > Date.now()) {
    return queueCache;
  }

  try {
    const queues = await listQueues({ token, config });
    requests.queues += 1;

    const monitored = queues.filter((queue) => normalizeQueueName(queue?.name || ""));
    queueCache = {
      ids: monitored.map((queue) => Number(queue.id)).filter((id) => Number.isFinite(id)),
      resolvedNames: monitored.map((queue) => String(queue.name)),
      expiresAt: Date.now() + config.queueCacheTtlMs
    };
  } catch (error) {
    // Sem a lista de filas a coleta continua: o filtro por nome no mapper faz
    // o mesmo recorte, so que descartando os tickets ja depois de recebidos.
    console.warn("[MTalk] Nao foi possivel listar as filas, seguindo sem filtro por fila:", error.message);
    queueCache = { ids: [], resolvedNames: [], expiresAt: Date.now() + 60000 };
  }

  return queueCache;
}

async function fetchMonitoredTickets({ token, config, queueIds, requests }) {
  const collected = [];

  for (const status of config.statuses) {
    // O teto de paginas vale por status: encher o limite lendo os tickets
    // abertos nao pode deixar os pendentes de fora.
    for (let pageNumber = 1; pageNumber <= config.maxPages; pageNumber += 1) {
      const page = await fetchTicketPage({ token, config, status, pageNumber, queueIds, requests });
      collected.push(...page.tickets);

      if (!page.hasMore || page.tickets.length < config.pageSize) {
        break;
      }
    }
  }

  return collected;
}

// "showAll" so e aceito para perfis administrativos. Quando o MTalk recusa, a
// coleta segue sem ele: o token le as filas as quais o usuario pertence.
async function fetchTicketPage({ token, config, status, pageNumber, queueIds, requests }) {
  if (useShowAll) {
    try {
      const page = await listTickets({ token, config, status, pageNumber, queueIds, showAll: true });
      requests.tickets += 1;
      return page;
    } catch (error) {
      requests.tickets += 1;
      if (error.statusCode === 401) {
        throw error;
      }
      useShowAll = false;
      console.warn("[MTalk] showAll recusado pela API, seguindo apenas com as filas do usuario:", error.message);
    }
  }

  const page = await listTickets({ token, config, status, pageNumber, queueIds, showAll: false });
  requests.tickets += 1;
  return page;
}

function describeCollectorStatus() {
  const config = getMtalkConfig();
  return {
    configurado: config.isConfigured,
    baseUrl: config.baseUrl,
    statusMonitorados: config.statuses,
    filasMonitoradas: getAllowedQueues(),
    limiteInatividadeMinutos: getInactivityThresholdMinutes(),
    cacheFilas: {
      filas: queueCache.resolvedNames,
      validoAte: queueCache.expiresAt ? new Date(queueCache.expiresAt).toISOString() : null
    }
  };
}

function resetQueueCache() {
  queueCache = { ids: [], expiresAt: 0, resolvedNames: [] };
  useShowAll = true;
}

module.exports = {
  collectFromMtalk,
  describeCollectorStatus,
  resetQueueCache
};
