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
    currentUrl: payload.url || ""
  });

  const headers = {
    "content-type": "application/json"
  };

  if (config.extensionToken) {
    headers["x-extension-token"] = config.extensionToken;
  }

  try {
    const response = await fetch(`${config.apiBaseUrl}/api/tickets/snapshot`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `API respondeu ${response.status}`);
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
      lastError: error.message || "Falha ao enviar snapshot"
    });
    return { ok: false, error: status.lastError, status };
  }
}

function countTickets(tickets) {
  const totalTickets = tickets.length;
  const missingTags = tickets.filter((ticket) => ticket.tagStatus === "SEM_TAG").length;
  return {
    totalTickets,
    missingTags,
    withTags: totalTickets - missingTags
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
  try {
    const response = await fetch(`${config.apiBaseUrl}/health`);
    if (!response.ok) {
      throw new Error(`API respondeu ${response.status}`);
    }
    const health = await response.json();
    const status = await updateStatus({ apiStatus: "conectado", lastError: "" });
    return { ok: true, health, status };
  } catch (error) {
    const status = await updateStatus({
      apiStatus: "erro",
      lastError: error.message || "Falha ao consultar API"
    });
    return { ok: false, error: status.lastError, status };
  }
}
