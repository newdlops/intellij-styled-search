export function getRendererPatchScript(): string {
  return `
(function () {
  if (window.__ijFindPatchedV12) { return 'already patched'; }
  window.__ijFindPatchedV12 = true;

  function send(payload) {
    try { globalThis.irSearchEvent(JSON.stringify(payload)); } catch (e) {}
  }

  function el(tag, opts) {
    var e = document.createElement(tag);
    if (opts) {
      if (opts.className) { e.className = opts.className; }
      if (opts.text != null) { e.textContent = opts.text; }
      if (opts.title) { e.setAttribute('title', opts.title); }
      if (opts.attrs) {
        for (var k in opts.attrs) { e.setAttribute(k, opts.attrs[k]); }
      }
      if (opts.children) {
        for (var i = 0; i < opts.children.length; i++) {
          if (opts.children[i]) { e.appendChild(opts.children[i]); }
        }
      }
    }
    return e;
  }
  function clearChildren(node) {
    while (node.firstChild) { node.removeChild(node.firstChild); }
  }

  var style = document.createElement('style');
  style.textContent = [
    '.ij-find-overlay {',
    '  position: fixed; top: 60px; left: 50%;',
    '  transform: translateX(-50%);',
    '  width: 760px; max-width: calc(100vw - 40px);',
    '  height: 640px; max-height: calc(100vh - 100px);',
    '  min-width: 420px; min-height: 320px;',
    '  background: var(--vscode-editorWidget-background, #252526);',
    '  color: var(--vscode-foreground, #cccccc);',
    '  border: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, #454545));',
    '  border-radius: 6px;',
    '  box-shadow: 0 12px 48px rgba(0,0,0,0.6);',
    '  z-index: 2147483000;',
    '  display: none; flex-direction: column;',
    '  font-family: var(--vscode-font-family, system-ui, -apple-system, sans-serif);',
    '  font-size: var(--vscode-font-size, 13px);',
    '  overflow: hidden;',
    '}',
    '.ij-find-overlay.visible { display: flex; }',
    '.ij-find-resizer {',
    '  position: absolute; bottom: 0; right: 0;',
    '  width: 16px; height: 16px;',
    '  cursor: se-resize;',
    '  background:',
    '    linear-gradient(135deg,',
    '      transparent 50%,',
    '      var(--vscode-widget-border, #555) 50%, var(--vscode-widget-border, #555) 60%,',
    '      transparent 60%, transparent 70%,',
    '      var(--vscode-widget-border, #555) 70%, var(--vscode-widget-border, #555) 80%,',
    '      transparent 80%);',
    '  z-index: 5; opacity: 0.6;',
    '}',
    '.ij-find-resizer:hover { opacity: 1; }',

    '.ij-find-header {',
    '  display: flex; align-items: center; gap: 10px;',
    '  padding: 5px 10px;',
    '  background: var(--vscode-titleBar-activeBackground, #3c3c3c);',
    '  color: var(--vscode-titleBar-activeForeground, #cccccc);',
    '  cursor: move; user-select: none;',
    '  border-bottom: 1px solid var(--vscode-widget-border, transparent);',
    '  flex: 0 0 auto;',
    '}',
    '.ij-find-title { font-size: 12px; font-weight: 500; }',
    '.ij-find-summary { flex: 1; font-size: 11px; color: var(--vscode-descriptionForeground, #9d9d9d); }',
    '.ij-find-close {',
    '  background: transparent; border: none; color: inherit;',
    '  cursor: pointer; font-size: 16px; line-height: 1; padding: 2px 8px;',
    '  border-radius: 3px;',
    '}',
    '.ij-find-close:hover { background: rgba(255,255,255,0.12); }',

    '.ij-find-toolbar {',
    '  padding: 8px 10px 6px; flex: 0 0 auto;',
    '  border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));',
    '}',
    '.ij-find-search-row { display: flex; gap: 6px; align-items: center; }',
    '.ij-find-query {',
    '  flex: 1; padding: 5px 8px;',
    '  font-family: var(--vscode-editor-font-family, monospace);',
    '  font-size: 13px;',
    '  background: var(--vscode-input-background, #3c3c3c);',
    '  color: var(--vscode-input-foreground, #cccccc);',
    '  border: 1px solid var(--vscode-input-border, transparent);',
    '  border-radius: 2px; outline: none;',
    '}',
    '.ij-find-query:focus { border-color: var(--vscode-focusBorder, #007acc); }',
    '.ij-find-opts { display: flex; gap: 2px; }',
    '.ij-find-opt {',
    '  min-width: 26px; height: 26px; padding: 0 6px;',
    '  font-size: 11px;',
    '  font-family: var(--vscode-editor-font-family, monospace);',
    '  background: transparent;',
    '  color: var(--vscode-foreground, #cccccc);',
    '  border: 1px solid transparent;',
    '  border-radius: 3px; cursor: pointer;',
    '}',
    '.ij-find-opt:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08)); }',
    '.ij-find-opt[aria-pressed="true"] {',
    '  background: var(--vscode-inputOption-activeBackground, rgba(14,99,156,0.5));',
    '  color: var(--vscode-inputOption-activeForeground, #ffffff);',
    '  border-color: var(--vscode-inputOption-activeBorder, #007acc);',
    '}',
    '.ij-find-status-row {',
    '  margin-top: 6px; display: flex; align-items: center; gap: 8px;',
    '  font-size: 11px;',
    '  color: var(--vscode-descriptionForeground, #9d9d9d);',
    '  min-height: 14px;',
    '}',
    '.ij-find-spinner {',
    '  width: 10px; height: 10px;',
    '  border: 2px solid var(--vscode-descriptionForeground, #9d9d9d);',
    '  border-top-color: transparent; border-radius: 50%;',
    '  animation: ij-find-spin 0.8s linear infinite;',
    '}',
    '.ij-find-spinner.hidden { display: none; }',
    '@keyframes ij-find-spin { to { transform: rotate(360deg); } }',

    '.ij-find-results {',
    '  flex: 1 1 auto; overflow: auto; padding: 2px 0;',
    '  min-height: 60px;',
    '}',
    '.ij-find-row {',
    '  display: flex; align-items: center; gap: 12px;',
    '  padding: 1px 12px; cursor: pointer;',
    '  font-family: var(--vscode-editor-font-family, monospace);',
    '  font-size: 12px; line-height: 18px;',
    '}',
    '.ij-find-row:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.05)); }',
    '.ij-find-row.active {',
    '  background: var(--vscode-list-activeSelectionBackground, #094771);',
    '  color: var(--vscode-list-activeSelectionForeground, #ffffff);',
    '}',
    '.ij-find-row-text {',
    '  flex: 1 1 auto; min-width: 0;',
    '  overflow: hidden; text-overflow: ellipsis;',
    '  white-space: pre;',
    '}',
    '.ij-find-row-loc {',
    '  flex: 0 0 auto;',
    '  color: var(--vscode-descriptionForeground, #9d9d9d);',
    '  font-size: 11px;',
    '  font-family: var(--vscode-font-family, system-ui);',
    '  max-width: 280px;',
    '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
    '  text-align: right;',
    '}',
    '.ij-find-row.active .ij-find-row-loc { color: inherit; opacity: 0.85; }',
    // Stronger highlight palette so it stays visible on hover & active rows.
    '.ij-find-hl {',
    '  background: var(--vscode-editor-findMatchHighlightBackground, rgba(247,140,0,0.55));',
    '  color: var(--vscode-editor-findMatchHighlightForeground, var(--vscode-foreground, inherit));',
    '  border-radius: 2px;',
    '  box-shadow: inset 0 0 0 1px var(--vscode-editor-findMatchHighlightBorder, transparent);',
    '}',
    '.ij-find-row.active .ij-find-hl {',
    '  background: var(--vscode-editor-findMatchBackground, rgba(247,140,0,0.75));',
    '}',
    '.ij-find-empty {',
    '  padding: 20px;',
    '  color: var(--vscode-descriptionForeground, #9d9d9d);',
    '  text-align: center; font-size: 12px;',
    '}',

    '.ij-find-splitter {',
    '  flex: 0 0 4px;',
    '  background: var(--vscode-widget-border, var(--vscode-panel-border, transparent));',
    '  cursor: ns-resize; user-select: none;',
    '}',
    '.ij-find-splitter:hover, .ij-find-splitter.dragging {',
    '  background: var(--vscode-focusBorder, #007acc);',
    '}',

    '.ij-find-preview {',
    '  flex: 0 0 240px;',
    '  display: flex; flex-direction: column;',
    '  background: var(--vscode-editor-background, #1e1e1e);',
    '  min-height: 0;',
    '}',
    '.ij-find-preview-header {',
    '  padding: 4px 10px; flex: 0 0 auto;',
    '  font-size: 11px;',
    '  color: var(--vscode-descriptionForeground, #9d9d9d);',
    '  border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent));',
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
    '  user-select: none;',
    '}',
    '.ij-find-preview-body {',
    '  flex: 1 1 auto; overflow: auto;',
    '  font-family: var(--vscode-editor-font-family, monospace);',
    '  font-size: 12px; line-height: 18px;',
    '  padding: 4px 0;',
    '}',
    '.ij-find-preview-line {',
    '  display: flex; gap: 8px; padding: 0 10px; white-space: pre;',
    '  color: var(--vscode-editor-foreground, #d4d4d4);',
    '}',
    '.ij-find-preview-line.focus {',
    '  background: var(--vscode-editor-rangeHighlightBackground, rgba(255,255,255,0.06));',
    '}',
    '.ij-find-preview-lineno {',
    '  flex: 0 0 44px; text-align: right;',
    '  color: var(--vscode-editorLineNumber-foreground, #858585);',
    '  user-select: none;',
    '}',
    '.ij-find-preview-text { flex: 1 1 auto; min-width: 0; }',

    // Token classes for our fallback regex tokenizer.
    '.ij-tk-keyword { color: var(--vscode-symbolIcon-keywordForeground, #c586c0); }',
    '.ij-tk-string { color: var(--vscode-symbolIcon-stringForeground, #ce9178); }',
    '.ij-tk-number { color: var(--vscode-symbolIcon-numberForeground, #b5cea8); }',
    '.ij-tk-function { color: var(--vscode-symbolIcon-functionForeground, #dcdcaa); }',
    '.ij-tk-type { color: var(--vscode-symbolIcon-classForeground, #4ec9b0); }',
    '.ij-tk-comment { color: var(--vscode-disabledForeground, #6a9955); font-style: italic; }',

    '.ij-find-hover-tooltip {',
    '  position: fixed;',
    '  z-index: 2147483647;',
    '  padding: 8px 12px;',
    '  background: var(--vscode-editorHoverWidget-background, #252526);',
    '  color: var(--vscode-editorHoverWidget-foreground, #cccccc);',
    '  border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-widget-border, #454545));',
    '  border-radius: 4px;',
    '  box-shadow: 0 6px 18px rgba(0,0,0,0.45);',
    '  font-family: var(--vscode-font-family, system-ui);',
    '  font-size: 13px; line-height: 1.5;',
    '  max-width: 640px; max-height: 360px;',
    '  overflow: auto;',
    '  pointer-events: auto;',
    '  display: none;',
    '}',
    '.ij-find-hover-tooltip.visible { display: block; }',
    '.ij-md-group { padding: 2px 0; }',
    '.ij-md-sep {',
    '  height: 1px; margin: 6px -12px;',
    '  background: var(--vscode-editorHoverWidget-border, var(--vscode-widget-border, #454545));',
    '  border: none;',
    '}',
    '.ij-md-p { margin: 4px 0; white-space: pre-wrap; }',
    '.ij-md-h1, .ij-md-h2, .ij-md-h3, .ij-md-h4, .ij-md-h5, .ij-md-h6 {',
    '  margin: 4px 0; font-weight: 600;',
    '}',
    '.ij-md-h1 { font-size: 15px; }',
    '.ij-md-h2 { font-size: 14px; }',
    '.ij-md-h3, .ij-md-h4, .ij-md-h5, .ij-md-h6 { font-size: 13px; }',
    '.ij-md-pre {',
    '  margin: 4px 0; padding: 6px 8px;',
    '  background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.3));',
    '  border-radius: 3px; overflow: auto;',
    '  font-family: var(--vscode-editor-font-family, monospace);',
    '  font-size: 12px; line-height: 1.4;',
    '  white-space: pre;',
    '}',
    '.ij-md-pre code { font-family: inherit; }',
    '.ij-md-icode {',
    '  font-family: var(--vscode-editor-font-family, monospace);',
    '  background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.25));',
    '  color: var(--vscode-textPreformat-foreground, inherit);',
    '  padding: 1px 5px;',
    '  border-radius: 3px;',
    '  font-size: 12px;',
    '}',
    '.ij-md-link { color: var(--vscode-textLink-foreground, #3794ff); text-decoration: none; cursor: pointer; }',
    '.ij-md-link:hover { color: var(--vscode-textLink-activeForeground, #3794ff); text-decoration: underline; }',
    '.ij-md-cmdlink-disabled { color: var(--vscode-disabledForeground, #6f6f6f); text-decoration: line-through; cursor: not-allowed; }',
    '.ij-md-codicon { font-family: codicon; font-size: 14px; vertical-align: text-bottom; line-height: 1; }',
    '.ij-md-ul, .ij-md-ol { margin: 4px 0; padding-left: 22px; }',
    '.ij-md-li { margin: 2px 0; }',
    '.ij-md-hr {',
    '  height: 1px; margin: 8px 0; border: none;',
    '  background: var(--vscode-editorHoverWidget-border, var(--vscode-widget-border, #454545));',
    '}',
  ].join('\\n');
  document.head.appendChild(style);

  var $title = el('span', { className: 'ij-find-title', text: 'Find in Files' });
  var $summary = el('span', { className: 'ij-find-summary', text: '' });
  var $close = el('button', { className: 'ij-find-close', title: 'Close (Esc)', text: '\\u00D7' });
  var $header = el('div', { className: 'ij-find-header', children: [$title, $summary, $close] });

  var $q = el('input', {
    className: 'ij-find-query',
    attrs: { type: 'text', placeholder: 'Search in project...', spellcheck: 'false', autocomplete: 'off' },
  });
  var $optCase = el('button', { className: 'ij-find-opt', title: 'Match Case (Alt+C)', text: 'Aa', attrs: { 'data-opt': 'caseSensitive', 'aria-pressed': 'false' } });
  var $optWord = el('button', { className: 'ij-find-opt', title: 'Whole Word (Alt+W)', text: 'W', attrs: { 'data-opt': 'wholeWord', 'aria-pressed': 'false' } });
  var $optRegex = el('button', { className: 'ij-find-opt', title: 'Regex (Alt+R)', text: '.*', attrs: { 'data-opt': 'useRegex', 'aria-pressed': 'false' } });
  var $opts = el('div', { className: 'ij-find-opts', children: [$optCase, $optWord, $optRegex] });
  var $searchRow = el('div', { className: 'ij-find-search-row', children: [$q, $opts] });

  var $status = el('span', { className: 'ij-find-status', text: 'Type a query' });
  var $spinner = el('span', { className: 'ij-find-spinner hidden' });
  var $statusRow = el('div', { className: 'ij-find-status-row', children: [$status, $spinner] });

  var $toolbar = el('div', { className: 'ij-find-toolbar', children: [$searchRow, $statusRow] });
  var $results = el('div', { className: 'ij-find-results', attrs: { tabindex: '0' } });
  var $splitter = el('div', { className: 'ij-find-splitter', title: 'Drag to resize' });

  var $previewHeader = el('div', { className: 'ij-find-preview-header', text: '' });
  var $previewBody = el('div', { className: 'ij-find-preview-body' });
  var $preview = el('div', { className: 'ij-find-preview', children: [$previewHeader, $previewBody] });

  var $resizer = el('div', { className: 'ij-find-resizer', title: 'Drag to resize panel' });

  var panel = el('div', {
    className: 'ij-find-overlay',
    children: [$header, $toolbar, $results, $splitter, $preview, $resizer],
  });
  document.body.appendChild(panel);

  var $hoverTooltip = el('div', { className: 'ij-find-hover-tooltip' });
  document.body.appendChild($hoverTooltip);

  var state = {
    options: { caseSensitive: false, wholeWord: false, useRegex: false },
    files: [],
    flat: [],
    activeIndex: -1,
    searching: false,
    debounce: null,
    lastPreviewKey: '',
    previewUri: '',
    previewLanguageId: '',
    hoverReqId: 0,
    hoverTimer: null,
    lastHoverKey: '',
  };

  function setStatus(text, spinning) {
    $status.textContent = text;
    $spinner.classList.toggle('hidden', !spinning);
  }
  function setSummary() {
    var files = state.files.length;
    var matches = 0;
    for (var i = 0; i < files; i++) { matches += state.files[i].matches.length; }
    if (matches === 0) { $summary.textContent = ''; return; }
    if (state.searching) {
      $summary.textContent = matches + '+ matches in ' + files + ' file' + (files === 1 ? '' : 's');
    } else {
      $summary.textContent = matches + ' result' + (matches === 1 ? '' : 's') + ' in ' + files + ' file' + (files === 1 ? '' : 's');
    }
  }

  function appendHighlightedInto(container, text, ranges) {
    if (!ranges || ranges.length === 0) {
      container.appendChild(document.createTextNode(text));
      return;
    }
    var sorted = ranges.slice().sort(function (a, b) { return a.start - b.start; });
    var pos = 0;
    var painted = 0;
    for (var i = 0; i < sorted.length; i++) {
      var r = sorted[i];
      if (!r || r.end <= r.start) { continue; }       // skip zero/negative-width
      if (r.start < pos) { continue; }                // skip overlap
      if (r.start > pos) { container.appendChild(document.createTextNode(text.slice(pos, r.start))); }
      var slice = text.slice(r.start, Math.min(r.end, text.length));
      if (slice.length > 0) {
        container.appendChild(el('span', { className: 'ij-find-hl', text: slice }));
        painted++;
      }
      pos = Math.min(r.end, text.length);
    }
    if (pos < text.length) { container.appendChild(document.createTextNode(text.slice(pos))); }
    if (painted === 0 && ranges.length > 0) {
      // Surface unexpected cases (e.g. malformed range) so it shows up in logs.
      send({ type: 'log', msg: 'paint=0 ranges=' + JSON.stringify(ranges).slice(0, 120) + ' textLen=' + text.length });
    }
  }

  function clearPreview() {
    $previewHeader.textContent = '';
    clearChildren($previewBody);
    state.lastPreviewKey = '';
    state.previewUri = '';
    state.previewLanguageId = '';
    hideHover();
  }

  function render() {
    clearChildren($results);
    if (state.files.length === 0) {
      var emptyText = state.searching
        ? 'Searching...'
        : ($q.value ? 'No results' : 'Type to search');
      $results.appendChild(el('div', { className: 'ij-find-empty', text: emptyText }));
      state.flat = [];
      setSummary();
      return;
    }
    state.flat = [];
    var frag = document.createDocumentFragment();
    for (var fi = 0; fi < state.files.length; fi++) {
      var f = state.files[fi];
      for (var mi = 0; mi < f.matches.length; mi++) {
        var m = f.matches[mi];
        var flatIdx = state.flat.length;
        state.flat.push({ fi: fi, mi: mi });

        var textEl = el('span', { className: 'ij-find-row-text' });
        appendHighlightedInto(textEl, m.preview, m.ranges);

        var locText = f.relPath + ':' + (m.line + 1);
        var locEl = el('span', { className: 'ij-find-row-loc', title: locText, text: locText });

        frag.appendChild(el('div', {
          className: 'ij-find-row',
          attrs: { 'data-flat': String(flatIdx) },
          children: [textEl, locEl],
        }));
      }
    }
    $results.appendChild(frag);
    applyActive();
    setSummary();
  }

  function applyActive() {
    var rows = $results.querySelectorAll('.ij-find-row');
    for (var i = 0; i < rows.length; i++) { rows[i].classList.remove('active'); }
    if (state.activeIndex >= 0 && state.activeIndex < rows.length) {
      var row = rows[state.activeIndex];
      row.classList.add('active');
      row.scrollIntoView({ block: 'nearest' });
    }
  }

  function selectMatch(flatIdx) {
    if (flatIdx < 0 || flatIdx >= state.flat.length) { return; }
    state.activeIndex = flatIdx;
    applyActive();
    var fm = state.flat[flatIdx];
    var f = state.files[fm.fi];
    var m = f.matches[fm.mi];
    var key = f.uri + '#' + m.line;
    if (key === state.lastPreviewKey) { return; }
    state.lastPreviewKey = key;
    send({ type: 'requestPreview', uri: f.uri, line: m.line, ranges: m.ranges, contextLines: 0 });
  }

  function openActive() {
    if (state.activeIndex < 0 || state.activeIndex >= state.flat.length) { return; }
    var fm = state.flat[state.activeIndex];
    var f = state.files[fm.fi];
    var m = f.matches[fm.mi];
    var col = (m.ranges && m.ranges[0]) ? m.ranges[0].start : 0;
    send({ type: 'openFile', uri: f.uri, line: m.line, column: col });
  }

  function triggerSearch() {
    var q = $q.value;
    clearPreview();
    if (!q) {
      state.files = []; state.flat = []; state.activeIndex = -1; state.searching = false;
      setStatus('Type a query', false);
      render();
      send({ type: 'cancel' });
      return;
    }
    send({
      type: 'search',
      options: {
        query: q,
        caseSensitive: state.options.caseSensitive,
        wholeWord: state.options.wholeWord,
        useRegex: state.options.useRegex,
      },
    });
  }

  function scheduleSearch() {
    if (state.debounce) { clearTimeout(state.debounce); }
    state.debounce = setTimeout(triggerSearch, 150);
  }

  function toggleOpt(key, btn) {
    state.options[key] = !state.options[key];
    btn.setAttribute('aria-pressed', String(state.options[key]));
    triggerSearch();
  }

  function moveActive(delta) {
    if (state.flat.length === 0) { return; }
    var next = state.activeIndex < 0
      ? (delta > 0 ? 0 : state.flat.length - 1)
      : Math.max(0, Math.min(state.flat.length - 1, state.activeIndex + delta));
    selectMatch(next);
  }

  $q.addEventListener('input', scheduleSearch);
  $q.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      if (state.debounce) { clearTimeout(state.debounce); }
      e.preventDefault();
      if (state.flat.length > 0 && state.activeIndex < 0) { selectMatch(0); }
      else if (state.flat.length > 0) { openActive(); }
      else { triggerSearch(); }
    } else if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
    else if (e.key === 'PageDown') { e.preventDefault(); moveActive(10); }
    else if (e.key === 'PageUp') { e.preventDefault(); moveActive(-10); }
    else if (e.key === 'Escape') { e.preventDefault(); window.__ijFindHide(); }
  });
  $optCase.addEventListener('click', function () { toggleOpt('caseSensitive', $optCase); });
  $optWord.addEventListener('click', function () { toggleOpt('wholeWord', $optWord); });
  $optRegex.addEventListener('click', function () { toggleOpt('useRegex', $optRegex); });
  $close.addEventListener('click', function () { window.__ijFindHide(); });

  $results.addEventListener('click', function (e) {
    var row = e.target instanceof HTMLElement ? e.target.closest('.ij-find-row') : null;
    if (!row) { return; }
    var flatIdx = parseInt(row.getAttribute('data-flat') || '-1', 10);
    if (flatIdx >= 0) { selectMatch(flatIdx); $q.focus(); }
  });
  $results.addEventListener('dblclick', function (e) {
    var row = e.target instanceof HTMLElement ? e.target.closest('.ij-find-row') : null;
    if (!row) { return; }
    var flatIdx = parseInt(row.getAttribute('data-flat') || '-1', 10);
    if (flatIdx >= 0) { state.activeIndex = flatIdx; applyActive(); openActive(); }
  });

  // Drag header
  (function setupDrag() {
    var dragging = false;
    var startX = 0, startY = 0, origX = 0, origY = 0;
    $header.addEventListener('mousedown', function (e) {
      if (e.target && e.target.closest && e.target.closest('.ij-find-close')) { return; }
      dragging = true;
      var rect = panel.getBoundingClientRect();
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      panel.style.transform = 'none';
      startX = e.clientX; startY = e.clientY;
      origX = rect.left; origY = rect.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) { return; }
      var nx = origX + (e.clientX - startX);
      var ny = origY + (e.clientY - startY);
      nx = Math.max(0, Math.min(window.innerWidth - 120, nx));
      ny = Math.max(0, Math.min(window.innerHeight - 40, ny));
      panel.style.left = nx + 'px';
      panel.style.top = ny + 'px';
    });
    document.addEventListener('mouseup', function () { dragging = false; });
  })();

  // Panel resize
  (function setupPanelResize() {
    var resizing = false;
    var startW = 0, startH = 0, startX = 0, startY = 0;
    $resizer.addEventListener('mousedown', function (e) {
      e.preventDefault(); e.stopPropagation();
      var rect = panel.getBoundingClientRect();
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      panel.style.transform = 'none';
      resizing = true;
      startW = rect.width; startH = rect.height;
      startX = e.clientX; startY = e.clientY;
    });
    document.addEventListener('mousemove', function (e) {
      if (!resizing) { return; }
      var w = Math.max(420, Math.min(window.innerWidth - 20, startW + (e.clientX - startX)));
      var h = Math.max(320, Math.min(window.innerHeight - 20, startH + (e.clientY - startY)));
      panel.style.width = w + 'px';
      panel.style.height = h + 'px';
    });
    document.addEventListener('mouseup', function () { resizing = false; });
  })();

  // Splitter
  (function setupSplitter() {
    var splitting = false;
    var startY = 0;
    var startPreviewH = 0;
    $splitter.addEventListener('mousedown', function (e) {
      e.preventDefault();
      splitting = true;
      $splitter.classList.add('dragging');
      startY = e.clientY;
      startPreviewH = $preview.getBoundingClientRect().height;
    });
    document.addEventListener('mousemove', function (e) {
      if (!splitting) { return; }
      var delta = startY - e.clientY;
      var panelH = panel.getBoundingClientRect().height;
      var maxPreview = panelH - 180;
      var newH = Math.max(60, Math.min(maxPreview, startPreviewH + delta));
      $preview.style.flex = '0 0 ' + newH + 'px';
    });
    document.addEventListener('mouseup', function () {
      if (splitting) { splitting = false; $splitter.classList.remove('dragging'); }
    });
  })();

  document.addEventListener('keydown', function (e) {
    if (!panel.classList.contains('visible')) { return; }
    if (e.altKey && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); toggleOpt('caseSensitive', $optCase); }
    else if (e.altKey && (e.key === 'w' || e.key === 'W')) { e.preventDefault(); toggleOpt('wholeWord', $optWord); }
    else if (e.altKey && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); toggleOpt('useRegex', $optRegex); }
  });

  // ── Monaco access (best effort) ──────────────────────────────────────
  var monacoState = { tried: false, api: null, source: '' };
  function findMonacoSync() {
    if (typeof monaco !== 'undefined' && monaco && monaco.editor && typeof monaco.editor.colorize === 'function') {
      return { api: monaco, source: 'global monaco' };
    }
    if (window.monaco && window.monaco.editor && typeof window.monaco.editor.colorize === 'function') {
      return { api: window.monaco, source: 'window.monaco' };
    }
    return null;
  }
  function ensureMonaco(cb) {
    if (monacoState.tried) { cb(monacoState.api); return; }
    var sync = findMonacoSync();
    if (sync) {
      monacoState.api = sync.api; monacoState.source = sync.source; monacoState.tried = true;
      send({ type: 'log', msg: 'monaco found via ' + sync.source });
      cb(sync.api); return;
    }
    var loaders = [];
    try { if (typeof window.require === 'function') { loaders.push({ fn: window.require, src: 'window.require' }); } } catch (e) {}
    try { if (typeof globalThis.require === 'function') { loaders.push({ fn: globalThis.require, src: 'globalThis.require' }); } } catch (e) {}
    try {
      if (globalThis.AMDLoader && globalThis.AMDLoader.global && typeof globalThis.AMDLoader.global.require === 'function') {
        loaders.push({ fn: globalThis.AMDLoader.global.require, src: 'AMDLoader.global.require' });
      }
    } catch (e) {}
    if (loaders.length === 0) {
      monacoState.tried = true;
      send({ type: 'log', msg: 'monaco probe: no loader (require/AMDLoader)' });
      cb(null); return;
    }
    var idx = 0;
    function tryNext() {
      if (idx >= loaders.length) {
        monacoState.tried = true;
        send({ type: 'log', msg: 'monaco probe: all loaders failed' });
        cb(null); return;
      }
      var entry = loaders[idx++];
      try {
        entry.fn(['vs/editor/editor.main'], function () {
          var found = findMonacoSync();
          if (found) {
            monacoState.api = found.api; monacoState.source = entry.src + ' -> ' + found.source; monacoState.tried = true;
            send({ type: 'log', msg: 'monaco loaded via ' + monacoState.source });
            cb(found.api);
          } else { tryNext(); }
        }, function (err) {
          send({ type: 'log', msg: 'loader ' + entry.src + ' failed: ' + (err && err.message ? err.message : String(err)).slice(0, 120) });
          tryNext();
        });
      } catch (e) {
        send({ type: 'log', msg: 'loader ' + entry.src + ' threw: ' + (e && e.message)});
        tryNext();
      }
    }
    tryNext();
  }

  // ── Lightweight regex tokenizer fallback ─────────────────────────────
  var KW = {
    'javascript': 'function var let const if else for while do return class extends new this super static async await yield import export from default null undefined true false typeof instanceof in of try catch finally throw switch case break continue void delete debugger',
    'typescript': 'function var let const if else for while do return class extends new this super static async await yield import export from default null undefined true false typeof instanceof in of try catch finally throw switch case break continue void delete debugger interface type enum namespace declare implements public private protected readonly abstract as is keyof infer never unknown any',
    'python': 'def class if elif else for while return import from as None True False yield lambda try except finally raise pass break continue with async await global nonlocal in is not and or assert del',
    'go': 'func var const if else for switch case break continue return type struct interface map chan go defer select package import nil true false range fallthrough goto',
    'rust': 'fn let mut const if else for while loop return struct enum impl trait use mod pub crate self super match break continue as in where Self ref move dyn async await box unsafe extern static',
    'java': 'public private protected static final abstract class interface extends implements new this super if else for while do return null true false void int long short byte float double char boolean String try catch finally throw throws import package switch case break continue instanceof',
    'c': 'int long short char float double void return if else for while do switch case break continue struct enum union typedef static const sizeof goto NULL true false',
    'cpp': 'int long short char float double void return if else for while do switch case break continue struct enum union typedef static const sizeof goto class public private protected new delete this virtual override template typename namespace using auto nullptr true false',
    'csharp': 'public private protected internal static readonly abstract sealed virtual override new this base class interface struct enum namespace using if else for foreach while do return null true false void int long short byte float double bool string char var dynamic try catch finally throw async await yield in out where',
    'ruby': 'def class module if elsif else end for while do return nil true false and or not begin rescue ensure raise yield self super lambda proc require require_relative attr_accessor attr_reader attr_writer puts',
    'php': 'function class interface trait extends implements public private protected static abstract final new this self parent if elseif else for foreach while do return null true false try catch finally throw use namespace echo print include require',
    'shellscript': 'if then else elif fi for while do done case esac function return in select break continue export local readonly true false',
    'bash': 'if then else elif fi for while do done case esac function return in select break continue export local readonly true false',
  };
  var ALIAS = { 'jsx': 'javascript', 'tsx': 'typescript', 'js': 'javascript', 'ts': 'typescript', 'py': 'python', 'sh': 'shellscript' };
  function langProfile(langId) {
    var lang = ALIAS[langId] || langId;
    var keywords = KW[lang];
    if (!keywords) { return null; }
    var p = { keywords: ' ' + keywords + ' ', lc: '//', bc: ['/*', '*/'], strings: ['"', "'", '\\u0060'] };
    if (lang === 'python' || lang === 'ruby' || lang === 'shellscript' || lang === 'bash' || lang === 'php') {
      p.lc = '#'; p.bc = null; p.strings = ['"', "'"];
    }
    return p;
  }
  function tokenizeLine(line, p) {
    var tokens = []; var i = 0; var n = line.length;
    while (i < n) {
      var c = line.charAt(i);
      // whitespace passthrough
      if (c === ' ' || c === '\\t') {
        var ws = i;
        while (ws < n && (line.charAt(ws) === ' ' || line.charAt(ws) === '\\t')) { ws++; }
        tokens.push({ text: line.slice(i, ws), type: 'default' });
        i = ws; continue;
      }
      // line comment
      if (p.lc && line.substr(i, p.lc.length) === p.lc) {
        tokens.push({ text: line.slice(i), type: 'comment' });
        break;
      }
      // string
      var matched = false;
      for (var s = 0; s < p.strings.length; s++) {
        var quote = p.strings[s];
        if (line.substr(i, quote.length) === quote) {
          var endIdx = i + quote.length;
          while (endIdx < n) {
            if (line.charAt(endIdx) === '\\\\') { endIdx += 2; continue; }
            if (line.substr(endIdx, quote.length) === quote) { endIdx += quote.length; break; }
            endIdx++;
          }
          if (endIdx > n) { endIdx = n; }
          tokens.push({ text: line.slice(i, endIdx), type: 'string' });
          i = endIdx; matched = true; break;
        }
      }
      if (matched) { continue; }
      // number
      if (c >= '0' && c <= '9') {
        var ne = i;
        while (ne < n && /[0-9.eExXa-fA-F_]/.test(line.charAt(ne))) { ne++; }
        tokens.push({ text: line.slice(i, ne), type: 'number' });
        i = ne; continue;
      }
      // identifier/keyword
      if (/[A-Za-z_$]/.test(c)) {
        var we = i;
        while (we < n && /[A-Za-z0-9_$]/.test(line.charAt(we))) { we++; }
        var word = line.slice(i, we);
        var type = 'default';
        if (p.keywords.indexOf(' ' + word + ' ') >= 0) { type = 'keyword'; }
        else if (we < n && line.charAt(we) === '(') { type = 'function'; }
        else if (word.length > 0 && word.charAt(0) >= 'A' && word.charAt(0) <= 'Z') { type = 'type'; }
        tokens.push({ text: word, type: type });
        i = we; continue;
      }
      tokens.push({ text: c, type: 'default' });
      i++;
    }
    return tokens;
  }
  function fallbackHighlight(textSpan, lineText, langId) {
    var p = langProfile(langId);
    if (!p) { return false; }
    var tokens = tokenizeLine(lineText, p);
    clearChildren(textSpan);
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (!t.text) { continue; }
      if (t.type === 'default') { textSpan.appendChild(document.createTextNode(t.text)); }
      else { textSpan.appendChild(el('span', { className: 'ij-tk-' + t.type, text: t.text })); }
    }
    return true;
  }

  // ── Monaco full-text colorize (when available) ───────────────────────
  var domParser = new DOMParser();
  function applyMonacoFullText(api, fullText, langId, lineEls) {
    try {
      api.editor.colorize(fullText, langId, { tabSize: 4 }).then(function (html) {
        if (typeof html !== 'string' || !html) { return; }
        // Split HTML at <br> boundaries by parsing.
        var doc = domParser.parseFromString('<body>' + html + '</body>', 'text/html');
        var body = doc.body;
        var perLine = [[]];
        var node = body.firstChild;
        while (node) {
          var next = node.nextSibling;
          if (node.nodeName === 'BR') { perLine.push([]); }
          else { perLine[perLine.length - 1].push(node); }
          node = next;
        }
        var maxLen = Math.min(perLine.length, lineEls.length);
        for (var i = 0; i < maxLen; i++) {
          var ts = lineEls[i].querySelector('.ij-find-preview-text');
          if (!ts) { continue; }
          clearChildren(ts);
          for (var j = 0; j < perLine[i].length; j++) {
            ts.appendChild(document.importNode(perLine[i][j], true));
          }
        }
      }).catch(function (err) {
        send({ type: 'log', msg: 'monaco colorize failed: ' + (err && err.message ? err.message : err) });
      });
    } catch (e) {
      send({ type: 'log', msg: 'monaco colorize threw: ' + (e && e.message) });
    }
  }

  function renderPreview(msg) {
    $previewHeader.textContent = msg.relPath || msg.uri;
    state.previewUri = msg.uri;
    state.previewLanguageId = msg.languageId || '';
    clearChildren($previewBody);
    var focusEl = null;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < msg.lines.length; i++) {
      var line = msg.lines[i];
      var isFocus = (line.lineNumber === msg.focusLine);
      var lineEl = el('div', {
        className: 'ij-find-preview-line' + (isFocus ? ' focus' : ''),
        attrs: { 'data-line': String(line.lineNumber) },
      });
      lineEl.appendChild(el('span', { className: 'ij-find-preview-lineno', text: String(line.lineNumber + 1) }));
      var textSpan = el('span', { className: 'ij-find-preview-text' });
      // Initial pass: search-range highlight on focus, fallback regex tokenizer for the rest.
      if (isFocus && msg.ranges && msg.ranges.length > 0) {
        appendHighlightedInto(textSpan, line.text, msg.ranges);
      } else if (!fallbackHighlight(textSpan, line.text, state.previewLanguageId)) {
        textSpan.textContent = line.text;
      }
      lineEl.appendChild(textSpan);
      frag.appendChild(lineEl);
      if (isFocus) { focusEl = lineEl; }
    }
    $previewBody.appendChild(frag);

    // Async upgrade with monaco if we can reach it (replaces tokenization).
    if (state.previewLanguageId) {
      var lineEls = $previewBody.querySelectorAll('.ij-find-preview-line');
      var fullText = msg.lines.map(function (l) { return l.text; }).join('\\n');
      ensureMonaco(function (api) {
        if (!api) { return; }
        applyMonacoFullText(api, fullText, state.previewLanguageId, lineEls);
      });
    }

    if (focusEl) {
      setTimeout(function () { try { focusEl.scrollIntoView({ block: 'center' }); } catch (e) {} }, 0);
    }
  }

  // ── Hover ────────────────────────────────────────────────────────────
  function getColumnInLine(textSpan, e) {
    var range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(e.clientX, e.clientY);
    } else if (document.caretPositionFromPoint) {
      var pos = document.caretPositionFromPoint(e.clientX, e.clientY);
      if (pos) { try { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); } catch (er) { range = null; } }
    }
    if (!range || !textSpan.contains(range.startContainer)) { return -1; }
    var col = 0;
    var walker = document.createTreeWalker(textSpan, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      if (node === range.startContainer) { return col + range.startOffset; }
      col += node.textContent.length;
    }
    return col;
  }

  // ── Mini Markdown renderer ───────────────────────────────────────────
  function commandFromUrl(url) {
    if (typeof url !== 'string' || url.indexOf('command:') !== 0) { return null; }
    var rest = url.slice('command:'.length);
    var qIdx = rest.indexOf('?');
    var name = qIdx >= 0 ? rest.slice(0, qIdx) : rest;
    var argsRaw = qIdx >= 0 ? rest.slice(qIdx + 1) : '';
    var args = [];
    if (argsRaw) {
      var decoded = '';
      try { decoded = decodeURIComponent(argsRaw); } catch (e) { decoded = argsRaw; }
      try {
        var parsed = JSON.parse(decoded);
        args = Array.isArray(parsed) ? parsed : [parsed];
      } catch (e) {
        // Some plugins use plain string args, not JSON.
        args = [decoded];
      }
    }
    return { name: name, args: args };
  }

  function makeCommandLink(label, url, isTrusted, allowedCommands) {
    var cmd = commandFromUrl(url);
    if (!cmd) { return null; }
    var enabled = isTrusted && (
      !allowedCommands || allowedCommands.length === 0 || allowedCommands.indexOf(cmd.name) >= 0
    );
    if (!enabled) {
      return el('span', {
        className: 'ij-md-cmdlink-disabled',
        text: label,
        title: 'Untrusted command link: ' + cmd.name,
      });
    }
    var a = el('a', {
      className: 'ij-md-link',
      text: label,
      attrs: { href: '#', title: 'Run: ' + cmd.name },
    });
    a.addEventListener('click', function (e) {
      e.preventDefault();
      send({ type: 'runCommand', command: cmd.name, args: cmd.args });
    });
    return a;
  }

  // Render \`$(name)\` codicon spans inside a string, appending to container.
  // Returns true if any icon was rendered, false otherwise.
  function appendWithCodicons(container, text) {
    var iconRe = /\\$\\(([\\w-]+)\\)/g;
    var lastIdx = 0;
    var m;
    var hadIcon = false;
    while ((m = iconRe.exec(text)) !== null) {
      if (m.index > lastIdx) { container.appendChild(document.createTextNode(text.slice(lastIdx, m.index))); }
      container.appendChild(el('span', { className: 'codicon codicon-' + m[1] + ' ij-md-codicon' }));
      lastIdx = m.index + m[0].length;
      hadIcon = true;
    }
    if (lastIdx < text.length) { container.appendChild(document.createTextNode(text.slice(lastIdx))); }
    return hadIcon;
  }

  function renderInline(container, text, ctx) {
    ctx = ctx || { isTrusted: false, allowedCommands: undefined };
    var pos = 0;
    var n = text.length;
    while (pos < n) {
      var rest = text.slice(pos);
      var m;
      // Inline code
      if ((m = /^\`([^\`\\n]+)\`/.exec(rest))) {
        container.appendChild(el('code', { className: 'ij-md-icode', text: m[1] }));
        pos += m[0].length; continue;
      }
      // Bold (** or __)
      if ((m = /^\\*\\*([^\\*\\n]+?)\\*\\*/.exec(rest)) || (m = /^__([^_\\n]+?)__/.exec(rest))) {
        var b = el('strong');
        renderInline(b, m[1], ctx);
        container.appendChild(b);
        pos += m[0].length; continue;
      }
      // Italic (* or _)
      if ((m = /^\\*([^\\*\\n]+?)\\*/.exec(rest)) || (m = /^_([^_\\n]+?)_/.exec(rest))) {
        var it = el('em');
        renderInline(it, m[1], ctx);
        container.appendChild(it);
        pos += m[0].length; continue;
      }
      // Link [text](url) — handles command: links specially
      if ((m = /^\\[([^\\]]+)\\]\\(([^)\\s]+)(?:\\s+\\"[^\\"]*\\")?\\)/.exec(rest))) {
        var label = m[1], url = m[2];
        if (url.indexOf('command:') === 0) {
          var cmdEl = makeCommandLink(label, url, ctx.isTrusted, ctx.allowedCommands);
          if (cmdEl) { container.appendChild(cmdEl); }
        } else {
          container.appendChild(el('a', {
            className: 'ij-md-link',
            text: label,
            attrs: { href: url, target: '_blank', rel: 'noopener' },
          }));
        }
        pos += m[0].length; continue;
      }
      // Codicon \`$(icon-name)\`
      if ((m = /^\\$\\(([\\w-]+)\\)/.exec(rest))) {
        container.appendChild(el('span', { className: 'codicon codicon-' + m[1] + ' ij-md-codicon' }));
        pos += m[0].length; continue;
      }
      // Bare URL
      if ((m = /^https?:\\/\\/[^\\s)]+/.exec(rest))) {
        container.appendChild(el('a', {
          className: 'ij-md-link',
          text: m[0],
          attrs: { href: m[0], target: '_blank', rel: 'noopener' },
        }));
        pos += m[0].length; continue;
      }
      // Plain text up to next inline marker
      var nextMarker = -1;
      for (var k = 0; k < rest.length; k++) {
        var c = rest.charAt(k);
        if (c === '\`' || c === '*' || c === '_' || c === '[' || c === '$' || c === 'h') {
          if (c === 'h' && rest.substr(k, 4) !== 'http') { continue; }
          if (c === '$' && rest.charAt(k + 1) !== '(') { continue; }
          nextMarker = k; break;
        }
      }
      var endIdx = nextMarker > 0 ? pos + nextMarker : n;
      container.appendChild(document.createTextNode(text.slice(pos, endIdx)));
      pos = endIdx;
    }
  }

  function renderMarkdownInto(container, md, ctx) {
    ctx = ctx || { isTrusted: false, allowedCommands: undefined };
    var lines = md.split(/\\r?\\n/);
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      // Code fence
      var fm = /^\`\`\`\\s*([\\w-]*)\\s*$/.exec(line);
      if (fm) {
        var lang = fm[1] || '';
        var codeBuf = [];
        i++;
        while (i < lines.length && !/^\`\`\`\\s*$/.test(lines[i])) {
          codeBuf.push(lines[i]); i++;
        }
        if (i < lines.length) { i++; } // skip closing fence
        var pre = el('pre', { className: 'ij-md-pre', attrs: { 'data-lang': lang } });
        var code = el('code', { className: 'ij-md-code', text: codeBuf.join('\\n') });
        pre.appendChild(code);
        container.appendChild(pre);
        continue;
      }
      // Horizontal rule
      if (/^\\s*([-*_])\\s*\\1\\s*\\1[\\s\\1]*$/.test(line)) {
        container.appendChild(el('hr', { className: 'ij-md-hr' }));
        i++;
        continue;
      }
      // Heading
      var hm = /^(#{1,6})\\s+(.*)$/.exec(line);
      if (hm) {
        var hd = el('div', { className: 'ij-md-h' + hm[1].length });
        renderInline(hd, hm[2], ctx);
        container.appendChild(hd);
        i++;
        continue;
      }
      // Unordered list
      if (/^\\s*[-*]\\s+/.test(line)) {
        var ul = el('ul', { className: 'ij-md-ul' });
        while (i < lines.length && /^\\s*[-*]\\s+/.test(lines[i])) {
          var liEl = el('li', { className: 'ij-md-li' });
          renderInline(liEl, lines[i].replace(/^\\s*[-*]\\s+/, ''), ctx);
          ul.appendChild(liEl);
          i++;
        }
        container.appendChild(ul);
        continue;
      }
      // Ordered list
      if (/^\\s*\\d+\\.\\s+/.test(line)) {
        var ol = el('ol', { className: 'ij-md-ol' });
        while (i < lines.length && /^\\s*\\d+\\.\\s+/.test(lines[i])) {
          var li2 = el('li', { className: 'ij-md-li' });
          renderInline(li2, lines[i].replace(/^\\s*\\d+\\.\\s+/, ''), ctx);
          ol.appendChild(li2);
          i++;
        }
        container.appendChild(ol);
        continue;
      }
      // Blank
      if (/^\\s*$/.test(line)) { i++; continue; }
      // Paragraph: collect until blank or block start
      var paraBuf = [];
      while (i < lines.length && lines[i].trim().length > 0
        && !/^\`\`\`/.test(lines[i])
        && !/^#{1,6}\\s/.test(lines[i])
        && !/^\\s*[-*]\\s/.test(lines[i])
        && !/^\\s*\\d+\\.\\s/.test(lines[i])) {
        paraBuf.push(lines[i]); i++;
      }
      if (paraBuf.length > 0) {
        var p = el('div', { className: 'ij-md-p' });
        renderInline(p, paraBuf.join(' '), ctx);
        container.appendChild(p);
      }
    }
    // Async colorize code blocks via monaco (if accessible).
    var pres = container.querySelectorAll('.ij-md-pre');
    if (pres.length > 0) {
      ensureMonaco(function (api) {
        if (!api) {
          // Fallback regex tokenizer per line.
          for (var i = 0; i < pres.length; i++) {
            var pre = pres[i];
            var lang = pre.getAttribute('data-lang') || '';
            var codeEl = pre.querySelector('code');
            if (!codeEl || !lang) { continue; }
            var raw = codeEl.textContent;
            var prof = langProfile(lang);
            if (!prof) { continue; }
            var lns = raw.split('\\n');
            clearChildren(codeEl);
            for (var j = 0; j < lns.length; j++) {
              if (j > 0) { codeEl.appendChild(document.createTextNode('\\n')); }
              var tokens = tokenizeLine(lns[j], prof);
              for (var k = 0; k < tokens.length; k++) {
                var t = tokens[k];
                if (!t.text) { continue; }
                if (t.type === 'default') { codeEl.appendChild(document.createTextNode(t.text)); }
                else { codeEl.appendChild(el('span', { className: 'ij-tk-' + t.type, text: t.text })); }
              }
            }
          }
          return;
        }
        for (var i = 0; i < pres.length; i++) {
          (function (pre) {
            var lang = pre.getAttribute('data-lang') || '';
            var codeEl = pre.querySelector('code');
            if (!codeEl || !lang) { return; }
            var raw = codeEl.textContent;
            try {
              api.editor.colorize(raw, lang, { tabSize: 4 }).then(function (html) {
                if (typeof html !== 'string') { return; }
                var doc = domParser.parseFromString('<body>' + html + '</body>', 'text/html');
                clearChildren(codeEl);
                var node = doc.body.firstChild;
                while (node) {
                  var next = node.nextSibling;
                  codeEl.appendChild(document.importNode(node, true));
                  node = next;
                }
              }).catch(function () {});
            } catch (e) {}
          })(pres[i]);
        }
      });
    }
  }

  // ── Hover lifecycle (matches editor behavior) ────────────────────────
  var hoverHideTimer = null;
  function cancelHoverHide() { if (hoverHideTimer) { clearTimeout(hoverHideTimer); hoverHideTimer = null; } }
  function scheduleHoverHide(delayMs) {
    cancelHoverHide();
    hoverHideTimer = setTimeout(hideHover, typeof delayMs === 'number' ? delayMs : 200);
  }
  function hideHover() {
    cancelHoverHide();
    $hoverTooltip.classList.remove('visible');
    clearChildren($hoverTooltip);
    state.lastHoverKey = '';
  }

  function showHoverContents(msg) {
    if (msg.reqId !== state.hoverReqId) { return; }
    if (!msg.contents || msg.contents.length === 0) { hideHover(); return; }
    cancelHoverHide();
    clearChildren($hoverTooltip);
    // Build the inner structure with the SAME class names VSCode's real hover
    // widget uses (\`monaco-hover-content\`, \`hover-row\`, \`markdown-hover\`,
    // \`hover-contents\`, \`rendered-markdown\`). DOM-scanning hover plugins —
    // e.g. intellisense-recursion's \`.rendered-markdown\` walker that injects
    // \`.ir-type-link\` spans for cmd+click-to-definition — will then decorate
    // our content automatically, identical to a real editor hover.
    var hoverContent = el('div', { className: 'monaco-hover-content' });
    for (var i = 0; i < msg.contents.length; i++) {
      var entry = msg.contents[i];
      // Backwards-compat: accept either string or { value, isTrusted, allowedCommands }.
      var entryValue = (typeof entry === 'string') ? entry : (entry && entry.value) || '';
      var entryTrusted = (typeof entry === 'object' && entry && !!entry.isTrusted);
      var entryAllowed = (typeof entry === 'object' && entry && entry.allowedCommands) || undefined;
      if (!entryValue) { continue; }
      if (i > 0) { hoverContent.appendChild(el('hr', { className: 'ij-md-sep' })); }
      var row = el('div', { className: 'hover-row markdown-hover' });
      var contentsCell = el('div', { className: 'hover-contents' });
      var group = el('div', { className: 'ij-md-group rendered-markdown' });
      renderMarkdownInto(group, entryValue, { isTrusted: entryTrusted, allowedCommands: entryAllowed });
      contentsCell.appendChild(group);
      row.appendChild(contentsCell);
      hoverContent.appendChild(row);
    }
    $hoverTooltip.appendChild(hoverContent);
    if (!hoverContent.firstChild) { hideHover(); return; }
    // Position, keeping inside viewport.
    $hoverTooltip.style.left = '0px'; $hoverTooltip.style.top = '0px';
    $hoverTooltip.classList.add('visible');
    var rect = $hoverTooltip.getBoundingClientRect();
    var x = msg.x + 14, y = msg.y + 18;
    if (x + rect.width > window.innerWidth - 8) { x = Math.max(8, window.innerWidth - rect.width - 8); }
    if (y + rect.height > window.innerHeight - 8) { y = Math.max(8, msg.y - rect.height - 12); }
    $hoverTooltip.style.left = x + 'px';
    $hoverTooltip.style.top = y + 'px';
  }

  $previewBody.addEventListener('mousemove', function (e) {
    if (!state.previewUri) { return; }
    cancelHoverHide();
    if (state.hoverTimer) { clearTimeout(state.hoverTimer); }
    state.hoverTimer = setTimeout(function () {
      var lineEl = e.target instanceof HTMLElement ? e.target.closest('.ij-find-preview-line') : null;
      if (!lineEl) { scheduleHoverHide(150); return; }
      var lineNum = parseInt(lineEl.getAttribute('data-line') || '-1', 10);
      if (lineNum < 0) { scheduleHoverHide(150); return; }
      var textSpan = lineEl.querySelector('.ij-find-preview-text');
      if (!textSpan) { scheduleHoverHide(150); return; }
      var col = getColumnInLine(textSpan, e);
      if (col < 0) { scheduleHoverHide(150); return; }
      var key = state.previewUri + ':' + lineNum + ':' + col;
      if (key === state.lastHoverKey) { return; }
      state.lastHoverKey = key;
      state.hoverReqId++;
      send({
        type: 'requestHover',
        reqId: state.hoverReqId,
        uri: state.previewUri,
        line: lineNum, column: col,
        x: e.clientX, y: e.clientY,
      });
    }, 280);
  });
  $previewBody.addEventListener('mouseleave', function () {
    if (state.hoverTimer) { clearTimeout(state.hoverTimer); state.hoverTimer = null; }
    scheduleHoverHide(220);
  });
  // Keep hover open while user moves into / interacts with the tooltip.
  $hoverTooltip.addEventListener('mouseenter', cancelHoverHide);
  $hoverTooltip.addEventListener('mouseleave', function () { scheduleHoverHide(180); });

  window.__ijFindShow = function (initialQuery) {
    try {
      panel.classList.add('visible');
      panel.style.setProperty('display', 'flex', 'important');
      panel.style.setProperty('visibility', 'visible', 'important');
      panel.style.setProperty('opacity', '1', 'important');
      panel.style.setProperty('pointer-events', 'auto', 'important');
      panel.style.setProperty('z-index', '2147483000', 'important');
      panel.style.setProperty('position', 'fixed', 'important');
      if (document.body.lastElementChild !== panel && document.body.lastElementChild !== $hoverTooltip) {
        document.body.appendChild(panel);
        document.body.appendChild($hoverTooltip);
      }
      if (typeof initialQuery === 'string' && initialQuery && initialQuery !== $q.value) {
        $q.value = initialQuery;
        triggerSearch();
      }
      setTimeout(function () { try { $q.focus(); $q.select(); } catch (e) {} }, 0);
      return 'show ok';
    } catch (e) { return 'show-err: ' + (e && e.message); }
  };
  window.__ijFindHide = function () {
    panel.classList.remove('visible');
    panel.style.removeProperty('display');
    panel.style.removeProperty('visibility');
    panel.style.removeProperty('opacity');
    panel.style.removeProperty('pointer-events');
    panel.style.removeProperty('z-index');
    panel.style.removeProperty('position');
    hideHover();
    send({ type: 'cancel' });
  };
  window.__ijFindStatus = function () {
    try {
      var r = panel.getBoundingClientRect();
      var cs = getComputedStyle(panel);
      return 'inDom=' + document.body.contains(panel) +
        ' disp=' + cs.display +
        ' z=' + cs.zIndex +
        ' rect=' + Math.round(r.x) + ',' + Math.round(r.y) + ',' + Math.round(r.width) + 'x' + Math.round(r.height) +
        ' monacoGlobal=' + (typeof monaco !== 'undefined') +
        ' windowRequire=' + (typeof window.require) +
        ' AMDLoader=' + (typeof globalThis.AMDLoader);
    } catch (e) { return 'status-err: ' + (e && e.message); }
  };
  window.__ijFindOnMessage = function (msg) {
    switch (msg.type) {
      case 'results:start':
        state.files = []; state.flat = []; state.activeIndex = -1; state.searching = true;
        clearPreview();
        setStatus('Searching...', true);
        render();
        break;
      case 'results:file':
        state.files.push(msg.match);
        render();
        var sofar = 0;
        for (var i = 0; i < state.files.length; i++) { sofar += state.files[i].matches.length; }
        setStatus(sofar + ' matches in ' + state.files.length + ' files', true);
        break;
      case 'results:done':
        state.searching = false;
        setSummary();
        if (msg.totalMatches === 0) {
          setStatus('No matches', false);
        } else {
          setStatus(
            msg.totalMatches + ' result' + (msg.totalMatches === 1 ? '' : 's') +
            ' in ' + msg.totalFiles + ' file' + (msg.totalFiles === 1 ? '' : 's') +
            (msg.truncated ? ' (truncated)' : ''),
            false
          );
        }
        if (state.activeIndex < 0 && state.flat.length > 0) { selectMatch(0); }
        break;
      case 'results:error':
        state.searching = false;
        setStatus('Error: ' + msg.message, false);
        break;
      case 'preview':
        renderPreview(msg);
        break;
      case 'hover':
        showHoverContents(msg);
        break;
    }
  };

  return 'ij-find patch installed';
})()
`;
}
