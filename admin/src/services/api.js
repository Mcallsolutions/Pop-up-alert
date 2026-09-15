const API_URL_KEY = "mcall_admin_api_url";

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

export const api = {
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
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    method: options.method || "GET",
    headers: { "content-type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    throw new Error(data?.error || data || `Erro ${response.status}`);
  }

  return data;
}

function toQuery(filters) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  const query = params.toString();
  return query ? `?${query}` : "";
}
