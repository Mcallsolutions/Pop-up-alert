// Metricas de tempo de resposta (services/attendance-metrics.js).

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSystemAlerts, computeAttendanceMetrics } = require("../src/services/attendance-metrics");

const T0 = Date.parse("2026-09-30T13:00:00.000Z");
const at = (minutes) => new Date(T0 + minutes * 60000).toISOString();
const msg = (senderKind, minutes, extra = {}) => ({ senderKind, createdAt: at(minutes), attendant: "Stephanie", ...extra });

test("bloco de 3 mensagens seguidas do cliente conta do INICIO do bloco", () => {
  const metrics = computeAttendanceMetrics([
    msg("CLIENTE", 0),
    msg("CLIENTE", 2),
    msg("CLIENTE", 5),
    msg("ATENDENTE", 10),
    msg("CLIENTE", 12),
    msg("ATENDENTE", 14)
  ]);

  assert.equal(metrics.primeiraRespostaMinutos, 10);
  assert.equal(metrics.maiorEsperaClienteMinutos, 10);
  assert.equal(metrics.tempoMedioRespostaMinutos, 6);
  assert.equal(metrics.mensagensCliente, 4);
  assert.equal(metrics.mensagensAtendente, 2);
  assert.equal(metrics.duracaoMinutos, 14);
  assert.equal(metrics.clienteAguardandoNoFim, false);
});

test("resposta automatica nao conta como resposta", () => {
  const metrics = computeAttendanceMetrics([
    msg("CLIENTE", 0, { attendant: "" }),
    msg("AUTOMATICA", 0.5, { attendant: "" }),
    msg("EMPRESA", 8)
  ]);

  assert.equal(metrics.primeiraRespostaMinutos, 8);
  assert.equal(metrics.maiorEsperaClienteMinutos, 8);
  assert.equal(metrics.mensagensAutomaticas, 1);
  assert.equal(metrics.mensagensEmpresa, 1);
});

test("conversa terminando com o cliente esperando conta a espera em aberto ate o fim da janela", () => {
  const messages = [msg("CLIENTE", 0), msg("ATENDENTE", 3), msg("CLIENTE", 10), msg("AUTOMATICA", 11), msg("CLIENTE", 12)];

  const semFim = computeAttendanceMetrics(messages);
  assert.equal(semFim.maiorEsperaClienteMinutos, 3, "sem endAt a janela acaba na ultima mensagem (2 min em aberto)");
  assert.equal(semFim.clienteAguardandoNoFim, true);

  const ticketAberto = computeAttendanceMetrics(messages, { endAt: T0 + 40 * 60000 });
  assert.equal(ticketAberto.maiorEsperaClienteMinutos, 30);
  assert.equal(ticketAberto.tempoMedioRespostaMinutos, 16.5);
  assert.equal(ticketAberto.primeiraRespostaMinutos, 3);

  const alerts = buildSystemAlerts(ticketAberto, [], { thresholdMinutes: 15 });
  assert.deepEqual(alerts, [{ tipo: "CLIENTE_AGUARDANDO", minutos: 30, limiteMinutos: 15, emAberto: true }]);
});

test("espera da empresa pelo cliente sai a parte", () => {
  const metrics = computeAttendanceMetrics([msg("CLIENTE", 0), msg("ATENDENTE", 2), msg("ATENDENTE", 5), msg("CLIENTE", 45)]);
  assert.equal(metrics.maiorEsperaAtendenteMinutos, 40);
  assert.equal(metrics.maiorEsperaClienteMinutos, 2);
});

test("transferencia de atendente", () => {
  const semTroca = computeAttendanceMetrics([msg("CLIENTE", 0), msg("ATENDENTE", 1)]);
  assert.equal(semTroca.teveTransferencia, false);

  const comTroca = computeAttendanceMetrics([
    msg("CLIENTE", 0, { attendant: "Stephanie" }),
    msg("ATENDENTE", 1, { attendant: "Stephanie" }),
    msg("CLIENTE", 5, { attendant: "Gabriel Oliveira" }),
    msg("ATENDENTE", 6, { attendant: "Gabriel Oliveira" })
  ]);
  assert.equal(comTroca.teveTransferencia, true);
});

test("sem resposta humana e sem mensagens", () => {
  const soBot = computeAttendanceMetrics([msg("CLIENTE", 0), msg("AUTOMATICA", 1)], { endAt: T0 + 5 * 60000 });
  assert.equal(soBot.primeiraRespostaMinutos, null);
  assert.equal(soBot.maiorEsperaClienteMinutos, 5);

  const vazio = computeAttendanceMetrics([]);
  assert.equal(vazio.duracaoMinutos, 0);
  assert.equal(vazio.tempoMedioRespostaMinutos, null);
});

test("alertas de cancelamento e orgao externo vem das flags, so com ids", () => {
  const alerts = buildSystemAlerts(
    { maiorEsperaClienteMinutos: 5 },
    [
      { id: "A", flags: ["CANCELAMENTO"] },
      { id: "B", flags: [] },
      { id: "C", flags: ["CANCELAMENTO", "ORGAO_EXTERNO"] }
    ],
    { thresholdMinutes: 15 }
  );
  assert.deepEqual(alerts, [
    { tipo: "CANCELAMENTO", mensagens: ["A", "C"] },
    { tipo: "ORGAO_EXTERNO", mensagens: ["C"] }
  ]);
});
