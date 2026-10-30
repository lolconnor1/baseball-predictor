'use strict';

/**
 * Pure-JS inference for models trained in Python and exported as JSON.
 * Supports logistic regression on home-minus-away terms, sklearn
 * RandomForest (average of leaf probabilities) and XGBoost (sum of leaf
 * log-odds + sigmoid).
 */

const sigmoid = z => 1 / (1 + Math.exp(-z));

// Each term's centred contribution to the logistic model's log-odds
function logisticContributions(model, features) {
  return model.terms.map((t, j) => {
    const value = t.home != null
      ? (features[t.home] ?? 0) - (features[t.away] ?? 0)
      : (features[t.feature] ?? 0);
    return model.weights[j] * (value - model.means[j]);
  });
}

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
  if (modelPayload.type === 'logistic') {
    return sigmoid(modelPayload.bias + logisticContributions(modelPayload, features).reduce((s, c) => s + c, 0));
  }

  const row = featureNames.map(k => features[k] ?? 0);

  if (modelPayload.type === 'xgboost') {
    let score = modelPayload.baseScore ?? 0;
    for (const tree of modelPayload.trees) score += traverseXGBTree(tree, row);
    return sigmoid(score);
  }

  // sklearn-rf: average leaf probabilities
  const trees = modelPayload.trees;
  let sum = 0;
  for (const tree of trees) sum += traverseRFTree(tree, row);
  return sum / trees.length;
}

/**
 * Per-feature attribution, exact in the model's own scale (`link`):
 *  - logistic: each term's weight × (value − training mean), in log-odds;
 *    a home/away pair's contribution is split evenly between its two features.
 *  - forest: tree-path attribution ("tree interpreter") — walking each tree
 *    from root to leaf, the change in P(home win) at every split is credited
 *    to the feature that split, averaged over trees.
 * Either way bias + sum(contributions) reproduces the raw prediction.
 * Returns null for XGBoost models (internal node values aren't exported).
 */
function rfExplain(modelPayload, featureNames, features) {
  if (modelPayload.type === 'xgboost') return null;

  if (modelPayload.type === 'logistic') {
    const position = new Map(featureNames.map((n, i) => [n, i]));
    const contributions = new Array(featureNames.length).fill(0);
    logisticContributions(modelPayload, features).forEach((c, j) => {
      const t = modelPayload.terms[j];
      if (t.home != null) {
        contributions[position.get(t.home)] += c / 2;
        contributions[position.get(t.away)] += c / 2;
      } else {
        contributions[position.get(t.feature)] += c;
      }
    });
    return { bias: modelPayload.bias, contributions, link: 'logit' };
  }

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
  return { bias: bias / n, contributions: contributions.map(c => c / n), link: 'prob' };
}

module.exports = { rfPredict, rfExplain };
