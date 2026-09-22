import 'dotenv/config';
import { chromium, webkit, devices } from 'playwright';
import { startRun, finishRun, savePage, saveCheck, incrementFailures, resetFailures } from './storage.js';
import { extractLinks, extractKeyFromUrl } from './extractor.js';
import { crawlSite } from './crawler.js';
import { runS1, runS2, runS3, runS4, runS5, runS6, runS7, runS8, runS9, runS10 } from './scenarios.js';
import { notifyStart, notifySuccess, notifyFailure } from './notifier.js';
import fs from 'fs';
import path from 'path';

// Ensure screenshots directory is clean
const SCREENSHOTS_DIR = path.join(process.cwd(), 'screenshots');
if (fs.existsSync(SCREENSHOTS_DIR)) {
  fs.rmSync(SCREENSHOTS_DIR, { recursive: true, force: true });
}
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const DEVICE_PROFILES = [
  {
    name: 'desktop',
    engine: 'chromium',
    desc: devices['Desktop Chrome']
  },
  {
    name: 'desktop_mac',
    engine: 'webkit',
    desc: devices['Desktop Safari']
  },
  { 
    name: 'mobile_ios', 
    engine: 'webkit',
    desc: devices['iPhone 13'] 
  },
  { 
    name: 'mobile_android', 
    engine: 'chromium',
    desc: devices['Pixel 5'] 
  },
];

// ─── Healthchecks.io ping ────────────────────────────────────────────────────
async function hcPing(suffix = '') {
  const base = process.env.HEALTHCHECK_URL;
  if (!base) return;
  const url = base.replace(/\/$/, '') + suffix;
  try {
    await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5000) });
  } catch {}
}

async function runWithConcurrency(tasks, limit = 6) {
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

// Wrapper to handle retries for INCONCLUSIVE
async function runWithRetry(fn, maxTries = 2) {
  let res;
  let allDetails = [];
  for (let i = 0; i < maxTries; i++) {
    res = await fn();
    if (res.status !== 'INCONCLUSIVE') return res;
    allDetails.push(`Try ${i + 1}: ${res.details}`);
  }
  res.details = allDetails.join(' | ');
  return res;
}

async function main() {
  const watchdog = setTimeout(async () => {
    console.error('🚨 Global timeout reached (40m). Force killing process to prevent zombie run.');
    finishRun(runId, 'FAILED');
    incrementFailures();
    await hcPing('/fail');
    process.exit(1);
  }, 40 * 60 * 1000);

  const rootUrl = (process.env.TARGET_URL || 'https://trustee.io').trim();
  const defaultKey = 'WoEs9XIVB6b';
  const maxPages = parseInt(process.env.CRAWLER_MAX_PAGES || '300', 10);
  const maxDepth = parseInt(process.env.CRAWLER_MAX_DEPTH || '10', 10);
  const delayMs = parseInt(process.env.CRAWLER_DELAY_MS || '500', 10);

  await hcPing('/start');

  let runId = null;
  let runFailed = false;

  const browsers = {
    chromium: await chromium.launch({ headless: true }),
    webkit: await webkit.launch({ headless: true })
  };

  try {
    runId = startRun();
    console.log(`--- Starting Run #${runId} ---`);

    const { foundUrls: pages, failedUrls, truncatedUrls } = await crawlSite(browsers.chromium, rootUrl, maxPages, maxDepth, delayMs);
    
    const dbModule = await import('./storage.js');
    for (const failed of failedUrls) {
      dbModule.saveCrawlError(runId, failed.url, failed.reason);
    }
    if (truncatedUrls) {
      for (const trunc of truncatedUrls) {
        dbModule.saveCrawlError(runId, trunc.url, 'TRUNCATED: ' + trunc.reason);
      }
    }

    const totalChecks = pages.length * 10 * DEVICE_PROFILES.length;
    console.log(`\nFound ${pages.length} pages × 10 scenarios × ${DEVICE_PROFILES.length} devices = ${totalChecks} checks`);
    console.log(`Failed to crawl ${failedUrls.length} pages (saved to crawl_errors).`);
    console.log(`Running with parallelism (up to 6 concurrent)...\n`);

    await notifyStart(runId, pages.length);

    for (let i = 0; i < pages.length; i++) {
      const url = pages[i];
      const pageId = savePage(runId, url);
      const nextPage = pages[(i + 1) % pages.length];

      console.log(`Testing ${url}...`);

      const tasks = [];
      for (const device of DEVICE_PROFILES) {
        const br = browsers[device.engine];
        
        const createScenTask = (scenarioName, expectedKey, runFunc) => async () => {
          const screenshotPath = path.join(SCREENSHOTS_DIR, `${runId}_${pageId}_${scenarioName}.png`);
          const res = await runWithRetry(() => runFunc(screenshotPath));
          return { id: scenarioName, expected: expectedKey, screenshotPath, ...res };
        };

        tasks.push(createScenTask(`S1_${device.name}`, defaultKey, (sp) => runS1(br, rootUrl, url, defaultKey, device.desc, sp)));
        tasks.push(createScenTask(`S2_${device.name}`, defaultKey, (sp) => runS2(br, url, defaultKey, device.desc, sp)));
        tasks.push(createScenTask(`S3_${device.name}`, defaultKey, (sp) => runS3(br, url, defaultKey, device.desc, sp)));
        tasks.push(createScenTask(`S4_${device.name}`, defaultKey, (sp) => runS4(br, rootUrl, url, nextPage, defaultKey, device.desc, sp)));
        tasks.push(createScenTask(`S5_${device.name}`, defaultKey, (sp) => runS5(br, url, 'OLD_KEY_ABC', defaultKey, device.desc, sp)));
        tasks.push(createScenTask(`S6_${device.name}`, null, (sp) => runS6(br, url, device.desc, sp)));
        tasks.push(createScenTask(`S7_${device.name}`, 'T_E-S.T~K', (sp) => runS7(br, url, device.desc, sp)));
        tasks.push(createScenTask(`S8_${device.name}`, defaultKey, (sp) => runS8(br, url, defaultKey, device.desc, sp)));
        tasks.push(createScenTask(`S9_${device.name}`, 'LONGKEY_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890', (sp) => runS9(br, url, device.desc, sp)));
        tasks.push(createScenTask(`S10_${device.name}`, defaultKey, (sp) => runS10(br, url, defaultKey, device.desc, sp)));
      }

      const results = await runWithConcurrency(tasks, 6);
      for (const r of results) {
        const finalScreenshot = (r.status.startsWith('FAIL') || r.status === 'INCONCLUSIVE') ? r.screenshotPath : null;
        saveCheck(runId, pageId, r.id, r.expected, r.actualKey, r.status, r.details, finalScreenshot);
        const icon = r.status === 'PASS' ? '✓' : ['NO_STORE_LINK', 'NO_INTERNAL_LINK', 'STOP_CHAIN'].includes(r.status) ? '○' : '✗';
        console.log(`  ${icon} ${r.id}: ${r.status}`);
      }
    }

    finishRun(runId, 'COMPLETED');
    resetFailures();
    await hcPing();

    const db = (await import('./storage.js')).getDb();
    const checks = db.prepare(`SELECT status, scenario FROM checks WHERE run_id = ?`).all(runId);
    const pass = checks.filter(c => c.status === 'PASS').length;
    const fail = checks.filter(c => c.status.startsWith('FAIL')).length;
    const noLink = checks.filter(c => ['NO_STORE_LINK', 'NO_INTERNAL_LINK', 'STOP_CHAIN'].includes(c.status)).length;
    const incon = checks.filter(c => c.status === 'INCONCLUSIVE').length;
    const dFail = checks.filter(c => c.status.startsWith('FAIL') && c.scenario.endsWith('_desktop')).length;
    const mFail = checks.filter(c => c.status.startsWith('FAIL') && c.scenario.endsWith('_desktop_mac')).length;
    const iFail = checks.filter(c => c.status.startsWith('FAIL') && c.scenario.endsWith('_mobile_ios')).length;
    const aFail = checks.filter(c => c.status.startsWith('FAIL') && c.scenario.endsWith('_mobile_android')).length;
    await notifySuccess(runId, { pass, fail, noStoreLink: noLink, inconclusive: incon, pages: pages.length, desktopFail: dFail, macFail: mFail, iosFail: iFail, androidFail: aFail });

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
    await browsers.chromium.close();
    await browsers.webkit.close();
  }

  process.exit(runFailed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  incrementFailures();
  await hcPing('/fail');
  process.exit(1);
});
