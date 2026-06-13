#!/usr/bin/env node
'use strict';

const { Command } = require('commander');

const program = new Command();

program
  .name('baseball-predictor')
  .description('⚾  MLB win/loss predictor — neural network + MLB Stats API')
  .version('1.0.0');

// ── train ────────────────────────────────────────────────────────────────────
program
  .command('train')
  .description('Fetch historical game data and train the neural network')
  .option(
    '-s, --seasons <years>',
    'Comma-separated list of seasons to train on',
    '2021,2022,2023,2024,2025,2026',
  )
  .option(
    '--fresh',
    'Ignore cached data and re-fetch everything from the MLB API',
    false,
  )
  .action(async opts => {
    const { train } = require('./src/train');
    const seasons   = opts.seasons.split(',').map(Number);
    console.log(`\n⚾  Baseball Predictor — Training`);
    console.log(`   Seasons : ${seasons.join(', ')}\n`);
    await train({ seasons, fresh: opts.fresh });
  });

// ── predict ──────────────────────────────────────────────────────────────────
program
  .command('predict')
  .description('Predict outcomes for games on a given date')
  .option(
    '-d, --date <YYYY-MM-DD>',
    'Date to predict games for (defaults to today)',
    new Date().toISOString().split('T')[0],
  )
  .action(async opts => {
    const { predict } = require('./src/predict');
    await predict({ date: opts.date });
  });

// ── update ───────────────────────────────────────────────────────────────────
program
  .command('update')
  .description('Fetch games since last update and do a quick top-up training run')
  .action(async () => {
    const { update } = require('./src/update');
    await update();
  });

// ── info ─────────────────────────────────────────────────────────────────────
program
  .command('info')
  .description('Show information about the currently trained model')
  .action(() => {
    const fs   = require('fs');
    const path = require('path');
    const modelPath = path.join(__dirname, 'data', 'model.json');

    if (!fs.existsSync(modelPath)) {
      console.log('\n❌  No trained model found. Run `node index.js train` first.\n');
      return;
    }

    const payload = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    console.log('\n🤖  Trained Model Info');
    console.log('─'.repeat(40));
    console.log(`  Seasons     : ${payload.trainedOn.join(', ')}`);
    console.log(`  Trained at  : ${new Date(payload.trainedAt).toLocaleString()}`);
    if (payload.lastUpdated) {
      console.log(`  Last update : ${payload.lastUpdated} (+${payload.updatedWith} games)`);
    }
    console.log(`  Total games : ${(payload.totalGames ?? payload.trainSize).toLocaleString()}`);
    console.log(`  Train size  : ${payload.trainSize.toLocaleString()} examples`);
    console.log(`  Test acc    : ${(payload.testAccuracy * 100).toFixed(1)}%`);
    console.log(`  Baseline    : ${(payload.baselineAcc  * 100).toFixed(1)}% (always pick home)\n`);
  });

program.parse();
