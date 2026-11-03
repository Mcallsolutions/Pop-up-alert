// Alertas de inatividade no WhatsApp: um aviso por parada, travas de envio e
// nada de dado pessoal fora do que foi ligado de proposito.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildAlertMessage,
  describeWhatsappStatus,
  maskRecipient,
  resetWhatsappAlerts,
  sendTestMessage,
  startWhatsappAlerts
} = require("../src/services/whatsapp-alerts.service");

const ENV_KEYS = [
  "WHATSAPP_ALERTS",
  "WHATSAPP_PROVIDER",
  "WHATSAPP_API_URL",
  "WHATSAPP_API_KEY",
  "WHATSAPP_INSTANCE",
  "WHATSAPP_RECIPIENTS",
  "WHATSAPP_INCLUDE_CLIENT_NAME",
  "WHATSAPP_REMINDER_MINUTES",
  "WHATSAPP_MAX_PER_HOUR"
];

const EVOLUTION = {
  WHATSAPP_ALERTS: "1",
  WHATSAPP_PROVIDER: "evolution",
  WHATSAPP_API_URL: "http://evolution.invalid/",
  WHATSAPP_API_KEY: "chave-de-teste",
  WHATSAPP_INSTANCE: "mcall",
  WHATSAPP_RECIPIENTS: "5511999990001, 120363000000000001@g.us"
};

function ticket(id, minutes, extra = {}) {
  return {
    externalTicketId: String(id),
    clientName: `CLIENTE SECRETO ${id}`,
    queue: "Suporte-MIX",
    attendant: "Stephanie",
    company: "0800 MIXTEL",
    url: `https://mtalk.invalid/tickets/uuid-${id}`,
    inactivityMinutes: minutes,
    ...extra
  };
}

function setup(t, env, respond = () => new Response(JSON.stringify({ ok: true }), { status: 201 })) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    return respond(calls.length);
  };

  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await resetWhatsappAlerts();
  });
  return calls;
}

test("desligado por padrao: nenhuma chamada sai do servidor", async (t) => {
  const calls = setup(t, {});
  assert.equal(startWhatsappAlerts({ tickets: [ticket(1, 40)], thresholdMinutes: 15 }), null);
  assert.equal(calls.length, 0);
  assert.equal(describeWhatsappStatus().ligado, false);
});

test("Evolution: um aviso por parada, para cada destinatario, sem nome do cliente", async (t) => {
  const calls = setup(t, EVOLUTION);
  const now = new Date("2026-11-03T15:00:00Z");

  await startWhatsappAlerts({ tickets: [ticket(1, 40), ticket(2, 90)], thresholdMinutes: 15, now });
  assert.equal(calls.length, 2, "uma mensagem por destinatario");
  assert.equal(calls[0].url, "http://evolution.invalid/message/sendText/mcall");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers.apikey, "chave-de-teste");
  assert.equal(calls[0].body.number, "5511999990001");
  assert.equal(calls[1].body.number, "120363000000000001@g.us");

  const texto = calls[0].body.text;
  assert.match(texto, /2 clientes passaram de 15 min/);
  assert.match(texto, /Suporte-MIX · Stephanie · 0800 MIXTEL — \*1h30\*/);
  assert.match(texto, /https:\/\/mtalk\.invalid\/tickets\/uuid-1/);
  assert.ok(!texto.includes("CLIENTE SECRETO"), "nome do cliente so com WHATSAPP_INCLUDE_CLIENT_NAME=1");

  // Mesmos tickets, ainda parados: nada novo.
  await startWhatsappAlerts({ tickets: [ticket(1, 41), ticket(2, 91)], thresholdMinutes: 15, now });
  assert.equal(calls.length, 2);

  // O ticket 1 volta a ter atividade e depois para de novo: aviso novo so dele.
  await startWhatsappAlerts({ tickets: [ticket(2, 92)], thresholdMinutes: 15, now });
  await startWhatsappAlerts({ tickets: [ticket(1, 16), ticket(2, 93)], thresholdMinutes: 15, now });
  assert.equal(calls.length, 4);
  assert.match(calls[2].body.text, /1 cliente passou de 15 min/);
  assert.ok(!calls[2].body.text.includes("uuid-2"));

  const status = describeWhatsappStatus();
  assert.equal(status.ultimoEnvio.ok, true);
  assert.deepEqual(status.destinatarios, ["••••••••0001", "grupo …0001"]);
  assert.ok(!JSON.stringify(status).includes("chave-de-teste"));
});

test("lembrete repete o aviso enquanto o ticket continuar parado", async (t) => {
  const calls = setup(t, { ...EVOLUTION, WHATSAPP_RECIPIENTS: "5511999990001", WHATSAPP_REMINDER_MINUTES: "30" });
  const inicio = Date.parse("2026-11-03T15:00:00Z");

  await startWhatsappAlerts({ tickets: [ticket(1, 20)], thresholdMinutes: 15, now: new Date(inicio) });
  await startWhatsappAlerts({ tickets: [ticket(1, 40)], thresholdMinutes: 15, now: new Date(inicio + 20 * 60000) });
  assert.equal(calls.length, 1);

  await startWhatsappAlerts({ tickets: [ticket(1, 50)], thresholdMinutes: 15, now: new Date(inicio + 30 * 60000) });
  assert.equal(calls.length, 2);
  assert.match(calls[1].body.text, /continua parado \(lembrete\)/);
});

test("nome do cliente vai so quando ligado de proposito", async (t) => {
  const calls = setup(t, { ...EVOLUTION, WHATSAPP_RECIPIENTS: "5511999990001", WHATSAPP_INCLUDE_CLIENT_NAME: "1" });
  await startWhatsappAlerts({ tickets: [ticket(7, 30)], thresholdMinutes: 15 });
  assert.match(calls[0].body.text, /CLIENTE SECRETO 7 · Suporte-MIX/);
});

test("falha no provedor nao marca como avisado e espera antes de tentar de novo", async (t) => {
  const calls = setup(t, { ...EVOLUTION, WHATSAPP_RECIPIENTS: "5511999990001" }, (n) =>
    n === 1
      ? new Response(JSON.stringify({ response: { message: ["instance not connected"] } }), { status: 400 })
      : new Response("{}", { status: 201 })
  );
  const inicio = Date.parse("2026-11-03T15:00:00Z");

  await startWhatsappAlerts({ tickets: [ticket(1, 20)], thresholdMinutes: 15, now: new Date(inicio) });
  const status = describeWhatsappStatus();
  assert.equal(status.ultimoEnvio.ok, false);
  assert.match(status.ultimoEnvio.erro, /HTTP 400 — instance not connected/);

  // Logo depois: ainda esperando.
  await startWhatsappAlerts({ tickets: [ticket(1, 21)], thresholdMinutes: 15, now: new Date(inicio + 60000) });
  assert.equal(calls.length, 1);

  // Passada a espera, o mesmo ticket e avisado.
  await startWhatsappAlerts({ tickets: [ticket(1, 26)], thresholdMinutes: 15, now: new Date(inicio + 6 * 60000) });
  assert.equal(calls.length, 2);
  assert.equal(describeWhatsappStatus().ultimoEnvio.ok, true);
});

test("teto por hora segura a rajada de avisos", async (t) => {
  const calls = setup(t, { ...EVOLUTION, WHATSAPP_RECIPIENTS: "5511999990001", WHATSAPP_MAX_PER_HOUR: "2" });
  const inicio = Date.now();

  for (let index = 1; index <= 4; index += 1) {
    await startWhatsappAlerts({ tickets: [ticket(index, 20)], thresholdMinutes: 15, now: new Date(inicio + index * 60000) });
  }
  assert.equal(calls.length, 2);
  assert.equal(describeWhatsappStatus().ultimoEnvio.semOrcamento, true);
});

test("CallMeBot: GET com telefone, texto e apikey de cada destinatario", async (t) => {
  const calls = setup(
    t,
    { WHATSAPP_ALERTS: "1", WHATSAPP_PROVIDER: "callmebot", WHATSAPP_RECIPIENTS: "5511999990001:111222" },
    () => new Response("<p>Message queued. You will receive it in a few seconds.</p>", { status: 200 })
  );

  await startWhatsappAlerts({ tickets: [ticket(1, 20)], thresholdMinutes: 15 });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, "https://api.callmebot.com/whatsapp.php");
  assert.equal(calls[0].method, "GET");
  assert.equal(url.searchParams.get("phone"), "+5511999990001");
  assert.equal(url.searchParams.get("apikey"), "111222");
  assert.match(url.searchParams.get("text"), /1 cliente passou de 15 min/);
});

test("CallMeBot com apikey recusada vira erro mesmo com HTTP 200", async (t) => {
  setup(
    t,
    { WHATSAPP_ALERTS: "1", WHATSAPP_PROVIDER: "callmebot", WHATSAPP_RECIPIENTS: "5511999990001:000" },
    () => new Response("<b>APIKey is invalid.</b> Please check it.", { status: 200 })
  );

  const resultado = await sendTestMessage({ requestedBy: "supervisao" });
  assert.equal(resultado.ok, false);
  assert.match(resultado.destinatarios[0].erro, /APIKey is invalid/);
  assert.equal(resultado.destinatarios[0].destinatario, "••••••••0001");
});

test("configuracao incompleta aparece no status e bloqueia o teste", async (t) => {
  const calls = setup(t, { WHATSAPP_ALERTS: "1", WHATSAPP_PROVIDER: "evolution", WHATSAPP_RECIPIENTS: "5511999990001" });
  assert.match(describeWhatsappStatus().problema, /WHATSAPP_API_URL/);
  await assert.rejects(sendTestMessage(), { statusCode: 400 });
  await startWhatsappAlerts({ tickets: [ticket(1, 20)], thresholdMinutes: 15 });
  assert.equal(calls.length, 0);
});

test("mensagem corta a lista longa e mascara destinatarios", () => {
  // O mais parado esta sem atendente (aguardando na fila).
  const tickets = Array.from({ length: 13 }, (_, index) => ticket(index + 1, 20 + index, index === 12 ? { attendant: "" } : {}));
  const texto = buildAlertMessage({
    novos: tickets,
    lembretes: [],
    totalParados: 13,
    thresholdMinutes: 15,
    includeClientName: false,
    now: new Date("2026-11-03T15:00:00Z")
  });
  assert.match(texto, /\+3 outros no painel/);
  assert.match(texto, /sem atendente/);
  assert.match(texto, /Parados agora: 13/);
  assert.equal(maskRecipient("5511999990001:segredo"), "••••••••0001");
  assert.equal(maskRecipient("120363000000000001@g.us"), "grupo …0001");
});
