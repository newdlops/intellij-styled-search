// Prepare a disposable workspace/profile for real Marketplace screenshots.
// Run after npm run compile, then launch the printed command in a terminal.
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const captureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ijss-marketplace-'));
const workspace = path.join(captureRoot, 'taskboard');
const userData = path.join(captureRoot, 'profile');
const extensions = path.join(captureRoot, 'extensions');
const sources = {
  'src/scheduler.ts': `export interface Task {
  id: string;
  title: string;
  delayMs?: number;
}

export interface ScheduledTask extends Task {
  runAt: Date;
  status: 'queued' | 'running' | 'done';
}

const queue = new Map<string, ScheduledTask>();

/** Add a task to the queue, ready for the next worker. */
export function scheduleTask(task: Task): ScheduledTask {
  const scheduled: ScheduledTask = {
    ...task,
    runAt: new Date(Date.now() + (task.delayMs ?? 1000)),
    status: 'queued',
  };

  queue.set(task.id, scheduled);
  return scheduled;
}

/** Queue a batch using the same scheduling rules. */
export function scheduleBatch(tasks: Task[]): ScheduledTask[] {
  return tasks.map((task) => scheduleTask(task));
}

export function pendingTasks(): ScheduledTask[] {
  return [...queue.values()].filter((task) => task.status === 'queued');
}
`,
  'src/workflows/daily.ts': `import { scheduleTask, scheduleBatch } from '../scheduler';

export function prepareDailyTasks() {
  const report = scheduleTask({ id: 'report', title: 'Build daily report' });
  const cleanup = scheduleTask({ id: 'cleanup', title: 'Archive completed tasks' });

  const reminders = scheduleBatch([
    { id: 'review', title: 'Review pending changes' },
    { id: 'backup', title: 'Back up workspace', delayMs: 5000 },
  ]);

  return { report, cleanup, reminders };
}
`,
  'src/workflows/retry.ts': `import { scheduleTask, type Task } from '../scheduler';

export function retryTask(task: Task, attempt: number) {
  const delayMs = Math.min(1000 * 2 ** attempt, 60_000);
  return scheduleTask({ ...task, delayMs });
}
`,
  'src/scheduler.test.ts': `import { scheduleTask, pendingTasks } from './scheduler';

export function checkScheduler() {
  const task = scheduleTask({ id: 'example', title: 'Check scheduling' });
  if (task.status !== 'queued') throw new Error('Expected a queued task');
  if (!pendingTasks().includes(task)) throw new Error('Task missing from queue');
}
`,
  'scripts/seed.ts': `import { scheduleTask } from '../src/scheduler';

scheduleTask({ id: 'welcome', title: 'Prepare a new workspace' });
scheduleTask({ id: 'index', title: 'Index project files' });
`,
  'docs/operations.md': `# Task scheduling

Use scheduleTask for one task and scheduleBatch for a group.
Workers consume the queue and retry failed tasks with a delay.
`,
  'tsconfig.json': JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler',
    strict: true, noEmit: true,
  }, include: ['src/**/*.ts', 'scripts/**/*.ts'] }, null, 2) + '\n',
  '.vscode/settings.json': JSON.stringify({
    'intellijStyledSearch.mcpAutoStart': false,
    'intellijStyledSearch.searchOnOpen': false,
  }, null, 2) + '\n',
};

for (const [file, text] of Object.entries(sources)) {
  const destination = path.join(workspace, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, text);
}
fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
fs.mkdirSync(extensions, { recursive: true });
fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
  'workbench.colorTheme': 'Default Dark Modern',
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'editor.fontSize': 15,
  'editor.minimap.enabled': false,
  'editor.stickyScroll.enabled': false,
  'window.restoreWindows': 'none',
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.autoCheckUpdates': false,
}, null, 2) + '\n');

const args = [
  '--new-window', '--skip-welcome', '--skip-release-notes',
  `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`,
  `--extensionDevelopmentPath=${root}`, workspace,
];
const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
console.log(JSON.stringify({ captureRoot, workspace, userData, extensions }, null, 2));
console.log('\ncode ' + args.map(quote).join(' '));
