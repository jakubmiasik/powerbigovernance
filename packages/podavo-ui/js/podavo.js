/*!
 * @podavo/ui — behaviour for the Podavo components. Framework-free, no build step.
 *
 *   Podavo.icons      Lucide icons: renders <i data-lucide="name">, re-renders injected markup
 *   Podavo.shell      AppShell: sidebar collapse, mobile navigation, theme, density
 *   Podavo.search     SearchField acting as a command palette over the navigation
 *   Podavo.drawer     Drawer: modal overlay, or docked beside content on wide screens
 *   Podavo.dialog     Dialog: native <dialog> with focus return
 *   Podavo.popover    Popover and Menu: [data-pd-popover] toggles, Esc / outside click close
 *   Podavo.tabs       Tabs: roving focus with arrow keys
 *   Podavo.grid       DataGrid: search, filters, columns, paging, export, density
 *   Podavo.localTime  <time data-local-time> in the viewer's time zone
 *
 * Every component is progressive enhancement over server-rendered markup and
 * none of them talk to a server, so they can never widen what a user may see.
 * Exposed as window.Podavo (and window.DataGrid / window.Drawer for older pages).
 */
(function (global) {
  'use strict';

  var Podavo = global.Podavo || {};
  Podavo.version = '1.0.0';

  // ─────────────────────────── helpers ───────────────────────────
  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function readPref(key) { try { return global.localStorage.getItem(key); } catch (e) { return null; } }
  function writePref(key, value) { try { global.localStorage.setItem(key, value); } catch (e) { /* not kept */ } }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function focusables(root) {
    return $all('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', root)
      .filter(function (el) { return el.offsetParent !== null || el === document.activeElement; });
  }
  function icon(name, cls) { return '<i data-lucide="' + escapeHtml(name) + '" class="' + (cls || '') + '" aria-hidden="true"></i>'; }
  Podavo.escapeHtml = escapeHtml;
  Podavo.iconHtml = icon;

  // ─────────────────────────── icons ───────────────────────────
  // Lucide replaces each <i data-lucide> with an inline <svg>. Hooks run first,
  // so a product can translate legacy markup (an older icon font, say) into
  // data-lucide before rendering. If Lucide failed to load, the markup is left
  // untouched, which keeps any fallback glyph visible.
  var iconHooks = [];
  var iconQueued = false;
  Podavo.icons = {
    beforeRender: function (fn) { iconHooks.push(fn); },
    render: function (root) {
      root = root || document.body;
      iconHooks.forEach(function (fn) { try { fn(root); } catch (e) { /* a hook must not stop rendering */ } });
      if (!global.lucide || typeof global.lucide.createIcons !== 'function') return;
      if (!root.querySelector || !root.querySelector('i[data-lucide]')) return;
      global.lucide.createIcons({ icons: global.lucide.icons, attrs: { 'aria-hidden': 'true', focusable: 'false' }, root: root });
    },
    queue: function () {
      if (iconQueued) return;
      iconQueued = true;
      (global.requestAnimationFrame || setTimeout)(function () { iconQueued = false; Podavo.icons.render(document.body); });
    }
  };

  // ─────────────────────────── shell ───────────────────────────
  var root = document.documentElement;
  Podavo.shell = {
    toggleNav: function () {
      var sidebar = $('.pd-sidebar');
      var backdrop = $('.pd-backdrop');
      var toggle = $('[data-pd-nav-toggle]');
      if (!sidebar) return;
      var open = sidebar.classList.toggle('is-open');
      if (backdrop) backdrop.classList.toggle('is-open', open);
      if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) { var first = $('.pd-nav-link', sidebar); if (first) first.focus(); }
      else if (toggle) toggle.focus();
    },
    toggleCollapse: function () {
      var collapsed = root.getAttribute('data-sidebar') !== 'collapsed';
      if (collapsed) root.setAttribute('data-sidebar', 'collapsed'); else root.removeAttribute('data-sidebar');
      writePref('pd-sidebar', collapsed ? 'collapsed' : 'expanded');
      Podavo.shell.sync();
    },
    toggleTheme: function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      root.setAttribute('data-bs-theme', next);
      writePref('pd-theme', next);
      Podavo.shell.sync();
      return next;
    },
    toggleDensity: function () {
      var next = root.getAttribute('data-density') === 'compact' ? 'comfortable' : 'compact';
      root.setAttribute('data-density', next);
      writePref('pd-density', next);
      Podavo.shell.sync();
      return next;
    },
    // Keeps every toggle's label, pressed state and icon in step with the page.
    sync: function () {
      var collapsed = root.getAttribute('data-sidebar') === 'collapsed';
      $all('[data-pd-collapse]').forEach(function (btn) {
        var label = collapsed ? 'Expand navigation' : 'Collapse navigation';
        btn.setAttribute('aria-label', label); btn.title = label;
        btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      });
      var dark = root.getAttribute('data-theme') === 'dark';
      $all('[data-pd-theme-toggle]').forEach(function (btn) {
        var label = dark ? 'Switch to light theme' : 'Switch to dark theme';
        btn.setAttribute('aria-label', label); btn.title = label + ' (Ctrl+Shift+D)';
        btn.innerHTML = icon(dark ? 'sun' : 'moon');
      });
      var compact = root.getAttribute('data-density') === 'compact';
      $all('[data-pd-density-toggle]').forEach(function (btn) {
        var label = compact ? 'Switch to comfortable rows' : 'Switch to compact rows';
        btn.setAttribute('aria-label', label); btn.title = label + ' (Ctrl+D)';
        btn.setAttribute('aria-pressed', compact ? 'true' : 'false');
        btn.innerHTML = icon(compact ? 'rows-4' : 'rows-3') + (btn.hasAttribute('data-pd-label') ? '<span>' + (compact ? 'Compact' : 'Comfortable') + '</span>' : '');
      });
      Podavo.icons.queue();
    }
  };
  // Applied before first paint by the inline head script in the AppShell; this
  // repeats it for pages that did not include that script.
  Podavo.shell.applyPreferences = function () {
    var theme = readPref('pd-theme') || readPref('pbi-gov-theme');
    if (theme === 'dark' || theme === 'light') { root.setAttribute('data-theme', theme); root.setAttribute('data-bs-theme', theme); }
    var density = readPref('pd-density') || readPref('pbi-gov-density');
    if (density === 'compact' || density === 'comfortable') root.setAttribute('data-density', density);
    if ((readPref('pd-sidebar') || readPref('pbi-gov-sidebar')) === 'collapsed') root.setAttribute('data-sidebar', 'collapsed');
  };

  // ─────────────────────────── search ───────────────────────────
  // A SearchField with role=combobox that offers the pages in the rendered
  // navigation (so only pages the user may open), plus optional "search in"
  // targets declared on the input: data-pd-search-targets='[{"label","href","hint","icon"}]'
  // where href contains {q}.
  Podavo.search = {
    init: function (input) {
      var list = document.getElementById(input.getAttribute('aria-controls'));
      if (!list) return;
      var pages = $all('.pd-sidebar .pd-nav-link').map(function (link) {
        var glyph = link.querySelector('[data-lucide], svg[data-lucide]');
        return {
          label: (link.textContent || '').trim(),
          href: link.getAttribute('href'),
          icon: glyph ? glyph.getAttribute('data-lucide') : 'arrow-right',
          group: link.getAttribute('data-nav-group') || ''
        };
      });
      var targets = [];
      try { targets = JSON.parse(input.getAttribute('data-pd-search-targets') || '[]'); } catch (e) { targets = []; }
      var options = [];
      var active = -1;

      function close() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; }
      function setActive(i) {
        var items = $all('[role="option"]', list);
        if (!items.length) return;
        active = (i + items.length) % items.length;
        items.forEach(function (el, n) { el.setAttribute('aria-selected', n === active ? 'true' : 'false'); });
        input.setAttribute('aria-activedescendant', items[active].id);
        items[active].scrollIntoView({ block: 'nearest' });
      }
      function render() {
        var raw = input.value.trim();
        var tokens = raw.toLowerCase().split(/\s+/).filter(Boolean);
        var matches = pages.filter(function (p) {
          var hay = (p.label + ' ' + p.group).toLowerCase();
          return tokens.every(function (t) { return hay.indexOf(t) !== -1; });
        }).slice(0, raw ? 8 : 12);
        options = [];
        var html = '';
        if (raw && targets.length) {
          html += '<li class="pd-listbox-group" role="presentation">Search</li>';
          targets.forEach(function (t) {
            var i = options.length;
            options.push(t.href.replace('{q}', encodeURIComponent(raw)));
            html += '<li class="pd-option" role="option" id="' + input.id + '-opt-' + i + '" data-index="' + i + '" aria-selected="false">' +
              icon(t.icon || 'search') + '<span>' + escapeHtml(t.label.replace('{q}', raw)) + '</span><span class="pd-option-hint">' + escapeHtml(t.hint || '') + '</span></li>';
          });
        }
        if (matches.length) {
          html += '<li class="pd-listbox-group" role="presentation">Pages</li>';
          matches.forEach(function (p) {
            var i = options.length;
            options.push(p.href);
            html += '<li class="pd-option" role="option" id="' + input.id + '-opt-' + i + '" data-index="' + i + '" aria-selected="false">' +
              icon(p.icon) + '<span>' + escapeHtml(p.label) + '</span><span class="pd-option-hint">' + escapeHtml(p.group) + '</span></li>';
          });
        }
        if (!options.length) html = '<li class="pd-listbox-empty" role="presentation">Nothing matches “' + escapeHtml(raw) + '”.</li>';
        list.innerHTML = html;
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        active = -1;
        if (raw && options.length) setActive(0);
        Podavo.icons.render(list);
      }
      function go(i) { if (options[i]) global.location.href = options[i]; }

      input.addEventListener('input', render);
      input.addEventListener('focus', render);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) render(); setActive(active + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
        else if (e.key === 'Enter') { if (active >= 0) { e.preventDefault(); go(active); } }
        else if (e.key === 'Escape') { if (!list.hidden) { e.preventDefault(); close(); } else input.blur(); }
      });
      list.addEventListener('mousedown', function (e) {
        var item = e.target.closest('[role="option"]');
        if (!item) return;
        e.preventDefault();
        go(Number(item.getAttribute('data-index')));
      });
      input.addEventListener('blur', function () { setTimeout(close, 120); });
    }
  };

  // ─────────────────────────── drawer ───────────────────────────
  // Below 1440 px (or without a .pd-dock parent) the drawer is a modal dialog:
  // focus moves in and is trapped, Escape closes, focus returns to the opener.
  // At ≥1440 px inside a .pd-dock it is docked beside the content instead: not
  // modal, nothing behind it is blocked, and the list stays usable.
  var openDrawer = null;
  function wantsDock(drawer) {
    var dock = drawer.parentElement && drawer.parentElement.classList.contains('pd-dock') ? drawer.parentElement : null;
    return dock && global.matchMedia && global.matchMedia('(min-width: 1440px)').matches ? dock : null;
  }
  Podavo.drawer = {
    open: function (idOrEl, opener) {
      var drawer = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
      if (!drawer) return;
      if (openDrawer && openDrawer.drawer !== drawer) Podavo.drawer.close({ keepFocus: true });
      var dock = wantsDock(drawer);
      var state = { drawer: drawer, opener: opener || document.activeElement, dock: dock, backdrop: null };
      if (openDrawer && openDrawer.drawer === drawer) { state.opener = openDrawer.opener; if (openDrawer.backdrop) state.backdrop = openDrawer.backdrop; }
      openDrawer = state;
      drawer.removeAttribute('hidden');
      drawer.setAttribute('aria-hidden', 'false');
      if (dock) {
        drawer.setAttribute('aria-modal', 'false');
        drawer.setAttribute('role', 'complementary');
        dock.classList.add('is-docked');
      } else {
        drawer.setAttribute('aria-modal', 'true');
        drawer.setAttribute('role', 'dialog');
        if (!state.backdrop) {
          state.backdrop = document.createElement('div');
          state.backdrop.className = 'pd-drawer-backdrop';
          state.backdrop.addEventListener('click', function () { Podavo.drawer.close(); });
          document.body.appendChild(state.backdrop);
        }
        document.body.classList.add('pd-drawer-open');
      }
      Podavo.icons.render(drawer);
      (global.requestAnimationFrame || setTimeout)(function () {
        if (state.backdrop) state.backdrop.classList.add('is-open');
        drawer.classList.add('is-open');
        if (!dock) {
          var target = drawer.querySelector('[data-pd-autofocus]') || drawer.querySelector('.pd-drawer-close') || drawer;
          target.focus();
        }
      });
      drawer.dispatchEvent(new CustomEvent('drawer:open', { bubbles: true, detail: { docked: !!dock } }));
    },
    close: function (opts) {
      if (!openDrawer) return;
      var state = openDrawer;
      openDrawer = null;
      state.drawer.classList.remove('is-open');
      state.drawer.setAttribute('aria-hidden', 'true');
      if (state.dock) state.dock.classList.remove('is-docked');
      if (state.backdrop) {
        state.backdrop.classList.remove('is-open');
        setTimeout(function () { state.backdrop.remove(); }, 200);
      }
      document.body.classList.remove('pd-drawer-open');
      if (!(opts && opts.keepFocus) && state.opener && document.contains(state.opener) && typeof state.opener.focus === 'function') state.opener.focus();
      state.drawer.dispatchEvent(new CustomEvent('drawer:close', { bubbles: true }));
    },
    isOpen: function () { return !!openDrawer; }
  };
  document.addEventListener('keydown', function (e) {
    if (!openDrawer || openDrawer.dock) return;
    if (document.querySelector('.modal.show, dialog[open]')) return; // a dialog above handles its own keys
    if (e.key === 'Escape') { e.preventDefault(); Podavo.drawer.close(); return; }
    if (e.key === 'Tab') {
      var items = focusables(openDrawer.drawer);
      if (!items.length) { e.preventDefault(); return; }
      var first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  document.addEventListener('keydown', function (e) {
    // A docked drawer still closes on Escape when focus is inside it.
    if (e.key === 'Escape' && openDrawer && openDrawer.dock && openDrawer.drawer.contains(document.activeElement)) Podavo.drawer.close();
  });

  // ─────────────────────────── dialog ───────────────────────────
  Podavo.dialog = {
    open: function (idOrEl, opener) {
      var dlg = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
      if (!dlg || typeof dlg.showModal !== 'function') return;
      dlg._pdOpener = opener || document.activeElement;
      dlg.showModal();
      Podavo.icons.render(dlg);
    },
    close: function (idOrEl) {
      var dlg = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
      if (dlg && dlg.open) dlg.close();
    }
  };
  document.addEventListener('close', function (e) {
    var dlg = e.target;
    if (dlg && dlg.tagName === 'DIALOG' && dlg._pdOpener && document.contains(dlg._pdOpener)) dlg._pdOpener.focus();
  }, true);

  // ─────────────────────────── popover / menu ───────────────────────────
  var openPopover = null;
  function closePopover(restoreFocus) {
    if (!openPopover) return;
    var p = openPopover;
    openPopover = null;
    p.panel.hidden = true;
    p.trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) p.trigger.focus();
  }
  Podavo.popover = {
    toggle: function (trigger) {
      var panel = document.getElementById(trigger.getAttribute('data-pd-popover'));
      if (!panel) return;
      if (openPopover && openPopover.panel === panel) { closePopover(true); return; }
      closePopover(false);
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      openPopover = { panel: panel, trigger: trigger };
      Podavo.icons.render(panel);
      var target = panel.querySelector('[data-pd-autofocus]') || focusables(panel)[0];
      if (target) target.focus();
    },
    close: closePopover
  };
  document.addEventListener('click', function (e) {
    var trigger = e.target.closest('[data-pd-popover]');
    if (trigger) { e.preventDefault(); Podavo.popover.toggle(trigger); return; }
    if (openPopover && !openPopover.panel.contains(e.target)) closePopover(false);
    if (e.target.closest('[data-pd-popover-close]')) closePopover(true);
    var drawerCloser = e.target.closest('[data-pd-drawer-close], [data-drawer-close]');
    if (drawerCloser) { e.preventDefault(); Podavo.drawer.close(); }
    var dialogOpener = e.target.closest('[data-pd-dialog-open]');
    if (dialogOpener) { e.preventDefault(); Podavo.dialog.open(dialogOpener.getAttribute('data-pd-dialog-open'), dialogOpener); }
    var dialogCloser = e.target.closest('[data-pd-dialog-close]');
    if (dialogCloser) { e.preventDefault(); Podavo.dialog.close(dialogCloser.closest('dialog')); }
    if (e.target.closest('[data-pd-nav-toggle]') || e.target.closest('.pd-backdrop')) Podavo.shell.toggleNav();
    if (e.target.closest('[data-pd-collapse]')) Podavo.shell.toggleCollapse();
  });
  document.addEventListener('keydown', function (e) {
    if (!openPopover) return;
    if (e.key === 'Escape') { e.preventDefault(); closePopover(true); return; }
    // Menus move focus with the arrow keys, like a native menu.
    if (openPopover.panel.getAttribute('role') === 'menu' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      var items = $all('[role="menuitem"]:not([disabled])', openPopover.panel);
      var i = items.indexOf(document.activeElement);
      var next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      if (items[next]) items[next].focus();
    }
  });

  // ─────────────────────────── tabs ───────────────────────────
  Podavo.tabs = {
    select: function (tab) {
      var list = tab.closest('[role="tablist"]');
      $all('[role="tab"]', list).forEach(function (t) {
        var on = t === tab;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.setAttribute('tabindex', on ? '0' : '-1');
        var panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.hidden = !on;
      });
      tab.dispatchEvent(new CustomEvent('tabs:change', { bubbles: true }));
    }
  };
  document.addEventListener('click', function (e) {
    var tab = e.target.closest('[role="tab"][aria-controls]');
    if (tab) Podavo.tabs.select(tab);
  });
  document.addEventListener('keydown', function (e) {
    var tab = e.target.closest && e.target.closest('[role="tab"][aria-controls]');
    if (!tab) return;
    var tabs = $all('[role="tab"]', tab.closest('[role="tablist"]'));
    var i = tabs.indexOf(tab);
    var next = null;
    if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
    else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === 'Home') next = tabs[0];
    else if (e.key === 'End') next = tabs[tabs.length - 1];
    if (next) { e.preventDefault(); next.focus(); Podavo.tabs.select(next); }
  });

  // ─────────────────────────── DataGrid ───────────────────────────
  // Opt-in on table[data-grid]. Header attributes:
  //   data-col="key"              can be shown/hidden from the Columns popover
  //   data-col-required           cannot be hidden
  //   data-col-default="hidden"   hidden until switched on;  ="wide": shown only at ≥1920 px
  //   data-filter-col             adds a "<label>: All" select built from the column's values
  //   data-no-export              left out of CSV export
  // Cells: data-filter-value (filter text), data-sort-value, data-export-value.
  // Rows: data-filter (search text); data-grid-skip excludes a row entirely.
  // The toolbar is built into [data-grid-toolbar-for="<table id>"] if present.
  var grids = new Map();
  var PAGE_SIZES = [10, 25, 50, 100];

  function Grid(table) {
    this.table = table;
    this.id = table.id || ('pd-grid-' + (grids.size + 1));
    this.tbody = table.tBodies[0];
    this.headers = $all('thead th', table);
    this.filters = {};
    this.columnFilters = {};
    this.page = 1;
    this.term = '';
    var saved = Number(readPref('grid-page-size:' + this.id));
    var preset = Number(table.getAttribute('data-grid-page-size')) || 25;
    this.pageSize = PAGE_SIZES.indexOf(saved) !== -1 ? saved : preset;
    this.noun = table.getAttribute('data-grid-label') || 'rows';
    this.build();
    this.applyColumns();
    this.refresh();
  }
  Grid.prototype.rows = function () {
    return Array.prototype.filter.call(this.tbody ? this.tbody.rows : [], function (r) {
      return !r.classList.contains('pd-grid-empty') && !r.hasAttribute('data-grid-skip');
    });
  };
  Grid.prototype.build = function () {
    var self = this;
    var table = this.table;
    var scroller = table.closest('.pd-grid-scroll, .table-responsive') || table;
    var toolbar = document.querySelector('[data-grid-toolbar-for="' + this.id + '"]');
    if (!toolbar) {
      toolbar = document.createElement('div');
      scroller.parentNode.insertBefore(toolbar, scroller);
    }
    toolbar.classList.add('pd-grid-toolbar');
    this.toolbar = toolbar;
    var firstPageControl = toolbar.firstChild;

    if (!table.hasAttribute('data-grid-no-search')) {
      var wrap = document.createElement('div');
      wrap.className = 'pd-search';
      var sid = this.id + '-search';
      wrap.innerHTML = '<label class="pd-visually-hidden" for="' + sid + '">Search ' + escapeHtml(this.noun) + '</label>' +
        icon('search', 'pd-search-icon') +
        '<input type="search" class="pd-input pd-input--sm" id="' + sid + '" data-grid-search autocomplete="off" placeholder="' +
        escapeHtml(table.getAttribute('data-grid-search-placeholder') || 'Search ' + this.noun) + '">';
      toolbar.insertBefore(wrap, firstPageControl);
      this.searchInput = wrap.querySelector('input');
      this.searchInput.addEventListener('input', function () { self.setSearch(self.searchInput.value); });
    }

    this.headers.forEach(function (th, index) {
      if (!th.hasAttribute('data-filter-col')) return;
      var name = (th.getAttribute('data-col-label') || th.textContent || '').trim();
      var values = {};
      self.rows().forEach(function (row) {
        var cell = row.cells[index];
        var v = cell ? (cell.getAttribute('data-filter-value') || cell.textContent || '').trim() : '';
        if (v) values[v] = true;
      });
      var order = (th.getAttribute('data-filter-order') || '').split('|').filter(Boolean);
      var keys = Object.keys(values).sort(function (a, b) {
        var ia = order.indexOf(a), ib = order.indexOf(b);
        if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        return a.localeCompare(b);
      });
      var select = document.createElement('select');
      select.className = 'pd-select pd-select--sm';
      select.style.width = 'auto';
      select.setAttribute('aria-label', 'Filter by ' + name);
      select.setAttribute('data-grid-filter', index);
      select.innerHTML = '<option value="">' + escapeHtml(name) + ': All</option>' +
        keys.map(function (v) { return '<option value="' + escapeHtml(v) + '">' + escapeHtml(v) + '</option>'; }).join('');
      select.addEventListener('change', function () {
        if (select.value) self.columnFilters[index] = select.value; else delete self.columnFilters[index];
        self.page = 1;
        self.refresh();
      });
      toolbar.insertBefore(select, firstPageControl);
    });

    var spacer = document.createElement('span');
    spacer.className = 'pd-grid-spacer';
    toolbar.insertBefore(spacer, firstPageControl);

    // Columns popover
    var toggleable = this.headers.filter(function (th) { return th.hasAttribute('data-col') && !th.hasAttribute('data-col-required'); });
    this.hiddenCols = {};
    if (toggleable.length) {
      var saved = {};
      try { saved = JSON.parse(readPref('grid-cols:' + this.id) || '{}') || {}; } catch (e) { saved = {}; }
      toggleable.forEach(function (th) {
        var key = th.getAttribute('data-col');
        var preset = th.getAttribute('data-col-default');
        var hiddenByDefault = preset === 'hidden' || (preset === 'wide' && global.innerWidth < 1920);
        if (Object.prototype.hasOwnProperty.call(saved, key) ? saved[key] === false : hiddenByDefault) self.hiddenCols[key] = true;
      });
      var anchor = document.createElement('div');
      anchor.className = 'pd-popover-anchor';
      var pid = this.id + '-columns';
      anchor.innerHTML = '<button type="button" class="pd-btn pd-btn--sm" data-pd-popover="' + pid + '" aria-expanded="false" aria-controls="' + pid + '">' +
        icon('columns-3') + '<span>Columns</span></button>' +
        '<div class="pd-popover pd-popover--end" id="' + pid + '" hidden role="group" aria-label="Visible columns">' +
        '<p class="pd-popover-title">Visible columns</p>' +
        toggleable.map(function (th) {
          var key = th.getAttribute('data-col');
          var label = (th.getAttribute('data-col-label') || th.textContent || key).trim();
          var cid = self.id + '-col-' + key;
          return '<label class="pd-menu-item" for="' + cid + '"><input type="checkbox" id="' + cid + '" data-col-toggle="' + escapeHtml(key) + '"' +
            (self.hiddenCols[key] ? '' : ' checked') + '> ' + escapeHtml(label) + '</label>';
        }).join('') + '</div>';
      anchor.addEventListener('change', function (e) {
        var key = e.target.getAttribute('data-col-toggle');
        if (!key) return;
        if (e.target.checked) delete self.hiddenCols[key]; else self.hiddenCols[key] = true;
        var store = {};
        toggleable.forEach(function (th) { var k = th.getAttribute('data-col'); store[k] = !self.hiddenCols[k]; });
        writePref('grid-cols:' + self.id, JSON.stringify(store));
        self.applyColumns();
      });
      toolbar.appendChild(anchor);
    }

    if (!table.hasAttribute('data-grid-no-export')) {
      var exp = document.createElement('button');
      exp.type = 'button';
      exp.className = 'pd-btn pd-btn--sm';
      exp.innerHTML = icon('download') + '<span>Export</span>';
      exp.title = 'Download the rows matching the current search and filters as CSV';
      exp.addEventListener('click', function () { self.exportCsv(); });
      toolbar.appendChild(exp);
    }

    var density = document.createElement('button');
    density.type = 'button';
    density.className = 'pd-icon-btn pd-icon-btn--outline';
    density.setAttribute('data-pd-density-toggle', '');
    density.addEventListener('click', function () {
      if (typeof global.toggleDensity === 'function') global.toggleDensity(); else Podavo.shell.toggleDensity();
    });
    toolbar.appendChild(density);

    this.countEl = document.createElement('span');
    this.countEl.setAttribute('aria-live', 'polite');
    if (!table.hasAttribute('data-grid-no-paging')) {
      var footer = document.createElement('div');
      footer.className = 'pd-grid-footer';
      var zid = this.id + '-size';
      footer.innerHTML = '<div class="pd-filterbar"><span data-count-slot></span>' +
        '<label for="' + zid + '" class="pd-visually-hidden">Rows per page</label>' +
        '<select class="pd-select pd-select--sm" style="width:auto" id="' + zid + '">' +
        PAGE_SIZES.map(function (n) { return '<option value="' + n + '"' + (n === self.pageSize ? ' selected' : '') + '>' + n + ' per page</option>'; }).join('') +
        '</select></div><nav class="pd-pager" aria-label="Pagination"></nav>';
      scroller.parentNode.insertBefore(footer, scroller.nextSibling);
      footer.querySelector('[data-count-slot]').appendChild(this.countEl);
      footer.querySelector('select').addEventListener('change', function (e) {
        self.pageSize = Number(e.target.value);
        writePref('grid-page-size:' + self.id, String(self.pageSize));
        self.page = 1;
        self.refresh();
      });
      footer.querySelector('.pd-pager').addEventListener('click', function (e) {
        var b = e.target.closest('[data-page]');
        if (!b || b.disabled) return;
        var v = b.getAttribute('data-page');
        self.page = v === 'prev' ? self.page - 1 : v === 'next' ? self.page + 1 : Number(v);
        self.refresh();
        var focusTarget = footer.querySelector('[aria-current="page"]');
        if (focusTarget) focusTarget.focus();
      });
      this.footer = footer;
    } else {
      toolbar.appendChild(this.countEl);
    }

    table.addEventListener('table:sorted', function () { self.refresh(); });
    Podavo.shell.sync();
  };
  Grid.prototype.setSearch = function (text) {
    if (this.searchInput && this.searchInput.value !== text) this.searchInput.value = text;
    this.term = String(text || '').trim().toLowerCase();
    this.page = 1;
    this.refresh();
  };
  Grid.prototype.applyColumns = function () {
    var hidden = this.hiddenCols || {};
    var off = [];
    this.headers.forEach(function (th, i) {
      var key = th.getAttribute('data-col');
      var isOff = !!(key && hidden[key]);
      th.style.display = isOff ? 'none' : '';
      if (isOff) off.push(i);
    });
    Array.prototype.forEach.call(this.tbody ? this.tbody.rows : [], function (row) {
      if (row.classList.contains('pd-grid-empty')) return;
      Array.prototype.forEach.call(row.cells, function (cell, i) { cell.style.display = off.indexOf(i) !== -1 ? 'none' : ''; });
    });
    this.visibleColumnCount = this.headers.length - off.length;
  };
  Grid.prototype.setFilter = function (name, fn) {
    if (fn) this.filters[name] = fn; else delete this.filters[name];
    this.page = 1;
  };
  Grid.prototype.matches = function (row) {
    var self = this;
    if (this.term) {
      var text = (row.getAttribute('data-filter') || row.textContent || '').toLowerCase();
      if (text.indexOf(this.term) === -1) return false;
    }
    for (var index in this.columnFilters) {
      var cell = row.cells[index];
      var v = cell ? (cell.getAttribute('data-filter-value') || cell.textContent || '').trim() : '';
      if (v !== this.columnFilters[index]) return false;
    }
    return Object.keys(this.filters).every(function (n) { return self.filters[n](row); });
  };
  Grid.prototype.matchedRows = function () {
    var self = this;
    return this.rows().filter(function (r) { return self.matches(r); });
  };
  Grid.prototype.refresh = function () {
    var rows = this.rows();
    var matched = this.matchedRows();
    var paging = !!this.footer;
    var size = paging ? this.pageSize : Math.max(matched.length, 1);
    var pages = Math.max(1, Math.ceil(matched.length / size));
    this.page = Math.min(Math.max(1, this.page), pages);
    var start = (this.page - 1) * size;
    var onPage = paging ? matched.slice(start, start + size) : matched;
    var shown = new Set(onPage);
    rows.forEach(function (r) { r.style.display = shown.has(r) ? '' : 'none'; });

    var empty = this.tbody && this.tbody.querySelector('tr.pd-grid-empty');
    if (!matched.length) {
      if (!empty && this.tbody) { empty = document.createElement('tr'); empty.className = 'pd-grid-empty'; this.tbody.appendChild(empty); }
      if (empty) {
        var msg = rows.length ? 'No ' + this.noun + ' match the current search and filters.'
          : (this.table.getAttribute('data-grid-empty') || 'No ' + this.noun + ' to show.');
        empty.innerHTML = '<td colspan="' + (this.visibleColumnCount || this.headers.length) + '">' + escapeHtml(msg) + '</td>';
      }
    } else if (empty) {
      empty.remove();
    }

    var from = matched.length ? start + 1 : 0;
    var to = start + onPage.length;
    this.countEl.textContent = 'Showing ' + from + '–' + to + ' of ' + matched.length + ' ' + this.noun +
      (matched.length !== rows.length ? ' (filtered from ' + rows.length + ')' : '');
    if (this.footer) this.renderPager(pages);

    this.table.dispatchEvent(new CustomEvent('grid:render', {
      bubbles: true,
      detail: { total: rows.length, matched: matched.length, shown: onPage.length, page: this.page, pages: pages }
    }));
  };
  Grid.prototype.renderPager = function (pages) {
    var page = this.page;
    var nums = [];
    for (var n = 1; n <= pages; n++) {
      if (n === 1 || n === pages || Math.abs(n - page) <= 1) nums.push(n);
      else if (nums[nums.length - 1] !== '…') nums.push('…');
    }
    var html = '<button type="button" class="pd-page-btn" data-page="prev" aria-label="Previous page"' + (page <= 1 ? ' disabled' : '') + '>' + icon('chevron-left') + '</button>';
    nums.forEach(function (n) {
      html += n === '…' ? '<span class="pd-page-gap" aria-hidden="true">…</span>'
        : '<button type="button" class="pd-page-btn" data-page="' + n + '" aria-label="Page ' + n + '"' + (n === page ? ' aria-current="page"' : '') + '>' + n + '</button>';
    });
    html += '<button type="button" class="pd-page-btn" data-page="next" aria-label="Next page"' + (page >= pages ? ' disabled' : '') + '>' + icon('chevron-right') + '</button>';
    this.footer.querySelector('.pd-pager').innerHTML = html;
    Podavo.icons.render(this.footer);
  };
  // CSV of the rows matching the current search and filters (every page), in
  // the columns currently shown. Built from what is already on screen: no request.
  Grid.prototype.exportCsv = function () {
    var self = this;
    var cols = [];
    this.headers.forEach(function (th, i) {
      if (th.style.display === 'none' || th.hasAttribute('data-no-export')) return;
      var label = (th.getAttribute('data-col-label') || th.textContent || '').trim();
      if (!label) return;
      cols.push({ i: i, label: label });
    });
    function cellText(cell) {
      if (!cell) return '';
      var v = cell.getAttribute('data-export-value');
      if (v === null) v = (cell.innerText || cell.textContent || '').replace(/\s+/g, ' ').trim();
      // Neutralise spreadsheet formulas (CSV injection).
      if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
      return '"' + v.replace(/"/g, '""') + '"';
    }
    var lines = [cols.map(function (c) { return '"' + c.label.replace(/"/g, '""') + '"'; }).join(',')];
    this.matchedRows().forEach(function (row) {
      lines.push(cols.map(function (c) { return cellText(row.cells[c.i]); }).join(','));
    });
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (self.table.getAttribute('data-grid-export-name') || self.id) + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  };

  Podavo.grid = {
    init: function (table) {
      if (!table) return null;
      if (grids.has(table)) return grids.get(table);
      var g = new Grid(table);
      grids.set(table, g);
      return g;
    },
    get: function (tableOrId) {
      var table = typeof tableOrId === 'string' ? document.getElementById(tableOrId) : tableOrId;
      return table ? (grids.get(table) || Podavo.grid.init(table)) : null;
    }
  };

  // ─────────────────────────── local time ───────────────────────────
  Podavo.localTime = function (scope) {
    $all('time[data-local-time]', scope).forEach(function (el) {
      var d = new Date(el.getAttribute('datetime'));
      if (isNaN(d.getTime())) return;
      el.textContent = d.toLocaleString(undefined, el.hasAttribute('data-date-only') ? { dateStyle: 'medium' } : { dateStyle: 'medium', timeStyle: 'short' });
      el.title = d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    });
  };

  // ─────────────────────────── boot ───────────────────────────
  function boot() {
    Podavo.localTime();
    $all('input[role="combobox"][data-pd-search]').forEach(Podavo.search.init);
    $all('table[data-grid]').forEach(function (t) { Podavo.grid.init(t); });
    Podavo.shell.sync();
    Podavo.icons.render(document.body);
    // Icons in markup added later (rows, results, messages) render as they arrive.
    if (global.MutationObserver) {
      new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var added = records[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (n.nodeType === 1 && (n.matches('i[data-lucide], i.bi') || n.querySelector('i[data-lucide], i.bi'))) { Podavo.icons.queue(); return; }
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    }
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        var input = $('input[role="combobox"][data-pd-search]');
        if (input) { e.preventDefault(); input.focus(); input.select(); }
      }
      if (e.key === 'Escape') {
        var sidebar = $('.pd-sidebar.is-open');
        if (sidebar) Podavo.shell.toggleNav();
      }
    });
    global.addEventListener('resize', function () {
      // Crossing the dock breakpoint re-opens the drawer in the right mode.
      if (!openDrawer) return;
      var shouldDock = !!wantsDock(openDrawer.drawer);
      if (shouldDock !== !!openDrawer.dock) {
        var d = openDrawer.drawer, o = openDrawer.opener;
        Podavo.drawer.close({ keepFocus: true });
        Podavo.drawer.open(d, o);
      }
    });
  }

  global.Podavo = Podavo;
  // Names older pages already use.
  global.DataGrid = global.DataGrid || Podavo.grid;
  global.Drawer = global.Drawer || Podavo.drawer;
  global.escapeHtml = global.escapeHtml || escapeHtml;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(window);
