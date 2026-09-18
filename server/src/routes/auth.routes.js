const express = require("express");
const { authenticate, requireAdmin } = require("../middleware/auth");
const { createToken, listTokens, revokeToken } = require("../services/token.service");

const router = express.Router();

// Quem sou eu: o painel e a extensao usam para saber se ha token valido, de
// quem e o recorte e se a pessoa e ADMIN. 401 aqui = hora de pedir o token.
router.get("/me", authenticate, (req, res) => {
  res.json(describeIdentity(req.auth));
});

// Gestao de tokens: so ADMIN (ou o modo aberto, para emitir o primeiro).
router.get("/tokens", authenticate, requireAdmin, async (_req, res, next) => {
  try {
    res.json(await listTokens());
  } catch (error) {
    next(error);
  }
});

// O token cru volta UMA vez, aqui. Depois so o rabicho (mca_...abcd).
router.post("/tokens", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { token, record } = await createToken(req.body || {});
    res.status(201).json({ token, item: record });
  } catch (error) {
    next(error);
  }
});

router.delete("/tokens/:id", authenticate, requireAdmin, async (req, res, next) => {
  try {
    res.json({ ok: true, item: await revokeToken(req.params.id) });
  } catch (error) {
    next(error);
  }
});

function describeIdentity(auth = {}) {
  return {
    name: auth.name,
    role: auth.role,
    attendant: auth.attendant || "",
    isAdmin: Boolean(auth.isAdmin),
    // false = a API ainda nao tem token ativo e esta aberta.
    authRequired: auth.authRequired !== false
  };
}

module.exports = router;
