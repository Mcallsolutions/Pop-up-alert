// GET /messages/{ticketId}: o painel do MTalk manda markAsRead=true, que marca a
// conversa como lida para o atendente. O monitor nunca pode mandar.

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMessagesRequest, listMessages } = require("../src/services/mtalk/mtalk.client");

const config = { baseUrl: "http://mtalk.invalid/backend", token: "token-de-teste", timeoutMs: 1000 };

test("buildMessagesRequest nunca inclui markAsRead, venha o que vier", () => {
  const entradas = [
    { ticketId: 10 },
    { ticketId: "10", nextId: 5 },
    { ticketId: 10, minUpdatedAt: "2026-09-30T13:00:00.000Z" },
    { ticketId: 10, markAsRead: true, nextId: 0 },
    { ticketId: 10, markAsRead: "true", query: { markAsRead: "true" } }
  ];

  for (const entrada of entradas) {
    const { path, query } = buildMessagesRequest(entrada);
    assert.equal(path, "/messages/10");
    assert.deepEqual(Object.keys(query).sort(), ["minUpdatedAt", "nextId"]);
  }

  assert.throws(() => buildMessagesRequest({ ticketId: "10?markAsRead=true" }), { statusCode: 400 });
  assert.throws(() => buildMessagesRequest({ ticketId: "../tickets" }), { statusCode: 400 });
});

test("listMessages monta a URL so com GET, nextId e minUpdatedAt", async (t) => {
  const chamadas = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    chamadas.push({ url: String(url), method: init?.method });
    return new Response(JSON.stringify({ count: 1, messages: [{ id: "A" }], hasMore: true, nextId: 77 }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const pagina = await listMessages({
    config,
    ticketId: 10,
    nextId: 5,
    minUpdatedAt: "2026-09-30T13:00:00.000Z",
    markAsRead: true
  });
  await listMessages({ config, ticketId: 11 });

  assert.equal(pagina.messages.length, 1);
  assert.equal(pagina.hasMore, true);
  assert.equal(pagina.nextId, 77);

  for (const chamada of chamadas) {
    assert.equal(chamada.method, "GET");
    assert.ok(!/markasread/i.test(chamada.url), chamada.url);
  }
  const primeira = new URL(chamadas[0].url);
  assert.equal(primeira.pathname, "/backend/messages/10");
  assert.equal(primeira.searchParams.get("nextId"), "5");
  assert.equal(primeira.searchParams.get("minUpdatedAt"), "2026-09-30T13:00:00.000Z");
  assert.equal(new URL(chamadas[1].url).search, "");
});
