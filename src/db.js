'use strict';
// SQLite database (uses Node's built-in node:sqlite, so no native build step).
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(config.dataDir, 'app.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

// All times are stored as ISO-8601 strings in UTC (e.g. 2026-10-27T18:00:00.000Z).
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name     TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pl_number     TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contests (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  start_at           TEXT NOT NULL,
  end_at             TEXT NOT NULL,
  timezone           TEXT NOT NULL DEFAULT 'UTC',
  visible            INTEGER NOT NULL DEFAULT 0,
  leaderboard_type   TEXT NOT NULL DEFAULT 'short',   -- short | long | adaptive
  penalty_per_wrong  INTEGER NOT NULL DEFAULT 10,     -- long: minutes added per wrong attempt on a solved problem
  decay_per_minute   REAL NOT NULL DEFAULT 1,         -- adaptive: points a problem loses every minute
  wrong_penalty_pts  REAL NOT NULL DEFAULT 0,         -- adaptive: points subtracted per wrong attempt (optional)
  show_code_after    INTEGER NOT NULL DEFAULT 0,      -- everyone can read everyone's code once the contest ends
  show_editorial     INTEGER NOT NULL DEFAULT 1,      -- show editorials / reference solutions once the contest ends
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS problems (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id        INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  ord               INTEGER NOT NULL DEFAULT 0,
  title             TEXT NOT NULL,
  statement         TEXT NOT NULL DEFAULT '',
  editorial         TEXT NOT NULL DEFAULT '',
  solution_code     TEXT NOT NULL DEFAULT '',
  solution_language TEXT NOT NULL DEFAULT 'cpp',
  time_limit_ms     INTEGER NOT NULL DEFAULT 1000,
  memory_limit_mb   INTEGER NOT NULL DEFAULT 256,
  points            REAL NOT NULL DEFAULT 100,        -- adaptive: maximum points for this problem
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_problems_contest ON problems(contest_id, ord);

CREATE TABLE IF NOT EXISTS tests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id      INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  ord             INTEGER NOT NULL DEFAULT 0,
  input           TEXT NOT NULL DEFAULT '',
  expected_output TEXT NOT NULL DEFAULT '',
  is_example      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tests_problem ON tests(problem_id, ord);

CREATE TABLE IF NOT EXISTS contest_entries (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  entered_at TEXT NOT NULL,
  PRIMARY KEY (user_id, contest_id)
);

CREATE TABLE IF NOT EXISTS submissions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,   -- NULL for admin test runs
  contest_id     INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  problem_id     INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  language       TEXT NOT NULL,                                     -- cpp | python | java
  source         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'queued',                    -- queued | judging | done
  verdict        TEXT,                                              -- AC | WA | CE | RE | TLE | MLE | IE
  failed_test    INTEGER,                                           -- 1-based index of the first failing test
  tests_passed   INTEGER NOT NULL DEFAULT 0,
  tests_total    INTEGER NOT NULL DEFAULT 0,
  time_ms        INTEGER,                                           -- max CPU time over tests
  memory_kb      INTEGER,                                           -- max resident memory over tests
  compile_output TEXT,
  judge_log      TEXT,                                              -- JSON: per-test results
  invalidated    INTEGER NOT NULL DEFAULT 0,                        -- admin removed it from standings
  admin_test     INTEGER NOT NULL DEFAULT 0,                        -- admin "test run", never shown to students
  submitted_at   TEXT NOT NULL,
  judged_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_sub_contest ON submissions(contest_id, submitted_at);
CREATE INDEX IF NOT EXISTS idx_sub_user ON submissions(user_id, submitted_at);
CREATE INDEX IF NOT EXISTS idx_sub_problem ON submissions(problem_id);
CREATE INDEX IF NOT EXISTS idx_sub_status ON submissions(status);
`);

const nowIso = () => new Date().toISOString();

// Runs fn inside a transaction; rolls back if it throws.
function transaction(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
}

module.exports = { db, nowIso, transaction };
