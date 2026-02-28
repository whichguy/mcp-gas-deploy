function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * @module runner-api
   * Public API exported to dispatcher.gs — all functions callable via exec tool.
   *
   * To add a new callable function:
   *   1. Implement it in a module
   *   2. require() it here and re-export
   */

  const hello = require('hello');
  const runner = require('test-framework/test-runner');

  /** Simple sanity check — exec tool calls this first */
  exports.greet = hello.greet;

  /** Run all registered GAS tests — returns LLM-friendly test report */
  exports.runTests = function() {
    return runner.runTestFile('hello.test');
  };

  /** Run all tests across all registered repos (heavier) */
  exports.runAllTests = runner.runAllTests;
}

__defineModule__(_main, false);
