#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');
const { Command } = require('commander');

const MODEL_PATH = path.join(__dirname, 'data', 'model.json');
const GAMES_PATH = path.join(__dirname, 'data', 'games.json');
const FIRST_SEASON = 2021;

// 2021 through the latest season present in the game cache
function defaultSeasons() {
  let last = 2026;
  if (fs.existsSync(GAMES_PATH)) {
    const games = JSON.parse(fs.readFileSync(GAMES_PATH, 'utf8'));
    last = Math.max(last, ...games.map(g => Number(g.date.slice(0, 4))));
  }
  const seasons = [];
  for (let s = FIRST_SEASON; s <= last; s++) seasons.push(s);
  return seasons;
}

const program = new Command();

program
  .name('baseball-predictor')
  .description('⚾  MLB game outcome predictor — point-in-time features, walk-forward validated and calibrated')
  .version('3.0.0');

// ── train ────────────────────────────────────────────────────────────────────
program
  .command('train')
  .description('Fetch historical data and train the model (walk-forward validated)')
  .option('-s, --seasons <years>', 'Comma-separated seasons to train on (default: 2021 → latest)')
  .option('--fresh', 'Ignore cached data and re-fetch everything from the MLB API', false)
  .action(async opts => {
    const { train } = require('./src/train');
    const seasons   = opts.seasons ? opts.seasons.split(',').map(Number) : defaultSeasons();
    console.log(`\n⚾  Baseball Predictor — Training`);
    console.log(`   Seasons : ${seasons.join(', ')}\n`);
    await train({ seasons, fresh: opts.fresh });
  });

// ── predict ──────────────────────────────────────────────────────────────────
program
  .command('predict')
  .description('Predict outcomes for games on a given date')
  .option('-d, --date <YYYY-MM-DD>', 'Date to predict games for (defaults to today, US Eastern)')
  .action(async opts => {
    const { predict } = require('./src/predict');
    await predict({ date: opts.date });
  });

// ── update ───────────────────────────────────────────────────────────────────
program
  .command('update')
  .description('Grade newly completed games, add them to the dataset and retrain')
  .action(async () => {
    const { update } = require('./src/update');
    await update();
  });

// ── daily ────────────────────────────────────────────────────────────────────
program
  .command('daily')
  .description('Full pipeline run: grade + retrain, predict today, publish the website data')
  .action(async () => {
    const { train }   = require('./src/train');
    const { update }  = require('./src/update');
    const { runPredict, localToday } = require('./src/predict');
    const { publish } = require('./src/publish');

    const date = localToday();
    console.log(`\n⚾  Daily pipeline — ${date}\n`);
    if (!fs.existsSync(MODEL_PATH)) await train({ seasons: defaultSeasons() });
    await update();
    const predictions = await runPredict(date);
    await publish({ date, predictions });
  });

// ── publish ──────────────────────────────────────────────────────────────────
program
  .command('publish')
  .description('Write the website data files (public/data/) for a date')
  .option('-d, --date <YYYY-MM-DD>', 'Date to publish (defaults to today, US Eastern)')
  .option('--no-predict', 'Skip predicting the date (model card and record only)')
  .action(async opts => {
    const { runPredict, localToday } = require('./src/predict');
    const { publish } = require('./src/publish');
    const date = opts.date ?? localToday();
    const predictions = opts.predict ? await runPredict(date) : [];
    await publish({ date, predictions });
  });

// ── info ─────────────────────────────────────────────────────────────────────
program
  .command('info')
  .description('Show information about the currently trained model')
  .action(() => {
    if (!fs.existsSync(MODEL_PATH)) {
      console.log('\n❌  No trained model found. Run `node index.js train` first.\n');
      return;
    }

    const payload = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
    console.log('\n🤖  Trained Model Info');
    console.log('─'.repeat(40));
    console.log(`  Model       : ${payload.modelType} (${payload.featureCount} features)`);
    console.log(`  Seasons     : ${payload.trainedOn.join(', ')}`);
    console.log(`  Trained at  : ${new Date(payload.trainedAt).toLocaleString()}`);
    if (payload.lastUpdated) console.log(`  Last update : ${payload.lastUpdated}`);
    console.log(`  Total games : ${(payload.totalGames ?? payload.trainSize).toLocaleString()}`);
    console.log(`  ${payload.testSeason} acc    : ${(payload.testAccuracy * 100).toFixed(1)}%  (walk-forward, log loss ${payload.testLogLoss?.toFixed(4)})`);
    console.log(`  Baseline    : ${(payload.baselineAcc  * 100).toFixed(1)}% (always pick home)\n`);
  });

program.parseAsync().catch(err => {
  console.error(`\n❌  ${err.message}`);
  process.exitCode = 1;
});
