import { chromium, devices } from 'playwright';

async function runRecon() {
  console.log('Starting recon on trustee.io (Mobile Version)...');
  
  // 1. Запускаємо браузер Chromium (Playwright). 
  // headless: true означає, що він працює у фоні, без видимого вікна.
  const browser = await chromium.launch({ headless: true });
  
  // Емулюємо мобільний пристрій (iPhone 13)
  const iPhone = devices['iPhone 13'];
  
  // 2. Створюємо "чистий" контекст з налаштуваннями телефону.
  const context = await browser.newContext({
    ...iPhone
  });
  const page = await context.newPage();

  // 3. Формуємо тестовий URL з реферальним ключем (TEST_KEY_123)
  const testUrl = 'https://trustee.io/?r=TEST_KEY_123';
  console.log(`Navigating to ${testUrl}`);
  
  // 4. Переходимо на сторінку. 'networkidle' каже Playwright почекати, 
  // поки сторінка повністю не перестане робити нові мережеві запити (мінімум 500мс тиші).
  await page.goto(testUrl, { waitUntil: 'networkidle' });
  
  // 5. Робимо жорстку паузу на 2 секунди.
  // Це потрібно, щоб дати час відпрацювати їхнім внутрішнім JS-скриптам 
  // (наприклад, анімаціям, банерам згоди на куки, або скриптам, що міняють лінки).
  await page.waitForTimeout(2000);

  // --- ПОЧИНАЄМО ПОШУК КЛЮЧА ---

  // Крок 1. Перевіряємо Cookies
  // Витягуємо всі куки для поточної сторінки
  const cookies = await context.cookies();
  console.log('\n--- COOKIES ---');
  // Шукаємо, чи є кука, значення якої містить наш ключ, або ім'я якої містить слово "ref"
  const refCookies = cookies.filter(c => c.value.includes('TEST_KEY_123') || c.name.toLowerCase().includes('ref'));
  console.log(refCookies.length ? refCookies : 'No explicit referral cookies found.');

  // Крок 2. Перевіряємо LocalStorage (локальне сховище браузера)
  // page.evaluate виконує цей код прямо всередині консолі браузера сторінки Trustee
  const localStorageData = await page.evaluate(() => Object.entries(localStorage));
  console.log('\n--- LOCAL STORAGE ---');
  const refLs = localStorageData.filter(([k, v]) => v.includes('TEST_KEY_123') || k.toLowerCase().includes('ref'));
  console.log(refLs.length ? refLs : 'No explicit referral localStorage found.');

  // Крок 3. Перевіряємо SessionStorage (сховище на час сесії)
  const sessionStorageData = await page.evaluate(() => Object.entries(sessionStorage));
  console.log('\n--- SESSION STORAGE ---');
  const refSs = sessionStorageData.filter(([k, v]) => v.includes('TEST_KEY_123') || k.toLowerCase().includes('ref'));
  console.log(refSs.length ? refSs : 'No explicit referral sessionStorage found.');

  // Крок 4. Дивимося, чи є ключ у звичайних посиланнях на сторінці
  console.log('\n--- ALL LINKS WITH "TEST_KEY_123" ---');
  // Витягуємо атрибут href у всіх тегів <a> на сторінці
  const allLinks = await page.evaluate(() => Array.from(document.querySelectorAll('a')).map(a => a.href));
  // Фільтруємо лише ті, куди дописався наш ключ
  const refLinks = allLinks.filter(href => href.includes('TEST_KEY_123'));
  // Якщо цей список не пустий - значить їхній скрипт автоматично додає ?r= до лінків!
  console.log(refLinks.length ? refLinks : 'No links contain the test key.');

  // Крок 5. Перевіряємо найголовніше: кінцеві посилання на App Store / Google Play
  console.log('\n--- ALL APP STORE / PLAY STORE LINKS ---');
  // Збираємо тільки ті посилання, що ведуть на скачування додатків
  const storeLinksNodes = await page.$$('a[href*="apple.com"], a[href*="play.google.com"]');
  for (const node of storeLinksNodes) {
    // Друкуємо їх, щоб подивитися, чи є в них наш ключ (спойлер: його там немає)
    console.log(await node.getAttribute('href'));
  }

  // (Тестовий шматок) Якщо лінки є, пробуємо клікнути на перший з них, 
  // щоб подивитися, куди він нас перенаправить в новій вкладці.
  if (storeLinksNodes.length > 0) {
    console.log('\n--- CLICKING FIRST STORE LINK ---');
    try {
      // Promise.all запускає паралельно: очікування нової вкладки і сам клік
      const [newPage] = await Promise.all([
        context.waitForEvent('page', { timeout: 5000 }), // Чекаємо відкриття нової вкладки
        storeLinksNodes[0].click() // Клікаємо
      ]);
      await newPage.waitForLoadState('domcontentloaded');
      console.log('Final URL after click:', newPage.url());
      await newPage.close();
    } catch (e) {
      console.log('Click test timed out (link probably opens in the same tab, not a new one).');
    }
  }

  // Завжди закриваємо браузер за собою, щоб не залишати "зомбі-процеси" в пам'яті
  await browser.close();
}

// Запускаємо нашу асинхронну функцію
runRecon().catch(console.error);
