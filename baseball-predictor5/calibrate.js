'use strict';

/**
 * calibrate.js
 *
 * Fits a Platt scaling calibration to the accuracy log and saves
 * calibration parameters to data/calibration.json.
 *
 * Platt scaling fits a logistic regression:
 *   calibrated = sigmoid(a * rawProb + b)
 *
 * where a and b are fitted to minimise log-loss on the accuracy log.
 * After running this, server.js applies the calibration to all predictions.
 *
 * Usage: node calibrate.js
 */

const fs   = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, 'data', 'accuracy-log.json');
const CAL_PATH = path.join(__dirname, 'data', 'calibration.json');

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (!fs.existsSync(LOG_PATH)) {
    console.error('❌  No accuracy log found. Run updates first.');
    process.exit(1);
  }

  const log = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
  console.log(`\n⚾  PLATT SCALING CALIBRATION`);
  console.log(`   Using ${log.length} logged predictions\n`);

  if (log.length < 30) {
    console.error('❌  Need at least 30 predictions to fit calibration.');
    process.exit(1);
  }

  // Build training data: X = raw homeProb, Y = actual outcome (1 = home won)
  const X = log.map(e => e.homeProb);
  const Y = log.map(e => e.actualHome ? 1 : 0);

  // Fit Platt scaling via gradient descent on log-loss
  const { a, b, history } = fitPlattScaling(X, Y);

  console.log(`   Fitted parameters:`);
  console.log(`   a = ${a.toFixed(6)}  (slope — <1 means model is overconfident)`);
  console.log(`   b = ${b.toFixed(6)}  (intercept bias)`);

  // Show before/after calibration curve
  console.log('\n   CALIBRATION COMPARISON (raw vs calibrated):\n');
  console.log('   Band        Raw centre   Actual %   Calibrated   Improvement');
  console.log('   ' + '─'.repeat(62));

  const bands = [
    { label: '50–55%', lo: 0.50, hi: 0.55 },
    { label: '55–60%', lo: 0.55, hi: 0.60 },
    { label: '60–65%', lo: 0.60, hi: 0.65 },
    { label: '65–70%', lo: 0.65, hi: 0.70 },
    { label: '70%+',   lo: 0.70, hi: 1.00 },
  ];

  for (const band of bands) {
    const subset = log.filter(e => {
      const conf = Math.max(e.homeProb, 1 - e.homeProb);
      return conf >= band.lo && conf < band.hi;
    });
    if (subset.length < 3) continue;

    const correct    = subset.filter(e => e.correct).length;
    const actualRate = correct / subset.length;
    const midRaw     = (band.lo + band.hi) / 2;
    const midCal     = sigmoid(a * midRaw + b);
    const rawErr     = Math.abs(midRaw - actualRate);
    const calErr     = Math.abs(midCal - actualRate);
    const improved   = calErr < rawErr ? '✅' : '⚠️';

    console.log(
      `   ${band.label.padEnd(12)}` +
      `${(midRaw*100).toFixed(0)}%         ` +
      `${(actualRate*100).toFixed(1)}%      ` +
      `${(midCal*100).toFixed(1)}%         ` +
      `${improved}  ${(rawErr*100).toFixed(1)}pp → ${(calErr*100).toFixed(1)}pp`
    );
  }

  // Compute before/after Brier scores
  const brierRaw = brierScore(X, Y, 1, 0);
  const brierCal = brierScore(X, Y, a, b);
  console.log(`\n   Brier score (raw)        : ${brierRaw.toFixed(4)}`);
  console.log(`   Brier score (calibrated) : ${brierCal.toFixed(4)}`);
  console.log(`   Improvement              : ${((brierRaw - brierCal) / brierRaw * 100).toFixed(1)}%`);

  // Save calibration
  const payload = {
    a, b,
    fittedOn:   log.length,
    fittedAt:   new Date().toISOString(),
    brierRaw,
    brierCal,
  };

  fs.writeFileSync(CAL_PATH, JSON.stringify(payload, null, 2));
  console.log(`\n✅  Calibration saved to data/calibration.json`);
  console.log(`   Restart the server to apply calibration to predictions.\n`);
}

// ---------------------------------------------------------------------------
// Platt scaling via gradient descent (minimise log-loss)
// ---------------------------------------------------------------------------

function fitPlattScaling(X, Y, {
  lr          = 0.01,
  iterations  = 10000,
  l2          = 0.001,   // L2 regularisation to prevent overfitting
} = {}) {
  let a = 1.0;   // start near identity
  let b = 0.0;
  const n = X.length;
  const history = [];

  for (let iter = 0; iter < iterations; iter++) {
    let gradA = 0;
    let gradB = 0;
    let loss  = 0;

    for (let i = 0; i < n; i++) {
      const p   = sigmoid(a * X[i] + b);
      const err = p - Y[i];
      gradA += err * X[i];
      gradB += err;
      // Log-loss
      loss += -(Y[i] * Math.log(p + 1e-15) + (1 - Y[i]) * Math.log(1 - p + 1e-15));
    }

    // Average gradient + L2 regularisation
    gradA = gradA / n + l2 * a;
    gradB = gradB / n;
    loss  = loss / n;

    a -= lr * gradA;
    b -= lr * gradB;

    // Adaptive learning rate — slow down as we converge
    if (iter % 1000 === 0) {
      history.push({ iter, loss, a, b });
      if (iter > 0 && Math.abs(history[history.length-1].loss - history[history.length-2].loss) < 1e-7) break;
    }
  }

  return { a, b, history };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function brierScore(X, Y, a, b) {
  const n = X.length;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const p = sigmoid(a * X[i] + b);
    sum += Math.pow(p - Y[i], 2);
  }
  return sum / n;
}

main();
