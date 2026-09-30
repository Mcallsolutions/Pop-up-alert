// Traduz uma mensagem da API do MTalk (Ticketz) para uma linha da tabela
// messages, JA MASCARADA.
//
// Mesmo padrao do mtalk.mapper: mtalk.client.js so fala HTTP e aqui fica a
// normalizacao. O texto original nao sai desta funcao — nem no retorno, nem em
// log, nem em erro. Se o mascaramento falhar, a linha sai com
// [MENSAGEM_OCULTA] (falha fechada), nunca com o texto cru.
//
// O que vira cada mensagem:
//   texto                         -> texto mascarado
//   localizacao / link de mapa    -> [LOCALIZACAO] (o body traz nome do lugar,
//                                    endereco e link: descartado inteiro)
//   contato (vCard)               -> [CONTATO] (o body traz telefones)
//   documento                     -> [DOCUMENTO] (nome de arquivo carrega CPF e nome)
//   audio / figurinha             -> [AUDIO] / [FIGURINHA]
//   imagem / video                -> [IMAGEM] / [VIDEO] + legenda mascarada
//   reacao                        -> fica fora da conversa (null)
//
// mediaType chega de dois jeitos: tipo do WhatsApp (conversation,
// locationMessage, ...) ou, em midia, o prefixo do mimetype (image, audio,
// video, application). Os dois sao tratados.

const { foldText, maskText } = require("../pii-mask");
const { normalizeAttendantName } = require("../attendant-filter");
const { toZonedIso } = require("../time-zone");

const MAX_BODY_LENGTH = 4000;
const MAX_ID_LENGTH = 120;
const MAX_MEDIA_TYPE_LENGTH = 40;

// Assinatura do atendente no comeco do body: "*Nome:*\n" (e a variacao
// "*Nome*:\n"). Sai do texto e vira pista de autoria.
const SIGNATURE_RE = /^\*([^*\n]{1,80}?)(?::\*|\*:)[ \t]*\r?\n/;
const MAP_LINK_RE = /maps\.google\.|google\.[a-z.]+\/maps|goo\.gl\/maps|maps\.app\.goo\.gl|waze\.com\/ul|maps\.apple\.com/i;
const VCARD_RE = /ticketzvcard|begin:vcard/i;
const FILE_NAME_RE =
  /^[^\n]{1,160}\.(?:jpe?g|png|gif|webp|heic|bmp|mp4|3gp|mov|avi|mkv|webm|ogg|opus|mp3|m4a|aac|wav|pdf|docx?|xlsx?|pptx?|txt|csv|zip|rar)$/i;

// Sinais por mensagem, sem IA, so nas mensagens do CLIENTE e com o texto sem
// acento e em minusculas. Viram alerta de sistema na analise da conversa.
const FLAG_PATTERNS = [
  [
    "CANCELAMENTO",
    /(?<![a-z])(?:cancel(?:ar|amento|amentos|o|a|e|ei|em|ando)|rescind[a-z]*|rescis[a-z]*|portabilidade|trocar de (?:operadora|provedor|empresa|internet))(?![a-z])/
  ],
  [
    "ORGAO_EXTERNO",
    /(?<![a-z])(?:procon|anatel|reclame ?aqui|consumidor\.gov|advogad[oa]s?|process(?:o|ar|ando|arei)|justica)(?![a-z])/
  ]
];

const MEDIA_MARKERS = {
  localizacao: "[LOCALIZACAO]",
  contato: "[CONTATO]",
  documento: "[DOCUMENTO]",
  audio: "[AUDIO]",
  figurinha: "[FIGURINHA]",
  imagem: "[IMAGEM]",
  video: "[VIDEO]"
};

// timeline: leituras do ticket ({ at: ms, attendant }) em ordem crescente, para
// saber quem estava com o ticket no momento da mensagem.
function mapApiMessage(apiMessage, { ticketId, clientName = "", attendantNames = [], timeline = [], collectedAt } = {}) {
  const id = cleanText(apiMessage?.id, MAX_ID_LENGTH);
  const created = parseDate(apiMessage?.createdAt);
  if (!id || !created) {
    return null;
  }

  // A listagem pode trazer o historico de outros tickets do mesmo contato.
  const ownTicket = String(ticketId ?? "").trim();
  if (apiMessage?.ticketId !== undefined && apiMessage?.ticketId !== null && String(apiMessage.ticketId) !== ownTicket) {
    return null;
  }

  const mediaType = cleanText(apiMessage?.mediaType, MAX_MEDIA_TYPE_LENGTH);
  const fromMe = apiMessage?.fromMe === true || apiMessage?.fromMe === 1 || apiMessage?.fromMe === "true";
  let body = String(apiMessage?.body ?? "").replace(/\r\n/g, "\n");

  const kind = classifyMessage(mediaType, body);
  if (kind === "reacao") {
    return null;
  }

  let signature = "";
  if (fromMe) {
    const match = SIGNATURE_RE.exec(body);
    if (match) {
      signature = match[1].trim();
      body = body.slice(match[0].length);
    }
  }

  const moment = resolveAttendantAt(timeline, created.getTime());
  const senderKind = resolveSenderKind({ fromMe, apiMessage, signature, moment });
  const attendant = normalizeAttendantName(
    moment.attendant || (senderKind === "ATENDENTE" ? signature || cleanText(apiMessage?.user?.name, 100) : "")
  ).slice(0, 100);

  const isDeleted = Boolean(apiMessage?.isDeleted);
  const content = isDeleted
    ? { text: null, found: {}, length: 0, flagSource: "" }
    : buildContent(kind, body, { clientName, attendantNames });
  const updated = parseDate(apiMessage?.updatedAt) || created;

  return {
    id,
    ticketId: ownTicket,
    fromMe: fromMe ? 1 : 0,
    senderKind,
    attendant: attendant || null,
    mediaType: mediaType || null,
    bodyMasked: content.text,
    bodyLength: content.length,
    piiFound: content.found,
    flags: senderKind === "CLIENTE" ? detectFlags(content.flagSource) : [],
    isDeleted: isDeleted ? 1 : 0,
    isEdited: apiMessage?.isEdited ? 1 : 0,
    createdAt: toZonedIso(created),
    updatedAt: toZonedIso(updated),
    collectedAt,
    createdMs: created.getTime(),
    updatedMs: updated.getTime()
  };
}

function classifyMessage(mediaType, body) {
  const type = String(mediaType || "").toLowerCase();

  if (type.startsWith("reaction")) return "reacao";
  if (type === "locationmessage" || type === "livelocationmessage" || /^\s*📍/u.test(body) || MAP_LINK_RE.test(body)) {
    return "localizacao";
  }
  if (type === "contactmessage" || type === "contactsarraymessage" || VCARD_RE.test(body)) return "contato";
  if (type.startsWith("document") || type === "application") return "documento";
  if (type.startsWith("audio") || type === "ptt" || type === "pttmessage") return "audio";
  if (type.startsWith("sticker")) return "figurinha";
  if (type.startsWith("image")) return "imagem";
  if (type.startsWith("video") || type === "ptvmessage") return "video";
  return "texto";
}

// Ordem das regras de autoria:
//   1. fromMe=false -> CLIENTE;
//   2. userId presente (se a instancia mandar) -> ATENDENTE;
//   3. assinatura presente -> ATENDENTE;
//   4. ticket sem atendente no momento (pela leitura mais proxima antes da
//      mensagem) -> AUTOMATICA (bot, fila, saudacao);
//   5. o resto -> EMPRESA: pode ser pessoa ou automatico, e a IA e avisada.
function resolveSenderKind({ fromMe, apiMessage, signature, moment }) {
  if (!fromMe) return "CLIENTE";
  if (hasUserId(apiMessage)) return "ATENDENTE";
  if (signature) return "ATENDENTE";
  if (moment.known && !moment.attendant) return "AUTOMATICA";
  return "EMPRESA";
}

// Quem estava com o ticket quando a mensagem saiu: a leitura mais proxima
// ANTES dela. Sem leitura anterior (a mensagem e mais velha que a primeira
// coleta do ticket), o atendente vem da primeira leitura depois, mas o momento
// fica "desconhecido" — e ai a mensagem nunca e classificada como AUTOMATICA.
function resolveAttendantAt(timeline, createdMs) {
  let known = false;
  let attendant = "";

  for (const reading of Array.isArray(timeline) ? timeline : []) {
    if (reading.at <= createdMs) {
      known = true;
      attendant = reading.attendant || "";
    } else {
      break;
    }
  }

  if (!known && timeline?.length) {
    attendant = timeline[0].attendant || "";
  }

  return { known, attendant };
}

function buildContent(kind, body, maskOptions) {
  if (kind === "localizacao" || kind === "contato") {
    const type = kind === "localizacao" ? "LOCALIZACAO" : "CONTATO";
    return { text: MEDIA_MARKERS[kind], found: { [type]: 1 }, length: 0, flagSource: "" };
  }

  if (kind === "documento" || kind === "audio" || kind === "figurinha") {
    return { text: MEDIA_MARKERS[kind], found: {}, length: 0, flagSource: "" };
  }

  if (kind === "imagem" || kind === "video") {
    // Sem legenda, algumas versoes gravam o nome do arquivo no body.
    const caption = FILE_NAME_RE.test(body.trim()) ? "" : body.trim();
    const masked = caption ? safeMask(caption, maskOptions) : { text: "", found: {} };
    return {
      text: masked.text ? `${MEDIA_MARKERS[kind]} ${masked.text}` : MEDIA_MARKERS[kind],
      found: masked.found,
      length: caption.length,
      flagSource: caption
    };
  }

  const text = body.trim();
  const masked = text ? safeMask(text, maskOptions) : { text: "", found: {} };
  return { text: masked.text, found: masked.found, length: text.length, flagSource: text };
}

// Falha fechada: erro no mascaramento nunca deixa o texto cru passar.
function safeMask(text, { clientName, attendantNames }) {
  try {
    return maskText(text.slice(0, MAX_BODY_LENGTH), { clientName, attendantNames });
  } catch (_error) {
    return { text: "[MENSAGEM_OCULTA]", found: { MENSAGEM_OCULTA: 1 } };
  }
}

function detectFlags(text) {
  if (!text) {
    return [];
  }

  const folded = foldText(String(text).slice(0, MAX_BODY_LENGTH));
  return FLAG_PATTERNS.filter(([, pattern]) => pattern.test(folded)).map(([flag]) => flag);
}

function hasUserId(apiMessage) {
  const value = apiMessage?.userId ?? apiMessage?.user?.id;
  return value !== undefined && value !== null && value !== "" && Number(value) !== 0;
}

function parseDate(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

module.exports = {
  classifyMessage,
  detectFlags,
  mapApiMessage,
  resolveAttendantAt
};
