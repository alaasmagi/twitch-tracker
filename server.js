require('dotenv').config();
const puppeteer = require('puppeteer');
const http = require('http');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const PORT        = process.env.PORT || 3000;
const CACHE_TTL   = parseInt(process.env.CACHE_TTL_SECONDS) || 30;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DB_PATH     = process.env.DB_PATH || 'cache.db';

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
  if (ALLOWED_ORIGINS.length === 0) {
    return { 'Access-Control-Allow-Origin': '*' };
  }
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Vary': 'Origin'
    };
  }
  return null;
}

async function scrapeChannel(channel) {
  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(`https://www.twitch.tv/${channel}`, { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    const data = await page.evaluate(() => {
      const result = { isLive: false, game: null, title: null, viewers: null, timestamp: new Date().toISOString() };

      const liveBadge = document.querySelector('[data-a-target="live-badge"]') ||
                        document.querySelector('.live-indicator') ||
                        document.querySelector('[aria-label="Live"]') ||
                        document.querySelector('[data-a-target="animated-channel-viewers-count"]') ||
                        document.querySelector('[data-a-target="channel-viewers-count"]');
      result.isLive = !!liveBadge;

      const gameLink = document.querySelector('[data-a-target="stream-game-link"] span') ||
                       document.querySelector('[data-a-target="stream-game-link"]');
      if (gameLink) result.game = gameLink.textContent.trim();

      const titleEl = document.querySelector('[data-a-target="stream-title"]') ||
                      document.querySelector('.tw-ellipsis h2') ||
                      document.querySelector('[class*="CoreText"]');
      if (titleEl) result.title = titleEl.textContent.trim();

      const viewerEl = document.querySelector('[data-a-target="animated-channel-viewers-count"]') ||
                       document.querySelector('[data-a-target="channel-viewers-count"]');
      if (viewerEl) result.viewers = viewerEl.textContent.trim();

      return result;
    });

    return data;
  } catch (err) {
    console.error('Scrape error:', err.message);
    return { error: err.message, timestamp: new Date().toISOString() };
  } finally {
    if (browser) await browser.close();
  }
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

  if (ALLOWED_ORIGINS.length > 0 && !corsHeaders) {
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
    const data = await scrapeChannel(channel);
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