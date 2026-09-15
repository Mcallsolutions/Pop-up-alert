const express = require("express");
const {
  describeCollectorStatus,
  getCurrentAlerts,
  runCollection
} = require("../services/mtalk/mtalk.collector");

const router = express.Router();

// Alertas da ultima coleta, consumidos pelo pop-up da extensao.
router.get("/alerts", (_req, res) => {
  res.json(getCurrentAlerts());
});

// Estado da integracao: sessao, agendamento e ultima coleta, sem expor token.
router.get("/status", (_req, res) => {
  res.json(describeCollectorStatus());
});

// Dispara uma coleta agora. dryRun=1 le a API e devolve o resultado sem gravar.
router.post("/collect", async (req, res, next) => {
  try {
    const persist = String(req.query.dryRun || "") !== "1";
    const result = await runCollection({ persist, reason: persist ? "manual" : "manual-dry-run" });

    res.status(persist ? 201 : 200).json({
      ok: true,
      persistido: persist,
      coletadoEm: result.collectedAt,
      totalTickets: result.totalTickets,
      totalWithTag: result.totalWithTag,
      totalWithoutTag: result.totalWithoutTag,
      totalWithoutAttendant: result.totalWithoutAttendant,
      totalInactive: result.totalInactive,
      thresholdMinutes: result.thresholdMinutes,
      snapshot: result.snapshot,
      diagnostics: result.diagnostics
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
