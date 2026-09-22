import 'dotenv/config';
import { chromium, webkit, devices } from 'playwright';
import {
  startRun, finishRun, savePage, saveCheck, incrementFailures, resetFailures,
  restoreConsecutiveFailures, getDb, saveCrawlError, setMonitorState,
} from './storage.js';
import { crawlSite, findTwoHopChain } from './crawler.js';
import { runS1, runS2, runS3, runS4, runS5, runS6 } from './scenarios.js';
import { notifyStart, notifySuccess, notifyFailure } from './notifier.js';
import { generateReport } from './reporter.js';
import fs from 'fs';
import path from 'path';

const SCREENSHOTS_DIR = path.join(process.cwd(), 'screenshots');
if (fs.existsSync(SCREENSHOTS_DIR)) {
  fs.rmSync(SCREENSHOTS_DIR, { recursive: true, force: true });
}
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const ALL_DEVICE_PROFILES = [
  { name: 'desktop', engine: 'chromium', desc: devices['Desktop Chrome'] },
  { name: 'mobile_ios', engine: 'webkit', desc: devices['iPhone 13'] },
  { name: 'mobile_android', engine: 'chromium', desc: devices['Pixel 5'] },
];

const isTest = process.env.NODE_ENV === 'test';
const fullScenarios = isTest || process.env.FULL_SCENARIOS === '1';
const DEVICE_PROFILES = isTest
  ? ALL_DEVICE_PROFILES.filter(d => d.name === 'desktop')
  : ALL_DEVICE_PROFILES;

const DEFAULT_KEY = 'WoEs9XIVB6b';
const OLD_KEY = 'OLD_KEY_ABC';
const LONG_KEY = 'LONGKEY_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890';
const SKIPPED = new Set(['NO_STORE_LINK', 'NO_INTERNAL_LINK', 'STOP_CHAIN', 'NO_FORM']);

async function hcPing(suffix = '') {
  const base = process.env.HEALTHCHECK_URL;
  if (!base) return;
  const url = base.replace(/\/$/, '') + suffix;
  try {
    await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5000) });
  } catch {}
}

function restoreHealthFromDisk() {
  const statusPath = path.join(process.cwd(), 'status.json');
  if (!fs.existsSync(statusPath)) return;
  try {
    const prev = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    if (typeof prev.consecutive_failures === 'number') {
      restoreConsecutiveFailures(prev.consecutive_failures);
    }
  } catch {}
}

async function runWithConcurrency(tasks, limit = 4) {
  const results = [];
  const executing = new Set();
  for (const task of tasks) {
    const p = task().then(r => { executing.delete(p); return r; });
    executing.add(p);
    results.push(p);
    if (executing.size >= limit) await Promise.race(executing);
  }
  return Promise.all(results);
}

async function runWithRetry(fn, maxTries = 2) {
  let res;
  const allDetails = [];
  for (let i = 0; i < maxTries; i++) {
    res = await fn();
    if (res.status !== 'INCONCLUSIVE') return res;
    allDetails.push(`Try ${i + 1}: ${res.details}`);
  }
  res.details = allDetails.join(' | ');
  return res;
}

function isDeepPage(url, rootUrl) {
  try {
    const p = new URL(url).pathname.replace(/\/$/, '') || '/';
    const root = new URL(rootUrl).pathname.replace(/\/$/, '') || '/';
    return p === root || /exchange/i.test(p);
  } catch {
    return false;
  }
}

function planForPage(url, rootUrl, pages, edges, device) {
  const jobs = [];
  const onlyDesktop = device.name === 'desktop';
  const deep = isDeepPage(url, rootUrl);

  jobs.push({ id: 'S2', expected: DEFAULT_KEY, run: (br, sp) => runS2(br, url, DEFAULT_KEY, device.desc, sp) });

  if (fullScenarios || onlyDesktop) {
    jobs.push({ id: 'S1', expected: DEFAULT_KEY, run: (br, sp) => runS1(br, rootUrl, url, DEFAULT_KEY, device.desc, sp) });
    jobs.push({ id: 'S3', expected: DEFAULT_KEY, run: (br, sp) => runS3(br, url, DEFAULT_KEY, device.desc, sp) });
    jobs.push({ id: 'S5', expected: DEFAULT_KEY, run: (br, sp) => runS5(br, url, OLD_KEY, DEFAULT_KEY, device.desc, sp) });
    jobs.push({ id: 'S6', expected: null, run: (br, sp) => runS6(br, url, device.desc, sp) });
  }



  if (fullScenarios || onlyDesktop) {
    const chain = findTwoHopChain(rootUrl, url, edges);
    const idx = pages.indexOf(url);
    const fallbackNext = pages[(idx + 1) % Math.max(pages.length, 1)] || url;
    const mid = chain?.intermediate || url;
    const dest = chain?.target || fallbackNext;
    jobs.push({ id: 'S4', expected: DEFAULT_KEY, run: (br, sp) => runS4(br, rootUrl, mid, dest, DEFAULT_KEY, device.desc, sp) });
  }

  return jobs;
}

async function main() {
  restoreHealthFromDisk();

  let runId = null;
  let runFailed = false;

  const watchdogMs = parseInt(process.env.WATCHDOG_MS || String(4 * 60 * 60 * 1000), 10);
  const watchdog = setTimeout(async () => {
    console.error('Global timeout reached. Stopping the run.');
    if (runId) {
      finishRun(runId, 'FAILED');
      incrementFailures();
    }
    await hcPing('/fail');
    process.exit(1);
  }, watchdogMs);

  const rootUrl = (process.env.TARGET_URL || 'https://trustee.io').trim();
  const maxPages = parseInt(process.env.CRAWLER_MAX_PAGES || '400', 10);
  const maxDepth = parseInt(process.env.CRAWLER_MAX_DEPTH || '10', 10);
  const delayMs = parseInt(process.env.CRAWLER_DELAY_MS || '400', 10);

  await hcPing('/start');

  const browsers = {
    chromium: await chromium.launch({ headless: true }),
    webkit: isTest ? null : await webkit.launch({ headless: true }),
  };

  try {
    runId = startRun();
    console.log(`--- Starting Run #${runId} ---`);

    const { foundUrls: pages, failedUrls, truncatedUrls, edges, sitemapCount } = await crawlSite(
      browsers.chromium, rootUrl, maxPages, maxDepth, delayMs
    );

    for (const failed of failedUrls) saveCrawlError(runId, failed.url, failed.reason);
    for (const trunc of truncatedUrls) saveCrawlError(runId, trunc.url, 'TRUNCATED: ' + trunc.reason);

    setMonitorState('last_coverage', JSON.stringify({
      pages: pages.length,
      sitemap: sitemapCount,
      crawl_errors: failedUrls.length,
      truncated: truncatedUrls.length,
      edges: edges.length,
    }));

    console.log(`\nCoverage: ${pages.length} pages, sitemap seeds ${sitemapCount}, ${failedUrls.length} crawl errors, ${truncatedUrls.length} truncated`);
    await notifyStart(runId, pages.length);

    for (let i = 0; i < pages.length; i++) {
      const url = pages[i];
      const pageId = savePage(runId, url);
      console.log(`Testing ${url}...`);

      const tasks = [];
      for (const device of DEVICE_PROFILES) {
        const br = browsers[device.engine];
        if (!br) continue;
        const jobs = planForPage(url, rootUrl, pages, edges, device);
        for (const job of jobs) {
          tasks.push(async () => {
            const screenshotPath = path.join(SCREENSHOTS_DIR, `${runId}_${pageId}_${job.id}_${device.name}.png`);
            const res = await runWithRetry(() => job.run(br, screenshotPath));
            return { id: `${job.id}_${device.name}`, expected: job.expected, screenshotPath, ...res };
          });
        }
      }

      const results = await runWithConcurrency(tasks, parseInt(process.env.CONCURRENCY || '4', 10));
      for (const r of results) {
        const shot = (r.status.startsWith('FAIL') || r.status === 'INCONCLUSIVE') ? r.screenshotPath : null;
        saveCheck(runId, pageId, r.id, r.expected, r.actualKey, r.status, r.details, shot);
        const icon = r.status === 'PASS' ? '✓' : SKIPPED.has(r.status) ? '○' : '✗';
        console.log(`  ${icon} ${r.id}: ${r.status}`);
      }
    }

    finishRun(runId, 'COMPLETED');
    resetFailures();
    await hcPing();

    const db = getDb();
    const checks = db.prepare(`SELECT status, scenario FROM checks WHERE run_id = ?`).all(runId);
    const pass = checks.filter(c => c.status === 'PASS').length;
    const fail = checks.filter(c => c.status.startsWith('FAIL')).length;
    const skipped = checks.filter(c => SKIPPED.has(c.status)).length;
    const incon = checks.filter(c => c.status === 'INCONCLUSIVE').length;
    const dFail = checks.filter(c => c.status.startsWith('FAIL') && c.scenario.endsWith('_desktop')).length;
    const mFail = checks.filter(c => c.status.startsWith('FAIL') && c.scenario.endsWith('_desktop_mac')).length;
    const iFail = checks.filter(c => c.status.startsWith('FAIL') && c.scenario.endsWith('_mobile_ios')).length;
    const aFail = checks.filter(c => c.status.startsWith('FAIL') && c.scenario.endsWith('_mobile_android')).length;
    await notifySuccess(runId, {
      pass, fail, noStoreLink: skipped, inconclusive: incon, pages: pages.length,
      desktopFail: dFail, macFail: mFail, iosFail: iFail, androidFail: aFail,
    });

    console.log(`\n--- Run #${runId} Completed ---`);
  } catch (err) {
    console.error(`Run failed:`, err);
    runFailed = true;
    if (runId) finishRun(runId, 'FAILED');
    incrementFailures();
    if (runId) await notifyFailure(runId, err.message);
    await hcPing('/fail');
  } finally {
    clearTimeout(watchdog);
    try { await browsers.chromium.close(); } catch {}
    try { if (browsers.webkit) await browsers.webkit.close(); } catch {}
    try { generateReport(); } catch (e) { console.error('Report generation failed:', e.message); }
  }

  process.exit(runFailed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  incrementFailures();
  await hcPing('/fail');
  process.exit(1);
});
