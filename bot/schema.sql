CREATE TABLE IF NOT EXISTS guests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  name_key TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  attendance TEXT NOT NULL CHECK (attendance IN ('yes', 'no')),
  transfer_to INTEGER NOT NULL DEFAULT 0,
  transfer_from INTEGER NOT NULL DEFAULT 0,
  wishes TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_guests_created_at
  ON guests (created_at);

-- Один гость = одна анкета. Повторная отправка обновляет запись.
CREATE UNIQUE INDEX IF NOT EXISTS idx_guests_name_key
  ON guests (name_key);

CREATE TABLE IF NOT EXISTS contest (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  telegram_id INTEGER NOT NULL,
  username TEXT,
  first_name TEXT,
  file_id TEXT NOT NULL,
  file_type TEXT NOT NULL,
  code TEXT NOT NULL,
  is_winner INTEGER NOT NULL DEFAULT 0
);

-- Только один победитель. Второй INSERT с is_winner = 1 упадёт,
-- и Worker сохранит участника как обычную попытку.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contest_single_winner
  ON contest (is_winner)
  WHERE is_winner = 1;

CREATE INDEX IF NOT EXISTS idx_contest_created_at
  ON contest (created_at);

-- Все, кто хоть раз написал боту. Нужны для рассылок и напоминаний.
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

-- Черновики рассылок: сначала предпросмотр, потом подтверждение.
CREATE TABLE IF NOT EXISTS broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  text TEXT NOT NULL,
  sent_at TEXT
);

-- Служебные значения: состояние мониторинга и прочее.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
