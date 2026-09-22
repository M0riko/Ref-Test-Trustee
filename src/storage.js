import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '..', 'db.sqlite');

let db = null;

export function initDB() {
  if (db) return db;
  
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT DEFAULT 'RUNNING'
    );
    
    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      FOREIGN KEY (run_id) REFERENCES runs(id)
    );
    
    CREATE TABLE IF NOT EXISTS checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      page_id INTEGER NOT NULL,
      scenario TEXT NOT NULL,
      expected_key TEXT,
      actual_key TEXT,
      status TEXT NOT NULL,
      details TEXT,
      screenshot_path TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id),
      FOREIGN KEY (page_id) REFERENCES pages(id)
    );

    CREATE TABLE IF NOT EXISTS monitor_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS crawl_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id)
    );

    INSERT OR IGNORE INTO monitor_state (key, value) VALUES ('consecutive_failures', '0');
  `);
  
  return db;
}

export function startRun() {
  const db = initDB();
  const stmt = db.prepare(`INSERT INTO runs (started_at) VALUES (datetime('now'))`);
  const info = stmt.run();
  return info.lastInsertRowid;
}

export function finishRun(runId, status = 'COMPLETED') {
  const db = initDB();
  const stmt = db.prepare(`UPDATE runs SET finished_at = datetime('now'), status = ? WHERE id = ?`);
  stmt.run(status, runId);
}

export function savePage(runId, url, title = '') {
  const db = initDB();
  const stmt = db.prepare(`INSERT INTO pages (run_id, url, title) VALUES (?, ?, ?)`);
  const info = stmt.run(runId, url, title);
  return info.lastInsertRowid;
}

export function saveCheck(runId, pageId, scenario, expectedKey, actualKey, status, details = '', screenshotPath = null) {
  const db = initDB();
  const stmt = db.prepare(`
    INSERT INTO checks (run_id, page_id, scenario, expected_key, actual_key, status, details, screenshot_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  stmt.run(runId, pageId, scenario, expectedKey, actualKey, status, details, screenshotPath);
}

export function saveCrawlError(runId, url, reason) {
  const db = initDB();
  const stmt = db.prepare(`
    INSERT INTO crawl_errors (run_id, url, reason, created_at)
    VALUES (?, ?, ?, datetime('now'))
  `);
  stmt.run(runId, url, reason);
}

export function getDb() {
  return initDB();
}

// ─── Consecutive failure tracking ──────────────────────────────────────────
export function getConsecutiveFailures() {
  const db = initDB();
  const row = db.prepare(`SELECT value FROM monitor_state WHERE key = 'consecutive_failures'`).get();
  return row ? parseInt(row.value, 10) : 0;
}

export function incrementFailures() {
  const db = initDB();
  const current = getConsecutiveFailures();
  db.prepare(`UPDATE monitor_state SET value = ? WHERE key = 'consecutive_failures'`).run(String(current + 1));
}

export function resetFailures() {
  const db = initDB();
  db.prepare(`UPDATE monitor_state SET value = '0' WHERE key = 'consecutive_failures'`).run();
}
