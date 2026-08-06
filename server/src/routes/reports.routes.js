const express = require("express");
const authMiddleware = require("../middlewares/auth.middleware");
const {
  getSummary,
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

router.get("/summary", (_req, res, next) => {
  try {
    res.json(getSummary());
  } catch (error) {
    next(error);
  }
});

router.get("/missing-tags", (req, res, next) => {
  try {
    res.json(getMissingTags(req.query));
  } catch (error) {
    next(error);
  }
});

router.get("/inactivity/summary", (req, res, next) => {
  try {
    res.json(getInactivitySummary(req.query));
  } catch (error) {
    next(error);
  }
});

router.get("/inactivity/tickets", (req, res, next) => {
  try {
    res.json(getInactiveTickets(req.query));
  } catch (error) {
    next(error);
  }
});

router.get("/inactivity/by-attendant", (req, res, next) => {
  try {
    res.json(getInactivityByAttendant(req.query));
  } catch (error) {
    next(error);
  }
});

router.get("/inactivity/by-company", (req, res, next) => {
  try {
    res.json(getInactivityByCompany(req.query));
  } catch (error) {
    next(error);
  }
});

router.get("/by-attendant", (req, res, next) => {
  try {
    res.json(getReportByAttendant(req.query));
  } catch (error) {
    next(error);
  }
});

router.get("/by-queue", (req, res, next) => {
  try {
    res.json(getReportByQueue(req.query));
  } catch (error) {
    next(error);
  }
});

module.exports = router;

