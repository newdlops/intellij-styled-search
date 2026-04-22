export function getRendererPatchScript(): string {
  return `
(function () {
  if (window.__ijFindPatchedV82) {
    var existingStatus = 'not-ready:no-status';
    try {
      existingStatus = window.__ijFindMonacoStatus ? window.__ijFindMonacoStatus() : existingStatus;
      if (existingStatus === 'ready') { return 'already patched'; }
      if (window.__ijFindInvalidateMonaco) {
        window.__ijFindInvalidateMonaco('already-patched-not-ready');
      }
    } catch (eStatus) {}
    try {
      if (window.__ijFindRefreshCapture) {
        return 'already patched; ' + window.__ijFindRefreshCapture('already-patched');
      }
    } catch (eRefresh) {
      return 'already patched; refresh err: ' + (eRefresh && eRefresh.message);
    }
    return 'already patched';
  }
  window.__ijFindPatchedV82 = true;

  // Unique id per patch install (per window). Paired with __seq below so the
  // ext host can dedup duplicate deliveries from accumulated CDP listeners
  // WITHOUT accidentally dropping legitimate events from *other* windows that
  // have their own independent __seq counters — a single global lastSeenSeq
  // would drop win=101's __seq=1 if win=95 had already bumped it to 200.
  var __ijFindInstanceId = 'ij-' + Math.random().toString(36).slice(2) + '-' + Date.now();
  var __ijFindSeq = 0;
  function send(payload) {
    try {
      payload.__seq = ++__ijFindSeq;
      payload.__src = __ijFindInstanceId;
      globalThis.irSearchEvent(JSON.stringify(payload));
    } catch (e) {}
  }

  // Remove overlay/hover DOM left behind by a previous patch version so
  // the new install is the ONLY instance in the page. Without this, older
  // V50 panels accumulate after an extension upgrade and querySelector
  // calls (including test probes) may hit stale nodes whose state the new
  // closure no longer owns.
  try {
    var stale = document.querySelectorAll('.ij-find-overlay, .ij-find-panel, .ij-find-hover-tooltip, .ij-find-preview-overflow-root, .ij-find-preview-overflow');
    for (var si = 0; si < stale.length; si++) {
      try { stale[si].parentElement && stale[si].parentElement.removeChild(stale[si]); } catch (eRm) {}
    }
  } catch (eClean) {}
  // Drop cached monaco refs from a previous patch version. They may carry
  // stale widgetOptions (e.g. V56s contributions-empty setting which
  // disabled hover/LSP contributions) and would keep being reused until a
  // full VSCode restart — clear so the next capture diagnostic
  // repopulates with this versions settings.
  try { window.__ijFindMonaco = null; } catch (eMM) {}

  // ── Capture VSCode internals via prototype interception ─────────────
  // Monkey-patch Map.set / WeakMap.set / Set.add briefly right after patch
  // install. VSCode stores widgets and services in native Map/WeakMap
  // containers internally; anything that gets .set() in and matches one of
  // the duck-typed signatures is captured for later use. Patches are
  // self-removing after 30s so the overhead disappears once we have what
  // we need (or if capture turned up empty).
  // Always restart capture on patch load — stale captures from a previous
  // extension-host session (renderer persists across Dev Host reloads)
  // reference disposed widgets and we want fresh services anyway.
  var caps = null;
  function makeCaptureState() {
    return {
      widgets: [],       // { v, src, key }  — CodeEditorWidget-like
      services: [],      // { v, src, key, kind } — DI / editor / model services
      widgetCtors: [],   // unique widget constructors we saw
      serviceMaps: [],   // Map instances that stored a service (likely ServiceCollection)
    };
  }
  function stringifyKey(k) {
    try {
      if (k === null || k === undefined) { return String(k); }
      if (typeof k === 'string') { return k.length > 60 ? k.slice(0, 60) + '…' : k; }
      if (typeof k === 'number' || typeof k === 'boolean') { return String(k); }
      return typeof k;
    } catch (e) { return '?'; }
  }
  window.__ijFindStartCapture = function (reason) {
    try { if (window.__ijFindStopCapture) { window.__ijFindStopCapture(); } } catch (eStop) {}
    caps = makeCaptureState();
    window.__ijFindCaptures = caps;
    window.__ijFindCaptureInstalled = true;
    var capturing = true;
    function sniff(v, src, k) {
      if (!capturing) { return null; }
      if (!v || typeof v !== 'object') { return null; }
      try {
        if (typeof v.layout === 'function' && typeof v.getModel === 'function' && typeof v.getDomNode === 'function') {
          if (caps.widgets.length < 50) {
            caps.widgets.push({ v: v, src: src, key: stringifyKey(k) });
          }
          var ctor = v.constructor;
          if (ctor && caps.widgetCtors.indexOf(ctor) < 0 && caps.widgetCtors.length < 10) {
            caps.widgetCtors.push(ctor);
          }
          return 'widget';
        }
      } catch (e) {}
      try {
        if (typeof v.createInstance === 'function' && typeof v.invokeFunction === 'function') {
          if (caps.services.length < 40) {
            caps.services.push({ v: v, src: src, key: stringifyKey(k), kind: 'IInstantiationService' });
          }
          return 'service';
        }
      } catch (e) {}
      try {
        if (typeof v.listCodeEditors === 'function' || typeof v.getActiveCodeEditor === 'function') {
          if (caps.services.length < 40) {
            caps.services.push({ v: v, src: src, key: stringifyKey(k), kind: 'ICodeEditorService' });
          }
          return 'service';
        }
      } catch (e) {}
      try {
        if (typeof v.createModel === 'function' && typeof v.getModel === 'function' && typeof v.getModels === 'function') {
          if (caps.services.length < 40) {
            caps.services.push({ v: v, src: src, key: stringifyKey(k), kind: 'IModelService' });
          }
          return 'service';
        }
      } catch (e) {}
      return null;
    }
    var origMapSet = Map.prototype.set;
    Map.prototype.set = function (k, v) {
      try {
        var kind = sniff(v, 'Map.set', k);
        if (kind === 'service' && caps.serviceMaps.indexOf(this) < 0 && caps.serviceMaps.length < 6) {
          caps.serviceMaps.push(this);
        }
      } catch (e) {}
      return origMapSet.call(this, k, v);
    };
    var origWeakMapSet = WeakMap.prototype.set;
    WeakMap.prototype.set = function (k, v) {
      try { sniff(v, 'WeakMap.set', k); } catch (e) {}
      return origWeakMapSet.call(this, k, v);
    };
    var origSetAdd = Set.prototype.add;
    Set.prototype.add = function (v) {
      try { sniff(v, 'Set.add', null); } catch (e) {}
      return origSetAdd.call(this, v);
    };
    var origArrayPush = Array.prototype.push;
    Array.prototype.push = function () {
      try {
        for (var i = 0; i < arguments.length; i++) {
          sniff(arguments[i], 'Array.push', i);
        }
      } catch (e) {}
      return origArrayPush.apply(this, arguments);
    };
    // Hook Reflect.construct so that whenever any \`new X(...)\` runs via
    // VSCode's DI container, we get the actual class X. Duck-test its
    // prototype — if it has layout/getModel/getDomNode there, it's the
    // widget class (or a subclass). Record distinct constructors.
    var origReflectConstruct = Reflect.construct;
    Reflect.construct = function (target, args, newTarget) {
      try {
        if (capturing && target && target.prototype) {
          var p = target.prototype;
          if (typeof p.layout === 'function' &&
              typeof p.getModel === 'function' &&
              typeof p.getDomNode === 'function') {
            if (caps.widgetCtors.indexOf(target) < 0 && caps.widgetCtors.length < 20) {
              caps.widgetCtors.push(target);
            }
          }
        }
      } catch (e) {}
      return origReflectConstruct.apply(Reflect, arguments);
    };
    window.__ijFindStopCapture = function () {
      if (!capturing) { return 'already-stopped'; }
      capturing = false;
      try { Map.prototype.set = origMapSet; } catch (e) {}
      try { WeakMap.prototype.set = origWeakMapSet; } catch (e) {}
      try { Set.prototype.add = origSetAdd; } catch (e) {}
      try { Array.prototype.push = origArrayPush; } catch (e) {}
      try { Reflect.construct = origReflectConstruct; } catch (e) {}
      window.__ijFindCaptureInstalled = false;
      // Summarise.
      var uniqKinds = {};
      for (var i = 0; i < caps.services.length; i++) { uniqKinds[caps.services[i].kind] = (uniqKinds[caps.services[i].kind] || 0) + 1; }
      send({ type: 'log', msg: 'Capture done: widgets=' + caps.widgets.length + ' services=' + JSON.stringify(uniqKinds) + ' ctors=' + caps.widgetCtors.length });
      for (var j = 0; j < caps.services.length && j < 8; j++) {
        var s = caps.services[j];
        send({ type: 'log', msg: 'svc[' + s.kind + '] via ' + s.src + ' key=' + s.key });
      }
      return 'stopped:w=' + caps.widgets.length + ':s=' + caps.services.length;
    };
    return 'capture-started:' + (reason || 'unknown');
  };
  window.__ijFindRefreshCapture = function (reason) {
    try { window.__ijFindMonaco = null; } catch (eMonaco) {}
    return window.__ijFindStartCapture(reason || 'refresh');
  };
  window.__ijFindStartCapture('patch-load');
  // No auto-stop — extension controls the lifecycle via CDP. Patches
  // stay installed until __ijFindStopCapture is explicitly invoked.

  // ── Standalone widget creation experiment (V36) ─────────────────────
  // Uses the captured IInstantiationService + widget constructor to try
  // creating a real monaco CodeEditorWidget rooted at a host div of our
  // choosing — without opening any editor group or tab. Logs everything
  // and briefly shows the widget for visual confirmation.
  // ── Preview integration helpers ────────────────────────────────────
  // Once __ijFindMonaco is populated (by the diagnostic's test widget
  // succeeding), renderPreview can spin up a real CodeEditorWidget rooted
  // in our overlay's preview pane. Services are borrowed from the widget
  // that was already alive in VSCode — theme / font / extensions all come
  // through automatically.
  // Dedicated overflow host for the preview editors overflow widgets
  // (hover, suggest, parameter hints, code action lightbulb, etc.).
  //
  // Requirements:
  //   1. Live as a body-level sibling of our overlay. If this stays inside
  //      .monaco-workbench, the workbench stacking context can still keep
  //      native Monaco hover/suggest widgets underneath the search panel.
  //   2. Carry .monaco-workbench + .monaco-editor ancestry so Monacos widget
  //      styles such as ".monaco-editor .monaco-hover" still match.
  //   3. Copy VS Code theme custom properties from the real workbench so
  //      --vscode-editorHoverWidget-background and friends resolve.
  //   4. Stack above our overlay panel (z-index 2147483000) so the hover
  //      popup isnt hidden behind the preview UI.
  //   5. Take no visual space itself (0x0 box) and not intercept input
  //      outside the widgets own bounds.
  function syncPreviewOverflowTheme(root) {
    try {
      var source = document.querySelector('.monaco-workbench') || document.body;
      if (!source || !root || !window.getComputedStyle) { return; }
      var cs = window.getComputedStyle(source);
      for (var i = 0; i < cs.length; i++) {
        var name = cs[i];
        if (name && name.indexOf('--vscode-') === 0) {
          var value = cs.getPropertyValue(name);
          if (value) { root.style.setProperty(name, value); }
        }
      }
      root.style.setProperty('color', cs.getPropertyValue('--vscode-foreground') || cs.color || 'inherit');
      root.style.setProperty('font-family', cs.getPropertyValue('--vscode-font-family') || cs.fontFamily || 'inherit');
      root.style.setProperty('font-size', cs.getPropertyValue('--vscode-font-size') || cs.fontSize || 'inherit');
    } catch (e) {}
  }
  function getOrCreatePreviewOverflowHost() {
    var root = document.querySelector('.ij-find-preview-overflow-root');
    var existing = root && root.querySelector('.ij-find-preview-overflow');
    if (existing && existing.parentElement) {
      if (root.parentElement !== document.body) { document.body.appendChild(root); }
      syncPreviewOverflowTheme(root);
      return existing;
    }
    root = document.createElement('div');
    root.className = 'monaco-workbench ij-find-preview-overflow-root';
    root.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'width:0',
      'height:0',
      'overflow:visible',
      'z-index:2147483600',
      'pointer-events:none',
    ].join(';');
    var node = document.createElement('div');
    node.className = 'monaco-editor ij-find-preview-overflow';
    node.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'width:0',
      'height:0',
      'overflow:visible',
      'z-index:2147483600',
      'pointer-events:none',
    ].join(';');
    root.appendChild(node);
    syncPreviewOverflowTheme(root);
    document.body.appendChild(root);
    return node;
  }

  function errorText(e) {
    try {
      return String((e && (e.message || e.description)) || e || '');
    } catch (err) {
      return '';
    }
  }
  function isDisposedText(text) {
    return /disposed/i.test(String(text || ''));
  }
  function isInstantiationServiceLike(v) {
    return !!(v && typeof v.createInstance === 'function' && typeof v.invokeFunction === 'function');
  }
  function isModelServiceLike(v) {
    return !!(v && typeof v.createModel === 'function' && typeof v.getModel === 'function' && typeof v.getModels === 'function');
  }
  function validateInstantiationService(inst) {
    if (!isInstantiationServiceLike(inst)) { return 'missing-inst'; }
    try {
      inst.invokeFunction(function () { return true; });
      return '';
    } catch (e) {
      return 'bad-inst:' + errorText(e).slice(0, 160);
    }
  }
  function validateModelService(modelSvc) {
    if (!isModelServiceLike(modelSvc)) { return 'missing-modelSvc'; }
    try {
      modelSvc.getModels();
      return '';
    } catch (e) {
      return 'bad-modelSvc:' + errorText(e).slice(0, 160);
    }
  }
  function describeMonacoState() {
    var m = window.__ijFindMonaco;
    if (!m) { return { ready: false, reason: 'none', disposed: false }; }
    if (!m.ctor) { return { ready: false, reason: 'missing-ctor', disposed: false }; }
    var instErr = validateInstantiationService(m.inst);
    if (instErr) { return { ready: false, reason: instErr, disposed: isDisposedText(instErr) }; }
    var modelErr = validateModelService(m.modelSvc);
    if (modelErr) { return { ready: false, reason: modelErr, disposed: isDisposedText(modelErr) }; }
    return { ready: true, reason: 'ready', disposed: false };
  }
  window.__ijFindMonacoStatus = function () {
    var status = describeMonacoState();
    if (!status.ready && status.disposed) {
      try { window.__ijFindMonaco = null; } catch (e) {}
    }
    return status.ready ? 'ready' : ('not-ready:' + status.reason);
  };
  window.__ijFindInvalidateMonaco = function (reason) {
    try { window.__ijFindMonaco = null; } catch (e) {}
    return 'invalidated:' + (reason || 'unknown');
  };

  function addInstCandidate(out, inst, label) {
    if (!isInstantiationServiceLike(inst)) { return; }
    for (var i = 0; i < out.length; i++) {
      if (out[i].inst === inst) { return; }
    }
    out.push({ inst: inst, label: label });
  }
  function addModelServiceCandidate(out, modelSvc, label) {
    if (!isModelServiceLike(modelSvc)) { return; }
    for (var i = 0; i < out.length; i++) {
      if (out[i].modelSvc === modelSvc) { return; }
    }
    out.push({ modelSvc: modelSvc, label: label });
  }
  function addWidgetInstantiationServices(out, widget, label, report) {
    if (!widget) { return; }
    try {
      if (widget._instantiationService) {
        addInstCandidate(out, widget._instantiationService, label + '._instantiationService');
      }
    } catch (eDirect) {}
    try {
      var keys = Object.getOwnPropertyNames(widget);
      for (var i = 0; i < keys.length; i++) {
        var v;
        try { v = widget[keys[i]]; } catch (e) { continue; }
        if (isInstantiationServiceLike(v)) {
          addInstCandidate(out, v, label + '.' + keys[i]);
        }
      }
    } catch (eKeys) {
      if (report) { report.push('inst scan err ' + label + ': ' + errorText(eKeys).slice(0, 80)); }
    }
  }
  function addWidgetModelServices(out, widget, label, report) {
    if (!widget) { return; }
    try {
      var keys = Object.getOwnPropertyNames(widget);
      for (var i = 0; i < keys.length; i++) {
        var v;
        try { v = widget[keys[i]]; } catch (e) { continue; }
        if (isModelServiceLike(v)) {
          addModelServiceCandidate(out, v, label + '.' + keys[i]);
        }
      }
    } catch (eKeys) {
      if (report) { report.push('modelSvc scan err ' + label + ': ' + errorText(eKeys).slice(0, 80)); }
    }
  }
  function collectInstantiationServiceCandidates(includeDom, report) {
    var out = [];
    if (includeDom) {
      try {
        var editors = document.querySelectorAll('.editor-group-container .monaco-editor');
        for (var i = 0; i < editors.length; i++) {
          var widget = findMonacoWidget(editors[i]);
          addWidgetInstantiationServices(out, widget, 'dom[' + i + ']', report);
        }
      } catch (eDom) {
        if (report) { report.push('dom inst scan err: ' + errorText(eDom).slice(0, 100)); }
      }
    }
    try {
      var m = window.__ijFindMonaco;
      if (m && m.inst) { addInstCandidate(out, m.inst, 'cached'); }
    } catch (eCached) {}
    var c = null;
    try { c = window.__ijFindCaptures || caps; } catch (eCaps) {}
    if (c) {
      try {
        for (var wi = 0; c.widgets && wi < c.widgets.length; wi++) {
          addWidgetInstantiationServices(out, c.widgets[wi].v, 'captured-widget[' + wi + ']', report);
        }
      } catch (eW) {}
      try {
        for (var si = 0; c.services && si < c.services.length; si++) {
          if (c.services[si].kind === 'IInstantiationService') {
            addInstCandidate(out, c.services[si].v, 'captured-service[' + si + ']');
          }
        }
      } catch (eS) {}
    }
    return out;
  }
  function collectModelServiceCandidates(includeDom, report) {
    var out = [];
    if (includeDom) {
      try {
        var editors = document.querySelectorAll('.editor-group-container .monaco-editor');
        for (var i = 0; i < editors.length; i++) {
          var widget = findMonacoWidget(editors[i]);
          addWidgetModelServices(out, widget, 'dom[' + i + ']', report);
        }
      } catch (eDom) {
        if (report) { report.push('dom modelSvc scan err: ' + errorText(eDom).slice(0, 100)); }
      }
    }
    try {
      var m = window.__ijFindMonaco;
      if (m && m.modelSvc) { addModelServiceCandidate(out, m.modelSvc, 'cached'); }
    } catch (eCached) {}
    var c = null;
    try { c = window.__ijFindCaptures || caps; } catch (eCaps) {}
    if (c) {
      try {
        for (var wi = 0; c.widgets && wi < c.widgets.length; wi++) {
          addWidgetModelServices(out, c.widgets[wi].v, 'captured-widget[' + wi + ']', report);
        }
      } catch (eW) {}
      try {
        for (var si = 0; c.services && si < c.services.length; si++) {
          if (c.services[si].kind === 'IModelService') {
            addModelServiceCandidate(out, c.services[si].v, 'captured-service[' + si + ']');
          }
        }
      } catch (eS) {}
    }
    return out;
  }
  function chooseLiveModelService(includeDom, report) {
    var modelCandidates = collectModelServiceCandidates(includeDom, report);
    for (var i = 0; i < modelCandidates.length; i++) {
      var err = validateModelService(modelCandidates[i].modelSvc);
      if (!err) { return modelCandidates[i]; }
      if (report) { report.push('SKIP modelSvc ' + modelCandidates[i].label + ': ' + err); }
    }
    return null;
  }

  window.__ijFindCreatePreviewEditor = function (host) {
    var m = window.__ijFindMonaco;
    if (!m || !m.ctor) { return null; }
    var overflowHost = getOrCreatePreviewOverflowHost();
    var options = {
      automaticLayout: true,
      readOnly: false,
      minimap: { enabled: !state || state.minimapEnabled !== false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'all',
      fixedOverflowWidgets: true,
      overflowWidgetsDomNode: overflowHost,
      // Sticky scroll (the header that pins the current function/class
      // as you scroll) adds visual noise to a read-mostly preview.
      stickyScroll: { enabled: false },
      // Keep selection/clipboard behavior first-class: copyWithSyntax…
      // lets Cmd+C inside preview carry styled text into other apps,
      // and contextmenu re-enables the right-click "Copy" entry that
      // capture's widgetOpts=bare would otherwise leave unwired.
      contextmenu: true,
      copyWithSyntaxHighlighting: true,
      // Show a 2-lane overview ruler and cursor position marker on the
      // scrollbar so the user can see where their cursor is while
      // scrolling a long file.
      overviewRulerLanes: 3,
      hideCursorInOverviewRuler: false,
    };
    var insts = collectInstantiationServiceCandidates(true, null);
    var sawDisposed = false;
    for (var i = 0; i < insts.length; i++) {
      var instErr = validateInstantiationService(insts[i].inst);
      if (instErr) {
        if (isDisposedText(instErr)) { sawDisposed = true; }
        send({ type: 'log', msg: 'createPreviewEditor skip inst ' + insts[i].label + ': ' + instErr });
        continue;
      }
      try {
        var editor = insts[i].inst.createInstance(m.ctor, host, options, m.widgetOptions || { isSimpleWidget: false });
        m.inst = insts[i].inst;
        var modelChoice = chooseLiveModelService(true, null);
        if (modelChoice) { m.modelSvc = modelChoice.modelSvc; }
        send({ type: 'log', msg: 'createPreviewEditor using inst ' + insts[i].label });
        return editor;
      } catch (e) {
        var msg = errorText(e);
        if (isDisposedText(msg)) { sawDisposed = true; }
        send({ type: 'log', msg: 'createPreviewEditor err via ' + insts[i].label + ': ' + msg.slice(0, 160) });
      }
    }
    if (sawDisposed) {
      try { window.__ijFindMonaco = null; } catch (eClear) {}
    }
    return null;
  };
  // Look up an existing TextModel in VSCode's ModelService by URI string.
  // When a file is open in VSCode (or has been touched via
  // vscode.workspace.openTextDocument), its model is registered here and
  // shared with any widget attached to it. Reusing it means edits in our
  // preview propagate straight into VSCode's buffer (and any open tab on
  // the same file picks the change up in real time).
  function findSharedModelByUri(uriStr) {
    if (!uriStr) { return null; }
    var m = window.__ijFindMonaco;
    if (!m || !m.modelSvc) { return null; }
    try {
      var models = typeof m.modelSvc.getModels === 'function' ? m.modelSvc.getModels() : [];
      for (var i = 0; i < models.length; i++) {
        var mdl = models[i];
        try {
          if (mdl && mdl.uri && typeof mdl.uri.toString === 'function' && mdl.uri.toString() === uriStr) {
            return mdl;
          }
        } catch (eLoop) {}
      }
    } catch (e) {}
    return null;
  }

  window.__ijFindSetPreviewContent = function (editor, content, languageId, uriStr) {
    var m = window.__ijFindMonaco;
    if (!m || !editor) { return false; }
    if (!m.modelSvc || validateModelService(m.modelSvc)) {
      var modelChoice = chooseLiveModelService(true, null);
      if (modelChoice) { m.modelSvc = modelChoice.modelSvc; }
    }
    if (!m.modelSvc || validateModelService(m.modelSvc)) { return false; }
    try {
      var shared = findSharedModelByUri(uriStr);
      var old = editor.getModel && editor.getModel();
      if (shared) {
        // Share VSCode's buffer. Edits flow both ways. Do NOT overwrite
        // its content — VSCode's buffer may have unsaved edits newer than
        // whatever content we were handed.
        if (old === shared) { return true; }
        editor.setModel(shared);
        // Only dispose the OLD model if it's one we created ourselves
        // (not registered under a real URI). Disposing a shared VSCode
        // model would break every other editor that references it.
        if (old && old.dispose && old !== shared) {
          var isIsolated = false;
          try { isIsolated = !(old.uri && old.uri.scheme && old.uri.scheme !== 'inmemory'); } catch (eU) { isIsolated = false; }
          if (isIsolated) { try { old.dispose(); } catch (eD) {} }
        }
        send({ type: 'log', msg: 'setPreviewContent: reused shared model uri=' + uriStr });
        return true;
      }
      // Fall back to an isolated model when the file isn't in VSCode's
      // ModelService. Edits here stay in-memory until the user saves.
      var model = m.modelSvc.createModel(content || '', languageId || 'plaintext');
      editor.setModel(model);
      if (old && old.dispose && old !== model) { try { old.dispose(); } catch (e) {} }
      send({ type: 'log', msg: 'setPreviewContent: isolated model (no shared model for ' + uriStr + ')' });
      return true;
    } catch (e) {
      var msg = errorText(e);
      if (isDisposedText(msg)) {
        try { window.__ijFindMonaco = null; } catch (eClear) {}
      }
      send({ type: 'log', msg: 'setPreviewContent err: ' + msg });
      return false;
    }
  };

  function findRealWidgetCtor(widget, report) {
    if (!widget) { return null; }
    try {
      var p = Object.getPrototypeOf(widget);
      var depth = 0;
      while (p && depth < 12) {
        var keys = [];
        try { keys = Object.getOwnPropertyNames(p); } catch (eKeys) {}
        var hasL = keys.indexOf('layout') >= 0;
        var hasM = keys.indexOf('getModel') >= 0;
        var hasD = keys.indexOf('getDomNode') >= 0;
        var ctorName = '?';
        try { ctorName = (p.constructor && p.constructor.name) || '?'; } catch (eName) {}
        if (report) {
          report.push('proto[' + depth + '] ctor=' + ctorName +
            ' hasLGD=' + hasL + '/' + hasM + '/' + hasD +
            ' keys=' + keys.slice(0, 30).join(','));
        }
        if (hasL && hasM && hasD && p.constructor) { return p.constructor; }
        p = Object.getPrototypeOf(p);
        depth++;
      }
    } catch (e) {
      if (report) { report.push('proto walk err: ' + e.message); }
    }
    return null;
  }

  window.__ijFindTestCreateWidget = function () {
    // Fast path: if a previous run already captured the real class + services,
    // don't recreate anything — we'd just burn a boot-time stub slot. Renderer
    // globals survive extension-host restarts, so this hits on warm reloads.
    try {
      var existing = window.__ijFindMonaco;
      if (existing && existing.ctor && window.__ijFindMonacoStatus && window.__ijFindMonacoStatus() === 'ready') {
        return 'monaco-already-captured ctor=' + (existing.ctor.name || '?');
      }
    } catch (e) {}
    var caps = window.__ijFindCaptures;
    if (!caps || !caps.services || caps.services.length === 0) {
      return 'no-services-captured';
    }
    var report = [];

    // Filter widgets to those whose getModel() actually returns a Model with
    // a uri — those are REAL editor widgets, not DI stubs / no-op proxies.
    var realWidgets = [];
    for (var wi = 0; wi < caps.widgets.length; wi++) {
      var cap = caps.widgets[wi];
      var vv = cap.v;
      try {
        var m = vv.getModel && vv.getModel();
        var uri = m && m.uri && (m.uri.toString ? m.uri.toString() : String(m.uri));
        var tag = '';
        var connected = false;
        var inEditorGroup = false;
        try {
          var d = vv.getDomNode && vv.getDomNode();
          if (d && d.tagName) { tag = d.tagName; }
          connected = !!(d && d.isConnected);
          inEditorGroup = !!(d && d.closest && d.closest('.editor-group-container'));
        } catch (e) {}
        if (uri && uri !== '?' && connected) {
          realWidgets.push({ v: vv, src: cap.src, key: cap.key, uri: uri, tag: tag, inEditorGroup: inEditorGroup });
        }
      } catch (e) {}
    }
    report.push('captured widgets total=' + caps.widgets.length + ' connectedReal=' + realWidgets.length);
    report.push('widgetCtors=' + caps.widgetCtors.length + ' serviceMaps=' + caps.serviceMaps.length);

    // 1. Candidates: real widget proto-walk first, then whatever was captured.
    var candidates = [];
    function pushCandidate(ctor, src) {
      if (!ctor) { return; }
      for (var ci = 0; ci < candidates.length; ci++) {
        if (candidates[ci].ctor === ctor) { return; }
      }
      candidates.push({ ctor: ctor, src: src });
    }
    var w0 = realWidgets[0] && realWidgets[0].v;
    if (realWidgets.length > 0) {
      report.push('real[0] uri=' + realWidgets[0].uri.slice(0, 100) + ' tag=' + realWidgets[0].tag + ' inGroup=' + realWidgets[0].inEditorGroup);
    }
    var realCtor = findRealWidgetCtor(w0, report);
    pushCandidate(realCtor, 'real-widget-proto');
    for (var i = 0; i < caps.widgetCtors.length; i++) {
      pushCandidate(caps.widgetCtors[i], 'captured[' + i + ']');
    }

    // 2. Log real info from the captured widget so we know what we're looking at.
    if (w0) {
      try {
        var model = w0.getModel && w0.getModel();
        if (model) {
          var uri = (model.uri && model.uri.toString) ? model.uri.toString() : '?';
          var lang = (model.getLanguageId && model.getLanguageId()) || '?';
          report.push('widget[0].model uri=' + uri.slice(0, 100) + ' lang=' + lang);
        } else { report.push('widget[0].getModel()=null'); }
      } catch (e) { report.push('getModel err: ' + e.message); }
      try {
        var dom = w0.getDomNode && w0.getDomNode();
        if (dom) {
          report.push('widget[0].dom tag=' + dom.tagName + ' class=' + (dom.className || '').slice(0, 80));
        }
      } catch (e) { report.push('getDomNode err: ' + e.message); }
    }

    // 3. Describe candidate ctors (kind, name, source preview).
    for (var ci = 0; ci < candidates.length; ci++) {
      var cc = candidates[ci];
      var nm = '?';
      try { nm = cc.ctor && cc.ctor.name || '?'; } catch (e) {}
      var ss = '';
      try { ss = String(cc.ctor).slice(0, 80).replace(/\\s+/g, ' '); } catch (e) {}
      report.push('cand[' + ci + '] from=' + cc.src + ' name=' + nm + ' src=' + ss);
    }

    // 4. Gather live instantiation-service candidates. Prefer services from
    // currently connected editor DOM, then fall back to captured services.
    var instCandidates = [];
    addWidgetInstantiationServices(instCandidates, w0, 'widget[0]', report);
    var collectedInsts = collectInstantiationServiceCandidates(true, report);
    for (var is = 0; is < collectedInsts.length; is++) {
      addInstCandidate(instCandidates, collectedInsts[is].inst, collectedInsts[is].label);
    }
    report.push('inst candidates=' + instCandidates.map(function (x) { return x.label; }).slice(0, 10).join(','));

    // 5. Create an off-screen host (invisible) and try each candidate. The
    //    host only needs to live long enough for createInstance + setModel +
    //    layout — we dispose it ~1s later. No visible test box.
    var host = document.createElement('div');
    host.className = 'ij-find-test-widget-host';
    host.style.cssText = [
      'position: fixed',
      'top: -99999px',
      'left: -99999px',
      'width: 640px',
      'height: 360px',
      'visibility: hidden',
      'pointer-events: none',
      'z-index: -1',
    ].join(';') + ';';
    document.body.appendChild(host);

    var testOptions = {
      value: 'const x = 42;',
      language: 'javascript',
      automaticLayout: true,
      readOnly: false,
      theme: 'vs-dark',
    };
    var widgetOptionCandidates = [
      { value: { isSimpleWidget: false }, label: 'widgetOpts=bare' },
      { value: { isSimpleWidget: false, contributions: [] }, label: 'widgetOpts=contributions' },
    ];

    var createdEditor = null;
    var winnerWidgetOptions = null;
    var winnerInst = null;
    for (var ii = 0; ii < instCandidates.length && !createdEditor; ii++) {
      var inst = instCandidates[ii].inst;
      var instLabel = instCandidates[ii].label;
      var instErr = validateInstantiationService(inst);
      if (instErr) {
        report.push('SKIP inst ' + instLabel + ': ' + instErr);
        continue;
      }
      for (var cj = 0; cj < candidates.length && !createdEditor; cj++) {
        var Ctor = candidates[cj].ctor;
        var srcLabel = candidates[cj].src;
        var attempts = [];
        for (var wo = 0; wo < widgetOptionCandidates.length; wo++) {
          (function (entry, instForAttempt) {
            attempts.push({
              fn: function (C) { return instForAttempt.createInstance(C, host, testOptions, entry.value); },
              label: 'createInstance(host,opts,' + entry.label + ')',
              widgetOptions: entry.value,
            });
            attempts.push({
              fn: function (C) { return new C(host, testOptions, entry.value); },
              label: 'new(host,opts,' + entry.label + ')',
              widgetOptions: entry.value,
            });
          })(widgetOptionCandidates[wo], inst);
        }
        (function (instForAttempt) {
          attempts.push({ fn: function (C) { return instForAttempt.createInstance(C, host, testOptions); }, label: 'createInstance(host,opts)', widgetOptions: null });
          attempts.push({ fn: function (C) { return new C(host, testOptions); }, label: 'new(host,opts)', widgetOptions: null });
        })(inst);
        for (var aa = 0; aa < attempts.length && !createdEditor; aa++) {
          try {
            var ed = attempts[aa].fn(Ctor);
            if (ed && typeof ed === 'object') {
              createdEditor = ed;
              winnerInst = inst;
              winnerWidgetOptions = attempts[aa].widgetOptions;
              report.push('OK ' + srcLabel + ' via ' + instLabel + ' ' + attempts[aa].label + ' → ' + (ed.constructor && ed.constructor.name));
              break;
            }
          } catch (e) {
            report.push('ERR ' + srcLabel + ' via ' + instLabel + ' ' + attempts[aa].label + ' : ' + errorText(e).slice(0, 160));
          }
        }
      }
    }

    if (!createdEditor) {
      try { document.body.removeChild(host); } catch (e) {}
      return report.join(' | ');
    }

    // ── Persist captured services so renderPreview can create real
    // monaco widgets long after capture stops ─────────────────────────
    var winnerCtor = realCtor || findRealWidgetCtor(createdEditor, report);
    if (!winnerCtor) {
      for (var cw = 0; cw < candidates.length; cw++) {
        if (createdEditor && createdEditor.constructor === candidates[cw].ctor) {
          winnerCtor = candidates[cw].ctor;
          break;
        }
      }
    }
    if (!winnerCtor) { winnerCtor = candidates[0] && candidates[0].ctor; }
    window.__ijFindMonaco = {
      ctor: winnerCtor,
      inst: winnerInst,
      modelSvc: null, // filled below
      widgetOptions: winnerWidgetOptions || { isSimpleWidget: false },
    };

    // ── Post-create: force proper rendering ───────────────────────────
    // Widget was constructed, but content likely isn't rendered because the
    // implicit \`value\` option didn't seed a model in this context. Use the
    // captured IModelService to create a real TextModel and assign it, then
    // explicitly call layout() with the host's size.
    var modelChoice = chooseLiveModelService(true, report);
    var modelSvc = modelChoice && modelChoice.modelSvc;
    if (modelChoice) { report.push('using modelSvc ' + modelChoice.label); }
    report.push('IModelService found=' + !!modelSvc);
    window.__ijFindMonaco.modelSvc = modelSvc;

    try {
      var currentModel = createdEditor.getModel && createdEditor.getModel();
      report.push('before model: ' + (currentModel ? 'has model uri=' + (currentModel.uri && currentModel.uri.toString && currentModel.uri.toString().slice(0, 80)) : 'null'));
    } catch (e) { report.push('getModel check err: ' + e.message); }

    if (modelSvc) {
      try {
        // Signature typically: createModel(value, languageSelection, resource?, isForSimpleWidget?)
        // Try with just value + language id string first.
        var newModel;
        try {
          newModel = modelSvc.createModel('const x = 42;\\nconst y = "hello";', 'javascript');
          report.push('createModel(value,lang) → ' + (newModel && newModel.constructor && newModel.constructor.name));
        } catch (e1) {
          report.push('createModel(value,lang) ERR: ' + String(e1 && e1.message || e1).slice(0, 120));
          try {
            // Fallback: create without language selection
            newModel = modelSvc.createModel('const x = 42;');
            report.push('createModel(value) → ' + (newModel && newModel.constructor && newModel.constructor.name));
          } catch (e2) {
            report.push('createModel(value) ERR: ' + String(e2 && e2.message || e2).slice(0, 120));
          }
        }
        if (newModel) {
          try {
            createdEditor.setModel(newModel);
            report.push('setModel OK');
          } catch (e) { report.push('setModel ERR: ' + String(e && e.message).slice(0, 120)); }
        }
      } catch (e) { report.push('modelSvc flow ERR: ' + e.message); }
    }

    try {
      var rect = host.getBoundingClientRect();
      createdEditor.layout({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
      report.push('layout(' + Math.floor(rect.width) + 'x' + Math.floor(rect.height) + ') called');
    } catch (e) { report.push('layout ERR: ' + e.message); }

    // Diagnostics about visible content.
    try {
      var mdom = createdEditor.getDomNode && createdEditor.getDomNode();
      var viewLines = mdom && mdom.querySelectorAll && mdom.querySelectorAll('.view-line');
      var innerLen = mdom && mdom.innerHTML ? mdom.innerHTML.length : 0;
      report.push('post-render: viewLines=' + (viewLines ? viewLines.length : '?') + ' innerHTML.len=' + innerLen);
      var m2 = createdEditor.getModel && createdEditor.getModel();
      if (m2) {
        report.push('post-render model uri=' + (m2.uri && m2.uri.toString && m2.uri.toString().slice(0, 80)) + ' lineCount=' + (m2.getLineCount && m2.getLineCount()));
      }
    } catch (e) { report.push('post-render check ERR: ' + e.message); }

    window.__ijFindTestEditorRef = createdEditor;
    window.__ijFindTestHostRef = host;
    setTimeout(function () {
      try { createdEditor.dispose(); } catch (e) {}
      try { document.body.removeChild(host); } catch (e) {}
      send({ type: 'log', msg: 'test widget disposed' });
    }, 1000);

    return report.join(' | ') + ' | off-screen host, disposes in 1s';
  };

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
    '.ij-find-search-row { display: flex; gap: 6px; align-items: flex-start; }',
    '.ij-find-scope-row { margin-top: 6px; }',
    '.ij-find-query-group {',
    '  flex: 1; display: flex; gap: 4px; align-items: flex-start;',
    '  min-width: 0;',
    '}',
    '.ij-find-query {',
    '  flex: 1; padding: 5px 8px;',
    '  min-width: 0;',
    '  font-family: var(--vscode-editor-font-family, monospace);',
    '  font-size: 13px;',
    '  line-height: 1.4;',
    '  background: var(--vscode-input-background, #3c3c3c);',
    '  color: var(--vscode-input-foreground, #cccccc);',
    '  border: 1px solid var(--vscode-input-border, transparent);',
    '  border-radius: 2px; outline: none;',
    '  resize: none;',
    '  overflow-y: auto; overflow-x: hidden;',
    '  min-height: 26px; max-height: 160px;',
    '  white-space: pre-wrap;',
    '  box-sizing: border-box;',
    '}',
    '.ij-find-query:focus { border-color: var(--vscode-focusBorder, #007acc); }',
    '.ij-find-history-wrap {',
    '  position: relative;',
    '  flex: 0 0 auto;',
    '}',
    '.ij-find-history {',
    '  height: 26px; min-width: 78px; padding: 0 18px 0 7px;',
    '  font-size: 11px;',
    '  font-family: var(--vscode-editor-font-family, monospace);',
    '  background: transparent;',
    '  color: var(--vscode-foreground, #cccccc);',
    '  border: 1px solid transparent;',
    '  border-radius: 3px; outline: none;',
    '  cursor: pointer;',
    '  box-sizing: border-box;',
    '  position: relative;',
    '}',
    '.ij-find-history::after {',
    '  content: "";',
    '  position: absolute; right: 7px; top: 50%; margin-top: -2px;',
    '  border-left: 4px solid transparent;',
    '  border-right: 4px solid transparent;',
    '  border-top: 5px solid currentColor;',
    '  opacity: 0.8;',
    '}',
    '.ij-find-history:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08)); }',
    '.ij-find-history:focus { border-color: var(--vscode-focusBorder, #007acc); }',
    '.ij-find-history[aria-expanded="true"] {',
    '  background: var(--vscode-inputOption-activeBackground, rgba(14,99,156,0.5));',
    '  color: var(--vscode-inputOption-activeForeground, #ffffff);',
    '  border-color: var(--vscode-inputOption-activeBorder, #007acc);',
    '}',
    '.ij-find-history:disabled { opacity: 0.45; cursor: default; }',
    '.ij-find-history:disabled:hover { background: transparent; }',
    '.ij-find-history-menu {',
    '  position: absolute; top: 30px; right: 0;',
    '  width: 340px; max-width: min(340px, calc(100vw - 48px));',
    '  max-height: 220px; overflow: auto;',
    '  display: none;',
    '  z-index: 2147483005;',
    '  background: var(--vscode-editorWidget-background, #252526);',
    '  color: var(--vscode-foreground, #cccccc);',
    '  border: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, #454545));',
    '  border-radius: 3px;',
    '  box-shadow: 0 8px 28px rgba(0,0,0,0.45);',
    '  padding: 3px 0;',
    '}',
    '.ij-find-history-menu.open { display: block; }',
    '.ij-find-history-item {',
    '  display: block; width: 100%;',
    '  padding: 5px 9px;',
    '  background: transparent;',
    '  color: inherit;',
    '  border: 0;',
    '  text-align: left;',
    '  font: 12px var(--vscode-editor-font-family, monospace);',
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
    '  cursor: pointer;',
    '}',
    '.ij-find-history-item:hover, .ij-find-history-item:focus {',
    '  background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.08));',
    '  outline: none;',
    '}',
    '.ij-find-scope {',
    '  width: 100%; padding: 5px 8px;',
    '  font-family: var(--vscode-editor-font-family, monospace);',
    '  font-size: 12px;',
    '  line-height: 1.4;',
    '  background: var(--vscode-input-background, #3c3c3c);',
    '  color: var(--vscode-input-foreground, #cccccc);',
    '  border: 1px solid var(--vscode-input-border, transparent);',
    '  border-radius: 2px; outline: none;',
    '  box-sizing: border-box;',
    '  min-height: 26px;',
    '}',
    '.ij-find-scope:focus { border-color: var(--vscode-focusBorder, #007acc); }',
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
    '.ij-find-opt[aria-disabled="true"] { opacity: 0.45; cursor: default; }',
    '.ij-find-opt[aria-disabled="true"]:hover { background: transparent; }',
    '.ij-find-opt[aria-pressed="true"] {',
    '  background: var(--vscode-inputOption-activeBackground, rgba(14,99,156,0.5));',
    '  color: var(--vscode-inputOption-activeForeground, #ffffff);',
    '  border-color: var(--vscode-inputOption-activeBorder, #007acc);',
    '}',
    '.ij-find-refresh { min-width: 42px; }',
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
    '  position: relative;',
    '  min-height: 60px;',
    '}',
    '.ij-find-results-inner {',
    '  position: relative;',
    '  min-height: 100%;',
    '}',
    '.ij-find-row {',
    '  display: flex; align-items: center; gap: 12px;',
    '  padding: 1px 12px; cursor: pointer;',
    '  font-family: var(--vscode-editor-font-family, monospace);',
    '  font-size: 12px; line-height: 18px;',
    '  height: 20px; box-sizing: border-box;',
    '}',
    '.ij-find-row:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.05)); }',
    '.ij-find-row.active {',
    '  background: var(--vscode-list-activeSelectionBackground, #094771);',
    '  color: var(--vscode-list-activeSelectionForeground, #ffffff);',
    '}',
    '.ij-find-row-pending { opacity: 0.45; font-style: italic; }',
    '.ij-find-row-pending.active { opacity: 0.8; }',
    '.ij-find-row-info { color: var(--vscode-descriptionForeground, #9d9d9d); cursor: default; }',
    '.ij-find-row-info:hover { background: transparent; }',
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
    '  min-width: 0;',
    '  min-height: 0;',
    '}',
    '.ij-find-preview-header {',
    '  padding: 4px 10px; flex: 0 0 auto;',
    '  display: flex; align-items: center; gap: 6px;',
    '  font-size: 11px;',
    '  color: var(--vscode-descriptionForeground, #9d9d9d);',
    '  border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent));',
    '  user-select: none;',
    '}',
    '.ij-find-preview-path {',
    '  flex: 1 1 auto; min-width: 0;',
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
    '}',
    '.ij-find-minimap-toggle {',
    '  flex: 0 0 auto;',
    '  font-size: 10px; padding: 1px 6px;',
    '  background: transparent;',
    '  color: inherit;',
    '  border: 1px solid var(--vscode-widget-border, #555);',
    '  border-radius: 3px; cursor: pointer;',
    '}',
    '.ij-find-minimap-toggle:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08)); }',
    '.ij-find-minimap-toggle[aria-pressed="true"] {',
    '  background: var(--vscode-inputOption-activeBackground, rgba(14,99,156,0.5));',
    '  color: var(--vscode-inputOption-activeForeground, #ffffff);',
    '  border-color: var(--vscode-inputOption-activeBorder, #007acc);',
    '}',
    '.ij-find-preview-body {',
    '  flex: 1 1 auto; position: relative; overflow: auto;',
    '  font-family: var(--vscode-editor-font-family, monospace);',
    '  font-size: 12px; line-height: 18px;',
    '  padding: 4px 0;',
    '  min-width: 0; min-height: 0;',
    '  scrollbar-gutter: stable both-edges;',
    '}',
    '.ij-find-preview-content {',
    '  min-width: 100%;',
    '  width: max-content;',
    '  min-height: 100%;',
    '}',
    // When a stolen monaco editor is mounted in this body, keep our own
    // padding / typography rules from bleeding into it. Nothing is forced
    // on the .monaco-editor child — we size it via inline style in JS.
    '.ij-find-preview-body.ij-find-stolen {',
    '  padding: 0;',
    '  overflow: hidden;',
    '  font-family: unset;',
    '  font-size: unset;',
    '  line-height: unset;',
    '  color: unset;',
    '}',
    '.ij-find-preview-line {',
    '  display: flex; gap: 8px; padding: 0 10px; white-space: pre;',
    '  width: max-content; min-width: 100%; box-sizing: border-box;',
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
    '.ij-find-preview-text { flex: 0 0 auto; min-width: 0; }',
    // Host element for the embedded Monaco editor. Monaco needs a sized box.
    '.ij-find-monaco-host {',
    '  flex: 1 1 auto; width: 100%; height: 100%; min-height: 0; overflow: hidden;',
    '}',
    // Monaco draws text selection as absolutely-positioned divs behind
    // each glyph. When the editor does not have DOM focus (e.g. user just
    // tabbed back to the query input), Monaco flips to the
    // "inactive selection" color which many themes render as
    // near-transparent — the minimap still shows the selection but the
    // actual editor area looks blank. Force the inactive selection to
    // inherit the active color so drag / Shift+Arrow produces a visible
    // highlight regardless of focus state. Two selectors cover both the
    // "monacoReal" path (ij-find-monaco-preview-host) and the fallback
    // "monaco.editor.create" path (ij-find-monaco-host).
    '.ij-find-monaco-host .monaco-editor .selected-text,',
    '.ij-find-monaco-preview-host .monaco-editor .selected-text {',
    '  background-color: var(--vscode-editor-selectionBackground, rgba(38,79,120,0.75)) !important;',
    '}',
    '.ij-find-modified-dot {',
    '  display: inline-block; width: 8px; height: 8px;',
    '  margin-right: 6px; border-radius: 50%;',
    '  background: var(--vscode-editorWarning-foreground, #cca700);',
    '  vertical-align: middle;',
    '  visibility: hidden;',
    '}',
    '.ij-find-modified .ij-find-modified-dot { visibility: visible; }',
    '.ij-find-edit-btn {',
    '  background: transparent; border: 1px solid var(--vscode-widget-border, #555);',
    '  color: inherit; cursor: pointer;',
    '  font-size: 11px; padding: 1px 8px;',
    '  border-radius: 3px; margin-left: auto;',
    '}',
    '.ij-find-edit-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08)); }',
    '.ij-find-edit-textarea {',
    '  width: 100%; height: 100%;',
    '  border: 0; outline: none; resize: none;',
    '  padding: 6px 10px;',
    '  background: var(--vscode-editor-background, #1e1e1e);',
    '  color: var(--vscode-editor-foreground, #d4d4d4);',
    '  font-family: var(--vscode-editor-font-family, monospace);',
    '  font-size: 12px; line-height: 18px;',
    '  white-space: pre; tab-size: 4;',
    '}',

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
    // Explicit highlight class for Monaco preview decorations. VSCode's
    // built-in .findMatch / .currentFindMatch classes sometimes don't
    // reach our stolen-widget preview instance (theme scoping / CSS
    // variables not resolving the same way), so we ship our own rule
    // with the same theme token as a fallback.
    '.ij-find-preview-match {',
    '  background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33)) !important;',
    '  box-sizing: border-box;',
    '}',
    '.ij-find-preview-match-active {',
    '  background-color: var(--vscode-editor-findMatchBackground, rgba(234, 92, 0, 0.6)) !important;',
    '  box-sizing: border-box;',
    '}',
    // Force the preview editors overflow widgets (hover popup, suggest
    // box, parameter hints, code action glyph, etc.) above our overlay
    // panel. The body-level root avoids the workbench stacking context;
    // descendant z-index stamping covers Monaco widgets that create their
    // own positioned boxes.
    '.ij-find-preview-overflow-root,',
    '.ij-find-preview-overflow {',
    '  position: fixed !important;',
    '  top: 0 !important; left: 0 !important;',
    '  width: 0 !important; height: 0 !important;',
    '  overflow: visible !important;',
    '  z-index: 2147483600 !important;',
    '  pointer-events: none;',
    '}',
    '.ij-find-preview-overflow,',
    '.ij-find-preview-overflow * {',
    '  z-index: 2147483601 !important;',
    '}',
    '.ij-find-preview-overflow .monaco-hover,',
    '.ij-find-preview-overflow .suggest-widget,',
    '.ij-find-preview-overflow .parameter-hints-widget,',
    '.ij-find-preview-overflow .monaco-menu,',
    '.ij-find-preview-overflow .context-view {',
    '  pointer-events: auto;',
    '}',
  ].join('\\n');
  document.head.appendChild(style);

  var $title = el('span', { className: 'ij-find-title', text: 'Find in Files' });
  var $summary = el('span', { className: 'ij-find-summary', text: '' });
  var $close = el('button', { className: 'ij-find-close', title: 'Close (Esc)', text: '\\u00D7' });
  var $header = el('div', { className: 'ij-find-header', children: [$title, $summary, $close] });

  var $q = el('textarea', {
    className: 'ij-find-query',
    attrs: {
      placeholder: 'Search in project... (Shift+Enter for newline)',
      spellcheck: 'false',
      autocomplete: 'off',
      rows: '1',
      wrap: 'soft',
    },
  });
  // Auto-grow: adjust textarea height to fit content, bounded by max-height.
  function autosizeQuery() {
    $q.style.height = 'auto';
    var h = Math.min(160, Math.max(26, $q.scrollHeight));
    $q.style.height = h + 'px';
  }
  var $history = el('button', {
    className: 'ij-find-history',
    text: 'History',
    attrs: {
      type: 'button',
      title: 'Search history',
      'aria-label': 'Search history',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
      disabled: 'true',
    },
  });
  var $historyMenu = el('div', {
    className: 'ij-find-history-menu',
    attrs: { role: 'listbox' },
  });
  var $historyWrap = el('div', { className: 'ij-find-history-wrap', children: [$history, $historyMenu] });
  var $optCase = el('button', { className: 'ij-find-opt', title: 'Match Case (Alt+C)', text: 'Aa', attrs: { 'data-opt': 'caseSensitive', 'aria-pressed': 'false' } });
  var $optWord = el('button', { className: 'ij-find-opt', title: 'Whole Word (Alt+W)', text: 'W', attrs: { 'data-opt': 'wholeWord', 'aria-pressed': 'false' } });
  var $optRegex = el('button', { className: 'ij-find-opt', title: 'Regex (Alt+R)', text: '.*', attrs: { 'data-opt': 'useRegex', 'aria-pressed': 'false' } });
  var $optRegexMultiline = el('button', { className: 'ij-find-opt', title: 'Regex Multiline (Alt+M)', text: 'ML', attrs: { 'data-opt': 'regexMultiline', 'aria-pressed': 'true', 'aria-disabled': 'true' } });
  var $refresh = el('button', { className: 'ij-find-opt ij-find-refresh', title: 'Refresh Search', text: 'Run', attrs: { type: 'button', 'aria-label': 'Refresh search' } });
  var $opts = el('div', { className: 'ij-find-opts', children: [$optCase, $optWord, $optRegex, $optRegexMultiline, $refresh] });
  var $queryGroup = el('div', { className: 'ij-find-query-group', children: [$q, $historyWrap] });
  var $searchRow = el('div', { className: 'ij-find-search-row', children: [$queryGroup, $opts] });
  var $scope = el('input', {
    className: 'ij-find-scope',
    attrs: {
      placeholder: 'Files scope (Ant patterns: src/**, **/*.ts, !**/*.test.ts)',
      spellcheck: 'false',
      autocomplete: 'off',
      type: 'text',
    },
  });
  var $scopeRow = el('div', { className: 'ij-find-scope-row', children: [$scope] });

  var $status = el('span', { className: 'ij-find-status', text: 'Type a query' });
  var $spinner = el('span', { className: 'ij-find-spinner hidden' });
  var $statusRow = el('div', { className: 'ij-find-status-row', children: [$status, $spinner] });

  var $toolbar = el('div', { className: 'ij-find-toolbar', children: [$searchRow, $scopeRow, $statusRow] });
  var $results = el('div', { className: 'ij-find-results', attrs: { tabindex: '0' } });
  var $resultsInner = el('div', { className: 'ij-find-results-inner' });
  $results.appendChild($resultsInner);
  var $splitter = el('div', { className: 'ij-find-splitter', title: 'Drag to resize' });

  var $modifiedDot = el('span', { className: 'ij-find-modified-dot', title: 'Unsaved changes' });
  var $previewPath = el('span', { className: 'ij-find-preview-path', text: '' });
  var $minimapToggle = el('button', {
    className: 'ij-find-minimap-toggle',
    title: 'Toggle minimap',
    text: 'Map',
    attrs: { type: 'button', 'aria-pressed': 'true' },
  });
  var $previewHeader = el('div', { className: 'ij-find-preview-header', children: [$modifiedDot, $previewPath, $minimapToggle] });
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

  // When the preview pane is resized (panel corner drag or splitter), relayout
  // any stolen Monaco editor so it re-fits the available area.
  try {
    var previewResizeObserver = new ResizeObserver(function () {
      if (state && state.stolenEditor) { layoutStolenEditor(); }
    });
    previewResizeObserver.observe($previewBody);
  } catch (e) {}

  var state = {
    options: { caseSensitive: false, wholeWord: false, useRegex: false, regexMultiline: true },
    files: [],
    flat: [],
    candidates: [],             // [{uri, relPath}] — planner-narrowed files, rg hasn't confirmed yet
    candidateTotal: 0,          // total planner candidate count (may exceed what we show)
    confirmedUris: {},          // uri → true once rg emits a match for it
    fileIndexByUri: {},         // uri → index into state.files, so chunked file payloads merge
    searchId: 0,
    hasMoreResults: false,
    loadingMore: false,
    pageSize: 2000,
    lastBatchOffset: 0,
    lastBatchMatches: 0,
    lastBatchFiles: 0,
    lastBatchMode: '',
    activeIndex: -1,
    searching: false,
    debounce: null,
    lastPreviewKey: '',
    previewUri: '',
    previewLanguageId: '',
    hoverReqId: 0,
    hoverTimer: null,
    lastHoverKey: '',
    monacoEditor: null,        // monaco.editor.IStandaloneCodeEditor
    monacoHost: null,          // div hosting the editor
    monacoChangeListener: null,
    minimapEnabled: true,      // persisted via $minimapToggle; every new preview editor honours it
    searchStartTs: 0,          // ms timestamp when results:start arrived; feeds the elapsed-time counter
    searchTicker: null,        // setInterval handle refreshing the status with live elapsed time
    previewMode: '',           // 'monaco' | 'stolen' | 'dom'
    lastPreviewMsg: null,
    editing: false,
    editTextarea: null,
    // DOM-move ("stolen editor") state: we physically relocate a real VSCode
    // editor instance into our preview pane. All editor features (LSP hover,
    // intellisense, undo, everything) come for free.
    stolenEditor: null,        // the .monaco-editor we moved
    stolenEditorOrigParent: null,
    stolenEditorOrigNextSibling: null,
    stolenEditorUri: '',
    stolenEditorWidget: null,  // cached widget reference for .layout() calls
    stolenEditorWidgetSearched: false,
    stolenGroup: null,         // .editor-group-container we shrink to 0
    stolenGroupOrigStyles: null,
    previewMonacoEditor: null,
    previewMonacoHost: null,
    resultsInfoText: '',
    rgScope: '',
    searchHistory: [],
    searchHistoryLimit: 100,
  };
  var RESULT_ROW_HEIGHT = 20;
  var RESULT_OVERSCAN = 12;

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

  function effectiveRegexMultilineValue(opts) {
    return !!(opts && opts.useRegex && opts.regexMultiline !== false);
  }

  function syncRegexMultilineUi() {
    var enabled = !!state.options.useRegex;
    $optRegexMultiline.setAttribute('aria-disabled', enabled ? 'false' : 'true');
  }

  // Render elapsed time as ' (N.Ns)' or ' (Nms)' — appended to status
  // messages so the user sees a live counter during long searches.
  function formatElapsed(ms) {
    if (!ms || ms < 0) { return ''; }
    if (ms < 1000) { return ' (' + ms + 'ms)'; }
    return ' (' + (ms / 1000).toFixed(1) + 's)';
  }
  // Status rewrite used by both results:start/file/candidates while the
  // search is in flight. Keeps the elapsed-time suffix updated on every
  // 100ms ticker tick without duplicating the count-formatting branches.
  function updateSearchingStatus() {
    var elapsed = state.searchStartTs ? Date.now() - state.searchStartTs : 0;
    var matches = 0;
    for (var i = 0; i < state.files.length; i++) { matches += state.files[i].matches.length; }
    var base;
    if (matches > 0) {
      base = matches + ' match' + (matches === 1 ? '' : 'es') + ' in ' + state.files.length +
             ' file' + (state.files.length === 1 ? '' : 's');
    } else if (state.candidateTotal > 0) {
      base = 'Searching ' + state.candidateTotal + ' candidate file' +
             (state.candidateTotal === 1 ? '' : 's') + '\u2026';
    } else {
      base = 'Searching\u2026';
    }
    setStatus(base + formatElapsed(elapsed), true);
  }

  function countVisibleRows() {
    var filterQ = state.filterQuery || '';
    var filterNeedle = filterQ;
    if (filterQ && !state.options.caseSensitive) { filterNeedle = filterQ.toLowerCase(); }
    var visible = 0;
    for (var fi = 0; fi < state.files.length; fi++) {
      var f = state.files[fi];
      for (var mi = 0; mi < f.matches.length; mi++) {
        if (!filterQ) { visible++; continue; }
        var hay = state.options.caseSensitive ? (f.matches[mi].preview || '') : (f.matches[mi].preview || '').toLowerCase();
        if (hay.indexOf(filterNeedle) >= 0) { visible++; }
      }
    }
    return visible;
  }

  function parseScopeInput(raw) {
    if (!raw) { return { includePatterns: [], excludePatterns: [] }; }
    var parts = String(raw).split(/[\\n,;]+/);
    var includePatterns = [];
    var excludePatterns = [];
    var seenInclude = {};
    var seenExclude = {};
    for (var i = 0; i < parts.length; i++) {
      var trimmed = parts[i].trim();
      if (!trimmed) { continue; }
      var target = includePatterns;
      var seen = seenInclude;
      if (trimmed.charAt(0) === '!' || trimmed.charAt(0) === '-') {
        trimmed = trimmed.slice(1).trim();
        target = excludePatterns;
        seen = seenExclude;
      } else if (trimmed.charAt(0) === '+') {
        trimmed = trimmed.slice(1).trim();
      }
      if (!trimmed || seen[trimmed]) { continue; }
      seen[trimmed] = true;
      target.push(trimmed);
    }
    return { includePatterns: includePatterns, excludePatterns: excludePatterns };
  }

  function renderSearchHistory() {
    clearChildren($historyMenu);
    var items = state.searchHistory || [];
    for (var i = 0; i < items.length; i++) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'ij-find-history-item';
      item.setAttribute('role', 'option');
      item.setAttribute('data-history-index', String(i));
      var label = String(items[i]).replace(/[\\r\\n\\t ]+/g, ' ').trim();
      item.textContent = label.length > 96 ? label.slice(0, 93) + '...' : (label || '(blank)');
      item.title = String(items[i]);
      $historyMenu.appendChild(item);
    }
    if (items.length > 0) { $history.removeAttribute('disabled'); }
    else {
      $history.setAttribute('disabled', 'true');
      closeSearchHistory();
    }
  }

  function closeSearchHistory() {
    $historyMenu.classList.remove('open');
    $history.setAttribute('aria-expanded', 'false');
  }

  function openSearchHistory() {
    if (!state.searchHistory || state.searchHistory.length === 0) { return; }
    $historyMenu.classList.add('open');
    $history.setAttribute('aria-expanded', 'true');
  }

  function toggleSearchHistory() {
    if ($historyMenu.classList.contains('open')) { closeSearchHistory(); }
    else { openSearchHistory(); }
  }

  function selectSearchHistory(idx) {
    if (idx >= 0 && state.searchHistory && idx < state.searchHistory.length) {
      $q.value = state.searchHistory[idx];
      autosizeQuery();
      markSearchDirty();
      closeSearchHistory();
      try { $q.focus(); } catch (e) {}
    }
  }

  function markSearchDirty(force) {
    if (state.debounce) { clearTimeout(state.debounce); state.debounce = null; }
    var q = typeof $q.value === 'string' ? $q.value : '';
    if (!q) {
      if (!state.searching) { setStatus('Type a query', false); }
      return;
    }
    if (!state.searching && (force || q !== (state.rgQuery || '') || ($scope.value || '') !== (state.rgScope || ''))) {
      setStatus('Press Enter or Run to search', false);
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

  function normalizeResultPreview(text) {
    var normalized = String(text || '');
    normalized = normalized.split(String.fromCharCode(13)).join(' ');
    normalized = normalized.split(String.fromCharCode(10)).join(' ');
    normalized = normalized.split(String.fromCharCode(8232)).join(' ');
    normalized = normalized.split(String.fromCharCode(8233)).join(' ');
    return normalized;
  }

  function clearPreview() {
    $previewPath.textContent = '';
    $preview.classList.remove('ij-find-modified');
    if (state.stolenEditor) { restoreStolenEditor(); }
    if (state.monacoEditor && state.monacoHost && state.monacoHost.parentElement === $previewBody) {
      // Keep editor in memory; just blank out its model contents.
      try { state.monacoEditor.setValue(''); } catch (e) {}
    } else {
      clearChildren($previewBody);
    }
    state.lastPreviewKey = '';
    state.previewUri = '';
    state.previewLanguageId = '';
    hideHover();
  }

  var _renderPending = false;
  var _resultsViewportPending = false;
  function scheduleRender() {
    if (_renderPending) { return; }
    _renderPending = true;
    requestAnimationFrame(function () {
      _renderPending = false;
      render();
    });
  }

  function scheduleResultsViewportRender() {
    if (_resultsViewportPending) { return; }
    _resultsViewportPending = true;
    requestAnimationFrame(function () {
      _resultsViewportPending = false;
      renderResultsViewport();
    });
  }

  function totalRenderableRows() {
    return state.flat.length + (state.resultsInfoText ? 1 : 0);
  }

  function placeVirtualRow(row, rowIdx) {
    row.style.position = 'absolute';
    row.style.top = (rowIdx * RESULT_ROW_HEIGHT) + 'px';
    row.style.left = '0';
    row.style.right = '0';
  }

  function buildResultRow(flatIdx) {
    var item = state.flat[flatIdx];
    var row;
    if (item.pendingUri) {
      var cPath = item.pendingRelPath || item.pendingUri;
      var cSlash = cPath.lastIndexOf('/');
      var cName = cSlash >= 0 ? cPath.slice(cSlash + 1) : cPath;
      row = el('div', {
        className: 'ij-find-row ij-find-row-pending' + (flatIdx === state.activeIndex ? ' active' : ''),
        attrs: { 'data-flat': String(flatIdx), title: cPath },
        children: [
          el('span', { className: 'ij-find-row-text', text: '\u2026 scanning' }),
          el('span', { className: 'ij-find-row-loc', text: cName }),
        ],
      });
      return row;
    }
    var f = state.files[item.fi];
    var m = f.matches[item.mi];
    var textEl = el('span', { className: 'ij-find-row-text' });
    appendHighlightedInto(textEl, normalizeResultPreview(m.preview), rangesForCurrentQuery(m));
    var slashIdx = f.relPath.lastIndexOf('/');
    var fileName = slashIdx >= 0 ? f.relPath.slice(slashIdx + 1) : f.relPath;
    var locText = fileName + ':' + (m.line + 1);
    return el('div', {
      className: 'ij-find-row' + (flatIdx === state.activeIndex ? ' active' : ''),
      attrs: { 'data-flat': String(flatIdx) },
      children: [
        textEl,
        el('span', {
          className: 'ij-find-row-loc',
          title: f.relPath + ':' + (m.line + 1),
          text: locText,
        }),
      ],
    });
  }

  function buildInfoRow(rowIdx) {
    return el('div', {
      className: 'ij-find-row ij-find-row-info',
      children: [el('span', { className: 'ij-find-row-text', text: state.resultsInfoText })],
    });
  }

  function ensureActiveVisible() {
    if (state.activeIndex < 0 || state.activeIndex >= state.flat.length) { return; }
    var viewportHeight = Math.max($results.clientHeight || 0, RESULT_ROW_HEIGHT);
    var top = state.activeIndex * RESULT_ROW_HEIGHT;
    var bottom = top + RESULT_ROW_HEIGHT;
    var viewTop = $results.scrollTop;
    var viewBottom = viewTop + viewportHeight;
    if (top < viewTop) {
      $results.scrollTop = top;
    } else if (bottom > viewBottom) {
      $results.scrollTop = Math.max(0, bottom - viewportHeight);
    }
  }

  function renderResultsViewport() {
    clearChildren($resultsInner);
    var totalRows = totalRenderableRows();
    if (totalRows === 0) {
      $resultsInner.style.height = 'auto';
      return;
    }
    $resultsInner.style.height = (totalRows * RESULT_ROW_HEIGHT) + 'px';
    var viewportHeight = Math.max($results.clientHeight || 0, RESULT_ROW_HEIGHT * 8);
    var scrollTop = $results.scrollTop;
    var start = Math.max(0, Math.floor(scrollTop / RESULT_ROW_HEIGHT) - RESULT_OVERSCAN);
    var end = Math.min(totalRows, Math.ceil((scrollTop + viewportHeight) / RESULT_ROW_HEIGHT) + RESULT_OVERSCAN);
    var frag = document.createDocumentFragment();
    for (var rowIdx = start; rowIdx < end; rowIdx++) {
      var row = rowIdx < state.flat.length ? buildResultRow(rowIdx) : buildInfoRow(rowIdx);
      placeVirtualRow(row, rowIdx);
      frag.appendChild(row);
    }
    $resultsInner.appendChild(frag);
    maybeLoadMoreResults();
  }

  function render() {
    var hasMatches = state.files.length > 0;
    // Pending candidates: show whenever we have them, whether rg is still
    // scanning OR the search finished with 0 matches (user still wants to
    // see which files were considered).
    var hasPending = state.candidates.length > 0;
    if (!hasMatches && !hasPending) {
      var emptyText = state.searching
        ? 'Searching\u2026'
        : ($q.value ? 'No results' : 'Type to search');
      clearChildren($resultsInner);
      $resultsInner.style.height = 'auto';
      $resultsInner.appendChild(el('div', { className: 'ij-find-empty', text: emptyText }));
      state.flat = [];
      state.resultsInfoText = '';
      setSummary();
      return;
    }
    state.flat = [];
    state.resultsInfoText = '';
    // Extension-typing filter: rg is still scanning (or has finished) the
    // superset query; we narrow each match to the user's current substring.
    var filterQ = state.filterQuery || '';
    var filterNeedle = filterQ;
    if (filterQ && !state.options.caseSensitive) { filterNeedle = filterQ.toLowerCase(); }
    // Confirmed matches first (normal rows, one per match line).
    for (var fi = 0; fi < state.files.length; fi++) {
      var f = state.files[fi];
      for (var mi = 0; mi < f.matches.length; mi++) {
        var m = f.matches[mi];
        if (filterQ) {
          var hay = state.options.caseSensitive ? (m.preview || '') : (m.preview || '').toLowerCase();
          if (hay.indexOf(filterNeedle) < 0) { continue; }
        }
        state.flat.push({ fi: fi, mi: mi });
      }
    }
    // Pending candidate rows: planner-narrowed files that rg hasn't matched
    // yet. Rendered in a muted style; clicking opens the file for preview
    // even before rg confirms a hit. Rows disappear on results:done if no
    // match came back, or upgrade to real match rows as rg emits them.
    if (hasPending) {
      var shown = 0;
      var cap = 200;
      for (var ci = 0; ci < state.candidates.length && shown < cap; ci++) {
        var c = state.candidates[ci];
        if (state.confirmedUris[c.uri]) { continue; }
        state.flat.push({ pendingUri: c.uri, pendingRelPath: c.relPath });
        shown++;
      }
      if (state.candidateTotal > shown + state.files.length) {
        state.resultsInfoText = '+ ' + (state.candidateTotal - shown - state.files.length) +
          ' more candidate file(s) being scanned\u2026';
      }
    }
    if (!state.resultsInfoText) {
      if (state.loadingMore) {
        state.resultsInfoText = 'Loading next ' + state.pageSize + ' results\u2026';
      } else if (state.hasMoreResults) {
        state.resultsInfoText = 'Scroll to load next ' + state.pageSize + ' results\u2026';
      }
    }
    if (state.activeIndex >= state.flat.length) {
      state.activeIndex = state.flat.length > 0 ? state.flat.length - 1 : -1;
    }
    applyActive(false);
    setSummary();
  }

  function applyActive(shouldScroll) {
    if (shouldScroll) { ensureActiveVisible(); }
    renderResultsViewport();
  }

  function selectMatch(flatIdx) {
    if (flatIdx < 0 || flatIdx >= state.flat.length) { return; }
    state.activeIndex = flatIdx;
    applyActive(true);
    var fm = state.flat[flatIdx];
    // Pending candidate row: no match confirmed yet. Preview opens the
    // file at line 0 so the user can skim while rg catches up.
    if (fm.pendingUri) {
      var pkey = fm.pendingUri + '#pending';
      if (pkey === state.lastPreviewKey) { return; }
      state.lastPreviewKey = pkey;
      send({ type: 'requestPreview', uri: fm.pendingUri, line: 0, contextLines: 0 });
      return;
    }
    var f = state.files[fm.fi];
    var m = f.matches[fm.mi];
    var key = f.uri + '#' + m.line;
    if (key === state.lastPreviewKey) { return; }
    state.lastPreviewKey = key;
    // When the user is in extension-typing mode, rg's m.ranges cover the
    // OLD (shorter) query. The preview should highlight what the user
    // actually typed (NEW query) — recompute the range against the new
    // substring so the findMatch decoration lands on the right span.
    var previewRanges = rangesForCurrentQuery(m);
    // Only refresh the overlay's preview pane; do NOT touch VSCode's editor
    // area at all. Arrow-key browsing leaves no trace.
    send({ type: 'requestPreview', uri: f.uri, line: m.line, ranges: previewRanges, contextLines: 0 });
  }

  // If we're in extension-filter mode, compute single-line ranges for the
  // user's NEW query against the match preview. Falls back to whatever rg
  // originally produced when no filter is active (non-extension searches
  // already have accurate ranges).
  function rangesForCurrentQuery(m) {
    var fq = state.filterQuery || '';
    if (!fq) { return m.ranges; }
    var preview = m.preview || '';
    var hay = state.options.caseSensitive ? preview : preview.toLowerCase();
    var needle = state.options.caseSensitive ? fq : fq.toLowerCase();
    var idx = hay.indexOf(needle);
    if (idx < 0) { return m.ranges; }
    return [{ start: idx, end: idx + fq.length }];
  }

  function openActive() {
    if (state.activeIndex < 0 || state.activeIndex >= state.flat.length) { return; }
    var fm = state.flat[state.activeIndex];
    if (fm.pendingUri) {
      // No confirmed line yet — open at the top of the file.
      send({ type: 'pinInSideEditor', uri: fm.pendingUri, line: 0, column: 0 });
      return;
    }
    var f = state.files[fm.fi];
    var m = f.matches[fm.mi];
    var col = (m.ranges && m.ranges[0]) ? m.ranges[0].start : 0;
    // Double-click / Enter — the explicit "open and edit" action. Pins the
    // file in Beside with focus so the user can edit with all real VSCode
    // features (intellisense, hover, save, undo, extensions).
    send({ type: 'pinInSideEditor', uri: f.uri, line: m.line, column: col });
  }

  function triggerSearch(forceRestart, recordHistory) {
    var raw = $q.value;
    var scopeRaw = $scope.value || '';
    // Preserve the query byte-for-byte. Multi-line search selections often
    // begin with indentation, and trimming that indentation changes the
    // literal search target into a different string.
    var q = typeof raw === 'string' ? raw : '';
    var scopePatterns = parseScopeInput(scopeRaw);
    clearPreview();
    if (!q) {
      state.files = []; state.flat = []; state.activeIndex = -1; state.searching = false;
      state.rgQuery = ''; state.filterQuery = ''; state.rgScope = '';
      state.hasMoreResults = false; state.loadingMore = false;
      if (state.searchTicker) { clearInterval(state.searchTicker); state.searchTicker = null; }
      setStatus('Type a query', false);
      render();
      send({ type: 'cancel' });
      return;
    }
    // Smart search-cancellation policy (preserves accuracy):
    //   - Extension (new strictly extends old): the in-flight/finished rg has
    //     the SUPERSET of matches we need. Don't cancel — just re-filter
    //     client-side on preview.includes(newQ) so the visible set becomes
    //     the exact subset for the new query. No wasted rg restart.
    //   - Backspace / disjoint / multi-line / options change: cancel and
    //     restart, because client-side substring filter can't reconstruct
    //     matches we never scanned for (backspace) or can't reliably judge
    //     multi-line spans.
    var oldQ = state.rgQuery || '';
    var oldOpts = state.rgOptions;
    var oldScope = state.rgScope || '';
    var optsChanged = !oldOpts ||
      oldOpts.caseSensitive !== state.options.caseSensitive ||
      oldOpts.wholeWord !== state.options.wholeWord ||
      oldOpts.useRegex !== state.options.useRegex ||
      effectiveRegexMultilineValue(oldOpts) !== effectiveRegexMultilineValue(state.options) ||
      oldScope !== scopeRaw;
    var involvesMultiline = q.indexOf('\\n') >= 0 || oldQ.indexOf('\\n') >= 0;
    // Identical-query guard: same query + same options and NOT a forceRestart.
    // Without this, spurious re-fires (e.g. show() + debounce race, or the
    // extension host bouncing back another 'search' request) each call
    // cancelActive() server-side, killing the in-flight zoekt process before
    // it can deliver results. Codesearch was fast enough to hide this; zoekt
    // process startup is slow enough that the final cancel wins and the user
    // sees "no results" for queries that should succeed.
    if (!forceRestart && !optsChanged && oldQ && q === oldQ) {
      return;
    }
    var isExtension = !forceRestart && oldQ && q.length > oldQ.length && q.indexOf(oldQ) === 0 &&
      !optsChanged && !involvesMultiline;
    if (isExtension) {
      state.filterQuery = q;
      render();
      // Show actual visible match count. state.flat is post-filter, so
      // state.flat.length is what the user sees. Don't blockade the status
      // with "Filtering..." — the user has already found what they need
      // in the list, the background rg scan is just catching extra matches
      // that may or may not pass the filter.
      var visibleRows = countVisibleRows();
      if (state.searching) {
        setStatus(visibleRows + ' match' + (visibleRows === 1 ? '' : 'es') + ' (scanning\u2026)', true);
      } else {
        setStatus(visibleRows + ' match' + (visibleRows === 1 ? '' : 'es'), false);
      }
      return;
    }
    state.rgQuery = q;
    state.rgOptions = {
      caseSensitive: state.options.caseSensitive,
      wholeWord: state.options.wholeWord,
      useRegex: state.options.useRegex,
      regexMultiline: state.options.regexMultiline,
    };
    state.rgScope = scopeRaw;
    state.filterQuery = '';
    state.hasMoreResults = false;
    state.loadingMore = false;
    send({
      type: 'log',
      msg: 'triggerSearch: len=' + q.length + '(raw=' + raw.length + ') hasNL=' +
           (q.indexOf('\\n') >= 0) +
           ' scope=' + JSON.stringify(scopeRaw.slice(0, 120)) +
           ' preview=' + JSON.stringify(q.slice(0, 120)),
    });
    send({
      type: 'search',
      recordHistory: !!recordHistory,
      options: {
        query: q,
        caseSensitive: state.options.caseSensitive,
        wholeWord: state.options.wholeWord,
        useRegex: state.options.useRegex,
        regexMultiline: state.options.regexMultiline,
        includePatterns: scopePatterns.includePatterns,
        excludePatterns: scopePatterns.excludePatterns,
      },
    });
  }

  function scheduleSearch() {
    markSearchDirty();
  }

  function refreshSearch() {
    if (state.debounce) { clearTimeout(state.debounce); state.debounce = null; }
    state.rgQuery = '';
    state.filterQuery = '';
    state.rgScope = '';
    triggerSearch(false, true);
  }

  function requestMoreResults() {
    if (state.searching || state.loadingMore || !state.hasMoreResults || !$q.value) { return; }
    state.loadingMore = true;
    setStatus('Loading next ' + state.pageSize + ' results\u2026', true);
    scheduleRender();
    send({ type: 'loadMore' });
  }

  function maybeLoadMoreResults() {
    if (state.searching || state.loadingMore || !state.hasMoreResults) { return; }
    var viewportHeight = Math.max($results.clientHeight || 0, RESULT_ROW_HEIGHT);
    var threshold = RESULT_ROW_HEIGHT * 6;
    var totalHeight = totalRenderableRows() * RESULT_ROW_HEIGHT;
    var remaining = totalHeight - ($results.scrollTop + viewportHeight);
    if (remaining <= threshold) { requestMoreResults(); }
  }

  function toggleOpt(key, btn) {
    if (btn && btn.getAttribute && btn.getAttribute('aria-disabled') === 'true') { return; }
    state.options[key] = !state.options[key];
    btn.setAttribute('aria-pressed', String(state.options[key]));
    if (key === 'useRegex') { syncRegexMultilineUi(); }
    markSearchDirty(true);
  }

  function moveActive(delta) {
    if (state.flat.length === 0) { return; }
    var next = state.activeIndex < 0
      ? (delta > 0 ? 0 : state.flat.length - 1)
      : Math.max(0, Math.min(state.flat.length - 1, state.activeIndex + delta));
    selectMatch(next);
  }

  $q.addEventListener('input', function () { autosizeQuery(); markSearchDirty(); });
  $scope.addEventListener('input', scheduleSearch);
  $history.addEventListener('click', function (e) {
    e.preventDefault();
    toggleSearchHistory();
  });
  $history.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleSearchHistory();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      openSearchHistory();
      var first = $historyMenu.querySelector('.ij-find-history-item');
      if (first) { try { first.focus(); } catch (eFocus) {} }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearchHistory();
    }
  });
  $historyMenu.addEventListener('click', function (e) {
    var item = e.target instanceof HTMLElement ? e.target.closest('.ij-find-history-item') : null;
    if (!item) { return; }
    e.preventDefault();
    selectSearchHistory(parseInt(item.getAttribute('data-history-index') || '-1', 10));
  });
  $historyMenu.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSearchHistory();
      try { $history.focus(); } catch (eFocus) {}
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      var active = document.activeElement instanceof HTMLElement ? document.activeElement.closest('.ij-find-history-item') : null;
      if (active) {
        e.preventDefault();
        selectSearchHistory(parseInt(active.getAttribute('data-history-index') || '-1', 10));
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      var items = Array.prototype.slice.call($historyMenu.querySelectorAll('.ij-find-history-item'));
      if (items.length === 0) { return; }
      e.preventDefault();
      var current = items.indexOf(document.activeElement);
      var next = e.key === 'ArrowDown'
        ? Math.min(items.length - 1, current + 1)
        : Math.max(0, current - 1);
      if (current < 0) { next = e.key === 'ArrowDown' ? 0 : items.length - 1; }
      try { items[next].focus(); } catch (eFocus2) {}
    }
  });
  document.addEventListener('mousedown', function (e) {
    if (!$historyMenu.classList.contains('open')) { return; }
    if (e.target instanceof Node && $historyWrap.contains(e.target)) { return; }
    closeSearchHistory();
  });
  $q.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      // Shift+Enter: insert literal newline (textarea default) → enables
      // ripgrep multi-line search. Plain Enter: execute the query.
      if (state.debounce) { clearTimeout(state.debounce); }
      e.preventDefault();
      refreshSearch();
    } else if (e.key === 'ArrowDown' && !e.shiftKey) { e.preventDefault(); moveActive(1); }
    else if (e.key === 'ArrowUp' && !e.shiftKey) { e.preventDefault(); moveActive(-1); }
    else if (e.key === 'PageDown') { e.preventDefault(); moveActive(10); }
    else if (e.key === 'PageUp') { e.preventDefault(); moveActive(-10); }
    else if (e.key === 'Escape') { e.preventDefault(); window.__ijFindHide(); }
  });
  $scope.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      if (state.debounce) { clearTimeout(state.debounce); }
      e.preventDefault();
      refreshSearch();
    } else if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
    else if (e.key === 'Escape') { e.preventDefault(); window.__ijFindHide(); }
  });
  $optCase.addEventListener('click', function () { toggleOpt('caseSensitive', $optCase); });
  $optWord.addEventListener('click', function () { toggleOpt('wholeWord', $optWord); });
  $optRegex.addEventListener('click', function () { toggleOpt('useRegex', $optRegex); });
  $optRegexMultiline.addEventListener('click', function () { toggleOpt('regexMultiline', $optRegexMultiline); });
  $refresh.addEventListener('click', refreshSearch);
  function applyMinimapSetting() {
    var ed = state.previewMonacoEditor || state.monacoEditor;
    if (ed && typeof ed.updateOptions === 'function') {
      try { ed.updateOptions({ minimap: { enabled: !!state.minimapEnabled } }); } catch (e) {}
    }
    $minimapToggle.setAttribute('aria-pressed', String(!!state.minimapEnabled));
  }
  applyMinimapSetting();
  $minimapToggle.addEventListener('click', function (e) {
    e.preventDefault();
    state.minimapEnabled = !state.minimapEnabled;
    applyMinimapSetting();
    // Keep focus in the editor so the button click doesn't strand the user
    // with an unfocused preview (re-introduces the inactive-selection bug).
    var ed = state.previewMonacoEditor || state.monacoEditor;
    if (ed && typeof ed.focus === 'function') { try { ed.focus(); } catch (eF) {} }
  });
  $close.addEventListener('click', function () { window.__ijFindHide(); });
  syncRegexMultilineUi();
  renderSearchHistory();

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
    if (flatIdx >= 0) { state.activeIndex = flatIdx; applyActive(true); openActive(); }
  });
  $results.addEventListener('scroll', function () {
    if (state.flat.length > 0 || state.resultsInfoText) { scheduleResultsViewportRender(); }
    maybeLoadMoreResults();
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
    else if (e.altKey && (e.key === 'm' || e.key === 'M')) { e.preventDefault(); toggleOpt('regexMultiline', $optRegexMultiline); }
  });

  // ── Monaco access (aggressive multi-path probe) ─────────────────────
  //
  // VSCode's renderer loads monaco to render every open editor, but recent
  // builds (ESM + bundled) hide it from \`globalThis.monaco\` / the AMD
  // \`require\`. We try several paths:
  //
  //   1. Direct globals: \`monaco\`, \`window.monaco\`, \`self.monaco\`.
  //   2. AMD loaders: \`window.require\`, \`globalThis.require\`,
  //      \`AMDLoader.global.require\`, \`globalThis.webPackChunkFn\`, etc.
  //   3. Node-integration \`require\` (if nodeIntegration=true in this window).
  //   4. \`__webpack_require__\` — late ESM bundles sometimes expose it.
  //   5. DOM walk: find an existing \`.monaco-editor\` in the workbench and
  //      extract its widget/model/service references from attached props,
  //      then reconstruct the monaco namespace from there.
  //
  // Each attempt logs what it tried so an unresolved environment can be
  // diagnosed from the output channel.
  var monacoState = { tried: false, api: null, source: '' };

  function findMonacoSync() {
    // First check our private bundle's global (set by monaco-entry.mjs) — we
    // use a non-conflicting name so we don't clobber anything VSCode itself
    // might reference as \`monaco\`.
    try { if (globalThis.__ijFindMonacoApi && globalThis.__ijFindMonacoApi.editor && typeof globalThis.__ijFindMonacoApi.editor.create === 'function') { return { api: globalThis.__ijFindMonacoApi, source: 'bundled (__ijFindMonacoApi)' }; } } catch (e) {}
    // Then fall back to any monaco VSCode may have exposed natively.
    try { if (typeof monaco !== 'undefined' && monaco && monaco.editor && typeof monaco.editor.create === 'function') { return { api: monaco, source: 'global monaco' }; } } catch (e) {}
    try { if (window.monaco && window.monaco.editor && typeof window.monaco.editor.create === 'function') { return { api: window.monaco, source: 'window.monaco' }; } } catch (e) {}
    try { if (self.monaco && self.monaco.editor && typeof self.monaco.editor.create === 'function') { return { api: self.monaco, source: 'self.monaco' }; } } catch (e) {}
    try { if (globalThis.monaco && globalThis.monaco.editor && typeof globalThis.monaco.editor.create === 'function') { return { api: globalThis.monaco, source: 'globalThis.monaco' }; } } catch (e) {}
    return null;
  }

  function collectLoaders() {
    var loaders = [];
    var candidates = [
      { get: function () { return window.require; }, src: 'window.require' },
      { get: function () { return globalThis.require; }, src: 'globalThis.require' },
      { get: function () { return self.require; }, src: 'self.require' },
      { get: function () { return globalThis.AMDLoader && globalThis.AMDLoader.global && globalThis.AMDLoader.global.require; }, src: 'AMDLoader.global.require' },
      { get: function () { return globalThis._VSCODE_AMDLOADER && globalThis._VSCODE_AMDLOADER.require; }, src: '_VSCODE_AMDLOADER.require' },
    ];
    for (var i = 0; i < candidates.length; i++) {
      try {
        var fn = candidates[i].get();
        if (typeof fn === 'function') { loaders.push({ fn: fn, src: candidates[i].src }); }
      } catch (e) {}
    }
    return loaders;
  }

  function tryMonacoViaDom() {
    try {
      var editors = document.querySelectorAll('.monaco-editor');
      if (editors.length === 0) { return null; }
      // VSCode / Monaco don't advertise a stable DOM hook, but some builds do
      // attach the widget via a private key. Walk own props looking for the
      // signature of a code editor widget (getModel + getDomNode).
      for (var i = 0; i < editors.length; i++) {
        var el = editors[i];
        var keys;
        try { keys = Object.keys(el); } catch (e) { keys = []; }
        for (var p in el) { if (keys.indexOf(p) < 0) { keys.push(p); } }
        for (var k = 0; k < keys.length; k++) {
          var key = keys[k];
          var value;
          try { value = el[key]; } catch (e) { continue; }
          if (!value || typeof value !== 'object') { continue; }
          if (typeof value.getModel === 'function' && typeof value.getDomNode === 'function') {
            send({ type: 'log', msg: 'DOM editor widget found on property "' + key + '"' });
            return { widget: value, domEl: el };
          }
        }
      }
    } catch (e) {
      send({ type: 'log', msg: 'DOM monaco probe error: ' + (e && e.message) });
    }
    return null;
  }

  function buildApiFromWidget(widget) {
    // Given a CodeEditorWidget instance, try to reach the editor factory / Uri
    // class via the prototype chain or its model.
    try {
      var model = widget.getModel();
      // model.uri likely an instance of monaco.Uri. Its prototype chain has
      // static factory methods we can poke at.
      if (model && model.uri) {
        // The model knows its originating monaco namespace via internal
        // references; but they are version-specific. Log what we can see so
        // we can tailor the next attempt.
        var modelProto = Object.getPrototypeOf(model);
        var uriProto = Object.getPrototypeOf(model.uri);
        send({ type: 'log', msg: 'widget.getModel() proto keys: ' + Object.getOwnPropertyNames(modelProto || {}).slice(0, 30).join(',') });
        send({ type: 'log', msg: 'model.uri proto keys: ' + Object.getOwnPropertyNames(uriProto || {}).slice(0, 30).join(',') });
      }
    } catch (e) {}
    return null;
  }

  function probeReport() {
    var report = {};
    try { report.location = String(location.href).slice(0, 200); } catch (e) { report.locationErr = String(e); }
    try { report.baseURI = String(document.baseURI).slice(0, 200); } catch (e) {}
    var globalKeys = [];
    try { for (var k in globalThis) { globalKeys.push(k); } } catch (e) {}
    report.totalGlobals = globalKeys.length;
    report.monacoEditorDomCount = document.querySelectorAll('.monaco-editor').length;
    var interesting = globalKeys.filter(function (k) { return /monaco|vs|editor|workbench|loader|amd|require|webpack|_VSCODE/i.test(k); });
    report.interesting = interesting.slice(0, 40);
    // Capture the shape of promising globals.
    try {
      if (typeof vscode !== 'undefined') {
        report.vscodeKeys = Object.keys(vscode).slice(0, 30);
        // Also prototype keys (contextBridge usually puts methods on proto).
        try {
          var proto = Object.getPrototypeOf(vscode);
          if (proto) { report.vscodeProtoKeys = Object.getOwnPropertyNames(proto).slice(0, 30); }
        } catch (e) {}
      }
    } catch (e) {}
    try { report.vscodeFileRoot = String(globalThis._VSCODE_FILE_ROOT).slice(0, 200); } catch (e) {}
    try {
      if (typeof globalThis.MonacoPerformanceMarks !== 'undefined') {
        var mpm = globalThis.MonacoPerformanceMarks;
        if (Array.isArray(mpm)) { report.perfMarksCount = mpm.length; }
        else if (typeof mpm === 'object' && mpm !== null) { report.perfMarksKeys = Object.keys(mpm).slice(0, 20); }
      }
    } catch (e) {}
    report.typeof = {
      monaco: typeof monaco,
      require: typeof require,
      process: typeof process,
      module: typeof module,
      __webpack_require__: typeof __webpack_require__,
      __dirname: typeof __dirname,
    };
    // Dynamic import availability — check indirectly (can't reference \`import\`
    // as an identifier in a script without triggering a SyntaxError).
    try {
      (0, eval)('import("about:blank").catch(function(){})');
      report.dynamicImport = 'expression-parsed';
    } catch (e) { report.dynamicImport = 'syntax-err:' + (e && e.message || '').slice(0, 80); }
    // First few script sources to see actual module paths.
    try {
      var scripts = document.querySelectorAll('script');
      var srcs = [];
      for (var s = 0; s < scripts.length && srcs.length < 8; s++) {
        var src = scripts[s].getAttribute('src') || scripts[s].getAttribute('data-src');
        if (src) { srcs.push(src.slice(0, 150)); }
      }
      report.scripts = srcs;
    } catch (e) {}
    return JSON.stringify(report).slice(0, 2500);
  }
  window.__ijFindProbe = probeReport;

  function ensureMonaco(cb) {
    if (monacoState.tried) { cb(monacoState.api); return; }
    // Path 1: direct global lookup.
    var sync = findMonacoSync();
    if (sync) {
      monacoState.api = sync.api; monacoState.source = sync.source; monacoState.tried = true;
      send({ type: 'log', msg: 'monaco found via ' + sync.source });
      cb(sync.api); return;
    }
    send({ type: 'log', msg: 'monaco probe report: ' + probeReport() });
    // Path 2: AMD/loader require.
    var loaders = collectLoaders();
    send({ type: 'log', msg: 'monaco loaders tried: ' + loaders.map(function (l) { return l.src; }).join(', ') });
    if (loaders.length > 0) {
      var idx = 0;
      var tryNext = function () {
        if (idx >= loaders.length) { tryNodeRequire(); return; }
        var entry = loaders[idx++];
        try {
          entry.fn(['vs/editor/editor.main'], function () {
            var found = findMonacoSync();
            if (found) {
              monacoState.api = found.api; monacoState.source = entry.src + ' → ' + found.source; monacoState.tried = true;
              send({ type: 'log', msg: 'monaco loaded via ' + monacoState.source });
              cb(found.api);
            } else { tryNext(); }
          }, function (err) {
            send({ type: 'log', msg: 'loader ' + entry.src + ' rejected: ' + String(err && err.message ? err.message : err).slice(0, 150) });
            tryNext();
          });
        } catch (e) {
          send({ type: 'log', msg: 'loader ' + entry.src + ' threw: ' + (e && e.message) });
          tryNext();
        }
      };
      tryNext();
      return;
    }
    tryDynamicImports();
    function tryDynamicImports() {
      // Path 2.5: dynamic ESM import. Recent VSCode builds (electron-browser
      // sandbox + ESM) don't expose a loader, but the module files are still
      // served over the \`vscode-file://\` scheme. Try several candidate URLs
      // derived from document.baseURI and \`_VSCODE_FILE_ROOT\`.
      var candidates = [];
      try {
        // Resolve up from out/vs/code/electron-browser/workbench/workbench.html
        // to the \`out/\` directory (4 levels up), then to vs/editor/editor.main.
        candidates.push(new URL('../../../../vs/editor/editor.main.js', document.baseURI).href);
        candidates.push(new URL('../../../../vs/editor/editor.api.js', document.baseURI).href);
        candidates.push(new URL('../../../../vs/editor/editor.main.mjs', document.baseURI).href);
      } catch (e) {}
      try {
        var root = globalThis._VSCODE_FILE_ROOT;
        if (typeof root === 'string' && root) {
          // \`_VSCODE_FILE_ROOT\` is the app's \`out\` path. Build a \`vscode-file://\` URL.
          var prefix = 'vscode-file://vscode-app';
          candidates.push(prefix + root + '/vs/editor/editor.main.js');
          candidates.push(prefix + root + '/vs/editor/editor.api.js');
          candidates.push(prefix + root + '/vs/editor/editor.main.mjs');
        }
      } catch (e) {}
      // Deduplicate
      var seen = {}, uniq = [];
      for (var ci = 0; ci < candidates.length; ci++) { if (!seen[candidates[ci]]) { seen[candidates[ci]] = 1; uniq.push(candidates[ci]); } }
      send({ type: 'log', msg: 'dynamic import candidates: ' + JSON.stringify(uniq) });
      if (uniq.length === 0) { tryNodeRequire(); return; }
      var ci2 = 0;
      function nextImport() {
        if (ci2 >= uniq.length) { tryNodeRequire(); return; }
        var url = uniq[ci2++];
        try {
          var p = (0, eval)('import(' + JSON.stringify(url) + ')');
          Promise.resolve(p).then(function (mod) {
            var keys = [];
            try { keys = mod ? Object.keys(mod) : []; } catch (e) {}
            send({ type: 'log', msg: 'import OK url=' + url + ' keys=' + keys.slice(0, 25).join(',') });
            // Preferred: after import, global \`monaco\` should exist.
            var sync = findMonacoSync();
            if (sync) {
              monacoState.api = sync.api; monacoState.source = 'dynamicImport(' + url + ') → ' + sync.source; monacoState.tried = true;
              send({ type: 'log', msg: 'monaco loaded via ' + monacoState.source });
              cb(sync.api);
              return;
            }
            // Fallback: the module namespace might itself expose the API.
            if (mod && mod.editor && typeof mod.editor.create === 'function') {
              monacoState.api = mod; monacoState.source = 'dynamicImport(' + url + ') module namespace'; monacoState.tried = true;
              send({ type: 'log', msg: 'monaco loaded from import namespace of ' + url });
              cb(mod);
              return;
            }
            nextImport();
          }).catch(function (err) {
            send({ type: 'log', msg: 'import rejected url=' + url + ' err=' + String(err && err.message || err).slice(0, 200) });
            nextImport();
          });
        } catch (e) {
          send({ type: 'log', msg: 'import threw url=' + url + ' err=' + (e && e.message) });
          nextImport();
        }
      }
      nextImport();
    }
    function tryNodeRequire() {
      // Path 3: Node-integrated require (if nodeIntegration=true for the
      // workbench window). Electron exposes \`require\` as a CJS wrapper-level
      // function; some VSCode versions leave this enabled.
      try {
        if (typeof require === 'function') {
          send({ type: 'log', msg: 'node require available, attempting require("vs/editor/editor.main")' });
          try {
            require('vs/editor/editor.main');
            var found = findMonacoSync();
            if (found) {
              monacoState.api = found.api; monacoState.source = 'node require'; monacoState.tried = true;
              send({ type: 'log', msg: 'monaco loaded via node require' });
              cb(found.api);
              return;
            }
          } catch (e) { send({ type: 'log', msg: 'node require("vs/editor/editor.main") threw: ' + (e && e.message).toString().slice(0, 200) }); }
        }
      } catch (e) {}
      tryDom();
    }
    function tryDom() {
      // Path 4: walk existing .monaco-editor DOM for widget/model handles.
      var domHit = tryMonacoViaDom();
      if (domHit) {
        buildApiFromWidget(domHit.widget);
        // Even without a full monaco namespace we can expose what we have.
        monacoState.source = 'DOM widget';
      }
      monacoState.tried = true;
      send({ type: 'log', msg: 'monaco probe: all loaders failed (final)' });
      cb(null);
    }
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
    state.lastPreviewMsg = msg;
    $previewPath.textContent = msg.relPath || msg.uri;
    state.previewUri = msg.uri;
    state.previewLanguageId = msg.languageId || '';
    $preview.classList.remove('ij-find-modified');
    var m = window.__ijFindMonaco;
    send({ type: 'log', msg: 'renderPreview uri=' + (msg.relPath || msg.uri).slice(0, 80) +
      ' hasMonaco=' + (!!m) +
      ' ctor=' + (!!(m && m.ctor)) +
      ' inst=' + (!!(m && m.inst)) +
      ' modelSvc=' + (!!(m && m.modelSvc)) });
    if (m && m.ctor && m.inst) {
      try { renderPreviewMonacoReal(msg); return; }
      catch (e) { send({ type: 'log', msg: 'renderPreviewMonacoReal threw: ' + (e && e.message) }); }
    }
    send({ type: 'log', msg: 'renderPreview: DOM fallback' });
    renderPreviewDOM(msg);
  }

  function renderPreviewMonacoReal(msg) {
    if (state.stolenEditor) { restoreStolenEditor(); }
    var fullText = (msg.lines || []).map(function (l) { return l.text; }).join('\\n');
    var lang = msg.languageId || 'plaintext';
    send({ type: 'log', msg: 'monacoReal lines=' + (msg.lines ? msg.lines.length : 0) + ' lang=' + lang + ' reuse=' + !!(state.previewMonacoEditor && state.previewMonacoHost && state.previewMonacoHost.parentElement === $previewBody) });
    // Reuse existing widget if it's still mounted in our preview body.
    if (state.previewMonacoEditor && state.previewMonacoHost && state.previewMonacoHost.parentElement === $previewBody) {
      var ok = window.__ijFindSetPreviewContent(state.previewMonacoEditor, fullText, lang, msg.uri);
      send({ type: 'log', msg: 'monacoReal reuse setModel=' + ok });
      if (ok) {
        try {
          var rect = state.previewMonacoHost.getBoundingClientRect();
          state.previewMonacoEditor.layout({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
        } catch (e) {}
        applyPreviewMatchDecorations(state.previewMonacoEditor, msg);
        try { revealMatchImmediate(state.previewMonacoEditor, msg); } catch (e) {}
        placeCursorAtMatch(state.previewMonacoEditor, msg);
        state.previewMode = 'monaco';
        return;
      }
    }
    clearChildren($previewBody);
    $previewBody.classList.add('ij-find-editor-mounted');
    var host = document.createElement('div');
    host.className = 'ij-find-monaco-preview-host';
    host.style.cssText = 'width:100%;height:100%;overflow:hidden;';
    $previewBody.appendChild(host);
    var hostRect = host.getBoundingClientRect();
    send({ type: 'log', msg: 'monacoReal host rect=' + Math.round(hostRect.width) + 'x' + Math.round(hostRect.height) });
    var editor = window.__ijFindCreatePreviewEditor(host);
    send({ type: 'log', msg: 'monacoReal createPreviewEditor → ' + (editor ? 'OK ' + (editor.constructor && editor.constructor.name) : 'null') });
    if (!editor) {
      try { $previewBody.removeChild(host); } catch (e) {}
      $previewBody.classList.remove('ij-find-editor-mounted');
      renderPreviewDOM(msg);
      return;
    }
    state.previewMonacoEditor = editor;
    state.previewMonacoHost = host;
    state.previewMode = 'monaco';
    var setOk = window.__ijFindSetPreviewContent(editor, fullText, lang, msg.uri);
    send({ type: 'log', msg: 'monacoReal setPreviewContent=' + setOk });
    try {
      var r2 = host.getBoundingClientRect();
      editor.layout({ width: Math.floor(r2.width), height: Math.floor(r2.height) });
    } catch (e) {}
    // Apply decorations BEFORE reveal so they're painted in the same frame
    // the viewport lands — otherwise the user sees scrolling-to-match and
    // then a subsequent flash when highlights appear.
    applyPreviewMatchDecorations(editor, msg);
    try { revealMatchImmediate(editor, msg); } catch (e) {}
    placeCursorAtMatch(editor, msg);
    // Post-render check
    try {
      var vl = editor.getDomNode && editor.getDomNode() && editor.getDomNode().querySelectorAll('.view-line');
      send({ type: 'log', msg: 'monacoReal rendered viewLines=' + (vl ? vl.length : '?') });
    } catch (e) {}
  }

  // Seat a real cursor at the match start so (a) the overview-ruler draws a
  // horizontal marker at the current line, (b) the minimap highlights the
  // viewport area, and (c) scrolling shows a visible position indicator.
  // Without an explicit setPosition the editor has no caret until the user
  // clicks inside it, and every visual cursor-position affordance stays
  // blank.
  function placeCursorAtMatch(editor, msg) {
    try {
      if (!editor || typeof editor.setPosition !== 'function') { return; }
      var line = (typeof msg.focusLine === 'number' ? msg.focusLine : 0) + 1;
      var r0 = msg.ranges && msg.ranges[0];
      var col = (r0 && typeof r0.start === 'number') ? r0.start + 1 : 1;
      editor.setPosition({ lineNumber: line, column: col });
    } catch (e) {}
  }

  // Scroll the preview to the match without the default smooth animation.
  // For multi-line matches, put the start near the top of the viewport so
  // as many match lines as possible are visible. ScrollType.Immediate = 1.
  function revealMatchImmediate(editor, msg) {
    var startLn = msg.focusLine + 1;
    var r0 = msg.ranges && msg.ranges[0];
    if (r0 && typeof r0.endLine === 'number' && r0.endLine > msg.focusLine) {
      var endLn = r0.endLine + 1;
      var endCol = (typeof r0.endCol === 'number') ? (r0.endCol + 1) : 1;
      var startCol = (typeof r0.start === 'number') ? (r0.start + 1) : 1;
      if (typeof editor.revealRangeNearTop === 'function') {
        editor.revealRangeNearTop({
          startLineNumber: startLn, startColumn: startCol,
          endLineNumber: endLn, endColumn: endCol,
        }, 1);
        return;
      }
      if (typeof editor.revealLines === 'function') {
        editor.revealLines(startLn, endLn, 1);
        return;
      }
    }
    if (typeof editor.revealLineInCenter === 'function') {
      editor.revealLineInCenter(startLn, 1);
    } else if (typeof editor.revealLine === 'function') {
      editor.revealLine(startLn, 1);
    }
  }

  // Apply findMatch decorations for the current preview.
  //
  // For multi-line matches (endLine/endCol present) we explode the span
  // into one single-line range per file line because Monaco's cross-line
  // inlineClassName rendering doesn't always paint the background on
  // middle lines — per-line ranges give us a guaranteed continuous
  // character-background highlight from startCol on startLine through
  // every intermediate line's full content to endCol on endLine.
  //
  // Every sub-range belonging to the SAME source match gets the same
  // currentFindMatch class so a multi-line match looks uniformly
  // highlighted top-to-bottom, not "first line strong + rest faint".
  function applyPreviewMatchDecorations(editor, msg) {
    try {
      var model = editor.getModel && editor.getModel();
      var maxColFor = function (ln) {
        try { return model ? model.getLineMaxColumn(ln) : 1073741823; }
        catch (e) { return 1073741823; }
      };
      var focusLineMonaco = msg.focusLine + 1;
      var decos = [];
      (msg.ranges || []).forEach(function (r, matchIdx) {
        var startLn = focusLineMonaco;
        var endLn = (typeof r.endLine === 'number') ? (r.endLine + 1) : startLn;
        var endCol = (typeof r.endCol === 'number') ? (r.endCol + 1) : (r.end + 1);
        // Apply BOTH our own class (guaranteed to load; explicit !important
        // background) AND Monaco's built-in one (gets minimap hints, overview
        // ruler contribution for free if the theme has them).
        var cls = matchIdx === 0
          ? 'ij-find-preview-match-active findMatch currentFindMatch'
          : 'ij-find-preview-match findMatch';
        var sub = [];
        if (startLn === endLn) {
          sub.push({
            startLineNumber: startLn, startColumn: r.start + 1,
            endLineNumber: endLn, endColumn: endCol,
          });
        } else {
          // First match line: start col -> end of the line.
          sub.push({
            startLineNumber: startLn, startColumn: r.start + 1,
            endLineNumber: startLn, endColumn: maxColFor(startLn),
          });
          // Middle lines: col 1 -> end of line.
          for (var ln = startLn + 1; ln < endLn; ln++) {
            sub.push({
              startLineNumber: ln, startColumn: 1,
              endLineNumber: ln, endColumn: maxColFor(ln),
            });
          }
          // Last match line: col 1 -> end col.
          sub.push({
            startLineNumber: endLn, startColumn: 1,
            endLineNumber: endLn, endColumn: endCol,
          });
        }
        for (var si = 0; si < sub.length; si++) {
          // Only seed overview-ruler + minimap markers on the FIRST sub-
          // range of each match — putting one per exploded line produces
          // a dense streak on multi-line hits and drowns out the actual
          // cursor marker. The first sub-range lands at the match's
          // starting line, which is what the user wants to jump to.
          var addRulerMarker = si === 0;
          var opts = { inlineClassName: cls, isWholeLine: false };
          if (addRulerMarker) {
            // Theme color tokens — Monaco resolves these to the theme's
            // selection/find colors. Fallback literal is a
            // Monaco-findMatch yellow-ish.
            opts.overviewRuler = {
              color: matchIdx === 0
                ? { id: 'editor.findMatchHighlightBackground' }
                : { id: 'editor.findMatchBackground' },
              position: 4, // OverviewRulerLane.Right
            };
            opts.minimap = {
              color: matchIdx === 0
                ? { id: 'minimap.findMatchHighlight' }
                : { id: 'minimap.findMatchHighlight' },
              position: 1, // MinimapPosition.Inline
            };
          }
          decos.push({ range: sub[si], options: opts });
        }
      });
      if (state.previewMonacoMatchDecos) {
        state.previewMonacoMatchDecos = editor.deltaDecorations(state.previewMonacoMatchDecos, []);
      }
      if (decos.length > 0) {
        state.previewMonacoMatchDecos = editor.deltaDecorations([], decos);
      }
    } catch (e) { send({ type: 'log', msg: 'monacoReal decorate threw: ' + (e && e.message) }); }
  }

  function disposePreviewMonacoEditor() {
    if (state.previewMonacoEditor) {
      try { state.previewMonacoEditor.dispose(); } catch (e) {}
    }
    if (state.previewMonacoHost && state.previewMonacoHost.parentElement) {
      try { state.previewMonacoHost.parentElement.removeChild(state.previewMonacoHost); } catch (e) {}
    }
    state.previewMonacoEditor = null;
    state.previewMonacoHost = null;
    $previewBody.classList.remove('ij-find-editor-mounted');
  }

  // ── Steal real VSCode editor DOM ─────────────────────────────────────
  //
  // When Monaco isn't directly accessible, we fall back to reparenting an
  // actual editor that VSCode has already created for this file. The editor
  // keeps all its wiring (language services, model, undo stack) because
  // internal references are to the DOM element itself — we're only moving it
  // to a different parent.
  //
  // On the next match selection we restore the previously stolen editor to
  // its original place and steal the new one.

  function filenameFromUri(uri) {
    try {
      var noQuery = String(uri).split('?')[0].split('#')[0];
      return decodeURIComponent(noQuery.split('/').pop());
    } catch (e) { return ''; }
  }

  function findVscodeEditorDom(uri) {
    var filename = filenameFromUri(uri);
    if (!filename) { return null; }
    var labels = document.querySelectorAll('.editor-group-container .tab .monaco-icon-label .label-name, .editor-group-container .tab .tab-label');
    for (var i = 0; i < labels.length; i++) {
      var label = labels[i];
      var txt = (label.textContent || '').trim();
      if (txt === filename || txt.split('/').pop() === filename) {
        var group = label.closest('.editor-group-container');
        if (!group) { continue; }
        // Steal the .monaco-editor directly — the smallest movable unit.
        var monacoEl = group.querySelector('.monaco-editor');
        if (monacoEl) { return monacoEl; }
      }
    }
    // Fallback: last .monaco-editor that's inside an .editor-group-container.
    var all = document.querySelectorAll('.editor-group-container .monaco-editor');
    if (all.length > 0) { return all[all.length - 1]; }
    return null;
  }

  // Duck-typing: a code editor widget has \`layout\`, \`getModel\`,
  // \`getDomNode\` function members. Walk every property (own + enumerable +
  // Symbol) on a given element looking for one.
  function findMonacoWidgetOn(el, label) {
    if (!el) { return null; }
    var seen = {};
    var keys = [];
    try { var own = Object.getOwnPropertyNames(el); for (var i = 0; i < own.length; i++) { keys.push(own[i]); seen[own[i]] = 1; } } catch (e) {}
    for (var k in el) { if (!seen[k]) { keys.push(k); seen[k] = 1; } }
    for (var j = 0; j < keys.length; j++) {
      var val;
      try { val = el[keys[j]]; } catch (e) { continue; }
      if (!val || typeof val !== 'object') { continue; }
      if (typeof val.layout === 'function' &&
          typeof val.getModel === 'function' &&
          typeof val.getDomNode === 'function') {
        send({ type: 'log', msg: 'widget found on ' + label + ' via "' + keys[j] + '"' });
        return val;
      }
      try {
        if (val.editor && typeof val.editor.layout === 'function' && typeof val.editor.getModel === 'function') {
          send({ type: 'log', msg: 'widget found on ' + label + ' via "' + keys[j] + '.editor"' });
          return val.editor;
        }
        if (val._editor && typeof val._editor.layout === 'function' && typeof val._editor.getModel === 'function') {
          send({ type: 'log', msg: 'widget found on ' + label + ' via "' + keys[j] + '._editor"' });
          return val._editor;
        }
      } catch (e) {}
    }
    try {
      var syms = Object.getOwnPropertySymbols(el);
      for (var s = 0; s < syms.length; s++) {
        var sv;
        try { sv = el[syms[s]]; } catch (e) { continue; }
        if (!sv || typeof sv !== 'object') { continue; }
        if (typeof sv.layout === 'function' && typeof sv.getModel === 'function' && typeof sv.getDomNode === 'function') {
          send({ type: 'log', msg: 'widget found on ' + label + ' via Symbol ' + syms[s].toString() });
          return sv;
        }
      }
    } catch (e) {}
    return null;
  }

  // Scan the live DOM for any existing code-editor widget the user
  // already has open and register it into caps.widgets / caps.services /
  // caps.widgetCtors WITHOUT needing to force-open a new file. When the
  // user has at least one editor visible this short-circuits the whole
  // force-open dance — no extra tab flash, no lost editor state.
  window.__ijFindCaptureFromDom = function () {
    try {
      var targetCaps = window.__ijFindCaptures;
      if (!targetCaps) { return 'no-caps'; }
      try { if (!caps) { caps = targetCaps; } } catch (eCaps) {}
      var before = targetCaps.widgets.length;
      var editors = document.querySelectorAll('.editor-group-container .monaco-editor');
      for (var i = 0; i < editors.length && targetCaps.widgets.length < 50; i++) {
        var widget = findMonacoWidget(editors[i]);
        if (!widget) { continue; }
        targetCaps.widgets.push({ v: widget, src: 'dom-capture', key: stringifyKey(i) });
        try {
          if (widget.constructor && targetCaps.widgetCtors.indexOf(widget.constructor) < 0 &&
              targetCaps.widgetCtors.length < 10) {
            targetCaps.widgetCtors.push(widget.constructor);
          }
        } catch (eCtor) {}
        try {
          var inst = widget._instantiationService;
          if (inst && typeof inst.createInstance === 'function' &&
              typeof inst.invokeFunction === 'function' &&
              targetCaps.services.length < 40) {
            targetCaps.services.push({
              v: inst, src: 'dom-capture', key: stringifyKey(i),
              kind: 'IInstantiationService',
            });
          }
        } catch (eSvc) {}
        try {
          var modelSvcs = [];
          addWidgetModelServices(modelSvcs, widget, 'dom-capture', null);
          for (var ms = 0; ms < modelSvcs.length && targetCaps.services.length < 40; ms++) {
            targetCaps.services.push({
              v: modelSvcs[ms].modelSvc, src: 'dom-capture', key: stringifyKey(i),
              kind: 'IModelService',
            });
          }
        } catch (eModelSvc) {}
      }
      return 'added=' + (targetCaps.widgets.length - before) +
             ' widgets=' + targetCaps.widgets.length +
             ' services=' + targetCaps.services.length +
             ' ctors=' + targetCaps.widgetCtors.length;
    } catch (e) { return 'dom-capture-err:' + (e && e.message); }
  };

  // Search .monaco-editor, each of its ancestors up to .editor-group-container,
  // and its own key descendants for the widget instance.
  function findMonacoWidget(startEl) {
    if (!startEl) { return null; }
    var candidates = [
      { el: startEl, label: '.monaco-editor' },
    ];
    var el = startEl.parentElement;
    for (var i = 0; i < 6 && el; i++, el = el.parentElement) {
      var cls = (el.className || '').toString().trim().split(/\\s+/)[0] || el.tagName;
      candidates.push({ el: el, label: 'ancestor[' + i + ']=' + cls });
      if (el.classList && el.classList.contains('editor-group-container')) { break; }
    }
    // Likely internal descendants that could host the widget reference.
    var innerSelectors = ['.overflow-guard', '.monaco-scrollable-element', '.margin', '.lines-content'];
    for (var n = 0; n < innerSelectors.length; n++) {
      var inner = startEl.querySelector(innerSelectors[n]);
      if (inner) { candidates.push({ el: inner, label: 'descendant=' + innerSelectors[n] }); }
    }
    for (var c = 0; c < candidates.length; c++) {
      var w = findMonacoWidgetOn(candidates[c].el, candidates[c].label);
      if (w) { return w; }
    }
    send({ type: 'log', msg: 'widget NOT found; checked ' + candidates.length + ' elements' });
    return null;
  }

  // Minimal: set the .monaco-editor outer box to the preview pane's size.
  // If we happen to find the widget handle we also call .layout() because
  // that is the clean Monaco API — BUT we never touch monaco's own internal
  // DOM (.overflow-guard, .view-lines, etc.). Those stay untouched so that
  // the editor's rendering / restoration are never corrupted.
  function layoutStolenEditor() {
    if (!state.stolenEditor) { return; }
    var rect = $previewBody.getBoundingClientRect();
    var w = Math.max(100, Math.floor(rect.width));
    var h = Math.max(40, Math.floor(rect.height));
    state.stolenEditor.style.width = w + 'px';
    state.stolenEditor.style.height = h + 'px';
    if (!state.stolenEditorWidget && !state.stolenEditorWidgetSearched) {
      state.stolenEditorWidget = findMonacoWidget(state.stolenEditor);
      state.stolenEditorWidgetSearched = true;
    }
    if (state.stolenEditorWidget && typeof state.stolenEditorWidget.layout === 'function') {
      try { state.stolenEditorWidget.layout({ width: w, height: h }); } catch (e) {}
    }
  }

  function restoreStolenEditor() {
    if (!state.stolenEditor || !state.stolenEditorOrigParent) { return; }
    try {
      state.stolenEditor.style.width = '';
      state.stolenEditor.style.height = '';
      state.stolenEditor.style.position = '';
      if (state.stolenEditorOrigNextSibling && state.stolenEditorOrigNextSibling.parentNode === state.stolenEditorOrigParent) {
        state.stolenEditorOrigParent.insertBefore(state.stolenEditor, state.stolenEditorOrigNextSibling);
      } else {
        state.stolenEditorOrigParent.appendChild(state.stolenEditor);
      }
      // Restore the source group's size so any tabs in that column reappear.
      if (state.stolenGroup && state.stolenGroupOrigStyles) {
        var g = state.stolenGroup;
        var s = state.stolenGroupOrigStyles;
        g.style.flex = s.groupFlex || '';
        g.style.minWidth = s.groupMinWidth || '';
        g.style.minHeight = s.groupMinHeight || '';
        g.style.overflow = s.groupOverflow || '';
        g.style.width = s.groupWidth || '';
        g.style.height = s.groupHeight || '';
        if (s.split) {
          s.split.style.flex = s.splitFlex || '';
          s.split.style.minWidth = s.splitMinWidth || '';
          s.split.style.overflow = s.splitOverflow || '';
          s.split.style.width = s.splitWidth || '';
        }
      }
    } catch (e) { send({ type: 'log', msg: 'restoreStolenEditor err: ' + (e && e.message) }); }
    $previewBody.classList.remove('ij-find-stolen');
    state.stolenEditor = null;
    state.stolenEditorOrigParent = null;
    state.stolenEditorOrigNextSibling = null;
    state.stolenEditorUri = '';
    state.stolenEditorWidget = null;
    state.stolenEditorWidgetSearched = false;
    state.stolenGroup = null;
    state.stolenGroupOrigStyles = null;
  }

  function stealEditorIntoPreview(editorEl, uri) {
    if (!editorEl || !editorEl.parentNode) { return false; }
    if (state.stolenEditor === editorEl && state.stolenEditorUri === uri) {
      layoutStolenEditor();
      return true;
    }
    if (state.stolenEditor) { restoreStolenEditor(); }
    state.stolenEditor = editorEl;
    state.stolenEditorWidget = null;
    state.stolenEditorWidgetSearched = false;
    state.stolenEditorOrigParent = editorEl.parentNode;
    state.stolenEditorOrigNextSibling = editorEl.nextSibling;
    state.stolenEditorUri = uri;
    // Shrink the source .editor-group-container (and its split-view-view
    // wrapper if any) to zero width without removing it from flex flow.
    // VSCode's split-view layout stays consistent — no corrupted sibling
    // styles on restore — and the group is visually invisible while we hold
    // its monaco editor.
    var group = editorEl.closest ? editorEl.closest('.editor-group-container') : null;
    if (group) {
      var split = group.closest ? group.closest('.split-view-view') : null;
      state.stolenGroup = group;
      state.stolenGroupOrigStyles = {
        groupFlex: group.style.flex,
        groupMinWidth: group.style.minWidth,
        groupMinHeight: group.style.minHeight,
        groupOverflow: group.style.overflow,
        groupWidth: group.style.width,
        groupHeight: group.style.height,
        splitFlex: split ? split.style.flex : undefined,
        splitMinWidth: split ? split.style.minWidth : undefined,
        splitOverflow: split ? split.style.overflow : undefined,
        splitWidth: split ? split.style.width : undefined,
        split: split,
      };
      group.style.flex = '0 0 0px';
      group.style.minWidth = '0';
      group.style.minHeight = '0';
      group.style.width = '0';
      group.style.overflow = 'hidden';
      if (split) {
        split.style.flex = '0 0 0px';
        split.style.minWidth = '0';
        split.style.overflow = 'hidden';
        split.style.width = '0';
      }
    }
    clearChildren($previewBody);
    $previewBody.classList.add('ij-find-stolen');
    editorEl.style.position = 'relative';
    $previewBody.appendChild(editorEl);
    layoutStolenEditor();
    return true;
  }

  function attemptStealVscodeEditor(msg, cb) {
    // The file has just been opened in a side editor by the extension.
    // Poll up to ~800ms for its DOM to appear, then move it.
    var attempts = 0;
    function tick() {
      var dom = findVscodeEditorDom(msg.uri);
      if (dom) {
        var ok = stealEditorIntoPreview(dom, msg.uri);
        send({ type: 'log', msg: 'steal editor ' + (ok ? 'OK' : 'FAIL') + ' attempts=' + attempts + ' dom=' + (dom.tagName + '.' + (dom.className || '').slice(0, 40)) });
        cb(ok);
        return;
      }
      attempts++;
      if (attempts > 40) {
        send({ type: 'log', msg: 'steal editor: no DOM found after ' + attempts + ' attempts' });
        cb(false);
        return;
      }
      setTimeout(tick, 20);
    }
    tick();
  }


  function ensureMonacoEditor(api) {
    if (state.monacoEditor && state.monacoHost && state.monacoHost.parentElement === $previewBody) {
      send({ type: 'log', msg: 'reusing existing monaco editor' });
      return state.monacoEditor;
    }
    clearChildren($previewBody);
    // Neutralise inherited typography / padding / overflow so Monaco's own
    // geometry is in charge of this container.
    $previewBody.classList.add('ij-find-editor-mounted');
    var host = el('div', { className: 'ij-find-monaco-host' });
    $previewBody.appendChild(host);
    var hostRect = host.getBoundingClientRect();
    send({ type: 'log', msg: 'monaco host created rect=' + Math.round(hostRect.width) + 'x' + Math.round(hostRect.height) + ' parentRect=' + Math.round($previewBody.getBoundingClientRect().width) + 'x' + Math.round($previewBody.getBoundingClientRect().height) });
    state.monacoHost = host;
    var editor;
    try {
      editor = api.editor.create(host, {
        automaticLayout: true,
        readOnly: false,
        minimap: { enabled: !state || state.minimapEnabled !== false },
        scrollBeyondLastLine: false,
        lineNumbers: 'on',
        glyphMargin: false,
        folding: true,
        contextmenu: true,
        copyWithSyntaxHighlighting: true,
        fontSize: 12,
        renderLineHighlight: 'all',
        occurrencesHighlight: true,
        overviewRulerLanes: 3,
        hideCursorInOverviewRuler: false,
      });
      send({ type: 'log', msg: 'monaco.editor.create OK editorType=' + typeof editor + ' hasGetModel=' + (editor && typeof editor.getModel === 'function') });
    } catch (e) {
      send({ type: 'log', msg: 'monaco.editor.create THREW: ' + (e && e.message) });
      throw e;
    }
    state.monacoEditor = editor;
    try {
      editor.addCommand(api.KeyMod.CtrlCmd | api.KeyCode.KeyS, function () {
        var ed = state.monacoEditor;
        var model = ed && ed.getModel();
        if (!model || !state.previewUri) {
          send({ type: 'log', msg: 'save skipped: no model or uri' });
          return;
        }
        var content = model.getValue();
        send({ type: 'log', msg: 'Cmd+S pressed; saving uri=' + state.previewUri + ' bytes=' + content.length });
        send({ type: 'saveFile', uri: state.previewUri, content: content });
        $preview.classList.remove('ij-find-modified');
      });
      send({ type: 'log', msg: 'save command registered' });
    } catch (e) {
      send({ type: 'log', msg: 'addCommand THREW: ' + (e && e.message) });
    }
    return editor;
  }

  function renderPreviewMonaco(api, msg) {
    state.previewMode = 'monaco';
    var editor = ensureMonacoEditor(api);
    var fullText = msg.lines.map(function (l) { return l.text; }).join('\\n');
    var fileUri;
    try { fileUri = api.Uri.parse(msg.uri); }
    catch (e) { send({ type: 'log', msg: 'Uri.parse threw: ' + (e && e.message) + ' uri=' + msg.uri }); return; }
    var model = null;
    try { model = api.editor.getModel(fileUri); }
    catch (e) { send({ type: 'log', msg: 'getModel threw: ' + (e && e.message) }); }
    if (model) {
      send({ type: 'log', msg: 'reused existing model lang=' + (model.getLanguageId ? model.getLanguageId() : '?') + ' lines=' + model.getLineCount() });
    } else {
      try {
        model = api.editor.createModel(fullText, msg.languageId || 'plaintext', fileUri);
        send({ type: 'log', msg: 'createModel OK lang=' + (msg.languageId || 'plaintext') });
      }
      catch (e) {
        send({ type: 'log', msg: 'createModel(uri) threw: ' + (e && e.message) + ' — trying anonymous' });
        try {
          model = api.editor.createModel(fullText, msg.languageId || 'plaintext');
          send({ type: 'log', msg: 'createModel anonymous OK' });
        }
        catch (e2) {
          send({ type: 'log', msg: 'createModel anonymous THREW: ' + (e2 && e2.message) });
          return;
        }
      }
    }
    if (msg.languageId && model.getLanguageId && model.getLanguageId() !== msg.languageId) {
      try { api.editor.setModelLanguage(model, msg.languageId); } catch (e) {}
    }
    try {
      editor.setModel(model);
      send({ type: 'log', msg: 'editor.setModel OK; readOnly=' + (editor.getOption ? editor.getOption(api.editor.EditorOption ? api.editor.EditorOption.readOnly : 81) : '?') });
    } catch (e) {
      send({ type: 'log', msg: 'setModel threw: ' + (e && e.message) });
      return;
    }

    if (state.monacoChangeListener) { try { state.monacoChangeListener.dispose(); } catch (e) {} }
    state.monacoChangeListener = model.onDidChangeContent(function (ev) {
      $preview.classList.add('ij-find-modified');
    });
    send({ type: 'log', msg: 'change listener attached' });

    // Reveal focus line and place caret at first match.
    var focusLine = msg.focusLine + 1; // monaco is 1-indexed
    var col = (msg.ranges && msg.ranges[0]) ? msg.ranges[0].start + 1 : 1;
    try {
      editor.revealLineInCenter(focusLine, 0);
      editor.setPosition({ lineNumber: focusLine, column: col });
    } catch (e) {}
    // Briefly highlight the search match using Monaco decorations.
    // For multi-line matches (endLine/endCol present), we extend the range
    // across lines so every line of the match is visibly highlighted —
    // previously only the match's starting line got the findMatch style.
    try {
      var ranges = (msg.ranges || []).map(function (r) {
        var endLineMonaco = (typeof r.endLine === 'number') ? (r.endLine + 1) : focusLine;
        var endColMonaco = (typeof r.endCol === 'number') ? (r.endCol + 1) : (r.end + 1);
        return new api.Range(focusLine, r.start + 1, endLineMonaco, endColMonaco);
      });
      if (state.monacoMatchDecos) { state.monacoMatchDecos = editor.deltaDecorations(state.monacoMatchDecos, []); }
      if (ranges.length === 0) {
        ranges = [new api.Range(focusLine, 1, focusLine, model.getLineMaxColumn(focusLine))];
      }
      state.monacoMatchDecos = editor.deltaDecorations([], ranges.map(function (range, idx) {
        return {
          range: range,
          options: {
            inlineClassName: idx === 0 && msg.ranges && msg.ranges.length > 0 ? 'findMatch currentFindMatch' : 'findMatch',
            className: 'rangeHighlight',
            isWholeLine: !(msg.ranges && msg.ranges.length > 0),
          },
        };
      }));
    } catch (e) {}
  }

  function renderPreviewDOM(msg) {
    if (state.stolenEditor) { restoreStolenEditor(); }
    state.previewMode = 'dom';
    // If we previously hosted Monaco, detach it.
    if (state.monacoEditor && state.monacoHost && state.monacoHost.parentElement === $previewBody) {
      try { state.monacoHost.parentElement.removeChild(state.monacoHost); } catch (e) {}
    }
    $previewBody.classList.remove('ij-find-editor-mounted');
    clearChildren($previewBody);
    var contentEl = el('div', { className: 'ij-find-preview-content' });
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
      if (isFocus && msg.ranges && msg.ranges.length > 0) {
        appendHighlightedInto(textSpan, line.text, msg.ranges);
      } else if (!fallbackHighlight(textSpan, line.text, state.previewLanguageId)) {
        textSpan.textContent = line.text;
      }
      lineEl.appendChild(textSpan);
      frag.appendChild(lineEl);
      if (isFocus) { focusEl = lineEl; }
    }
    contentEl.appendChild(frag);
    $previewBody.appendChild(contentEl);
    if (focusEl) {
      setTimeout(function () {
        try { focusEl.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
      }, 0);
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

  // Mousedown in the preview pane must hand focus to the Monaco editor. Without
  // this, dragging to select or Shift+arrow keeps focus on the overlay query,
  // and Monaco renders the selection in its "inactive" style — which the theme
  // draws as near-transparent, so users see selection markers in the minimap
  // overview but nothing in the actual editor. Focusing the editor flips the
  // selection layer to the theme's active color AND wires up cursor-position
  // indicators on the scrollbar / minimap.
  $previewBody.addEventListener('mousedown', function () {
    var ed = state.previewMonacoEditor || state.monacoEditor;
    if (ed && typeof ed.focus === 'function') {
      try { ed.focus(); } catch (e) {}
    }
  }, true);

  $previewBody.addEventListener('mousemove', function (e) {
    if (!state.previewUri) { return; }
    // In Monaco mode, the embedded editor handles hover natively via VSCode
    // language services — don't double-show a custom tooltip.
    if (state.previewMode === 'monaco') { return; }
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

  window.__ijFindShow = function (initialQuery, showOptions) {
    try {
      var wasVisible = panel.classList.contains('visible');
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
      try {
        var previewOverflowRoot = document.querySelector('.ij-find-preview-overflow-root');
        if (previewOverflowRoot) {
          document.body.appendChild(previewOverflowRoot);
          syncPreviewOverflowTheme(previewOverflowRoot);
        }
      } catch (e) {}
      // Paint the overlay BEFORE firing the search — otherwise the browser
      // processes our JS (send to extension → runRgSearch → network roundtrip)
      // inside the same microtask and the panel appears only after the first
      // results:start message lands. rAF guarantees one paint first.
      if (typeof initialQuery === 'string' && initialQuery && initialQuery !== $q.value) {
        var forceLiteral = !!(showOptions && showOptions.forceLiteral);
        if (forceLiteral) {
          state.options.useRegex = false;
          state.options.wholeWord = false;
          $optRegex.setAttribute('aria-pressed', 'false');
          $optWord.setAttribute('aria-pressed', 'false');
          syncRegexMultilineUi();
        }
        var oldQ = state.rgQuery || '';
        var oldOpts = state.rgOptions;
        var oldScope = state.rgScope || '';
        var scopeRaw = $scope.value || '';
        var optsChangedForShow = forceLiteral || !oldOpts ||
          oldOpts.caseSensitive !== state.options.caseSensitive ||
          oldOpts.wholeWord !== state.options.wholeWord ||
          oldOpts.useRegex !== state.options.useRegex ||
          effectiveRegexMultilineValue(oldOpts) !== effectiveRegexMultilineValue(state.options);
        var extendsCurrent = wasVisible &&
          !!oldQ &&
          oldScope === scopeRaw &&
          initialQuery.length > oldQ.length &&
          initialQuery.indexOf(oldQ) === 0 &&
          initialQuery.indexOf('\\n') < 0 &&
          oldQ.indexOf('\\n') < 0 &&
          !optsChangedForShow;
        $q.value = initialQuery;
        autosizeQuery();
        if (state.debounce) { clearTimeout(state.debounce); state.debounce = null; }
        if (extendsCurrent) {
          state.filterQuery = initialQuery;
          render();
          var visibleRows = 0;
          for (var fk = 0; fk < state.flat.length; fk++) {
            if (!state.flat[fk].pendingUri) { visibleRows++; }
          }
          if (state.searching) {
            setStatus(visibleRows + ' match' + (visibleRows === 1 ? '' : 'es') + ' (scanning\u2026)', true);
          } else {
            setStatus(visibleRows + ' match' + (visibleRows === 1 ? '' : 'es'), false);
          }
        } else {
          setStatus('Searching\u2026', true);
          render();
          var showSearchFired = false;
          function fireShowSearch() {
            if (showSearchFired) { return; }
            showSearchFired = true;
            triggerSearch(false);
          }
          requestAnimationFrame(function () {
            requestAnimationFrame(fireShowSearch);
          });
          setTimeout(fireShowSearch, 50);
        }
      }
      setTimeout(function () { try { $q.focus(); $q.select(); } catch (e) {} }, 0);
      return 'show ok';
    } catch (e) { return 'show-err: ' + (e && e.message); }
  };
  window.__ijFindHide = function () {
    // doShow fires fire-and-forget __ijFindHide into every non-focused
    // workbench window to preemptively dismiss any stale overlay. Those
    // windows never had our panel visible in this session, so we MUST NOT
    // send cancel from them — it races with the newly-started search in
    // the focused window and SIGTERMs rg mid-scan (manifests as rg
    // exit=null + 0 matches).
    var wasVisible = panel.classList.contains('visible');
    panel.classList.remove('visible');
    panel.style.removeProperty('display');
    panel.style.removeProperty('visibility');
    panel.style.removeProperty('opacity');
    panel.style.removeProperty('pointer-events');
    panel.style.removeProperty('z-index');
    panel.style.removeProperty('position');
    // Return any stolen VSCode editor to its editor group.
    if (state.stolenEditor) { restoreStolenEditor(); }
    // Tear down preview monaco widget so its GPU/DOM resources are released.
    disposePreviewMonacoEditor();
    hideHover();
    if (wasVisible) { send({ type: 'cancel' }); }
  };
  window.__ijFindStatus = function () {
    try {
      var r = panel.getBoundingClientRect();
      var cs = getComputedStyle(panel);
      // Deeper probe of possible Monaco access paths.
      var globalKeys = [];
      try {
        for (var k in globalThis) {
          if (/monaco|amd|loader|workbench|_VSCODE/i.test(k)) { globalKeys.push(k); }
          if (globalKeys.length > 30) { break; }
        }
      } catch (e) {}
      var domEditors = document.querySelectorAll('.monaco-editor');
      var firstEditorProps = [];
      if (domEditors.length > 0) {
        for (var p in domEditors[0]) {
          if (typeof domEditors[0][p] === 'object' && domEditors[0][p] !== null) {
            if (/editor|widget|controller|context/i.test(p)) { firstEditorProps.push(p); }
          }
          if (firstEditorProps.length > 20) { break; }
        }
      }
      var monacoStatus = window.__ijFindMonacoStatus ? window.__ijFindMonacoStatus() : 'no-monaco-status';
      return 'inDom=' + document.body.contains(panel) +
        ' disp=' + cs.display +
        ' z=' + cs.zIndex +
        ' rect=' + Math.round(r.x) + ',' + Math.round(r.y) + ',' + Math.round(r.width) + 'x' + Math.round(r.height) +
        ' monacoStatus=' + monacoStatus +
        ' monacoGlobal=' + (typeof monaco !== 'undefined') +
        ' windowRequire=' + (typeof window.require) +
        ' AMDLoader=' + (typeof globalThis.AMDLoader) +
        ' MonacoEnv=' + (typeof globalThis.MonacoEnvironment) +
        ' globalCandidates=[' + globalKeys.join(',') + ']' +
        ' domEditors=' + domEditors.length +
        ' firstEditorProps=[' + firstEditorProps.join(',') + ']';
    } catch (e) { return 'status-err: ' + (e && e.message); }
  };
  // Test-only probes. Safe to ship — they just expose read-only state the
  // E2E suite polls to avoid racing async CDP evals.
  window.__ijFindGetSearchState = function () {
    try {
      return {
        searching: !!state.searching,
        filesCount: (state.files || []).length,
        flatCount: (state.flat || []).length,
        activeIndex: typeof state.activeIndex === 'number' ? state.activeIndex : -1,
        previewMode: state.previewMode || null,
        previewUri: state.previewUri || null,
        lastPreviewKey: state.lastPreviewKey || null,
        inputValue: $q ? $q.value : null,
        scopeValue: $scope ? $scope.value : null,
        searchId: typeof state.searchId === 'number' ? state.searchId : 0,
        hasMoreResults: !!state.hasMoreResults,
        loadingMore: !!state.loadingMore,
        pageSize: typeof state.pageSize === 'number' ? state.pageSize : 0,
        lastBatchOffset: typeof state.lastBatchOffset === 'number' ? state.lastBatchOffset : 0,
        lastBatchMatches: typeof state.lastBatchMatches === 'number' ? state.lastBatchMatches : 0,
        lastBatchFiles: typeof state.lastBatchFiles === 'number' ? state.lastBatchFiles : 0,
        lastBatchMode: state.lastBatchMode || '',
        rgQuery: state.rgQuery || '',
        rgScope: state.rgScope || '',
        filterQuery: state.filterQuery || '',
        historyCount: state.searchHistory ? state.searchHistory.length : 0,
        history: state.searchHistory || [],
        options: {
          caseSensitive: !!state.options.caseSensitive,
          wholeWord: !!state.options.wholeWord,
          useRegex: !!state.options.useRegex,
          regexMultiline: state.options.regexMultiline !== false,
        },
      };
    } catch (e) { return { err: String(e && e.message) }; }
  };
  window.__ijFindRefreshSearch = refreshSearch;
  window.__ijFindSetScopeValue = function (value, forceRestart) {
    try {
      $scope.value = value == null ? '' : String(value);
      if (forceRestart) { refreshSearch(); }
      else { scheduleSearch(); }
      return window.__ijFindGetSearchState();
    } catch (e) { return { err: String(e && e.message) }; }
  };
  window.__ijFindGetPreviewDecorations = function () {
    try {
      var editor = state.previewMonacoEditor;
      if (!editor) { return { editor: null, decorations: [] }; }
      var model = editor.getModel && editor.getModel();
      if (!model) { return { editor: 'no-model', decorations: [] }; }
      var raw = model.getAllDecorations();
      var out = [];
      for (var i = 0; i < raw.length; i++) {
        var d = raw[i];
        var inlineCls = (d.options && d.options.inlineClassName) || '';
        if (!/findMatch/.test(inlineCls)) { continue; }
        out.push({
          startLineNumber: d.range.startLineNumber,
          startColumn: d.range.startColumn,
          endLineNumber: d.range.endLineNumber,
          endColumn: d.range.endColumn,
          inlineClassName: inlineCls,
        });
      }
      return { editor: 'ok', decorations: out, lineCount: model.getLineCount ? model.getLineCount() : -1 };
    } catch (e) { return { err: String(e && e.message) }; }
  };
  window.__ijFindOnMessage = function (msg) {
    var msgSearchId = typeof msg.searchId === 'number' ? msg.searchId : null;
    switch (msg.type) {
      case 'results:start':
        state.files = []; state.flat = []; state.candidates = [];
        state.candidateTotal = 0; state.confirmedUris = {}; state.fileIndexByUri = {};
        state.searchId = msgSearchId !== null ? msgSearchId : ((state.searchId || 0) + 1);
        state.filterQuery = '';
        state.hasMoreResults = false;
        state.loadingMore = false;
        state.lastBatchOffset = 0;
        state.lastBatchMatches = 0;
        state.lastBatchFiles = 0;
        state.lastBatchMode = 'start';
        state.activeIndex = -1; state.searching = true;
        state.searchStartTs = Date.now();
        if (state.searchTicker) { clearInterval(state.searchTicker); }
        // Tick the status every 100ms with elapsed time so the user sees
        // the search is progressing even during a long full-scan.
        state.searchTicker = setInterval(function () {
          if (!state.searching) { return; }
          updateSearchingStatus();
        }, 100);
        clearPreview();
        updateSearchingStatus();
        render();
        break;
      case 'results:candidates':
        if (msgSearchId !== null && msgSearchId !== state.searchId) { break; }
        // Planner narrowed the workspace to these files; rg hasn't matched
        // them yet. Show as pending rows so the user sees *something*
        // clickable immediately instead of an empty Searching state.
        state.candidates = msg.candidates || [];
        state.candidateTotal = msg.total || state.candidates.length;
        updateSearchingStatus();
        render();
        break;
      case 'results:file':
        if (msgSearchId !== null && msgSearchId !== state.searchId) { break; }
        if (!msg.match || !msg.match.uri) { break; }
        state.confirmedUris[msg.match.uri] = true;
        var fileIdx = state.fileIndexByUri[msg.match.uri];
        if (typeof fileIdx === 'number' && state.files[fileIdx]) {
          Array.prototype.push.apply(state.files[fileIdx].matches, msg.match.matches || []);
        } else {
          state.fileIndexByUri[msg.match.uri] = state.files.length;
          state.files.push(msg.match);
        }
        // rg streams file-at-a-time. Rendering on every event nukes the
        // results DOM and can steal a click mid-action. Coalesce to one
        // render per animation frame — multiple events within ~16ms become
        // a single DOM rebuild.
        scheduleRender();
        updateSearchingStatus();
        // Show the preview for the FIRST match as soon as it arrives, not
        // after the whole search finishes. On a slow full-scan (multi-
        // second rg run) this is the difference between staring at an
        // empty preview pane for 10s vs seeing the first hit in <100ms.
        if (state.activeIndex < 0) {
          // render() / scheduleRender() may not have flushed state.flat
          // yet — do a sync rebuild so selectMatch can find row 0.
          render();
          if (state.flat.length > 0) { selectMatch(0); }
        }
        break;
      case 'results:done':
        if (msgSearchId !== null && msgSearchId !== state.searchId) { break; }
        state.searching = false;
        state.loadingMore = false;
        state.hasMoreResults = !!msg.truncated;
        if (typeof msg.pageSize === 'number' && msg.pageSize > 0) { state.pageSize = msg.pageSize; }
        state.lastBatchOffset = typeof msg.offset === 'number' ? msg.offset : 0;
        state.lastBatchMatches = typeof msg.pageMatches === 'number' ? msg.pageMatches : 0;
        state.lastBatchFiles = typeof msg.pageFiles === 'number' ? msg.pageFiles : 0;
        state.lastBatchMode = state.lastBatchOffset > 0 ? 'append' : 'initial';
        if (state.searchTicker) { clearInterval(state.searchTicker); state.searchTicker = null; }
        setSummary();
        if (state.lastBatchOffset > 0) {
          if (state.lastBatchMatches === 0) {
            setStatus(
              'No additional results' + formatElapsed(Date.now() - (state.searchStartTs || Date.now())),
              false,
            );
          } else {
            var visibleRows = countVisibleRows();
            var appendStatus = 'Loaded +' + state.lastBatchMatches + ' result' +
              (state.lastBatchMatches === 1 ? '' : 's') +
              ' in ' + state.lastBatchFiles + ' file' + (state.lastBatchFiles === 1 ? '' : 's') +
              ' (' + msg.totalMatches + ' total';
            if (state.filterQuery) { appendStatus += ', ' + visibleRows + ' visible'; }
            appendStatus += ')';
            if (msg.truncated) { appendStatus += ', scroll for more'; }
            setStatus(
              appendStatus + formatElapsed(Date.now() - (state.searchStartTs || Date.now())),
              false,
            );
          }
        } else if (msg.totalMatches === 0) {
          // Keep candidates visible even with no matches — they were the
          // planner's best guess, user may want to skim them manually.
          setStatus(
            (state.candidateTotal > 0
              ? 'No matches in ' + state.candidateTotal + ' candidate file' +
                (state.candidateTotal === 1 ? '' : 's')
              : 'No matches') + formatElapsed(Date.now() - (state.searchStartTs || Date.now())),
            false,
          );
        } else {
          // Real matches came back — drop the unconfirmed candidates so the
          // result list only shows actual hits.
          state.candidates = [];
          setStatus(
            msg.totalMatches + ' result' + (msg.totalMatches === 1 ? '' : 's') +
            ' in ' + msg.totalFiles + ' file' + (msg.totalFiles === 1 ? '' : 's') +
            (msg.truncated ? ' (truncated)' : '') +
            formatElapsed(Date.now() - (state.searchStartTs || Date.now())),
            false
          );
        }
        render();
        if (state.activeIndex < 0 && state.flat.length > 0) { selectMatch(0); }
        break;
      case 'results:error':
        if (msgSearchId !== null && msgSearchId !== state.searchId) { break; }
        state.searching = false;
        state.loadingMore = false;
        state.hasMoreResults = false;
        state.lastBatchMode = 'error';
        if (state.searchTicker) { clearInterval(state.searchTicker); state.searchTicker = null; }
        setStatus('Error: ' + msg.message, false);
        break;
      case 'history:update':
        state.searchHistory = Array.isArray(msg.entries) ? msg.entries.filter(function (entry) {
          return typeof entry === 'string' && entry.length > 0;
        }) : [];
        state.searchHistoryLimit = typeof msg.limit === 'number' ? msg.limit : state.searchHistoryLimit;
        renderSearchHistory();
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
