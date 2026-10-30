'use strict';

const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const { fetchHistoricalGames, fetchBullpenData } = require('./api');
const { loadPitCache, ensureSeasonLogs,
        ensurePitcherSeasons, buildPitContext }   = require('./pointInTime');
const { fetchGameWeather }                        = require('./weather');
const { getVenueCoords }                          = require('./venues');
const { buildTrainingData, buildModelTerms }      = require('./features');

const ROOT         = path.join(__dirname, '..');
const DATA_PATH    = path.join(ROOT, 'data', 'games.json');
const BULLPEN_PATH   = path.join(ROOT, 'data', 'bullpen.json');
const WEATHER_PATH   = path.join(ROOT, 'data', 'weather-cache.json');
const MODEL_PATH     = path.join(ROOT, 'data', 'model.json');
const BACKTEST_PATH  = path.join(ROOT, 'data', 'backtest.json');


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

  // ── 2. Point-in-time pitcher / team game logs ──────────────────────
  // Every pitcher, bullpen and split stat is rebuilt from per-game logs as of
  // the day before each game (see pointInTime.js). Season totals fetched at
  // training time would leak future games into the features.
  console.log('📦  Loading point-in-time game logs…');
  const pitCache = loadPitCache();
  await ensureSeasonLogs(pitCache, allGames, [Math.min(...seasons) - 1, ...seasons]);
  const pit    = buildPitContext(pitCache, await ensurePitcherSeasons(seasons));
  console.log(`   Seasons cached: ${Object.keys(pitCache.seasons).sort().join(', ')}
`);

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

  // ── 8. Build feature vectors ──────────────────────────────────────
  console.log('🔧  Building feature vectors…');
  const { buildNormStats } = require('./features');
  const normStats    = buildNormStats(allGames);
  const trainingData = buildTrainingData(allGames, { pit, bullpenByGame, weatherByGame });

  if (trainingData.length < 100) {
    throw new Error('Not enough training examples. Try adding more seasons.');
  }

  const withPitchers = trainingData.filter(e => e.hasPitcherData).length;
  console.log(`   ${withPitchers}/${trainingData.length} examples with pitcher data\n`);

  // Feature vector: convert object → array (consistent insertion-order keys)
  const featureNames = Object.keys(trainingData[0].input);
  const featureCount = featureNames.length;
  const toRow = e => featureNames.map(k => e.input[k]);

  // ── 9. Walk-forward split: each season is tested on a model trained
  //       only on earlier seasons (done in Python)
  const lastSeason = Math.max(...seasons);
  const splitDate  = `${lastSeason}-01-01`;
  const sortedData = [...trainingData].sort((a, b) => a.date.localeCompare(b.date));
  const testSize   = sortedData.filter(e => e.date >= splitDate).length;

  if (testSize < 50) {
    throw new Error(`Not enough test examples after ${splitDate}. Add more seasons.`);
  }

  // ── 10. Write feature vectors for Python trainer
  const allRows  = sortedData.map(toRow);
  const allY     = sortedData.map(e => e.output.homeWin);

  const TMP_IN  = path.join(ROOT, 'data', '_train_input.json');
  const TMP_OUT = path.join(ROOT, 'data', '_train_output.json');

  const allDates = sortedData.map(e => e.date);
  fs.writeFileSync(TMP_IN, JSON.stringify({
    X: allRows, y: allY, dates: allDates,
    names: featureNames, terms: buildModelTerms(featureNames),
  }));

  // ── 11. Spawn Python trainer (logistic vs RF vs XGBoost, walk-forward CV)
  const PYTHON_SCRIPT = path.join(ROOT, 'scripts', 'train_model.py');
  console.log('🐍  Spawning Python trainer (logistic vs RF vs XGBoost, walk-forward)…');

  const pythonCmd = process.env.PYTHON_CMD ?? (process.platform === 'win32' ? 'python' : 'python3');
  const result = spawnSync(pythonCmd, [PYTHON_SCRIPT, TMP_IN, TMP_OUT], {
    stdio: 'inherit',
    timeout: 600_000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });

  fs.unlinkSync(TMP_IN);

  if (result.status !== 0 || result.signal) {
    const detail = result.signal
      ? `killed by signal ${result.signal} (${result.signal === 'SIGKILL' ? 'likely OOM' : 'terminated'})`
      : `exit code ${result.status}`;
    if (result.stderr) console.error('Python stderr:', result.stderr.toString());
    throw new Error(`Python trainer failed — ${detail}`);
  }

  const pyOut       = JSON.parse(fs.readFileSync(TMP_OUT, 'utf8'));
  fs.unlinkSync(TMP_OUT);

  const testAccuracy = pyOut.testAccuracy;
  const homeWinRate  = pyOut.baselineAcc;

  const modelType = { logistic: 'logistic-regression', xgboost: 'xgboost' }[pyOut.type]
    ?? 'sklearn-random-forest';

  console.log(`📊  Model type     : ${modelType}`);
  console.log(`    ${lastSeason} accuracy  : ${(testAccuracy * 100).toFixed(1)}%  (log loss ${pyOut.testLogLoss?.toFixed(4)}, coin flip 0.6931)`);
  console.log(`    Baseline (home): ${(homeWinRate * 100).toFixed(1)}%`);
  if (pyOut.walkForwardCV && Object.keys(pyOut.walkForwardCV).length > 0) {
    console.log(`    Walk-forward CV :`);
    for (const [yr, s] of Object.entries(pyOut.walkForwardCV)) {
      console.log(`      ${yr}: ${(s.accuracy * 100).toFixed(1)}% acc  (${(s.baseline * 100).toFixed(1)}% baseline)  ll ${s.logLoss.toFixed(4)}  n=${s.n}`);
    }
  }
  console.log();

  // ── 12. Save ──────────────────────────────────────────────────────
  // The out-of-fold predictions go to their own file (backtest analytics on
  // the website), not into the model.
  const { oof, ...modelOut } = pyOut;
  fs.writeFileSync(MODEL_PATH, JSON.stringify({
    model:           modelOut,
    modelType,
    trainedOn:       seasons,
    trainedAt:       new Date().toISOString(),
    totalGames:      allGames.length,
    trainSize:       allY.length - testSize,
    testSize,
    testSeason:      lastSeason,
    splitDate,
    testAccuracy,
    testLogLoss:     pyOut.testLogLoss,
    baselineAcc:     homeWinRate,
    walkForwardCV:   pyOut.walkForwardCV ?? {},
    pitcherCoverage: `${withPitchers}/${trainingData.length}`,
    featureCount,
    featureNames,
    splitType:       'walk-forward',
    normStats:       { rsLo: normStats.rsLo, rsHi: normStats.rsHi, maxRuns: normStats.maxRuns },
  }));

  // Backtest rows: [date, gameId, calibrated home win prob, home won (0/1),
  //                 "better record" baseline pick (1 = home)]
  const cal = pyOut.calibration;
  const backtest = [];
  sortedData.forEach((e, i) => {
    if (oof?.[i] == null) return;
    const p = cal ? 1 / (1 + Math.exp(-(cal.a * oof[i] + cal.b))) : oof[i];
    backtest.push([
      e.date, e.gameId, Math.round(p * 10000) / 10000, e.output.homeWin,
      e.input.homeWinPct >= e.input.awayWinPct ? 1 : 0,
    ]);
  });
  fs.writeFileSync(BACKTEST_PATH, JSON.stringify(backtest));
  console.log(`   Backtest saved (${backtest.length} out-of-sample predictions)`);

  console.log(`✅  Model saved to data/model.json (${featureCount} features)\n`);
  return { accuracy: testAccuracy, baselineAcc: homeWinRate };
}

module.exports = { train };