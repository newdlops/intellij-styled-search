/** CDP awaitPromise uses a weak handle; keep pending evaluations alive until completion. */
export function retainAwaitedCdpExpression(expression: string, timeoutMs: number): string {
  const retentionMs = timeoutMs > 0 ? Math.ceil(timeoutMs) + 1000 : 0;
  return `(function () {
    var value = (${expression});
    if (!(value instanceof Promise)) { return value; }
    var pending = globalThis.__ijssPendingCdpEvaluations;
    if (!(pending instanceof Set)) {
      pending = globalThis.__ijssPendingCdpEvaluations = new Set();
    }
    pending.add(value);
    var timer;
    function release() {
      if (timer) { clearTimeout(timer); }
      pending.delete(value);
    }
    if (${retentionMs} > 0) {
      timer = setTimeout(release, ${retentionMs});
      if (timer && typeof timer.unref === 'function') { timer.unref(); }
    }
    value.then(release, release);
    return value;
  })()`;
}
