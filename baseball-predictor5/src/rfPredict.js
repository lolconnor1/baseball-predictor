'use strict';

/**
 * Pure-JS inference for models trained in Python and exported as JSON trees.
 * Supports sklearn RandomForest (average of leaf probabilities) and
 * XGBoost (sum of leaf log-odds + sigmoid).
 */

function traverseRFTree(tree, row) {
  let node = 0;
  while (tree.childrenLeft[node] !== -1) {
    node = row[tree.feature[node]] <= tree.threshold[node]
      ? tree.childrenLeft[node]
      : tree.childrenRight[node];
  }
  return tree.value[node][1]; // P(home win)
}

function traverseXGBTree(tree, row) {
  let node = 0;
  while (tree.childrenLeft[node] !== -1) {
    node = row[tree.feature[node]] < tree.threshold[node]
      ? tree.childrenLeft[node]
      : tree.childrenRight[node];
  }
  return tree.leafValue[node]; // log-odds contribution
}

/**
 * @param {object} modelPayload  — the `model` field from model.json
 * @param {string[]} featureNames
 * @param {object} features      — keyed feature object from buildFeatureVector
 * @returns {number} probability of home win [0, 1]
 */
function rfPredict(modelPayload, featureNames, features) {
  const row = featureNames.map(k => features[k] ?? 0);

  if (modelPayload.type === 'xgboost') {
    let score = modelPayload.baseScore ?? 0;
    for (const tree of modelPayload.trees) score += traverseXGBTree(tree, row);
    return 1 / (1 + Math.exp(-score)); // sigmoid
  }

  // sklearn-rf: average leaf probabilities
  const trees = modelPayload.trees;
  let sum = 0;
  for (const tree of trees) sum += traverseRFTree(tree, row);
  return sum / trees.length;
}

/**
 * Tree-path attribution for the sklearn forest ("tree interpreter"): walking
 * each tree from root to leaf, the change in P(home win) at every split is
 * credited to the feature that split. Averaged over trees,
 *   bias + sum(contributions) === rfPredict(...)
 * exactly. Returns null for XGBoost models (internal node values aren't exported).
 */
function rfExplain(modelPayload, featureNames, features) {
  if (modelPayload.type === 'xgboost') return null;

  const row = featureNames.map(k => features[k] ?? 0);
  const contributions = new Array(featureNames.length).fill(0);
  let bias = 0;

  for (const tree of modelPayload.trees) {
    let node = 0;
    bias += tree.value[0][1];
    while (tree.childrenLeft[node] !== -1) {
      const next = row[tree.feature[node]] <= tree.threshold[node]
        ? tree.childrenLeft[node]
        : tree.childrenRight[node];
      contributions[tree.feature[node]] += tree.value[next][1] - tree.value[node][1];
      node = next;
    }
  }

  const n = modelPayload.trees.length;
  return { bias: bias / n, contributions: contributions.map(c => c / n) };
}

module.exports = { rfPredict, rfExplain };
