require('dotenv').config();
const puppeteer = require('puppeteer');
const http = require('http');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const PORT        = process.env.PORT || 3000;
const CACHE_TTL   = parseInt(process.env.CACHE_TTL_SECONDS) || 30;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
const DB_PATH     = process.env.DB_PATH || 'cache.db';

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS cache (
    channel    TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    scraped_at INTEGER NOT NULL
  )
`);

const getCache    = db.prepare('SELECT data, scraped_at FROM cache WHERE channel = ?');
const upsertCache = db.prepare(`
  INSERT INTO cache (channel, data, scraped_at) VALUES (?, ?, ?)
  ON CONFLICT(channel) DO UPDATE SET data = excluded.data, scraped_at = excluded.scraped_at
`);
const deleteOld   = db.prepare('DELETE FROM cache WHERE scraped_at < ?');

function getCached(channel) {
  const row = getCache.get(channel);
  if (!row) return null;
  const ageSeconds = (Date.now() - row.scraped_at) / 1000;
  if (ageSeconds > CACHE_TTL) {
    deleteOld.run(Date.now() - CACHE_TTL * 1000);
    return null;
  }
  const data = JSON.parse(row.data);
  data.cached = true;
  data.cacheAge = Math.round(ageSeconds);
  return data;
}

function setCache(channel, data) {
  upsertCache.run(channel, JSON.stringify(data), Date.now());
}

function getCorsHeaders(origin) {
  if (ALLOWED_ORIGINS.length === 0) return { 'Access-Control-Allow-Origin': '*' };
  if (origin && ALLOWED_ORIGINS.includes(origin)) return { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };
  return null;
}

let browser = null;

async function getBrowser() {
  if (browser && browser.connected) return browser;
  browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-crash-reporter',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
      '--disable-background-networking',
    ],
  });
  browser.on('disconnected', () => { browser = null; });
  return browser;
}

async function scrapeChannel(channel) {
  let page;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    page.setDefaultNavigationTimeout(60000);

    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.setRequestInterception(true);
    page.on('request', req => {
      const t = req.resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(t)) req.abort();
      else req.continue();
    });

    await page.goto(`https://www.twitch.tv/${channel}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    await Promise.race([
      page.waitForSelector('[data-a-target="stream-title"]',                   { timeout: 10000 }),
      page.waitForSelector('[data-a-target="channel-viewers-count"]',          { timeout: 10000 }),
      page.waitForSelector('[data-a-target="animated-channel-viewers-count"]', { timeout: 10000 }),
    ]).catch(() => {});

    const data = await page.evaluate(() => {
      const result = { isLive: false, game: null, title: null, viewers: null, timestamp: new Date().toISOString() };

      const liveBadge =
        document.querySelector('[data-a-target="live-badge"]') ||
        document.querySelector('.live-indicator') ||
        document.querySelector('[aria-label="Live"]') ||
        document.querySelector('[data-a-target="animated-channel-viewers-count"]') ||
        document.querySelector('[data-a-target="channel-viewers-count"]');
      result.isLive = !!liveBadge;

      const gameLink =
        document.querySelector('[data-a-target="stream-game-link"] span') ||
        document.querySelector('[data-a-target="stream-game-link"]');
      if (gameLink) result.game = gameLink.textContent.trim();

      const titleEl =
        document.querySelector('[data-a-target="stream-title"]') ||
        document.querySelector('.tw-ellipsis h2') ||
        document.querySelector('[class*="CoreText"]');
      if (titleEl) result.title = titleEl.textContent.trim();

      const viewerEl =
        document.querySelector('[data-a-target="animated-channel-viewers-count"]') ||
        document.querySelector('[data-a-target="channel-viewers-count"]');
      if (viewerEl) result.viewers = viewerEl.textContent.trim();

      return result;
    });

    return data;
  } catch (err) {
    console.error('Scrape error:', err.message);
    if (err.message.includes('Target closed') || err.message.includes('Session closed')) {
      browser = null;
    }
    return { error: err.message, timestamp: new Date().toISOString() };
  } finally {
    if (page && !page.isClosed()) await page.close().catch(() => {});
  }
}


let scraping = false;
const scrapeQueue = [];

async function scrapeWithLock(channel) {
  if (scraping) return new Promise(resolve => scrapeQueue.push({ channel, resolve }));
  scraping = true;
  const result = await scrapeChannel(channel);
  scraping = false;
  if (scrapeQueue.length > 0) {
    const next = scrapeQueue.shift();
    scrapeWithLock(next.channel).then(next.resolve);
  }
  return result;
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers['origin'];
  const corsHeaders = getCorsHeaders(origin);

  if (req.method === 'OPTIONS') {
    if (corsHeaders) {
      res.writeHead(204, {
        ...corsHeaders,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400'
      });
    } else {
      res.writeHead(403);
    }
    return res.end();
  }

  const parsed = new URL(req.url, `http://localhost`);

  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  const ext = path.extname(parsed.pathname);
  if (MIME[ext]) {
    const filePath = path.join(__dirname, parsed.pathname);
    if (!filePath.startsWith(__dirname)) {
      res.writeHead(403); return res.end('Forbidden');
    }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[ext] });
      res.end(data);
    });
    return;
  }

  // ── API ──
  const isSameOriginRequest = !origin || origin === `http://localhost:${PORT}`;
  if (ALLOWED_ORIGINS.length > 0 && !isSameOriginRequest && !corsHeaders) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Forbidden' }));
  }

  res.setHeader('Content-Type', 'application/json');
  if (corsHeaders) Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));

  if (parsed.pathname === '/status') {
    const channel = (parsed.searchParams.get('channel') || '').trim().toLowerCase();
    if (!channel || !/^[a-z0-9_]{1,25}$/.test(channel)) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: 'vigane channel parameeter' }));
    }

    const cached = getCached(channel);
    if (cached) {
      console.log(`[${new Date().toLocaleTimeString()}] Cache HIT: ${channel} (${cached.cacheAge}s old)`);
      cached.channel = channel;
      return res.end(JSON.stringify(cached));
    }

    console.log(`[${new Date().toLocaleTimeString()}] Cache MISS — scraping: twitch.tv/${channel}`);
    const data = await scrapeWithLock(channel);
    data.channel = channel;
    if (!data.error) setCache(channel, data);
    res.end(JSON.stringify(data));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  }
});

server.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`🗄️  SQLite cache TTL: ${CACHE_TTL}s`);
});

process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(0); });
process.on('SIGINT',  async () => { if (browser) await browser.close(); process.exit(0); });