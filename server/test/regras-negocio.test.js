// Regras de negocio: so atendentes monitorados, limite de alerta (15) x de
// registro (18), varios atendentes no filtro e retencao de 60 dias. SQLite
// temporario e cwd fora do projeto. So dados FICTICIOS.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SRC = path.resolve(__dirname, "../src");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "regras-teste-"));
process.chdir(workDir);

Object.assign(process.env, {
  SQLITE_PATH: path.join(workDir, "teste.sqlite"),
  MTALK_TOKEN: "",
  MTALK_COLLECT_INTERVAL_SECONDS: "0",
  MONITOR_TIME_ZONE: "America/Sao_Paulo",
  REPORT_CACHE_SECONDS: "0",
  AI_ATTENDANCE_ANALYSIS: "0",
  WHATSAPP_ALERTS: "0",
  SERVE_ADMIN: "0"
});
for (const name of ["INACTIVITY_THRESHOLD_MINUTES", "INACTIVITY_RECORD_MINUTES", "RETENTION_DAYS", "SERVICE_STANDARD_ZERO_MINUTES"]) {
  delete process.env[name];
}

const QUEUE = "Suporte-MIX";
const { saveSnapshot } = require(path.join(SRC, "services/ticket.service"));
const { toZonedIso } = require(path.join(SRC, "services/time-zone"));
const { getDatabase, purgeUnmonitoredAttendants } = require(path.join(SRC, "database"));
const { isMonitoredAttendant, listMonitoredAttendants } = require(path.join(SRC, "services/attendant-filter"));
const { buildCacheKey } = require(path.join(SRC, "services/report-cache"));
const {
  getInactivityRecordMinutes,
  getInactivityThresholdMinutes,
  getRetentionDays,
  getServiceStandardZeroMinutes
} = require(path.join(SRC, "config/monitoring"));
const { getInactiveTickets, getReportByAttendant } = require(path.join(SRC, "services/report.service"));

function ticket(id, attendant, minutes = 3) {
  return {
    externalTicketId: String(id),
    clientName: `Cliente Ficticio ${id}`,
    queue: QUEUE,
    attendant,
    tags: ["Cliente"],
    inactivityMinutes: minutes
  };
}

test("padroes: retencao de 60 dias, alerta em 15 e registro em 18 minutos", () => {
  assert.equal(getRetentionDays(), 60);
  assert.equal(getInactivityThresholdMinutes(), 15);
  assert.equal(getInactivityRecordMinutes(), 18);
  assert.equal(getServiceStandardZeroMinutes(), 60);

  process.env.INACTIVITY_RECORD_MINUTES = "10";
  assert.equal(getInactivityRecordMinutes(), 15, "o registro nunca fica abaixo do alerta");
  delete process.env.INACTIVITY_RECORD_MINUTES;
});

test("so entram tickets sem atendente e dos 5 atendentes monitorados", () => {
  assert.deepEqual(listMonitoredAttendants(), [
    "Guilherme Gomes",
    "Gabriell Carvalho",
    "Luis otavio",
    "Stephanie",
    "Aleksandro"
  ]);

  for (const name of ["", "  ", null, "Guilherme Gomes", "GABRIELL CARVALHO", "luis otavio", "Stephanie", "Alek", "Alek NETFIBRA"]) {
    assert.equal(isMonitoredAttendant(name), true, `deveria entrar: ${JSON.stringify(name)}`);
  }
  for (const name of ["Paula Andrade", "Gabriel Oliveira", "Gabriell", "Stephanie Silva"]) {
    assert.equal(isMonitoredAttendant(name), false, `deveria ficar de fora: ${name}`);
  }
});

test("chave do cache: a ordem dos atendentes nao cria resposta nova", () => {
  assert.equal(
    buildCacheKey("x", { attendant: ["Stephanie", "Aleksandro"] }),
    buildCacheKey("x", { attendant: ["Aleksandro", "Stephanie", "Stephanie"] })
  );
  assert.notEqual(buildCacheKey("x", { attendant: ["Stephanie"] }), buildCacheKey("x", { attendant: ["Stephanie", "Aleksandro"] }));
});

test.before(async () => {
  await saveSnapshot({
    source: "teste",
    url: "http://mtalk.local/tickets",
    collectedAt: toZonedIso(new Date()),
    tickets: [
      ticket(1, "Stephanie", 16),
      ticket(2, "Stephanie", 30),
      ticket(3, "Aleksandro", 45),
      ticket(4, "Guilherme Gomes", 20),
      ticket(5, "", 25)
    ]
  });
});

test("relatorios so contam a parada acima de 18 min (16 min alerta, mas nao registra)", async () => {
  const lista = await getInactiveTickets({}, { paginate: true });
  const ids = lista.items.map((item) => item.externalTicketId);
  assert.ok(!ids.includes("1"), "16 min fica na margem: alerta sim, registro nao");
  assert.deepEqual(ids, ["3", "2", "5", "4"]);
  assert.equal(lista.paginacao.total, 4);
});

test("filtro com varios atendentes: entra quem bate com qualquer um", async () => {
  const dois = await getInactiveTickets({ attendant: ["Stephanie", "Alek"] }, { paginate: true });
  assert.deepEqual(dois.items.map((item) => item.externalTicketId), ["3", "2"]);

  const um = await getInactiveTickets({ attendant: "Guilherme" }, { paginate: true });
  assert.deepEqual(um.items.map((item) => item.externalTicketId), ["4"]);

  const vazio = await getInactiveTickets({ attendant: [] }, { paginate: true });
  assert.equal(vazio.paginacao.total, 4, "lista vazia = sem filtro");

  const porAtendente = await getReportByAttendant({ attendant: ["Stephanie", "Aleksandro"] });
  assert.deepEqual(porAtendente.items.map((item) => item.attendant).sort(), ["Aleksandro", "Stephanie"]);
});

test("migracao: apaga so quem nao e monitorado nem sem atendente, e e repetivel", async () => {
  const { DatabaseSync } = require("node:sqlite");
  const database = await getDatabase();
  await saveSnapshot({
    source: "teste",
    url: "http://mtalk.local/tickets",
    collectedAt: toZonedIso(new Date()),
    tickets: [ticket(90, "Paula Andrade"), ticket(91, "Gabriel Oliveira"), ticket(92, ""), ticket(93, "Luis otavio")]
  });

  const raw = new DatabaseSync(database.filename);
  raw.exec("PRAGMA busy_timeout = 5000");
  raw
    .prepare(
      `INSERT INTO messages (id, ticket_id, from_me, sender_kind, body_masked, created_at, collected_at)
       VALUES ('M90', '90', 0, 'CLIENTE', 'oi', '2026-01-01T10:00:00-03:00', '2026-01-01T10:00:00-03:00'),
              ('M93', '93', 0, 'CLIENTE', 'oi', '2026-01-01T10:00:00-03:00', '2026-01-01T10:00:00-03:00')`
    )
    .run();

  purgeUnmonitoredAttendants(raw);
  const remaining = raw.prepare("SELECT DISTINCT external_ticket_id AS id FROM tickets WHERE external_ticket_id >= '90' ORDER BY 1").all();
  assert.deepEqual(remaining.map((row) => row.id), ["92", "93"]);
  const messages = raw.prepare("SELECT ticket_id FROM messages").all();
  assert.deepEqual(messages.map((row) => row.ticket_id), ["93"], "a conversa de quem saiu tambem sai");

  purgeUnmonitoredAttendants(raw);
  assert.equal(raw.prepare("SELECT COUNT(*) AS total FROM tickets WHERE external_ticket_id >= '90'").get().total, 2);
  raw.close();

  const applied = await database.prepare("SELECT 1 AS found FROM schema_migrations WHERE filename = '006_somente_atendentes_monitorados'").get();
  assert.ok(applied, "a migracao ficou registrada e nao roda de novo");
});
