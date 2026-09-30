const express = require("express");
const {
  analyzeTicketManually,
  getAnalysesByAttendant,
  getAnalysis,
  getAttendanceStatus,
  listAnalyses
} = require("../services/attendance-analysis.service");

// Analise de atendimento por IA. Montada so para o painel (sessao de login):
// o token da extensao nunca le mensagem nem analise, nem de perfil ADMIN.
const router = express.Router();

router.get("/status", async (_req, res, next) => {
  try {
    res.json(await getAttendanceStatus());
  } catch (error) {
    next(error);
  }
});

// Filtros: day, startDate, endDate, attendant, queue, company, clientName,
// riscoCancelamento, sentimentoCliente, notaMax e limit.
router.get("/analyses", async (req, res, next) => {
  try {
    res.json(await listAnalyses(req.query));
  } catch (error) {
    next(error);
  }
});

// A analise mais a transcricao MASCARADA da janela analisada.
router.get("/analyses/:id", async (req, res, next) => {
  try {
    res.json(await getAnalysis(req.params.id));
  } catch (error) {
    next(error);
  }
});

router.get("/by-attendant", async (req, res, next) => {
  try {
    res.json(await getAnalysesByAttendant(req.query));
  } catch (error) {
    next(error);
  }
});

// Analise manual: le as mensagens do ticket e chama a OpenAI agora.
router.post("/tickets/:ticketId/analyze", async (req, res, next) => {
  try {
    res.status(201).json(await analyzeTicketManually(req.params.ticketId, { createdBy: req.auth?.username || null }));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
