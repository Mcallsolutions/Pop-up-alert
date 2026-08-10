const express = require("express");
const authMiddleware = require("../middlewares/auth.middleware");
const {
  createPrompt,
  deletePrompt,
  generateSummary,
  getLatestSummary,
  getStatus,
  listPrompts,
  listSummaries,
  updatePrompt
} = require("../services/ai.service");

const router = express.Router();

router.use(authMiddleware);

router.get("/status", async (_req, res, next) => {
  try {
    res.json(await getStatus());
  } catch (error) {
    next(error);
  }
});

router.get("/prompts", async (_req, res, next) => {
  try {
    res.json(await listPrompts());
  } catch (error) {
    next(error);
  }
});

router.post("/prompts", async (req, res, next) => {
  try {
    res.status(201).json(await createPrompt(req.body));
  } catch (error) {
    next(error);
  }
});

router.put("/prompts/:id", async (req, res, next) => {
  try {
    res.json(await updatePrompt(req.params.id, req.body));
  } catch (error) {
    next(error);
  }
});

router.delete("/prompts/:id", async (req, res, next) => {
  try {
    res.json(await deletePrompt(req.params.id));
  } catch (error) {
    next(error);
  }
});

// Gera um resumo novo chamando a OpenAI com os filtros enviados no corpo.
router.post("/summary", async (req, res, next) => {
  try {
    res.status(201).json(await generateSummary(req.body || {}, req.user));
  } catch (error) {
    next(error);
  }
});

router.get("/summary/latest", async (_req, res, next) => {
  try {
    res.json(await getLatestSummary());
  } catch (error) {
    next(error);
  }
});

router.get("/summaries", async (req, res, next) => {
  try {
    res.json(await listSummaries(req.query.limit));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
