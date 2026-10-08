const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

exports.activate = () => {
  if (!process.env.IJSS_SCOPE_STAGE) return;
  void (async () => {
    let error;
    try {
      const scenario = require(path.join(process.env.IJSS_SCOPE_REPO, 'out/test/util/searchScopeRestartScenario.js'));
      await scenario.runScopeRestartScenario();
    } catch (failure) {
      error = String(failure.stack || failure);
      console.error('[scope restart failure]', error);
    }
    const output = process.env.IJSS_SCOPE_ARTIFACTS;
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, `${process.env.IJSS_SCOPE_STAGE}-result.json`), JSON.stringify({passed:!error,error},null,2));
    await vscode.commands.executeCommand('workbench.action.quit');
  })();
};
