import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getConsecutiveFailures } from './storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '..', 'db.sqlite');
const reportPath = path.join(__dirname, '..', 'report.html');
const statusPath = path.join(__dirname, '..', 'status.json');

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

export function generateReport() {
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

  const pages = db.prepare(`SELECT * FROM pages WHERE run_id = ?`).all(run.id);
  const crawlErrors = db.prepare(`SELECT * FROM crawl_errors WHERE run_id = ?`).all(run.id);
  const consecutiveFailures = getConsecutiveFailures();

  // Global stats
  const stats = { PASS: 0, FAIL: 0, NO_STORE_LINK: 0, INCONCLUSIVE: 0, total: checks.length };
  const inapplicables = ['NO_STORE_LINK', 'NO_INTERNAL_LINK', 'STOP_CHAIN', 'NO_FORM'];
  checks.forEach(c => {
    if (c.status === 'PASS') stats.PASS++;
    else if (c.status.startsWith('FAIL')) stats.FAIL++;
    else if (inapplicables.includes(c.status)) stats.NO_STORE_LINK++;
    else stats.INCONCLUSIVE++;
  });

  const desktopChecks  = checks.filter(c => c.scenario.endsWith('_desktop'));
  const macChecks      = checks.filter(c => c.scenario.endsWith('_desktop_mac'));
  const iosChecks      = checks.filter(c => c.scenario.endsWith('_mobile_ios'));
  const androidChecks  = checks.filter(c => c.scenario.endsWith('_mobile_android'));
  
  const dS = calcStats(desktopChecks);
  const mS = calcStats(macChecks);
  const iS = calcStats(iosChecks);
  const aS = calcStats(androidChecks);

  // Group by URL for the matrix UI
  const checksByUrl = {};
  checks.forEach(c => {
    if (!checksByUrl[c.url]) checksByUrl[c.url] = [];
    checksByUrl[c.url].push(c);
  });

  // Helper to render a status cell
  function renderStatusCell(c) {
    if (!c) return '<td class="cell-empty">—</td>';
    let cls = c.status.startsWith('FAIL') ? 'status-FAIL' : `status-${c.status}`;
    let icon = c.status === 'PASS' ? '✅' : c.status.startsWith('FAIL') ? '❌' : inapplicables.includes(c.status) ? '⚪' : '⚠️';
    let text = c.status.startsWith('FAIL') ? 'FAIL' : c.status;
    
    // Create a CSS tooltip for errors
    let details = '';
    if (c.status.startsWith('FAIL') || c.status === 'INCONCLUSIVE' || inapplicables.includes(c.status)) {
      let safeDetails = (c.details || 'No details provided').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      let screenLink = c.screenshot_path ? `<br><br><a href="${c.screenshot_path}" target="_blank" style="color: #60a5fa; text-decoration: underline;">📸 View Screenshot</a>` : '';
      details = `<div class="tooltip">${safeDetails}<br><br><b>Expected:</b> ${c.expected_key || '—'}<br><b>Actual:</b> ${c.actual_key || '—'}${screenLink}</div>`;
      cls += ' has-tooltip';
    }
    
    return `<td class="${cls}">${icon} ${text}${details}</td>`;
  }

  let pagesHtml = '';
  for (const [url, urlChecks] of Object.entries(checksByUrl)) {
    const urlStats = calcStats(urlChecks);
    
    // Group by base scenario (S1, S2, etc)
    const scMap = {};
    urlChecks.forEach(c => {
      let sc = c.scenario.replace(/_desktop$/, '').replace(/_desktop_mac$/, '').replace(/_mobile_ios$/, '').replace(/_mobile_android$/, '');
      if (!scMap[sc]) scMap[sc] = {};
      
      if (c.scenario.endsWith('_desktop')) scMap[sc].win = c;
      else if (c.scenario.endsWith('_desktop_mac')) scMap[sc].mac = c;
      else if (c.scenario.endsWith('_mobile_ios')) scMap[sc].ios = c;
      else if (c.scenario.endsWith('_mobile_android')) scMap[sc].android = c;
    });

    const scenarioDescriptions = {
      'S1': 'Навігація з головної (через клік)',
      'S2': 'Прямий перехід за посиланням',
      'S3': 'Перезавантаження сторінки (F5)',
      'S4': 'Ланцюгова навігація (Multi-hop)',
      'S5': 'Заміна старого ключа новим',
      'S6': 'Контроль (захід без ключа)',
      'S7': 'Ключ зі спецсимволами',
      'S8': 'Виживання з UTM-мітками',
      'S9': 'Екстремально довгий ключ',
      'S10': 'Взаємодія з формою обміну (Exchange) — специфічно для сторінок з кнопкою купівлі/обміну'
    };

    let tbody = '';
    const sortedScenarios = Object.keys(scMap).sort();
    for (const sc of sortedScenarios) {
      const row = scMap[sc];
      const desc = scenarioDescriptions[sc] || '';
      tbody += `
        <tr>
          <td class="sc-name">
            <strong>${sc}</strong>
            <div class="sc-desc">${desc}</div>
          </td>
          ${renderStatusCell(row.win)}
          ${renderStatusCell(row.mac)}
          ${renderStatusCell(row.ios)}
          ${renderStatusCell(row.android)}
        </tr>
      `;
    }

    let pathname = '/';
    try { pathname = new URL(url).pathname || '/'; } catch {}

    pagesHtml += `
    <div class="page-card">
      <div class="page-header">
        <h3><a href="${url}" target="_blank">${pathname}</a></h3>
        <div class="page-stats">
          <span class="badge pass">✅ ${urlStats.PASS}</span>
          <span class="badge fail">❌ ${urlStats.FAIL}</span>
          <span class="badge nolink">⚪ ${urlStats.NO_STORE_LINK}</span>
          <span class="badge warn">⚠️ ${urlStats.INCONCLUSIVE}</span>
        </div>
      </div>
      <table class="matrix-table">
        <thead>
          <tr>
            <th width="20%">Scenario</th>
            <th width="20%">🖥️ Windows</th>
            <th width="20%">💻 Mac M1/M2</th>
            <th width="20%">📱 iOS</th>
            <th width="20%">🤖 Android</th>
          </tr>
        </thead>
        <tbody>
          ${tbody}
        </tbody>
      </table>
    </div>
    `;
  }

  // Add Crawl Errors block if any exist
  if (crawlErrors && crawlErrors.length > 0) {
    let errorRows = crawlErrors.map(e => `
      <tr>
        <td style="text-align: left; padding-left: 24px;"><a href="${e.url}" target="_blank" style="color: #f87171;">${e.url}</a></td>
        <td style="color: #94a3b8; text-align: left;">${(e.reason || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</td>
      </tr>
    `).join('');
    
    pagesHtml += `
    <div class="page-card" style="border-color: #7f1d1d;">
      <div class="page-header" style="background: #450a0a;">
        <h3 style="color: #fca5a5;">⚠️ Не вдалося перевірити (${crawlErrors.length} сторінок)</h3>
      </div>
      <div style="padding: 16px 24px; font-size: 0.9em; color: #fecaca; background: #2b0504;">
        Ці сторінки були знайдені, але їх не вдалося завантажити для перевірки (Timeout, 500 тощо).
      </div>
      <table class="matrix-table">
        <thead>
          <tr>
            <th width="40%">URL</th>
            <th width="60%">Причина помилки</th>
          </tr>
        </thead>
        <tbody>
          ${errorRows}
        </tbody>
      </table>
    </div>
    `;
  }

  // ── Monitor health badge ──
  const healthColor = consecutiveFailures === 0 ? '#10b981' : consecutiveFailures < 3 ? '#f59e0b' : '#ef4444';
  const healthLabel = consecutiveFailures === 0
    ? '✅ Monitor healthy'
    : `⚠️ ${consecutiveFailures} consecutive failure${consecutiveFailures > 1 ? 's' : ''}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Trustee Referral Monitor — Report</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; }
    body { font-family: 'Inter', sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 40px 20px; }
    .container { max-width: 1200px; margin: 0 auto; }
    
    /* Header */
    header { margin-bottom: 40px; text-align: center; }
    h1 { font-size: 2.5em; font-weight: 700; margin: 0 0 10px 0; letter-spacing: -0.5px; background: linear-gradient(90deg, #818cf8, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .subtitle { color: #94a3b8; font-size: 1.05em; margin: 0 0 20px 0; }
    .health-badge { display: inline-flex; align-items: center; padding: 6px 16px; border-radius: 20px; font-size: 0.9em; font-weight: 600; background: #1e293b; border: 1px solid #334155; color: ${healthColor}; box-shadow: 0 2px 10px rgba(0,0,0,0.2); }
    
    /* Global Stats */
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 50px; }
    .stat-card { background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 24px; text-align: center; box-shadow: 0 4px 20px -2px rgba(0, 0, 0, 0.2); transition: transform 0.2s, border-color 0.2s; }
    .stat-card:hover { transform: translateY(-3px); border-color: #475569; }
    .stat-title { color: #94a3b8; font-size: 0.85em; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; }
    .stat-value { display: block; font-size: 3em; font-weight: 700; margin-top: 10px; line-height: 1; }
    .val-total { color: #818cf8; } .val-pass { color: #34d399; } .val-fail { color: #f87171; } .val-nolink { color: #cbd5e1; } .val-warn { color: #fbbf24; }

    /* Page Cards */
    .page-card { background: #1e293b; border: 1px solid #334155; border-radius: 16px; margin-bottom: 30px; overflow: hidden; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.2); }
    .page-header { background: #0f172a; border-bottom: 1px solid #334155; padding: 18px 24px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 15px; }
    .page-header h3 { margin: 0; font-size: 1.2em; font-weight: 600; }
    .page-header a { color: #e2e8f0; text-decoration: none; transition: color 0.2s; }
    .page-header a:hover { color: #818cf8; text-decoration: underline; }
    .page-stats { display: flex; gap: 8px; }
    .badge { padding: 6px 12px; border-radius: 8px; font-size: 0.85em; font-weight: 600; border: 1px solid transparent; }
    .badge.pass { background: rgba(52, 211, 153, 0.1); color: #34d399; border-color: rgba(52, 211, 153, 0.2); }
    .badge.fail { background: rgba(248, 113, 113, 0.1); color: #f87171; border-color: rgba(248, 113, 113, 0.2); }
    .badge.nolink { background: rgba(148, 163, 184, 0.1); color: #94a3b8; border-color: rgba(148, 163, 184, 0.2); }
    .badge.warn { background: rgba(251, 191, 36, 0.1); color: #fbbf24; border-color: rgba(251, 191, 36, 0.2); }

    /* Matrix Table */
    .matrix-table { width: 100%; border-collapse: collapse; }
    .matrix-table th { background: rgba(15, 23, 42, 0.5); color: #94a3b8; font-weight: 600; font-size: 0.85em; text-transform: uppercase; padding: 14px 16px; text-align: center; border-bottom: 1px solid #334155; letter-spacing: 0.5px; }
    .matrix-table th:first-child { text-align: left; padding-left: 24px; }
    .matrix-table td { padding: 14px 16px; text-align: center; border-bottom: 1px solid #334155; font-size: 0.95em; vertical-align: middle; transition: background 0.15s; }
    .matrix-table tr:last-child td { border-bottom: none; }
    .matrix-table tr:hover td { background: rgba(255, 255, 255, 0.03); }
    .sc-name { text-align: left !important; color: #e2e8f0; padding-left: 24px !important; }
    .sc-desc { font-size: 0.85em; color: #94a3b8; font-weight: 400; margin-top: 6px; line-height: 1.3; }
    
    /* Status Cells */
    .status-PASS { color: #34d399; font-weight: 600; }
    .status-FAIL { color: #f87171; font-weight: 600; background: rgba(248, 113, 113, 0.03); }
    .status-NO_STORE_LINK { color: #64748b; }
    .status-INCONCLUSIVE { color: #fbbf24; font-weight: 600; }
    .cell-empty { color: #334155; }

    /* Tooltips for Fails */
    .has-tooltip { position: relative; cursor: pointer; }
    .has-tooltip::after { content: ''; position: absolute; bottom: 8px; right: 8px; width: 0; height: 0; border-style: solid; border-width: 0 0 6px 6px; border-color: transparent transparent #f87171 transparent; opacity: 0.5; }
    .tooltip { visibility: hidden; width: 260px; background-color: #1e293b; color: #f8fafc; text-align: left; border-radius: 8px; padding: 12px 16px; position: absolute; z-index: 10; bottom: calc(100% + 5px); left: 50%; transform: translateX(-50%) translateY(10px); opacity: 0; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); font-size: 0.85em; font-weight: 400; border: 1px solid #475569; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5); pointer-events: none; line-height: 1.5; }
    .tooltip::before { content: ""; position: absolute; top: 100%; left: 50%; margin-left: -6px; border-width: 6px; border-style: solid; border-color: #475569 transparent transparent transparent; }
    .has-tooltip:hover .tooltip { visibility: visible; opacity: 1; transform: translateX(-50%) translateY(0); pointer-events: auto; }

    footer { text-align: center; color: #64748b; font-size: 0.9em; margin-top: 60px; border-top: 1px solid #334155; padding-top: 30px; padding-bottom: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Trustee Referral Monitor</h1>
      <p class="subtitle">Run #${run.id} &bull; Started: ${run.started_at} UTC</p>
      <div class="health-badge">${healthLabel}</div>
    </header>

    <div class="summary-grid">
      <div class="stat-card">
        <span class="stat-title">Total Checks</span>
        <span class="stat-value val-total">${stats.total}</span>
      </div>
      <div class="stat-card">
        <span class="stat-title">PASS</span>
        <span class="stat-value val-pass">${stats.PASS}</span>
      </div>
      <div class="stat-card">
        <span class="stat-title">FAIL</span>
        <span class="stat-value val-fail">${stats.FAIL}</span>
      </div>
      <div class="stat-card">
        <span class="stat-title">No Store Link</span>
        <span class="stat-value val-nolink">${stats.NO_STORE_LINK}</span>
      </div>
      <div class="stat-card">
        <span class="stat-title">Inconclusive</span>
        <span class="stat-value val-warn">${stats.INCONCLUSIVE}</span>
      </div>
    </div>

    <div class="pages-container">
      ${pagesHtml}
    </div>

    <footer>
      Generated automatically by Playwright Monitor &bull; ${new Date().toISOString()}
    </footer>
  </div>
</body>
</html>`;

  fs.writeFileSync(reportPath, html);
  console.log('HTML report generated:', reportPath);

  // ── status.json — machine-readable monitor health ──────────────────────────
  const statusData = {
    run_id: run.id,
    started_at: run.started_at,
    finished_at: run.finished_at,
    run_status: run.status,
    total_checks: stats.total,
    pages_crawled: pages.length,
    pass: stats.PASS,
    fail: stats.FAIL,
    no_store_link: stats.NO_STORE_LINK,
    inconclusive: stats.INCONCLUSIVE,
    overall: stats.FAIL > 0 ? 'FAIL' : (stats.INCONCLUSIVE === stats.total ? 'INCONCLUSIVE' : 'PASS'),
    consecutive_failures: consecutiveFailures,   // ← key field for monitoring
    desktop: dS,
    desktop_mac: mS,
    mobile_ios: iS,
    mobile_android: aS,
    generated_at: new Date().toISOString()
  };
  fs.writeFileSync(statusPath, JSON.stringify(statusData, null, 2));
  console.log('Status JSON generated:', statusPath);
}

generateReport();
