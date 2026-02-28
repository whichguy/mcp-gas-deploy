function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * @module hello
   * Simple test module — validates basic exec round-trip.
   */

  exports.greet = function() {
    return 'Hello from GAS!';
  };
}

__defineModule__(_main, false);
