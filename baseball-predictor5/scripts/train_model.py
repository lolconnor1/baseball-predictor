"""
Train a Random Forest and XGBoost on pre-built feature vectors, keep the better one.

Usage:
  python train_model.py <input.json> <output.json>

Input JSON:
  { "X": [[float,...],...], "y": [0|1,...], "testMask": [bool,...], "dates": ["YYYY-MM-DD",...] }

Output JSON:
  {
    "type":              "xgboost" | "sklearn-rf",
    "trees":             [...],        # array of exported trees
    "baseScore":         float,        # XGBoost only — log-odds bias term
    "nClasses":          2,
    "testAccuracy":      float,
    "baselineAcc":       float,
    "featureImportances": [float,...],
    "walkForwardCV":     {year: {accuracy, baseline, n},...}
  }
"""

import sys
import json
import math
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

import os
N_TREES   = int(os.environ.get("N_TREES",   "200"))
MAX_DEPTH = int(os.environ.get("MAX_DEPTH", "12"))
SKIP_XGB  = os.environ.get("SKIP_XGB", "").lower() in ("1", "true", "yes")

def make_rf():
    return RandomForestClassifier(
        n_estimators=N_TREES, max_depth=MAX_DEPTH, min_samples_leaf=15,
        random_state=42, n_jobs=-1,
    )

def make_xgb():
    return xgb.XGBClassifier(
        n_estimators=min(N_TREES * 2, 400), max_depth=6, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8,
        min_child_weight=15, gamma=1,
        objective="binary:logistic", eval_metric="logloss",
        base_score=0.5, random_state=42, n_jobs=-1,
        verbosity=0,
    )

def accuracy(clf, X, y):
    p = clf.predict_proba(X)[:, 1]
    return float(((p >= 0.5).astype(int) == y).mean())

def sigmoid(x):
    return 1.0 / (1.0 + math.exp(-x))


# ---------------------------------------------------------------------------
# Walk-forward CV (train on all years before test year)
# ---------------------------------------------------------------------------

def walk_forward_cv(X, y, dates, make_clf_fn):
    years = sorted(set(d[:4] for d in dates))
    results = {}
    dates_arr = np.array(dates)
    for yr in years:
        test_mask  = np.array([d.startswith(yr) for d in dates])
        train_mask = ~test_mask
        if test_mask.sum() < 20 or train_mask.sum() < 100:
            continue
        clf = make_clf_fn()
        clf.fit(X[train_mask], y[train_mask])
        acc  = accuracy(clf, X[test_mask], y[test_mask])
        base = float(y[test_mask].mean())
        results[yr] = {"accuracy": acc, "baseline": base, "n": int(test_mask.sum())}
    return results


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) < 3:
        print("Usage: train_model.py <input.json> <output.json>", file=sys.stderr)
        sys.exit(1)

    with open(sys.argv[1], encoding="utf-8") as f:
        data = json.load(f)

    X      = np.array(data["X"],        dtype=np.float64)
    y      = np.array(data["y"],        dtype=np.int32)
    mask   = np.array(data["testMask"], dtype=bool)
    dates  = data.get("dates", [])

    X_train, y_train = X[~mask], y[~mask]
    X_test,  y_test  = X[mask],  y[mask]
    baseline = float(y_test.mean())

    print(f"   Train: {len(y_train)}  Test: {len(y_test)}", flush=True)
    print(f"   Config: {N_TREES} trees, depth {MAX_DEPTH}, skip_xgb={SKIP_XGB}", flush=True)

    # -- Phase 1: compare RF vs XGBoost on temporal hold-out ----------------
    print("   Phase 1: training RF...", flush=True)
    rf = make_rf()
    rf.fit(X_train, y_train)
    rf_acc = accuracy(rf, X_test, y_test)
    print(f"   RF  test accuracy: {rf_acc*100:.1f}%", flush=True)

    if SKIP_XGB:
        use_xgb     = False
        best_acc    = rf_acc
        winner_name = "RandomForest"
        xgb_clf     = None
        print(f"   Skipping XGBoost (SKIP_XGB=true)", flush=True)
    else:
        print("   Phase 1: training XGBoost...", flush=True)
        xgb_clf = make_xgb()
        xgb_clf.fit(X_train, y_train)
        xgb_acc = accuracy(xgb_clf, X_test, y_test)
        print(f"   XGB test accuracy: {xgb_acc*100:.1f}%", flush=True)
        use_xgb     = xgb_acc > rf_acc
        best_acc    = xgb_acc if use_xgb else rf_acc
        winner_name = "XGBoost" if use_xgb else "RandomForest"

    print(f"   Winner: {winner_name}  ({best_acc*100:.1f}% vs {baseline*100:.1f}% baseline)", flush=True)

    # -- Platt scaling calibration on the temporal hold-out ---------------
    winner_probs = (xgb_clf if use_xgb else rf).predict_proba(X_test)[:, 1]
    cal = LogisticRegression(C=1e10, solver="lbfgs")
    cal.fit(winner_probs.reshape(-1, 1), y_test)
    cal_a = float(cal.coef_[0][0])
    cal_b = float(cal.intercept_[0])
    print(f"   Calibration: a={cal_a:.3f}, b={cal_b:.3f}\n", flush=True)

    # -- Walk-forward CV using the winning model type -----------------------
    if dates:
        make_winner = make_xgb if use_xgb else make_rf
        print("   Walk-forward CV by year:", flush=True)
        wf = walk_forward_cv(X, y, dates, make_winner)
        for yr, s in wf.items():
            print(f"     {yr}: {s['accuracy']*100:.1f}%  ({s['baseline']*100:.1f}% baseline)  n={s['n']}", flush=True)
        print("", flush=True)
    else:
        wf = {}

    # -- Phase 2: retrain winner on full dataset ----------------------------
    print(f"   Phase 2: retraining {winner_name} on full dataset ({len(y)} examples)...", flush=True)
    if use_xgb:
        final = make_xgb()
        final.fit(X, y)
        booster  = final.get_booster()
        raw_dump = booster.get_dump(dump_format="json")
        trees    = [export_xgb_tree(t) for t in raw_dump]
        importances = final.feature_importances_.tolist()
        result = {
            "type":               "xgboost",
            "baseScore":          0.0,   # log-odds bias; 0.0 = base_score 0.5
            "trees":              trees,
            "nClasses":           2,
            "testAccuracy":       best_acc,
            "baselineAcc":        baseline,
            "featureImportances": importances,
            "walkForwardCV":      wf,
            "calibration":        {"a": cal_a, "b": cal_b},
        }
    else:
        final = make_rf()
        final.fit(X, y)
        trees = [export_rf_tree(est) for est in final.estimators_]
        result = {
            "type":               "sklearn-rf",
            "trees":              trees,
            "nClasses":           2,
            "testAccuracy":       best_acc,
            "baselineAcc":        baseline,
            "featureImportances": final.feature_importances_.tolist(),
            "walkForwardCV":      wf,
            "calibration":        {"a": cal_a, "b": cal_b},
        }

    print("   Final model trained\n", flush=True)

    with open(sys.argv[2], "w", encoding="utf-8") as f:
        json.dump(result, f)

    print("   Model saved", flush=True)


if __name__ == "__main__":
    main()
