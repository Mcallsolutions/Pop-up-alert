// Tokens da extensao (pop-up): identificam o atendente para recortar os
// alertas. O painel de administracao NAO usa estes tokens — ele entra com
// usuario e senha (admin-auth.service).
//
// Nao confundir com o MTALK_TOKEN: aquele e unico, fica no .env e e o que a
// coleta usa para ler os tickets no MTalk. O token daqui e emitido por voce,
// identifica uma pessoa e serve so para recortar o que ela le do que ja foi
// coletado — a coleta continua igual, com o mesmo custo.
//
// O banco guarda apenas o SHA-256 do token. O valor cru existe uma unica vez,
// na resposta da criacao: perdeu, revoga e emite outro.
//
// Enquanto nao houver nenhum token ativo, as rotas da extensao rodam em MODO
// ABERTO (todo mundo ve tudo), para que um clone novo suba com `npm run dev`
// sem passo extra. O painel nunca fica aberto. Criar o primeiro token liga a exigencia de token.

const crypto = require("node:crypto");
const { getDatabase } = require("../database");
const { normalizeAttendantName } = require("./attendant-filter");

const TOKEN_PREFIX = "mca_";
const TOKEN_BYTES = 32;
const ROLES = new Set(["ADMIN", "ATENDENTE"]);
// last_used_at e so informativo: nao vale um UPDATE por requisicao de um
// popup que consulta a cada minuto.
const LAST_USED_THROTTLE_MS = 60 * 1000;

// Quantidade de tokens ativos, em cache: e lida em toda requisicao para
// decidir entre modo aberto e exigencia de token.
let activeTokenCache = { total: null, expiresAt: 0 };
const lastUsedWrites = new Map();

async function countActiveTokens() {
  if (activeTokenCache.total !== null && activeTokenCache.expiresAt > Date.now()) {
    return activeTokenCache.total;
  }

  const database = await getDatabase();
  const row = await database.prepare("SELECT COUNT(*) AS total FROM api_tokens WHERE is_active = 1").get();
  const total = Number(row?.total || 0);
  activeTokenCache = { total, expiresAt: Date.now() + 5000 };
  return total;
}

async function isOpenMode() {
  return (await countActiveTokens()) === 0;
}

function invalidateTokenCache() {
  activeTokenCache = { total: null, expiresAt: 0 };
}

async function createToken({ name, attendant, role } = {}) {
  const database = await getDatabase();
  const cleanName = cleanText(name);
  if (!cleanName) {
    throw badRequest("Informe um nome para o token (ex.: 'Stephanie - notebook').");
  }

  const cleanRole = String(role || "ATENDENTE").trim().toUpperCase();
  if (!ROLES.has(cleanRole)) {
    throw badRequest("Perfil invalido: use ADMIN ou ATENDENTE.");
  }

  // O atendente e gravado ja canonico ("Alek NETFIBRA" -> "Aleksandro"), o
  // mesmo nome que a coleta grava em tickets.attendant.
  const canonicalAttendant = cleanRole === "ADMIN" ? "" : normalizeAttendantName(attendant);
  if (cleanRole === "ATENDENTE" && !canonicalAttendant) {
    throw badRequest("Informe o atendente do token (o nome como aparece no MTalk).");
  }

  const token = `${TOKEN_PREFIX}${crypto.randomBytes(TOKEN_BYTES).toString("base64url")}`;
  const result = await database
    .prepare(
      `INSERT INTO api_tokens (name, attendant, role, token_hash, token_hint)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(cleanName, canonicalAttendant || null, cleanRole, hashToken(token), tokenHint(token));

  invalidateTokenCache();

  return { token, record: await getTokenById(result.lastInsertRowid) };
}

async function listTokens() {
  const database = await getDatabase();
  const rows = await database
    .prepare(
      `SELECT id, name, attendant, role, token_hint AS "tokenHint", is_active AS "isActive",
              last_used_at AS "lastUsedAt", revoked_at AS "revokedAt", created_at AS "createdAt"
       FROM api_tokens
       ORDER BY is_active DESC, datetime(created_at) DESC`
    )
    .all();

  return { items: rows.map(normalizeTokenRow) };
}

async function getTokenById(id) {
  const database = await getDatabase();
  const row = await database
    .prepare(
      `SELECT id, name, attendant, role, token_hint AS "tokenHint", is_active AS "isActive",
              last_used_at AS "lastUsedAt", revoked_at AS "revokedAt", created_at AS "createdAt"
       FROM api_tokens WHERE id = ?`
    )
    .get(Number(id));

  return row ? normalizeTokenRow(row) : null;
}

// Revogar nao apaga a linha: a lista continua mostrando quem teve acesso.
async function revokeToken(id) {
  const database = await getDatabase();
  const tokenId = Number(id);
  if (!Number.isFinite(tokenId)) {
    throw badRequest("Id de token invalido.");
  }

  const result = await database
    .prepare(
      `UPDATE api_tokens
       SET is_active = 0, revoked_at = CURRENT_TIMESTAMP
       WHERE id = ? AND is_active = 1`
    )
    .run(tokenId);

  if (!result.changes) {
    const existente = await getTokenById(tokenId);
    if (!existente) {
      throw notFound("Token nao encontrado.");
    }
    return existente;
  }

  invalidateTokenCache();
  lastUsedWrites.delete(tokenId);
  return getTokenById(tokenId);
}

// Devolve a identidade do token ou null. A busca e pelo hash: token errado nem
// chega a virar consulta por nome.
async function authenticateToken(rawToken) {
  const token = cleanText(rawToken);
  if (!token) {
    return null;
  }

  const database = await getDatabase();
  const row = await database
    .prepare(
      `SELECT id, name, attendant, role
       FROM api_tokens
       WHERE token_hash = ? AND is_active = 1`
    )
    .get(hashToken(token));

  if (!row) {
    return null;
  }

  touchToken(database, row.id).catch((error) => {
    console.warn("[Auth] Nao foi possivel gravar last_used_at:", error.message);
  });

  return toIdentity(row);
}

// Identidade do modo aberto: mesma forma de um ADMIN, com a marca de que
// nenhum token foi exigido.
function openModeIdentity() {
  return {
    id: null,
    name: "Acesso aberto",
    role: "ADMIN",
    attendant: "",
    scopeAttendant: null,
    isAdmin: true,
    authRequired: false
  };
}

function toIdentity(row) {
  const role = String(row.role || "ATENDENTE").toUpperCase();
  const attendant = cleanText(row.attendant);
  const isAdmin = role === "ADMIN";

  return {
    id: Number(row.id),
    name: cleanText(row.name),
    role,
    attendant,
    // O recorte dos alertas e dos relatorios. ADMIN nao recorta nada.
    scopeAttendant: isAdmin ? null : attendant || null,
    isAdmin,
    authRequired: true
  };
}

async function touchToken(database, id) {
  const agora = Date.now();
  const ultimo = lastUsedWrites.get(id) || 0;
  if (agora - ultimo < LAST_USED_THROTTLE_MS) {
    return;
  }

  lastUsedWrites.set(id, agora);
  await database.prepare("UPDATE api_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
}

function normalizeTokenRow(row) {
  return {
    id: Number(row.id),
    name: row.name,
    attendant: cleanText(row.attendant),
    role: row.role,
    tokenHint: row.tokenHint,
    isActive: Boolean(row.isActive),
    lastUsedAt: row.lastUsedAt || null,
    revokedAt: row.revokedAt || null,
    createdAt: row.createdAt
  };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

// Rabicho para a pessoa reconhecer o token na lista sem que ele seja
// reconstituivel.
function tokenHint(token) {
  return `${TOKEN_PREFIX}...${token.slice(-4)}`;
}

function cleanText(value) {
  return String(value || "").trim();
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.publicMessage = message;
  return error;
}

function notFound(message) {
  const error = new Error(message);
  error.statusCode = 404;
  error.publicMessage = message;
  return error;
}

module.exports = {
  authenticateToken,
  countActiveTokens,
  createToken,
  getTokenById,
  isOpenMode,
  listTokens,
  openModeIdentity,
  revokeToken
};
