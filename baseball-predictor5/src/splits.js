'use strict';

// Team batting splits vs LHP/RHP are computed point-in-time in pointInTime.js;
// this module only holds the shared normalisation.

// ---------------------------------------------------------------------------
// Normalise OPS [0.550, 0.900] → [0, 1]
// ---------------------------------------------------------------------------

function normaliseOPS(ops) {
  if (ops == null || isNaN(ops)) return 0.5;
  return Math.max(0, Math.min(1, (ops - 0.550) / (0.900 - 0.550)));
}

module.exports = { normaliseOPS };
