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

module.exports = { rfPredict };
