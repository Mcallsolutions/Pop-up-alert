// Coleta os tickets pela API oficial do MTalk, grava o snapshot e guarda a
// ultima leitura em memoria para os alertas (GET /api/alerts).
//
// O servidor e o unico lugar que conversa com o MTalk. Custo por coleta:
//   - 1 chamada GET /tickets por status monitorado: "open" com showAll=true e
//     "pending" sem ele, as duas ja filtradas por queueIds;
//   - paginas extras so quando ha mais tickets que o tamanho de pagina;
//   - 1 chamada GET /queue a cada MTALK_QUEUE_CACHE_MINUTES (padrao 60 min);
//   - GET /tags/list so quando algum vinculo de TAG chega sem nome, e no maximo
//     1 vez a cada MTALK_TAG_CACHE_MINUTES (padrao 10 min);
//   - GET /contacts/{id} so para ticket que continuaria no alerta de TAG e cujo
//     contato veio sem o campo de TAGs, com cache por contato e no maximo
//     MTALK_MAX_CONTACT_LOOKUPS consultas novas por coleta.
// A autenticacao (URL + token) fica em mtalk.client.js.

const { MAX_TICKETS_PER_SNAPSHOT, getInactivityThresholdMinutes, getMtalkConfig } = require("../../config/monitoring");
const { normalizeAttendantName } = require("../attendant-filter");
const { getAllowedQueues, normalizeQueueName } = require("../queue-filter");
const { saveSnapshot } = require("../ticket.service");
const { toZonedIso } = require("../time-zone");
const { describeSession, getContact, listQueues, listTags, listTickets } = require("./mtalk.client");
const { dedupeApiTickets, mapApiTicket } = require("./mtalk.mapper");
const {
  EMPTY_CATALOG,
  buildTagCatalog,
  contactIdForTagLookup,
  contactTagValues,
  needsTagCatalog,
  ticketNeedsTagCatalog
} = require("./mtalk.tags");

// A aba de pendentes do painel do MTalk nao manda showAll: ticket aguardando ja
// vem de todas as filas informadas em queueIds.
const STATUSES_WITHOUT_SHOW_ALL = new Set(["pending"]);
const MAX_ALERT_ITEMS = 6;

let queueCache = { ids: [], expiresAt: 0, resolvedNames: [] };
let tagCatalogCache = { catalog: EMPTY_CATALOG, expiresAt: 0 };
// contactId -> { values, expiresAt }: TAGs lidas de GET /contacts/{id}.
const contactTagCache = new Map();
let useShowAll = true;

// Estado do agendamento e da ultima leitura bem-sucedida.
let schedulerTimer = null;
let runningCollection = null;
let lastCollection = null;
let lastRun = { startedAt: null, finishedAt: null, ok: null, error: null, reason: null };

async function collectFromMtalk({ persist = true } = {}) {
  const config = getMtalkConfig();
  const startedAt = Date.now();
  const now = new Date();
  const requests = { tickets: 0, queues: 0, tags: 0, contacts: 0 };

  const queues = await resolveMonitoredQueues({ config, requests });
  const apiTickets = await fetchMonitoredTickets({ config, queueIds: queues.ids, requests });
  const uniqueTickets = dedupeApiTickets(apiTickets);

  // A listagem costuma trazer a TAG com o nome; o catalogo so e lido quando
  // algum vinculo chega apenas com o id.
  const tagCatalog = uniqueTickets.some(ticketNeedsTagCatalog) ? await resolveTagCatalog({ config, requests }) : EMPTY_CATALOG;

  // O ticket cru anda junto do mapeado: fillContactTags precisa dos dois para
  // remapear so quem ainda parece sem TAG.
  const mapOptions = { now, tagCatalog, panelUrl: config.panelUrl };
  const mapeados = uniqueTickets
    .map((apiTicket) => ({ apiTicket, ticket: mapApiTicket(apiTicket, mapOptions) }))
    .filter((item) => item.ticket);

  await fillContactTags({ config, items: mapeados, tagCatalog, now, requests });

  const monitorados = mapeados.map((item) => item.ticket);
  const tickets = monitorados.slice(0, MAX_TICKETS_PER_SNAPSHOT);
  if (monitorados.length > tickets.length) {
    console.warn(`[MTalk] ${monitorados.length} tickets monitorados; gravando apenas os ${tickets.length} primeiros.`);
  }

  const threshold = getInactivityThresholdMinutes();
  const collectedAt = toZonedIso(now);
  const diagnostics = {
    filasResolvidas: queues.resolvedNames,
    ticketsRecebidos: apiTickets.length,
    ticketsMonitorados: tickets.length,
    requisicoes: requests.tickets + requests.queues + requests.tags + requests.contacts,
    requisicoesPorEndpoint: {
      "GET /tickets": requests.tickets,
      "GET /queue": requests.queues,
      "GET /tags/list": requests.tags,
      "GET /contacts/{id}": requests.contacts
    },
    duracaoMs: Date.now() - startedAt
  };

  const totals = computeTotals(tickets, threshold);

  const saved = persist
    ? await saveSnapshot({ source: "mtalk-api", url: `${config.panelUrl}/tickets`, collectedAt, tickets })
    : null;

  lastCollection = { collectedAt, thresholdMinutes: threshold, totals, diagnostics, tickets };

  return {
    ...totals,
    thresholdMinutes: threshold,
    collectedAt,
    snapshot: saved,
    diagnostics,
    tickets
  };
}

// Uma coleta por vez: o disparo manual durante uma coleta agendada espera a
// que ja esta em andamento em vez de dobrar as chamadas ao MTalk.
function runCollection({ persist = true, reason = "agendada" } = {}) {
  if (runningCollection) {
    return runningCollection;
  }

  lastRun = { ...lastRun, startedAt: new Date().toISOString(), reason };
  runningCollection = collectFromMtalk({ persist })
    .then((result) => {
      lastRun = { ...lastRun, finishedAt: new Date().toISOString(), ok: true, error: null };
      return result;
    })
    .catch((error) => {
      lastRun = { ...lastRun, finishedAt: new Date().toISOString(), ok: false, error: error.message };
      throw error;
    })
    .finally(() => {
      runningCollection = null;
    });

  return runningCollection;
}

function startCollector() {
  const config = getMtalkConfig();

  if (!config.isConfigured) {
    console.warn("[MTalk] Coleta automatica desligada: defina MTALK_BASE_URL e MTALK_TOKEN no .env e reinicie a API.");
    return false;
  }

  if (!config.collectIntervalMs) {
    console.warn("[MTalk] Coleta automatica desligada (MTALK_COLLECT_INTERVAL_SECONDS=0).");
    return false;
  }

  const tick = () =>
    runCollection({ reason: "agendada" }).catch((error) => {
      console.error("[MTalk] Falha na coleta:", error.message);
    });

  stopCollector();
  tick();
  schedulerTimer = setInterval(tick, config.collectIntervalMs);
  console.log(`[MTalk] Coleta automatica a cada ${config.collectIntervalMs / 1000}s em ${config.baseUrl}.`);
  return true;
}

function stopCollector() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

// Alertas da ultima leitura, no formato que o pop-up da extensao desenha.
//
// scope.attendant recorta a lista para um atendente so. Ticket SEM atendente
// continua indo para todo mundo de proposito: ninguem e dono dele, e cliente
// esquecido na fila e justamente o que nao pode passar despercebido.
function getCurrentAlerts({ attendant = null } = {}) {
  const config = getMtalkConfig();
  const collection = lastCollection;
  const tickets = scopeTickets(collection?.tickets || [], attendant);
  const threshold = collection?.thresholdMinutes ?? getInactivityThresholdMinutes();
  const identificados = tickets.filter((ticket) => String(ticket.clientName || "").trim());
  // Ticket aguardando na fila nao tem a quem cobrar a TAG, mas continua no
  // alerta de inatividade — mesma regra dos relatorios.
  const missingTag = identificados.filter((ticket) => ticket.tagStatus === "SEM_TAG" && hasResponsible(ticket));
  const inactive = identificados
    .filter((ticket) => Number(ticket.inactivityMinutes || 0) > threshold)
    .sort((a, b) => Number(b.inactivityMinutes || 0) - Number(a.inactivityMinutes || 0));
  const ageMs = collection ? Date.now() - new Date(collection.collectedAt).getTime() : null;
  // Leitura velha nao pode continuar gerando alerta como se fosse o agora.
  const staleAfterMs = Math.max(config.collectIntervalMs * 3, 3 * 60 * 1000);

  return {
    collectedAt: collection?.collectedAt || null,
    stale: ageMs === null || ageMs > staleAfterMs,
    thresholdMinutes: threshold,
    // Recalculado no recorte: os totais precisam contar o mesmo que as listas.
    totals: collection ? computeTotals(tickets, threshold) : null,
    scope: { attendant: attendant || null },
    lastError: lastRun.ok === false ? lastRun.error : null,
    missingTag: { total: missingTag.length, items: missingTag.slice(0, MAX_ALERT_ITEMS).map(toAlertItem) },
    inactive: {
      total: inactive.length,
      items: inactive.slice(0, MAX_ALERT_ITEMS).map(toAlertItem),
      // Todos os inativos COM atendente, sem o corte de MAX_ALERT_ITEMS: quem
      // acabou de passar do limite e o menos parado da lista e cairia fora dos
      // itens. A extensao compara com a consulta anterior para tocar o bip.
      assignedTicketIds: inactive.filter(hasResponsible).map((ticket) => ticket.externalTicketId)
    }
  };
}

function toAlertItem(ticket) {
  return {
    externalTicketId: ticket.externalTicketId,
    ticketUuid: ticket.ticketUuid,
    url: ticket.ticketUrl,
    clientName: ticket.clientName,
    queue: ticket.queue,
    attendant: ticket.attendant,
    company: ticket.company,
    displayTime: ticket.displayTime,
    inactivityMinutes: ticket.inactivityMinutes
  };
}

function hasResponsible(ticket) {
  return Boolean(String(ticket?.attendant || "").trim());
}

// Recorte por atendente: os tickets dele mais todos os que estao sem dono.
function scopeTickets(tickets, attendant) {
  const canonical = normalizeAttendantName(attendant);
  if (!canonical) {
    return tickets;
  }

  const alvo = canonical.toUpperCase();
  return tickets.filter(
    (ticket) => !hasResponsible(ticket) || normalizeAttendantName(ticket.attendant).toUpperCase() === alvo
  );
}

// Mesma divisao dos relatorios: TAG so conta onde ha atendente vinculado;
// inatividade conta tudo, inclusive quem esta aguardando na fila.
function computeTotals(tickets, threshold) {
  const comResponsavel = tickets.filter(hasResponsible);

  return {
    totalTickets: tickets.length,
    totalWithTag: comResponsavel.filter((ticket) => ticket.tagStatus === "COM_TAG").length,
    totalWithoutTag: comResponsavel.filter((ticket) => ticket.tagStatus === "SEM_TAG").length,
    totalWithoutAttendant: tickets.length - comResponsavel.length,
    totalInactive: tickets.filter((ticket) => Number(ticket.inactivityMinutes || 0) > threshold).length
  };
}

// Os ids das filas monitoradas mudam pouco, entao ficam em cache.
async function resolveMonitoredQueues({ config, requests }) {
  if (queueCache.expiresAt > Date.now()) {
    return queueCache;
  }

  try {
    const queues = await listQueues({ config });
    requests.queues += 1;

    const monitored = queues.filter((queue) => normalizeQueueName(queue?.name || ""));
    queueCache = {
      ids: monitored.map((queue) => Number(queue.id)).filter((id) => Number.isFinite(id)),
      resolvedNames: monitored.map((queue) => String(queue.name)),
      expiresAt: Date.now() + config.queueCacheTtlMs
    };
  } catch (error) {
    requests.queues += 1;
    // Sessao recusada e credencial ausente derrubam a coleta inteira.
    if (error.statusCode === 401 || error.statusCode === 503) {
      throw error;
    }
    // Sem a lista de filas a coleta continua: o filtro por nome no mapper faz
    // o mesmo recorte, so que descartando os tickets ja depois de recebidos.
    console.warn("[MTalk] Nao foi possivel listar as filas, seguindo sem filtro por fila:", error.message);
    queueCache = { ids: [], resolvedNames: [], expiresAt: Date.now() + 60000 };
  }

  return queueCache;
}

// O catalogo de TAGs (GET /tags/list) da nome ao vinculo que chega so com o id
// e permite descartar vinculo de TAG ja excluida.
async function resolveTagCatalog({ config, requests }) {
  if (tagCatalogCache.expiresAt > Date.now()) {
    return tagCatalogCache.catalog;
  }

  try {
    const tags = await listTags({ config });
    requests.tags += 1;
    tagCatalogCache = {
      catalog: buildTagCatalog(tags),
      expiresAt: Date.now() + config.tagCacheTtlMs
    };
  } catch (error) {
    // Sem o catalogo a coleta continua: o que importa para o alerta e existir
    // vinculo, nao o nome.
    requests.tags += 1;
    console.warn("[MTalk] Nao foi possivel ler o catalogo de TAGs (/tags/list):", error.message);
    tagCatalogCache = { catalog: EMPTY_CATALOG, expiresAt: Date.now() + 60000 };
  }

  return tagCatalogCache.catalog;
}

// Segunda passada, so para os tickets que continuariam no alerta de TAG.
//
// Algumas instancias nao devolvem contact.tags dentro de GET /tickets; nelas a
// TAG vinculada ao CLIENTE so aparece consultando o contato. O custo fica preso
// em quatro travas: so ticket sem TAG, so ticket com atendente, cache por
// contato e no maximo config.maxContactLookups consultas novas por coleta.
async function fillContactTags({ config, items, tagCatalog, now, requests }) {
  if (!config.maxContactLookups) {
    return;
  }

  pruneContactTagCache();

  const candidatos = items.filter(
    (item) => item.ticket.tagStatus === "SEM_TAG" && hasResponsible(item.ticket) && contactIdForTagLookup(item.apiTicket)
  );

  const comTagDoContato = [];
  let consultasNovas = 0;

  for (const item of candidatos) {
    const contactId = contactIdForTagLookup(item.apiTicket);
    let values = readCachedContactTags(contactId);

    if (!values) {
      if (consultasNovas >= config.maxContactLookups) {
        continue;
      }
      consultasNovas += 1;

      try {
        const contact = await getContact({ config, contactId });
        requests.contacts += 1;
        values = contactTagValues(contact);
        cacheContactTags(contactId, values, config);
      } catch (error) {
        // Erro aqui costuma ser da sessao ou da instancia, nao daquele contato.
        requests.contacts += 1;
        console.warn(`[MTalk] Nao foi possivel ler as TAGs do contato ${contactId}:`, error.message);
        break;
      }
    }

    if (values.length) {
      comTagDoContato.push({ item, values });
    }
  }

  if (!comTagDoContato.length) {
    return;
  }

  // TAG do cliente que veio so com o id precisa do catalogo para ganhar nome.
  const catalog =
    !tagCatalog.loaded && comTagDoContato.some(({ values }) => needsTagCatalog(values))
      ? await resolveTagCatalog({ config, requests })
      : tagCatalog;

  for (const { item, values } of comTagDoContato) {
    item.ticket =
      mapApiTicket(item.apiTicket, { now, tagCatalog: catalog, contactTags: values, panelUrl: config.panelUrl }) ||
      item.ticket;
  }
}

function readCachedContactTags(contactId) {
  const entry = contactTagCache.get(contactId);
  return entry && entry.expiresAt > Date.now() ? entry.values : null;
}

function cacheContactTags(contactId, values, config) {
  const ttl = values.length ? config.contactTaggedCacheTtlMs : config.contactUntaggedCacheTtlMs;
  contactTagCache.set(contactId, { values, expiresAt: Date.now() + ttl });
}

function pruneContactTagCache() {
  const agora = Date.now();
  for (const [contactId, entry] of contactTagCache) {
    if (entry.expiresAt <= agora) {
      contactTagCache.delete(contactId);
    }
  }
}

async function fetchMonitoredTickets({ config, queueIds, requests }) {
  const collected = [];

  for (const status of config.statuses) {
    // O teto de paginas vale por status: encher o limite lendo os tickets
    // abertos nao pode deixar os pendentes de fora.
    for (let pageNumber = 1; pageNumber <= config.maxPages; pageNumber += 1) {
      const page = await fetchTicketPage({ config, status, pageNumber, queueIds, requests });
      collected.push(...page.tickets);

      if (!page.hasMore || page.tickets.length < config.pageSize) {
        break;
      }
    }
  }

  return collected;
}

// showAll so vai onde o painel do MTalk tambem manda (fora da aba de pendentes)
// e so e aceito para perfis administrativos: quando o MTalk recusa, a coleta
// segue sem ele e le as filas as quais o usuario pertence. Sessao recusada e
// falha de rede nao dizem nada sobre o showAll, entao nao o desligam.
async function fetchTicketPage({ config, status, pageNumber, queueIds, requests }) {
  if (useShowAll && !STATUSES_WITHOUT_SHOW_ALL.has(status)) {
    try {
      const page = await listTickets({ config, status, pageNumber, queueIds, showAll: true });
      requests.tickets += 1;
      return page;
    } catch (error) {
      requests.tickets += 1;
      if (error.statusCode === 401 || error.statusCode === 503 || error.noResponse) {
        throw error;
      }
      useShowAll = false;
      console.warn("[MTalk] showAll recusado pela API, seguindo apenas com as filas do usuario:", error.message);
    }
  }

  const page = await listTickets({ config, status, pageNumber, queueIds, showAll: false });
  requests.tickets += 1;
  return page;
}

function describeCollectorStatus({ isAdmin = true } = {}) {
  const config = getMtalkConfig();
  const comum = {
    configurado: config.isConfigured,
    sessao: describeSession(),
    coletaAutomatica: {
      ativa: Boolean(schedulerTimer),
      intervaloSegundos: config.collectIntervalMs / 1000,
      emAndamento: Boolean(runningCollection),
      ultimaExecucao: lastRun
    },
    filasMonitoradas: getAllowedQueues(),
    limiteInatividadeMinutos: getInactivityThresholdMinutes()
  };

  // Atendente ve o suficiente para saber se a coleta esta de pe; os numeros da
  // operacao inteira e o diagnostico sao do ADMIN.
  if (!isAdmin) {
    return {
      ...comum,
      ultimaColeta: lastCollection ? { coletadoEm: lastCollection.collectedAt } : null
    };
  }

  return {
    ...comum,
    baseUrl: config.baseUrl,
    ultimaColeta: lastCollection
      ? { coletadoEm: lastCollection.collectedAt, ...lastCollection.totals, diagnostico: lastCollection.diagnostics }
      : null,
    statusMonitorados: config.statuses,
    maxConsultasContato: config.maxContactLookups,
    cacheFilas: {
      filas: queueCache.resolvedNames,
      validoAte: queueCache.expiresAt ? new Date(queueCache.expiresAt).toISOString() : null
    },
    contatosEmCache: contactTagCache.size
  };
}

module.exports = {
  describeCollectorStatus,
  getCurrentAlerts,
  runCollection,
  startCollector,
  stopCollector
};
