CREATE TABLE IF NOT EXISTS user_pins (
  telegram_id TEXT NOT NULL,
  portfolio_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (telegram_id, portfolio_id),
  FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
);
