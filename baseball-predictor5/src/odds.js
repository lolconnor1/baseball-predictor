'use strict';

/**
 * odds.js — Polymarket only
 *
 * Fetches MLB game win probabilities from Polymarket's public Gamma API.
 * No API key required.
 *
 * Polymarket MLB markets look like:
 *   "Will the Yankees beat the Red Sox on April 28?"
 *   "Yankees vs Red Sox: Yankees to win?"
 */

const GAMMA_URL = 'https://gamma-api.polymarket.com/markets';

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Returns { matchupKey → polymarketData } for all MLB markets on a date.
 * matchupKey: lowercase "away vs home" e.g. "new york yankees vs boston red sox"
 */
async function fetchAllOdds(date) {
  const markets = await fetchMLBMarkets(date);

  const result = {};

  for (const market of markets) {
    const parsed = parseMLBMarket(market, date);
    if (!parsed) continue;

    const key = `${parsed.team1.toLowerCase()} vs ${parsed.team2.toLowerCase()}`;

    // outcomePrices is a JSON array string like ["0.62", "0.38"]
    // outcomes is a JSON array string like ["Yes", "No"]
    let yesProb = null;
    try {
      const prices   = JSON.parse(market.outcomePrices || '[]');
      const outcomes = JSON.parse(market.outcomes      || '[]');
      const yesIdx   = outcomes.findIndex(o => /yes/i.test(o));

      if (yesIdx !== -1 && prices[yesIdx] != null) {
        yesProb = parseFloat(prices[yesIdx]);
      } else if (prices.length === 2) {
        yesProb = parseFloat(prices[0]); // assume first = Yes
      }
    } catch { continue; }

    if (yesProb == null || isNaN(yesProb)) continue;

    // "Yes" means the subject team wins — figure out which team that is
    // and whether they are home or away
    const subjectProb = parsed.subjectIsHome ? yesProb : 1 - yesProb;

    result[key] = {
      homeProb:   Math.round(subjectProb * 1000) / 1000,
      awayProb:   Math.round((1 - subjectProb) * 1000) / 1000,
      marketUrl:  `https://polymarket.com/event/${market.slug || market.id}`,
      liquidity:  market.liquidity ? Math.round(parseFloat(market.liquidity)) : null,
      volume:     market.volume    ? Math.round(parseFloat(market.volume))    : null,
      question:   market.question,
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Fetch MLB markets from Gamma API
// ---------------------------------------------------------------------------

async function fetchMLBMarkets(date) {
  // Try tag_slug first, fall back to keyword search
  const strategies = [
    () => fetchWithParams({ tag_slug: 'mlb',      active: 'true', closed: 'false', limit: '200' }),
    () => fetchWithParams({ tag_slug: 'baseball',  active: 'true', closed: 'false', limit: '200' }),
    () => fetchWithParams({ active: 'true', closed: 'false', limit: '500' }),
  ];

  for (const strategy of strategies) {
    try {
      const markets = await strategy();
      if (markets.length > 0) {
        // Filter to likely game markets
        const gameMarkets = markets.filter(m => looksLikeMLBGameMarket(m, date));
        if (gameMarkets.length > 0) {
          console.log(`   📊 Polymarket: found ${gameMarkets.length} MLB game markets for ${date}`);
          return gameMarkets;
        }
      }
    } catch { continue; }
  }

  console.warn(`   ⚠️  Polymarket: no MLB markets found for ${date}`);
  return [];
}

async function fetchWithParams(params) {
  const url = `${GAMMA_URL}?${new URLSearchParams(params)}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  // API returns array or { markets: [...] }
  return Array.isArray(data) ? data : (data.markets || []);
}

// ---------------------------------------------------------------------------
// Filter: does this market look like an MLB game market for our date?
// ---------------------------------------------------------------------------

function looksLikeMLBGameMarket(market, date) {
  const q = (market.question || market.title || '').toLowerCase();

  // Must mention winning/beating
  if (!q.includes('win') && !q.includes('beat')) return false;

  // Must mention at least one MLB team
  const mentionsTeam = MLB_TEAMS.some(t => q.includes(t));
  if (!mentionsTeam) return false;

  // Check end date is close to our target date
  if (market.endDate) {
    const end    = new Date(market.endDate);
    const target = new Date(date);
    const diff   = (end - target) / 86400000;
    if (diff < -1 || diff > 2) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Parse: extract team names and subject from a market question
// ---------------------------------------------------------------------------

/**
 * Returns { team1, team2, subjectTeam, subjectIsHome } or null.
 * team1/team2: full team names as they'd appear in our games data
 * subjectTeam: the team "Yes" refers to winning
 * subjectIsHome: whether the subject team is the home team
 */
function parseMLBMarket(market, date) {
  const q = (market.question || market.title || '').toLowerCase();

  let foundTeams = [];

  for (const [fullName, aliases] of Object.entries(MLB_TEAM_MAP)) {
    for (const alias of aliases) {
      if (q.includes(alias)) {
        foundTeams.push({ fullName, alias, pos: q.indexOf(alias) });
        break;
      }
    }
  }

  if (foundTeams.length < 2) return null;

  // Sort by position in question string
  foundTeams.sort((a, b) => a.pos - b.pos);
  const [first, second] = foundTeams;

  // "Will X beat Y" or "X to win" → X is the subject
  // "X vs Y: X win" → X is the subject
  const subjectTeam = first.fullName;

  // We don't know home/away from the market alone — that gets resolved
  // in findOddsForGame by matching against our schedule data
  return {
    team1:         first.fullName,
    team2:         second.fullName,
    subjectTeam:   first.fullName,
    subjectIsHome: true,  // resolved later in findOddsForGame
  };
}

// ---------------------------------------------------------------------------
// Match odds to a game from our schedule
// ---------------------------------------------------------------------------

/**
 * Finds the Polymarket entry for a specific game.
 * Tries several key combinations since we don't know which team
 * Polymarket lists first.
 */
function findOddsForGame(oddsMap, awayTeamName, homeTeamName) {
  const away = homeTeamName.toLowerCase();
  const home = awayTeamName.toLowerCase();

  // Try both orderings
  const keys = [
    `${home} vs ${away}`,
    `${away} vs ${home}`,
  ];

  for (const key of keys) {
    if (oddsMap[key]) {
      const entry = oddsMap[key];
      // If the key has home team first, swap the probs
      if (key.startsWith(away)) {
        return {
          ...entry,
          homeProb: entry.awayProb,
          awayProb: entry.homeProb,
        };
      }
      return entry;
    }
  }

  // Fuzzy match: find any key where both team name words appear
  for (const [key, entry] of Object.entries(oddsMap)) {
    const awayWord = awayTeamName.split(' ').pop().toLowerCase(); // e.g. "yankees"
    const homeWord = homeTeamName.split(' ').pop().toLowerCase(); // e.g. "sox"
    if (key.includes(awayWord) && key.includes(homeWord)) {
      // Determine ordering
      const awayFirst = key.indexOf(awayWord) < key.indexOf(homeWord);
      if (awayFirst) {
        // key is "away vs home" — entry.homeProb is already correct
        return entry;
      } else {
        // key is "home vs away" — swap
        return { ...entry, homeProb: entry.awayProb, awayProb: entry.homeProb };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// MLB team name lookup — aliases used to match Polymarket question text
// ---------------------------------------------------------------------------

const MLB_TEAM_MAP = {
  'Arizona Diamondbacks':    ['diamondbacks', 'd-backs', 'arizona d'],
  'Atlanta Braves':          ['braves', 'atlanta'],
  'Baltimore Orioles':       ['orioles', 'baltimore'],
  'Boston Red Sox':          ['red sox', 'boston'],
  'Chicago Cubs':            ['cubs', 'chicago cubs'],
  'Chicago White Sox':       ['white sox', 'chicago white'],
  'Cincinnati Reds':         ['reds', 'cincinnati'],
  'Cleveland Guardians':     ['guardians', 'cleveland'],
  'Colorado Rockies':        ['rockies', 'colorado'],
  'Detroit Tigers':          ['tigers', 'detroit'],
  'Houston Astros':          ['astros', 'houston'],
  'Kansas City Royals':      ['royals', 'kansas city'],
  'Los Angeles Angels':      ['angels', 'la angels', 'los angeles angels'],
  'Los Angeles Dodgers':     ['dodgers', 'la dodgers', 'los angeles dodgers'],
  'Miami Marlins':           ['marlins', 'miami'],
  'Milwaukee Brewers':       ['brewers', 'milwaukee'],
  'Minnesota Twins':         ['twins', 'minnesota'],
  'New York Mets':           ['mets', 'ny mets', 'new york mets'],
  'New York Yankees':        ['yankees', 'ny yankees', 'new york yankees'],
  'Oakland Athletics':       ['athletics', "a's", 'oakland'],
  'Philadelphia Phillies':   ['phillies', 'philadelphia'],
  'Pittsburgh Pirates':      ['pirates', 'pittsburgh'],
  'San Diego Padres':        ['padres', 'san diego'],
  'San Francisco Giants':    ['giants', 'san francisco'],
  'Seattle Mariners':        ['mariners', 'seattle'],
  'St. Louis Cardinals':     ['cardinals', 'st. louis', 'st louis'],
  'Tampa Bay Rays':          ['rays', 'tampa bay'],
  'Texas Rangers':           ['rangers', 'texas'],
  'Toronto Blue Jays':       ['blue jays', 'toronto'],
  'Washington Nationals':    ['nationals', 'washington'],
};

// Flat list for quick containment check
const MLB_TEAMS = Object.values(MLB_TEAM_MAP).flat();

module.exports = { fetchAllOdds, findOddsForGame };