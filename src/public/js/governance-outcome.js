/*
 * Draws the Governance Outcome from /api/governance/summary.
 * Every value is set with textContent: nothing from the data is parsed as HTML.
 * Missing values show as "Unknown", never 0.
 */
(function () {
  'use strict';
  var root = document.getElementById('governanceOutcome');
  if (!root) return;
  var body = document.getElementById('goBody');
  var sub = document.getElementById('goSub');
  var tenantSelect = document.getElementById('goTenant');
  var regenerate = document.getElementById('goRegenerate');
  var tenantId = root.getAttribute('data-tenant-id');
  // The scan selected at the top of the page; another tenant picked here drops it.
  var runId = root.getAttribute('data-run-id') || '';

  // ── tiny DOM helpers ──
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') el.setAttribute('style', v);
      else el.setAttribute(k, v === true ? '' : String(v));
    });
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return el;
  }
  var SVGNS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, children) {
    var el = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, String(attrs[k])); });
    (children || []).forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }
  function num(v) { return v === null || v === undefined ? 'Unknown' : Number(v).toLocaleString('en-US'); }
  function utc(v) {
    if (!v) return 'Unknown';
    var d = new Date(v);
    if (isNaN(d.getTime())) return 'Unknown';
    return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  }
  function pct(v) { return v === null || v === undefined ? 'Unknown' : (v > 0 ? '+' : '') + v + '%'; }
  function badge(text, tone) { return h('span', { class: 'pd-badge pd-badge--' + tone, text: text }); }
  var SEV_TONE = { High: 'danger', Medium: 'warning', Low: 'info' };
  var STATUS_TONE = { 'Pass': 'success', 'Fail': 'danger', 'Potential risk': 'orange', 'Unknown': 'outline' };
  function card(title, icon, children, extraClass, meta) {
    return h('section', { class: 'pd-card go-card' + (extraClass ? ' ' + extraClass : '') }, [
      h('div', { class: 'pd-card-header' }, [
        h('h3', { class: 'pd-card-title' }, [h('i', { 'data-lucide': icon, 'aria-hidden': 'true' }), title]),
        meta ? h('span', { class: 'pd-card-meta', text: meta }) : null,
      ]),
    ].concat(children));
  }
  function table(caption, headers, rows, opts) {
    opts = opts || {};
    return h('div', { class: 'go-table-wrap' + (opts.scroll ? ' go-table-wrap--scroll' : '') }, [
      h('table', { class: 'pd-table go-table' }, [
        h('caption', { class: 'visually-hidden', text: caption }),
        h('thead', null, [h('tr', null, headers.map(function (hd) { return h('th', { scope: 'col', class: hd.num ? 'is-num' : null, text: hd.label }); }))]),
        h('tbody', null, rows),
      ]),
    ]);
  }
  function td(content, isNum, cls) {
    var cell = h('td', { class: [isNum ? 'is-num' : '', cls || ''].join(' ').trim() || null });
    if (content instanceof Node) cell.appendChild(content); else cell.textContent = content;
    return cell;
  }

  // ── sections ──
  function header(o) {
    var r = o.run;
    var dl = h('dl', { class: 'go-facts' }, []);
    [['Tenant', o.tenant.name || 'Unknown'], ['Tenant ID', o.tenant.id], ['Scan', r.label || ('#' + r.id)], ['Scan started', utc(r.startedAt)],
     ['Scan completed', utc(r.completedAt)], ['Run by', r.runBy || 'Unknown']].forEach(function (pair) {
      dl.appendChild(h('div', null, [h('dt', { text: pair[0] }), h('dd', { text: pair[1], class: pair[0] === 'Tenant ID' ? 'go-mono' : null })]));
    });
    var s1 = o.summary;
    return h('div', { class: 'pd-card go-header' }, [
      h('div', { class: 'go-header-top' }, [
        h('div', { class: 'go-asof' }, [h('strong', { text: 'Data as of ' + utc(o.dataAsOf) })]),
        h('div', { class: 'go-tally', role: 'list', 'aria-label': 'Findings by status' }, [
          h('span', { role: 'listitem' }, [badge(s1.potentialRisk + ' Potential risk', 'orange')]),
          h('span', { role: 'listitem' }, [badge(s1.fail + ' Fail', 'danger')]),
          h('span', { role: 'listitem' }, [badge(s1.unknown + ' Unknown', 'outline')]),
          h('span', { role: 'listitem' }, [badge(s1.pass + ' Pass', 'success')]),
        ]),
      ]),
      dl,
    ]);
  }

  function kpis(o) {
    var k = o.kpis;
    function tile(label, value, hint, icon) {
      return h('div', { class: 'pd-metric pd-metric--neutral' }, [
        h('span', { class: 'pd-metric-icon', 'aria-hidden': 'true' }, [h('i', { 'data-lucide': icon })]),
        h('span', { class: 'pd-metric-body' }, [
          h('span', { class: 'pd-metric-label', text: label }),
          h('span', { class: 'pd-metric-row' }, [
            h('span', { class: 'pd-metric-value' + (value === 'Unknown' || value === 'Not collected' ? ' is-unavailable' : ''), text: value }),
          ]),
          hint ? h('span', { class: 'go-metric-hint', text: hint }) : null,
        ]),
      ]);
    }
    var st = k.settings;
    var storage = k.storage;
    var storageValue = storage.status === 'Collected' ? Number(storage.raw).toLocaleString('en-US') : storage.status;
    var storageHint = storage.status === 'Collected'
      ? storage.unitsLabel + ' · ≈ ' + storage.approxGb + ' GB (approx.)'
      : (storage.status === 'Not collected' ? 'storage_scanned_count = 0' : null);
    return h('div', { class: 'go-kpis' }, [
      tile('Workspaces', num(k.workspaces), null, 'layers'),
      tile('Items', num(k.items), null, 'boxes'),
      tile('Users', num(k.users), num(k.creators) + ' creators · ' + num(k.explorers) + ' explorers', 'users'),
      tile('Capacities', num(k.capacities), null, 'cpu'),
      tile('Tenant settings', num(st.total), num(st.enabled) + ' enabled · ' + num(st.disabled) + ' disabled · ' + num(st.groupScoped) + ' group-scoped · ' + num(st.delegated) + ' delegated', 'sliders-horizontal'),
      tile('Storage', storageValue, storageHint, 'hard-drive'),
    ]);
  }

  function itemChart(o) {
    var known = o.itemTypes.filter(function (t) { return t.value !== null; });
    var max = known.reduce(function (m, t) { return Math.max(m, t.value); }, 0) || 1;
    var list = h('ul', { class: 'go-bars', 'aria-label': 'Items by type' }, o.itemTypes.map(function (t) {
      return h('li', null, [
        h('span', { class: 'go-bar-label', text: t.label }),
        h('span', { class: 'go-bar', 'aria-hidden': 'true' }, [h('span', { style: 'width:' + (t.value ? Math.max(1, Math.round(t.value / max * 100)) : 0) + '%' })]),
        h('span', { class: 'go-bar-value', text: num(t.value) }),
      ]);
    }));
    return card('Item types', 'chart-bar', [list]);
  }

  function smallTables(o) {
    var byType = table('Workspaces by type', [{ label: 'Type' }, { label: 'Workspaces', num: true }],
      o.workspacesByType.map(function (r) { return h('tr', null, [td(r.type), td(num(r.workspaces), true)]); }));
    var sku = table('Capacity SKU distribution for workspaces of type Workspace', [{ label: 'SKU' }, { label: 'Workspaces', num: true }, { label: 'Items', num: true }, { label: '% of items', num: true }],
      o.skus.map(function (r) { return h('tr', null, [td(r.sku), td(num(r.workspaces), true), td(num(r.items), true), td(r.pctItems === null ? 'Unknown' : r.pctItems + '%', true)]); }));
    return h('div', { class: 'go-two' }, [
      card('Workspaces by type', 'layout-grid', [byType]),
      card('Capacity SKU distribution', 'gauge', [sku], null, 'Workspaces of type Workspace'),
    ]);
  }

  function findings(o) {
    var rows = [];
    o.findings.forEach(function (f) {
      var ratio = f.count === null ? 'Unknown' : f.count + ' / ' + (f.denominator === null ? 'Unknown' : f.denominator);
      var affected = null;
      if (f.affected && f.affected.length) {
        affected = h('details', { class: 'go-affected' }, [
          h('summary', { text: f.affected.length + ' affected' }),
          h('ul', null, f.affected.map(function (a) {
            return h('li', null, [h('span', { text: a.name }), a.detail ? h('span', { class: 'go-dim', text: ' · ' + a.detail }) : null, a.id && a.id.indexOf('total_') !== 0 ? h('span', { class: 'go-dim go-mono', text: ' · ' + a.id }) : null]);
          })),
        ]);
      }
      rows.push(h('tr', { class: f.status === 'Pass' ? 'go-row-pass' : null }, [
        td(f.id, false, 'go-mono'),
        td(h('div', null, [h('div', { class: 'go-finding-title', text: f.title }), h('div', { class: 'go-dim', text: f.category + (f.detail ? ' · ' + f.detail : '') }), affected])),
        td(badge(f.severity, SEV_TONE[f.severity] || 'neutral')),
        td(badge(f.status, STATUS_TONE[f.status] || 'outline')),
        td(ratio, true),
      ]));
    });
    var t = o.meta.thresholds;
    return card('Findings', 'list-checks', [
      table('Findings from the fixed rules, most severe first', [{ label: 'ID' }, { label: 'Rule' }, { label: 'Severity' }, { label: 'Status' }, { label: 'Count / of', num: true }], rows),
      h('div', { class: 'pd-card-footer', text: 'Rules and thresholds come from the rules file (admin share ' + t.adminSharePct + '%, top-' + t.topWorkspacesCount + ' item share ' + t.topWorkspacesItemSharePct + '%, trend ±' + t.trendChangePct + '%). Pass means the rule found nothing; it is not a compliance statement.' }),
    ], 'go-findings', (o.run.label || '') + ' · data as of ' + utc(o.dataAsOf));
  }

  var RIGHT_CLASS = { Admin: 'go-r-admin', Member: 'go-r-member', Contributor: 'go-r-contributor', Viewer: 'go-r-viewer' };
  function access(o) {
    var a = o.access;
    if (!a.available) return card('Access', 'key-round', [h('div', { class: 'go-empty', text: 'Unknown: no completed tenant scan has access data.' })]);
    var max = a.byPrincipalType.reduce(function (m, t) { return Math.max(m, t.total); }, 0) || 1;
    var bars = h('ul', { class: 'go-stack' }, a.byPrincipalType.map(function (t) {
      var bar = h('span', { class: 'go-stack-bar', role: 'img', 'aria-label': t.principalType + ': ' + a.rights.map(function (r) { return r + ' ' + (t.byRight[r] || 0); }).join(', ') });
      var inner = h('span', { class: 'go-stack-fill', style: 'width:' + Math.max(2, Math.round(t.total / max * 100)) + '%' });
      a.rights.forEach(function (r) {
        var n = t.byRight[r] || 0;
        if (!n) return;
        inner.appendChild(h('span', { class: RIGHT_CLASS[r] || 'go-r-other', style: 'width:' + (n / t.total * 100).toFixed(2) + '%', title: r + ': ' + n }));
      });
      bar.appendChild(inner);
      return h('li', null, [h('span', { class: 'go-bar-label', text: t.principalType }), bar, h('span', { class: 'go-bar-value', text: num(t.total) })]);
    }));
    var legend = h('ul', { class: 'go-legend' }, a.rights.map(function (r) { return h('li', null, [h('span', { class: 'go-swatch ' + (RIGHT_CLASS[r] || 'go-r-other'), 'aria-hidden': 'true' }), r]); }));
    var facts = h('div', { class: 'go-access-facts' }, [
      h('div', null, [h('span', { class: 'go-big', text: a.adminSharePct === null ? 'Unknown' : a.adminSharePct + '%' }), h('span', { class: 'go-dim', text: ' Admin share · ' + num(a.adminAssignments) + ' of ' + num(a.totalAssignments) + ' assignments' })]),
      h('div', null, [h('span', { class: 'go-big', text: num(a.groupAssignments) }), h('span', { class: 'go-dim', text: ' group assignments' })]),
    ]);
    var banner = a.isLatestRun ? null : h('div', { class: 'go-banner', role: 'note', text: 'Access data from ' + a.label + ' (' + utc(a.completedAt) + '): ' + (o.run.label || 'the shown scan') + ' recorded no access, so access and F3 are read from the earlier scan.' });
    return card('Access', 'key-round', [banner, facts, bars, legend], null, 'As of ' + a.label);
  }

  function sparkline(metric, runs) {
    var vals = runs.map(function (r) { return r.values[metric.key]; });
    var known = vals.filter(function (v) { return v !== null; });
    var w = 240, hgt = 64, pad = 6;
    var min = Math.min.apply(null, known), max = Math.max.apply(null, known), range = (max - min) || 1;
    var step = runs.length > 1 ? (w - pad * 2) / (runs.length - 1) : 0;
    function xy(i, v) { return [(pad + i * step).toFixed(1), (hgt - pad - ((v - min) / range) * (hgt - pad * 2)).toFixed(1)]; }
    var pts = [];
    vals.forEach(function (v, i) { if (v !== null) pts.push(xy(i, v).join(',')); });
    var svg = s('svg', { viewBox: '0 0 ' + w + ' ' + hgt, width: '100%', height: hgt, role: 'img', 'aria-label': metric.label + ' per scan, oldest first: ' + runs.map(function (r, i) { return r.label + ' ' + (vals[i] === null ? 'Unknown' : vals[i]); }).join(', ') });
    svg.appendChild(s('polyline', { points: pts.join(' '), fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    runs.forEach(function (r, i) {
      if (vals[i] === null) return;
      var c = xy(i, vals[i]);
      var hit = r.changes[metric.key] && r.changes[metric.key].hit;
      svg.appendChild(s('circle', { cx: c[0], cy: c[1], r: hit ? 4.5 : 2.5, class: hit ? 'go-dot-hit' : 'go-dot' }));
    });
    var last = runs[runs.length - 1];
    var change = last.changes[metric.key];
    return h('figure', { class: 'go-spark' + (change && change.hit ? ' is-hit' : '') }, [
      h('figcaption', null, [h('span', { text: metric.label }), h('strong', { text: num(last.values[metric.key]) }), change ? h('span', { class: 'go-dim', text: pct(change.pct) }) : null]),
      svg,
    ]);
  }

  function trend(o) {
    var t = o.trend;
    if (t.runs.length < 2) return card('Trend', 'chart-line', [h('div', { class: 'go-empty', text: 'Unknown: fewer than two completed tenant scans have totals.' })]);
    var charts = h('div', { class: 'go-sparks' }, t.metrics.map(function (m) { return sparkline(m, t.runs); }));
    var headers = [{ label: 'Scan' }, { label: 'Completed (UTC)' }].concat(t.metrics.map(function (m) { return { label: m.label, num: true }; }));
    var rows = t.runs.map(function (r) {
      return h('tr', null, [td(r.label), td(utc(r.completedAt))].concat(t.metrics.map(function (m) {
        var c = r.changes[m.key];
        var cell = h('div', null, [h('div', { text: num(r.values[m.key]) })]);
        if (c) cell.appendChild(h('div', { class: 'go-dim', text: (c.abs === null ? 'Unknown' : (c.abs > 0 ? '+' : '') + c.abs) + ' · ' + pct(c.pct) }));
        return td(cell, true, c && c.hit ? 'go-cell-hit' : null);
      })));
    });
    return card('Trend across whole-tenant scans of ' + (o.run.principal || 'this principal'), 'chart-line', [
      charts,
      table('Totals per run with change against the previous run', headers, rows),
      h('div', { class: 'pd-card-footer', text: 'Scans of ' + (o.run.principal || 'this principal') + ' in scan-number order. Highlighted: a change of more than ±' + t.thresholdPct + '% against the same principal\'s previous scan (rule T1). A change from 0 has no percentage and shows as Unknown.' }),
    ], null, t.runs.length + ' scans');
  }

  function deletions(o) {
    var rows = o.deletions.map(function (d) { return h('tr', null, [td(d.workspaceName), td(d.state), td(utc(d.deletedAt)), td(d.scan || 'Unknown')]); });
    return card('Recorded workspace deletions', 'trash-2', [
      o.deletions.length ? table('Workspace deletions recorded for this tenant', [{ label: 'Workspace' }, { label: 'State' }, { label: 'Deleted (UTC)' }, { label: 'Scan' }], rows, { scroll: true })
        : h('div', { class: 'go-empty', text: 'No deletions recorded for this tenant.' }),
    ], null, o.deletions.length + ' recorded');
  }

  function gaps(o) {
    if (!o.gaps.length) return null;
    return h('section', { class: 'pd-card go-gaps', 'aria-labelledby': 'goGapsTitle' }, [
      h('div', { class: 'pd-card-header' }, [h('h3', { class: 'pd-card-title', id: 'goGapsTitle' }, [h('i', { 'data-lucide': 'triangle-alert', 'aria-hidden': 'true' }), 'Data gaps and limitations'])]),
      h('ul', null, o.gaps.map(function (g) { return h('li', { text: g.message }); })),
    ]);
  }

  function render(o) {
    body.textContent = '';
    var frag = document.createDocumentFragment();
    [header(o), kpis(o), h('div', { class: 'go-two' }, [itemChart(o), access(o)]), smallTables(o), findings(o), trend(o), deletions(o), gaps(o)]
      .forEach(function (part) { if (part) frag.appendChild(part); });
    body.appendChild(frag);
    var how = o.meta.trigger === 'after-scan' ? 'after the scan' : 'on demand';
    sub.textContent = 'Fixed rules over ' + (o.run.label || 'the selected scan') + (o.selection ? ' (shown for ' + o.selection.selectedLabel + ')' : '') + ' · generated ' + how + ' at ' + utc(o.meta.generatedAt) + (o.meta.cached ? ' (cached)' : '');
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons({ icons: window.lucide.icons, attrs: { 'aria-hidden': 'true', focusable: 'false' }, root: root });
  }

  function showState(kind, text) {
    body.textContent = '';
    var box = h('div', { class: 'pd-card go-state go-state--' + kind, role: kind === 'error' ? 'alert' : 'status' }, [
      kind === 'loading' ? h('span', { class: 'pd-spinner', 'aria-hidden': 'true' }) : null, ' ', text,
    ]);
    if (kind === 'loading') box.setAttribute('aria-busy', 'true');
    if (kind === 'error') {
      var retry = h('button', { type: 'button', class: 'pd-btn pd-btn--sm', text: 'Try again' });
      retry.addEventListener('click', function () { load(false); });
      box.appendChild(h('div', { class: 'go-state-actions' }, [retry]));
    }
    body.appendChild(box);
  }

  function load(force) {
    showState('loading', force ? 'Generating the governance outcome…' : 'Loading the governance outcome…');
    if (regenerate) regenerate.disabled = true;
    var url = '/api/governance/summary' + (force ? '/regenerate' : '') + '?tenantId=' + encodeURIComponent(tenantId) + (runId ? '&runId=' + encodeURIComponent(runId) : '');
    fetch(url, force ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin' } : { credentials: 'same-origin' })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) { return { status: res.status, data: data }; });
      })
      .then(function (r) {
        if (r.status === 200) return render(r.data);
        if (r.status === 404) return showState('empty', (r.data && r.data.error && r.data.error !== 'No completed tenant scan') ? r.data.error + '.' : 'No completed tenant scan for this tenant yet. Run a whole-tenant analysis and the outcome is generated as its last step.');
        if (r.status === 403) return showState('error', 'You do not have access to this tenant.');
        showState('error', (r.data && r.data.error) || 'The governance outcome could not be loaded.');
      })
      .catch(function () { showState('error', 'The governance outcome could not be loaded. Check your connection.'); })
      .then(function () { if (regenerate) regenerate.disabled = false; });
  }

  if (tenantSelect) tenantSelect.addEventListener('change', function () { tenantId = tenantSelect.value; runId = ''; load(false); });
  if (regenerate) regenerate.addEventListener('click', function () { load(true); });
  load(false);
})();
