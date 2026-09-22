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

  const pages = db.prepare(`SELECT * FROM pages WHERE run_id = ?`).all(run.id);
  const consecutiveFailures = getConsecutiveFailures();

  // Global stats
  const stats = { PASS: 0, FAIL: 0, NO_STORE_LINK: 0, INCONCLUSIVE: 0, total: checks.length };
  checks.forEach(c => {
    if (c.status === 'PASS') stats.PASS++;
    else if (c.status.startsWith('FAIL')) stats.FAIL++;
    else if (c.status === 'NO_STORE_LINK') stats.NO_STORE_LINK++;
    else stats.INCONCLUSIVE++;
  });

  // Split by device
  const desktopChecks  = checks.filter(c => c.scenario.endsWith('_desktop'));
  const macChecks      = checks.filter(c => c.scenario.endsWith('_desktop_mac'));
  const iosChecks      = checks.filter(c => c.scenario.endsWith('_mobile_ios'));
  const androidChecks  = checks.filter(c => c.scenario.endsWith('_mobile_android'));
  const inconclusive   = checks.filter(c => c.status === 'INCONCLUSIVE');

  function buildRows(list) {
    if (!list.length) return '<tr><td colspan="6" style="text-align:center;color:#64748b">— No checks —</td></tr>';
    return list.map(c => {
      let cls = c.status.startsWith('FAIL') ? 'status-FAIL' : `status-${c.status}`;
      let sc = c.scenario.replace(/_desktop$/, '').replace(/_desktop_mac$/, '').replace(/_mobile_ios$/, '').replace(/_mobile_android$/, '');
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
  const mS = calcStats(macChecks);
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

  // ── INCONCLUSIVE section ── (separate block as required by TZ)
  function inconclusiveSection(list) {
    if (!list.length) return '';
    const rows = list.map(c => {
      let sc = c.scenario.replace(/_desktop$/, '').replace(/_desktop_mac$/, '').replace(/_mobile_ios$/, '').replace(/_mobile_android$/, '');
      let device = c.scenario.endsWith('_desktop') ? '🖥️' : c.scenario.endsWith('_desktop_mac') ? '💻' : c.scenario.endsWith('_mobile_ios') ? '📱' : '🤖';
      return `<tr>
        <td><a href="${c.url}" target="_blank">${new URL(c.url).pathname}</a></td>
        <td>${device} <strong>${sc}</strong></td>
        <td class="status-INCONCLUSIVE">INCONCLUSIVE</td>
        <td class="details">${c.details || 'Unknown error'}</td>
      </tr>`;
    }).join('\n');
    return `
  <h2 class="inconclusive-title">⚠️ Could Not Verify (${list.length} checks — NOT counted as success)</h2>
  <div class="card inconclusive-card">
    <p>These checks could not be completed due to technical issues (timeout, network error, CAPTCHA, DNS).
    They are listed separately and are <strong>not counted as PASS</strong>.</p>
  </div>
  <table>
    <thead><tr><th>Page</th><th>Scenario</th><th>Status</th><th>Reason</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
  }

  // ── Monitor health badge ──
  const healthColor = consecutiveFailures === 0 ? '#34d399' : consecutiveFailures < 3 ? '#fbbf24' : '#f87171';
  const healthLabel = consecutiveFailures === 0
    ? '✅ Monitor healthy'
    : `⚠️ ${consecutiveFailures} consecutive failure${consecutiveFailures > 1 ? 's' : ''}`;

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
    .inconclusive-title{color:#fbbf24;border-color:#78350f}
    .subtitle{color:#64748b;font-size:.95em;margin-bottom:20px}
    .health-badge{display:inline-block;padding:4px 14px;border-radius:14px;font-size:.85em;font-weight:600;background:#1e293b;border:1px solid #334155;margin-bottom:16px;color:${healthColor}}
    .card{background:#1e293b;border-radius:10px;padding:18px 22px;box-shadow:0 2px 8px rgba(0,0,0,.3);margin-bottom:20px}
    .inconclusive-card{border-left:3px solid #fbbf24}
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
  <span class="health-badge">${healthLabel} | ${consecutiveFailures === 0 ? 'Last run succeeded' : `${consecutiveFailures} run(s) failed in a row`}</span>

  <div class="card summary">
    <div class="stat stat-total"><small>Total checks</small><strong>${stats.total}</strong></div>
    <div class="stat" style="border-color:#475569"><small>Pages crawled</small><strong style="color:#e2e8f0">${pages.length}</strong></div>
    <div class="stat stat-pass"><small>PASS</small><strong>${stats.PASS}</strong></div>
    <div class="stat stat-fail"><small>FAIL</small><strong>${stats.FAIL}</strong></div>
    <div class="stat stat-nolink"><small>No store link</small><strong>${stats.NO_STORE_LINK}</strong></div>
    <div class="stat stat-inconclusive"><small>Inconclusive</small><strong>${stats.INCONCLUSIVE}</strong></div>
  </div>

  ${section('Desktop (Windows)', '🖥️ Win', 'badge-desktop', desktopChecks, dS)}
  ${section('Desktop (Mac M1/M2)', '💻 Mac', 'badge-desktop', macChecks, mS)}
  ${section('Mobile — iOS (iPhone 13)', '📱 iOS', 'badge-ios', iosChecks, iS)}
  ${section('Mobile — Android (Pixel 5)', '🤖 Android', 'badge-android', androidChecks, aS)}
  ${inconclusiveSection(inconclusive)}

  <footer>Generated by Trustee Referral Monitor | ${new Date().toISOString()}</footer>
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

  // ── report.md — GitHub Actions Step Summary ──────────────────────────────────
  const mdPath = path.join(__dirname, '..', 'report.md');
  const md = `# 🔍 Trustee Referral Monitor Report\n\n` +
    `**Status**: ${run.status} | **Overall**: ${statusData.overall}\n\n` +
    `### Summary\n` +
    `- **Pages Crawled**: ${pages.length}\n` +
    `- **Total Checks**: ${stats.total}\n` +
    `- ✅ **PASS**: ${stats.PASS}\n` +
    `- ❌ **FAIL**: ${stats.FAIL}\n` +
    `- ⚪ **No Store Link**: ${stats.NO_STORE_LINK}\n` +
    `- ⚠️ **Inconclusive**: ${stats.INCONCLUSIVE}\n\n` +
    `### Device Breakdown\n` +
    `| Device | PASS | FAIL | No Link |\n` +
    `|--------|------|------|---------|\n` +
    `| 🖥️ Win Desktop | ${dS.PASS} | ${dS.FAIL} | ${dS.NO_STORE_LINK} |\n` +
    `| 💻 Mac Desktop | ${mS.PASS} | ${mS.FAIL} | ${mS.NO_STORE_LINK} |\n` +
    `| 📱 iOS | ${iS.PASS} | ${iS.FAIL} | ${iS.NO_STORE_LINK} |\n` +
    `| 🤖 Android | ${aS.PASS} | ${aS.FAIL} | ${aS.NO_STORE_LINK} |\n\n` +
    `> **Note**: For full details, download \`report.html\` from artifacts or check the Telegram alert.`;
  fs.writeFileSync(mdPath, md);
  console.log('Markdown report generated:', mdPath);

  // ── junit.xml — CI/CD Test Annotations ──────────────────────────────────────
  const junitPath = path.join(__dirname, '..', 'junit.xml');
  let junitXml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  junitXml += `<testsuites name="Referral Monitor" tests="${stats.total}" failures="${stats.FAIL}">\n`;
  
  // Group checks by page
  const pagesGroup = {};
  checks.forEach(c => {
    if (!pagesGroup[c.url]) pagesGroup[c.url] = [];
    pagesGroup[c.url].push(c);
  });

  for (const [url, pageChecks] of Object.entries(pagesGroup)) {
    const pageFails = pageChecks.filter(c => c.status.startsWith('FAIL')).length;
    // Escape URL for XML attribute
    const escapedUrl = url.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const pathName = new URL(url).pathname;
    junitXml += `  <testsuite name="${escapedUrl}" tests="${pageChecks.length}" failures="${pageFails}">\n`;
    pageChecks.forEach(c => {
      junitXml += `    <testcase name="${c.scenario}" classname="${pathName}">\n`;
      if (c.status.startsWith('FAIL')) {
        junitXml += `      <failure message="${c.status}">${c.details ? c.details.replace(/&/g, '&amp;').replace(/</g, '&lt;') : ''}</failure>\n`;
      } else if (c.status === 'INCONCLUSIVE') {
        junitXml += `      <error message="${c.status}">${c.details ? c.details.replace(/&/g, '&amp;').replace(/</g, '&lt;') : ''}</error>\n`;
      } else if (c.status === 'NO_STORE_LINK') {
        junitXml += `      <skipped message="No store link"/>\n`;
      }
      junitXml += `    </testcase>\n`;
    });
    junitXml += `  </testsuite>\n`;
  }
  junitXml += `</testsuites>`;
  
  fs.writeFileSync(junitPath, junitXml);
  console.log('JUnit XML generated:', junitPath);
}

generateReport();
