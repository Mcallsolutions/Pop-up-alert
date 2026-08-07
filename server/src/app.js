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

const DEFAULT_CORS_ORIGINS = "http://localhost:5173,http://localhost:8080,chrome-extension://";
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

const app = express();

// Necessario atras do proxy da Vercel/Nginx para que o rate limit e o req.ip
// enxerguem o IP real do cliente em vez do IP do proxy.
app.set("trust proxy", 1);

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
    legacyHeaders: false,
    // Em ambiente serverless a memoria nao e compartilhada entre instancias,
    // entao o rate limit funciona apenas como protecao best-effort por instancia.
    validate: isServerless ? { xForwardedForHeader: false } : true
  })
);

// Rotas que NAO dependem do banco ficam antes do middleware de conexao,
// para que o healthcheck continue respondendo mesmo com o banco fora do ar.
app.get(["/health", "/api/health"], async (_req, res) => {
  const database = await initializeDatabase()
    .then((instance) => ({ status: "ok", client: instance.client }))
    .catch((error) => ({ status: "erro", error: error.message }));

  res.status(database.status === "ok" ? 200 : 503).json({
    status: database.status === "ok" ? "ok" : "degradado",
    service: "mcall-ticket-tag-api",
    database,
    timestamp: new Date().toISOString()
  });
});

app.get("/api", (_req, res) => {
  res.json(getApiCatalog());
});

// Interface HTML de teste da API.
// Em producao (projeto unico na Vercel) o "/" serve o painel admin,
// por isso a interface tambem responde em "/api/console".
app.get(["/", "/api/console"], (_req, res) => {
  res.type("html").send(renderApiInterface());
});

app.use("/api/auth", requireDatabase, authRoutes);
app.use("/api/tickets", requireDatabase, ticketRoutes);
app.use("/api/reports", requireDatabase, reportRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "Rota nao encontrada" });
});

app.use((error, _req, res, _next) => {
  console.error("[API]", error);
  res.status(error.statusCode || 500).json({
    error: error.publicMessage || "Erro interno"
  });
});

module.exports = app;

// Garante a conexao/migrations antes das rotas que tocam o banco.
// Fica fora do pipeline global para que /health e /api respondam mesmo
// com o banco indisponivel.
async function requireDatabase(_req, _res, next) {
  try {
    await initializeDatabase();
    next();
  } catch (error) {
    error.statusCode = error.statusCode || 503;
    error.publicMessage = error.publicMessage || `Banco de dados indisponivel: ${error.message}`;
    next(error);
  }
}

function validateCorsOrigin(origin, callback) {
  if (!origin) {
    callback(null, true);
    return;
  }

  const allowed = String(process.env.CORS_ORIGINS || DEFAULT_CORS_ORIGINS)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  // No deploy unico da Vercel o painel roda na mesma origem da API.
  if (process.env.VERCEL_URL) {
    allowed.push(`https://${process.env.VERCEL_URL}`);
  }

  if (process.env.NODE_ENV !== "production" && !allowed.includes("chrome-extension://")) {
    allowed.push("chrome-extension://");
  }

  const isAllowed = allowed.some((entry) => matchesCorsOrigin(origin, entry));

  if (isAllowed) {
    callback(null, true);
    return;
  }

  const error = new Error(`Origem nao permitida pelo CORS: ${origin}`);
  error.statusCode = 403;
  error.publicMessage = "Origem nao permitida pelo CORS";
  callback(error, false);
}

function matchesCorsOrigin(origin, entry) {
  if (entry.endsWith("://")) {
    return origin.startsWith(entry);
  }

  if (entry.includes("*")) {
    const pattern = `^${entry.split("*").map(escapeRegex).join(".*")}$`;
    return new RegExp(pattern).test(origin);
  }

  return origin === entry;
}

function escapeRegex(value) {
  return String(value).replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
