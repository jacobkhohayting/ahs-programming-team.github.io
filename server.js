'use strict';
// MiniForces - a small Codeforces-style contest site with a built-in judge.
// Start with `npm start` (see README.md).
const path = require('path');
const fs = require('fs');
const express = require('express');
const config = require('./src/config');
const { db } = require('./src/db');
const { sessionMiddleware } = require('./src/auth');
const judge = require('./src/judge');
const { HttpError } = require('./src/util');

// Keep secrets out of reach of sandboxed student programs (best effort).
for (const [p, mode] of [[path.join(config.root, '.env'), 0o600], [config.dataDir, 0o700], [path.join(config.dataDir, 'app.db'), 0o600]]) {
  try { if (fs.existsSync(p)) fs.chmodSync(p, mode); } catch { /* ignore */ }
}

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
  next();
});

app.use(express.json({ limit: '60mb' }));
app.use(sessionMiddleware);

// API
app.use('/api/admin', require('./src/routes/admin'));
app.use('/api', require('./src/routes/public'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Static front end + vendored libraries (served straight from node_modules, no build step).
const pub = path.join(__dirname, 'public');
app.use('/vendor/codemirror', express.static(path.join(__dirname, 'node_modules/codemirror'), { maxAge: '7d' }));
app.use('/vendor/katex', express.static(path.join(__dirname, 'node_modules/katex/dist'), { maxAge: '7d' }));
app.use('/vendor/marked', express.static(path.join(__dirname, 'node_modules/marked'), { maxAge: '7d' }));
app.use(express.static(pub, { index: false, maxAge: '1h' }));
app.get(/^\/admin(\/.*)?$/, (req, res) => res.sendFile(path.join(pub, 'admin.html')));
app.get(/.*/, (req, res) => res.sendFile(path.join(pub, 'index.html')));

// Errors
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(config.port, config.host, () => {
  console.log(`${config.siteName} listening on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  console.log(`data directory: ${config.dataDir}`);
  judge.start().catch((e) => console.error('judge failed to start', e));
});

process.on('SIGTERM', () => { db.close(); process.exit(0); });
process.on('SIGINT', () => { db.close(); process.exit(0); });
