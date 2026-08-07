const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { getDatabase } = require("../database");
const authMiddleware = require("../middlewares/auth.middleware");

const router = express.Router();

router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      res.status(400).json({ error: "Email e senha sao obrigatorios" });
      return;
    }

    const database = await getDatabase();
    const admin = await database
      .prepare('SELECT id, email, name, password_hash AS "passwordHash" FROM admins WHERE email = ?')
      .get(String(email).trim().toLowerCase());

    if (!admin || !bcrypt.compareSync(String(password), admin.passwordHash)) {
      res.status(401).json({ error: "Credenciais invalidas" });
      return;
    }

    const token = jwt.sign(
      {
        sub: admin.id,
        email: admin.email
      },
      process.env.JWT_SECRET || "dev-secret",
      { expiresIn: process.env.JWT_EXPIRES_IN || "12h" }
    );

    res.json({
      token,
      user: {
        id: admin.id,
        email: admin.email,
        name: admin.name
      }
    });
  } catch (error) {
    next(error);
  }
});

router.get("/me", authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;

