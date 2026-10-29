'use strict';

/**
 * pitchers.js  (v3 — adds recent form via game log)
 *
 * fetchProbablePitchers: gets season ERA/WHIP for each starter (used in model)
 * fetchPitcherRecentForm: gets last-3-start ERA for each starter (display only)
 */

const BASE_URL   = 'https://statsapi.mlb.com/api/v1';
const LEAGUE_AVG = { era: 4.20, whip: 1.28, fip: 4.20 };

// ---------------------------------------------------------------------------
// Season stats (used as model features)
// ---------------------------------------------------------------------------

async function fetchProbablePitchers(date) {
  const scheduleUrl =
    `${BASE_URL}/schedule?sportId=1&date=${date}&hydrate=probablePitcher&gameType=R`;

  let scheduleData;
  try {
    const res = await fetch(scheduleUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    scheduleData = await res.json();
  } catch (err) {
    console.warn(`  ⚠️  Could not fetch schedule for pitchers: ${err.message}`);
    return {};
  }

  const pitcherIds = new Set();
  const gameStubs  = [];

  for (const dateObj of scheduleData.dates || []) {
    for (const game of dateObj.games || []) {
      const homeId   = game.teams?.home?.probablePitcher?.id   ?? null;
      const awayId   = game.teams?.away?.probablePitcher?.id   ?? null;
      const homeName = game.teams?.home?.probablePitcher?.fullName ?? 'TBD';
      const awayName = game.teams?.away?.probablePitcher?.fullName ?? 'TBD';

      if (homeId) pitcherIds.add(homeId);
      if (awayId) pitcherIds.add(awayId);
      gameStubs.push({ gameId: game.gamePk, homeId, awayId, homeName, awayName });
    }
  }

  if (pitcherIds.size === 0) return {};

  const season   = date.slice(0, 4);
  const statsMap = await fetchPitcherStatsMap([...pitcherIds], season);

  const result = {};
  for (const { gameId, homeId, awayId, homeName, awayName } of gameStubs) {
    result[gameId] = {
      home: homeId ? (statsMap[homeId] ?? { ...LEAGUE_AVG, name: homeName, isLeagueAvg: true })
                   : { ...LEAGUE_AVG, name: 'TBD', isLeagueAvg: true },
      away: awayId ? (statsMap[awayId] ?? { ...LEAGUE_AVG, name: awayName, isLeagueAvg: true })
                   : { ...LEAGUE_AVG, name: 'TBD', isLeagueAvg: true },
    };
  }

  return result;
}

async function fetchPitcherStatsMap(ids, season) {
  const statsMap = {};
  const url =
    `${BASE_URL}/people?personIds=${ids.join(',')}&hydrate=stats(group=pitching,type=season,season=${season})`;

  let data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.warn(`  ⚠️  Could not fetch pitcher stats: ${err.message}`);
    return statsMap;
  }

  for (const person of data.people || []) {
    const name  = person.fullName ?? 'Unknown';
    const split = person.stats
      ?.find(s => s.group?.displayName === 'pitching' && s.type?.displayName === 'season')
      ?.splits?.[0]?.stat;

    if (!split) {
      statsMap[person.id] = { ...LEAGUE_AVG, name, isLeagueAvg: true };
      continue;
    }

    const era  = parseFloat(split.era)  || LEAGUE_AVG.era;
    const whip = parseFloat(split.whip) || LEAGUE_AVG.whip;
    const ip   = parseFloat(split.inningsPitched) || 0;
    const hr   = parseInt(split.homeRuns)    || 0;
    const bb   = parseInt(split.baseOnBalls) || 0;
    const hbp  = parseInt(split.hitByPitch)  || 0;
    const k    = parseInt(split.strikeOuts)  || 0;
    const fip  = ip >= 20 ? (13 * hr + 3 * (bb + hbp) - 2 * k) / ip + 3.10 : era;

    statsMap[person.id] = { name, era, whip, ip, fip, isLeagueAvg: false };
  }

  return statsMap;
}

// ---------------------------------------------------------------------------
// Recent form via game log (display only — not used as model feature)
// ---------------------------------------------------------------------------

/**
 * Fetches the last N starts for a list of pitcher IDs and returns
 * { pitcherId → { recentEra, starts, trend } }
 *
 * trend: 'improving' | 'declining' | 'stable'
 *
 * This is called at prediction time only. It's too expensive to backfill
 * for every historical game, so it's not a training feature — but it's
 * valuable context to display alongside predictions.
 */
async function fetchPitcherRecentForm(pitcherIds, season, beforeDate = '9999-12-31', lastNStarts = 3) {
  if (pitcherIds.length === 0) return {};

  const url =
    `${BASE_URL}/people?personIds=${pitcherIds.join(',')}&hydrate=stats(group=pitching,type=gameLog,season=${season})`;

  let data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.warn(`  ⚠️  Could not fetch pitcher game logs: ${err.message}`);
    return {};
  }

  const result = {};

  for (const person of data.people || []) {
    const gameLogStats = person.stats
      ?.find(s => s.group?.displayName === 'pitching' && s.type?.displayName === 'gameLog');

    // Starts before the target date only, most recent first
    const starts = (gameLogStats?.splits || [])
      .filter(s => (s.date ?? '') < beforeDate)
      .filter(s => (s.stat?.outs ?? 0) >= 3 && s.stat?.gamesStarted >= 1)
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
      .slice(0, lastNStarts);

    if (starts.length === 0) {
      result[person.id] = null;
      continue;
    }

    // The game log's `era` field is season-to-date, so compute each start's
    // ERA from its own earned runs and outs.
    const startEra = s => (s.stat.earnedRuns ?? 0) * 27 / s.stat.outs;
    const totalER   = starts.reduce((sum, s) => sum + (s.stat.earnedRuns ?? 0), 0);
    const totalOuts = starts.reduce((sum, s) => sum + s.stat.outs, 0);
    const recentEra = totalER * 27 / totalOuts;

    // Trend: newest start vs oldest start in the window
    let trend = 'stable';
    if (starts.length >= 2) {
      const newest = startEra(starts[0]);
      const oldest = startEra(starts[starts.length - 1]);
      if (newest < oldest - 0.75)      trend = 'improving';  // ERA dropped = better
      else if (newest > oldest + 0.75) trend = 'declining';
    }

    result[person.id] = {
      recentEra:  Math.round(recentEra * 100) / 100,
      starts:     starts.length,
      trend,
      lastStartDate: starts[0]?.date ?? null,
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Normalise and build pitcher model features
// ---------------------------------------------------------------------------

function normaliseERA(era) {
  const clamped = Math.max(1.5, Math.min(7.0, era));
  return 1 - (clamped - 1.5) / (7.0 - 1.5);
}

function normaliseFIP(fip) {
  const clamped = Math.max(1.5, Math.min(7.0, fip));
  return 1 - (clamped - 1.5) / (7.0 - 1.5);
}

function normaliseWHIP(whip) {
  const clamped = Math.max(0.85, Math.min(1.80, whip));
  return 1 - (clamped - 0.85) / (1.80 - 0.85);
}

function buildPitcherFeatures(homePitcher, awayPitcher) {
  const hFIP  = normaliseFIP(homePitcher.fip ?? homePitcher.era ?? LEAGUE_AVG.fip);
  const hWHIP = normaliseWHIP(homePitcher.whip);
  const aFIP  = normaliseFIP(awayPitcher.fip ?? awayPitcher.era ?? LEAGUE_AVG.fip);
  const aWHIP = normaliseWHIP(awayPitcher.whip);

  const homeQuality = 0.6 * hFIP + 0.4 * hWHIP;
  const awayQuality = 0.6 * aFIP + 0.4 * aWHIP;

  return {
    homePitcherFIP:   hFIP,
    homePitcherWHIP:  hWHIP,
    awayPitcherFIP:   aFIP,
    awayPitcherWHIP:  aWHIP,
    pitcherAdvantage: Math.max(0, Math.min(1, (homeQuality - awayQuality + 1) / 2)),
  };
}

module.exports = {
  fetchProbablePitchers,
  fetchPitcherRecentForm,
  buildPitcherFeatures,
  normaliseERA,
  normaliseFIP,
  normaliseWHIP,
  LEAGUE_AVG,
};
