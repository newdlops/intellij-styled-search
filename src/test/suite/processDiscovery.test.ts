import * as assert from 'assert';
import { inferBundledElectronMainPid } from '../../electronMainProcess';

suite('Electron main process discovery', () => {
  const appRoot = '/Applications/Neutral Workbench.app/Contents/Resources/app';
  const helperExec =
    '/Applications/Neutral Workbench.app/Contents/Frameworks/' +
    'Neutral Workbench Helper (Plugin).app/Contents/MacOS/Neutral Workbench Helper (Plugin)';

  test('infers a renamed packaged app main PID from Electron bundle structure', () => {
    assert.strictEqual(inferBundledElectronMainPid({
      platform: 'darwin',
      appRoot,
      execPath: helperExec,
      ppid: 4312,
    }), 4312);
  });

  test('does not infer a desktop main PID for remote-server or non-helper hosts', () => {
    assert.strictEqual(inferBundledElectronMainPid({
      platform: 'darwin',
      appRoot: '/srv/editor-server/current/out',
      execPath: '/srv/editor-server/current/node',
      ppid: 4312,
    }), null);

    assert.strictEqual(inferBundledElectronMainPid({
      platform: 'darwin',
      appRoot,
      execPath: '/Applications/Neutral Workbench.app/Contents/MacOS/Neutral Workbench',
      ppid: 4312,
    }), null);

    assert.strictEqual(inferBundledElectronMainPid({
      platform: 'darwin',
      appRoot,
      execPath:
        '/Applications/Other Workbench.app/Contents/Frameworks/' +
        'Other Workbench Helper (Plugin).app/Contents/MacOS/Other Workbench Helper (Plugin)',
      ppid: 4312,
    }), null);
  });
});
