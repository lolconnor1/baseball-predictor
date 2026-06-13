'use strict';

const fs   = require('fs');
const path = require('path');

const BASE_URL  = 'https://statsapi.mlb.com/api/v1';
const ROOT      = path.join(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'data');

// ---------------------------------------------------------------------------
// fetchTeamSplits
// Returns { vsLHP: { avg, ops }, vsRHP: { avg, ops } } for a team in a season.
// Uses a per-season cache file to avoid redundant API calls.
// ---------------------------------------------------------------------------

async function fetchTeamSplits(teamId, season) {
  const cachePath = path.join(CACHE_DIR, `splits-${season}.json`);
  const cacheKey  = String(teamId);

  // Load season cache if it exists
  let cache = {};
  if (fs.existsSync(cachePath)) {
    try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { cache = {}; }
  }
  if (cache[cacheKey]) return cache[cacheKey];

  const url =
    `${BASE_URL}/teams/${teamId}/stats` +
    `?stats=statSplits&group=hitting&gameType=R&season=${season}` +
    `&sitCodes=vl,vr&sportId=1`;

  let data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.warn(`  ⚠️  Could not fetch splits for team ${teamId} ${season}: ${err.message}`);
    return null;
  }

  const result = { vsLHP: null, vsRHP: null };

  for (const statGroup of data.stats ?? []) {
    for (const split of statGroup.splits ?? []) {
      const code = split.split?.code;
      const stat = split.stat;
      if (!stat) continue;
      const ops = parseFloat(stat.ops) || null;
      const avg = parseFloat(stat.avg) || null;
      if (code === 'vl') result.vsLHP = { avg, ops };
      if (code === 'vr') result.vsRHP = { avg, ops };
    }
  }

  cache[cacheKey] = result;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cache));

  return result;
}

// ---------------------------------------------------------------------------
// Normalise OPS [0.550, 0.900] → [0, 1]
// ---------------------------------------------------------------------------

function normaliseOPS(ops) {
  if (ops == null || isNaN(ops)) return 0.5;
  return Math.max(0, Math.min(1, (ops - 0.550) / (0.900 - 0.550)));
}

module.exports = { fetchTeamSplits, normaliseOPS };
