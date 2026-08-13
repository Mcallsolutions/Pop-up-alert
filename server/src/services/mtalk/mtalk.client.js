// Cliente HTTP da API oficial do MTalk (Ticketz).
//
// Autenticacao: header "Authorization: Bearer <token>", o mesmo token que o
// painel guarda em localStorage["token"]. Ver "Mtalk integration/mtalk-api-mapeamento.md".
//
// Este modulo so fala HTTP: nao normaliza nem filtra nada. A traducao para o
// formato interno fica em mtalk.mapper.js.

const { getMtalkConfig } = require("../../config/monitoring");

async function listQueues({ token, config = getMtalkConfig() } = {}) {
  const data = await requestMtalk("/queue", { token, config });
  return Array.isArray(data) ? data : toArray(data?.queues);
}

// GET /backend/tickets?status=open&pageNumber=1&queueIds=[...]
// Resposta: { tickets, count, hasMore }
async function listTickets({ token, config = getMtalkConfig(), status, pageNumber = 1, queueIds = [], showAll = true } = {}) {
  const query = {
    pageNumber: String(pageNumber),
    status,
    // Vazio nao vai na query: o MTalk trata a ausencia como "so as minhas filas".
    showAll: showAll ? "true" : ""
  };

  // Filtrar por fila no proprio servidor evita trazer as filas que o painel
  // monitora mas o relatorio ignora — menos payload e menos paginas.
  if (queueIds.length) {
    query.queueIds = JSON.stringify(queueIds);
  }

  const data = await requestMtalk("/tickets", { token, config, query });

  return {
    tickets: toArray(data?.tickets),
    count: Number(data?.count || 0),
    hasMore: Boolean(data?.hasMore)
  };
}

async function getCurrentUser({ token, config = getMtalkConfig() } = {}) {
  return requestMtalk("/auth/me", { token, config });
}

async function requestMtalk(path, { token, config = getMtalkConfig(), query = {}, method = "GET" } = {}) {
  const activeToken = String(token || config.token || "").trim();

  if (!activeToken) {
    throw buildError(
      "Token do MTalk nao configurado. Defina MTALK_TOKEN no ambiente ou envie o token na chamada.",
      503
    );
  }

  const url = new URL(`${config.baseUrl}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${activeToken}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(config.timeoutMs)
    });
  } catch (error) {
    const motivo = error?.name === "TimeoutError" ? `nao respondeu em ${config.timeoutMs}ms` : error?.message;
    throw buildError(`Falha ao falar com a API do MTalk (${url.pathname}): ${motivo}`, 502);
  }

  if (!response.ok) {
    throw buildError(describeHttpFailure(response, url), response.status === 401 ? 401 : 502);
  }

  return response.json().catch(() => ({}));
}

function describeHttpFailure(response, url) {
  if (response.status === 401 || response.status === 403) {
    return `A API do MTalk recusou o token (${response.status}). O token expira junto com a sessao do painel; gere um novo em MTALK_TOKEN.`;
  }

  if (response.status === 404) {
    return `A API do MTalk respondeu 404 para ${url.pathname}. Confira MTALK_BASE_URL (deve terminar em "/backend").`;
  }

  return `A API do MTalk respondeu ${response.status} para ${url.pathname}.`;
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
  getCurrentUser,
  listQueues,
  listTickets
};
