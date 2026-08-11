const ATTENDANT_ALIASES = new Map([
  ["STEPHANIE", "Stephanie"],
  ["GABRIEL OLIVEIRA", "Gabriel Oliveira"],
  ["GABRIELL CARVALHO", "Gabriell Carvalho"],
  ["GUILHERME GOMES", "Guilherme Gomes"],
  ["LUIS OTAVIO", "Luis otavio"],
  ["ALEK", "Aleksandro"],
  ["ALEKSANDRO", "Aleksandro"]
]);
const COMPANY_PREFIXES = ["NETFIBRA", "MIX", "IDEZ", "TERRA", "PLANET"];
// Tokens de empresa/produto que aparecem colados no nome do atendente
// (ex.: "Luis Otavio0800 TERRANET", "Aleksandro0800 MIXTEL").
const COMPANY_TOKENS = [
  ...COMPANY_PREFIXES,
  "TERRANET",
  "MIXTEL",
  "TELECOM",
  "FIBRA",
  "BDG",
  "AIA",
  "0800"
];
// Linha no formato "<Nome do atendente>0800 <EMPRESA>": e apenas a
// identificacao de quem atende, nao um atendimento/cliente.
const ATTENDANT_COMPANY_LINE = /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ.'\s]{2,60}?)\s*0800\b[\s\-–—_|/]*([A-Za-z0-9][A-Za-z0-9\s._&-]{0,40})?$/u;

function normalizeAttendantName(value) {
  const text = cleanText(value);
  if (!text) {
    return "";
  }

  const key = normalizeKey(text);
  const exact = ATTENDANT_ALIASES.get(key);
  if (exact) {
    return exact;
  }

  for (const [aliasKey, canonical] of ATTENDANT_ALIASES.entries()) {
    if (!key.startsWith(aliasKey)) {
      continue;
    }

    const suffix = key.slice(aliasKey.length).trim();
    if (!suffix || isCompanySuffix(suffix)) {
      return canonical;
    }
  }

  return extractAttendantFromCompanyLine(text) || text;
}

function isKnownAttendant(value) {
  return normalizeAttendantName(value) !== cleanText(value) || ATTENDANT_ALIASES.has(normalizeKey(value));
}

// "0800 TERRANET", "0800MIXTEL", "- MIX" etc. sao sufixos de empresa/fila
// colados no nome do atendente, e nao parte do nome do cliente.
function isCompanySuffix(value) {
  const compact = normalizeKey(value).replace(/[^A-Z0-9]/g, "");
  if (!compact) {
    return false;
  }

  const withoutPhone = compact.replace(/^0800/, "");
  if (compact !== withoutPhone) {
    return true;
  }

  return COMPANY_TOKENS.some((token) => withoutPhone.startsWith(token));
}

// Detecta o padrao "<Atendente>0800 <EMPRESA>" mesmo para atendentes que
// ainda nao estao na lista de aliases.
function looksLikeAttendantCompanyLine(value) {
  return Boolean(extractAttendantFromCompanyLine(value));
}

function extractAttendantFromCompanyLine(value) {
  const text = cleanText(value);
  const match = text.match(ATTENDANT_COMPANY_LINE);
  if (!match) {
    return "";
  }

  const name = cleanText(match[1]).replace(/[-–—_|/,.]+$/g, "");
  const company = cleanText(match[2]);
  if (!name || name.split(/\s+/).filter(Boolean).length > 4 || !/[A-Za-zÀ-ÿ]{3,}/.test(name)) {
    return "";
  }
  if (company && !isCompanySuffix(company)) {
    return "";
  }

  return ATTENDANT_ALIASES.get(normalizeKey(name)) || name;
}

function getKnownAttendants() {
  return Array.from(new Set(ATTENDANT_ALIASES.values()));
}

// Descarta nomes de "cliente" que na verdade sao atendente, empresa ou rotulo
// da tela do MTalk. Usado na gravacao do snapshot e de novo na leitura dos
// relatorios, para que dados antigos tambem saiam limpos.
function sanitizeClientName(value) {
  const text = cleanText(value);
  if (!text) return "";
  if (isKnownAttendant(text)) return "";
  if (looksLikeAttendantCompanyLine(text)) return "";
  if (/^Suporte\s*-/i.test(text)) return "";
  if (new RegExp(`^(${COMPANY_PREFIXES.join("|")})\\b`, "i").test(text)) return "";
  if (/^(All|Aberto|Fechado|Pendente|Resolvido|Atendente|Cliente|Fila|Tags?|N[aãÃ]o identificado|Cliente n[aãÃ]o identificado)$/i.test(text)) {
    return "";
  }
  // Frase corrida (pontuacao ou varias palavras minusculas) e mensagem do
  // ticket, nao nome de cliente — que no MTalk vem em caixa alta.
  if (/[.!?]/.test(text) && calculateUppercaseRatio(text) < 0.7) return "";
  if (/[a-z]{2,}\s+[a-z]{2,}/.test(text) && calculateUppercaseRatio(text) < 0.55) return "";
  return text;
}

function calculateUppercaseRatio(text) {
  const letters = Array.from(String(text || "")).filter((char) => /[A-Za-z]/.test(char));
  if (!letters.length) return 0;
  const upper = letters.filter((char) => char === char.toUpperCase() && char !== char.toLowerCase()).length;
  return upper / letters.length;
}

function normalizeKey(value) {
  return cleanText(value)
    .replace(/[.,;:]+$/g, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = {
  getKnownAttendants,
  isKnownAttendant,
  normalizeAttendantName,
  sanitizeClientName
};
