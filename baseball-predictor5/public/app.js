'use strict';

// ---------------------------------------------------------------------------
// Baseball Oracle — static front end. Reads the JSON the daily pipeline
// publishes to data/, plus live scores straight from the MLB Stats API.
// ---------------------------------------------------------------------------

const MLB_API   = 'https://statsapi.mlb.com/api/v1';
const PAGE_SIZE = 50;
const MODEL_INFO = {
  'logistic-regression':   { name: 'logistic regression', importance: "Share of the model's total weight (coefficients on standardized inputs), grouped by what the features describe." },
  'sklearn-random-forest': { name: 'random forest', importance: "Share of the forest's total impurity-based importance, grouped by what the features describe." },
  'xgboost':               { name: 'XGBoost', importance: "Share of the model's total impurity-based importance, grouped by what the features describe." },
};
const C = { mark: Charts.css('--mark'), muted: Charts.css('--mark-muted') };

const state = { today: null, record: null, model: null, backtest: null, rendered: new Set() };

// ── DOM helper: never puts data into innerHTML ─────────────────────────────
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const pct  = (v, d = 1) => `${(v * 100).toFixed(d)}%`;
const pts  = v => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)} pts`;
const nf   = v => v.toLocaleString();
const dateLong  = d => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const dateShort = d => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const nickname  = name => name.split(' ').slice(-1)[0] === 'Sox' || name.split(' ').slice(-1)[0] === 'Jays'
  ? name.split(' ').slice(-2).join(' ') : name.split(' ').slice(-1)[0];

async function getJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Routing (#today / #record / #model)
// ---------------------------------------------------------------------------

const TABS = ['today', 'record', 'model'];

function route() {
  const tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'today';
  document.querySelectorAll('[data-tab]').forEach(a => {
    const on = a.dataset.tab === tab;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.querySelectorAll('.tab-content').forEach(s => s.classList.toggle('active', s.id === `tab-${tab}`));
  render(tab);
}

window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });

async function render(tab) {
  if (state.rendered.has(tab)) return;
  state.rendered.add(tab);
  try {
    if (tab === 'today')  await renderToday();
    if (tab === 'record') await renderRecord();
    if (tab === 'model')  await renderModel();
  } catch (err) {
    state.rendered.delete(tab);
    const target = { today: 'todayGames', record: 'recordKpis', model: 'modelKpis' }[tab];
    document.getElementById(target).replaceChildren(h('div', { class: 'error-state' }, `Couldn't load data — ${err.message}`));
  }
}

// ---------------------------------------------------------------------------
// Header status
// ---------------------------------------------------------------------------

async function loadStatus() {
  const dot  = document.querySelector('.status-dot');
  const text = document.querySelector('.status-text');
  try {
    state.today ??= await getJson('data/today.json');
    const at = new Date(state.today.generatedAt);
    dot.className = 'status-dot live';
    text.textContent = `UPDATED ${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase()}, ${at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  } catch {
    dot.className = 'status-dot error';
    text.textContent = 'DATA UNAVAILABLE';
  }
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

async function renderToday() {
  state.today ??= await getJson('data/today.json');
  const { date, games, nextGameDate } = state.today;
  const container = document.getElementById('todayGames');

  document.getElementById('todayTitle').textContent = dateLong(date);

  if (!games.length) {
    document.getElementById('todaySub').textContent = 'No MLB games today.';
    const days = nextGameDate ? Math.round((new Date(`${nextGameDate}T12:00:00`) - new Date(`${date}T12:00:00`)) / 86400000) : null;
    container.replaceChildren(h('div', { class: 'offseason' },
      h('div', { class: 'big' }, nextGameDate ? `Next games: ${dateLong(nextGameDate)}` : 'No games scheduled'),
      h('p', {}, nextGameDate
        ? `${days} day${days === 1 ? '' : 's'} to go. Predictions appear here every game day. Until then, see how the model did on every game of last season, or how it works.`
        : 'Predictions appear here every game day.'),
      h('div', { class: 'actions' },
        h('a', { class: 'btn-primary', href: '#record' }, 'Last season’s results'),
        h('a', { class: 'btn-secondary', href: '#model' }, 'How it works')),
    ));
    return;
  }

  const predicted = games.filter(g => !g.insufficient).length;
  document.getElementById('todaySub').textContent =
    `${games.length} games · ${predicted} predicted · probabilities are calibrated home/away win chances`;

  const grid = h('div', { class: 'games-grid' });
  games
    .slice()
    .sort((a, b) => (a.gameDate ?? '').localeCompare(b.gameDate ?? ''))
    .forEach((g, i) => {
      const card = gameCard(g);
      card.style.animationDelay = `${i * 40}ms`;
      grid.appendChild(card);
    });
  container.replaceChildren(grid);
  liveScores(date);
}

function gameCard(g) {
  const start = g.gameDate ? new Date(g.gameDate).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : '';
  const card = h('article', { class: 'game-card', 'data-game': g.gameId, 'aria-label': `${g.awayTeamName} at ${g.homeTeamName}` });

  const header = h('div', { class: 'game-card-header' },
    h('span', { class: 'game-state' }, start || g.status),
    h('span', { class: 'game-venue' }, g.venueName ?? ''));

  if (g.insufficient) {
    card.append(header, h('div', { class: 'game-card-body' },
      h('div', { class: 'teams' },
        h('div', { class: 'team-name' }, g.awayTeamName), h('span'),
        h('div', { class: 'team-name' }, g.homeTeamName), h('span')),
      h('div', { class: 'card-foot' }, 'Not enough games played yet to predict this matchup.')));
    return card;
  }

  const pickHome = g.predictedHome;
  const teamRow = (name, role, prob, isPick, side) => [
    h('div', { class: `team-name${isPick ? ' pick' : ''}` }, name, h('span', { class: 'role' }, role)),
    h('div', {},
      h('span', { class: `team-prob${isPick ? ' pick' : ''}` }, pct(prob)),
      h('span', { class: 'team-score', 'data-score': side })),
  ];

  const pitcher = (p, form) => {
    if (!p || p.isLeagueAvg) return h('div', { class: 'kv-val' }, h('span', { class: 'muted' }, 'TBD'));
    return h('div', { class: 'kv-val' },
      p.name, ' ',
      h('span', { class: 'muted' }, `${p.era?.toFixed(2)} ERA`),
      form ? h('span', { class: 'muted' }, ` · last ${form.starts}: ${form.recentEra.toFixed(2)}`) : null);
  };

  const factors = (g.factors ?? []).slice(0, 3).filter(f => Math.abs(f.value) >= 0.002);
  const factorList = factors.length ? h('div', { class: 'factors' },
    h('div', { class: 'factors-title' }, 'Why: biggest factors'),
    factors.map(f => {
      const toward = f.value >= 0 ? g.homeTeamName : g.awayTeamName;
      return h('div', { class: 'factor' },
        h('span', { class: 'factor-name' }, f.group, h('span', { class: 'toward' }, ` → ${nickname(toward)}`)),
        h('span', { class: 'factor-bar', 'aria-hidden': 'true' },
          h('span', { style: `width:${Math.min(100, Math.abs(f.value) / 0.06 * 100).toFixed(0)}%` })),
        h('span', { class: 'factor-val' }, pts(Math.abs(f.value))));
    })) : null;

  card.append(header, h('div', { class: 'game-card-body' },
    h('div', { class: 'teams' },
      teamRow(g.awayTeamName, 'AWAY', g.awayProb, !pickHome, 'away'),
      teamRow(g.homeTeamName, 'HOME', g.homeProb, pickHome, 'home')),
    h('div', { class: 'prob-bar', role: 'img', 'aria-label': `${pct(g.awayProb)} away, ${pct(g.homeProb)} home` },
      h('span', { class: pickHome ? '' : 'pick', style: `width:${g.awayProb * 100}%` }),
      h('span', { class: pickHome ? 'pick' : '', style: `width:${g.homeProb * 100}%` })),
    h('div', { class: 'pitchers' },
      h('div', {}, h('div', { class: 'kv-key' }, `${nickname(g.awayTeamName)} starter`), pitcher(g.awayPitcher, g.awayForm)),
      h('div', {}, h('div', { class: 'kv-key' }, `${nickname(g.homeTeamName)} starter`), pitcher(g.homePitcher, g.homeForm))),
    factorList,
    h('div', { class: 'card-foot' },
      h('span', { 'data-lock': '' }, g.recordedPregame ? 'Prediction recorded before first pitch' : 'No pre-game prediction recorded'),
      h('span', { 'data-result': '' }))));
  return card;
}

// Pulls live state and scores from the MLB API so the page stays current
// between pipeline runs. Fails quietly — the published data still renders.
async function liveScores(date) {
  let anyLive = false;
  try {
    const data = await getJson(`${MLB_API}/schedule?sportId=1&gameType=R&date=${date}&hydrate=linescore`);
    for (const g of data.dates?.[0]?.games ?? []) {
      const card = document.querySelector(`[data-game="${g.gamePk}"]`);
      if (!card) continue;
      const abstract = g.status?.abstractGameState;
      const stateEl  = card.querySelector('.game-state');
      const away = g.teams?.away?.score, home = g.teams?.home?.score;

      if (abstract === 'Live') {
        anyLive = true;
        const ls = g.linescore;
        stateEl.textContent = ls?.currentInningOrdinal ? `${ls.isTopInning ? 'Top' : 'Bot'} ${ls.currentInningOrdinal}` : 'Live';
        stateEl.classList.add('live');
      } else if (abstract === 'Final') {
        stateEl.textContent = g.status.detailedState === 'Final' ? 'Final' : g.status.detailedState;
        stateEl.classList.remove('live');
      } else if (g.status?.detailedState && !['Scheduled', 'Pre-Game', 'Warmup'].includes(g.status.detailedState)) {
        stateEl.textContent = g.status.detailedState;   // Postponed, Delayed, …
      }

      if (abstract !== 'Preview' && away != null && home != null) {
        card.querySelector('[data-score="away"]')?.replaceChildren(String(away));
        card.querySelector('[data-score="home"]')?.replaceChildren(String(home));
      }

      const game = state.today.games.find(x => x.gameId === g.gamePk);
      const resultEl = card.querySelector('[data-result]');
      if (abstract === 'Final' && game && !game.insufficient && resultEl && away !== home) {
        const correct = (home > away) === game.predictedHome;
        resultEl.replaceChildren(h('span', { class: `result-chip ${correct ? 'correct' : 'missed'}` }, correct ? '✓ Correct' : '✗ Missed'));
      }
    }
  } catch { /* offline or API hiccup — keep published data */ }

  if (anyLive) setTimeout(() => liveScores(date), 60_000);
}

// ---------------------------------------------------------------------------
// Track record
// ---------------------------------------------------------------------------

async function renderRecord() {
  [state.record, state.backtest] = await Promise.all([
    state.record ?? getJson('data/record.json'),
    state.backtest ?? getJson('data/backtest.json'),
  ]);
  state.model ??= await getJson('data/model.json');

  const hasLive = !!state.record.summary;
  const liveBtn = document.getElementById('modeLive');
  const btBtn   = document.getElementById('modeBacktest');
  btBtn.textContent = `${state.backtest.season} backtest`;
  liveBtn.disabled = !hasLive;
  if (!hasLive) liveBtn.title = 'Live tracking starts with the first game day under the current model';

  const setMode = mode => {
    liveBtn.setAttribute('aria-pressed', String(mode === 'live'));
    btBtn.setAttribute('aria-pressed', String(mode === 'backtest'));
    drawRecord(mode);
  };
  liveBtn.onclick = () => setMode('live');
  btBtn.onclick   = () => setMode('backtest');
  setMode(hasLive ? 'live' : 'backtest');
}

function drawRecord(mode) {
  const live    = mode === 'live';
  const summary = live ? state.record.summary : state.model.latestSeason;
  const rows    = live ? state.record.entries : state.backtest.games;

  document.getElementById('recordNote').textContent = live
    ? (state.record.excludedNotPregame
        ? `${nf(state.record.excludedNotPregame)} games without a prediction recorded before first pitch are left out.`
        : '')
    : `Every ${state.backtest.season} game, predicted by a model trained only on earlier seasons — the same out-of-sample test shown on the How it works tab.` +
      (state.record.summary ? '' : ' Live, pre-game tracking begins on the next game day.');

  const kpis = document.getElementById('recordKpis');
  kpis.replaceChildren(...summaryTiles(summary));

  // The first weeks swing on tiny samples; start once there's a real sample
  const all = summary.cumulative;
  const cum = all.length > 4 ? all.filter(p => p.n >= 150) : all;
  Charts.line(document.getElementById('chartCumulative'), {
    labels: cum.map(p => p.week),
    xFormat: dateShort,
    xTitle: 'Week of',
    format: v => pct(v),
    tooltipTitle: i => `Through week of ${dateShort(cum[i].week)} · ${nf(cum[i].n)} games`,
    ariaLabel: 'Running accuracy by week',
    series: [
      { name: 'Model', short: 'model', color: C.mark, values: cum.map(p => p.accuracy) },
      { name: 'Always pick home', short: 'home', color: C.muted, values: cum.map(p => p.homeAccuracy) },
    ],
  });

  drawTable(rows);
}

function summaryTiles(s) {
  const tiles = [
    { label: 'Accuracy', value: pct(s.accuracy), detail: `${nf(s.n)} games · 95% CI ${pct(s.accuracyCI[0])}–${pct(s.accuracyCI[1])}`, highlight: true },
    { label: 'vs. always picking home', value: pts(s.liftVsHome.value), detail: `home team won ${pct(s.homeBaseline)} · CI ${pts(s.liftVsHome.ci[0])} to ${pts(s.liftVsHome.ci[1])}` },
  ];
  if (s.liftVsRecord) {
    tiles.push({ label: 'vs. picking the better record', value: pts(s.liftVsRecord.value), detail: `that rule got ${pct(s.recordBaseline)} · CI ${pts(s.liftVsRecord.ci[0])} to ${pts(s.liftVsRecord.ci[1])}` });
  }
  tiles.push({ label: 'Log loss', value: s.logLoss.toFixed(3), detail: `lower is better · base rate ${s.baseRateLogLoss.toFixed(3)}, coin flip 0.693` });
  return tiles.map(t => h('div', { class: `kpi${t.highlight ? ' highlight' : ''}` },
    h('div', { class: 'kpi-label' }, t.label),
    h('div', { class: 'kpi-value' }, t.value),
    h('div', { class: 'kpi-detail' }, t.detail)));
}

function drawTable(rows) {
  const teamSel   = document.getElementById('filterTeam');
  const resultSel = document.getElementById('filterResult');
  const tbody     = document.querySelector('#recordTable tbody');
  const more      = document.getElementById('showMore');
  const count     = document.getElementById('filterCount');

  const teams = [...new Set(rows.flatMap(r => [r.home, r.away]))].filter(Boolean).sort();
  const keep  = teamSel.value;
  teamSel.replaceChildren(h('option', { value: '' }, 'All teams'), ...teams.map(t => h('option', { value: t }, t)));
  teamSel.value = teams.includes(keep) ? keep : '';

  let shown = PAGE_SIZE;
  const filtered = () => rows.filter(r =>
    (!teamSel.value || r.home === teamSel.value || r.away === teamSel.value) &&
    (!resultSel.value || (resultSel.value === 'correct') === r.correct));

  const draw = () => {
    const list = filtered();
    const correct = list.filter(r => r.correct).length;
    count.textContent = list.length ? `${nf(list.length)} games · ${pct(correct / list.length)} correct` : 'No games';
    tbody.replaceChildren(...list.slice(0, shown).map(r => {
      const pickHome = r.homeProb >= 0.5;
      return h('tr', {},
        h('td', { class: 'muted' }, dateShort(r.date)),
        h('td', {},
          h('span', { class: 'name-full' }, `${r.away} @ ${r.home}`),
          h('span', { class: 'name-short' }, `${nickname(r.away)} @ ${nickname(r.home)}`)),
        h('td', { class: 'muted' }, r.awayScore != null ? `${r.awayScore}–${r.homeScore}` : ''),
        h('td', {}, nickname(pickHome ? r.home : r.away), h('span', { class: 'muted' }, ` ${pct(pickHome ? r.homeProb : 1 - r.homeProb, 0)}`)),
        h('td', {}, h('span', { class: `result-badge ${r.correct ? 'correct' : 'missed'}`, 'aria-label': r.correct ? 'Correct' : 'Missed' }, r.correct ? '✓' : '✗')));
    }));
    more.hidden = list.length <= shown;
  };

  teamSel.onchange = resultSel.onchange = () => { shown = PAGE_SIZE; draw(); };
  more.onclick = () => { shown += PAGE_SIZE * 2; draw(); };
  draw();
}

// ---------------------------------------------------------------------------
// How it works
// ---------------------------------------------------------------------------

async function renderModel() {
  state.model ??= await getJson('data/model.json');
  const { model, walkForward, pooled, importance } = state.model;

  document.getElementById('featureCount').textContent = model.featureCount;
  const modelInfo = MODEL_INFO[model.type] ?? MODEL_INFO['sklearn-random-forest'];
  document.getElementById('modelWinner').textContent = modelInfo.name;
  document.getElementById('importanceSub').textContent = modelInfo.importance;

  const first = walkForward[0]?.season, last = walkForward[walkForward.length - 1]?.season;
  document.getElementById('modelKpis').replaceChildren(
    ...[
      { label: `Accuracy, ${first}–${last}`, value: pct(pooled.accuracy), detail: `${nf(pooled.n)} out-of-sample games`, highlight: true },
      { label: 'Lift over home team', value: pts(pooled.liftVsHome.value), detail: `95% CI ${pts(pooled.liftVsHome.ci[0])} to ${pts(pooled.liftVsHome.ci[1])}` },
      { label: 'Log loss', value: pooled.logLoss.toFixed(4), detail: `base rate ${pooled.baseRateLogLoss.toFixed(4)} · coin flip 0.6931` },
      { label: 'Training data', value: nf(model.totalGames), detail: `games, ${model.seasons[0]}–${model.seasons[model.seasons.length - 1]} · ${modelInfo.name}${model.trees ? `, ${model.trees} trees` : ''}` },
    ].map(t => h('div', { class: `kpi${t.highlight ? ' highlight' : ''}` },
      h('div', { class: 'kpi-label' }, t.label),
      h('div', { class: 'kpi-value' }, t.value),
      h('div', { class: 'kpi-detail' }, t.detail))));

  Charts.dumbbell(document.getElementById('chartWalkForward'), {
    categories: walkForward.map(s => s.season),
    categoryTitle: 'Season',
    primary:   { name: 'Model', color: C.mark, values: walkForward.map(s => s.accuracy) },
    secondary: { name: 'Always pick home', color: C.muted, values: walkForward.map(s => s.homeBaseline) },
    format: v => pct(v),
    ariaLabel: 'Walk-forward accuracy by season',
    detail: i => [{ value: walkForward[i].logLoss.toFixed(4), name: 'log loss' }, { value: nf(walkForward[i].n), name: 'games' }],
    extraColumns: { headers: ['Log loss', 'Games'], row: i => [walkForward[i].logLoss.toFixed(4), nf(walkForward[i].n)] },
  });

  Charts.calibration(document.getElementById('chartCalibration'), { bins: pooled.calibration, color: C.mark });

  Charts.columns(document.getElementById('chartConfidence'), {
    items: pooled.byConfidence.filter(b => b.n > 0).map(b => ({
      label: b.label, sub: `${pct(b.share, 0)} of games`, value: b.accuracy, ci: b.accuracyCI,
      tooltipExtra: [{ value: nf(b.n), name: 'games' }],
    })),
    color: C.mark,
    format: v => pct(v, 0),
    valueName: 'picked correctly',
    ref: { value: 0.5, label: 'coin flip' },
    ariaLabel: 'Accuracy by confidence band',
    tableHeaders: ['Confidence', 'Accuracy', '95% interval', 'Share of games'],
    tableRow: it => [it.label, pct(it.value), `${pct(it.ci[0])}–${pct(it.ci[1])}`, it.sub],
  });

  Charts.bars(document.getElementById('chartImportance'), {
    items: importance.groups.filter(g => g.value > 0.001).map(g => ({ label: g.group, value: g.value })),
    color: C.mark,
    format: v => pct(v, 0),
    valueName: 'of total importance',
    ariaLabel: 'Feature importance by group',
    tableHeaders: ['Feature group', 'Share of importance'],
  });
}

// ---------------------------------------------------------------------------

loadStatus();
route();
