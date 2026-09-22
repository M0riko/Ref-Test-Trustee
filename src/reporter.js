import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '..', 'db.sqlite');
const reportPath = path.join(__dirname, '..', 'report.html');
const statusPath = path.join(__dirname, '..', 'status.json');

function generateReport() {
  if (!fs.existsSync(dbPath)) {
    console.error('Database not found. Please run npm start first.');
    return;
  }

  const db = new Database(dbPath);
  
  const run = db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get();
  if (!run) { console.log('No runs found.'); return; }

  const checks = db.prepare(`
    SELECT c.*, p.url FROM checks c JOIN pages p ON c.page_id = p.id
    WHERE c.run_id = ? ORDER BY p.url, c.scenario
  `).all(run.id);

  // Global stats
  const stats = { PASS: 0, FAIL: 0, NO_STORE_LINK: 0, INCONCLUSIVE: 0, total: checks.length };
  checks.forEach(c => {
    if (c.status === 'PASS') stats.PASS++;
    else if (c.status.startsWith('FAIL')) stats.FAIL++;
    else if (c.status === 'NO_STORE_LINK') stats.NO_STORE_LINK++;
    else stats.INCONCLUSIVE++;
  });

  // Split by device
  const desktopChecks = checks.filter(c => c.scenario.includes('_desktop'));
  const iosChecks = checks.filter(c => c.scenario.includes('_mobile_ios'));
  const androidChecks = checks.filter(c => c.scenario.includes('_mobile_android'));

  function buildRows(list) {
    return list.map(c => {
      let cls = c.status.startsWith('FAIL') ? 'status-FAIL' : `status-${c.status}`;
      let sc = c.scenario.replace(/_desktop$/, '').replace(/_mobile_ios$/, '').replace(/_mobile_android$/, '');
      return `<tr>
        <td><a href="${c.url}" target="_blank">${new URL(c.url).pathname}</a></td>
        <td><strong>${sc}</strong></td>
        <td class="${cls}">${c.status}</td>
        <td>${c.expected_key || '—'}</td>
        <td>${c.actual_key || '—'}</td>
        <td class="details">${c.details || ''}</td>
      </tr>`;
    }).join('\n');
  }

  function calcStats(list) {
    const s = { PASS: 0, FAIL: 0, NO_STORE_LINK: 0, INCONCLUSIVE: 0 };
    list.forEach(c => {
      if (c.status === 'PASS') s.PASS++;
      else if (c.status.startsWith('FAIL')) s.FAIL++;
      else if (c.status === 'NO_STORE_LINK') s.NO_STORE_LINK++;
      else s.INCONCLUSIVE++;
    });
    return s;
  }

  const dS = calcStats(desktopChecks);
  const iS = calcStats(iosChecks);
  const aS = calcStats(androidChecks);

  function section(title, badge, cls, list, st) {
    if (!list.length) return '';
    return `
  <h2><span class="device-badge ${cls}">${badge}</span> ${title} (${list.length} checks)</h2>
  <div class="card summary" style="margin-bottom:14px">
    <div class="stat stat-pass"><small>PASS</small><strong>${st.PASS}</strong></div>
    <div class="stat stat-fail"><small>FAIL</small><strong>${st.FAIL}</strong></div>
    <div class="stat stat-nolink"><small>No link</small><strong>${st.NO_STORE_LINK}</strong></div>
    <div class="stat stat-inconclusive"><small>Inconclusive</small><strong>${st.INCONCLUSIVE}</strong></div>
  </div>
  <table>
    <thead><tr><th>Page</th><th>Scenario</th><th>Status</th><th>Expected</th><th>Actual</th><th>Details</th></tr></thead>
    <tbody>${buildRows(list)}</tbody>
  </table>`;
  }

  const html = `<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <title>Trustee Referral Monitor — Report</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:20px 30px}
    h1{color:#f1f5f9;font-size:1.8em;margin-bottom:5px}
    h2{color:#94a3b8;font-size:1.3em;margin-top:30px;border-bottom:1px solid #334155;padding-bottom:8px}
    .subtitle{color:#64748b;font-size:.95em;margin-bottom:20px}
    .card{background:#1e293b;border-radius:10px;padding:18px 22px;box-shadow:0 2px 8px rgba(0,0,0,.3);margin-bottom:20px}
    .summary{display:flex;gap:14px;flex-wrap:wrap}
    .stat{background:#0f172a;padding:14px;border-radius:8px;flex:1;min-width:120px;text-align:center;border:1px solid #334155}
    .stat strong{display:block;font-size:28px;margin-top:4px}
    .stat-pass strong{color:#34d399} .stat-fail strong{color:#f87171}
    .stat-nolink strong{color:#94a3b8} .stat-inconclusive strong{color:#fbbf24}
    .stat-total strong{color:#818cf8} .stat small{color:#94a3b8;font-size:.85em}
    table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:10px;overflow:hidden;margin-bottom:25px}
    th,td{padding:10px 14px;text-align:left;border-bottom:1px solid #334155;font-size:.9em}
    th{background:#334155;font-weight:600;color:#cbd5e1}
    tr:hover{background:#334155}
    a{color:#818cf8;text-decoration:none} a:hover{text-decoration:underline}
    .status-PASS{color:#34d399;font-weight:bold} .status-FAIL{color:#f87171;font-weight:bold}
    .status-NO_STORE_LINK{color:#94a3b8} .status-INCONCLUSIVE{color:#fbbf24;font-weight:bold}
    .details{font-size:.82em;color:#94a3b8;max-width:400px;word-wrap:break-word}
    .device-badge{display:inline-block;padding:3px 10px;border-radius:12px;font-size:.8em;font-weight:600;margin-right:6px}
    .badge-desktop{background:#312e81;color:#a5b4fc}
    .badge-ios{background:#064e3b;color:#6ee7b7}
    .badge-android{background:#713f12;color:#fde68a}
    footer{text-align:center;color:#475569;font-size:.85em;padding:20px 0}
  </style>
</head>
<body>
  <h1>🔍 Trustee Referral Monitor</h1>
  <p class="subtitle">Run #${run.id} | Started: ${run.started_at} UTC | Status: ${run.status}</p>
  <div class="card summary">
    <div class="stat stat-total"><small>Total checks</small><strong>${stats.total}</strong></div>
    <div class="stat stat-pass"><small>PASS</small><strong>${stats.PASS}</strong></div>
    <div class="stat stat-fail"><small>FAIL</small><strong>${stats.FAIL}</strong></div>
    <div class="stat stat-nolink"><small>No store link</small><strong>${stats.NO_STORE_LINK}</strong></div>
    <div class="stat stat-inconclusive"><small>Inconclusive</small><strong>${stats.INCONCLUSIVE}</strong></div>
  </div>
  ${section('Desktop', '🖥️ Desktop', 'badge-desktop', desktopChecks, dS)}
  ${section('Mobile — iOS (iPhone 13)', '📱 iOS', 'badge-ios', iosChecks, iS)}
  ${section('Mobile — Android (Pixel 5)', '🤖 Android', 'badge-android', androidChecks, aS)}
  <footer>Generated by Trustee Referral Monitor | ${new Date().toISOString()}</footer>
</body>
</html>`;

  fs.writeFileSync(reportPath, html);
  console.log('HTML report generated:', reportPath);

  // status.json for monitoring
  const statusData = {
    run_id: run.id, started_at: run.started_at, finished_at: run.finished_at,
    run_status: run.status, total_checks: stats.total,
    pass: stats.PASS, fail: stats.FAIL, no_store_link: stats.NO_STORE_LINK, inconclusive: stats.INCONCLUSIVE,
    overall: stats.FAIL > 0 ? 'FAIL' : (stats.INCONCLUSIVE > 0 ? 'WARN' : 'PASS'),
    desktop: dS, mobile_ios: iS, mobile_android: aS,
    generated_at: new Date().toISOString()
  };
  fs.writeFileSync(statusPath, JSON.stringify(statusData, null, 2));
  console.log('Status JSON generated:', statusPath);
}

generateReport();
