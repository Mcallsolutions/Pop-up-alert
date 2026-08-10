// Integracao com a API da OpenAI.
//
// A chave NUNCA vai para o navegador: quem chama a OpenAI e sempre a API,
// usando OPENAI_API_KEY do ambiente. O painel so conversa com /api/ai/*.
//
// Todas as respostas sao pedidas em JSON (response_format json_object) para o
// painel poder renderizar campo a campo em vez de exibir texto solto.

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
// A funcao serverless da Vercel tem maxDuration de 30s (ver vercel.json),
// entao o timeout aqui precisa ficar abaixo disso para o erro ser tratavel.
const DEFAULT_TIMEOUT_MS = 25000;

function getOpenAiConfig() {
  return {
    apiKey: String(process.env.OPENAI_API_KEY || "").trim(),
    baseUrl: String(process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, ""),
    model: String(process.env.OPENAI_MODEL || DEFAULT_MODEL).trim(),
    organization: String(process.env.OPENAI_ORGANIZATION || "").trim(),
    project: String(process.env.OPENAI_PROJECT || "").trim(),
    temperature: parseNumber(process.env.OPENAI_TEMPERATURE, 0.2),
    maxOutputTokens: parseNumber(process.env.OPENAI_MAX_OUTPUT_TOKENS, 1200),
    timeoutMs: parseNumber(process.env.OPENAI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  };
}

function isOpenAiConfigured() {
  return Boolean(getOpenAiConfig().apiKey);
}

// Status seguro para o painel: confirma se a integracao esta pronta sem
// devolver a chave nem qualquer parte dela.
function getOpenAiStatus() {
  const config = getOpenAiConfig();

  return {
    configurado: Boolean(config.apiKey),
    modelo: config.model,
    baseUrl: config.baseUrl,
    temperatura: config.temperature,
    maxTokensResposta: config.maxOutputTokens,
    timeoutMs: config.timeoutMs
  };
}

// Envia as mensagens para /chat/completions e devolve o JSON ja convertido em
// objeto. Lanca erro com statusCode/publicMessage no padrao do resto da API.
async function createJsonCompletion({ messages, model, temperature, maxOutputTokens }) {
  const config = getOpenAiConfig();

  if (!config.apiKey) {
    throwAiError(503, "OPENAI_API_KEY nao configurada. Defina a chave no ambiente para usar a IA.");
  }

  if (!Array.isArray(messages) || !messages.length) {
    throwAiError(400, "Nenhuma mensagem foi montada para enviar a OpenAI.");
  }

  const body = {
    model: model || config.model,
    // Obriga a resposta a ser um JSON valido em vez de texto livre.
    response_format: { type: "json_object" },
    temperature: temperature ?? config.temperature,
    max_tokens: maxOutputTokens ?? config.maxOutputTokens,
    messages
  };

  const response = await fetchWithTimeout(
    `${config.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: buildHeaders(config),
      body: JSON.stringify(body)
    },
    config.timeoutMs
  );

  const raw = await response.text();
  const payload = safeJsonParse(raw);

  if (!response.ok) {
    const detalhe = payload?.error?.message || raw.slice(0, 300) || `HTTP ${response.status}`;
    throwAiError(mapUpstreamStatus(response.status), `OpenAI respondeu ${response.status}: ${detalhe}`);
  }

  const choice = payload?.choices?.[0];
  const content = choice?.message?.content;

  if (choice?.finish_reason === "length") {
    throwAiError(
      502,
      "A resposta da OpenAI foi cortada por limite de tokens. Aumente OPENAI_MAX_OUTPUT_TOKENS ou reduza os prompts."
    );
  }

  const parsed = safeJsonParse(content);

  if (!parsed || typeof parsed !== "object") {
    throwAiError(502, "A OpenAI nao devolveu um JSON valido.");
  }

  return {
    json: parsed,
    model: payload?.model || body.model,
    usage: {
      promptTokens: Number(payload?.usage?.prompt_tokens || 0),
      completionTokens: Number(payload?.usage?.completion_tokens || 0),
      totalTokens: Number(payload?.usage?.total_tokens || 0)
    }
  };
}

function buildHeaders(config) {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${config.apiKey}`
  };

  if (config.organization) {
    headers["openai-organization"] = config.organization;
  }

  if (config.project) {
    headers["openai-project"] = config.project;
  }

  return headers;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throwAiError(504, `A OpenAI nao respondeu em ${Math.round(timeoutMs / 1000)}s.`);
    }
    throwAiError(502, `Falha ao chamar a OpenAI: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// 401/429 da OpenAI nao podem virar 401/429 da nossa API: o painel trataria
// como sessao expirada ou rate limit proprio. Viram erro de gateway.
function mapUpstreamStatus(status) {
  if (status === 429) return 429;
  if (status >= 500) return 502;
  return 502;
}

function safeJsonParse(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function throwAiError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = message;
  throw error;
}

module.exports = {
  createJsonCompletion,
  getOpenAiConfig,
  getOpenAiStatus,
  isOpenAiConfigured
};
