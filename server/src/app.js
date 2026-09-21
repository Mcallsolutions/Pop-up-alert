require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { initializeDatabase } = require("./database");
const { authenticate, authenticatePanel } = require("./middleware/auth");
const authRoutes = require("./routes/auth.routes");
const mtalkRoutes = require("./routes/mtalk.routes");
const reportRoutes = require("./routes/reports.routes");
const aiRoutes = require("./routes/ai.routes");
const extensionRoutes = require("./routes/extension.routes");

// Painel em dev (Vite) e a extensao Chrome. Separe por virgula para liberar mais.
const DEFAULT_CORS_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173,chrome-extension://";
// Build do painel (npm run build). Se existir, a propria API serve o painel:
// e o que faz `npm start` sozinho entregar tudo, sem depender do nginx.
const ADMIN_DIST_DIR = path.resolve(__dirname, "../../dist");

const app = express();

// Atras de um proxy (nginx), TRUST_PROXY=1 faz o Express ler o IP real do
// X-Forwarded-For — sem isso o rate limit contaria todo mundo como o proxy.
// Fora do proxy fica 0: assim ninguem forja o proprio IP mandando o cabecalho.
app.set("trust proxy", Number(process.env.TRUST_PROXY || 0));

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

// Duas portas de entrada (ver middleware/auth.js):
// - authenticate: rotas que a extensao usa (/api/mtalk). Aceita o token da
//   pessoa, que recorta os alertas, ou a sessao do painel;
// - authenticatePanel: o resto do painel (relatorios, IA, download da
//   extensao, gestao de tokens). So sessao de login com usuario e senha.
// /api/auth cuida da propria autenticacao rota a rota (login, sessao, /me).
app.use("/api/auth", requireDatabase, authRoutes);
app.use("/api/mtalk", requireDatabase, authenticate, mtalkRoutes);
app.use("/api/reports", requireDatabase, authenticatePanel, reportRoutes);
app.use("/api/ai", requireDatabase, authenticatePanel, aiRoutes);
// Download do .zip da extensao, pelo painel. O pacote sai da pasta
// /extension, sem token nem .env dentro.
app.use("/api/extension", requireDatabase, authenticatePanel, extensionRoutes);

serveAdminPanel(app);

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

// Serve o painel ja compilado, quando ele existe. O painel nao usa rotas de
// URL (a navegacao e por estado), entao basta o index.html na raiz alem dos
// arquivos de /assets.
function serveAdminPanel(instance) {
  const indexFile = path.join(ADMIN_DIST_DIR, "index.html");

  if (String(process.env.SERVE_ADMIN || "") === "0" || !fs.existsSync(indexFile)) {
    return;
  }

  instance.use(express.static(ADMIN_DIST_DIR, { index: false, maxAge: "1h" }));
  instance.get(["/", "/index.html"], (_req, res) => {
    res.sendFile(indexFile);
  });
}

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
