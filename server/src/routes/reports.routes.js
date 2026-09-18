const express = require("express");
const { scopedFilters } = require("../middleware/auth");
const {
  getSummary,
  getFilterOptions,
  getMissingTags,
  getInactivitySummary,
  getInactiveTickets,
  getInactivityByAttendant,
  getInactivityByCompany,
  getReportByAttendant,
  getReportByQueue
} = require("../services/report.service");

const router = express.Router();

// scopedFilters carimba o recorte do token por cima dos filtros da tela: quem
// tem token de atendente so enxerga os proprios tickets e os que estao sem
// atendente, em qualquer relatorio.

router.get("/summary", async (req, res, next) => {
  try {
    res.json(await getSummary(scopedFilters(req, req.query)));
  } catch (error) {
    next(error);
  }
});

router.get("/filters", async (req, res, next) => {
  try {
    res.json(await getFilterOptions(scopedFilters(req, req.query)));
  } catch (error) {
    next(error);
  }
});

router.get("/missing-tags", async (req, res, next) => {
  try {
    res.json(await getMissingTags(scopedFilters(req, req.query)));
  } catch (error) {
    next(error);
  }
});

router.get("/inactivity/summary", async (req, res, next) => {
  try {
    res.json(await getInactivitySummary(scopedFilters(req, req.query)));
  } catch (error) {
    next(error);
  }
});

router.get("/inactivity/tickets", async (req, res, next) => {
  try {
    res.json(await getInactiveTickets(scopedFilters(req, req.query)));
  } catch (error) {
    next(error);
  }
});

router.get("/inactivity/by-attendant", async (req, res, next) => {
  try {
    res.json(await getInactivityByAttendant(scopedFilters(req, req.query)));
  } catch (error) {
    next(error);
  }
});

router.get("/inactivity/by-company", async (req, res, next) => {
  try {
    res.json(await getInactivityByCompany(scopedFilters(req, req.query)));
  } catch (error) {
    next(error);
  }
});

router.get("/by-attendant", async (req, res, next) => {
  try {
    res.json(await getReportByAttendant(scopedFilters(req, req.query)));
  } catch (error) {
    next(error);
  }
});

router.get("/by-queue", async (req, res, next) => {
  try {
    res.json(await getReportByQueue(scopedFilters(req, req.query)));
  } catch (error) {
    next(error);
  }
});

module.exports = router;

