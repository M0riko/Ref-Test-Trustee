import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '..', 'db.sqlite');
const reportPath = path.join(__dirname, '..', 'report.html');

function generateReport() {
  if (!fs.existsSync(dbPath)) {
    console.error('Database not found. Please run npm start first.');
    return;
  }

  const db = new Database(dbPath);
  
  // Get latest run
  const run = db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get();
  if (!run) {
    console.log('No runs found in database.');
    return;
  }

  // Get checks for this run
  const checks = db.prepare(`
    SELECT c.*, p.url 
    FROM checks c 
    JOIN pages p ON c.page_id = p.id 
    WHERE c.run_id = ?
    ORDER BY p.url, c.scenario
  `).all(run.id);

  // Calculate stats
  const stats = { PASS: 0, FAIL: 0, NO_STORE_LINK: 0, INCONCLUSIVE: 0 };
  checks.forEach(c => {
    if (c.status === 'PASS') stats.PASS++;
    else if (c.status.startsWith('FAIL')) stats.FAIL++;
    else if (c.status === 'NO_STORE_LINK') stats.NO_STORE_LINK++;
    else stats.INCONCLUSIVE++;
  });

  let rows = '';
  checks.forEach(c => {
    let statusClass = `status-${c.status}`;
    if (c.status.startsWith('FAIL')) statusClass = 'status-FAIL';
    
    rows += `
      <tr>
        <td><a href="${c.url}" target="_blank">${new URL(c.url).pathname}</a></td>
        <td><strong>${c.scenario}</strong></td>
        <td class="${statusClass}">${c.status}</td>
        <td>${c.expected_key || '-'}</td>
        <td>${c.actual_key || '-'}</td>
        <td class="details">${c.details || ''}</td>
      </tr>
    `;
  });

  const html = `<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <title>Trustee Referral Monitor</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f3f4f6; color: #111827; margin: 0; padding: 20px; }
    h1 { margin-top: 0; }
    .card { background: white; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 20px; }
    .summary { display: flex; gap: 20px; flex-wrap: wrap; }
    .stat { background: #f9fafb; padding: 15px; border-radius: 6px; flex: 1; min-width: 150px; text-align: center; border: 1px solid #e5e7eb; }
    .stat strong { display: block; font-size: 24px; color: #4f46e5; margin-top: 5px; }
    table { width: 100%; border-collapse: collapse; background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.1); border-radius: 8px; overflow: hidden; }
    th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #e5e7eb; }
    th { background-color: #f9fafb; font-weight: 600; color: #374151; }
    tr:hover { background-color: #f9fafb; }
    .status-PASS { color: #059669; font-weight: bold; }
    .status-FAIL { color: #dc2626; font-weight: bold; }
    .status-NO_STORE_LINK { color: #6b7280; }
    .status-INCONCLUSIVE { color: #d97706; font-weight: bold; }
    .details { font-size: 0.9em; color: #6b7280; max-width: 400px; word-wrap: break-word; }
  </style>
</head>
<body>
  <h1>Trustee Referral Monitor</h1>
  
  <div class="card summary">
    <div class="stat">Запуск #<strong>${run.id}</strong><br><small>${run.started_at}</small></div>
    <div class="stat">Успішно (PASS)<strong>${stats.PASS}</strong></div>
    <div class="stat">Помилки (FAIL)<strong>${stats.FAIL}</strong></div>
    <div class="stat">Немає лінків<strong>${stats.NO_STORE_LINK}</strong></div>
    <div class="stat">Збої<strong>${stats.INCONCLUSIVE}</strong></div>
  </div>

  <h2>Детальні результати</h2>
  <table>
    <thead>
      <tr>
        <th>Сторінка</th>
        <th>Сценарій</th>
        <th>Статус</th>
        <th>Очікуваний ключ</th>
        <th>Фактичний ключ</th>
        <th>Деталі</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</body>
</html>`;

  fs.writeFileSync(reportPath, html);
  console.log('Report generated at:', reportPath);
}

generateReport();
