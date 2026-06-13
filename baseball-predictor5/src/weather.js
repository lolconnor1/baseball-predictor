'use strict';

// In-memory cache keyed by "lat,lon|date" — valid for duration of a single run
const _cache = new Map();

/**
 * Fetches daily max temperature (°F) and max wind speed (mph) for a venue/date.
 * Uses Open-Meteo free API — no key required.
 * Returns { tempF, windMph } or null on failure.
 *
 * Domed stadiums (Tropicana Field, Rogers Centre, Minute Maid, Chase Field,
 * loanDepot park) have controlled climates; for those we return neutral values
 * so weather features add no signal.
 */

// Team IDs for fully domed or retractable-roof stadiums (neutral conditions)
const DOME_TEAM_IDS = new Set([117, 109, 139, 141, 146]);

async function fetchGameWeather(lat, lon, dateStr, homeTeamId = null) {
  if (homeTeamId != null && DOME_TEAM_IDS.has(homeTeamId)) {
    return { tempF: 72, windMph: 0 };  // neutral indoor conditions
  }

  const key = `${lat.toFixed(3)},${lon.toFixed(3)}|${dateStr}`;
  if (_cache.has(key)) return _cache.get(key);

  // Open-Meteo: use archive API for past dates, forecast API for today/future
  const today   = new Date().toISOString().split('T')[0];
  const baseUrl = dateStr < today
    ? 'https://archive-api.open-meteo.com/v1/archive'
    : 'https://api.open-meteo.com/v1/forecast';

  const url =
    `${baseUrl}` +
    `?latitude=${lat}&longitude=${lon}` +
    `&daily=temperature_2m_max,wind_speed_10m_max` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph` +
    `&timezone=auto&start_date=${dateStr}&end_date=${dateStr}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const tempF   = data.daily?.temperature_2m_max?.[0]  ?? null;
    const windMph = data.daily?.wind_speed_10m_max?.[0]   ?? null;

    if (tempF == null || windMph == null) return null;

    const result = { tempF, windMph };
    _cache.set(key, result);
    return result;
  } catch (err) {
    console.warn(`  ⚠️  Weather fetch failed for ${dateStr} (${lat},${lon}): ${err.message}`);
    return null;
  }
}

/**
 * Normalise temperature [32, 95]°F → [0, 1]
 * Normalise wind [0, 25] mph → [0, 1] (clamped at 25)
 */
function normaliseWeather(weather) {
  if (!weather) return { tempFeature: 0.5, windFeature: 0.5 };
  const tempFeature = Math.max(0, Math.min(1, (weather.tempF - 32) / (95 - 32)));
  const windFeature = Math.max(0, Math.min(1, weather.windMph / 25));
  return { tempFeature, windFeature };
}

module.exports = { fetchGameWeather, normaliseWeather, DOME_TEAM_IDS };
