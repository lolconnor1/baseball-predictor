'use strict';

const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const { fetchHistoricalGames, fetchSeasonPitcherStats,
        fetchPitcherGameLogs, fetchBullpenData,
        fetchBullpenERA }                         = require('./api');
const { fetchTeamSplits }                         = require('./splits');
const { fetchGameWeather }                        = require('./weather');
const { getVenueCoords }                          = require('./venues');
const { buildTrainingData }                       = require('./features');

const ROOT         = path.join(__dirname, '..');
const DATA_PATH    = path.join(ROOT, 'data', 'games.json');
const STATS_PATH   = path.join(ROOT, 'data', 'pitcher-stats.json');
const GAMELOGS_PATH  = path.join(ROOT, 'data', 'pitcher-gamelogs.json');
const BULLPEN_PATH   = path.join(ROOT, 'data', 'bullpen.json');
const WEATHER_PATH   = path.join(ROOT, 'data', 'weather-cache.json');
const MODEL_PATH     = path.join(ROOT, 'data', 'model.json');
const CAL_PATH       = path.join(ROOT, 'data', 'calibration.json');


async function train({ seasons = [2021, 2022, 2023, 2024, 2025, 2026], fresh = false } = {}) {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });

  // ── 1. Load or fetch game data ─────────────────────────────────────
  let allGames;
  if (!fresh && fs.existsSync(DATA_PATH)) {
    allGames = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    const cachedSeasons = new Set(allGames.map(g => g.date.slice(0, 4)));
    const missingSeasons = seasons.filter(s => !cachedSeasons.has(String(s)));
    if (missingSeasons.length === 0) {
      console.log(`📦  Loading cached game data… ${allGames.length} games loaded.\n`);
    } else {
      console.log(`📦  Loaded ${allGames.length} cached games. Fetching missing seasons: ${missingSeasons.join(', ')}…`);
      for (const season of missingSeasons) {
        const games = await fetchHistoricalGames(season);
        allGames.push(...games);
        console.log(`   ✅  ${season}: ${games.length} games`);
      }
      allGames.sort((a, b) => a.date.localeCompare(b.date));
      fs.writeFileSync(DATA_PATH, JSON.stringify(allGames));
      console.log(`💾  Saved ${allGames.length} games\n`);
    }
  } else {
    allGames = [];
    for (const season of seasons) {
      const games = await fetchHistoricalGames(season);
      allGames.push(...games);
      console.log(`   ✅  ${season}: ${games.length} games`);
    }
    fs.writeFileSync(DATA_PATH, JSON.stringify(allGames));
    console.log(`💾  Saved ${allGames.length} games\n`);
  }

  // ── 2. Pitcher season stats ────────────────────────────────────────
  let pitcherStatsBySeason;
  if (!fresh && fs.existsSync(STATS_PATH)) {
    const raw = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
    pitcherStatsBySeason = {};
    for (const [season, entries] of Object.entries(raw)) {
      pitcherStatsBySeason[season] = new Map(entries);
    }
    const missingSeasonsStats = seasons.filter(s => !pitcherStatsBySeason[s]);
    if (missingSeasonsStats.length === 0) {
      const total = Object.values(pitcherStatsBySeason).reduce((s, m) => s + m.size, 0);
      console.log(`📦  Loading cached pitcher season stats… ${total} records loaded.\n`);
    } else {
      console.log(`📦  Pitcher stats cache missing seasons: ${missingSeasonsStats.join(', ')}. Fetching…`);
      for (const season of missingSeasonsStats) {
        pitcherStatsBySeason[season] = await fetchSeasonPitcherStats(season);
        console.log(`   ✅  ${season}: ${pitcherStatsBySeason[season].size} pitchers`);
      }
      const ser = {};
      for (const [s, m] of Object.entries(pitcherStatsBySeason)) ser[s] = [...m.entries()];
      fs.writeFileSync(STATS_PATH, JSON.stringify(ser));
      console.log(`💾  Saved pitcher season stats\n`);
    }
  } else {
    pitcherStatsBySeason = {};
    for (const season of seasons) {
      pitcherStatsBySeason[season] = await fetchSeasonPitcherStats(season);
    }
    const ser = {};
    for (const [s, m] of Object.entries(pitcherStatsBySeason)) ser[s] = [...m.entries()];
    fs.writeFileSync(STATS_PATH, JSON.stringify(ser));
    console.log(`💾  Saved pitcher season stats\n`);
  }

  // ── 3. Pitcher game logs (recent form) ────────────────────────────
  let pitcherGameLogsBySeason;
  if (!fresh && fs.existsSync(GAMELOGS_PATH)) {
    const raw = JSON.parse(fs.readFileSync(GAMELOGS_PATH, 'utf8'));
    pitcherGameLogsBySeason = {};
    for (const [season, entries] of Object.entries(raw)) {
      pitcherGameLogsBySeason[season] = new Map(entries);
    }
    const missingSeasonLogs = seasons.filter(s => !pitcherGameLogsBySeason[s]);
    if (missingSeasonLogs.length === 0) {
      const total = Object.values(pitcherGameLogsBySeason).reduce((s, m) => s + m.size, 0);
      console.log(`📦  Loading cached pitcher game logs… ${total} records loaded.\n`);
    } else {
      console.log(`📦  Pitcher game logs missing seasons: ${missingSeasonLogs.join(', ')}. Fetching…`);
      for (const season of missingSeasonLogs) {
        const pitcherIds = [...new Set(
          allGames
            .filter(g => g.date.startsWith(season))
            .flatMap(g => [g.homePitcherId, g.awayPitcherId].filter(Boolean))
        )];
        console.log(`   ${season}: ${pitcherIds.length} unique starters`);
        pitcherGameLogsBySeason[season] = await fetchPitcherGameLogs(pitcherIds, season);
        console.log(`   → ${pitcherGameLogsBySeason[season].size} game logs retrieved`);
      }
      const ser = {};
      for (const [s, m] of Object.entries(pitcherGameLogsBySeason)) ser[s] = [...m.entries()];
      fs.writeFileSync(GAMELOGS_PATH, JSON.stringify(ser));
      console.log(`💾  Saved pitcher game logs\n`);
    }
  } else {
    pitcherGameLogsBySeason = {};
    for (const season of seasons) {
      const pitcherIds = [...new Set(
        allGames
          .filter(g => g.date.startsWith(season))
          .flatMap(g => [g.homePitcherId, g.awayPitcherId].filter(Boolean))
      )];
      console.log(`   ${season}: fetching ${pitcherIds.length} pitcher game logs…`);
      pitcherGameLogsBySeason[season] = await fetchPitcherGameLogs(pitcherIds, season);
    }
    const ser = {};
    for (const [s, m] of Object.entries(pitcherGameLogsBySeason)) ser[s] = [...m.entries()];
    fs.writeFileSync(GAMELOGS_PATH, JSON.stringify(ser));
    console.log(`💾  Saved pitcher game logs\n`);
  }

  // ── 4. Bullpen pitch counts ────────────────────────────────────────
  let bullpenByGame;
  if (!fresh && fs.existsSync(BULLPEN_PATH)) {
    const raw = JSON.parse(fs.readFileSync(BULLPEN_PATH, 'utf8'));
    bullpenByGame = new Map(Object.entries(raw).map(([k, v]) => [parseInt(k), v]));
    // Fetch bullpen data for any seasons whose games are not yet in cache
    const missingSeasonBullpen = seasons.filter(s =>
      allGames.some(g => g.date.startsWith(s) && !bullpenByGame.has(g.gameId))
    );
    if (missingSeasonBullpen.length === 0) {
      console.log(`📦  Loading cached bullpen data… ${bullpenByGame.size} records loaded.\n`);
    } else {
      console.log(`📦  Bullpen cache missing data for: ${missingSeasonBullpen.join(', ')}. Fetching…`);
      for (const season of missingSeasonBullpen) {
        const gameIds = allGames.filter(g => g.date.startsWith(season) && !bullpenByGame.has(g.gameId)).map(g => g.gameId);
        console.log(`   ${season}: fetching ${gameIds.length} boxscores…`);
        const data = await fetchBullpenData(gameIds);
        for (const [id, val] of data.entries()) bullpenByGame.set(id, val);
        console.log(`   ✅  ${data.size} boxscores loaded for ${season}`);
      }
      const ser = {};
      for (const [k, v] of bullpenByGame.entries()) ser[k] = v;
      fs.writeFileSync(BULLPEN_PATH, JSON.stringify(ser));
      console.log(`💾  Saved bullpen data\n`);
    }
  } else {
    bullpenByGame = new Map();
    for (const season of seasons) {
      const gameIds = allGames.filter(g => g.date.startsWith(season)).map(g => g.gameId);
      console.log(`   ${season}: fetching ${gameIds.length} boxscores…`);
      const data = await fetchBullpenData(gameIds);
      for (const [id, val] of data.entries()) bullpenByGame.set(id, val);
      console.log(`   ✅  ${data.size} boxscores loaded for ${season}`);
    }
    const ser = {};
    for (const [k, v] of bullpenByGame.entries()) ser[k] = v;
    fs.writeFileSync(BULLPEN_PATH, JSON.stringify(ser));
    console.log(`💾  Saved bullpen data\n`);
  }

  // ── 5. Team batting splits vs LHP/RHP (auto-cached per season file) ─
  console.log('🔄  Loading team batting splits…');
  const splitsBySeason = {};
  for (const season of seasons) {
    splitsBySeason[season] = {};
    const teamIds = [...new Set(allGames.filter(g => g.date.startsWith(season))
      .flatMap(g => [g.homeTeamId, g.awayTeamId]))];
    for (const teamId of teamIds) {
      const splits = await fetchTeamSplits(teamId, season);
      if (splits) splitsBySeason[season][teamId] = splits;
    }
    console.log(`   ${season}: ${Object.keys(splitsBySeason[season]).length} teams loaded`);
  }
  console.log();

  // ── 6. Weather per game (cached in weather-cache.json) ───────────
  let weatherByGame = {};
  if (fs.existsSync(WEATHER_PATH)) {
    weatherByGame = JSON.parse(fs.readFileSync(WEATHER_PATH, 'utf8'));
    console.log(`📦  Weather cache: ${Object.keys(weatherByGame).length} games loaded.`);
  }

  // Always fill in any missing games (rate-limited: batch=5, 200ms between batches)
  const missingGames = allGames.filter(g => !weatherByGame[g.gameId] && getVenueCoords(g.homeTeamId));
  if (missingGames.length > 0) {
    console.log(`🌤️   Fetching weather for ${missingGames.length} missing games…`);
    let fetched = 0;
    const BATCH = 5;
    for (let i = 0; i < missingGames.length; i += BATCH) {
      const batch = missingGames.slice(i, i + BATCH);
      await Promise.all(batch.map(async g => {
        const coords = getVenueCoords(g.homeTeamId);
        const w = await fetchGameWeather(coords.lat, coords.lon, g.date, g.homeTeamId);
        if (w) { weatherByGame[g.gameId] = w; fetched++; }
      }));
      if (i + BATCH < missingGames.length) await new Promise(r => setTimeout(r, 200));
      if ((i / BATCH) % 50 === 49) {
        fs.writeFileSync(WEATHER_PATH, JSON.stringify(weatherByGame));
        console.log(`   … ${i + BATCH}/${missingGames.length} fetched`);
      }
    }
    fs.writeFileSync(WEATHER_PATH, JSON.stringify(weatherByGame));
    console.log(`💾  Saved weather — ${fetched} new games (${Object.keys(weatherByGame).length} total)\n`);
  } else {
    console.log(`   All games already cached.\n`);
  }

  // ── 7. Bullpen quality ERA by team/season ────────────────────────
  const BULLPEN_ERA_PATH = path.join(ROOT, 'data', 'bullpen-era.json');
  let bullpenERABySeason = {};
  if (!fresh && fs.existsSync(BULLPEN_ERA_PATH)) {
    const raw = JSON.parse(fs.readFileSync(BULLPEN_ERA_PATH, 'utf8'));
    for (const [season, entries] of Object.entries(raw)) {
      bullpenERABySeason[season] = new Map(entries);
    }
    const missingSeasonERA = seasons.filter(s => !bullpenERABySeason[s]);
    if (missingSeasonERA.length === 0) {
      const total = Object.values(bullpenERABySeason).reduce((s, m) => s + m.size, 0);
      console.log(`📦  Loading cached bullpen ERA data… ${total} records loaded.\n`);
    } else {
      console.log(`📦  Bullpen ERA missing seasons: ${missingSeasonERA.join(', ')}. Fetching…`);
      for (const season of missingSeasonERA) {
        const teamIds = [...new Set(allGames.filter(g => g.date.startsWith(season))
          .flatMap(g => [g.homeTeamId, g.awayTeamId]))];
        bullpenERABySeason[season] = await fetchBullpenERA(teamIds, season);
        console.log(`   ${season}: ${bullpenERABySeason[season].size} teams`);
      }
      const ser = {};
      for (const [s, m] of Object.entries(bullpenERABySeason)) ser[s] = [...m.entries()];
      fs.writeFileSync(BULLPEN_ERA_PATH, JSON.stringify(ser));
      console.log(`💾  Saved bullpen ERA data\n`);
    }
  } else {
    for (const season of seasons) {
      const teamIds = [...new Set(allGames.filter(g => g.date.startsWith(season))
        .flatMap(g => [g.homeTeamId, g.awayTeamId]))];
      bullpenERABySeason[season] = await fetchBullpenERA(teamIds, season);
      console.log(`   ${season}: ${bullpenERABySeason[season].size} teams`);
    }
    const ser = {};
    for (const [s, m] of Object.entries(bullpenERABySeason)) ser[s] = [...m.entries()];
    fs.writeFileSync(BULLPEN_ERA_PATH, JSON.stringify(ser));
    console.log(`💾  Saved bullpen ERA data\n`);
  }

  // ── 8. Build feature vectors ──────────────────────────────────────
  console.log('🔧  Building feature vectors…');
  const { buildNormStats } = require('./features');
  const normStats    = buildNormStats(allGames);
  const trainingData = buildTrainingData(
    allGames,
    pitcherStatsBySeason,
    pitcherGameLogsBySeason,
    bullpenByGame,
    splitsBySeason,
    weatherByGame,
    bullpenERABySeason,
  );

  if (trainingData.length < 100) {
    throw new Error('Not enough training examples. Try adding more seasons.');
  }

  const withPitchers = trainingData.filter(e => e.hasPitcherData).length;
  console.log(`   ${withPitchers}/${trainingData.length} examples with pitcher data\n`);

  // Feature vector: convert object → array (consistent insertion-order keys)
  const featureNames = Object.keys(trainingData[0].input);
  const featureCount = featureNames.length;
  const toRow = e => featureNames.map(k => e.input[k]);

  // ── 9. Temporal split for honest accuracy evaluation ─────────────
  const lastSeason = Math.max(...seasons);
  const splitDate  = `${lastSeason}-01-01`;
  const sortedData = [...trainingData].sort((a, b) => a.date.localeCompare(b.date));
  const splitTrain = sortedData.filter(e => e.date < splitDate);
  const splitTest  = sortedData.filter(e => e.date >= splitDate);

  console.log(`   Temporal split: train on pre-${lastSeason}, test on ${lastSeason}`);
  console.log(`   Train: ${splitTrain.length}  Test: ${splitTest.length}\n`);

  if (splitTest.length < 50) {
    throw new Error(`Not enough test examples after ${splitDate}. Add more seasons.`);
  }

  // ── 9. Write feature vectors for Python trainer ──────────────────
  const allRows  = sortedData.map(toRow);
  const allY     = sortedData.map(e => e.output.homeWin);
  const testMask = sortedData.map(e => e.date >= splitDate);

  const TMP_IN  = path.join(ROOT, 'data', '_train_input.json');
  const TMP_OUT = path.join(ROOT, 'data', '_train_output.json');

  const allDates = sortedData.map(e => e.date);
  fs.writeFileSync(TMP_IN, JSON.stringify({ X: allRows, y: allY, testMask, dates: allDates }));

  // ── 10. Spawn Python to train sklearn RandomForest ────────────────
  const PYTHON_SCRIPT = path.join(ROOT, 'scripts', 'train_model.py');
  console.log('🐍  Spawning Python trainer (sklearn RF, 200 trees)…');

  const pythonCmd = process.env.PYTHON_CMD ?? (process.platform === 'win32' ? 'python' : 'python3');
  const result = spawnSync(pythonCmd, [PYTHON_SCRIPT, TMP_IN, TMP_OUT], {
    stdio: 'inherit',
    timeout: 600_000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });

  fs.unlinkSync(TMP_IN);

  if (result.status !== 0) {
    throw new Error(`Python trainer exited with code ${result.status}`);
  }

  const pyOut       = JSON.parse(fs.readFileSync(TMP_OUT, 'utf8'));
  fs.unlinkSync(TMP_OUT);

  const testAccuracy = pyOut.testAccuracy;
  const homeWinRate  = pyOut.baselineAcc;

  const modelType = pyOut.type === 'xgboost' ? 'xgboost' : 'sklearn-random-forest';

  console.log(`📊  Model type     : ${modelType}`);
  console.log(`    Test accuracy  : ${(testAccuracy * 100).toFixed(1)}%`);
  console.log(`    Baseline (home): ${(homeWinRate * 100).toFixed(1)}%`);
  if (pyOut.walkForwardCV && Object.keys(pyOut.walkForwardCV).length > 0) {
    console.log(`    Walk-forward CV :`);
    for (const [yr, s] of Object.entries(pyOut.walkForwardCV)) {
      console.log(`      ${yr}: ${(s.accuracy * 100).toFixed(1)}% acc  (${(s.baseline * 100).toFixed(1)}% baseline)  n=${s.n}`);
    }
  }
  console.log();

  // ── 11. Save ──────────────────────────────────────────────────────
  fs.writeFileSync(MODEL_PATH, JSON.stringify({
    model:           pyOut,
    modelType,
    trainedOn:       seasons,
    trainedAt:       new Date().toISOString(),
    trainSize:       allY.filter((_, i) => !testMask[i]).length,
    testSize:        allY.filter((_, i) =>  testMask[i]).length,
    testSeason:      lastSeason,
    splitDate,
    testAccuracy,
    baselineAcc:     homeWinRate,
    walkForwardCV:   pyOut.walkForwardCV ?? {},
    pitcherCoverage: `${withPitchers}/${trainingData.length}`,
    featureCount,
    featureNames,
    splitType:       'temporal',
    normStats:       { rsLo: normStats.rsLo, rsHi: normStats.rsHi, maxRuns: normStats.maxRuns },
  }));

  if (pyOut.calibration) {
    fs.writeFileSync(CAL_PATH, JSON.stringify(pyOut.calibration));
    console.log(`   Calibration saved (a=${pyOut.calibration.a.toFixed(3)}, b=${pyOut.calibration.b.toFixed(3)})`);
  }

  console.log(`✅  Model saved to data/model.json (${featureCount} features)\n`);
  return { accuracy: testAccuracy, baselineAcc: homeWinRate };
}

module.exports = { train };