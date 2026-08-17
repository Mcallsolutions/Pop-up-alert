// Traduz um ticket da API oficial do MTalk para o formato interno de snapshot.
//
// A API entrega os campos ja separados (contact, queue, user, whatsapp, tags),
// entao aqui nao ha heuristica de leitura de tela: so normalizacao dos mesmos
// parametros que o projeto ja monitorava — filas, atendentes, empresas, tags e
// o tempo de inatividade.

const { normalizeQueueName } = require("../queue-filter");
const { normalizeAttendantName } = require("../attendant-filter");
const { EMPTY_CATALOG, collectTicketTagNames } = require("./mtalk.tags");

// A API devolve datas em UTC (ISO 8601) e o painel do MTalk mostra em BRT.
const DISPLAY_TIME_ZONE = "America/Sao_Paulo";
const MAX_INACTIVITY_MINUTES = 24 * 60;

const displayTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: DISPLAY_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

// Devolve null quando o ticket esta fora das filas monitoradas.
//
// tagCatalog e contactTags vem do coletor: o catalogo de /tags/list resolve os
// vinculos que chegam so com o id, e contactTags carrega as TAGs do cliente
// quando a listagem de tickets nao as devolveu.
function mapApiTicket(apiTicket, { now = new Date(), tagCatalog = EMPTY_CATALOG, contactTags = [] } = {}) {
  const queue = normalizeQueueName(apiTicket?.queue?.name || "");
  if (!queue) {
    return null;
  }

  const externalTicketId = cleanText(apiTicket?.id, 40);
  if (!externalTicketId) {
    return null;
  }

  // TAG do atendimento E TAG do cliente: as duas tiram o ticket do alerta.
  const tags = collectTicketTagNames(apiTicket, tagCatalog, contactTags);
  const lastActivityAt = parseDate(apiTicket?.updatedAt) || parseDate(apiTicket?.createdAt);

  return {
    // O id do ticket e estavel entre leituras: substitui a chave montada a
    // partir de cliente/fila/horario que a leitura de tela precisava usar.
    ticketKey: `mtalk:${externalTicketId}`,
    externalTicketId,
    ticketUuid: cleanText(apiTicket?.uuid, 60),
    ticketStatus: cleanText(apiTicket?.status, 20).toLowerCase(),
    clientName: cleanText(apiTicket?.contact?.name, 160),
    queue,
    attendant: cleanAttendant(apiTicket?.user?.name),
    company: cleanText(apiTicket?.whatsapp?.name, 120),
    displayTime: formatDisplayTime(lastActivityAt),
    lastMessageAt: lastActivityAt ? lastActivityAt.toISOString() : "",
    inactivityMinutes: calculateInactivityMinutes(lastActivityAt, now),
    unreadMessages: cleanNonNegativeInteger(apiTicket?.unreadMessages),
    tag: tags[0] || null,
    tags,
    tagStatus: tags.length ? "COM_TAG" : "SEM_TAG"
  };
}

// Um ticket aberto e um ticket pendente podem voltar nas duas consultas de
// status; o id resolve a duplicidade sem depender de nome nem de horario.
function dedupeApiTickets(apiTickets) {
  const seen = new Set();
  return apiTickets.filter((apiTicket) => {
    const id = cleanText(apiTicket?.id, 40);
    if (!id || seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

// O nome vem do cadastro do usuario, entao nao ha lixo de tela para descartar:
// a normalizacao serve so para unificar as variacoes ja conhecidas
// ("Alek", "Alek NETFIBRA" -> "Aleksandro").
function cleanAttendant(value) {
  const text = cleanText(value, 100);
  return text ? normalizeAttendantName(text).slice(0, 100) : "";
}

function calculateInactivityMinutes(lastActivityAt, now) {
  if (!lastActivityAt) {
    return null;
  }

  const diffMinutes = Math.floor((now.getTime() - lastActivityAt.getTime()) / 60000);
  if (!Number.isFinite(diffMinutes) || diffMinutes < 0) {
    return 0;
  }

  return Math.min(diffMinutes, MAX_INACTIVITY_MINUTES);
}

function formatDisplayTime(date) {
  return date ? displayTimeFormatter.format(date) : "";
}

function parseDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cleanNonNegativeInteger(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

module.exports = {
  DISPLAY_TIME_ZONE,
  dedupeApiTickets,
  mapApiTicket
};
