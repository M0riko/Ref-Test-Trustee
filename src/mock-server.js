import http from 'http';

const PORT = 3000;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const key = url.searchParams.get('r') || '';
  
  res.writeHead(200, { 'Content-Type': 'text/html' });
  
  if (url.pathname === '/') {
    // Root page: works correctly
    res.end(`
      <!DOCTYPE html>
      <html>
      <head><title>Mock Trustee - Good</title></head>
      <body>
        <h1>Welcome to Mock Trustee</h1>
        <!-- Valid store link that forwards the key -->
        <a href="https://apps.apple.com/app/id12345?r=${key}">App Store</a>
        <!-- Internal link to a broken page -->
        <a href="/broken?r=${key}">Go to Broken Page</a>
      </body>
      </html>
    `);
  } else if (url.pathname === '/broken') {
    // Broken page: simulates the desktop bug (drops the key)
    res.end(`
      <!DOCTYPE html>
      <html>
      <head><title>Mock Trustee - Broken</title></head>
      <body>
        <h1>Broken Page</h1>
        <p>This page simulates the bug where the key is lost.</p>
        <!-- BAD store link: forgets to include the referral key! -->
        <a href="https://play.google.com/store/apps/details?id=com.trustee">Google Play (NO KEY!)</a>
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
  console.log('Press Ctrl+C to stop.');
});
