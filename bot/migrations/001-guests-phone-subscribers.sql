-- Миграция существующей базы к версии с телефоном, подписчиками и рассылками.
-- Применять один раз:
--   wrangler d1 execute antoniolga-bot --remote --file=migrations/001-guests-phone-subscribers.sql

ALTER TABLE guests ADD COLUMN phone TEXT NOT NULL DEFAULT '';
ALTER TABLE guests ADD COLUMN name_key TEXT NOT NULL DEFAULT '';
ALTER TABLE guests ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

UPDATE guests
   SET name_key = lower(replace(replace(trim(name), 'ё', 'е'), ' ', ''))
 WHERE name_key = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_guests_name_key
  ON guests (name_key);

CREATE TABLE IF NOT EXISTS subscribers (
  telegram_id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  username TEXT,
  first_name TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscribers_last_seen
  ON subscribers (last_seen_at);

CREATE TABLE IF NOT EXISTS broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  text TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
