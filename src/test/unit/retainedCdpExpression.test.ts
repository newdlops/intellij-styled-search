import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import WebSocket from 'ws';
import { retainAwaitedCdpExpression } from '../../internal/retainedCdpExpression';

test('awaited CDP promises survive GC and release their roots after settlement', { timeout: 15000 }, async () => {
  // Use an external inspector connection: sending a local Session callback
  // while V8 is collecting a promise can itself crash Node during GC.
  const child = spawn(process.execPath, ['--expose-gc', '--inspect=127.0.0.1:0', '-e', 'setInterval(function(){},30000)']);
  let socket: WebSocket | undefined;
  const pending = new Map<number, (response: any) => void>();
  let nextId = 0;
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let stderr = '';
      child.stderr.on('data', chunk => {
        stderr += chunk.toString();
        const match = stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/);
        if (match) { resolve(match[0]); }
      });
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Inspector child exited: ${code}; ${stderr}`)));
    });
    socket = new WebSocket(url);
    socket.on('message', raw => {
      const response = JSON.parse(raw.toString());
      if (response.id) { pending.get(response.id)?.(response); pending.delete(response.id); }
    });
    await once(socket, 'open');
    const evaluate = (expression: string, awaitPromise = false): Promise<any> => {
      const id = ++nextId;
      return new Promise(resolve => {
        pending.set(id, resolve);
        socket!.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise, returnByValue: true } }));
      });
    };
    const fixture = (key: string) => `(function(){
      var finish; var promise = new Promise(function(resolve){finish=resolve;});
      promise.finish=finish; globalThis[${JSON.stringify(key)}]=new WeakRef(promise); return promise;
    })()`;
    const collect = async () => {
      for (let i = 0; i < 4; i++) { await evaluate('global.gc()'); }
    };
    const unrooted = evaluate(fixture('__unrootedProbe'), true);
    await collect();
    assert.match((await unrooted).error.message, /Promise was collected/);

    const first = evaluate(retainAwaitedCdpExpression(fixture('__retainedProbeA'), 10000), true);
    const second = evaluate(retainAwaitedCdpExpression(fixture('__retainedProbeB'), 10000), true);
    await collect();
    assert.equal((await evaluate('globalThis.__ijssPendingCdpEvaluations.size')).result.result.value, 2);
    await evaluate('globalThis.__retainedProbeA.deref().finish("first")');
    assert.equal((await first).result.result.value, 'first');
    assert.equal((await evaluate('globalThis.__ijssPendingCdpEvaluations.size')).result.result.value, 1);
    await collect();
    await evaluate('globalThis.__retainedProbeB.deref().finish("second")');
    assert.equal((await second).result.result.value, 'second');
    assert.equal((await evaluate('globalThis.__ijssPendingCdpEvaluations.size')).result.result.value, 0);

    const rejected = await evaluate(retainAwaitedCdpExpression('Promise.reject(new Error("probe rejection"))', 10000), true);
    assert.match(rejected.result.exceptionDetails.exception.description, /probe rejection/);
    assert.equal((await evaluate('globalThis.__ijssPendingCdpEvaluations.size')).result.result.value, 0);
    assert.equal((await evaluate(retainAwaitedCdpExpression('42', 10000), true)).result.result.value, 42);

    const expiring = evaluate(retainAwaitedCdpExpression(fixture('__expiringProbe'), 1), true);
    const deadline = Date.now() + 5000;
    let roots = 1;
    while (roots && Date.now() < deadline) {
      roots = (await evaluate('globalThis.__ijssPendingCdpEvaluations.size')).result.result.value;
      if (roots) { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    assert.equal(roots, 0, 'an abandoned evaluation must release its root after the caller deadline');
    await collect();
    assert.match((await expiring).error.message, /Promise was collected/);
  } finally {
    socket?.terminate();
    child.kill();
    if (child.exitCode === null && child.signalCode === null) { await once(child, 'exit'); }
  }
});
