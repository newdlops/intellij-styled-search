export const MONACO_GLOBALS_PEEK_EXPR = `(function(){
  try {
    var m = window.__ijFindMonaco;
    var f = window.__ijFindMonacoFactory;
    var status = window.__ijFindMonacoStatus ? window.__ijFindMonacoStatus() : 'not-ready:no-status';
    if (!m) return 'status=' + status + ' none';
    return 'status=' + status +
      ' ctor=' + (!!(m.ctor)) +
      ' inst=' + (!!(m.inst)) +
      ' modelSvc=' + (!!(m.modelSvc)) +
      ' factory=' + (!!(f && f.ctor)) +
      ' instCandidates=' + ((m.instCandidates || []).length) +
      ' modelSvcCandidates=' + ((m.modelSvcCandidates || []).length);
  } catch(e){ return 'peek-err:' + (e && e.message); }
})()`;

export const CAPTURE_BUFFER_PEEK_EXPR = `(function(){
  try {
    var c = window.__ijFindCaptures || {};
    return 'widgets=' + ((c.widgets||[]).length) +
      ' services=' + ((c.services||[]).length) +
      ' ctors=' + ((c.widgetCtors||[]).length) +
      ' installed=' + !!window.__ijFindCaptureInstalled;
  } catch(e){ return 'peek-err:' + (e && e.message); }
})()`;

export const STOP_CAPTURE_EXPR = `(function(){ try { return window.__ijFindStopCapture && window.__ijFindStopCapture(); } catch(e){ return 'stop-err:' + (e && e.message); } })()`;
export const TEST_WIDGET_CREATE_EXPR = `(function(){ try { return window.__ijFindTestCreateWidget ? window.__ijFindTestCreateWidget() : 'no-test-fn'; } catch(e){ return 'test-throw:' + (e && e.message); } })()`;
export const DOM_CAPTURE_EXPR = `(function(){try{return window.__ijFindCaptureFromDom?window.__ijFindCaptureFromDom():'no-fn'}catch(e){return 'throw:'+(e&&e.message)}})()`;

export const CLEAR_CAPTURE_BUFFER_EXPR = `(function(){
  try {
    if (window.__ijFindCaptures) {
      window.__ijFindCaptures.widgets = [];
      window.__ijFindCaptures.services = [];
      window.__ijFindCaptures.widgetCtors = [];
      window.__ijFindCaptures.serviceMaps = [];
    }
    return 'cleared';
  } catch (e) { return 'clear-err:' + (e && e.message); }
})()`;
