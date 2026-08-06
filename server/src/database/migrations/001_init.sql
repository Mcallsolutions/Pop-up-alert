CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

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

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tickets_tag_status ON tickets(tag_status);
CREATE INDEX IF NOT EXISTS idx_tickets_collected_at ON tickets(collected_at);
CREATE INDEX IF NOT EXISTS idx_tickets_attendant ON tickets(attendant);
CREATE INDEX IF NOT EXISTS idx_tickets_queue_name ON tickets(queue_name);
CREATE INDEX IF NOT EXISTS idx_tickets_company ON tickets(company);
CREATE INDEX IF NOT EXISTS idx_snapshots_collected_at ON snapshots(collected_at);

