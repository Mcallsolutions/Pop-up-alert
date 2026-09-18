const API_URL_KEY = "mcall_admin_api_url";
// Token de acesso a esta API (nao e o token do MTalk). Fica so neste navegador
// e define o recorte: token de atendente ve os proprios tickets e os que estao
// sem atendente.
const API_TOKEN_KEY = "mcall_admin_token";

// Vazio = mesma origem do painel. Em dev o Vite faz proxy de /api para a API
// local (http://localhost:3333).
const DEFAULT_API_URL = import.meta.env.VITE_API_URL ?? "";

export function getApiBaseUrl() {
  const stored = localStorage.getItem(API_URL_KEY);
  return String(stored ?? DEFAULT_API_URL).replace(/\/+$/, "");
}

export function setApiBaseUrl(value) {
  const normalized = String(value || "").replace(/\/+$/, "");

  if (!normalized) {
    localStorage.removeItem(API_URL_KEY);
    return;
  }

  localStorage.setItem(API_URL_KEY, normalized);
}

export function getApiToken() {
  return String(localStorage.getItem(API_TOKEN_KEY) || "");
}

// Aceita o token colado cru, com "Bearer " na frente ou entre aspas.
export function setApiToken(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();

  if (!normalized) {
    localStorage.removeItem(API_TOKEN_KEY);
    return "";
  }

  localStorage.setItem(API_TOKEN_KEY, normalized);
  return normalized;
}

export const api = {
  me() {
    return request("/api/auth/me");
  },
  tokens() {
    return request("/api/auth/tokens");
  },
  createToken(payload) {
    return request("/api/auth/tokens", { method: "POST", body: payload });
  },
  revokeToken(id) {
    return request(`/api/auth/tokens/${id}`, { method: "DELETE" });
  },
  summary(filters = {}) {
    return request(`/api/reports/summary${toQuery(filters)}`);
  },
  filterOptions(filters = {}) {
    return request(`/api/reports/filters${toQuery(filters)}`);
  },
  missingTags(filters = {}) {
    return request(`/api/reports/missing-tags${toQuery(filters)}`);
  },
  inactivitySummary(filters = {}) {
    return request(`/api/reports/inactivity/summary${toQuery(filters)}`);
  },
  inactiveTickets(filters = {}) {
    return request(`/api/reports/inactivity/tickets${toQuery(filters)}`);
  },
  inactivityByAttendant(filters = {}) {
    return request(`/api/reports/inactivity/by-attendant${toQuery(filters)}`);
  },
  inactivityByCompany(filters = {}) {
    return request(`/api/reports/inactivity/by-company${toQuery(filters)}`);
  },
  byAttendant(filters = {}) {
    return request(`/api/reports/by-attendant${toQuery(filters)}`);
  },
  byQueue(filters = {}) {
    return request(`/api/reports/by-queue${toQuery(filters)}`);
  },
  extensionPackage() {
    return request("/api/extension/package");
  },
  downloadExtension() {
    return download("/api/extension/download", "extensao.zip");
  },
  mtalkStatus() {
    return request("/api/mtalk/status");
  },
  mtalkCollect() {
    return request("/api/mtalk/collect", { method: "POST" });
  },
  aiStatus() {
    return request("/api/ai/status");
  },
  aiPrompts() {
    return request("/api/ai/prompts");
  },
  createAiPrompt(payload) {
    return request("/api/ai/prompts", { method: "POST", body: payload });
  },
  updateAiPrompt(id, payload) {
    return request(`/api/ai/prompts/${id}`, { method: "PUT", body: payload });
  },
  deleteAiPrompt(id) {
    return request(`/api/ai/prompts/${id}`, { method: "DELETE" });
  },
  generateAiSummary(filters = {}) {
    return request("/api/ai/summary", { method: "POST", body: filters });
  },
  latestAiSummary() {
    return request("/api/ai/summary/latest");
  },
  aiSummaries(limit = 10) {
    return request(`/api/ai/summaries${toQuery({ limit })}`);
  }
};

async function request(path, options = {}) {
  const token = getApiToken();
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    const error = new Error(data?.error || data || `Erro ${response.status}`);
    // O painel usa isto para voltar a pedir o token em vez de so mostrar o erro.
    error.status = response.status;
    error.unauthorized = response.status === 401;
    throw error;
  }

  return data;
}

// Download autenticado: o token vai no cabecalho, entao nao da para apontar um
// <a href> direto para a rota. Busca o arquivo, vira blob e dispara o save.
async function download(path, fallbackFileName) {
  const token = getApiToken();
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json") ? await response.json() : await response.text();
    const error = new Error(data?.error || data || `Erro ${response.status}`);
    error.status = response.status;
    error.unauthorized = response.status === 401;
    throw error;
  }

  const fileName = fileNameFromDisposition(response.headers.get("content-disposition")) || fallbackFileName;
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  return { fileName, size: blob.size };
}

// Le o nome do arquivo que a API mandou no content-disposition.
function fileNameFromDisposition(header) {
  const match = /filename="?([^";]+)"?/i.exec(String(header || ""));
  return match ? match[1] : "";
}

function toQuery(filters) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  const query = params.toString();
  return query ? `?${query}` : "";
}
