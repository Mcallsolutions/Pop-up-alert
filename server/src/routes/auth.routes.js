const express = require("express");
const rateLimit = require("express-rate-limit");
const { authenticate, authenticatePanel, readToken } = require("../middleware/auth");
const { createToken, listTokens, revokeToken } = require("../services/token.service");
const { login, logout } = require("../services/admin-auth.service");

const router = express.Router();

// Tentativas de senha por IP. So as que falham contam: quem acerta nao gasta
// cota.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas tentativas de login. Aguarde alguns minutos e tente de novo." }
});

// Login do painel: usuario e senha viram uma sessao (mcs_...) que o painel
// manda como Bearer nas proximas chamadas.
router.post("/login", loginLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const result = await login(username, password);

    if (!result) {
      res.status(401).json({ error: "Usuario ou senha invalidos." });
      return;
    }

    res.json({ session: result.session, expiresAt: result.expiresAt, user: describeIdentity(result.identity) });
  } catch (error) {
    next(error);
  }
});

router.post("/logout", async (req, res, next) => {
  try {
    await logout(readToken(req));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Quem esta logado no painel. 401 aqui = hora de mostrar a tela de login.
router.get("/session", authenticatePanel, (req, res) => {
  res.json(describeIdentity(req.auth));
});

// Quem sou eu, para a extensao: de quem e o token, qual o recorte e se a API
// exige token. 401 aqui = token ausente ou revogado.
router.get("/me", authenticate, (req, res) => {
  res.json(describeIdentity(req.auth));
});

// Gestao dos tokens da extensao: so pelo painel (login de administrador).
router.get("/tokens", authenticatePanel, async (_req, res, next) => {
  try {
    res.json(await listTokens());
  } catch (error) {
    next(error);
  }
});

// O token cru volta UMA vez, aqui. Depois so o rabicho (mca_...abcd).
router.post("/tokens", authenticatePanel, async (req, res, next) => {
  try {
    const { token, record } = await createToken(req.body || {});
    res.status(201).json({ token, item: record });
  } catch (error) {
    next(error);
  }
});

router.delete("/tokens/:id", authenticatePanel, async (req, res, next) => {
  try {
    res.json({ ok: true, item: await revokeToken(req.params.id) });
  } catch (error) {
    next(error);
  }
});

function describeIdentity(auth = {}) {
  return {
    name: auth.name,
    username: auth.username || "",
    role: auth.role,
    attendant: auth.attendant || "",
    isAdmin: Boolean(auth.isAdmin),
    // false = ainda nao ha token de extensao ativo e as rotas da extensao
    // estao abertas.
    authRequired: auth.authRequired !== false,
    expiresAt: auth.expiresAt || null
  };
}

module.exports = router;
