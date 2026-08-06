const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const { DatabaseSync } = require("node:sqlite");

let db;

function getDatabase() {
  if (!db) {
    initializeDatabase();
  }
  return db;
}

function initializeDatabase() {
  const client = process.env.DATABASE_CLIENT || "sqlite";
  if (client !== "sqlite") {
    throw new Error("Apenas SQLite esta habilitado neste build local. Configure um adaptador PostgreSQL para VPS.");
  }

  const databaseFile = path.resolve(process.cwd(), process.env.SQLITE_DATABASE || "./data/mcall.sqlite");
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true });

  db = new DatabaseSync(databaseFile);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  runMigrations(db);
  seedAdmin(db);
  return db;
}

function runMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const migrationsDir = path.join(__dirname, "migrations");
  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const hasMigration = database.prepare("SELECT 1 AS found FROM schema_migrations WHERE filename = ?");
  const insertMigration = database.prepare("INSERT INTO schema_migrations (filename) VALUES (?)");

  for (const file of files) {
    if (hasMigration.get(file)) {
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    try {
      database.exec("BEGIN IMMEDIATE");
      database.exec(sql);
      insertMigration.run(file);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

function seedAdmin(database) {
  const email = String(process.env.ADMIN_EMAIL || "admin@mcall.local").trim().toLowerCase();
  const name = process.env.ADMIN_NAME || "Administrador";
  const password = process.env.ADMIN_PASSWORD || "admin123";
  const existing = database.prepare("SELECT id FROM admins WHERE email = ?").get(email);

  if (!existing) {
    const passwordHash = bcrypt.hashSync(password, 10);
    database
      .prepare("INSERT INTO admins (email, name, password_hash) VALUES (?, ?, ?)")
      .run(email, name, passwordHash);
  }
}

module.exports = {
  getDatabase,
  initializeDatabase
};

if (require.main === module) {
  require("dotenv").config();
  initializeDatabase();
  console.log("Banco inicializado com sucesso.");
}
