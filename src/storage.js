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

export function getDb() {
  return initDB();
}
