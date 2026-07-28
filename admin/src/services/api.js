const TOKEN_KEY = "mcall_admin_token";
const API_URL_KEY = "mcall_admin_api_url";

export function getApiBaseUrl() {
  return (localStorage.getItem(API_URL_KEY) || import.meta.env.VITE_API_URL || "http://localhost:3333").replace(/\/+$/, "");
}

export function setApiBaseUrl(value) {
  localStorage.setItem(API_URL_KEY, String(value || "http://localhost:3333").replace(/\/+$/, ""));
}

export function getStoredToken() {
  localStorage.removeItem(TOKEN_KEY);
  return sessionStorage.getItem(TOKEN_KEY) || "";
}

export function setStoredToken(token) {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function removeStoredToken() {
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_KEY);
}

export const api = {
  login(payload) {
    return request("/api/auth/login", {
      method: "POST",
      body: payload,
      auth: false
    });
  },
  me() {
    return request("/api/auth/me");
  },
  summary() {
    return request("/api/reports/summary");
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
  }
};

async function request(path, options = {}) {
  const headers = {
    "content-type": "application/json",
    ...(options.headers || {})
  };

  if (options.auth !== false) {
    const token = getStoredToken();
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
  }

  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    method: options.method || "GET",
    headers,
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

