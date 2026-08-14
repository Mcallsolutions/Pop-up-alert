const elements = {
  apiBadge: document.getElementById("apiBadge"),
  totalTickets: document.getElementById("totalTickets"),
  missingTags: document.getElementById("missingTags"),
  withTags: document.getElementById("withTags"),
  waitingTickets: document.getElementById("waitingTickets"),
  lastReadAt: document.getElementById("lastReadAt"),
  lastSentAt: document.getElementById("lastSentAt"),
  currentUrl: document.getElementById("currentUrl"),
  captureStatus: document.getElementById("captureStatus"),
  parserMessage: document.getElementById("parserMessage"),
  errorRow: document.getElementById("errorRow"),
  lastError: document.getElementById("lastError"),
  forceScan: document.getElementById("forceScan"),
  checkApi: document.getElementById("checkApi"),
  configForm: document.getElementById("configForm"),
  apiBaseUrl: document.getElementById("apiBaseUrl"),
  extensionToken: document.getElementById("extensionToken"),
  feedback: document.getElementById("feedback")
};

document.addEventListener("DOMContentLoaded", load);
elements.forceScan.addEventListener("click", forceScan);
elements.checkApi.addEventListener("click", checkApi);
elements.configForm.addEventListener("submit", saveConfig);

async function load() {
  const response = await sendMessage({ type: "GET_STATUS" });
  if (response?.ok) {
    renderStatus(response.status);
    renderConfig(response.config);
  } else {
    setFeedback(response?.error || "Nao foi possivel carregar o status");
  }
}

async function forceScan() {
  setFeedback("Executando leitura...");
  const response = await sendMessage({ type: "FORCE_SCAN" });
  if (response?.ok) {
    setFeedback(`Leitura concluida: ${response.totalTickets || 0} tickets, ${response.missingTags || 0} sem TAG.`);
  } else {
    setFeedback(response?.error || "Nao foi possivel executar a leitura");
  }
  await load();
}

async function checkApi() {
  setFeedback("Testando API...");
  const response = await sendMessage({ type: "CHECK_API_HEALTH" });
  if (response?.ok) {
    setFeedback(
      response.tokenVerificado
        ? "API conectada e token aceito."
        : "API conectada. Versao publicada ainda nao tem /api/tickets/ping, entao o token nao pode ser conferido."
    );
  } else {
    setFeedback(response?.error || "API indisponivel.");
  }
  await load();
}

async function saveConfig(event) {
  event.preventDefault();
  const config = {
    apiBaseUrl: elements.apiBaseUrl.value,
    extensionToken: elements.extensionToken.value
  };
  const response = await sendMessage({ type: "SAVE_CONFIG", config });
  if (response?.ok) {
    setFeedback("Configuracao salva.");
    renderConfig(response.config);
  } else {
    setFeedback(response?.error || "Erro ao salvar configuracao");
  }
}

function renderConfig(config = {}) {
  elements.apiBaseUrl.value = config.apiBaseUrl || "https://pop-up-alert.vercel.app";
  elements.extensionToken.value = config.extensionToken || "";
}

function renderStatus(status = {}) {
  elements.totalTickets.textContent = status.totalTickets || 0;
  elements.missingTags.textContent = status.missingTags || 0;
  elements.withTags.textContent = status.withTags || 0;
  elements.waitingTickets.textContent = status.waitingTickets || 0;
  elements.lastReadAt.textContent = formatDate(status.lastReadAt);
  elements.lastSentAt.textContent = formatDate(status.lastSentAt);
  elements.currentUrl.textContent = status.currentUrl || "-";
  elements.captureStatus.textContent = formatCaptureStatus(status);
  elements.parserMessage.textContent = status.parserMessage || "-";
  elements.lastError.textContent = status.lastError || "-";
  elements.errorRow.hidden = !status.lastError;

  elements.apiBadge.className = "badge";
  if (status.apiStatus === "conectado") {
    elements.apiBadge.classList.add("badge-ok");
    elements.apiBadge.textContent = "API online";
  } else if (status.apiStatus === "erro") {
    elements.apiBadge.classList.add("badge-error");
    elements.apiBadge.textContent = "API erro";
  } else {
    elements.apiBadge.classList.add("badge-muted");
    elements.apiBadge.textContent = "API";
  }
}

function formatCaptureStatus(status = {}) {
  const labels = {
    aguardando_leitura: "Aguardando leitura",
    tickets_detectados: "Tickets detectados",
    tickets_sem_tag_detectados: "Tickets sem TAG detectados",
    nenhum_ticket_detectado: "Nenhum ticket detectado",
    sem_sessao: "Sessao do MTalk nao encontrada",
    erro_na_api: "Erro na API do MTalk",
    erro_na_captura: "Erro na captura"
  };
  const label = labels[status.captureStatus] || status.captureStatus || "-";
  // Com a leitura pela API: quantos tickets vieram e quantos sao das filas
  // monitoradas.
  const monitored = Number(status.selectedCount || 0);
  const received = Number(status.candidateCount || 0);
  return `${label} (${monitored}/${received})`;
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(response || { ok: false, error: chrome.runtime.lastError?.message || "" });
    });
  });
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "medium"
  }).format(date);
}

function setFeedback(message) {
  elements.feedback.textContent = message || "";
}
