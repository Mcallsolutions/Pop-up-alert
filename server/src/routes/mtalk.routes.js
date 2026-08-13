const express = require("express");
const authMiddleware = require("../middlewares/auth.middleware");
const { validateExtensionToken } = require("../middlewares/extension-token");
const { collectFromMtalk, describeCollectorStatus } = require("../services/mtalk/mtalk.collector");

// Coleta headless: le os tickets pela API oficial do MTalk e grava o snapshot,
// sem depender de um navegador com o painel aberto. Precisa de MTALK_TOKEN.
// Aceita GET e POST porque os Cron Jobs da Vercel chamam por GET.
const dataRoutes = express.Router();

dataRoutes.all("/collect", async (req, res, next) => {
  if (req.method !== "GET" && req.method !== "POST") {
    next();
    return;
  }

  try {
    validateExtensionToken(req);
    // dryRun le a API e devolve o resultado sem gravar nada: util para
    // conferir token e filas logo depois de um deploy.
    const persist = String(req.query.dryRun || "") !== "1";
    const result = await collectFromMtalk({ persist });

    res.status(persist ? 201 : 200).json({
      ok: true,
      persistido: persist,
      totalTickets: result.totalTickets,
      totalWithTag: result.totalWithTag,
      totalWithoutTag: result.totalWithoutTag,
      totalInactive: result.totalInactive,
      thresholdMinutes: result.thresholdMinutes,
      snapshot: result.snapshot,
      diagnostics: result.diagnostics
    });
  } catch (error) {
    next(error);
  }
});

// Status da integracao para o painel: mostra o que esta configurado sem expor
// o token.
const panelRoutes = express.Router();

panelRoutes.get("/status", authMiddleware, (_req, res) => {
  res.json(describeCollectorStatus());
});

module.exports = { dataRoutes, panelRoutes };
