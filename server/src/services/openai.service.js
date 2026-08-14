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
// O resumo pede texto + quatro listas. Com 1200 a resposta era cortada quando
// havia muitos atendentes ou filas, e resposta cortada nao vira JSON valido.
const DEFAULT_MAX_OUTPUT_TOKENS = 2000;
// Uma correcao para max_tokens e outra para temperature; nao ha um terceiro
// parametro incompativel conhecido, entao o loop nao precisa girar mais.
const MAX_COMPAT_RETRIES = 3;

function getOpenAiConfig() {
  return {
    apiKey: String(process.env.OPENAI_API_KEY || "").trim(),
    baseUrl: String(process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, ""),
    model: String(process.env.OPENAI_MODEL || DEFAULT_MODEL).trim(),
    organization: String(process.env.OPENAI_ORGANIZATION || "").trim(),
    project: String(process.env.OPENAI_PROJECT || "").trim(),
    temperature: parseNumber(process.env.OPENAI_TEMPERATURE, 0.2),
    maxOutputTokens: parseNumber(process.env.OPENAI_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS),
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
// jsonSchema (opcional) obriga a resposta a sair no formato exato esperado pelo
// painel. Se o modelo/endpoint nao suportar, a chamada cai sozinha para
// json_object, que garante JSON valido mas nao os campos.
async function createJsonCompletion({ messages, model, temperature, maxOutputTokens, jsonSchema }) {
  const config = getOpenAiConfig();

  if (!config.apiKey) {
    throwAiError(503, "OPENAI_API_KEY nao configurada. Defina a chave no ambiente para usar a IA.");
  }

  if (!Array.isArray(messages) || !messages.length) {
    throwAiError(400, "Nenhuma mensagem foi montada para enviar a OpenAI.");
  }

  let body = {
    model: model || config.model,
    response_format: jsonSchema ? { type: "json_schema", json_schema: jsonSchema } : { type: "json_object" },
    temperature: temperature ?? config.temperature,
    max_tokens: maxOutputTokens ?? config.maxOutputTokens,
    messages
  };

  const ajustes = [];

  for (let tentativa = 1; ; tentativa += 1) {
    const { response, raw, payload } = await postCompletion(body, config);

    if (response.ok) {
      return buildCompletionResult(payload, body, ajustes);
    }

    // Familias de modelo diferentes recusam parametros diferentes. Em vez de
    // manter uma lista de modelos aqui (que envelhece a cada lancamento), a
    // correcao vem do que a propria API respondeu.
    const ajuste = tentativa < MAX_COMPAT_RETRIES && response.status === 400 ? adjustForUpstreamError(body, payload?.error) : null;

    if (!ajuste) {
      const detalhe = payload?.error?.message || raw.slice(0, 300) || `HTTP ${response.status}`;
      const contexto = ajustes.length ? ` (apos ajustar: ${ajustes.join(", ")})` : "";
      throwAiError(mapUpstreamStatus(response.status), `OpenAI respondeu ${response.status}: ${detalhe}${contexto}`);
    }

    console.warn(`[IA] ${body.model} recusou um parametro; reenviando com ${ajuste.motivo}.`);
    ajustes.push(ajuste.motivo);
    body = ajuste.body;
  }
}

// A leitura do corpo fica dentro da janela de timeout: sem isso, um servidor
// que aceita a conexao e trava no meio da resposta deixaria a chamada pendurada
// ate o limite da funcao serverless.
async function postCompletion(body, config) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildHeaders(config),
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const raw = await response.text();
    return { response, raw, payload: safeJsonParse(raw) };
  } catch (error) {
    if (error.name === "AbortError") {
      throwAiError(504, `A OpenAI nao respondeu em ${Math.round(config.timeoutMs / 1000)}s.`);
    }
    throwAiError(502, `Falha ao chamar a OpenAI: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function buildCompletionResult(payload, body, ajustes) {
  const choice = payload?.choices?.[0];

  if (choice?.finish_reason === "length") {
    throwAiError(
      502,
      "A resposta da OpenAI foi cortada por limite de tokens. Aumente OPENAI_MAX_OUTPUT_TOKENS ou reduza os prompts."
    );
  }

  // Recusa do modelo vem em message.refusal, com content nulo: sem tratar,
  // isso aparecia como o generico "nao devolveu um JSON valido".
  if (choice?.message?.refusal) {
    throwAiError(502, `A OpenAI recusou a solicitacao: ${choice.message.refusal}`);
  }

  const parsed = safeJsonParse(choice?.message?.content);

  if (!parsed || typeof parsed !== "object") {
    throwAiError(502, "A OpenAI nao devolveu um JSON valido.");
  }

  return {
    json: parsed,
    model: payload?.model || body.model,
    ajustes,
    usage: {
      promptTokens: Number(payload?.usage?.prompt_tokens || 0),
      completionTokens: Number(payload?.usage?.completion_tokens || 0),
      totalTokens: Number(payload?.usage?.total_tokens || 0)
    }
  };
}

// Devolve { body, motivo } quando da para reenviar corrigido, ou null quando o
// erro nao e de compatibilidade de parametro.
function adjustForUpstreamError(body, error) {
  const message = String(error?.message || "");
  const param = String(error?.param || "");

  if (body.max_tokens !== undefined && (param === "max_tokens" || /max_completion_tokens/i.test(message))) {
    const { max_tokens: limite, ...resto } = body;
    return { body: { ...resto, max_completion_tokens: limite }, motivo: "max_completion_tokens" };
  }

  if (body.temperature !== undefined && (param === "temperature" || /\btemperature\b/i.test(message))) {
    const { temperature: _semTemperatura, ...resto } = body;
    return { body: resto, motivo: "temperature padrao do modelo" };
  }

  if (body.response_format?.type === "json_schema" && /json_schema|response_format/i.test(`${message} ${param}`)) {
    return { body: { ...body, response_format: { type: "json_object" } }, motivo: "response_format json_object" };
  }

  return null;
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

// Variavel criada em branco no painel da Vercel chega como "" — e Number("")
// e 0, nao NaN. Sem esta guarda, OPENAI_MAX_OUTPUT_TOKENS vazio virava
// max_tokens: 0 e OPENAI_TIMEOUT_MS vazio abortava a chamada instantaneamente.
function parseNumber(value, fallback) {
  const text = String(value ?? "").trim();
  if (!text) {
    return fallback;
  }

  const parsed = Number(text);
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
  getOpenAiStatus,
  isOpenAiConfigured
};
