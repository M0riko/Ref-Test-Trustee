import { DatabaseSync as Database } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = process.env.NODE_ENV === 'test'
  ? path.join(__dirname, '..', 'test-db.sqlite')
  : path.join(__dirname, '..', 'db.sqlite');
const reportPath = path.join(__dirname, '..', 'report.html');
const statusPath = path.join(__dirname, '..', 'status.json');

const SKIPPED = new Set(['NO_STORE_LINK', 'NO_INTERNAL_LINK', 'STOP_CHAIN', 'NO_FORM']);

const scenarioDescriptions = {
  S1: 'Landing with key, then a real click to this page',
  S2: 'Direct visit with ?r=KEY (site must attach the key itself)',
  S3: 'Reload after landing with the key',
  S4: 'Two-hop click path from the homepage',
  S5: 'New referral key replaces the previous one',
  S6: 'Control visit without a referral key',
  S7: 'Key with special characters',
  S8: 'Key survives alongside UTM parameters',
  S9: 'Very long key',
  S10: 'Buy/exchange control that leads to a store',
};

function emptyStats() {
  return { PASS: 0, FAIL: 0, SKIPPED: 0, INCONCLUSIVE: 0 };
}

function addStat(s, status) {
  if (status === 'PASS') s.PASS++;
  else if (status.startsWith('FAIL')) s.FAIL++;
  else if (SKIPPED.has(status)) s.SKIPPED++;
  else s.INCONCLUSIVE++;
}

function calcStats(list) {
  const s = emptyStats();
  list.forEach(c => addStat(s, c.status));
  return s;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function relScreenshot(p) {
  if (!p) return '';
  const name = path.basename(p);
  return `screenshots/${name}`;
}

export function generateReport() {
  if (!fs.existsSync(dbPath)) {
    console.error('Database not found. Please run npm start first.');
    return;
  }

  const db = new Database(dbPath, { readonly: true });

  const run = db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get();
  if (!run) {
    console.log('No runs found.');
    db.close();
    return;
  }

  const checks = db.prepare(`
    SELECT c.*, p.url FROM checks c JOIN pages p ON c.page_id = p.id
    WHERE c.run_id = ? ORDER BY p.url, c.scenario
  `).all(run.id);

  const pages = db.prepare(`SELECT * FROM pages WHERE run_id = ?`).all(run.id);
  const crawlErrors = db.prepare(`SELECT * FROM crawl_errors WHERE run_id = ?`).all(run.id);
  const failRow = db.prepare(`SELECT value FROM monitor_state WHERE key = 'consecutive_failures'`).get();
  const consecutiveFailures = failRow ? parseInt(failRow.value, 10) : 0;

  let coverage = { pages: pages.length, sitemap: null, crawl_errors: crawlErrors.length, truncated: 0, edges: null };
  try {
    const row = db.prepare(`SELECT value FROM monitor_state WHERE key = 'last_coverage'`).get();
    if (row) coverage = { ...coverage, ...JSON.parse(row.value) };
  } catch {}

  db.close();

  const stats = { ...emptyStats(), total: checks.length };
  checks.forEach(c => addStat(stats, c.status));

  const desktopChecks = checks.filter(c => c.scenario.endsWith('_desktop'));
  const macChecks = checks.filter(c => c.scenario.endsWith('_desktop_mac'));
  const iosChecks = checks.filter(c => c.scenario.endsWith('_mobile_ios'));
  const androidChecks = checks.filter(c => c.scenario.endsWith('_mobile_android'));
  const dS = calcStats(desktopChecks);
  const mS = calcStats(macChecks);
  const iS = calcStats(iosChecks);
  const aS = calcStats(androidChecks);

  const checksByUrl = {};
  checks.forEach(c => {
    if (!checksByUrl[c.url]) checksByUrl[c.url] = [];
    checksByUrl[c.url].push(c);
  });

  const fails = checks.filter(c => c.status.startsWith('FAIL'));
  const skipped = checks.filter(c => SKIPPED.has(c.status));
  const inconclusive = checks.filter(c => c.status === 'INCONCLUSIVE');

  function renderStatusCell(c) {
    if (!c) return '<td class="cell-empty">—</td>';
    let cls = c.status.startsWith('FAIL') ? 'status-FAIL' : SKIPPED.has(c.status) ? 'status-SKIP' : `status-${c.status}`;
    const icon = c.status === 'PASS' ? '✅' : c.status.startsWith('FAIL') ? '❌' : SKIPPED.has(c.status) ? '⚪' : '⚠️';
    const text = c.status.startsWith('FAIL') ? c.status : c.status;
    let details = '';
    if (c.status !== 'PASS') {
      const shot = relScreenshot(c.screenshot_path);
      const screenLink = shot && fs.existsSync(path.join(__dirname, '..', shot))
        ? `<br><br><a href="${esc(shot)}" target="_blank">View screenshot</a>`
        : '';
      details = `<div class="tooltip">${esc(c.details || 'No details')}<br><br><b>Expected:</b> ${esc(c.expected_key || '—')}<br><b>Actual:</b> ${esc(c.actual_key || '—')}<br><b>Reproduce:</b> ${esc(c.url)} · ${esc(c.scenario)}${screenLink}</div>`;
      cls += ' has-tooltip';
    }
    return `<td class="${cls}">${icon} ${esc(text)}${details}</td>`;
  }

  let pagesHtml = '';
  for (const [url, urlChecks] of Object.entries(checksByUrl)) {
    const urlStats = calcStats(urlChecks);
    const scMap = {};
    urlChecks.forEach(c => {
      const sc = c.scenario.replace(/_desktop_mac$/, '').replace(/_mobile_ios$/, '').replace(/_mobile_android$/, '').replace(/_desktop$/, '');
      if (!scMap[sc]) scMap[sc] = {};
      if (c.scenario.endsWith('_desktop_mac')) scMap[sc].mac = c;
      else if (c.scenario.endsWith('_mobile_ios')) scMap[sc].ios = c;
      else if (c.scenario.endsWith('_mobile_android')) scMap[sc].android = c;
      else if (c.scenario.endsWith('_desktop')) scMap[sc].win = c;
    });

    let tbody = '';
    for (const sc of Object.keys(scMap).sort()) {
      const row = scMap[sc];
      tbody += `
        <tr>
          <td class="sc-name"><strong>${esc(sc)}</strong><div class="sc-desc">${esc(scenarioDescriptions[sc] || '')}</div></td>
          ${renderStatusCell(row.win)}
          ${renderStatusCell(row.mac)}
          ${renderStatusCell(row.ios)}
          ${renderStatusCell(row.android)}
        </tr>`;
    }

    let pathname = url;
    try { pathname = new URL(url).pathname || '/'; } catch {}

    pagesHtml += `
    <div class="page-card">
      <div class="page-header">
        <h3><a href="${esc(url)}" target="_blank">${esc(pathname)}</a></h3>
        <div class="page-stats">
          <span class="badge pass">PASS ${urlStats.PASS}</span>
          <span class="badge fail">FAIL ${urlStats.FAIL}</span>
          <span class="badge nolink">SKIP ${urlStats.SKIPPED}</span>
          <span class="badge warn">INCONCLUSIVE ${urlStats.INCONCLUSIVE}</span>
        </div>
      </div>
      <table class="matrix-table">
        <thead>
          <tr>
            <th width="20%">Scenario</th>
            <th width="20%">Desktop Chrome</th>
            <th width="20%">Desktop Safari</th>
            <th width="20%">iOS</th>
            <th width="20%">Android</th>
          </tr>
        </thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>`;
  }

  function issueTable(title, rows, color) {
    if (!rows.length) return '';
    const body = rows.map(c => `
      <tr>
        <td>${esc(c.status)}</td>
        <td><a href="${esc(c.url)}" target="_blank">${esc(c.url)}</a></td>
        <td>${esc(c.scenario)}</td>
        <td>${esc(c.expected_key || '—')}</td>
        <td>${esc(c.actual_key || '—')}</td>
        <td>${esc(c.details || '')}</td>
      </tr>`).join('');
    return `
    <div class="page-card" style="border-color:${color};">
      <div class="page-header"><h3>${esc(title)} (${rows.length})</h3></div>
      <table class="matrix-table">
        <thead><tr><th>Status</th><th>Page</th><th>Scenario</th><th>Expected</th><th>Actual</th><th>Details</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
  }

  if (crawlErrors.length) {
    const errorRows = crawlErrors.map(e => `
      <tr>
        <td style="text-align:left;padding-left:24px;"><a href="${esc(e.url)}" target="_blank">${esc(e.url)}</a></td>
        <td style="text-align:left;">${esc(e.reason)}</td>
      </tr>`).join('');
    pagesHtml += `
    <div class="page-card" style="border-color:#7f1d1d;">
      <div class="page-header"><h3>Could not crawl / truncated (${crawlErrors.length})</h3></div>
      <table class="matrix-table">
        <thead><tr><th width="40%">URL</th><th width="60%">Reason</th></tr></thead>
        <tbody>${errorRows}</tbody>
      </table>
    </div>`;
  }

  pagesHtml = issueTable('Problems found (expected vs actual)', fails, '#7f1d1d')
    + issueTable('Could not complete the check (not counted as pass or fail)', inconclusive, '#854d0e')
    + issueTable('Skipped / not applicable', skipped.slice(0, 80), '#334155')
    + pagesHtml;

  const healthColor = consecutiveFailures === 0 ? '#10b981' : consecutiveFailures < 3 ? '#f59e0b' : '#ef4444';
  const healthLabel = consecutiveFailures === 0
    ? 'Monitor healthy'
    : `${consecutiveFailures} consecutive monitor failure(s)`;

  const generatedAt = new Date().toISOString();
  const overall = stats.FAIL > 0 ? 'FAIL' : (stats.INCONCLUSIVE === stats.total && stats.total > 0 ? 'INCONCLUSIVE' : 'PASS');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Trustee Referral Monitor — Report</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 40px 20px; }
    .container { max-width: 1200px; margin: 0 auto; }
    header { margin-bottom: 32px; text-align: center; }
    h1 { font-size: 2.2em; margin: 0 0 10px; }
    .subtitle { color: #94a3b8; }
    .health-badge { display: inline-flex; padding: 6px 16px; border-radius: 20px; font-weight: 600; background: #1e293b; border: 1px solid #334155; color: ${healthColor}; }
    .stale { display: none; margin: 16px auto 0; max-width: 640px; background: #7f1d1d; color: #fecaca; padding: 12px 16px; border-radius: 8px; }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin: 28px 0 40px; }
    .stat-card { background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 20px; text-align: center; }
    .stat-title { color: #94a3b8; font-size: 0.8em; text-transform: uppercase; }
    .stat-value { display: block; font-size: 2.4em; font-weight: 700; margin-top: 8px; }
    .val-total { color: #818cf8; } .val-pass { color: #34d399; } .val-fail { color: #f87171; } .val-nolink { color: #cbd5e1; } .val-warn { color: #fbbf24; }
    .page-card { background: #1e293b; border: 1px solid #334155; border-radius: 16px; margin-bottom: 24px; overflow: auto; }
    .page-header { background: #0f172a; border-bottom: 1px solid #334155; padding: 16px 20px; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .page-header h3 { margin: 0; font-size: 1.05em; }
    .page-header a { color: #e2e8f0; }
    .page-stats { display: flex; gap: 8px; flex-wrap: wrap; }
    .badge { padding: 6px 10px; border-radius: 8px; font-size: 0.8em; font-weight: 600; }
    .badge.pass { background: rgba(52, 211, 153, 0.1); color: #34d399; }
    .badge.fail { background: rgba(248, 113, 113, 0.1); color: #f87171; }
    .badge.nolink { background: rgba(148, 163, 184, 0.1); color: #94a3b8; }
    .badge.warn { background: rgba(251, 191, 36, 0.1); color: #fbbf24; }
    .matrix-table { width: 100%; border-collapse: collapse; }
    .matrix-table th, .matrix-table td { padding: 12px; border-bottom: 1px solid #334155; font-size: 0.9em; text-align: center; vertical-align: top; }
    .matrix-table th { color: #94a3b8; font-size: 0.8em; text-transform: uppercase; }
    .sc-name { text-align: left !important; color: #e2e8f0; }
    .sc-desc { font-size: 0.8em; color: #94a3b8; margin-top: 4px; }
    .status-PASS { color: #34d399; font-weight: 600; }
    .status-FAIL { color: #f87171; font-weight: 600; }
    .status-SKIP { color: #64748b; }
    .status-INCONCLUSIVE { color: #fbbf24; font-weight: 600; }
    .has-tooltip { position: relative; cursor: help; }
    .tooltip { visibility: hidden; width: 320px; background: #0f172a; color: #f8fafc; text-align: left; border-radius: 8px; padding: 12px; position: absolute; z-index: 10; bottom: 120%; left: 50%; transform: translateX(-50%); opacity: 0; font-size: 0.8em; border: 1px solid #475569; pointer-events: none; }
    .has-tooltip:hover .tooltip { visibility: visible; opacity: 1; pointer-events: auto; }
    .tooltip a { color: #93c5fd; }
    footer { text-align: center; color: #64748b; margin-top: 48px; border-top: 1px solid #334155; padding-top: 24px; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Trustee Referral Monitor</h1>
      <p class="subtitle">Run #${run.id} · ${esc(run.status)} · started ${esc(run.started_at)} UTC · finished ${esc(run.finished_at || '—')}</p>
      <div class="health-badge">${esc(healthLabel)}</div>
      <div class="stale" id="stale-banner">This report is older than 36 hours. The daily monitor may have missed a run.</div>
      <p class="subtitle" style="margin-top:16px;">Coverage: ${coverage.pages} pages crawled · sitemap seeds ${coverage.sitemap ?? '—'} · crawl graph edges ${coverage.edges ?? '—'} · truncated ${coverage.truncated ?? 0} · crawl errors ${coverage.crawl_errors ?? crawlErrors.length}</p>
    </header>
    <div class="summary-grid">
      <div class="stat-card"><span class="stat-title">Total</span><span class="stat-value val-total">${stats.total}</span></div>
      <div class="stat-card"><span class="stat-title">PASS</span><span class="stat-value val-pass">${stats.PASS}</span></div>
      <div class="stat-card"><span class="stat-title">FAIL</span><span class="stat-value val-fail">${stats.FAIL}</span></div>
      <div class="stat-card"><span class="stat-title">Skipped</span><span class="stat-value val-nolink">${stats.SKIPPED}</span></div>
      <div class="stat-card"><span class="stat-title">Inconclusive</span><span class="stat-value val-warn">${stats.INCONCLUSIVE}</span></div>
    </div>
    <div class="pages-container">${pagesHtml}</div>
    <footer>Generated ${esc(generatedAt)} · Skipped checks are not counted as passes</footer>
  </div>
  <script>
    (function() {
      var generated = Date.parse(${JSON.stringify(generatedAt)});
      if (!isNaN(generated) && (Date.now() - generated) > 36 * 3600 * 1000) {
        var el = document.getElementById('stale-banner');
        if (el) el.style.display = 'block';
      }
    })();
  </script>
</body>
</html>`;

  fs.writeFileSync(reportPath, html);
  console.log('HTML report generated:', reportPath);

  const statusData = {
    run_id: run.id,
    started_at: run.started_at,
    finished_at: run.finished_at,
    run_status: run.status,
    total_checks: stats.total,
    pages_crawled: pages.length,
    pass: stats.PASS,
    fail: stats.FAIL,
    skipped: stats.SKIPPED,
    no_store_link: stats.SKIPPED,
    inconclusive: stats.INCONCLUSIVE,
    overall,
    consecutive_failures: consecutiveFailures,
    coverage,
    desktop: dS,
    desktop_mac: mS,
    mobile_ios: iS,
    mobile_android: aS,
    generated_at: generatedAt,
    stale_after_hours: 36,
  };
  fs.writeFileSync(statusPath, JSON.stringify(statusData, null, 2));
  console.log('Status JSON generated:', statusPath);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [
      `# Referral monitor run #${run.id}`,
      ``,
      `- Status: **${run.status}** / overall **${overall}**`,
      `- Pages crawled: ${pages.length}`,
      `- PASS: ${stats.PASS} · FAIL: ${stats.FAIL} · SKIP: ${stats.SKIPPED} · INCONCLUSIVE: ${stats.INCONCLUSIVE}`,
      `- Coverage: sitemap ${coverage.sitemap ?? '—'}, truncated ${coverage.truncated ?? 0}, crawl errors ${coverage.crawl_errors ?? crawlErrors.length}`,
      `- Consecutive monitor failures: ${consecutiveFailures}`,
      ``,
    ].join('\n');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) generateReport();
