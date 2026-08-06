ALTER TABLE tickets ADD COLUMN ticket_key TEXT;

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
