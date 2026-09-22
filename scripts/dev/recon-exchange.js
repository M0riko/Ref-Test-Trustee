import { chromium } from 'playwright';
import fs from 'fs';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://trustee.io/exchange?r=TESTKEY', { waitUntil: 'networkidle' });
  
  // click accept cookies if present
  try {
    await page.click('button:has-text("Accept")', { timeout: 2000 });
  } catch {}

  await page.screenshot({ path: 'scripts/dev/exchange.png', fullPage: true });

  const html = await page.content();
  fs.writeFileSync('scripts/dev/exchange.html', html);

  await browser.close();
})();
