// Padrao de atendimento (TAG + inatividade), paginacao da lista de inativos e
// periodo personalizado. SQLite temporario e cwd fora do projeto, para o dotenv
// nunca carregar o .env real. So dados FICTICIOS.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const SRC = path.resolve(__dirname, "../src");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "padrao-teste-"));
process.chdir(workDir);

Object.assign(process.env, {
  SQLITE_PATH: path.join(workDir, "teste.sqlite"),
  MTALK_TOKEN: "",
  MTALK_COLLECT_INTERVAL_SECONDS: "0",
  MONITOR_TIME_ZONE: "America/Sao_Paulo",
  INACTIVITY_THRESHOLD_MINUTES: "15",
  RETENTION_DAYS: "0",
  MISSING_TAG_LIST_DAYS: "10",
  REPORT_CACHE_SECONDS: "0",
  AI_ATTENDANCE_ANALYSIS: "0",
  WHATSAPP_ALERTS: "0",
  SERVE_ADMIN: "0"
});
delete process.env.SERVICE_STANDARD_ZERO_MINUTES;
delete process.env.EXTENSION_OPEN_MODE;

const NOW = Date.now();
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const QUEUE = "Suporte-MIX";

const { saveSnapshot } = require(path.join(SRC, "services/ticket.service"));
const { toZonedIso } = require(path.join(SRC, "services/time-zone"));
const { getInactiveTickets, getMissingTags, getServiceStandard } = require(path.join(SRC, "services/report.service"));
const { buildServiceStandard, inactivityScore, scoreTicket } = require(path.join(SRC, "services/service-standard"));
const { getServiceStandardZeroMinutes } = require(path.join(SRC, "config/monitoring"));

const OPTIONS = { thresholdMinutes: 15, zeroMinutes: 60 };

function ticket(id, { tags = ["Cliente"], attendant = "Atendente A", minutes = 3, clientName } = {}) {
  return {
    externalTicketId: String(id),
    clientName: clientName ?? `Cliente Ficticio ${id}`,
    queue: QUEUE,
    attendant,
    tags,
    inactivityMinutes: minutes
  };
}

async function snapshot(agoMs, tickets) {
  await saveSnapshot({
    source: "teste",
    url: "http://mtalk.local/tickets",
    collectedAt: toZonedIso(new Date(NOW - agoMs)),
    tickets
  });
}

// "YYYY-MM-DD" na hora local da operacao, como o painel manda no filtro.
function dayAgo(days) {
  return toZonedIso(new Date(NOW - days * DAY_MS)).slice(0, 10);
}

test("nota de inatividade: 100 ate o limite e cai em linha reta ate zerar", () => {
  assert.equal(inactivityScore(0, OPTIONS), 100);
  assert.equal(inactivityScore(15, OPTIONS), 100, "no limite ainda nao desconta");
  assert.equal(inactivityScore(37.5, OPTIONS), 50);
  assert.equal(inactivityScore(60, OPTIONS), 0);
  assert.equal(inactivityScore(600, OPTIONS), 0, "nunca fica negativa");
  assert.equal(inactivityScore(null, OPTIONS), 100);
});

test("nota do ticket: metade TAG, metade inatividade; sem atendente so inatividade", () => {
  assert.equal(scoreTicket({ inactivityMinutes: 3, hasResponsible: true, hasTag: true }, OPTIONS).score, 100);
  assert.equal(scoreTicket({ inactivityMinutes: 3, hasResponsible: true, hasTag: false }, OPTIONS).score, 50);
  assert.equal(scoreTicket({ inactivityMinutes: 60, hasResponsible: true, hasTag: true }, OPTIONS).score, 50);
  assert.equal(scoreTicket({ inactivityMinutes: 60, hasResponsible: true, hasTag: false }, OPTIONS).score, 0);

  const aguardando = scoreTicket({ inactivityMinutes: 37.5, hasResponsible: false, hasTag: false }, OPTIONS);
  assert.equal(aguardando.score, 50, "ticket sem atendente nao e cobrado pela TAG");
  assert.equal(aguardando.tag, null);
});

test("sem ticket nenhum a porcentagem e null, nao 0%", () => {
  const vazio = buildServiceStandard([], OPTIONS);
  assert.equal(vazio.percent, null);
  assert.equal(vazio.tickets, 0);
  assert.deepEqual(vazio.items, []);
});

test("ponto de zero configuravel, mas nunca abaixo do limite", () => {
  assert.equal(getServiceStandardZeroMinutes(), 60, "padrao: 4x o limite");
  process.env.SERVICE_STANDARD_ZERO_MINUTES = "90";
  assert.equal(getServiceStandardZeroMinutes(), 90);
  process.env.SERVICE_STANDARD_ZERO_MINUTES = "10";
  assert.equal(getServiceStandardZeroMinutes(), 60, "valor invalido volta ao padrao");
  delete process.env.SERVICE_STANDARD_ZERO_MINUTES;
});

let appServer;
let api;
let painel;

test.before(async () => {
  // Ha 1 hora o ticket 6 ficou 50 min parado; agora esta com 2 min e com TAG.
  await snapshot(60 * MINUTE_MS, [ticket(6, { attendant: "Atendente C", minutes: 50 })]);
  await snapshot(0, [
    ticket(1, { minutes: 10 }),
    ticket(2, { minutes: 60 }),
    ticket(3, { tags: [], minutes: 5 }),
    ticket(4, { attendant: "Atendente B", minutes: 20 }),
    ticket(5, { attendant: "", tags: [], minutes: 30 }),
    ticket(6, { attendant: "Atendente C", minutes: 2 }),
    ticket(8, { clientName: "", minutes: 90 })
  ]);
  // Ha 20 dias: sem TAG e parado 40 min.
  await snapshot(20 * DAY_MS, [ticket(7, { tags: [], minutes: 40 })]);
});

test.after(async () => {
  if (appServer) {
    appServer.closeAllConnections?.();
    await new Promise((resolve) => appServer.close(resolve));
  }
});

test("padrao geral e por atendente: pico de parada + TAG da leitura mais recente", async () => {
  const padrao = await getServiceStandard({ startDate: dayAgo(2) });

  // 6 tickets avaliados (o sem nome de contato fica de fora).
  assert.equal(padrao.tickets, 6);
  assert.equal(padrao.percent, 70.4);
  assert.equal(padrao.inactivityPercent, 63);
  assert.equal(padrao.tagPercent, 80, "so os 5 que tem atendente entram na parte da TAG");
  assert.equal(padrao.inactiveTickets, 4);
  assert.equal(padrao.withoutTag, 1);
  assert.equal(padrao.thresholdMinutes, 15);
  assert.equal(padrao.zeroMinutes, 60);

  // Do pior para o melhor; ticket sem atendente so conta no geral.
  assert.deepEqual(
    padrao.items.map((item) => [item.attendant, item.tickets, item.percent]),
    [
      ["Atendente C", 1, 61.1],
      ["Atendente A", 3, 66.7],
      ["Atendente B", 1, 94.4]
    ]
  );
});

test("periodo personalizado separa o ticket de 20 dias atras", async () => {
  const antigo = await getServiceStandard({ startDate: dayAgo(25), endDate: dayAgo(15) });
  assert.equal(antigo.tickets, 1);
  assert.equal(antigo.percent, 22.2, "sem TAG (0) e 40 min parado (44,4)");

  const recente = await getServiceStandard({ startDate: dayAgo(2), endDate: dayAgo(0) });
  assert.equal(recente.tickets, 6);

  const tudo = await getServiceStandard({});
  assert.equal(tudo.tickets, 7);
});

test("lista sem TAG: com data nos filtros a limpeza de 10 dias nao se aplica", async () => {
  const lista = await getMissingTags({}, { paginate: true, maxAgeDays: 10 });
  assert.ok(!lista.items.some((item) => item.externalTicketId === "7"), "sem data, o de 20 dias fica de fora");
  assert.equal(lista.limpeza.dias, 10);

  const periodo = await getMissingTags({ startDate: dayAgo(25), endDate: dayAgo(15) }, { paginate: true, maxAgeDays: 10 });
  assert.deepEqual(
    periodo.items.map((item) => item.externalTicketId),
    ["7"]
  );
  assert.equal(periodo.limpeza, undefined);
});

test("inativos paginados: maior parada primeiro, sem repetir cliente entre paginas", async () => {
  const filtros = { startDate: dayAgo(2) };

  const primeira = await getInactiveTickets({ ...filtros, pageSize: 3 }, { paginate: true });
  assert.deepEqual(primeira.paginacao, { pagina: 1, porPagina: 3, total: 4, totalPaginas: 2 });
  assert.deepEqual(
    primeira.items.map((item) => [item.externalTicketId, item.inactivityMinutes]),
    [
      ["2", 60],
      ["6", 50],
      ["5", 30]
    ]
  );

  const segunda = await getInactiveTickets({ ...filtros, pageSize: 3, page: 2 }, { paginate: true });
  assert.deepEqual(
    segunda.items.map((item) => item.externalTicketId),
    ["4"]
  );

  const alem = await getInactiveTickets({ ...filtros, pageSize: 3, page: 99 }, { paginate: true });
  assert.equal(alem.paginacao.pagina, 2, "pagina fora do intervalo cai na ultima");

  const padrao = await getInactiveTickets(filtros, { paginate: true });
  assert.equal(padrao.paginacao.porPagina, 15);

  const semPaginar = await getInactiveTickets(filtros);
  assert.equal(semPaginar.items.length, 4, "sem paginate (IA) a resposta e a de sempre");
  assert.equal(semPaginar.paginacao, undefined);
});

test("rotas: inativos paginados e padrao de atendimento exigem login", async () => {
  const app = require(path.join(SRC, "app"));
  const { createAdminUser } = require(path.join(SRC, "services/admin-auth.service"));

  appServer = await new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
  api = `http://127.0.0.1:${appServer.address().port}`;

  await createAdminUser({ username: "padrao-teste", name: "Supervisao", password: "senha-de-teste-123" });
  const login = await fetch(`${api}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "padrao-teste", password: "senha-de-teste-123" })
  }).then((response) => response.json());
  painel = { authorization: `Bearer ${login.session}` };

  assert.equal((await fetch(`${api}/api/reports/service-standard`)).status, 401);
  assert.equal((await fetch(`${api}/api/reports/inactivity/tickets`)).status, 401);

  const query = `startDate=${dayAgo(2)}`;
  const lista = await fetch(`${api}/api/reports/inactivity/tickets?${query}&pageSize=3&page=2`, { headers: painel }).then(
    (response) => response.json()
  );
  assert.equal(lista.items.length, 1);
  assert.equal(lista.paginacao.totalPaginas, 2);

  const padrao = await fetch(`${api}/api/reports/service-standard?${query}`, { headers: painel }).then((response) =>
    response.json()
  );
  assert.equal(padrao.percent, 70.4);

  const invalida = await fetch(`${api}/api/reports/service-standard?startDate=2026-09-31`, { headers: painel });
  assert.equal(invalida.status, 400, "data impossivel no periodo vira 400");
});
