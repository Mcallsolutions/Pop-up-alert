require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { initializeDatabase } = require("./database");
const mtalkRoutes = require("./routes/mtalk.routes");
const reportRoutes = require("./routes/reports.routes");
const aiRoutes = require("./routes/ai.routes");

// Painel em dev (Vite) e a extensao Chrome. Separe por virgula para liberar mais.
const DEFAULT_CORS_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173,chrome-extension://";

const app = express();

app.use(helmet());
app.use(express.json({ limit: "512kb" }));
app.use(cors(corsOptionsDelegate));
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false
  })
);

// Rotas que NAO dependem do banco ficam antes do middleware de conexao,
// para que o healthcheck continue respondendo mesmo com o banco fora do ar.
app.get("/health", async (_req, res) => {
  const database = await initializeDatabase()
    .then((instance) => ({ status: "ok", client: instance.client, arquivo: instance.filename }))
    .catch((error) => ({ status: "erro", error: error.message }));

  res.status(database.status === "ok" ? 200 : 503).json({
    status: database.status === "ok" ? "ok" : "degradado",
    service: "mcall-ticket-tag-api",
    database,
    timestamp: new Date().toISOString()
  });
});

app.use("/api/mtalk", requireDatabase, mtalkRoutes);
app.use("/api/reports", requireDatabase, reportRoutes);
app.use("/api/ai", requireDatabase, aiRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "Rota nao encontrada" });
});

app.use((error, _req, res, _next) => {
  // Erro esperado (com mensagem publica) vira uma linha; so o inesperado leva
  // o stack inteiro para o log.
  if (error.publicMessage) {
    console.error(`[API] ${error.statusCode || 500} ${error.publicMessage}`);
  } else {
    console.error("[API]", error);
  }
  res.status(error.statusCode || 500).json({
    error: error.publicMessage || "Erro interno"
  });
});

module.exports = app;

// Garante a conexao/migrations antes das rotas que tocam o banco.
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

// Requisicao sem Origin (curl, extensao pelo service worker) e de mesma origem
// passam direto; o resto precisa estar em CORS_ORIGINS.
function corsOptionsDelegate(req, callback) {
  const origin = req.headers.origin;

  if (!origin || isSameOrigin(req, origin) || isAllowedOrigin(origin)) {
    callback(null, { origin: true, credentials: false });
    return;
  }

  const error = new Error(`Origem nao permitida pelo CORS: ${origin}`);
  error.statusCode = 403;
  error.publicMessage = `Origem nao permitida pelo CORS: ${origin}`;
  callback(error);
}

function isSameOrigin(req, origin) {
  const host = req.headers.host;
  return Boolean(host) && [`http://${host}`, `https://${host}`].some((candidate) => normalizeOrigin(candidate) === normalizeOrigin(origin));
}

function isAllowedOrigin(origin) {
  const normalizedOrigin = normalizeOrigin(origin);

  return String(process.env.CORS_ORIGINS || DEFAULT_CORS_ORIGINS)
    .split(/[,\n;]/)
    .map((item) => item.trim().replace(/^["']|["']$/g, "").trim())
    .filter(Boolean)
    .some((entry) => (entry.endsWith("://") ? normalizedOrigin.startsWith(entry.toLowerCase()) : normalizedOrigin === normalizeOrigin(entry)));
}

function normalizeOrigin(value) {
  return String(value).trim().replace(/\/+$/, "").toLowerCase();
}
