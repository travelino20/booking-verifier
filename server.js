#!/usr/bin/env node
/**
 * server.js — Backend pentru aplicația Booking Codes.
 *
 * Rolul lui: rulează verificarea pe Booking "în spate" (cu Playwright),
 * astfel încât userul să vadă doar verdictul.
 *
 * Expune:
 *   GET  /                     → servește booking-codes.html
 *   POST /api/verify-code      → rulează verificarea și întoarce JSON
 *
 * Pornire:
 *   npm install
 *   npx playwright install chromium
 *   node server.js
 *
 * Apoi deschide http://localhost:3000 în browser.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { verify } = require('./verify-booking-code.js');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const ROOT = __dirname;
// Optional API key. If API_KEY is set in the environment, all /api/verify-code
// requests must include header X-API-Key: <same value>. Leave unset for local dev.
const API_KEY = process.env.API_KEY || null;

// Throttle: avoid firing multiple Playwright runs concurrently on a single machine.
let activeRuns = 0;
const MAX_CONCURRENT = 2;

// Cache of recent verdicts (to dedupe rapid repeat clicks for the same code).
// Keep 10 minutes TTL — code validity can change daily, so keep it short.
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

function getCached(code) {
  const key = code.toLowerCase();
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.verdict;
}
function setCached(code, verdict) {
  cache.set(code.toLowerCase(), { ts: Date.now(), verdict });
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(obj));
}

function serveFile(res, absPath, contentType) {
  try {
    const data = fs.readFileSync(absPath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  } catch (e) {
    res.writeHead(404); res.end('Not found');
  }
}

async function readBody(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > max) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleVerify(req, res) {
  // API key check (if configured)
  if (API_KEY) {
    const supplied = req.headers['x-api-key'] || '';
    if (supplied !== API_KEY) {
      return sendJson(res, 401, { valid: false, reason: 'API key lipsă sau invalid.' });
    }
  }

  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJson(res, 400, { valid: false, reason: 'Body invalid.' }); }

  let data;
  try { data = JSON.parse(body || '{}'); }
  catch (_) { return sendJson(res, 400, { valid: false, reason: 'JSON invalid.' }); }

  const code = (data.code || '').toString().trim();
  if (!code) return sendJson(res, 400, { valid: false, reason: 'Cod lipsă.' });
  if (code.length > 64) return sendJson(res, 400, { valid: false, reason: 'Cod prea lung.' });

  // Cache hit → return immediately (saves 30-60s per duplicate click).
  const cached = getCached(code);
  if (cached) {
    return sendJson(res, 200, { ...cached, cached: true });
  }

  if (activeRuns >= MAX_CONCURRENT) {
    return sendJson(res, 503, { valid: false, reason: 'Server ocupat. Reîncearcă în câteva secunde.' });
  }

  activeRuns++;
  console.log(`[verify] START ${code} (active=${activeRuns})`);
  const t0 = Date.now();

  try {
    const verdict = await verify({
      code,
      headful: false,
      name: 'Verifier Bot',
      email: 'verifier@example.com',
      phone: '0700000000',
      timeoutMs: 90_000
    });
    const ms = Date.now() - t0;
    console.log(`[verify] DONE  ${code} → ${verdict.valid ? 'VALID' : 'INVALID'} (${verdict.reason}) [${ms}ms]`);
    setCached(code, verdict);
    sendJson(res, 200, verdict);
  } catch (e) {
    console.error(`[verify] ERROR ${code}:`, e.message);
    sendJson(res, 500, { valid: false, reason: 'Eroare la verificare: ' + e.message });
  } finally {
    activeRuns--;
  }
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // Health check
  if (req.method === 'GET' && req.url === '/api/health') {
    return sendJson(res, 200, { ok: true, activeRuns, cached: cache.size });
  }

  // Serve the app
  if (req.method === 'GET' && (req.url === '/' || req.url === '/booking-codes.html')) {
    return serveFile(res, path.join(ROOT, 'booking-codes.html'), 'text/html; charset=utf-8');
  }

  // Verification endpoint
  if (req.method === 'POST' && req.url === '/api/verify-code') {
    return handleVerify(req, res);
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n╭────────────────────────────────────────────────╮`);
  console.log(`│  Booking Codes server                          │`);
  console.log(`│  Deschide:  http://localhost:${PORT}              │`);
  console.log(`│  Verifică:  POST /api/verify-code  { "code" }  │`);
  console.log(`│  API key:   ${API_KEY ? 'activ (via X-API-Key header)' : 'dezactivat (dev mode) '}     │`);
  console.log(`╰────────────────────────────────────────────────╯\n`);
});
