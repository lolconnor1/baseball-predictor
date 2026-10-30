'use strict';

const { rfPredict } = require('./rfPredict');
const fs    = require('fs');
const path  = require('path');

const { train }                                                 = require('./train');
const { fetchBullpenData }                                      = require('./api');
const { fetchGameWeather }                                      = require('./weather');
const { getVenueCoords }                                        = require('./venues');
const { buildTeamHistory, buildUmpireHistory, buildGameFeatures } = require('./features');
const { loadPitCache, ensureSeasonLogs, ensurePitcherSeasons,
        buildPitContext }                                       = require('./pointInTime');

const ROOT             = path.join(__dirname, '..');
const DATA_PATH        = path.join(ROOT, 'data', 'games.json');
const BULLPEN_PATH     = path.join(ROOT, 'data', 'bullpen.json');
const MODEL_PATH       = path.join(ROOT, 'data', 'model.json');
const LOG_PATH         = path.join(ROOT, 'data', 'accuracy-log.json');
const WEATHER_PATH     = path.join(ROOT, 'data', 'weather-cache.json');
const PRED_CACHE_PATH  = path.join(ROOT, 'data', 'prediction-cache.json');

// ---------------------------------------------------------------------------

async function update() {
  // ── 1. Check prerequisites ─────────────────────────────────────────────
  // Throw rather than exit — update() also runs inside the web server's cron
  if (!fs.existsSync(MODEL_PATH)) {
    throw new Error('No trained model found. Run `node index.js train` first.');
  }
  if (!fs.existsSync(DATA_PATH)) {
    throw new Error('No game data found. Run `node index.js train` first.');
  }

  // ── 2. Find last cached game date ──────────────────────────────────────
  const existingGames = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const lastDate      = existingGames.reduce((max, g) => g.date > max ? g.date : max, '');
  const today         = new Date().toISOString().split('T')[0];

  if (!lastDate) {
    throw new Error('Game cache is empty. Run `node index.js train` instead.');
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

  const payload = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));

  const normStats   = payload.normStats ?? null;
  const calibration = payload.model?.calibration ?? null;
  const predCache = fs.existsSync(PRED_CACHE_PATH)
    ? JSON.parse(fs.readFileSync(PRED_CACHE_PATH, 'utf8'))
    : {};

  // ── 4. Build feature vectors for games with no pre-game prediction ────
  // Everything goes through buildGameFeatures, which only uses data from
  // before each game's date, so refreshing the logs first doesn't leak.
  console.log('🔧  Building feature vectors…');
  const history       = buildTeamHistory(existingGames);
  const umpireHistory = buildUmpireHistory(existingGames);

  let bullpenByGame = null;
  if (fs.existsSync(BULLPEN_PATH)) {
    const raw = JSON.parse(fs.readFileSync(BULLPEN_PATH, 'utf8'));
    bullpenByGame = new Map(Object.entries(raw).map(([k, v]) => [parseInt(k), v]));
  }

  // Fetch weather for new games (merge into persistent cache)
  const weatherByGame = fs.existsSync(WEATHER_PATH)
    ? JSON.parse(fs.readFileSync(WEATHER_PATH, 'utf8'))
    : {};
  // Batched so a large catch-up (e.g. after the off-season) doesn't flood the API
  const needWeather = newGames.filter(g => !weatherByGame[g.gameId] && getVenueCoords(g.homeTeamId));
  for (let i = 0; i < needWeather.length; i += 5) {
    await Promise.all(needWeather.slice(i, i + 5).map(async g => {
      const coords = getVenueCoords(g.homeTeamId);
      const w = await fetchGameWeather(coords.lat, coords.lon, g.date, g.homeTeamId);
      if (w) weatherByGame[g.gameId] = w;
    }));
    if (i + 5 < needWeather.length) await new Promise(r => setTimeout(r, 200));
  }
  fs.writeFileSync(WEATHER_PATH, JSON.stringify(weatherByGame));

  const needsRebuild = newGames.some(g => predCache[`${g.date}|${g.gameId}`]?.homeProb == null);
  let pit = null;
  if (needsRebuild) {
    const pitCache = loadPitCache();
    await ensureSeasonLogs(pitCache, allGames, newSeasons);
    pit = buildPitContext(pitCache, await ensurePitcherSeasons(newSeasons));
  }
  const featureCtx = { history, umpireHistory, pit, bullpenByGame, weatherByGame, normStats };

  const predictions = [];
  let   skipped     = 0;
  let   fromCache   = 0;

  for (const g of newGames) {
    const cached = predCache[`${g.date}|${g.gameId}`];

    // Use the prediction that was actually shown before the game
    if (cached?.homeProb != null) {
      predictions.push({ cachedHomeProb: cached.homeProb, game: g });
      fromCache++;
      continue;
    }

    // No pre-game prediction recorded: rebuild it as a fallback
    const built = buildGameFeatures(g, featureCtx);
    if (!built) { skipped++; continue; }
    predictions.push({ cachedHomeProb: null, features: built.features, game: g });
  }

  console.log(`   ${predictions.length} predictions (${fromCache} pre-game, ${predictions.length - fromCache} rebuilt, ${skipped} skipped)\n`);

  if (predictions.length === 0) {
    console.log('ℹ️   No usable examples from new games.\n');
    return;
  }

  // ── 5. Load model and run predictions BEFORE training ──────────────────
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
      pregame:       p.cachedHomeProb != null,
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

  // ── 6. Append to accuracy log ──────────────────────────────────────────
  const existingLog = fs.existsSync(LOG_PATH)
    ? JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'))
    : [];

  const updatedLog = [...existingLog, ...logEntries];
  fs.writeFileSync(LOG_PATH, JSON.stringify(updatedLog, null, 2));

  // ── 7. Append new games to cache ──────────────────────────────────────
  fs.writeFileSync(DATA_PATH, JSON.stringify(allGames));
  console.log(`\n💾  Cache: ${existingGames.length} → ${allGames.length} games`);

  // ── 8. Bullpen pitch counts for the new games ─────────────────────────
  const newGameIds = newGames.map(g => g.gameId);
  if (newGameIds.length > 0) {
    const existing   = fs.existsSync(BULLPEN_PATH) ? JSON.parse(fs.readFileSync(BULLPEN_PATH, 'utf8')) : {};
    const newBullpen = await fetchBullpenData(newGameIds);
    for (const [k, v] of newBullpen.entries()) existing[k] = v;
    fs.writeFileSync(BULLPEN_PATH, JSON.stringify(existing));
    console.log(`   Bullpen data updated: ${newBullpen.size} new games`);
  }

  // ── 9. Full retrain on all data ──────────────────────────────────────
  // Include any new season that's appeared in the data (e.g. opening day 2027)
  const seasons = [...new Set([
    ...(payload.trainedOn ?? []),
    ...allGames.map(g => Number(g.date.slice(0, 4))),
  ])].sort();
  console.log(`🌲  Triggering full retrain on ${allGames.length} games…`);
  await train({ seasons, fresh: false });

  const updatedModel = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
  updatedModel.lastUpdated = today;
  updatedModel.totalGames  = allGames.length;
  fs.writeFileSync(MODEL_PATH, JSON.stringify(updatedModel));
  console.log(`✅  Model retrained through ${today}\n`);

  // ── 10. Print running accuracy summary ────────────────────────────────
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
    `&hydrate=linescore,team,probablePitcher,officials&gameType=R`;
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
        umpireId:      (game.officials ?? [])
          .find(o => (o.officialType || '').toLowerCase().includes('plate'))?.official?.id ?? null,
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