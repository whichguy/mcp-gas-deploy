function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * @module hello.test
   * Unit tests for the hello module — runs on GAS runtime via exec tool.
   *
   * Execute via: exec { function: "runTests" }
   * Expected: 3 passing, 0 failing
   */

  const { describe, it } = require('test-framework/mocha-adapter');
  const hello = require('hello');

  describe('hello module', () => {
    it('greet returns a string', () => {
      const result = hello.greet();
      if (typeof result !== 'string') throw new Error(`Expected string, got ${typeof result}`);
    });

    it('greet contains Hello', () => {
      const result = hello.greet();
      if (!result.includes('Hello')) throw new Error(`Expected "Hello" in "${result}"`);
    });

    it('greet contains GAS', () => {
      const result = hello.greet();
      if (!result.includes('GAS')) throw new Error(`Expected "GAS" in "${result}"`);
    });
  });
}

__defineModule__(_main, false);
