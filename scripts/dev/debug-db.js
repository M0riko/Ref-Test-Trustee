import Database from 'better-sqlite3';

const db = new Database('db.sqlite');
const rows = db.prepare("SELECT scenario, details FROM checks WHERE status='INCONCLUSIVE' LIMIT 5").all();
console.log(rows);
