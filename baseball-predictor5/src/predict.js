'use strict';

const { rfPredict } = require('./rfPredict');
const fs   = require('fs');
const path = require('path');

const { fetchGamesForDate }                              = require('./api');
const { buildTeamHistory, computeTeamStats,
        computeH2HStats, computeScheduleContext,
        buildUmpireStats, buildFeatureVector }           = require('./features');
const { fetchProbablePitchers, fetchPitcherRecentForm } = require('./pitchers');
const { getRawParkFactor, getVenueName }                = require('./venues');

const ROOT          = path.join(__dirname, '..');
const DATA_PATH     = path.join(ROOT, 'data', 'games.json');
const MODEL_PATH    = path.join(ROOT, 'data', 'model.json');
const BULLPEN_PATH  = path.join(ROOT, 'data', 'bullpen.json');
const GAMELOGS_PATH = path.join(ROOT, 'data', 'pitcher-gamelogs.json');

async function predict({ date = today() } = {}) {
  // ── 1. Load model ──────────────────────────────────────────────────
  if (!fs.existsSync(MODEL_PATH)) {
    console.error('❌  No trained model found. Run `node index.js train` first.');
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));

  if (!payload.model) throw new Error('No valid model found in model.json');
  const featureNames = payload.featureNames;

  console.log(`\n🤖  Model trained on seasons : ${payload.trainedOn.join(', ')}`);
  console.log(`    Test accuracy             : ${(payload.testAccuracy * 100).toFixed(1)}%`);
  console.log(`    Baseline (always home)    : ${(payload.baselineAcc * 100).toFixed(1)}%`);
  console.log(`    Feature count             : ${payload.featureCount ?? 'legacy'}`);
  if (payload.lastUpdated) console.log(`    Last updated              : ${payload.lastUpdated}`);
  console.log();

  // ── 2. Load game history + caches ─────────────────────────────────
  if (!fs.existsSync(DATA_PATH)) {
    console.error('❌  No game data found. Run `node index.js train` first.');
    process.exit(1);
  }
  const allGames    = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const history     = buildTeamHistory(allGames);
  const umpireHistory = buildUmpireHistory(allGames);

  // Bullpen cache
  let bullpenByGame = null;
  if (fs.existsSync(BULLPEN_PATH)) {
    const raw = JSON.parse(fs.readFileSync(BULLPEN_PATH, 'utf8'));
    bullpenByGame = new Map(Object.entries(raw).map(([k, v]) => [parseInt(k), v]));
  }

  // Pitcher game logs cache
  let pitcherGameLogsForSeason = null;
  if (fs.existsSync(GAMELOGS_PATH)) {
    const raw    = JSON.parse(fs.readFileSync(GAMELOGS_PATH, 'utf8'));
    const season = date.slice(0, 4);
    pitcherGameLogsForSeason = new Map((raw[season] ?? []).map(([k, v]) => [k, v]));
  }

  // ── 3. Fetch schedule + pitcher data ──────────────────────────────
  console.log(`📡  Fetching games and pitcher data for ${date}…`);
  const [games, pitcherMap] = await Promise.all([
    fetchGamesForDate(date),
    fetchProbablePitchers(date),
  ]);

  if (games.length === 0) {
    console.log(`\n⚾  No games found for ${date}.\n`);
    return;
  }

  // ── 4. Fetch pitcher IDs + recent form ────────────────────────────
  const allPitcherIds  = new Set();
  const pitcherIdsByGame = {};

  const scheduleUrl =
    `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=probablePitcher&gameType=R`;
  const schedResp = await fetch(scheduleUrl).catch(() => null);
  if (schedResp?.ok) {
    const schedData = await schedResp.json();
    for (const dateObj of schedData.dates || []) {
      for (const game of dateObj.games || []) {
        pitcherIdsByGame[game.gamePk] = {
          homeId: game.teams?.home?.probablePitcher?.id ?? null,
          awayId: game.teams?.away?.probablePitcher?.id ?? null,
        };
        if (pitcherIdsByGame[game.gamePk].homeId)
          allPitcherIds.add(pitcherIdsByGame[game.gamePk].homeId);
        if (pitcherIdsByGame[game.gamePk].awayId)
          allPitcherIds.add(pitcherIdsByGame[game.gamePk].awayId);
      }
    }
  }

  const season     = date.slice(0, 4);
  const recentForm = allPitcherIds.size > 0
    ? await fetchPitcherRecentForm([...allPitcherIds], season)
    : {};

  // ── 5. Build predictions ───────────────────────────────────────────
  const divider = '─'.repeat(70);
  const normStats = payload.normStats ?? null;

  console.log(`\n🎯  MLB Predictions for ${date}`);
  console.log(divider);

  let modelled = 0;

  for (const game of games) {
    const { homeTeamName, awayTeamName, homeTeamId, awayTeamId, status, gameId } = game;

    const homeHistory = history[homeTeamId] || [];
    const awayHistory = history[awayTeamId] || [];
    const homeStats   = computeTeamStats(homeHistory, date);
    const awayStats   = computeTeamStats(awayHistory, date);

    if (!homeStats || !awayStats) {
      console.log(`\n  ${awayTeamName} @ ${homeTeamName}  [${status}]`);
      console.log(`  ⚠️   Not enough historical data to predict.`);
      continue;
    }

    const h2hStats       = computeH2HStats(homeHistory, awayTeamId, date);
    const homeCtx        = computeScheduleContext(homeHistory, date);
    const awayCtx        = computeScheduleContext(awayHistory, date);
    const scheduleContext = { home: homeCtx, away: awayCtx };
    const pitcherStats   = pitcherMap[gameId] ?? null;
    const ids            = pitcherIdsByGame[gameId] ?? {};

    const tierOneData = {
      homePitcherId:   ids.homeId,
      awayPitcherId:   ids.awayId,
      pitcherGameLogs: pitcherGameLogsForSeason,
      homeHistory,
      awayHistory,
      bullpenByGame,
      date,
      umpireId:        game.umpireId ?? null,
      umpireStats: umpireHistory,
    };

    const features = buildFeatureVector(
      homeStats, awayStats, h2hStats, homeTeamId,
      pitcherStats, scheduleContext, tierOneData, normStats
    );

    const homeProb = rfPredict(payload.model, featureNames, features);

    const awayProb     = 1 - homeProb;
    const favoriteHome = homeProb >= 0.5;
    const favorite     = favoriteHome ? homeTeamName : awayTeamName;
    const confidence   = favoriteHome ? homeProb : awayProb;

    const homePitcher = pitcherStats?.home;
    const awayPitcher = pitcherStats?.away;
    const homeForm    = ids.homeId ? recentForm[ids.homeId] : null;
    const awayForm    = ids.awayId ? recentForm[ids.awayId] : null;

    console.log(`\n  ${awayTeamName}  @  ${homeTeamName}  [${status}]`);
    console.log(`  Venue      : ${getVenueName(homeTeamId)}  (park factor ${getRawParkFactor(homeTeamId).toFixed(2)})`);

    if (homePitcher && !homePitcher.isLeagueAvg) {
      const hStr = homeForm ? `  recent ${homeForm.recentEra} ERA (${homeForm.trend})` : '';
      const aStr = awayForm ? `  recent ${awayForm.recentEra} ERA (${awayForm.trend})` : '';
      console.log(`  Pitchers   : ${homePitcher.name} ERA ${homePitcher.era?.toFixed(2)} WHIP ${homePitcher.whip?.toFixed(2)}${hStr}`);
      console.log(`               ${awayPitcher.name} ERA ${awayPitcher.era?.toFixed(2)} WHIP ${awayPitcher.whip?.toFixed(2)}${aStr} (away)`);
    } else {
      console.log(`  Pitchers   : Not yet announced`);
    }

    const h2hLabel = h2hStats.h2hHomeWinPct === 0.5 && h2hStats.h2hRunDiffAdv === 0.5
      ? 'Insufficient history'
      : `Home wins ${pct(h2hStats.h2hHomeWinPct)} of prior matchups`;
    console.log(`  H2H        : ${h2hLabel}`);

    const homeRest   = Math.round(homeCtx.restDays * 5);
    const awayRest   = Math.round(awayCtx.restDays * 5);
    const homeGames7 = Math.round(homeCtx.scheduleDensity * 7);
    const awayGames7 = Math.round(awayCtx.scheduleDensity * 7);
    const homeStand  = Math.round(homeCtx.homeStandLength * 7);
    const roadTrip   = Math.round(awayCtx.roadTripLength  * 7);
    console.log(`  Schedule   : Home — ${homeRest}d rest, ${homeGames7}/7 days, game ${homeStand} of home stand`);
    console.log(`               Away — ${awayRest}d rest, ${awayGames7}/7 days, game ${roadTrip} of road trip`);

    console.log(`  Prediction : ${BOLD}${favorite}${RESET} wins`);
    console.log(`  Confidence : ${confidenceBar(confidence)} ${pct(confidence)}`);
    console.log(`  Win probs  : home ${pct(homeProb)}  |  away ${pct(awayProb)}`);
    console.log(`  Home stats : WR ${pct(homeStats.winPct)}, RS ${homeStats.avgRS.toFixed(1)}, RA ${homeStats.avgRA.toFixed(1)}, last-5 ${pct(homeStats.momentum)}`);
    console.log(`  Away stats : WR ${pct(awayStats.winPct)}, RS ${awayStats.avgRS.toFixed(1)}, RA ${awayStats.avgRA.toFixed(1)}, last-5 ${pct(awayStats.momentum)}`);

    modelled++;
  }

  console.log(`\n${divider}`);
  console.log(`  ${modelled} of ${games.length} matchup(s) predicted\n`);
}

const BOLD  = '\x1b[1m';
const RESET = '\x1b[0m';

function pct(v) { return `${(v * 100).toFixed(1)}%`; }

function confidenceBar(c) {
  const f = Math.round(c * 20);
  return `[${'█'.repeat(f)}${'░'.repeat(20 - f)}]`;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

module.exports = { predict };