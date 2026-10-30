'use strict';

const BASE_URL = 'https://statsapi.mlb.com/api/v1';

// ---------------------------------------------------------------------------
// Schedule fetch — now includes umpires hydration
// ---------------------------------------------------------------------------

async function fetchSchedule(startDate, endDate) {
  const url =
    `${BASE_URL}/schedule?sportId=1` +
    `&startDate=${startDate}&endDate=${endDate}` +
    `&hydrate=linescore,team,probablePitcher,officials&gameType=R`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB API error ${res.status}: ${url}`);
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

      // Extract home plate umpire ID
      const officials    = game.officials || [];
      const platOfficial = officials.find(o =>
        (o.officialType || '').toLowerCase().includes('home plate') ||
        (o.officialType || '').toLowerCase().includes('plate')
      );
      const umpireId = platOfficial?.official?.id ?? null;

      games.push({
        gameId:         game.gamePk,
        date:           dateObj.date,
        homeTeamId:     home.team.id,
        homeTeamName:   home.team.name,
        awayTeamId:     away.team.id,
        awayTeamName:   away.team.name,
        homeScore,
        awayScore,
        homeWin:        homeScore > awayScore,
        homePitcherId:  game.teams.home.probablePitcher?.id ?? null,
        awayPitcherId:  game.teams.away.probablePitcher?.id ?? null,
        umpireId,
      });
    }
  }
  return games.sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchHistoricalGames(season) {
  console.log(`📡  Fetching ${season} season from MLB API…`);

  const chunks = [
    [`${season}-03-20`, `${season}-04-30`],
    [`${season}-05-01`, `${season}-06-30`],
    [`${season}-07-01`, `${season}-08-31`],
    [`${season}-09-01`, `${season}-11-05`],
  ];

  const allGames = [];
  for (const [start, end] of chunks) {
    const data  = await fetchSchedule(start, end);
    const games = parseCompletedGames(data);
    allGames.push(...games);
    process.stdout.write(`   ${start} → ${end}: ${games.length} games\n`);
    await sleep(400);
  }

  return allGames;
}

// ---------------------------------------------------------------------------
// Pitcher season stats
// ---------------------------------------------------------------------------

/**
 * Full-season pitching counting stats for every pitcher in a season.
 * Returns Map<pitcherId, [outs, h, er, bb, hbp, k, hr, gs, g, age]>
 */
async function fetchSeasonPitcherCounts(season) {
  const counts = new Map();
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const url =
      `${BASE_URL}/stats?stats=season&group=pitching&season=${season}` +
      `&sportId=1&playerPool=all&limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${season} pitcher stats`);
    const stats = (await res.json()).stats?.[0];
    for (const { player, stat: s } of stats?.splits ?? []) {
      if (!player?.id || !s) continue;
      counts.set(player.id, [
        s.outs ?? 0, s.hits ?? 0, s.earnedRuns ?? 0, s.baseOnBalls ?? 0, s.hitByPitch ?? 0,
        s.strikeOuts ?? 0, s.homeRuns ?? 0, s.gamesStarted ?? 0, s.gamesPitched ?? 0, s.age ?? null,
      ]);
    }
    if (offset + pageSize >= (stats?.totalSplits ?? 0)) break;
    await sleep(200);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// NEW: Bullpen pitch counts from boxscores
// Fetches the total relief pitcher pitches thrown by each team for a game.
// Returns Map<gameId, { homeBullpenPitches, awayBullpenPitches }>
// ---------------------------------------------------------------------------

async function fetchBullpenData(gameIds) {
  if (!gameIds || gameIds.length === 0) return new Map();

  const result = new Map();
  const BATCH  = 5;   // boxscores are large — fetch 5 at a time

  for (let i = 0; i < gameIds.length; i += BATCH) {
    const batch = gameIds.slice(i, i + BATCH);

    await Promise.all(batch.map(async gameId => {
      const url = `${BASE_URL}/game/${gameId}/boxscore`;
      try {
        const res  = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();

        const homeBullpen = extractBullpenPitches(data.teams?.home);
        const awayBullpen = extractBullpenPitches(data.teams?.away);

        result.set(gameId, {
          homeBullpenPitches: homeBullpen,
          awayBullpenPitches: awayBullpen,
        });
      } catch { /* skip failed games */ }
    }));

    await sleep(300);
  }

  return result;
}

function extractBullpenPitches(teamData) {
  if (!teamData?.pitchers || !teamData?.players) return 0;

  // teamData.pitchers = array of player IDs who pitched
  // First pitcher is the starter — rest are relievers
  const pitcherIds = teamData.pitchers || [];
  if (pitcherIds.length <= 1) return 0;

  const relievers = pitcherIds.slice(1);   // skip starter
  let totalPitches = 0;

  for (const id of relievers) {
    const key    = `ID${id}`;
    const player = teamData.players[key];
    const pitches = player?.stats?.pitching?.numberOfPitches ?? 0;
    totalPitches += pitches;
  }

  return totalPitches;
}

// ---------------------------------------------------------------------------
// Schedule date fetch (used at prediction time)
// ---------------------------------------------------------------------------

async function fetchGamesForDate(date) {
  const data  = await fetchSchedule(date, date);
  const games = [];

  for (const dateObj of data.dates || []) {
    for (const game of dateObj.games || []) {
      const home = game.teams.home;
      const away = game.teams.away;

      const officials    = game.officials || [];
      const platOfficial = officials.find(o =>
        (o.officialType || '').toLowerCase().includes('plate')
      );

      games.push({
        gameId:        game.gamePk,
        date:          dateObj.date,
        gameDate:      game.gameDate ?? null,   // first pitch, ISO UTC
        homeTeamId:    home.team.id,
        homeTeamName:  home.team.name,
        awayTeamId:    away.team.id,
        awayTeamName:  away.team.name,
        status:        game.status?.detailedState ?? 'Unknown',
        homeScore:     home.score ?? null,
        awayScore:     away.score ?? null,
        homeWin:       home.score != null && away.score != null
                         ? home.score > away.score : null,
        umpireId:      platOfficial?.official?.id ?? null,
        umpireName:    platOfficial?.official?.fullName ?? null,
      });
    }
  }
  return games;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  fetchHistoricalGames,
  fetchGamesForDate,
  fetchSeasonPitcherCounts,
  fetchBullpenData,
};