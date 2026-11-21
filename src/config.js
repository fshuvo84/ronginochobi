'use strict';

const fs = require('fs');
const path = require('path');

// Minimal .env loader (keeps the project free of extra dependencies).
(function loadEnvFile() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
})();

const num = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

module.exports = {
  PORT: num(process.env.PORT, 3000),
  HOST: process.env.HOST || '0.0.0.0',
  SITE_NAME: process.env.SITE_NAME || 'MediaHub',

  // The directory-listing web server that holds the movies / series.
  BASE_URL: (process.env.FTP_BASE_URL || 'http://172.16.50.4').replace(/\/+$/, '') + '/',
  UPSTREAM_USER: process.env.FTP_USER || '',
  UPSTREAM_PASS: process.env.FTP_PASS || '',

  // Search index (a background crawl of the whole library).
  INDEX_DEPTH: num(process.env.INDEX_DEPTH, 6),
  INDEX_CONCURRENCY: num(process.env.INDEX_CONCURRENCY, 6),
  INDEX_REFRESH_MINUTES: num(process.env.INDEX_REFRESH_MINUTES, 360),

  LISTING_CACHE_SECONDS: num(process.env.LISTING_CACHE_SECONDS, 300),
  DATA_DIR: path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')),
};
