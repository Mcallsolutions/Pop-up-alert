// Unifica as variacoes de nome do mesmo atendente no cadastro de usuarios do
// MTalk ("Alek", "Alek NETFIBRA" -> "Aleksandro"). Nome fora da tabela passa
// direto: user.name ja e o cadastro oficial.
const ATTENDANT_ALIASES = new Map([
  ["STEPHANIE", "Stephanie"],
  ["GABRIEL OLIVEIRA", "Gabriel Oliveira"],
  ["GABRIELL CARVALHO", "Gabriell Carvalho"],
  ["GUILHERME GOMES", "Guilherme Gomes"],
  ["LUIS OTAVIO", "Luis otavio"],
  ["ALEK", "Aleksandro"],
  ["ALEKSANDRO", "Aleksandro"]
]);
// Unicos atendentes levados ao sistema (nomes canonicos de ATTENDANT_ALIASES),
// alem dos tickets sem atendente. O que e de qualquer outra pessoa nem chega a
// ser gravado: ver isMonitoredAttendant.
const MONITORED_ATTENDANTS = ["Guilherme Gomes", "Gabriell Carvalho", "Luis otavio", "Stephanie", "Aleksandro"];
const MONITORED_KEYS = new Set(MONITORED_ATTENDANTS.map((name) => name.toUpperCase()));
// Sufixos de empresa/conexao que alguns cadastros levam junto do nome.
const COMPANY_TOKENS = ["NETFIBRA", "MIX", "IDEZ", "TERRA", "TERRANET", "MIXTEL", "TELECOM", "BDG", "AIA"];

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
    if (key.startsWith(aliasKey) && isCompanySuffix(key.slice(aliasKey.length))) {
      return canonical;
    }
  }

  return text;
}

// Chave para comparar o mesmo atendente vindo de lugares diferentes (token,
// leitura de tickets, assinatura da mensagem): canonico e em maiusculas, como o
// recorte dos alertas (scopeTickets no coletor).
function attendantKey(value) {
  return normalizeAttendantName(value).toUpperCase();
}

// Ticket sem atendente (aguardando na fila) sempre entra: ninguem e dono dele.
// Com atendente, so os de MONITORED_ATTENDANTS (apelidos viram o nome canonico).
function isMonitoredAttendant(value) {
  const key = attendantKey(value);
  return !key || MONITORED_KEYS.has(key);
}

function listMonitoredAttendants() {
  return [...MONITORED_ATTENDANTS];
}

// Nomes conhecidos (canonicos e apelidos). O mascaramento de mensagens
// (pii-mask.js) troca qualquer um deles por [ATENDENTE].
function listKnownAttendantNames() {
  return [...new Set([...ATTENDANT_ALIASES.keys(), ...ATTENDANT_ALIASES.values()])];
}

// Sufixos de empresa nao sao nome de pessoa: o mascaramento nao pode trocar
// "MIX" por [ATENDENTE] so porque um cadastro se chama "Alek MIX".
function listCompanyTokens() {
  return [...COMPANY_TOKENS];
}

function isCompanySuffix(value) {
  const compact = String(value || "").replace(/[^A-Z0-9]/g, "");
  return Boolean(compact) && COMPANY_TOKENS.some((token) => compact.startsWith(token));
}

function normalizeKey(value) {
  return cleanText(value)
    .replace(/[.,;:]+$/g, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = {
  attendantKey,
  isMonitoredAttendant,
  listCompanyTokens,
  listMonitoredAttendants,
  listKnownAttendantNames,
  normalizeAttendantName
};
