const { getDatabase } = require("../database");
const { createJsonCompletion, getOpenAiStatus, isOpenAiConfigured } = require("./openai.service");
const {
  getSummary,
  getMissingTags,
  getInactivitySummary,
  getInactiveTickets,
  getInactivityByAttendant,
  getReportByAttendant,
  getReportByQueue
} = require("./report.service");

const PROMPT_KINDS = ["INSTRUCAO", "TREINAMENTO"];
const MAX_PROMPT_TITLE = 120;
const MAX_PROMPT_CONTENT = 8000;
// Quantas linhas de ticket vao no contexto. Mais que isso estoura o prompt sem
// melhorar o resumo — o modelo ja recebe os totais agregados.
const MAX_CONTEXT_TICKETS = 40;

// Contrato do JSON devolvido pela IA. Fica junto do prompt para o modelo e do
// painel, que renderiza campo a campo.
const SUMMARY_SCHEMA = {
  resumo: "string — panorama do periodo em ate 6 linhas",
  nivelRisco: "string — BAIXO, MEDIO ou ALTO",
  pontosCriticos: ["string — ocorrencia que exige acao imediata"],
  atendentes: [{ nome: "string", observacao: "string" }],
  filas: [{ fila: "string", observacao: "string" }],
  recomendacoes: ["string — acao pratica sugerida"]
};

const BASE_SYSTEM_PROMPT = [
  "Voce e o analista de operacao de atendimento da Mcall.",
  "Recebe dados ja consolidados de tickets do MTalk (uso de TAG e tempo sem resposta) e escreve um resumo gerencial em portugues do Brasil.",
  "Regras: use apenas os numeros recebidos, nunca invente nomes, clientes ou metricas; se um dado nao existir, diga que nao ha informacao;",
  "seja objetivo e direto ao ponto, sempre citando os numeros que sustentam cada afirmacao.",
  "Responda SEMPRE com um unico objeto JSON valido, sem texto fora do JSON, seguindo exatamente este formato:",
  JSON.stringify(SUMMARY_SCHEMA, null, 2)
].join("\n");

async function listPrompts() {
  const database = await getDatabase();
  const rows = await database
    .prepare(
      `SELECT id, title, kind, content, is_active AS "isActive", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM ai_prompts
       ORDER BY kind, id`
    )
    .all();

  return { items: rows.map(normalizePromptRow) };
}

async function createPrompt(payload) {
  const database = await getDatabase();
  const prompt = validatePromptPayload(payload);
  const now = new Date().toISOString();

  const result = await database
    .prepare(
      `INSERT INTO ai_prompts (title, kind, content, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(prompt.title, prompt.kind, prompt.content, prompt.isActive ? 1 : 0, now, now, { returning: "id" });

  return getPrompt(result.lastInsertRowid);
}

async function updatePrompt(id, payload) {
  const database = await getDatabase();
  const current = await getPrompt(id);

  if (!current) {
    throwValidation("Prompt nao encontrado", 404);
  }

  const prompt = validatePromptPayload({ ...current, ...payload });

  await database
    .prepare("UPDATE ai_prompts SET title = ?, kind = ?, content = ?, is_active = ?, updated_at = ? WHERE id = ?")
    .run(prompt.title, prompt.kind, prompt.content, prompt.isActive ? 1 : 0, new Date().toISOString(), current.id);

  return getPrompt(current.id);
}

async function deletePrompt(id) {
  const database = await getDatabase();
  const promptId = normalizeId(id);
  const result = await database.prepare("DELETE FROM ai_prompts WHERE id = ?").run(promptId);

  if (!result.changes) {
    throwValidation("Prompt nao encontrado", 404);
  }

  return { id: promptId, removido: true };
}

async function getPrompt(id) {
  const database = await getDatabase();
  const row = await database
    .prepare(
      `SELECT id, title, kind, content, is_active AS "isActive", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM ai_prompts
       WHERE id = ?`
    )
    .get(normalizeId(id));

  return row ? normalizePromptRow(row) : null;
}

async function getStatus() {
  const database = await getDatabase();
  const prompts = await database
    .prepare(
      `SELECT kind, COUNT(*) AS total, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS ativos
       FROM ai_prompts
       GROUP BY kind`
    )
    .all();
  const ultimo = await getLatestSummary();

  return {
    openai: getOpenAiStatus(),
    prompts: prompts.map((row) => ({
      tipo: row.kind,
      total: Number(row.total || 0),
      ativos: Number(row.ativos || 0)
    })),
    ultimoResumoEm: ultimo?.createdAt || null
  };
}

// Monta o contexto a partir dos MESMOS relatorios que o painel exibe, aplica os
// prompts cadastrados e guarda o JSON devolvido pela IA.
async function generateSummary(filters = {}, user = null) {
  if (!isOpenAiConfigured()) {
    throwValidation("OPENAI_API_KEY nao configurada. Cadastre a chave no ambiente antes de gerar o resumo.", 503);
  }

  const contexto = await buildContext(filters);

  if (!contexto.totais.totalTicketsProcessed) {
    throwValidation("Nao ha tickets no periodo selecionado para a IA resumir.", 400);
  }

  const { items: prompts } = await listPrompts();
  const messages = buildMessages(prompts, contexto);
  const completion = await createJsonCompletion({ messages });

  return saveSummary({
    content: completion.json,
    model: completion.model,
    usage: completion.usage,
    filters: cleanFilters(filters),
    createdBy: user?.email || user?.name || null
  });
}

async function saveSummary({ content, model, usage, filters, createdBy }) {
  const database = await getDatabase();
  const result = await database
    .prepare(
      `INSERT INTO ai_summaries (model, filters, content, prompt_tokens, completion_tokens, total_tokens, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      model,
      JSON.stringify(filters || {}),
      JSON.stringify(content),
      usage?.promptTokens || 0,
      usage?.completionTokens || 0,
      usage?.totalTokens || 0,
      createdBy,
      new Date().toISOString(),
      { returning: "id" }
    );

  return getSummaryById(result.lastInsertRowid);
}

async function getSummaryById(id) {
  const database = await getDatabase();
  const row = await database
    .prepare(
      `SELECT id, model, filters, content, prompt_tokens AS "promptTokens", completion_tokens AS "completionTokens",
              total_tokens AS "totalTokens", created_by AS "createdBy", created_at AS "createdAt"
       FROM ai_summaries
       WHERE id = ?`
    )
    .get(normalizeId(id));

  return row ? normalizeSummaryRow(row) : null;
}

async function getLatestSummary() {
  const database = await getDatabase();
  const row = await database
    .prepare(
      `SELECT id, model, filters, content, prompt_tokens AS "promptTokens", completion_tokens AS "completionTokens",
              total_tokens AS "totalTokens", created_by AS "createdBy", created_at AS "createdAt"
       FROM ai_summaries
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT 1`
    )
    .get();

  return row ? normalizeSummaryRow(row) : null;
}

async function listSummaries(limit = 10) {
  const database = await getDatabase();
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const rows = await database
    .prepare(
      `SELECT id, model, filters, content, prompt_tokens AS "promptTokens", completion_tokens AS "completionTokens",
              total_tokens AS "totalTokens", created_by AS "createdBy", created_at AS "createdAt"
       FROM ai_summaries
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT ?`
    )
    .all(safeLimit);

  return { items: rows.map(normalizeSummaryRow) };
}

async function buildContext(filters) {
  const [totais, semTag, inatividade, inativos, inatividadePorAtendente, porAtendente, porFila] = await Promise.all([
    getSummary(filters),
    getMissingTags({ ...filters, limit: MAX_CONTEXT_TICKETS }),
    getInactivitySummary(filters),
    getInactiveTickets({ ...filters, limit: MAX_CONTEXT_TICKETS }),
    getInactivityByAttendant(filters),
    getReportByAttendant(filters),
    getReportByQueue(filters)
  ]);

  return {
    geradoEm: new Date().toISOString(),
    filtros: cleanFilters(filters),
    totais,
    inatividade,
    porAtendente,
    porFila,
    inatividadePorAtendente: inatividadePorAtendente.items,
    ticketsSemTag: semTag.items.slice(0, MAX_CONTEXT_TICKETS).map(toContextTicket),
    ticketsSemTagOcultos: semTag.incompletosOcultos,
    ticketsInativos: inativos.items.slice(0, MAX_CONTEXT_TICKETS).map(toContextTicket)
  };
}

// O horario que interessa para a IA e o do ticket (display_time), nao o da
// coleta — mesma leitura que o painel passou a mostrar.
function toContextTicket(ticket) {
  return {
    cliente: ticket.clientName || "",
    fila: ticket.queue || "",
    atendente: ticket.attendant || "",
    empresa: ticket.company || "",
    horarioDoTicket: ticket.displayTime || "",
    minutosSemResposta: ticket.inactivityMinutes ?? null,
    tag: ticket.tag || null
  };
}

function buildMessages(prompts, contexto) {
  const instrucoes = prompts.filter((prompt) => prompt.kind === "INSTRUCAO" && prompt.isActive);
  const treinamentos = prompts.filter((prompt) => prompt.kind === "TREINAMENTO" && prompt.isActive);

  const system = [BASE_SYSTEM_PROMPT];

  if (instrucoes.length) {
    system.push(
      "\nInstrucoes adicionais cadastradas pelo administrador (obedeca todas):",
      ...instrucoes.map((prompt) => `- ${prompt.title}: ${prompt.content}`)
    );
  }

  if (treinamentos.length) {
    system.push(
      "\nExemplos de treinamento (use como referencia de estilo, criterio e vocabulario, nunca como dado real):",
      ...treinamentos.map((prompt) => `### ${prompt.title}\n${prompt.content}`)
    );
  }

  return [
    { role: "system", content: system.join("\n") },
    {
      role: "user",
      content: [
        "Analise os dados de operacao abaixo e devolva o resumo no formato JSON combinado.",
        "```json",
        JSON.stringify(contexto),
        "```"
      ].join("\n")
    }
  ];
}

function validatePromptPayload(payload) {
  const title = cleanText(payload?.title, MAX_PROMPT_TITLE);
  const content = cleanMultilineText(payload?.content, MAX_PROMPT_CONTENT);
  const kind = String(payload?.kind || "INSTRUCAO").trim().toUpperCase();

  if (!title) {
    throwValidation("Informe um titulo para o prompt");
  }

  if (!content) {
    throwValidation("Informe o conteudo do prompt");
  }

  if (!PROMPT_KINDS.includes(kind)) {
    throwValidation(`Tipo invalido. Use ${PROMPT_KINDS.join(" ou ")}.`);
  }

  return {
    title,
    kind,
    content,
    isActive: payload?.isActive === undefined ? true : Boolean(payload.isActive)
  };
}

function normalizePromptRow(row) {
  return {
    id: Number(row.id),
    title: row.title,
    kind: row.kind,
    content: row.content,
    isActive: Number(row.isActive) === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function normalizeSummaryRow(row) {
  return {
    id: Number(row.id),
    model: row.model || null,
    filters: parseJson(row.filters) || {},
    content: parseJson(row.content) || { resumo: String(row.content || "") },
    usage: {
      promptTokens: Number(row.promptTokens || 0),
      completionTokens: Number(row.completionTokens || 0),
      totalTokens: Number(row.totalTokens || 0)
    },
    createdBy: row.createdBy || null,
    createdAt: row.createdAt
  };
}

function cleanFilters(filters = {}) {
  const allowed = ["day", "startDate", "endDate", "attendant", "company", "queue", "clientName"];
  return allowed.reduce((acc, key) => {
    const value = String(filters?.[key] || "").trim();
    if (value) acc[key] = value;
    return acc;
  }, {});
}

function parseJson(value) {
  if (value && typeof value === "object") {
    return value;
  }

  try {
    return JSON.parse(String(value || ""));
  } catch (_error) {
    return null;
  }
}

function normalizeId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throwValidation("Identificador invalido");
  }
  return id;
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

// Prompts sao textos longos: quebras de linha fazem parte do conteudo e nao
// podem ser achatadas como nos campos de ticket.
function cleanMultilineText(value, maxLength) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, maxLength);
}

function throwValidation(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = message;
  throw error;
}

module.exports = {
  createPrompt,
  deletePrompt,
  generateSummary,
  getLatestSummary,
  getStatus,
  listPrompts,
  listSummaries,
  updatePrompt
};
