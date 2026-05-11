const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 5000;
const HOST = '0.0.0.0';
const ROOT = __dirname;
const COUNTER_FILE = path.join(ROOT, '.visitor-count.json');

const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
};

function readCount() {
  try {
    const data = fs.readFileSync(COUNTER_FILE, 'utf8');
    return JSON.parse(data).count || 0;
  } catch {
    return 0;
  }
}

function incrementCount() {
  const count = readCount() + 1;
  fs.writeFileSync(COUNTER_FILE, JSON.stringify({ count }), 'utf8');
  return count;
}

function buildCounterSVG(count) {
  const label = 'visitors';
  const value = count.toLocaleString();
  const labelW = label.length * 7.5 + 20;
  const valueW = value.length * 9 + 20;
  const totalW = labelW + valueW;
  const h = 28;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${h}" role="img" aria-label="${label}: ${value}">
  <defs>
    <linearGradient id="a" x2="0" y2="100%">
      <stop offset="0" stop-color="#1a1a2e"/>
      <stop offset="1" stop-color="#0f0f1a"/>
    </linearGradient>
    <linearGradient id="b" x2="0" y2="100%">
      <stop offset="0" stop-color="#7c3aed"/>
      <stop offset="1" stop-color="#5b21b6"/>
    </linearGradient>
    <clipPath id="c">
      <rect width="${totalW}" height="${h}" rx="6" fill="#fff"/>
    </clipPath>
  </defs>
  <g clip-path="url(#c)">
    <rect width="${labelW}" height="${h}" fill="url(#a)"/>
    <rect x="${labelW}" width="${valueW}" height="${h}" fill="url(#b)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelW / 2}" y="18" fill="#9090b0">${label}</text>
    <text x="${labelW + valueW / 2}" y="18" font-weight="bold">${value}</text>
  </g>
</svg>`;
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];

  if (urlPath === '/api/visitors') {
    const count = incrementCount();
    const svg = buildCounterSVG(count);
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
    res.end(svg);
    return;
  }

  if (urlPath === '/api/visitors/count') {
    const count = readCount();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ count }));
    return;
  }

  let servePath = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(ROOT, servePath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isDirectory()) {
      const indexFile = path.join(filePath, 'index.html');
      fs.readFile(indexFile, (err2, data) => {
        if (err2) {
          res.writeHead(404);
          res.end('Not Found');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(data);
        }
      });
      return;
    }

    fs.readFile(filePath, (err2, data) => {
      if (err2) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`GameGram server running at http://${HOST}:${PORT}`);
});
