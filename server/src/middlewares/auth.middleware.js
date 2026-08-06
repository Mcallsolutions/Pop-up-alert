const jwt = require("jsonwebtoken");
const { getDatabase } = require("../database");

function authMiddleware(req, res, next) {
  const header = req.get("authorization") || "";
  const [, token] = header.match(/^Bearer\s+(.+)$/i) || [];

  if (!token) {
    res.status(401).json({ error: "Token ausente" });
    return;
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || "dev-secret");
    const admin = getDatabase()
      .prepare("SELECT id, email, name, created_at AS createdAt FROM admins WHERE id = ?")
      .get(payload.sub);

    if (!admin) {
      res.status(401).json({ error: "Usuario nao encontrado" });
      return;
    }

    req.user = admin;
    next();
  } catch (_error) {
    res.status(401).json({ error: "Token invalido" });
  }
}

module.exports = authMiddleware;

