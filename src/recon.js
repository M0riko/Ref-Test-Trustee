import { chromium } from 'playwright';

async function runRecon() {
  console.log('Starting recon on trustee.io...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const testUrl = 'https://trustee.io/?r=TEST_KEY_123';
  console.log(`Navigating to ${testUrl}`);
  
  await page.goto(testUrl, { waitUntil: 'networkidle' });
  
  // Let the page settle (cookies banners, scripts)
  await page.waitForTimeout(2000);

  // 1. Check Cookies
  const cookies = await context.cookies();
  console.log('\n--- COOKIES ---');
  const refCookies = cookies.filter(c => c.value.includes('TEST_KEY_123') || c.name.toLowerCase().includes('ref'));
  console.log(refCookies.length ? refCookies : 'No explicit referral cookies found.');

  // 2. Check localStorage
  const localStorageData = await page.evaluate(() => Object.entries(localStorage));
  console.log('\n--- LOCAL STORAGE ---');
  const refLs = localStorageData.filter(([k, v]) => v.includes('TEST_KEY_123') || k.toLowerCase().includes('ref'));
  console.log(refLs.length ? refLs : 'No explicit referral localStorage found.');

  // 3. Check sessionStorage
  const sessionStorageData = await page.evaluate(() => Object.entries(sessionStorage));
  console.log('\n--- SESSION STORAGE ---');
  const refSs = sessionStorageData.filter(([k, v]) => v.includes('TEST_KEY_123') || k.toLowerCase().includes('ref'));
  console.log(refSs.length ? refSs : 'No explicit referral sessionStorage found.');

  // 4. Check Store Links
  console.log('\n--- ALL LINKS WITH "TEST_KEY_123" ---');
  const allLinks = await page.evaluate(() => Array.from(document.querySelectorAll('a')).map(a => a.href));
  const refLinks = allLinks.filter(href => href.includes('TEST_KEY_123'));
  console.log(refLinks.length ? refLinks : 'No links contain the test key.');

  console.log('\n--- ALL APP STORE / PLAY STORE LINKS ---');
  const storeLinksNodes = await page.$$('a[href*="apple.com"], a[href*="play.google.com"]');
  for (const node of storeLinksNodes) {
    console.log(await node.getAttribute('href'));
  }

  if (storeLinksNodes.length > 0) {
    console.log('\n--- CLICKING FIRST STORE LINK ---');
    const [newPage] = await Promise.all([
      context.waitForEvent('page'),
      storeLinksNodes[0].click()
    ]);
    await newPage.waitForLoadState('domcontentloaded');
    console.log('Final URL after click:', newPage.url());
    await newPage.close();
  }

  await browser.close();
}

runRecon().catch(console.error);
