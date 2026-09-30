// Cliente HTTP da API oficial do MTalk (Ticketz).
//
// Autenticacao por URL + token: MTALK_BASE_URL aponta para o backend da
// instancia e MTALK_TOKEN vai em "Authorization: Bearer <token>" em cada
// leitura. O servidor nao faz login nem renova o token: quando o MTalk recusa
// (401 ou 403), a coleta falha e o erro aparece no painel ate o token ser
// trocado no .env.
//
// Leituras usadas pelo monitor, no mesmo formato do painel do MTalk
// (levantamento em "Mtalk integration/mtalk-api-endpoints.md"):
//   GET /tickets             -> tickets em atendimento ("open") e aguardando ("pending")
//   GET /queue               -> ids das filas monitoradas, para o filtro queueIds
//   GET /tags/list           -> catalogo de TAGs, quando um vinculo chega sem nome
//   GET /contacts/{id}       -> TAGs do cliente, quando a listagem nao as traz
//   GET /messages/{ticketId} -> mensagens do ticket, SO com a analise de
//                               atendimento ligada (AI_ATTENDANCE_ANALYSIS=1)
// O painel do MTalk chama /messages com markAsRead=true, que marca a conversa
// como lida para o atendente. Aqui esse parametro nao existe: listMessages
// monta a query so com nextId e minUpdatedAt, e nada que venha de fora entra
// nela. Ficam de fora de proposito todas as rotas de escrita (POST/PUT/DELETE),
// que atingem o atendimento e o cliente real.
//
// Este modulo so fala HTTP: nao normaliza nem filtra nada. A traducao para o
// formato interno fica em mtalk.mapper.js.

const { getMtalkConfig } = require("../../config/monitoring");

// Resultado da ultima chamada, para o painel saber se o token esta valendo.
let session = createEmptySession();

function createEmptySession() {
  return { lastSuccessAt: null, lastError: "" };
}

// GET /backend/queue -> cadastro de filas ({ id, name, ... }). Traduz os NOMES
// das filas monitoradas nos ids que o filtro queueIds exige.
async function listQueues({ config = getMtalkConfig() } = {}) {
  const data = await requestMtalk("/queue", { config });
  return Array.isArray(data) ? data : toArray(data?.queues);
}

// Mesmo formato das abas do painel do MTalk (mtalk-api-endpoints.md, secao 3):
//   GET /backend/tickets?status=open&showAll=true&queueIds=[...]
//   GET /backend/tickets?status=pending&queueIds=[...]
// pageNumber so entra a partir da segunda pagina. Resposta: { tickets, count, hasMore }
async function listTickets({ config = getMtalkConfig(), status, pageNumber = 1, queueIds = [], showAll = false } = {}) {
  const query = {
    status,
    showAll: showAll ? "true" : "",
    queueIds: queueIds.length ? JSON.stringify(queueIds) : "",
    pageNumber: pageNumber > 1 ? String(pageNumber) : ""
  };

  const data = await requestMtalk("/tickets", { config, query });

  return {
    tickets: toArray(data?.tickets),
    count: Number(data?.count || 0),
    hasMore: Boolean(data?.hasMore)
  };
}

// GET /backend/tags/list -> array de { id, name, color, kanban }; algumas
// versoes embrulham em { tags }.
async function listTags({ config = getMtalkConfig() } = {}) {
  const data = await requestMtalk("/tags/list", { config });
  return Array.isArray(data) ? data : toArray(data?.tags);
}

// GET /backend/contacts/{id} -> cadastro do contato, com as TAGs vinculadas.
async function getContact({ config = getMtalkConfig(), contactId } = {}) {
  const id = String(contactId ?? "").trim();
  if (!id) {
    return null;
  }

  return requestMtalk(`/contacts/${encodeURIComponent(id)}`, { config });
}

// GET /backend/messages/{ticketId} -> { count, messages[], ticket, hasMore, nextId }
//   nextId       -> pagina para tras (mensagens mais antigas);
//   minUpdatedAt -> so o que mudou depois dessa data (novas, editadas, apagadas).
// A assinatura nao aceita markAsRead nem outro parametro livre de proposito:
// ler a conversa pelo monitor nunca pode zerar o "nao lidas" do atendente.
async function listMessages({ config = getMtalkConfig(), ticketId, minUpdatedAt, nextId } = {}) {
  const { path, query } = buildMessagesRequest({ ticketId, minUpdatedAt, nextId });
  const data = await requestMtalk(path, { config, query });

  return {
    messages: toArray(data?.messages),
    count: Number(data?.count || 0),
    hasMore: Boolean(data?.hasMore),
    nextId: data?.nextId ?? null
  };
}

// Separado para o teste provar que markAsRead nunca entra na URL.
function buildMessagesRequest({ ticketId, minUpdatedAt, nextId } = {}) {
  const id = String(ticketId ?? "").trim();
  if (!/^\d+$/.test(id)) {
    throw buildError("Identificador de ticket invalido para ler as mensagens.", 400);
  }

  return {
    path: `/messages/${encodeURIComponent(id)}`,
    query: {
      nextId: nextId === undefined || nextId === null ? "" : String(nextId),
      minUpdatedAt: minUpdatedAt ? String(minUpdatedAt) : ""
    }
  };
}

function buildMtalkUrl(baseUrl, path, query = {}) {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

// So GET: este cliente nao tem, de proposito, nenhuma chamada de escrita.
async function requestMtalk(path, { config = getMtalkConfig(), query = {} } = {}) {
  if (!config.token) {
    throw buildError(
      "Token do MTalk nao configurado. Defina MTALK_BASE_URL e MTALK_TOKEN no .env e reinicie a API: o .env so e lido ao iniciar.",
      503
    );
  }

  const url = buildMtalkUrl(config.baseUrl, path, query);

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(config.timeoutMs)
    });
  } catch (error) {
    const motivo = error?.name === "TimeoutError" ? `nao respondeu em ${config.timeoutMs}ms` : error?.message;
    const failure = buildError(`Falha ao falar com a API do MTalk (${url.pathname}): ${motivo}`, 502);
    // Sem resposta nao da para concluir nada sobre os parametros enviados.
    failure.noResponse = true;
    throw failure;
  }

  if (!response.ok) {
    const message = describeHttpFailure(response, url);
    // Token recusado pelo MTalk sai da NOSSA API como 502, nunca 401: para o
    // painel e para a extensao, 401 quer dizer "a sua sessao / o seu token" — o
    // painel derrubava o login do administrador e a extensao pedia o token do
    // atendente quando quem tinha vencido era o MTALK_TOKEN. O coletor olha
    // sessionRejected para parar a coleta.
    const failure = buildError(message, 502);
    if (isSessionRejected(response.status)) {
      session.lastError = message;
      failure.sessionRejected = true;
    }
    throw failure;
  }

  session = { lastSuccessAt: new Date().toISOString(), lastError: "" };
  return response.json().catch(() => ({}));
}

// Token vencido ou invalido volta como 401 ou 403 no MTalk.
function isSessionRejected(status) {
  return status === 401 || status === 403;
}

function describeHttpFailure(response, url) {
  if (isSessionRejected(response.status)) {
    return `A API do MTalk recusou MTALK_TOKEN (${response.status}). O token pode ter expirado: gere um novo, atualize o .env e reinicie a API.`;
  }

  if (response.status === 404) {
    return `A API do MTalk respondeu 404 para ${url.pathname}. Confira MTALK_BASE_URL (deve terminar em "/backend").`;
  }

  return `A API do MTalk respondeu ${response.status} para ${url.pathname}.`;
}

// Estado do token para o painel, sem expor o valor.
function describeSession() {
  const config = getMtalkConfig();
  return {
    tokenConfigurado: Boolean(config.token),
    ultimaRespostaOkEm: session.lastSuccessAt,
    ultimoErro: session.lastError || null
  };
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function buildError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}

module.exports = {
  buildMessagesRequest,
  describeSession,
  getContact,
  listMessages,
  listQueues,
  listTags,
  listTickets
};
