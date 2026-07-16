#!/usr/bin/env node
/**
 * subdomain_finder_notimeout.js
 *
 * Passive subdomain discovery via crt.sh (Certificate Transparency logs)
 * + active check to see which discovered subdomains respond over HTTP/HTTPS.
 *
 * This is a Node.js port of subdomain_finder_notimeout.sh. Request timeouts
 * are DISABLED, so requests wait indefinitely for a response instead of
 * erroring out quickly. Useful on flaky/slow networks, but a genuinely dead
 * host can hang until you Ctrl+C.
 *
 * USAGE:
 *   node subdomain_finder_notimeout.js example.com
 *   node subdomain_finder_notimeout.js example.com --threads 30
 *   node subdomain_finder_notimeout.js example.com --retries 8 --alive-retries 2
 *
 * REQUIREMENTS: Node.js 18+ (no external npm packages needed)
 *
 * ONLY run this against domains you own or are authorized to test.
 */

'use strict';

const fs = require('fs');
const https = require('https');
const http = require('http');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
let THREADS = 20;          // concurrent liveness-check jobs
let ALIVE_RETRIES = 2;     // retry attempts per scheme (http/https) on connection errors
let CRT_RETRIES = 8;       // max retry attempts for crt.sh on 429/500/502/503/504 or empty results

const RETRY_BACKOFF_BASE = 5;  // seconds; grows as BASE * attempt
const RETRY_BACKOFF_MAX = 60;  // cap so it doesn't grow unbounded

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
function usage() {
  console.log(`Usage: node ${require('path').basename(__filename)} <domain> [--threads N] [--alive-retries N] [--retries N]`);
  console.log('');
  console.log('  <domain>            Target domain, e.g. example.com');
  console.log(`  --threads N         Concurrent liveness-check jobs (default: ${THREADS})`);
  console.log('  --alive-retries N   Retry attempts per scheme http/https on connection');
  console.log(`                      errors during liveness checks (default: ${ALIVE_RETRIES})`);
  console.log('  --retries N         Max retry attempts for crt.sh on rate-limit/server');
  console.log(`                      errors or empty responses (default: ${CRT_RETRIES})`);
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.length < 1) usage();

let DOMAIN = argv[0];
const rest = argv.slice(1);

for (let i = 0; i < rest.length; i++) {
  switch (rest[i]) {
    case '--threads':
      THREADS = parseInt(rest[++i], 10);
      break;
    case '--alive-retries':
      ALIVE_RETRIES = parseInt(rest[++i], 10);
      break;
    case '--retries':
      CRT_RETRIES = parseInt(rest[++i], 10);
      break;
    case '-h':
    case '--help':
      usage();
      break;
    default:
      console.log(`[!] Unknown argument: ${rest[i]}`);
      usage();
  }
}

// Lowercase + trim the domain
DOMAIN = DOMAIN.trim().toLowerCase();

const RAW_FILE = `subdomains_raw_${DOMAIN}.txt`;
const ALIVE_FILE = `subdomains_alive_${DOMAIN}.txt`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function backoffSleep(attempt) {
  let wait = RETRY_BACKOFF_BASE * attempt;
  if (wait > RETRY_BACKOFF_MAX) wait = RETRY_BACKOFF_MAX;
  console.log(`[*] Waiting ${wait}s before retrying (crt.sh rate-limit cooldown)...`);
  await sleep(wait * 1000);
}

function isRetryableStatus(code) {
  return [429, 500, 502, 503, 504].includes(code);
}

// Simple GET with no timeout set (mirrors curl with no --max-time).
// Resolves { statusCode, body } or rejects on a connection-level error.
function httpGet(url, { followRedirects = false } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https://') ? https : http;
    const req = lib.get(
      url,
      { headers: { 'User-Agent': 'Mozilla/5.0' } },
      (res) => {
        if (
          followRedirects &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          const nextUrl = new URL(res.headers.location, url).toString();
          httpGet(nextUrl, { followRedirects: true }).then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );
    // Intentionally NOT setting req.setTimeout(...) -> waits indefinitely.
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// getSubdomains: query crt.sh, with retry on throttling/empty responses
// ---------------------------------------------------------------------------
async function getSubdomains() {
  const url = `https://crt.sh/?q=%25.${encodeURIComponent(DOMAIN)}&output=json`;

  for (let attempt = 1; attempt <= CRT_RETRIES; attempt++) {
    console.log(`[*] Querying crt.sh for subdomains of: ${DOMAIN} (attempt ${attempt}/${CRT_RETRIES}, no timeout)...`);

    let res;
    try {
      res = await httpGet(url);
    } catch (err) {
      console.log(`[!] Attempt ${attempt}/${CRT_RETRIES} failed (connection error: ${err.message}). Retrying...`);
      if (attempt < CRT_RETRIES) await backoffSleep(attempt);
      continue;
    }

    console.log(`HTTP Status: ${res.statusCode}`);

    if (isRetryableStatus(res.statusCode)) {
      console.log(`[!] Attempt ${attempt}/${CRT_RETRIES}: got HTTP ${res.statusCode} (server likely overloaded/rate-limiting). Retrying...`);
      if (attempt < CRT_RETRIES) await backoffSleep(attempt);
      continue;
    }

    if (res.statusCode < 200 || res.statusCode >= 300) {
      console.log(`[!] Error contacting crt.sh: HTTP ${res.statusCode}`);
      if (attempt < CRT_RETRIES) {
        await backoffSleep(attempt);
        continue;
      }
      return false;
    }

    let records;
    try {
      records = JSON.parse(res.body);
    } catch (e) {
      console.log('[!] crt.sh returned invalid JSON (it may be rate-limiting you).');
      if (attempt < CRT_RETRIES) {
        await backoffSleep(attempt);
        continue;
      }
      return false;
    }

    console.log(`Number of records: ${records.length}`);

    if (records.length === 0) {
      if (attempt < CRT_RETRIES) {
        console.log('[!] Got 0 records — likely a rate-limit, not a real empty result. Retrying...');
        await backoffSleep(attempt);
        continue;
      } else {
        console.log('[!] Still 0 records after all retries — treating as a genuine empty result.');
        return false;
      }
    }

    // Extract name_value fields, split on newlines, normalize, filter,
    // and keep only entries that end with the target domain.
    const set = new Set();
    for (const rec of records) {
      const nameValue = rec.name_value || '';
      for (let line of nameValue.split('\n')) {
        line = line.trim().toLowerCase();
        if (line.startsWith('*.')) line = line.slice(2);
        if (line.includes('*')) continue;
        if (line.endsWith(DOMAIN)) set.add(line);
      }
    }

    const subdomains = Array.from(set).sort();
    console.log(`Subdomains collected: ${subdomains.length}`);

    fs.writeFileSync(RAW_FILE, subdomains.join('\n') + (subdomains.length ? '\n' : ''));
    return true;
  }

  console.log(`[!] Giving up after ${CRT_RETRIES} attempts.`);
  return false;
}

// ---------------------------------------------------------------------------
// checkAlive: try HTTPS then HTTP, no timeout, retrying connection errors
// ---------------------------------------------------------------------------
// Returns { url, code, scheme } on success, or null on failure.
async function checkAlive(subdomain, retries) {
  for (const scheme of ['https', 'http']) {
    const url = `${scheme}://${subdomain}`;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await httpGet(url, { followRedirects: true });
        return { url, code: res.statusCode, scheme };
      } catch (err) {
        // Roughly mirror curl exit codes 6 (DNS) / 7 (connect) -> retry same scheme.
        const retryableCodes = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'];
        if (retryableCodes.includes(err.code)) {
          continue;
        }
        // Non-retryable (e.g. TLS/cert error) -> try next scheme.
        break;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Simple concurrency pool (mirrors `xargs -P THREADS`)
// ---------------------------------------------------------------------------
async function runPool(items, poolSize, worker) {
  let idx = 0;
  const results = [];
  async function runner() {
    while (idx < items.length) {
      const current = items[idx++];
      results.push(await worker(current));
    }
  }
  const runners = Array.from({ length: Math.min(poolSize, items.length) }, runner);
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const found = await getSubdomains();
  if (!found) {
    console.log('[!] No subdomains found.');
    process.exit(0);
  }

  const subdomains = fs
    .readFileSync(RAW_FILE, 'utf8')
    .split('\n')
    .filter(Boolean);

  console.log(`[+] Found ${subdomains.length} unique subdomains (saved to ${RAW_FILE})`);
  console.log(`[*] Checking liveness with ${THREADS} threads (no timeout, retries=${ALIVE_RETRIES})...`);

  const aliveLines = [];

  await runPool(subdomains, THREADS, async (sub) => {
    const result = await checkAlive(sub, ALIVE_RETRIES);
    if (result) {
      console.log(`[ALIVE][${result.scheme}] ${sub} -> ${result.code}`);
      aliveLines.push(`${result.url} [${result.code}]`);
    }
  });

  const aliveUnique = Array.from(new Set(aliveLines)).sort();
  fs.writeFileSync(ALIVE_FILE, aliveUnique.join('\n') + (aliveUnique.length ? '\n' : ''));

  console.log('');
  console.log(`[+] Done. ${aliveUnique.length} alive subdomains saved to: ${ALIVE_FILE}`);
  console.log('==================================================');
  console.log(`Total Found : ${subdomains.length}`);
  console.log(`Alive       : ${aliveUnique.length}`);
  console.log('==================================================');
}

main();
