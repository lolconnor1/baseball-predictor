'use strict';

/**
 * venues.js
 *
 * Static ballpark data keyed by MLB home team ID.
 *
 * runFactor > 1.0  →  hitter-friendly park (more runs expected)
 * runFactor < 1.0  →  pitcher-friendly park (fewer runs expected)
 *
 * Factors are approximate 5-year park averages from Baseball Reference.
 * They are stable enough year-to-year that a static table is fine.
 */

const VENUES = {
  108: { name: 'Angel Stadium',              teamName: 'LA Angels',         runFactor: 0.98, lat: 33.800,  lon: -117.883 },
  109: { name: 'Chase Field',                teamName: 'Arizona',           runFactor: 1.06, lat: 33.446,  lon: -112.067 },
  110: { name: 'Oriole Park',                teamName: 'Baltimore',         runFactor: 1.03, lat: 39.284,  lon: -76.622  },
  111: { name: 'Fenway Park',                teamName: 'Boston',            runFactor: 1.08, lat: 42.347,  lon: -71.097  },
  112: { name: 'Wrigley Field',              teamName: 'Chicago Cubs',      runFactor: 1.05, lat: 41.948,  lon: -87.656  },
  113: { name: 'Great American Ball Park',   teamName: 'Cincinnati',        runFactor: 1.11, lat: 39.098,  lon: -84.507  },
  114: { name: 'Progressive Field',          teamName: 'Cleveland',         runFactor: 0.97, lat: 41.496,  lon: -81.685  },
  115: { name: 'Coors Field',                teamName: 'Colorado',          runFactor: 1.22, lat: 39.756,  lon: -104.994 },
  116: { name: 'Comerica Park',              teamName: 'Detroit',           runFactor: 0.97, lat: 42.339,  lon: -83.049  },
  117: { name: 'Minute Maid Park',           teamName: 'Houston',           runFactor: 1.00, lat: 29.757,  lon: -95.355  },
  118: { name: 'Kauffman Stadium',           teamName: 'Kansas City',       runFactor: 1.01, lat: 39.051,  lon: -94.480  },
  119: { name: 'Dodger Stadium',             teamName: 'LA Dodgers',        runFactor: 0.95, lat: 34.074,  lon: -118.240 },
  120: { name: 'Nationals Park',             teamName: 'Washington',        runFactor: 1.02, lat: 38.873,  lon: -77.008  },
  121: { name: 'Citi Field',                 teamName: 'NY Mets',           runFactor: 0.96, lat: 40.757,  lon: -73.846  },
  133: { name: 'Oakland Coliseum',           teamName: 'Oakland',           runFactor: 0.94, lat: 37.752,  lon: -122.201 },
  134: { name: 'PNC Park',                   teamName: 'Pittsburgh',        runFactor: 0.97, lat: 40.447,  lon: -80.006  },
  135: { name: 'Petco Park',                 teamName: 'San Diego',         runFactor: 0.94, lat: 32.707,  lon: -117.157 },
  136: { name: 'T-Mobile Park',              teamName: 'Seattle',           runFactor: 0.95, lat: 47.591,  lon: -122.332 },
  137: { name: 'Oracle Park',                teamName: 'San Francisco',     runFactor: 0.93, lat: 37.779,  lon: -122.389 },
  138: { name: 'Busch Stadium',              teamName: 'St. Louis',         runFactor: 0.97, lat: 38.623,  lon: -90.193  },
  139: { name: 'Tropicana Field',            teamName: 'Tampa Bay',         runFactor: 0.96, lat: 27.768,  lon: -82.653  },
  140: { name: 'Globe Life Field',           teamName: 'Texas',             runFactor: 1.04, lat: 32.748,  lon: -97.082  },
  141: { name: 'Rogers Centre',              teamName: 'Toronto',           runFactor: 1.05, lat: 43.641,  lon: -79.389  },
  142: { name: 'Target Field',               teamName: 'Minnesota',         runFactor: 0.99, lat: 44.982,  lon: -93.278  },
  143: { name: 'Citizens Bank Park',         teamName: 'Philadelphia',      runFactor: 1.07, lat: 39.906,  lon: -75.166  },
  144: { name: 'Truist Park',                teamName: 'Atlanta',           runFactor: 1.02, lat: 33.891,  lon: -84.468  },
  145: { name: 'Guaranteed Rate Field',      teamName: 'Chicago White Sox', runFactor: 1.04, lat: 41.830,  lon: -87.634  },
  146: { name: 'loanDepot park',             teamName: 'Miami',             runFactor: 0.95, lat: 25.778,  lon: -80.220  },
  147: { name: 'Yankee Stadium',             teamName: 'NY Yankees',        runFactor: 1.04, lat: 40.829,  lon: -73.926  },
  158: { name: 'American Family Field',      teamName: 'Milwaukee',         runFactor: 1.01, lat: 43.029,  lon: -87.971  },
};

/**
 * Returns the run factor for a home team (defaults to 1.0 if unknown).
 * Normalised to [0,1] for use as a neural net feature:
 *   factor 0.90 → 0.25
 *   factor 1.00 → 0.50
 *   factor 1.10 → 0.75
 *   factor 1.22 → ~1.0
 */
function getParkFactor(homeTeamId) {
  const venue = VENUES[homeTeamId];
  const factor = venue ? venue.runFactor : 1.0;
  // Map [0.90, 1.22] → [0, 1]
  return Math.max(0, Math.min(1, (factor - 0.90) / 0.32));
}

/**
 * Returns the raw run factor (useful for display).
 */
function getRawParkFactor(homeTeamId) {
  return VENUES[homeTeamId]?.runFactor ?? 1.0;
}

function getVenueName(homeTeamId) {
  return VENUES[homeTeamId]?.name ?? 'Unknown Ballpark';
}

function getVenueCoords(homeTeamId) {
  const v = VENUES[homeTeamId];
  if (!v || v.lat == null) return null;
  return { lat: v.lat, lon: v.lon };
}

module.exports = { getParkFactor, getRawParkFactor, getVenueName, getVenueCoords, VENUES };
