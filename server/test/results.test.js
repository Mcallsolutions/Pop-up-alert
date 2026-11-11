// Resultados: % de acerto por contagem de falhas (inatividade pesa mais que TAG),
// geral e por atendente. SQLite temporario e cwd fora do projeto. So dados FICTICIOS.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const SRC = path.resolve(__dirname, "../src");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resultados-teste-"));
process.chdir(workDir);

Object.assign(process.env, {
  SQLITE_PATH: path.join(workDir, "teste.sqlite"),
  MTALK_TOKEN: "",
  MTALK_COLLECT_INTERVAL_SECONDS: "0",
  MONITOR_TIME_ZONE: "America/Sao_Paulo",
  INACTIVITY_THRESHOLD_MINUTES: "15",
  RETENTION_DAYS: "0",
  REPORT_CACHE_SECONDS: "0",
  AI_ATTENDANCE_ANALYSIS: "0",
  WHATSAPP_ALERTS: "0",
  SERVE_ADMIN: "0"
});
delete process.env.RESULT_INACTIVITY_WEIGHT;
delete process.env.EXTENSION_OPEN_MODE;

const NOW = Date.now();
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const QUEUE = "Suporte-MIX";

const { saveSnapshot } = require(path.join(SRC, "services/ticket.service"));
const { toZonedIso } = require(path.join(SRC, "services/time-zone"));
const { getResults } = require(path.join(SRC, "services/report.service"));
const { buildResults } = require(path.join(SRC, "services/results"));
const { getResultInactivityWeight } = require(path.join(SRC, "config/monitoring"));

const OPTIONS = { thresholdMinutes: 18, inactivityWeight: 70 };

function t(attendant, minutes, hasTag = true) {
  return { attendant, inactivityMinutes: minutes, hasResponsible: Boolean(attendant), hasTag };
}

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

function dayAgo(days) {
  return toZonedIso(new Date(NOW - days * DAY_MS)).slice(0, 10);
}

test("acerto = 1 - falhas/atendimentos, ponderado: inatividade pesa mais que TAG", () => {
  // 10 atendimentos: 2 parados (80% de acerto) e 5 sem TAG (50% de acerto).
  const tickets = [
    ...Array.from({ length: 2 }, () => t("A", 40)),
    ...Array.from({ length: 3 }, () => t("A", 5, false)),
    ...Array.from({ length: 2 }, () => t("A", 5, false)),
    ...Array.from({ length: 3 }, () => t("A", 5))
  ];
  const [linha] = buildResults(tickets, OPTIONS).items;
  assert.equal(linha.atendimentos, 10);
  assert.equal(linha.inactivityFailures, 2);
  assert.equal(linha.tagFailures, 5);
  assert.equal(linha.inactivityPercent, 80);
  assert.equal(linha.tagPercent, 50);
  assert.equal(linha.percent, 71, "80*0,7 + 50*0,3");

  // Mesma contagem de falhas em cada metrica: a de inatividade derruba mais.
  const soInatividade = buildResults([t("A", 40), t("A", 5), t("A", 5), t("A", 5)], OPTIONS);
  const soTag = buildResults([t("A", 5, false), t("A", 5), t("A", 5), t("A", 5)], OPTIONS);
  assert.equal(soInatividade.percent, 82.5);
  assert.equal(soTag.percent, 92.5);
  assert.ok(soInatividade.percent < soTag.percent);
});

test("o limite de registro nao e falha; ticket sem atendente so conta na inatividade", () => {
  const geral = buildResults([t("A", 18), t("", 30, false), t("", 5, false)], OPTIONS);
  assert.equal(geral.atendimentos, 3);
  assert.equal(geral.inactivityFailures, 1);
  assert.equal(geral.tagFailures, 0, "aguardando atendente nao tem a quem cobrar a TAG");
  assert.equal(geral.tagPercent, 100);
  assert.deepEqual(
    geral.items.map((item) => item.attendant),
    ["A"],
    "sem atendente nao ha linha propria"
  );

  const soAguardando = buildResults([t("", 30, false), t("", 5, false)], OPTIONS);
  assert.equal(soAguardando.tagPercent, null);
  assert.equal(soAguardando.percent, 50, "sem TAG cobravel vale so a inatividade");
});

test("sem ticket nenhum o resultado e null, nao 0%", () => {
  const vazio = buildResults([], OPTIONS);
  assert.equal(vazio.percent, null);
  assert.equal(vazio.atendimentos, 0);
  assert.deepEqual(vazio.items, []);
  assert.equal(vazio.tagWeight, 30);
});

test("peso da inatividade: padrao 70, sempre acima de 50 e abaixo de 100", () => {
  assert.equal(getResultInactivityWeight(), 70);
  process.env.RESULT_INACTIVITY_WEIGHT = "80";
  assert.equal(getResultInactivityWeight(), 80);
  for (const invalido of ["50", "30", "100", "abc", "-5"]) {
    process.env.RESULT_INACTIVITY_WEIGHT = invalido;
    assert.equal(getResultInactivityWeight(), 70, `${invalido} volta ao padrao`);
  }
  delete process.env.RESULT_INACTIVITY_WEIGHT;
});

let appServer;

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

test("resultados do banco: geral e por atendente, do pior para o melhor", async () => {
  const resultados = await getResults({ startDate: dayAgo(2) });

  // 6 tickets avaliados (o sem nome de contato fica de fora): 4 parados e 1 sem
  // TAG entre os 5 que tem atendente.
  assert.equal(resultados.atendimentos, 6);
  assert.equal(resultados.inactivityFailures, 4);
  assert.equal(resultados.tagFailures, 1);
  assert.equal(resultados.inactivityPercent, 33.3);
  assert.equal(resultados.tagPercent, 80);
  assert.equal(resultados.percent, 47.3);
  assert.equal(resultados.inactivityWeight, 70);
  assert.equal(resultados.thresholdMinutes, 18);

  assert.deepEqual(
    resultados.items.map((item) => [item.attendant, item.atendimentos, item.inactivityFailures, item.tagFailures, item.percent]),
    [
      ["Atendente B", 1, 1, 0, 30],
      ["Atendente C", 1, 1, 0, 30],
      ["Atendente A", 3, 1, 1, 66.7]
    ]
  );

  const antigo = await getResults({ startDate: dayAgo(25), endDate: dayAgo(15) });
  assert.equal(antigo.atendimentos, 1);
  assert.equal(antigo.percent, 0, "parado 40 min e sem TAG");
});

test("rota /api/reports/results exige login", async () => {
  const app = require(path.join(SRC, "app"));
  const { createAdminUser } = require(path.join(SRC, "services/admin-auth.service"));

  appServer = await new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
  const api = `http://127.0.0.1:${appServer.address().port}`;

  await createAdminUser({ username: "resultados-teste", name: "Supervisao", password: "senha-de-teste-123" });
  const login = await fetch(`${api}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "resultados-teste", password: "senha-de-teste-123" })
  }).then((response) => response.json());

  assert.equal((await fetch(`${api}/api/reports/results`)).status, 401);

  const corpo = await fetch(`${api}/api/reports/results?startDate=${dayAgo(2)}`, {
    headers: { authorization: `Bearer ${login.session}` }
  }).then((response) => response.json());
  assert.equal(corpo.percent, 47.3);
  assert.equal(corpo.items.length, 3);
});
