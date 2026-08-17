// Identificacao das TAGs pela API oficial do MTalk (Ticketz).
//
// Uma TAG pode chegar em DOIS lugares diferentes na resposta de
// GET /backend/tickets:
//   - ticket.tags[]         -> TAG marcada no proprio atendimento;
//   - ticket.contact.tags[] -> TAG marcada no CLIENTE (contato).
// O painel do MTalk mostra as duas no mesmo campo, entao para o atendente e
// tudo "a TAG do cliente". Ler apenas a primeira era o que mantinha o ticket na
// lista de alerta mesmo depois de o atendente vincular a TAG ao contato.
//
// O catalogo oficial (GET /backend/tags/list) entra por dois motivos: resolve o
// vinculo que vem so com o id da TAG (sem o nome junto) e descarta id de TAG que
// nao existe mais no cadastro.

const MAX_TAGS_PER_TICKET = 10;
const MAX_TAG_NAME = 120;

// Catalogo vazio = "nao foi possivel ler /tags/list". Nesse estado um vinculo
// que veio so com id ainda conta como TAG (ver resolveTagName): presenca de
// vinculo e o que decide o alerta, o nome e so para exibir.
const EMPTY_CATALOG = { byId: new Map(), names: [], loaded: false };

function buildTagCatalog(rawTags) {
  const byId = new Map();
  const names = [];

  for (const raw of toArray(rawTags)) {
    const id = toId(raw?.id);
    const name = cleanText(raw?.name, MAX_TAG_NAME);
    if (!id || !name || byId.has(id)) {
      continue;
    }
    byId.set(id, name);
    names.push(name);
  }

  return { byId, names, loaded: byId.size > 0 };
}

// Todas as TAGs do ticket, do atendimento e do contato, sem repetir.
// extraTags recebe o que veio de uma consulta separada ao contato, quando a
// listagem de tickets nao trouxe esse campo.
function collectTicketTagNames(apiTicket, catalog = EMPTY_CATALOG, extraTags = []) {
  const sources = [apiTicket?.tags, apiTicket?.contact?.tags, apiTicket?.contact?.contactTags, extraTags];
  const names = [];

  for (const source of sources) {
    for (const value of toArray(source)) {
      const name = resolveTagName(value, catalog);
      if (name && !names.includes(name)) {
        names.push(name);
      }
      if (names.length >= MAX_TAGS_PER_TICKET) {
        return names;
      }
    }
  }

  return names;
}

// Nem toda instancia devolve as TAGs do contato dentro da listagem de tickets.
// Quando o campo vem AUSENTE (diferente de vir como lista vazia), so uma
// consulta ao contato responde se o cliente ja foi marcado ou nao.
function contactIdForTagLookup(apiTicket) {
  const contact = apiTicket?.contact;
  if (Array.isArray(contact?.tags) || Array.isArray(contact?.contactTags)) {
    return null;
  }

  return toId(contact?.id ?? apiTicket?.contactId);
}

// Valores crus de TAG de um cadastro de contato (GET /backend/contacts/{id}).
// A resolucao para nome fica com collectTicketTagNames, que ja conhece todos os
// formatos que o MTalk usa.
function contactTagValues(contact) {
  const values = Array.isArray(contact?.tags) ? contact.tags : contact?.contactTags;
  return toArray(values);
}

// Formatos aceitos, todos vistos na API: "Nome", { id, name }, { tagId, tag },
// e o id puro (numero ou texto). Em linha de vinculo (ContactTag) o "id" e o da
// LINHA, nao o da TAG — por isso tagId/tag.id vem antes.
function resolveTagName(value, catalog = EMPTY_CATALOG) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "number") {
    return resolveTagId(value, catalog);
  }

  if (typeof value === "string") {
    const text = cleanText(value, MAX_TAG_NAME);
    if (!text) {
      return "";
    }
    return /^\d+$/.test(text) ? resolveTagId(Number(text), catalog) : text;
  }

  if (typeof value === "object") {
    const name = cleanText(value.name ?? value.tag?.name ?? value.tagName, MAX_TAG_NAME);
    if (name) {
      return name;
    }
    const id = toId(value.tagId ?? value.tag?.id ?? value.id);
    return id ? resolveTagId(id, catalog) : "";
  }

  return "";
}

function resolveTagId(id, catalog) {
  const tagId = toId(id);
  if (!tagId) {
    return "";
  }

  const name = catalog?.byId?.get(tagId);
  if (name) {
    return name;
  }

  // Com o catalogo carregado, id desconhecido e vinculo orfao: descarta.
  // Sem catalogo, o vinculo continua valendo — so nao da para nomear a TAG.
  return catalog?.loaded ? "" : `TAG ${tagId}`;
}

function toId(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

module.exports = {
  EMPTY_CATALOG,
  MAX_TAGS_PER_TICKET,
  buildTagCatalog,
  collectTicketTagNames,
  contactIdForTagLookup,
  contactTagValues
};
