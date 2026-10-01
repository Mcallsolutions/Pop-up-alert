// Integracao da analise de atendimento, de ponta a ponta:
// MTalk FALSO e OpenAI FALSA (node:http local), SQLite temporario e cwd fora do
// projeto, para o dotenv nunca carregar o .env real.
//
// So dados FICTICIOS. Os documentos sao exemplos de DV valido conhecidos.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const SRC = path.resolve(__dirname, "../src");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "atendimento-teste-"));
process.chdir(workDir);

const NOW = Date.now();
const ago = (minutes) => new Date(NOW - minutes * 60000).toISOString();

const CLIENT_NAMES = {
  5001: "Maria Ficticia Teste",
  5002: "Joao Inventado",
  5003: "Rita Exemplo",
  5004: "Caio Modelo",
  5005: "Lia Amostra",
  5006: "Beatriz Exemplar",
  5007: "Heitor Simulado"
};
// Paula nao tem token: o ticket 5006 fica fora do recorte da IA.
const ATTENDANTS = {
  5001: "Stephanie",
  5002: "Gabriel Oliveira",
  5003: "Gabriel Oliveira",
  5004: "Stephanie",
  5005: "Stephanie",
  5006: "Paula Andrade",
  5007: "Stephanie"
};
// updatedAt do ticket: 5006 e o mais antigo, mas esta fora do recorte; entre os
// de dentro, 5001 e o primeiro na fila da leitura.
const TICKET_UPDATED = { 5001: 150, 5002: 120, 5003: 110, 5004: 105, 5005: 100, 5006: 160, 5007: 115 };
// O 5007 esperou na fila (sem atendente) ate 130 minutos atras.
const PENDING_UNTIL = { 5007: 130 };

const LOCATION_BODY = "📍\n*Padaria Inventada*\n_Rua Ficticia 99_\nhttps://maps.google.com/maps?q=-3.7319,-38.5267";
const CONTACT_BODY = JSON.stringify({ ticketzvCard: [{ name: "Fulano Ficticio", number: "5585988887777" }] });

// Valores que nunca podem aparecer no banco nem no que vai para a OpenAI.
const FORBIDDEN = [
  "123.456.789-09",
  "12345678909",
  "12.ABC.345/01DE-35",
  "12ABC34501DE35",
  "Acacias",
  "4111 1111 1111 1111",
  "4111111111111111",
  "abc12345",
  "Padaria Inventada",
  "Rua Ficticia",
  "maps.google",
  "-38.5267",
  "ticketzvCard",
  "Fulano Ficticio",
  "5585988887777",
  // Marca das mensagens fora do recorte: nem mascaradas elas podem ser gravadas.
  "fora-do-recorte"
];
// Alem deles, a OpenAI nao recebe nome de cliente, de atendente nem de empresa.
const FORBIDDEN_FOR_OPENAI = [
  ...FORBIDDEN,
  "Maria",
  "Joao",
  "Rita",
  "Beatriz",
  "Heitor",
  "Stephanie",
  "Gabriel",
  "Oliveira",
  "Paula",
  "0800 TESTE"
];

function buildMessages() {
  const msg = (ticketId, n, minutesAgo, fields) => ({
    id: `ID-${ticketId}-${String(n).padStart(2, "0")}`,
    ticketId,
    fromMe: false,
    mediaType: "conversation",
    body: "",
    isDeleted: false,
    isEdited: false,
    read: true,
    ack: 3,
    createdAt: ago(minutesAgo),
    updatedAt: ago(minutesAgo),
    ...fields
  });

  const messages = {
    5001: [
      msg(5001, 1, 180, { body: "boa tarde, meu cpf e 123.456.789-09 e estou sem internet" }),
      msg(5001, 2, 178, { fromMe: true, body: "*Stephanie:*\nOla Maria, vou verificar. Pode confirmar o endereco?" }),
      msg(5001, 3, 175, { body: "Rua das Acacias, 123, apto 45, bairro Centro" }),
      msg(5001, 4, 174, { body: "o cnpj da empresa e 12.ABC.345/01DE-35" }),
      msg(5001, 5, 173, { mediaType: "locationMessage", body: LOCATION_BODY }),
      msg(5001, 6, 172, { mediaType: "contactMessage", body: CONTACT_BODY }),
      msg(5001, 7, 170, { fromMe: true, body: "*Stephanie:*\nObrigada. Nunca envie dados de cartao por aqui." }),
      msg(5001, 8, 169, { body: "meu cartao e 4111 1111 1111 1111 e a senha do wifi: abc12345" }),
      msg(5001, 9, 168, { body: "se nao resolver vou no procon" }),
      msg(5001, 10, 160, { fromMe: true, body: "*Stephanie:*\nResolvido, pode testar?" }),
      msg(5001, 11, 150, { body: "funcionou, obrigada" }),
      msg(5001, 12, 149, { mediaType: "reactionMessage", body: "👍" })
    ]
  };

  for (const ticketId of [5002, 5003, 5004, 5005]) {
    const base = TICKET_UPDATED[ticketId] + 10;
    const primeiroNome = CLIENT_NAMES[ticketId].split(" ")[0];
    messages[ticketId] = [
      msg(ticketId, 1, base, { body: "minha internet caiu" }),
      msg(ticketId, 2, base - 3, { fromMe: true, body: `*${ATTENDANTS[ticketId]}:*\nOla ${primeiroNome}, vou reiniciar a porta` }),
      msg(ticketId, 3, base - 6, { body: "voltou" }),
      msg(ticketId, 4, base - 8, { fromMe: true, body: `*${ATTENDANTS[ticketId]}:*\nOtimo, qualquer coisa estamos aqui` })
    ];
  }

  // Atendente sem token: se a leitura buscasse, a marca chegaria ao banco.
  messages[5006] = [
    msg(5006, 1, 170, { body: "texto fora-do-recorte do cliente" }),
    msg(5006, 2, 168, { fromMe: true, body: "*Paula Andrade:*\nresposta fora-do-recorte" }),
    msg(5006, 3, 166, { body: "ok fora-do-recorte" }),
    msg(5006, 4, 165, { fromMe: true, body: "*Paula Andrade:*\nencerrando fora-do-recorte" })
  ];

  // Fila de espera, assinatura de quem nao tem token e uma mensagem que a
  // propria API diz ser de outra fila (99): so 03, 04, 07 e 08 entram.
  messages[5007] = [
    msg(5007, 1, 150, { body: "oi fora-do-recorte" }),
    msg(5007, 2, 149, { fromMe: true, body: "Digite 1 para suporte fora-do-recorte" }),
    msg(5007, 3, 129, { queueId: 7, body: "minha internet caiu" }),
    msg(5007, 4, 128, { queueId: 7, fromMe: true, body: "*Stephanie:*\nVou verificar" }),
    msg(5007, 5, 126, { queueId: 7, fromMe: true, body: "*Paula Andrade:*\nentrei fora-do-recorte" }),
    msg(5007, 6, 125, { queueId: 99, body: "pergunta no financeiro fora-do-recorte" }),
    msg(5007, 7, 124, { queueId: 7, body: "voltou" }),
    msg(5007, 8, 123, { queueId: 7, fromMe: true, body: "*Stephanie:*\nOtimo" })
  ];
  return messages;
}

const MESSAGES = buildMessages();
const mtalkRequests = [];
const openAiRequests = [];

// minutesAgo: o ticket como a coleta o via naquele momento.
function buildTicket(ticketId, minutesAgo = 0) {
  const pending = minutesAgo > (PENDING_UNTIL[ticketId] ?? Infinity);
  return {
    id: ticketId,
    uuid: `00000000-0000-4000-8000-00000000${ticketId}`,
    status: pending ? "pending" : "open",
    unreadMessages: 0,
    updatedAt: ago(TICKET_UPDATED[ticketId]),
    createdAt: ago(200),
    queue: { id: 7, name: "Suporte-MIX" },
    user: pending ? null : { id: 1, name: ATTENDANTS[ticketId] },
    whatsapp: { name: "0800 TESTE" },
    contact: { id: ticketId + 100, name: CLIENT_NAMES[ticketId], tags: [] },
    tags: [{ id: 1, name: "TAG TESTE" }]
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function fakeMtalk(req, res) {
  mtalkRequests.push({ method: req.method, url: req.url });
  const url = new URL(req.url, "http://mtalk.local");

  if (req.headers.authorization !== "Bearer token-falso") {
    sendJson(res, 401, { error: "ERR_SESSION_EXPIRED" });
    return;
  }
  if (url.pathname === "/backend/queue") {
    sendJson(res, 200, [{ id: 7, name: "Suporte-MIX" }]);
    return;
  }
  if (url.pathname === "/backend/tickets") {
    const tickets = url.searchParams.get("status") === "open" ? Object.keys(CLIENT_NAMES).map((id) => buildTicket(Number(id))) : [];
    sendJson(res, 200, { tickets, count: tickets.length, hasMore: false });
    return;
  }
  const match = /^\/backend\/messages\/(\d+)$/.exec(url.pathname);
  if (match) {
    const minUpdatedAt = Date.parse(url.searchParams.get("minUpdatedAt") || "");
    const messages = (MESSAGES[match[1]] || []).filter(
      (message) => !Number.isFinite(minUpdatedAt) || Date.parse(message.updatedAt) >= minUpdatedAt
    );
    sendJson(res, 200, { count: messages.length, messages, ticket: {}, hasMore: false, nextId: null });
    return;
  }
  sendJson(res, 404, { error: "nao encontrado" });
}

// Resposta da IA com dado pessoal no texto e evidencia inventada: os dois
// precisam ser tratados antes de gravar.
const FAKE_ANALYSIS = {
  resumo: "Cliente Maria informou o cpf 123.456.789-09 e o problema foi resolvido.",
  assunto: "SUPORTE_TECNICO",
  sentimentoCliente: "POSITIVO",
  riscoCancelamento: "MEDIO",
  mencionaOrgaoExterno: true,
  resolvido: "SIM",
  nota: 4,
  pontosPositivos: ["Orientou o cliente a nao mandar cartao pelo chat"],
  pontosDeMelhoria: ["Confirmar a solucao antes de encerrar"],
  alertas: [{ tipo: "ORGAO_EXTERNO", descricao: "Cliente citou o Procon" }],
  evidencias: [
    { mensagemId: "m1", motivo: "pedido inicial" },
    { mensagemId: "m999", motivo: "id inventado" }
  ]
};

function fakeOpenAi(req, res) {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    openAiRequests.push(raw);
    sendJson(res, 200, {
      model: "modelo-falso",
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify(FAKE_ANALYSIS) } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
    });
  });
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function stop(server) {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

let mtalkServer;
let openAiServer;
let appServer;
let api;
let painel;
let lastCollection;

async function allTextValues(database) {
  const values = [];
  const tables = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  for (const { name } of tables) {
    for (const row of await database.prepare(`SELECT * FROM "${name}"`).all()) {
      for (const [column, value] of Object.entries(row)) {
        if (typeof value === "string") values.push({ table: name, column, value });
      }
    }
  }
  return values;
}

function assertNoneOf(forbidden, text, where) {
  const lower = String(text).toLowerCase();
  for (const value of forbidden) {
    assert.ok(!lower.includes(value.toLowerCase()), `"${value}" apareceu em ${where}`);
  }
}

test.before(async () => {
  mtalkServer = await listen(fakeMtalk);
  openAiServer = await listen(fakeOpenAi);

  Object.assign(process.env, {
    SQLITE_PATH: path.join(workDir, "teste.sqlite"),
    MTALK_BASE_URL: `http://127.0.0.1:${mtalkServer.address().port}/backend`,
    MTALK_TOKEN: "token-falso",
    MTALK_COLLECT_INTERVAL_SECONDS: "0",
    MTALK_TIMEOUT_MS: "5000",
    OPENAI_API_KEY: "chave-falsa",
    OPENAI_BASE_URL: `http://127.0.0.1:${openAiServer.address().port}/v1`,
    OPENAI_MODEL: "modelo-falso",
    OPENAI_TIMEOUT_MS: "5000",
    MONITOR_TIME_ZONE: "America/Sao_Paulo",
    INACTIVITY_THRESHOLD_MINUTES: "15",
    RETENTION_DAYS: "90",
    AI_ATTENDANCE_ANALYSIS: "0",
    AI_ANALYSIS_MAX_PER_HOUR: "0",
    AI_ANALYSIS_IDLE_MINUTES: "20",
    AI_ANALYSIS_MIN_MESSAGES: "4",
    AI_ANALYSIS_MAX_MESSAGES: "80",
    SERVE_ADMIN: "0"
  });
  for (const name of ["EXTENSION_OPEN_MODE", "AI_ANALYSIS_MODEL", "MESSAGE_RETENTION_DAYS", "OPENAI_ORGANIZATION", "OPENAI_PROJECT"]) {
    delete process.env[name];
  }
});

test.after(async () => {
  await stop(appServer);
  await stop(mtalkServer);
  await stop(openAiServer);
});

function modules() {
  return {
    collector: require(path.join(SRC, "services/mtalk/mtalk.collector")),
    attendance: require(path.join(SRC, "services/attendance-analysis.service")),
    database: require(path.join(SRC, "database")),
    pii: require(path.join(SRC, "services/pii-mask"))
  };
}

async function collect() {
  const { attendance, collector } = modules();
  const result = await collector.runCollection({ reason: "teste" });
  await attendance.whenAttendanceIdle();
  return result;
}

const messageRequests = () => mtalkRequests.filter((request) => request.url.startsWith("/backend/messages/"));

// Em producao a coleta roda o tempo todo, entao ha leituras de tickets bem antes
// das mensagens. Aqui elas sao semeadas a cada 2 minutos (a leitura vale 3).
async function seedReadings() {
  const { saveSnapshot } = require(path.join(SRC, "services/ticket.service"));
  const { mapApiTicket } = require(path.join(SRC, "services/mtalk/mtalk.mapper"));
  const { toZonedIso } = require(path.join(SRC, "services/time-zone"));

  for (let minutesAgo = 200; minutesAgo >= 2; minutesAgo -= 2) {
    const at = new Date(NOW - minutesAgo * 60000);
    const tickets = Object.keys(CLIENT_NAMES).map((id) => mapApiTicket(buildTicket(Number(id), minutesAgo), { now: at }));
    await saveSnapshot({ source: "teste", url: "http://mtalk.local/tickets", collectedAt: toZonedIso(at), tickets });
  }
}

test("com AI_ATTENDANCE_ANALYSIS=0 o sistema se comporta como antes", async () => {
  const result = await collect();
  const database = await modules().database.getDatabase();

  assert.equal(result.totalTickets, 7);
  assert.equal(messageRequests().length, 0, "nenhuma chamada a /messages");
  assert.equal(result.diagnostics.requisicoesPorEndpoint["GET /messages/{ticketId}"], undefined);
  for (const table of ["messages", "message_sync", "attendance_analyses"]) {
    const row = await database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get();
    assert.equal(row.total, 0, `${table} deveria continuar vazia`);
  }
});

test("teto de leituras por coleta, contado no diagnostico", async () => {
  const { createToken } = require(path.join(SRC, "services/token.service"));
  await createToken({ name: "Stephanie - teste", attendant: "Stephanie", role: "ATENDENTE" });
  await createToken({ name: "Gabriel - teste", attendant: "gabriel oliveira", role: "ATENDENTE" });
  await seedReadings();

  process.env.AI_ATTENDANCE_ANALYSIS = "1";
  process.env.MTALK_MAX_MESSAGE_FETCHES = "2";

  const first = await collect();
  assert.equal(messageRequests().length, 2);
  assert.equal(first.diagnostics.requisicoesPorEndpoint["GET /messages/{ticketId}"], 2);
  assert.deepEqual(
    messageRequests().map((request) => request.url.split("?")[0]),
    ["/backend/messages/5001", "/backend/messages/5002"],
    "do updatedAt mais antigo para o mais novo; o 5006 (fora do recorte) nao gasta o teto"
  );

  process.env.MTALK_MAX_MESSAGE_FETCHES = "20";
  lastCollection = await collect();
  assert.equal(messageRequests().length, 6, "so os 4 que faltavam; quem nao mudou nao e lido de novo");
  assert.equal(lastCollection.diagnostics.requisicoesPorEndpoint["GET /messages/{ticketId}"], 4);
});

test("nenhuma requisicao ao MTalk leva markAsRead, e todas sao GET", () => {
  assert.ok(mtalkRequests.length > 0);
  for (const request of mtalkRequests) {
    assert.equal(request.method, "GET");
    assert.ok(!/markasread/i.test(request.url), request.url);
  }
});

test("mensagens gravadas ja mascaradas: nenhum valor original em nenhuma coluna", async () => {
  const database = await modules().database.getDatabase();
  for (const { table, column, value } of await allTextValues(database)) {
    assertNoneOf(FORBIDDEN, value, `${table}.${column}`);
  }

  const rows = await database
    .prepare(`SELECT id, sender_kind AS kind, attendant, body_masked AS body, pii_found AS pii, flags FROM messages WHERE ticket_id = '5001' ORDER BY created_at`)
    .all();
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));

  assert.equal(rows.length, 11, "a reacao fica fora da conversa");
  assert.equal(byId["ID-5001-05"].body, "[LOCALIZACAO]");
  assert.equal(byId["ID-5001-06"].body, "[CONTATO]");
  assert.equal(byId["ID-5001-01"].body, "boa tarde, meu cpf e [CPF] e estou sem internet");
  assert.deepEqual(JSON.parse(byId["ID-5001-01"].pii), { CPF: 1 });
  assert.equal(byId["ID-5001-02"].kind, "ATENDENTE");
  assert.equal(byId["ID-5001-02"].body, "Ola [CLIENTE], vou verificar. Pode confirmar o endereco?");
  assert.equal(byId["ID-5001-02"].attendant, "Stephanie");
  assert.deepEqual(JSON.parse(byId["ID-5001-09"].flags), ["ORGAO_EXTERNO"]);
});

test("recorte: so os trechos com atendente vinculado em fila monitorada sao gravados", async () => {
  const { attendance, database } = modules();
  const db = await database.getDatabase();

  assert.ok(!messageRequests().some((request) => request.url.startsWith("/backend/messages/5006")), "atendente sem token nem gasta GET");
  const paula = await db.prepare("SELECT COUNT(*) AS total FROM messages WHERE ticket_id = '5006'").get();
  assert.equal(paula.total, 0);

  const rows = await db
    .prepare(`SELECT id, sender_kind AS kind, attendant FROM messages WHERE ticket_id = '5007' ORDER BY created_at`)
    .all();
  assert.deepEqual(
    rows.map((row) => row.id),
    ["ID-5007-03", "ID-5007-04", "ID-5007-07", "ID-5007-08"],
    "fora: fila de espera, bot, assinatura sem token e mensagem de outra fila"
  );
  assert.ok(rows.every((row) => row.attendant === "Stephanie"));

  const status = await attendance.getAttendanceStatus();
  assert.deepEqual(status.recorte.atendentesVinculados, ["Gabriel Oliveira", "Stephanie"]);
  assert.equal(status.leitura.ultima.mensagensForaDoRecorte, 4, "as 4 do 5007 na ultima leitura");
  assert.equal(status.leitura.ultima.ticketsForaDoRecorte, 1, "o 5006");
});

test("analise automatica respeita o teto por hora e grava o que a IA devolveu ja mascarado", async () => {
  const { attendance, database } = modules();
  process.env.AI_ANALYSIS_MAX_PER_HOUR = "1";

  await attendance.runAutomaticAnalysisIfDue({ force: true });
  assert.equal(openAiRequests.length, 1, "6 tickets elegiveis, teto de 1 por hora");

  await attendance.runAutomaticAnalysisIfDue({ force: true });
  assert.equal(openAiRequests.length, 1, "o orcamento da hora ja foi gasto");

  const db = await database.getDatabase();
  const rows = await db.prepare(`SELECT id, ticket_id AS "ticketId" FROM attendance_analyses`).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ticketId, "5001", "a conversa parada ha mais tempo vai primeiro");

  const analysis = await attendance.getAnalysis(rows[0].id);
  assert.equal(analysis.status, "CONCLUIDA");
  assert.equal(analysis.trigger, "AUTOMATICA");
  assert.equal(analysis.attendant, "Stephanie");
  assert.equal(analysis.content.resumo, "Cliente [CLIENTE] informou o cpf [CPF] e o problema foi resolvido.");
  assert.deepEqual(analysis.content.evidencias, [{ mensagemId: "ID-5001-01", motivo: "pedido inicial" }]);
  assert.equal(analysis.content.nota, 4);
  assert.ok(analysis.systemAlerts.some((alerta) => alerta.tipo === "ORGAO_EXTERNO"));
  assert.equal(analysis.metrics.mensagensCliente, 8);
  assert.equal(analysis.metrics.mensagensAtendente, 3);
  assert.equal(analysis.metrics.primeiraRespostaMinutos, 2);

  const evidencia = analysis.transcricao.find((item) => item.id === "ID-5001-01");
  assert.deepEqual(evidencia.evidencia, { motivo: "pedido inicial" });
  assert.ok(analysis.transcricao.every((item) => !String(item.texto).includes("123.456")));
});

test("o que foi para a OpenAI nao tem valor original, nome nem horario absoluto", () => {
  assert.ok(openAiRequests.length >= 1);
  for (const raw of openAiRequests) {
    assertNoneOf(FORBIDDEN_FOR_OPENAI, raw, "requisicao a OpenAI");
    const body = JSON.parse(raw);
    const user = body.messages.find((message) => message.role === "user").content;
    const payload = JSON.parse(user.slice(user.indexOf("{"), user.lastIndexOf("}") + 1));
    assert.equal(payload.mensagens[0].id, "m1");
    assert.equal(payload.mensagens[0].minuto, 0);
    assert.equal(payload.ticket.fila, "Suporte-MIX");
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(user), "sem data/hora absoluta");
    assert.equal(body.response_format.json_schema.strict, true);
  }
});

test("assertNoPii bloqueia um payload com dado cru: nada vai para a OpenAI", async () => {
  const { attendance, database } = modules();
  const db = await database.getDatabase();
  const before = openAiRequests.length;

  // Simula um defeito no mascaramento de entrada (numa mensagem do recorte).
  await db
    .prepare(
      `INSERT INTO messages (id, ticket_id, from_me, sender_kind, attendant, body_masked, pii_found, flags, created_at, collected_at)
       VALUES ('ID-CRU', '5002', 0, 'CLIENTE', 'Gabriel Oliveira', 'meu cpf e 123.456.789-09', '{}', '[]', ?, ?)`
    )
    .run(new Date(NOW - 100 * 60000).toISOString(), new Date().toISOString());

  const analysis = await attendance.analyzeTicketManually("5002", { createdBy: "teste" });
  await db.prepare("DELETE FROM messages WHERE id = 'ID-CRU'").run();

  assert.equal(openAiRequests.length, before, "o payload nao pode sair");
  assert.equal(analysis.status, "BLOQUEADA");
  assert.equal(analysis.content, null);
  const bloqueio = analysis.systemAlerts.find((alerta) => alerta.tipo === "ANALISE_BLOQUEADA");
  assert.deepEqual(bloqueio.tipos, { CPF: 1 });
  const gravada = await db.prepare("SELECT * FROM attendance_analyses WHERE id = ?").get(analysis.id);
  assert.ok(!JSON.stringify(gravada).includes("123.456"), "o registro guarda so o tipo e a quantidade");
});

test("rotas: so o painel acessa, feature desligada responde 403", async () => {
  const app = require(path.join(SRC, "app"));
  const { createAdminUser } = require(path.join(SRC, "services/admin-auth.service"));
  const { createToken } = require(path.join(SRC, "services/token.service"));

  appServer = await listen(app);
  api = `http://127.0.0.1:${appServer.address().port}`;

  await createAdminUser({ username: "supervisao-teste", name: "Supervisao", password: "senha-de-teste-123" });
  const login = await fetch(`${api}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "supervisao-teste", password: "senha-de-teste-123" })
  }).then((response) => response.json());
  painel = { authorization: `Bearer ${login.session}` };

  const { token } = await createToken({ name: "Extensao teste", role: "ADMIN" });
  const extensao = await fetch(`${api}/api/attendance/status`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(extensao.status, 401, "token da extensao nunca le analise");
  assert.equal((await fetch(`${api}/api/attendance/analyses`)).status, 401);

  const status = await fetch(`${api}/api/attendance/status`, { headers: painel }).then((response) => response.json());
  assert.equal(status.ligada, true);
  assert.ok(status.mensagensNoBanco >= 11);
  assert.equal(status.orcamentoHora.limite, 1);

  const lista = await fetch(`${api}/api/attendance/analyses?riscoCancelamento=MEDIO`, { headers: painel }).then((response) =>
    response.json()
  );
  assert.equal(lista.items.length, 1);
  assert.equal(lista.items[0].clientName, CLIENT_NAMES[5001], "nome do cliente so no painel");
  assert.equal(lista.totais.analisadas, 1);
  assert.equal(lista.totais.bloqueadas, 0);

  const porAtendente = await fetch(`${api}/api/attendance/by-attendant`, { headers: painel }).then((response) => response.json());
  assert.deepEqual(porAtendente.items.map((item) => item.attendant), ["Stephanie"]);

  const manual = await fetch(`${api}/api/attendance/tickets/5003/analyze`, { method: "POST", headers: painel });
  assert.equal(manual.status, 201);
  const criada = await manual.json();
  assert.equal(criada.trigger, "MANUAL");
  assert.equal(criada.createdBy, "supervisao-teste");
  assert.equal(criada.status, "CONCLUIDA");

  const leiturasAntes = messageRequests().length;
  const fora = await fetch(`${api}/api/attendance/tickets/5006/analyze`, { method: "POST", headers: painel });
  assert.equal(fora.status, 400, "atendente sem token: nada no recorte");
  assert.match((await fora.json()).error, /recorte/);
  assert.equal(messageRequests().length, leiturasAntes, "nem le o ticket no MTalk");

  process.env.AI_ATTENDANCE_ANALYSIS = "0";
  const desligada = await fetch(`${api}/api/attendance/tickets/5003/analyze`, { method: "POST", headers: painel });
  assert.equal(desligada.status, 403);
  assert.match((await desligada.json()).error, /AI_ATTENDANCE_ANALYSIS=1/);
  process.env.AI_ATTENDANCE_ANALYSIS = "1";

  assert.equal((await fetch(`${api}/api/attendance/tickets/abc/analyze`, { method: "POST", headers: painel })).status, 400);
  assert.equal((await fetch(`${api}/api/attendance/tickets/999999/analyze`, { method: "POST", headers: painel })).status, 404);
});

test("revogar o token tira o atendente da analise na hora", async () => {
  const { attendance } = modules();
  const { listTokens, revokeToken } = require(path.join(SRC, "services/token.service"));
  const gabriel = (await listTokens()).items.find((item) => item.attendant === "Gabriel Oliveira" && item.isActive);
  await revokeToken(gabriel.id);

  const leiturasAntes = messageRequests().length;
  const response = await fetch(`${api}/api/attendance/tickets/5003/analyze`, { method: "POST", headers: painel });
  assert.equal(response.status, 400, "as mensagens do 5003 continuam no banco, mas fora do recorte");
  assert.equal(messageRequests().length, leiturasAntes, "sem trecho vinculado, nem le o ticket");
  assert.deepEqual((await attendance.getAttendanceStatus()).recorte.atendentesVinculados, ["Stephanie"]);
});

test("de novo: nada do que foi gravado ou enviado tem o valor original", async () => {
  const database = await modules().database.getDatabase();
  for (const { table, column, value } of await allTextValues(database)) {
    assertNoneOf(FORBIDDEN, value, `${table}.${column}`);
  }
  for (const raw of openAiRequests) {
    assertNoneOf(FORBIDDEN_FOR_OPENAI, raw, "requisicao a OpenAI");
  }
});
