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
//
// Antes de mapear, a leitura passa cada mensagem por isWithinAnalysisScope: a
// IA so le os trechos com atendente vinculado em fila monitorada.

const { foldText, maskText } = require("../pii-mask");
const { attendantKey, normalizeAttendantName } = require("../attendant-filter");
const { normalizeQueueName } = require("../queue-filter");
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

// timeline: trechos do ticket tirados das leituras ({ at, until, attendant,
// queue }, em ms e em ordem crescente: de at ate until o ticket esteve com
// aquele atendente naquela fila), para saber quem estava com o ticket no
// momento da mensagem.
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
  const fromMe = isFromMe(apiMessage);
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

// Quem estava com o ticket quando a mensagem saiu: o trecho que comecou mais
// perto ANTES dela. Sem trecho anterior (a mensagem e mais velha que a primeira
// coleta do ticket), o atendente vem do primeiro trecho depois, mas o momento
// fica "desconhecido" — e ai a mensagem nunca e classificada como AUTOMATICA.
function resolveAttendantAt(timeline, createdMs) {
  let reading = null;

  for (const entry of Array.isArray(timeline) ? timeline : []) {
    if (entry.at <= createdMs) {
      reading = entry;
    } else {
      break;
    }
  }

  if (!reading) {
    return { known: false, attendant: timeline?.[0]?.attendant || "", queue: "", until: null };
  }
  return { known: true, attendant: reading.attendant || "", queue: reading.queue || "", until: reading.until ?? reading.at };
}

// Recorte da analise por IA. scope vem de createAnalysisScope. Entra a mensagem
// (do cliente ou da empresa) enviada enquanto o ticket estava numa fila
// monitorada com um atendente vinculado. Na duvida, fica de fora:
//   1. precisa haver um trecho antes da mensagem, e ela nao pode ter saido mais
//      de readingValidityMs depois da ultima leitura dele — passando disso o
//      ticket tinha saido da listagem (fechado ou em outra fila);
//   2. o trecho precisa ser de fila monitorada;
//   3. a fila da propria mensagem (queueId/queue, quando a instancia manda)
//      pega a transferencia que aconteceu entre duas coletas. Fila ausente ou
//      nula nao exclui: vale a do trecho;
//   4. mensagem assinada precisa ser de atendente vinculado. Sem assinatura, o
//      atendente do trecho precisa ser vinculado — bot e fila de espera ficam
//      de fora. A assinatura de um vinculado so supre trecho SEM atendente (ele
//      aceitou o ticket entre duas coletas), nunca o de outra pessoa.
function isWithinAnalysisScope(apiMessage, { timeline = [], scope } = {}) {
  const created = parseDate(apiMessage?.createdAt);
  if (!created || !scope) {
    return false;
  }

  const moment = resolveAttendantAt(timeline, created.getTime());
  if (!moment.known || created.getTime() - moment.until > scope.readingValidityMs) {
    return false;
  }
  if (!normalizeQueueName(moment.queue) || !isMessageQueueAllowed(apiMessage, scope.queueIds)) {
    return false;
  }

  const author = signatureAuthor(apiMessage);
  if (author) {
    return scope.isLinked(author) && (!moment.attendant || scope.isLinked(moment.attendant));
  }
  return scope.isLinked(moment.attendant);
}

// attendants: nomes dos tokens ATENDENTE ativos. queueIds: ids das filas
// monitoradas no MTalk (vazio quando a coleta nao conseguiu listar as filas).
function createAnalysisScope({ attendants = [], queueIds = [], readingValidityMs }) {
  const keys = new Set(attendants.map(attendantKey).filter(Boolean));
  return {
    attendants: [...attendants],
    queueIds: new Set([...queueIds].map(Number).filter(Number.isFinite)),
    readingValidityMs,
    isLinked: (name) => keys.has(attendantKey(name))
  };
}

function isMessageQueueAllowed(apiMessage, queueIds) {
  const name = cleanText(apiMessage?.queue?.name, 120);
  if (name) {
    return Boolean(normalizeQueueName(name));
  }

  const id = apiMessage?.queueId ?? apiMessage?.queue?.id;
  if (id === undefined || id === null || id === "" || !queueIds?.size) {
    return true;
  }
  return queueIds.has(Number(id));
}

function signatureAuthor(apiMessage) {
  if (!isFromMe(apiMessage)) {
    return "";
  }
  const match = SIGNATURE_RE.exec(String(apiMessage?.body ?? "").replace(/\r\n/g, "\n"));
  return match ? match[1].trim() : "";
}

function isFromMe(apiMessage) {
  return apiMessage?.fromMe === true || apiMessage?.fromMe === 1 || apiMessage?.fromMe === "true";
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
  createAnalysisScope,
  detectFlags,
  isWithinAnalysisScope,
  mapApiMessage,
  resolveAttendantAt
};
