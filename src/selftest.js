import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const DB_PATH = path.join(rootDir, 'test-db.sqlite');

async function runSelftest() {
  console.log('Starting selftest...');
  
  // 1. Clean up old db
  try {
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  } catch (e) {
    console.warn('Could not delete old test-db.sqlite, it might be locked:', e.message);
  }

  // 2. Start mock-server
  const mockServer = spawn('node', ['src/mock-server.js'], { cwd: rootDir });
  
  await new Promise(r => setTimeout(r, 2000)); // wait for server to start

  // 3. Run checker
  console.log('Running checker against mock server...');
  const checker = spawn('node', ['src/checker.js'], {
    cwd: rootDir,
    stdio: 'inherit',
    env: { 
      ...process.env, 
      NODE_ENV: 'test',
      TARGET_URL: 'http://localhost:3000',
      CRAWLER_MAX_PAGES: '10',
      CRAWLER_MAX_DEPTH: '2',
      CRAWLER_DELAY_MS: '0',
      SCENARIO_TIMEOUT_MS: '2000'
    }
  });

  await new Promise((resolve) => {
    checker.on('close', resolve);
  });

  // 4. Assert results
  const db = new Database(DB_PATH);
  const checks = db.prepare('SELECT p.url, c.scenario, c.status, c.details FROM checks c JOIN pages p ON c.page_id = p.id WHERE c.run_id = (SELECT MAX(id) FROM runs)').all();
  
  let passed = true;
  const assertStatus = (url, scenarioPattern, expectedStatus) => {
    const match = checks.find(c => c.url === url && c.scenario.startsWith(scenarioPattern));
    if (!match) {
      console.error(`❌ Missing check for ${url} / ${scenarioPattern}`);
      passed = false;
    } else if (match.status !== expectedStatus) {
      console.error(`❌ Assertion failed for ${url} / ${scenarioPattern}: expected ${expectedStatus}, got ${match.status} (Details: ${match.details})`);
      passed = false;
    } else {
      console.log(`✅ OK: ${url} / ${scenarioPattern} -> ${match.status}`);
    }
  };

  // Assertions
  console.log('\n--- Evaluating Assertions ---');
  
  // (1) Root page gives PASS
  assertStatus('http://localhost:3000/', 'S2', 'PASS');
  
  // (2) Broken page gives FAIL_LOST
  assertStatus('http://localhost:3000/broken', 'S2', 'FAIL_LOST');
  
  // (3) Timeout page gives INCONCLUSIVE (mock-server just hangs on /timeout)
  // We use S2 as representative, because S2 tries to goto the page and extract links
  assertStatus('http://localhost:3000/timeout', 'S2', 'INCONCLUSIVE');

  // Also check S5 on stale-key page gives FAIL_STALE
  assertStatus('http://localhost:3000/stale-key', 'S5', 'FAIL_STALE');

  // (4) S4 on no-key-link searching for /missing gives STOP_CHAIN or S1 gives NO_INTERNAL_LINK
  assertStatus('http://localhost:3000/no-key-link', 'S4', 'STOP_CHAIN');

  // Write report
  fs.writeFileSync(path.join(rootDir, 'selftest-report.json'), JSON.stringify(checks, null, 2));
  console.log('\nSaved selftest-report.json');

  // Cleanup
  mockServer.kill();

  if (!passed) {
    console.error('\nSelftest FAILED.');
    process.exit(1);
  } else {
    console.log('\nSelftest PASSED successfully.');
    process.exit(0);
  }
}

runSelftest().catch(err => {
  console.error('Fatal error in selftest:', err);
  process.exit(1);
});
