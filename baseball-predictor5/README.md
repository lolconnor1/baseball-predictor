# ⚾ Baseball Win/Loss Predictor

A Node.js machine learning app that predicts MLB game outcomes using a neural network and the **free MLB Stats API** (no API key required).

## How It Works

```
MLB Stats API  →  Historical Games  →  Rolling Team Stats  →  Neural Net  →  Win Probabilities
```

1. **Data** — Fetches completed regular-season games from `statsapi.mlb.com`
2. **Features** — For each game, computes the following for each team using the **last 30 games** played before that date (no data leakage):
   - Win percentage
   - Average runs scored & allowed
   - Home / away split win %
   - Last-5 game momentum
3. **Model** — A 3-layer neural network (brain.js) trained to predict the **home team win probability**
4. **Predict** — Fetches today's (or any date's) schedule and outputs a confidence-bar prediction for each matchup

## Requirements

- **Node.js 18+** (native `fetch` is required)

## Setup

```bash
git clone <this-repo>
cd baseball-predictor
npm install
```

## Usage

### Step 1 — Train the model

```bash
# Train on 2022, 2023, 2024 seasons (recommended — takes ~5 min first run)
npm run train

# Train on specific seasons
node index.js train --seasons 2023,2024

# Force re-fetch from API (clears the cache)
node index.js train --fresh
```

> Data is cached in `data/games.json` so subsequent runs are instant.  
> The trained model is saved to `data/model.json`.

### Step 2 — Make predictions

```bash
# Predict today's games
npm run predict

# Predict a specific date
node index.js predict --date 2025-04-25

# Show model info
node index.js info
```

### Example Output

```
🤖  Model trained on seasons: 2022, 2023, 2024
    Test accuracy : 57.8%
    Baseline acc  : 54.1% (always pick home team)

🎯  MLB Predictions for 2025-04-25
──────────────────────────────────────────────────────────────────

  New York Yankees  @  Boston Red Sox  [Scheduled]
  Prediction : Boston Red Sox wins
  Confidence : [████████████░░░░░░░░] 62.4%
  Win probs  : home 62.4%  |  away 37.6%
  Home stats : WR 58.3%, RS 4.8, RA 3.9, last-5 60.0%
  Away stats : WR 46.7%, RS 4.1, RA 4.6, last-5 40.0%
```

## What to Expect

- MLB home teams win ~54% of games historically
- A well-tuned model typically achieves **56–60% accuracy** on unseen games
- Vegas sportsbooks are at ~56–57% — so beating that consistently is very hard!

## Improving Accuracy

The current model uses only team-level rolling stats. Accuracy can be improved by adding:

| Feature | Notes |
|---|---|
| Starting pitcher ERA/WHIP | Single biggest predictor |
| Head-to-head records | Current-season matchup history |
| Ballpark factors | Some parks favor hitters/pitchers |
| Weather (temp, wind) | MLB weather APIs or OpenMeteo |
| Lineup quality | Starter vs. bench composition |
| Injury reports | Rotoworld / RotoGrinders |

## Project Structure

```
baseball-predictor/
├── index.js              # CLI entry point (train / predict / info)
├── package.json
├── src/
│   ├── api.js            # MLB Stats API wrapper
│   ├── features.js       # Rolling stats & feature engineering
│   ├── train.js          # Fetch → feature → train → save
│   └── predict.js        # Load model → fetch schedule → predict
└── data/                 # Created automatically
    ├── games.json        # Cached historical game data
    └── model.json        # Trained neural network weights
```

## Notes

- This project is for **educational purposes**
- MLB Stats API terms of service apply — don't hammer the endpoint
- The free API has no SLA; occasionally it's slow or returns empty data
