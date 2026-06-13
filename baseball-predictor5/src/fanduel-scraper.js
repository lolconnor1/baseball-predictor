'use strict';

/**
 * fanduel-scraper.js
 *
 * Scrapes MLB moneyline odds from FanDuel Ontario using Playwright.
 * Uses aria-label attributes for stable selection — not class names.
 *
 * Usage: node src/fanduel-scraper.js
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const FANDUEL_MLB_URL = 'https://on.sportsbook.fanduel.ca/navigation/mlb';

// ---------------------------------------------------------------------------
async function scrapeFanDuelOdds(date = todayLocal(), { headless = true } = {}) {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-CA',
  });
 
  const page = await context.newPage();
  console.log(`🌐  Scraping FanDuel odds for ${date}...`);
 
  await page.goto(FANDUEL_MLB_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('[aria-label*="Moneyline"]', { timeout: 20000 })
    .catch(() => console.log('  ⚠️  No Moneyline elements found'));
 
  const games = await page.evaluate((targetDate) => {
    function parseMoneyline(el) {
      const label = el.getAttribute('aria-label') || '';
      const match = label.match(/Moneyline,\s*(.+?),\s*([+-]?\d+)\s*Odds/i);
      return match ? { team: match[1].trim(), americanOdds: parseInt(match[2]) } : null;
    }
 
    const results = [];
    const seen    = new Set();
 
    // Each game is in an <li> element containing a <time datetime="..."> and moneyline buttons
    const listItems = document.querySelectorAll('li');
 
    for (const li of listItems) {
      // Check the datetime — filter by date
      const timeEl = li.querySelector('time[datetime]');
      if (!timeEl) continue;
 
      const datetime = timeEl.getAttribute('datetime');
      const utcDate   = datetime.slice(0, 10);
      const etOffset  = 4;
      const etDate    = new Date(new Date(datetime) - etOffset * 3600000)
                          .toISOString().slice(0, 10);
 
      // Debug: log every datetime we see
      console.log('GAME:', timeEl.textContent.trim(), '| datetime:', datetime, '| utc:', utcDate, '| et:', etDate, '| target:', targetDate);
 
      if (utcDate !== targetDate && etDate !== targetDate) continue;
 
      // Find moneyline buttons within this li
      const moneylines = li.querySelectorAll('[aria-label*="Moneyline"]');
      if (moneylines.length < 2) continue;
 
      const away = parseMoneyline(moneylines[0]);
      const home = parseMoneyline(moneylines[1]);
      if (!away || !home) continue;
 
      const key = `${away.team}|${home.team}`;
      if (seen.has(key)) continue;
      seen.add(key);
 
      results.push({
        away,
        home,
        gameTime: timeEl.textContent.trim(), // e.g. "6:41pm ET"
        datetime,
      });
    }
 
    return results;
  }, date);
 
  await browser.close();
 
  console.log(`✅  ${games.length} games found for ${date}\n`);
  games.forEach(g => {
    const fmt = o => `${o > 0 ? '+' : ''}${o}`;
    const { awayProb, homeProb } = removeVig(
      americanToImplied(g.away.americanOdds),
      americanToImplied(g.home.americanOdds)
    );
    console.log(`  ${g.gameTime}  ${g.away.team} (${fmt(g.away.americanOdds)}) @ ${g.home.team} (${fmt(g.home.americanOdds)})`);
    console.log(`    Implied: away ${(awayProb*100).toFixed(1)}%  home ${(homeProb*100).toFixed(1)}%`);
  });
 
  return games;
}
 
function americanToImplied(odds) {
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}
 
function removeVig(awayImplied, homeImplied) {
  const total = awayImplied + homeImplied;
  return {
    awayProb: Math.round(awayImplied / total * 1000) / 1000,
    homeProb: Math.round(homeImplied / total * 1000) / 1000,
  };
}
 
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
 
module.exports = { scrapeFanDuelOdds, americanToImplied, removeVig };
 
if (require.main === module) {
  const date = process.argv[2] || todayLocal();
  scrapeFanDuelOdds(date, { headless: false });
}