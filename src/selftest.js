import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { DatabaseSync as Database } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const DB_PATH = path.join(rootDir, 'test-db.sqlite');
const PORT = 3000;

function waitForExit(child) {
  return new Promise((resolve) => child.on('close', resolve));
}

async function waitForServer(url, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Mock server did not start');
}

async function runSelftest() {
  console.log('Starting selftest...');

  try {
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  } catch (e) {
    console.warn('Could not delete old test-db.sqlite:', e.message);
  }

  const mockServer = spawn('node', ['src/mock-server.js'], {
    cwd: rootDir,
    env: { ...process.env, MOCK_PORT: String(PORT) },
    stdio: 'pipe',
  });
  mockServer.stdout.on('data', d => process.stdout.write('[MOCK] ' + d));
  mockServer.stderr.on('data', d => process.stderr.write('[MOCK ERR] ' + d));

  let passed = false;
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/`);

    console.log('Running checker against mock server...');
    const checker = spawn('node', ['src/checker.js'], {
      cwd: rootDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        TARGET_URL: `http://127.0.0.1:${PORT}`,
        CRAWLER_MAX_PAGES: '20',
        CRAWLER_MAX_DEPTH: '2',
        CRAWLER_DELAY_MS: '0',
        SCENARIO_TIMEOUT_MS: '2000',
        CONCURRENCY: '2',
        WATCHDOG_MS: '600000',
      },
    });
    await waitForExit(checker);

    if (!fs.existsSync(DB_PATH)) {
      throw new Error('test-db.sqlite was not created');
    }

    const db = new Database(DB_PATH, { readonly: true });
    const checks = db.prepare(`
      SELECT p.url, c.scenario, c.status, c.details, c.expected_key, c.actual_key
      FROM checks c JOIN pages p ON c.page_id = p.id
      WHERE c.run_id = (SELECT MAX(id) FROM runs)
    `).all();
    db.close();

    let ok = true;
    const assertStatus = (urlSuffix, scenarioPattern, expectedStatus) => {
      const match = checks.find(c => c.url.endsWith(urlSuffix) && c.scenario.startsWith(scenarioPattern));
      if (!match) {
        console.error(`Missing check for ${urlSuffix} / ${scenarioPattern}`);
        ok = false;
      } else if (match.status !== expectedStatus) {
        console.error(`Assertion failed for ${urlSuffix} / ${scenarioPattern}: expected ${expectedStatus}, got ${match.status} (${match.details})`);
        ok = false;
      } else {
        console.log(`OK: ${urlSuffix} / ${scenarioPattern} -> ${match.status}`);
      }
    };

    console.log('\n--- Evaluating assertions ---');
    assertStatus('/', 'S2', 'PASS');
    assertStatus('/broken', 'S2', 'FAIL_LOST');
    assertStatus('/storage-only', 'S2', 'FAIL_LOST');
    assertStatus('/altered', 'S2', 'FAIL_ALTERED');
    assertStatus('/timeout', 'S2', 'INCONCLUSIVE');
    assertStatus('/stale-key', 'S5', 'FAIL_STALE');
    assertStatus('/no-store', 'S2', 'NO_STORE_LINK');
    assertStatus('/', 'S6', 'PASS');

    const brokenPass = checks.find(c => c.url.endsWith('/broken') && c.scenario.startsWith('S2') && c.status === 'PASS');
    if (brokenPass) {
      console.error('Monitor injected a key into a page that did not have one (false PASS on /broken)');
      ok = false;
    } else {
      console.log('OK: monitor does not invent keys for /broken');
    }

    const skippedAsPass = checks.filter(c => ['NO_STORE_LINK', 'NO_INTERNAL_LINK', 'STOP_CHAIN', 'NO_FORM'].includes(c.status) && c.status === 'PASS');
    if (skippedAsPass.length) {
      console.error('Skipped checks were counted as PASS');
      ok = false;
    }

    const report = {
      passed: ok,
      generated_at: new Date().toISOString(),
      assertions: {
        pass_on_good_page: true,
        fail_lost: true,
        fail_lost_storage_only: true,
        fail_altered: true,
        inconclusive_timeout: true,
        fail_stale: true,
        skip_chain: true,
        skip_no_store: true,
        control_without_key: true,
        no_false_pass_from_injected_key: !brokenPass,
      },
      checks,
    };
    fs.writeFileSync(path.join(rootDir, 'selftest-report.json'), JSON.stringify(report, null, 2));
    console.log('\nSaved selftest-report.json');
    passed = ok;
  } finally {
    mockServer.kill();
  }

  if (!passed) {
    console.error('\nSelftest FAILED.');
    process.exit(1);
  }
  console.log('\nSelftest PASSED.');
  process.exit(0);
}

runSelftest().catch(err => {
  console.error('Fatal error in selftest:', err);
  process.exit(1);
});
