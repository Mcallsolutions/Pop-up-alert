// Normalizacao das mensagens do MTalk (services/mtalk/mtalk.messages.js):
// autoria, assinatura, midias, sinais e mascaramento na entrada.
// So dados ficticios.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAnalysisScope, isWithinAnalysisScope, mapApiMessage } = require("../src/services/mtalk/mtalk.messages");

const T0 = Date.parse("2026-09-30T13:00:00.000Z");
const minutes = (value) => new Date(T0 + value * 60000).toISOString();

function message(overrides = {}) {
  return {
    id: "MSG1",
    ticketId: 900,
    fromMe: false,
    body: "ola",
    mediaType: "conversation",
    isDeleted: false,
    isEdited: false,
    createdAt: minutes(10),
    updatedAt: minutes(10),
    ...overrides
  };
}

function map(overrides, options = {}) {
  return mapApiMessage(message(overrides), {
    ticketId: "900",
    clientName: "Joana Ficticia",
    attendantNames: [],
    timeline: [{ at: T0, attendant: "Stephanie" }],
    collectedAt: "2026-09-30T10:20:00-03:00",
    ...options
  });
}

test("mensagem do cliente e mascarada na entrada e so a contagem fica", () => {
  const row = map({ body: "Oi, aqui e a Joana, meu cpf e 123.456.789-09" });
  assert.equal(row.senderKind, "CLIENTE");
  assert.equal(row.bodyMasked, "Oi, aqui e a [CLIENTE], meu cpf e [CPF]");
  assert.deepEqual(row.piiFound, { CPF: 1, CLIENTE: 1 });
  assert.equal(row.fromMe, 0);
  assert.equal(row.attendant, "Stephanie");
});

test("assinatura sai do texto e marca a mensagem como do atendente", () => {
  const row = map({ fromMe: true, body: "*Alek NETFIBRA:*\nBoa tarde, vou verificar" }, { timeline: [] });
  assert.equal(row.senderKind, "ATENDENTE");
  assert.equal(row.bodyMasked, "Boa tarde, vou verificar");
  assert.equal(row.attendant, "Aleksandro", "atendente sempre canonico");

  const variacao = map({ fromMe: true, body: "*Stephanie*:\nOk" });
  assert.equal(variacao.senderKind, "ATENDENTE");
  assert.equal(variacao.bodyMasked, "Ok");
});

test("userId presente (quando a instancia manda) e atendente", () => {
  assert.equal(map({ fromMe: true, userId: 157, body: "Pronto" }).senderKind, "ATENDENTE");
  assert.equal(map({ fromMe: true, userId: null, body: "Pronto" }).senderKind, "EMPRESA");
});

test("sem assinatura: ticket sem atendente no momento e automatica; com atendente, EMPRESA", () => {
  const semAtendente = map(
    { fromMe: true, body: "Digite 1 para suporte" },
    { timeline: [{ at: T0, attendant: "" }, { at: T0 + 30 * 60000, attendant: "Stephanie" }] }
  );
  assert.equal(semAtendente.senderKind, "AUTOMATICA");

  const comAtendente = map({ fromMe: true, body: "Obrigado pelo contato" });
  assert.equal(comAtendente.senderKind, "EMPRESA");

  // Mensagem mais velha que a primeira leitura: momento desconhecido nunca vira AUTOMATICA.
  const antesDaColeta = map({ fromMe: true, body: "Bem-vindo", createdAt: minutes(-60) }, { timeline: [{ at: T0, attendant: "" }] });
  assert.equal(antesDaColeta.senderKind, "EMPRESA");
});

test("atendente vem da leitura mais proxima ANTES da mensagem (transferencia)", () => {
  const timeline = [
    { at: T0, attendant: "Stephanie" },
    { at: T0 + 20 * 60000, attendant: "Gabriel Oliveira" }
  ];
  assert.equal(map({ createdAt: minutes(10) }, { timeline }).attendant, "Stephanie");
  assert.equal(map({ createdAt: minutes(25) }, { timeline }).attendant, "Gabriel Oliveira");
});

test("localizacao e contato sao descartados inteiros, nem mascarados", () => {
  const local = map({
    mediaType: "locationMessage",
    body: "📍\n*Padaria Inventada*\n_Rua Ficticia 99_\nhttps://maps.google.com/maps?q=-3.73,-38.52"
  });
  assert.equal(local.bodyMasked, "[LOCALIZACAO]");
  assert.deepEqual(local.piiFound, { LOCALIZACAO: 1 });
  assert.equal(local.bodyLength, 0);

  assert.equal(map({ mediaType: "conversation", body: "📍\n*Lugar*\n_Endereco_" }).bodyMasked, "[LOCALIZACAO]");
  assert.equal(map({ body: "to aqui https://maps.app.goo.gl/abc123" }).bodyMasked, "[LOCALIZACAO]");

  const contato = map({ mediaType: "contactMessage", body: '{"ticketzvCard":[{"name":"Fulano","number":"5585988887777"}]}' });
  assert.equal(contato.bodyMasked, "[CONTATO]");
  assert.equal(map({ mediaType: "conversation", body: "BEGIN:VCARD\nTEL:85988887777\nEND:VCARD" }).bodyMasked, "[CONTATO]");
});

test("midias: os dois formatos de mediaType", () => {
  assert.equal(map({ mediaType: "documentMessage", body: "cpf-12345678909-joana.pdf" }).bodyMasked, "[DOCUMENTO]");
  assert.equal(map({ mediaType: "application", body: "contrato joana.pdf" }).bodyMasked, "[DOCUMENTO]");
  assert.equal(map({ mediaType: "audioMessage", body: "" }).bodyMasked, "[AUDIO]");
  assert.equal(map({ mediaType: "audio", body: "audio.ogg" }).bodyMasked, "[AUDIO]");
  assert.equal(map({ mediaType: "stickerMessage", body: "" }).bodyMasked, "[FIGURINHA]");
  assert.equal(map({ mediaType: "image", body: "IMG-20260930-WA0001.jpg" }).bodyMasked, "[IMAGEM]");
  assert.equal(map({ mediaType: "imageMessage", body: "foto do roteador, liga 85 98888-7777" }).bodyMasked, "[IMAGEM] foto do roteador, liga [TELEFONE]");
  assert.equal(map({ mediaType: "video", body: "" }).bodyMasked, "[VIDEO]");
});

test("reacao, historico de outro ticket e mensagem sem data ficam de fora", () => {
  assert.equal(map({ mediaType: "reactionMessage", body: "👍" }), null);
  assert.equal(map({ ticketId: 899 }), null);
  assert.equal(map({ createdAt: null }), null);
});

test("mensagem apagada fica sem texto", () => {
  const row = map({ isDeleted: true, body: "meu cpf e 123.456.789-09" });
  assert.equal(row.bodyMasked, null);
  assert.deepEqual(row.piiFound, {});
  assert.deepEqual(row.flags, []);
  assert.equal(row.isDeleted, 1);
});

test("sinais de cancelamento e orgao externo so nas mensagens do cliente", () => {
  assert.deepEqual(map({ body: "Quero CANCELAR, vou no Procon" }).flags, ["CANCELAMENTO", "ORGAO_EXTERNO"]);
  assert.deepEqual(map({ body: "vou pedir portabilidade" }).flags, ["CANCELAMENTO"]);
  assert.deepEqual(map({ body: "vou falar com meu advogado" }).flags, ["ORGAO_EXTERNO"]);
  assert.deepEqual(map({ fromMe: true, body: "*Stephanie:*\nposso cancelar a visita?" }).flags, []);
  assert.deepEqual(map({ body: "obrigado, resolveu" }).flags, []);
});

test("falha fechada: erro no mascaramento grava [MENSAGEM_OCULTA], nunca o texto", () => {
  const explode = { toString() { throw new Error("falha simulada"); } };
  const row = map({ body: "meu cpf e 123.456.789-09" }, { attendantNames: [explode] });
  assert.equal(row.bodyMasked, "[MENSAGEM_OCULTA]");
  assert.deepEqual(row.piiFound, { MENSAGEM_OCULTA: 1 });
});

// ---------------------------------------------------------------------------
// Recorte da analise: so trechos com atendente vinculado em fila monitorada.

const MIN = 60000;
const SCOPE = createAnalysisScope({
  attendants: ["Stephanie", "aleksandro"],
  queueIds: [7],
  readingValidityMs: 3 * MIN
});
// Pendente na fila ate o minuto 10; Stephanie do 10 ao 30; Paula (sem token) do
// 32 ao 40; ticket fora da listagem do 40 ao 60; Stephanie de novo do 60 ao 70.
const TIMELINE = [
  { at: T0, until: T0 + 9 * MIN, attendant: "", queue: "Suporte-MIX" },
  { at: T0 + 10 * MIN, until: T0 + 30 * MIN, attendant: "Stephanie", queue: "Suporte-MIX" },
  { at: T0 + 32 * MIN, until: T0 + 40 * MIN, attendant: "Paula Andrade", queue: "Suporte-MIX" },
  { at: T0 + 60 * MIN, until: T0 + 70 * MIN, attendant: "Stephanie", queue: "Suporte-MIX" }
];

function inScope(overrides, { timeline = TIMELINE, scope = SCOPE } = {}) {
  return isWithinAnalysisScope(message(overrides), { timeline, scope });
}

test("recorte: cliente e empresa entram no trecho do atendente vinculado", () => {
  assert.equal(inScope({ createdAt: minutes(15) }), true);
  assert.equal(inScope({ createdAt: minutes(16), fromMe: true, body: "*Stephanie:*\nVou verificar" }), true);
  assert.equal(inScope({ createdAt: minutes(17), fromMe: true, body: "Obrigado pelo contato" }), true, "sem assinatura, vale o trecho");
  assert.equal(inScope({ createdAt: minutes(65) }), true, "o atendente voltou ao ticket");
});

test("recorte: bot e fila de espera ficam de fora; assinatura de vinculado supre trecho sem atendente", () => {
  assert.equal(inScope({ createdAt: minutes(5) }), false, "cliente aguardando na fila");
  assert.equal(inScope({ createdAt: minutes(6), fromMe: true, body: "Digite 1 para suporte" }), false, "bot");
  assert.equal(
    inScope({ createdAt: minutes(9.5), fromMe: true, body: "*Stephanie:*\nBoa tarde, aqui e a Stephanie" }),
    true,
    "aceitou entre duas coletas"
  );
  assert.equal(inScope({ createdAt: minutes(8), fromMe: true, body: "*Paula Andrade:*\nOi" }), false);
});

test("recorte: atendente sem token fica de fora, inclusive o cliente no trecho dele", () => {
  assert.equal(inScope({ createdAt: minutes(35) }), false);
  assert.equal(inScope({ createdAt: minutes(36), fromMe: true, body: "*Paula Andrade:*\nOla" }), false);
  assert.equal(
    inScope({ createdAt: minutes(37), fromMe: true, body: "*Stephanie:*\nAjudando a colega" }),
    false,
    "assinatura nao toma o trecho de outra pessoa"
  );
  assert.equal(
    inScope({ createdAt: minutes(20), fromMe: true, body: "*Paula Andrade:*\nEntrei na conversa" }),
    false,
    "quem assina sem token fica de fora mesmo no trecho de um vinculado"
  );
});

test("recorte: nome do token vale pelo canonico, sem diferenca de maiusculas", () => {
  const timeline = [{ at: T0, until: T0 + 30 * MIN, attendant: "Aleksandro", queue: "Suporte-IDEZ" }];
  assert.equal(inScope({ createdAt: minutes(5), fromMe: true, body: "*Alek NETFIBRA:*\nOi" }, { timeline }), true);
  assert.equal(inScope({ createdAt: minutes(6) }, { timeline }), true);
});

test("recorte: sem leitura antes, ou longe demais da ultima, fica de fora", () => {
  assert.equal(inScope({ createdAt: minutes(-5) }), false, "mais velha que a primeira leitura");
  assert.equal(inScope({ createdAt: minutes(32.5) }, { timeline: TIMELINE.slice(0, 2) }), true, "ate 3 min depois da ultima leitura");
  assert.equal(inScope({ createdAt: minutes(45) }), false, "ticket fora da listagem (fechado ou em outra fila)");
  assert.equal(inScope({ createdAt: minutes(15) }, { timeline: [] }), false);
  assert.equal(isWithinAnalysisScope(message({ createdAt: minutes(15) }), { timeline: TIMELINE }), false, "sem scope, nada entra");
});

test("recorte: a fila da propria mensagem pega a transferencia entre coletas", () => {
  assert.equal(inScope({ createdAt: minutes(15), queueId: 7 }), true);
  assert.equal(inScope({ createdAt: minutes(15), queueId: 99 }), false, "outra fila");
  assert.equal(inScope({ createdAt: minutes(15), queue: { id: 99, name: "Financeiro" } }), false);
  assert.equal(inScope({ createdAt: minutes(15), queue: { id: 99, name: "Suporte - TERRANET" } }), true, "o nome decide");
  assert.equal(inScope({ createdAt: minutes(15), queueId: null }), true, "fila nula nao exclui: vale a leitura");

  const semIds = createAnalysisScope({ attendants: ["Stephanie"], queueIds: [], readingValidityMs: 3 * MIN });
  assert.equal(inScope({ createdAt: minutes(15), queueId: 99 }, { scope: semIds }), true, "sem a lista de filas, vale a leitura");

  const outraFila = [{ at: T0, until: T0 + 30 * MIN, attendant: "Stephanie", queue: "Comercial" }];
  assert.equal(inScope({ createdAt: minutes(15) }, { timeline: outraFila }), false, "trecho fora das filas monitoradas");
});

test("recorte: sem nenhum atendente vinculado, nada entra", () => {
  const vazio = createAnalysisScope({ attendants: [], queueIds: [7], readingValidityMs: 3 * MIN });
  assert.equal(inScope({ createdAt: minutes(15) }, { scope: vazio }), false);
  assert.equal(inScope({ createdAt: minutes(5), fromMe: true, body: "*Stephanie:*\nOi" }, { scope: vazio }), false);
});
