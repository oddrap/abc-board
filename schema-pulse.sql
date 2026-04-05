-- ABC Pulse: Portfolio Management Tables

-- Portfolios table
CREATE TABLE IF NOT EXISTS portfolios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'stale', 'dead', 'scraping', 'archived')),
  assignee_name TEXT,
  assignee_telegram_id TEXT,
  logo_url TEXT,
  gdrive_folder_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  last_update_at TEXT
);

-- Portfolio updates table
CREATE TABLE IF NOT EXISTS portfolio_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  portfolio_id INTEGER NOT NULL,
  author_name TEXT NOT NULL,
  author_telegram_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  update_date TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
);

-- File attachments table
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  update_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  file_type TEXT,
  gdrive_url TEXT NOT NULL,
  gdrive_file_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (update_id) REFERENCES portfolio_updates(id) ON DELETE CASCADE
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_portfolios_status ON portfolios(status);
CREATE INDEX IF NOT EXISTS idx_updates_portfolio ON portfolio_updates(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_updates_date ON portfolio_updates(update_date DESC);
CREATE INDEX IF NOT EXISTS idx_attachments_update ON attachments(update_id);
