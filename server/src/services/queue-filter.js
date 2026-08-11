const ALLOWED_QUEUE_CODES = new Set(["TERRANET", "PLANET", "MIX", "IDEZ", "BDG", "AIA"]);
const ALLOWED_QUEUE_LABELS = {
  TERRANET: "TerraNet",
  PLANET: "PLANET",
  MIX: "MIX",
  IDEZ: "IDEZ",
  BDG: "BDG",
  AIA: "AIA"
};

function normalizeQueueName(value) {
  const text = cleanText(value);
  const match = text.match(/Suporte\s*-\s*([A-Za-z0-9_-]+)/i);
  if (!match) {
    return "";
  }

  const code = normalizeQueueCode(match[1]);
  if (!ALLOWED_QUEUE_CODES.has(code)) {
    return "";
  }

  return `Suporte-${ALLOWED_QUEUE_LABELS[code]}`;
}

function getAllowedQueues() {
  return Array.from(ALLOWED_QUEUE_CODES).map((code) => `Suporte-${ALLOWED_QUEUE_LABELS[code]}`);
}

function normalizeQueueCode(value) {
  return cleanText(value).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = {
  getAllowedQueues,
  normalizeQueueName
};
