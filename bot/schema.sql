CREATE TABLE IF NOT EXISTS guests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  name TEXT NOT NULL,
  attendance TEXT NOT NULL CHECK (attendance IN ('yes', 'no')),
  transfer_to INTEGER NOT NULL DEFAULT 0,
  transfer_from INTEGER NOT NULL DEFAULT 0,
  wishes TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_guests_created_at
  ON guests (created_at);

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
