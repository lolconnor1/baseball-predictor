"""
Train a Random Forest and XGBoost on pre-built feature vectors, keep the better one.

Usage:
  python train_model.py <input.json> <output.json>

Input JSON:
  { "X": [[float,...],...], "y": [0|1,...], "dates": ["YYYY-MM-DD",...] }

Validation is walk-forward by season: each season is predicted by a model
trained only on earlier seasons. Those out-of-fold (OOF) predictions are used
to (a) pick RF vs XGBoost by log loss and (b) fit the Platt calibration, so
the calibration never sees probabilities from a model that trained on the
same games. The final model is then retrained on everything.

Output JSON:
  {
    "type":              "xgboost" | "sklearn-rf",
    "trees":             [...],        # array of exported trees
    "baseScore":         float,        # XGBoost only — log-odds bias term
    "nClasses":          2,
    "testAccuracy":      float,        # last season, walk-forward
    "testLogLoss":       float,
    "baselineAcc":       float,        # last season home win rate
    "featureImportances": [float,...],
    "walkForwardCV":     {year: {accuracy, baseline, logLoss, brier, n},...},
    "calibration":       {"a": float, "b": float}
  }
"""

import sys
import os
import json
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
import xgboost as xgb


# ---------------------------------------------------------------------------
# sklearn RF export  (value = normalised class probabilities at each node)
# ---------------------------------------------------------------------------

def export_rf_tree(estimator):
    t = estimator.tree_
    vals = t.value[:, 0, :]
    row_sums = vals.sum(axis=1, keepdims=True)
    probs = np.where(row_sums > 0, vals / row_sums, 0.0)
    return {
        "type":          "rf",
        "feature":       t.feature.tolist(),
        "threshold":     t.threshold.tolist(),
        "childrenLeft":  t.children_left.tolist(),
        "childrenRight": t.children_right.tolist(),
        "value":         probs.tolist(),
    }


# ---------------------------------------------------------------------------
# XGBoost export  (leaf values are log-odds contributions)
# ---------------------------------------------------------------------------

def export_xgb_tree(tree_json_str):
    """Convert one XGBoost tree (JSON string) to parallel arrays for JS traversal."""
    root = json.loads(tree_json_str)

    feature, threshold, left, right, leaf_value = [], [], [], [], []

    def visit(node):
        idx = len(feature)
        feature.append(-2)
        threshold.append(-2.0)
        left.append(-1)
        right.append(-1)
        leaf_value.append(0.0)

        if "leaf" in node:
            leaf_value[idx] = float(node["leaf"])
        else:
            feature[idx] = int(node["split"][1:])         # "f5" -> 5
            threshold[idx] = float(node["split_condition"])
            by_id = {c["nodeid"]: c for c in node["children"]}
            left[idx] = len(feature)
            visit(by_id[node["yes"]])
            right[idx] = len(feature)
            visit(by_id[node["no"]])

    visit(root)
    return {
        "type":          "xgb",
        "feature":       feature,
        "threshold":     threshold,
        "childrenLeft":  left,
        "childrenRight": right,
        "leafValue":     leaf_value,
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

N_TREES   = int(os.environ.get("N_TREES",   "200"))
MAX_DEPTH = int(os.environ.get("MAX_DEPTH", "12"))
N_JOBS    = int(os.environ.get("N_JOBS",    "-1"))
SKIP_XGB  = os.environ.get("SKIP_XGB", "").lower() in ("1", "true", "yes")
SKIP_CV   = os.environ.get("SKIP_CV",  "").lower() in ("1", "true", "yes")

def make_rf():
    return RandomForestClassifier(
        n_estimators=N_TREES, max_depth=MAX_DEPTH, min_samples_leaf=15,
        random_state=42, n_jobs=N_JOBS,
    )

def make_xgb():
    return xgb.XGBClassifier(
        n_estimators=min(N_TREES * 2, 400), max_depth=6, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8,
        min_child_weight=15, gamma=1,
        objective="binary:logistic", eval_metric="logloss",
        base_score=0.5, random_state=42, n_jobs=N_JOBS,
        verbosity=0,
    )

def log_loss(p, y):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))

def brier(p, y):
    return float(np.mean((p - y) ** 2))

def fit_platt(p, y):
    cal = LogisticRegression(C=1e10, solver="lbfgs")
    cal.fit(p.reshape(-1, 1), y)
    return float(cal.coef_[0][0]), float(cal.intercept_[0])

def apply_platt(p, a, b):
    return 1.0 / (1.0 + np.exp(-(a * p + b)))


# ---------------------------------------------------------------------------
# Walk-forward CV (train only on seasons before the test season)
# ---------------------------------------------------------------------------

def walk_forward(X, y, years, test_years, make_clf_fn):
    """Returns (oof_probs, oof_mask, per-year stats) for the given model type."""
    oof  = np.full(len(y), np.nan)
    mask = np.zeros(len(y), dtype=bool)
    stats = {}
    for yr in test_years:
        test_mask  = years == yr
        train_mask = years < yr
        if test_mask.sum() < 20 or train_mask.sum() < 100:
            continue
        clf = make_clf_fn()
        clf.fit(X[train_mask], y[train_mask])
        p = clf.predict_proba(X[test_mask])[:, 1]
        oof[test_mask]  = p
        mask[test_mask] = True
        yt = y[test_mask]
        stats[str(yr)] = {
            "accuracy": float(((p >= 0.5).astype(int) == yt).mean()),
            "baseline": float(yt.mean()),
            "logLoss":  log_loss(p, yt),
            "brier":    brier(p, yt),
            "n":        int(test_mask.sum()),
        }
    return oof, mask, stats


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) < 3:
        print("Usage: train_model.py <input.json> <output.json>", file=sys.stderr)
        sys.exit(1)

    with open(sys.argv[1], encoding="utf-8") as f:
        data = json.load(f)

    X     = np.array(data["X"], dtype=np.float64)
    y     = np.array(data["y"], dtype=np.int32)
    years = np.array([int(d[:4]) for d in data["dates"]])

    all_years  = sorted(set(years.tolist()))
    last_year  = all_years[-1]
    # SKIP_CV keeps memory/time down on small hosts: only the last season is
    # held out, which is still a strict train-on-the-past split.
    test_years = [last_year] if SKIP_CV else all_years[1:]

    print(f"   Examples: {len(y)}  Seasons: {all_years[0]}–{last_year}", flush=True)
    print(f"   Config: {N_TREES} trees, depth {MAX_DEPTH}, skip_xgb={SKIP_XGB}, skip_cv={SKIP_CV}", flush=True)
    print(f"   Walk-forward test seasons: {', '.join(map(str, test_years))}", flush=True)

    candidates = [("RandomForest", make_rf)]
    if not SKIP_XGB:
        candidates.append(("XGBoost", make_xgb))

    results = {}
    for name, make in candidates:
        print(f"   Walk-forward: {name}...", flush=True)
        oof, mask, stats = walk_forward(X, y, years, test_years, make)
        a, b   = fit_platt(oof[mask], y[mask])
        cal_ll = log_loss(apply_platt(oof[mask], a, b), y[mask])
        raw_ll = log_loss(oof[mask], y[mask])
        acc    = float(((oof[mask] >= 0.5).astype(int) == y[mask]).mean())
        results[name] = {"stats": stats, "cal": (a, b), "calLL": cal_ll, "make": make,
                         "oof": oof, "oofMask": mask}
        print(f"     OOF accuracy {acc*100:.1f}%  log loss raw {raw_ll:.4f}  calibrated {cal_ll:.4f}  (n={int(mask.sum())})", flush=True)
        for yr, s in stats.items():
            print(f"       {yr}: {s['accuracy']*100:.1f}%  ({s['baseline']*100:.1f}% home)  ll {s['logLoss']:.4f}  n={s['n']}", flush=True)

    winner_name = min(results, key=lambda k: results[k]["calLL"])
    winner      = results[winner_name]
    cal_a, cal_b = winner["cal"]
    last_stats  = winner["stats"][str(last_year)]
    print(f"   Winner: {winner_name}  (calibrated OOF log loss {winner['calLL']:.4f}; coin flip = 0.6931)", flush=True)
    print(f"   Calibration: a={cal_a:.3f}, b={cal_b:.3f}\n", flush=True)

    # -- Retrain winner on full dataset ----------------------------------------
    print(f"   Retraining {winner_name} on full dataset ({len(y)} examples)...", flush=True)
    final = winner["make"]()
    final.fit(X, y)

    common = {
        "nClasses":           2,
        "testAccuracy":       last_stats["accuracy"],
        "testLogLoss":        last_stats["logLoss"],
        "baselineAcc":        last_stats["baseline"],
        "oofLogLoss":         winner["calLL"],
        "featureImportances": final.feature_importances_.tolist(),
        "walkForwardCV":      winner["stats"],
        "calibration":        {"a": cal_a, "b": cal_b},
        # Raw out-of-fold probability per input row (null where the row was
        # never in a test season). Used for the website's backtest analytics.
        "oof": [round(float(p), 5) if m else None for p, m in zip(winner["oof"], winner["oofMask"])],
    }
    if winner_name == "XGBoost":
        raw_dump = final.get_booster().get_dump(dump_format="json")
        result = {
            "type":      "xgboost",
            "baseScore": 0.0,   # log-odds bias; 0.0 = base_score 0.5
            "trees":     [export_xgb_tree(t) for t in raw_dump],
            **common,
        }
    else:
        result = {
            "type":  "sklearn-rf",
            "trees": [export_rf_tree(est) for est in final.estimators_],
            **common,
        }

    print("   Final model trained\n", flush=True)

    with open(sys.argv[2], "w", encoding="utf-8") as f:
        json.dump(result, f)

    print("   Model saved", flush=True)


if __name__ == "__main__":
    main()
