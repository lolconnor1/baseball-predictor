'use strict';

// ---------------------------------------------------------------------------
// Tab routing — works for both desktop .tab buttons and mobile .nav-item
// ---------------------------------------------------------------------------

function switchTab(tabName) {
  // Update desktop top tabs
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  // Update mobile bottom nav items
  document.querySelectorAll('.bottom-nav .nav-item').forEach(n => n.classList.toggle('active', n.dataset.tab === tabName));
  // Update content panels
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(`tab-${tabName}`).classList.add('active');

  // Lazy-load data for the activated tab
  if (tabName === 'accuracy') loadAccuracy();
  if (tabName === 'bets')     loadBets();
  if (tabName === 'model')    loadModelInfo();
}

// Wire up desktop top tabs
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// Wire up mobile bottom nav items
document.querySelectorAll('.bottom-nav .nav-item').forEach(item => {
  item.addEventListener('click', () => switchTab(item.dataset.tab));
});

// ---------------------------------------------------------------------------
// Date picker defaults to today
// ---------------------------------------------------------------------------

const datePicker = document.getElementById('datePicker');
const today = localToday();
datePicker.value = today;

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Model status (header)
// ---------------------------------------------------------------------------

async function loadStatus() {
  try {
    const data = await api('/api/status');
    const dot  = document.querySelector('.status-dot');
    const text = document.querySelector('.status-text');

    if (!data.trained) {
      dot.className  = 'status-dot error';
      text.textContent = 'NO MODEL — run train first';
      return;
    }

    dot.className    = 'status-dot live';
    text.textContent = `MODEL READY · ${(data.testAccuracy * 100).toFixed(1)}% ACC · UPDATED ${data.lastUpdated ?? 'N/A'}`;
  } catch {
    document.querySelector('.status-text').textContent = 'Server unreachable';
  }
}

loadStatus();

// ---------------------------------------------------------------------------
// Predictions
// ---------------------------------------------------------------------------

document.getElementById('btnPredict').addEventListener('click', runPredictions);

async function runPredictions() {
  const date = datePicker.value;
  if (!date) return;

  const btn = document.getElementById('btnPredict');
  const container = document.getElementById('predictionsContainer');

  btn.disabled    = true;
  btn.textContent = 'LOADING…';
  container.innerHTML = '<div class="loading">FETCHING PREDICTIONS</div>';

  try {
    const data = await api(`/api/predict?date=${date}`);

    if (!data.predictions || data.predictions.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚾</div><p>No games found for ${date}</p></div>`;
      return;
    }

    container.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'games-grid';

    data.predictions.forEach((game, i) => {
      const card = buildGameCard(game);
      card.style.animationDelay = `${i * 60}ms`;
      grid.appendChild(card);
    });

    container.appendChild(grid);
  } catch (err) {
    container.innerHTML = `<div class="error-state">Error: ${err.message}</div>`;
  } finally {
    btn.disabled    = false;
    btn.textContent = 'RUN PREDICTIONS';
  }
}

function buildGameCard(game) {
  if (game.insufficient) {
    const card = document.createElement('div');
    card.className = 'game-card';
    card.innerHTML = `
      <div class="game-card-header">
        <span class="matchup">${game.awayTeamName} @ ${game.homeTeamName}</span>
        <span class="game-status">${game.status}</span>
      </div>
      <div class="game-card-body">
        <div style="color:var(--text-dim);font-family:var(--font-mono);font-size:12px">
          ⚠ Insufficient historical data
        </div>
      </div>`;
    return card;
  }

  const homeWinner = game.predictedHome;
  const homeProb   = (game.homeProb * 100).toFixed(1);
  const awayProb   = (game.awayProb * 100).toFixed(1);
  const confidence = (Math.max(game.homeProb, game.awayProb) * 100).toFixed(1);

  // Pitcher lines
  let pitcherHtml = `<div class="detail-row"><div class="detail-key">PITCHERS</div><div class="detail-val" style="color:var(--text-dim)">Not yet announced</div></div>`;
  if (game.homePitcher && !game.homePitcher.isLeagueAvg) {
    const hForm = game.homeForm ? ` <span class="${game.homeForm.trend}">${game.homeForm.trend} (${game.homeForm.recentEra} ERA)</span>` : '';
    const aForm = game.awayForm ? ` <span class="${game.awayForm.trend}">${game.awayForm.trend} (${game.awayForm.recentEra} ERA)</span>` : '';
    pitcherHtml = `
      <div class="detail-row">
        <div class="detail-key">HOME PITCHER</div>
        <div class="detail-val">${game.homePitcher.name} — ${game.homePitcher.era?.toFixed(2)} ERA / ${game.homePitcher.whip?.toFixed(2)} WHIP${hForm}</div>
      </div>
      <div class="detail-row">
        <div class="detail-key">AWAY PITCHER</div>
        <div class="detail-val">${game.awayPitcher.name} — ${game.awayPitcher.era?.toFixed(2)} ERA / ${game.awayPitcher.whip?.toFixed(2)} WHIP${aForm}</div>
      </div>`;
  }

  // H2H
  const h2hHtml = game.h2h.hasHistory
    ? `Home wins ${(game.h2h.homeWinPct * 100).toFixed(0)}% of prior matchups`
    : `No H2H history`;

  // Schedule
  const { homeRestDays, awayRestDays, homeGames7, awayGames7, homeStandLength, roadTripLength } = game.schedule;

  // Stats
  const hs = game.homeStats;
  const as = game.awayStats;

  const card = document.createElement('div');
  card.className = 'game-card';
  card.innerHTML = `
    <div class="game-card-header">
      <span class="matchup">
        <span class="${!homeWinner ? 'winner' : ''}">${game.awayTeamName}</span>
        <span style="color:var(--text-dim);font-weight:400"> @ </span>
        <span class="${homeWinner ? 'winner' : ''}">${game.homeTeamName}</span>
      </span>
      <span class="game-status">${game.status}</span>
    </div>
    <div class="game-card-body">

      <div class="prob-section">
        <div class="prob-label">
          <span>${game.awayTeamName}</span>
          <span>WIN PROBABILITY${game.calibrated ? ' <span class="cal-badge">CALIBRATED</span>' : ''}</span>
          <span>${game.homeTeamName}</span>
        </div>
        <div class="prob-bar-wrap">
          <div class="prob-bar-away" style="width:${awayProb}%"></div>
          <div class="prob-bar-home" style="width:${homeProb}%"></div>
        </div>
        <div class="prob-values">
          <span class="prob-away">${awayProb}%</span>
          <span class="prob-home">${homeProb}%</span>
        </div>
      </div>

      <div class="divider"></div>

      <div class="detail-grid">
        <div class="detail-row">
          <div class="detail-key">VENUE</div>
          <div class="detail-val">${game.venueName} <span style="color:var(--text-dim)">(${game.parkFactor.toFixed(2)}x)</span></div>
        </div>
        <div class="detail-row">
          <div class="detail-key">H2H RECORD</div>
          <div class="detail-val">${h2hHtml}</div>
        </div>
        ${pitcherHtml}
        <div class="detail-row">
          <div class="detail-key">HOME SCHEDULE</div>
          <div class="detail-val">${homeRestDays}d rest · ${homeGames7}/7 days · game ${homeStandLength} of home stand</div>
        </div>
        <div class="detail-row">
          <div class="detail-key">AWAY SCHEDULE</div>
          <div class="detail-val">${awayRestDays}d rest · ${awayGames7}/7 days · game ${roadTripLength} of road trip</div>
        </div>
        <div class="detail-row">
          <div class="detail-key">HOME STATS (L30)</div>
          <div class="detail-val">WR ${pct(hs.winPct)} · RS ${hs.avgRS} · RA ${hs.avgRA} · L5 ${pct(hs.momentum)}</div>
        </div>
        <div class="detail-row">
          <div class="detail-key">AWAY STATS (L30)</div>
          <div class="detail-val">WR ${pct(as.winPct)} · RS ${as.avgRS} · RA ${as.avgRA} · L5 ${pct(as.momentum)}</div>
        </div>
      </div>

      ${buildFanDuelSection(game)}

      ${buildOddsSection(game)}

      <div class="prediction-row">
        <div>
          <div class="prediction-label">PREDICTED WINNER</div>
          <div class="prediction-winner">${game.predictedWinner}</div>
        </div>
        <div class="confidence-badge">
          ${confidence}% CONF
          ${game.calibrated && game.rawProb ? `<span class="raw-prob-note">raw: ${(Math.max(game.rawProb, 1-game.rawProb)*100).toFixed(1)}%</span>` : ''}
        </div>
      </div>

      <button class="log-bet-btn js-log-bet">💰 LOG BET</button>

    </div>`;

  card.querySelector('.js-log-bet').addEventListener('click', () => openBetModal(game, datePicker.value));

  return card;
}

// ---------------------------------------------------------------------------
// Accuracy log
// ---------------------------------------------------------------------------

async function loadAccuracy() {
  const container = document.getElementById('accuracyLog');
  container.innerHTML = '<div class="loading">LOADING ACCURACY DATA</div>';

  try {
    const data = await api('/api/accuracy');

    // Stats cards
    if (data.stats) {
      const s = data.stats;
      document.getElementById('statAllTime').textContent =
        `${(s.accuracy * 100).toFixed(1)}% (${s.correct}/${s.total})`;
      document.getElementById('statRecent').textContent =
        s.recentAccuracy != null
          ? `${(s.recentAccuracy * 100).toFixed(1)}% (${s.recentCorrect}/${s.recentTotal})`
          : '—';
      document.getElementById('statConf').textContent =
        s.confAccuracy != null
          ? `${(s.confAccuracy * 100).toFixed(1)}% (${s.confCorrect}/${s.confTotal})`
          : '—';
    }

    if (!data.entries || data.entries.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">📊</div><p>No accuracy data yet</p></div>`;
      return;
    }

    const table = document.createElement('table');
    table.className = 'log-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th></th>
          <th>DATE</th>
          <th>MATCHUP</th>
          <th>SCORE</th>
          <th>PREDICTED</th>
          <th>ACTUAL</th>
          <th>CONF</th>
        </tr>
      </thead>`;

    const tbody = document.createElement('tbody');
    for (const e of data.entries) {
      const conf = (Math.max(e.homeProb, 1 - e.homeProb) * 100).toFixed(1);
      const predicted = e.predictedHome ? e.homeTeam : e.awayTeam;
      const actual    = e.actualHome    ? e.homeTeam : e.awayTeam;
      const tr = document.createElement('tr');
      tr.className = e.correct ? 'correct' : 'incorrect';
      tr.innerHTML = `
        <td><span class="result-badge ${e.correct ? 'correct' : 'incorrect'}">${e.correct ? '✓' : '✗'}</span></td>
        <td>${e.date}</td>
        <td>${e.awayTeam} @ ${e.homeTeam}</td>
        <td>${e.awayScore}–${e.homeScore}</td>
        <td style="color:${e.correct ? 'var(--green)' : 'var(--red)'}">${predicted}</td>
        <td>${actual}</td>
        <td style="color:var(--text-dim)">${conf}%</td>`;
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    container.innerHTML = '';
    container.appendChild(table);

    // Team breakdown
    if (data.stats?.teamStats?.length > 0) {
      const teamSection = document.createElement('div');
      teamSection.style.marginTop = '32px';
      teamSection.innerHTML = buildTeamBreakdown(data.stats.teamStats);
      container.appendChild(teamSection);
    }

  } catch (err) {
    container.innerHTML = `<div class="error-state">Error loading accuracy data: ${err.message}</div>`;
  }
}

function buildTeamBreakdown(teamStats) {
  const rows = teamStats.map(t => {
    const p       = (t.accuracy * 100).toFixed(1);
    const barWidth  = Math.round(t.accuracy * 100);
    const barColor  = t.accuracy >= 0.60 ? 'var(--green)'
                    : t.accuracy >= 0.50 ? 'var(--amber)'
                    : 'var(--red)';
    return `
      <tr class="team-row">
        <td class="team-name-cell">${t.team}</td>
        <td class="team-record-cell">${t.correct}/${t.total}</td>
        <td class="team-bar-cell">
          <div class="team-acc-bar-wrap">
            <div class="team-acc-bar" style="width:${barWidth}%;background:${barColor}"></div>
          </div>
        </td>
        <td class="team-pct-cell" style="color:${barColor}">${p}%</td>
      </tr>`;
  }).join('');

  return `
    <div class="team-breakdown">
      <div class="team-breakdown-header">
        <span class="odds-label">ACCURACY BY TEAM</span>
        <span style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim)">sorted by games predicted</span>
      </div>
      <table class="team-table">
        <thead>
          <tr>
            <th>TEAM</th>
            <th>RECORD</th>
            <th></th>
            <th>ACC</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ---------------------------------------------------------------------------
// Model info (Oracle tab)
// ---------------------------------------------------------------------------

async function loadModelInfo() {
  const container = document.getElementById('modelInfo');

  try {
    const data = await api('/api/status');

    if (!data.trained) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">🔮</div><p>No trained model found.<br>Run <code>node index.js train</code> first.</p></div>`;
      return;
    }

    const lift = ((data.testAccuracy - data.baselineAcc) * 100).toFixed(1);

    container.innerHTML = `
      <div class="model-grid">
        <div class="model-card">
          <div class="model-card-label">SEASONS TRAINED</div>
          <div class="model-card-value">${data.seasons.join(', ')}</div>
        </div>
        <div class="model-card">
          <div class="model-card-label">ENSEMBLE SIZE</div>
          <div class="model-card-value green">${data.ensembleSize ?? 1} models</div>
        </div>
        <div class="model-card">
          <div class="model-card-label">TEST ACCURACY</div>
          <div class="model-card-value green">${(data.testAccuracy * 100).toFixed(1)}%</div>
        </div>
        <div class="model-card">
          <div class="model-card-label">BASELINE (ALWAYS HOME)</div>
          <div class="model-card-value">${(data.baselineAcc * 100).toFixed(1)}%</div>
        </div>
        <div class="model-card">
          <div class="model-card-label">LIFT OVER BASELINE</div>
          <div class="model-card-value green">+${lift}pp</div>
        </div>
        <div class="model-card">
          <div class="model-card-label">TOTAL GAMES TRAINED</div>
          <div class="model-card-value">${(data.totalGames || 0).toLocaleString()}</div>
        </div>
        <div class="model-card">
          <div class="model-card-label">LAST UPDATED</div>
          <div class="model-card-value">${data.lastUpdated ?? 'Never'}</div>
        </div>
        <div class="model-card">
          <div class="model-card-label">TEST METHOD</div>
          <div class="model-card-value ${data.splitType === 'temporal' ? 'green' : ''}">${
            data.splitType === 'temporal'
              ? `Temporal (${data.testSeason} season)`
              : 'Random 80/20'
          }</div>
        </div>
        <div class="model-card">
          <div class="model-card-label">CACHE THROUGH</div>
          <div class="model-card-value">${data.cacheThrough || '—'}</div>
        </div>
        <div class="model-card">
          <div class="model-card-label">PITCHER COVERAGE</div>
          <div class="model-card-value">${data.pitcherCoverage ?? '—'}</div>
        </div>
      </div>

      <div class="feature-list">
        <h3>Feature Vector — 26 Inputs</h3>
        <div class="feature-group">
          <div class="feature-group-label">Rolling Team Stats (Exp. Weighted, Last 30 Games)</div>
          <div class="feature-chips">
            <span class="chip">Home Win %</span>
            <span class="chip">Away Win %</span>
            <span class="chip">Home Avg RS</span>
            <span class="chip">Away Avg RS</span>
            <span class="chip">Home Avg RA</span>
            <span class="chip">Away Avg RA</span>
            <span class="chip">Home/Home Win %</span>
            <span class="chip">Away/Away Win %</span>
            <span class="chip">Win % Diff</span>
            <span class="chip">Run Diff Adv</span>
            <span class="chip">Home Momentum (L5)</span>
            <span class="chip">Away Momentum (L5)</span>
          </div>
        </div>
        <div class="feature-group">
          <div class="feature-group-label">Head-to-Head (Last 15 Matchups)</div>
          <div class="feature-chips">
            <span class="chip">H2H Home Win %</span>
            <span class="chip">H2H Run Diff</span>
          </div>
        </div>
        <div class="feature-group">
          <div class="feature-group-label">Ballpark</div>
          <div class="feature-chips">
            <span class="chip">Park Run Factor</span>
          </div>
        </div>
        <div class="feature-group">
          <div class="feature-group-label">Starting Pitchers</div>
          <div class="feature-chips">
            <span class="chip">Home ERA</span>
            <span class="chip">Home WHIP</span>
            <span class="chip">Away ERA</span>
            <span class="chip">Away WHIP</span>
            <span class="chip">Pitcher Advantage</span>
          </div>
        </div>
        <div class="feature-group">
          <div class="feature-group-label">Schedule Context</div>
          <div class="feature-chips">
            <span class="chip">Home Rest Days</span>
            <span class="chip">Away Rest Days</span>
            <span class="chip">Home Schedule Density</span>
            <span class="chip">Away Schedule Density</span>
            <span class="chip">Home Stand Length</span>
            <span class="chip">Road Trip Length</span>
          </div>
        </div>
        <div class="feature-group">
          <div class="feature-group-label">Pitcher Recent Form (Last 3 Starts)</div>
          <div class="feature-chips">
            <span class="chip">Home Starter Recent ERA</span>
            <span class="chip">Away Starter Recent ERA</span>
            <span class="chip">Recent Form Advantage</span>
          </div>
        </div>
        <div class="feature-group">
          <div class="feature-group-label">Bullpen Fatigue</div>
          <div class="feature-chips">
            <span class="chip">Home Bullpen Fatigue (3-day)</span>
            <span class="chip">Away Bullpen Fatigue (3-day)</span>
          </div>
        </div>
        <div class="feature-group">
          <div class="feature-group-label">Umpire</div>
          <div class="feature-chips">
            <span class="chip">Umpire Run Factor</span>
          </div>
        </div>
      </div>`;
  } catch (err) {
    container.innerHTML = `<div class="error-state">Error: ${err.message}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function api(url, options = {}) {
  const key = localStorage.getItem('baseball-oracle-admin-key');
  if (key) {
    options.headers = { ...(options.headers || {}), 'X-Admin-Key': key };
  }
  const res = await fetch(url, options);
  if (res.status === 401) {
    const newKey = prompt('Enter admin key:');
    if (!newKey) throw new Error('Admin key required');
    localStorage.setItem('baseball-oracle-admin-key', newKey);
    return api(url, options); // retry with new key
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

function pct(v) { return `${(v * 100).toFixed(1)}%`; }

// ---------------------------------------------------------------------------
// FanDuel odds + Kelly sizing
// ---------------------------------------------------------------------------

function buildFanDuelSection(game) {
  const fd = game.fanduel;
  const k  = game.kelly;

  if (!fd) {
    return `<div class="odds-section odds-unavailable">
      <span class="odds-label">FANDUEL ODDS</span>
      <span class="odds-na">Not available</span>
    </div>`;
  }

  const fmt      = o => `${o > 0 ? '+' : ''}${o}`;
  const edge     = fd ? (game.homeProb - fd.homeProb) : 0;
  const edgePP   = Math.round(edge * 1000) / 10;
  const edgeCls  = Math.abs(edgePP) < 2 ? 'edge-neutral' : edgePP > 0 ? 'edge-positive' : 'edge-negative';
  const edgeLbl  = Math.abs(edgePP) < 2 ? 'EVEN' : `${edgePP > 0 ? '+' : ''}${edgePP}pp HOME`;

  let kellyHtml = '';
  if (k && k.bet) {
    const sideLbl  = k.side === 'home' ? game.homeTeamName : game.awayTeamName;
    const urgency  = k.betFraction >= 5 ? 'kelly-strong' : k.betFraction >= 2 ? 'kelly-moderate' : 'kelly-weak';
    kellyHtml = `
      <div class="kelly-row ${urgency}">
        <div class="kelly-left">
          <span class="kelly-label">KELLY BET</span>
          <span class="kelly-team">${sideLbl} (${fmt(k.odds)})</span>
        </div>
        <div class="kelly-right">
          <span class="kelly-fraction">${k.betFraction}%</span>
          <span class="kelly-sub">of bankroll</span>
        </div>
        <div class="kelly-detail">
          Blended prob ${pct(k.blendedProb)} vs market ${pct(k.marketProb)} · edge +${(k.edge*100).toFixed(1)}pp
        </div>
      </div>`;
  } else if (k && !k.bet) {
    kellyHtml = `<div class="kelly-row kelly-none">
      <span class="kelly-label">KELLY</span>
      <span class="kelly-no-edge">No edge over market</span>
    </div>`;
  }

  return `
    <div class="odds-section">
      <div class="odds-header">
        <span class="odds-label">FANDUEL</span>
        <span class="odds-col-heads">
          <span>AWAY / HOME IMPLIED</span>
          <span></span>
          <span>MODEL EDGE</span>
        </span>
      </div>
      <div class="odds-row">
        <div class="odds-source">
          <span class="odds-source-name">MONEYLINE</span>
          <span class="odds-source-sub">${fmt(fd.awayOdds)} / ${fmt(fd.homeOdds)}</span>
        </div>
        <div class="odds-probs">
          <span class="odds-prob-away">${pct(fd.awayProb)}</span>
          <span class="odds-sep">/</span>
          <span class="odds-prob-home">${pct(fd.homeProb)}</span>
        </div>
        <div class="odds-american"></div>
        <div class="odds-edge ${edgeCls}">${edgeLbl}</div>
      </div>
      ${kellyHtml}
    </div>`;
}

// ---------------------------------------------------------------------------
// Polymarket embed
// ---------------------------------------------------------------------------

// Slug format: mlb-{away_abbrev}-{home_abbrev}-{YYYY-MM-DD}
const TEAM_ABBREV = {
  'Arizona Diamondbacks':   'ari', 'Atlanta Braves':        'atl',
  'Baltimore Orioles':      'bal', 'Boston Red Sox':        'bos',
  'Chicago Cubs':           'chc', 'Chicago White Sox':     'cws',
  'Cincinnati Reds':        'cin', 'Cleveland Guardians':   'cle',
  'Colorado Rockies':       'col', 'Detroit Tigers':        'det',
  'Houston Astros':         'hou', 'Kansas City Royals':    'kc',
  'Los Angeles Angels':     'laa', 'Los Angeles Dodgers':   'lad',
  'Miami Marlins':          'mia', 'Milwaukee Brewers':     'mil',
  'Minnesota Twins':        'min', 'New York Mets':         'nym',
  'New York Yankees':       'nyy', 'Oakland Athletics':     'oak', 'Athletics':             'oak',
  'Philadelphia Phillies':  'phi', 'Pittsburgh Pirates':    'pit',
  'San Diego Padres':       'sd',  'San Francisco Giants':  'sf',
  'Seattle Mariners':       'sea', 'St. Louis Cardinals':   'stl',
  'Tampa Bay Rays':         'tb',  'Texas Rangers':         'tex',
  'Toronto Blue Jays':      'tor', 'Washington Nationals':  'wsh',
};

function buildOddsSection(game) {
  const awayAbbr = TEAM_ABBREV[game.awayTeamName];
  const homeAbbr = TEAM_ABBREV[game.homeTeamName];

  if (!awayAbbr || !homeAbbr) {
    return `<div class="odds-section odds-unavailable">
      <span class="odds-label">POLYMARKET</span>
      <span class="odds-na">No market found</span>
    </div>`;
  }

  const date = document.getElementById('datePicker').value;
  const slug = `mlb-${awayAbbr}-${homeAbbr}-${date}`;
  const embedUrl = `https://embed.polymarket.com/sports?market=${slug}&theme=dark&height=320`;
  const marketUrl = `https://polymarket.com/sports/mlb/${slug}`;

  return `
    <div class="poly-embed-wrap">
      <div class="odds-label" style="margin-bottom:6px">POLYMARKET <a href="${marketUrl}" target="_blank" class="poly-link" style="margin-left:8px">Open market ↗</a></div>
      <iframe
        src="${embedUrl}"
        width="100%"
        height="320"
        frameborder="0"
        allowtransparency="true"
        loading="lazy"
        style="border-radius:3px;display:block">
      </iframe>
    </div>`;
}

/**
 * Format the edge: how much the model's home probability
 * differs from the market's implied probability.
 * Positive = model thinks home team is more likely than market does.
 */
function formatEdge(diff) {
  const pp = Math.round(diff * 1000) / 10;  // percentage points, 1dp
  if (Math.abs(pp) < 2) return { label: 'EVEN', cls: 'edge-neutral' };
  if (pp > 0)           return { label: `+${pp}pp HOME`, cls: 'edge-positive' };
  return                       { label: `${pp}pp HOME`, cls: 'edge-negative' };
}

// ---------------------------------------------------------------------------
// Bet modal
// ---------------------------------------------------------------------------

let _betGame   = null;
let _betDate   = null;
let _betSide   = 'home';

const betModal      = document.getElementById('betModal');
const betCancelBtn  = document.getElementById('betCancelBtn');
const betSubmitBtn  = document.getElementById('betSubmitBtn');
const betOddsInput  = document.getElementById('betOddsInput');
const betAmountInput = document.getElementById('betAmountInput');

betCancelBtn.addEventListener('click', closeBetModal);
betModal.addEventListener('click', e => { if (e.target === betModal) closeBetModal(); });

betSubmitBtn.addEventListener('click', () => {
  const odds   = parseFloat(betOddsInput.value);
  const amount = parseFloat(betAmountInput.value);

  if (!betOddsInput.value || isNaN(odds)) {
    betOddsInput.focus(); return;
  }
  if (!betAmountInput.value || isNaN(amount) || amount <= 0) {
    betAmountInput.focus(); return;
  }

  betSubmitBtn.disabled    = true;
  betSubmitBtn.textContent = 'SAVING…';

  try {
    // Store bet in localStorage
    const bets = JSON.parse(localStorage.getItem('baseball-oracle-bets') || '[]');
    const bet = {
      id: `bet-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      placedAt: new Date().toISOString(),
      date: _betDate,
      homeTeam: _betGame.homeTeamName,
      awayTeam: _betGame.awayTeamName,
      betSide: _betSide,
      betTeam: _betSide === 'home' ? _betGame.homeTeamName : _betGame.awayTeamName,
      betOdds: odds,
      betAmount: amount,
    };
    bets.push(bet);
    localStorage.setItem('baseball-oracle-bets', JSON.stringify(bets));
    closeBetModal();
  } finally {
    betSubmitBtn.disabled    = false;
    betSubmitBtn.textContent = 'LOG BET';
  }
});

[betOddsInput, betAmountInput].forEach(el => el.addEventListener('input', updatePayoutPreview));

function openBetModal(game, date) {
  _betGame = game;
  _betDate = date;
  _betSide = game.predictedHome ? 'home' : 'away';

  document.getElementById('betModalMatchup').textContent =
    `${game.awayTeamName}  @  ${game.homeTeamName}`;

  // Build team selector buttons
  const btns = document.getElementById('betTeamBtns');
  btns.innerHTML = `
    <button class="bet-team-btn${_betSide === 'away' ? ' active' : ''}" data-side="away">
      <span class="bet-team-role">AWAY</span>
      <span class="bet-team-name">${game.awayTeamName}</span>
    </button>
    <span class="bet-at-sep">@</span>
    <button class="bet-team-btn${_betSide === 'home' ? ' active' : ''}" data-side="home">
      <span class="bet-team-role">HOME</span>
      <span class="bet-team-name">${game.homeTeamName}</span>
    </button>`;

  btns.querySelectorAll('.bet-team-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _betSide = btn.dataset.side;
      btns.querySelectorAll('.bet-team-btn').forEach(b => b.classList.toggle('active', b === btn));
      prefillOdds();
      updatePayoutPreview();
    });
  });

  prefillOdds();
  betAmountInput.value = '';
  updatePayoutPreview();
  betModal.classList.add('active');
  betAmountInput.focus();
}

function closeBetModal() {
  betModal.classList.remove('active');
  _betGame = null;
}

function prefillOdds() {
  if (!_betGame?.fanduel) { betOddsInput.value = ''; return; }
  const odds = _betSide === 'home' ? _betGame.fanduel.homeOdds : _betGame.fanduel.awayOdds;
  betOddsInput.value = odds ?? '';
}

function updatePayoutPreview() {
  const el     = document.getElementById('betPayoutPreview');
  const odds   = parseFloat(betOddsInput.value);
  const amount = parseFloat(betAmountInput.value);

  if (isNaN(odds) || isNaN(amount) || amount <= 0) {
    el.textContent = '';
    return;
  }

  const decimal = odds > 0 ? odds / 100 : 100 / Math.abs(odds);
  const toWin   = Math.round(amount * decimal * 100) / 100;
  const payout  = Math.round((amount + toWin) * 100) / 100;
  const team    = _betSide === 'home' ? _betGame?.homeTeamName : _betGame?.awayTeamName;
  el.textContent = `${team} wins → +$${toWin.toFixed(2)} (payout $${payout.toFixed(2)})`;
}

// ---------------------------------------------------------------------------
// Bet Tracker tab — all storage via localStorage
// ---------------------------------------------------------------------------

async function loadBets() {
  const container = document.getElementById('betsLog');
  container.innerHTML = '<div class="loading">LOADING BETS</div>';

  const rawBets = JSON.parse(localStorage.getItem('baseball-oracle-bets') || '[]');

  // Start with all bets as pending
  let bets = rawBets.map(b => ({ ...b, status: 'pending', pnl: null }));

  // Resolve outcomes against the accuracy log
  try {
    const data = await api('/api/accuracy');
    const logMap = new Map(
      (data.entries || []).map(e => [`${e.date}|${e.homeTeam}|${e.awayTeam}`, e])
    );
    bets = rawBets.map(bet => {
      const entry = logMap.get(`${bet.date}|${bet.homeTeam}|${bet.awayTeam}`);
      if (!entry) return { ...bet, status: 'pending', pnl: null };
      const betWon = (bet.betSide === 'home') === entry.actualHome;
      const decimal = bet.betOdds > 0 ? bet.betOdds / 100 : 100 / Math.abs(bet.betOdds);
      const pnl = betWon
        ? Math.round(bet.betAmount * decimal * 100) / 100
        : -bet.betAmount;
      return {
        ...bet,
        status: betWon ? 'won' : 'lost',
        pnl,
        actualHome: entry.actualHome,
        homeScore: entry.homeScore,
        awayScore: entry.awayScore,
      };
    });
  } catch { /* offline or no data — leave all as pending */ }

  // Compute stats
  const settled     = bets.filter(b => b.status !== 'pending');
  const won         = settled.filter(b => b.status === 'won');
  const netPnl      = settled.reduce((s, b) => s + b.pnl, 0);
  const totalWagered = bets.reduce((s, b) => s + b.betAmount, 0);

  // Update stat cards
  if (bets.length > 0) {
    const pnlEl = document.getElementById('betStatPnl');
    pnlEl.textContent = `${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}`;
    pnlEl.style.color = netPnl >= 0 ? 'var(--green)' : 'var(--red)';

    document.getElementById('betStatWinRate').textContent = settled.length
      ? `${(won.length / settled.length * 100).toFixed(1)}% (${won.length}/${settled.length})`
      : `— (${bets.filter(b => b.status === 'pending').length} pending)`;

    document.getElementById('betStatWagered').textContent = `$${totalWagered.toFixed(2)}`;

    const roiEl = document.getElementById('betStatRoi');
    const roi = totalWagered > 0 ? Math.round(netPnl / totalWagered * 10000) / 100 : 0;
    roiEl.textContent = `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`;
    roiEl.style.color = roi >= 0 ? 'var(--green)' : 'var(--red)';
  } else {
    ['betStatPnl', 'betStatWinRate', 'betStatWagered', 'betStatRoi'].forEach(id => {
      document.getElementById(id).textContent = '—';
    });
  }

  if (bets.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">💰</div><p>No bets logged yet — click LOG BET on any prediction card</p></div>`;
    return;
  }

  // Render table (most-recent first)
  const reversed = [...bets].reverse();

  const table = document.createElement('table');
  table.className = 'bets-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>DATE</th>
        <th>MATCHUP</th>
        <th>BET</th>
        <th>ODDS</th>
        <th>AMOUNT</th>
        <th>RESULT</th>
        <th>P&amp;L</th>
        <th></th>
      </tr>
    </thead>`;

  const tbody = document.createElement('tbody');
  for (const b of reversed) {
    const fmtOdds = b.betOdds > 0 ? `+${b.betOdds}` : `${b.betOdds}`;
    const score   = b.homeScore != null ? `${b.awayScore}–${b.homeScore}` : '';

    const statusHtml = b.status === 'pending'
      ? `<span class="bet-status bet-status-pending">PENDING</span>`
      : b.status === 'won'
        ? `<span class="bet-status bet-status-won">WON ${score}</span>`
        : `<span class="bet-status bet-status-lost">LOST ${score}</span>`;

    const pnlHtml = b.pnl == null ? '—'
      : b.pnl >= 0
        ? `<span class="bet-pnl bet-pnl-pos">+$${b.pnl.toFixed(2)}</span>`
        : `<span class="bet-pnl bet-pnl-neg">-$${Math.abs(b.pnl).toFixed(2)}</span>`;

    const tr = document.createElement('tr');
    tr.className = b.status === 'won' ? 'bet-won' : b.status === 'lost' ? 'bet-lost' : '';
    tr.innerHTML = `
      <td>${b.date}</td>
      <td class="bet-matchup-cell">${b.awayTeam} @ ${b.homeTeam}</td>
      <td class="bet-team-cell">${b.betTeam}</td>
      <td>${fmtOdds}</td>
      <td>$${b.betAmount.toFixed(2)}</td>
      <td>${statusHtml}</td>
      <td>${pnlHtml}</td>
      <td><button class="bet-delete-btn" data-id="${b.id}" title="Remove bet">×</button></td>`;
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  container.innerHTML = '';
  container.appendChild(table);

  // Delete handlers — update localStorage directly
  container.querySelectorAll('.bet-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('Remove this bet?')) return;
      const stored = JSON.parse(localStorage.getItem('baseball-oracle-bets') || '[]');
      localStorage.setItem('baseball-oracle-bets', JSON.stringify(stored.filter(b => b.id !== btn.dataset.id)));
      loadBets();
    });
  });
}
