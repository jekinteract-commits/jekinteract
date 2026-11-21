-- JekInteract license database (Cloudflare D1 / SQLite)
-- Jalankan:
--   npx wrangler d1 execute jek-license --file=license-server/schema.sql
-- Untuk database lokal (testing):
--   npx wrangler d1 execute jek-license --local --file=license-server/schema.sql

CREATE TABLE IF NOT EXISTS keys (
  key          TEXT PRIMARY KEY,
  note         TEXT NOT NULL DEFAULT '',
  days         INTEGER NOT NULL,
  max_devices  INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked      INTEGER NOT NULL DEFAULT 0,
  revoked_at   TEXT
);

CREATE TABLE IF NOT EXISTS devices (
  key         TEXT NOT NULL,
  hwid        TEXT NOT NULL,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  PRIMARY KEY (key, hwid),
  FOREIGN KEY (key) REFERENCES keys(key)
);

CREATE INDEX IF NOT EXISTS idx_devices_key ON devices(key);
CREATE INDEX IF NOT EXISTS idx_keys_expires ON keys(expires_at);
