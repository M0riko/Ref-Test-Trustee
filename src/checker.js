import { chromium } from 'playwright';
import { startRun, finishRun, savePage, saveCheck } from './storage.js';
import { crawlSite } from './crawler.js';
import { runS1, runS2, runS3, runS5, runS6, runS7 } from './scenarios.js';

async function main() {
  const rootUrl = 'https://trustee.io';
  const defaultKey = 'WoEs9XIVB6b';
  
  const runId = startRun();
  console.log(`--- Starting Run #${runId} ---`);

  const browser = await chromium.launch({ headless: true });

  try {
    // 1. Crawl to find pages
    const pages = await crawlSite(browser, rootUrl, 5); // limiting to 5 for speed
    console.log(`Found ${pages.length} pages to test.`);

    // 2. Run scenarios on each page
    for (const url of pages) {
      const pageId = savePage(runId, url);
      console.log(`\nTesting ${url}`);

      // S1: Nav from root
      console.log('  Running S1...');
      const resS1 = await runS1(browser, rootUrl, url, defaultKey);
      saveCheck(runId, pageId, 'S1', defaultKey, resS1.actualKey, resS1.status, resS1.details);

      // S2: Direct visit
      console.log('  Running S2...');
      const resS2 = await runS2(browser, url, defaultKey);
      saveCheck(runId, pageId, 'S2', defaultKey, resS2.actualKey, resS2.status, resS2.details);

      // S3: Reload
      console.log('  Running S3...');
      const resS3 = await runS3(browser, url, defaultKey);
      saveCheck(runId, pageId, 'S3', defaultKey, resS3.actualKey, resS3.status, resS3.details);

      // S5: Key replacement
      console.log('  Running S5...');
      const resS5 = await runS5(browser, url, 'OLD_KEY', defaultKey);
      saveCheck(runId, pageId, 'S5', defaultKey, resS5.actualKey, resS5.status, resS5.details);

      // S6: Control
      console.log('  Running S6...');
      const resS6 = await runS6(browser, url);
      saveCheck(runId, pageId, 'S6', null, resS6.actualKey, resS6.status, resS6.details);

      // S7: Special chars
      console.log('  Running S7...');
      const resS7 = await runS7(browser, url);
      saveCheck(runId, pageId, 'S7', 'T_E-S.T~K', resS7.actualKey, resS7.status, resS7.details);
    }
    
    finishRun(runId, 'COMPLETED');
    console.log(`--- Run #${runId} Completed ---`);
  } catch (err) {
    console.error(`Run failed:`, err);
    finishRun(runId, 'FAILED');
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
