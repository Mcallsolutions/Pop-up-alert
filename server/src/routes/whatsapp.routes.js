const express = require("express");
const { describeWhatsappStatus, sendTestMessage } = require("../services/whatsapp-alerts.service");

// Alertas de inatividade no WhatsApp. So painel (sessao de login): o status
// mostra os destinatarios mascarados e nunca a chave do provedor.
const router = express.Router();

router.get("/status", (_req, res) => {
  res.json(describeWhatsappStatus());
});

// Manda uma mensagem de teste para todos os destinatarios configurados.
router.post("/test", async (req, res, next) => {
  try {
    res.json(await sendTestMessage({ requestedBy: req.auth?.username || null }));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
