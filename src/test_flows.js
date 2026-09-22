import { chromium, devices } from 'playwright';

async function checkFlow(deviceName, emulateDevice, url) {
  console.log(`\n======================================`);
  console.log(`Testing Flow: ${deviceName}`);
  console.log(`======================================`);
  
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(emulateDevice ? { ...emulateDevice } : {});
  const page = await context.newPage();
  
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  
  console.log('--- ALL VISIBLE LINKS ---');
  const links = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a')).map(a => a.href).filter(h => 
      h.includes('apple.com') || 
      h.includes('play.google.com') || 
      h.includes('.apk') || 
      h.includes('app.link') ||
      h.includes('appsflyer')
    );
  });
  console.log([...new Set(links)]);

  // QR Code check
  const qrCodeUrl = await page.evaluate(() => {
    const qrImgs = Array.from(document.querySelectorAll('img')).filter(img => 
      img.src.includes('qr') || 
      img.className.includes('qr') || 
      img.alt.toLowerCase().includes('qr') ||
      img.src.includes('data:image') // Some QRs are base64 inline
    );
    return qrImgs.map(img => img.src);
  });
  
  if (qrCodeUrl.length > 0) {
    console.log(`[QR CODE GENERATED]: Yes, ${qrCodeUrl.length} found.`);
    // In a real scenario we could decode the QR to read the URL, 
    // but typically the frontend script gets the URL from a data attribute before generating the image.
    const qrDataUrl = await page.evaluate(() => {
      const el = document.querySelector('[data-qr-url], [data-url]');
      return el ? (el.getAttribute('data-qr-url') || el.getAttribute('data-url')) : null;
    });
    if (qrDataUrl) console.log('[QR DATA URL]:', qrDataUrl);
  } else {
    console.log('[QR CODE GENERATED]: No');
  }

  await browser.close();
}

async function runAll() {
  const url = 'https://trustee.io/?r=WoEs9XIVB6b';
  
  // 1. Desktop
  await checkFlow('Desktop (PC)', null, url);
  
  // 2. iPhone
  await checkFlow('Mobile (iPhone 13)', devices['iPhone 13'], url);
  
  // 3. Android
  await checkFlow('Mobile (Pixel 5)', devices['Pixel 5'], url);
}

runAll().catch(console.error);
