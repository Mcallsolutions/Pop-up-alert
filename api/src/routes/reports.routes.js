const express = require("express");
const authMiddleware = require("../middlewares/auth.middleware");
const {
  getSummary,
  getMissingTags,
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

