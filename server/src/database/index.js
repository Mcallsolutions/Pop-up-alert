// Banco local em SQLite (modulo node:sqlite, embutido no Node 22.5+), sem
// servidor de banco para instalar.
//
// Os servicos usam uma interface assincrona (prepare().get/all/run e
// transaction) para nao depender do driver. As chamadas ao SQLite sao
// sincronas por baixo, entao uma transacao nunca intercala comandos de outra
// requisicao: nao ha I/O entre o BEGIN e o COMMIT.

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_DATABASE_PATH = path.resolve(__dirname, "../../data/monitor.sqlite");

let initializationPromise;

async function getDatabase() {
  return initializeDatabase();
}

async function initializeDatabase() {
  if (!initializationPromise) {
    initializationPromise = Promise.resolve()
      .then(() => createSqliteDatabase(getDatabasePath()))
      .catch((error) => {
        initializationPromise = undefined;
        throw error;
      });
  }

  return initializationPromise;
}

function getDatabasePath() {
  const configured = String(process.env.SQLITE_PATH || "").trim();
  return configured ? path.resolve(process.cwd(), configured) : DEFAULT_DATABASE_PATH;
}

function createSqliteDatabase(filename) {
  const { DatabaseSync } = require("node:sqlite");

  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const connection = new DatabaseSync(filename);

  connection.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);

  const database = {
    client: "sqlite",
    filename,
    prepare(sql) {
      const statement = connection.prepare(sql);
      return {
        async get(...args) {
          return statement.get(...toParams(args)) || null;
        },
        async all(...args) {
          return statement.all(...toParams(args));
        },
        async run(...args) {
          const result = statement.run(...toParams(args));
          return {
            changes: Number(result.changes || 0),
            lastInsertRowid: Number(result.lastInsertRowid || 0)
          };
        }
      };
    },
    async exec(sql) {
      connection.exec(sql);
    },
    async transaction(callback) {
      connection.exec("BEGIN");
      try {
        const result = await callback(database);
        connection.exec("COMMIT");
        return result;
      } catch (error) {
        connection.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      connection.close();
    }
  };

  runMigrations(connection);
  return database;
}

// O driver nao aceita undefined nem boolean.
function toParams(args) {
  return args.map((value) => {
    if (value === undefined) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    return value;
  });
}

// Roda na conexao crua (sincrona), antes de a API aceitar requisicoes.
function runMigrations(connection) {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const hasMigration = connection.prepare("SELECT 1 AS found FROM schema_migrations WHERE filename = ?");
  const register = connection.prepare("INSERT INTO schema_migrations (filename) VALUES (?)");

  for (const [filename, sql] of Object.entries(MIGRATIONS)) {
    if (hasMigration.get(filename)) {
      continue;
    }

    connection.exec("BEGIN");
    try {
      connection.exec(sql);
      register.run(filename);
      connection.exec("COMMIT");
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
  }
}

// Para adicionar uma migration, crie uma nova chave — nunca edite uma que ja
// rodou.
const MIGRATIONS = {
  "001_schema.sql": `
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      source_url TEXT NOT NULL,
      collected_at TEXT NOT NULL,
      total_tickets INTEGER NOT NULL DEFAULT 0,
      total_with_tag INTEGER NOT NULL DEFAULT 0,
      total_without_tag INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Uma linha por ticket por coleta. external_ticket_id e o id do ticket no
    -- MTalk; os relatorios mantem so a leitura mais recente de cada um.
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      external_ticket_id TEXT NOT NULL,
      ticket_uuid TEXT,
      ticket_status TEXT,
      client_name TEXT,
      queue_name TEXT,
      attendant TEXT,
      company TEXT,
      display_time TEXT,
      last_message_at TEXT,
      unread_messages INTEGER,
      inactivity_minutes INTEGER,
      tag TEXT,
      tags TEXT,
      tag_status TEXT NOT NULL CHECK (tag_status IN ('COM_TAG', 'SEM_TAG')),
      source_url TEXT NOT NULL,
      collected_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_collected_at ON snapshots(collected_at);
    CREATE INDEX IF NOT EXISTS idx_tickets_collected_at ON tickets(collected_at);
    CREATE INDEX IF NOT EXISTS idx_tickets_external_collected_at ON tickets(external_ticket_id, collected_at);
    CREATE INDEX IF NOT EXISTS idx_tickets_queue_name ON tickets(queue_name);
    CREATE INDEX IF NOT EXISTS idx_tickets_attendant ON tickets(attendant);
    CREATE INDEX IF NOT EXISTS idx_tickets_company ON tickets(company);
    CREATE INDEX IF NOT EXISTS idx_tickets_tag_status ON tickets(tag_status);
    CREATE INDEX IF NOT EXISTS idx_tickets_inactivity_minutes ON tickets(inactivity_minutes);

    CREATE TABLE IF NOT EXISTS ai_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('INSTRUCAO', 'TREINAMENTO')),
      content TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_ai_prompts_kind ON ai_prompts(kind, is_active);

    CREATE TABLE IF NOT EXISTS ai_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT,
      filters TEXT,
      content TEXT NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_ai_summaries_created_at ON ai_summaries(created_at);
  `,
  "002_api_tokens.sql": `
    -- Tokens de acesso a ESTA API. Nada a ver com MTALK_TOKEN, que continua
    -- unico, no .env e usado so pela coleta: aqui o token apenas recorta o que
    -- cada pessoa le do que ja foi coletado.
    --
    -- Guardamos so o SHA-256 do token; o valor cru aparece uma unica vez, na
    -- criacao. attendant vazio = ve tudo (perfil ADMIN).
    CREATE TABLE IF NOT EXISTS api_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      attendant TEXT,
      role TEXT NOT NULL DEFAULT 'ATENDENTE' CHECK (role IN ('ADMIN', 'ATENDENTE')),
      token_hash TEXT NOT NULL UNIQUE,
      token_hint TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_used_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_api_tokens_is_active ON api_tokens(is_active);
  `
};

module.exports = {
  getDatabase,
  initializeDatabase
};

if (require.main === module) {
  require("dotenv").config();
  initializeDatabase()
    .then((database) => {
      console.log(`Banco inicializado com sucesso em ${database.filename}.`);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
