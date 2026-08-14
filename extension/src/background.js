const CONFIG_KEY = "mcall_config";
const STATUS_KEY = "mcall_status";

// Aponta para o deploy da Vercel. Para desenvolver localmente, troque no popup
// ou nas opcoes da extensao para http://localhost:3333.
const DEFAULT_CONFIG = {
  apiBaseUrl: "https://pop-up-alert.vercel.app",
  extensionToken: ""
};

const DEFAULT_STATUS = {
  apiStatus: "desconhecido",
  lastError: "",
  lastReadAt: null,
  lastSentAt: null,
  captureStatus: "aguardando_leitura",
  parserMessage: "Aguardando primeira leitura.",
  parserVersion: "",
  lastScanReason: "",
  candidateCount: 0,
  selectedCount: 0,
  totalTickets: 0,
  missingTags: 0,
  withTags: 0,
  waitingTickets: 0,
  currentUrl: ""
};

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get([CONFIG_KEY, STATUS_KEY]);
  if (!current[CONFIG_KEY]) {
    await chrome.storage.local.set({ [CONFIG_KEY]: DEFAULT_CONFIG });
  }
  if (!current[STATUS_KEY]) {
    await chrome.storage.local.set({ [STATUS_KEY]: DEFAULT_STATUS });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      console.error("[Mcall Monitor]", error);
      sendResponse({ ok: false, error: error.message || "Erro inesperado" });
    });
  return true;
});

async function handleMessage(message) {
  if (!message || !message.type) {
    return { ok: false, error: "Mensagem invalida" };
  }

  if (message.type === "GET_CONFIG") {
    return { ok: true, config: await getConfig() };
  }

  if (message.type === "SAVE_CONFIG") {
    const nextConfig = normalizeConfig(message.config || {});
    await chrome.storage.local.set({ [CONFIG_KEY]: nextConfig });
    return { ok: true, config: nextConfig };
  }

  if (message.type === "GET_STATUS") {
    const status = await getStatus();
    return { ok: true, status, config: await getConfig() };
  }

  if (message.type === "FORCE_SCAN") {
    return forceActiveTabScan();
  }

  if (message.type === "CHECK_API_HEALTH") {
    return checkApiHealth();
  }

  if (message.type === "SNAPSHOT_READY") {
    return sendSnapshot(message.payload);
  }

  return { ok: false, error: "Tipo de mensagem desconhecido" };
}

async function getConfig() {
  const result = await chrome.storage.local.get(CONFIG_KEY);
  return { ...DEFAULT_CONFIG, ...(result[CONFIG_KEY] || {}) };
}

async function getStatus() {
  const result = await chrome.storage.local.get(STATUS_KEY);
  return { ...DEFAULT_STATUS, ...(result[STATUS_KEY] || {}) };
}

function normalizeConfig(config) {
  const apiBaseUrl = String(config.apiBaseUrl || DEFAULT_CONFIG.apiBaseUrl).trim().replace(/\/+$/, "");
  return {
    apiBaseUrl: apiBaseUrl || DEFAULT_CONFIG.apiBaseUrl,
    extensionToken: String(config.extensionToken || "").trim()
  };
}

async function updateStatus(patch) {
  const status = { ...(await getStatus()), ...patch };
  await chrome.storage.local.set({ [STATUS_KEY]: status });
  return status;
}

async function sendSnapshot(payload) {
  if (!payload || !Array.isArray(payload.tickets)) {
    return { ok: false, error: "Snapshot invalido" };
  }

  const config = await getConfig();
  const totals = countTickets(payload.tickets);
  const diagnostics = payload.diagnostics || {};

  await updateStatus({
    lastReadAt: payload.collectedAt,
    captureStatus: diagnostics.captureStatus || (payload.tickets.length ? "tickets_detectados" : "nenhum_ticket_detectado"),
    parserMessage: diagnostics.parserMessage || "",
    parserVersion: diagnostics.parserVersion || "",
    lastScanReason: diagnostics.reason || "",
    candidateCount: Number(diagnostics.candidateCount || 0),
    selectedCount: Number(diagnostics.selectedCount || payload.tickets.length || 0),
    totalTickets: totals.totalTickets,
    missingTags: totals.missingTags,
    withTags: totals.withTags,
    waitingTickets: totals.waitingTickets,
    currentUrl: payload.url || ""
  });

  const headers = {
    "content-type": "application/json"
  };

  if (config.extensionToken) {
    headers["x-extension-token"] = config.extensionToken;
  }

  const endpoint = `${config.apiBaseUrl}/api/tickets/snapshot`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(await describeHttpFailure(response, config));
    }

    const data = await response.json();
    const status = await updateStatus({
      apiStatus: "conectado",
      lastError: "",
      lastSentAt: new Date().toISOString()
    });

    return { ok: true, data, status };
  } catch (error) {
    const status = await updateStatus({
      apiStatus: "erro",
      lastError: describeSendFailure(error, endpoint)
    });
    console.error("[Mcall Monitor] falha ao enviar snapshot para", endpoint, error);
    return { ok: false, error: status.lastError, status };
  }
}

// Mensagens acionaveis: sem isso o popup mostra apenas "Failed to fetch",
// que nao diz se o problema e URL errada, token ou API fora do ar.
async function describeHttpFailure(response, config) {
  const corpo = await response.text().catch(() => "");
  const detalhe = corpo ? ` Detalhe: ${corpo.slice(0, 200)}` : "";

  if (response.status === 401) {
    return config.extensionToken
      ? `A API recusou o token da extensao (401). O valor em EXTENSION_TOKEN na Vercel precisa ser identico ao configurado aqui.${detalhe}`
      : `A API exige um token da extensao (401), mas nenhum esta configurado aqui. Copie o valor de EXTENSION_TOKEN da Vercel para o campo "Token da extensao".${detalhe}`;
  }

  if (response.status === 403) {
    return `A API bloqueou a origem da extensao (403). Adicione "chrome-extension://${chrome.runtime.id}" em CORS_ORIGINS na Vercel.${detalhe}`;
  }

  if (response.status === 400) {
    return `A API recusou o conteudo do snapshot (400).${detalhe}`;
  }

  if (response.status === 404) {
    return `A API respondeu "rota nao encontrada" (404) para ${response.url}. Confirme a URL da API no campo acima (sem "/api" no final) e se o deploy da Vercel esta atualizado.${detalhe}`;
  }

  if (response.status === 503) {
    return `A API esta no ar mas o banco nao respondeu (503). Confira DATABASE_URL/POSTGRES_URL na Vercel.${detalhe}`;
  }

  return `API respondeu ${response.status}.${detalhe}`;
}

function describeSendFailure(error, endpoint) {
  const mensagem = error?.message || "Falha ao enviar snapshot";

  if (/failed to fetch|networkerror|load failed/i.test(mensagem)) {
    return `Nao foi possivel alcancar ${endpoint}. Confirme a URL da API no campo acima e se o endereco esta acessivel.`;
  }

  return mensagem;
}

// Ticket aguardando na fila (sem atendente vinculado) nao entra na conta de
// TAG: nao ha a quem cobrar. Ele vira um numero proprio, para que
// totalTickets = withTags + missingTags + waitingTickets continue fechando.
function countTickets(tickets) {
  const comResponsavel = tickets.filter((ticket) => String(ticket.attendant || "").trim());
  const missingTags = comResponsavel.filter((ticket) => ticket.tagStatus === "SEM_TAG").length;

  return {
    totalTickets: tickets.length,
    missingTags,
    withTags: comResponsavel.length - missingTags,
    waitingTickets: tickets.length - comResponsavel.length
  };
}

async function forceActiveTabScan() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    return { ok: false, error: "Nenhuma aba ativa encontrada" };
  }

  if (!tab.url || !tab.url.startsWith("https://s11.mtalk.com.br/tickets")) {
    return { ok: false, error: "Abra a tela de tickets do MTalk para forcar a leitura" };
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "FORCE_SCAN_FROM_POPUP" });
    return response || { ok: true };
  } catch (error) {
    return { ok: false, error: "Content script ainda nao esta pronto nesta aba" };
  }
}

async function checkApiHealth() {
  const config = await getConfig();
  const endpoint = `${config.apiBaseUrl}/health`;
  try {
    const response = await fetch(endpoint);
    if (!response.ok) {
      throw new Error(await describeHttpFailure(response, config));
    }
    const health = await response.json();

    // O /health nao exige token, entao sozinho ele daria "conectado" mesmo com
    // token errado e todo snapshot voltando 401. O ping fecha essa lacuna.
    const pingHeaders = config.extensionToken ? { "x-extension-token": config.extensionToken } : {};
    const ping = await fetch(`${config.apiBaseUrl}/api/tickets/ping`, { method: "POST", headers: pingHeaders });

    // 404/405 = API no ar, mas em uma versao anterior a esta rota. Nesse caso a
    // conexao esta ok e so a verificacao extra de token nao pode ser feita.
    if (ping.status === 404 || ping.status === 405) {
      const status = await updateStatus({ apiStatus: "conectado", lastError: "" });
      return { ok: true, health, tokenVerificado: false, status };
    }

    if (!ping.ok) {
      throw new Error(await describeHttpFailure(ping, config));
    }

    const status = await updateStatus({ apiStatus: "conectado", lastError: "" });
    return { ok: true, health, tokenVerificado: true, status };
  } catch (error) {
    const status = await updateStatus({
      apiStatus: "erro",
      lastError: describeSendFailure(error, endpoint)
    });
    return { ok: false, error: status.lastError, status };
  }
}
