// Login do painel de administracao (usuario e senha).
//
// Nao confundir com token.service: aqueles tokens sao por pessoa e servem so
// para a extensao (pop-up) saber de quem sao os alertas. O painel e sempre de
// administrador — quem entra aqui ve tudo e gerencia os tokens da extensao.
//
// Usuarios sao criados pela linha de comando (`npm run admin -- criar ...`):
// nao ha cadastro pela web, entao um painel recem-publicado nao tem como ser
// "reivindicado" por quem chegar primeiro.
//
// A senha vira hash scrypt com sal aleatorio. O login devolve um valor de
// sessao (mcs_...) que o painel manda como Bearer; o banco guarda so o SHA-256
// dele e a sessao expira sozinha.

const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { getDatabase } = require("../database");

const scrypt = promisify(crypto.scrypt);

const SESSION_PREFIX = "mcs_";
const SESSION_BYTES = 32;
const DEFAULT_SESSION_HOURS = 12;
const MIN_PASSWORD_LENGTH = 8;
const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

// Hash de uma senha qualquer, calculado uma vez: usuario inexistente tambem
// paga o custo do scrypt, para o tempo de resposta nao entregar quem existe.
let dummyHashPromise;

function isSessionToken(value) {
  return String(value || "").startsWith(SESSION_PREFIX);
}

async function createAdminUser({ username, name, password } = {}) {
  const cleanUsername = cleanText(username).toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(cleanUsername)) {
    throw badRequest("Login invalido: use de 3 a 40 caracteres entre letras, numeros, ponto, hifen e sublinhado.");
  }

  const passwordHash = await hashPassword(password);
  const database = await getDatabase();

  const existente = await database.prepare("SELECT id FROM admin_users WHERE username = ?").get(cleanUsername);
  if (existente) {
    throw badRequest(`Ja existe um usuario com o login "${cleanUsername}".`);
  }

  const result = await database
    .prepare("INSERT INTO admin_users (username, name, password_hash) VALUES (?, ?, ?)")
    .run(cleanUsername, cleanText(name) || cleanUsername, passwordHash);

  return getAdminUserById(result.lastInsertRowid);
}

// Trocar a senha derruba as sessoes abertas daquele usuario.
async function setAdminPassword(username, password) {
  const passwordHash = await hashPassword(password);
  const user = await requireUserByUsername(username);
  const database = await getDatabase();

  await database.prepare("UPDATE admin_users SET password_hash = ? WHERE id = ?").run(passwordHash, user.id);
  await database.prepare("DELETE FROM admin_sessions WHERE user_id = ?").run(user.id);
  return getAdminUserById(user.id);
}

async function setAdminActive(username, active) {
  const user = await requireUserByUsername(username);
  const database = await getDatabase();

  await database.prepare("UPDATE admin_users SET is_active = ? WHERE id = ?").run(active ? 1 : 0, user.id);
  if (!active) {
    await database.prepare("DELETE FROM admin_sessions WHERE user_id = ?").run(user.id);
  }
  return getAdminUserById(user.id);
}

async function listAdminUsers() {
  const database = await getDatabase();
  const rows = await database
    .prepare(
      `SELECT id, username, name, is_active AS "isActive", last_login_at AS "lastLoginAt", created_at AS "createdAt"
       FROM admin_users
       ORDER BY is_active DESC, username`
    )
    .all();

  return rows.map(normalizeUserRow);
}

// Devolve { session, identity } ou null. A mensagem de erro e a mesma para
// login inexistente, senha errada e usuario desativado.
async function login(username, password) {
  const cleanUsername = cleanText(username).toLowerCase();
  const database = await getDatabase();
  const row = cleanUsername
    ? await database
        .prepare("SELECT id, username, name, password_hash, is_active FROM admin_users WHERE username = ?")
        .get(cleanUsername)
    : null;

  const passwordOk = await verifyPassword(String(password || ""), row?.password_hash || (await getDummyHash()));
  if (!row || !passwordOk || !row.is_active) {
    return null;
  }

  await database.prepare("DELETE FROM admin_sessions WHERE datetime(expires_at) <= datetime('now')").run();

  const session = `${SESSION_PREFIX}${crypto.randomBytes(SESSION_BYTES).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + getSessionHours() * 60 * 60 * 1000).toISOString();

  await database
    .prepare("INSERT INTO admin_sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)")
    .run(row.id, hashSession(session), expiresAt);
  await database.prepare("UPDATE admin_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?").run(row.id);

  return { session, expiresAt, identity: toIdentity(row, expiresAt) };
}

async function authenticateSession(rawSession) {
  const session = cleanText(rawSession);
  if (!isSessionToken(session)) {
    return null;
  }

  const database = await getDatabase();
  const row = await database
    .prepare(
      `SELECT u.id, u.username, u.name, s.expires_at
       FROM admin_sessions s
       JOIN admin_users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND u.is_active = 1 AND datetime(s.expires_at) > datetime('now')`
    )
    .get(hashSession(session));

  return row ? toIdentity(row, row.expires_at) : null;
}

async function logout(rawSession) {
  const session = cleanText(rawSession);
  if (!isSessionToken(session)) {
    return;
  }

  const database = await getDatabase();
  await database.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(hashSession(session));
}

// Mesma forma da identidade de um token ADMIN (ve tudo, sem recorte), com a
// marca de que veio do login do painel.
function toIdentity(row, expiresAt) {
  return {
    id: Number(row.id),
    kind: "admin-session",
    username: row.username,
    name: cleanText(row.name) || row.username,
    role: "ADMIN",
    attendant: "",
    scopeAttendant: null,
    isAdmin: true,
    authRequired: true,
    expiresAt
  };
}

async function hashPassword(password) {
  const value = String(password || "");
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw badRequest(`A senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`);
  }

  const salt = crypto.randomBytes(16);
  const key = await scrypt(value, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

async function verifyPassword(password, stored) {
  const [algo, N, r, p, salt, key] = String(stored || "").split("$");
  if (algo !== "scrypt" || !salt || !key) {
    return false;
  }

  const expected = Buffer.from(key, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p)
  });
  return crypto.timingSafeEqual(expected, actual);
}

function getDummyHash() {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(crypto.randomBytes(16).toString("hex"));
  }
  return dummyHashPromise;
}

function getSessionHours() {
  const hours = Number(process.env.ADMIN_SESSION_HOURS);
  return Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_SESSION_HOURS;
}

async function getAdminUserById(id) {
  const database = await getDatabase();
  const row = await database
    .prepare(
      `SELECT id, username, name, is_active AS "isActive", last_login_at AS "lastLoginAt", created_at AS "createdAt"
       FROM admin_users WHERE id = ?`
    )
    .get(Number(id));
  return row ? normalizeUserRow(row) : null;
}

async function requireUserByUsername(username) {
  const database = await getDatabase();
  const row = await database
    .prepare("SELECT id FROM admin_users WHERE username = ?")
    .get(cleanText(username).toLowerCase());
  if (!row) {
    throw notFound(`Usuario "${cleanText(username)}" nao encontrado.`);
  }
  return row;
}

function normalizeUserRow(row) {
  return {
    id: Number(row.id),
    username: row.username,
    name: row.name,
    isActive: Boolean(row.isActive),
    lastLoginAt: row.lastLoginAt || null,
    createdAt: row.createdAt
  };
}

function hashSession(session) {
  return crypto.createHash("sha256").update(session, "utf8").digest("hex");
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
  MIN_PASSWORD_LENGTH,
  authenticateSession,
  createAdminUser,
  isSessionToken,
  listAdminUsers,
  login,
  logout,
  setAdminActive,
  setAdminPassword
};
