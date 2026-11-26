/*
 * Migration aid: draws the Bootstrap Icons used by pages that have not moved to
 * @podavo/ui yet with the matching Lucide icon, so every screen shares one icon
 * style today. Each <i class="bi bi-x"> gains data-lucide and keeps its classes;
 * if Lucide cannot load, or a name is unmapped, the Bootstrap glyph stays visible.
 *
 * Left alone on purpose: icons whose classes a page script rewrites later (the
 * chevrons in collapse toggles, the details tree). Replacing those with an <svg>
 * would leave the script editing an element that is no longer there.
 *
 * Remove a page's entries from the migration list as it adopts Lucide directly;
 * delete this file when no page uses Bootstrap Icons.
 */
(function () {
  'use strict';
  var MAP = {
    'activity': 'activity', 'archive': 'archive', 'arrow-clockwise': 'rotate-cw', 'arrow-counterclockwise': 'rotate-ccw',
    'arrow-down-circle': 'circle-arrow-down', 'arrow-left': 'arrow-left', 'arrow-left-right': 'arrow-left-right',
    'arrow-repeat': 'refresh-cw', 'arrow-return-right': 'corner-down-right', 'arrow-right': 'arrow-right',
    'arrow-right-circle': 'circle-arrow-right', 'bar-chart': 'chart-column', 'bar-chart-line-fill': 'chart-column',
    'book': 'book-open', 'box': 'box', 'box-arrow-down': 'download', 'box-arrow-in-right': 'log-in',
    'box-arrow-right': 'log-out', 'box-arrow-up-right': 'external-link', 'boxes': 'boxes', 'broadcast': 'radio',
    'building': 'building-2', 'calendar-check': 'calendar-check', 'calendar-event': 'calendar', 'calendar-plus': 'calendar-plus',
    'camera': 'camera', 'check': 'check', 'check-circle': 'circle-check', 'check-circle-fill': 'circle-check',
    'check-lg': 'check', 'check2': 'check', 'check2-all': 'check-check', 'check2-circle': 'circle-check-big',
    'check2-square': 'square-check', 'chevron-down': 'chevron-down', 'chevron-expand': 'chevrons-up-down',
    'chevron-left': 'chevron-left', 'chevron-right': 'chevron-right', 'chevron-up': 'chevron-up', 'circle': 'circle',
    'clipboard': 'clipboard', 'clipboard-check': 'clipboard-check', 'clipboard-data': 'clipboard-list',
    'clipboard2-check': 'scale', 'clock': 'clock', 'clock-history': 'history', 'cloud': 'cloud',
    'cloud-arrow-up': 'cloud-upload', 'cloud-download': 'cloud-download', 'collection': 'layers', 'dash-circle': 'circle-minus',
    'database': 'database', 'diagram-2': 'network', 'diagram-3': 'workflow', 'distribute-horizontal': 'rows-4',
    'distribute-vertical': 'rows-3', 'download': 'download', 'exclamation-octagon': 'octagon-alert',
    'exclamation-triangle': 'triangle-alert', 'eye': 'eye', 'file-earmark-bar-graph': 'file-text', 'file-earmark-x': 'file-x',
    'filetype-csv': 'file-spreadsheet', 'fingerprint': 'fingerprint', 'fire': 'flame', 'flag': 'flag',
    'folder2-open': 'folder-open', 'funnel': 'funnel', 'funnel-fill': 'funnel', 'gear': 'settings', 'gear-fill': 'settings',
    'gem': 'gem', 'graph-up': 'chart-line', 'graph-up-arrow': 'trending-up', 'grid': 'grid-3x3', 'grid-1x2': 'layout-dashboard',
    'grid-3x3': 'grid-3x3', 'grid-3x3-gap': 'grid-3x3', 'hdd': 'hard-drive', 'hdd-network': 'server', 'hexagon': 'hexagon',
    'hourglass-bottom': 'hourglass', 'hourglass-split': 'hourglass', 'hourglass-top': 'hourglass', 'house': 'house',
    'inbox': 'inbox', 'info-circle': 'info', 'info-circle-fill': 'info', 'key': 'key-round', 'keyboard': 'keyboard',
    'layers': 'layers', 'layout-sidebar-inset': 'panel-left', 'layout-sidebar-reverse': 'panel-right',
    'layout-three-columns': 'columns-3', 'lightbulb': 'lightbulb', 'lightning': 'zap', 'lightning-charge': 'zap',
    'link-45deg': 'link', 'list': 'menu', 'list-check': 'list-checks', 'list-ol': 'list-ordered', 'list-task': 'list-todo',
    'list-ul': 'list', 'lock': 'lock', 'lock-fill': 'lock', 'magic': 'wand-sparkles', 'moon': 'moon', 'patch-check': 'badge-check',
    'pause-circle': 'circle-pause', 'pause-fill': 'pause', 'pencil': 'pencil', 'pencil-square': 'square-pen',
    'people': 'users', 'people-fill': 'users', 'person': 'user', 'person-badge': 'user-cog', 'person-exclamation': 'user-round',
    'person-fill': 'user', 'person-lines-fill': 'contact', 'person-plus': 'user-plus', 'person-raised-hand': 'hand',
    'person-slash': 'user-x', 'person-x': 'user-x', 'pie-chart': 'chart-pie', 'play-circle': 'circle-play', 'play-fill': 'play',
    'plug': 'plug', 'plus': 'plus', 'plus-circle': 'circle-plus', 'plus-lg': 'plus', 'question-circle': 'circle-help',
    'record-circle': 'circle-dot', 'robot': 'bot', 'rocket': 'rocket', 'rulers': 'ruler', 'safe': 'vault', 'save': 'save',
    'search': 'search', 'server': 'server', 'shield-check': 'shield-check', 'shield-exclamation': 'shield-alert',
    'shield-lock': 'lock-keyhole', 'shield-plus': 'shield-plus', 'signpost': 'signpost', 'slash-circle': 'ban',
    'sliders': 'sliders-horizontal', 'sort-down': 'arrow-down-wide-narrow', 'speedometer2': 'gauge', 'sun': 'sun',
    'table': 'table', 'tag': 'tag', 'tags': 'tags', 'trash': 'trash-2', 'trash3': 'trash-2', 'type': 'type', 'upload': 'upload',
    'x': 'x', 'x-circle': 'circle-x', 'x-circle-fill': 'circle-x', 'x-lg': 'x'
  };
  var SKIP = '[data-no-lucide], .tree-chevron, [data-bs-toggle="collapse"] i, .spinner-border';

  function convert(root) {
    var icons = (root || document).querySelectorAll('i.bi:not([data-lucide])');
    for (var i = 0; i < icons.length; i++) {
      var el = icons[i];
      if (el.matches(SKIP)) continue;
      var m = /(?:^|\s)bi-([a-z0-9-]+)/.exec(el.className);
      if (m && MAP[m[1]]) {
        el.setAttribute('data-lucide', MAP[m[1]]);
        if (!el.hasAttribute('aria-label')) el.setAttribute('aria-hidden', 'true');
      }
    }
  }
  window.PodavoIconMap = MAP;
  if (window.Podavo && window.Podavo.icons) window.Podavo.icons.beforeRender(convert);
})();
