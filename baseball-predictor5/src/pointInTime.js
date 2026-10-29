'use strict';

/**
 * pointInTime.js — leak-free pitcher, bullpen and batting-split stats
 *
 * Every stat here is computed from per-game logs using only games played
 * strictly BEFORE the target date, then shrunk toward a prior (last season's
 * final numbers, themselves shrunk toward league average). Training and live
 * prediction both go through this module, so a feature means the same thing
 * in both places.
 *
 * Cache: data/pit-logs.json
 *   seasons[season] = {
 *     fetchedAt,
 *     pitchers:     { id: { hand, games: [[date, gamePk, teamId, gs, outs, er, h, bb, hbp, k, hr], ...] } },
 *     teamPitching: { teamId: [[date, gamePk, outs, er], ...] },
 *     teamHitting:  { teamId: [[date, gamePk, oppId, ab, h, bb, hbp, sf, tb], ...] },
 *   }
 * Priors: data/pitcher-priors.json — full-season pitcher stats by season
 *   { season: { fetchedAt, stats: [[id, { era, whip, ip, fip, k9, bb9, hr9 }], ...] } }
 */

const fs   = require('fs');
const path = require('path');
const { fetchSeasonPitcherStats } = require('./api');

const BASE_URL    = 'https://statsapi.mlb.com/api/v1';
const ROOT        = path.join(__dirname, '..');
const CACHE_PATH  = path.join(ROOT, 'data', 'pit-logs.json');
const PRIORS_PATH = path.join(ROOT, 'data', 'pitcher-priors.json');

const LEAGUE = {
  era: 4.20, whip: 1.28, fip: 4.20, k9: 8.5, bb9: 3.2, hr9: 1.2,
  bullpenEra: 4.10, obp: 0.315, slg: 0.405,
};
const FIP_CONST = 3.10;

// Shrinkage weights (in innings / plate appearances of "prior" evidence)
const PITCHER_PRIOR_IP     = 20;   // prior-season line → league
const PITCHER_BLEND_BASE   = 15;   // current-season line → prior (min weight)
const BULLPEN_PRIOR_IP     = 100;
const BULLPEN_BLEND_IP     = 50;
const SPLIT_PRIOR_PA       = 300;
const SPLIT_BLEND_PA       = 250;

// ---------------------------------------------------------------------------
// Cache I/O
// ---------------------------------------------------------------------------

function loadPitCache() {
  if (!fs.existsSync(CACHE_PATH)) return { version: 1, seasons: {} };
  return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
}

function savePitCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
}

function loadPriors() {
  if (!fs.existsSync(PRIORS_PATH)) return {};
  return JSON.parse(fs.readFileSync(PRIORS_PATH, 'utf8'));
}

// A season's cache is only final if it was fetched after that season ended.
function isComplete(entry, season) {
  return entry?.fetchedAt && entry.fetchedAt >= `${Number(season) + 1}-01-01`;
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchPitcherLogs(pitcherIds, season) {
  const result = {};
  const BATCH  = 50;

  for (let i = 0; i < pitcherIds.length; i += BATCH) {
    const batch = pitcherIds.slice(i, i + BATCH);
    const url =
      `${BASE_URL}/people?personIds=${batch.join(',')}` +
      `&hydrate=stats(group=pitching,type=gameLog,season=${season},gameType=R)`;

    let data;
    try {
      data = await fetchJson(url);
    } catch (err) {
      console.warn(`   ⚠️  Pitcher log batch failed (${season}): ${err.message}`);
      continue;
    }

    for (const person of data.people || []) {
      const log = person.stats
        ?.find(s => s.group?.displayName === 'pitching' && s.type?.displayName === 'gameLog');
      const games = (log?.splits || [])
        .filter(s => s.gameType === 'R' && s.date && s.game?.gamePk)
        .map(s => {
          const st = s.stat ?? {};
          return [
            s.date, s.game.gamePk, s.team?.id ?? null,
            st.gamesStarted ?? 0, st.outs ?? 0, st.earnedRuns ?? 0,
            st.hits ?? 0, st.baseOnBalls ?? 0, st.hitByPitch ?? 0,
            st.strikeOuts ?? 0, st.homeRuns ?? 0,
          ];
        })
        .sort((a, b) => a[0].localeCompare(b[0]));
      result[person.id] = { hand: person.pitchHand?.code ?? 'R', games };
    }

    await sleep(200);
  }

  return result;
}

async function fetchTeamLogs(teamIds, season) {
  const teamPitching = {};
  const teamHitting  = {};

  for (const teamId of teamIds) {
    const base = `${BASE_URL}/teams/${teamId}/stats?stats=gameLog&season=${season}&gameType=R`;
    try {
      const [pitch, hit] = await Promise.all([
        fetchJson(`${base}&group=pitching`),
        fetchJson(`${base}&group=hitting`),
      ]);
      teamPitching[teamId] = (pitch.stats?.[0]?.splits ?? [])
        .filter(s => s.date && s.game?.gamePk)
        .map(s => [s.date, s.game.gamePk, s.stat?.outs ?? 0, s.stat?.earnedRuns ?? 0])
        .sort((a, b) => a[0].localeCompare(b[0]));
      teamHitting[teamId] = (hit.stats?.[0]?.splits ?? [])
        .filter(s => s.date && s.game?.gamePk)
        .map(s => {
          const st = s.stat ?? {};
          return [
            s.date, s.game.gamePk, s.opponent?.id ?? null,
            st.atBats ?? 0, st.hits ?? 0, st.baseOnBalls ?? 0,
            st.hitByPitch ?? 0, st.sacFlies ?? 0, st.totalBases ?? 0,
          ];
        })
        .sort((a, b) => a[0].localeCompare(b[0]));
    } catch (err) {
      console.warn(`   ⚠️  Team log fetch failed for ${teamId} ${season}: ${err.message}`);
    }
    await sleep(100);
  }

  return { teamPitching, teamHitting };
}

// ---------------------------------------------------------------------------
// Cache maintenance
// ---------------------------------------------------------------------------

/**
 * Makes sure every season in `seasons` (plus the prior season, for team
 * priors) has logs cached. Seasons that weren't complete when fetched are
 * re-fetched so their numbers are current.
 */
async function ensureSeasonLogs(cache, allGames, seasons) {
  for (const season of seasons) {
    const key   = String(season);
    const entry = cache.seasons[key];
    if (isComplete(entry, season)) continue;

    const seasonGames = allGames.filter(g => g.date.startsWith(key));
    const pitcherIds  = [...new Set(seasonGames.flatMap(g => [g.homePitcherId, g.awayPitcherId]).filter(Boolean))];
    const teamIds     = [...new Set(seasonGames.flatMap(g => [g.homeTeamId, g.awayTeamId]))];
    if (pitcherIds.length === 0) continue;

    console.log(`   ${key}: fetching game logs for ${pitcherIds.length} starters and ${teamIds.length} teams…`);
    const pitchers = await fetchPitcherLogs(pitcherIds, key);
    const { teamPitching, teamHitting } = await fetchTeamLogs(teamIds, key);
    const now = new Date().toISOString();
    cache.seasons[key] = { fetchedAt: now, teamsFetchedAt: now, pitchers, teamPitching, teamHitting };
    savePitCache(cache);
  }
}

/** Refreshes logs for specific pitchers (e.g. today's probable starters). */
async function refreshPitchers(cache, season, pitcherIds) {
  const key = String(season);
  if (!cache.seasons[key]) cache.seasons[key] = { fetchedAt: null, pitchers: {}, teamPitching: {}, teamHitting: {} };
  if (pitcherIds.length === 0) return;
  Object.assign(cache.seasons[key].pitchers, await fetchPitcherLogs(pitcherIds, key));
}

/** Refreshes team logs for a season if they're older than maxAgeHours. */
async function refreshTeamsIfStale(cache, season, teamIds, maxAgeHours = 12) {
  const key   = String(season);
  const entry = cache.seasons[key];
  const age   = entry?.teamsFetchedAt ? (Date.now() - new Date(entry.teamsFetchedAt)) / 3600000 : Infinity;
  if (age < maxAgeHours) return false;

  const { teamPitching, teamHitting } = await fetchTeamLogs(teamIds, key);
  Object.assign(entry.teamPitching, teamPitching);
  Object.assign(entry.teamHitting,  teamHitting);
  entry.teamsFetchedAt = new Date().toISOString();
  return true;
}

/**
 * Loads the cache and brings it up to date for predicting games on `date`:
 * today's starters get fresh logs, and team logs are refreshed if stale.
 * Completed seasons are only touched for pitchers missing from the cache.
 * Returns a ready-to-use point-in-time context.
 */
async function preparePitForDate(date, pitcherIds, teamIds) {
  const season   = date.slice(0, 4);
  const cache    = loadPitCache();
  const entry    = cache.seasons[season];
  const complete = isComplete(entry, season);

  const toFetch = complete
    ? pitcherIds.filter(id => !entry.pitchers[id])
    : pitcherIds;
  await refreshPitchers(cache, season, toFetch);
  const teamsRefreshed = !complete && await refreshTeamsIfStale(cache, season, teamIds);

  if (toFetch.length > 0 || teamsRefreshed) savePitCache(cache);
  return buildPitContext(cache);
}

/**
 * Full-season pitcher stats for each prior season (season - 1), used to
 * anchor early-season estimates. Re-fetched until the season is complete.
 */
async function ensurePitcherPriors(seasons) {
  const priors  = loadPriors();
  let   changed = false;

  for (const season of seasons) {
    const prior = String(Number(season) - 1);
    if (isComplete(priors[prior], prior)) continue;
    const stats = await fetchSeasonPitcherStats(prior);
    priors[prior] = { fetchedAt: new Date().toISOString(), stats: [...stats.entries()] };
    changed = true;
  }

  if (changed) fs.writeFileSync(PRIORS_PATH, JSON.stringify(priors));
  return priors;
}

// ---------------------------------------------------------------------------
// Point-in-time context
// ---------------------------------------------------------------------------

/**
 * Builds a lookup object over the cached logs. All methods take a date and
 * only use games strictly before it.
 */
function buildPitContext(cache, priors = loadPriors()) {
  const priorMaps    = {};   // season → Map<pitcherId, stats>
  const starterIndex = {};   // season → Map<"gamePk|teamId", { pitcherId, row }>
  const logMaps      = {};   // season → Map<pitcherId, { pitchHand, startDates }>
  const teamPriors   = {};   // "season|teamId" → { bullpenEra, vsL, vsR }

  function priorMap(season) {
    const key = String(Number(season) - 1);
    if (!priorMaps[key]) priorMaps[key] = new Map(priors[key]?.stats ?? []);
    return priorMaps[key];
  }

  function starters(season) {
    const key = String(season);
    if (!starterIndex[key]) {
      const idx = new Map();
      for (const [id, p] of Object.entries(cache.seasons[key]?.pitchers ?? {})) {
        for (const row of p.games) {
          if (row[3] >= 1 && row[2] != null) idx.set(`${row[1]}|${row[2]}`, { pitcherId: Number(id), row });
        }
      }
      starterIndex[key] = idx;
    }
    return starterIndex[key];
  }

  function handOf(season, pitcherId) {
    return cache.seasons[String(season)]?.pitchers?.[pitcherId]?.hand ?? null;
  }

  // ── Starting pitchers ───────────────────────────────────────────────────

  function pitcherBefore(pitcherId, date) {
    const season = date.slice(0, 4);
    const games  = cache.seasons[season]?.pitchers?.[pitcherId]?.games ?? [];

    let outs = 0, er = 0, h = 0, bb = 0, hbp = 0, k = 0, hr = 0;
    for (const row of games) {
      if (row[0] >= date) break;
      outs += row[4]; er += row[5]; h += row[6]; bb += row[7]; hbp += row[8]; k += row[9]; hr += row[10];
    }
    const ip = outs / 3;

    // Prior: last season's line, shrunk toward league average
    const p   = pitcherId ? priorMap(season).get(pitcherId) : null;
    const pIP = p ? Math.min(p.ip ?? 0, 150) : 0;
    const shrink = (v, lg) => (v != null && isFinite(v) ? (v * pIP + lg * PITCHER_PRIOR_IP) / (pIP + PITCHER_PRIOR_IP) : lg);
    const pr = {
      era:  shrink(p?.era,  LEAGUE.era),
      whip: shrink(p?.whip, LEAGUE.whip),
      fip:  shrink(p?.fip,  LEAGUE.fip),
      k9:   shrink(p?.k9,   LEAGUE.k9),
      bb9:  shrink(p?.bb9,  LEAGUE.bb9),
      hr9:  shrink(p?.hr9,  LEAGUE.hr9),
    };

    // Current season to date, blended with the prior
    const W = PITCHER_BLEND_BASE + pIP * 0.15;
    const blend = (num, prRate) => (num + prRate * W) / (ip + W);
    return {
      era:  blend(9 * er,      pr.era),
      whip: blend(h + bb,      pr.whip),
      k9:   blend(9 * k,       pr.k9),
      bb9:  blend(9 * bb,      pr.bb9),
      hr9:  blend(9 * hr,      pr.hr9),
      fip:  blend(13 * hr + 3 * (bb + hbp) - 2 * k, pr.fip - FIP_CONST) + FIP_CONST,
      ip,
    };
  }

  /**
   * Map<pitcherId, { pitchHand, startDates: [{date, earnedRuns, ip}] }> for a
   * season, in the shape features.js expects. Starts are ascending by date;
   * features.js filters them to before the game date.
   */
  function pitcherLogsForSeason(season) {
    const key = String(season);
    if (!logMaps[key]) {
      const m = new Map();
      for (const [id, p] of Object.entries(cache.seasons[key]?.pitchers ?? {})) {
        m.set(Number(id), {
          pitchHand:  p.hand,
          startDates: p.games
            .filter(r => r[3] >= 1 && r[4] >= 3)
            .map(r => ({ date: r[0], earnedRuns: r[5], ip: r[4] / 3 })),
        });
      }
      logMaps[key] = m;
    }
    return logMaps[key];
  }

  // ── Team bullpen & batting splits ───────────────────────────────────────

  // Raw season totals for a team before a date (no shrinkage)
  function teamTotals(teamId, season, date) {
    const s    = cache.seasons[String(season)];
    const idx  = starters(season);
    const tot  = { bpOuts: 0, bpER: 0, L: emptyBat(), R: emptyBat() };
    if (!s) return tot;

    for (const row of s.teamPitching?.[teamId] ?? []) {
      if (row[0] >= date) break;
      const st = idx.get(`${row[1]}|${teamId}`);
      if (!st) continue;   // starter unknown — can't separate bullpen
      tot.bpOuts += row[2] - st.row[4];
      tot.bpER   += row[3] - st.row[5];
    }

    for (const row of s.teamHitting?.[teamId] ?? []) {
      if (row[0] >= date) break;
      const opp  = row[2] != null ? idx.get(`${row[1]}|${row[2]}`) : null;
      const hand = opp ? handOf(season, opp.pitcherId) : null;
      if (hand !== 'L' && hand !== 'R') continue;
      const b = tot[hand];
      b.ab += row[3]; b.h += row[4]; b.bb += row[5]; b.hbp += row[6]; b.sf += row[7]; b.tb += row[8];
    }
    return tot;
  }

  function teamPrior(teamId, season) {
    const key = `${season}|${teamId}`;
    if (!teamPriors[key]) {
      const prev = String(Number(season) - 1);
      const t    = teamTotals(teamId, prev, `${season}-01-01`);
      const bpIP = t.bpOuts / 3;
      teamPriors[key] = {
        bullpenEra: (9 * t.bpER + LEAGUE.bullpenEra * BULLPEN_PRIOR_IP) / (bpIP + BULLPEN_PRIOR_IP),
        L: shrinkBat(t.L, LEAGUE.obp, LEAGUE.slg, SPLIT_PRIOR_PA),
        R: shrinkBat(t.R, LEAGUE.obp, LEAGUE.slg, SPLIT_PRIOR_PA),
      };
    }
    return teamPriors[key];
  }

  function teamBefore(teamId, date) {
    const season = date.slice(0, 4);
    const t      = teamTotals(teamId, season, date);
    const pr     = teamPrior(teamId, season);
    const bpIP   = t.bpOuts / 3;
    const vsL    = shrinkBat(t.L, pr.L.obp, pr.L.slg, SPLIT_BLEND_PA);
    const vsR    = shrinkBat(t.R, pr.R.obp, pr.R.slg, SPLIT_BLEND_PA);
    return {
      bullpenEra: (9 * t.bpER + pr.bullpenEra * BULLPEN_BLEND_IP) / (bpIP + BULLPEN_BLEND_IP),
      splits: { vsLHP: { ops: vsL.obp + vsL.slg }, vsRHP: { ops: vsR.obp + vsR.slg } },
    };
  }

  return { pitcherBefore, pitcherLogsForSeason, teamBefore };
}

function emptyBat() {
  return { ab: 0, h: 0, bb: 0, hbp: 0, sf: 0, tb: 0 };
}

function shrinkBat(b, prObp, prSlg, weight) {
  const pa = b.ab + b.bb + b.hbp + b.sf;
  return {
    obp: (b.h + b.bb + b.hbp + prObp * weight) / (pa + weight),
    slg: (b.tb + prSlg * weight) / (b.ab + weight),
  };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  loadPitCache,
  savePitCache,
  ensureSeasonLogs,
  ensurePitcherPriors,
  preparePitForDate,
  buildPitContext,
  LEAGUE,
};
