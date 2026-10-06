const { Spec } = require('mocha').reporters;

// Preserve assertion details even if Electron exits before Mocha's summary.
module.exports = class ImmediateFailureReporter extends Spec {
  constructor(runner, options) {
    super(runner, options);
    runner.on('fail', (test, error) => {
      process.stderr.write(`\n[E2E failure] ${test.fullTitle()}\n${error.stack || String(error)}\n`);
    });
  }
};
