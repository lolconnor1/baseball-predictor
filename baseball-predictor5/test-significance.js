'use strict';

/**
 * test-significance.js
 *
 * Runs statistical tests to determine whether the model's accuracy is
 * meaningfully better than chance, the home-team baseline, and random guessing.
 *
 * Tests included:
 *   1. Binomial test vs 50% (is it better than a coin flip?)
 *   2. Binomial test vs home-team baseline (~54%)
 *   3. Binomial test vs market implied probability (is it beating the crowd?)
 *   4. Confidence interval for true accuracy
 *   5. High-confidence subset analysis
 *   6. Streak analysis (are wins/losses clustered or random?)
 *   7. Brier score (how well-calibrated are the probabilities?)
 *   8. ROI simulation (what would flat betting have returned?)
 *
 * Usage: node test-significance.js
 */

const fs   = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, 'data', 'accuracy-log.json');

// ---------------------------------------------------------------------------

function main() {
  if (!fs.existsSync(LOG_PATH)) {
    console.error('❌  No accuracy log found. Run some updates first.');
    process.exit(1);
  }

  const log = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));

  if (log.length < 20) {
    console.log(`⚠️  Only ${log.length} predictions logged — need at least 20 for meaningful tests.`);
    console.log('   Keep running updates and check back later.\n');
  }

  const n       = log.length;
  const correct = log.filter(e => e.correct).length;
  const acc     = correct / n;

  console.log('\n⚾  MODEL SIGNIFICANCE TESTING');
  console.log('═'.repeat(60));
  console.log(`   Sample size : ${n} predictions`);
  console.log(`   Correct     : ${correct}`);
  console.log(`   Accuracy    : ${(acc * 100).toFixed(2)}%`);
  console.log('═'.repeat(60));

  // ── 1. Binomial test vs 50% ────────────────────────────────────────
  section('1. vs COIN FLIP (50%)');
  binomialTest(correct, n, 0.50);

  // ── 2. Binomial test vs home-team baseline ────────────────────────
  section('2. vs HOME TEAM BASELINE (54%)');
  binomialTest(correct, n, 0.54);

  // ── 3. Binomial test vs market (if homeProb data available) ───────
  section('3. vs MARKET IMPLIED PROBABILITY');
  marketTest(log);

  // ── 4. Confidence interval ─────────────────────────────────────────
  section('4. CONFIDENCE INTERVAL FOR TRUE ACCURACY');
  confidenceInterval(correct, n);

  // ── 5. High-confidence subset ──────────────────────────────────────
  section('5. HIGH-CONFIDENCE PICKS (≥60%, ≥65%, ≥70%)');
  confidenceSubsets(log);

  // ── 6. Streak analysis ─────────────────────────────────────────────
  section('6. STREAK ANALYSIS (are results random or clustered?)');
  runsTest(log);

  // ── 7. Brier score ────────────────────────────────────────────────
  section('7. BRIER SCORE (probability calibration)');
  brierScore(log);

  // ── 8. ROI simulation ────────────────────────────────────────────
  section('8. FLAT BET ROI SIMULATION');
  roiSimulation(log);

  // ── 9. Calibration curve ──────────────────────────────────────────
  section('9. CALIBRATION CURVE');
  calibrationCurve(log);

  console.log('\n' + '═'.repeat(60));
  console.log('  INTERPRETATION GUIDE');
  console.log('─'.repeat(60));
  console.log('  p < 0.05  → result is statistically significant (95% confidence)');
  console.log('  p < 0.01  → highly significant (99% confidence)');
  console.log('  p > 0.05  → could be due to chance — need more data');
  console.log('  Brier score: lower is better. Coin flip = 0.25. Perfect = 0.00');
  console.log('  ROI > 0% with -110 vig → model has real betting edge');
  console.log('═'.repeat(60) + '\n');
}

// ---------------------------------------------------------------------------
// 1 & 2: Binomial test
// ---------------------------------------------------------------------------
// Tests H0: true accuracy = baseline
// Uses normal approximation to binomial (valid for n >= 30)

function binomialTest(correct, n, baseline) {
  const acc      = correct / n;
  const se       = Math.sqrt(baseline * (1 - baseline) / n);
  const z        = (acc - baseline) / se;
  const p        = 1 - normalCDF(z);   // one-tailed: is model BETTER?

  console.log(`  Model accuracy : ${(acc * 100).toFixed(2)}%`);
  console.log(`  Baseline       : ${(baseline * 100).toFixed(1)}%`);
  console.log(`  Z-score        : ${z.toFixed(3)}`);
  console.log(`  p-value        : ${p.toFixed(4)} (one-tailed)`);
  console.log(`  Result         : ${interpret(p, acc > baseline)}`);
}

// ---------------------------------------------------------------------------
// 3: Market test
// ---------------------------------------------------------------------------
// Compares model picks to what the market implied probability would pick

function marketTest(log) {
  // Entries with FanDuel data have homeProb from the model
  // We simulate: what if you just always picked the market favourite?
  const withMarket = log.filter(e => e.homeProb != null);

  if (withMarket.length === 0) {
    console.log('  No market probability data in log yet.');
    console.log('  (Market odds are only recorded after FanDuel integration)');
    return;
  }

  // Market pick: whoever has >50% implied prob (using model's homeProb as proxy for now)
  // When fanduel odds are logged, this will use actual market probs
  const n           = withMarket.length;
  const modelRight  = withMarket.filter(e => e.correct).length;
  const marketRight = withMarket.filter(e => {
    const marketPicksHome = e.homeProb >= 0.5;
    return marketPicksHome === e.actualHome;
  }).length;

  console.log(`  Games with probability data : ${n}`);
  console.log(`  Model correct               : ${modelRight} (${(modelRight/n*100).toFixed(1)}%)`);
  console.log(`  Market favourite correct    : ${marketRight} (${(marketRight/n*100).toFixed(1)}%)`);

  if (modelRight > marketRight) {
    const diff = modelRight - marketRight;
    console.log(`  Model beats market by       : ${diff} games (${(diff/n*100).toFixed(1)}pp)`);
    binomialTest(modelRight, n, marketRight / n);
  } else {
    console.log('  ⚠️  Market is outperforming the model on this sample');
  }
}

// ---------------------------------------------------------------------------
// 4: Confidence interval (Wilson score interval — more accurate than normal)
// ---------------------------------------------------------------------------

function confidenceInterval(correct, n, z = 1.96) {
  const p      = correct / n;
  const denom  = 1 + z*z/n;
  const centre = (p + z*z/(2*n)) / denom;
  const margin = (z * Math.sqrt(p*(1-p)/n + z*z/(4*n*n))) / denom;

  const lo = Math.max(0, centre - margin);
  const hi = Math.min(1, centre + margin);

  console.log(`  Observed accuracy : ${(p * 100).toFixed(2)}%`);
  console.log(`  95% CI            : [${(lo*100).toFixed(1)}%, ${(hi*100).toFixed(1)}%]`);
  console.log(`  Interpretation    : We are 95% confident the model's true`);
  console.log(`                      accuracy lies between ${(lo*100).toFixed(1)}% and ${(hi*100).toFixed(1)}%`);

  if (lo > 0.54) {
    console.log(`  ✅  Lower bound exceeds 54% baseline — model has a real edge`);
  } else if (lo > 0.50) {
    console.log(`  🟡  Lower bound exceeds 50% — likely better than random`);
  } else {
    console.log(`  ❌  Lower bound below 50% — need more data to be confident`);
  }
}

// ---------------------------------------------------------------------------
// 5: Confidence subsets
// ---------------------------------------------------------------------------

function confidenceSubsets(log) {
  for (const threshold of [0.60, 0.65, 0.70]) {
    const subset  = log.filter(e => Math.max(e.homeProb, 1 - e.homeProb) >= threshold);
    if (subset.length === 0) {
      console.log(`  ≥${(threshold*100).toFixed(0)}% confidence : no picks yet`);
      continue;
    }
    const correct = subset.filter(e => e.correct).length;
    const acc     = correct / subset.length;
    const se      = Math.sqrt(0.54 * 0.46 / subset.length);
    const z       = (acc - 0.54) / se;
    const p       = 1 - normalCDF(z);
    console.log(`  ≥${(threshold*100).toFixed(0)}% confidence : ${correct}/${subset.length} = ${(acc*100).toFixed(1)}%  p=${p.toFixed(3)}  ${pStar(p)}`);
  }
}

// ---------------------------------------------------------------------------
// 6: Runs test (Wald-Wolfowitz)
// ---------------------------------------------------------------------------
// Tests whether wins and losses are randomly distributed or clustered
// Clustering might indicate the model has streaky performance tied to
// external factors (weather, roster changes, etc.)

function runsTest(log) {
  const sequence = log.map(e => e.correct ? 1 : 0);
  const n1       = sequence.filter(x => x === 1).length;  // correct
  const n2       = sequence.filter(x => x === 0).length;  // incorrect
  const n        = n1 + n2;

  let runs = 1;
  for (let i = 1; i < sequence.length; i++) {
    if (sequence[i] !== sequence[i-1]) runs++;
  }

  // Expected runs and variance under H0 (random sequence)
  const mu  = (2 * n1 * n2) / n + 1;
  const sigma2 = (2 * n1 * n2 * (2 * n1 * n2 - n)) / (n * n * (n - 1));
  const z   = (runs - mu) / Math.sqrt(sigma2);
  const p   = 2 * (1 - normalCDF(Math.abs(z)));  // two-tailed

  console.log(`  Correct / Incorrect : ${n1} / ${n2}`);
  console.log(`  Observed runs       : ${runs}`);
  console.log(`  Expected runs       : ${mu.toFixed(1)}`);
  console.log(`  Z-score             : ${z.toFixed(3)}`);
  console.log(`  p-value             : ${p.toFixed(4)} (two-tailed)`);

  if (p > 0.05) {
    console.log('  Result              : ✅  Results appear randomly distributed (good)');
  } else if (z < 0) {
    console.log('  Result              : ⚠️  Results are MORE clustered than random');
    console.log('                        (long winning/losing streaks — check for bias)');
  } else {
    console.log('  Result              : ⚠️  Results alternate MORE than random');
    console.log('                        (unusual pattern — investigate)');
  }
}

// ---------------------------------------------------------------------------
// 7: Brier score
// ---------------------------------------------------------------------------
// Measures probability calibration — lower is better
// Perfect calibration = 0.00, coin flip = 0.25

function brierScore(log) {
  const scores = log.map(e => {
    const pHome  = e.homeProb;
    const actual = e.actualHome ? 1 : 0;
    return Math.pow(pHome - actual, 2);
  });

  const brier     = scores.reduce((a, b) => a + b, 0) / scores.length;
  const coinFlip  = 0.25;
  const skill     = 1 - (brier / coinFlip);  // Brier skill score

  console.log(`  Brier score       : ${brier.toFixed(4)}`);
  console.log(`  Coin flip baseline: ${coinFlip.toFixed(4)}`);
  console.log(`  Skill score       : ${(skill * 100).toFixed(1)}% improvement over coin flip`);
  console.log(`  Interpretation    : ${
    brier < 0.20 ? '✅  Well calibrated' :
    brier < 0.23 ? '🟡  Reasonably calibrated' :
    '❌  Poorly calibrated — probabilities need adjustment'
  }`);
}

// ---------------------------------------------------------------------------
// 8: ROI simulation
// ---------------------------------------------------------------------------
// Simulates flat betting $100 on every model pick
// Uses -110 vig (standard US sportsbook) and +100 (even money, no vig)

function roiSimulation(log) {
  const bet     = 100;
  let bankroll110 = 0;
  let bankrollEven = 0;

  for (const e of log) {
    if (e.correct) {
      bankroll110  += bet * (100/110);  // win $90.91 at -110 vig
      bankrollEven += bet;              // win $100 at even money
    } else {
      bankroll110  -= bet;
      bankrollEven -= bet;
    }
  }

  const totalBet   = log.length * bet;
  const roi110     = (bankroll110 / totalBet) * 100;
  const roiEven    = (bankrollEven / totalBet) * 100;

  console.log(`  Total wagered     : $${totalBet.toLocaleString()}`);
  console.log(`  P&L at -110 vig   : ${bankroll110 >= 0 ? '+' : ''}$${Math.round(bankroll110).toLocaleString()}`);
  console.log(`  ROI at -110 vig   : ${roi110.toFixed(2)}%`);
  console.log(`  P&L at even money : ${bankrollEven >= 0 ? '+' : ''}$${Math.round(bankrollEven).toLocaleString()}`);
  console.log(`  ROI at even money : ${roiEven.toFixed(2)}%`);
  console.log(`  Interpretation    : ${
    roi110 > 0  ? '✅  Profitable even with vig — strong edge' :
    roiEven > 0 ? '🟡  Profitable without vig — edge exists but needs sharper lines' :
    '❌  Not profitable — model needs improvement or sample is too small'
  }`);
}

// ---------------------------------------------------------------------------
// 9: Calibration curve
// ---------------------------------------------------------------------------
// Groups predictions by confidence band and shows actual win rate per band

function calibrationCurve(log) {
  const bands = [
    { label: '50–55%', lo: 0.50, hi: 0.55 },
    { label: '55–60%', lo: 0.55, hi: 0.60 },
    { label: '60–65%', lo: 0.60, hi: 0.65 },
    { label: '65–70%', lo: 0.65, hi: 0.70 },
    { label: '70%+',   lo: 0.70, hi: 1.00 },
  ];

  console.log('  Band      Predicted   Actual     N     Diff');
  console.log('  ' + '─'.repeat(52));

  for (const band of bands) {
    const subset = log.filter(e => {
      const conf = Math.max(e.homeProb, 1 - e.homeProb);
      return conf >= band.lo && conf < band.hi;
    });
    if (subset.length === 0) {
      console.log(`  ${band.label.padEnd(10)}  —           —          0`);
      continue;
    }
    const correct    = subset.filter(e => e.correct).length;
    const actualRate = correct / subset.length;
    const midpoint   = (band.lo + band.hi) / 2;
    const diff       = actualRate - midpoint;
    const diffStr    = `${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(1)}pp`;
    const bar        = '█'.repeat(Math.round(actualRate * 20));

    console.log(`  ${band.label.padEnd(10)}  ${(midpoint*100).toFixed(0)}%         ${(actualRate*100).toFixed(1)}%      ${String(subset.length).padEnd(5)} ${diffStr}`);
  }

  console.log('\n  A well-calibrated model shows actual rates close to predicted rates.');
  console.log('  If high-confidence picks underperform, the model is overconfident.');
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

// Normal CDF approximation (Abramowitz & Stegun)
function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return z > 0 ? 1 - p : p;
}

function interpret(p, isPositive) {
  if (!isPositive) return '❌  Model is NOT beating this baseline';
  if (p < 0.01)   return `✅  Highly significant (p=${p.toFixed(4)}) ***`;
  if (p < 0.05)   return `✅  Significant (p=${p.toFixed(4)}) **`;
  if (p < 0.10)   return `🟡  Marginal (p=${p.toFixed(4)}) * — need more data`;
  return               `❌  Not significant (p=${p.toFixed(4)}) — could be chance`;
}

function pStar(p) {
  if (p < 0.01) return '***';
  if (p < 0.05) return '**';
  if (p < 0.10) return '*';
  return '';
}

function section(title) {
  console.log(`\n  ${title}`);
  console.log('  ' + '─'.repeat(54));
}

main();
