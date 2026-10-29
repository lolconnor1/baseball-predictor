'use strict';

/**
 * features.js  (v5 — umpire tendencies, bullpen fatigue, pitcher recent form)
 *
 * Feature vector: 32 inputs (was 26)
 *
 *  ── Team rolling stats (exp. weighted, last 30 games) ───────────── 0–11
 *  ── Head-to-head ────────────────────────────────────────────────── 12–13
 *  ── Ballpark ────────────────────────────────────────────────────── 14
 *  ── Starting pitchers (season ERA/WHIP) ─────────────────────────── 15–19
 *  ── Schedule context ────────────────────────────────────────────── 20–25
 *
 *  ── NEW: Pitcher recent form (last 3 starts) ─────────────────────── 26–28
 *  26  homeStarterRecentERA   normalised & inverted
 *  27  awayStarterRecentERA
 *  28  recentFormAdvantage    composite home-pitcher recent quality vs away
 *
 *  ── NEW: Bullpen fatigue ─────────────────────────────────────────── 29–30
 *  29  homeBullpenFatigue     relief pitches in last 3 days / 120
 *  30  awayBullpenFatigue
 *
 *  ── NEW: Umpire run factor ───────────────────────────────────────── 31
 *  31  umpireRunFactor        umpire's historical runs/game vs league avg
 */

const { getParkFactor } = require('./venues');
const { normaliseWeather } = require('./weather');
const { buildPitcherFeatures, LEAGUE_AVG,
  normaliseERA, normaliseFIP } = require('./pitchers');
const { normaliseOPS } = require('./splits');

const ROLLING_WINDOW = 30;
const H2H_WINDOW = 15;
const DECAY_LAMBDA = 0.05;

// Human-readable grouping of model features, used for per-game explanations
// and grouped feature importance on the website.
const FEATURE_GROUP_MEMBERS = {
  'Starting pitching': [
    'homePitcherFIP', 'homePitcherWHIP', 'awayPitcherFIP', 'awayPitcherWHIP', 'pitcherAdvantage',
    'homeK9', 'awayK9', 'homeBB9', 'awayBB9', 'homeHR9', 'awayHR9',
    'homeStarterRecentERA', 'awayStarterRecentERA', 'recentFormAdvantage',
    'homeStarterRestDays', 'awayStarterRestDays', 'homeStarterAnnounced', 'awayStarterAnnounced',
  ],
  'Lineup vs. starter hand': ['homeVsHandOPS', 'awayVsHandOPS'],
  'Bullpen': ['homeBullpenFatigue', 'awayBullpenFatigue', 'homeBullpenERA', 'awayBullpenERA'],
  'Team form': [
    'homeWinPct', 'awayWinPct', 'homePythagWinPct', 'awayPythagWinPct',
    'homeAvgRS', 'awayAvgRS', 'homeAvgRA', 'awayAvgRA', 'homeHomeWinPct', 'awayAwayWinPct',
    'homeRecentHomePct', 'awayRecentAwayPct', 'winPctDiff', 'runDiffAdv', 'homeMomentum', 'awayMomentum',
  ],
  'Head-to-head': ['h2hHomeWinPct', 'h2hRunDiffAdv'],
  'Schedule & rest': [
    'homeRestDays', 'awayRestDays', 'homeScheduleDensity', 'awayScheduleDensity',
    'homeStandLength', 'roadTripLength',
  ],
  'Park & weather': ['parkFactor', 'tempFeature', 'windFeature'],
  'Umpire': ['umpireRunFactor'],
  'Season timing': ['seasonProgress'],
};
const FEATURE_GROUPS = Object.fromEntries(
  Object.entries(FEATURE_GROUP_MEMBERS).flatMap(([group, names]) => names.map(n => [n, group]))
);

// Neutral fallback values for new features when data unavailable
const NEUTRAL_RECENT_ERA = 0.5;
const NEUTRAL_BULLPEN = 0.5;
const NEUTRAL_UMPIRE = 0.5;

// ---------------------------------------------------------------------------
// Data-driven normalisation bounds
// ---------------------------------------------------------------------------
// Instead of hard-coding MAX_RUNS=15, ERA range etc., we compute the actual
// p5 and p95 from the training data. This prevents clipping and ensures
// the full [0,1] range is used.

function computeNormBounds(values, pLow = 0.05, pHigh = 0.95) {
  const sorted = [...values].filter(v => v != null && isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return { lo: 0, hi: 1 };
  const lo = sorted[Math.floor(sorted.length * pLow)];
  const hi = sorted[Math.floor(sorted.length * pHigh)];
  return { lo, hi: hi > lo ? hi : lo + 1 };
}

function normaliseTo01(value, lo, hi) {
  if (hi === lo) return 0.5;
  return Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
}

/**
 * Computes data-driven normalisation bounds from the full game dataset.
 * Called once before training and cached on the returned object.
 * Falls back to sensible defaults if data is insufficient.
 */
function buildNormStats(games) {
  const totalRuns = games.map(g => g.homeScore + g.awayScore);
  const homeRuns = games.map(g => g.homeScore);

  const runBounds = computeNormBounds(totalRuns);

  return {
    // For avg runs scored/allowed per game — use p5/p95 of per-game totals
    rsLo: computeNormBounds(homeRuns).lo,
    rsHi: computeNormBounds(homeRuns).hi,
    // Fallback MAX_RUNS used in run diff features
    maxRuns: runBounds.hi,
  };
}

// ---------------------------------------------------------------------------
// Team history builder
// ---------------------------------------------------------------------------

function buildTeamHistory(games) {
  const history = {};
  for (const g of games) {
    if (!history[g.homeTeamId]) history[g.homeTeamId] = [];
    if (!history[g.awayTeamId]) history[g.awayTeamId] = [];

    history[g.homeTeamId].push({
      date: g.date, isHome: true,
      runsScored: g.homeScore, runsAllowed: g.awayScore,
      won: g.homeWin, opponent: g.awayTeamId,
      gameId: g.gameId,
    });
    history[g.awayTeamId].push({
      date: g.date, isHome: false,
      runsScored: g.awayScore, runsAllowed: g.homeScore,
      won: !g.homeWin, opponent: g.homeTeamId,
      gameId: g.gameId,
    });
  }
  for (const id of Object.keys(history)) {
    history[id].sort((a, b) => a.date.localeCompare(b.date));
  }
  return history;
}

// ---------------------------------------------------------------------------
// Rolling team stats — exponentially weighted
// ---------------------------------------------------------------------------

function computeTeamStats(teamGames, beforeDate, n = ROLLING_WINDOW) {
  const season = beforeDate.slice(0, 4);
  const currentSeasonGames = teamGames.filter(g => g.date < beforeDate && g.date.startsWith(season));
  const prior = currentSeasonGames.length >= 8
    ? currentSeasonGames.slice(-n)
    : teamGames.filter(g => g.date < beforeDate).slice(-n);
  if (prior.length < 8) return null;

  const weights = prior.map((_, i) => Math.exp(DECAY_LAMBDA * i));
  const totalW = weights.reduce((a, b) => a + b, 0);

  const winPct = prior.reduce((s, g, i) => s + (g.won ? weights[i] : 0), 0) / totalW;
  const avgRS = prior.reduce((s, g, i) => s + g.runsScored * weights[i], 0) / totalW;
  const avgRA = prior.reduce((s, g, i) => s + g.runsAllowed * weights[i], 0) / totalW;

  const homeGames = prior.filter(g => g.isHome);
  const awayGames = prior.filter(g => !g.isHome);

  const homeWinPct = homeGames.length > 3
    ? homeGames.filter(g => g.won).length / homeGames.length : winPct;
  const awayWinPct = awayGames.length > 3
    ? awayGames.filter(g => g.won).length / awayGames.length : winPct;

  const last5 = prior.slice(-5);
  const momentum = last5.filter(g => g.won).length / last5.length;

  // Pythagorean win% — better measure of true team quality than actual W/L
  const pythagWinPct = avgRS ** 2 / (avgRS ** 2 + avgRA ** 2 + 1e-9);

  // Recent home/away form (last 5 venue-specific games)
  const recentHomeGames = homeGames.slice(-5);
  const recentAwayGames = awayGames.slice(-5);
  const recentHomeWinPct = recentHomeGames.length >= 3
    ? recentHomeGames.filter(g => g.won).length / recentHomeGames.length : homeWinPct;
  const recentAwayWinPct = recentAwayGames.length >= 3
    ? recentAwayGames.filter(g => g.won).length / recentAwayGames.length : awayWinPct;

  return { winPct, avgRS, avgRA, homeWinPct, awayWinPct, momentum,
           pythagWinPct, recentHomeWinPct, recentAwayWinPct, gamesPlayed: prior.length };
}

// ---------------------------------------------------------------------------
// Head-to-head
// ---------------------------------------------------------------------------

function computeH2HStats(homeTeamHistory, awayTeamId, beforeDate, n = H2H_WINDOW) {
  const h2h = homeTeamHistory
    .filter(g => g.date < beforeDate && g.opponent === awayTeamId)
    .slice(-n);

  if (h2h.length < 3) return { h2hHomeWinPct: 0.5, h2hRunDiffAdv: 0.5 };

  const wins = h2h.filter(g => g.won).length;
  const avgMargin = mean(h2h.map(g => g.runsScored - g.runsAllowed));

  return {
    h2hHomeWinPct: wins / h2h.length,
    h2hRunDiffAdv: Math.max(0, Math.min(1, (avgMargin + 8) / 16)),
  };
}

// ---------------------------------------------------------------------------
// Schedule context
// ---------------------------------------------------------------------------

function computeScheduleContext(teamGames, beforeDate) {
  const prior = teamGames.filter(g => g.date < beforeDate);
  if (prior.length === 0) return { restDays: 0.5, scheduleDensity: 0.5, homeStandLength: 0.5, roadTripLength: 0.5 };

  const lastGame = prior[prior.length - 1];
  const daysSince = dateDiffDays(lastGame.date, beforeDate);
  const restDays = Math.min(daysSince, 5) / 5;

  const sevenDaysAgo = offsetDate(beforeDate, -7);
  const recentGames = prior.filter(g => g.date >= sevenDaysAgo);
  const scheduleDensity = Math.min(recentGames.length, 7) / 7;

  let homeStandLength = 0;
  for (let i = prior.length - 1; i >= 0; i--) {
    if (prior[i].isHome) homeStandLength++;
    else break;
  }

  let roadTripLength = 0;
  for (let i = prior.length - 1; i >= 0; i--) {
    if (!prior[i].isHome) roadTripLength++;
    else break;
  }

  return {
    restDays,
    scheduleDensity,
    homeStandLength: Math.min(homeStandLength, 7) / 7,
    roadTripLength: Math.min(roadTripLength, 7) / 7,
  };
}

// ---------------------------------------------------------------------------
// NEW: Pitcher recent form (last 3 starts)
// ---------------------------------------------------------------------------

/**
 * Looks up a pitcher's recent ERA from the game logs map.
 * Returns normalised [0,1] value (inverted — higher = better pitcher).
 * Falls back to NEUTRAL if no data.
 */
/**
 * Returns a pitcher's recent ERA using only starts BEFORE beforeDate.
 * The game log cache stores all starts for the full season — we must
 * filter to prevent data leakage from future starts.
 */
function getRecentERAFeature(pitcherId, pitcherGameLogs, beforeDate, lastN = 3) {
  if (!pitcherId || !pitcherGameLogs) return NEUTRAL_RECENT_ERA;
  const log = pitcherGameLogs.get(pitcherId);
  if (!log || !log.startDates) return NEUTRAL_RECENT_ERA;

  // log.startDates is an array of { date, earnedRuns, inningsPitched }
  // Filter to starts strictly before the game date, then take last N
  const priorStarts = (log.startDates ?? [])
    .filter(s => s.date < beforeDate)
    .slice(-lastN);

  if (priorStarts.length === 0) return NEUTRAL_RECENT_ERA;

  const totalER = priorStarts.reduce((s, x) => s + (x.earnedRuns ?? 0), 0);
  const totalIP = priorStarts.reduce((s, x) => s + (x.ip ?? 0), 0);

  if (totalIP < 1) return NEUTRAL_RECENT_ERA;

  const recentEra = (totalER / totalIP) * 9;
  return normaliseERA(recentEra);
}

/**
 * Returns normalised days-since-last-start for a pitcher [0,1].
 * Clamp range [4,10] days — typical rotation window.
 * Returns 0.5 (neutral) if pitcher has no prior starts.
 */
function getStarterRestDays(pitcherId, pitcherGameLogs, beforeDate) {
  if (!pitcherId || !pitcherGameLogs) return 0.5;
  const log = pitcherGameLogs.get(pitcherId);
  if (!log || !log.startDates || log.startDates.length === 0) return 0.5;

  const priorStarts = log.startDates.filter(s => s.date < beforeDate);
  if (priorStarts.length === 0) return 0.5;

  const lastStart = priorStarts[priorStarts.length - 1].date;
  const days = Math.round((new Date(beforeDate) - new Date(lastStart)) / 86400000);
  return Math.max(0, Math.min(1, (Math.max(4, Math.min(10, days)) - 4) / 6));
}

// ---------------------------------------------------------------------------
// NEW: Bullpen fatigue
// ---------------------------------------------------------------------------

/**
 * Computes the total relief pitcher pitches thrown by a team in the last
 * `days` days, using the bullpen data map.
 *
 * Normalised: 0 = no fatigue, 1 = very fatigued (120+ pitches in last 3 days)
 */
function computeBullpenFatigue(teamHistory, beforeDate, bullpenByGame, isHome, days = 3) {
  const cutoff = offsetDate(beforeDate, -days);
  const recentGames = teamHistory.filter(g => g.date >= cutoff && g.date < beforeDate);

  let totalPitches = 0;
  for (const g of recentGames) {
    const data = bullpenByGame?.get(g.gameId);
    if (!data) continue;
    totalPitches += isHome ? (data.homeBullpenPitches ?? 0) : (data.awayBullpenPitches ?? 0);
  }

  // Normalise: 120 pitches over 3 days = very fatigued = 1.0
  return Math.min(1, totalPitches / 120);
}

// ---------------------------------------------------------------------------
// NEW: Umpire run factor
// ---------------------------------------------------------------------------

/**
 * Builds a chronologically-indexed umpire game list from all games.
 * Returns { umpireId → [{ date, totalRuns }, ...] } sorted by date.
 *
 * This replaces the old approach of pre-computing averages over all games,
 * which caused leakage by including future games in historical averages.
 */
function buildUmpireHistory(games) {
  const history = {};

  for (const g of games) {
    if (!g.umpireId) continue;
    if (!history[g.umpireId]) history[g.umpireId] = [];
    history[g.umpireId].push({
      date: g.date,
      totalRuns: g.homeScore + g.awayScore,
    });
  }

  // Sort each umpire's history chronologically
  for (const id of Object.keys(history)) {
    history[id].sort((a, b) => a.date.localeCompare(b.date));
  }

  return history;
}

/**
 * Computes an umpire's run factor using only games called BEFORE beforeDate.
 * This is the leak-free version — it recomputes incrementally per game.
 *
 * League average ~9 runs/game → 0.5
 * Tight-zone umpire ~7.5 runs → ~0.25
 * Wide-zone umpire ~10.5 runs → ~0.75
 */
function getUmpireFeature(umpireId, umpireHistory, beforeDate) {
  if (!umpireId || !umpireHistory || !umpireHistory[umpireId]) return NEUTRAL_UMPIRE;

  const priorGames = umpireHistory[umpireId].filter(g => g.date < beforeDate);
  if (priorGames.length < 5) return NEUTRAL_UMPIRE;  // need minimum sample

  const avgRuns = mean(priorGames.map(g => g.totalRuns));
  return Math.max(0, Math.min(1, (avgRuns - 6) / 6));
}

// ---------------------------------------------------------------------------
// Feature vector assembly (32 features)
// ---------------------------------------------------------------------------

function buildFeatureVector(
  homeStats, awayStats, h2hStats, homeTeamId, pitcherStats = null,
  scheduleContext = null, tierOneData = null, normStats = null
) {
  const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

  // ── Base rolling stats ─────────────────────────────────────────────────
  // Use data-driven bounds if available, fall back to hard-coded defaults
  const rsLo = normStats?.rsLo ?? 0;
  const rsHi = normStats?.rsHi ?? 15;
  const maxRuns = normStats?.maxRuns ?? 15;

  const base = {
    homeWinPct:        clamp(homeStats.winPct),
    awayWinPct:        clamp(awayStats.winPct),
    homePythagWinPct:  clamp(homeStats.pythagWinPct),
    awayPythagWinPct:  clamp(awayStats.pythagWinPct),
    homeAvgRS:         clamp(normaliseTo01(homeStats.avgRS, rsLo, rsHi)),
    awayAvgRS:         clamp(normaliseTo01(awayStats.avgRS, rsLo, rsHi)),
    homeAvgRA:         clamp(normaliseTo01(homeStats.avgRA, rsLo, rsHi)),
    awayAvgRA:         clamp(normaliseTo01(awayStats.avgRA, rsLo, rsHi)),
    homeHomeWinPct:    clamp(homeStats.homeWinPct),
    awayAwayWinPct:    clamp(awayStats.awayWinPct),
    homeRecentHomePct: clamp(homeStats.recentHomeWinPct),
    awayRecentAwayPct: clamp(awayStats.recentAwayWinPct),
    winPctDiff: clamp((homeStats.winPct - awayStats.winPct + 1) / 2),
    runDiffAdv: clamp(
      ((homeStats.avgRS - homeStats.avgRA) - (awayStats.avgRS - awayStats.avgRA) + maxRuns)
      / (2 * maxRuns)
    ),
    homeMomentum: clamp(homeStats.momentum),
    awayMomentum: clamp(awayStats.momentum),
  };

  // ── H2H ───────────────────────────────────────────────────────────────
  const h2h = {
    h2hHomeWinPct: clamp(h2hStats.h2hHomeWinPct),
    h2hRunDiffAdv: clamp(h2hStats.h2hRunDiffAdv),
  };

  // ── Ballpark ──────────────────────────────────────────────────────────
  const ballpark = { parkFactor: clamp(getParkFactor(homeTeamId)) };

  // ── Season pitcher stats ──────────────────────────────────────────────
  const homePitcher = pitcherStats?.home ?? LEAGUE_AVG;
  const awayPitcher = pitcherStats?.away ?? LEAGUE_AVG;
  const pitcher = buildPitcherFeatures(homePitcher, awayPitcher);

  // ── Schedule context ──────────────────────────────────────────────────
  const hCtx = scheduleContext?.home ?? { restDays: 0.5, scheduleDensity: 0.5, homeStandLength: 0.5, roadTripLength: 0.5 };
  const aCtx = scheduleContext?.away ?? { restDays: 0.5, scheduleDensity: 0.5, homeStandLength: 0.5, roadTripLength: 0.5 };
  const schedule = {
    homeRestDays: clamp(hCtx.restDays),
    awayRestDays: clamp(aCtx.restDays),
    homeScheduleDensity: clamp(hCtx.scheduleDensity),
    awayScheduleDensity: clamp(aCtx.scheduleDensity),
    homeStandLength: clamp(hCtx.homeStandLength),
    roadTripLength: clamp(aCtx.roadTripLength),
  };

  // Shared date for all historical lookups
  const beforeDate = tierOneData?.date ?? '9999-99-99';

  // ── NEW: Recent pitcher form ──────────────────────────────────────────
  const homePitcherId = tierOneData?.homePitcherId ?? null;
  const awayPitcherId = tierOneData?.awayPitcherId ?? null;
  const gameLogs = tierOneData?.pitcherGameLogs ?? null;

  const homeRecentRaw = getRecentERAFeature(homePitcherId, gameLogs, beforeDate);
  const awayRecentRaw = getRecentERAFeature(awayPitcherId, gameLogs, beforeDate);

  // 70/30 blend: recent ERA (last 3 starts) weighted with season FIP
  const homeSeasonFIP = normaliseFIP(
    (pitcherStats?.home?.fip ?? pitcherStats?.home?.era ?? LEAGUE_AVG.fip)
  );
  const awaySeasonFIP = normaliseFIP(
    (pitcherStats?.away?.fip ?? pitcherStats?.away?.era ?? LEAGUE_AVG.fip)
  );
  const homeRecentERA = clamp(0.70 * homeRecentRaw + 0.30 * homeSeasonFIP);
  const awayRecentERA = clamp(0.70 * awayRecentRaw + 0.30 * awaySeasonFIP);
  const recentAdv = clamp((homeRecentERA - awayRecentERA + 1) / 2);

  const recentForm = {
    homeStarterRecentERA: homeRecentERA,
    awayStarterRecentERA: awayRecentERA,
    recentFormAdvantage: recentAdv,
  };

  // ── NEW: LHP/RHP batting splits ──────────────────────────────────────
  // Home team bats against away pitcher; away team bats against home pitcher.
  const homeSplits = tierOneData?.homeSplits ?? null;
  const awaySplits = tierOneData?.awaySplits ?? null;

  // Derive handedness from game logs (stored as pitchHand when logs were fetched)
  const homePitcherThrows = gameLogs?.get(homePitcherId)?.pitchHand ?? 'R';
  const awayPitcherThrows = gameLogs?.get(awayPitcherId)?.pitchHand ?? 'R';

  // Home lineup faces away starter's handedness
  const homeVsHand = homeSplits
    ? (awayPitcherThrows === 'L' ? homeSplits.vsLHP : homeSplits.vsRHP)
    : null;
  // Away lineup faces home starter's handedness
  const awayVsHand = awaySplits
    ? (homePitcherThrows === 'L' ? awaySplits.vsLHP : awaySplits.vsRHP)
    : null;

  const splits = {
    homeVsHandOPS: normaliseOPS(homeVsHand?.ops ?? null),
    awayVsHandOPS: normaliseOPS(awayVsHand?.ops ?? null),
  };

  // ── NEW: Starter personal rest days ──────────────────────────────────
  const homeStarterRestDays = getStarterRestDays(homePitcherId, gameLogs, beforeDate);
  const awayStarterRestDays = getStarterRestDays(awayPitcherId, gameLogs, beforeDate);
  const starterRest = { homeStarterRestDays, awayStarterRestDays };

  // ── NEW: Bullpen fatigue ──────────────────────────────────────────────
  const homeHistory = tierOneData?.homeHistory ?? [];
  const awayHistory = tierOneData?.awayHistory ?? [];
  const bullpenByGame = tierOneData?.bullpenByGame ?? null;

  const homeFatigue = bullpenByGame
    ? computeBullpenFatigue(homeHistory, beforeDate, bullpenByGame, true)
    : NEUTRAL_BULLPEN;
  const awayFatigue = bullpenByGame
    ? computeBullpenFatigue(awayHistory, beforeDate, bullpenByGame, false)
    : NEUTRAL_BULLPEN;

  const bullpen = {
    homeBullpenFatigue: clamp(homeFatigue),
    awayBullpenFatigue: clamp(awayFatigue),
  };

  // ── NEW: Weather features ─────────────────────────────────────────────
  const weather = normaliseWeather(tierOneData?.weather ?? null);

  // ── NEW: Bullpen quality ERA (point-in-time, see pointInTime.js) ─────
  const homeBullpenEraRaw = tierOneData?.homeBullpenERA ?? null;
  const awayBullpenEraRaw = tierOneData?.awayBullpenERA ?? null;
  // Normalise [2.5, 6.0] → [0,1] inverted (lower ERA = better = higher value)
  const normBullpenERA = era => {
    if (era == null) return 0.5;
    return Math.max(0, Math.min(1, 1 - (Math.max(2.5, Math.min(6.0, era)) - 2.5) / 3.5));
  };
  const bullpenQuality = {
    homeBullpenERA: normBullpenERA(homeBullpenEraRaw),
    awayBullpenERA: normBullpenERA(awayBullpenEraRaw),
  };

  // ── NEW: Starter announced flag ───────────────────────────────────────
  const starterFlags = {
    homeStarterAnnounced: homePitcherId != null ? 1 : 0,
    awayStarterAnnounced: awayPitcherId != null ? 1 : 0,
  };

  // ── NEW: Umpire ───────────────────────────────────────────────────────
  const umpireId = tierOneData?.umpireId ?? null;
  const umpireStats = tierOneData?.umpireStats ?? null;
  const umpire = {
    umpireRunFactor: clamp(getUmpireFeature(umpireId, umpireStats, beforeDate)),
  };

  // ── NEW: Pitcher component stats (K/9, BB/9, HR/9) ───────────────────
  const normK9  = v => clamp(normaliseTo01(v ?? 7.5, 4.0, 12.0));
  const normBB9 = v => clamp(1 - normaliseTo01(v ?? 3.0, 1.0, 5.5)); // inverted: fewer BB = better
  const normHR9 = v => clamp(1 - normaliseTo01(v ?? 1.1, 0.4, 2.0)); // inverted: fewer HR = better
  const pitcherComponents = {
    homeK9:  normK9(pitcherStats?.home?.k9),
    awayK9:  normK9(pitcherStats?.away?.k9),
    homeBB9: normBB9(pitcherStats?.home?.bb9),
    awayBB9: normBB9(pitcherStats?.away?.bb9),
    homeHR9: normHR9(pitcherStats?.home?.hr9),
    awayHR9: normHR9(pitcherStats?.away?.hr9),
  };

  // ── NEW: Season progress ──────────────────────────────────────────────
  const gameYear = beforeDate.slice(0, 4);
  const daysSinceOpen = (new Date(beforeDate) - new Date(`${gameYear}-03-20`)) / 86400000;
  const seasonProgress = { seasonProgress: clamp(daysSinceOpen / 200) };

  return { ...base, ...h2h, ...ballpark, ...pitcher, ...schedule, ...splits, ...recentForm,
           ...starterRest, ...bullpen, ...bullpenQuality, ...weather, ...starterFlags,
           ...umpire, ...pitcherComponents, ...seasonProgress };
}

// ---------------------------------------------------------------------------
// Training dataset builder
// ---------------------------------------------------------------------------

/**
 * Builds the full feature vector for one game using only information
 * available before game.date. This is the single code path used by
 * training, the daily update, the web server and the CLI.
 *
 * @param {object} game  { gameId, date, homeTeamId, awayTeamId, homePitcherId, awayPitcherId, umpireId }
 * @param {object} ctx   { history, umpireHistory, pit, bullpenByGame, weatherByGame, normStats }
 * @returns {object|null} null if either team lacks enough history
 */
function buildGameFeatures(game, ctx) {
  const { history, umpireHistory, pit, bullpenByGame = null, weatherByGame = {}, normStats = null } = ctx;
  const { date, homeTeamId, awayTeamId, homePitcherId = null, awayPitcherId = null } = game;

  const homeHistory = history[homeTeamId] || [];
  const awayHistory = history[awayTeamId] || [];
  const homeStats = computeTeamStats(homeHistory, date);
  const awayStats = computeTeamStats(awayHistory, date);
  if (!homeStats || !awayStats) return null;

  const h2hStats = computeH2HStats(homeHistory, awayTeamId, date);
  const homeCtx = computeScheduleContext(homeHistory, date);
  const awayCtx = computeScheduleContext(awayHistory, date);

  const pitcherStats = {
    home: homePitcherId ? pit.pitcherBefore(homePitcherId, date) : LEAGUE_AVG,
    away: awayPitcherId ? pit.pitcherBefore(awayPitcherId, date) : LEAGUE_AVG,
  };
  const homeTeam = pit.teamBefore(homeTeamId, date);
  const awayTeam = pit.teamBefore(awayTeamId, date);

  const tierOneData = {
    homePitcherId,
    awayPitcherId,
    pitcherGameLogs: pit.pitcherLogsForSeason(date.slice(0, 4)),
    homeHistory,
    awayHistory,
    bullpenByGame,
    date,
    umpireId: game.umpireId ?? null,
    umpireStats: umpireHistory,
    homeSplits: homeTeam.splits,
    awaySplits: awayTeam.splits,
    weather: weatherByGame[game.gameId] ?? null,
    awayTeamId,
    homeBullpenERA: homeTeam.bullpenEra,
    awayBullpenERA: awayTeam.bullpenEra,
  };

  const features = buildFeatureVector(
    homeStats, awayStats, h2hStats, homeTeamId,
    pitcherStats, { home: homeCtx, away: awayCtx }, tierOneData, normStats
  );

  return { features, homeStats, awayStats, h2hStats, homeCtx, awayCtx, pitcherStats };
}

function buildTrainingData(games, { pit, bullpenByGame = null, weatherByGame = {} }) {
  const history = buildTeamHistory(games);
  const umpireHistory = buildUmpireHistory(games);  // indexed by date — no leakage
  const normStats = buildNormStats(games);
  console.log(`   Norm bounds: RS [${normStats.rsLo.toFixed(1)}, ${normStats.rsHi.toFixed(1)}], maxRuns ${normStats.maxRuns.toFixed(1)}`);
  const ctx = { history, umpireHistory, pit, bullpenByGame, weatherByGame, normStats };
  const trainingData = [];
  let skipped = 0;
  let withPitchers = 0;

  for (const g of games) {
    const built = buildGameFeatures(g, ctx);
    if (!built) { skipped++; continue; }

    const hasPitcherData = !!(g.homePitcherId && g.awayPitcherId);
    if (hasPitcherData) withPitchers++;

    trainingData.push({
      input: built.features,
      output: { homeWin: g.homeWin ? 1 : 0 },
      hasPitcherData,
      date: g.date,   // needed for temporal train/test split
      gameId: g.gameId,
    });
  }

  console.log(`   Built ${trainingData.length} examples (${skipped} skipped, ${withPitchers} with pitcher data)`);
  return trainingData;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function dateDiffDays(dateA, dateB) {
  return Math.round((new Date(dateB) - new Date(dateA)) / 86400000);
}

function offsetDate(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

module.exports = {
  buildTeamHistory,
  computeTeamStats,
  computeH2HStats,
  computeScheduleContext,
  buildNormStats,
  buildUmpireHistory,
  buildFeatureVector,
  buildGameFeatures,
  FEATURE_GROUPS,
  buildTrainingData,
};