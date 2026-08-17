// Coleta os tickets pela API oficial do MTalk e grava um snapshot.
//
// Custo por coleta (o objetivo e manter isso baixo):
//   - 1 chamada GET /queue a cada MTALK_QUEUE_CACHE_MINUTES (padrao 10 min);
//   - 1 chamada GET /tags/list a cada MTALK_TAG_CACHE_MINUTES (padrao 10 min);
//   - 1 chamada GET /tickets por status monitorado (padrao "open" e "pending");
//   - paginas extras so quando ha mais tickets que o tamanho de pagina;
//   - no maximo MTALK_MAX_CONTACT_LOOKUPS chamadas GET /contacts/{id}, e so
//     quando a listagem nao devolveu as TAGs do cliente (ver fillContactTags).
// Fila, atendente, empresa e TAGs ja vem dentro da propria listagem.

const { MAX_TICKETS_PER_SNAPSHOT, getInactivityThresholdMinutes, getMtalkConfig } = require("../../config/monitoring");
const { getAllowedQueues, normalizeQueueName } = require("../queue-filter");
const { saveSnapshot } = require("../ticket.service");
const { getContact, listQueues, listTags, listTickets } = require("./mtalk.client");
const { dedupeApiTickets, mapApiTicket } = require("./mtalk.mapper");
const { EMPTY_CATALOG, buildTagCatalog, contactIdForTagLookup, contactTagValues } = require("./mtalk.tags");

let queueCache = { ids: [], expiresAt: 0, resolvedNames: [] };
let tagCatalogCache = { catalog: EMPTY_CATALOG, expiresAt: 0 };
let useShowAll = true;

async function collectFromMtalk({ token, persist = true } = {}) {
  const config = getMtalkConfig();
  const startedAt = Date.now();
  const now = new Date();
  const requests = { queues: 0, tags: 0, tickets: 0, contacts: 0 };

  const [queues, tagCatalog] = await Promise.all([
    resolveMonitoredQueues({ token, config, requests }),
    resolveTagCatalog({ token, config, requests })
  ]);
  const apiTickets = await fetchMonitoredTickets({ token, config, queueIds: queues.ids, requests });

  // O ticket cru anda junto do mapeado: fillContactTags precisa dos dois para
  // remapear so quem ainda parece sem TAG.
  const mapeados = dedupeApiTickets(apiTickets)
    .map((apiTicket) => ({ apiTicket, ticket: mapApiTicket(apiTicket, { now, tagCatalog }) }))
    .filter((item) => item.ticket);

  await fillContactTags({ token, config, items: mapeados, tagCatalog, now, requests });

  const monitorados = mapeados.map((item) => item.ticket);

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
      tagsCadastradas: tagCatalog.names.length,
      contatosConsultados: requests.contacts,
      ticketsRecebidos: apiTickets.length,
      ticketsMonitorados: tickets.length,
      requisicoes: requests.queues + requests.tags + requests.tickets + requests.contacts,
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

// O catalogo de TAGs (GET /tags/list) da nome ao vinculo que a listagem manda
// so com o id e permite descartar vinculo de TAG ja excluida. Fica em cache
// como as filas: sao dados de cadastro, mudam raramente.
async function resolveTagCatalog({ token, config, requests }) {
  if (tagCatalogCache.expiresAt > Date.now()) {
    return tagCatalogCache.catalog;
  }

  try {
    const tags = await listTags({ token, config });
    requests.tags += 1;
    tagCatalogCache = {
      catalog: buildTagCatalog(tags),
      expiresAt: Date.now() + config.tagCacheTtlMs
    };
  } catch (error) {
    // Sem o catalogo a coleta continua: as TAGs que vem com nome na listagem
    // seguem valendo, e as que vem so com id contam como TAG sem nome — o que
    // importa para o alerta e existir vinculo.
    requests.tags += 1;
    console.warn("[MTalk] Nao foi possivel ler o catalogo de TAGs (/tags/list):", error.message);
    tagCatalogCache = { catalog: EMPTY_CATALOG, expiresAt: Date.now() + 60000 };
  }

  return tagCatalogCache.catalog;
}

// Segunda passada, so para os tickets que continuariam no alerta de TAG.
//
// Algumas instancias nao devolvem contact.tags dentro de GET /tickets. Nessas,
// a TAG que o atendente vinculou ao CLIENTE nunca chegava aqui e o ticket
// ficava preso no alerta. A consulta ao contato resolve, e o custo fica preso
// em tres travas: so ticket sem TAG, so ticket com atendente, e no maximo
// config.maxContactLookups chamadas por coleta.
async function fillContactTags({ token, config, items, tagCatalog, now, requests }) {
  if (!config.maxContactLookups) {
    return;
  }

  const pendentes = items
    .filter(
      (item) =>
        item.ticket.tagStatus === "SEM_TAG" &&
        String(item.ticket.attendant || "").trim() &&
        contactIdForTagLookup(item.apiTicket)
    )
    .slice(0, config.maxContactLookups);

  for (const item of pendentes) {
    const contactId = contactIdForTagLookup(item.apiTicket);

    try {
      const contact = await getContact({ token, config, contactId });
      requests.contacts += 1;

      const contactTags = contactTagValues(contact);
      if (!contactTags.length) {
        continue;
      }

      item.ticket = mapApiTicket(item.apiTicket, { now, tagCatalog, contactTags }) || item.ticket;
    } catch (error) {
      // Erro aqui costuma ser do token ou da instancia (endpoint indisponivel),
      // nao daquele contato: insistir nos demais so gastaria requisicao.
      requests.contacts += 1;
      console.warn(`[MTalk] Nao foi possivel ler as TAGs do contato ${contactId}:`, error.message);
      return;
    }
  }
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
    maxConsultasContato: config.maxContactLookups,
    cacheFilas: {
      filas: queueCache.resolvedNames,
      validoAte: queueCache.expiresAt ? new Date(queueCache.expiresAt).toISOString() : null
    },
    cacheTags: {
      tags: tagCatalogCache.catalog.names,
      validoAte: tagCatalogCache.expiresAt ? new Date(tagCatalogCache.expiresAt).toISOString() : null
    }
  };
}

function resetQueueCache() {
  queueCache = { ids: [], expiresAt: 0, resolvedNames: [] };
  tagCatalogCache = { catalog: EMPTY_CATALOG, expiresAt: 0 };
  useShowAll = true;
}

module.exports = {
  collectFromMtalk,
  describeCollectorStatus,
  resetQueueCache
};
