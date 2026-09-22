import http from 'http';

const PORT = process.env.MOCK_PORT ? parseInt(process.env.MOCK_PORT, 10) : 3000;

const storeLink = (key) => {
  if (key) return `https://apps.apple.com/app/id12345?r=${key}`;
  return 'https://apps.apple.com/app/id12345';
};

const nav = `
  <a href="/">Home</a>
  <a href="/broken">Broken</a>
  <a href="/altered">Altered</a>
  <a href="/stale-key">Stale</a>
  <a href="/storage-only">Storage only</a>
  <a href="/no-store">No store</a>
  <a href="/no-key-link">No key link</a>
  <a href="/timeout">Timeout</a>
`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const key = url.searchParams.get('r') || '';

  if (url.pathname === '/timeout') {
    setTimeout(() => {
      try {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body>${nav}<a href="${storeLink(key)}">App</a></body></html>`);
      } catch {}
    }, 4000);
    return;
  }

  if (url.pathname === '/go-store') {
    res.writeHead(302, { Location: storeLink(key) });
    res.end();
    return;
  }

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><body>
      <h1>Mock Trustee</h1>
      ${nav}
      <a href="${storeLink(key)}">App Store</a>
    </body></html>`);
  } else if (url.pathname === '/broken') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><body>
      <h1>Broken Page</h1>
      ${nav}
      <a href="https://play.google.com/store/apps/details?id=com.trustee">Google Play (no key)</a>
    </body></html>`);
  } else if (url.pathname === '/altered') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><body>
      <h1>Altered key</h1>
      ${nav}
      <a href="https://apps.apple.com/app/id12345?r=NOT_THE_KEY">App Store</a>
    </body></html>`);
  } else if (url.pathname === '/storage-only') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><body>
      <h1>Key only in storage</h1>
      ${nav}
      <script>try { localStorage.setItem('r', ${JSON.stringify(key)}); sessionStorage.setItem('r', ${JSON.stringify(key)}); } catch (e) {}</script>
      <a href="https://apps.apple.com/app/id12345">App Store without key in href</a>
    </body></html>`);
  } else if (url.pathname === '/no-store') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><body>
      <h1>No store links</h1>
      ${nav}
      <p>About page</p>
    </body></html>`);
  } else if (url.pathname === '/no-key-link') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><body>
      <h1>No Key Link</h1>
      ${nav}
      <a href="/broken">Internal link without key</a>
    </body></html>`);
  } else if (url.pathname === '/stale-key') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><body>
      <h1>Stale Key</h1>
      ${nav}
      <a href="https://apps.apple.com/app/id12345?r=OLD_KEY_ABC">App Store</a>
    </body></html>`);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock server running at http://localhost:${PORT}`);
});
