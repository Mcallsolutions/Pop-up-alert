// Service worker da extensao.
//
// A extensao nao le a pagina nem a sessao do MTalk: quem conversa com a API do
// MTalk e o servidor local. Aqui so buscamos os alertas ja calculados em
// GET /api/mtalk/alerts e repassamos para o content script desenhar o pop-up.
// A chamada sai do service worker (e nao da pagina https do MTalk) porque a
// pagina nao pode chamar http://localhost.
//
// Todo endereco que a extensao chamar precisa estar em host_permissions no
// manifest.json — inclusive um dominio novo da API.

const CONFIG_KEY = "mcall_config";
const STATUS_KEY = "mcall_status";
const MTALK_TICKETS_URL = "https://s11.mtalk.com.br/tickets*";

const DEFAULT_CONFIG = {
  // API hospedada. Em maquina de desenvolvimento troque por http://localhost:3333
  // no popup ou nas opcoes da extensao.
  apiBaseUrl: "https://xn--gesto-dra.mcallsolutions.com.br",
  // Token da API LOCAL, emitido no painel ou por `npm run token`. E ele que diz
  // de quem sao os alertas: cada atendente cola o seu. Nada a ver com o login
  // do MTalk — a extensao continua sem tocar na sessao do MTalk.
  apiToken: ""
};

const DEFAULT_STATUS = {
  apiStatus: "desconhecido",
  // Atendente do token (vazio = token de administrador ou API em modo aberto).
  scopeAttendant: "",
  lastError: "",
  lastFetchAt: null,
  collectedAt: null,
  stale: true,
  totalTickets: 0,
  missingTags: 0,
  withTags: 0,
  waitingTickets: 0,
  inactiveTickets: 0
};

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(CONFIG_KEY);
  await chrome.storage.local.set({
    [CONFIG_KEY]: normalizeConfig(current[CONFIG_KEY] || {}),
    [STATUS_KEY]: DEFAULT_STATUS
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => {
      console.error("[Mcall Monitor]", error);
      sendResponse({ ok: false, error: error.message || "Erro inesperado" });
    });
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case "GET_CONFIG":
      return { ok: true, config: await getConfig() };
    case "SAVE_CONFIG": {
      const config = normalizeConfig(message.config || {});
      await chrome.storage.local.set({ [CONFIG_KEY]: config });
      return { ok: true, config };
    }
    case "GET_STATUS":
      return { ok: true, status: await getStatus(), config: await getConfig() };
    case "FETCH_ALERTS":
      return fetchAlerts();
    case "FORCE_COLLECT":
      return forceCollect();
    case "CHECK_API_HEALTH":
      return checkApiHealth();
    default:
      return { ok: false, error: "Tipo de mensagem desconhecido" };
  }
}

async function fetchAlerts() {
  const config = await getConfig();
  const endpoint = `${config.apiBaseUrl}/api/mtalk/alerts`;

  try {
    const response = await fetch(endpoint, { cache: "no-store", headers: authHeaders(config) });
    if (!response.ok) {
      throw new Error(await describeHttpFailure(response));
    }

    const alerts = await response.json();
    const totals = alerts.totals || {};
    const status = await updateStatus({
      apiStatus: "conectado",
      scopeAttendant: alerts.scope?.attendant || "",
      lastError: alerts.lastError || "",
      lastFetchAt: new Date().toISOString(),
      collectedAt: alerts.collectedAt,
      stale: Boolean(alerts.stale),
      totalTickets: Number(totals.totalTickets || 0),
      missingTags: Number(totals.totalWithoutTag || 0),
      withTags: Number(totals.totalWithTag || 0),
      waitingTickets: Number(totals.totalWithoutAttendant || 0),
      inactiveTickets: Number(alerts.inactive?.total || 0)
    });

    return { ok: true, alerts, status };
  } catch (error) {
    const status = await updateStatus({ apiStatus: "erro", lastError: describeFetchFailure(error, endpoint) });
    return { ok: false, error: status.lastError, status };
  }
}

// Pede uma coleta agora ao servidor e avisa as abas do MTalk para redesenharem.
async function forceCollect() {
  const config = await getConfig();
  const endpoint = `${config.apiBaseUrl}/api/mtalk/collect`;

  try {
    const response = await fetch(endpoint, { method: "POST", headers: authHeaders(config) });
    if (!response.ok) {
      throw new Error(await describeHttpFailure(response));
    }

    const result = await response.json();
    const alerts = await fetchAlerts();
    await notifyMtalkTabs();
    return { ok: true, result, status: alerts.status };
  } catch (error) {
    const status = await updateStatus({ apiStatus: "erro", lastError: describeFetchFailure(error, endpoint) });
    return { ok: false, error: status.lastError, status };
  }
}

async function notifyMtalkTabs() {
  const tabs = await chrome.tabs.query({ url: MTALK_TICKETS_URL });
  await Promise.all(
    tabs.map((tab) => chrome.tabs.sendMessage(tab.id, { type: "REFRESH_ALERTS" }).catch(() => undefined))
  );
}

async function checkApiHealth() {
  const config = await getConfig();
  const endpoint = `${config.apiBaseUrl}/health`;

  try {
    const response = await fetch(endpoint, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(await describeHttpFailure(response));
    }

    const health = await response.json();
    // /health responde sem token; o resto da API nao. Um 401 aqui e a forma
    // mais direta de dizer "a API esta de pe, o seu token que nao serve".
    const meResponse = await fetch(`${config.apiBaseUrl}/api/auth/me`, {
      cache: "no-store",
      headers: authHeaders(config)
    });
    if (!meResponse.ok) {
      throw new Error(await describeHttpFailure(meResponse));
    }

    const me = await meResponse.json();
    const statusResponse = await fetch(`${config.apiBaseUrl}/api/mtalk/status`, {
      cache: "no-store",
      headers: authHeaders(config)
    });
    const mtalk = statusResponse.ok ? await statusResponse.json() : null;
    const status = await updateStatus({
      apiStatus: "conectado",
      scopeAttendant: me.attendant || "",
      lastError: ""
    });
    return { ok: true, health, me, mtalk, status };
  } catch (error) {
    const status = await updateStatus({ apiStatus: "erro", lastError: describeFetchFailure(error, endpoint) });
    return { ok: false, error: status.lastError, status };
  }
}

async function getConfig() {
  const result = await chrome.storage.local.get(CONFIG_KEY);
  return normalizeConfig(result[CONFIG_KEY] || {});
}

async function getStatus() {
  const result = await chrome.storage.local.get(STATUS_KEY);
  return { ...DEFAULT_STATUS, ...(result[STATUS_KEY] || {}) };
}

function normalizeConfig(config) {
  const apiBaseUrl = String(config.apiBaseUrl || "").trim().replace(/\/+$/, "");
  return {
    apiBaseUrl: apiBaseUrl || DEFAULT_CONFIG.apiBaseUrl,
    apiToken: normalizeToken(config.apiToken)
  };
}

// Aceita o token colado cru, com "Bearer " na frente ou entre aspas — a mesma
// tolerancia que o servidor tem com o MTALK_TOKEN.
function normalizeToken(value) {
  return String(value || "")
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

function authHeaders(config) {
  return config.apiToken ? { authorization: `Bearer ${config.apiToken}` } : {};
}

async function updateStatus(patch) {
  const status = { ...(await getStatus()), ...patch };
  await chrome.storage.local.set({ [STATUS_KEY]: status });
  return status;
}

async function describeHttpFailure(response) {
  const corpo = await response.text().catch(() => "");
  let detalhe = corpo.slice(0, 200);
  try {
    detalhe = JSON.parse(corpo).error || detalhe;
  } catch (_error) {
    // corpo nao e JSON: usa o texto cru
  }

  if (response.status === 401) {
    return "Token de acesso ausente, invalido ou revogado. Cole o seu token nas opcoes da extensao.";
  }

  if (response.status === 403) {
    return detalhe || "Este token nao tem acesso a esta area.";
  }

  if (response.status === 404) {
    return `A API respondeu "rota nao encontrada" (404) para ${response.url}. Confirme a URL da API (sem "/api" no final).`;
  }

  return `API respondeu ${response.status}.${detalhe ? ` ${detalhe}` : ""}`;
}

function describeFetchFailure(error, endpoint) {
  const mensagem = error?.message || "Falha ao falar com a API";

  if (/failed to fetch|networkerror|load failed/i.test(mensagem)) {
    return `Nao foi possivel alcancar ${endpoint}. Confirme se a API local esta rodando (npm run dev).`;
  }

  return mensagem;
}
