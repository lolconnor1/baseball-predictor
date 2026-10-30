# ⚾ Baseball Oracle

**A machine learning model that predicts the winner of every MLB game, retrained and published automatically every day.**

**Live site:** https://lolconnor1.github.io/baseball-predictor/

Each morning a scheduled GitHub Actions job pulls the latest results from the MLB Stats API, rebuilds 59 features for every game using only information available before first pitch, retrains the model, scores today's games, and redeploys a static site. There's no server: the pipeline writes JSON, and GitHub Pages serves it.

## Results

Out-of-sample, walk-forward validated (each season predicted by a model trained only on earlier seasons), 2022–2026:

| | |
|---|---|
| Accuracy | **56.6%** over 12,138 games (95% CI 55.7–57.4%) |
| vs. always picking the home team | **+3.6 pts** (95% CI +2.6 to +4.7) |
| vs. picking the team with the better recent record | **+2.8 pts** (95% CI +1.8 to +3.8) |
| Log loss | **0.6792** (base rate 0.6914, coin flip 0.6931) |
| Picks made at 65%+ confidence | right **69%** of the time |

| Season | Model | Always home |
|---|---|---|
| 2022 | 59.3% | 53.3% |
| 2023 | 55.6% | 52.1% |
| 2024 | 56.8% | 52.1% |
| 2025 | 56.0% | 54.4% |
| 2026 | 55.2% | 52.8% |

Single MLB games are close to coin flips: home teams win about 53% of the time, and even betting markets only reach the high 50s. The model's edge is real but modest: in 2025, a strong year for home teams, it beat the home-team baseline by under two points. The site reports all of this as-is.

## What moved the needle

Every change is judged on the same 12,138 out-of-sample games, by log loss first: a single season's accuracy is too noisy (±1 pt) to show a real 0.5-pt gain.

| Change | Accuracy | Log loss |
|---|---|---|
| Leak-free features, random forest | 55.4% | 0.6825 |
| Regularized logistic regression on home-minus-away differences | 56.5% | 0.6805 |
| Marcel-style starting pitcher projections (replacing season-to-date FIP, WHIP, K/9, BB/9, HR/9 and last-3-start ERA) | 56.6% | 0.6792 |

Tried and dropped, because they didn't beat noise: training on each game twice with home and away swapped, blending the logistic model with a tuned forest, and XGBoost.

## The data leak

An earlier version of this model scored **60.5%** on its test season. Beating the betting market by that much is a red flag, not a result.

The cause was leakage. Starting pitcher FIP/WHIP/K9, team batting splits vs. left- and right-handed pitching, and bullpen ERA were all fetched as **season totals**, then attached to every game of that season. A game in April already "knew" how a pitcher would finish in September. A cache bug made it worse: the "recent form" feature was silently falling back to those same season totals.

The fix was to rebuild every stat **point-in-time**. Per-game logs for every starter and every team are aggregated using only games played before the target date, then shrunk toward the previous season's line (itself shrunk toward league average) so early-season numbers are stable. Accuracy fell to 55.3%, in line with the 56.8% the old model had actually managed on live games. Training and live prediction now share a single feature builder, so they can't drift apart again.

## How it works

```
MLB Stats API ──┐
Open-Meteo ─────┤──▶ point-in-time features ──▶ walk-forward CV ──▶ Platt calibration ──▶ predict today
                │    (59 per game)               LR vs RF vs XGBoost  (on out-of-sample      lock pre-game
                │                                pick by log loss      predictions)          predictions
                │                                                                                 │
GitHub Actions (3×/day) ─── commit data/ back to the repo ◀──────────────────────────────────────┤
                                                                                                   ▼
                                                                         static JSON ──▶ GitHub Pages site
```

- **Features** ([`src/features.js`](baseball-predictor5/src/features.js), [`src/pointInTime.js`](baseball-predictor5/src/pointInTime.js)): a Marcel-style projection of each starting pitcher (K%, BB%, HR%, FIP, ERA and WHIP from this season plus the previous three, weighted toward recent seasons and regressed toward league average by how noisy each rate is), the starter's expected innings and MLB experience, lineup OPS against the starter's handedness, bullpen ERA and 3-day workload, exponentially weighted team form over the last 30 games, Pythagorean record, head-to-head, rest and travel, park factor, weather, and plate-umpire run environment.
- **Model** ([`scripts/train_model.py`](baseball-predictor5/scripts/train_model.py)): three candidates are evaluated walk-forward and the lowest out-of-sample log loss wins: a heavily regularized (L2) logistic regression on home-minus-away differences, a random forest and XGBoost. The logistic regression wins. A random forest used to be the model; switching to the logistic regression was worth about a point of accuracy (55.4% → 56.5%) and 0.002 of log loss. A single game is mostly noise, so the simplest model generalizes best. XGBoost overfits badly.
- **Inference** ([`src/rfPredict.js`](baseball-predictor5/src/rfPredict.js)): pure JS, with exact per-game explanations: each input's weight × its distance from the average game. The contributions sum exactly to the prediction and are grouped on the site into plain-language factors like "Starting pitching → Dodgers +8.0 pts". (The random-forest path, kept for when a forest wins, uses tree-path attribution.)
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
  scripts/train_model.py      logistic vs RF vs XGBoost, walk-forward CV, Platt calibration
  public/                     the static site (HTML, CSS, dependency-free SVG charts)
  data/                       cached pipeline state, committed by the daily job
```

Not affiliated with MLB. Built for learning; data from the MLB Stats API and Open-Meteo.
