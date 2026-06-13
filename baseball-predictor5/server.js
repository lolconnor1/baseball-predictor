'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const cron     = require('node-cron');

const app  = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Admin auth middleware — protect mutating endpoints when ADMIN_KEY is set
// ---------------------------------------------------------------------------
const ADMIN_KEY = process.env.ADMIN_KEY;
function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) return next(); // no key configured = open (local dev)
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

const ROOT           = __dirname;
const DATA_PATH      = path.join(ROOT, 'data', 'games.json');
const CAL_PATH       = path.join(ROOT, 'data', 'calibration.json');
const MODEL_PATH     = path.join(ROOT, 'data', 'model.json');
const LOG_PATH       = path.join(ROOT, 'data', 'accuracy-log.json');
const BETS_PATH      = path.join(ROOT, 'data', 'bets.json');
const PRED_CACHE_PATH = path.join(ROOT, 'data', 'prediction-cache.json');

app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

// ---------------------------------------------------------------------------
// GET /api/status — model info
// ---------------------------------------------------------------------------
app.get('/api/status', (req, res) => {
  if (!fs.existsSync(MODEL_PATH)) {
    return res.json({ trained: false });
  }

  const payload  = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
  const games    = fs.existsSync(DATA_PATH)
    ? JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'))
    : [];
  const lastDate = games.reduce((max, g) => g.date > max ? g.date : max, '');

  res.json({
    trained:        true,
    modelType:      payload.modelType ?? 'neural-net',
    seasons:        payload.trainedOn,
    splitType:      payload.splitType ?? 'random',
    testSeason:     payload.testSeason ?? null,
    testSize:       payload.testSize ?? null,
    trainedAt:      payload.trainedAt,
    lastUpdated:    payload.lastUpdated ?? null,
    testAccuracy:   payload.testAccuracy,
    baselineAcc:    payload.baselineAcc,
    totalGames:     payload.totalGames ?? payload.trainSize,
    cacheThrough:   lastDate,
    pitcherCoverage: payload.pitcherCoverage ?? null,
  });
});

// ---------------------------------------------------------------------------
// GET /api/predict?date=YYYY-MM-DD
// ---------------------------------------------------------------------------
app.get('/api/predict', async (req, res) => {
  const date = req.query.date || localToday();

  try {
    // We run the predict logic and capture its output as structured data
    const predictions = await runPredict(date);
    res.json({ date, predictions });
  } catch (err) {
    console.error('Predict error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/update — run the update script
// ---------------------------------------------------------------------------
app.post('/api/update', requireAdmin, async (req, res) => {
  try {
    const result = await runUpdate();
    res.json(result);
  } catch (err) {
    console.error('Update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/accuracy — accuracy log
// ---------------------------------------------------------------------------
app.get('/api/accuracy', (req, res) => {
  if (!fs.existsSync(LOG_PATH)) return res.json({ entries: [], stats: null });

  const log   = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
  const stats = computeStats(log);
  res.json({ entries: log.slice().reverse(), stats }); // newest first
});

// ---------------------------------------------------------------------------
// GET /api/bets — bet log with resolved outcomes
// ---------------------------------------------------------------------------
app.get('/api/bets', (_req, res) => {
  const bets = fs.existsSync(BETS_PATH)
    ? JSON.parse(fs.readFileSync(BETS_PATH, 'utf8'))
    : [];

  const log = fs.existsSync(LOG_PATH)
    ? JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'))
    : [];

  const logMap = new Map(log.map(e => [`${e.date}|${e.homeTeam}|${e.awayTeam}`, e]));

  const resolved = bets.map(bet => {
    const entry = logMap.get(`${bet.date}|${bet.homeTeam}|${bet.awayTeam}`);
    if (!entry) return { ...bet, status: 'pending', pnl: null };

    const betWon  = (bet.betSide === 'home') === entry.actualHome;
    const decimal = bet.betOdds > 0 ? bet.betOdds / 100 : 100 / Math.abs(bet.betOdds);
    const pnl     = betWon ? Math.round(bet.betAmount * decimal * 100) / 100 : -bet.betAmount;

    return {
      ...bet,
      status:     betWon ? 'won' : 'lost',
      pnl,
      actualHome: entry.actualHome,
      homeScore:  entry.homeScore,
      awayScore:  entry.awayScore,
    };
  });

  const settled      = resolved.filter(b => b.status !== 'pending');
  const won          = settled.filter(b => b.status === 'won');
  const netPnl       = settled.reduce((s, b) => s + b.pnl, 0);
  const totalWagered = resolved.reduce((s, b) => s + b.betAmount, 0);

  res.json({
    bets: resolved.slice().reverse(),
    stats: resolved.length > 0 ? {
      total:        resolved.length,
      settled:      settled.length,
      pending:      resolved.length - settled.length,
      won:          won.length,
      lost:         settled.length - won.length,
      winRate:      settled.length ? Math.round(won.length / settled.length * 1000) / 1000 : null,
      netPnl:       Math.round(netPnl * 100) / 100,
      totalWagered: Math.round(totalWagered * 100) / 100,
      roi:          totalWagered > 0 ? Math.round(netPnl / totalWagered * 10000) / 100 : 0,
    } : null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/bet — record a new bet
// ---------------------------------------------------------------------------
app.post('/api/bet', (req, res) => {
  const { date, homeTeam, awayTeam, betSide, betOdds, betAmount } = req.body;

  if (!date || !homeTeam || !awayTeam || !betSide || betOdds == null || !betAmount) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!['home', 'away'].includes(betSide)) {
    return res.status(400).json({ error: 'betSide must be "home" or "away"' });
  }
  if (typeof betAmount !== 'number' || betAmount <= 0) {
    return res.status(400).json({ error: 'betAmount must be a positive number' });
  }
  if (typeof betOdds !== 'number') {
    return res.status(400).json({ error: 'betOdds must be a number' });
  }

  const bets = fs.existsSync(BETS_PATH)
    ? JSON.parse(fs.readFileSync(BETS_PATH, 'utf8'))
    : [];

  const bet = {
    id:         `bet-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    placedAt:   new Date().toISOString(),
    date,
    homeTeam,
    awayTeam,
    betSide,
    betTeam:    betSide === 'home' ? homeTeam : awayTeam,
    betOdds:    Number(betOdds),
    betAmount:  Number(betAmount),
  };

  bets.push(bet);
  fs.writeFileSync(BETS_PATH, JSON.stringify(bets, null, 2));
  res.json({ success: true, bet });
});

// ---------------------------------------------------------------------------
// DELETE /api/bet/:id — remove a bet
// ---------------------------------------------------------------------------
app.delete('/api/bet/:id', (req, res) => {
  const bets = fs.existsSync(BETS_PATH)
    ? JSON.parse(fs.readFileSync(BETS_PATH, 'utf8'))
    : [];

  const filtered = bets.filter(b => b.id !== req.params.id);
  if (filtered.length === bets.length) {
    return res.status(404).json({ error: 'Bet not found' });
  }

  fs.writeFileSync(BETS_PATH, JSON.stringify(filtered, null, 2));
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Predict logic — returns structured data instead of printing
// ---------------------------------------------------------------------------
async function runPredict(date) {
  const { rfPredict } = require('./src/rfPredict');

  const { fetchGamesForDate }                               = require('./src/api');
  const { buildTeamHistory, computeTeamStats, computeH2HStats,
          computeScheduleContext, buildUmpireHistory,
          buildFeatureVector }                              = require('./src/features');
  const { fetchProbablePitchers, fetchPitcherRecentForm }  = require('./src/pitchers');
  const { getRawParkFactor, getVenueName }                 = require('./src/venues');
  const { fetchTeamSplits }                                = require('./src/splits');
  const { fetchGameWeather }                               = require('./src/weather');
  const { getVenueCoords }                                 = require('./src/venues');
  const { fetchBullpenERA }                                = require('./src/api');
  const { scrapeFanDuelOdds, americanToImplied, removeVig } = require('./src/fanduel-scraper');

  const payload = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));

  if (!payload.model) throw new Error('No valid model found in model.json — try retraining.');
  const featureNames = payload.featureNames;

  // Load calibration if available
  const calibration = fs.existsSync(CAL_PATH)
    ? JSON.parse(fs.readFileSync(CAL_PATH, 'utf8'))
    : null;
  const normStats = payload.normStats ?? null;

  if (calibration) {
    console.log(`   Calibration applied (a=${calibration.a.toFixed(3)}, b=${calibration.b.toFixed(3)})`);
  }

  const allGames = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const history     = buildTeamHistory(allGames);
  const umpireHistory = buildUmpireHistory(allGames);

  const [games, pitcherMap, fanDuelGames] = await Promise.all([
    fetchGamesForDate(date),
    fetchProbablePitchers(date),
    scrapeFanDuelOdds(date, { headless: true }).catch(() => []),
  ]);

  // Build a lookup map from team name keyword -> fanduel odds
  const fanDuelMap = {};
  for (const g of fanDuelGames) {
    const awayKey = g.away.team.split(' ').pop().toLowerCase();
    const homeKey = g.home.team.split(' ').pop().toLowerCase();
    fanDuelMap[awayKey] = { side: 'away', game: g };
    fanDuelMap[homeKey] = { side: 'home', game: g };
  }

  // Load bullpen cache if available
  const BULLPEN_PATH = path.join(ROOT, 'data', 'bullpen.json');
  let bullpenByGame = null;
  if (fs.existsSync(BULLPEN_PATH)) {
    const raw = JSON.parse(fs.readFileSync(BULLPEN_PATH, 'utf8'));
    bullpenByGame = new Map(Object.entries(raw).map(([k, v]) => [parseInt(k), v]));
  }

  // Load pitcher game logs cache if available
  const GAMELOGS_PATH = path.join(ROOT, 'data', 'pitcher-gamelogs.json');
  let pitcherGameLogsForDate = null;
  if (fs.existsSync(GAMELOGS_PATH)) {
    const raw    = JSON.parse(fs.readFileSync(GAMELOGS_PATH, 'utf8'));
    const season = date.slice(0, 4);
    const entries = raw[season] ?? [];
    pitcherGameLogsForDate = new Map(entries);
  }

  // Fetch pitcher IDs for recent form
  const scheduleUrl =
    `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=probablePitcher&gameType=R`;
  const schedResp = await fetch(scheduleUrl).catch(() => null);
  const pitcherIdsByGame = {};
  const allPitcherIds = new Set();

  if (schedResp?.ok) {
    const schedData = await schedResp.json();
    for (const dateObj of schedData.dates || []) {
      for (const game of dateObj.games || []) {
        pitcherIdsByGame[game.gamePk] = {
          homeId: game.teams?.home?.probablePitcher?.id ?? null,
          awayId: game.teams?.away?.probablePitcher?.id ?? null,
        };
        if (pitcherIdsByGame[game.gamePk].homeId) allPitcherIds.add(pitcherIdsByGame[game.gamePk].homeId);
        if (pitcherIdsByGame[game.gamePk].awayId) allPitcherIds.add(pitcherIdsByGame[game.gamePk].awayId);
      }
    }
  }

  const season     = date.slice(0, 4);
  const recentForm = allPitcherIds.size > 0
    ? await fetchPitcherRecentForm([...allPitcherIds], season)
    : {};

  // Fetch batting splits for all teams playing today (auto-cached)
  const teamSplitsMap = {};
  const teamIds = [...new Set(games.flatMap(g => [g.homeTeamId, g.awayTeamId]))];
  await Promise.all(teamIds.map(async teamId => {
    const splits = await fetchTeamSplits(teamId, season).catch(() => null);
    if (splits) teamSplitsMap[teamId] = splits;
  }));

  // Fetch weather for today's games (per venue/date, in-memory cache in weather.js)
  const gameWeatherMap = {};
  await Promise.all(games.map(async g => {
    const coords = getVenueCoords(g.homeTeamId);
    if (!coords) return;
    const w = await fetchGameWeather(coords.lat, coords.lon, date, g.homeTeamId).catch(() => null);
    if (w) gameWeatherMap[g.gameId] = w;
  }));

  // Fetch bullpen ERA for today's teams (from file cache + API refresh)
  const BULLPEN_ERA_PATH = path.join(ROOT, 'data', 'bullpen-era.json');
  let bullpenERAForSeason = new Map();
  if (fs.existsSync(BULLPEN_ERA_PATH)) {
    const raw = JSON.parse(fs.readFileSync(BULLPEN_ERA_PATH, 'utf8'));
    if (raw[season]) bullpenERAForSeason = new Map(raw[season]);
  }
  const missingTeams = teamIds.filter(id => !bullpenERAForSeason.has(id));
  if (missingTeams.length > 0) {
    const fresh = await fetchBullpenERA(missingTeams, season).catch(() => new Map());
    for (const [id, era] of fresh.entries()) bullpenERAForSeason.set(id, era);
  }

  const results = [];

  for (const game of games) {
    const { homeTeamName, awayTeamName, homeTeamId, awayTeamId, status, gameId } = game;

    const homeHistory = history[homeTeamId] || [];
    const awayHistory = history[awayTeamId] || [];
    const homeStats   = computeTeamStats(homeHistory, date);
    const awayStats   = computeTeamStats(awayHistory, date);

    if (!homeStats || !awayStats) {
      results.push({ homeTeamName, awayTeamName, status, insufficient: true });
      continue;
    }

    const h2hStats       = computeH2HStats(homeHistory, awayTeamId, date);
    const homeCtx        = computeScheduleContext(homeHistory, date);
    const awayCtx        = computeScheduleContext(awayHistory, date);
    const scheduleContext = { home: homeCtx, away: awayCtx };
    const pitcherStats   = pitcherMap[gameId] ?? null;

    const ids2      = pitcherIdsByGame[gameId] ?? {};
    const tierOneData = {
      homePitcherId:   ids2.homeId,
      awayPitcherId:   ids2.awayId,
      pitcherGameLogs: pitcherGameLogsForDate,
      homeHistory:     history[homeTeamId] || [],
      awayHistory:     history[awayTeamId] || [],
      bullpenByGame,
      date,
      umpireId:        game.umpireId ?? null,
      umpireStats:     umpireHistory,
      homeSplits:      teamSplitsMap[homeTeamId] ?? null,
      awaySplits:      teamSplitsMap[awayTeamId] ?? null,
      weather:         gameWeatherMap[gameId] ?? null,
      awayTeamId,
      bullpenERAByTeam: bullpenERAForSeason,
    };

    const features = buildFeatureVector(
      homeStats, awayStats, h2hStats, homeTeamId, pitcherStats, scheduleContext, tierOneData, normStats
    );

    const rawProb  = rfPredict(payload.model, featureNames, features);
    const homeProb = applyCalibration(rawProb, calibration);

    const ids     = pitcherIdsByGame[gameId] ?? {};
    const homeForm = ids.homeId ? recentForm[ids.homeId] : null;
    const awayForm = ids.awayId ? recentForm[ids.awayId] : null;

    // Match FanDuel odds to this game by team name keyword
    const homeKey = homeTeamName.split(' ').pop().toLowerCase();
    const fdEntry = fanDuelMap[homeKey];
    let fanduel = null;
    if (fdEntry) {
      const g   = fdEntry.game;
      const isHomeCorrect = fdEntry.side === 'home';
      const homeOdds = isHomeCorrect ? g.home.americanOdds : g.away.americanOdds;
      const awayOdds = isHomeCorrect ? g.away.americanOdds : g.home.americanOdds;
      const { homeProb: fdHomeProb, awayProb: fdAwayProb } = removeVig(
        americanToImplied(isHomeCorrect ? g.away.americanOdds : g.home.americanOdds),
        americanToImplied(homeOdds)
      );
      fanduel = {
        homeOdds,
        awayOdds,
        homeProb: Math.round(fdHomeProb * 1000) / 1000,
        awayProb: Math.round(fdAwayProb * 1000) / 1000,
      };
    }

    // Kelly criterion sizing (quarter Kelly)
    const kelly = fanduel ? computeKelly(homeProb, fanduel) : null;

    results.push({
      gameId,
      homeTeamName,
      awayTeamName,
      homeTeamId,
      status,
      rawProb:       Math.round(rawProb * 1000) / 1000,
      homeProb:      Math.round(homeProb * 1000) / 1000,
      calibrated:    calibration != null,
      awayProb:      Math.round((1 - homeProb) * 1000) / 1000,
      predictedWinner: homeProb >= 0.5 ? homeTeamName : awayTeamName,
      predictedHome:   homeProb >= 0.5,
      venueName:     getVenueName(homeTeamId),
      parkFactor:    getRawParkFactor(homeTeamId),
      homePitcher:   pitcherStats?.home ?? null,
      awayPitcher:   pitcherStats?.away ?? null,
      homeForm,
      awayForm,
      h2h: {
        homeWinPct: h2hStats.h2hHomeWinPct,
        runDiffAdv: h2hStats.h2hRunDiffAdv,
        hasHistory: !(h2hStats.h2hHomeWinPct === 0.5 && h2hStats.h2hRunDiffAdv === 0.5),
      },
      schedule: {
        homeRestDays:    Math.round(homeCtx.restDays * 5),
        awayRestDays:    Math.round(awayCtx.restDays * 5),
        homeGames7:      Math.round(homeCtx.scheduleDensity * 7),
        awayGames7:      Math.round(awayCtx.scheduleDensity * 7),
        homeStandLength: Math.round(homeCtx.homeStandLength * 7),
        roadTripLength:  Math.round(awayCtx.roadTripLength  * 7),
      },
      homeStats: {
        winPct:   Math.round(homeStats.winPct * 1000) / 1000,
        avgRS:    Math.round(homeStats.avgRS * 10) / 10,
        avgRA:    Math.round(homeStats.avgRA * 10) / 10,
        momentum: Math.round(homeStats.momentum * 1000) / 1000,
      },
      awayStats: {
        winPct:   Math.round(awayStats.winPct * 1000) / 1000,
        avgRS:    Math.round(awayStats.avgRS * 10) / 10,
        avgRA:    Math.round(awayStats.avgRA * 10) / 10,
        momentum: Math.round(awayStats.momentum * 1000) / 1000,
      },
      fanduel,
      kelly,
    });
  }

  // Persist predictions so update can use the exact same probabilities
  // for accuracy tracking (avoids stat-staleness discrepancies).
  const predCache = fs.existsSync(PRED_CACHE_PATH)
    ? JSON.parse(fs.readFileSync(PRED_CACHE_PATH, 'utf8'))
    : {};
  for (const r of results) {
    if (r.insufficient) continue;
    predCache[`${date}|${r.gameId}`] = {
      homeProb:      r.homeProb,
      rawProb:       r.rawProb,
      predictedHome: r.predictedHome,
    };
  }
  fs.writeFileSync(PRED_CACHE_PATH, JSON.stringify(predCache));

  return results;
}

// ---------------------------------------------------------------------------
// Update logic
// ---------------------------------------------------------------------------
async function runUpdate() {
  const { update } = require('./src/update');

  // Capture console output during update
  const lines = [];
  const orig  = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); orig(...args); };

  try {
    await update();
  } finally {
    console.log = orig;
  }

  const log   = fs.existsSync(LOG_PATH)
    ? JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'))
    : [];
  const stats = computeStats(log);

  return { success: true, log: lines, stats };
}

// ---------------------------------------------------------------------------
// Kelly criterion
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Platt scaling calibration
// ---------------------------------------------------------------------------
function applyCalibration(rawProb, cal) {
  if (!cal) return rawProb;
  return 1 / (1 + Math.exp(-(cal.a * rawProb + cal.b)));
}

function computeKelly(modelHomeProb, fanduel, {
  modelWeight   = 0.70,
  kellyFraction = 0.25,
} = {}) {
  // Blend model and market probabilities
  const marketWeight  = 1 - modelWeight;
  const blendedHome   = modelHomeProb * modelWeight + fanduel.homeProb * marketWeight;
  const blendedAway   = 1 - blendedHome;

  // Determine which side has edge and compute Kelly for that side
  const results = [];

  for (const side of ['home', 'away']) {
    const blended  = side === 'home' ? blendedHome   : blendedAway;
    const market   = side === 'home' ? fanduel.homeProb : fanduel.awayProb;
    const odds     = side === 'home' ? fanduel.homeOdds  : fanduel.awayOdds;

    // Convert American odds to decimal profit per 
    const decimal = odds > 0 ? odds / 100 : 100 / Math.abs(odds);
    const kelly   = (decimal * blended - (1 - blended)) / decimal;

    if (kelly > 0) {
      const fraction  = kelly * kellyFraction;
      const edge      = blended - market;
      results.push({
        side,
        betFraction:  Math.round(fraction * 1000) / 10,   // % of bankroll
        edge:         Math.round(edge * 1000) / 1000,
        blendedProb:  Math.round(blended * 1000) / 1000,
        marketProb:   Math.round(market * 1000) / 1000,
        odds,
        kelly:        Math.round(kelly * 1000) / 1000,
      });
    }
  }

  if (results.length === 0) return { bet: false, reason: 'No edge over market' };

  // Return the side with the highest edge
  const best = results.sort((a, b) => b.edge - a.edge)[0];
  return { bet: true, ...best };
}

// ---------------------------------------------------------------------------
// Stats helper
// ---------------------------------------------------------------------------
function computeStats(log) {
  if (!log.length) return null;

  const total   = log.length;
  const correct = log.filter(e => e.correct).length;

  const cutoff = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split('T')[0];
  })();

  const recent        = log.filter(e => e.date >= cutoff);
  const recentCorrect = recent.filter(e => e.correct).length;

  const confident     = log.filter(e => Math.max(e.homeProb, 1 - e.homeProb) >= 0.65);
  const confCorrect   = confident.filter(e => e.correct).length;

  // Per-team breakdown
  const teamMap = {};
  for (const e of log) {
    for (const [teamName, isHome] of [[e.homeTeam, true], [e.awayTeam, false]]) {
      if (!teamMap[teamName]) teamMap[teamName] = { total: 0, correct: 0 };
      teamMap[teamName].total++;
      // Correct if model predicted this team to win and they did, or predicted loss and they lost
      const modelPickedHome = e.predictedHome;
      const modelPickedThisTeam = isHome ? modelPickedHome : !modelPickedHome;
      const thisTeamWon = isHome ? e.actualHome : !e.actualHome;
      if (modelPickedThisTeam === thisTeamWon) teamMap[teamName].correct++;
    }
  }

  const teamStats = Object.entries(teamMap)
    .map(([team, s]) => ({
      team,
      total:    s.total,
      correct:  s.correct,
      accuracy: Math.round(s.correct / s.total * 1000) / 1000,
    }))
    .sort((a, b) => b.total - a.total);

  return {
    total, correct,
    accuracy:       Math.round(correct / total * 1000) / 1000,
    recentTotal:    recent.length,
    recentCorrect,
    recentAccuracy: recent.length ? Math.round(recentCorrect / recent.length * 1000) / 1000 : null,
    confTotal:      confident.length,
    confCorrect,
    confAccuracy:   confident.length ? Math.round(confCorrect / confident.length * 1000) / 1000 : null,
    teamStats,
  };
}

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Scheduled daily update — runs at 9:15 AM server time every day
// ---------------------------------------------------------------------------
cron.schedule('15 9 * * *', async () => {
  console.log(`[cron] Starting scheduled daily update…`);
  try {
    await runUpdate();
    console.log(`[cron] Daily update complete.`);
  } catch (err) {
    console.error(`[cron] Daily update failed:`, err.message);
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\n⚾  Baseball Oracle`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Admin auth: ${ADMIN_KEY ? 'enabled' : 'disabled (set ADMIN_KEY to enable)'}`);
  console.log(`   Daily update scheduled: 9:15 AM\n`);
});