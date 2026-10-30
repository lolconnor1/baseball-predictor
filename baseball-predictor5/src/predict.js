'use strict';

/**
 * predict.js — predictions for a date, used by the daily pipeline (which
 * publishes them to the website) and the CLI (`node index.js predict`).
 */

const fs   = require('fs');
const path = require('path');

const { rfPredict, rfExplain }                             = require('./rfPredict');
const { fetchGamesForDate }                                = require('./api');
const { buildTeamHistory, buildUmpireHistory,
        buildGameFeatures, FEATURE_GROUPS }                = require('./features');
const { fetchProbablePitchers, fetchPitcherRecentForm }   = require('./pitchers');
const { getRawParkFactor, getVenueName, getVenueCoords }  = require('./venues');
const { fetchGameWeather }                                = require('./weather');
const { preparePitForDate }                               = require('./pointInTime');

const ROOT            = path.join(__dirname, '..');
const DATA_PATH       = path.join(ROOT, 'data', 'games.json');
const MODEL_PATH      = path.join(ROOT, 'data', 'model.json');
const BULLPEN_PATH    = path.join(ROOT, 'data', 'bullpen.json');
const PRED_CACHE_PATH = path.join(ROOT, 'data', 'prediction-cache.json');
const PREGAME_STATUSES = new Set(['Scheduled', 'Pre-Game', 'Warmup', 'Delayed Start']);
const SCHEDULE_TZ     = process.env.SCHEDULE_TZ || 'America/New_York';

// ---------------------------------------------------------------------------
// Predict logic — returns structured data instead of printing
// ---------------------------------------------------------------------------
async function runPredict(date) {
  const payload = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));

  if (!payload.model) throw new Error('No valid model found in model.json — try retraining.');
  const featureNames = payload.featureNames;
  const calibration  = payload.model.calibration ?? null;
  const normStats    = payload.normStats ?? null;

  const allGames      = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const history       = buildTeamHistory(allGames);
  const umpireHistory = buildUmpireHistory(allGames);

  const [games, pitcherMap] = await Promise.all([
    fetchGamesForDate(date),
    fetchProbablePitchers(date),
  ]);

  // Load bullpen cache if available
  let bullpenByGame = null;
  if (fs.existsSync(BULLPEN_PATH)) {
    const raw = JSON.parse(fs.readFileSync(BULLPEN_PATH, 'utf8'));
    bullpenByGame = new Map(Object.entries(raw).map(([k, v]) => [parseInt(k), v]));
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
    ? await fetchPitcherRecentForm([...allPitcherIds], season, date)
    : {};

  // Point-in-time pitcher / bullpen / split stats — same code path as training
  const teamIds = [...new Set(games.flatMap(g => [g.homeTeamId, g.awayTeamId]))];
  const pit     = await preparePitForDate(date, [...allPitcherIds], teamIds);

  // Fetch weather for today's games (per venue/date, in-memory cache in weather.js)
  const gameWeatherMap = {};
  await Promise.all(games.map(async g => {
    const coords = getVenueCoords(g.homeTeamId);
    if (!coords) return;
    const w = await fetchGameWeather(coords.lat, coords.lon, date, g.homeTeamId).catch(() => null);
    if (w) gameWeatherMap[g.gameId] = w;
  }));

  const featureCtx = {
    history, umpireHistory, pit, bullpenByGame, weatherByGame: gameWeatherMap, normStats,
  };

  const results = [];

  for (const game of games) {
    const { homeTeamName, awayTeamName, homeTeamId, awayTeamId, status, gameId, gameDate } = game;
    const ids = pitcherIdsByGame[gameId] ?? {};
    const base = { gameId, gameDate, homeTeamName, awayTeamName, homeTeamId, awayTeamId, status };

    const built = buildGameFeatures(
      { ...game, homePitcherId: ids.homeId ?? null, awayPitcherId: ids.awayId ?? null },
      featureCtx
    );
    if (!built) {
      results.push({ ...base, insufficient: true });
      continue;
    }
    const { features, homeStats, awayStats, h2hStats, homeCtx, awayCtx } = built;
    const pitcherStats = pitcherMap[gameId] ?? null;   // display only (name, season ERA/WHIP)

    const rawProb  = rfPredict(payload.model, featureNames, features);
    const homeProb = applyCalibration(rawProb, calibration);

    results.push({
      ...base,
      rawProb:       round(rawProb, 3),
      homeProb:      round(homeProb, 3),
      awayProb:      round(1 - homeProb, 3),
      calibrated:    calibration != null,
      predictedWinner: homeProb >= 0.5 ? homeTeamName : awayTeamName,
      predictedHome:   homeProb >= 0.5,
      factors:       explainFactors(payload.model, featureNames, features, homeProb, calibration),
      venueName:     getVenueName(homeTeamId),
      parkFactor:    getRawParkFactor(homeTeamId),
      homePitcher:   pitcherStats?.home ?? null,
      awayPitcher:   pitcherStats?.away ?? null,
      homeForm:      ids.homeId ? recentForm[ids.homeId] : null,
      awayForm:      ids.awayId ? recentForm[ids.awayId] : null,
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
        winPct:   round(homeStats.winPct, 3),
        avgRS:    round(homeStats.avgRS, 1),
        avgRA:    round(homeStats.avgRA, 1),
        momentum: round(homeStats.momentum, 3),
      },
      awayStats: {
        winPct:   round(awayStats.winPct, 3),
        avgRS:    round(awayStats.avgRS, 1),
        avgRA:    round(awayStats.avgRA, 1),
        momentum: round(awayStats.momentum, 3),
      },
    });
  }

  // Persist pre-game predictions so update can grade the exact probabilities
  // that were shown. Only games that haven't started are recorded (the latest
  // pre-game run wins); a run after first pitch never overwrites it.
  const predCache = fs.existsSync(PRED_CACHE_PATH)
    ? JSON.parse(fs.readFileSync(PRED_CACHE_PATH, 'utf8'))
    : {};
  const predictedAt = new Date().toISOString();
  let cachedCount = 0;
  for (const r of results) {
    if (r.insufficient || !PREGAME_STATUSES.has(r.status)) continue;
    predCache[`${date}|${r.gameId}`] = {
      homeProb:      r.homeProb,
      rawProb:       r.rawProb,
      predictedHome: r.predictedHome,
      predictedAt,
    };
    cachedCount++;
  }
  if (cachedCount > 0) fs.writeFileSync(PRED_CACHE_PATH, JSON.stringify(predCache));

  return results;
}

// ---------------------------------------------------------------------------
// Platt scaling calibration
// ---------------------------------------------------------------------------
function applyCalibration(rawProb, cal) {
  if (!cal) return rawProb;
  return 1 / (1 + Math.exp(-(cal.a * rawProb + cal.b)));
}

/**
 * Per-game explanation: each feature's contribution to the raw model output
 * (see rfExplain), summed into readable groups and scaled by the local slope
 * from that output to the displayed, calibrated home win probability, so they
 * read in percentage points. Positive = favours the home team.
 */
function explainFactors(model, featureNames, features, homeProb, cal) {
  const explained = rfExplain(model, featureNames, features);
  if (!explained) return null;

  let slope = cal ? cal.a * homeProb * (1 - homeProb) : 1;
  if (explained.link === 'logit') {
    // log-odds → raw probability, before the calibration step
    const rawProb = 1 / (1 + Math.exp(-explained.contributions.reduce((s, c) => s + c, explained.bias)));
    slope *= rawProb * (1 - rawProb);
  }
  const byGroup = {};
  featureNames.forEach((name, i) => {
    const group = FEATURE_GROUPS[name] ?? 'Other';
    byGroup[group] = (byGroup[group] ?? 0) + explained.contributions[i] * slope;
  });

  return Object.entries(byGroup)
    .map(([group, value]) => ({ group, value: round(value, 4) }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
}

// Today's date in the schedule timezone (CI runners use UTC, which rolls over
// to tomorrow during evening games in the US)
function localToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: SCHEDULE_TZ });
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

// ---------------------------------------------------------------------------
// CLI output
// ---------------------------------------------------------------------------

async function predict({ date = localToday() } = {}) {
  if (!fs.existsSync(MODEL_PATH) || !fs.existsSync(DATA_PATH)) {
    console.error('❌  No trained model or game data found. Run `node index.js train` first.');
    process.exitCode = 1;
    return;
  }

  const payload = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
  console.log(`\n🤖  Model trained on seasons : ${payload.trainedOn.join(', ')}`);
  console.log(`    ${payload.testSeason} accuracy          : ${pct(payload.testAccuracy)}  (walk-forward)`);
  console.log(`    Baseline (always home)    : ${pct(payload.baselineAcc)}`);
  if (payload.lastUpdated) console.log(`    Last updated              : ${payload.lastUpdated}`);

  const results = await runPredict(date);
  if (results.length === 0) {
    console.log(`\n⚾  No games found for ${date}.\n`);
    return;
  }

  const divider = '─'.repeat(70);
  console.log(`\n🎯  MLB Predictions for ${date}`);
  console.log(divider);

  for (const r of results) {
    console.log(`\n  ${r.awayTeamName}  @  ${r.homeTeamName}  [${r.status}]`);
    if (r.insufficient) {
      console.log(`  ⚠️   Not enough historical data to predict.`);
      continue;
    }

    const confidence = r.predictedHome ? r.homeProb : r.awayProb;
    console.log(`  Venue      : ${r.venueName}  (park factor ${r.parkFactor.toFixed(2)})`);

    const hp = r.homePitcher, ap = r.awayPitcher;
    if (hp && !hp.isLeagueAvg && ap) {
      const form = f => f ? `  recent ${f.recentEra} ERA (${f.trend})` : '';
      console.log(`  Pitchers   : ${hp.name} ERA ${hp.era?.toFixed(2)} WHIP ${hp.whip?.toFixed(2)}${form(r.homeForm)}`);
      console.log(`               ${ap.name} ERA ${ap.era?.toFixed(2)} WHIP ${ap.whip?.toFixed(2)}${form(r.awayForm)} (away)`);
    } else {
      console.log(`  Pitchers   : Not yet announced`);
    }

    console.log(`  Prediction : ${BOLD}${r.predictedWinner}${RESET} wins`);
    console.log(`  Confidence : ${confidenceBar(confidence)} ${pct(confidence)}${r.calibrated ? '  (calibrated)' : ''}`);
    console.log(`  Win probs  : home ${pct(r.homeProb)}  |  away ${pct(r.awayProb)}`);
    if (r.factors) {
      const top = r.factors.slice(0, 3).map(f =>
        `${f.group} ${f.value >= 0 ? '+' : '−'}${Math.abs(f.value * 100).toFixed(1)} → ${f.value >= 0 ? 'home' : 'away'}`);
      console.log(`  Key factors: ${top.join('  ·  ')}`);
    }
  }

  const modelled = results.filter(r => !r.insufficient).length;
  console.log(`\n${divider}`);
  console.log(`  ${modelled} of ${results.length} matchup(s) predicted\n`);
}

const BOLD  = '\x1b[1m';
const RESET = '\x1b[0m';

function pct(v) { return `${(v * 100).toFixed(1)}%`; }

function confidenceBar(c) {
  const f = Math.round(c * 20);
  return `[${'█'.repeat(f)}${'░'.repeat(20 - f)}]`;
}

module.exports = { runPredict, predict, localToday, applyCalibration };
