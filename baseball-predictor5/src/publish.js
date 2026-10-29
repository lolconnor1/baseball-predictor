'use strict';

/**
 * publish.js — turns pipeline state into the static JSON the website reads.
 *
 *   public/data/today.json     today's games + predictions (pre-game ones locked)
 *   public/data/record.json    live track record (pre-game predictions only)
 *   public/data/model.json     model card: walk-forward results, calibration,
 *                              baselines, feature importance
 *   public/data/backtest.json  every game of the latest test season, predicted
 *                              out-of-sample (shown during the off-season)
 */

const fs   = require('fs');
const path = require('path');
const { FEATURE_GROUPS } = require('./features');

const ROOT            = path.join(__dirname, '..');
const DATA            = path.join(ROOT, 'data');
const OUT_DIR         = path.join(ROOT, 'public', 'data');
const MODEL_PATH      = path.join(DATA, 'model.json');
const GAMES_PATH      = path.join(DATA, 'games.json');
const LOG_PATH        = path.join(DATA, 'accuracy-log.json');
const BACKTEST_PATH   = path.join(DATA, 'backtest.json');
const PRED_CACHE_PATH = path.join(DATA, 'prediction-cache.json');

const PREGAME_STATUSES = new Set(['Scheduled', 'Pre-Game', 'Warmup', 'Delayed Start']);

const FEATURE_LABELS = {
  pitcherAdvantage: 'Starting pitcher edge (FIP + WHIP)',
  recentFormAdvantage: 'Starter recent-form edge',
  homeStarterRecentERA: 'Home starter recent ERA', awayStarterRecentERA: 'Away starter recent ERA',
  homePitcherFIP: 'Home starter FIP', awayPitcherFIP: 'Away starter FIP',
  homePitcherWHIP: 'Home starter WHIP', awayPitcherWHIP: 'Away starter WHIP',
  homeK9: 'Home starter K/9', awayK9: 'Away starter K/9',
  homeBB9: 'Home starter BB/9', awayBB9: 'Away starter BB/9',
  homeHR9: 'Home starter HR/9', awayHR9: 'Away starter HR/9',
  homeVsHandOPS: 'Home lineup OPS vs. starter hand', awayVsHandOPS: 'Away lineup OPS vs. starter hand',
  homeBullpenERA: 'Home bullpen ERA', awayBullpenERA: 'Away bullpen ERA',
  homeBullpenFatigue: 'Home bullpen workload (3 days)', awayBullpenFatigue: 'Away bullpen workload (3 days)',
  runDiffAdv: 'Run differential edge', winPctDiff: 'Win % edge',
  homePythagWinPct: 'Home Pythagorean win %', awayPythagWinPct: 'Away Pythagorean win %',
  homeWinPct: 'Home win % (last 30)', awayWinPct: 'Away win % (last 30)',
  homeAvgRS: 'Home runs scored / game', awayAvgRS: 'Away runs scored / game',
  homeAvgRA: 'Home runs allowed / game', awayAvgRA: 'Away runs allowed / game',
  umpireRunFactor: 'Plate umpire run environment', parkFactor: 'Park factor',
  tempFeature: 'Temperature', windFeature: 'Wind speed', seasonProgress: 'Point in season',
  h2hHomeWinPct: 'Head-to-head win %', h2hRunDiffAdv: 'Head-to-head run differential',
};

// ---------------------------------------------------------------------------

async function publish({ date, predictions = [] } = {}) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const payload  = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
  const games    = JSON.parse(fs.readFileSync(GAMES_PATH, 'utf8'));
  const gameById = new Map(games.map(g => [g.gameId, g]));
  const generatedAt = new Date().toISOString();

  // ── today.json ────────────────────────────────────────────────────────
  const predCache = readJson(PRED_CACHE_PATH, {});
  const todayGames = predictions.map(p => {
    if (p.insufficient) return slim(p);
    // Once a game has started, show the prediction that was recorded before
    // first pitch — that's the one that gets graded.
    const cached = predCache[`${date}|${p.gameId}`];
    const started = !PREGAME_STATUSES.has(p.status);
    const locked  = started && cached?.homeProb != null;
    const homeProb = locked ? cached.homeProb : p.homeProb;
    return {
      ...slim(p),
      homeProb,
      awayProb: round(1 - homeProb, 3),
      predictedHome: homeProb >= 0.5,
      recordedPregame: !started || locked,
    };
  });
  const nextGameDate = todayGames.length === 0 ? await fetchNextGameDate(date) : null;
  writeJson('today.json', { date, generatedAt, nextGameDate, games: todayGames });

  // ── record.json ───────────────────────────────────────────────────────
  const log     = readJson(LOG_PATH, []);
  const pregame = log.filter(e => e.pregame === true);
  writeJson('record.json', {
    generatedAt,
    excludedNotPregame: log.length - pregame.length,
    summary: pregame.length ? summarise(pregame.map(e => ({
      p: e.homeProb, y: e.actualHome ? 1 : 0, date: e.date,
    }))) : null,
    entries: pregame.slice().reverse().map(e => ({
      date: e.date, home: e.homeTeam, away: e.awayTeam,
      homeScore: e.homeScore, awayScore: e.awayScore,
      homeProb: e.homeProb, correct: e.correct,
    })),
  });

  // ── model.json + backtest.json ────────────────────────────────────────
  const backtestRows = readJson(BACKTEST_PATH, []);
  const oof = backtestRows.map(([d, gameId, p, y, recordPick]) => ({ date: d, gameId, p, y, recordPick }));
  const testSeason = String(payload.testSeason);
  const latest = oof.filter(r => r.date.startsWith(testSeason));

  writeJson('model.json', {
    generatedAt,
    model: {
      type:         payload.modelType,
      trees:        payload.model.trees.length,
      featureCount: payload.featureCount,
      seasons:      payload.trainedOn,
      totalGames:   payload.totalGames,
      trainedAt:    payload.trainedAt,
      dataThrough:  games.reduce((m, g) => g.date > m ? g.date : m, ''),
      calibration:  payload.model.calibration,
    },
    // Per season from the same calibrated out-of-sample predictions as every
    // other number on the site
    walkForward: [...new Set(oof.map(r => r.date.slice(0, 4)))].sort().map(season => {
      const rows = oof.filter(r => r.date.startsWith(season));
      return {
        season: Number(season),
        accuracy: mean(rows.map(r => ((r.p >= 0.5 ? 1 : 0) === r.y ? 1 : 0))),
        homeBaseline: mean(rows.map(r => r.y)),
        logLoss: logLoss(rows),
        brier: mean(rows.map(r => (r.p - r.y) ** 2)),
        n: rows.length,
      };
    }),
    pooled:     oof.length ? summarise(oof) : null,
    latestSeason: latest.length ? { season: Number(testSeason), ...summarise(latest) } : null,
    importance: featureImportance(payload),
  });

  writeJson('backtest.json', {
    season: Number(testSeason),
    games: latest.slice().reverse().map(r => {
      const g = gameById.get(r.gameId);
      return {
        date: r.date, home: g?.homeTeamName, away: g?.awayTeamName,
        homeScore: g?.homeScore, awayScore: g?.awayScore,
        homeProb: r.p, correct: (r.p >= 0.5 ? 1 : 0) === r.y,
      };
    }),
  });

  console.log(`🌐  Published site data for ${date} → public/data/ (${todayGames.length} games today)`);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * rows: [{ p: home win prob, y: 1 if home won, date, recordPick? }]
 */
function summarise(rows) {
  const n       = rows.length;
  const correct = rows.map(r => ((r.p >= 0.5 ? 1 : 0) === r.y ? 1 : 0));
  const acc     = mean(correct);
  const homeAcc = mean(rows.map(r => r.y));
  const baseRate = homeAcc;   // constant "home team wins X%" forecast

  // Paired difference vs. always picking the home team (same games)
  const diffs = rows.map((r, i) => correct[i] - r.y);
  const lift  = meanCI(diffs);

  const out = {
    n,
    accuracy:     acc,
    accuracyCI:   wilson(acc, n),
    homeBaseline: homeAcc,
    liftVsHome:   lift,
    logLoss:      logLoss(rows),
    baseRateLogLoss: logLoss(rows.map(r => ({ p: baseRate, y: r.y }))),
    brier:        mean(rows.map(r => (r.p - r.y) ** 2)),
    calibration:  calibrationBins(rows),
    byConfidence: confidenceBuckets(rows, correct),
    cumulative:   cumulativeByWeek(rows, correct),
  };

  if (rows.every(r => r.recordPick != null)) {
    const recordCorrect = rows.map(r => (r.recordPick === r.y ? 1 : 0));
    out.recordBaseline = mean(recordCorrect);
    out.liftVsRecord   = meanCI(rows.map((_, i) => correct[i] - recordCorrect[i]));
  }
  return out;
}

function calibrationBins(rows, width = 0.05) {
  const bins = new Map();
  for (const r of rows) {
    const lo = Math.floor(r.p / width) * width;
    const key = lo.toFixed(2);
    if (!bins.has(key)) bins.set(key, { lo, sumP: 0, sumY: 0, n: 0 });
    const b = bins.get(key);
    b.sumP += r.p; b.sumY += r.y; b.n++;
  }
  return [...bins.values()]
    .filter(b => b.n >= 50)   // smaller end bins are mostly noise
    .sort((a, b) => a.lo - b.lo)
    .map(b => ({
      lo: round(b.lo, 2), hi: round(b.lo + width, 2),
      predicted: b.sumP / b.n, actual: b.sumY / b.n, n: b.n,
    }));
}

function confidenceBuckets(rows, correct) {
  const edges = [[0.50, 0.55], [0.55, 0.60], [0.60, 0.65], [0.65, 1.01]];
  return edges.map(([lo, hi]) => {
    const idx = rows.map((r, i) => i).filter(i => {
      const c = Math.max(rows[i].p, 1 - rows[i].p);
      return c >= lo && c < hi;
    });
    const acc = idx.length ? mean(idx.map(i => correct[i])) : null;
    return {
      label: hi > 1 ? `${Math.round(lo * 100)}%+` : `${Math.round(lo * 100)}–${Math.round(hi * 100)}%`,
      n: idx.length, share: idx.length / rows.length, accuracy: acc,
      accuracyCI: idx.length ? wilson(acc, idx.length) : null,
    };
  });
}

// Running accuracy at the end of each week (Monday-start), per season
function cumulativeByWeek(rows, correct) {
  const order = rows.map((r, i) => i).sort((a, b) => rows[a].date.localeCompare(rows[b].date));
  const points = [];
  let n = 0, c = 0, h = 0, lastWeek = null;
  const point = () => ({ week: lastWeek, n, accuracy: c / n, homeAccuracy: h / n });
  for (const i of order) {
    const week = weekStart(rows[i].date);
    if (lastWeek && week !== lastWeek) points.push(point());
    n++; c += correct[i]; h += rows[i].y; lastWeek = week;
  }
  if (lastWeek) points.push(point());
  return points;
}

function featureImportance(payload) {
  const imp   = payload.model.featureImportances ?? [];
  const names = payload.featureNames;
  const groups = {};
  names.forEach((name, i) => {
    const g = FEATURE_GROUPS[name] ?? 'Other';
    groups[g] = (groups[g] ?? 0) + (imp[i] ?? 0);
  });
  return {
    groups: Object.entries(groups)
      .map(([group, value]) => ({ group, value }))
      .sort((a, b) => b.value - a.value),
    features: names
      .map((name, i) => ({ name, label: FEATURE_LABELS[name] ?? name, group: FEATURE_GROUPS[name] ?? 'Other', value: imp[i] ?? 0 }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 12),
  };
}

function logLoss(rows) {
  return mean(rows.map(r => {
    const p = Math.min(Math.max(r.y ? r.p : 1 - r.p, 1e-6), 1);
    return -Math.log(p);
  }));
}

// Wilson score interval for a proportion
function wilson(p, n, z = 1.96) {
  const denom  = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / denom;
  const half   = (z / denom) * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [centre - half, centre + half];
}

// Mean with a normal-approximation 95% CI
function meanCI(values, z = 1.96) {
  const n = values.length;
  const m = mean(values);
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1));
  const half = z * sd / Math.sqrt(n);
  return { value: m, ci: [m - half, m + half] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Drops fields the site doesn't use
function slim(p) {
  const { rawProb, calibrated, h2h, schedule, ...rest } = p;
  return rest;
}

async function fetchNextGameDate(fromDate) {
  const end = new Date(new Date(fromDate).getTime() + 200 * 86400000).toISOString().slice(0, 10);
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&gameType=R&startDate=${fromDate}&endDate=${end}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return data.dates?.find(d => d.date > fromDate)?.date ?? null;
  } catch {
    return null;
  }
}

function weekStart(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function readJson(p, fallback) {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback;
}

function writeJson(name, obj) {
  fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(obj, (k, v) =>
    typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 10000) / 10000 : v));
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

module.exports = { publish };
