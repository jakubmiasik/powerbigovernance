/*
 * Fabric Governance — shared UI components.
 *
 *   LocalTime   <time data-local-time datetime="…">  → shown in the viewer's time zone
 *   GlobalSearch  the top-bar combobox: pages this user can open, plus workspaces
 *   DataGrid    table[data-grid] → search, column filters, column chooser, pagination
 *   Drawer      .drawer[role=dialog] → contextual details without leaving the page
 *
 * Everything here is progressive enhancement over server-rendered markup: with
 * this file missing, every table still lists every row and every link still works.
 * Nothing here talks to the server, so it cannot widen what a user can see or do.
 */
(function () {
  'use strict';

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function readPref(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function writePref(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* not kept */ }
  }

  // ───────────────────────── LocalTime ─────────────────────────
  // The server renders UTC (it does not know the viewer's zone); the browser
  // rewrites it to local time and keeps the exact UTC value in the tooltip.
  function formatLocalTimes(root) {
    (root || document).querySelectorAll('time[data-local-time]').forEach(function (el) {
      var date = new Date(el.getAttribute('datetime'));
      if (isNaN(date.getTime())) return;
      el.textContent = date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      el.title = date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    });
  }

  // ───────────────────────── GlobalSearch ─────────────────────────
  // Searches the navigation the server rendered for this user, so it can only
  // ever offer pages the user is allowed to open.
  function initGlobalSearch() {
    var input = document.getElementById('globalSearch');
    var list = document.getElementById('globalSearchResults');
    if (!input || !list) return;

    var pages = Array.prototype.map.call(document.querySelectorAll('.sidebar-nav .sidebar-link'), function (link) {
      var icon = link.querySelector('i');
      return {
        label: (link.textContent || '').trim(),
        href: link.getAttribute('href'),
        icon: icon ? icon.className.replace(/\s*\bbi\b\s*/, ' ').trim() : 'bi-arrow-right',
        group: link.getAttribute('data-nav-group') || ''
      };
    });
    var canSearchWorkspaces = pages.some(function (p) { return p.href === '/workspaces'; });
    var options = [];
    var activeIndex = -1;

    function close() {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      activeIndex = -1;
    }

    function setActive(index) {
      var items = list.querySelectorAll('[role="option"]');
      if (!items.length) return;
      activeIndex = (index + items.length) % items.length;
      items.forEach(function (item, i) { item.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false'); });
      input.setAttribute('aria-activedescendant', items[activeIndex].id);
      items[activeIndex].scrollIntoView({ block: 'nearest' });
    }

    function render() {
      var term = input.value.trim().toLowerCase();
      var tokens = term.split(/\s+/).filter(Boolean);
      var matches = pages.filter(function (p) {
        var hay = (p.label + ' ' + p.group).toLowerCase();
        return tokens.every(function (t) { return hay.indexOf(t) !== -1; });
      }).slice(0, term ? 8 : 12);

      options = [];
      var html = '';
      if (term && canSearchWorkspaces) {
        options.push({ href: '/workspaces?q=' + encodeURIComponent(input.value.trim()) });
        html += '<li class="search-group" role="presentation">Workspaces</li>' +
          '<li class="search-result" role="option" id="gs-opt-0" aria-selected="false" data-index="0">' +
          '<i class="bi bi-collection" aria-hidden="true"></i><span>Find workspaces matching “' + escapeHtml(input.value.trim()) + '”</span>' +
          '<span class="search-hint">Workspace triage</span></li>';
      }
      if (matches.length) {
        html += '<li class="search-group" role="presentation">Pages</li>';
        matches.forEach(function (p) {
          var index = options.length;
          options.push({ href: p.href });
          html += '<li class="search-result" role="option" id="gs-opt-' + index + '" aria-selected="false" data-index="' + index + '">' +
            '<i class="bi ' + escapeHtml(p.icon) + '" aria-hidden="true"></i><span>' + escapeHtml(p.label) + '</span>' +
            '<span class="search-hint">' + escapeHtml(p.group) + '</span></li>';
        });
      }
      if (!options.length) {
        html = '<li class="search-empty" role="presentation">No page matches “' + escapeHtml(input.value.trim()) + '”.</li>';
      }
      list.innerHTML = html;
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      activeIndex = -1;
      if (options.length && term) setActive(0);
    }

    function go(index) {
      var option = options[index];
      if (option) window.location.href = option.href;
    }

    input.addEventListener('input', render);
    input.addEventListener('focus', render);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) render(); setActive(activeIndex + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIndex - 1); }
      else if (e.key === 'Enter') { if (activeIndex >= 0) { e.preventDefault(); go(activeIndex); } }
      else if (e.key === 'Escape') { if (!list.hidden) { e.preventDefault(); close(); } else { input.blur(); } }
    });
    list.addEventListener('mousedown', function (e) {
      var item = e.target.closest('[role="option"]');
      if (!item) return;
      e.preventDefault();
      go(Number(item.getAttribute('data-index')));
    });
    input.addEventListener('blur', function () { setTimeout(close, 120); });

    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        input.focus();
        input.select();
      }
    });
  }

  // ───────────────────────── Drawer ─────────────────────────
  var openDrawerState = null;

  function focusable(container) {
    return Array.prototype.filter.call(
      container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'),
      function (el) { return el.offsetParent !== null || el === document.activeElement; }
    );
  }

  var Drawer = {
    open: function (idOrEl, opener) {
      var drawer = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
      if (!drawer) return;
      if (openDrawerState && openDrawerState.drawer !== drawer) Drawer.close();
      var backdrop = document.createElement('div');
      backdrop.className = 'drawer-backdrop';
      backdrop.addEventListener('click', function () { Drawer.close(); });
      document.body.appendChild(backdrop);
      openDrawerState = { drawer: drawer, backdrop: backdrop, opener: opener || document.activeElement };
      drawer.removeAttribute('hidden');
      drawer.setAttribute('aria-hidden', 'false');
      document.body.classList.add('drawer-open');
      requestAnimationFrame(function () {
        backdrop.classList.add('is-open');
        drawer.classList.add('is-open');
        var target = drawer.querySelector('[data-drawer-autofocus]') || drawer.querySelector('.drawer-close') || drawer;
        target.focus();
      });
      drawer.dispatchEvent(new CustomEvent('drawer:open', { bubbles: true }));
    },
    close: function () {
      if (!openDrawerState) return;
      var state = openDrawerState;
      openDrawerState = null;
      state.drawer.classList.remove('is-open');
      state.drawer.setAttribute('aria-hidden', 'true');
      state.backdrop.classList.remove('is-open');
      document.body.classList.remove('drawer-open');
      setTimeout(function () { state.backdrop.remove(); }, 220);
      if (state.opener && typeof state.opener.focus === 'function' && document.contains(state.opener)) state.opener.focus();
      state.drawer.dispatchEvent(new CustomEvent('drawer:close', { bubbles: true }));
    },
    isOpen: function () { return !!openDrawerState; }
  };

  document.addEventListener('keydown', function (e) {
    if (!openDrawerState) return;
    // A Bootstrap modal opened from inside the drawer handles its own keys.
    if (document.querySelector('.modal.show')) return;
    if (e.key === 'Escape') { e.preventDefault(); Drawer.close(); return; }
    if (e.key === 'Tab') {
      var items = focusable(openDrawerState.drawer);
      if (!items.length) { e.preventDefault(); return; }
      var first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  document.addEventListener('click', function (e) {
    var closer = e.target.closest('[data-drawer-close]');
    if (closer) { e.preventDefault(); Drawer.close(); }
  });

  // ───────────────────────── DataGrid ─────────────────────────
  // Opt-in on table[data-grid]. Header attributes:
  //   data-col="key"          column can be shown/hidden from the Columns menu
  //   data-col-required       column cannot be hidden
  //   data-col-default="hidden"  hidden until the user turns it on
  //   data-col-default="wide"    shown by default only at ≥1920 px
  //   data-filter-col         adds a "<label>: All" select built from the column's values
  // Cell attribute data-filter-value overrides the text used for that filter.
  // Rows with data-filter supply the text the search matches.
  var grids = new Map();
  var PAGE_SIZES = [10, 25, 50, 100];

  function DataGrid(table) {
    this.table = table;
    this.id = table.id || ('grid-' + (grids.size + 1));
    this.tbody = table.tBodies[0];
    this.headers = Array.prototype.slice.call(table.querySelectorAll('thead th'));
    this.filters = {};
    this.columnFilters = {};
    this.page = 1;
    var savedSize = Number(readPref('grid-page-size:' + this.id));
    var defaultSize = Number(table.getAttribute('data-grid-page-size')) || 25;
    this.pageSize = PAGE_SIZES.indexOf(savedSize) !== -1 ? savedSize : defaultSize;
    this.term = '';
    this.build();
    this.applyColumns();
    this.refresh();
  }

  DataGrid.prototype.rows = function () {
    return Array.prototype.filter.call(this.tbody ? this.tbody.rows : [], function (row) {
      return !row.classList.contains('grid-empty') && !row.hasAttribute('data-grid-skip');
    });
  };

  DataGrid.prototype.build = function () {
    var self = this;
    var table = this.table;
    var container = table.closest('.table-responsive') || table;
    var label = table.getAttribute('data-grid-label') || 'rows';

    var toolbar = document.querySelector('[data-grid-toolbar-for="' + this.id + '"]');
    if (!toolbar) {
      toolbar = document.createElement('div');
      toolbar.className = 'grid-toolbar';
      container.parentNode.insertBefore(toolbar, container);
    } else {
      toolbar.classList.add('grid-toolbar');
    }
    this.toolbar = toolbar;

    // Search
    if (!table.hasAttribute('data-grid-no-search')) {
      var searchWrap = document.createElement('div');
      searchWrap.className = 'grid-search';
      var searchId = this.id + '-search';
      searchWrap.innerHTML = '<label class="visually-hidden" for="' + searchId + '">Search ' + escapeHtml(label) + '</label>' +
        '<i class="bi bi-search" aria-hidden="true"></i>' +
        '<input type="search" class="form-control form-control-sm" id="' + searchId + '" data-grid-search placeholder="' +
        escapeHtml(table.getAttribute('data-grid-search-placeholder') || ('Search ' + label)) + '" autocomplete="off">';
      toolbar.insertBefore(searchWrap, toolbar.firstChild);
      this.searchWrap = searchWrap;
      this.searchInput = searchWrap.querySelector('input');
      this.searchInput.addEventListener('input', function () {
        self.term = self.searchInput.value.trim().toLowerCase();
        self.page = 1;
        self.refresh();
      });
      var initial = table.getAttribute('data-grid-initial-search');
      if (initial) { this.searchInput.value = initial; this.term = initial.trim().toLowerCase(); }
    }

    // Column value filters sit right after the search; the page's own controls
    // (bulk actions and the like) follow a spacer on the right.
    var filterAnchor = this.searchWrap ? this.searchWrap.nextSibling : toolbar.firstChild;
    this.headers.forEach(function (th, index) {
      if (!th.hasAttribute('data-filter-col')) return;
      var name = (th.getAttribute('data-col-label') || th.textContent || '').trim();
      var values = {};
      self.rows().forEach(function (row) {
        var cell = row.cells[index];
        if (!cell) return;
        var value = (cell.getAttribute('data-filter-value') || cell.textContent || '').trim();
        if (value) values[value] = true;
      });
      var select = document.createElement('select');
      select.className = 'form-select form-select-sm';
      select.setAttribute('aria-label', 'Filter by ' + name);
      select.innerHTML = '<option value="">' + escapeHtml(name) + ': All</option>' +
        Object.keys(values).sort().map(function (v) { return '<option value="' + escapeHtml(v) + '">' + escapeHtml(v) + '</option>'; }).join('');
      select.addEventListener('change', function () {
        if (select.value) self.columnFilters[index] = select.value; else delete self.columnFilters[index];
        self.page = 1;
        self.refresh();
      });
      toolbar.insertBefore(select, filterAnchor);
    });

    var spacer = document.createElement('span');
    spacer.className = 'grid-spacer';
    toolbar.insertBefore(spacer, filterAnchor);

    this.countEl = document.createElement('span');
    this.countEl.className = 'grid-count';
    this.countEl.setAttribute('aria-live', 'polite');

    // Columns menu
    var toggleable = this.headers.filter(function (th) { return th.hasAttribute('data-col') && !th.hasAttribute('data-col-required'); });
    if (toggleable.length) {
      var saved = {};
      try { saved = JSON.parse(readPref('grid-cols:' + this.id) || '{}') || {}; } catch (e) { saved = {}; }
      this.hiddenCols = {};
      this.headers.forEach(function (th) {
        var key = th.getAttribute('data-col');
        if (!key || th.hasAttribute('data-col-required')) return;
        // "wide" columns start visible only on wide screens (≥1920 px), which is
        // where the extra width goes to more columns instead of wider ones.
        var preset = th.getAttribute('data-col-default');
        var hiddenByDefault = preset === 'hidden' || (preset === 'wide' && window.innerWidth < 1920);
        var hidden = Object.prototype.hasOwnProperty.call(saved, key) ? saved[key] === false : hiddenByDefault;
        if (hidden) self.hiddenCols[key] = true;
      });

      var dd = document.createElement('div');
      dd.className = 'dropdown';
      var menuId = this.id + '-columns';
      dd.innerHTML = '<button class="btn btn-sm btn-outline-secondary dropdown-toggle" type="button" data-bs-toggle="dropdown" data-bs-auto-close="outside" aria-expanded="false" aria-controls="' + menuId + '">' +
        '<i class="bi bi-layout-three-columns me-1" aria-hidden="true"></i>Columns</button>' +
        '<div class="dropdown-menu grid-columns-menu" id="' + menuId + '">' +
        toggleable.map(function (th) {
          var key = th.getAttribute('data-col');
          var name = (th.getAttribute('data-col-label') || th.textContent || key).trim();
          var cid = self.id + '-col-' + key;
          return '<div class="form-check"><input class="form-check-input" type="checkbox" id="' + cid + '" data-col-toggle="' + escapeHtml(key) + '"' +
            (self.hiddenCols[key] ? '' : ' checked') + '><label class="form-check-label" for="' + cid + '">' + escapeHtml(name) + '</label></div>';
        }).join('') + '</div>';
      dd.addEventListener('change', function (e) {
        var key = e.target.getAttribute('data-col-toggle');
        if (!key) return;
        if (e.target.checked) delete self.hiddenCols[key]; else self.hiddenCols[key] = true;
        var store = {};
        toggleable.forEach(function (th) { var k = th.getAttribute('data-col'); store[k] = !self.hiddenCols[k]; });
        writePref('grid-cols:' + self.id, JSON.stringify(store));
        self.applyColumns();
      });
      toolbar.appendChild(dd);
    }

    // Density: the same switch as the top bar, offered where tables are read
    var density = document.createElement('button');
    density.type = 'button';
    density.className = 'btn btn-sm btn-outline-secondary';
    density.setAttribute('data-density-toggle', '');
    density.addEventListener('click', function () { if (typeof window.toggleDensity === 'function') window.toggleDensity(); syncDensityButtons(); });
    toolbar.appendChild(density);
    syncDensityButtons();

    // Footer: page size and pager
    if (!table.hasAttribute('data-grid-no-paging')) {
      var footer = document.createElement('div');
      footer.className = 'grid-footer';
      var sizeId = this.id + '-pagesize';
      footer.innerHTML =
        '<div class="d-flex align-items-center gap-3 flex-wrap"><span data-count-slot></span><span class="d-flex align-items-center gap-2"><label for="' + sizeId + '" class="mb-0">Rows per page</label>' +
        '<select class="form-select form-select-sm" id="' + sizeId + '">' +
        PAGE_SIZES.map(function (n) { return '<option value="' + n + '"' + (n === self.pageSize ? ' selected' : '') + '>' + n + '</option>'; }).join('') +
        '</select></span></div>' +
        '<nav class="grid-pager" aria-label="Pagination">' +
        '<button type="button" class="btn btn-sm btn-outline-secondary" data-page="prev" aria-label="Previous page"><i class="bi bi-chevron-left" aria-hidden="true"></i></button>' +
        '<span class="px-2" data-page-label></span>' +
        '<button type="button" class="btn btn-sm btn-outline-secondary" data-page="next" aria-label="Next page"><i class="bi bi-chevron-right" aria-hidden="true"></i></button>' +
        '</nav>';
      container.parentNode.insertBefore(footer, container.nextSibling);
      footer.querySelector('[data-count-slot]').appendChild(this.countEl);
      footer.querySelector('select').addEventListener('change', function (e) {
        self.pageSize = Number(e.target.value);
        writePref('grid-page-size:' + self.id, String(self.pageSize));
        self.page = 1;
        self.refresh();
      });
      footer.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-page]');
        if (!btn) return;
        self.page += btn.getAttribute('data-page') === 'next' ? 1 : -1;
        self.refresh();
      });
      this.footer = footer;
    } else {
      toolbar.appendChild(this.countEl);
    }

    table.addEventListener('table:sorted', function () { self.refresh(); });
  };

  DataGrid.prototype.applyColumns = function () {
    var hidden = this.hiddenCols || {};
    var indexes = [];
    this.headers.forEach(function (th, i) {
      var key = th.getAttribute('data-col');
      var off = !!(key && hidden[key]);
      th.style.display = off ? 'none' : '';
      if (off) indexes.push(i);
    });
    var all = Array.prototype.slice.call(this.tbody ? this.tbody.rows : []);
    all.forEach(function (row) {
      if (row.classList.contains('grid-empty')) return;
      Array.prototype.forEach.call(row.cells, function (cell, i) {
        cell.style.display = indexes.indexOf(i) !== -1 ? 'none' : '';
      });
    });
    this.visibleColumnCount = this.headers.length - indexes.length;
  };

  DataGrid.prototype.setFilter = function (name, fn) {
    if (fn) this.filters[name] = fn; else delete this.filters[name];
    this.page = 1;
  };

  DataGrid.prototype.matches = function (row) {
    var self = this;
    if (this.term) {
      var text = (row.getAttribute('data-filter') || row.textContent || '').toLowerCase();
      if (text.indexOf(this.term) === -1) return false;
    }
    for (var index in this.columnFilters) {
      var cell = row.cells[index];
      var value = cell ? (cell.getAttribute('data-filter-value') || cell.textContent || '').trim() : '';
      if (value !== this.columnFilters[index]) return false;
    }
    return Object.keys(this.filters).every(function (name) { return self.filters[name](row); });
  };

  DataGrid.prototype.refresh = function () {
    var self = this;
    var rows = this.rows();
    var matched = rows.filter(function (row) { return self.matches(row); });
    var paging = !!this.footer;
    var size = paging ? this.pageSize : matched.length || 1;
    var pages = Math.max(1, Math.ceil(matched.length / size));
    this.page = Math.min(Math.max(1, this.page), pages);
    var start = (this.page - 1) * size;
    var onPage = paging ? matched.slice(start, start + size) : matched;
    var showSet = new Set(onPage);

    rows.forEach(function (row) { row.style.display = showSet.has(row) ? '' : 'none'; });

    var empty = this.tbody && this.tbody.querySelector('tr.grid-empty');
    if (!matched.length) {
      if (!empty && this.tbody) {
        empty = document.createElement('tr');
        empty.className = 'grid-empty';
        this.tbody.appendChild(empty);
      }
      if (empty) {
        var noun = this.table.getAttribute('data-grid-label') || 'rows';
        var msg = rows.length
          ? 'No ' + escapeHtml(noun) + ' match the current search and filters.'
          : escapeHtml(this.table.getAttribute('data-grid-empty') || ('No ' + noun + ' to show.'));
        empty.innerHTML = '<td colspan="' + (this.visibleColumnCount || this.headers.length) + '">' + msg + '</td>';
      }
    } else if (empty) {
      empty.remove();
    }

    var noun2 = this.table.getAttribute('data-grid-label') || 'rows';
    var from = matched.length ? start + 1 : 0;
    var to = start + onPage.length;
    this.countEl.textContent = (paging && matched.length > size ? from + '–' + to + ' of ' : '') + matched.length + ' ' + noun2 +
      (matched.length !== rows.length ? ' (of ' + rows.length + ')' : '');
    if (this.footer) {
      this.footer.querySelector('[data-page-label]').textContent = 'Page ' + this.page + ' of ' + pages;
      this.footer.querySelector('[data-page="prev"]').disabled = this.page <= 1;
      this.footer.querySelector('[data-page="next"]').disabled = this.page >= pages;
    }

    this.table.dispatchEvent(new CustomEvent('grid:render', {
      bubbles: true,
      detail: { total: rows.length, matched: matched.length, shown: onPage.length, page: this.page, pages: pages }
    }));
  };

  function syncDensityButtons() {
    var compact = document.documentElement.getAttribute('data-density') === 'compact';
    document.querySelectorAll('[data-density-toggle]').forEach(function (btn) {
      btn.innerHTML = '<i class="bi ' + (compact ? 'bi-distribute-horizontal' : 'bi-distribute-vertical') + ' me-1" aria-hidden="true"></i>' +
        (compact ? 'Compact' : 'Comfortable');
      btn.setAttribute('aria-label', 'Row density: ' + (compact ? 'compact' : 'comfortable') + '. Switch to ' + (compact ? 'comfortable' : 'compact'));
    });
  }
  new MutationObserver(syncDensityButtons).observe(document.documentElement, { attributes: true, attributeFilter: ['data-density'] });

  window.DataGrid = {
    init: function (table) {
      if (!table || grids.has(table)) return grids.get(table);
      var grid = new DataGrid(table);
      grids.set(table, grid);
      return grid;
    },
    get: function (tableOrId) {
      var table = typeof tableOrId === 'string' ? document.getElementById(tableOrId) : tableOrId;
      return table ? grids.get(table) || window.DataGrid.init(table) : null;
    }
  };
  window.Drawer = Drawer;
  window.escapeHtml = window.escapeHtml || escapeHtml;

  // ───────────────────────── Boot ─────────────────────────
  function boot() {
    formatLocalTimes();
    initGlobalSearch();
    document.querySelectorAll('table[data-grid]').forEach(function (table) { window.DataGrid.init(table); });

    // The mobile navigation overlay closes on Escape, like any other overlay.
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var sidebar = document.getElementById('appSidebar');
      if (sidebar && sidebar.classList.contains('show') && typeof window.toggleSidebar === 'function') window.toggleSidebar();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
