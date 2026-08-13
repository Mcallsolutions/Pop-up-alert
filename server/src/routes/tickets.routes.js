const express = require("express");
const { validateExtensionToken } = require("../middlewares/extension-token");
const { saveSnapshot } = require("../services/ticket.service");

// Rotas que NAO tocam o banco. Ficam separadas para poderem ser montadas fora
// do middleware requireDatabase: o ping so valida token, entao nao faz sentido
// ele responder 503 quando o banco esta fora do ar.
const publicRoutes = express.Router();

// Teste de conectividade da extensao. Passa pela MESMA validacao de token do
// snapshot, entao um "ok" aqui garante que o envio real tambem vai passar.
// Responde tambem em GET para poder ser conferido pelo navegador.
publicRoutes.all("/ping", (req, res, next) => {
  if (req.method !== "GET" && req.method !== "POST" && req.method !== "HEAD") {
    next();
    return;
  }

  try {
    validateExtensionToken(req);
    res.json({
      ok: true,
      rota: "/api/tickets/ping",
      tokenExigido: Boolean(process.env.EXTENSION_TOKEN),
      origem: req.headers.origin || null
    });
  } catch (error) {
    next(error);
  }
});

const dataRoutes = express.Router();

dataRoutes.post("/snapshot", async (req, res, next) => {
  try {
    validateExtensionToken(req);
    const result = await saveSnapshot(req.body);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = {
  publicRoutes,
  dataRoutes
};
