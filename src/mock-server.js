import http from 'http';

const PORT = 3000;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const key = url.searchParams.get('r') || '';
  
  if (url.pathname === '/timeout') {
    // DO NOT writeHead or end, just wait and let it timeout.
    setTimeout(() => {
      // 4000ms is > SCENARIO_TIMEOUT_MS (2000) so checker fails,
      // but < crawler timeout (15000) so crawler succeeds.
      try { res.end('<html><body><a href="https://apps.apple.com/app/id123">App</a></body></html>'); } catch {}
    }, 4000);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  
  if (url.pathname === '/') {
    res.end(`
      <!DOCTYPE html>
      <html>
      <head><title>Mock Trustee - Good</title></head>
      <body>
        <h1>Welcome to Mock Trustee</h1>
        <a href="https://apps.apple.com/app/id12345?r=${key}">App Store</a>
        <a href="/broken?r=${key}">Go to Broken Page</a>
        <a href="/no-key-link">Go to No Key Link Page</a>
        <a href="/timeout">Go to Timeout</a>
        <a href="/stale-key">Go to Stale Key</a>
      </body>
      </html>
    `);
  } else if (url.pathname === '/broken') {
    res.end(`
      <!DOCTYPE html>
      <html>
      <head><title>Mock Trustee - Broken</title></head>
      <body>
        <h1>Broken Page</h1>
        <a href="https://play.google.com/store/apps/details?id=com.trustee">Google Play (NO KEY!)</a>
      </body>
      </html>
    `);
  } else if (url.pathname === '/no-key-link') {
    // Tests S1 navigating without key, but the target page HAS the key? No, the mock is static, so if we click, we go to /stale-key without key.
    res.end(`
      <!DOCTYPE html>
      <html>
      <head><title>No Key Link Page</title></head>
      <body>
        <h1>No Key Link</h1>
        <!-- Link without key -->
        <a href="/broken">Internal link without key</a>
      </body>
      </html>
    `);
  } else if (url.pathname === '/stale-key') {
    res.end(`
      <!DOCTYPE html>
      <html>
      <head><title>Stale Key Page</title></head>
      <body>
        <h1>Stale Key</h1>
        <a href="https://apps.apple.com/app/id12345?r=OLD_KEY_ABC">App Store</a>
      </body>
      </html>
    `);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Mock server running at http://localhost:${PORT}`);
});
