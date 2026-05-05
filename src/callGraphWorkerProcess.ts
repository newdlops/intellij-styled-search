import {
  rebuildCallGraphWorker,
  type CallGraphRebuildProgress,
  type CallGraphWorkerRebuildInput,
  type CallGraphWorkerRebuildResult,
} from './callGraph';
import * as v8 from 'v8';

type WorkerRequest = {
  type?: string;
  input?: CallGraphWorkerRebuildInput;
};

type WorkerResponse =
  | {
      type: 'ready';
      pid: number;
      ppid: number;
      title: string;
      argv0: string;
      execPath: string;
      execArgv: string[];
      heapLimitMb: number;
      heapUsedMb: number;
    }
  | { type: 'progress'; progress: CallGraphRebuildProgress }
  | { type: 'done'; result: CallGraphWorkerRebuildResult }
  | { type: 'error'; error: string };

let active = false;

try {
  process.title = 'ijss-callgraph-worker';
} catch {
  // Best-effort diagnostic title only. Some Electron builds ignore title changes.
}

function send(message: WorkerResponse): void {
  if (typeof process.send === 'function') {
    process.send(message);
  } else {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

process.on('message', (message: WorkerRequest) => {
  if (message?.type !== 'rebuild' || !message.input) {
    send({ type: 'error', error: 'invalid call graph worker request' });
    return;
  }
  if (active) {
    send({ type: 'error', error: 'call graph worker is already running' });
    return;
  }
  active = true;
  const memory = process.memoryUsage();
  const heapStats = v8.getHeapStatistics();
  send({
    type: 'ready',
    pid: process.pid,
    ppid: process.ppid,
    title: process.title,
    argv0: process.argv0,
    execPath: process.execPath,
    execArgv: process.execArgv,
    heapLimitMb: Math.round(heapStats.heap_size_limit / (1024 * 1024)),
    heapUsedMb: Math.round(memory.heapUsed / (1024 * 1024)),
  });
  void rebuildCallGraphWorker(message.input, (progress) => {
    send({ type: 'progress', progress });
  }).then((result) => {
    send({ type: 'done', result });
    setTimeout(() => process.exit(0), 10);
  }, (err) => {
    send({ type: 'error', error: err instanceof Error ? err.message : String(err) });
    setTimeout(() => process.exit(1), 10);
  });
});

process.on('uncaughtException', (err) => {
  send({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  setTimeout(() => process.exit(1), 10);
});

process.on('unhandledRejection', (reason) => {
  send({ type: 'error', error: reason instanceof Error ? reason.message : String(reason) });
  setTimeout(() => process.exit(1), 10);
});
