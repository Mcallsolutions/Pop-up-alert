// Lista de tickets sem TAG (paginacao e limpeza de 10 dias) e cache dos
// relatorios do painel. SQLite temporario e cwd fora do projeto, para o dotenv
// nunca carregar o .env real. So dados FICTICIOS.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const SRC = path.resolve(__dirname, "../src");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "relatorios-teste-"));
process.chdir(workDir);

Object.assign(process.env, {
  SQLITE_PATH: path.join(workDir, "teste.sqlite"),
  MTALK_TOKEN: "",
  MTALK_COLLECT_INTERVAL_SECONDS: "0",
  MONITOR_TIME_ZONE: "America/Sao_Paulo",
  INACTIVITY_THRESHOLD_MINUTES: "15",
  RETENTION_DAYS: "90",
  MISSING_TAG_LIST_DAYS: "10",
  REPORT_CACHE_SECONDS: "300",
  AI_ATTENDANCE_ANALYSIS: "0",
  WHATSAPP_ALERTS: "0",
  SERVE_ADMIN: "0"
});
delete process.env.EXTENSION_OPEN_MODE;

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
const QUEUE = "Suporte-MIX";

const { saveSnapshot } = require(path.join(SRC, "services/ticket.service"));
const { toZonedIso } = require(path.join(SRC, "services/time-zone"));
const { getMissingTags } = require(path.join(SRC, "services/report.service"));
const { buildCacheKey, clearReportCache } = require(path.join(SRC, "services/report-cache"));

function ticket(id, { tags = [], attendant = "Atendente Ficticio", clientName = `Cliente Ficticio ${id}` } = {}) {
  return { externalTicketId: String(id), clientName, queue: QUEUE, attendant, tags, inactivityMinutes: 3 };
}

async function snapshot(daysAgo, tickets) {
  await saveSnapshot({
    source: "teste",
    url: "http://mtalk.local/tickets",
    collectedAt: toZonedIso(new Date(NOW - daysAgo * DAY_MS)),
    tickets
  });
}

let appServer;
let api;
let painel;

test.before(async () => {
  // 3 clientes sem TAG vistos pela ultima vez ha 12 dias: saem da lista.
  // O 300 tambem foi visto ha 12 dias, mas hoje ja tem TAG.
  await snapshot(12, [ticket(100), ticket(101), ticket(102), ticket(300)]);
  // Visto ha 9 dias: ainda dentro da janela.
  await snapshot(9, [ticket(200)]);
  // Hoje: 20 sem TAG, o 300 com TAG, um aguardando na fila e um sem nome.
  const hoje = Array.from({ length: 20 }, (_, index) => ticket(1000 + index));
  hoje.push(ticket(300, { tags: ["Cliente VIP"] }), ticket(400, { attendant: "" }), ticket(500, { clientName: "" }));
  await snapshot(0, hoje);
});

test.after(async () => {
  if (appServer) {
    appServer.closeAllConnections?.();
    await new Promise((resolve) => appServer.close(resolve));
  }
});

test("lista sem TAG: 15 clientes por pagina e a ultima pagina com o resto", async () => {
  const primeira = await getMissingTags({ page: 1 }, { paginate: true, maxAgeDays: 10 });
  assert.equal(primeira.items.length, 15);
  assert.deepEqual(primeira.paginacao, { pagina: 1, porPagina: 15, total: 21, totalPaginas: 2 });

  const segunda = await getMissingTags({ page: 2 }, { paginate: true, maxAgeDays: 10 });
  assert.equal(segunda.items.length, 6);
  const ids = new Set([...primeira.items, ...segunda.items].map((item) => item.externalTicketId));
  assert.equal(ids.size, 21, "nenhum cliente repetido entre as paginas");

  const alem = await getMissingTags({ page: 99 }, { paginate: true, maxAgeDays: 10 });
  assert.equal(alem.paginacao.pagina, 2, "pagina fora do intervalo cai na ultima");

  const exportacao = await getMissingTags({ pageSize: 1000 }, { paginate: true, maxAgeDays: 10 });
  assert.equal(exportacao.items.length, 21, "a exportacao pede a lista inteira de uma vez");
});

test("limpeza: quem esta na lista ha mais de 10 dias sai sozinho, sem apagar o historico", async () => {
  const lista = await getMissingTags({}, { paginate: true, maxAgeDays: 10 });
  const ids = lista.items.map((item) => item.externalTicketId);
  for (const velho of ["100", "101", "102"]) {
    assert.ok(!ids.includes(velho), `${velho} ficou na lista`);
  }
  assert.ok(!ids.includes("300"), "o ticket que ganhou TAG depois nao volta pela leitura velha");
  assert.equal(lista.limpeza.dias, 10);
  assert.match(lista.limpeza.desde, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  assert.equal(lista.semAtendenteOcultos, 1);
  assert.equal(lista.incompletosOcultos, 1);

  const comNove = await getMissingTags({ pageSize: 1000 }, { paginate: true, maxAgeDays: 10 });
  assert.ok(comNove.items.some((item) => item.externalTicketId === "200"), "visto ha 9 dias continua");

  // Sem a limpeza (IA e MISSING_TAG_LIST_DAYS=0) o historico inteiro continua la.
  const historico = await getMissingTags({});
  assert.equal(historico.total, 24);
  assert.equal(historico.paginacao, undefined, "sem paginate a resposta e a de sempre");
});

test("chave do cache: so os filtros que mudam o resultado", () => {
  assert.equal(buildCacheKey("x", { day: "2026-11-04", fresh: "1", lixo: "abc" }), buildCacheKey("x", { day: "2026-11-04" }));
  assert.notEqual(buildCacheKey("x", { page: "1" }), buildCacheKey("x", { page: "2" }));
  assert.notEqual(buildCacheKey("x", { scopeAttendant: "A" }), buildCacheKey("x", {}));
  assert.notEqual(buildCacheKey("x", {}), buildCacheKey("y", {}));
});

test("rota: paginada, com cache, e fresh=1 traz o dado novo", async () => {
  const app = require(path.join(SRC, "app"));
  const { createAdminUser } = require(path.join(SRC, "services/admin-auth.service"));

  appServer = await new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
  api = `http://127.0.0.1:${appServer.address().port}`;

  await createAdminUser({ username: "relatorios-teste", name: "Supervisao", password: "senha-de-teste-123" });
  const login = await fetch(`${api}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "relatorios-teste", password: "senha-de-teste-123" })
  }).then((response) => response.json());
  painel = { authorization: `Bearer ${login.session}` };

  assert.equal((await fetch(`${api}/api/reports/missing-tags`)).status, 401, "sem login, nada");

  clearReportCache();
  const primeira = await fetch(`${api}/api/reports/missing-tags`, { headers: painel });
  assert.equal(primeira.headers.get("x-cache"), "MISS");
  const corpo = await primeira.json();
  assert.equal(corpo.items.length, 15);
  assert.deepEqual(corpo.paginacao, { pagina: 1, porPagina: 15, total: 21, totalPaginas: 2 });
  assert.equal(corpo.limpeza.dias, 10);

  const segunda = await fetch(`${api}/api/reports/missing-tags?page=2`, { headers: painel });
  assert.equal(segunda.headers.get("x-cache"), "MISS", "cada pagina tem a sua entrada");
  assert.equal((await segunda.json()).items.length, 6);

  const resumo = await fetch(`${api}/api/reports/summary`, { headers: painel });
  assert.equal(resumo.headers.get("x-cache"), "MISS");
  const totalAntes = (await resumo.json()).totalWithoutTag;

  // Coleta nova: o cache segue servindo a resposta guardada ate vencer...
  await snapshot(0, [ticket(9000)]);
  const guardado = await fetch(`${api}/api/reports/summary`, { headers: painel });
  assert.equal(guardado.headers.get("x-cache"), "HIT");
  assert.equal((await guardado.json()).totalWithoutTag, totalAntes);
  const listaGuardada = await fetch(`${api}/api/reports/missing-tags`, { headers: painel });
  assert.equal(listaGuardada.headers.get("x-cache"), "HIT");
  assert.equal((await listaGuardada.json()).paginacao.total, 21);

  // ...e o botao Atualizar (fresh=1) busca no banco e guarda o resultado novo.
  const atualizado = await fetch(`${api}/api/reports/summary?fresh=1`, { headers: painel });
  assert.equal(atualizado.headers.get("x-cache"), "MISS");
  assert.equal((await atualizado.json()).totalWithoutTag, totalAntes + 1);
  const depois = await fetch(`${api}/api/reports/summary`, { headers: painel });
  assert.equal(depois.headers.get("x-cache"), "HIT");
  assert.equal((await depois.json()).totalWithoutTag, totalAntes + 1);

  const listaNova = await fetch(`${api}/api/reports/missing-tags?fresh=1`, { headers: painel }).then((response) =>
    response.json()
  );
  assert.equal(listaNova.paginacao.total, 22);
  assert.equal(listaNova.items[0].externalTicketId, "9000", "o mais recente primeiro");

  // REPORT_CACHE_SECONDS=0 desliga o cache.
  process.env.REPORT_CACHE_SECONDS = "0";
  const semCache1 = await fetch(`${api}/api/reports/by-queue`, { headers: painel });
  const semCache2 = await fetch(`${api}/api/reports/by-queue`, { headers: painel });
  assert.equal(semCache1.headers.get("x-cache"), "MISS");
  assert.equal(semCache2.headers.get("x-cache"), "MISS");
  process.env.REPORT_CACHE_SECONDS = "300";
});
