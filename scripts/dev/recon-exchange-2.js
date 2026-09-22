import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://trustee.io/exchange?r=TESTKEY', { waitUntil: 'networkidle' });
  
  try {
    await page.click('button:has-text("Accept all")', { timeout: 2000 });
  } catch {}

  const buttons = await page.locator('button, a.btn, a[class*="button"]').evaluateAll(els => els.map(e => ({
    text: e.innerText.trim(),
    html: e.outerHTML
  })));
  console.log(buttons.filter(b => b.text.length > 0));

  await browser.close();
})();
