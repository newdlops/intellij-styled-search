export function getRendererPatchScript(): string {
  return `
(function () {
  if (window.__ijFindPatchedV50) { return 'already patched'; }
  window.__ijFindPatchedV50 = true;

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
  try { if (window.__ijFindStopCapture) { window.__ijFindStopCapture(); } } catch (e) {}
  window.__ijFindCaptures = {
    widgets: [],       // { v, src, key }  — CodeEditorWidget-like
    services: [],      // { v, src, key, kind } — DI / editor / model services
    widgetCtors: [],   // unique widget constructors we saw
    serviceMaps: [],   // Map instances that stored a service (likely ServiceCollection)
  };
  window.__ijFindCaptureInstalled = false;
  if (!window.__ijFindCaptureInstalled) {
    window.__ijFindCaptureInstalled = true;
    var caps = window.__ijFindCaptures;
    var capturing = true;
    function stringifyKey(k) {
      try {
        if (k === null || k === undefined) { return String(k); }
        if (typeof k === 'string') { return k.length > 60 ? k.slice(0, 60) + '…' : k; }
        if (typeof k === 'number' || typeof k === 'boolean') { return String(k); }
        return typeof k;
      } catch (e) { return '?'; }
    }
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
    // No auto-stop — extension controls the lifecycle via CDP. Patches
    // stay installed until __ijFindStopCapture is explicitly invoked.
  }

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
  window.__ijFindCreatePreviewEditor = function (host) {
    var m = window.__ijFindMonaco;
    if (!m || !m.ctor || !m.inst) { return null; }
    try {
      var editor = m.inst.createInstance(m.ctor, host, {
        automaticLayout: true,
        readOnly: false,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderLineHighlight: 'all',
      }, m.widgetOptions);
      return editor;
    } catch (e) {
      send({ type: 'log', msg: 'createPreviewEditor err: ' + (e && e.message) });
      return null;
    }
  };
  window.__ijFindSetPreviewContent = function (editor, content, languageId) {
    var m = window.__ijFindMonaco;
    if (!m || !m.modelSvc || !editor) { return false; }
    try {
      var model = m.modelSvc.createModel(content || '', languageId || 'plaintext');
      var old = editor.getModel && editor.getModel();
      editor.setModel(model);
      if (old && old.dispose && old !== model) { try { old.dispose(); } catch (e) {} }
      return true;
    } catch (e) {
      send({ type: 'log', msg: 'setPreviewContent err: ' + (e && e.message) });
      return false;
    }
  };

  window.__ijFindTestCreateWidget = function () {
    // Fast path: if a previous run already captured the real class + services,
    // don't recreate anything — we'd just burn a boot-time stub slot. Renderer
    // globals survive extension-host restarts, so this hits on warm reloads.
    try {
      var existing = window.__ijFindMonaco;
      if (existing && existing.ctor && existing.inst && existing.modelSvc) {
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
        try { var d = vv.getDomNode && vv.getDomNode(); if (d && d.tagName) { tag = d.tagName; } } catch (e) {}
        if (uri && uri !== '?') {
          realWidgets.push({ v: vv, src: cap.src, key: cap.key, uri: uri, tag: tag });
        }
      } catch (e) {}
    }
    report.push('captured widgets total=' + caps.widgets.length + ' real=' + realWidgets.length);
    report.push('widgetCtors=' + caps.widgetCtors.length + ' serviceMaps=' + caps.serviceMaps.length);

    // 1. Candidates: constructors captured, plus proto chain of any real widget.
    var candidates = [];
    for (var i = 0; i < caps.widgetCtors.length; i++) {
      var c = caps.widgetCtors[i];
      candidates.push({ ctor: c, src: 'captured[' + i + ']' });
    }
    var w0 = (realWidgets[0] && realWidgets[0].v) || (caps.widgets[0] && caps.widgets[0].v);
    if (realWidgets.length > 0) {
      report.push('real[0] uri=' + realWidgets[0].uri.slice(0, 100) + ' tag=' + realWidgets[0].tag);
    }
    if (w0) {
      try {
        var p = Object.getPrototypeOf(w0);
        var depth = 0;
        while (p && depth < 8) {
          var keys = [];
          try { keys = Object.getOwnPropertyNames(p); } catch (e) {}
          var hasL = keys.indexOf('layout') >= 0;
          var hasM = keys.indexOf('getModel') >= 0;
          var hasD = keys.indexOf('getDomNode') >= 0;
          var ctorName = '?';
          try { ctorName = (p.constructor && p.constructor.name) || '?'; } catch (e) {}
          report.push('proto[' + depth + '] ctor=' + ctorName + ' hasLGD=' + hasL + '/' + hasM + '/' + hasD + ' keys=' + keys.slice(0, 30).join(','));
          if (hasL && hasM && hasD) {
            try {
              if (p.constructor && candidates.every(function (ce) { return ce.ctor !== p.constructor; })) {
                candidates.push({ ctor: p.constructor, src: 'proto[' + depth + '].constructor' });
              }
            } catch (e) {}
          }
          p = Object.getPrototypeOf(p);
          depth++;
        }
      } catch (e) { report.push('proto walk err: ' + e.message); }
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

    // 4. Find an IInstantiationService from widget[0] if possible (same
    //    services tree as the widget — safest choice).
    var inst = caps.services[0].v;
    try {
      if (w0) {
        var keysW = Object.getOwnPropertyNames(w0);
        for (var ki = 0; ki < keysW.length; ki++) {
          var fv;
          try { fv = w0[keysW[ki]]; } catch (e) { continue; }
          if (fv && typeof fv === 'object' &&
              typeof fv.createInstance === 'function' &&
              typeof fv.invokeFunction === 'function') {
            inst = fv;
            report.push('using widget[0].' + keysW[ki] + ' as IInstantiationService');
            break;
          }
        }
      }
    } catch (e) {}

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
    var widgetOptions = { isSimpleWidget: false, contributions: [] };

    var createdEditor = null;
    for (var cj = 0; cj < candidates.length && !createdEditor; cj++) {
      var Ctor = candidates[cj].ctor;
      var srcLabel = candidates[cj].src;
      // Try: createInstance(Ctor, host, opts), createInstance(..., widgetOpts), new Ctor(host, opts), new Ctor(host, opts, widgetOpts)
      var attempts = [
        { fn: function (C) { return inst.createInstance(C, host, testOptions); }, label: 'createInstance(host,opts)' },
        { fn: function (C) { return inst.createInstance(C, host, testOptions, widgetOptions); }, label: 'createInstance(host,opts,wo)' },
        { fn: function (C) { return new C(host, testOptions); }, label: 'new(host,opts)' },
        { fn: function (C) { return new C(host, testOptions, widgetOptions); }, label: 'new(host,opts,wo)' },
      ];
      for (var aa = 0; aa < attempts.length && !createdEditor; aa++) {
        try {
          var ed = attempts[aa].fn(Ctor);
          if (ed && typeof ed === 'object') {
            createdEditor = ed;
            report.push('OK ' + srcLabel + ' ' + attempts[aa].label + ' → ' + (ed.constructor && ed.constructor.name));
            break;
          }
        } catch (e) {
          report.push('ERR ' + srcLabel + ' ' + attempts[aa].label + ' : ' + String(e && e.message || e).slice(0, 160));
        }
      }
    }

    if (!createdEditor) {
      try { document.body.removeChild(host); } catch (e) {}
      return report.join(' | ');
    }

    // ── Persist captured services so renderPreview can create real
    // monaco widgets long after capture stops ─────────────────────────
    var winnerCtor = null;
    for (var cw = 0; cw < candidates.length; cw++) {
      if (createdEditor && createdEditor.constructor === candidates[cw].ctor) {
        winnerCtor = candidates[cw].ctor;
        break;
      }
    }
    if (!winnerCtor) { winnerCtor = candidates[0] && candidates[0].ctor; }
    window.__ijFindMonaco = {
      ctor: winnerCtor,
      inst: inst,
      modelSvc: null, // filled below
      widgetOptions: widgetOptions,
    };

    // ── Post-create: force proper rendering ───────────────────────────
    // Widget was constructed, but content likely isn't rendered because the
    // implicit \`value\` option didn't seed a model in this context. Use the
    // captured IModelService to create a real TextModel and assign it, then
    // explicitly call layout() with the host's size.
    var modelSvc = null;
    for (var si = 0; si < caps.services.length; si++) {
      if (caps.services[si].kind === 'IModelService') { modelSvc = caps.services[si].v; break; }
    }
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
    '.ij-find-query {',
    '  flex: 1; padding: 5px 8px;',
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
    '.ij-find-row-pending { opacity: 0.45; font-style: italic; }',
    '.ij-find-row-pending.active { opacity: 0.8; }',
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
    // Host element for the embedded Monaco editor. Monaco needs a sized box.
    '.ij-find-monaco-host {',
    '  flex: 1 1 auto; width: 100%; height: 100%; min-height: 0; overflow: hidden;',
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

  var $modifiedDot = el('span', { className: 'ij-find-modified-dot', title: 'Unsaved changes' });
  var $previewPath = el('span', { className: 'ij-find-preview-path', text: '' });
  var $previewHeader = el('div', { className: 'ij-find-preview-header', children: [$modifiedDot, $previewPath] });
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
    options: { caseSensitive: false, wholeWord: false, useRegex: false },
    files: [],
    flat: [],
    candidates: [],             // [{uri, relPath}] — planner-narrowed files, rg hasn't confirmed yet
    candidateTotal: 0,          // total planner candidate count (may exceed what we show)
    confirmedUris: {},          // uri → true once rg emits a match for it
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
    $previewPath.textContent = '';
    $preview.classList.remove('ij-find-modified');
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

  function render() {
    clearChildren($results);
    var hasMatches = state.files.length > 0;
    // Pending candidates: show whenever we have them, whether rg is still
    // scanning OR the search finished with 0 matches (user still wants to
    // see which files were considered).
    var hasPending = state.candidates.length > 0;
    if (!hasMatches && !hasPending) {
      var emptyText = state.searching
        ? 'Searching\u2026'
        : ($q.value ? 'No results' : 'Type to search');
      $results.appendChild(el('div', { className: 'ij-find-empty', text: emptyText }));
      state.flat = [];
      setSummary();
      return;
    }
    state.flat = [];
    var frag = document.createDocumentFragment();
    // Confirmed matches first (normal rows, one per match line).
    for (var fi = 0; fi < state.files.length; fi++) {
      var f = state.files[fi];
      for (var mi = 0; mi < f.matches.length; mi++) {
        var m = f.matches[mi];
        var flatIdx = state.flat.length;
        state.flat.push({ fi: fi, mi: mi });

        var textEl = el('span', { className: 'ij-find-row-text' });
        appendHighlightedInto(textEl, m.preview, m.ranges);

        var slashIdx = f.relPath.lastIndexOf('/');
        var fileName = slashIdx >= 0 ? f.relPath.slice(slashIdx + 1) : f.relPath;
        var locText = fileName + ':' + (m.line + 1);
        var locEl = el('span', {
          className: 'ij-find-row-loc',
          title: f.relPath + ':' + (m.line + 1),
          text: locText,
        });

        frag.appendChild(el('div', {
          className: 'ij-find-row',
          attrs: { 'data-flat': String(flatIdx) },
          children: [textEl, locEl],
        }));
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
        var pendingFlatIdx = state.flat.length;
        state.flat.push({ pendingUri: c.uri, pendingRelPath: c.relPath });
        var cSlash = c.relPath.lastIndexOf('/');
        var cName = cSlash >= 0 ? c.relPath.slice(cSlash + 1) : c.relPath;
        var pendRow = el('div', {
          className: 'ij-find-row ij-find-row-pending',
          attrs: { 'data-flat': String(pendingFlatIdx), title: c.relPath },
          children: [
            el('span', { className: 'ij-find-row-text', text: '\u2026 scanning' }),
            el('span', { className: 'ij-find-row-loc', text: cName }),
          ],
        });
        frag.appendChild(pendRow);
        shown++;
      }
      if (state.candidateTotal > shown + state.files.length) {
        var overflowEl = el('div', {
          className: 'ij-find-empty',
          text: '+ ' + (state.candidateTotal - shown - state.files.length) +
                ' more candidate file(s) being scanned\u2026',
        });
        frag.appendChild(overflowEl);
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
    // Only refresh the overlay's preview pane; do NOT touch VSCode's editor
    // area at all. Arrow-key browsing leaves no trace.
    send({ type: 'requestPreview', uri: f.uri, line: m.line, ranges: m.ranges, contextLines: 0 });
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

  function triggerSearch() {
    var raw = $q.value;
    // Trim leading/trailing whitespace (covers spaces, tabs, newlines).
    // Pasted selections almost always drag an extra blank line along, which
    // would prevent rg's literal match from hitting a file that doesn't
    // start with a newline. Interior whitespace stays intact.
    var q = typeof raw === 'string' ? raw.trim() : '';
    clearPreview();
    if (!q) {
      state.files = []; state.flat = []; state.activeIndex = -1; state.searching = false;
      setStatus('Type a query', false);
      render();
      send({ type: 'cancel' });
      return;
    }
    send({
      type: 'log',
      msg: 'triggerSearch: len=' + q.length + '(raw=' + raw.length + ') hasNL=' +
           (q.indexOf('\\n') >= 0) +
           ' preview=' + JSON.stringify(q.slice(0, 120)),
    });
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

  $q.addEventListener('input', function () { autosizeQuery(); scheduleSearch(); });
  $q.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      // Shift+Enter: insert literal newline (textarea default) → enables
      // ripgrep multi-line search. Plain Enter: navigate or trigger search.
      if (state.debounce) { clearTimeout(state.debounce); }
      e.preventDefault();
      if (state.flat.length > 0 && state.activeIndex < 0) { selectMatch(0); }
      else if (state.flat.length > 0) { openActive(); }
      else { triggerSearch(); }
    } else if (e.key === 'ArrowDown' && !e.shiftKey) { e.preventDefault(); moveActive(1); }
    else if (e.key === 'ArrowUp' && !e.shiftKey) { e.preventDefault(); moveActive(-1); }
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
    var fullText = (msg.lines || []).map(function (l) { return l.text; }).join('\\n');
    var lang = msg.languageId || 'plaintext';
    send({ type: 'log', msg: 'monacoReal lines=' + (msg.lines ? msg.lines.length : 0) + ' lang=' + lang + ' reuse=' + !!(state.previewMonacoEditor && state.previewMonacoHost && state.previewMonacoHost.parentElement === $previewBody) });
    // Reuse existing widget if it's still mounted in our preview body.
    if (state.previewMonacoEditor && state.previewMonacoHost && state.previewMonacoHost.parentElement === $previewBody) {
      var ok = window.__ijFindSetPreviewContent(state.previewMonacoEditor, fullText, lang);
      send({ type: 'log', msg: 'monacoReal reuse setModel=' + ok });
      if (ok) {
        try { state.previewMonacoEditor.revealLineInCenter(msg.focusLine + 1); } catch (e) {}
        try {
          var rect = state.previewMonacoHost.getBoundingClientRect();
          state.previewMonacoEditor.layout({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
        } catch (e) {}
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
    var setOk = window.__ijFindSetPreviewContent(editor, fullText, lang);
    send({ type: 'log', msg: 'monacoReal setPreviewContent=' + setOk });
    try {
      var r2 = host.getBoundingClientRect();
      editor.layout({ width: Math.floor(r2.width), height: Math.floor(r2.height) });
    } catch (e) {}
    try { editor.revealLineInCenter(msg.focusLine + 1); } catch (e) {}
    // Post-render check
    try {
      var vl = editor.getDomNode && editor.getDomNode() && editor.getDomNode().querySelectorAll('.view-line');
      send({ type: 'log', msg: 'monacoReal rendered viewLines=' + (vl ? vl.length : '?') });
    } catch (e) {}
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

  // Search \`.monaco-editor\`, each of its ancestors up to .editor-group-container,
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
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        lineNumbers: 'on',
        glyphMargin: false,
        folding: true,
        contextmenu: true,
        fontSize: 12,
        renderLineHighlight: 'all',
        occurrencesHighlight: true,
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
    state.previewMode = 'dom';
    // If we previously hosted Monaco, detach it.
    if (state.monacoEditor && state.monacoHost && state.monacoHost.parentElement === $previewBody) {
      try { state.monacoHost.parentElement.removeChild(state.monacoHost); } catch (e) {}
    }
    $previewBody.classList.remove('ij-find-editor-mounted');
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
      // Paint the overlay BEFORE firing the search — otherwise the browser
      // processes our JS (send to extension → runRgSearch → network roundtrip)
      // inside the same microtask and the panel appears only after the first
      // results:start message lands. rAF guarantees one paint first.
      if (typeof initialQuery === 'string' && initialQuery && initialQuery !== $q.value) {
        $q.value = initialQuery;
        autosizeQuery();
        setStatus('Searching\u2026', true);
        render();
        requestAnimationFrame(function () {
          requestAnimationFrame(triggerSearch);
        });
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
      return 'inDom=' + document.body.contains(panel) +
        ' disp=' + cs.display +
        ' z=' + cs.zIndex +
        ' rect=' + Math.round(r.x) + ',' + Math.round(r.y) + ',' + Math.round(r.width) + 'x' + Math.round(r.height) +
        ' monacoGlobal=' + (typeof monaco !== 'undefined') +
        ' windowRequire=' + (typeof window.require) +
        ' AMDLoader=' + (typeof globalThis.AMDLoader) +
        ' MonacoEnv=' + (typeof globalThis.MonacoEnvironment) +
        ' globalCandidates=[' + globalKeys.join(',') + ']' +
        ' domEditors=' + domEditors.length +
        ' firstEditorProps=[' + firstEditorProps.join(',') + ']';
    } catch (e) { return 'status-err: ' + (e && e.message); }
  };
  window.__ijFindOnMessage = function (msg) {
    switch (msg.type) {
      case 'results:start':
        state.files = []; state.flat = []; state.candidates = [];
        state.candidateTotal = 0; state.confirmedUris = {};
        state.activeIndex = -1; state.searching = true;
        clearPreview();
        setStatus('Searching\u2026', true);
        render();
        break;
      case 'results:candidates':
        // Planner narrowed the workspace to these files; rg hasn't matched
        // them yet. Show as pending rows so the user sees *something*
        // clickable immediately instead of an empty Searching state.
        state.candidates = msg.candidates || [];
        state.candidateTotal = msg.total || state.candidates.length;
        setStatus('Searching ' + state.candidateTotal + ' candidate file' +
                  (state.candidateTotal === 1 ? '' : 's') + '\u2026', true);
        render();
        break;
      case 'results:file':
        state.confirmedUris[msg.match.uri] = true;
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
          // Keep candidates visible even with no matches — they were the
          // planner's best guess, user may want to skim them manually.
          setStatus(
            state.candidateTotal > 0
              ? 'No matches in ' + state.candidateTotal + ' candidate file' +
                (state.candidateTotal === 1 ? '' : 's')
              : 'No matches',
            false,
          );
        } else {
          // Real matches came back — drop the unconfirmed candidates so the
          // result list only shows actual hits.
          state.candidates = [];
          setStatus(
            msg.totalMatches + ' result' + (msg.totalMatches === 1 ? '' : 's') +
            ' in ' + msg.totalFiles + ' file' + (msg.totalFiles === 1 ? '' : 's') +
            (msg.truncated ? ' (truncated)' : ''),
            false
          );
        }
        render();
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
