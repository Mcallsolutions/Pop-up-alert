const form = document.getElementById("optionsForm");
const apiBaseUrl = document.getElementById("apiBaseUrl");
const feedback = document.getElementById("feedback");

document.addEventListener("DOMContentLoaded", loadConfig);
form.addEventListener("submit", saveConfig);

async function loadConfig() {
  const response = await sendMessage({ type: "GET_CONFIG" });
  if (!response?.ok) {
    feedback.textContent = response?.error || "Nao foi possivel carregar as opcoes";
    return;
  }
  apiBaseUrl.value = response.config.apiBaseUrl || "http://localhost:3333";
}

async function saveConfig(event) {
  event.preventDefault();
  const response = await sendMessage({ type: "SAVE_CONFIG", config: { apiBaseUrl: apiBaseUrl.value } });
  feedback.textContent = response?.ok ? "Configuracao salva." : response?.error || "Erro ao salvar configuracao";
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(response || { ok: false, error: chrome.runtime.lastError?.message || "" });
    });
  });
}
