const elements = {
  apiBadge: document.getElementById("apiBadge"),
  totalTickets: document.getElementById("totalTickets"),
  missingTags: document.getElementById("missingTags"),
  inactiveTickets: document.getElementById("inactiveTickets"),
  waitingTickets: document.getElementById("waitingTickets"),
  collectedAt: document.getElementById("collectedAt"),
  lastFetchAt: document.getElementById("lastFetchAt"),
  situation: document.getElementById("situation"),
  errorRow: document.getElementById("errorRow"),
  lastError: document.getElementById("lastError"),
  forceCollect: document.getElementById("forceCollect"),
  checkApi: document.getElementById("checkApi"),
  scope: document.getElementById("scope"),
  configForm: document.getElementById("configForm"),
  apiBaseUrl: document.getElementById("apiBaseUrl"),
  apiToken: document.getElementById("apiToken"),
  feedback: document.getElementById("feedback")
};

document.addEventListener("DOMContentLoaded", async () => {
  await load();
  // Atualiza os numeros ao abrir, sem esperar o proximo ciclo do content script.
  await sendMessage({ type: "FETCH_ALERTS" });
  await load();
});
elements.forceCollect.addEventListener("click", forceCollect);
elements.checkApi.addEventListener("click", checkApi);
elements.configForm.addEventListener("submit", saveConfig);

async function load() {
  const response = await sendMessage({ type: "GET_STATUS" });
  if (response?.ok) {
    renderStatus(response.status);
    elements.apiBaseUrl.value = response.config?.apiBaseUrl || "https://tag-monitor.mcallsolutions.com.br";
    // O campo ja vem preenchido para que salvar a URL nao apague o token.
    elements.apiToken.value = response.config?.apiToken || "";
  } else {
    setFeedback(response?.error || "Nao foi possivel carregar o status");
  }
}

async function forceCollect() {
  setFeedback("Coletando tickets na API do MTalk...");
  elements.forceCollect.disabled = true;
  const response = await sendMessage({ type: "FORCE_COLLECT" });
  elements.forceCollect.disabled = false;

  if (response?.ok) {
    const result = response.result || {};
    setFeedback(`Coleta concluida: ${result.totalTickets || 0} tickets, ${result.totalWithoutTag || 0} sem TAG.`);
  } else {
    setFeedback(response?.error || "Nao foi possivel coletar");
  }
  await load();
}

async function checkApi() {
  setFeedback("Testando API...");
  const response = await sendMessage({ type: "CHECK_API_HEALTH" });
  if (response?.ok) {
    const sessao = response.mtalk?.sessao;
    const mtalk = !response.mtalk?.configurado
      ? "MTalk sem MTALK_TOKEN no .env do servidor."
      : sessao?.ultimoErro
        ? `MTalk: ${sessao.ultimoErro}`
        : sessao?.ultimaRespostaOkEm
          ? "Token do MTalk aceito."
          : "Token do MTalk ainda nao testado.";
    const quem = !response.me?.authRequired
      ? "API sem token exigido (modo aberto)."
      : `Token de ${response.me.name}: ${response.me.attendant || "ve todos os atendentes"}.`;
    setFeedback(`API local conectada. ${quem} ${mtalk}`);
  } else {
    setFeedback(response?.error || "API indisponivel.");
  }
  await load();
}

async function saveConfig(event) {
  event.preventDefault();
  const response = await sendMessage({
    type: "SAVE_CONFIG",
    config: { apiBaseUrl: elements.apiBaseUrl.value, apiToken: elements.apiToken.value }
  });
  if (response?.ok) {
    setFeedback("Configuracao salva.");
    elements.apiBaseUrl.value = response.config.apiBaseUrl;
    elements.apiToken.value = response.config.apiToken;
    await sendMessage({ type: "FETCH_ALERTS" });
    await load();
  } else {
    setFeedback(response?.error || "Erro ao salvar configuracao");
  }
}

function renderStatus(status = {}) {
  elements.totalTickets.textContent = status.totalTickets || 0;
  elements.missingTags.textContent = status.missingTags || 0;
  elements.inactiveTickets.textContent = status.inactiveTickets || 0;
  elements.waitingTickets.textContent = status.waitingTickets || 0;
  elements.collectedAt.textContent = formatDate(status.collectedAt);
  elements.lastFetchAt.textContent = formatDate(status.lastFetchAt);
  elements.situation.textContent = !status.collectedAt
    ? "Servidor ainda sem coleta"
    : status.stale
      ? "Coleta desatualizada: alertas ocultos"
      : "Alertas em dia";
  elements.scope.textContent = status.scopeAttendant || "todos os atendentes";
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
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "medium" }).format(date);
}

function setFeedback(message) {
  elements.feedback.textContent = message || "";
}
