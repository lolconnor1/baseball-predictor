'use strict';

const { rfPredict } = require('./rfPredict');
const fs    = require('fs');
const path  = require('path');

const { train }                                                 = require('./train');
const { fetchSeasonPitcherStats, fetchPitcherGameLogs,
        fetchBullpenData, fetchBullpenERA }                     = require('./api');
const { fetchTeamSplits }                                       = require('./splits');
const { fetchGameWeather }                                      = require('./weather');
const { getVenueCoords }                                        = require('./venues');
const { buildTeamHistory, computeTeamStats, computeH2HStats,
        computeScheduleContext, buildUmpireHistory,
        buildFeatureVector }                                        = require('./features');

const ROOT             = path.join(__dirname, '..');
const DATA_PATH        = path.join(ROOT, 'data', 'games.json');
const STATS_PATH       = path.join(ROOT, 'data', 'pitcher-stats.json');
const GAMELOGS_PATH    = path.join(ROOT, 'data', 'pitcher-gamelogs.json');
const BULLPEN_PATH     = path.join(ROOT, 'data', 'bullpen.json');
const MODEL_PATH       = path.join(ROOT, 'data', 'model.json');
const LOG_PATH         = path.join(ROOT, 'data', 'accuracy-log.json');
const WEATHER_PATH     = path.join(ROOT, 'data', 'weather-cache.json');
const BULLPEN_ERA_PATH = path.join(ROOT, 'data', 'bullpen-era.json');
const PRED_CACHE_PATH  = path.join(ROOT, 'data', 'prediction-cache.json');
const CAL_PATH         = path.join(ROOT, 'data', 'calibration.json');

// ---------------------------------------------------------------------------

async function update() {
  // ── 1. Check prerequisites ─────────────────────────────────────────────
  if (!fs.existsSync(MODEL_PATH)) {
    console.error('❌  No trained model found. Run `node index.js train` first.');
    process.exit(1);
  }
  if (!fs.existsSync(DATA_PATH)) {
    console.error('❌  No game data found. Run `node index.js train` first.');
    process.exit(1);
  }

  // ── 2. Find last cached game date ──────────────────────────────────────
  const existingGames = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const lastDate      = existingGames.reduce((max, g) => g.date > max ? g.date : max, '');
  const today         = new Date().toISOString().split('T')[0];

  if (!lastDate) {
    console.error('❌  Game cache is empty. Run `node index.js train` instead.');
    process.exit(1);
  }

  // Always re-fetch from lastDate (not lastDate+1) so late-finishing games
  // on a partial-day update are still picked up on the next run.
  // We deduplicate by gameId below so nothing gets double-counted.
  const fetchFrom = lastDate;
  if (fetchFrom > today) {
    console.log(`\n✅  Already up to date — last game in cache: ${lastDate}\n`);
    printAccuracySummary();
    return;
  }

  console.log(`\n⚾  Baseball Predictor — Incremental Update`);
  console.log(`   Cache current through : ${lastDate}`);
  console.log(`   Fetching new games    : ${fetchFrom} → ${today}\n`);

  // ── 3. Fetch new completed games ───────────────────────────────────────
  const scheduleData = await fetchRangeWithPitchers(fetchFrom, today);
  const fetchedGames  = parseCompletedGames(scheduleData);
  const cachedIds     = new Set(existingGames.map(g => g.gameId));
  const newGames      = fetchedGames.filter(g => !cachedIds.has(g.gameId));

  if (newGames.length === 0) {
    console.log(`ℹ️   No completed games found between ${fetchFrom} and ${today}.\n`);
    printAccuracySummary();
    return;
  }

  console.log(`📥  Found ${newGames.length} new completed games\n`);
  const allGames   = [...existingGames, ...newGames];
  const newSeasons = [...new Set(newGames.map(g => g.date.slice(0, 4)))];

  // ── 4. Load cached pitcher stats — do NOT refresh yet ─────────────────────
  // Refreshing before feature-building would contaminate the features with
  // post-game ERA/WHIP, giving accuracy numbers that can't be reproduced
  // from a real pre-game prediction. Stats are refreshed after training below.
  let pitcherStatsBySeason = {};
  if (fs.existsSync(STATS_PATH)) {
    const raw = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
    for (const [season, entries] of Object.entries(raw)) {
      pitcherStatsBySeason[season] = new Map(entries);
    }
  }

  const payload = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));

  const normStats   = payload.normStats ?? null;
  const calibration = fs.existsSync(CAL_PATH)
    ? JSON.parse(fs.readFileSync(CAL_PATH, 'utf8'))
    : null;
  const predCache = fs.existsSync(PRED_CACHE_PATH)
    ? JSON.parse(fs.readFileSync(PRED_CACHE_PATH, 'utf8'))
    : {};

  // ── 5. Build feature vectors using EXISTING history (no leakage) ───────
  // Important: we use existingGames (not allGames) to build the history so
  // that predictions are made with only data available before each game.
  console.log('🔧  Building feature vectors…');
  const history     = buildTeamHistory(existingGames);
  const umpireHistory = buildUmpireHistory(existingGames);

  // Load bullpen and game log caches
  let bullpenByGame = null;
  if (fs.existsSync(BULLPEN_PATH)) {
    const raw = JSON.parse(fs.readFileSync(BULLPEN_PATH, 'utf8'));
    bullpenByGame = new Map(Object.entries(raw).map(([k, v]) => [parseInt(k), v]));
  }

  // Fetch batting splits for affected seasons (cached per team)
  const splitsBySeason = {};
  for (const season of newSeasons) {
    splitsBySeason[season] = {};
    const teamIds = [...new Set(newGames.filter(g => g.date.startsWith(season))
      .flatMap(g => [g.homeTeamId, g.awayTeamId]))];
    for (const teamId of teamIds) {
      const splits = await fetchTeamSplits(teamId, season);
      if (splits) splitsBySeason[season][teamId] = splits;
    }
  }

  // Fetch weather for new games (merge into persistent cache)
  const weatherByGame = fs.existsSync(WEATHER_PATH)
    ? JSON.parse(fs.readFileSync(WEATHER_PATH, 'utf8'))
    : {};
  await Promise.all(newGames.map(async g => {
    if (weatherByGame[g.gameId]) return;
    const coords = getVenueCoords(g.homeTeamId);
    if (!coords) return;
    const w = await fetchGameWeather(coords.lat, coords.lon, g.date, g.homeTeamId);
    if (w) weatherByGame[g.gameId] = w;
  }));
  fs.writeFileSync(WEATHER_PATH, JSON.stringify(weatherByGame));

  // Fetch bullpen quality ERA for affected seasons (merge into persistent cache)
  const bullpenERABySeason = {};
  if (fs.existsSync(BULLPEN_ERA_PATH)) {
    const raw = JSON.parse(fs.readFileSync(BULLPEN_ERA_PATH, 'utf8'));
    for (const [season, entries] of Object.entries(raw)) {
      bullpenERABySeason[season] = new Map(entries);
    }
  }
  for (const season of newSeasons) {
    const teamIds = [...new Set(newGames.filter(g => g.date.startsWith(season))
      .flatMap(g => [g.homeTeamId, g.awayTeamId]))];
    const freshMap = await fetchBullpenERA(teamIds, season);
    if (!bullpenERABySeason[season]) bullpenERABySeason[season] = new Map();
    for (const [id, era] of freshMap.entries()) bullpenERABySeason[season].set(id, era);
  }
  const bullpenERASer = {};
  for (const [s, m] of Object.entries(bullpenERABySeason)) bullpenERASer[s] = [...m.entries()];
  fs.writeFileSync(BULLPEN_ERA_PATH, JSON.stringify(bullpenERASer));

  const predictions  = [];
  let   skipped      = 0;
  let   withPitchers = 0;
  let   fromCache    = 0;

  // Load game logs once outside the loop (avoid re-reading for every game)
  const gameLogsRaw = fs.existsSync(GAMELOGS_PATH)
    ? JSON.parse(fs.readFileSync(GAMELOGS_PATH, 'utf8'))
    : {};

  for (const g of newGames) {
    const cacheKey = `${g.date}|${g.gameId}`;
    const cached   = predCache[cacheKey];

    // Use the prediction that was actually shown to the user — no reconstruction needed
    if (cached?.homeProb != null) {
      predictions.push({ cachedHomeProb: cached.homeProb, game: g });
      fromCache++;
      continue;
    }

    // No cached prediction: rebuild the feature vector as a fallback
    const homeHistory = history[g.homeTeamId] || [];
    const awayHistory = history[g.awayTeamId] || [];

    const homeStats = computeTeamStats(homeHistory, g.date);
    const awayStats = computeTeamStats(awayHistory, g.date);
    if (!homeStats || !awayStats) { skipped++; continue; }

    const h2hStats = computeH2HStats(homeHistory, g.awayTeamId, g.date);

    const season    = g.date.slice(0, 4);
    const seasonMap = pitcherStatsBySeason[season];
    let   pitcherStats   = null;
    let   hasPitcherData = false;

    if (seasonMap && g.homePitcherId && g.awayPitcherId) {
      const homeP = seasonMap.get(g.homePitcherId);
      const awayP = seasonMap.get(g.awayPitcherId);
      if (homeP && awayP) {
        pitcherStats   = { home: homeP, away: awayP };
        hasPitcherData = true;
        withPitchers++;
      }
    }

    const homeCtx = computeScheduleContext(homeHistory, g.date);
    const awayCtx = computeScheduleContext(awayHistory, g.date);
    const scheduleContext = { home: homeCtx, away: awayCtx };

    const pitcherGameLogs = new Map((gameLogsRaw[season] ?? []).map(([k, v]) => [k, v]));

    const seasonSplits = splitsBySeason[season] ?? {};
    const tierOneData = {
      homePitcherId:    g.homePitcherId,
      awayPitcherId:    g.awayPitcherId,
      pitcherGameLogs,
      homeHistory,
      awayHistory,
      bullpenByGame,
      date:             g.date,
      umpireId:         g.umpireId ?? null,
      umpireStats:      umpireHistory,
      homeSplits:       seasonSplits[g.homeTeamId] ?? null,
      awaySplits:       seasonSplits[g.awayTeamId] ?? null,
      weather:          weatherByGame[g.gameId] ?? null,
      awayTeamId:       g.awayTeamId,
      bullpenERAByTeam: bullpenERABySeason[season] ?? null,
    };

    const features = buildFeatureVector(
      homeStats, awayStats, h2hStats, g.homeTeamId,
      pitcherStats, scheduleContext, tierOneData, normStats
    );

    predictions.push({ cachedHomeProb: null, features, game: g, hasPitcherData });
  }

  console.log(`   ${predictions.length} predictions (${fromCache} from cache, ${withPitchers} rebuilt with pitcher data, ${skipped} skipped)\n`);

  if (predictions.length === 0) {
    console.log('ℹ️   No usable examples from new games.\n');
    return;
  }

  // ── 6. Load model and run predictions BEFORE training ──────────────────
  

  if (!payload.model) throw new Error('No valid model found in model.json — try retraining.');
  const featureNames = payload.featureNames;

  console.log(`🎯  Evaluating predictions on new games…`);
  const logEntries = [];
  let   correct    = 0;

  for (const p of predictions) {
    let homeProb;
    if (p.cachedHomeProb != null) {
      homeProb = p.cachedHomeProb;
    } else {
      const rawProb = rfPredict(payload.model, featureNames, p.features);
      homeProb = calibration
        ? 1 / (1 + Math.exp(-(calibration.a * rawProb + calibration.b)))
        : rawProb;
    }

    const game             = p.game;
    const predictedHomeWin = homeProb > 0.5;
    const wasCorrect       = predictedHomeWin === game.homeWin;
    if (wasCorrect) correct++;

    logEntries.push({
      date:          game.date,
      homeTeam:      game.homeTeamName,
      awayTeam:      game.awayTeamName,
      homeScore:     game.homeScore,
      awayScore:     game.awayScore,
      predictedHome: predictedHomeWin,
      actualHome:    game.homeWin,
      homeProb:      Math.round(homeProb * 1000) / 1000,
      correct:       wasCorrect,
    });
  }

  const batchAccuracy = correct / predictions.length;

  // Print per-game results
  const divider = '─'.repeat(68);
  console.log(`\n${divider}`);
  for (const e of logEntries) {
    const label  = e.correct ? '✅' : '❌';
    const pick   = e.predictedHome ? e.homeTeam : e.awayTeam;
    const winner = e.actualHome    ? e.homeTeam : e.awayTeam;
    const conf   = e.predictedHome ? e.homeProb : 1 - e.homeProb;
    console.log(
      `  ${label}  ${e.date}  ${e.awayTeam} @ ${e.homeTeam}  ` +
      `[${e.awayScore}–${e.homeScore}]  ` +
      `picked ${pick} (${(conf * 100).toFixed(1)}%)  actual: ${winner}`
    );
  }

  console.log(`${divider}`);
  console.log(`  Batch accuracy: ${correct}/${predictions.length} = ${(batchAccuracy * 100).toFixed(1)}%\n`);

  // ── 7. Append to accuracy log ──────────────────────────────────────────
  const existingLog = fs.existsSync(LOG_PATH)
    ? JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'))
    : [];

  const updatedLog = [...existingLog, ...logEntries];
  fs.writeFileSync(LOG_PATH, JSON.stringify(updatedLog, null, 2));

  // ── 8. Append new games to cache ──────────────────────────────────────
  fs.writeFileSync(DATA_PATH, JSON.stringify(allGames));
  console.log(`\n💾  Cache: ${existingGames.length} → ${allGames.length} games`);

  // ── 9. Refresh pitcher stats, game logs & bullpen (after accuracy is locked) ──
  for (const season of newSeasons) {
    console.log(`🔄  Refreshing pitcher stats for ${season}…`);
    pitcherStatsBySeason[season] = await fetchSeasonPitcherStats(season);
  }
  const serialisable = {};
  for (const [season, map] of Object.entries(pitcherStatsBySeason)) {
    serialisable[season] = [...map.entries()];
  }
  fs.writeFileSync(STATS_PATH, JSON.stringify(serialisable));

  for (const season of newSeasons) {
    const raw        = fs.existsSync(GAMELOGS_PATH) ? JSON.parse(fs.readFileSync(GAMELOGS_PATH, 'utf8')) : {};
    const pitcherIds = [...new Set(
      allGames.filter(g => g.date.startsWith(season))
              .flatMap(g => [g.homePitcherId, g.awayPitcherId].filter(Boolean))
    )];
    const logs = await fetchPitcherGameLogs(pitcherIds, season);
    raw[season] = [...logs.entries()];
    fs.writeFileSync(GAMELOGS_PATH, JSON.stringify(raw));
    console.log(`   Game logs refreshed for ${season}: ${logs.size} pitchers`);
  }

  const newGameIds = newGames.map(g => g.gameId);
  if (newGameIds.length > 0) {
    const existing   = fs.existsSync(BULLPEN_PATH) ? JSON.parse(fs.readFileSync(BULLPEN_PATH, 'utf8')) : {};
    const newBullpen = await fetchBullpenData(newGameIds);
    for (const [k, v] of newBullpen.entries()) existing[k] = v;
    fs.writeFileSync(BULLPEN_PATH, JSON.stringify(existing));
    console.log(`   Bullpen data updated: ${newBullpen.size} new games`);
  }

  // ── 10. Full retrain on all data ──────────────────────────────────────
  const seasons = payload.trainedOn ?? [2024, 2025, 2026];
  console.log(`🌲  Triggering full retrain on ${allGames.length} games…`);
  await train({ seasons, fresh: false });

  const updatedModel = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
  updatedModel.lastUpdated = today;
  updatedModel.totalGames  = allGames.length;
  fs.writeFileSync(MODEL_PATH, JSON.stringify(updatedModel));
  console.log(`✅  Model retrained through ${today}\n`);

  // ── 11. Print running accuracy summary ────────────────────────────────
  printAccuracySummary(updatedLog);
}

// ---------------------------------------------------------------------------
// Accuracy summary — printed at the end of every update
// ---------------------------------------------------------------------------

function printAccuracySummary(log) {
  if (!log) {
    if (!fs.existsSync(LOG_PATH)) return;
    log = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
  }
  if (log.length === 0) return;

  const total   = log.length;
  const correct = log.filter(e => e.correct).length;
  const overall = correct / total;

  // Last 30 days
  const cutoff  = offsetDate(new Date().toISOString().split('T')[0], -30);
  const recent  = log.filter(e => e.date >= cutoff);
  const recentCorrect = recent.filter(e => e.correct).length;

  // High-confidence picks (>= 65%)
  const confident = log.filter(e => Math.max(e.homeProb, 1 - e.homeProb) >= 0.65);
  const confCorrect = confident.filter(e => e.correct).length;

  console.log('📈  Running Accuracy Summary');
  console.log('─'.repeat(40));
  console.log(`  All-time    : ${correct}/${total} = ${(overall * 100).toFixed(1)}%`);

  if (recent.length > 0) {
    console.log(`  Last 30 days: ${recentCorrect}/${recent.length} = ${(recentCorrect / recent.length * 100).toFixed(1)}%`);
  }

  if (confident.length > 0) {
    console.log(`  High conf (≥65%): ${confCorrect}/${confident.length} = ${(confCorrect / confident.length * 100).toFixed(1)}%`);
  }

  // Streak
  const streak = currentStreak(log);
  if (streak.count > 1) {
    console.log(`  Current streak: ${streak.count} ${streak.correct ? 'correct ✅' : 'incorrect ❌'}`);
  }

  console.log('─'.repeat(40));
  console.log(`  Log saved to data/accuracy-log.json\n`);
}

function currentStreak(log) {
  if (log.length === 0) return { count: 0, correct: true };
  const last = log[log.length - 1].correct;
  let count  = 1;
  for (let i = log.length - 2; i >= 0; i--) {
    if (log[i].correct === last) count++;
    else break;
  }
  return { count, correct: last };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = 'https://statsapi.mlb.com/api/v1';

async function fetchRangeWithPitchers(startDate, endDate) {
  const url =
    `${BASE_URL}/schedule?sportId=1` +
    `&startDate=${startDate}&endDate=${endDate}` +
    `&hydrate=linescore,team,probablePitcher&gameType=R`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB API error ${res.status}`);
  return res.json();
}

function parseCompletedGames(scheduleData) {
  const games = [];
  for (const dateObj of scheduleData.dates || []) {
    for (const game of dateObj.games || []) {
      if (game.status?.detailedState !== 'Final') continue;
      const home      = game.teams.home;
      const away      = game.teams.away;
      const homeScore = home.score ?? 0;
      const awayScore = away.score ?? 0;
      if (homeScore === awayScore) continue;

      games.push({
        gameId:        game.gamePk,
        date:          dateObj.date,
        homeTeamId:    home.team.id,
        homeTeamName:  home.team.name,
        awayTeamId:    away.team.id,
        awayTeamName:  away.team.name,
        homeScore,
        awayScore,
        homeWin:       homeScore > awayScore,
        homePitcherId: game.teams.home.probablePitcher?.id ?? null,
        awayPitcherId: game.teams.away.probablePitcher?.id ?? null,
      });
    }
  }
  return games.sort((a, b) => a.date.localeCompare(b.date));
}

function offsetDate(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

module.exports = { update };