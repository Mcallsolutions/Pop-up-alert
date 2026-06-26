const ATTENDANT_ALIASES = new Map([
  ["STEPHANIE", "Stephanie"],
  ["GABRIEL OLIVEIRA", "Gabriel Oliveira"],
  ["GABRIELL CARVALHO", "Gabriell Carvalho"],
  ["GUILHERME GOMES", "Guilherme Gomes"],
  ["LUIS", "Luis"]
]);
const COMPANY_PREFIXES = ["NETFIBRA", "MIX", "IDEZ", "TERRA", "PLANET"];

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
    if (!suffix || COMPANY_PREFIXES.some((prefix) => suffix.startsWith(prefix))) {
      return canonical;
    }
  }

  return text;
}

function isKnownAttendant(value) {
  return normalizeAttendantName(value) !== cleanText(value) || ATTENDANT_ALIASES.has(normalizeKey(value));
}

function getKnownAttendants() {
  return Array.from(ATTENDANT_ALIASES.values());
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
  normalizeAttendantName
};
