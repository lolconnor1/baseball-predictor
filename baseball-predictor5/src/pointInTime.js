'use strict';

/**
 * pointInTime.js — leak-free pitcher, bullpen and batting-split stats
 *
 * Every stat here is computed from per-game logs using only games played
 * strictly BEFORE the target date, then shrunk toward a prior (earlier
 * seasons, themselves shrunk toward league average). Training and live
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
 * Pitcher history: data/pitcher-seasons.json — full-season counting stats
 *   { season: { fetchedAt, stats: [[id, [outs, h, er, bb, hbp, k, hr, gs, g, age]], ...] } }
 */

const fs   = require('fs');
const path = require('path');
const { fetchSeasonPitcherCounts } = require('./api');

const BASE_URL             = 'https://statsapi.mlb.com/api/v1';
const ROOT                 = path.join(__dirname, '..');
const CACHE_PATH           = path.join(ROOT, 'data', 'pit-logs.json');
const PITCHER_SEASONS_PATH = path.join(ROOT, 'data', 'pitcher-seasons.json');

const LEAGUE = { bullpenEra: 4.10, obp: 0.315, slg: 0.405 };

// Shrinkage weights (in innings / plate appearances of "prior" evidence)
const BULLPEN_PRIOR_IP     = 100;
const BULLPEN_BLEND_IP     = 50;
const SPLIT_PRIOR_PA       = 300;
const SPLIT_BLEND_PA       = 250;

// Marcel-style starter projection (pitcherProjection)
const PROJECTION = {
  // Current season to date, then one, two and three seasons back
  seasonWeights: [1.0, 0.6, 0.4, 0.2],
  // Regression toward league average, in weighted batters faced: strikeout
  // rate becomes reliable quickly, hits and runs allowed barely do
  regressBF: { k: 150, bb: 300, hr: 1000, h: 1500, er: 1500, outs: 1500 },
  // Starter length: current-season starts count fully, last season's half,
  // shrunk toward the league average start by this many starts
  prevSeasonStartWeight: 0.5,
  regressStarts: 4,
};

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

function loadPitcherSeasons() {
  if (!fs.existsSync(PITCHER_SEASONS_PATH)) return {};
  return JSON.parse(fs.readFileSync(PITCHER_SEASONS_PATH, 'utf8'));
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
  return buildPitContext(cache, await ensurePitcherSeasons([season]));
}

/**
 * Full-season counting stats for the three seasons before each season in
 * `seasons` (the projection's history). Re-fetched until a season is complete.
 * data/pitcher-seasons.json: { season: { fetchedAt, stats: [[id, [outs, h, er, bb, hbp, k, hr, gs, g, age]], ...] } }
 */
async function ensurePitcherSeasons(seasons) {
  const data   = loadPitcherSeasons();
  const needed = [...new Set(seasons.flatMap(s => [1, 2, 3].map(k => String(Number(s) - k))))].sort();
  let changed  = false;

  for (const season of needed) {
    if (isComplete(data[season], season)) continue;
    console.log(`   Fetching ${season} pitcher season totals…`);
    const counts = await fetchSeasonPitcherCounts(season);
    data[season] = { fetchedAt: new Date().toISOString(), stats: [...counts.entries()] };
    changed = true;
  }

  if (changed) fs.writeFileSync(PITCHER_SEASONS_PATH, JSON.stringify(data));
  return data;
}

// ---------------------------------------------------------------------------
// Point-in-time context
// ---------------------------------------------------------------------------

/**
 * Builds a lookup object over the cached logs. All methods take a date and
 * only use games strictly before it.
 */
function buildPitContext(cache, pitcherSeasons = loadPitcherSeasons()) {
  const starterIndex = {};   // season → Map<"gamePk|teamId", { pitcherId, row }>
  const logMaps      = {};   // season → Map<pitcherId, { pitchHand, startDates }>
  const teamPriors   = {};   // "season|teamId" → { bullpenEra, vsL, vsR }
  const seasonCounts = {};   // season → Map<pitcherId, counts>
  const leagues      = {};   // season → league rates per batter faced

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

  // ── Starting pitchers: Marcel-style projection ──────────────────────────
  // Counts are { bf, outs, h, er, bb, k, hr } with bb including HBP and
  // batters faced approximated as outs + h + bb + hbp, the same way for
  // full seasons and game logs so rates are comparable.

  function countsOf(outs, h, er, bb, hbp, k, hr) {
    return { bf: outs + h + bb + hbp, outs, h, er, bb: bb + hbp, k, hr };
  }

  function seasonCountsFor(season) {
    const key = String(season);
    if (!seasonCounts[key]) {
      seasonCounts[key] = new Map((pitcherSeasons[key]?.stats ?? []).map(([id, c]) =>
        [id, countsOf(c[0], c[1], c[2], c[3], c[4], c[5], c[6])]));
    }
    return seasonCounts[key];
  }

  function league(season) {
    const key = String(season);
    if (!leagues[key]) {
      const t = countsOf(0, 0, 0, 0, 0, 0, 0);
      for (const c of seasonCountsFor(season).values()) for (const f in t) t[f] += c[f];
      const rate = Object.fromEntries(Object.keys(t).map(f => [f, t[f] / t.bf]));

      // Average start length, from the starters' game logs
      let starts = 0, startOuts = 0;
      for (const p of Object.values(cache.seasons[key]?.pitchers ?? {})) {
        for (const row of p.games) if (row[3] >= 1) { starts++; startOuts += row[4]; }
      }
      const ip = t.outs / 3;
      leagues[key] = t.bf > 0 ? {
        ...rate,
        fipConst: (9 * t.er - (13 * t.hr + 3 * t.bb - 2 * t.k)) / ip,
        outsPerStart: starts > 0 ? startOuts / starts : 16,
      } : null;
    }
    return leagues[key];
  }

  /**
   * Projected per-batter rates for a starter as of `date`: the current season
   * to date plus the three before it, weighted by recency, each rate regressed
   * toward the previous season's league average by how noisy it is.
   */
  function pitcherProjection(pitcherId, date, opts = {}) {
    // An unannounced starter (null id) projects as a pitcher with no history
    const P      = { ...PROJECTION, ...opts };
    const season = Number(date.slice(0, 4));
    const lg     = league(season - 1) ?? league(season - 2);

    const tot = countsOf(0, 0, 0, 0, 0, 0, 0);
    let historyBF = 0;
    const add = (c, w) => {
      for (const f in tot) tot[f] += w * c[f];
      historyBF += c.bf;
    };

    const logs = cache.seasons[String(season)]?.pitchers?.[pitcherId]?.games ?? [];
    const now  = countsOf(0, 0, 0, 0, 0, 0, 0);
    let starts = 0, startOuts = 0;
    for (const row of logs) {
      if (row[0] >= date) break;
      const c = countsOf(row[4], row[6], row[5], row[7], row[8], row[9], row[10]);
      for (const f in now) now[f] += c[f];
      if (row[3] >= 1) { starts++; startOuts += row[4]; }
    }
    add(now, P.seasonWeights[0]);
    for (let back = 1; back <= 3; back++) {
      const c = seasonCountsFor(season - back).get(Number(pitcherId));
      if (c) add(c, P.seasonWeights[back]);
    }

    const rate = f => (tot[f] + P.regressBF[f] * lg[f]) / (tot.bf + P.regressBF[f]);
    const r = { k: rate('k'), bb: rate('bb'), hr: rate('hr'), h: rate('h'), er: rate('er'), outs: rate('outs') };
    const ipPerBF = r.outs / 3;

    for (const row of cache.seasons[String(season - 1)]?.pitchers?.[pitcherId]?.games ?? []) {
      if (row[3] >= 1) { starts += P.prevSeasonStartWeight; startOuts += P.prevSeasonStartWeight * row[4]; }
    }

    return {
      kPct:  r.k,
      bbPct: r.bb,
      hrPct: r.hr,
      kbb:   r.k - r.bb,
      fip:   (13 * r.hr + 3 * r.bb - 2 * r.k) / ipPerBF + lg.fipConst,
      era:   9 * r.er / ipPerBF,
      whip:  (r.h + r.bb) / ipPerBF,
      historyBF,
      expectedIP: (startOuts + P.regressStarts * lg.outsPerStart) / (starts + P.regressStarts) / 3,
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

  return { pitcherProjection, pitcherLogsForSeason, teamBefore };
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
  ensurePitcherSeasons,
  preparePitForDate,
  buildPitContext,
};
