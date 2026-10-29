# ⚾ Baseball Oracle

**A machine learning model that predicts the winner of every MLB game, retrained and published automatically every day.**

**Live site:** https://lolconnor1.github.io/baseball-predictor/

Each morning a scheduled GitHub Actions job pulls the latest results from the MLB Stats API, rebuilds 53 features for every game using only information available before first pitch, retrains a random forest, scores today's games, and redeploys a static site. There's no server: the pipeline writes JSON, and GitHub Pages serves it.

## Results

Out-of-sample, walk-forward validated (each season predicted by a model trained only on earlier seasons), 2022–2026:

| | |
|---|---|
| Accuracy | **55.5%** over 12,138 games (95% CI 54.6–56.4%) |
| vs. always picking the home team | **+2.5 pts** (95% CI +1.5 to +3.6) |
| vs. picking the team with the better recent record | **+1.7 pts** (95% CI +0.7 to +2.7) |
| Log loss | **0.6825** (base rate 0.6914, coin flip 0.6931) |
| Picks made at 65%+ confidence | right **70%** of the time |

| Season | Model | Always home |
|---|---|---|
| 2022 | 57.3% | 53.3% |
| 2023 | 54.9% | 52.1% |
| 2024 | 55.6% | 52.1% |
| 2025 | 54.2% | 54.4% |
| 2026 | 55.3% | 52.8% |

Single MLB games are close to coin flips: home teams win about 53% of the time, and even betting markets only reach the high 50s. The model's edge is real but modest, and in 2025 it didn't beat the home-team baseline at all. The site reports all of this as-is.

## The data leak

An earlier version of this model scored **60.5%** on its test season. Beating the betting market by that much is a red flag, not a result.

The cause was leakage. Starting pitcher FIP/WHIP/K9, team batting splits vs. left- and right-handed pitching, and bullpen ERA were all fetched as **season totals**, then attached to every game of that season. A game in April already "knew" how a pitcher would finish in September. A cache bug made it worse: the "recent form" feature was silently falling back to those same season totals.

The fix was to rebuild every stat **point-in-time**. Per-game logs for every starter and every team are aggregated using only games played before the target date, then shrunk toward the previous season's line (itself shrunk toward league average) so early-season numbers are stable. Accuracy fell to 55.3%, in line with the 56.8% the old model had actually managed on live games. Training and live prediction now share a single feature builder, so they can't drift apart again.

## How it works

```
MLB Stats API ──┐
Open-Meteo ─────┤──▶ point-in-time features ──▶ walk-forward CV ──▶ Platt calibration ──▶ predict today
                │    (53 per game)               RF vs XGBoost        (on out-of-sample      lock pre-game
                │                                pick by log loss      predictions)          predictions
                │                                                                                 │
GitHub Actions (3×/day) ─── commit data/ back to the repo ◀──────────────────────────────────────┤
                                                                                                   ▼
                                                                         static JSON ──▶ GitHub Pages site
```

- **Features** ([`src/features.js`](baseball-predictor5/src/features.js), [`src/pointInTime.js`](baseball-predictor5/src/pointInTime.js)): starting pitcher quality (FIP, WHIP, K/9, BB/9, HR/9) and last-3-start form, lineup OPS against the starter's handedness, bullpen ERA and 3-day workload, exponentially weighted team form over the last 30 games, Pythagorean record, head-to-head, rest and travel, park factor, weather, and plate-umpire run environment.
- **Model** ([`scripts/train_model.py`](baseball-predictor5/scripts/train_model.py)): scikit-learn random forest and XGBoost are both evaluated walk-forward; the lower out-of-sample log loss wins. The random forest has won every time so far; XGBoost overfits this noisy target. The winner is retrained on all data and exported as JSON trees.
- **Inference** ([`src/rfPredict.js`](baseball-predictor5/src/rfPredict.js)): pure-JS tree traversal, plus per-game explanations via tree-path attribution. Each feature's contribution sums exactly to the prediction, grouped on the site into plain-language factors like "Starting pitching → Dodgers +8.0 pts".
- **Calibration**: Platt scaling fit on the walk-forward out-of-sample predictions, never on games the model trained on.
- **Honest tracking**: live predictions are recorded before first pitch and graded afterwards; games without a pre-game prediction are excluded from the live record.

## Running it locally

Requires Node.js 20+ and Python 3.10+.

```bash
cd baseball-predictor5
npm install
pip install -r requirements.txt

node index.js train            # walk-forward train on 2021 → latest season (~1 min with cached data)
node index.js predict          # today's predictions in the terminal
node index.js daily            # the full pipeline the scheduled job runs
node index.js publish          # write the site data to public/data/
npm run preview                # serve the site at http://localhost:8080
```

## Repository layout

```
.github/workflows/daily.yml   scheduled pipeline + Pages deploy
baseball-predictor5/
  index.js                    CLI: train, update, predict, daily, publish, info
  src/
    api.js                    MLB Stats API: games, box scores, season pitcher stats
    pointInTime.js            leak-free pitcher / bullpen / split stats from game logs
    features.js               the single per-game feature builder
    train.js, update.js       training, daily grading + retraining
    predict.js, rfPredict.js  inference, calibration, explanations
    publish.js                metrics (Wilson CIs, paired lift CIs, calibration bins) → site JSON
  scripts/train_model.py      RF vs XGBoost, walk-forward CV, Platt calibration
  public/                     the static site (HTML, CSS, dependency-free SVG charts)
  data/                       cached pipeline state, committed by the daily job
```

Not affiliated with MLB. Built for learning; data from the MLB Stats API and Open-Meteo.
