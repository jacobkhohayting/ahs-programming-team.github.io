'use strict';
// Configuration comes from environment variables (see .env.example).
// A .env file in the project root is loaded automatically if present.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const dataDir = path.resolve(root, process.env.DATA_DIR || 'data');
fs.mkdirSync(dataDir, { recursive: true });

// Secret used to sign session cookies. Generated once and kept in data/secret.key
// unless SESSION_SECRET is provided.
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  const f = path.join(dataDir, 'secret.key');
  if (fs.existsSync(f)) sessionSecret = fs.readFileSync(f, 'utf8').trim();
  else {
    sessionSecret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, sessionSecret, { mode: 0o600 });
  }
}

const adminPassword = process.env.ADMIN_PASSWORD || '';
if (!adminPassword) {
  console.warn('WARNING: ADMIN_PASSWORD is not set. The admin area is disabled until you set it (see .env.example).');
}

module.exports = {
  root,
  dataDir,
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  siteName: process.env.SITE_NAME || 'MiniForces',
  sessionSecret,
  adminPassword,
  cookieSecure: process.env.COOKIE_SECURE === '1',
  trustProxy: process.env.TRUST_PROXY === '1',
  judgeWorkers: Math.max(1, Number(process.env.JUDGE_WORKERS || 1)),
  // Work directory for compiling/running submissions. Must NOT live inside dataDir
  // (which is locked down to mode 700 so sandboxed programs cannot read the database).
  judgeDir: path.resolve(root, process.env.JUDGE_DIR || path.join(require('os').tmpdir(), 'miniforces-judge')),
  timeFactorPython: Number(process.env.JUDGE_TIME_FACTOR_PYTHON || 1),
  timeFactorJava: Number(process.env.JUDGE_TIME_FACTOR_JAVA || 1),
  submitCooldownMs: Number(process.env.SUBMIT_COOLDOWN_MS || 3000),
  maxSourceBytes: 64 * 1024,
  compilers: {
    cpp: process.env.CXX || 'g++',
    python: process.env.PYTHON || 'python3',
    javac: process.env.JAVAC || 'javac',
    java: process.env.JAVA || 'java',
  },
};
