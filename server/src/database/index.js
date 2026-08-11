const bcrypt = require("bcryptjs");

let initializationPromise;

async function getDatabase() {
  return initializeDatabase();
}

async function initializeDatabase() {
  if (!initializationPromise) {
    initializationPromise = Promise.resolve()
      .then(async () => {
        const database = createPostgresDatabase();
        await database.initialize();
        return database;
      })
      .catch((error) => {
        initializationPromise = undefined;
        throw error;
      });
  }

  return initializationPromise;
}

function isServerless() {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

function createPostgresDatabase() {
  const { Pool } = require("pg");
  const connectionString = getPostgresUrl();

  if (!connectionString) {
    throw new Error(
      "DATABASE_URL ou POSTGRES_URL precisa ser configurado. Na Vercel, conecte um Postgres em Storage; " +
        "no ambiente local, aponte para um Postgres proprio."
    );
  }

  const pool = new Pool({
    connectionString,
    ssl: getPostgresSslConfig(connectionString),
    // Em serverless cada instancia atende uma requisicao por vez, entao manter
    // um pool grande so consome conexoes do banco a toa.
    max: isServerless() ? 1 : 10,
    idleTimeoutMillis: isServerless() ? 5000 : 10000,
    connectionTimeoutMillis: 10000
  });

  pool.on("error", (error) => {
    console.error("[DB] Erro no pool do PostgreSQL:", error.message);
  });

  const createQueryableDatabase = (queryable) => ({
    client: "postgres",
    async initialize() {
      await runMigrations(this);
      await seedAdmin(this);
    },
    prepare(sql) {
      return {
        async get(...args) {
          const { params } = splitArgs(args);
          const result = await queryable.query(toPostgresSql(sql), params);
          return result.rows[0] || null;
        },
        async all(...args) {
          const { params } = splitArgs(args);
          const result = await queryable.query(toPostgresSql(sql), params);
          return result.rows;
        },
        async run(...args) {
          const { params, options } = splitArgs(args);
          const result = await queryable.query(addReturning(toPostgresSql(sql), options.returning), params);
          const row = result.rows[0] || {};
          return {
            changes: result.rowCount,
            lastInsertRowid: row.id,
            row
          };
        }
      };
    },
    async exec(sql) {
      await queryable.query(sql);
    },
    async transaction(callback) {
      const client = await pool.connect();
      const transactionDatabase = createQueryableDatabase(client);

      try {
        await client.query("BEGIN");
        const result = await callback(transactionDatabase);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  });

  return createQueryableDatabase(pool);
}

async function runMigrations(database) {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const hasMigration = database.prepare("SELECT 1 AS found FROM schema_migrations WHERE filename = ?");

  for (const [filename, sql] of Object.entries(MIGRATIONS)) {
    if (await hasMigration.get(filename)) {
      continue;
    }

    await database.transaction(async (transaction) => {
      await transaction.exec(sql);
      await transaction.prepare("INSERT INTO schema_migrations (filename) VALUES (?)").run(filename);
    });
  }
}

// As variaveis de ambiente sao a unica fonte da credencial do painel — nao ha
// tela para trocar a senha. Por isso o seed nao pode so criar o admin: ele
// tambem re-sincroniza nome e senha quando ADMIN_* muda entre deploys. Sem
// isso, trocar ADMIN_PASSWORD nao surtia efeito algum e o login continuava
// respondendo "Credenciais invalidas" com a senha nova.
async function seedAdmin(activeDatabase) {
  const email = String(process.env.ADMIN_EMAIL || "admin@mcall.local").trim().toLowerCase();
  const name = process.env.ADMIN_NAME || "Administrador";
  const password = process.env.ADMIN_PASSWORD || "admin123";
  const existing = await activeDatabase
    .prepare('SELECT id, name, password_hash AS "passwordHash" FROM admins WHERE email = ?')
    .get(email);

  if (!existing) {
    await activeDatabase
      .prepare("INSERT INTO admins (email, name, password_hash) VALUES (?, ?, ?)")
      .run(email, name, bcrypt.hashSync(password, 10));
    console.log(`[DB] Admin ${email} criado a partir das variaveis ADMIN_*.`);
    return;
  }

  // O hash muda a cada chamada de hashSync (salt aleatorio), entao a comparacao
  // e feita contra o hash gravado — assim so ha escrita quando a senha mudou.
  const senhaMudou = !bcrypt.compareSync(password, existing.passwordHash);
  const nomeMudou = existing.name !== name;

  if (!senhaMudou && !nomeMudou) {
    return;
  }

  await activeDatabase
    .prepare("UPDATE admins SET name = ?, password_hash = ? WHERE id = ?")
    .run(name, senhaMudou ? bcrypt.hashSync(password, 10) : existing.passwordHash, existing.id);

  console.log(`[DB] Admin ${email} atualizado a partir das variaveis ADMIN_* (senha: ${senhaMudou ? "trocada" : "mantida"}).`);
}

function getPostgresUrl() {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    ""
  );
}

function getPostgresSslConfig(connectionString) {
  if (String(process.env.PGSSLMODE || "").toLowerCase() === "disable") {
    return false;
  }

  if (/localhost|127\.0\.0\.1/i.test(connectionString)) {
    return false;
  }

  return { rejectUnauthorized: false };
}

function splitArgs(args) {
  const values = [...args];
  const options = isRunOptions(values[values.length - 1]) ? values.pop() : {};
  const params = values.length === 1 && Array.isArray(values[0]) ? values[0] : values;
  return { params, options };
}

function isRunOptions(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(value, "returning")
  );
}

// As consultas sao escritas com "?" e convertidas para os placeholders
// numerados do PostgreSQL na hora de executar.
function toPostgresSql(sql) {
  let parameterIndex = 0;
  return String(sql)
    .replace(/\?/g, () => `$${++parameterIndex}`)
    .replace(/\bdatetime\(([^)]+)\)/gi, "($1::timestamptz)");
}

function addReturning(sql, returning) {
  if (!returning || /\bRETURNING\b/i.test(sql)) {
    return sql;
  }

  return `${String(sql).replace(/;+\s*$/, "")} RETURNING ${returning}`;
}

const MIGRATIONS = {
  "001_init.sql": `
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      source TEXT NOT NULL,
      source_url TEXT NOT NULL,
      collected_at TEXT NOT NULL,
      total_tickets INTEGER NOT NULL DEFAULT 0,
      total_with_tag INTEGER NOT NULL DEFAULT 0,
      total_without_tag INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      snapshot_id INTEGER NOT NULL,
      client_name TEXT,
      queue_name TEXT,
      attendant TEXT,
      company TEXT,
      display_time TEXT,
      tag TEXT,
      tag_status TEXT NOT NULL CHECK (tag_status IN ('COM_TAG', 'SEM_TAG')),
      source_url TEXT NOT NULL,
      collected_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
      FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tickets_tag_status ON tickets(tag_status);
    CREATE INDEX IF NOT EXISTS idx_tickets_collected_at ON tickets(collected_at);
    CREATE INDEX IF NOT EXISTS idx_tickets_attendant ON tickets(attendant);
    CREATE INDEX IF NOT EXISTS idx_tickets_queue_name ON tickets(queue_name);
    CREATE INDEX IF NOT EXISTS idx_tickets_company ON tickets(company);
    CREATE INDEX IF NOT EXISTS idx_snapshots_collected_at ON snapshots(collected_at);
  `,
  "002_ticket_key.sql": `
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ticket_key TEXT;

    UPDATE tickets
    SET ticket_key =
      lower(trim(coalesce(client_name, ''))) || '|' ||
      lower(trim(coalesce(queue_name, ''))) || '|' ||
      lower(trim(coalesce(attendant, ''))) || '|' ||
      lower(trim(coalesce(company, ''))) || '|' ||
      lower(trim(coalesce(display_time, '')))
    WHERE ticket_key IS NULL OR ticket_key = '';

    CREATE INDEX IF NOT EXISTS idx_tickets_ticket_key ON tickets(ticket_key);
    CREATE INDEX IF NOT EXISTS idx_tickets_key_collected_at ON tickets(ticket_key, collected_at);
  `,
  "003_inactivity_minutes.sql": `
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS inactivity_minutes INTEGER;

    CREATE INDEX IF NOT EXISTS idx_tickets_inactivity_minutes ON tickets(inactivity_minutes);
  `,
  "004_ai.sql": `
    CREATE TABLE IF NOT EXISTS ai_prompts (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      title TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('INSTRUCAO', 'TREINAMENTO')),
      content TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
      updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
    );

    CREATE INDEX IF NOT EXISTS idx_ai_prompts_kind ON ai_prompts(kind, is_active);

    CREATE TABLE IF NOT EXISTS ai_summaries (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      model TEXT,
      filters TEXT,
      content TEXT NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
    );

    CREATE INDEX IF NOT EXISTS idx_ai_summaries_created_at ON ai_summaries(created_at);
  `
};

module.exports = {
  getDatabase,
  initializeDatabase
};

if (require.main === module) {
  require("dotenv").config();
  initializeDatabase()
    .then(() => {
      console.log("Banco inicializado com sucesso.");
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
