require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const { initializeDatabase } = require("./database");
const authRoutes = require("./routes/auth.routes");
const ticketRoutes = require("./routes/tickets.routes");
const reportRoutes = require("./routes/reports.routes");
const { renderApiInterface, getApiCatalog } = require("./views/api-interface");

const app = express();
const port = Number(process.env.PORT || 3333);
const DEFAULT_CORS_ORIGINS = "http://localhost:5173,http://localhost:8080,chrome-extension://";

initializeDatabase();

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'", "'unsafe-inline'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "connect-src": ["'self'"],
        "img-src": ["'self'", "data:"],
        "object-src": ["'none'"]
      }
    }
  })
);
app.use(express.json({ limit: "512kb" }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(
  cors({
    origin: validateCorsOrigin,
    credentials: false
  })
);
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 180,
    standardHeaders: true,
    legacyHeaders: false
  })
);

app.get("/", (_req, res) => {
  res.type("html").send(renderApiInterface());
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "mcall-ticket-tag-api",
    timestamp: new Date().toISOString()
  });
});

app.get("/api", (_req, res) => {
  res.json(getApiCatalog());
});

app.use("/api/auth", authRoutes);
app.use("/api/tickets", ticketRoutes);
app.use("/api/reports", reportRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "Rota nao encontrada" });
});

app.use((error, _req, res, _next) => {
  console.error("[API]", error);
  res.status(error.statusCode || 500).json({
    error: error.publicMessage || "Erro interno"
  });
});

app.listen(port, () => {
  console.log(`Mcall Ticket Tag API ouvindo em http://localhost:${port}`);
});

function validateCorsOrigin(origin, callback) {
  if (!origin) {
    callback(null, true);
    return;
  }

  const allowed = String(process.env.CORS_ORIGINS || DEFAULT_CORS_ORIGINS)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (process.env.NODE_ENV !== "production" && !allowed.includes("chrome-extension://")) {
    allowed.push("chrome-extension://");
  }

  const isAllowed = allowed.some((entry) => {
    if (entry.endsWith("://")) {
      return origin.startsWith(entry);
    }
    return origin === entry;
  });

  if (isAllowed) {
    callback(null, true);
    return;
  }

  const error = new Error(`Origem nao permitida pelo CORS: ${origin}`);
  error.statusCode = 403;
  error.publicMessage = "Origem nao permitida pelo CORS";
  callback(error, false);
}
