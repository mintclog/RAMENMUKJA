import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createApi } from './server/api.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const handleApi = createApi();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const routes = /^\/(?:explore|saved|me|login|admin|terms|privacy|community|menus\/[^/]+(?:\/review)?|shops\/[^/]+)?\/?$/;

http.createServer(async (req, res) => {
  if (new URL(req.url, 'http://localhost').pathname.startsWith('/api/')) return handleApi(req, res);
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const asset = pathname === '/index.html' || /^\/src\/[a-z0-9-]+\.(?:js|css|svg)$/.test(pathname);
    if (!asset && !routes.test(pathname)) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const file = asset ? pathname.slice(1) : 'index.html';
    const body = await readFile(path.join(root, file));
    res.writeHead(200, {
      'Content-Type': `${types[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' https://maps.googleapis.com https://maps.gstatic.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; font-src 'self' https://cdn.jsdelivr.net https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://maps.googleapis.com https://maps.gstatic.com https://*.googleapis.com; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}`));
