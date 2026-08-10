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
