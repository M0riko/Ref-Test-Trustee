import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  await page.goto('https://trustee.io?r=TEST', { waitUntil: 'domcontentloaded' });
  
  // Wait a bit to let JS render
  await page.waitForTimeout(3000);
  
  // Find all links that look like store links
  const links = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a'))
      .filter(a => a.href.includes('apple.com') || a.href.includes('google.com') || a.href.includes('branch.io') || a.href.includes('app.link') || a.className.includes('store'))
      .map(a => ({
        href: a.href,
        className: a.className,
        text: a.innerText.trim().substring(0, 50)
      }));
  });
  
  console.log('Found store links:', JSON.stringify(links, null, 2));
  
  await browser.close();
}

main().catch(console.error);
