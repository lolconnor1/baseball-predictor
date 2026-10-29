'use strict';

/**
 * charts.js — small dependency-free SVG charts for the model pages.
 *
 * Every chart: hairline grid, thin marks, a hover/focus tooltip whose hit
 * targets are larger than the marks, and a "View as table" twin so no value
 * is only reachable by hovering. Labels go in with textContent, never innerHTML.
 */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function el(tag, attrs = {}, parent = null) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  function text(parent, x, y, str, attrs = {}) {
    const t = el('text', { x, y, ...attrs }, parent);
    t.textContent = str;
    return t;
  }

  function html(tag, className, str) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (str != null) node.textContent = str;
    return node;
  }

  // ── Tooltip ──────────────────────────────────────────────────────────
  const tooltip = {
    node: null,
    show(anchor, title, rows) {
      this.node ??= document.getElementById('tooltip');
      const n = this.node;
      n.replaceChildren();
      if (title) n.appendChild(html('div', 'tt-title', title));
      for (const r of rows) {
        const row = html('div', 'tt-row');
        if (r.color) {
          const key = html('span', 'tt-key');
          key.style.background = r.color;
          row.appendChild(key);
        }
        row.appendChild(html('span', 'tt-val', r.value));
        if (r.name) row.appendChild(html('span', 'tt-name', r.name));
        n.appendChild(row);
      }
      n.hidden = false;
      const box = n.getBoundingClientRect();
      let x, y;
      if (anchor.clientX != null) { x = anchor.clientX + 14; y = anchor.clientY + 14; }
      else { const r = anchor.getBoundingClientRect(); x = r.right + 8; y = r.top; }
      if (x + box.width > window.innerWidth - 8) x = Math.max(8, x - box.width - 28);
      if (y + box.height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - box.height - 8);
      n.style.left = `${x}px`;
      n.style.top  = `${y}px`;
    },
    hide() { if (this.node) this.node.hidden = true; },
  };

  // Wires hover + keyboard focus on a hit target
  function hover(target, onShow, onHide = () => {}) {
    target.setAttribute('tabindex', '0');
    target.addEventListener('pointermove', e => onShow(e));
    target.addEventListener('pointerleave', () => { tooltip.hide(); onHide(); });
    target.addEventListener('focus', () => onShow(target));
    target.addEventListener('blur', () => { tooltip.hide(); onHide(); });
  }

  // ── Shared pieces ────────────────────────────────────────────────────
  function legend(container, items) {
    const wrap = html('div', 'legend');
    for (const it of items) {
      const item = html('span', 'legend-item');
      const key = html('span', `legend-key${it.shape === 'dot' ? ' dot' : ''}`);
      key.style.background = it.color;
      item.append(key, document.createTextNode(it.label));
      wrap.appendChild(item);
    }
    container.appendChild(wrap);
  }

  function tableView(container, headers, rows) {
    const details = html('details', 'table-view');
    details.appendChild(html('summary', null, 'View as table'));
    const wrap = html('div', 'table-wrap');
    const table = html('table', 'log-table');
    const thead = table.createTHead().insertRow();
    for (const h of headers) {
      const th = html('th', null, h);
      th.scope = 'col';
      thead.appendChild(th);
    }
    const tbody = table.createTBody();
    for (const r of rows) {
      const tr = tbody.insertRow();
      for (const c of r) tr.insertCell().textContent = c;
    }
    wrap.appendChild(table);
    details.appendChild(wrap);
    container.appendChild(details);
  }

  function niceStep(span, target = 5) {
    const raw = span / target;
    const steps = [0.005, 0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5, 1];
    return steps.find(s => s >= raw) ?? raw;
  }

  function domain(values, pad = 0.01, step = null) {
    let lo = Math.min(...values) - pad, hi = Math.max(...values) + pad;
    const s = step ?? niceStep(hi - lo);
    lo = Math.floor(lo / s) * s; hi = Math.ceil(hi / s) * s;
    return { lo, hi, step: s };
  }

  function yAxis(svg, { lo, hi, step }, y, x0, x1, fmt) {
    for (let v = lo; v <= hi + 1e-9; v += step) {
      const yy = y(v);
      el('line', { x1: x0, x2: x1, y1: yy, y2: yy, class: Math.abs(v - lo) < 1e-9 ? 'axis' : 'gridline' }, svg);
      text(svg, x0 - 8, yy + 4, fmt(v), { 'text-anchor': 'end' });
    }
  }

  // Column path: 4px rounded data-end, square at the baseline
  function columnPath(x, w, yTop, yBase, r = 4) {
    const h = yBase - yTop;
    r = Math.min(r, w / 2, h);
    return `M${x},${yBase}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + w - r}Q${x + w},${yTop} ${x + w},${yTop + r}V${yBase}Z`;
  }

  function barPath(xBase, xEnd, y, h, r = 4) {
    const w = xEnd - xBase;
    r = Math.min(r, h / 2, w);
    return `M${xBase},${y}H${xEnd - r}Q${xEnd},${y} ${xEnd},${y + r}V${y + h - r}Q${xEnd},${y + h} ${xEnd - r},${y + h}H${xBase}Z`;
  }

  // Re-render on width change
  function responsive(container, draw) {
    let lastW = 0;
    const run = () => {
      const w = container.clientWidth;
      if (!w || w === lastW) return;
      lastW = w;
      draw(w);
    };
    new ResizeObserver(run).observe(container);
    run();
  }

  function mount(container) {
    container.replaceChildren();
    const plot = html('div');
    container.appendChild(plot);
    return plot;
  }

  // ── Line chart (time series, crosshair) ──────────────────────────────
  // opts: { labels: [..x labels..], series: [{ name, color, values }], format, height }
  function line(container, opts) {
    const { labels, series, format, height = 260, xFormat = s => s } = opts;
    container.replaceChildren();
    if (series.length > 1) legend(container, series.map(s => ({ label: s.name, color: s.color })));
    const plot = html('div');
    container.appendChild(plot);

    responsive(plot, W => {
      plot.replaceChildren();
      const m = { t: 10, r: 112, b: 28, l: 46 };
      const svg = el('svg', { viewBox: `0 0 ${W} ${height}`, role: 'img', 'aria-label': opts.ariaLabel ?? '' }, plot);
      const dom = domain(series.flatMap(s => s.values), 0.005);
      const n = labels.length;
      const x = i => m.l + (n === 1 ? 0 : (i / (n - 1)) * (W - m.l - m.r));
      const y = v => m.t + (1 - (v - dom.lo) / (dom.hi - dom.lo)) * (height - m.t - m.b);

      yAxis(svg, dom, y, m.l, W - m.r, format);
      const tickEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - m.l - m.r) / 90))));
      for (let i = 0; i < n; i += tickEvery) text(svg, x(i), height - 8, xFormat(labels[i]), { 'text-anchor': 'middle' });

      for (const s of series) {
        el('path', {
          d: s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join(''),
          fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
        }, svg);
        const last = s.values[n - 1];
        el('circle', { cx: x(n - 1), cy: y(last), r: 4, fill: s.color, stroke: css('--bg2'), 'stroke-width': 2 }, svg);
      }
      // End labels, nudged apart only if they'd overlap
      const ends = series.map(s => ({ s, y: y(s.values[n - 1]) })).sort((a, b) => a.y - b.y);
      for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
      for (const e of ends) {
        text(svg, x(n - 1) + 10, e.y + 4, `${format(e.s.values[n - 1])} ${e.s.short ?? ''}`.trim(), { class: 'label-strong' });
      }

      const cross = el('line', { y1: m.t, y2: height - m.b, class: 'crosshair', visibility: 'hidden' }, svg);
      const hit = el('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: height - m.t - m.b, class: 'hit' }, svg);
      let idx = n - 1;
      const showAt = (i, anchor) => {
        idx = i;
        cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
        cross.setAttribute('visibility', 'visible');
        tooltip.show(anchor, opts.tooltipTitle ? opts.tooltipTitle(i) : xFormat(labels[i]),
          series.map(s => ({ color: s.color, value: format(s.values[i]), name: s.name })));
      };
      hover(hit, e => {
        if (e.clientX == null) return showAt(idx, hit);
        const r = hit.getBoundingClientRect();
        const frac = (e.clientX - r.left) / r.width;
        showAt(Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1)))), e);
      }, () => cross.setAttribute('visibility', 'hidden'));
      hit.addEventListener('keydown', e => {
        if (e.key === 'ArrowRight') { showAt(Math.min(n - 1, idx + 1), hit); e.preventDefault(); }
        if (e.key === 'ArrowLeft')  { showAt(Math.max(0, idx - 1), hit); e.preventDefault(); }
      });
    });

    tableView(container, [opts.xTitle ?? '', ...series.map(s => s.name)],
      labels.map((l, i) => [xFormat(l), ...series.map(s => format(s.values[i]))]));
  }

  // ── Dumbbell: one category per column, model vs baseline ────────────
  // opts: { categories, primary: {name,color,values}, secondary: {name,color,values}, format, detail(i) }
  function dumbbell(container, opts) {
    const { categories, primary, secondary, format, height = 250 } = opts;
    container.replaceChildren();
    legend(container, [primary, secondary].map(s => ({ label: s.name, color: s.color, shape: 'dot' })));
    const plot = html('div');
    container.appendChild(plot);

    responsive(plot, W => {
      plot.replaceChildren();
      const m = { t: 22, r: 16, b: 28, l: 46 };
      const svg = el('svg', { viewBox: `0 0 ${W} ${height}`, role: 'img', 'aria-label': opts.ariaLabel ?? '' }, plot);
      const dom = domain([...primary.values, ...secondary.values], 0.01);
      const band = (W - m.l - m.r) / categories.length;
      const cx = i => m.l + band * (i + 0.5);
      const y = v => m.t + (1 - (v - dom.lo) / (dom.hi - dom.lo)) * (height - m.t - m.b);

      yAxis(svg, dom, y, m.l, W - m.r, format);
      categories.forEach((c, i) => {
        const g = el('g', {}, svg);
        el('line', { x1: cx(i), x2: cx(i), y1: y(primary.values[i]), y2: y(secondary.values[i]), stroke: css('--axis'), 'stroke-width': 2 }, g);
        el('circle', { cx: cx(i), cy: y(secondary.values[i]), r: 5, fill: secondary.color, stroke: css('--bg2'), 'stroke-width': 2 }, g);
        el('circle', { cx: cx(i), cy: y(primary.values[i]), r: 5, fill: primary.color, stroke: css('--bg2'), 'stroke-width': 2 }, g);
        const above = primary.values[i] >= secondary.values[i];
        text(svg, cx(i), y(primary.values[i]) + (above ? -11 : 19), format(primary.values[i]), { 'text-anchor': 'middle', class: 'label-strong' });
        text(svg, cx(i), height - 8, String(c), { 'text-anchor': 'middle' });
        const hit = el('rect', { x: cx(i) - band / 2, y: m.t, width: band, height: height - m.t - m.b, class: 'hit' }, svg);
        hover(hit, e => {
          g.classList.add('hovered');
          tooltip.show(e, String(c), [
            { color: primary.color, value: format(primary.values[i]), name: primary.name },
            { color: secondary.color, value: format(secondary.values[i]), name: secondary.name },
            ...(opts.detail ? opts.detail(i) : []),
          ]);
        }, () => g.classList.remove('hovered'));
      });
    });

    tableView(container, [opts.categoryTitle ?? '', primary.name, secondary.name, ...(opts.extraColumns?.headers ?? [])],
      categories.map((c, i) => [String(c), format(primary.values[i]), format(secondary.values[i]), ...(opts.extraColumns?.row(i) ?? [])]));
  }

  // ── Calibration (reliability) plot ───────────────────────────────────
  // opts: { bins: [{ lo, hi, predicted, actual, n }], color }
  function calibration(container, opts) {
    const { bins, color } = opts;
    const plot = mount(container);
    const pct = v => `${Math.round(v * 100)}%`;

    responsive(plot, W => {
      plot.replaceChildren();
      const size = Math.min(W, 420);
      const height = size;
      const m = { t: 10, r: 14, b: 40, l: 46 };
      const svg = el('svg', { viewBox: `0 0 ${W} ${height}`, role: 'img', 'aria-label': 'Calibration: predicted vs actual home win rate' }, plot);
      const all = bins.flatMap(b => [b.predicted, b.actual]);
      const dom = domain(all, 0.02, 0.1);
      const x = v => m.l + (v - dom.lo) / (dom.hi - dom.lo) * (W - m.l - m.r);
      const y = v => m.t + (1 - (v - dom.lo) / (dom.hi - dom.lo)) * (height - m.t - m.b);

      yAxis(svg, dom, y, m.l, W - m.r, pct);
      for (let v = dom.lo; v <= dom.hi + 1e-9; v += dom.step) text(svg, x(v), height - 22, pct(v), { 'text-anchor': 'middle' });
      text(svg, (m.l + W - m.r) / 2, height - 4, 'Predicted home win chance', { 'text-anchor': 'middle' });

      el('line', { x1: x(dom.lo), y1: y(dom.lo), x2: x(dom.hi), y2: y(dom.hi), class: 'ref' }, svg);
      text(svg, x(dom.hi) - 4, y(dom.hi) + 16, 'perfect calibration', { 'text-anchor': 'end' });

      el('path', {
        d: bins.map((b, i) => `${i ? 'L' : 'M'}${x(b.predicted)},${y(b.actual)}`).join(''),
        fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round',
      }, svg);
      for (const b of bins) {
        const dot = el('circle', { cx: x(b.predicted), cy: y(b.actual), r: 4.5, fill: color, stroke: css('--bg2'), 'stroke-width': 2 }, svg);
        const hit = el('circle', { cx: x(b.predicted), cy: y(b.actual), r: 13, class: 'hit' }, svg);
        hover(hit, e => {
          dot.classList.add('hovered');
          tooltip.show(e, `Predicted ${pct(b.lo)}–${pct(b.hi)}`, [
            { color, value: `${(b.actual * 100).toFixed(1)}%`, name: 'home team actually won' },
            { value: `${(b.predicted * 100).toFixed(1)}%`, name: 'average prediction' },
            { value: b.n.toLocaleString(), name: 'games' },
          ]);
        }, () => dot.classList.remove('hovered'));
      }
    });

    tableView(container, ['Predicted range', 'Avg prediction', 'Home won', 'Games'],
      bins.map(b => [`${pct(b.lo)}–${pct(b.hi)}`, `${(b.predicted * 100).toFixed(1)}%`, `${(b.actual * 100).toFixed(1)}%`, b.n.toLocaleString()]));
  }

  // ── Columns with interval whiskers ───────────────────────────────────
  // opts: { items: [{ label, sub, value, ci }], color, format, ref: { value, label } }
  function columns(container, opts) {
    const { items, color, format, ref, height = 260 } = opts;
    const plot = mount(container);

    responsive(plot, W => {
      plot.replaceChildren();
      // Right margin holds the reference line's label, clear of the columns
      const m = { t: 22, r: ref ? 64 : 12, b: 44, l: 46 };
      const svg = el('svg', { viewBox: `0 0 ${W} ${height}`, role: 'img', 'aria-label': opts.ariaLabel ?? '' }, plot);
      const vals = items.flatMap(it => it.ci ?? [it.value]).concat(ref ? [ref.value] : []);
      const dom = domain(vals, 0.01);
      dom.lo = Math.max(0, Math.min(dom.lo, 0.45));
      const band = (W - m.l - m.r) / items.length;
      const bw = Math.min(24, band * 0.5);
      const y = v => m.t + (1 - (v - dom.lo) / (dom.hi - dom.lo)) * (height - m.t - m.b);
      const base = y(dom.lo);

      yAxis(svg, dom, y, m.l, W - m.r, format);
      if (ref) {
        el('line', { x1: m.l, x2: W - m.r, y1: y(ref.value), y2: y(ref.value), class: 'ref' }, svg);
        text(svg, W - m.r + 6, y(ref.value) + 4, ref.label);
      }

      items.forEach((it, i) => {
        const cx = m.l + band * (i + 0.5);
        const g = el('g', {}, svg);
        el('path', { d: columnPath(cx - bw / 2, bw, y(it.value), base), fill: color }, g);
        if (it.ci) {
          el('line', { x1: cx, x2: cx, y1: y(it.ci[0]), y2: y(it.ci[1]), stroke: css('--text-dim'), 'stroke-width': 1 }, g);
          for (const v of it.ci) el('line', { x1: cx - 5, x2: cx + 5, y1: y(v), y2: y(v), stroke: css('--text-dim'), 'stroke-width': 1 }, g);
        }
        const top = it.ci ? y(it.ci[1]) : y(it.value);
        text(svg, cx, top - 7, format(it.value), { 'text-anchor': 'middle', class: 'label-strong' });
        text(svg, cx, height - 26, it.label, { 'text-anchor': 'middle' });
        if (it.sub) text(svg, cx, height - 10, it.sub, { 'text-anchor': 'middle' });
        const hit = el('rect', { x: cx - band / 2, y: m.t, width: band, height: height - m.t - m.b, class: 'hit' }, svg);
        hover(hit, e => {
          g.classList.add('hovered');
          tooltip.show(e, it.label, [
            { color, value: format(it.value), name: opts.valueName ?? '' },
            ...(it.ci ? [{ value: `${format(it.ci[0])} – ${format(it.ci[1])}`, name: '95% interval' }] : []),
            ...(it.tooltipExtra ?? []),
          ]);
        }, () => g.classList.remove('hovered'));
      });
    });

    tableView(container, opts.tableHeaders, items.map(opts.tableRow));
  }

  // ── Horizontal bars (ranked magnitudes) ──────────────────────────────
  // opts: { items: [{ label, value }], color, format }
  function bars(container, opts) {
    const { items, color, format } = opts;
    const plot = mount(container);
    const rowH = 30, bh = 14;

    responsive(plot, W => {
      plot.replaceChildren();
      const labelW = Math.min(190, W * 0.42);
      const m = { t: 4, r: 56, b: 4, l: labelW };
      const height = m.t + m.b + rowH * items.length;
      const svg = el('svg', { viewBox: `0 0 ${W} ${height}`, role: 'img', 'aria-label': opts.ariaLabel ?? '' }, plot);
      const max = Math.max(...items.map(it => it.value));
      const x = v => m.l + (v / max) * (W - m.l - m.r);
      el('line', { x1: m.l, x2: m.l, y1: m.t, y2: height - m.b, class: 'axis' }, svg);

      items.forEach((it, i) => {
        const yy = m.t + i * rowH;
        const g = el('g', {}, svg);
        text(svg, m.l - 10, yy + rowH / 2 + 4, it.label, { 'text-anchor': 'end', class: 'label-strong' });
        el('path', { d: barPath(m.l, Math.max(m.l + 2, x(it.value)), yy + (rowH - bh) / 2, bh), fill: color }, g);
        text(svg, x(it.value) + 8, yy + rowH / 2 + 4, format(it.value));
        const hit = el('rect', { x: 0, y: yy, width: W, height: rowH, class: 'hit' }, svg);
        hover(hit, e => {
          g.classList.add('hovered');
          tooltip.show(e, it.label, [{ color, value: format(it.value), name: opts.valueName ?? '' }, ...(it.tooltipExtra ?? [])]);
        }, () => g.classList.remove('hovered'));
      });
    });

    tableView(container, opts.tableHeaders ?? ['', ''], items.map(it => [it.label, format(it.value)]));
  }

  window.Charts = { line, dumbbell, calibration, columns, bars, css };
})();
