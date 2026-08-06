ALTER TABLE tickets ADD COLUMN inactivity_minutes INTEGER;

CREATE INDEX IF NOT EXISTS idx_tickets_inactivity_minutes ON tickets(inactivity_minutes);
