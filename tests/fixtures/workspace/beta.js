class BetaWidget {
  constructor() {
    this.count = 0;
    this.label = 'beta';
  }

  increment() {
    this.count += 1;
    return this.count;
  }

  reset() {
    this.count = 0;
  }
}

function helperBeta() {
  return new BetaWidget();
}

const BETA_DEFAULT = { debug: false, retries: 3 };

module.exports = { BetaWidget, helperBeta, BETA_DEFAULT };
