const express = require("express");
const { getMissingTagListDays } = require("../config/monitoring");
const { scopedFilters } = require("../middleware/auth");
const { getCachedReport } = require("../services/report-cache");
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
// atendente, em qualquer relatorio. O recorte entra na chave do cache junto com
// os filtros (ver report-cache.js).

router.get("/summary", cachedReport("summary", getSummary));
router.get("/filters", cachedReport("filters", getFilterOptions));
// Paginada (15 clientes por pagina, `page`) e sem quem esta ha mais de
// MISSING_TAG_LIST_DAYS dias na lista.
router.get(
  "/missing-tags",
  cachedReport("missing-tags", (filters) =>
    getMissingTags(filters, { paginate: true, maxAgeDays: getMissingTagListDays() })
  )
);
router.get("/inactivity/summary", cachedReport("inactivity-summary", getInactivitySummary));
router.get("/inactivity/tickets", cachedReport("inactivity-tickets", getInactiveTickets));
router.get("/inactivity/by-attendant", cachedReport("inactivity-by-attendant", getInactivityByAttendant));
router.get("/inactivity/by-company", cachedReport("inactivity-by-company", getInactivityByCompany));
router.get("/by-attendant", cachedReport("by-attendant", getReportByAttendant));
router.get("/by-queue", cachedReport("by-queue", getReportByQueue));

// fresh=1 ignora o cache e grava a resposta nova. X-Cache diz se veio do cache
// e X-Cache-Date de quando e a resposta.
function cachedReport(name, loader) {
  return async (req, res, next) => {
    try {
      const filters = scopedFilters(req, req.query);
      const { value, hit, storedAt } = await getCachedReport(name, filters, () => loader(filters), {
        fresh: String(req.query.fresh || "") === "1"
      });
      res.set("X-Cache", hit ? "HIT" : "MISS");
      res.set("X-Cache-Date", new Date(storedAt).toISOString());
      res.json(value);
    } catch (error) {
      next(error);
    }
  };
}

module.exports = router;
