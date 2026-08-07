const express = require("express");
const authMiddleware = require("../middlewares/auth.middleware");
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

router.use(authMiddleware);

router.get("/summary", async (req, res, next) => {
  try {
    res.json(await getSummary(req.query));
  } catch (error) {
    next(error);
  }
});

router.get("/filters", async (req, res, next) => {
  try {
    res.json(await getFilterOptions(req.query));
  } catch (error) {
    next(error);
  }
});

router.get("/missing-tags", async (req, res, next) => {
  try {
    res.json(await getMissingTags(req.query));
  } catch (error) {
    next(error);
  }
});

router.get("/inactivity/summary", async (req, res, next) => {
  try {
    res.json(await getInactivitySummary(req.query));
  } catch (error) {
    next(error);
  }
});

router.get("/inactivity/tickets", async (req, res, next) => {
  try {
    res.json(await getInactiveTickets(req.query));
  } catch (error) {
    next(error);
  }
});

router.get("/inactivity/by-attendant", async (req, res, next) => {
  try {
    res.json(await getInactivityByAttendant(req.query));
  } catch (error) {
    next(error);
  }
});

router.get("/inactivity/by-company", async (req, res, next) => {
  try {
    res.json(await getInactivityByCompany(req.query));
  } catch (error) {
    next(error);
  }
});

router.get("/by-attendant", async (req, res, next) => {
  try {
    res.json(await getReportByAttendant(req.query));
  } catch (error) {
    next(error);
  }
});

router.get("/by-queue", async (req, res, next) => {
  try {
    res.json(await getReportByQueue(req.query));
  } catch (error) {
    next(error);
  }
});

module.exports = router;

