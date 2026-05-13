export const RENDERER_PATCH_VERSION = 127;

export function getRendererPatchScript(
  enableMonacoPreviewCapture = false,
  enablePerfDiagnostics = false,
  suspendIntelliSenseRecursionCapture = true,
  enableRendererInlayClickHook = true,
  disposeRendererPatchOnHide = true,
  installAdditionalSearchInstance = false,
  // #47: opt-in to enable Pylance/LSP hover + autocomplete in preview by
  // creating the embed editor with isSimpleWidget=false. Trade-off: the
  // workbench's EditorService may try to take over the editor on focus
  // (see rendererPatch.ts createPreviewEditor comment) — but #46-1 and
  // hide/show preservation guards mitigate most user-visible damage.
  enablePreviewLanguageFeatures = false,
): string {
  const enableMonacoPreviewCaptureLiteral = enableMonacoPreviewCapture ? 'true' : 'false';
  const enablePerfDiagnosticsLiteral = enablePerfDiagnostics ? 'true' : 'false';
  const suspendIntelliSenseRecursionCaptureLiteral = suspendIntelliSenseRecursionCapture ? 'true' : 'false';
  const enableRendererInlayClickHookLiteral = enableRendererInlayClickHook ? 'true' : 'false';
  const disposeRendererPatchOnHideLiteral = disposeRendererPatchOnHide ? 'true' : 'false';
  const installAdditionalSearchInstanceLiteral = installAdditionalSearchInstance ? 'true' : 'false';
  const enablePreviewLanguageFeaturesLiteral = enablePreviewLanguageFeatures ? 'true' : 'false';
  return `
(function () {
  var __ijFindPatchVersion = ${RENDERER_PATCH_VERSION};
  var __ijFindEnableMonacoPreviewCapture = ${enableMonacoPreviewCaptureLiteral};
  var __ijFindEnablePerfDiagnostics = ${enablePerfDiagnosticsLiteral};
  var __ijFindShouldSuspendIntelliSenseRecursionCapture = ${suspendIntelliSenseRecursionCaptureLiteral};
  var __ijFindEnableRendererInlayClickHook = ${enableRendererInlayClickHookLiteral};
  var __ijFindDisposeRendererPatchOnHide = ${disposeRendererPatchOnHideLiteral};
  var __ijFindInstallAdditionalInstance = ${installAdditionalSearchInstanceLiteral};
  var __ijFindEnablePreviewLanguageFeatures = ${enablePreviewLanguageFeaturesLiteral};
  try {
    if (!__ijFindInstallAdditionalInstance && typeof window.__ijFindDisposeAllSearchUi === 'function') {
      window.__ijFindDisposeAllSearchUi('patch-upgrade');
    } else if (!__ijFindInstallAdditionalInstance && typeof window.__ijFindDisposeSearchUi === 'function') {
      window.__ijFindDisposeSearchUi('patch-upgrade');
    }
  } catch (eDisposePrevious) {}
  if (!__ijFindInstallAdditionalInstance && window.__ijFindPatchVersion === __ijFindPatchVersion && window.__ijFindPatchedV100) {
    try { window.__ijFindDisableMonacoProbes = !__ijFindEnableMonacoPreviewCapture; } catch (eFlag) {}
    try { window.__ijFindPerfDiagnostics = !!__ijFindEnablePerfDiagnostics; } catch (ePerfFlag) {}
    try { window.__ijFindShouldSuspendIntelliSenseRecursionCapture = !!__ijFindShouldSuspendIntelliSenseRecursionCapture; } catch (eIrFlag) {}
    try { window.__ijFindEnableRendererInlayClickHook = !!__ijFindEnableRendererInlayClickHook; } catch (eInlayFlag) {}
    try { window.__ijFindDisposeRendererPatchOnHide = !!__ijFindDisposeRendererPatchOnHide; } catch (eDisposeFlag) {}
  if (!__ijFindEnableMonacoPreviewCapture) {
      try { if (window.__ijFindStopCapture) { window.__ijFindStopCapture('already-patched-monaco-disabled'); } } catch (eStopAlready) {}
      try { window.__ijFindMonaco = null; } catch (eMonacoAlready) {}
      try { window.__ijFindMonacoFactory = null; } catch (eMonacoFactoryAlready) {}
    }
    return 'already patched:v' + __ijFindPatchVersion;
  }
  try { window.__ijFindPatchedV92 = false; } catch (eOldFlag) {}
  try { window.__ijFindPatchedV93 = false; } catch (eOldFlag93) {}
  try { window.__ijFindPatchedV94 = false; } catch (eOldFlag94) {}
  try { window.__ijFindPatchedV95 = false; } catch (eOldFlag95) {}
  try { window.__ijFindPatchedV96 = false; } catch (eOldFlag96) {}
  try { window.__ijFindPatchedV97 = false; } catch (eOldFlag97) {}
  try { window.__ijFindPatchedV98 = false; } catch (eOldFlag98) {}
  try { window.__ijFindPatchedV99 = false; } catch (eOldFlag99) {}
  window.__ijFindPatchedV100 = true;
  window.__ijFindPatchVersion = __ijFindPatchVersion;
  window.__ijFindPerfDiagnostics = !!__ijFindEnablePerfDiagnostics;
  window.__ijFindShouldSuspendIntelliSenseRecursionCapture = !!__ijFindShouldSuspendIntelliSenseRecursionCapture;
  window.__ijFindEnableRendererInlayClickHook = !!__ijFindEnableRendererInlayClickHook;
  window.__ijFindDisposeRendererPatchOnHide = !!__ijFindDisposeRendererPatchOnHide;
  function isRendererDiagnosticsEnabled() {
    try { return window.__ijFindPerfDiagnostics === true || window.__ijFindRendererTrace === true; }
    catch (eDiagFlag) { return false; }
  }
  function installIntelliSenseRecursionCaptureGuard() {
    try {
      if (!window.__ijFindShouldSuspendIntelliSenseRecursionCapture) { return 'disabled'; }
      var start = window.__irStartCapture;
      if (typeof start !== 'function') { return 'no-start'; }
      if (start.__ijssGuarded === true) { return 'already'; }
      var original = start.__ijssOriginal || start;
      var guarded = function (reason) {
        try {
          if (window.__ijFindIrCaptureSuspended === true) {
            return 'suppressed:ijss:' + String(reason || 'unknown');
          }
        } catch (eSuppressed) {}
        return original.apply(this, arguments);
      };
      try { guarded.__ijssGuarded = true; } catch (eGuardFlag) {}
      try { guarded.__ijssOriginal = original; } catch (eOrigFlag) {}
      window.__irStartCapture = guarded;
      return 'wrapped';
    } catch (eGuard) {
      return 'guard-err:' + String(eGuard && eGuard.message || eGuard).slice(0, 120);
    }
  }
  // Multi-reason recursion-capture suspend tracker. The IR capture is
  // considered suspended while *any* reason is active. Each reason can be
  // added or removed independently so different parts of the system (the
  // search overlay being visible, a workbench-editor tab-switch, etc.) can
  // hold their own slot without overwriting each other.
  if (!window.__ijFindIrSuspendReasons || typeof window.__ijFindIrSuspendReasons !== 'object') {
    try { window.__ijFindIrSuspendReasons = Object.create(null); } catch (eIrInit) {}
  }
  if (typeof window.__ijFindEditorActivityCount !== 'number') {
    try { window.__ijFindEditorActivityCount = 0; } catch (eIrCount) {}
  }
  function listIrSuspendReasons() {
    try {
      var bag = window.__ijFindIrSuspendReasons || {};
      var out = [];
      for (var key in bag) { if (Object.prototype.hasOwnProperty.call(bag, key)) { out.push(key); } }
      return out;
    } catch (eListIr) { return []; }
  }
  function setIntelliSenseRecursionCaptureSuspended(active, reason) {
    try {
      if (!window.__ijFindShouldSuspendIntelliSenseRecursionCapture) { return 'disabled'; }
      var guard = installIntelliSenseRecursionCaptureGuard();
      var key = String(reason || 'unknown');
      try { if (!window.__ijFindIrSuspendReasons) { window.__ijFindIrSuspendReasons = Object.create(null); } } catch (eEnsureBag) {}
      var bag = window.__ijFindIrSuspendReasons;
      if (active) {
        try { bag[key] = true; } catch (eAddReason) {}
      } else {
        try { delete bag[key]; } catch (eDelReason) {}
        // 'search-ui-hidden' is the paired un-suspend for 'search-ui-visible'.
        // Treat it as clearing the whole search-ui pair so callers that pass
        // 'search-ui-hidden' don't have to know about both keys.
        if (key === 'search-ui-hidden') {
          try { delete bag['search-ui-visible']; } catch (eDelVisible) {}
        }
      }
      var suspended = false;
      try { for (var anyKey in bag) { if (Object.prototype.hasOwnProperty.call(bag, anyKey)) { suspended = true; break; } } } catch (eAnyKey) {}
      window.__ijFindIrCaptureSuspended = suspended;
      window.__ijFindIrCaptureSuspendReason = suspended ? listIrSuspendReasons().join(',') : '';
      var stopped = '';
      if (suspended && window.__irCaptureActive && typeof window.__irStopCapture === 'function') {
        try { stopped = String(window.__irStopCapture('ijss:' + key)); }
        catch (eStopIr) { stopped = 'stop-err:' + String(eStopIr && eStopIr.message || eStopIr).slice(0, 120); }
      }
      return 'suspend=' + suspended + ' guard=' + guard + (stopped ? ' stop=' + stopped : '');
    } catch (eSuspendIr) {
      return 'suspend-err:' + String(eSuspendIr && eSuspendIr.message || eSuspendIr).slice(0, 120);
    }
  }
  window.__ijFindSetIntelliSenseRecursionCaptureSuspended = setIntelliSenseRecursionCaptureSuspended;
  window.__ijFindIntelliSenseRecursionCaptureState = function () {
    try {
      return {
        suspended: !!window.__ijFindIrCaptureSuspended,
        reasons: listIrSuspendReasons(),
        editorActivityCount: typeof window.__ijFindEditorActivityCount === 'number'
          ? window.__ijFindEditorActivityCount
          : 0,
      };
    } catch (eState) { return { err: String(eState && eState.message || eState).slice(0, 120) }; }
  };
  // editor-activity reason is reference-counted and auto-clears after 1s
  // of quiescence so a tab-switch burst keeps the IR capture suppressed
  // without permanently disabling it.
  var __ijssEditorActivityTimer;
  function noteEditorActivityFromWorkbench(reason) {
    try {
      window.__ijFindEditorActivityCount = (typeof window.__ijFindEditorActivityCount === 'number'
        ? window.__ijFindEditorActivityCount
        : 0) + 1;
      setIntelliSenseRecursionCaptureSuspended(true, 'editor-activity');
    } catch (eNote) {}
    try { if (__ijssEditorActivityTimer) { clearTimeout(__ijssEditorActivityTimer); } } catch (eClearTimer) {}
    try {
      __ijssEditorActivityTimer = setTimeout(function () {
        __ijssEditorActivityTimer = undefined;
        try { setIntelliSenseRecursionCaptureSuspended(false, 'editor-activity'); } catch (eClearReason) {}
      }, 1000);
    } catch (eTimerSet) {}
  }
  window.__ijFindNoteWorkbenchEditorActivity = noteEditorActivityFromWorkbench;

  // Unique id per patch install (per window). Paired with __seq below so the
  // ext host can dedup duplicate deliveries from accumulated CDP listeners
  // WITHOUT accidentally dropping legitimate events from *other* windows that
  // have their own independent __seq counters — a single global lastSeenSeq
  // would drop win=101's __seq=1 if win=95 had already bumped it to 200.
  var __ijFindInstanceId = 'ij-' + Math.random().toString(36).slice(2) + '-' + Date.now();
  var __ijFindSeq = 0;
  var __ijFindConsoleBridgePrefix = '__IJSS_BRIDGE__';
  try {
    globalThis.irSearchEvent = function (payload) {
      try { console.info(__ijFindConsoleBridgePrefix + String(payload)); } catch (eConsole) {}
    };
  } catch (eBridgeInstall) {}
  function send(payload) {
    try {
      if (__ijFindDisposed) { return; }
      if (payload && payload.type === 'log' && !window.__ijFindDebugRendererLogs) {
        var logMsg = String(payload.msg || '');
        if (logMsg.indexOf('__ij-bridge-ping-') !== 0) { return; }
      }
      payload.__seq = ++__ijFindSeq;
      payload.__src = __ijFindInstanceId;
      var raw = JSON.stringify(payload);
      if (typeof globalThis.irSearchEvent === 'function') {
        globalThis.irSearchEvent(raw);
      } else {
        console.info(__ijFindConsoleBridgePrefix + raw);
      }
    } catch (e) {}
  }
  function sendPersistent(payload) {
    try {
      if (payload && payload.type === 'log' && !window.__ijFindDebugRendererLogs) {
        var logMsg = String(payload.msg || '');
        if (logMsg.indexOf('__ij-bridge-ping-') !== 0) { return; }
      }
      payload.__seq = ++__ijFindSeq;
      payload.__src = __ijFindInstanceId;
      var raw = JSON.stringify(payload);
      if (typeof globalThis.irSearchEvent === 'function') {
        globalThis.irSearchEvent(raw);
      } else {
        console.info(__ijFindConsoleBridgePrefix + raw);
      }
    } catch (e) {}
  }

  var __ijFindDisposers = [];
  var __ijFindDisposed = false;
  function addDisposer(fn) {
    if (typeof fn === 'function') { __ijFindDisposers.push(fn); }
    return fn;
  }
  function on(target, type, listener, options) {
    if (!target || typeof target.addEventListener !== 'function') { return listener; }
    target.addEventListener(type, listener, options);
    addDisposer(function () {
      try { target.removeEventListener(type, listener, options); } catch (eRemoveListener) {}
    });
    return listener;
  }
  function trackObserver(observer) {
    if (observer && typeof observer.disconnect === 'function') {
      addDisposer(function () {
        try { observer.disconnect(); } catch (eDisconnect) {}
      });
    }
    return observer;
  }
  function disposeSearchUi(reason) {
    if (__ijFindDisposed) { return 'already-disposed'; }
    __ijFindDisposed = true;
    var out = [];
    try {
      var registry = window.__ijFindInstances || null;
      if (registry && registry[__ijFindInstanceId]) {
        delete registry[__ijFindInstanceId];
        out.push('registry=removed');
      }
      if (window.__ijFindActiveInstanceId === __ijFindInstanceId) {
        var nextActive = '';
        if (registry) {
          for (var rk in registry) {
            if (Object.prototype.hasOwnProperty.call(registry, rk)) { nextActive = rk; break; }
          }
        }
        window.__ijFindActiveInstanceId = nextActive;
      }
    } catch (eRegistryDispose) {}
    try { cancelScheduledRender(); out.push('render=cancelled'); } catch (eRender) {}
    try { if (typeof state !== 'undefined' && state && state.searchTicker) { clearInterval(state.searchTicker); state.searchTicker = null; out.push('ticker=cleared'); } } catch (eTicker) {}
    try { if (typeof state !== 'undefined' && state && state.debounce) { clearTimeout(state.debounce); state.debounce = null; out.push('debounce=cleared'); } } catch (eDebounce) {}
    try { if (typeof state !== 'undefined' && state && state.hoverTimer) { clearTimeout(state.hoverTimer); state.hoverTimer = null; out.push('hoverTimer=cleared'); } } catch (eHoverTimer) {}
    try { if (typeof hoverHideTimer !== 'undefined' && hoverHideTimer) { clearTimeout(hoverHideTimer); hoverHideTimer = null; out.push('hoverHide=cleared'); } } catch (eHoverHide) {}
    try { if (typeof restoreStolenEditor === 'function' && state && state.stolenEditor) { restoreStolenEditor(); out.push('stolen=restored'); } } catch (eStolen) {}
    try { if (typeof disposePreviewMonacoEditor === 'function') { disposePreviewMonacoEditor(); out.push('preview=disposed'); } } catch (ePreview) {}
    try {
      if (typeof state !== 'undefined' && state) {
        state.files = [];
        state.flat = [];
        state.candidates = [];
        state.confirmedUris = {};
        state.fileIndexByUri = {};
        state.matchCount = 0;
        state.searching = false;
        state.loadingMore = false;
        state.hasMoreResults = false;
        state.lastPreviewMsg = null;
        out.push('state=cleared');
      }
    } catch (eState) {}
    for (var di = __ijFindDisposers.length - 1; di >= 0; di--) {
      try { __ijFindDisposers[di](); } catch (eDisposer) {}
    }
    __ijFindDisposers = [];
    try { if (typeof hideHover === 'function') { hideHover(); out.push('hover=hidden'); } } catch (eHover) {}
    try { if (typeof panel !== 'undefined' && panel && panel.parentElement) { panel.parentElement.removeChild(panel); out.push('panel=detached'); } } catch (ePanelDetach) {}
    // $hoverTooltip removed in #32 — nothing to detach here.
    try {
      var previewOverflowRoot = findPreviewOverflowRootForInstance();
      if (previewOverflowRoot && previewOverflowRoot.parentElement) {
        previewOverflowRoot.parentElement.removeChild(previewOverflowRoot);
        out.push('overflow=detached');
      }
    } catch (eOverflowDetach) {}
    try { setIntelliSenseRecursionCaptureSuspended(false, 'dispose:' + (reason || 'unknown')); } catch (eIrDispose) {}
    try {
      var remainingInstances = false;
      var remainingRegistry = window.__ijFindInstances || null;
      if (remainingRegistry) {
        for (var rr in remainingRegistry) {
          if (Object.prototype.hasOwnProperty.call(remainingRegistry, rr)) { remainingInstances = true; break; }
        }
      }
      if (!remainingInstances) { window.__ijFindPatchedV100 = false; }
    } catch (ePatchFlag) {}
    try {
      var hasInstancesForVersion = false;
      var versionRegistry = window.__ijFindInstances || null;
      if (versionRegistry) {
        for (var vr in versionRegistry) {
          if (Object.prototype.hasOwnProperty.call(versionRegistry, vr)) { hasInstancesForVersion = true; break; }
        }
      }
      if (!hasInstancesForVersion && window.__ijFindPatchVersion === __ijFindPatchVersion) {
        window.__ijFindPatchVersion = 0;
      }
    } catch (ePatchVersion) {}
    return out.join(',') || 'disposed';
  }
  window.__ijFindDisposeSearchUi = disposeSearchUi;

  // Remove overlay/hover DOM left behind by a previous patch version so
  // the new install is the ONLY instance in the page. Without this, older
  // V50 panels accumulate after an extension upgrade and querySelector
  // calls (including test probes) may hit stale nodes whose state the new
  // closure no longer owns.
  if (!__ijFindInstallAdditionalInstance) { try {
    var stale = document.querySelectorAll('.ij-find-overlay, .ij-find-panel, .ij-find-hover-tooltip, .ij-find-preview-overflow-root, .ij-find-preview-overflow');
    for (var si = 0; si < stale.length; si++) {
      try { stale[si].parentElement && stale[si].parentElement.removeChild(stale[si]); } catch (eRm) {}
    }
  } catch (eClean) {} }
  // If an older renderer patch left prototype capture active, undo it before
  // installing this version. A live Array/Map/Reflect hook can slow the whole
  // VSCode renderer, not just this extension.
  try { if (window.__ijFindStopCapture) { window.__ijFindStopCapture('patch-upgrade'); } } catch (eStopOld) {}
  try { window.__ijFindDisableMonacoProbes = !__ijFindEnableMonacoPreviewCapture; } catch (eDisableFlag) {}
  // Keep the Monaco editor factory across additional/spawned panel installs.
  // The factory stores constructor + DI services, not a preview widget, so it
  // is safe to reuse for the lifetime of this renderer/workspace and avoids
  // reopening a tab just to recover from DOM fallback.
  try {
    var preservedMonacoFactory = window.__ijFindMonacoFactory ||
      (window.__ijFindMonaco && window.__ijFindMonaco.factorySingleton ? window.__ijFindMonaco : null);
    if (preservedMonacoFactory &&
        preservedMonacoFactory.ctor &&
        preservedMonacoFactory.factoryVersion === __ijFindPatchVersion) {
      window.__ijFindMonacoFactory = preservedMonacoFactory;
      window.__ijFindMonaco = preservedMonacoFactory;
    } else {
      window.__ijFindMonacoFactory = null;
      window.__ijFindMonaco = null;
    }
  } catch (eMM) {}

  // ── Capture VSCode internals via prototype interception ─────────────
  // Optional Monaco capture. This is disabled by default because these
  // prototype hooks run on VSCode's renderer/UI thread.
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
    if (window.__ijFindDisableMonacoProbes) { return 'capture-disabled'; }
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
    if (window.__ijFindDisableMonacoProbes) { return 'capture-disabled'; }
    try {
      if (window.__ijFindMonacoFactory && window.__ijFindMonacoFactory.ctor) {
        window.__ijFindMonaco = window.__ijFindMonacoFactory;
      } else {
        window.__ijFindMonaco = null;
      }
    } catch (eMonaco) {}
    return window.__ijFindStartCapture(reason || 'refresh');
  };
  if (!window.__ijFindDisableMonacoProbes) {
    window.__ijFindStartCapture('patch-load');
  } else {
    caps = makeCaptureState();
    window.__ijFindCaptures = caps;
    window.__ijFindCaptureInstalled = false;
  }
  // Keep the history behaviour: capture is armed at patch load and stopped
  // explicitly after the diagnostic has promoted a widget constructor and
  // services into __ijFindMonaco.

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
  //   4. Stack above our overlay panel (z-index 10000) so the hover
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
  function findPreviewOverflowRootForInstance() {
    try {
      var roots = document.querySelectorAll('.ij-find-preview-overflow-root');
      for (var i = 0; i < roots.length; i++) {
        if (roots[i] && roots[i].getAttribute && roots[i].getAttribute('data-ij-find-src') === __ijFindInstanceId) {
          return roots[i];
        }
      }
    } catch (eFindOverflowRoot) {}
    return null;
  }
  function getOrCreatePreviewOverflowHost() {
    var root = findPreviewOverflowRootForInstance();
    var existing = root && root.querySelector('.ij-find-preview-overflow');
    if (existing && existing.parentElement) {
      markSearchUiRoot(root);
      markSearchUiRoot(existing);
      try { root.setAttribute('data-ij-find-src', __ijFindInstanceId); } catch (eRootSrcExisting) {}
      try { existing.setAttribute('data-ij-find-src', __ijFindInstanceId); } catch (eNodeSrcExisting) {}
      if (root.parentElement !== document.body) { document.body.appendChild(root); }
      syncPreviewOverflowTheme(root);
      return existing;
    }
    root = document.createElement('div');
    root.className = 'monaco-workbench ij-find-preview-overflow-root';
    markSearchUiRoot(root);
    try { root.setAttribute('data-ij-find-src', __ijFindInstanceId); } catch (eRootSrc) {}
    root.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'width:0',
      'height:0',
      'overflow:visible',
      'z-index:10020',
      'pointer-events:none',
    ].join(';');
    var node = document.createElement('div');
    node.className = 'monaco-editor ij-find-preview-overflow';
    markSearchUiRoot(node);
    try { node.setAttribute('data-ij-find-src', __ijFindInstanceId); } catch (eNodeSrc) {}
    node.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'width:0',
      'height:0',
      'overflow:visible',
      'z-index:10020',
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
  function getMonacoFactorySingleton() {
    var factory = null;
    var current = null;
    try { factory = window.__ijFindMonacoFactory || null; } catch (eFactory) {}
    try { current = window.__ijFindMonaco || null; } catch (eCurrent) {}
    if (factory && factory.ctor) {
      try {
        if (!current || !current.ctor) {
          window.__ijFindMonaco = factory;
        }
      } catch (ePromoteFactory) {}
      return factory;
    }
    if (current && current.ctor) {
      if (current.factorySingleton) {
        try { window.__ijFindMonacoFactory = current; } catch (ePromoteCurrent) {}
      }
      return current;
    }
    return null;
  }
  function ensureMonacoFactoryCandidateArrays(m) {
    if (!m) { return; }
    try {
      if (!Array.isArray(m.instCandidates)) { m.instCandidates = []; }
    } catch (eInstArr) {}
    try {
      if (!Array.isArray(m.modelSvcCandidates)) { m.modelSvcCandidates = []; }
    } catch (eModelArr) {}
  }
  function installMonacoFactorySingleton(m) {
    if (!m || !m.ctor) { return m; }
    ensureMonacoFactoryCandidateArrays(m);
    try { m.factorySingleton = true; } catch (eFlag) {}
    try { m.factoryVersion = __ijFindPatchVersion; } catch (eVersion) {}
    try { m.factoryCreatedAt = m.factoryCreatedAt || Date.now(); } catch (eCreated) {}
    try { window.__ijFindMonacoFactory = m; } catch (eFactory) {}
    try { window.__ijFindMonaco = m; } catch (eCurrent) {}
    return m;
  }
  function rememberMonacoInstCandidate(m, inst, label) {
    if (!m || !isInstantiationServiceLike(inst)) { return; }
    ensureMonacoFactoryCandidateArrays(m);
    try {
      addInstCandidate(m.instCandidates, inst, label || 'factory');
      if (m.instCandidates.length > 16) { m.instCandidates.length = 16; }
      m.inst = inst;
    } catch (eRememberInst) {}
  }
  function rememberMonacoModelServiceCandidate(m, modelSvc, label) {
    if (!m || !isModelServiceLike(modelSvc)) { return; }
    ensureMonacoFactoryCandidateArrays(m);
    try {
      addModelServiceCandidate(m.modelSvcCandidates, modelSvc, label || 'factory');
      if (m.modelSvcCandidates.length > 16) { m.modelSvcCandidates.length = 16; }
      m.modelSvc = modelSvc;
    } catch (eRememberModel) {}
  }
  function forgetMonacoInstCandidate(inst) {
    if (!inst) { return; }
    var m = getMonacoFactorySingleton();
    if (!m) { return; }
    try {
      if (m.inst === inst) { m.inst = null; }
      if (Array.isArray(m.instCandidates)) {
        m.instCandidates = m.instCandidates.filter(function (entry) {
          return entry && entry.inst !== inst;
        });
      }
    } catch (eForgetInst) {}
  }
  function forgetMonacoModelServiceCandidate(modelSvc) {
    if (!modelSvc) { return; }
    var m = getMonacoFactorySingleton();
    if (!m) { return; }
    try {
      if (m.modelSvc === modelSvc) { m.modelSvc = null; }
      if (Array.isArray(m.modelSvcCandidates)) {
        m.modelSvcCandidates = m.modelSvcCandidates.filter(function (entry) {
          return entry && entry.modelSvc !== modelSvc;
        });
      }
    } catch (eForgetModel) {}
  }
  function describeMonacoState() {
    var m = getMonacoFactorySingleton();
    if (!m) { return { ready: false, reason: 'none', disposed: false }; }
    if (!m.ctor) { return { ready: false, reason: 'missing-ctor', disposed: false }; }
    installMonacoFactorySingleton(m);
    var instChoice = chooseLiveInstantiationService(false, null);
    if (!instChoice) {
      var instErr = validateInstantiationService(m.inst);
      return { ready: false, reason: instErr || 'missing-inst', disposed: isDisposedText(instErr) };
    }
    rememberMonacoInstCandidate(m, instChoice.inst, instChoice.label);
    var modelChoice = chooseLiveModelService(false, null);
    if (!modelChoice) {
      var modelErr = validateModelService(m.modelSvc);
      return { ready: false, reason: modelErr || 'missing-modelSvc', disposed: isDisposedText(modelErr) };
    }
    rememberMonacoModelServiceCandidate(m, modelChoice.modelSvc, modelChoice.label);
    return { ready: true, reason: 'ready', disposed: false };
  }
  window.__ijFindMonacoStatus = function () {
    var status = describeMonacoState();
    return status.ready ? 'ready' : ('not-ready:' + status.reason);
  };
  window.__ijFindInvalidateMonaco = function (reason) {
    try { window.__ijFindMonaco = null; } catch (e) {}
    try { window.__ijFindMonacoFactory = null; } catch (eFactory) {}
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
  function collectWorkbenchMonacoEditorElements() {
    var out = [];
    var seen = [];
    function add(el) {
      if (!el) { return; }
      try {
        if (el.closest && el.closest('.ij-find-overlay')) { return; }
      } catch (eOverlay) {}
      if (seen.indexOf(el) >= 0) { return; }
      seen.push(el);
      out.push(el);
    }
    try {
      var broad = document.querySelectorAll('.monaco-editor');
      for (var i = 0; i < broad.length; i++) { add(broad[i]); }
    } catch (eBroad) {}
    try {
      var grouped = document.querySelectorAll('.editor-group-container .monaco-editor');
      for (var j = 0; j < grouped.length; j++) { add(grouped[j]); }
    } catch (eGrouped) {}
    return out;
  }
  function collectInstantiationServiceCandidates(includeDom, report) {
    var out = [];
    try {
      var m = getMonacoFactorySingleton();
      if (m) {
        if (m.editorInst) { addInstCandidate(out, m.editorInst, 'factory.editor'); }
        if (m.inst) { addInstCandidate(out, m.inst, 'factory.cached'); }
        if (Array.isArray(m.instCandidates)) {
          for (var mi = 0; mi < m.instCandidates.length; mi++) {
            var entry = m.instCandidates[mi];
            if (entry && entry.inst) {
              addInstCandidate(out, entry.inst, 'factory[' + mi + ']:' + (entry.label || 'inst'));
            }
          }
        }
      }
    } catch (eFactoryCached) {}
    if (includeDom) {
      try {
        var editors = collectWorkbenchMonacoEditorElements();
        for (var i = 0; i < editors.length; i++) {
          var widget = findMonacoWidget(editors[i]);
          addWidgetInstantiationServices(out, widget, 'dom[' + i + ']', report);
        }
      } catch (eDom) {
        if (report) { report.push('dom inst scan err: ' + errorText(eDom).slice(0, 100)); }
      }
    }
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
    try {
      var m = getMonacoFactorySingleton();
      if (m) {
        if (m.modelSvc) { addModelServiceCandidate(out, m.modelSvc, 'factory.cached'); }
        if (Array.isArray(m.modelSvcCandidates)) {
          for (var mi = 0; mi < m.modelSvcCandidates.length; mi++) {
            var entry = m.modelSvcCandidates[mi];
            if (entry && entry.modelSvc) {
              addModelServiceCandidate(out, entry.modelSvc, 'factory[' + mi + ']:' + (entry.label || 'modelSvc'));
            }
          }
        }
      }
    } catch (eFactoryCached) {}
    if (includeDom) {
      try {
        var editors = collectWorkbenchMonacoEditorElements();
        for (var i = 0; i < editors.length; i++) {
          var widget = findMonacoWidget(editors[i]);
          addWidgetModelServices(out, widget, 'dom[' + i + ']', report);
        }
      } catch (eDom) {
        if (report) { report.push('dom modelSvc scan err: ' + errorText(eDom).slice(0, 100)); }
      }
    }
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
  function chooseLiveInstantiationService(includeDom, report) {
    var instCandidates = collectInstantiationServiceCandidates(includeDom, report);
    for (var i = 0; i < instCandidates.length; i++) {
      var err = validateInstantiationService(instCandidates[i].inst);
      if (!err) { return instCandidates[i]; }
      if (isDisposedText(err)) { forgetMonacoInstCandidate(instCandidates[i].inst); }
      if (report) { report.push('SKIP inst ' + instCandidates[i].label + ': ' + err); }
    }
    return null;
  }
  function chooseLiveModelService(includeDom, report) {
    var modelCandidates = collectModelServiceCandidates(includeDom, report);
    for (var i = 0; i < modelCandidates.length; i++) {
      var err = validateModelService(modelCandidates[i].modelSvc);
      if (!err) { return modelCandidates[i]; }
      if (isDisposedText(err)) { forgetMonacoModelServiceCandidate(modelCandidates[i].modelSvc); }
      if (report) { report.push('SKIP modelSvc ' + modelCandidates[i].label + ': ' + err); }
    }
    return null;
  }

  function previewMinimapOptions() {
    return {
      enabled: !state || state.minimapEnabled !== false,
      // Injected preview editors do not always inherit the workbench's
      // minimap :hover styling chain. Keep the viewport slider visible so
      // the preview has the same scroll-position affordance as real editors.
      showSlider: 'always',
      autohide: false,
    };
  }

  function previewHoverOptions() {
    return {
      enabled: true,
      sticky: true,
      // The preview editor renders hover widgets into a body-level overflow
      // host. Give the pointer enough grace to travel from the symbol to that
      // detached hover widget instead of hiding as soon as it leaves the token.
      hidingDelay: 1200,
    };
  }

  function previewInlayHintsOptions() {
    // Disabled in #45 (the user-reported "inlay 클릭 안 됨" + "두 inlay 겹침"
    // combo). In captain, VSCode's native InlayHintsController DOES query
    // our CallGraphInlayHintsProvider and renders inline inlay spans —
    // but InlayHintLabelPart.command does NOT fire when clicked inside
    // the embed preview editor (Monaco's mouse-click pipeline behaves
    // differently for isSimpleWidget=true widgets). Result: user sees
    // both our absolute layer AND the silent native inlays, and their
    // clicks pick up the native one which dispatches nothing. Turning
    // native InlayHints off here keeps the preview to a single,
    // clickable source — our absolute callgraph layer. Trade-off: any
    // language-server param/type hints (Pylance ":int" etc.) won't show
    // in the preview pane. Hover popovers are independent and still
    // work natively.
    return {
      enabled: 'off',
    };
  }

  function createPreviewEditor(host) {
    var m = getMonacoFactorySingleton();
    if (!m || !m.ctor) { return null; }
    installMonacoFactorySingleton(m);
    var overflowHost = getOrCreatePreviewOverflowHost();
    var options = {
      automaticLayout: true,
      readOnly: false,
      minimap: previewMinimapOptions(),
      scrollBeyondLastLine: false,
      renderLineHighlight: 'all',
      fixedOverflowWidgets: true,
      overflowWidgetsDomNode: overflowHost,
      hover: previewHoverOptions(),
      inlayHints: previewInlayHintsOptions(),
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
    // isSimpleWidget=true keeps VSCode's EditorService from taking over
    // this widget on focus (it would otherwise detach the DOM and clear
    // the model — "preview goes blank on click"). The original comment
    // claimed this keeps hover/inlay/intellisense intact; #47 found that
    // claim was wrong for LSP providers like Pylance — they need
    // isSimpleWidget=false to fire hover + autocomplete in the embed.
    // Opt-in via intellijStyledSearch.previewLanguageFeatures (default
    // off so existing users don't hit the takeover regression).
    var widgetOptions = {};
    if (m.widgetOptions && typeof m.widgetOptions === 'object') {
      try {
        for (var wk in m.widgetOptions) {
          if (Object.prototype.hasOwnProperty.call(m.widgetOptions, wk)) {
            widgetOptions[wk] = m.widgetOptions[wk];
          }
        }
      } catch (eWidgetOpts) {}
    }
    widgetOptions.isSimpleWidget = !__ijFindEnablePreviewLanguageFeatures;
    var triedDirectNew = false;
    function tryDirectNew(label) {
      if (triedDirectNew) { return null; }
      triedDirectNew = true;
      try {
        var directEditor = new m.ctor(host, options, widgetOptions);
        try { m.createMode = 'new'; } catch (eModeNew) {}
        send({ type: 'log', msg: 'createPreviewEditor using direct new ' + label });
        return directEditor;
      } catch (eDirectNew) {
        send({ type: 'log', msg: 'createPreviewEditor direct new err ' + label + ': ' + errorText(eDirectNew).slice(0, 160) });
        return null;
      }
    }
    if (m.createMode === 'new') {
      var directFirst = tryDirectNew('factory.createMode');
      if (directFirst) { return directFirst; }
    }
    var insts = collectInstantiationServiceCandidates(true, null);
    for (var i = 0; i < insts.length; i++) {
      var instErr = validateInstantiationService(insts[i].inst);
      if (instErr) {
        if (isDisposedText(instErr)) { forgetMonacoInstCandidate(insts[i].inst); }
        send({ type: 'log', msg: 'createPreviewEditor skip inst ' + insts[i].label + ': ' + instErr });
        continue;
      }
      try {
        var editor = insts[i].inst.createInstance(m.ctor, host, options, widgetOptions);
        rememberMonacoInstCandidate(m, insts[i].inst, insts[i].label);
        try { m.editorInst = insts[i].inst; } catch (eEditorInst) {}
        try { m.createMode = 'createInstance'; } catch (eModeCreateInstance) {}
        var modelChoice = chooseLiveModelService(true, null);
        if (modelChoice) { rememberMonacoModelServiceCandidate(m, modelChoice.modelSvc, modelChoice.label); }
        send({ type: 'log', msg: 'createPreviewEditor using inst ' + insts[i].label });
        return editor;
      } catch (e) {
        var msg = errorText(e);
        if (isDisposedText(msg)) { forgetMonacoInstCandidate(insts[i].inst); }
        try {
          if (m.editorInst === insts[i].inst && (isDisposedText(msg) || /UNKNOWN service|Method not found/i.test(msg))) {
            m.editorInst = null;
          }
        } catch (eForgetEditorInst) {}
        send({ type: 'log', msg: 'createPreviewEditor err via ' + insts[i].label + ': ' + msg.slice(0, 160) });
        if (!triedDirectNew && /UNKNOWN service|Method not found/i.test(msg)) {
          var directAfterCreateError = tryDirectNew('after-createInstance-error');
          if (directAfterCreateError) { return directAfterCreateError; }
        }
      }
    }
    var directFallback = tryDirectNew('fallback');
    if (directFallback) { return directFallback; }
    return null;
  }
  window.__ijFindCreatePreviewEditor = createPreviewEditor;
  function createPreviewTextModel(content, languageId, uriStr, fullFile) {
    var m = getMonacoFactorySingleton();
    if (!m || !m.modelSvc) {
      var modelChoice = chooseLiveModelService(true, null);
      if (m && modelChoice) { rememberMonacoModelServiceCandidate(m, modelChoice.modelSvc, modelChoice.label); }
    }
    if (!m || !m.modelSvc) { return null; }
    var lang = languageId || 'plaintext';
    // Default: isolated model. Rapid-switch / pressure callers need to
    // create-and-throw-away models without paying LSP startup cost. We
    // upgrade to resource-bound asynchronously once the preview settles
    // (see scheduleSettledPreviewHydrate). That gives hover/intellisense
    // for the URI the user actually keeps reading without spamming LSP
    // for 64 burst-clicked previews.
    var isolated = m.modelSvc.createModel(content || '', lang);
    state.previewIsolatedModelCreates++;
    send({ type: 'log', msg: 'setPreviewContent: isolated preview model for ' + uriStr });
    return isolated;
  }

  // Borrow Monaco's URI constructor from any live model so we can build a
  // resource-bound model in the renderer without reaching for the bundled
  // monaco namespace (which Trusted Types and the bundle structure make
  // awkward to import directly).
  function getMonacoUriClassFromState() {
    try {
      var m = getMonacoFactorySingleton();
      var modelSvc = m && m.modelSvc;
      var models = modelSvc && modelSvc.getModels && modelSvc.getModels();
      if (models && models.length) {
        for (var i = 0; i < models.length; i++) {
          var uri = models[i] && models[i].uri;
          if (uri && uri.constructor) { return uri.constructor; }
        }
      }
    } catch (eFromService) {}
    try {
      var editor = state.previewMonacoEditor;
      var editorModel = editor && editor.getModel && editor.getModel();
      var editorUri = editorModel && editorModel.uri;
      if (editorUri && editorUri.constructor) { return editorUri.constructor; }
    } catch (eFromEditor) {}
    return null;
  }

  function parseMonacoUri(uriStr) {
    var URIClass = getMonacoUriClassFromState();
    if (!URIClass) { return null; }
    try { if (typeof URIClass.parse === 'function') { return URIClass.parse(uriStr); } } catch (eParse) {}
    try { return new URIClass(uriStr); } catch (eCtor) {}
    return null;
  }

  function hydrateResourcePreviewForPressureCooldown(reason) {
    state.lspPressureHydrateTimer = null;
    // Snapshot for trace: gives the next captain log a clean enter→exit pair
    // for every hydrate attempt, with the URI scheme before/after the swap.
    // The existing send({type:'log',...}) lines are filtered out of production
    // logs by send() unless __ijFindDebugRendererLogs===true, so we route
    // hydrate diagnostics through trace() (which survives in production logs
    // when rendererPerfDiagnostics is on).
    var traceEnterEditor = state.previewMonacoEditor;
    var traceEnterModel = traceEnterEditor && traceEnterEditor.getModel && traceEnterEditor.getModel();
    var traceEnterUri = '';
    var traceEnterScheme = '';
    try {
      if (traceEnterModel && traceEnterModel.uri) {
        traceEnterUri = String(traceEnterModel.uri.toString() || '');
        traceEnterScheme = String(traceEnterModel.uri.scheme || '');
      }
    } catch (eTraceEnter) {}
    var traceTargetUri = state.lastPreviewMsg && state.lastPreviewMsg.uri ? String(state.lastPreviewMsg.uri) : '';
    trace('preview/hydrate/enter', {
      reason: String(reason || ''),
      currentUri: traceEnterUri,
      currentScheme: traceEnterScheme,
      targetUri: traceTargetUri,
    });
    try {
      if (state.lspPressureUntil > Date.now()) {
        // Pressure was extended after we scheduled; reschedule for the new
        // deadline rather than hydrating mid-window.
        trace('preview/hydrate/skip', { reason: 'pressure-window-extended', until: state.lspPressureUntil });
        scheduleLspPressureHydrate();
        return;
      }
      var editor = state.previewMonacoEditor;
      var msg = state.lastPreviewMsg;
      if (!editor || !msg || !msg.uri) {
        trace('preview/hydrate/skip', { reason: 'no-editor-or-msg', hasEditor: !!editor, hasMsg: !!msg });
        return;
      }
      var existingModel = editor.getModel && editor.getModel();
      var existingUri = existingModel && existingModel.uri ? String(existingModel.uri.toString()) : '';
      if (existingUri === msg.uri) {
        trace('preview/hydrate/skip', { reason: 'already-bound', uri: existingUri });
        return;
      }
      var m = getMonacoFactorySingleton();
      if (!m || !m.modelSvc) {
        trace('preview/hydrate/skip', { reason: 'no-monaco-or-modelsvc', hasFactory: !!m });
        return;
      }
      var monacoUri = parseMonacoUri(msg.uri);
      if (!monacoUri) {
        send({ type: 'log', msg: 'lspPressure cooldown hydrate: could not construct Monaco URI for ' + msg.uri });
        trace('preview/hydrate/skip', { reason: 'parse-uri-failed', targetUri: msg.uri });
        return;
      }
      var fullText = (msg.lines || []).map(function (l) { return l.text; }).join('\\n');
      var lang = msg.languageId || 'plaintext';
      var resourceModel = null;
      var reusedModel = false;
      try {
        resourceModel = m.modelSvc.getModel && m.modelSvc.getModel(monacoUri);
      } catch (eGet) {}
      if (resourceModel) {
        reusedModel = true;
        send({ type: 'log', msg: 'lspPressure cooldown hydrate: reused existing resource model for ' + msg.uri });
      } else {
        try {
          resourceModel = m.modelSvc.createModel(fullText, lang, monacoUri, false);
        } catch (eCreate) {
          send({ type: 'log', msg: 'lspPressure cooldown hydrate create err: ' + (eCreate && eCreate.message) });
          trace('preview/hydrate/error', { stage: 'createModel', err: String(eCreate && eCreate.message || eCreate).slice(0, 160) });
          return;
        }
        if (!resourceModel) {
          trace('preview/hydrate/skip', { reason: 'createModel-returned-null' });
          return;
        }
        state.previewResourceModelCreates++;
      }
      var hydrateViewState = null;
      try { hydrateViewState = editor.saveViewState && editor.saveViewState(); } catch (eHydrateSave) {}
      try {
        editor.setModel(resourceModel);
        if (hydrateViewState) {
          try { editor.restoreViewState && editor.restoreViewState(hydrateViewState); } catch (eHydrateRestore) {}
        }
        if (existingModel && existingModel !== resourceModel && existingModel.dispose) {
          try { existingModel.dispose(); state.previewOwnedModelDisposes++; } catch (eDispose) {}
        }
        send({ type: 'log', msg: 'lspPressure cooldown hydrate: swapped to resource model for ' + msg.uri + ' (' + (reason || '') + ')' });
        var newScheme = '';
        try {
          var nm = editor.getModel && editor.getModel();
          if (nm && nm.uri) { newScheme = String(nm.uri.scheme || ''); }
        } catch (eNewScheme) {}
        // Mark hydrated. We previously also cleared the absolute callgraph
        // layer here (#33) under the assumption that VSCode's native
        // InlayHintsController would take over via our registered
        // CallGraphInlayHintsProvider. E2E "native InlayHint click in
        // embed preview" proved otherwise: the controller does NOT query
        // our provider for the embed editor — so dropping our layer leaves
        // the user with nothing to click. #44 revert: keep the absolute
        // layer alive post-hydrate. The captain "두 inlay 겹쳐 보임"
        // complaint that motivated #33 turns out to be our callgraph
        // overlay coexisting with Pylance's native parameter/type hints,
        // which is intentional — they're different information.
        state.previewHydrated = true;
        // The setModel above swapped the editor onto a fresh model, so the
        // findMatch decorations applied earlier (during
        // renderPreviewMonacoReal) have been dropped on the OLD model.
        // Rebuild them on the new model so the user-visible yellow highlight
        // survives the 250ms hydrate transition.
        var matchDecorsReapplied = false;
        try {
          if (msg) {
            // Old IDs belonged to the previous model; forget them so
            // applyPreviewMatchDecorations doesn't waste a deltaDecorations
            // call clearing IDs that don't apply to the new model.
            state.previewMonacoMatchDecos = null;
            applyPreviewMatchDecorations(editor, msg);
            matchDecorsReapplied = true;
          }
        } catch (eReapplyDecos) {
          send({ type: 'log', msg: 'hydrate reapply match decos err: ' + (eReapplyDecos && eReapplyDecos.message) });
        }
        trace('preview/hydrate/success', {
          reason: String(reason || ''),
          uri: msg.uri,
          newScheme: newScheme,
          reusedModel: reusedModel,
          // clearedAbsoluteCallGraphLayer was retired in #44 revert. The
          // field is kept emitting false so older log readers don't break.
          clearedAbsoluteCallGraphLayer: false,
          matchDecorsReapplied: matchDecorsReapplied,
          intellisense: gatherEmbedEditorIntellisenseSnapshot(editor),
        });
        // #47 auto-probe at a KNOWN meaningful position: the search
        // match's start column on focusLine. col=0 (line start) gives
        // word-based fallback completions and 0 hovers (no symbol
        // there); the match column actually sits on a symbol token so
        // Pylance's intelligent providers should respond if they're
        // bound to this URI. Dedupe is host-side per (uri, line, col).
        try {
          var probeLine0 = -1;
          var probeCol0 = -1;
          if (msg && typeof msg.focusLine === 'number') {
            probeLine0 = Math.max(0, msg.focusLine);
            if (Array.isArray(msg.ranges) && msg.ranges.length > 0 && typeof msg.ranges[0].start === 'number') {
              probeCol0 = Math.max(0, msg.ranges[0].start);
            } else {
              probeCol0 = 0;
            }
          }
          if (probeLine0 >= 0 && probeCol0 >= 0 && msg && msg.uri) {
            send({
              type: 'requestIntellisenseProbe',
              uri: String(msg.uri),
              line: probeLine0,
              column: probeCol0,
              source: 'hydrate-success-match-pos',
            });
          }
        } catch (eAutoProbe) {}
      } catch (eSet) {
        send({ type: 'log', msg: 'lspPressure cooldown hydrate setModel err: ' + (eSet && eSet.message) });
        trace('preview/hydrate/error', { stage: 'setModel', err: String(eSet && eSet.message || eSet).slice(0, 160) });
      }
    } catch (eOuter) {
      send({ type: 'log', msg: 'lspPressure cooldown hydrate threw: ' + (eOuter && eOuter.message) });
      trace('preview/hydrate/error', { stage: 'outer', err: String(eOuter && eOuter.message || eOuter).slice(0, 160) });
    }
  }

  function scheduleLspPressureHydrate() {
    if (state.lspPressureHydrateTimer) {
      clearTimeout(state.lspPressureHydrateTimer);
      state.lspPressureHydrateTimer = null;
    }
    var delay = Math.max(0, (state.lspPressureUntil || 0) - Date.now()) + 50;
    state.lspPressureHydrateTimer = setTimeout(function () {
      hydrateResourcePreviewForPressureCooldown('cooldown-timer');
    }, delay);
  }

  // When the user lands on a preview and stops switching for SETTLE_MS, we
  // upgrade the isolated model to a resource-bound model so hover /
  // intellisense / go-to-definition work on the file they're actually
  // reading. Rapid burst-clicks reset the timer, so we never create 64
  // resource models for 64 transient previews.
  var PREVIEW_SETTLE_HYDRATE_DELAY_MS = 250;
  function scheduleSettledPreviewHydrate() {
    var hadPrior = !!state.lspPressureHydrateTimer;
    if (state.lspPressureHydrateTimer) {
      clearTimeout(state.lspPressureHydrateTimer);
      state.lspPressureHydrateTimer = null;
    }
    var lastUri = state.lastPreviewMsg && state.lastPreviewMsg.uri ? String(state.lastPreviewMsg.uri) : '';
    trace('preview/hydrate/schedule', {
      delayMs: PREVIEW_SETTLE_HYDRATE_DELAY_MS,
      replacedPriorTimer: hadPrior,
      lastUri: lastUri,
    });
    state.lspPressureHydrateTimer = setTimeout(function () {
      hydrateResourcePreviewForPressureCooldown('settle-timer');
    }, PREVIEW_SETTLE_HYDRATE_DELAY_MS);
  }

  function setPreviewContent(editor, content, languageId, uriStr, fullFile) {
    var m = getMonacoFactorySingleton();
    if (!m || !editor) { return false; }
    if (!m.modelSvc || validateModelService(m.modelSvc)) {
      var modelChoice = chooseLiveModelService(true, null);
      if (modelChoice) { rememberMonacoModelServiceCandidate(m, modelChoice.modelSvc, modelChoice.label); }
    }
    if (!m.modelSvc || validateModelService(m.modelSvc)) { return false; }
    try {
      var old = editor.getModel && editor.getModel();
      var model = createPreviewTextModel(content, languageId, uriStr, !!fullFile);
      if (!model) { return false; }
      editor.setModel(model);
      if (old && old.dispose && old !== model) {
        // Only dispose models we own (isolated, scheme=inmemory). A
        // resource-bound model (scheme=file) is shared with the workbench
        // editor and other VS Code subsystems — disposing it tears down
        // the open editor for that file. Leave file:// models alone.
        var oldScheme = '';
        try { oldScheme = old.uri && old.uri.scheme ? String(old.uri.scheme) : ''; } catch (eScheme) {}
        if (oldScheme === 'inmemory' || oldScheme === '') {
          try {
            old.dispose();
            state.previewOwnedModelDisposes++;
          } catch (e) {}
        }
      }
      return true;
    } catch (e) {
      var msg = errorText(e);
      if (isDisposedText(msg)) {
        forgetMonacoModelServiceCandidate(m.modelSvc);
      }
      send({ type: 'log', msg: 'setPreviewContent err: ' + msg });
      return false;
    }
  }
  window.__ijFindSetPreviewContent = setPreviewContent;

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

  function isEditorWidgetLike(v) {
    try {
      return !!(v && typeof v === 'object' &&
        typeof v.layout === 'function' &&
        typeof v.getModel === 'function' &&
        typeof v.getDomNode === 'function');
    } catch (e) { return false; }
  }

  function addServiceEditorWidget(capsForService, widget, src, report) {
    if (!capsForService || !isEditorWidgetLike(widget)) { return false; }
    try {
      for (var i = 0; capsForService.widgets && i < capsForService.widgets.length; i++) {
        if (capsForService.widgets[i].v === widget) { return false; }
      }
      if (capsForService.widgets.length < 50) {
        capsForService.widgets.push({ v: widget, src: src, key: 'service' });
      }
      var ctor = widget.constructor;
      if (ctor && capsForService.widgetCtors.indexOf(ctor) < 0 && capsForService.widgetCtors.length < 20) {
        capsForService.widgetCtors.push(ctor);
      }
      if (report) { report.push('service editor widget via ' + src); }
      return true;
    } catch (e) {
      if (report) { report.push('service editor widget err ' + src + ': ' + errorText(e).slice(0, 80)); }
      return false;
    }
  }

  function promoteCapturedEditorServiceWidgets(capsForService, report) {
    if (!capsForService || !capsForService.services) { return 0; }
    var added = 0;
    var codeEditorServices = 0;
    for (var si = 0; si < capsForService.services.length; si++) {
      var entry = capsForService.services[si];
      if (!entry || entry.kind !== 'ICodeEditorService' || !entry.v) { continue; }
      codeEditorServices++;
      var svc = entry.v;
      try {
        if (typeof svc.getActiveCodeEditor === 'function') {
          if (addServiceEditorWidget(capsForService, svc.getActiveCodeEditor(), 'ICodeEditorService.getActiveCodeEditor', report)) {
            added++;
          }
        }
      } catch (eActiveEditor) {
        if (report) { report.push('getActiveCodeEditor err: ' + errorText(eActiveEditor).slice(0, 80)); }
      }
      try {
        if (typeof svc.getFocusedCodeEditor === 'function') {
          if (addServiceEditorWidget(capsForService, svc.getFocusedCodeEditor(), 'ICodeEditorService.getFocusedCodeEditor', report)) {
            added++;
          }
        }
      } catch (eFocusedEditor) {
        if (report) { report.push('getFocusedCodeEditor err: ' + errorText(eFocusedEditor).slice(0, 80)); }
      }
      try {
        if (typeof svc.listCodeEditors === 'function') {
          var editors = svc.listCodeEditors() || [];
          for (var ei = 0; ei < editors.length; ei++) {
            if (addServiceEditorWidget(capsForService, editors[ei], 'ICodeEditorService.listCodeEditors[' + ei + ']', report)) {
              added++;
            }
          }
        }
      } catch (eListEditors) {
        if (report) { report.push('listCodeEditors err: ' + errorText(eListEditors).slice(0, 80)); }
      }
    }
    if (report) { report.push('codeEditorServices=' + codeEditorServices + ' promotedWidgets=' + added); }
    return added;
  }

  window.__ijFindTestCreateWidget = function () {
    // Fast path: if a previous run already captured the real class + services,
    // don't recreate anything — we'd just burn a boot-time stub slot. Renderer
    // globals survive extension-host restarts, so this hits on warm reloads.
    try {
      var existing = getMonacoFactorySingleton();
      if (existing && existing.ctor && window.__ijFindMonacoStatus && window.__ijFindMonacoStatus() === 'ready') {
        installMonacoFactorySingleton(existing);
        return 'monaco-already-captured ctor=' + (existing.ctor.name || '?');
      }
    } catch (e) {}
    var caps = window.__ijFindCaptures;
    if (!caps || !caps.services || caps.services.length === 0) {
      return 'no-services-captured';
    }
    var report = [];
    promoteCapturedEditorServiceWidgets(caps, report);

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
    var winnerCreateMode = '';
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
              mode: 'createInstance',
              widgetOptions: entry.value,
            });
            attempts.push({
              fn: function (C) { return new C(host, testOptions, entry.value); },
              label: 'new(host,opts,' + entry.label + ')',
              mode: 'new',
              widgetOptions: entry.value,
            });
          })(widgetOptionCandidates[wo], inst);
        }
        (function (instForAttempt) {
          attempts.push({ fn: function (C) { return instForAttempt.createInstance(C, host, testOptions); }, label: 'createInstance(host,opts)', mode: 'createInstance', widgetOptions: null });
          attempts.push({ fn: function (C) { return new C(host, testOptions); }, label: 'new(host,opts)', mode: 'new', widgetOptions: null });
        })(inst);
        for (var aa = 0; aa < attempts.length && !createdEditor; aa++) {
          try {
            var ed = attempts[aa].fn(Ctor);
            if (ed && typeof ed === 'object') {
              createdEditor = ed;
              winnerInst = inst;
              winnerWidgetOptions = attempts[aa].widgetOptions;
              winnerCreateMode = attempts[aa].mode || '';
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
    var monacoFactory = installMonacoFactorySingleton({
      ctor: winnerCtor,
      inst: winnerInst,
      editorInst: winnerInst,
      createMode: winnerCreateMode,
      modelSvc: null, // filled below
      widgetOptions: winnerWidgetOptions || { isSimpleWidget: false },
      instCandidates: [],
      modelSvcCandidates: [],
    });
    rememberMonacoInstCandidate(monacoFactory, winnerInst, 'winner');
    for (var ic = 0; ic < instCandidates.length; ic++) {
      rememberMonacoInstCandidate(monacoFactory, instCandidates[ic].inst, instCandidates[ic].label);
    }
    try { monacoFactory.inst = winnerInst; } catch (eWinnerInst) {}
    try { monacoFactory.editorInst = winnerInst; } catch (eWinnerEditorInst) {}
    try { monacoFactory.createMode = winnerCreateMode; } catch (eWinnerCreateMode) {}

    // ── Post-create: force proper rendering ───────────────────────────
    // Widget was constructed, but content likely isn't rendered because the
    // implicit \`value\` option didn't seed a model in this context. Use the
    // captured IModelService to create a real TextModel and assign it, then
    // explicitly call layout() with the host's size.
    var modelChoice = chooseLiveModelService(true, report);
    var modelSvc = modelChoice && modelChoice.modelSvc;
    if (modelChoice) {
      rememberMonacoModelServiceCandidate(monacoFactory, modelChoice.modelSvc, modelChoice.label);
      report.push('using modelSvc ' + modelChoice.label);
    }
    var collectedModelSvcs = collectModelServiceCandidates(true, report);
    for (var mc = 0; mc < collectedModelSvcs.length; mc++) {
      rememberMonacoModelServiceCandidate(monacoFactory, collectedModelSvcs[mc].modelSvc, collectedModelSvcs[mc].label);
    }
    if (modelChoice) { try { monacoFactory.modelSvc = modelChoice.modelSvc; } catch (eWinnerModel) {} }
    modelSvc = monacoFactory.modelSvc;
    report.push('IModelService found=' + !!modelSvc);

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
  function markSearchUiRoot(node) {
    try {
      node.setAttribute('data-ijss-root', 'true');
      node.setAttribute('data-intellisense-recursion-ignore', 'true');
      node.setAttribute('data-ir-ignore', 'true');
    } catch (e) {}
    return node;
  }
  function getSearchUiMountRoot() {
    try {
      return document.querySelector('.monaco-workbench') ||
        document.querySelector('.workbench') ||
        document.body;
    } catch (eMountRoot) {
      return document.body;
    }
  }
  function ensureSearchUiMounted(node) {
    try {
      var root = getSearchUiMountRoot();
      if (node.parentElement !== root) { root.appendChild(node); }
      return root;
    } catch (eMount) {
      try { if (node.parentElement !== document.body) { document.body.appendChild(node); } } catch (eBodyMount) {}
      return document.body;
    }
  }
  // Legacy DIY hover tooltip was removed in #32 — VSCode's native Monaco
  // hover handles all hover content now (#33 made the embed editor reuse
  // the workbench hover service). Both helpers below are kept as stubs so
  // any straggler references in the source compile, but they are no-ops.
  function isDomPreviewHoverEnabled() { return false; }

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
    '  box-shadow: none;',
    '  z-index: 10000;',
    '  display: none; flex-direction: column;',
    '  font-family: var(--vscode-font-family, system-ui, -apple-system, sans-serif);',
    '  font-size: var(--vscode-font-size, 13px);',
    '  overflow: hidden;',
    '  contain: layout paint;',
    '  isolation: isolate;',
    '}',
    '.ij-find-overlay.visible { display: flex; }',
    '.ij-find-overlay.ij-find-focused {',
    '  border-color: var(--vscode-focusBorder, var(--vscode-widget-border, #007acc));',
    '}',
    '.ij-find-overlay.ij-find-minimized {',
    '  min-width: 240px !important;',
    '  min-height: 0 !important;',
    '  width: min(320px, calc(100vw - 16px)) !important;',
    '  height: 30px !important;',
    '  max-width: calc(100vw - 16px) !important;',
    '  max-height: 30px !important;',
    '  overflow: hidden !important;',
    '}',
    '.ij-find-overlay.ij-find-minimized .ij-find-header {',
    '  min-height: 30px;',
    '  padding: 3px 8px;',
    '  border-bottom: none;',
    '}',
    '.ij-find-overlay.ij-find-minimized .ij-find-title,',
    '.ij-find-overlay.ij-find-minimized .ij-find-summary {',
    '  white-space: nowrap;',
    '  overflow: hidden;',
    '  text-overflow: ellipsis;',
    '}',
    '.ij-find-overlay.ij-find-minimized .ij-find-toolbar,',
    '.ij-find-overlay.ij-find-minimized .ij-find-results,',
    '.ij-find-overlay.ij-find-minimized .ij-find-splitter,',
    '.ij-find-overlay.ij-find-minimized .ij-find-preview,',
    '.ij-find-overlay.ij-find-minimized .ij-find-resizer {',
    '  display: none !important;',
    '}',
    '.ij-find-overlay.ij-find-detached {',
    '  box-shadow: 0 8px 24px rgba(0,0,0,0.28);',
    '}',
    '.ij-find-overlay.ij-find-detached .ij-find-preview-body.ij-find-detached-preview-snapshot {',
    '  padding: 4px 0;',
    '  overflow: auto;',
    '  font-family: var(--vscode-editor-font-family, monospace);',
    '  font-size: 12px;',
    '  line-height: 18px;',
    '  color: var(--vscode-editor-foreground, #d4d4d4);',
    '  scrollbar-gutter: stable both-edges;',
    '  user-select: text;',
    '}',
    '.ij-find-overlay.ij-find-detached .ij-find-preview-body.ij-find-detached-preview-snapshot * {',
    '  user-select: text;',
    '}',
    '.ij-find-overlay.ij-find-detached .ij-find-preview-body.ij-find-detached-preview-snapshot .ij-find-preview-lineno {',
    '  user-select: none;',
    '}',
    '.ij-find-overlay.ij-find-detached .ij-find-query,',
    '.ij-find-overlay.ij-find-detached .ij-find-scope {',
    '  cursor: default;',
    '}',
    '.ij-find-overlay.ij-find-detached .ij-find-opt,',
    '.ij-find-overlay.ij-find-detached .ij-find-refresh,',
    '.ij-find-overlay.ij-find-detached .ij-find-history,',
    '.ij-find-overlay.ij-find-detached .ij-find-minimap-toggle {',
    '  pointer-events: none !important;',
    '  opacity: 0.62;',
    '}',
    '.ij-find-overlay.ij-find-shell {',
    '  height: auto;',
    '  min-height: 0;',
    '  max-height: calc(100vh - 100px);',
    '}',
    '.ij-find-overlay.ij-find-shell .ij-find-results,',
    '.ij-find-overlay.ij-find-shell .ij-find-splitter,',
    '.ij-find-overlay.ij-find-shell .ij-find-preview {',
    '  display: none;',
    '}',
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
    '.ij-find-minimize,',
    '.ij-find-close {',
    '  background: transparent; border: none; color: inherit;',
    '  cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 8px;',
    '  min-width: 24px; height: 22px;',
    '  border-radius: 3px;',
    '}',
    '.ij-find-close { font-size: 16px; }',
    '.ij-find-minimize:hover,',
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
    '  z-index: 10005;',
    '  background: var(--vscode-editorWidget-background, #252526);',
    '  color: var(--vscode-foreground, #cccccc);',
    '  border: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, #454545));',
    '  border-radius: 3px;',
    '  box-shadow: none;',
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
    '  contain: layout paint;',
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
    '.ij-find-row-actions {',
    '  flex: 0 0 auto;',
    '  display: flex; align-items: center; gap: 3px;',
    '  opacity: 0.72;',
    '}',
    '.ij-find-row:hover .ij-find-row-actions,',
    '.ij-find-row.active .ij-find-row-actions,',
    '.ij-find-row:focus-within .ij-find-row-actions { opacity: 1; }',
    '.ij-find-row-action {',
    '  height: 18px;',
    '  min-width: 48px;',
    '  padding: 0 6px;',
    '  border: 1px solid transparent;',
    '  border-radius: 3px;',
    '  background: transparent;',
    '  color: inherit;',
    '  font: 11px var(--vscode-font-family, system-ui);',
    '  line-height: 16px;',
    '  cursor: pointer;',
    '}',
    '.ij-find-row-action:hover, .ij-find-row-action:focus {',
    '  background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08));',
    '  border-color: var(--vscode-focusBorder, var(--vscode-widget-border, #555));',
    '  outline: none;',
    '}',
    // Orange highlight palette so search matches stay consistent across themes.
    '.ij-find-hl {',
    '  background: rgba(255, 139, 26, 0.50);',
    '  color: var(--vscode-editor-findMatchHighlightForeground, var(--vscode-foreground, inherit));',
    '  border-radius: 2px;',
    '  box-shadow: inset 0 0 0 1px rgba(255, 166, 48, 0.72);',
    '}',
    '.ij-find-row.active .ij-find-hl {',
    '  background: rgba(255, 125, 0, 0.76);',
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
    '  contain: layout paint;',
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
	    '.ij-find-preview-truncated {',
	    '  padding: 2px 10px;',
	    '  color: var(--vscode-descriptionForeground, #9d9d9d);',
	    '  font-style: italic;',
	    '}',
    // When a stolen monaco editor is mounted in this body, keep our own
    // padding / typography rules from bleeding into it. Nothing is forced
    // on the .monaco-editor child — we size it via inline style in JS.
    '.ij-find-preview-body.ij-find-editor-mounted,',
    '.ij-find-preview-body.ij-find-stolen {',
    '  padding: 0;',
    '  overflow: hidden;',
    '  font-family: unset;',
    '  font-size: unset;',
    '  line-height: unset;',
    '  color: unset;',
    '  scrollbar-gutter: auto;',
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
    '.ij-find-preview-inlay {',
    '  flex: 0 0 auto;',
    '  display: inline-flex; align-items: center;',
    '  margin-left: 12px; padding: 0 4px;',
    '  border-radius: 3px;',
    '  color: var(--vscode-editorInlayHint-foreground, var(--vscode-descriptionForeground, #9d9d9d));',
    '  background: var(--vscode-editorInlayHint-background, transparent);',
    '  cursor: pointer;',
    '  user-select: none;',
    '}',
    '.ij-find-preview-inlay:hover {',
    '  color: var(--vscode-editorLink-activeForeground, var(--vscode-textLink-activeForeground, #4daafc));',
    '  background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08));',
    '}',
    '.ij-find-preview-monaco-inlay-layer {',
    '  position: absolute; inset: 0; pointer-events: none; z-index: 20;',
    '  overflow: hidden;',
    '}',
    '.ij-find-preview-monaco-inlay-layer .ij-find-preview-inlay {',
    '  position: absolute; margin-left: 0; height: 18px; line-height: 18px;',
    '  pointer-events: auto; white-space: nowrap;',
    '}',
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
    // The minimap slider uses VS Code theme variables without fallbacks.
    // Our preview editor is mounted under an injected body-level overlay,
    // so provide scoped fallbacks and force the slider above the minimap
    // canvases. This makes the viewport thumb visible in preview just like
    // in normal editor groups.
    '.ij-find-monaco-host .monaco-editor .minimap,',
    '.ij-find-monaco-preview-host .monaco-editor .minimap {',
    '  z-index: 20 !important;',
    '}',
    '.ij-find-monaco-host .monaco-editor .minimap .minimap-slider,',
    '.ij-find-monaco-preview-host .monaco-editor .minimap .minimap-slider {',
    '  opacity: 1 !important;',
    '  z-index: 30 !important;',
    '  pointer-events: auto !important;',
    '}',
    '.ij-find-monaco-host .monaco-editor .minimap-slider .minimap-slider-horizontal,',
    '.ij-find-monaco-preview-host .monaco-editor .minimap-slider .minimap-slider-horizontal {',
    '  background: var(--vscode-minimapSlider-background, var(--vscode-scrollbarSlider-background, rgba(121,121,121,0.45))) !important;',
    '}',
    '.ij-find-monaco-host .monaco-editor .minimap-slider:hover .minimap-slider-horizontal,',
    '.ij-find-monaco-preview-host .monaco-editor .minimap-slider:hover .minimap-slider-horizontal,',
    '.ij-find-monaco-host .monaco-editor .minimap:hover .minimap-slider-horizontal,',
    '.ij-find-monaco-preview-host .monaco-editor .minimap:hover .minimap-slider-horizontal {',
    '  background: var(--vscode-minimapSlider-hoverBackground, var(--vscode-scrollbarSlider-hoverBackground, rgba(100,100,100,0.75))) !important;',
    '}',
    '.ij-find-monaco-host .monaco-editor .minimap-slider.active .minimap-slider-horizontal,',
    '.ij-find-monaco-preview-host .monaco-editor .minimap-slider.active .minimap-slider-horizontal {',
    '  background: var(--vscode-minimapSlider-activeBackground, var(--vscode-scrollbarSlider-activeBackground, rgba(191,191,191,0.65))) !important;',
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
    '  z-index: 10020;',
    '  padding: 8px 12px;',
    '  background: var(--vscode-editorHoverWidget-background, #252526);',
    '  color: var(--vscode-editorHoverWidget-foreground, #cccccc);',
    '  border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-widget-border, #454545));',
    '  border-radius: 4px;',
    '  box-shadow: none;',
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
    // variables not resolving the same way), so we ship our own orange rule.
    '.ij-find-preview-match {',
    '  background-color: rgba(255, 139, 26, 0.42) !important;',
    '  box-sizing: border-box;',
    '}',
    '.ij-find-preview-match-active {',
    '  background-color: rgba(255, 125, 0, 0.70) !important;',
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
    '  z-index: 10020 !important;',
    '  pointer-events: none !important;',
    '}',
    '.ij-find-preview-overflow * {',
    '  z-index: 10021 !important;',
    '}',
    '.ij-find-preview-overflow .monaco-hover,',
    '.ij-find-preview-overflow .monaco-hover *,',
    '.ij-find-preview-overflow .suggest-widget,',
    '.ij-find-preview-overflow .suggest-widget *,',
    '.ij-find-preview-overflow .parameter-hints-widget,',
    '.ij-find-preview-overflow .parameter-hints-widget *,',
    '.ij-find-preview-overflow .monaco-menu,',
    '.ij-find-preview-overflow .monaco-menu *,',
    '.ij-find-preview-overflow .context-view,',
    '.ij-find-preview-overflow .context-view * {',
    '  pointer-events: auto !important;',
    '}',
  ].join('\\n');
  document.head.appendChild(style);

  var $title = el('span', { className: 'ij-find-title', text: 'Find in Files' });
  var $summary = el('span', { className: 'ij-find-summary', text: '' });
  var $minimize = el('button', { className: 'ij-find-minimize', title: 'Minimize panel', text: '\\u2212', attrs: { type: 'button', 'aria-label': 'Minimize panel', 'aria-pressed': 'false' } });
  var $close = el('button', { className: 'ij-find-close', title: 'Close (Esc)', text: '\\u00D7' });
  var $header = el('div', { className: 'ij-find-header', children: [$title, $summary, $minimize, $close] });

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
  var $optCase = el('button', { className: 'ij-find-opt', title: 'Case Sensitive (Alt+C)', text: 'aA', attrs: { 'data-opt': 'caseSensitive', 'aria-pressed': 'false' } });
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
  markSearchUiRoot(panel);
  try { panel.setAttribute('data-ij-find-src', __ijFindInstanceId); } catch (ePanelSrcAttr) {}
  wireSearchPanelFocus(panel);

  // $hoverTooltip element (DIY hover) removed in #32 — Monaco's native
  // hover infra handles all hover UX through our preview editor now.

  // When the preview pane is resized (panel corner drag or splitter), relayout
  // any stolen Monaco editor so it re-fits the available area.
  try {
    var previewResizeObserver = trackObserver(new ResizeObserver(function () {
      if (state && state.stolenEditor) { layoutStolenEditor(); }
    }));
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
    activePreviewSeq: 0,
    previewUri: '',
    previewLanguageId: '',
    previewBaseLine: 0,
    previewFullFile: true,
    hoverReqId: 0,
    hoverTimer: null,
    lastHoverKey: '',
    monacoEditor: null,        // monaco.editor.IStandaloneCodeEditor
    monacoHost: null,          // div hosting the editor
    monacoChangeListener: null,
    minimapEnabled: true,      // persisted via $minimapToggle; every new preview editor honours it
    minimized: false,
    minimizedLayout: null,
    searchStartTs: 0,          // ms timestamp when results:start arrived; feeds the elapsed-time counter
    searchTicker: null,        // setInterval handle refreshing the status with live elapsed time
    previewMode: '',           // 'monaco' | 'stolen' | 'dom'
    lastPreviewMsg: null,
    // True once the settle hydrate has upgraded the preview model to a
    // file://-bound resource model. At that point VSCode's
    // InlayHintsController starts driving inlays via our registered
    // CallGraphInlayHintsProvider, so our own absolutely-positioned
    // callgraph layer must step aside — otherwise the same hints render
    // twice on the same line. Reset to false on every new-URI preview
    // render so the immediate inlay paint still uses our fast path.
    previewHydrated: false,
    previewRecoveryTimer: null,
    previewResourceModelCreates: 0,
    previewIsolatedModelCreates: 0,
    previewOwnedModelDisposes: 0,
    lspPressureUntil: 0,
    lspPressureReason: '',
    lspPressureHydrateTimer: null,
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
    lastRenderedPreviewUri: '',
    lastRenderedPreviewFocusLine: -1,
    previewMonacoInlayLayer: null,
    previewMonacoInlayDisposers: [],
    previewMonacoSaveEditor: null,
    previewMonacoKeydownListener: null,
    previewMonacoDiagDisposers: [],
    previewMonacoDiagObserver: null,
    previewMonacoHealObserver: null,
    previewMonacoHealPending: false,
    previewMonacoHealRecursion: 0,
    previewMonacoHealLastAt: 0,
    resultsInfoText: '',
    rgScope: '',
	    searchHistory: [],
	    searchHistoryLimit: 100,
		  matchCount: 0,
		  recoveryUntil: 0,
		};
  function irLightStatus() {
    var out = {};
    try {
      out.patchVersion = window.__irPatchVersion || null;
      out.captureActive = !!window.__irCaptureActive;
      out.captureSessionId = typeof window.__irCaptureSessionId === 'number' ? window.__irCaptureSessionId : null;
      out.hasStopCapture = typeof window.__irStopCapture === 'function';
      out.scanTimer = !!window.__irScanTimer;
      out.scanInterval = !!window.__irScanInterval;
      out.markdownObserver = !!window.__irMarkdownObserver;
      out.recaptureScheduled = !!window.__irRecaptureScheduled;
      out.mdRenderer = !!window.__irMdRenderer;
      out.monaco = !!window.__irMonaco;
      out.monacoCaps = !!window.__irMonacoCaps;
      out.ijssCaptureSuspended = !!window.__ijFindIrCaptureSuspended;
      out.ijssCaptureGuarded = !!(window.__irStartCapture && window.__irStartCapture.__ijssGuarded);
    } catch (e) {
      out.error = String(e && e.message || e).slice(0, 160);
    }
    return out;
  }
  function lightStatusObject() {
    var out = {
      patchVersion: window.__ijFindPatchVersion || null,
      disposed: !!__ijFindDisposed,
      panelVisible: false,
      panelInDom: false,
      files: 0,
      flat: 0,
      candidates: 0,
      matchCount: 0,
      searching: false,
      loadingMore: false,
      hasMoreResults: false,
      activeIndex: -1,
      minimized: false,
      previewMode: '',
      previewUri: '',
      hasDebounce: false,
      hasTicker: false,
      hasHoverTimer: false,
      monacoProbeDisabled: !!window.__ijFindDisableMonacoProbes,
      rendererInlayClickHook: !!window.__ijFindEnableRendererInlayClickHook,
      disposeOnHide: !!window.__ijFindDisposeRendererPatchOnHide
    };
    try {
      out.panelVisible = !!(panel && panel.classList && panel.classList.contains('visible'));
      out.panelInDom = !!(panel && panel.parentElement);
    } catch (ePanel) {}
    try {
      out.files = state.files ? state.files.length : 0;
      out.flat = state.flat ? state.flat.length : 0;
      out.candidates = state.candidates ? state.candidates.length : 0;
      out.matchCount = state.matchCount || 0;
      out.searching = !!state.searching;
      out.loadingMore = !!state.loadingMore;
      out.hasMoreResults = !!state.hasMoreResults;
      out.activeIndex = typeof state.activeIndex === 'number' ? state.activeIndex : -1;
      out.minimized = !!state.minimized;
      out.previewMode = state.previewMode || '';
      out.previewUri = state.previewUri || '';
      out.hasDebounce = !!state.debounce;
      out.hasTicker = !!state.searchTicker;
      out.hasHoverTimer = !!state.hoverTimer;
    } catch (eState) {
      out.stateError = String(eState && eState.message || eState).slice(0, 160);
    }
    return out;
  }
  window.__ijFindLightStatus = lightStatusObject;
  function trace(phase, data) {
    try {
      if (!isRendererDiagnosticsEnabled()) { return; }
      send({
        type: 'trace',
        phase: String(phase || ''),
        perf: Math.round((performance && performance.now ? performance.now() : 0)),
        data: data || {},
        light: lightStatusObject(),
        ir: irLightStatus(),
      });
    } catch (eTrace) {}
  }
  function perfNow() {
    try { return performance && performance.now ? performance.now() : Date.now(); }
    catch (ePerfNow) { return Date.now(); }
  }
  function perfMemorySnapshot() {
    try {
      var mem = performance && performance.memory;
      if (!mem) { return null; }
      return {
        used: Math.round(mem.usedJSHeapSize || 0),
        total: Math.round(mem.totalJSHeapSize || 0),
        limit: Math.round(mem.jsHeapSizeLimit || 0),
      };
    } catch (eMem) {
      return null;
    }
  }
  function perfDomSnapshot() {
    try {
      return {
        monacoHovers: document.querySelectorAll('.monaco-hover,.monaco-editor-hover').length,
        renderedMarkdown: document.querySelectorAll('.rendered-markdown').length,
        tokenizedSources: document.querySelectorAll('.monaco-tokenized-source').length,
        ijRoots: document.querySelectorAll('[data-ijss-root="true"]').length,
        visiblePanel: isPanelVisibleForPerf(),
        activeTag: document.activeElement && document.activeElement.tagName ? document.activeElement.tagName : '',
        activeClass: document.activeElement && document.activeElement.className ? String(document.activeElement.className).slice(0, 120) : '',
      };
    } catch (eDom) {
      return { error: String(eDom && eDom.message || eDom).slice(0, 120) };
    }
  }
  function eventDelayMs(evt) {
    try {
      if (!evt || typeof evt.timeStamp !== 'number') { return null; }
      var nowPerf = perfNow();
      var ts = evt.timeStamp;
      // DOMHighResTimeStamp is relative to navigationStart; old epoch-based
      // events are relative to Date.now().
      var delay = ts > 1000000000 ? (Date.now() - ts) : (nowPerf - ts);
      if (!isFinite(delay)) { return null; }
      return Math.max(0, Math.round(delay));
    } catch (eDelay) { return null; }
  }
  function compactEventTarget(target) {
    try {
      if (!target || !target.tagName) { return { tag: '', inPanel: false, role: '' }; }
      var cls = typeof target.className === 'string' ? target.className : '';
      var role = '';
      if (target === $q) { role = 'query'; }
      else if (target === $scope) { role = 'scope'; }
      else if (target === $refresh) { role = 'run'; }
      else if (target === $close) { role = 'close'; }
      return {
        tag: String(target.tagName || '').toLowerCase(),
        id: target.id ? String(target.id).slice(0, 60) : '',
        cls: cls ? cls.slice(0, 100) : '',
        role: role,
        inPanel: !!(panel && panel.contains && panel.contains(target)),
      };
    } catch (eTarget) {
      return { tag: 'err', inPanel: false, role: '' };
    }
  }
  var __ijPanelDiag = {
    active: false,
    reason: '',
    startedAt: 0,
    lastFrameAt: 0,
    rafId: 0,
    flushTimer: 0,
    removeListeners: [],
    frameGaps: [],
    slowFrames: [],
    events: [],
    eventTimings: [],
    longTasks: [],
    longAnimationFrames: [],
    marks: [],
    framesTotal: 0,
    maxGapMs: 0,
    flushSeq: 0,
    lastHealthyFlushAt: 0,
  };
  function diagPush(listName, item, limit) {
    try {
      var list = __ijPanelDiag[listName];
      if (!Array.isArray(list)) { return; }
      list.push(item);
      var max = typeof limit === 'number' ? limit : 240;
      if (list.length > max) { list.splice(0, list.length - max); }
    } catch (ePush) {}
  }
  function panelDiagMark(name, data) {
    try {
      if (!__ijPanelDiag.active) { return; }
      diagPush('marks', {
        at: Math.round(perfNow() - __ijPanelDiag.startedAt),
        name: String(name || ''),
        data: data || {},
      }, 0);
    } catch (eMark) {}
  }
  function percentile(values, p) {
    try {
      if (!values || values.length === 0) { return 0; }
      var sorted = values.slice().sort(function (a, b) { return a - b; });
      var idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
      return Math.round(sorted[idx]);
    } catch (ePct) { return 0; }
  }
  function flushPanelDiagnostics(reason, finalFlush) {
    try {
      if (!isRendererDiagnosticsEnabled()) { return; }
      if (!__ijPanelDiag.active && !finalFlush) { return; }
      var now = perfNow();
      var frameGaps = __ijPanelDiag.frameGaps.splice(0, __ijPanelDiag.frameGaps.length);
      var slowFrames = __ijPanelDiag.slowFrames.splice(0, __ijPanelDiag.slowFrames.length);
      var events = __ijPanelDiag.events.splice(0, __ijPanelDiag.events.length);
      var eventTimings = __ijPanelDiag.eventTimings.splice(0, __ijPanelDiag.eventTimings.length);
      var longTasks = __ijPanelDiag.longTasks.splice(0, __ijPanelDiag.longTasks.length);
      var loafs = __ijPanelDiag.longAnimationFrames.splice(0, __ijPanelDiag.longAnimationFrames.length);
      var marks = __ijPanelDiag.marks.splice(0, __ijPanelDiag.marks.length);
      if (!finalFlush && frameGaps.length === 0 && events.length === 0 &&
          eventTimings.length === 0 && longTasks.length === 0 && loafs.length === 0 && marks.length === 0) {
        return;
      }
      var sum = 0;
      for (var i = 0; i < frameGaps.length; i++) { sum += frameGaps[i]; }
      var frameMax = frameGaps.length ? Math.max.apply(Math, frameGaps) : 0;
      var frameP95 = percentile(frameGaps, 0.95);
      var hasAnomaly = slowFrames.length > 0 || eventTimings.length > 0 || longTasks.length > 0 || loafs.length > 0 || frameMax >= 32;
      var verbose = window.__ijFindPerfVerbose === true;
      var healthyDue = now - (__ijPanelDiag.lastHealthyFlushAt || 0) >= 5000;
      if (!finalFlush && !hasAnomaly && !verbose && !healthyDue) { return; }
      if (!finalFlush && !hasAnomaly && !verbose) {
        __ijPanelDiag.lastHealthyFlushAt = now;
      }
      send({
        type: 'trace',
        phase: 'paneldiag:flush',
        perf: Math.round(now),
        data: {
          reason: reason || '',
          final: !!finalFlush,
          seq: ++__ijPanelDiag.flushSeq,
          healthy: !hasAnomaly,
          elapsedMs: Math.round(now - (__ijPanelDiag.startedAt || now)),
          visible: isPanelVisibleForPerf(),
          frameCount: frameGaps.length,
          frameGapsMs: (finalFlush || hasAnomaly || verbose) ? frameGaps : [],
          frameAvgMs: frameGaps.length ? Math.round(sum / frameGaps.length) : 0,
          frameP95Ms: frameP95,
          frameMaxMs: frameMax,
          framesTotal: __ijPanelDiag.framesTotal,
          maxGapSinceStartMs: Math.round(__ijPanelDiag.maxGapMs || 0),
          slowFrames: slowFrames,
          events: events,
          eventTimings: eventTimings,
          longTasks: longTasks,
          longAnimationFrames: loafs,
          marks: marks,
          memory: perfMemorySnapshot(),
          dom: perfDomSnapshot(),
          light: lightStatusObject(),
          ir: irLightStatus(),
        },
      });
    } catch (eFlushDiag) {}
  }
  function panelDiagEventListener(evt) {
    try {
      if (!__ijPanelDiag.active) { return; }
      var now = perfNow();
      var item = {
        at: Math.round(now - __ijPanelDiag.startedAt),
        type: evt.type || '',
        delayMs: eventDelayMs(evt),
        target: compactEventTarget(evt.target),
        key: evt.key ? String(evt.key).slice(0, 24) : '',
        button: typeof evt.button === 'number' ? evt.button : undefined,
        mods: (evt.metaKey ? 'M' : '') + (evt.ctrlKey ? 'C' : '') + (evt.altKey ? 'A' : '') + (evt.shiftKey ? 'S' : ''),
        defaultPrevented: !!evt.defaultPrevented,
      };
      if (!/^(input|keydown|keyup|focusin|focusout|pointerdown|mousedown|click|dblclick)$/.test(item.type || '') &&
          !(typeof item.delayMs === 'number' && item.delayMs >= 32)) {
        return;
      }
      if ((item.type === 'pointerdown' || item.type === 'mousedown' || item.type === 'click') &&
          typeof item.delayMs === 'number' && item.delayMs < 16 &&
          item.target && item.target.inPanel === false &&
          !window.__ijFindPerfVerbose) {
        return;
      }
      diagPush('events', item, 260);
    } catch (eEvtDiag) {}
  }
  function startPanelDiagnostics(reason, durationMs) {
    try {
      if (!isRendererDiagnosticsEnabled()) { return; }
      var now = perfNow();
      if (__ijPanelDiag.active) {
        __ijPanelDiag.reason += ',' + String(reason || 'show');
        panelDiagMark('diag:extend', { reason: reason || '', durationMs: durationMs || 0 });
        return;
      }
      __ijPanelDiag.active = true;
      __ijPanelDiag.reason = String(reason || 'show');
      __ijPanelDiag.startedAt = now;
      __ijPanelDiag.lastFrameAt = 0;
      __ijPanelDiag.frameGaps = [];
      __ijPanelDiag.slowFrames = [];
      __ijPanelDiag.events = [];
      __ijPanelDiag.eventTimings = [];
      __ijPanelDiag.longTasks = [];
      __ijPanelDiag.longAnimationFrames = [];
      __ijPanelDiag.marks = [];
      __ijPanelDiag.framesTotal = 0;
      __ijPanelDiag.maxGapMs = 0;
      __ijPanelDiag.flushSeq = 0;
      __ijPanelDiag.lastHealthyFlushAt = 0;
      var eventTypes = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'keydown', 'keyup', 'input', 'wheel', 'focusin', 'focusout'];
      var opts = { capture: true, passive: true };
      __ijPanelDiag.removeListeners = [];
      for (var et = 0; et < eventTypes.length; et++) {
        try {
          document.addEventListener(eventTypes[et], panelDiagEventListener, opts);
          (function (type) {
            __ijPanelDiag.removeListeners.push(function () {
              try { document.removeEventListener(type, panelDiagEventListener, opts); } catch (eRemoveEvt) {}
            });
          })(eventTypes[et]);
        } catch (eAddEvt) {}
      }
      var tick = function (ts) {
        if (!__ijPanelDiag.active) { return; }
        var frameAt = typeof ts === 'number' ? ts : perfNow();
        if (__ijPanelDiag.lastFrameAt > 0) {
          var gap = frameAt - __ijPanelDiag.lastFrameAt;
          var rounded = Math.max(0, Math.round(gap));
          __ijPanelDiag.framesTotal++;
          __ijPanelDiag.frameGaps.push(rounded);
          if (__ijPanelDiag.frameGaps.length > 180) { __ijPanelDiag.frameGaps.splice(0, __ijPanelDiag.frameGaps.length - 180); }
          if (gap > __ijPanelDiag.maxGapMs) { __ijPanelDiag.maxGapMs = gap; }
          if (gap >= 32) {
            diagPush('slowFrames', {
              at: Math.round(frameAt - __ijPanelDiag.startedAt),
              gapMs: rounded,
              visible: isPanelVisibleForPerf(),
              activeTag: document.activeElement && document.activeElement.tagName ? String(document.activeElement.tagName).toLowerCase() : '',
            }, 80);
          }
        }
        __ijPanelDiag.lastFrameAt = frameAt;
        if (isPanelVisibleForPerf()) {
          __ijPanelDiag.rafId = requestAnimationFrame(tick);
        }
      };
      if (typeof requestAnimationFrame === 'function') {
        __ijPanelDiag.rafId = requestAnimationFrame(tick);
      }
      __ijPanelDiag.flushTimer = setInterval(function () {
        flushPanelDiagnostics('interval', false);
      }, 1000);
      panelDiagMark('diag:start', { reason: reason || '', durationMs: durationMs || 0 });
    } catch (eStartDiag) {}
  }
  function stopPanelDiagnostics(reason) {
    try {
      if (!__ijPanelDiag.active) { return; }
      panelDiagMark('diag:stop', { reason: reason || '' });
      __ijPanelDiag.active = false;
      if (__ijPanelDiag.rafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(__ijPanelDiag.rafId);
      }
      __ijPanelDiag.rafId = 0;
      if (__ijPanelDiag.flushTimer) { clearInterval(__ijPanelDiag.flushTimer); }
      __ijPanelDiag.flushTimer = 0;
      var removers = __ijPanelDiag.removeListeners || [];
      __ijPanelDiag.removeListeners = [];
      for (var i = 0; i < removers.length; i++) {
        try { removers[i](); } catch (eRemoveDiag) {}
      }
      flushPanelDiagnostics(reason || 'stop', true);
    } catch (eStopDiag) {}
  }
  function longTaskAttribution(entry) {
    var out = [];
    try {
      var attr = entry && entry.attribution;
      if (!attr || typeof attr.length !== 'number') { return out; }
      for (var i = 0; i < attr.length && i < 6; i++) {
        var a = attr[i] || {};
        out.push({
          name: a.name || '',
          entryType: a.entryType || '',
          containerType: a.containerType || '',
          containerName: a.containerName || '',
          containerId: a.containerId || '',
          containerSrc: a.containerSrc || '',
        });
      }
    } catch (eAttr) {}
    return out;
  }
  var __ijPerfWatch = {
    active: false,
    rafId: 0,
    reason: '',
    startedAt: 0,
    deadline: 0,
    lastFrameAt: 0,
    lastGapLogAt: 0,
    maxGapMs: 0,
    gapEvents: 0,
    longTaskEvents: 0,
  };
  function isPanelVisibleForPerf() {
    try { return !!(panel && panel.classList && panel.classList.contains('visible')); }
    catch (eVisible) { return false; }
  }
  function startPerfWatch(reason, durationMs) {
    try {
      if (!isRendererDiagnosticsEnabled()) { return; }
      if (typeof requestAnimationFrame !== 'function') { return; }
      var now = perfNow();
      var duration = Math.max(1000, Math.min(30000, typeof durationMs === 'number' ? durationMs : 12000));
      var wasActive = __ijPerfWatch.active;
      __ijPerfWatch.deadline = Math.max(__ijPerfWatch.deadline || 0, now + duration);
      __ijPerfWatch.reason = wasActive ? (__ijPerfWatch.reason + ',' + reason) : String(reason || 'watch');
      if (wasActive) { return; }
      __ijPerfWatch.active = true;
      __ijPerfWatch.startedAt = now;
      __ijPerfWatch.lastFrameAt = 0;
      __ijPerfWatch.lastGapLogAt = 0;
      __ijPerfWatch.maxGapMs = 0;
      __ijPerfWatch.gapEvents = 0;
      __ijPerfWatch.longTaskEvents = 0;
      trace('perf:watch:start', { reason: __ijPerfWatch.reason, durationMs: duration });
      var tick = function (ts) {
        if (!__ijPerfWatch.active) { return; }
        var frameAt = typeof ts === 'number' ? ts : perfNow();
        if (__ijPerfWatch.lastFrameAt > 0) {
          var gap = frameAt - __ijPerfWatch.lastFrameAt;
          if (gap > __ijPerfWatch.maxGapMs) { __ijPerfWatch.maxGapMs = gap; }
          if (gap >= 80 && __ijPerfWatch.gapEvents < 24 && frameAt - __ijPerfWatch.lastGapLogAt >= 250) {
            __ijPerfWatch.gapEvents++;
            __ijPerfWatch.lastGapLogAt = frameAt;
            trace('perf:raf-gap', {
              reason: __ijPerfWatch.reason,
              gapMs: Math.round(gap),
              maxGapMs: Math.round(__ijPerfWatch.maxGapMs),
              elapsedMs: Math.round(frameAt - __ijPerfWatch.startedAt),
              memory: perfMemorySnapshot(),
              dom: perfDomSnapshot(),
            });
          }
        }
        __ijPerfWatch.lastFrameAt = frameAt;
        if (frameAt < __ijPerfWatch.deadline && isPanelVisibleForPerf()) {
          __ijPerfWatch.rafId = requestAnimationFrame(tick);
          return;
        }
        __ijPerfWatch.active = false;
        __ijPerfWatch.rafId = 0;
        trace('perf:watch:end', {
          reason: __ijPerfWatch.reason,
          elapsedMs: Math.round(frameAt - __ijPerfWatch.startedAt),
          maxGapMs: Math.round(__ijPerfWatch.maxGapMs),
          gapEvents: __ijPerfWatch.gapEvents,
          longTaskEvents: __ijPerfWatch.longTaskEvents,
        });
      };
      __ijPerfWatch.rafId = requestAnimationFrame(tick);
    } catch (eWatch) {}
  }
  function stopPerfWatch(reason) {
    try {
      if (!__ijPerfWatch.active) { return; }
      __ijPerfWatch.active = false;
      if (__ijPerfWatch.rafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(__ijPerfWatch.rafId);
      }
      trace('perf:watch:stop', {
        reason: reason || 'stop',
        watchReason: __ijPerfWatch.reason,
        elapsedMs: Math.round(perfNow() - __ijPerfWatch.startedAt),
        maxGapMs: Math.round(__ijPerfWatch.maxGapMs),
        gapEvents: __ijPerfWatch.gapEvents,
        longTaskEvents: __ijPerfWatch.longTaskEvents,
      });
    } catch (eStopWatch) {}
  }
  function reportPerfPhase(name, startedAt, data, thresholdMs) {
    try {
      if (!isRendererDiagnosticsEnabled()) { return; }
      var duration = perfNow() - startedAt;
      var threshold = typeof thresholdMs === 'number' ? thresholdMs : 8;
      if (duration >= threshold || window.__ijFindPerfVerbose === true) {
        var payload = data || {};
        payload.name = name;
        payload.durationMs = Math.round(duration);
        trace('perf:phase', payload);
      }
      if (duration >= 80) {
        startPerfWatch('slow-phase:' + name, 6000);
      }
    } catch (ePhase) {}
  }
  (function installLongTaskObserver() {
    try {
      if (!isRendererDiagnosticsEnabled()) { return; }
      if (typeof PerformanceObserver !== 'function') {
        trace('perf:longtask-observer', { supported: false, reason: 'no-performance-observer' });
        return;
      }
      var supported = PerformanceObserver.supportedEntryTypes || [];
      if (supported.indexOf && supported.indexOf('longtask') < 0) {
        trace('perf:longtask-observer', { supported: false, reason: 'entrytype-missing' });
        return;
      }
      var observer = new PerformanceObserver(function (list) {
        if (!isPanelVisibleForPerf() && !__ijPerfWatch.active) { return; }
        var entries = list.getEntries ? list.getEntries() : [];
        for (var i = 0; i < entries.length && __ijPerfWatch.longTaskEvents < 24; i++) {
          var entry = entries[i];
          var duration = entry && entry.duration ? entry.duration : 0;
          if (duration < 50) { continue; }
          __ijPerfWatch.longTaskEvents++;
          diagPush('longTasks', {
            at: Math.round(perfNow() - (__ijPanelDiag.startedAt || perfNow())),
            durationMs: Math.round(duration),
            startTimeMs: Math.round(entry.startTime || 0),
            name: entry.name || '',
            entryType: entry.entryType || '',
            attribution: longTaskAttribution(entry),
          }, 80);
          trace('perf:longtask', {
            durationMs: Math.round(duration),
            startTimeMs: Math.round(entry.startTime || 0),
            name: entry.name || '',
            entryType: entry.entryType || '',
            attribution: longTaskAttribution(entry),
            memory: perfMemorySnapshot(),
            dom: perfDomSnapshot(),
          });
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
      addDisposer(function () { try { observer.disconnect(); } catch (eDisconnectPerf) {} });
      trace('perf:longtask-observer', { supported: true, entryTypes: supported.slice ? supported.slice(0, 40) : [] });
    } catch (eLongTask) {
      trace('perf:longtask-observer', { supported: false, reason: String(eLongTask && eLongTask.message || eLongTask).slice(0, 160) });
    }
  })();
  (function installEventTimingObserver() {
    try {
      if (!isRendererDiagnosticsEnabled()) { return; }
      if (typeof PerformanceObserver !== 'function') { return; }
      var supported = PerformanceObserver.supportedEntryTypes || [];
      if (!supported.indexOf || supported.indexOf('event') < 0) {
        trace('perf:event-observer', { supported: false });
        return;
      }
      var observer = new PerformanceObserver(function (list) {
        if (!isPanelVisibleForPerf() && !__ijPanelDiag.active) { return; }
        var entries = list.getEntries ? list.getEntries() : [];
        for (var i = 0; i < entries.length && i < 60; i++) {
          var entry = entries[i];
          var duration = Math.round(entry.duration || 0);
          var delay = Math.round((entry.processingStart || 0) - (entry.startTime || 0));
          var processing = Math.round((entry.processingEnd || 0) - (entry.processingStart || 0));
          if (!window.__ijFindPerfVerbose && !/^(click|dblclick|mousedown|mouseup|pointerdown|pointerup|keydown|keyup|input|wheel)$/.test(entry.name || '')) {
            if (duration < 80 && delay < 40 && processing < 16) { continue; }
          }
          if (duration < 80 && delay < 40 && processing < 16 && !window.__ijFindPerfVerbose) { continue; }
          diagPush('eventTimings', {
            at: Math.round(perfNow() - (__ijPanelDiag.startedAt || perfNow())),
            name: entry.name || '',
            durationMs: duration,
            delayMs: delay,
            processingMs: processing,
            cancelable: !!entry.cancelable,
          }, 120);
        }
      });
      try {
        observer.observe({ type: 'event', buffered: true, durationThreshold: 16 });
      } catch (eTypedEvent) {
        observer.observe({ entryTypes: ['event'] });
      }
      addDisposer(function () { try { observer.disconnect(); } catch (eDisconnectEvent) {} });
      trace('perf:event-observer', { supported: true });
    } catch (eEventObs) {
      trace('perf:event-observer', { supported: false, reason: String(eEventObs && eEventObs.message || eEventObs).slice(0, 160) });
    }
  })();
  (function installLongAnimationFrameObserver() {
    try {
      if (!isRendererDiagnosticsEnabled()) { return; }
      if (typeof PerformanceObserver !== 'function') { return; }
      var supported = PerformanceObserver.supportedEntryTypes || [];
      if (!supported.indexOf || supported.indexOf('long-animation-frame') < 0) {
        trace('perf:loaf-observer', { supported: false });
        return;
      }
      var observer = new PerformanceObserver(function (list) {
        if (!isPanelVisibleForPerf() && !__ijPanelDiag.active) { return; }
        var entries = list.getEntries ? list.getEntries() : [];
        for (var i = 0; i < entries.length && i < 40; i++) {
          var entry = entries[i];
          diagPush('longAnimationFrames', {
            at: Math.round(perfNow() - (__ijPanelDiag.startedAt || perfNow())),
            durationMs: Math.round(entry.duration || 0),
            startTimeMs: Math.round(entry.startTime || 0),
            blockingDurationMs: Math.round(entry.blockingDuration || 0),
            renderStartMs: Math.round(entry.renderStart || 0),
            styleAndLayoutStartMs: Math.round(entry.styleAndLayoutStart || 0),
            scripts: entry.scripts && typeof entry.scripts.length === 'number' ? entry.scripts.length : 0,
          }, 80);
        }
      });
      observer.observe({ entryTypes: ['long-animation-frame'] });
      addDisposer(function () { try { observer.disconnect(); } catch (eDisconnectLoaf) {} });
      trace('perf:loaf-observer', { supported: true });
    } catch (eLoafObs) {
      trace('perf:loaf-observer', { supported: false, reason: String(eLoafObs && eLoafObs.message || eLoafObs).slice(0, 160) });
    }
  })();
  (function installGcObserver() {
    try {
      if (!isRendererDiagnosticsEnabled()) { return; }
      if (typeof PerformanceObserver !== 'function') { return; }
      var supported = PerformanceObserver.supportedEntryTypes || [];
      if (!supported.indexOf || supported.indexOf('gc') < 0) {
        trace('perf:gc-observer', { supported: false });
        return;
      }
      var observer = new PerformanceObserver(function (list) {
        if (!isPanelVisibleForPerf() && !__ijPerfWatch.active) { return; }
        var entries = list.getEntries ? list.getEntries() : [];
        for (var i = 0; i < entries.length && i < 12; i++) {
          var entry = entries[i];
          trace('perf:gc', {
            durationMs: Math.round(entry.duration || 0),
            startTimeMs: Math.round(entry.startTime || 0),
            name: entry.name || '',
            kind: entry.kind || '',
            memory: perfMemorySnapshot(),
          });
        }
      });
      observer.observe({ entryTypes: ['gc'] });
      addDisposer(function () { try { observer.disconnect(); } catch (eDisconnectGc) {} });
      trace('perf:gc-observer', { supported: true });
    } catch (eGc) {
      trace('perf:gc-observer', { supported: false, reason: String(eGc && eGc.message || eGc).slice(0, 160) });
    }
  })();
  trace('patch:installed', {
    monacoCaptureEnabled: !!__ijFindEnableMonacoPreviewCapture,
    perfDiagnostics: !!__ijFindEnablePerfDiagnostics
  });
	  var RESULT_ROW_HEIGHT = 20;
  var RESULT_OVERSCAN = 12;
  var SEARCHING_RENDER_MIN_INTERVAL_MS = 100;

  function setStatus(text, spinning) {
    $status.textContent = text;
    $spinner.classList.toggle('hidden', !spinning);
  }
  function setSummary() {
    var files = state.files.length;
    var matches = state.matchCount || 0;
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

  function previewMinimapMatchOptions(active) {
    return {
      // Theme tokens can resolve too close to the minimap text color in some
      // VS Code themes. Use an opaque orange so match marks remain visible.
      color: active ? '#ff6a00' : '#ffb000',
      position: 1, // MinimapPosition.Inline
    };
  }

  function syncRegexMultilineUi() {
    var enabled = !!state.options.useRegex;
    $optRegexMultiline.setAttribute('aria-disabled', enabled ? 'false' : 'true');
  }

  function syncCaseUi() {
    $optCase.setAttribute('aria-pressed', String(!!state.options.caseSensitive));
  }

  var detachedPanelSeq = 0;
  try {
    if (typeof window.__ijFindPanelZSeq !== 'number') { window.__ijFindPanelZSeq = 10000; }
  } catch (ePanelZInit) {}

  function getFocusedSearchPanel() {
    try { return window.__ijFindFocusedSearchPanel || null; } catch (eFocusedGet) { return null; }
  }

  function setFocusedSearchPanel(root) {
    try { window.__ijFindFocusedSearchPanel = root || null; } catch (eFocusedSet) {}
  }

  function capturePanelInlineLayout() {
    var names = ['left', 'top', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'transform'];
    var out = {};
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      try {
        var value = panel.style.getPropertyValue(name);
        var priority = panel.style.getPropertyPriority(name);
        out[name] = {
          value: value,
          priority: priority,
          had: value !== '' || priority !== '',
        };
      } catch (eCaptureStyle) {}
    }
    return out;
  }

  function restorePanelInlineLayout(layout) {
    if (!layout) { return; }
    var names = ['left', 'top', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'transform'];
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var entry = layout[name];
      try {
        if (entry && entry.had) {
          panel.style.setProperty(name, entry.value || '', entry.priority || '');
        } else {
          panel.style.removeProperty(name);
        }
      } catch (eRestoreStyle) {}
    }
  }

  function setPreviewOverflowHidden(hidden) {
    try {
      var overflowRoot = findPreviewOverflowRootForInstance();
      if (overflowRoot) {
        if (hidden) { overflowRoot.style.setProperty('display', 'none', 'important'); }
        else { overflowRoot.style.removeProperty('display'); }
      }
    } catch (eOverflowHidden) {}
  }

  function relayoutHostedPreviewEditorSoon() {
    setTimeout(function () {
      try {
        var ed = state.previewMonacoEditor || state.monacoEditor;
        var host = state.previewMonacoHost || state.monacoHost;
        if (ed && host && host.parentElement && typeof ed.layout === 'function') {
          var rect = host.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            ed.layout({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
          }
        }
      } catch (ePreviewLayout) {}
      try { if (state.stolenEditor) { layoutStolenEditor(); } } catch (eStolenLayout) {}
    }, 0);
  }

  function syncMinimizeButton() {
    try {
      var minimized = !!state.minimized;
      $minimize.textContent = minimized ? '\\u25A1' : '\\u2212';
      $minimize.title = minimized ? 'Restore panel' : 'Minimize panel';
      $minimize.setAttribute('aria-label', minimized ? 'Restore panel' : 'Minimize panel');
      $minimize.setAttribute('aria-pressed', minimized ? 'true' : 'false');
    } catch (eMinButton) {}
  }

  function minimizeSearchPanel() {
    if (state.minimized) { return; }
    var rect = panel.getBoundingClientRect();
    state.minimizedLayout = capturePanelInlineLayout();
    state.minimized = true;
    try { hideHover(); } catch (eHideHoverForMinimize) {}
    if (state.hoverTimer) { clearTimeout(state.hoverTimer); state.hoverTimer = null; }
    setPreviewOverflowHidden(true);
    panel.classList.add('ij-find-minimized');
    var compactW = Math.max(240, Math.min(320, window.innerWidth - 16));
    var compactH = 30;
    var left = Math.max(8, Math.min(Math.max(8, window.innerWidth - compactW - 8), Math.round(rect.left)));
    var top = Math.max(8, Math.min(Math.max(8, window.innerHeight - compactH - 8), Math.round(rect.top)));
    panel.style.setProperty('left', left + 'px', 'important');
    panel.style.setProperty('top', top + 'px', 'important');
    panel.style.setProperty('width', compactW + 'px', 'important');
    panel.style.setProperty('height', compactH + 'px', 'important');
    panel.style.setProperty('min-width', '240px', 'important');
    panel.style.setProperty('min-height', '0', 'important');
    panel.style.setProperty('max-width', 'calc(100vw - 16px)', 'important');
    panel.style.setProperty('max-height', compactH + 'px', 'important');
    panel.style.setProperty('transform', 'none', 'important');
    syncMinimizeButton();
    panelDiagMark('minimize', { active: true, width: compactW, height: compactH });
    trace('minimize', { active: true });
  }

  function restoreSearchPanelFromMinimized(silent) {
    if (!state.minimized) { return; }
    var layout = state.minimizedLayout;
    state.minimized = false;
    state.minimizedLayout = null;
    panel.classList.remove('ij-find-minimized');
    restorePanelInlineLayout(layout);
    setPreviewOverflowHidden(false);
    syncMinimizeButton();
    relayoutHostedPreviewEditorSoon();
    if (!silent) {
      bringSearchPanelToFront(panel);
      panelDiagMark('minimize', { active: false });
      trace('minimize', { active: false });
    }
  }

  function toggleSearchPanelMinimized() {
    if (state.minimized) { restoreSearchPanelFromMinimized(false); }
    else { minimizeSearchPanel(); }
  }

  function bringSearchPanelToFront(root) {
      if (!root || !root.classList || !root.classList.contains('ij-find-overlay')) { return; }
      try {
      window.__ijFindPanelZSeq = (typeof window.__ijFindPanelZSeq === 'number' ? window.__ijFindPanelZSeq : 10000) + 1;
      root.style.setProperty('z-index', String(window.__ijFindPanelZSeq), 'important');
      setFocusedSearchPanel(root);
      if (root === panel) {
        window.__ijFindActiveInstanceId = __ijFindInstanceId;
        var overflowRoot = findPreviewOverflowRootForInstance();
        if (overflowRoot) {
          overflowRoot.style.setProperty('z-index', String(window.__ijFindPanelZSeq + 20), 'important');
        }
      }
      var overlays = document.querySelectorAll('.ij-find-overlay.ij-find-focused');
      for (var i = 0; i < overlays.length; i++) {
        if (overlays[i] !== root) { overlays[i].classList.remove('ij-find-focused'); }
      }
      root.classList.add('ij-find-focused');
    } catch (eBring) {}
  }

  function wireSearchPanelFocus(root) {
    try {
      root.addEventListener('pointerdown', function () { bringSearchPanelToFront(root); }, true);
      root.addEventListener('mousedown', function () { bringSearchPanelToFront(root); }, true);
      root.addEventListener('focusin', function () { bringSearchPanelToFront(root); }, true);
    } catch (eFocusWire) {}
  }

  function hasVisibleSearchPanelExcept(root) {
    try {
      var overlays = document.querySelectorAll('.ij-find-overlay.visible');
      for (var i = 0; i < overlays.length; i++) {
        if (overlays[i] !== root) { return true; }
      }
    } catch (eVisiblePanels) {}
    return false;
  }

  function noteSearchPanelClosed(root) {
    try {
      if (getFocusedSearchPanel() === root) { setFocusedSearchPanel(null); }
      if (root && root.classList) { root.classList.remove('ij-find-focused'); }
      if (!hasVisibleSearchPanelExcept(root)) {
        setIntelliSenseRecursionCaptureSuspended(false, 'search-ui-hidden');
        sendPersistent({ type: 'panelHidden' });
      }
    } catch (ePanelClosed) {}
  }

  function closeDetachedSearchPanel(root) {
    try {
      if (!root || !root.classList || !root.classList.contains('ij-find-detached')) { return false; }
      root.classList.remove('visible');
      try { root.remove(); } catch (eRemoveDetached) {}
      noteSearchPanelClosed(root);
      return true;
    } catch (eCloseDetached) {
      return false;
    }
  }

  function rectForSpawnBase() {
    try {
      if (
        getFocusedSearchPanel() &&
        getFocusedSearchPanel().classList &&
        getFocusedSearchPanel().classList.contains('visible') &&
        document.body.contains(getFocusedSearchPanel())
      ) {
        var focusedRect = getFocusedSearchPanel().getBoundingClientRect();
        if (isUsableSpawnBaseRect(focusedRect)) { return focusedRect; }
      }
    } catch (eFocusedRect) {}
    try {
      if (panel.classList && panel.classList.contains('visible') && document.body.contains(panel)) {
        var panelRect = panel.getBoundingClientRect();
        if (isUsableSpawnBaseRect(panelRect)) { return panelRect; }
      }
    } catch (ePanelRect) {}
    return null;
  }

  function isUsableSpawnBaseRect(rect) {
    try {
      if (!rect) { return false; }
      if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) { return false; }
      if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) { return false; }
      if (rect.width < 320 || rect.height < 220) { return false; }
      if (rect.right <= 0 || rect.bottom <= 0) { return false; }
      if (rect.left >= window.innerWidth || rect.top >= window.innerHeight) { return false; }
      return true;
    } catch (eUsableSpawnRect) {
      return false;
    }
  }

  function defaultSpawnPanelLayout() {
    var availableWidth = Math.max(420, window.innerWidth - 44);
    var availableHeight = Math.max(320, window.innerHeight - 84);
    var width = Math.min(860, availableWidth);
    var height = Math.min(680, availableHeight);
    var left = Math.round((window.innerWidth - width) / 2);
    var top = Math.max(36, Math.round((window.innerHeight - height) / 2));
    return {
      left: Math.max(8, left),
      top: Math.max(8, top),
      width: Math.round(width),
      height: Math.round(height),
    };
  }

  function applyPanelLayout(layout) {
    if (!layout) { return; }
    panel.style.left = Math.round(layout.left) + 'px';
    panel.style.top = Math.round(layout.top) + 'px';
    panel.style.width = Math.round(layout.width) + 'px';
    panel.style.height = Math.round(layout.height) + 'px';
    panel.style.maxWidth = 'none';
    panel.style.maxHeight = 'none';
    panel.style.transform = 'none';
  }

  function applyPreviewHeavyLayout(panelHeight) {
    try {
      var maxPreview = Math.max(150, Math.round(panelHeight) - 180);
      var desired = Math.max(320, Math.round(panelHeight * 0.58));
      $preview.style.flex = '0 0 ' + Math.min(maxPreview, desired) + 'px';
    } catch (ePreviewHeavy) {}
  }

  function offsetPanelPosition(baseRect, width, height) {
    var offset = 36;
    var maxLeft = Math.max(8, window.innerWidth - Math.min(width, window.innerWidth - 20));
    var maxTop = Math.max(8, window.innerHeight - Math.min(height, window.innerHeight - 20));
    var left = Math.round((baseRect ? baseRect.left : 80) + offset);
    var top = Math.round((baseRect ? baseRect.top : 80) + offset);
    if (left > maxLeft) { left = Math.max(8, Math.round((baseRect ? baseRect.left : maxLeft) - offset)); }
    if (top > maxTop) { top = Math.max(8, Math.round((baseRect ? baseRect.top : maxTop) - offset)); }
    return {
      left: Math.max(8, Math.min(maxLeft, left)),
      top: Math.max(8, Math.min(maxTop, top)),
    };
  }

  function makeDetachedPanelDraggable(root) {
    try {
      var header = root.querySelector('.ij-find-header');
      if (!header) { return; }
      var dragging = false;
      var startX = 0, startY = 0, origX = 0, origY = 0;
      function move(e) {
        if (!dragging) { return; }
        var nx = origX + (e.clientX - startX);
        var ny = origY + (e.clientY - startY);
        nx = Math.max(0, Math.min(window.innerWidth - 120, nx));
        ny = Math.max(0, Math.min(window.innerHeight - 40, ny));
        root.style.left = nx + 'px';
        root.style.top = ny + 'px';
      }
      function up() {
        dragging = false;
        try { document.removeEventListener('mousemove', move, true); } catch (eMoveRemove) {}
        try { document.removeEventListener('mouseup', up, true); } catch (eUpRemove) {}
      }
      header.addEventListener('mousedown', function (e) {
        if (e.target && e.target.closest && e.target.closest('.ij-find-minimize, .ij-find-close')) { return; }
        bringSearchPanelToFront(root);
        var rect = root.getBoundingClientRect();
        dragging = true;
        startX = e.clientX; startY = e.clientY;
        origX = rect.left; origY = rect.top;
        try { document.addEventListener('mousemove', move, true); } catch (eMoveAdd) {}
        try { document.addEventListener('mouseup', up, true); } catch (eUpAdd) {}
        e.preventDefault();
      });
    } catch (eDragDetached) {}
  }

  function makeDetachedPanelRowsInteractive(root) {
    try {
      root.addEventListener('click', function (e) {
        var close = e.target instanceof HTMLElement ? e.target.closest('.ij-find-close') : null;
        if (close) {
          e.preventDefault();
          e.stopPropagation();
          closeDetachedSearchPanel(root);
          return;
        }
        var actionBtn = e.target instanceof HTMLElement ? e.target.closest('.ij-find-row-action') : null;
        var row = e.target instanceof HTMLElement ? e.target.closest('.ij-find-row') : null;
        if (!row) { return; }
        var uri = row.getAttribute('data-uri') || '';
        if (!uri) { return; }
        var line = parseInt(row.getAttribute('data-line') || '0', 10);
        var column = parseInt(row.getAttribute('data-column') || '0', 10);
        if (actionBtn) {
          e.preventDefault();
          e.stopPropagation();
          var action = actionBtn.getAttribute('data-action') || '';
          if (action === 'reveal') {
            sendPersistent({ type: 'revealFile', uri: uri });
          } else if (action === 'open') {
            sendPersistent({ type: 'pinInSideEditor', uri: uri, line: line || 0, column: column || 0 });
          }
        }
      }, true);
      root.addEventListener('dblclick', function (e) {
        var row = e.target instanceof HTMLElement ? e.target.closest('.ij-find-row') : null;
        if (!row) { return; }
        var uri = row.getAttribute('data-uri') || '';
        if (!uri) { return; }
        var line = parseInt(row.getAttribute('data-line') || '0', 10);
        var column = parseInt(row.getAttribute('data-column') || '0', 10);
        e.preventDefault();
        e.stopPropagation();
        sendPersistent({ type: 'pinInSideEditor', uri: uri, line: line || 0, column: column || 0 });
      }, true);
    } catch (eRowsDetached) {}
  }

  function renderDetachedPreviewSnapshot(root) {
    try {
      var body = root && root.querySelector ? root.querySelector('.ij-find-preview-body') : null;
      if (!body) { return; }
      body.classList.remove('ij-find-editor-mounted');
      body.classList.remove('ij-find-stolen');
      body.classList.add('ij-find-detached-preview-snapshot');
      body.style.removeProperty('font-family');
      body.style.removeProperty('font-size');
      body.style.removeProperty('line-height');
      clearChildren(body);
      var msg = state.lastPreviewMsg;
      if (!msg || !Array.isArray(msg.lines) || msg.lines.length === 0) {
        body.appendChild(el('div', {
          className: 'ij-find-preview-content',
          children: [
            el('div', {
              className: 'ij-find-preview-line ij-find-preview-truncated',
              text: 'Preview snapshot unavailable',
            }),
          ],
        }));
        return;
      }
      var bounded = boundedPreviewLines(msg);
      var contentEl = el('div', { className: 'ij-find-preview-content' });
      var frag = document.createDocumentFragment();
      var focusEl = null;
      if (bounded.omittedBefore > 0) {
        frag.appendChild(el('div', {
          className: 'ij-find-preview-line ij-find-preview-truncated',
          text: '... ' + bounded.omittedBefore + ' earlier line(s) omitted',
        }));
      }
      for (var i = 0; i < bounded.lines.length; i++) {
        var line = bounded.lines[i];
        var isFocus = line.lineNumber === msg.focusLine;
        var lineEl = el('div', {
          className: 'ij-find-preview-line' + (isFocus ? ' focus' : ''),
          attrs: { 'data-line': String(line.lineNumber) },
        });
        lineEl.appendChild(el('span', {
          className: 'ij-find-preview-lineno',
          text: String(line.lineNumber + 1),
        }));
        var textSpan = el('span', { className: 'ij-find-preview-text' });
        if (isFocus && msg.ranges && msg.ranges.length > 0) {
          appendHighlightedInto(textSpan, line.text, msg.ranges);
        } else if (!fallbackHighlight(textSpan, line.text, msg.languageId || state.previewLanguageId || '')) {
          textSpan.textContent = line.text;
        }
        lineEl.appendChild(textSpan);
        frag.appendChild(lineEl);
        if (isFocus) { focusEl = lineEl; }
      }
      if (bounded.omittedAfter > 0) {
        frag.appendChild(el('div', {
          className: 'ij-find-preview-line ij-find-preview-truncated',
          text: '... ' + bounded.omittedAfter + ' later line(s) omitted',
        }));
      }
      contentEl.appendChild(frag);
      body.appendChild(contentEl);
      if (focusEl) {
        setTimeout(function () {
          try { focusEl.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (eScrollDetachedPreview) {}
        }, 0);
      }
    } catch (eDetachedPreview) {}
  }

  on(document, 'click', function (e) {
    try {
      var target = e.target instanceof HTMLElement ? e.target : null;
      var close = target && target.closest ? target.closest('.ij-find-close') : null;
      var root = close && close.closest ? close.closest('.ij-find-overlay.ij-find-detached') : null;
      if (!root) { return; }
      e.preventDefault();
      e.stopPropagation();
      closeDetachedSearchPanel(root);
    } catch (eDetachedDocClose) {}
  }, true);

  function detachCurrentPanelForSpawn() {
    if (!panel.classList.contains('visible')) { return false; }
    try {
      var rect = panel.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) { return false; }
      detachedPanelSeq += 1;
      var clone = panel.cloneNode(true);
      clone.classList.add('ij-find-detached');
      clone.setAttribute('data-ij-find-detached', String(detachedPanelSeq));
      clone.style.left = Math.round(rect.left) + 'px';
      clone.style.top = Math.round(rect.top) + 'px';
      clone.style.width = Math.round(rect.width) + 'px';
      clone.style.height = Math.round(rect.height) + 'px';
      clone.style.maxWidth = 'none';
      clone.style.maxHeight = 'none';
      clone.style.transform = 'none';
      clone.style.display = 'flex';
      clone.style.visibility = 'visible';
      clone.style.opacity = '1';
      clone.style.pointerEvents = 'auto';
      clone.style.position = 'fixed';
      clone.style.zIndex = String(9990 + detachedPanelSeq);
      var title = clone.querySelector('.ij-find-title');
      if (title && title.textContent) { title.textContent = title.textContent + ' \u00b7 detached'; }
      var fields = clone.querySelectorAll('textarea, input');
      for (var i = 0; i < fields.length; i++) {
        try { fields[i].readOnly = true; fields[i].setAttribute('tabindex', '-1'); } catch (eField) {}
      }
      renderDetachedPreviewSnapshot(clone);
      makeDetachedPanelDraggable(clone);
      makeDetachedPanelRowsInteractive(clone);
      wireSearchPanelFocus(clone);
      if (panel.parentElement) { panel.parentElement.appendChild(clone); }
      var spawnBaseRect = rectForSpawnBase() || rect;
      var nextPos = offsetPanelPosition(spawnBaseRect, rect.width, rect.height);
      panel.style.left = nextPos.left + 'px';
      panel.style.top = nextPos.top + 'px';
      panel.style.width = Math.round(rect.width) + 'px';
      panel.style.height = Math.round(rect.height) + 'px';
      panel.style.maxWidth = 'none';
      panel.style.maxHeight = 'none';
      panel.style.transform = 'none';
      bringSearchPanelToFront(panel);
      return true;
    } catch (eDetach) {
      return false;
    }
  }

  function setShellMode(active) {
    try {
      var beforeChildren = panel ? panel.children.length : -1;
      panel.classList.toggle('ij-find-shell', !!active);
      if (active) {
        if ($results.parentElement === panel) { panel.removeChild($results); }
        if ($splitter.parentElement === panel) { panel.removeChild($splitter); }
        if ($preview.parentElement === panel) { panel.removeChild($preview); }
        if ($resizer.parentElement === panel) { panel.removeChild($resizer); }
      } else {
        if ($results.parentElement !== panel) { panel.appendChild($results); }
        if ($splitter.parentElement !== panel) { panel.appendChild($splitter); }
        if ($preview.parentElement !== panel) { panel.appendChild($preview); }
        if ($resizer.parentElement !== panel) { panel.appendChild($resizer); }
      }
      panelDiagMark('shellMode', {
        active: !!active,
        beforeChildren: beforeChildren,
        afterChildren: panel ? panel.children.length : -1,
        resultsAttached: $results.parentElement === panel,
        previewAttached: $preview.parentElement === panel,
      });
    } catch (eShell) {}
  }

  function ensureFullPanelStructure(reason) {
    try {
      if (state.minimized) { return; }
      if (
        panel.classList.contains('ij-find-shell') ||
        $results.parentElement !== panel ||
        $splitter.parentElement !== panel ||
        $preview.parentElement !== panel ||
        $resizer.parentElement !== panel
      ) {
        setShellMode(false);
        panelDiagMark('panelStructure:restore', { reason: reason || '' });
      }
    } catch (ePanelStructure) {
      panelDiagMark('panelStructure:error', {
        reason: reason || '',
        message: ePanelStructure && ePanelStructure.message,
      });
    }
  }

  // Render elapsed time as ' (N.Ns)' or ' (Nms)' — appended to status
  // messages so the user sees a live counter during long searches.
  function formatElapsed(ms) {
    if (!ms || ms < 0) { return ''; }
    if (ms < 1000) { return ' (' + ms + 'ms)'; }
    return ' (' + (ms / 1000).toFixed(1) + 's)';
  }
  // Status rewrite used by both results:start/file/candidates while the
  // search is in flight. Keeps the elapsed-time suffix updated without
  // duplicating the count-formatting branches.
  function updateSearchingStatus() {
    var elapsed = state.searchStartTs ? Date.now() - state.searchStartTs : 0;
    var matches = state.matchCount || 0;
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
    ranges = sanitizeRangesForText(text, ranges);
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
  }

  function sanitizeRangesForText(text, ranges) {
    var len = String(text || '').length;
    if (!ranges || ranges.length === 0) { return []; }
    var out = [];
    for (var i = 0; i < ranges.length && out.length < 16; i++) {
      var r = ranges[i] || {};
      var start = typeof r.start === 'number' && isFinite(r.start) ? Math.floor(r.start) : 0;
      var end = typeof r.end === 'number' && isFinite(r.end) ? Math.floor(r.end) : start;
      start = Math.max(0, Math.min(len, start));
      end = Math.max(0, Math.min(len, end));
      if (end <= start) { continue; }
      var sanitized = { start: start, end: end };
      if (typeof r.endLine === 'number' && isFinite(r.endLine)) {
        sanitized.endLine = Math.max(0, Math.floor(r.endLine));
        if (typeof r.endCol === 'number' && isFinite(r.endCol)) {
          sanitized.endCol = Math.max(0, Math.floor(r.endCol));
        }
      }
      out.push(sanitized);
    }
    return out;
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
    clearPreviewMonacoCallGraphInlays();
    if (state.previewRecoveryTimer) {
      clearTimeout(state.previewRecoveryTimer);
      state.previewRecoveryTimer = null;
    }
    if (state.stolenEditor) { restoreStolenEditor(); }
    // Preserve the embedded preview Monaco editor across clears so the
    // next preview render reuses it (avoiding the 124ms cold create cost
    // measured in captain log.txt). The match-decoration cleanup runs
    // below so a stale findMatch highlight doesn't outlive its query.
    if (state.previewMonacoEditor && state.previewMonacoHost && state.previewMonacoHost.parentElement === $previewBody) {
      try {
        if (state.previewMonacoMatchDecos) {
          state.previewMonacoEditor.deltaDecorations(state.previewMonacoMatchDecos, []);
          state.previewMonacoMatchDecos = null;
        }
      } catch (eClearMatchDecos) {}
      state.previewHydrated = false;
    } else if (state.monacoEditor && state.monacoHost && state.monacoHost.parentElement === $previewBody) {
      // Legacy stolen-monaco path: keep editor in memory; blank out the model.
      try { state.monacoEditor.setValue(''); } catch (e) {}
    } else {
      clearChildren($previewBody);
    }
    state.lastPreviewKey = '';
    state.activePreviewSeq++;
    state.previewUri = '';
    state.previewMode = '';
    state.lastPreviewMsg = null;
    state.previewLanguageId = '';
    hideHover();
  }

  var _renderPending = false;
  var _resultsViewportPending = false;
  var _renderTimer = null;
  var _lastRenderAt = 0;
  function scheduleRender() {
    if (_renderPending) { return; }
    _renderPending = true;
    var delay = 0;
    if (state.searching) {
      delay = Math.max(0, SEARCHING_RENDER_MIN_INTERVAL_MS - (Date.now() - _lastRenderAt));
    }
    function runRenderFrame() {
      _renderTimer = null;
      requestAnimationFrame(function () {
        var renderT0 = perfNow();
        _renderPending = false;
        _lastRenderAt = Date.now();
        try {
          render();
        } finally {
          reportPerfPhase('render:scheduled', renderT0, {
            searching: !!state.searching,
            files: state.files.length,
            flat: state.flat.length,
            candidates: state.candidates.length,
          }, 10);
        }
      });
    }
    if (delay > 0) {
      _renderTimer = setTimeout(runRenderFrame, delay);
    } else {
      runRenderFrame();
    }
  }

  function cancelScheduledRender() {
    if (_renderTimer) {
      clearTimeout(_renderTimer);
      _renderTimer = null;
    }
    _renderPending = false;
    _resultsViewportPending = false;
  }

  function scheduleResultsViewportRender() {
    if (_resultsViewportPending) { return; }
    _resultsViewportPending = true;
    requestAnimationFrame(function () {
      var viewportT0 = perfNow();
      _resultsViewportPending = false;
      try {
        renderResultsViewport();
      } finally {
        reportPerfPhase('resultsViewport:scheduled', viewportT0, {
          flat: state.flat.length,
          activeIndex: state.activeIndex,
          scrollTop: Math.round($results.scrollTop || 0),
        }, 10);
      }
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

  function buildRowActions() {
    return el('span', {
      className: 'ij-find-row-actions',
      children: [
        el('button', {
          className: 'ij-find-row-action',
          text: 'Reveal',
          title: 'Reveal file in Explorer',
          attrs: { type: 'button', 'data-action': 'reveal', 'aria-label': 'Reveal file in Explorer' },
        }),
        el('button', {
          className: 'ij-find-row-action',
          text: 'Open',
          title: 'Open file',
          attrs: { type: 'button', 'data-action': 'open', 'aria-label': 'Open file' },
        }),
      ],
    });
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
        attrs: {
          'data-flat': String(flatIdx),
          'data-uri': item.pendingUri,
          'data-line': '0',
          'data-column': '0',
          title: cPath,
        },
        children: [
          el('span', { className: 'ij-find-row-text', text: '\u2026 scanning' }),
          el('span', { className: 'ij-find-row-loc', text: cName }),
          buildRowActions(),
        ],
      });
      return row;
    }
    var f = state.files[item.fi];
    var m = f.matches[item.mi];
    var textEl = el('span', { className: 'ij-find-row-text' });
    appendHighlightedInto(textEl, normalizeResultPreview(m.preview), rangesForCurrentQuery(m));
    var targetRanges = rangesForCurrentQuery(m);
    var targetColumn = (targetRanges && targetRanges[0]) ? targetRanges[0].start : 0;
    var slashIdx = f.relPath.lastIndexOf('/');
    var fileName = slashIdx >= 0 ? f.relPath.slice(slashIdx + 1) : f.relPath;
    var locText = fileName + ':' + (m.line + 1);
    return el('div', {
      className: 'ij-find-row' + (flatIdx === state.activeIndex ? ' active' : ''),
      attrs: {
        'data-flat': String(flatIdx),
        'data-uri': f.uri,
        'data-line': String(m.line),
        'data-column': String(targetColumn),
      },
      children: [
        textEl,
        el('span', {
          className: 'ij-find-row-loc',
          title: f.relPath + ':' + (m.line + 1),
          text: locText,
        }),
        buildRowActions(),
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
    var viewportT0 = perfNow();
    try {
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
    } finally {
      reportPerfPhase('resultsViewport', viewportT0, {
        flat: state.flat.length,
        totalRows: totalRenderableRows(),
        activeIndex: state.activeIndex,
        scrollTop: Math.round($results.scrollTop || 0),
      }, 10);
    }
  }

  function render() {
    var renderT0 = perfNow();
    try {
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
    } finally {
      reportPerfPhase('render', renderT0, {
        searching: !!state.searching,
        files: state.files.length,
        flat: state.flat.length,
        candidates: state.candidates.length,
        activeIndex: state.activeIndex,
      }, 10);
    }
  }

  function applyActive(shouldScroll) {
    if (shouldScroll) { ensureActiveVisible(); }
    renderResultsViewport();
  }

  function selectMatch(flatIdx) {
    if (flatIdx < 0 || flatIdx >= state.flat.length) { return; }
    var selectT0 = perfNow();
    state.activeIndex = flatIdx;
    applyActive(true);
    var fm = state.flat[flatIdx];
    // Pending candidate row: no match confirmed yet. Preview opens the
    // file at line 0 so the user can skim while rg catches up.
    if (fm.pendingUri) {
      var pkey = fm.pendingUri + '#pending';
      if (pkey === state.lastPreviewKey && state.previewUri === fm.pendingUri) {
        trace('preview/select', { path: 'pending-dedup', flatIdx: flatIdx, applyActiveMs: Math.round(perfNow() - selectT0) });
        return;
      }
      state.lastPreviewKey = pkey;
      state.activePreviewSeq++;
      trace('preview/select', {
        path: 'pending',
        flatIdx: flatIdx,
        previewSeq: state.activePreviewSeq,
        applyActiveMs: Math.round(perfNow() - selectT0),
      });
      send({ type: 'requestPreview', uri: fm.pendingUri, line: 0, contextLines: 0, previewSeq: state.activePreviewSeq });
      return;
    }
    var f = state.files[fm.fi];
    var m = f.matches[fm.mi];
    var key = f.uri + '#' + m.line;
    if (key === state.lastPreviewKey && state.previewUri === f.uri) {
      trace('preview/select', { path: 'dedup', flatIdx: flatIdx, applyActiveMs: Math.round(perfNow() - selectT0) });
      return;
    }
    state.lastPreviewKey = key;
    // When the user is in extension-typing mode, rg's m.ranges cover the
    // OLD (shorter) query. The preview should highlight what the user
    // actually typed (NEW query) — recompute the range against the new
    // substring so the findMatch decoration lands on the right span.
    var previewRanges = rangesForCurrentQuery(m);
    // Only refresh the overlay's preview pane; do NOT touch VSCode's editor
    // area at all. Arrow-key browsing leaves no trace.
    state.activePreviewSeq++;
    trace('preview/select', {
      path: 'match',
      flatIdx: flatIdx,
      previewSeq: state.activePreviewSeq,
      line: m.line,
      applyActiveMs: Math.round(perfNow() - selectT0),
    });
    send({ type: 'requestPreview', uri: f.uri, line: m.line, ranges: previewRanges, contextLines: 0, previewSeq: state.activePreviewSeq });
  }

  // If we're in extension-filter mode, compute single-line ranges for the
  // user's NEW query against the match preview. Falls back to whatever rg
  // originally produced when no filter is active (non-extension searches
  // already have accurate ranges).
  function rangesForCurrentQuery(m) {
    var fq = state.filterQuery || '';
    var preview = normalizeResultPreview(m.preview || '');
    if (!fq) { return sanitizeRangesForText(preview, m.ranges); }
    var hay = state.options.caseSensitive ? preview : preview.toLowerCase();
    var needle = state.options.caseSensitive ? fq : fq.toLowerCase();
    var idx = hay.indexOf(needle);
    if (idx < 0) { return sanitizeRangesForText(preview, m.ranges); }
    return sanitizeRangesForText(preview, [{ start: idx, end: idx + fq.length }]);
  }

  function targetForFlatIndex(flatIdx) {
    if (flatIdx < 0 || flatIdx >= state.flat.length) { return null; }
    var fm = state.flat[flatIdx];
    if (fm.pendingUri) {
      // No confirmed line yet, so use the top of the file.
      return { uri: fm.pendingUri, line: 0, column: 0 };
    }
    var f = state.files[fm.fi];
    var m = f.matches[fm.mi];
    var ranges = rangesForCurrentQuery(m);
    var col = (ranges && ranges[0]) ? ranges[0].start : 0;
    return { uri: f.uri, line: m.line, column: col };
  }

  function openActive() {
    var target = targetForFlatIndex(state.activeIndex);
    if (!target) { return; }
    // Double-click / explicit Open action. Pins the file with focus so the
    // user can edit with all real VSCode features.
    send({ type: 'pinInSideEditor', uri: target.uri, line: target.line, column: target.column });
  }

  function revealActive() {
    var target = targetForFlatIndex(state.activeIndex);
    if (!target) { return; }
    send({ type: 'revealFile', uri: target.uri });
  }

	  function triggerSearch(forceRestart, recordHistory) {
	    var raw = $q.value;
	    var scopeRaw = $scope.value || '';
    // Preserve the query byte-for-byte. Multi-line search selections often
    // begin with indentation, and trimming that indentation changes the
    // literal search target into a different string.
	    var q = typeof raw === 'string' ? raw : '';
    trace('search:request', {
      len: q.length,
      hasNewline: q.indexOf('\\n') >= 0,
      forceRestart: !!forceRestart,
      recordHistory: !!recordHistory,
    });
	    var scopePatterns = parseScopeInput(scopeRaw);
    clearPreview();
    if (!q) {
      setShellMode(true);
      state.files = []; state.flat = []; state.activeIndex = -1; state.searching = false;
      state.rgQuery = ''; state.filterQuery = ''; state.rgScope = '';
      state.hasMoreResults = false; state.loadingMore = false;
      if (state.searchTicker) { clearInterval(state.searchTicker); state.searchTicker = null; }
      setStatus('Type a query', false);
      render();
      send({ type: 'cancel' });
      return;
    }
    setShellMode(false);
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
    if (key === 'caseSensitive') {
      state.options.caseSensitive = !state.options.caseSensitive;
      syncCaseUi();
    } else {
      state.options[key] = !state.options[key];
      btn.setAttribute('aria-pressed', String(state.options[key]));
    }
    if (key === 'useRegex') { syncRegexMultilineUi(); }
    if ($q.value) {
      refreshSearch();
    } else {
      markSearchDirty(true);
    }
  }

  function optionShortcutMatches(e, code, key) {
    return e && (e.code === code || String(e.key || '').toLowerCase() === key);
  }

  function isPlainOptionKeyAllowed(e) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) { return false; }
    var target = e.target instanceof HTMLElement ? e.target : null;
    return !!(target && target.closest('.ij-find-opts'));
  }

  function handleOptionShortcut(e) {
    if (!panel.classList.contains('visible') || e.isComposing) { return false; }
    var withModifier = !!e.altKey && !e.ctrlKey && !e.metaKey;
    var plainFromOptions = isPlainOptionKeyAllowed(e);
    if (!withModifier && !plainFromOptions) { return false; }
    if (optionShortcutMatches(e, 'KeyC', 'c')) {
      e.preventDefault();
      toggleOpt('caseSensitive', $optCase);
      return true;
    }
    if (optionShortcutMatches(e, 'KeyW', 'w')) {
      e.preventDefault();
      toggleOpt('wholeWord', $optWord);
      return true;
    }
    if (optionShortcutMatches(e, 'KeyR', 'r')) {
      e.preventDefault();
      toggleOpt('useRegex', $optRegex);
      return true;
    }
    if (optionShortcutMatches(e, 'KeyM', 'm')) {
      e.preventDefault();
      toggleOpt('regexMultiline', $optRegexMultiline);
      return true;
    }
    return false;
  }

  function moveActive(delta) {
    if (state.flat.length === 0) { return; }
    var next = state.activeIndex < 0
      ? (delta > 0 ? 0 : state.flat.length - 1)
      : Math.max(0, Math.min(state.flat.length - 1, state.activeIndex + delta));
    selectMatch(next);
  }

  on($q, 'input', function () { autosizeQuery(); markSearchDirty(); });
  on($scope, 'input', scheduleSearch);
  on($history, 'click', function (e) {
    e.preventDefault();
    toggleSearchHistory();
  });
  on($history, 'keydown', function (e) {
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
  on($historyMenu, 'click', function (e) {
    var item = e.target instanceof HTMLElement ? e.target.closest('.ij-find-history-item') : null;
    if (!item) { return; }
    e.preventDefault();
    selectSearchHistory(parseInt(item.getAttribute('data-history-index') || '-1', 10));
  });
  on($historyMenu, 'keydown', function (e) {
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
  on(document, 'mousedown', function (e) {
    if (!$historyMenu.classList.contains('open')) { return; }
    if (e.target instanceof Node && $historyWrap.contains(e.target)) { return; }
    closeSearchHistory();
  });
  on($q, 'keydown', function (e) {
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
    else if (e.key === 'Escape') { e.preventDefault(); hideSearchPanel(); }
  });
  on($scope, 'keydown', function (e) {
    if (e.key === 'Enter') {
      if (state.debounce) { clearTimeout(state.debounce); }
      e.preventDefault();
      refreshSearch();
    } else if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
    else if (e.key === 'Escape') { e.preventDefault(); hideSearchPanel(); }
  });
  on($optCase, 'click', function () { toggleOpt('caseSensitive', $optCase); });
  on($optWord, 'click', function () { toggleOpt('wholeWord', $optWord); });
  on($optRegex, 'click', function () { toggleOpt('useRegex', $optRegex); });
  on($optRegexMultiline, 'click', function () { toggleOpt('regexMultiline', $optRegexMultiline); });
  on($refresh, 'click', refreshSearch);
  function applyMinimapSetting() {
    var ed = state.previewMonacoEditor || state.monacoEditor;
    if (ed && typeof ed.updateOptions === 'function') {
      try { ed.updateOptions({ minimap: previewMinimapOptions() }); } catch (e) {}
    }
    $minimapToggle.setAttribute('aria-pressed', String(!!state.minimapEnabled));
  }
  applyMinimapSetting();
  on($minimapToggle, 'click', function (e) {
    e.preventDefault();
    state.minimapEnabled = !state.minimapEnabled;
    applyMinimapSetting();
    // Keep focus in the editor so the button click doesn't strand the user
    // with an unfocused preview (re-introduces the inactive-selection bug).
    var ed = state.previewMonacoEditor || state.monacoEditor;
    if (ed && typeof ed.focus === 'function') { try { ed.focus(); } catch (eF) {} }
  });
  on($minimize, 'click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    toggleSearchPanelMinimized();
  });
  on($close, 'click', function () { hideSearchPanel(); });
  syncCaseUi();
  syncRegexMultilineUi();
  renderSearchHistory();

  on($results, 'click', function (e) {
    var actionBtn = e.target instanceof HTMLElement ? e.target.closest('.ij-find-row-action') : null;
    if (actionBtn) {
      e.preventDefault();
      e.stopPropagation();
      var actionRow = actionBtn.closest('.ij-find-row');
      var actionFlatIdx = actionRow ? parseInt(actionRow.getAttribute('data-flat') || '-1', 10) : -1;
      if (actionFlatIdx >= 0) {
        state.activeIndex = actionFlatIdx;
        applyActive(true);
        var action = actionBtn.getAttribute('data-action') || '';
        if (action === 'open') { openActive(); }
        else if (action === 'reveal') { revealActive(); }
      }
      return;
    }
    var row = e.target instanceof HTMLElement ? e.target.closest('.ij-find-row') : null;
    if (!row) { return; }
    var flatIdx = parseInt(row.getAttribute('data-flat') || '-1', 10);
    if (flatIdx >= 0) { selectMatch(flatIdx); $q.focus(); }
  });
  on($results, 'dblclick', function (e) {
    if (e.target instanceof HTMLElement && e.target.closest('.ij-find-row-action')) { return; }
    var row = e.target instanceof HTMLElement ? e.target.closest('.ij-find-row') : null;
    if (!row) { return; }
    var flatIdx = parseInt(row.getAttribute('data-flat') || '-1', 10);
    if (flatIdx >= 0) { state.activeIndex = flatIdx; applyActive(true); openActive(); }
  });
  on($results, 'scroll', function () {
    if (state.flat.length > 0 || state.resultsInfoText) { scheduleResultsViewportRender(); }
    maybeLoadMoreResults();
  });

  function addTemporaryDocumentMouseHandlers(moveHandler, upHandler) {
    var active = true;
    function cleanup() {
      if (!active) { return; }
      active = false;
      try { document.removeEventListener('mousemove', moveHandler, true); } catch (eMoveRemove) {}
      try { document.removeEventListener('mouseup', wrappedUpHandler, true); } catch (eUpRemove) {}
    }
    function wrappedUpHandler(e) {
      try { if (typeof upHandler === 'function') { upHandler(e); } }
      finally { cleanup(); }
    }
    try {
      document.addEventListener('mousemove', moveHandler, true);
      document.addEventListener('mouseup', wrappedUpHandler, true);
      addDisposer(cleanup);
    } catch (eAddMouseHandlers) {}
    return cleanup;
  }

  // Drag header
  (function setupDrag() {
    var dragging = false;
    var startX = 0, startY = 0, origX = 0, origY = 0;
    function onMove(e) {
      if (!dragging) { return; }
      var nx = origX + (e.clientX - startX);
      var ny = origY + (e.clientY - startY);
      nx = Math.max(0, Math.min(window.innerWidth - 120, nx));
      ny = Math.max(0, Math.min(window.innerHeight - 40, ny));
      panel.style.left = nx + 'px';
      panel.style.top = ny + 'px';
    }
    function onUp() {
      dragging = false;
    }
    on($header, 'mousedown', function (e) {
      if (e.target && e.target.closest && e.target.closest('.ij-find-minimize, .ij-find-close')) { return; }
      dragging = true;
      var rect = panel.getBoundingClientRect();
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      panel.style.transform = 'none';
      startX = e.clientX; startY = e.clientY;
      origX = rect.left; origY = rect.top;
      addTemporaryDocumentMouseHandlers(onMove, onUp);
      e.preventDefault();
    });
  })();

  // Panel resize
  (function setupPanelResize() {
    var resizing = false;
    var startW = 0, startH = 0, startX = 0, startY = 0;
    function onMove(e) {
      if (!resizing) { return; }
      var w = Math.max(420, Math.min(window.innerWidth - 20, startW + (e.clientX - startX)));
      var h = Math.max(320, Math.min(window.innerHeight - 20, startH + (e.clientY - startY)));
      panel.style.width = w + 'px';
      panel.style.height = h + 'px';
    }
    function onUp() {
      resizing = false;
    }
    on($resizer, 'mousedown', function (e) {
      if (state.minimized) { return; }
      e.preventDefault(); e.stopPropagation();
      var rect = panel.getBoundingClientRect();
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      panel.style.transform = 'none';
      resizing = true;
      startW = rect.width; startH = rect.height;
      startX = e.clientX; startY = e.clientY;
      addTemporaryDocumentMouseHandlers(onMove, onUp);
    });
  })();

  // Splitter
  (function setupSplitter() {
    var splitting = false;
    var startY = 0;
    var startPreviewH = 0;
    function onMove(e) {
      if (!splitting) { return; }
      var delta = startY - e.clientY;
      var panelH = panel.getBoundingClientRect().height;
      var maxPreview = panelH - 180;
      var newH = Math.max(60, Math.min(maxPreview, startPreviewH + delta));
      $preview.style.flex = '0 0 ' + newH + 'px';
    }
    function onUp() {
      if (splitting) { splitting = false; $splitter.classList.remove('dragging'); }
    }
    on($splitter, 'mousedown', function (e) {
      e.preventDefault();
      splitting = true;
      $splitter.classList.add('dragging');
      startY = e.clientY;
      startPreviewH = $preview.getBoundingClientRect().height;
      addTemporaryDocumentMouseHandlers(onMove, onUp);
    });
  })();

  on(document, 'keydown', function (e) {
    handleOptionShortcut(e);
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
    if (window.__ijFindDisableMonacoProbes) {
      monacoState.tried = true;
      monacoState.api = null;
      monacoState.source = 'disabled';
      cb(null);
      return;
    }
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

  function previewMessageIsStale(msg) {
    if (!msg) { return false; }
    if (typeof msg.previewSeq === 'number') {
      return msg.previewSeq < state.activePreviewSeq;
    }
    if (!state.lastPreviewKey || !msg.uri) { return false; }
    var selectedUri = state.lastPreviewKey.split('#')[0] || '';
    return !!selectedUri && msg.uri !== selectedUri;
  }

  function scheduleDomPreviewRecovery(msg) {
    if (!msg || previewMessageIsStale(msg)) { return; }
    if (state.previewRecoveryTimer) {
      clearTimeout(state.previewRecoveryTimer);
      state.previewRecoveryTimer = null;
    }
    var deadline = perfNow() + 1000;
    var expectedUri = msg.uri;
    var expectedSeq = typeof msg.previewSeq === 'number' ? msg.previewSeq : null;
    var attempt = function () {
      state.previewRecoveryTimer = null;
      if (expectedSeq !== null && expectedSeq < state.activePreviewSeq) { return; }
      if (state.previewMode !== 'dom' || state.previewUri !== expectedUri || state.lastPreviewMsg !== msg) { return; }
      if (!window.__ijFindDisableMonacoProbes) {
        var m = null;
        var monacoStatus = 'disabled';
        try { monacoStatus = window.__ijFindMonacoStatus ? window.__ijFindMonacoStatus() : 'no-status'; }
        catch (eStatus) { monacoStatus = 'status-err:' + (eStatus && eStatus.message); }
        if (monacoStatus !== 'ready' && typeof window.__ijFindTestCreateWidget === 'function') {
          try { window.__ijFindTestCreateWidget(); } catch (ePromote) {}
          try { monacoStatus = window.__ijFindMonacoStatus ? window.__ijFindMonacoStatus() : monacoStatus; }
          catch (eStatusAfterPromote) {}
        }
        try { m = getMonacoFactorySingleton(); } catch (eMonaco) {}
        if (monacoStatus === 'ready' && m && m.ctor) {
          try {
            renderPreviewMonacoReal(msg);
            return;
          } catch (eRender) {
            send({ type: 'log', msg: 'preview auto-recovery render threw: ' + (eRender && eRender.message) });
          }
        }
      }
      if (perfNow() < deadline) {
        state.previewRecoveryTimer = setTimeout(attempt, 40);
      }
    };
    state.previewRecoveryTimer = setTimeout(attempt, 16);
  }

  function renderPreview(msg) {
    if (previewMessageIsStale(msg)) {
      send({ type: 'log', msg: 'ignored stale preview seq=' + msg.previewSeq + ' active=' + state.activePreviewSeq + ' uri=' + (msg.uri || '') });
      return;
    }
    if (
      state.lastPreviewMsg &&
      state.lastPreviewMsg.uri === msg.uri &&
      typeof state.lastPreviewMsg.previewSeq === 'number' &&
      typeof msg.previewSeq === 'number' &&
      state.lastPreviewMsg.previewSeq === msg.previewSeq &&
      !Array.isArray(msg.callGraphInlays) &&
      Array.isArray(state.lastPreviewMsg.callGraphInlays)
    ) {
      try { msg.callGraphInlays = state.lastPreviewMsg.callGraphInlays; } catch (eMergePreviewInlays) {}
      send({ type: 'log', msg: 'preview inlays merged into same-preview refresh uri=' + (msg.uri || '') + ' previewSeq=' + msg.previewSeq + ' count=' + msg.callGraphInlays.length });
    }
    if (msg && typeof msg.previewSeq === 'number' && msg.previewSeq > state.activePreviewSeq) {
      state.activePreviewSeq = msg.previewSeq;
    }
    if (state.previewRecoveryTimer) {
      clearTimeout(state.previewRecoveryTimer);
      state.previewRecoveryTimer = null;
    }
    state.lastPreviewMsg = msg;
    $previewPath.textContent = msg.relPath || msg.uri;
    state.previewUri = msg.uri;
    state.previewLanguageId = msg.languageId || '';
    state.previewBaseLine = typeof msg.baseLine === 'number'
      ? msg.baseLine
      : (msg.lines && msg.lines.length > 0 && typeof msg.lines[0].lineNumber === 'number' ? msg.lines[0].lineNumber : 0);
    state.previewFullFile = msg.fullFile !== false;
    $preview.classList.remove('ij-find-modified');
    var m = window.__ijFindDisableMonacoProbes ? null : getMonacoFactorySingleton();
    var monacoStatus = 'disabled';
    if (!window.__ijFindDisableMonacoProbes) {
      try { monacoStatus = window.__ijFindMonacoStatus ? window.__ijFindMonacoStatus() : 'no-status'; }
      catch (eStatus) { monacoStatus = 'status-err:' + (eStatus && eStatus.message); }
      try { m = getMonacoFactorySingleton(); } catch (eRefreshMonaco) {}
      // Cold-path warmup: when capture isn't ready yet but the workbench
      // already has a real Monaco editor mounted, try a synchronous DOM scan
      // + TEST widget promotion before falling back to renderPreviewDOM.
      // Without this, the first preview after a cold extension start spends
      // ~700-1500ms in DOM mode while the extension's capture diagnostic
      // schedules force-open; that wasted hop is exactly the pattern that
      // shows up in captain log.txt.
      if (monacoStatus !== 'ready' || !m || !m.ctor) {
        try { if (typeof window.__ijFindCaptureFromDom === 'function') { window.__ijFindCaptureFromDom(); } } catch (eDomScan) {}
        try { if (typeof window.__ijFindTestCreateWidget === 'function') { window.__ijFindTestCreateWidget(); } } catch (ePromote) {}
        try { monacoStatus = window.__ijFindMonacoStatus ? window.__ijFindMonacoStatus() : monacoStatus; }
        catch (eStatus2) {}
        try { m = getMonacoFactorySingleton(); } catch (eRefresh2) {}
      }
    }
    send({ type: 'log', msg: 'renderPreview uri=' + (msg.relPath || msg.uri).slice(0, 80) +
      ' hasMonaco=' + (!!m) +
      ' ctor=' + (!!(m && m.ctor)) +
      ' inst=' + (!!(m && m.inst)) +
      ' modelSvc=' + (!!(m && m.modelSvc)) +
      ' status=' + monacoStatus });
    if (monacoStatus === 'ready' && m && m.ctor) {
      try { renderPreviewMonacoReal(msg); return; }
      catch (e) { send({ type: 'log', msg: 'renderPreviewMonacoReal threw: ' + (e && e.message) }); }
    }
    send({ type: 'log', msg: 'renderPreview: DOM fallback' });
    renderPreviewDOM(msg);
    scheduleDomPreviewRecovery(msg);
  }

  // B-path warmup retry scheduling. Stores a single in-flight timer +
  // attempt count; resets when prewarm succeeds or the panel hides.
  var __ijFindPrewarmRetryTimer = null;
  // First retry deliberately tight (50ms) — captain log 01:14 showed
  // Monaco capture going ready right around the time the user fired
  // their first click (~500ms after show). Anything longer and the user
  // beats prewarm to it. Later retries back off normally so a tab that
  // truly has no Monaco doesn't churn.
  var __ijFindPrewarmRetryDelays = [50, 200, 400, 800, 1600];
  function schedulePrewarmRetry(reason) {
    try {
      if (__ijFindPrewarmRetryTimer) { return; }
      if (state.previewMonacoEditor) { return; }
      if (!$previewBody || !$previewBody.isConnected) { return; }
      var attempt = (state.previewPrewarmAttempts || 0);
      if (attempt >= __ijFindPrewarmRetryDelays.length) {
        trace('preview/prewarm/retry-give-up', { attempts: attempt, source: String(reason || '') });
        return;
      }
      var delay = __ijFindPrewarmRetryDelays[attempt];
      state.previewPrewarmAttempts = attempt + 1;
      trace('preview/prewarm/retry-scheduled', { attempt: attempt + 1, delayMs: delay, source: String(reason || '') });
      __ijFindPrewarmRetryTimer = setTimeout(function () {
        __ijFindPrewarmRetryTimer = null;
        try { prewarmPreviewMonacoEditor('retry#' + (attempt + 1) + ':' + (reason || '')); } catch (eRetry) {}
      }, delay);
    } catch (eSched) {}
  }
  function cancelPrewarmRetry() {
    try {
      if (__ijFindPrewarmRetryTimer) {
        clearTimeout(__ijFindPrewarmRetryTimer);
        __ijFindPrewarmRetryTimer = null;
      }
      state.previewPrewarmAttempts = 0;
    } catch (eCancel) {}
  }

  // B-path warmup: create the preview Monaco editor up-front so the
  // user's first result-row click does NOT pay the cold create cost
  // (~124ms in captain). Subsequent renders take the reuse path via
  // canReuse=true in renderPreviewMonacoReal. Safe to call multiple
  // times; bails out if an editor already exists, Monaco is not yet
  // captured, or $previewBody is unavailable. When Monaco is not ready,
  // schedules a backoff retry — see schedulePrewarmRetry above.
  function prewarmPreviewMonacoEditor(reason) {
    try {
      if (state.previewMonacoEditor) {
        trace('preview/prewarm/skip', { reason: 'already-have-editor', source: String(reason || '') });
        return;
      }
      if (!$previewBody || !$previewBody.isConnected) {
        trace('preview/prewarm/skip', { reason: 'no-preview-body', source: String(reason || '') });
        return;
      }
      if (window.__ijFindDisableMonacoProbes) {
        trace('preview/prewarm/skip', { reason: 'monaco-probes-disabled', source: String(reason || '') });
        return;
      }
      var monacoStatus = 'disabled';
      try { monacoStatus = window.__ijFindMonacoStatus ? window.__ijFindMonacoStatus() : 'no-status'; }
      catch (eStatus) { monacoStatus = 'status-err:' + (eStatus && eStatus.message); }
      var factory = null;
      try { factory = getMonacoFactorySingleton(); } catch (eFactory) {}
      if (monacoStatus !== 'ready' || !factory || !factory.ctor) {
        // Captain log 00:42 showed both first-show prewarms skip here:
        // monacoStatus=not-ready:none, hasFactory=false. Capture is lazy
        // and happens after the panel paints. Re-schedule a backoff retry
        // so prewarm eventually fires once Monaco is captured — without
        // this the first user click STILL pays the cold create cost.
        // Cap at ~3s total (200, 400, 800, 1600ms) so a tab without any
        // captured Monaco doesn't churn forever.
        trace('preview/prewarm/skip', { reason: 'monaco-not-ready', monacoStatus: monacoStatus, hasFactory: !!factory, source: String(reason || '') });
        schedulePrewarmRetry(reason);
        return;
      }
      var warmT0 = perfNow();
      var host = document.createElement('div');
      host.className = 'ij-find-monaco-preview-host';
      host.style.cssText = 'width:100%;height:100%;overflow:hidden;';
      $previewBody.appendChild(host);
      $previewBody.classList.add('ij-find-editor-mounted');
      var editor = null;
      try { editor = createPreviewEditor(host); } catch (eCreate) {
        send({ type: 'log', msg: 'prewarm createPreviewEditor threw: ' + (eCreate && eCreate.message) });
      }
      if (!editor) {
        try { $previewBody.removeChild(host); } catch (eRemoveHost) {}
        $previewBody.classList.remove('ij-find-editor-mounted');
        trace('preview/prewarm/skip', { reason: 'create-failed', source: String(reason || '') });
        return;
      }
      state.previewMonacoEditor = editor;
      state.previewMonacoHost = host;
      // Leave previewMode empty so renderPreview() still treats the first
      // real message as "first render" semantically — but canReuse is
      // checked against (previewMonacoEditor && host && host.parentElement
      // === $previewBody), which is now TRUE. The first real preview will
      // take the reuse path: setPreviewContent swaps in the actual model.
      try {
        var rect = host.getBoundingClientRect();
        editor.layout({ width: Math.max(0, Math.floor(rect.width)), height: Math.max(0, Math.floor(rect.height)) });
      } catch (eLayout) {}
      trace('preview/prewarm/done', {
        source: String(reason || ''),
        elapsedMs: Math.round(perfNow() - warmT0),
        attempts: (state.previewPrewarmAttempts || 0),
      });
      cancelPrewarmRetry();
    } catch (eOuter) {
      send({ type: 'log', msg: 'prewarm outer err: ' + (eOuter && eOuter.message) });
    }
  }

  // Test hook: lets E2E tests force a prewarm attempt without bouncing
  // through showSearchPanel's setTimeout(0). Intentionally only exposed
  // under the renderer test API namespace so production code paths
  // continue to go through showSearchPanel.
  try {
    window.__ijFindForceTestPrewarm = function (reason) {
      try { prewarmPreviewMonacoEditor(reason || 'test'); return 'ok'; }
      catch (eForce) { return 'err:' + String(eForce && eForce.message || eForce).slice(0, 120); }
    };
  } catch (eExposePrewarm) {}

  // Diagnostic snapshot of the embed preview editor's language-feature
  // surface: isSimpleWidget flag, model URI scheme/language, line count,
  // hover/contentHover contribution presence, and any contentHover widget
  // currently in the DOM. Gives ground evidence for tracking #2
  // (Pylance hover/autocomplete not appearing in preview). All checks
  // are best-effort — Monaco internals shift across versions.
  function gatherEmbedEditorIntellisenseSnapshot(editor) {
    var out = {
      enablePreviewLanguageFeatures: !!__ijFindEnablePreviewLanguageFeatures,
      hasEditor: !!editor,
      isSimpleWidget: null,
      modelScheme: '',
      modelLanguage: '',
      modelLineCount: -1,
      hasContentHoverContrib: false,
      contentHoverWidgetCount: 0,
    };
    if (!editor) { return out; }
    try {
      // CodeEditorWidget exposes _configuration with options. The simple
      // widget flag is on a separate option key (EditorOption isSimpleWidget
      // in modern builds). Fall back to a direct property probe — recent
      // VSCode keeps it on the widget instance under isSimpleWidget via
      // the constructor option.
      if (typeof editor.isSimpleWidget === 'boolean') {
        out.isSimpleWidget = editor.isSimpleWidget;
      } else if (editor._configuration && editor._configuration.options) {
        // EditorOption.isSimpleWidget is an enum; try string key first.
        try { out.isSimpleWidget = !!editor._configuration.options.get('isSimpleWidget'); }
        catch (eOptGet) {}
      }
    } catch (eSimpleProbe) {}
    try {
      var model = editor.getModel && editor.getModel();
      if (model && model.uri) { out.modelScheme = String(model.uri.scheme || ''); }
      if (model && typeof model.getLanguageId === 'function') { out.modelLanguage = String(model.getLanguageId() || ''); }
      else if (model && typeof model.getModeId === 'function') { out.modelLanguage = String(model.getModeId() || ''); }
      if (model && typeof model.getLineCount === 'function') { out.modelLineCount = model.getLineCount(); }
    } catch (eModelProbe) {}
    try {
      if (typeof editor.getContribution === 'function') {
        out.hasContentHoverContrib = !!(editor.getContribution('editor.contrib.contentHover')
          || editor.getContribution('editor.contrib.hover'));
      }
    } catch (eContribProbe) {}
    try {
      out.contentHoverWidgetCount = document.querySelectorAll('.monaco-hover,.monaco-editor-hover,.content-hover-widget').length;
    } catch (eHoverDomProbe) {}
    return out;
  }
  // Expose for future test instrumentation (no production use).
  try { window.__ijFindGatherEmbedEditorIntellisenseSnapshot = gatherEmbedEditorIntellisenseSnapshot; } catch (eExposeIs) {}

  function renderPreviewMonacoReal(msg) {
    var renderT0 = perfNow();
    if (state.stolenEditor) { restoreStolenEditor(); }
    var fullText = (msg.lines || []).map(function (l) { return l.text; }).join('\\n');
    var lang = msg.languageId || 'plaintext';
    var canReuse = !!(state.previewMonacoEditor && state.previewMonacoHost && state.previewMonacoHost.parentElement === $previewBody);
    // Whenever the user lands on a different URI, the hydrate trip has to
    // run again on the new model. Reset previewHydrated so our fast-path
    // absolute callgraph layer renders inlays for the first 250ms before
    // the native InlayHintsController takes over.
    if (msg && msg.uri && msg.uri !== state.lastRenderedPreviewUri) {
      state.previewHydrated = false;
    }
    send({ type: 'log', msg: 'monacoReal lines=' + (msg.lines ? msg.lines.length : 0) + ' lang=' + lang + ' reuse=' + canReuse });
    // Snapshot the leak-prone counters BEFORE rendering so the trace can
    // attribute any growth to this exact render.
    var preMonacoHovers = 0;
    var preIjRoots = 0;
    try {
      preMonacoHovers = document.querySelectorAll('.monaco-hover,.monaco-editor-hover').length;
      preIjRoots = document.querySelectorAll('[data-ijss-root="true"]').length;
    } catch (ePreDom) {}
    trace('preview/render/start', {
      uri: msg && msg.uri ? String(msg.uri) : '',
      canReuse: canReuse,
      lines: msg && msg.lines ? msg.lines.length : 0,
      lang: lang,
      preMonacoHovers: preMonacoHovers,
      preIjRoots: preIjRoots,
    });
    // Reuse existing widget if it's still mounted in our preview body.
    if (canReuse) {
      // Same-URI rerender (capture refresh, lspPressure hydrate, repeated
      // requestPreview for the SAME match line, etc.) should not yank
      // the user's scroll position back. Save the viewState before the
      // model swap and restore it after instead of calling revealMatch.
      // BUT if the user clicked a different result on the same file
      // (different focusLine), the new match line might be 100 lines
      // below — in that case we MUST scroll to it. #46 fix: only treat
      // as "same refresh" when focusLine is also unchanged.
      var msgFocusLine = (msg && typeof msg.focusLine === 'number') ? msg.focusLine : -1;
      var isSameUriRefresh = state.lastRenderedPreviewUri === msg.uri
        && state.lastRenderedPreviewFocusLine === msgFocusLine;
      var savedViewState = null;
      if (isSameUriRefresh) {
        try { savedViewState = state.previewMonacoEditor.saveViewState && state.previewMonacoEditor.saveViewState(); }
        catch (eSaveVs) {}
      }
      var setT0 = perfNow();
      var ok = setPreviewContent(state.previewMonacoEditor, fullText, lang, msg.uri, state.previewFullFile);
      var setMs = Math.round(perfNow() - setT0);
      send({ type: 'log', msg: 'monacoReal reuse setModel=' + ok + ' sameUriRefresh=' + isSameUriRefresh });
      if (ok) {
        var layoutT0 = perfNow();
        try {
          var rect = state.previewMonacoHost.getBoundingClientRect();
          state.previewMonacoEditor.layout({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
        } catch (e) {}
        var layoutMs = Math.round(perfNow() - layoutT0);
        wirePreviewMonacoEditor(state.previewMonacoEditor);
        var decoT0 = perfNow();
        applyPreviewMatchDecorations(state.previewMonacoEditor, msg);
        var decoMs = Math.round(perfNow() - decoT0);
        if (isSameUriRefresh && savedViewState) {
          try { state.previewMonacoEditor.restoreViewState && state.previewMonacoEditor.restoreViewState(savedViewState); }
          catch (eRestoreVs) {}
        } else {
          try { revealMatchImmediate(state.previewMonacoEditor, msg); } catch (e) {}
          placeCursorAtMatch(state.previewMonacoEditor, msg);
        }
        var inlayT0 = perfNow();
        renderPreviewMonacoCallGraphInlays(state.previewMonacoEditor, msg);
        var inlayMs = Math.round(perfNow() - inlayT0);
        state.previewMode = 'monaco';
        state.lastRenderedPreviewUri = msg.uri;
        state.lastRenderedPreviewFocusLine = msgFocusLine;
        scheduleSettledPreviewHydrate();
        var postReuseMonacoHovers = 0;
        var postReuseIjRoots = 0;
        try {
          postReuseMonacoHovers = document.querySelectorAll('.monaco-hover,.monaco-editor-hover').length;
          postReuseIjRoots = document.querySelectorAll('[data-ijss-root="true"]').length;
        } catch (ePostReuse) {}
        trace('preview/render/done', {
          path: 'reuse',
          uri: msg && msg.uri ? String(msg.uri) : '',
          sameUriRefresh: isSameUriRefresh,
          totalMs: Math.round(perfNow() - renderT0),
          setContentMs: setMs,
          layoutMs: layoutMs,
          decorationsMs: decoMs,
          inlaysMs: inlayMs,
          postMonacoHovers: postReuseMonacoHovers,
          postIjRoots: postReuseIjRoots,
          deltaHovers: postReuseMonacoHovers - preMonacoHovers,
          deltaIjRoots: postReuseIjRoots - preIjRoots,
          intellisense: gatherEmbedEditorIntellisenseSnapshot(state.previewMonacoEditor),
        });
        return;
      }
    }
    // CREATE path: about to replace the host with a fresh editor. If we
    // had a previous Monaco preview editor, its hover/overflow widgets are
    // anchored to a SHARED overflow host on document.body, NOT to
    // $previewBody — so clearing $previewBody removes the editor's DOM but
    // leaks the hover widget and view zones because we never call
    // editor.dispose(). Trace this gap so we can measure how many leaks
    // accumulate per session and prove the hypothesis before plugging it.
    var hadPriorEditor = !!state.previewMonacoEditor;
    trace('preview/render/create-prep', {
      hadPriorEditor: hadPriorEditor,
      // Intentionally NOT disposing the prior editor here yet — see [[project-preview-hover-arch]].
      // We're instrumenting first so the leak shows up in the trace, then the
      // E2E pins it, then we fix.
      priorEditorDisposed: false,
    });
    clearChildren($previewBody);
    $previewBody.classList.add('ij-find-editor-mounted');
    var host = document.createElement('div');
    host.className = 'ij-find-monaco-preview-host';
    host.style.cssText = 'width:100%;height:100%;overflow:hidden;';
    $previewBody.appendChild(host);
    var hostRect = host.getBoundingClientRect();
    send({ type: 'log', msg: 'monacoReal host rect=' + Math.round(hostRect.width) + 'x' + Math.round(hostRect.height) });
    var createT0 = perfNow();
    var editor = createPreviewEditor(host);
    var createMs = Math.round(perfNow() - createT0);
    send({ type: 'log', msg: 'monacoReal createPreviewEditor → ' + (editor ? 'OK ' + (editor.constructor && editor.constructor.name) : 'null') });
    if (!editor) {
      try { $previewBody.removeChild(host); } catch (e) {}
      $previewBody.classList.remove('ij-find-editor-mounted');
      trace('preview/render/done', {
        path: 'create-failed',
        uri: msg && msg.uri ? String(msg.uri) : '',
        totalMs: Math.round(perfNow() - renderT0),
        createMs: createMs,
      });
      renderPreviewDOM(msg);
      scheduleDomPreviewRecovery(msg);
      return;
    }
    state.previewMonacoEditor = editor;
    state.previewMonacoHost = host;
    state.previewMode = 'monaco';
    var setNewT0 = perfNow();
    var setOk = setPreviewContent(editor, fullText, lang, msg.uri, state.previewFullFile);
    var setNewMs = Math.round(perfNow() - setNewT0);
    send({ type: 'log', msg: 'monacoReal setPreviewContent=' + setOk });
    wirePreviewMonacoEditor(editor);
    var layoutNewT0 = perfNow();
    try {
      var r2 = host.getBoundingClientRect();
      editor.layout({ width: Math.floor(r2.width), height: Math.floor(r2.height) });
    } catch (e) {}
    var layoutNewMs = Math.round(perfNow() - layoutNewT0);
    // Apply decorations BEFORE reveal so they're painted in the same frame
    // the viewport lands — otherwise the user sees scrolling-to-match and
    // then a subsequent flash when highlights appear.
    var decoNewT0 = perfNow();
    applyPreviewMatchDecorations(editor, msg);
    var decoNewMs = Math.round(perfNow() - decoNewT0);
    try { revealMatchImmediate(editor, msg); } catch (e) {}
    placeCursorAtMatch(editor, msg);
    var inlayNewT0 = perfNow();
    renderPreviewMonacoCallGraphInlays(editor, msg);
    var inlayNewMs = Math.round(perfNow() - inlayNewT0);
    state.lastRenderedPreviewUri = msg.uri;
    state.lastRenderedPreviewFocusLine = msgFocusLine;
    scheduleSettledPreviewHydrate();
    var postCreateMonacoHovers = 0;
    var postCreateIjRoots = 0;
    try {
      postCreateMonacoHovers = document.querySelectorAll('.monaco-hover,.monaco-editor-hover').length;
      postCreateIjRoots = document.querySelectorAll('[data-ijss-root="true"]').length;
    } catch (ePostCreate) {}
    trace('preview/render/done', {
      path: 'create',
      uri: msg && msg.uri ? String(msg.uri) : '',
      hadPriorEditor: hadPriorEditor,
      priorEditorDisposed: false,
      totalMs: Math.round(perfNow() - renderT0),
      createMs: createMs,
      setContentMs: setNewMs,
      layoutMs: layoutNewMs,
      decorationsMs: decoNewMs,
      inlaysMs: inlayNewMs,
      postMonacoHovers: postCreateMonacoHovers,
      postIjRoots: postCreateIjRoots,
      deltaHovers: postCreateMonacoHovers - preMonacoHovers,
      deltaIjRoots: postCreateIjRoots - preIjRoots,
      intellisense: gatherEmbedEditorIntellisenseSnapshot(editor),
    });
    // Post-render check
    try {
      var vl = editor.getDomNode && editor.getDomNode() && editor.getDomNode().querySelectorAll('.view-line');
      send({ type: 'log', msg: 'monacoReal rendered viewLines=' + (vl ? vl.length : '?') });
    } catch (e) {}
  }

  function savePreviewMonacoModel() {
    try {
      var ed = state.previewMonacoEditor || state.monacoEditor;
      var model = ed && ed.getModel && ed.getModel();
      if (!model || !state.previewUri) {
        send({ type: 'log', msg: 'preview save skipped: no model or uri' });
        return;
      }
      var content = model.getValue ? model.getValue() : '';
      send({ type: 'log', msg: 'preview save requested uri=' + state.previewUri + ' bytes=' + content.length });
      send({ type: 'saveFile', uri: state.previewUri, content: content });
      $preview.classList.remove('ij-find-modified');
    } catch (eSavePreview) {
      send({ type: 'log', msg: 'preview save threw: ' + (eSavePreview && eSavePreview.message) });
    }
  }

  function registerPreviewSaveKeybinding(editor) {
    if (!editor || state.previewMonacoSaveEditor === editor) { return; }
    state.previewMonacoSaveEditor = editor;
    try {
      if (state.previewMonacoKeydownListener && state.previewMonacoKeydownListener.dispose) {
        state.previewMonacoKeydownListener.dispose();
      }
    } catch (eDisposeKey) {}
    state.previewMonacoKeydownListener = null;
    try {
      if (typeof editor.addCommand === 'function') {
        editor.addCommand(2048 | 49, savePreviewMonacoModel);
        send({ type: 'log', msg: 'preview save command registered' });
      }
    } catch (eAddCommand) {
      send({ type: 'log', msg: 'preview addCommand save failed: ' + (eAddCommand && eAddCommand.message) });
    }
    try {
      var node = editor.getDomNode && editor.getDomNode();
      if (!node || !node.addEventListener) { return; }
      var handler = function (event) {
        if (!event) { return; }
        var key = String(event.key || '').toLowerCase();
        if ((event.metaKey || event.ctrlKey) && key === 's') {
          try {
            event.preventDefault();
            event.stopPropagation();
          } catch (eStopSave) {}
          savePreviewMonacoModel();
        }
      };
      node.addEventListener('keydown', handler, true);
      state.previewMonacoKeydownListener = {
        dispose: function () {
          try { node.removeEventListener('keydown', handler, true); } catch (eRemoveSave) {}
        },
      };
    } catch (eKeyListener) {
      send({ type: 'log', msg: 'preview save key listener failed: ' + (eKeyListener && eKeyListener.message) });
    }
  }

  function teardownPreviewMonacoHealObserver() {
    try {
      if (state.previewMonacoHealObserver && typeof state.previewMonacoHealObserver.disconnect === 'function') {
        state.previewMonacoHealObserver.disconnect();
      }
    } catch (eHealTeardown) {}
    state.previewMonacoHealObserver = null;
    state.previewMonacoHealPending = false;
  }

  function wirePreviewMonacoHealObserver(editor, host) {
    // Watch the preview host: if the workbench tears the editor DOM out from
    // under us (which happens when a click inside the editor causes some
    // workbench service to dispose its view/model without calling
    // editor.dispose), re-render the preview from the last message so the
    // user sees content again. isSimpleWidget=true alone doesn't prevent the
    // takeover, so we recover instead of trying to block it.
    teardownPreviewMonacoHealObserver();
    if (typeof MutationObserver !== 'function' || !host || !editor) { return; }
    try {
      var observer = new MutationObserver(function () {
        if (state.previewMonacoHealPending) { return; }
        if (state.previewMonacoEditor !== editor) { return; }
        var dom = null;
        try { dom = typeof editor.getDomNode === 'function' ? editor.getDomNode() : null; } catch (eDomHeal) {}
        if (dom && dom.parentElement === host) { return; }
        state.previewMonacoHealPending = true;
        var now = perfNow();
        var sinceLast = now - (state.previewMonacoHealLastAt || 0);
        state.previewMonacoHealLastAt = now;
        // Cap recursion: if heals keep firing back-to-back, give up and fall
        // through to DOM mode rather than burn CPU re-creating editors that
        // get torn down again on the very next focus event.
        if (sinceLast < 500) {
          state.previewMonacoHealRecursion++;
        } else {
          state.previewMonacoHealRecursion = 0;
        }
        var lastMsg = state.lastPreviewMsg;
        if (state.previewMonacoHealRecursion >= 3 || !lastMsg) {
          teardownPreviewMonacoHealObserver();
          if (state.previewMonacoHealRecursion >= 3) {
            try { send({ type: 'log', msg: 'preview monaco self-heal giving up after repeated detach' }); } catch (eGiveUp) {}
          }
          state.previewMonacoHealPending = false;
          return;
        }
        // Forget the broken editor instance so renderPreviewMonacoReal
        // recreates a fresh widget instead of trying to reuse the orphaned
        // one. The host element itself remains under $previewBody.
        state.previewMonacoEditor = null;
        Promise.resolve().then(function () {
          try {
            renderPreviewMonacoReal(lastMsg);
          } catch (eHealRender) {
            try { send({ type: 'log', msg: 'preview monaco self-heal render threw: ' + (eHealRender && eHealRender.message) }); } catch (eHealLog) {}
          } finally {
            state.previewMonacoHealPending = false;
          }
        });
      });
      observer.observe(host, { childList: true });
      state.previewMonacoHealObserver = observer;
    } catch (eHealWire) {
      try { send({ type: 'log', msg: 'preview monaco self-heal wire failed: ' + (eHealWire && eHealWire.message) }); } catch (eHealLogWire) {}
    }
  }

  function teardownPreviewMonacoDiagnostics() {
    try {
      var d = state.previewMonacoDiagDisposers || [];
      for (var i = 0; i < d.length; i++) {
        try { if (d[i] && typeof d[i].dispose === 'function') { d[i].dispose(); } }
        catch (eDispDiag) {}
      }
    } catch (eDiagTeardown) {}
    state.previewMonacoDiagDisposers = [];
    try {
      if (state.previewMonacoDiagObserver && typeof state.previewMonacoDiagObserver.disconnect === 'function') {
        state.previewMonacoDiagObserver.disconnect();
      }
    } catch (eDiagObs) {}
    state.previewMonacoDiagObserver = null;
  }

  function snapshotPreviewMonacoState(label, extra) {
    try {
      var ed = state.previewMonacoEditor;
      var host = state.previewMonacoHost;
      var dom = ed && typeof ed.getDomNode === 'function' ? ed.getDomNode() : null;
      var hostInBody = !!(host && host.parentElement === $previewBody);
      var domInHost = !!(host && dom && (dom.parentElement === host || (dom.parentNode && dom.parentNode === host)));
      var viewLines = 0;
      try {
        if (dom && dom.querySelectorAll) {
          viewLines = dom.querySelectorAll('.view-line').length;
        }
      } catch (eVl) {}
      var rect = null;
      try { if (host && host.getBoundingClientRect) { rect = host.getBoundingClientRect(); } } catch (eRect) {}
      var modelOk = false;
      try { modelOk = !!(ed && typeof ed.getModel === 'function' && ed.getModel()); } catch (eMo) {}
      var bodyChildren = 0;
      try { bodyChildren = $previewBody ? $previewBody.childElementCount : -1; } catch (eBc) {}
      var snap = {
        label: String(label || ''),
        hostInBody: hostInBody,
        domInHost: domInHost,
        viewLines: viewLines,
        modelOk: modelOk,
        bodyChildren: bodyChildren,
        hostW: rect ? Math.round(rect.width) : -1,
        hostH: rect ? Math.round(rect.height) : -1,
        activeEl: document.activeElement && document.activeElement.tagName ? document.activeElement.tagName.toLowerCase() : 'none',
        activeCls: document.activeElement && document.activeElement.className ? String(document.activeElement.className).slice(0, 60) : '',
        previewMode: state.previewMode || '',
      };
      if (extra && typeof extra === 'object') {
        for (var k in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, k)) { snap[k] = extra[k]; }
        }
      }
      trace('previewDiag:snap', snap);
    } catch (eSnap) {
      try { trace('previewDiag:snap-err', { label: String(label || ''), err: String(eSnap && eSnap.message || eSnap).slice(0, 120) }); } catch (eSendErr) {}
    }
  }

  function wirePreviewMonacoDiagnostics(editor) {
    teardownPreviewMonacoDiagnostics();
    if (!editor) { return; }
    var disposers = [];
    var safeOn = function (eventName) {
      try {
        if (typeof editor[eventName] === 'function') {
          return editor[eventName];
        }
      } catch (eName) {}
      return null;
    };
    try {
      var onFocus = safeOn('onDidFocusEditorWidget');
      if (onFocus) {
        disposers.push(onFocus.call(editor, function () {
          trace('previewDiag:event', { name: 'focusEditorWidget' });
          snapshotPreviewMonacoState('focus');
        }));
      }
    } catch (eFocus) {
      trace('previewDiag:wire-err', { hook: 'focus', err: String(eFocus && eFocus.message).slice(0, 120) });
    }
    try {
      var onBlur = safeOn('onDidBlurEditorWidget');
      if (onBlur) {
        disposers.push(onBlur.call(editor, function () {
          trace('previewDiag:event', { name: 'blurEditorWidget' });
          snapshotPreviewMonacoState('blur');
        }));
      }
    } catch (eBlur) {
      trace('previewDiag:wire-err', { hook: 'blur', err: String(eBlur && eBlur.message).slice(0, 120) });
    }
    try {
      var onSel = safeOn('onDidChangeCursorSelection');
      if (onSel) {
        var selSeq = 0;
        disposers.push(onSel.call(editor, function (e) {
          selSeq++;
          if (selSeq > 4) { return; } // throttle so a drag-select doesn't flood the log
          var src = e && e.source ? String(e.source) : '?';
          var hasSel = false;
          try {
            var s = e && e.selection;
            hasSel = !!(s && (s.startLineNumber !== s.endLineNumber || s.startColumn !== s.endColumn));
          } catch (eSelInfo) {}
          trace('previewDiag:event', { name: 'cursorSelection', source: src, hasSel: hasSel, seq: selSeq });
          snapshotPreviewMonacoState('cursorSelection#' + selSeq);
        }));
      }
    } catch (eSel) {
      trace('previewDiag:wire-err', { hook: 'selection', err: String(eSel && eSel.message).slice(0, 120) });
    }
    try {
      var onLayout = safeOn('onDidLayoutChange');
      if (onLayout) {
        var layoutSeq = 0;
        disposers.push(onLayout.call(editor, function (e) {
          layoutSeq++;
          if (layoutSeq > 6) { return; }
          var w = e && typeof e.width === 'number' ? Math.round(e.width) : -1;
          var h = e && typeof e.height === 'number' ? Math.round(e.height) : -1;
          trace('previewDiag:event', { name: 'layoutChange', w: w, h: h, seq: layoutSeq });
          if (w === 0 || h === 0) { snapshotPreviewMonacoState('layoutZero', { w: w, h: h }); }
        }));
      }
    } catch (eLayout) {
      trace('previewDiag:wire-err', { hook: 'layout', err: String(eLayout && eLayout.message).slice(0, 120) });
    }
    try {
      var onDispose = safeOn('onDidDispose');
      if (onDispose) {
        disposers.push(onDispose.call(editor, function () {
          trace('previewDiag:event', { name: 'editorDispose' });
          snapshotPreviewMonacoState('editorDispose');
        }));
      }
    } catch (eDisp) {
      trace('previewDiag:wire-err', { hook: 'dispose', err: String(eDisp && eDisp.message).slice(0, 120) });
    }
    try {
      if (typeof MutationObserver === 'function' && $previewBody) {
        var lastReport = 0;
        var mutationSeq = 0;
        var observer = new MutationObserver(function (records) {
          var now = perfNow();
          for (var i = 0; i < records.length; i++) {
            var rec = records[i];
            var removed = rec.removedNodes ? rec.removedNodes.length : 0;
            var added = rec.addedNodes ? rec.addedNodes.length : 0;
            if (!removed && !added) { continue; }
            var targetCls = '';
            try { targetCls = rec.target && rec.target.className ? String(rec.target.className).slice(0, 80) : ''; } catch (eTc) {}
            if (now - lastReport < 100) { continue; }
            lastReport = now;
            mutationSeq++;
            trace('previewDiag:event', { name: 'mutation', target: targetCls, removed: removed, added: added, seq: mutationSeq });
            snapshotPreviewMonacoState('mutation#' + mutationSeq);
          }
        });
        observer.observe($previewBody, { childList: true, subtree: true });
        state.previewMonacoDiagObserver = observer;
      }
    } catch (eObs) {
      trace('previewDiag:wire-err', { hook: 'mutation', err: String(eObs && eObs.message).slice(0, 120) });
    }
    try {
      var dom = typeof editor.getDomNode === 'function' ? editor.getDomNode() : null;
      if (dom && dom.addEventListener) {
        var pointerHandler = function (ev) {
          trace('previewDiag:event', { name: 'pointerdown', button: ev.button, shift: !!ev.shiftKey });
          snapshotPreviewMonacoState('pointerdown');
        };
        dom.addEventListener('pointerdown', pointerHandler, true);
        disposers.push({
          dispose: function () {
            try { dom.removeEventListener('pointerdown', pointerHandler, true); } catch (eRm) {}
          },
        });
      }
    } catch (ePtr) {
      trace('previewDiag:wire-err', { hook: 'pointerdown', err: String(ePtr && ePtr.message).slice(0, 120) });
    }
    state.previewMonacoDiagDisposers = disposers;
    snapshotPreviewMonacoState('wired');
  }

  function wirePreviewMonacoEditor(editor) {
    registerPreviewSaveKeybinding(editor);
    try {
      if (editor && typeof editor.updateOptions === 'function') {
        editor.updateOptions({
          fixedOverflowWidgets: true,
          overflowWidgetsDomNode: getOrCreatePreviewOverflowHost(),
          hover: previewHoverOptions(),
          inlayHints: previewInlayHintsOptions(),
        });
      }
    } catch (eOptions) {
      send({ type: 'log', msg: 'preview editor option refresh failed: ' + (eOptions && eOptions.message) });
    }
    try {
      if (state.monacoChangeListener && state.monacoChangeListener.dispose) {
        state.monacoChangeListener.dispose();
      }
    } catch (eDisposeChange) {}
    state.monacoChangeListener = null;
    try {
      var model = editor && editor.getModel && editor.getModel();
      if (model && typeof model.onDidChangeContent === 'function') {
        state.monacoChangeListener = model.onDidChangeContent(function () {
          $preview.classList.add('ij-find-modified');
        });
      }
    } catch (eChangeListener) {
      send({ type: 'log', msg: 'preview change listener failed: ' + (eChangeListener && eChangeListener.message) });
    }
    wirePreviewMonacoDiagnostics(editor);
    wirePreviewMonacoHealObserver(editor, state.previewMonacoHost);
    wirePreviewIntellisenseProbes(editor);
  }

  // Live signal for #47: when the user lingers >= 350ms over a token
  // in the preview, do TWO things:
  //   1. Emit a hover-linger trace with the embed editor's diagnostic
  //      snapshot so the next captain log shows the editor state.
  //   2. Ask the extension host (via requestIntellisenseProbe) to run
  //      vscode.executeHoverProvider + executeCompletionItemProvider
  //      against the SAME position — giving us automatic ground-truth
  //      without the human needing to invoke a command. Output appears
  //      as "[diag-auto] preview-intellisense ..." in the log.
  //
  // Renderer-side dedupe per (uri, line, col, 3s) so a single position
  // doesn't generate dozens of probes when multiple listeners fire.
  var __ijFindIntellisenseProbeRecent = Object.create(null);
  function wirePreviewIntellisenseProbes(editor) {
    try {
      if (!editor || typeof editor.onMouseMove !== 'function') { return; }
      // wirePreviewMonacoEditor runs on every render (both create and
      // reuse paths). Without this guard each render adds another
      // mouseMove listener, multiplying probes per real hover.
      if (editor.__ijFindIntellisenseProbeWired === true) { return; }
      try { editor.__ijFindIntellisenseProbeWired = true; } catch (eFlag) {}
      var lingerTimer = null;
      var lastPos = null;
      function clearTimer() {
        if (lingerTimer) {
          try { clearTimeout(lingerTimer); } catch (eClearTm) {}
          lingerTimer = null;
        }
      }
      var disposable = editor.onMouseMove(function (e) {
        var target = e && e.target;
        var pos = target && target.position;
        if (!pos || typeof pos.lineNumber !== 'number') { clearTimer(); return; }
        if (lastPos && lastPos.lineNumber === pos.lineNumber && lastPos.column === pos.column) { return; }
        lastPos = { lineNumber: pos.lineNumber, column: pos.column };
        clearTimer();
        lingerTimer = setTimeout(function () {
          try {
            var snapshot = gatherEmbedEditorIntellisenseSnapshot(editor);
            var widgetVisible = false;
            var widgetClasses = [];
            try {
              var hovers = document.querySelectorAll('.monaco-hover,.monaco-editor-hover,.content-hover-widget');
              for (var hi = 0; hi < hovers.length; hi++) {
                var visible = (hovers[hi].offsetParent !== null) || (hovers[hi].getBoundingClientRect && hovers[hi].getBoundingClientRect().height > 0);
                if (visible) {
                  widgetVisible = true;
                  widgetClasses.push(((hovers[hi].className || '') + '').slice(0, 80));
                  break;
                }
              }
            } catch (eHoverDom) {}
            // Convert Monaco's 1-based lineNumber/column to extension
            // host's 0-based line/character.
            var line0 = Math.max(0, (pos.lineNumber || 1) - 1);
            var col0 = Math.max(0, (pos.column || 1) - 1);
            trace('preview/intellisense/hover-linger', {
              line: pos.lineNumber,
              column: pos.column,
              hoverWidgetVisibleAfter350ms: widgetVisible,
              hoverWidgetClasses: widgetClasses,
              snapshot: snapshot,
            });
            // Auto ground-truth probe (host-side dedupe handles bursts).
            try {
              var uriStr = snapshot && snapshot.modelScheme === 'file' && state.previewUri ? state.previewUri : '';
              if (uriStr) {
                var probeKey = uriStr + '|' + line0 + '|' + col0;
                var nowTs = Date.now();
                var prev = __ijFindIntellisenseProbeRecent[probeKey] || 0;
                if (nowTs - prev > 3000) {
                  __ijFindIntellisenseProbeRecent[probeKey] = nowTs;
                  send({
                    type: 'requestIntellisenseProbe',
                    uri: uriStr,
                    line: line0,
                    column: col0,
                    source: 'hover-linger',
                  });
                }
              }
            } catch (eProbeReq) {}
          } catch (eFire) {}
        }, 350);
      });
      addDisposer(function () {
        clearTimer();
        try { disposable && disposable.dispose && disposable.dispose(); } catch (eDisp) {}
      });
    } catch (eWireProbe) {}
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
      var line = previewModelLineForFileLine(typeof msg.focusLine === 'number' ? msg.focusLine : 0);
      var r0 = msg.ranges && msg.ranges[0];
      var col = (r0 && typeof r0.start === 'number') ? r0.start + 1 : 1;
      editor.setPosition({ lineNumber: line, column: col });
    } catch (e) {}
  }

  function previewModelLineForFileLine(fileLine) {
    var base = typeof state.previewBaseLine === 'number' ? state.previewBaseLine : 0;
    return Math.max(1, (typeof fileLine === 'number' ? fileLine : 0) - base + 1);
  }

  function clearPreviewMonacoCallGraphInlays() {
    try {
      var disposers = state.previewMonacoInlayDisposers || [];
      for (var i = 0; i < disposers.length; i++) {
        try {
          if (disposers[i] && typeof disposers[i].dispose === 'function') {
            disposers[i].dispose();
          }
        } catch (eDisposeInlay) {}
      }
    } catch (eInlayDisposers) {}
    state.previewMonacoInlayDisposers = [];
    if (state.previewMonacoInlayLayer && state.previewMonacoInlayLayer.parentElement) {
      try { state.previewMonacoInlayLayer.parentElement.removeChild(state.previewMonacoInlayLayer); } catch (eRemoveInlayLayer) {}
    }
    state.previewMonacoInlayLayer = null;
  }

  function renderPreviewMonacoCallGraphInlays(editor, msg) {
    clearPreviewMonacoCallGraphInlays();
    var byLine = previewCallGraphInlaysByLine(msg);
    var inlays = [];
    for (var lineKey in byLine) {
      if (!Object.prototype.hasOwnProperty.call(byLine, lineKey)) { continue; }
      for (var li = 0; li < byLine[lineKey].length; li++) {
        inlays.push(byLine[lineKey][li]);
      }
    }
    send({ type: 'log', msg: 'preview monaco inlays render start uri=' + (msg && msg.uri || state.previewUri || '') + ' previewSeq=' + (msg && typeof msg.previewSeq === 'number' ? msg.previewSeq : 'none') + ' count=' + inlays.length + ' hasEditor=' + (!!editor) + ' hasHost=' + (!!state.previewMonacoHost) });
    if (!editor || inlays.length === 0 || !state.previewMonacoHost) { return; }
    var host = state.previewMonacoHost;
    if (!host.parentElement) { return; }
    try {
      var hostPosition = window.getComputedStyle ? window.getComputedStyle(host).position : '';
      if (!hostPosition || hostPosition === 'static') { host.style.position = 'relative'; }
    } catch (eHostPosition) {
      host.style.position = 'relative';
    }
    var layer = markSearchUiRoot(el('div', { className: 'ij-find-preview-monaco-inlay-layer' }));
    host.appendChild(layer);
    state.previewMonacoInlayLayer = layer;
    var pending = false;
    var updateLayer = function () {
      pending = false;
      if (state.previewMonacoInlayLayer !== layer || !layer.parentElement) { return; }
      var model = null;
      try { model = editor.getModel && editor.getModel(); } catch (eModel) {}
      if (!model) { return; }
      clearChildren(layer);
      var hostWidth = Math.max(0, host.clientWidth || 0);
      var hostHeight = Math.max(0, host.clientHeight || 0);
      var rendered = 0;
      for (var i = 0; i < inlays.length; i++) {
        var inlay = inlays[i];
        var lineNumber = previewModelLineForFileLine(inlay.line);
        var lineCount = 0;
        try { lineCount = model.getLineCount ? model.getLineCount() : 0; } catch (eLineCount) {}
        if (lineCount > 0 && (lineNumber < 1 || lineNumber > lineCount)) { continue; }
        var maxColumn = 1073741823;
        try { maxColumn = model.getLineMaxColumn ? model.getLineMaxColumn(lineNumber) : maxColumn; } catch (eMaxColumn) {}
        var column = typeof inlay.column === 'number' ? inlay.column + 1 : maxColumn;
        column = Math.max(1, Math.min(maxColumn, column));
        var pos = null;
        try {
          if (typeof editor.getScrolledVisiblePosition === 'function') {
            pos = editor.getScrolledVisiblePosition({ lineNumber: lineNumber, column: column });
          }
        } catch (eVisiblePos) {}
        var top = pos && typeof pos.top === 'number' ? pos.top : NaN;
        var left = pos && typeof pos.left === 'number' ? pos.left : NaN;
        var height = pos && typeof pos.height === 'number' && pos.height > 0 ? pos.height : 18;
        if (!Number.isFinite(top)) {
          try {
            if (typeof editor.getTopForLineNumber === 'function' && typeof editor.getScrollTop === 'function') {
              top = editor.getTopForLineNumber(lineNumber) - editor.getScrollTop();
            }
          } catch (eTopFallback) {}
        }
        if (!Number.isFinite(left)) { left = 80; }
        if (!Number.isFinite(top)) { continue; }
        if (hostHeight > 0 && (top + height < 0 || top > hostHeight)) { continue; }
        left = left + 8;
        if (hostWidth > 0 && left > hostWidth - 28) {
          left = Math.max(48, hostWidth - 140);
        }
        var attrs = {
          'data-ijss-callgraph-symbol-id': inlay.symbolId,
          'data-ijss-callgraph-kind': inlay.kind,
          'data-ijss-callgraph-label': inlay.label,
          'data-ijss-callgraph-column': String(inlay.column),
          'role': 'button',
          'tabindex': '0',
          'aria-label': (inlay.label ? inlay.label + ' ' : '') + inlay.text,
        };
        var node = el('span', {
          className: 'ij-find-preview-inlay ijss-callgraph',
          text: inlay.text,
          title: inlay.label ? inlay.label : inlay.text,
          attrs: attrs,
        });
        node.style.top = Math.round(top + Math.max(0, (height - 18) / 2)) + 'px';
        node.style.left = Math.round(left) + 'px';
        layer.appendChild(node);
        rendered++;
      }
      send({ type: 'log', msg: 'preview monaco inlays layer update uri=' + (msg && msg.uri || state.previewUri || '') + ' rendered=' + rendered + ' requested=' + inlays.length + ' host=' + hostWidth + 'x' + hostHeight });
    };
    var scheduleUpdate = function () {
      if (pending) { return; }
      pending = true;
      requestAnimationFrame(updateLayer);
    };
    var disposers = [];
    try {
      if (typeof editor.onDidScrollChange === 'function') {
        disposers.push(editor.onDidScrollChange(scheduleUpdate));
      }
    } catch (eScrollListen) {}
    try {
      if (typeof editor.onDidLayoutChange === 'function') {
        disposers.push(editor.onDidLayoutChange(scheduleUpdate));
      }
    } catch (eLayoutListen) {}
    try {
      var modelForListener = editor.getModel && editor.getModel();
      if (modelForListener && typeof modelForListener.onDidChangeContent === 'function') {
        disposers.push(modelForListener.onDidChangeContent(scheduleUpdate));
      }
    } catch (eContentListen) {}
    state.previewMonacoInlayDisposers = disposers;
    updateLayer();
    requestAnimationFrame(updateLayer);
    setTimeout(updateLayer, 0);
  }

  // Scroll the preview to the match without the default smooth animation.
  // For multi-line matches, put the start near the top of the viewport so
  // as many match lines as possible are visible. ScrollType.Immediate = 1.
  function revealMatchImmediate(editor, msg) {
    var startLn = previewModelLineForFileLine(msg.focusLine);
    var r0 = msg.ranges && msg.ranges[0];
    if (r0 && typeof r0.endLine === 'number' && r0.endLine > msg.focusLine) {
      var endLn = previewModelLineForFileLine(r0.endLine);
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
      var focusLineMonaco = previewModelLineForFileLine(msg.focusLine);
      var decos = [];
      (msg.ranges || []).forEach(function (r, matchIdx) {
        var startLn = focusLineMonaco;
        var endLn = (typeof r.endLine === 'number') ? previewModelLineForFileLine(r.endLine) : startLn;
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
          // Keep overview-ruler markers limited to the match start so the
          // scrollbar remains a jump target, but mirror every highlighted
          // sub-range into the minimap so multi-line matches are visible
          // there exactly where the text is highlighted.
          var addRulerMarker = si === 0;
          var opts = { inlineClassName: cls, isWholeLine: false };
          opts.minimap = previewMinimapMatchOptions(matchIdx === 0);
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
    clearPreviewMonacoCallGraphInlays();
    teardownPreviewMonacoHealObserver();
    teardownPreviewMonacoDiagnostics();
    try {
      if (state.monacoChangeListener && state.monacoChangeListener.dispose) {
        state.monacoChangeListener.dispose();
      }
    } catch (eChangeDispose) {}
    state.monacoChangeListener = null;
    try {
      if (state.previewMonacoKeydownListener && state.previewMonacoKeydownListener.dispose) {
        state.previewMonacoKeydownListener.dispose();
      }
    } catch (eKeyDispose) {}
    state.previewMonacoKeydownListener = null;
    state.previewMonacoSaveEditor = null;
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

  window.__ijFindForceStopMonacoCapture = function (reason) {
    var out = [];
    try { window.__ijFindDisableMonacoProbes = true; out.push('disabled=true'); } catch (eDisable) {}
    try {
      if (window.__ijFindStopCapture) { out.push('stop=' + window.__ijFindStopCapture(reason || 'force-stop')); }
      else { out.push('stop=no-fn'); }
    } catch (eStop) { out.push('stop-err=' + (eStop && eStop.message)); }
    try { window.__ijFindMonaco = null; out.push('monaco=null'); } catch (eMonaco) {}
    try { window.__ijFindMonacoFactory = null; out.push('monacoFactory=null'); } catch (eMonacoFactory) {}
    try {
      monacoState.tried = true;
      monacoState.api = null;
      monacoState.source = 'force-stopped';
      out.push('loader=disabled');
    } catch (eState) {}
    try { disposePreviewMonacoEditor(); out.push('preview=disposed'); } catch (ePreview) {}
    try {
      if (window.__ijFindCaptures) {
        window.__ijFindCaptures.widgets = [];
        window.__ijFindCaptures.services = [];
        window.__ijFindCaptures.widgetCtors = [];
        window.__ijFindCaptures.serviceMaps = [];
        out.push('captures=cleared');
      }
    } catch (eCaps) {}
    try { window.__ijFindCaptureInstalled = false; } catch (eInstalled) {}
    return out.join(',');
  };

  function clearSearchUiForRecovery(reason) {
    var out = [];
    try { cancelScheduledRender(); out.push('render=cancelled'); } catch (eRender) {}
    try { if (state.searchTicker) { clearInterval(state.searchTicker); state.searchTicker = null; out.push('ticker=cleared'); } } catch (eTicker) {}
    try { if (state.debounce) { clearTimeout(state.debounce); state.debounce = null; out.push('debounce=cleared'); } } catch (eDebounce) {}
    try { if (state.hoverTimer) { clearTimeout(state.hoverTimer); state.hoverTimer = null; out.push('hoverTimer=cleared'); } } catch (eHoverTimer) {}
    try { if (hoverHideTimer) { clearTimeout(hoverHideTimer); hoverHideTimer = null; out.push('hoverHide=cleared'); } } catch (eHoverHide) {}
    try { if (state.stolenEditor) { restoreStolenEditor(); out.push('stolen=restored'); } } catch (eStolen) { out.push('stolen=err'); }
    try { disposePreviewMonacoEditor(); out.push('preview=disposed'); } catch (ePreview) { out.push('preview=err'); }
    try { hideHover(); out.push('hover=hidden'); } catch (eHover) {}
    try {
      state.files = [];
      state.flat = [];
      state.candidates = [];
      state.candidateTotal = 0;
      state.confirmedUris = {};
      state.fileIndexByUri = {};
      state.matchCount = 0;
      state.activeIndex = -1;
      state.searching = false;
      state.loadingMore = false;
      state.hasMoreResults = false;
      state.resultsInfoText = '';
      state.lastPreviewKey = '';
      state.previewUri = '';
      state.previewLanguageId = '';
      out.push('state=cleared');
    } catch (eState) { out.push('state=err'); }
    try {
      clearChildren($resultsInner);
      $resultsInner.style.height = 'auto';
      clearChildren($previewBody);
      $previewBody.classList.remove('ij-find-editor-mounted', 'ij-find-stolen');
      out.push('dom=cleared');
    } catch (eDom) { out.push('dom=err'); }
    try { setStatus('Recovered renderer UI', false); } catch (eStatus) {}
    try {
      panel.classList.remove('visible');
      if (state.minimized) { restoreSearchPanelFromMinimized(true); }
      panel.style.removeProperty('display');
      panel.style.removeProperty('visibility');
      panel.style.removeProperty('opacity');
      panel.style.removeProperty('pointer-events');
      panel.style.removeProperty('z-index');
      panel.style.removeProperty('position');
      out.push('panel=hidden');
    } catch (ePanel) { out.push('panel=err'); }
    try { if (panel.parentElement) { panel.parentElement.removeChild(panel); out.push('panel=detached'); } } catch (ePanelDetach) {}
    // $hoverTooltip removed in #32 — nothing to detach here either.
    try {
      var previewOverflowRoot = findPreviewOverflowRootForInstance();
      if (previewOverflowRoot && previewOverflowRoot.parentElement) {
        previewOverflowRoot.parentElement.removeChild(previewOverflowRoot);
        out.push('overflow=detached');
      }
    } catch (eOverflowDetach) {}
    return out.join(',');
  }

	  window.__ijFindEmergencyRecover = function (reason) {
	    var out = [];
	    try { state.recoveryUntil = Date.now() + 1000; } catch (eRecoveryUntil) {}
	    try { out.push('ir=' + setIntelliSenseRecursionCaptureSuspended(true, reason || 'emergency-recover')); }
	    catch (eIr) { out.push('ir-err=' + (eIr && eIr.message)); }
	    try { out.push('force=' + window.__ijFindForceStopMonacoCapture(reason || 'emergency-recover')); }
	    catch (eForce) { out.push('force-err=' + (eForce && eForce.message)); }
    try { out.push('dispose=' + window.__ijFindDisposeSearchUi(reason || 'emergency-recover')); }
    catch (eDispose) { out.push('dispose-err=' + (eDispose && eDispose.message)); }
    try { out.push('ui=' + clearSearchUiForRecovery(reason || 'emergency-recover')); }
    catch (eUi) { out.push('ui-err:' + (eUi && eUi.message)); }
    return out.join(' | ');
  };

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
    for (var i = labels.length - 1; i >= 0; i--) {
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
    // Fallback: last workbench .monaco-editor outside our overlay.
    var all = collectWorkbenchMonacoEditorElements();
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

  function findMonacoWidgetOnQuiet(el) {
    if (!el) { return null; }
    var seen = {};
    var keys = [];
    try { var own = Object.getOwnPropertyNames(el); for (var i = 0; i < own.length; i++) { keys.push(own[i]); seen[own[i]] = 1; } } catch (e) {}
    for (var k in el) { if (!seen[k]) { keys.push(k); seen[k] = 1; } }
    for (var j = 0; j < keys.length; j++) {
      var val;
      try { val = el[keys[j]]; } catch (e1) { continue; }
      if (!val || typeof val !== 'object') { continue; }
      if (typeof val.layout === 'function' &&
          typeof val.getModel === 'function' &&
          typeof val.getDomNode === 'function') {
        return val;
      }
      try {
        if (val.editor && typeof val.editor.layout === 'function' && typeof val.editor.getModel === 'function') {
          return val.editor;
        }
        if (val._editor && typeof val._editor.layout === 'function' && typeof val._editor.getModel === 'function') {
          return val._editor;
        }
      } catch (e2) {}
    }
    try {
      var syms = Object.getOwnPropertySymbols(el);
      for (var s = 0; s < syms.length; s++) {
        var sv;
        try { sv = el[syms[s]]; } catch (e3) { continue; }
        if (!sv || typeof sv !== 'object') { continue; }
        if (typeof sv.layout === 'function' && typeof sv.getModel === 'function' && typeof sv.getDomNode === 'function') {
          return sv;
        }
      }
    } catch (e4) {}
    return null;
  }

  function classTextOf(el) {
    try {
      if (!el) { return ''; }
      if (typeof el.className === 'string') { return el.className; }
      if (el.className && typeof el.className.baseVal === 'string') { return el.className.baseVal; }
      return String(el.className || '');
    } catch (e) { return ''; }
  }

  function normalizedInlineText(el) {
    try { return (el && el.textContent ? el.textContent : '').replace(/\\s+/g, ' ').trim(); }
    catch (e) { return ''; }
  }

  function callGraphInlayText(el) {
    var parts = [];
    try {
      var text = normalizedInlineText(el);
      if (text) { parts.push(text); }
    } catch (eText) {}
    try {
      var attrs = ['aria-label', 'title', 'data-title', 'data-content', 'data-text'];
      for (var i = 0; i < attrs.length; i++) {
        var value = el && el.getAttribute && el.getAttribute(attrs[i]);
        if (value) { parts.push(String(value).replace(/\\s+/g, ' ').trim()); }
      }
    } catch (eAttrs) {}
    return parts.join(' ').trim();
  }

  function callGraphInlayLabelKindForElement(el) {
    try {
      var text = normalizedInlineText(el);
      var textKind = text && text.length <= 160 ? callGraphInlayLabelKind(text) : '';
      if (textKind) { return textKind; }
    } catch (eTextKind) {}
    try {
      var attrs = ['aria-label', 'title', 'data-title', 'data-content', 'data-text'];
      for (var i = 0; i < attrs.length; i++) {
        var value = el && el.getAttribute && el.getAttribute(attrs[i]);
        if (!value) { continue; }
        var normalized = String(value).replace(/\\s+/g, ' ').trim();
        var attrKind = normalized && normalized.length <= 160 ? callGraphInlayLabelKind(normalized) : '';
        if (attrKind) { return attrKind; }
      }
    } catch (eAttrKind) {}
    return '';
  }

  function callGraphInlayKindFromText(text) {
    var m = /\\b(callees|impl|usages)\\s+\\d+\\b/.exec(text || '');
    return m ? m[1] : '';
  }

  function exactCallGraphInlayLabel(text) {
    return /^(?:callees|impl|usages)\\s+\\d+$/.test(text || '');
  }

  function compactCallGraphInlayLabel(text) {
    return /^(?:callees|impl|usages)\\s+\\d+(?:\\s*\\|\\s*(?:callees|impl|usages)\\s+\\d+)*$/.test(text || '');
  }

  function callGraphInlayLabelKind(text) {
    if (!exactCallGraphInlayLabel(text) && !compactCallGraphInlayLabel(text)) { return ''; }
    return callGraphInlayKindFromText(text) || 'usages';
  }

  function isSearchUiEventTarget(target) {
    try {
      var el = target && target.nodeType === 3 ? target.parentElement : target;
      return !!(el && el.closest && el.closest('[data-ijss-root="true"], .ij-find-overlay, .ij-find-preview-overflow-root, .ij-find-hover-tooltip'));
    } catch (eSearchTarget) {
      return false;
    }
  }

  function isSearchPreviewEditorTarget(target) {
    try {
      var el = target && target.nodeType === 3 ? target.parentElement : target;
      if (!el || !el.closest || el.closest('.ij-find-detached')) { return false; }
      return !!el.closest('.ij-find-preview-body .monaco-editor');
    } catch (ePreviewTarget) {
      return false;
    }
  }

  function isActiveSelectionInSearchPreviewEditor() {
    try {
      if (isSearchPreviewEditorTarget(document.activeElement)) { return true; }
      var sel = window.getSelection ? window.getSelection() : null;
      if (sel) {
        if (isSearchPreviewEditorTarget(sel.anchorNode)) { return true; }
        if (isSearchPreviewEditorTarget(sel.focusNode)) { return true; }
      }
    } catch (eActivePreview) {}
    return false;
  }

  window.__ijFindShouldSpawnSearchSelection = function () {
    return isActiveSelectionInSearchPreviewEditor() ? 'preview' : '';
  };

  function isPotentialCallGraphInlayClickTarget(start) {
    try {
      var el = start && start.nodeType === 3 ? start.parentElement : start;
      if (!el || !el.closest) { return false; }
      return !!el.closest('.monaco-editor');
    } catch (ePotentialInlay) {
      return false;
    }
  }

  function classTextOf(el) {
    try {
      if (!el) { return ''; }
      if (typeof el.className === 'string') { return el.className; }
      if (el.getAttribute) { return el.getAttribute('class') || ''; }
    } catch (eClassText) {}
    return '';
  }

  function isCallGraphInlayishElement(el) {
    try {
      if (!el || !el.tagName) { return false; }
      var cls = classTextOf(el);
      if (/\\b(?:ijss-callgraph|callgraph|inlay|inline-hint|inlineHints|codelens|codicon)\\b/i.test(cls)) {
        return true;
      }
      var role = el.getAttribute && String(el.getAttribute('role') || '');
      if (/button|link/i.test(role) && callGraphInlayLabelKindForElement(el)) { return true; }
    } catch (eInlayish) {}
    return false;
  }

  function callGraphInlayTargetGate(start) {
    try {
      var el = start && start.nodeType === 3 ? start.parentElement : start;
      for (var depth = 0; el && depth < 8; depth++, el = el.parentElement) {
        if (!el || el === document.body) { break; }
        if (el.classList && (el.classList.contains('view-line') || el.classList.contains('view-lines') || el.classList.contains('monaco-editor'))) {
          break;
        }
        var kind = callGraphInlayLabelKindForElement(el);
        if (kind) { return { element: el, kind: kind, reason: 'label' }; }
        if (isCallGraphInlayishElement(el)) { return { element: el, kind: '', reason: 'inlayish' }; }
      }
    } catch (eGate) {}
    return null;
  }

  function closestCallGraphEditorLine(start) {
    var el = start && start.nodeType === 3 ? start.parentElement : start;
    for (var depth = 0; el && depth < 12; depth++, el = el.parentElement) {
      if (!el || el === document.body) { break; }
      if (el.classList && el.classList.contains('view-line')) { return el; }
      if (el.classList && el.classList.contains('monaco-editor')) { break; }
    }
    return null;
  }

  function isSmallInlaySearchScope(el) {
    try {
      if (!el || !el.querySelectorAll) { return false; }
      if (el.classList && el.classList.contains('monaco-editor')) { return false; }
      if (el.classList && el.classList.contains('view-lines')) { return false; }
      return el.children ? el.children.length <= 80 : true;
    } catch (eScope) {
      return false;
    }
  }

  function findCallGraphInlayChild(el, clientX, clientY) {
    if (!isSmallInlaySearchScope(el)) { return null; }
    if (!isCallGraphInlayishElement(el) && !callGraphInlayLabelKindForElement(el)) { return null; }
    var children = el && el.querySelectorAll ? el.querySelectorAll('*') : [];
    for (var i = 0; i < children.length; i++) {
      var childKind = callGraphInlayLabelKindForElement(children[i]);
      if (!childKind) { continue; }
      try {
        var rect = children[i].getBoundingClientRect();
        if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
          return { element: children[i], kind: childKind };
        }
      } catch (eRect) {}
    }
    return null;
  }

  function findCallGraphInlayElementInAncestry(start, clientX, clientY) {
    var el = start && start.nodeType === 3 ? start.parentElement : start;
    for (var depth = 0; el && depth < 8; depth++, el = el.parentElement) {
      if (!el || el === document.body) { break; }
      if (el.classList && (el.classList.contains('view-line') || el.classList.contains('monaco-editor'))) {
        break;
      }
      var childHit = findCallGraphInlayChild(el, clientX, clientY);
      if (childHit) { return childHit; }
      var kind = callGraphInlayLabelKindForElement(el);
      if (!kind) { continue; }
      try {
        var rect = el.getBoundingClientRect();
        if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) { continue; }
      } catch (eRect) {}
      return { element: el, kind: kind };
    }
    return null;
  }

  function findCallGraphInlayElement(start, clientX, clientY) {
    if (isSearchUiEventTarget(start) && !isSearchPreviewEditorTarget(start)) { return null; }
    if (!isPotentialCallGraphInlayClickTarget(start)) { return null; }
    var gate = callGraphInlayTargetGate(start);
    if (!gate) { return null; }
    if (gate.kind) {
      try {
        var gateRect = gate.element && gate.element.getBoundingClientRect && gate.element.getBoundingClientRect();
        if (!gateRect || (clientX >= gateRect.left && clientX <= gateRect.right && clientY >= gateRect.top && clientY <= gateRect.bottom)) {
          return { element: gate.element, kind: gate.kind };
        }
      } catch (eGateRect) {
        return { element: gate.element, kind: gate.kind };
      }
    }
    var direct = findCallGraphInlayElementInAncestry(start, clientX, clientY);
    if (direct) { return direct; }
    try {
      var stack = document.elementsFromPoint ? document.elementsFromPoint(clientX, clientY) : [];
      for (var i = 0; i < stack.length; i++) {
        if (isSearchUiEventTarget(stack[i]) && !isSearchPreviewEditorTarget(stack[i])) { continue; }
        if (!callGraphInlayTargetGate(stack[i])) { continue; }
        var hit = findCallGraphInlayElementInAncestry(stack[i], clientX, clientY);
        if (hit) { return hit; }
      }
    } catch (ePoint) {}
    return null;
  }

  var __ijFindEditorWidgetCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function findEditorWidgetForInlayElement(el) {
    var monacoEl = el && el.closest && el.closest('.monaco-editor');
    if (__ijFindEditorWidgetCache && monacoEl) {
      try {
        var cachedWidget = __ijFindEditorWidgetCache.get(monacoEl);
        if (cachedWidget && typeof cachedWidget.getModel === 'function') { return cachedWidget; }
      } catch (eCacheRead) {}
    }
    var widget = findMonacoWidgetOnQuiet(monacoEl);
    if (!widget && typeof findMonacoWidget === 'function') { widget = findMonacoWidget(monacoEl); }
    if (widget) {
      if (__ijFindEditorWidgetCache && monacoEl) {
        try { __ijFindEditorWidgetCache.set(monacoEl, widget); } catch (eCacheSet) {}
      }
      return widget;
    }
    try {
      var capsNow = window.__ijFindCaptures;
      var widgets = capsNow && capsNow.widgets ? capsNow.widgets : [];
      for (var i = 0; i < widgets.length; i++) {
        var candidate = widgets[i] && widgets[i].v;
        if (!candidate || typeof candidate.getDomNode !== 'function') { continue; }
        var dom = candidate.getDomNode();
        if (dom && dom.contains && dom.contains(el)) { return candidate; }
      }
    } catch (e) {}
    return null;
  }

  // #49 user-requested: stamp every native Monaco inlay span with the
  // (line, kind, text) the symbol it was rendered for, so the click
  // handler can dispatch with exact precision instead of reconstructing
  // line/col from click pixels (which drifts across virtual scroll,
  // line-wrap, fold).
  //
  // Monaco renders inlays inside .view-line containers in the workbench
  // editor. We walk view-lines in DOM order against the editor widget's
  // visible ranges to derive the model line for each, then stamp every
  // inlay-looking span on that line.
  function tagNativeInlaysInViewLine(viewLine, widget, modelLine) {
    if (!viewLine || typeof modelLine !== 'number' || modelLine < 0) { return { tagged: 0, scanned: 0, kindHits: 0, symbolHits: 0 }; }
    var tagged = 0;
    var scanned = 0;
    var kindHits = 0;
    var symbolHits = 0;
    try {
      // Generous filter — Monaco inlay class names vary across versions.
      var candidates = viewLine.querySelectorAll('[class*="inlay" i], [class*="hint" i]');
      for (var i = 0; i < candidates.length; i++) {
        var span = candidates[i];
        if (!span || span.getAttribute('data-ijss-render-line')) { continue; }
        scanned++;
        // Confirm callgraph-ownership by text — workbench's Pylance param
        // hints also render here but use different text patterns.
        var text = ((span.textContent || '') + '').trim();
        var kind = callGraphInlayKindFromText(text);
        if (!kind) { continue; }
        kindHits++;
        // Symbol/label extraction: ask Monaco directly which inlay hint
        // is rendered at this span's center via getTargetAtClientPoint.
        // target.detail.injectedText.options.attachedData carries the
        // InlayHintLabelPart that holds command + arguments (symbolId,
        // qualifiedName). #50 user request.
        var symbolId = '';
        var symbolLabel = '';
        try {
          var rect = span.getBoundingClientRect();
          var cx = Math.round(rect.left + rect.width / 2);
          var cy = Math.round(rect.top + rect.height / 2);
          if (widget && typeof widget.getTargetAtClientPoint === 'function') {
            var target = widget.getTargetAtClientPoint(cx, cy);
            var injected = target && target.detail && target.detail.injectedText;
            var attached = injected && ((injected.options && injected.options.attachedData) || injected.attachedData);
            var part = attached && (attached.part || attached);
            var command = part && part.command;
            var args = command && command.arguments;
            if (args && args.length >= 1 && typeof args[0] === 'string') {
              symbolId = args[0];
              symbolLabel = args.length >= 2 && typeof args[1] === 'string' ? args[1] : '';
              symbolHits++;
            }
          }
        } catch (eSymProbe) {}
        try {
          span.setAttribute('data-ijss-render-line', String(modelLine));
          span.setAttribute('data-ijss-render-kind', kind);
          span.setAttribute('data-ijss-render-text', text.slice(0, 60));
          if (symbolId) {
            span.setAttribute('data-ijss-render-symbol-id', symbolId);
          }
          if (symbolLabel) {
            span.setAttribute('data-ijss-render-symbol-label', symbolLabel);
          }
          tagged++;
        } catch (eAttr) {}
      }
    } catch (eScan) {}
    return { tagged: tagged, scanned: scanned, kindHits: kindHits, symbolHits: symbolHits };
  }

  function tagNativeInlaysInEditor(editor) {
    var summary = { tagged: 0, scanned: 0, kindHits: 0, symbolHits: 0, viewLines: 0, reason: '' };
    try {
      if (!editor || typeof editor.getDomNode !== 'function') { summary.reason = 'no-editor-or-getDomNode'; return summary; }
      if (typeof editor.getVisibleRanges !== 'function') { summary.reason = 'no-getVisibleRanges'; return summary; }
      var visible = editor.getVisibleRanges() || [];
      if (!visible.length) { summary.reason = 'empty-visible-ranges'; return summary; }
      var dom = editor.getDomNode();
      if (!dom) { summary.reason = 'no-dom'; return summary; }
      var linesRoots = dom.querySelectorAll('.view-lines');
      if (!linesRoots || !linesRoots.length) { summary.reason = 'no-view-lines-root'; return summary; }
      // Flatten visible ranges into ordered model lines; wrap/fold splits
      // them into multiple ranges that we walk in sequence.
      var flatLines = [];
      for (var rIdx = 0; rIdx < visible.length; rIdx++) {
        var range = visible[rIdx];
        var start = Math.max(1, range.startLineNumber || 1);
        var end = Math.max(start, range.endLineNumber || start);
        for (var ln = start; ln <= end; ln++) { flatLines.push(ln); }
      }
      var domViewLines = linesRoots[0].querySelectorAll('.view-line');
      summary.viewLines = domViewLines.length;
      for (var i = 0; i < domViewLines.length && i < flatLines.length; i++) {
        var modelLineMonaco = flatLines[i];                 // 1-based
        var modelLineZero = Math.max(0, modelLineMonaco - 1);
        var local = tagNativeInlaysInViewLine(domViewLines[i], editor, modelLineZero);
        summary.tagged += local.tagged;
        summary.scanned += local.scanned;
        summary.kindHits += local.kindHits;
        summary.symbolHits += local.symbolHits;
      }
      summary.reason = 'ok';
      return summary;
    } catch (eTagEditor) {
      summary.reason = 'threw:' + String(eTagEditor && eTagEditor.message || eTagEditor).slice(0, 80);
      return summary;
    }
  }

  function setupNativeInlayTagObserver() {
    if (window.__ijFindNativeInlayTagObserverInstalled === true) { return; }
    try { window.__ijFindNativeInlayTagObserverInstalled = true; } catch (eFlag) {}
    var pendingTag = null;
    function scheduleTagAllEditors() {
      if (pendingTag) { return; }
      pendingTag = setTimeout(function () {
        pendingTag = null;
        var totalTagged = 0;
        var totalScanned = 0;
        var totalKindHits = 0;
        var totalSymbolHits = 0;
        var totalViewLines = 0;
        var editorsTried = 0;
        var editorDomsSeen = 0;
        var widgetMisses = 0;
        var reasons = [];
        try {
          var allEditorDoms = document.querySelectorAll('.monaco-editor');
          for (var i = 0; i < allEditorDoms.length; i++) {
            var dom = allEditorDoms[i];
            if (dom.closest && dom.closest('.ij-find-overlay')) { continue; }
            editorDomsSeen++;
            try {
              var widget = findMonacoWidgetOnQuiet(dom);
              if (!widget) { widgetMisses++; continue; }
              editorsTried++;
              var sum = tagNativeInlaysInEditor(widget);
              if (sum && typeof sum === 'object') {
                totalTagged += sum.tagged || 0;
                totalScanned += sum.scanned || 0;
                totalKindHits += sum.kindHits || 0;
                totalSymbolHits += sum.symbolHits || 0;
                totalViewLines += sum.viewLines || 0;
                if (sum.reason && sum.reason !== 'ok' && reasons.length < 6) {
                  reasons.push(sum.reason);
                }
              }
            } catch (eWidget) {}
          }
        } catch (eAllEditors) {}
        // Only emit a trace when the tagging pipeline actually did
        // something interesting — otherwise this fires on every DOM
        // mutation (we observed 349 emissions in a single captain
        // session) and drowns the log. Real signals: at least one
        // span was tagged, OR an editor reported a non-ok failure
        // reason that we want to diagnose.
        var hasFailureReason = false;
        for (var rI = 0; rI < reasons.length; rI++) {
          if (reasons[rI] && reasons[rI] !== 'ok') { hasFailureReason = true; break; }
        }
        if (totalTagged > 0 || hasFailureReason) {
          try {
            trace('preview/inlay/render-tagged', {
              editorDomsSeen: editorDomsSeen,
              editorsTried: editorsTried,
              widgetMisses: widgetMisses,
              totalViewLines: totalViewLines,
              totalScanned: totalScanned,
              totalKindHits: totalKindHits,
              totalSymbolHits: totalSymbolHits,
              totalTagged: totalTagged,
              reasons: reasons,
            });
          } catch (eTrace) {}
        }
      }, 80);
    }
    try {
      var observer = trackObserver(new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var added = mutations[i].addedNodes;
          if (!added || !added.length) { continue; }
          for (var j = 0; j < added.length; j++) {
            var node = added[j];
            if (!node || node.nodeType !== 1) { continue; }
            // Cheap filter: only react to nodes likely to contain inlay
            // text. Match on the class itself OR existence of children.
            var cls = (node.className || '') + '';
            if (/inlay|hint|view-line/i.test(cls) || (node.querySelector && node.querySelector('[class*="inlay" i], .view-line'))) {
              scheduleTagAllEditors();
              return;
            }
          }
        }
      }));
      observer.observe(document.body, { childList: true, subtree: true });
    } catch (eObsInstall) {}
    // Tag any inlays already in the DOM right now.
    scheduleTagAllEditors();
  }
  // Kick off tagging once Monaco capture is plausible — best-effort. Idle
  // failures are harmless; the next mutation will retry.
  try { setTimeout(setupNativeInlayTagObserver, 0); } catch (eKick) {}

  function visibleLineOrdinalFromInlayDom(el, event) {
    try {
      var viewLine = closestCallGraphEditorLine(el);
      if (!viewLine && document.elementsFromPoint && event) {
        var stack = document.elementsFromPoint(event.clientX, event.clientY) || [];
        for (var s = 0; s < stack.length && !viewLine; s++) {
          viewLine = closestCallGraphEditorLine(stack[s]);
        }
      }
      if (!viewLine) { return null; }
      var linesRoot = viewLine.closest && viewLine.closest('.view-lines');
      var monacoEl = viewLine.closest && viewLine.closest('.monaco-editor');
      if (!linesRoot || !monacoEl) { return null; }
      var lines = Array.prototype.slice.call(linesRoot.querySelectorAll('.view-line'));
      var ordinal = lines.indexOf(viewLine);
      if (ordinal < 0) { return null; }
      return { lineOrdinal: ordinal, column: 1000000 };
    } catch (eVisibleLineOrdinal) {
      return null;
    }
  }

  // #48 user-suggested: Monaco's InlayHintsController stores the rendered
  // InlayHintLabelPart reference on the injected-text option's attachedData.
  // When the user clicks an inlay span, getTargetAtClientPoint gives us a
  // target whose detail.injectedText.options.attachedData IS that label
  // part — with command + arguments intact. Extracting it directly avoids
  // re-deriving line/column and querying providers; we just dispatch the
  // exact command Monaco's hover popup would.
  function extractInlayHintLabelPartFromClick(widget, event) {
    try {
      if (!widget || typeof widget.getTargetAtClientPoint !== 'function') { return null; }
      var target = widget.getTargetAtClientPoint(event.clientX, event.clientY);
      if (!target) { return null; }
      var injected = target.detail && target.detail.injectedText;
      if (!injected) { return null; }
      // Some Monaco versions surface attachedData under options, others
      // directly. Walk both shapes defensively.
      var attached = (injected.options && injected.options.attachedData)
        || injected.attachedData
        || null;
      if (!attached) { return null; }
      // attached is an instance of InlayHintLabelPart-like {part, item, ...}
      // The label part with its command can be nested either as
      // attached.part (current Code) or directly on attached.
      var part = attached.part || attached;
      var command = part && part.command;
      if (!command || typeof command.command !== 'string') { return null; }
      return {
        commandId: String(command.command),
        commandArguments: Array.isArray(command.arguments) ? command.arguments.slice() : [],
        commandTitle: command.title ? String(command.title) : '',
        partLabel: part && typeof part.label === 'string' ? part.label : '',
      };
    } catch (eExtractInlay) {
      return null;
    }
  }

  // VS Code's public InlayHint API exposes InlayHintLabelPart.command but
  // ties it to cmd/ctrl+click (and the context-menu entry) — there's no
  // plain-click hook. When the workbench main editor's Monaco widget
  // isn't captured by our probe (so widget=null), our render-tag pipeline
  // can't stamp the symbolId at draw time and our DOM->widget extraction
  // path can't read it at click time either. The robust fallback is to
  // synthesize a cmd/ctrl+click on the inlay span: Monaco's native
  // InlayHintsController owns the label-part metadata internally and
  // will resolve the exact symbolId regardless of whether we captured
  // the widget. Our own document-level handler re-enters from the
  // synthetic event but bails on metaKey/ctrlKey, so this can't recurse.
  function simulateCmdClickOnInlay(inlayElement, sourceEvent) {
    if (!inlayElement || typeof inlayElement.getBoundingClientRect !== 'function') { return false; }
    try {
      var isMac = (typeof navigator !== 'undefined' && navigator.platform && /mac|iphone|ipad/i.test(navigator.platform));
      var rect = inlayElement.getBoundingClientRect();
      var cx = (sourceEvent && Number.isFinite(sourceEvent.clientX)) ? sourceEvent.clientX : Math.round(rect.left + rect.width / 2);
      var cy = (sourceEvent && Number.isFinite(sourceEvent.clientY)) ? sourceEvent.clientY : Math.round(rect.top + rect.height / 2);
      var modMeta = isMac ? true : false;
      var modCtrl = isMac ? false : true;
      function dispatchEv(type, useBtn, isPointer) {
        try {
          var init = {
            bubbles: true,
            cancelable: true,
            button: 0,
            buttons: useBtn,
            clientX: cx,
            clientY: cy,
            view: window,
            metaKey: modMeta,
            ctrlKey: modCtrl,
            altKey: false,
            shiftKey: false,
          };
          var ev;
          if (isPointer && typeof PointerEvent === 'function') {
            init.pointerType = 'mouse';
            init.pointerId = 1;
            init.isPrimary = true;
            ev = new PointerEvent(type, init);
          } else {
            ev = new MouseEvent(type, init);
          }
          inlayElement.dispatchEvent(ev);
        } catch (eDispatchOne) {}
      }
      // Monaco's gesture pipeline starts at pointerdown; the legacy
      // mouse channel and a final click event cover handlers that only
      // listen on one or the other.
      dispatchEv('pointerdown', 1, true);
      dispatchEv('mousedown', 1, false);
      dispatchEv('pointerup', 0, true);
      dispatchEv('mouseup', 0, false);
      dispatchEv('click', 0, false);
      return true;
    } catch (eCmdSim) {
      return false;
    }
  }

  function editorPositionFromInlayClick(widget, event) {
    if (!widget || typeof widget.getModel !== 'function') { return null; }
    var model = widget.getModel();
    if (!model || !model.uri || typeof model.uri.toString !== 'function') { return null; }
    var pos = null;
    try {
      if (typeof widget.getTargetAtClientPoint === 'function') {
        var target = widget.getTargetAtClientPoint(event.clientX, event.clientY);
        pos = target && target.position;
        if (!pos && target && target.range) {
          if (typeof target.range.getStartPosition === 'function') {
            pos = target.range.getStartPosition();
          } else if (typeof target.range.startLineNumber === 'number') {
            pos = { lineNumber: target.range.startLineNumber, column: target.range.startColumn || 1 };
          }
        }
        if (!pos && target && target.detail && target.detail.range) {
          var detailRange = target.detail.range;
          if (typeof detailRange.getStartPosition === 'function') {
            pos = detailRange.getStartPosition();
          } else if (typeof detailRange.startLineNumber === 'number') {
            pos = { lineNumber: detailRange.startLineNumber, column: detailRange.startColumn || 1 };
          }
        }
      }
    } catch (eTarget) {}
    if (!pos) {
      try {
        var dom = widget.getDomNode && widget.getDomNode();
        var rect = dom && dom.getBoundingClientRect && dom.getBoundingClientRect();
        var y = rect ? event.clientY - rect.top : NaN;
        var visible = typeof widget.getVisibleRanges === 'function' ? widget.getVisibleRanges() : [];
        if (Number.isFinite(y) && visible && visible.length && typeof widget.getScrolledVisiblePosition === 'function') {
          for (var vr = 0; vr < visible.length && !pos; vr++) {
            var startLine = Math.max(1, visible[vr].startLineNumber || 1);
            var endLine = Math.max(startLine, visible[vr].endLineNumber || startLine);
            for (var ln = startLine; ln <= endLine; ln++) {
              var vp = widget.getScrolledVisiblePosition({ lineNumber: ln, column: 1 });
              if (!vp || typeof vp.top !== 'number') { continue; }
              var height = typeof vp.height === 'number' && vp.height > 0 ? vp.height : 20;
              if (y >= vp.top - 2 && y <= vp.top + height + 2) {
                pos = { lineNumber: ln, column: 1 };
                break;
              }
            }
          }
        }
      } catch (eVisible) {}
    }
    if (!pos || typeof pos.lineNumber !== 'number') { return null; }
    return {
      uri: model.uri.toString(),
      line: Math.max(0, pos.lineNumber - 1),
      column: Math.max(0, (typeof pos.column === 'number' ? pos.column : 1) - 1),
    };
  }

  var __ijFindLastInlayActivation = null;
  function rememberCallGraphInlayActivation(event, hit) {
    try {
      __ijFindLastInlayActivation = {
        at: Date.now(),
        x: event.clientX,
        y: event.clientY,
        kind: hit && hit.kind || '',
      };
    } catch (eRememberInlay) {}
  }

  function matchesLastCallGraphInlayActivation(event) {
    try {
      var last = __ijFindLastInlayActivation;
      if (!last || Date.now() - last.at > 900) { return false; }
      return Math.abs((event.clientX || 0) - last.x) <= 3 &&
        Math.abs((event.clientY || 0) - last.y) <= 3;
    } catch (eLastInlay) {
      return false;
    }
  }

  function reportCallGraphInlayHook(name, startedAt, event, hit, reason) {
    try {
      var elapsed = perfNow() - startedAt;
      if (elapsed < 4 && !hit) { return; }
      var payload = {
        hit: !!hit,
        reason: reason || '',
        kind: hit && hit.kind || '',
        target: compactEventTarget(event && event.target),
      };
      panelDiagMark('inlayHook:' + name, payload);
      reportPerfPhase('inlayHook:' + name, startedAt, payload, 4);
    } catch (eInlayHookReport) {}
  }

  function handleCallGraphInlayMouseDown(event) {
    var hookT0 = perfNow();
    if (!event || (typeof event.button === 'number' && event.button !== 0)) { return; }
    var fromPreviewEditor = isSearchPreviewEditorTarget(event.target);
    if (isSearchUiEventTarget(event.target) && !fromPreviewEditor) { return; }
    if (fromPreviewEditor) {
      var previewRoot = event.target && event.target.closest ? event.target.closest('.ij-find-overlay') : null;
      bringSearchPanelToFront(previewRoot || panel);
    }
    if (event.type !== 'pointerdown' && matchesLastCallGraphInlayActivation(event)) {
      try {
        event.preventDefault();
        event.stopPropagation();
        if (event.stopImmediatePropagation) { event.stopImmediatePropagation(); }
      } catch (eStopDup) {}
      reportCallGraphInlayHook('duplicate', hookT0, event, null, 'duplicate');
      return;
    }
    var hit = findCallGraphInlayElement(event.target, event.clientX, event.clientY);
    if (!hit || !hit.kind) {
      reportCallGraphInlayHook('pointerdown', hookT0, event, hit, 'miss');
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      reportCallGraphInlayHook('pointerdown', hookT0, event, hit, 'native-modifier');
      return;
    }
    // Decide whether this hit belongs to our absolutely-positioned
    // callgraph layer OR to a VSCode native InlayHint span rendered
    // inline by InlayHintsController (Pylance, our own provider, etc.).
    //
    // Our production span (rendererPatch.ts ~5937): class
    // "ij-find-preview-inlay ijss-callgraph" + data-ijss-callgraph-
    // symbol-id, inside .ij-find-preview-monaco-inlay-layer.
    //
    // Native inlay path: VSCode does NOT fire InlayHintLabelPart.command
    // on a plain click — only on cmd/ctrl+click or via the
    // hover-popup's "Execute command" button. Users expect plain click
    // to work for our callgraph "usages N / impl N / callees N" inlays
    // (#46 user report). We own those clicks too — but with
    // line-based dispatch (column 0) so the extension host falls
    // through to its line-based symbol resolution instead of trying to
    // match an inlay column that doesn't exist for that symbol.
    var isOwnInlay = false;
    try {
      var probe = hit.element;
      for (var depth = 0; probe && depth < 6; depth++, probe = probe.parentElement) {
        if (!probe || probe === document.body) { break; }
        if (probe.getAttribute && probe.getAttribute('data-ijss-callgraph-symbol-id')) { isOwnInlay = true; break; }
        if (probe.classList && probe.classList.contains('ijss-callgraph')) { isOwnInlay = true; break; }
        if (probe.classList && probe.classList.contains('ij-find-preview-monaco-inlay-layer')) { isOwnInlay = true; break; }
        if (probe.classList && (probe.classList.contains('view-line') || probe.classList.contains('monaco-editor'))) { break; }
      }
    } catch (eOwnProbe) {}
    if (!isOwnInlay) {
      // Native callgraph inlay (text pattern "usages N" etc.). Dispatch
      // to the extension host. Two paths depending on what we can
      // resolve:
      //   1. widget + getTargetAtClientPoint → uri + line → dispatch
      //      activateCallGraphInlayAtPosition with column 0 (extension
      //      host falls back to line-based symbol resolution).
      //   2. widget unavailable (workbench editor wasn't captured by our
      //      Monaco probe, e.g., main editor in captain) → fall back to
      //      visible-line + activateCallGraphInlayAtVisibleLine, which
      //      uses vscode.window.activeTextEditor for URI.
      if (hit.kind === 'usages' || hit.kind === 'impl' || hit.kind === 'callees') {
        var widget = findEditorWidgetForInlayElement(hit.element);
        // #49 user-suggested highest-priority path: at render time the
        // MutationObserver stamps every native callgraph inlay with
        // data-ijss-render-line / -kind / -text reflecting the EXACT
        // (line, kind) the symbol was rendered for. If the clicked
        // element (or any ancestor up to .view-line) carries these
        // attrs, use them directly — no line/col reconstruction, no
        // visible-line drift across virtual scroll / wrap / fold.
        var renderTaggedSpan = null;
        var renderLine = -1;
        var renderKind = '';
        var renderSymbolId = '';
        var renderSymbolLabel = '';
        try {
          var walk = hit.element;
          for (var depthRt = 0; walk && depthRt < 6; depthRt++, walk = walk.parentElement) {
            if (!walk || walk === document.body) { break; }
            if (walk.classList && walk.classList.contains('view-line')) { break; }
            if (walk.getAttribute && walk.getAttribute('data-ijss-render-line')) {
              renderTaggedSpan = walk;
              renderLine = parseInt(walk.getAttribute('data-ijss-render-line'), 10);
              renderKind = walk.getAttribute('data-ijss-render-kind') || hit.kind;
              renderSymbolId = walk.getAttribute('data-ijss-render-symbol-id') || '';
              renderSymbolLabel = walk.getAttribute('data-ijss-render-symbol-label') || '';
              break;
            }
          }
        } catch (eRtWalk) {}
        // Highest-priority path: render-time tag carries symbolId — dispatch
        // showXxxForSymbol directly, bypassing line/registry resolution.
        if (renderTaggedSpan && renderSymbolId) {
          try {
            event.preventDefault();
            event.stopPropagation();
            if (event.stopImmediatePropagation) { event.stopImmediatePropagation(); }
          } catch (eStopSym) {}
          rememberCallGraphInlayActivation(event, hit);
          var symCommand = commandForPreviewCallGraphInlayKind(renderKind);
          var symArgs = [renderSymbolId, renderSymbolLabel];
          trace('preview/inlay/click', {
            source: 'native-callgraph-render-tagged-symbol',
            kind: renderKind,
            symbolId: renderSymbolId,
            label: renderSymbolLabel,
            inlayText: (renderTaggedSpan.getAttribute('data-ijss-render-text') || '').slice(0, 80),
            inlayClasses: ((renderTaggedSpan.className || '') + '').slice(0, 120),
            command: symCommand,
            args: symArgs,
            renderLine: renderLine,
          });
          sendPersistent({
            type: 'runCommand',
            command: symCommand,
            args: symArgs,
          });
          reportCallGraphInlayHook('pointerdown', hookT0, event, hit, 'native-callgraph-render-tagged-symbol');
          return;
        }
        if (renderTaggedSpan && Number.isFinite(renderLine) && renderLine >= 0) {
          try {
            event.preventDefault();
            event.stopPropagation();
            if (event.stopImmediatePropagation) { event.stopImmediatePropagation(); }
          } catch (eStopTag) {}
          rememberCallGraphInlayActivation(event, hit);
          var renderUri = widget && widget.getModel && widget.getModel() && widget.getModel().uri
            ? String(widget.getModel().uri.toString())
            : '';
          var renderArgs = renderUri
            ? [renderKind, renderUri, renderLine, 1000000]
            : null;
          trace('preview/inlay/click', {
            source: 'native-callgraph-render-tagged',
            kind: renderKind,
            symbolId: null,
            label: null,
            inlayText: (renderTaggedSpan.getAttribute('data-ijss-render-text') || '').slice(0, 80),
            inlayClasses: ((renderTaggedSpan.className || '') + '').slice(0, 120),
            command: renderUri ? 'intellijStyledSearch.activateCallGraphInlayAtPosition' : null,
            args: renderArgs,
            renderLine: renderLine,
            renderUri: renderUri,
          });
          if (renderArgs) {
            sendPersistent({
              type: 'runCommand',
              command: 'intellijStyledSearch.activateCallGraphInlayAtPosition',
              args: renderArgs,
            });
            reportCallGraphInlayHook('pointerdown', hookT0, event, hit, 'native-callgraph-render-tagged');
            return;
          }
          // No URI available — let the lower fallbacks run.
        }
        // #48 user-suggested fast-fast-path: Monaco already attached the
        // exact InlayHintLabelPart (with command + symbolId arguments) to
        // the mouse target's injectedText. Read it directly and dispatch
        // — no line/col reconstruction, no provider re-query, no nearby
        // fallback. This is the same path the inlay's hover-popup
        // "Execute command" button takes.
        var inlayLabel = extractInlayHintLabelPartFromClick(widget, event);
        if (inlayLabel) {
          try {
            event.preventDefault();
            event.stopPropagation();
            if (event.stopImmediatePropagation) { event.stopImmediatePropagation(); }
          } catch (eStopInjected) {}
          rememberCallGraphInlayActivation(event, hit);
          trace('preview/inlay/click', {
            source: 'native-callgraph-inlay-label',
            kind: hit.kind,
            symbolId: inlayLabel.commandArguments && inlayLabel.commandArguments[0] || null,
            label: inlayLabel.commandArguments && inlayLabel.commandArguments[1] || null,
            inlayText: ((hit.element && hit.element.textContent) || '').slice(0, 80),
            inlayClasses: ((hit.element && hit.element.className) || '').slice(0, 120),
            command: inlayLabel.commandId,
            args: inlayLabel.commandArguments,
          });
          sendPersistent({
            type: 'runCommand',
            command: inlayLabel.commandId,
            args: inlayLabel.commandArguments,
          });
          reportCallGraphInlayHook('pointerdown', hookT0, event, hit, 'native-callgraph-inlay-label');
          return;
        }
        var pos = editorPositionFromInlayClick(widget, event);
        if (widget && pos) {
          try {
            event.preventDefault();
            event.stopPropagation();
            if (event.stopImmediatePropagation) { event.stopImmediatePropagation(); }
          } catch (eStopNativePos) {}
          rememberCallGraphInlayActivation(event, hit);
          // Registry indexes inlays by (line, kind, *line-end column*).
          // Sending pos.column (Monaco's line-end at the inlay) hits the
          // exact entry instead of nearby-fallback (col=0 drift bug).
          // The trailing inlayText arg lets the extension host disambiguate
          // when line drift (overscan/wrap/fold) maps us to a neighbor line
          // — it then scans hints in a small window and picks the one whose
          // label-part text matches exactly (e.g., "usages 50").
          var inlayTextForDispatch = ((hit.element && hit.element.textContent) || '').trim().slice(0, 120);
          var posLineCol = [hit.kind, pos.uri, pos.line, pos.column, inlayTextForDispatch];
          trace('preview/inlay/click', {
            source: 'native-callgraph-dispatch',
            kind: hit.kind,
            symbolId: null,
            label: null,
            inlayText: inlayTextForDispatch,
            inlayClasses: ((hit.element && hit.element.className) || '').slice(0, 120),
            command: 'intellijStyledSearch.activateCallGraphInlayAtPosition',
            args: posLineCol,
          });
          sendPersistent({
            type: 'runCommand',
            command: 'intellijStyledSearch.activateCallGraphInlayAtPosition',
            args: posLineCol,
          });
          reportCallGraphInlayHook('pointerdown', hookT0, event, hit, 'native-callgraph-dispatch');
          return;
        }
        // Cmd/Ctrl+click redispatch — try BEFORE the visible-line
        // fallback. visible-line uses lineOrdinal + inlayText drift
        // recovery, but when the inlay text is non-unique on a page
        // (e.g., several "usages 1" or "usages 3" inlays) the drift
        // matcher picks the closest line, which is wrong ~20% of the
        // time per captain log. Cmd/Ctrl+click delegates the
        // symbol-resolution to Monaco's own InlayHintsController which
        // owns 100% accurate metadata regardless of widget capture or
        // text uniqueness. Trigger this whenever the prior fast paths
        // missed — not only when widget=null, since the widget+pos
        // path also frequently misses on workbench inlays even when
        // findEditorWidgetForInlayElement returns a stale capture.
        if (simulateCmdClickOnInlay(hit.element, event)) {
          try {
            event.preventDefault();
            event.stopPropagation();
            if (event.stopImmediatePropagation) { event.stopImmediatePropagation(); }
          } catch (eStopCmdSim) {}
          rememberCallGraphInlayActivation(event, hit);
          trace('preview/inlay/click', {
            source: 'native-callgraph-cmd-redispatch',
            kind: hit.kind,
            symbolId: null,
            label: null,
            inlayText: ((hit.element && hit.element.textContent) || '').slice(0, 80),
            inlayClasses: ((hit.element && hit.element.className) || '').slice(0, 120),
            command: '(synthetic cmd/ctrl+click -> Monaco native InlayHintsController)',
            args: null,
            widgetCaptured: !!widget,
          });
          reportCallGraphInlayHook('pointerdown', hookT0, event, hit, 'native-callgraph-cmd-redispatch');
          return;
        }
        var visibleLine = visibleLineOrdinalFromInlayDom(hit.element, event);
        if (visibleLine) {
          try {
            event.preventDefault();
            event.stopPropagation();
            if (event.stopImmediatePropagation) { event.stopImmediatePropagation(); }
          } catch (eStopNativeVl) {}
          rememberCallGraphInlayActivation(event, hit);
          // #48: pass the line-end column sentinel (1_000_000) that
          // visibleLineOrdinalFromInlayDom already computed. Extension
          // host then uses registry exact-match for (line, kind,
          // line-end-col) instead of falling back to nearby-search.
          // Pass inlay text so ext host can disambiguate when ordinal
          // drifts (Monaco view-line recycle / overscan / wrap).
          var inlayTextForVlDispatch = ((hit.element && hit.element.textContent) || '').trim().slice(0, 120);
          var vlArgs = [hit.kind, visibleLine.lineOrdinal, visibleLine.column, inlayTextForVlDispatch];
          trace('preview/inlay/click', {
            source: 'native-callgraph-visible-line',
            kind: hit.kind,
            symbolId: null,
            label: null,
            inlayText: inlayTextForVlDispatch,
            inlayClasses: ((hit.element && hit.element.className) || '').slice(0, 120),
            command: 'intellijStyledSearch.activateCallGraphInlayAtVisibleLine',
            args: vlArgs,
          });
          sendPersistent({
            type: 'runCommand',
            command: 'intellijStyledSearch.activateCallGraphInlayAtVisibleLine',
            args: vlArgs,
          });
          reportCallGraphInlayHook('pointerdown', hookT0, event, hit, 'native-callgraph-visible-line');
          return;
        }
      }
      reportCallGraphInlayHook('pointerdown', hookT0, event, hit, 'native-pass-through');
      return;
    }
    var widget = findEditorWidgetForInlayElement(hit.element);
    var position = editorPositionFromInlayClick(widget, event);
    if (position) {
      try {
        event.preventDefault();
        event.stopPropagation();
        if (event.stopImmediatePropagation) { event.stopImmediatePropagation(); }
      } catch (eStop) {}
      rememberCallGraphInlayActivation(event, hit);
      var ownPosSymbolId = (hit.element && hit.element.getAttribute && hit.element.getAttribute('data-ijss-callgraph-symbol-id')) || null;
      var ownPosLabel = (hit.element && hit.element.getAttribute && hit.element.getAttribute('data-ijss-callgraph-label')) || null;
      trace('preview/inlay/click', {
        source: 'own-position',
        kind: hit.kind,
        symbolId: ownPosSymbolId,
        label: ownPosLabel,
        inlayText: ((hit.element && hit.element.textContent) || '').slice(0, 80),
        inlayClasses: ((hit.element && hit.element.className) || '').slice(0, 120),
        command: 'intellijStyledSearch.activateCallGraphInlayAtPosition',
        args: [hit.kind, position.uri, position.line, position.column],
      });
      sendPersistent({
        type: 'runCommand',
        command: 'intellijStyledSearch.activateCallGraphInlayAtPosition',
        args: [hit.kind, position.uri, position.line, position.column],
      });
      reportCallGraphInlayHook('pointerdown', hookT0, event, hit, 'hit-position');
      return;
    }
    var visibleLine = visibleLineOrdinalFromInlayDom(hit.element, event);
    if (visibleLine) {
      try {
        event.preventDefault();
        event.stopPropagation();
        if (event.stopImmediatePropagation) { event.stopImmediatePropagation(); }
      } catch (eStopVisibleLine) {}
      rememberCallGraphInlayActivation(event, hit);
      var ownVlSymbolId = (hit.element && hit.element.getAttribute && hit.element.getAttribute('data-ijss-callgraph-symbol-id')) || null;
      var ownVlLabel = (hit.element && hit.element.getAttribute && hit.element.getAttribute('data-ijss-callgraph-label')) || null;
      trace('preview/inlay/click', {
        source: 'own-visible-line',
        kind: hit.kind,
        symbolId: ownVlSymbolId,
        label: ownVlLabel,
        inlayText: ((hit.element && hit.element.textContent) || '').slice(0, 80),
        inlayClasses: ((hit.element && hit.element.className) || '').slice(0, 120),
        command: 'intellijStyledSearch.activateCallGraphInlayAtVisibleLine',
        args: [hit.kind, visibleLine.lineOrdinal, visibleLine.column],
      });
      sendPersistent({
        type: 'runCommand',
        command: 'intellijStyledSearch.activateCallGraphInlayAtVisibleLine',
        args: [hit.kind, visibleLine.lineOrdinal, visibleLine.column],
      });
      reportCallGraphInlayHook('pointerdown', hookT0, event, hit, 'hit-visible-line');
      return;
    }
    reportCallGraphInlayHook('pointerdown', hookT0, event, hit, 'hit-no-position');
  }

  function suppressCallGraphInlayClick(event) {
    var hookT0 = perfNow();
    if (matchesLastCallGraphInlayActivation(event)) {
      try {
        event.preventDefault();
        event.stopPropagation();
        if (event.stopImmediatePropagation) { event.stopImmediatePropagation(); }
      } catch (eStopCached) {}
      reportCallGraphInlayHook('click', hookT0, event, null, 'duplicate');
      return;
    }
    if (isSearchUiEventTarget(event.target) && !isSearchPreviewEditorTarget(event.target)) { return; }
    var hit = findCallGraphInlayElement(event.target, event.clientX, event.clientY);
    if (!hit) {
      reportCallGraphInlayHook('click', hookT0, event, hit, 'miss');
      return;
    }
    // Only suppress the click that follows a pointer/mouse down we already
    // handled. Fresh clicks should keep VS Code's native inlay command path,
    // which carries the exact symbol id.
    reportCallGraphInlayHook('click', hookT0, event, hit, 'pass-through');
  }

  function removePriorCallGraphInlayListeners() {
    try {
      var registered = window.__ijFindCallGraphInlayListeners || {};
      if (registered.pointerdown) { document.removeEventListener('pointerdown', registered.pointerdown, true); }
      if (registered.mousedown) { document.removeEventListener('mousedown', registered.mousedown, true); }
      if (registered.click) { document.removeEventListener('click', registered.click, true); }
    } catch (eRegistered) {}
    try {
      if (typeof getEventListeners !== 'function') { return; }
      var events = getEventListeners(document) || {};
      var eventTypes = ['pointerdown', 'mousedown', 'click'];
      for (var et = 0; et < eventTypes.length; et++) {
        var type = eventTypes[et];
        var listeners = events[type] || [];
        for (var li = 0; li < listeners.length; li++) {
          var listener = listeners[li] && listeners[li].listener;
          if (typeof listener !== 'function') { continue; }
          var src = '';
          try { src = Function.prototype.toString.call(listener); } catch (eSrc) {}
          if (!/handleCallGraphInlayMouseDown|suppressCallGraphInlayClick|activateCallGraphInlayAtPosition/.test(src)) { continue; }
          try { document.removeEventListener(type, listener, true); } catch (eTrue) {}
          try { document.removeEventListener(type, listener, false); } catch (eFalse) {}
        }
      }
    } catch (eDevtools) {}
  }

  removePriorCallGraphInlayListeners();
  if (__ijFindEnableRendererInlayClickHook) {
    if (window.PointerEvent) {
      document.addEventListener('pointerdown', handleCallGraphInlayMouseDown, true);
    } else {
      document.addEventListener('mousedown', handleCallGraphInlayMouseDown, true);
    }
    document.addEventListener('click', suppressCallGraphInlayClick, true);
    window.__ijFindCallGraphInlayListeners = {
      pointerdown: window.PointerEvent ? handleCallGraphInlayMouseDown : null,
      mousedown: window.PointerEvent ? null : handleCallGraphInlayMouseDown,
      click: suppressCallGraphInlayClick,
      enabled: true,
    };
  } else {
    window.__ijFindCallGraphInlayListeners = {
      pointerdown: null,
      mousedown: null,
      click: null,
      enabled: false,
    };
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
      var editors = collectWorkbenchMonacoEditorElements();
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
             ' editors=' + editors.length +
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
        minimap: previewMinimapOptions(),
        scrollBeyondLastLine: false,
        lineNumbers: 'on',
        glyphMargin: false,
        folding: true,
        contextmenu: true,
        copyWithSyntaxHighlighting: true,
        fontSize: 12,
        renderLineHighlight: 'all',
        occurrencesHighlight: true,
        fixedOverflowWidgets: true,
        overflowWidgetsDomNode: getOrCreatePreviewOverflowHost(),
        hover: previewHoverOptions(),
        inlayHints: previewInlayHintsOptions(),
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
      var focusText = '';
      try {
        for (var fl = 0; fl < (msg.lines || []).length; fl++) {
          if (msg.lines[fl] && msg.lines[fl].lineNumber === msg.focusLine) {
            focusText = String(msg.lines[fl].text || '');
            break;
          }
        }
      } catch (eFocusText) {}
      var ranges = sanitizeRangesForText(focusText, msg.ranges || []).map(function (r) {
        return new api.Range(focusLine, r.start + 1, focusLine, r.end + 1);
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
            minimap: previewMinimapMatchOptions(idx === 0),
          },
        };
      }));
    } catch (e) {}
  }

  function boundedPreviewLines(msg) {
    var rawLines = Array.isArray(msg && msg.lines) ? msg.lines : [];
    var maxLines = 360;
    var maxChars = 1600;
    var startIdx = 0;
    var endIdx = rawLines.length;
    var omittedBefore = 0;
    var omittedAfter = 0;
    if (rawLines.length > maxLines) {
      var focusIdx = -1;
      for (var fi = 0; fi < rawLines.length; fi++) {
        if (rawLines[fi] && rawLines[fi].lineNumber === msg.focusLine) { focusIdx = fi; break; }
      }
      if (focusIdx < 0) { focusIdx = 0; }
      var half = Math.floor(maxLines / 2);
      startIdx = Math.max(0, Math.min(focusIdx - half, rawLines.length - maxLines));
      endIdx = Math.min(rawLines.length, startIdx + maxLines);
      omittedBefore = startIdx;
      omittedAfter = rawLines.length - endIdx;
    }
    var out = [];
    for (var i = startIdx; i < endIdx; i++) {
      var line = rawLines[i] || {};
      var text = String(line.text || '');
      if (text.length > maxChars) { text = text.slice(0, maxChars) + '...'; }
      out.push({ lineNumber: line.lineNumber, text: text });
    }
    return { lines: out, omittedBefore: omittedBefore, omittedAfter: omittedAfter };
  }

  function normalizePreviewCallGraphInlay(raw) {
    if (!raw || typeof raw !== 'object') { return null; }
    var line = typeof raw.line === 'number' ? raw.line :
      (typeof raw.lineNumber === 'number' ? raw.lineNumber : NaN);
    if (!Number.isFinite(line)) { return null; }
    var symbolId = String(raw.symbolId || raw.id || '');
    if (!symbolId) { return null; }
    var kind = String(raw.kind || callGraphInlayKindFromText(String(raw.text || raw.label || '')) || 'usages');
    if (kind === 'implementation') { kind = 'impl'; }
    if (kind !== 'usages' && kind !== 'callees' && kind !== 'impl') { kind = 'usages'; }
    var text = String(raw.text || '');
    if (!text) {
      var count = typeof raw.count === 'number' && raw.count >= 0 ? raw.count : '';
      text = kind + (count === '' ? '' : ' ' + count);
    }
    return {
      line: Math.max(0, Math.floor(line)),
      column: typeof raw.column === 'number' ? Math.max(0, Math.floor(raw.column)) : 0,
      kind: kind,
      text: text || kind,
      symbolId: symbolId,
      label: String(raw.label || raw.name || ''),
    };
  }

  function previewCallGraphInlaysByLine(msg) {
    var byLine = {};
    var raw = Array.isArray(msg && msg.callGraphInlays) ? msg.callGraphInlays : [];
    for (var i = 0; i < raw.length; i++) {
      var inlay = normalizePreviewCallGraphInlay(raw[i]);
      if (!inlay) { continue; }
      var key = String(inlay.line);
      if (!byLine[key]) { byLine[key] = []; }
      byLine[key].push(inlay);
    }
    for (var line in byLine) {
      byLine[line].sort(function (a, b) { return a.column - b.column; });
    }
    return byLine;
  }

  function previewCallGraphInlayCountByLine(byLine) {
    var count = 0;
    for (var line in (byLine || {})) {
      if (!Object.prototype.hasOwnProperty.call(byLine, line)) { continue; }
      count += byLine[line] ? byLine[line].length : 0;
    }
    return count;
  }

  function commandForPreviewCallGraphInlayKind(kind) {
    if (kind === 'callees') { return 'intellijStyledSearch.showCalleesForSymbol'; }
    if (kind === 'impl') { return 'intellijStyledSearch.showImplementationsForSymbol'; }
    return 'intellijStyledSearch.showUsagesForSymbol';
  }

  function titleForCallGraphInlayKind(kind) {
    if (kind === 'callees') { return 'Find Callees'; }
    if (kind === 'impl') { return 'Find Implementations'; }
    return 'Find Usages';
  }

  function appendDomPreviewCallGraphInlays(lineEl, lineNumber, inlaysByLine) {
    var lineInlays = inlaysByLine && inlaysByLine[String(lineNumber)];
    if (!lineInlays || lineInlays.length === 0) { return; }
    for (var i = 0; i < lineInlays.length; i++) {
      var inlay = lineInlays[i];
      var attrs = {
        'data-ijss-callgraph-symbol-id': inlay.symbolId,
        'data-ijss-callgraph-kind': inlay.kind,
        'data-ijss-callgraph-label': inlay.label,
        'data-ijss-callgraph-column': String(inlay.column),
        'role': 'button',
        'tabindex': '0',
        'aria-label': (inlay.label ? inlay.label + ' ' : '') + inlay.text,
      };
      lineEl.appendChild(el('span', {
        className: 'ij-find-preview-inlay ijss-callgraph',
        text: inlay.text,
        title: inlay.label ? inlay.label : inlay.text,
        attrs: attrs,
      }));
    }
  }

  function renderPreviewDOM(msg) {
    var previewT0 = perfNow();
    var renderedLines = 0;
    var omittedBefore = 0;
    var omittedAfter = 0;
    var previewError = null;
    startPerfWatch('preview:dom', 8000);
    panelDiagMark('preview:dom:start', {
      uri: msg && msg.uri ? String(msg.uri).slice(-120) : '',
      lineCount: msg && msg.lines ? msg.lines.length : 0,
      focusLine: msg ? msg.focusLine : undefined,
    });
    trace('preview:dom:start', {
      uri: msg && msg.uri ? String(msg.uri).slice(-120) : '',
      lineCount: msg && msg.lines ? msg.lines.length : 0,
      focusLine: msg ? msg.focusLine : undefined,
    });
    try {
      ensureFullPanelStructure('preview-dom-start');
      if (state.stolenEditor) { restoreStolenEditor(); }
      state.previewMode = 'dom';
      clearPreviewMonacoCallGraphInlays();
      // If we previously hosted Monaco, detach it.
      if (state.monacoEditor && state.monacoHost && state.monacoHost.parentElement === $previewBody) {
        try { state.monacoHost.parentElement.removeChild(state.monacoHost); } catch (e) {}
      }
      $previewBody.classList.remove('ij-find-editor-mounted');
      clearChildren($previewBody);
      var bounded = boundedPreviewLines(msg);
      omittedBefore = bounded.omittedBefore;
      omittedAfter = bounded.omittedAfter;
      var contentEl = el('div', { className: 'ij-find-preview-content' });
      var focusEl = null;
      var frag = document.createDocumentFragment();
      var inlaysByLine = previewCallGraphInlaysByLine(msg);
      send({ type: 'log', msg: 'preview dom inlays render uri=' + (msg && msg.uri || '') + ' previewSeq=' + (msg && typeof msg.previewSeq === 'number' ? msg.previewSeq : 'none') + ' count=' + previewCallGraphInlayCountByLine(inlaysByLine) });
      if (bounded.omittedBefore > 0) {
        frag.appendChild(el('div', {
          className: 'ij-find-preview-line ij-find-preview-truncated',
          text: '... ' + bounded.omittedBefore + ' earlier line(s) omitted',
        }));
      }
      for (var i = 0; i < bounded.lines.length; i++) {
        var line = bounded.lines[i];
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
        appendDomPreviewCallGraphInlays(lineEl, line.lineNumber, inlaysByLine);
        frag.appendChild(lineEl);
        if (isFocus) { focusEl = lineEl; }
      }
      renderedLines = bounded.lines.length;
      if (bounded.omittedAfter > 0) {
        frag.appendChild(el('div', {
          className: 'ij-find-preview-line ij-find-preview-truncated',
          text: '... ' + bounded.omittedAfter + ' later line(s) omitted',
        }));
      }
      contentEl.appendChild(frag);
      $previewBody.appendChild(contentEl);
      if (focusEl) {
        setTimeout(function () {
          try { focusEl.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
        }, 0);
      }
    } catch (eDomPreview) {
      previewError = eDomPreview;
      send({ type: 'log', msg: 'renderPreviewDOM threw: ' + (eDomPreview && eDomPreview.message) });
      try {
        state.previewMode = 'dom';
        $previewBody.classList.remove('ij-find-editor-mounted');
        clearChildren($previewBody);
        $previewBody.appendChild(el('div', {
          className: 'ij-find-preview-content',
          children: [el('div', {
            className: 'ij-find-preview-line ij-find-preview-truncated',
            text: 'Preview fallback render failed. Select another result or reopen search.',
          })],
        }));
      } catch (eDomPreviewFallback) {}
    } finally {
      ensureFullPanelStructure('preview-dom-end');
      trace('preview:dom:end', {
        renderedLines: renderedLines,
        omittedBefore: omittedBefore,
        omittedAfter: omittedAfter,
        durationMs: Math.round(perfNow() - previewT0),
        error: previewError && previewError.message ? String(previewError.message).slice(0, 160) : '',
      });
      panelDiagMark('preview:dom:end', {
        renderedLines: renderedLines,
        omittedBefore: omittedBefore,
        omittedAfter: omittedAfter,
        durationMs: Math.round(perfNow() - previewT0),
        error: previewError && previewError.message ? String(previewError.message).slice(0, 160) : '',
      });
      reportPerfPhase('preview:dom', previewT0, {
        renderedLines: renderedLines,
        omittedBefore: omittedBefore,
        omittedAfter: omittedAfter,
      }, 10);
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
    on(a, 'click', function (e) {
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

  // Hover lifecycle removed in #32 — Monaco's native hover handles all
  // popovers via the embedded preview editor. The no-op stubs below let
  // legacy call sites (clearPreview, minimize, disposeSearchUi recovery)
  // keep their try/catch wrappers without churn.
  var hoverHideTimer = null;
  function cancelHoverHide() { if (hoverHideTimer) { clearTimeout(hoverHideTimer); hoverHideTimer = null; } }
  function scheduleHoverHide(_delayMs) { /* no-op after #32 */ }
  function hideHover() { cancelHoverHide(); state.lastHoverKey = ''; }

  var __ijFindLastDomPreviewInlayActivation = null;
  function closestDomPreviewCallGraphInlay(target) {
    try {
      var el = target && target.nodeType === 3 ? target.parentElement : target;
      if (!el || !el.closest) { return null; }
      var inlay = el.closest('[data-ijss-callgraph-symbol-id]');
      if (!inlay || !$previewBody.contains(inlay)) { return null; }
      return inlay;
    } catch (eDomInlayTarget) {
      return null;
    }
  }

  function suppressDomPreviewInlayEvent(event) {
    try {
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) { event.stopImmediatePropagation(); }
    } catch (eSuppressDomInlay) {}
  }

  function recentlyActivatedDomPreviewInlay(event, inlay) {
    try {
      var last = __ijFindLastDomPreviewInlayActivation;
      if (!last || Date.now() - last.at > 900) { return false; }
      return last.inlay === inlay &&
        Math.abs((event.clientX || 0) - last.x) <= 3 &&
        Math.abs((event.clientY || 0) - last.y) <= 3;
    } catch (eRecentDomInlay) {
      return false;
    }
  }

  function activateDomPreviewCallGraphInlay(event) {
    if (!event) { return; }
    var keyboard = event.type === 'keydown';
    if (keyboard) {
      var key = String(event.key || '');
      if (key !== 'Enter' && key !== ' ') { return; }
    } else if (typeof event.button === 'number' && event.button !== 0) {
      return;
    }
    var inlay = closestDomPreviewCallGraphInlay(event.target);
    if (!inlay) { return; }
    if (!keyboard && event.type !== 'pointerdown' && recentlyActivatedDomPreviewInlay(event, inlay)) {
      suppressDomPreviewInlayEvent(event);
      return;
    }
    var symbolId = inlay.getAttribute('data-ijss-callgraph-symbol-id') || '';
    if (!symbolId) { return; }
    var kind = inlay.getAttribute('data-ijss-callgraph-kind') || callGraphInlayLabelKindForElement(inlay) || 'usages';
    var label = inlay.getAttribute('data-ijss-callgraph-label') || '';
    suppressDomPreviewInlayEvent(event);
    try {
      __ijFindLastDomPreviewInlayActivation = {
        at: Date.now(),
        inlay: inlay,
        x: event.clientX || 0,
        y: event.clientY || 0,
      };
    } catch (eRememberDomInlay) {}
    var resolvedCommand = commandForPreviewCallGraphInlayKind(kind);
    trace('preview/inlay/click', {
      source: 'absolute-layer',
      kind: kind,
      symbolId: symbolId,
      label: label,
      inlayText: ((inlay.textContent || '') + '').slice(0, 80),
      inlayClasses: ((inlay.className || '') + '').slice(0, 120),
      command: resolvedCommand,
      args: [symbolId, label],
    });
    sendPersistent({
      type: 'runCommand',
      command: resolvedCommand,
      args: [symbolId, label],
    });
  }

  // Mousedown in the preview pane must hand focus to the Monaco editor. Without
  // this, dragging to select or Shift+arrow keeps focus on the overlay query,
  // and Monaco renders the selection in its "inactive" style — which the theme
  // draws as near-transparent, so users see selection markers in the minimap
  // overview but nothing in the actual editor. Focusing the editor flips the
  // selection layer to the theme's active color AND wires up cursor-position
  // indicators on the scrollbar / minimap.
  on($previewBody, 'pointerdown', activateDomPreviewCallGraphInlay, true);
  on($previewBody, 'mousedown', activateDomPreviewCallGraphInlay, true);
  on($previewBody, 'click', activateDomPreviewCallGraphInlay, true);
  on($previewBody, 'keydown', activateDomPreviewCallGraphInlay, true);

  on($previewBody, 'mousedown', function () {
    var ed = state.previewMonacoEditor || state.monacoEditor;
    if (ed && typeof ed.focus === 'function') {
      try { ed.focus(); } catch (e) {}
    }
  }, true);

  // DOM-fallback mouse-hover dispatch was removed in #32. Monaco's
  // native hover service drives all hover popovers in our preview now
  // (#33 made the embed model resolve hover providers exactly like a
  // workbench file editor would).

	  function showSearchPanel(initialQuery, showOptions) {
	    try {
	      if (Date.now() < (state.recoveryUntil || 0)) { return 'suppressed:recovery'; }
	      var wasVisible = panel.classList.contains('visible');
	      var suppressSearch = !!(showOptions && showOptions.suppressSearch);
	      var forceLiteral = !!(showOptions && showOptions.forceLiteral);
      var preservePreview = !!(showOptions && showOptions.preservePreview);
      var spawnPanel = !!(showOptions && showOptions.spawn);
      var showStatusText = showOptions && typeof showOptions.statusText === 'string' ? showOptions.statusText : '';
      var showLoading = !!(showOptions && showOptions.loading);
      var shellRequested = suppressSearch || !(typeof initialQuery === 'string' && initialQuery.length > 0);
      var shouldShell = false;
      try { window.__ijFindActiveInstanceId = __ijFindInstanceId; } catch (eActiveShow) {}
      setIntelliSenseRecursionCaptureSuspended(true, 'search-ui-visible');
      var showT0 = perfNow();
      startPanelDiagnostics('show', 30000);
      startPerfWatch('show', 15000);
      panelDiagMark('show:start', { queryLen: typeof initialQuery === 'string' ? initialQuery.length : 0, suppressSearch: suppressSearch, shellRequested: shellRequested, shouldShell: shouldShell, wasVisible: !!wasVisible, spawn: spawnPanel });
      trace('show:start', {
        queryLen: typeof initialQuery === 'string' ? initialQuery.length : 0,
        hasNewline: typeof initialQuery === 'string' && initialQuery.indexOf('\\n') >= 0,
        wasVisible: !!wasVisible,
        spawn: spawnPanel,
      });
      if (state.minimized) { restoreSearchPanelFromMinimized(true); }
      var shellT0 = perfNow();
      setShellMode(shouldShell);
      reportPerfPhase('show:setShellMode', shellT0, { shouldShell: shouldShell }, 1);
      var styleT0 = perfNow();
      var spawnBaseRect = spawnPanel ? rectForSpawnBase() : null;
      if (spawnPanel && !wasVisible) {
        if (spawnBaseRect) {
          var spawnWidth = Math.max(420, Math.round(spawnBaseRect.width || 640));
          var spawnHeight = Math.max(320, Math.round(spawnBaseRect.height || 420));
          var spawnPos = offsetPanelPosition(spawnBaseRect, spawnWidth, spawnHeight);
          applyPanelLayout({
            left: spawnPos.left,
            top: spawnPos.top,
            width: spawnWidth,
            height: spawnHeight,
          });
        } else {
          var centeredLayout = defaultSpawnPanelLayout();
          applyPanelLayout(centeredLayout);
          applyPreviewHeavyLayout(centeredLayout.height);
        }
      }
      panel.classList.add('visible');
      panel.style.setProperty('display', 'flex', 'important');
      panel.style.setProperty('visibility', 'visible', 'important');
      panel.style.setProperty('opacity', '1', 'important');
      panel.style.setProperty('pointer-events', 'auto', 'important');
      panel.style.setProperty('z-index', String(10000 + detachedPanelSeq), 'important');
      panel.style.setProperty('position', 'fixed', 'important');
      var mountT0 = perfNow();
      ensureSearchUiMounted(panel);
      reportPerfPhase('show:mount', mountT0, {
        shouldShell: shouldShell,
        parentTag: panel.parentElement && panel.parentElement.tagName ? String(panel.parentElement.tagName).toLowerCase() : '',
      }, 1);
      bringSearchPanelToFront(panel);
      reportPerfPhase('show:style', styleT0, { shouldShell: shouldShell }, 1);
      var themeT0 = perfNow();
      if (!shouldShell) {
        syncPreviewOverflowTheme(panel);
      }
      // $hoverTooltip theme sync + body mount were the DIY hover bring-up
      // path; removed in #32 along with the rest of that subsystem.
      reportPerfPhase('show:themeSync', themeT0, { shouldShell: shouldShell }, 1);
      try {
        var previewOverflowRoot = findPreviewOverflowRootForInstance();
        if (previewOverflowRoot && !shouldShell) {
          document.body.appendChild(previewOverflowRoot);
          syncPreviewOverflowTheme(previewOverflowRoot);
        }
	      } catch (e) {}
      trace('show:visible', { wasVisible: !!wasVisible });
      // Background pre-warm of the preview Monaco editor (B-path). Captain
      // log measured the first cold createPreviewEditor at ~124ms; once we
      // pre-create the editor here, the user's first result-row click hits
      // the reuse path (~13-37ms) instead. Gated to fire only when:
      //  - we don't already have a preview editor (hide-preserved case),
      //  - Monaco capture has captured a ctor + services,
      //  - we're in the main (non-shell) layout so $previewBody is real.
      // We schedule via setTimeout(0) so the show:visible paint happens
      // first; the user sees the panel before we burn 100ms on warmup.
      if (!shouldShell && !state.previewMonacoEditor) {
        setTimeout(function () {
          try { prewarmPreviewMonacoEditor('show'); } catch (ePrewarm) {}
        }, 0);
      }
      // Paint the overlay BEFORE firing the search — otherwise the browser
      // processes our JS (send to extension → runRgSearch → network roundtrip)
      // inside the same microtask and the panel appears only after the first
      // results:start message lands. rAF guarantees one paint first.
      trace('show:options', { suppressSearch: suppressSearch, forceLiteral: forceLiteral, loading: showLoading, preservePreview: preservePreview });
      if (forceLiteral) {
        state.options.useRegex = false;
        state.options.wholeWord = false;
        $optRegex.setAttribute('aria-pressed', 'false');
        $optWord.setAttribute('aria-pressed', 'false');
        syncRegexMultilineUi();
      }
      if (typeof initialQuery === 'string' && (suppressSearch || initialQuery !== $q.value)) {
        panelDiagMark('show:setQuery', { len: initialQuery.length, suppressSearch: suppressSearch });
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
        if (suppressSearch || !initialQuery) {
          panelDiagMark('show:suppressSearch', { len: initialQuery.length, preservePreview: preservePreview });
          cancelScheduledRender();
          if (!preservePreview) {
            clearPreview();
          }
          state.files = [];
          state.flat = [];
          state.candidates = [];
          state.candidateTotal = 0;
          state.confirmedUris = {};
          state.fileIndexByUri = {};
          state.matchCount = 0;
          state.activeIndex = -1;
          state.searching = false;
          state.loadingMore = false;
          state.hasMoreResults = false;
          state.rgQuery = '';
          state.filterQuery = '';
          state.rgScope = '';
          if (state.debounce) { clearTimeout(state.debounce); state.debounce = null; }
          setStatus(showStatusText || (initialQuery ? 'Press Enter or Run to search' : 'Type a query'), showLoading);
          render();
        } else if (extendsCurrent) {
          panelDiagMark('show:extendsCurrent', { len: initialQuery.length });
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
          panelDiagMark('show:autoSearch', { len: initialQuery.length });
          setStatus('Searching\u2026', true);
          render();
          var showSearchFired = false;
	          function fireShowSearch() {
	            if (showSearchFired) { return; }
	            showSearchFired = true;
            trace('show:triggerSearch', { queryLen: typeof initialQuery === 'string' ? initialQuery.length : 0 });
	            triggerSearch(false);
	          }
          requestAnimationFrame(function () {
            requestAnimationFrame(fireShowSearch);
          });
          setTimeout(fireShowSearch, 50);
        }
      }
	      setTimeout(function () {
        var focusT0 = perfNow();
        try { $q.focus(); $q.select(); } catch (e) {}
        reportPerfPhase('show:focusSelect', focusT0, { activeTag: document.activeElement && document.activeElement.tagName ? String(document.activeElement.tagName).toLowerCase() : '' }, 1);
        panelDiagMark('show:focusSelect', {});
      }, 0);
      trace('show:end', { queryLen: typeof initialQuery === 'string' ? initialQuery.length : 0, durationMs: Math.round(perfNow() - showT0) });
      panelDiagMark('show:end', { durationMs: Math.round(perfNow() - showT0) });
      reportPerfPhase('show', showT0, {
        queryLen: typeof initialQuery === 'string' ? initialQuery.length : 0,
        wasVisible: !!wasVisible,
      }, 10);
	      return 'show ok src=' + __ijFindInstanceId;
    } catch (e) { return 'show-err: ' + (e && e.message); }
  }
	  function hideSearchPanel() {
	    var wasVisible = panel.classList.contains('visible');
    trace('hide:start', { wasVisible: !!wasVisible });
    panelDiagMark('hide:start', { wasVisible: !!wasVisible });
    stopPerfWatch('hide');
	    panel.classList.remove('visible');
    if (state.minimized) { restoreSearchPanelFromMinimized(true); }
    if (getFocusedSearchPanel() === panel) { setFocusedSearchPanel(null); }
    panel.classList.remove('ij-find-focused');
    panel.style.removeProperty('display');
    panel.style.removeProperty('visibility');
    panel.style.removeProperty('opacity');
    panel.style.removeProperty('pointer-events');
    panel.style.removeProperty('z-index');
    panel.style.removeProperty('position');
    try {
      if (panel.parentElement) { panel.parentElement.removeChild(panel); }
    } catch (eHideDetachPanel) {}
    // Return any stolen VSCode editor to its editor group.
    if (state.stolenEditor) { restoreStolenEditor(); }
    // Preserve the preview Monaco editor across hide/show cycles so the
    // next show's first preview render hits the reuse path
    // (~13-37ms in captain) instead of paying the 162ms cold create
    // cost again. The panel itself is detached below; the preview host
    // travels inside the panel subtree so previewMonacoHost.parentElement
    // remains $previewBody and canReuse stays true. We DO clear any
    // search-match decorations on hide so a stale highlight from the last
    // result doesn't flash at the next show.
    var preservedEditor = state.previewMonacoEditor;
    try {
      if (preservedEditor && state.previewMonacoMatchDecos) {
        preservedEditor.deltaDecorations(state.previewMonacoMatchDecos, []);
        state.previewMonacoMatchDecos = null;
      }
    } catch (eClearMatchDecos) {}
    try { clearPreviewMonacoCallGraphInlays(); } catch (eClearInlays) {}
    // Reset hydrate flag so the next preview's settle hydrate fires
    // properly (the preserved editor's model might still be file:// from
    // last time, but the next preview will bind a fresh model).
    state.previewHydrated = false;
    // Any in-flight prewarm retry from before this hide is no longer
    // relevant — the next show will reschedule.
    try { cancelPrewarmRetry(); } catch (eCancelWarm) {}
    trace('hide:preserved-preview-editor', { hadEditor: !!preservedEditor });
    // Each panel instance owns its own overflow root (overflow widgets
    // anchored to document.body, separate from the panel's subtree). When
    // a spawned/additional panel is closed forever, its overflow root must
    // be torn down. The main instance's overflow root will be lazily
    // recreated by getOrCreatePreviewOverflowHost on next show.
    try {
      var previewOverflowRoot = findPreviewOverflowRootForInstance();
      if (previewOverflowRoot && previewOverflowRoot.parentElement) {
        previewOverflowRoot.parentElement.removeChild(previewOverflowRoot);
      }
    } catch (eHideOverflowDetach) {}
    cancelScheduledRender();
    if (state.searchTicker) { clearInterval(state.searchTicker); state.searchTicker = null; }
    if (state.debounce) { clearTimeout(state.debounce); state.debounce = null; }
    state.searchId = (state.searchId || 0) + 1;
    state.files = [];
    state.flat = [];
    state.candidates = [];
    state.candidateTotal = 0;
    state.confirmedUris = {};
    state.fileIndexByUri = {};
    state.matchCount = 0;
    state.activeIndex = -1;
    state.searching = false;
    state.loadingMore = false;
    state.hasMoreResults = false;
    state.resultsInfoText = '';
    state.rgQuery = '';
    state.filterQuery = '';
    state.rgScope = '';
    try {
      clearChildren($resultsInner);
      $resultsInner.style.height = 'auto';
    } catch (eClearResults) {}
    hideHover();
    var hasOtherVisibleSearchPanel = hasVisibleSearchPanelExcept(panel);
    if (wasVisible) {
      send({ type: 'cancel' });
      if (!hasOtherVisibleSearchPanel) { send({ type: 'panelHidden' }); }
    }
    if (!hasOtherVisibleSearchPanel) {
      setIntelliSenseRecursionCaptureSuspended(false, 'search-ui-hidden');
    }
    trace('hide:end', { wasVisible: !!wasVisible });
    panelDiagMark('hide:end', { wasVisible: !!wasVisible });
    stopPanelDiagnostics('hide');
    if (window.__ijFindDisposeRendererPatchOnHide) {
      setTimeout(function () {
        try {
          if (typeof window.__ijFindDisposeSearchUi === 'function') {
            disposeSearchUi('hide');
          }
        } catch (eDisposeOnHide) {}
      }, 0);
    }
	  }
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
        ' patchVersion=' + window.__ijFindPatchVersion +
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
  window.__ijFindGetPreviewMonacoStateForTests = function () {
    try {
      var ed = state.previewMonacoEditor;
      var host = state.previewMonacoHost;
      var dom = null;
      var domErr = '';
      try { dom = ed && typeof ed.getDomNode === 'function' ? ed.getDomNode() : null; }
      catch (eDomTest) { domErr = String(eDomTest && eDomTest.message || eDomTest).slice(0, 80); }
      var hostInBody = !!(host && host.parentElement === $previewBody);
      var domInHost = !!(host && dom && dom.parentElement === host);
      var viewLines = 0;
      try { if (dom && dom.querySelectorAll) { viewLines = dom.querySelectorAll('.view-line').length; } } catch (eVlTest) {}
      var modelOk = false;
      try { modelOk = !!(ed && typeof ed.getModel === 'function' && ed.getModel()); } catch (eMoTest) {}
      var disposed = false;
      try {
        if (ed) {
          // Monaco editors expose _isDisposed (StandaloneCodeEditor) and
          // _disposed (CodeEditorWidget). Probe both safely.
          if (typeof ed._isDisposed === 'boolean') { disposed = ed._isDisposed; }
          else if (typeof ed._disposed === 'boolean') { disposed = ed._disposed; }
        }
      } catch (eDisp) {}
      return {
        hasEditor: !!ed,
        hasHost: !!host,
        hostInBody: hostInBody,
        domInHost: domInHost,
        viewLines: viewLines,
        modelOk: modelOk,
        disposed: disposed,
        domErr: domErr,
        previewMode: state.previewMode || null,
        previewUri: state.previewUri || null,
      };
    } catch (eState) {
      return { err: String(eState && eState.message || eState).slice(0, 200) };
    }
  };
  // Used by E2E only: gives tests direct access to the live preview editor
  // widget so they can assert on scrollTop / viewState after refresh
  // scenarios. Refresh on each call rather than caching — the editor
  // instance is recreated on capture refresh / DOM fallback recovery.
  Object.defineProperty(window, '__ijFindPreviewEditorForTests', {
    configurable: true,
    get: function () { return state.previewMonacoEditor; },
  });
  window.__ijFindGetSearchState = function () {
    try {
      return {
        searching: !!state.searching,
        filesCount: (state.files || []).length,
        flatCount: (state.flat || []).length,
        activeIndex: typeof state.activeIndex === 'number' ? state.activeIndex : -1,
        activePreviewSeq: typeof state.activePreviewSeq === 'number' ? state.activePreviewSeq : 0,
        previewMode: state.previewMode || null,
        previewUri: state.previewUri || null,
        previewModelUri: state.previewMonacoEditor && state.previewMonacoEditor.getModel && state.previewMonacoEditor.getModel() && state.previewMonacoEditor.getModel().uri
          ? String(state.previewMonacoEditor.getModel().uri.toString())
          : null,
        previewResourceModelCreates: state.previewResourceModelCreates || 0,
        previewIsolatedModelCreates: state.previewIsolatedModelCreates || 0,
        previewOwnedModelDisposes: state.previewOwnedModelDisposes || 0,
        lspPressureUntil: state.lspPressureUntil || 0,
        lspPressureReason: state.lspPressureReason || '',
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
          hasMinimap: !!(d.options && d.options.minimap),
          minimapColor: d.options && d.options.minimap ? d.options.minimap.color : undefined,
        });
      }
      return { editor: 'ok', decorations: out, lineCount: model.getLineCount ? model.getLineCount() : -1 };
    } catch (e) { return { err: String(e && e.message) }; }
  };
  function acceptFileMatch(match) {
    if (!match || !match.uri) { return false; }
    state.confirmedUris[match.uri] = true;
    var fileIdx = state.fileIndexByUri[match.uri];
    if (typeof fileIdx === 'number' && state.files[fileIdx]) {
      Array.prototype.push.apply(state.files[fileIdx].matches, match.matches || []);
    } else {
      state.fileIndexByUri[match.uri] = state.files.length;
      state.files.push(match);
    }
    state.matchCount += (match.matches || []).length;
    return true;
  }

  function afterResultsChanged() {
    // rg streams in bursts. Rendering on every file nukes the results DOM
    // and runs inside the workbench renderer, so coalesce to one frame.
    scheduleRender();
    updateSearchingStatus();
    if (state.activeIndex < 0) {
      render();
      if (state.flat.length > 0) { selectMatch(0); }
    }
  }

	  function onSearchMessage(msg) {
	    if (__ijFindDisposed) { return 'disposed'; }
	    if (Date.now() < (state.recoveryUntil || 0)) { return 'suppressed:recovery'; }
	    if (!panel.classList.contains('visible') && msg && /^(results:|preview(?::inlays)?$|hover$)/.test(String(msg.type || ''))) {
	      return 'ignored:hidden';
	    }
	    var msgSearchId = typeof msg.searchId === 'number' ? msg.searchId : null;
      var msgT0 = perfNow();
      panelDiagMark('message:start', {
        type: String(msg && msg.type || ''),
        searchId: msgSearchId,
        batch: msg && Array.isArray(msg.matches) ? msg.matches.length : undefined,
      });
      try {
	    switch (msg.type) {
	      case 'results:start':
        panelDiagMark('results:start', { searchId: msgSearchId });
        setShellMode(false);
        startPerfWatch('results:start', 12000);
        trace('results:start', { searchId: msgSearchId });
	        cancelScheduledRender();
        state.files = []; state.flat = []; state.candidates = [];
        state.candidateTotal = 0; state.confirmedUris = {}; state.fileIndexByUri = {};
        state.matchCount = 0;
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
        // Keep progress visible without keeping the workbench renderer hot.
        state.searchTicker = setInterval(function () {
          if (!state.searching) { return; }
          updateSearchingStatus();
        }, 500);
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
	        if (acceptFileMatch(msg.match)) {
          trace('results:file', {
            searchId: msgSearchId,
            uri: msg.match && msg.match.uri ? String(msg.match.uri).slice(-120) : '',
            matches: msg.match && msg.match.matches ? msg.match.matches.length : 0,
          });
          afterResultsChanged();
        }
	        break;
	      case 'results:batch':
	        if (msgSearchId !== null && msgSearchId !== state.searchId) { break; }
	        var batch = Array.isArray(msg.matches) ? msg.matches : [];
        panelDiagMark('results:batch', { searchId: msgSearchId, files: batch.length });
        startPerfWatch('results:batch', 8000);
        trace('results:batch', { searchId: msgSearchId, files: batch.length });
	        var changed = false;
	        for (var bi = 0; bi < batch.length; bi++) {
	          changed = acceptFileMatch(batch[bi]) || changed;
	        }
	        if (changed) { afterResultsChanged(); }
	        break;
	      case 'results:done':
	        if (msgSearchId !== null && msgSearchId !== state.searchId) { break; }
        panelDiagMark('results:done:start', {
          searchId: msgSearchId,
          totalMatches: msg.totalMatches,
          totalFiles: msg.totalFiles,
        });
        startPerfWatch('results:done', 8000);
        trace('results:done:start', {
          searchId: msgSearchId,
          totalMatches: msg.totalMatches,
          totalFiles: msg.totalFiles,
          truncated: !!msg.truncated,
        });
	        cancelScheduledRender();
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
        trace('results:done:end', {
          searchId: msgSearchId,
          flat: state.flat.length,
          activeIndex: state.activeIndex,
        });
        panelDiagMark('results:done:end', {
          searchId: msgSearchId,
          flat: state.flat.length,
          activeIndex: state.activeIndex,
        });
	        break;
      case 'results:error':
        if (msgSearchId !== null && msgSearchId !== state.searchId) { break; }
        cancelScheduledRender();
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
        panelDiagMark('preview:message', {
          uri: msg.uri ? String(msg.uri).slice(-120) : '',
          lineCount: msg.lines && typeof msg.lines.length === 'number' ? msg.lines.length : 0,
        });
        startPerfWatch('preview:message', 8000);
        renderPreview(msg);
        break;
      case 'preview:inlays':
        var previewInlayCount = Array.isArray(msg.callGraphInlays) ? msg.callGraphInlays.length : 0;
        send({ type: 'log', msg: 'preview inlays message uri=' + (msg.uri || '') + ' previewSeq=' + (typeof msg.previewSeq === 'number' ? msg.previewSeq : 'none') + ' count=' + previewInlayCount + ' stateUri=' + (state.previewUri || '') + ' activeSeq=' + state.activePreviewSeq + ' mode=' + (state.previewMode || '') + ' hasLast=' + (!!state.lastPreviewMsg) });
        if (msg.uri && state.previewUri && msg.uri !== state.previewUri) {
          send({ type: 'log', msg: 'preview inlays dropped uri mismatch msgUri=' + msg.uri + ' stateUri=' + state.previewUri });
          break;
        }
        if (typeof msg.previewSeq === 'number' && msg.previewSeq < state.activePreviewSeq) {
          send({ type: 'log', msg: 'preview inlays dropped stale previewSeq=' + msg.previewSeq + ' active=' + state.activePreviewSeq });
          break;
        }
        if (state.lastPreviewMsg) {
          try { state.lastPreviewMsg.callGraphInlays = Array.isArray(msg.callGraphInlays) ? msg.callGraphInlays : []; } catch (eInlayMsg) {}
        }
        if (state.previewMode === 'monaco' && state.previewMonacoEditor) {
          // #44 revert: keep rendering our absolute callgraph layer even
          // after hydrate. The native InlayHintsController does not
          // actually consult our provider for the embedded editor
          // (proven by the "native InlayHint click in embed preview" E2E),
          // so handing off would leave the user with no clickable inlays.
          renderPreviewMonacoCallGraphInlays(state.previewMonacoEditor, msg);
        } else if (state.previewMode === 'dom' && state.lastPreviewMsg) {
          renderPreviewDOM(state.lastPreviewMsg);
        } else {
          send({ type: 'log', msg: 'preview inlays not rendered: mode=' + (state.previewMode || '') + ' hasMonaco=' + (!!state.previewMonacoEditor) + ' hasLast=' + (!!state.lastPreviewMsg) });
        }
        break;
      case 'lspPressure':
        // Diagnostics-driven backpressure: when LSP is overloaded the
        // extension host pushes an until-window during which the renderer
        // should avoid spawning resource-backed Monaco models. We track the
        // ack so tests can assert the renderer is paying attention, and we
        // schedule a one-shot hydrate to upgrade the latest isolated preview
        // model to a resource-bound model once the pressure window expires.
        if (msg && msg.active === false) {
          state.lspPressureUntil = 0;
          state.lspPressureReason = '';
          if (state.lspPressureHydrateTimer) {
            clearTimeout(state.lspPressureHydrateTimer);
            state.lspPressureHydrateTimer = null;
          }
        } else if (msg) {
          var pressureUntil = typeof msg.until === 'number' ? msg.until : 0;
          if (pressureUntil > (state.lspPressureUntil || 0)) {
            state.lspPressureUntil = pressureUntil;
          }
          if (typeof msg.reason === 'string') {
            state.lspPressureReason = msg.reason;
          }
          scheduleLspPressureHydrate();
        }
        break;
    }
      } finally {
        reportPerfPhase('message:' + String(msg && msg.type || ''), msgT0, {
          type: String(msg && msg.type || ''),
          searchId: msgSearchId,
        }, 8);
      }
  }

  function searchInstanceRegistry() {
    try {
      if (!window.__ijFindInstances || typeof window.__ijFindInstances !== 'object') {
        window.__ijFindInstances = {};
      }
      return window.__ijFindInstances;
    } catch (eRegistry) {
      return {};
    }
  }

  function isRegisteredSearchInstanceVisible(inst) {
    try {
      var p = inst && inst.panel;
      if (!p || !p.classList || !p.classList.contains('visible')) { return false; }
      if (typeof p.isConnected === 'boolean') { return p.isConnected; }
      return !!(p.ownerDocument && p.ownerDocument.body && p.ownerDocument.body.contains(p));
    } catch (eVisibleInstance) {
      return false;
    }
  }

  function findRegisteredSearchInstance(targetSrc) {
    try {
      var registry = searchInstanceRegistry();
      if (targetSrc && registry[targetSrc]) { return registry[targetSrc]; }
      var activeId = window.__ijFindActiveInstanceId || '';
      if (activeId && registry[activeId] && isRegisteredSearchInstanceVisible(registry[activeId])) {
        return registry[activeId];
      }
      if (registry[__ijFindInstanceId] && isRegisteredSearchInstanceVisible(registry[__ijFindInstanceId])) {
        return registry[__ijFindInstanceId];
      }
      for (var visibleKey in registry) {
        if (Object.prototype.hasOwnProperty.call(registry, visibleKey) &&
            isRegisteredSearchInstanceVisible(registry[visibleKey])) {
          return registry[visibleKey];
        }
      }
      if (activeId && registry[activeId]) { return registry[activeId]; }
      if (registry[__ijFindInstanceId]) { return registry[__ijFindInstanceId]; }
      for (var key in registry) {
        if (Object.prototype.hasOwnProperty.call(registry, key)) { return registry[key]; }
      }
    } catch (eFindInstance) {}
    return null;
  }

  function registerSearchInstance() {
    try {
      var registry = searchInstanceRegistry();
      registry[__ijFindInstanceId] = {
        id: __ijFindInstanceId,
        panel: panel,
        show: showSearchPanel,
        hide: hideSearchPanel,
        onMessage: onSearchMessage,
        getSearchState: window.__ijFindGetSearchState,
        refreshSearch: refreshSearch,
        setScopeValue: window.__ijFindSetScopeValue,
        getPreviewDecorations: window.__ijFindGetPreviewDecorations,
        getPreviewOverflowHostForTests: getOrCreatePreviewOverflowHost,
        dispose: disposeSearchUi,
      };
      window.__ijFindActiveInstanceId = __ijFindInstanceId;
      window.__ijFindShow = function (initialQuery, showOptions) {
        var targetSrc = showOptions && showOptions.__targetSrc ? String(showOptions.__targetSrc) : '';
        if (!targetSrc && showOptions && showOptions.spawn) {
          try {
            var spawnRegistry = searchInstanceRegistry();
            var spawnInst = spawnRegistry[__ijFindInstanceId];
            if (spawnInst && typeof spawnInst.show === 'function') {
              return spawnInst.show(initialQuery, showOptions || {});
            }
          } catch (eSpawnShowInstance) {}
        }
        var inst = findRegisteredSearchInstance(targetSrc);
        if (inst && typeof inst.show === 'function') {
          return inst.show(initialQuery, showOptions || {});
        }
        return showSearchPanel(initialQuery, showOptions || {});
      };
      window.__ijFindHide = function (targetSrc) {
        var inst = findRegisteredSearchInstance(targetSrc ? String(targetSrc) : '');
        if (inst && typeof inst.hide === 'function') { return inst.hide(); }
        return hideSearchPanel();
      };
      window.__ijFindOnMessage = function (msg) {
        var targetSrc = msg && msg.__targetSrc ? String(msg.__targetSrc) : '';
        var inst = findRegisteredSearchInstance(targetSrc);
        if (inst && typeof inst.onMessage === 'function') {
          return inst.onMessage(msg || {});
        }
        return 'missing-instance:' + (targetSrc || 'active');
      };
      window.__ijFindGetSearchState = function (targetSrc) {
        var inst = findRegisteredSearchInstance(targetSrc ? String(targetSrc) : '');
        if (inst && typeof inst.getSearchState === 'function') { return inst.getSearchState(); }
        return { err: 'missing-instance' };
      };
      window.__ijFindRefreshSearch = function (targetSrc) {
        var inst = findRegisteredSearchInstance(targetSrc ? String(targetSrc) : '');
        if (inst && typeof inst.refreshSearch === 'function') { return inst.refreshSearch(); }
        return undefined;
      };
      window.__ijFindSetScopeValue = function (value, forceRestart, targetSrc) {
        var inst = findRegisteredSearchInstance(targetSrc ? String(targetSrc) : '');
        if (inst && typeof inst.setScopeValue === 'function') { return inst.setScopeValue(value, forceRestart); }
        return { err: 'missing-instance' };
      };
      window.__ijFindGetPreviewDecorations = function (targetSrc) {
        var inst = findRegisteredSearchInstance(targetSrc ? String(targetSrc) : '');
        if (inst && typeof inst.getPreviewDecorations === 'function') { return inst.getPreviewDecorations(); }
        return { editor: null, decorations: [] };
      };
      window.__ijFindDisposeAllSearchUi = function (reason) {
        var out = [];
        var all = searchInstanceRegistry();
        var ids = [];
        for (var id in all) {
          if (Object.prototype.hasOwnProperty.call(all, id)) { ids.push(id); }
        }
        for (var i = 0; i < ids.length; i++) {
          try {
            var target = all[ids[i]];
            if (target && typeof target.dispose === 'function') {
              out.push(ids[i] + ':' + target.dispose(reason || 'dispose-all'));
            }
          } catch (eDisposeOne) {
            out.push(ids[i] + ':err');
          }
        }
        return out.join('|') || 'none';
      };
    } catch (eRegisterInstance) {}
  }

  registerSearchInstance();

  return 'ij-find patch installed';
})()
`;
}
