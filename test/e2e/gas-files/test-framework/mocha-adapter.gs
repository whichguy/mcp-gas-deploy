function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * @module test-framework/mocha-adapter
   * BDD test structure with skip/only support and LLM-friendly reports
   *
   * @example
   * const {describe, it} = require('test-framework/mocha-adapter');
   * describe('Module', () => {
   *   it('works', () => { expect(1).to.equal(1); });
   *   it.skip('todo', () => {});  // skip while debugging
   *   it.only('focus', () => {}); // run ONLY this test
   * });
   * describe.skip('WIP Suite', () => {}); // skip entire suite
   *
   * // Add custom context for LLM debugging:
   * it('complex test', function() {
   *   this.context({ scenario: 'edge case', data: someInput });
   *   expect(result).to.equal(expected);
   * });
   */

  const { formatDiff } = require('test-framework/diff-utils');
  const { formatHints, generateDomainHints } = require('test-framework/fix-hints');

  // Global context to track test suite hierarchy
  const context = {
    currentSuite: null,
    rootSuites: [],
    testResults: [],
    hasOnly: false,  // Flag: when true, only run .only() tests
    currentTest: null  // Current test being executed (for context capture)
  };

  /**
   * Test execution context for capturing custom info
   */
  class TestContext {
    constructor() {
      this._customContext = {};
      this._hints = [];
      this._logs = [];
    }
    
    /**
     * Add custom context for LLM debugging
     * @param {Object} ctx - Context object with scenario, data, etc.
     */
    context(ctx) {
      Object.assign(this._customContext, ctx);
    }
    
    /**
     * Add a custom debugging hint
     * @param {string} hint - Hint text
     */
    hint(hint) {
      this._hints.push(hint);
    }
    
    /**
     * Log message for LLM report
     * @param {...*} args - Log arguments
     */
    log(...args) {
      this._logs.push({ time: Date.now(), args });
    }
    
    /**
     * Get all captured context
     * @returns {Object} Captured context
     */
    getContext() {
      return {
        custom: this._customContext,
        hints: this._hints,
        logs: this._logs
      };
    }
  }

  /**
   * Define a test suite
   * @param {string} name - Suite name
   * @param {Function} fn - Suite definition function
   * @param {Object} options - Internal options (skip, only)
   */
  function describe(name, fn, options = {}) {
    const suite = {
      name: name,
      parent: context.currentSuite,
      tests: [],
      suites: [],
      skip: options.skip || false,
      only: options.only || false,
      hooks: {
        before: [],
        after: [],
        beforeEach: [],
        afterEach: []
      }
    };
    
    // Track if any .only() is used
    if (options.only) {
      context.hasOnly = true;
    }
    
    // Add to parent or root
    if (context.currentSuite) {
      context.currentSuite.suites.push(suite);
    } else {
      context.rootSuites.push(suite);
    }
    
    // Execute suite definition in context of this suite
    const previousSuite = context.currentSuite;
    context.currentSuite = suite;
    
    try {
      fn();
    } finally {
      // Restore parent suite context
      context.currentSuite = previousSuite;
    }
  }

  /**
   * Define a test case
   * @param {string} name - Test name
   * @param {Function} fn - Test function
   */
  function it(name, fn) {
    if (!context.currentSuite) {
      throw new Error('it() must be called inside a describe() block');
    }
    
    context.currentSuite.tests.push({
      name: name,
      fn: fn,
      skip: false,
      only: false
    });
  }

  /**
   * Skip this test (useful while debugging other tests)
   * @param {string} name - Test name
   * @param {Function} fn - Test function
   */
  it.skip = function(name, fn) {
    if (!context.currentSuite) {
      throw new Error('it.skip() must be called inside a describe() block');
    }
    context.currentSuite.tests.push({
      name: name,
      fn: fn,
      skip: true,
      only: false
    });
  };

  /**
   * Run ONLY this test (useful for focusing on one failing test)
   * @param {string} name - Test name
   * @param {Function} fn - Test function
   */
  it.only = function(name, fn) {
    if (!context.currentSuite) {
      throw new Error('it.only() must be called inside a describe() block');
    }
    context.currentSuite.tests.push({
      name: name,
      fn: fn,
      skip: false,
      only: true
    });
    context.hasOnly = true;
  };

  /**
   * Skip this suite (useful while debugging other suites)
   * @param {string} name - Suite name
   * @param {Function} fn - Suite definition function
   */
  describe.skip = function(name, fn) {
    describe(name, fn, { skip: true });
  };

  /**
   * Run ONLY this suite (useful for focusing on one suite)
   * @param {string} name - Suite name
   * @param {Function} fn - Suite definition function
   */
  describe.only = function(name, fn) {
    describe(name, fn, { only: true });
  };

  /**
   * Define a before hook (runs once before all tests in suite)
   * @param {Function} fn - Hook function
   */
  function before(fn) {
    if (!context.currentSuite) {
      throw new Error('before() must be called inside a describe() block');
    }
    
    context.currentSuite.hooks.before.push(fn);
  }

  /**
   * Define an after hook (runs once after all tests in suite)
   * @param {Function} fn - Hook function
   */
  function after(fn) {
    if (!context.currentSuite) {
      throw new Error('after() must be called inside a describe() block');
    }
    
    context.currentSuite.hooks.after.push(fn);
  }

  /**
   * Define a beforeEach hook
   * @param {Function} fn - Hook function
   */
  function beforeEach(fn) {
    if (!context.currentSuite) {
      throw new Error('beforeEach() must be called inside a describe() block');
    }
    
    context.currentSuite.hooks.beforeEach.push(fn);
  }

  /**
   * Define an afterEach hook
   * @param {Function} fn - Hook function
   */
  function afterEach(fn) {
    if (!context.currentSuite) {
      throw new Error('afterEach() must be called inside a describe() block');
    }
    
    context.currentSuite.hooks.afterEach.push(fn);
  }

  /**
   * Get the current test context
   * @returns {Object} Test context with root suites and results
   */
  function getContext() {
    return {
      rootSuites: context.rootSuites,
      testResults: context.testResults,
      currentSuite: context.currentSuite
    };
  }

  /**
   * Reset the test context (useful between test runs)
   */
  function resetContext() {
    context.currentSuite = null;
    context.rootSuites = [];
    context.testResults = [];
    context.hasOnly = false;
  }

  /**
   * Execute a test suite and all nested suites
   * @param {Object} suite - Suite to execute
   * @param {Object} ancestorHooks - Hooks from ancestor suites
   * @param {string} parentPath - Parent suite path for LLM reports
   * @returns {Object} Suite results
   */
  function executeSuite(suite, ancestorHooks = { beforeEach: [], afterEach: [] }, parentPath = '') {
    const suiteResult = {
      name: suite.name,
      tests: [],
      suites: [],
      passed: 0,
      failed: 0,
      skipped: 0
    };
    
    // Run before hooks (once per suite, before any tests)
    try {
      for (const hook of suite.hooks.before) {
        hook();
      }
    } catch (error) {
      // If before hook fails, skip all tests in this suite
      Logger.log(`before hook failed in "${suite.name}": ${error.message}`);
      suiteResult.error = { message: `before hook failed: ${error.message}`, stack: error.stack };
      return suiteResult;
    }
    
    // Collect all beforeEach/afterEach hooks from ancestors and current suite
    const allBeforeEach = [...ancestorHooks.beforeEach, ...suite.hooks.beforeEach];
    const allAfterEach = [...ancestorHooks.afterEach, ...suite.hooks.afterEach];
    
    // Build suite path for LLM reports
    const suitePath = parentPath ? `${parentPath} > ${suite.name}` : suite.name;
    
    // Execute tests
    for (const test of suite.tests) {
      const testResult = executeTest(test, allBeforeEach, allAfterEach, { suiteIsOnly: suite.only, suitePath });
      suiteResult.tests.push(testResult);
      
      if (testResult.passed) {
        suiteResult.passed++;
      } else if (testResult.skipped) {
        suiteResult.skipped++;
      } else {
        suiteResult.failed++;
      }
    }
    
    // Execute nested suites
    for (const nestedSuite of suite.suites) {
      const nestedResult = executeSuite(nestedSuite, {
        beforeEach: allBeforeEach,
        afterEach: allAfterEach
      }, suitePath);
      suiteResult.suites.push(nestedResult);
      suiteResult.passed += nestedResult.passed;
      suiteResult.failed += nestedResult.failed;
      suiteResult.skipped += nestedResult.skipped;
    }
    
    // Run after hooks (once per suite, after all tests)
    try {
      for (const hook of suite.hooks.after) {
        hook();
      }
    } catch (error) {
      Logger.log(`after hook failed in "${suite.name}": ${error.message}`);
      // Don't override results, just log the error
    }
    
    return suiteResult;
  }

  /**
   * Execute a single test with hooks and context capture
   * @param {Object} test - Test to execute
   * @param {Array} beforeEachHooks - BeforeEach hooks to run
   * @param {Array} afterEachHooks - AfterEach hooks to run
   * @param {Object} options - Execution options (hasOnlyInSuite, suitePath)
   * @returns {Object} Test result with llmReport on failure
   */
  function executeTest(test, beforeEachHooks, afterEachHooks, options = {}) {
    const testResult = {
      name: test.name,
      passed: false,
      skipped: false,
      error: null,
      duration: 0
    };
    
    // Handle skipped tests
    if (test.skip) {
      testResult.skipped = true;
      return testResult;
    }
    
    // If hasOnly is set globally, skip tests without .only flag
    // unless the suite itself is marked .only
    if (context.hasOnly && !test.only && !options.suiteIsOnly) {
      testResult.skipped = true;
      return testResult;
    }
    
    // Create test context for capturing custom info
    const testContext = new TestContext();
    context.currentTest = testContext;
    
    const startTime = Date.now();
    let testPassed = false;
    let testError = null;
    let afterEachError = null;  // Track afterEach errors separately
    
    try {
      // Run beforeEach hooks
      for (const hook of beforeEachHooks) {
        hook();
      }
      
      // Run test with context bound to 'this'
      test.fn.call(testContext);
      testPassed = true;
      
    } catch (error) {
      testPassed = false;
      testError = error;
    } finally {
      // Run afterEach hooks in finally block (always runs)
      // Context remains available to afterEach hooks
      try {
        for (const hook of afterEachHooks) {
          hook();
        }
      } catch (hookError) {
        afterEachError = hookError;
      }
      
      // Clear current test AFTER afterEach hooks complete
      context.currentTest = null;
    }
    
    // Handle error consolidation
    if (afterEachError) {
      if (testPassed) {
        // Test passed but afterEach failed - this is a failure
        testPassed = false;
        testError = new Error(`afterEach hook failed: ${afterEachError.message}`);
        testError.stack = afterEachError.stack;
      } else {
        // Both test AND afterEach failed - attach afterEach error to test error
        testError.afterEachError = {
          message: afterEachError.message,
          stack: afterEachError.stack
        };
        Logger.log(`Warning: afterEach also failed: ${afterEachError.message}`);
      }
    }
    
    testResult.passed = testPassed;
    testResult.duration = Date.now() - startTime;
    
    if (testError) {
      testResult.error = {
        message: testError.message,
        stack: testError.stack
      };
      // Capture expected/actual if available (from chai assertions)
      if (testError.expected !== undefined) {
        testResult.error.expected = testError.expected;
      }
      if (testError.actual !== undefined) {
        testResult.error.actual = testError.actual;
      }
      
      // Build complete LLM report
      const capturedContext = testContext.getContext();
      testResult.llmReport = buildLlmReport(test, testError, capturedContext, options, testResult.duration);
    }
    
    return testResult;
  }

  /**
   * Build complete LLM-friendly failure report
   * @param {Object} test - Test object
   * @param {Error} error - Test error
   * @param {Object} capturedContext - Captured test context
   * @param {Object} options - Execution options
   * @param {number} duration - Test duration in ms
   * @returns {Object} Complete LLM report
   */
  function buildLlmReport(test, error, capturedContext, options, duration) {
    const llmReport = {
      // 1. WHAT FAILED
      whatFailed: {
        test: test.name,
        suite: options.suitePath || '',
        duration: duration
      },
      
      // 2. WHAT WAS CALLED (from error's llmReport if available)
      whatCalled: capturedContext.custom || {},
      
      // 3. EXPECTED vs ACTUAL (from error's llmReport if available)
      assertion: error.llmReport?.assertion || null,
      values: error.llmReport?.values || {
        expected: error.expected,
        actual: error.actual
      },
      diff: error.llmReport?.diff || null,
      
      // 4. FIX HINTS (combine auto-generated and custom)
      fixHints: [
        ...(error.llmReport?.fixHints || []),
        ...capturedContext.hints
      ],
      
      // Additional context
      logs: capturedContext.logs
    };
    
    return llmReport;
  }

  /**
   * Format LLM report as readable text block
   * @param {Object} llmReport - LLM report object
   * @returns {string} Formatted text
   */
  function formatLlmReport(llmReport) {
    if (!llmReport) return '';
    
    const lines = [];
    const sep = '═'.repeat(78);
    
    lines.push(sep);
    lines.push('TEST FAILURE REPORT');
    lines.push(sep);
    
    // 1. WHAT FAILED
    lines.push('');
    lines.push('1. WHAT FAILED');
    lines.push(`   Test: ${llmReport.whatFailed?.test || 'unknown'}`);
    if (llmReport.whatFailed?.suite) {
      lines.push(`   Suite: ${llmReport.whatFailed.suite}`);
    }
    if (llmReport.assertion) {
      lines.push(`   Assertion: ${llmReport.assertion.type || 'unknown'}${llmReport.assertion.negated ? ' (negated)' : ''}`);
    }
    lines.push(`   Duration: ${llmReport.whatFailed?.duration || 0}ms`);
    
    // 2. WHAT WAS CALLED
    if (llmReport.whatCalled && Object.keys(llmReport.whatCalled).length > 0) {
      lines.push('');
      lines.push('2. WHAT WAS CALLED');
      for (const [key, value] of Object.entries(llmReport.whatCalled)) {
        lines.push(`   ${key}: ${JSON.stringify(value)}`);
      }
    }
    
    // 3. EXPECTED vs ACTUAL
    lines.push('');
    lines.push('3. EXPECTED vs ACTUAL');
    if (llmReport.values) {
      lines.push(`   Expected (${llmReport.values.expectedType || typeof llmReport.values.expected}):`);
      lines.push(`     ${llmReport.values.expectedJSON || JSON.stringify(llmReport.values.expected)}`);
      lines.push(`   Actual (${llmReport.values.actualType || typeof llmReport.values.actual}):`);
      lines.push(`     ${llmReport.values.actualJSON || JSON.stringify(llmReport.values.actual)}`);
    }
    
    // Diff summary
    if (llmReport.diff) {
      lines.push('');
      lines.push('   DIFF:');
      lines.push(`     ${llmReport.diff.summary || 'Values differ'}`);
      if (llmReport.diff.missing?.length) {
        lines.push(`     Missing: ${llmReport.diff.missing.length} items`);
      }
      if (llmReport.diff.extra?.length) {
        lines.push(`     Extra: ${llmReport.diff.extra.length} items`);
      }
    }
    
    // 4. FIX HINTS
    if (llmReport.fixHints?.length) {
      lines.push('');
      lines.push('4. FIX HINTS');
      for (const hint of llmReport.fixHints) {
        lines.push(`   → ${hint}`);
      }
    }
    
    lines.push(sep);
    
    return lines.join('\n');
  }

  /**
   * Check if a test/suite name matches a grep pattern
   * @param {string} name - Name to check
   * @param {string|RegExp} grep - Pattern to match
   * @returns {boolean} True if matches
   */
  function matchesGrep(name, grep) {
    if (!grep) return true;
    if (!name) return false;  // Null safety: undefined/null names don't match
    if (grep instanceof RegExp) {
      return grep.test(name);
    }
    return String(name).toLowerCase().includes(String(grep).toLowerCase());
  }

  /**
   * Filter suites/tests by grep pattern (mutates the suite structure)
   * @param {Array} suites - Suites to filter
   * @param {string|RegExp} grep - Pattern to match
   */
  function filterByGrep(suites, grep) {
    for (const suite of suites) {
      // Filter tests by grep
      suite.tests = suite.tests.filter(test => matchesGrep(test.name, grep) || matchesGrep(suite.name, grep));
      
      // Recursively filter nested suites
      if (suite.suites.length > 0) {
        filterByGrep(suite.suites, grep);
      }
    }
  }

  /**
   * Execute all root suites
   * @param {Object} options - Execution options
   * @param {string|RegExp} options.grep - Only run tests matching this pattern
   * @returns {Array} Results for all root suites
   */
  function executeAll(options = {}) {
    const { grep } = options;
    
    // Apply grep filter if provided
    if (grep) {
      filterByGrep(context.rootSuites, grep);
    }
    
    const results = [];
    
    for (const suite of context.rootSuites) {
      // Skip entire suite if marked .skip or (hasOnly and not .only)
      if (suite.skip || (context.hasOnly && !suite.only && !suiteHasOnly(suite))) {
        results.push({
          name: suite.name,
          tests: suite.tests.map(t => ({ name: t.name, passed: false, skipped: true, error: null, duration: 0 })),
          suites: [],
          passed: 0,
          failed: 0,
          skipped: suite.tests.length
        });
        continue;
      }
      results.push(executeSuite(suite));
    }
    
    context.testResults = results;
    return results;
  }

  /**
   * Check if a suite contains any .only tests or nested .only suites
   * @param {Object} suite - Suite to check
   * @returns {boolean} True if suite contains .only
   */
  function suiteHasOnly(suite) {
    if (suite.only) return true;
    if (suite.tests.some(t => t.only)) return true;
    return suite.suites.some(s => suiteHasOnly(s));
  }

  /**
   * Format test results as a readable string
   * @param {Array} results - Test results
   * @param {number} indent - Indentation level
   * @returns {string} Formatted results
   */
  function formatResults(results, indent = 0) {
    const indentStr = '  '.repeat(indent);
    let output = '';
    
    for (const suiteResult of results) {
      output += `${indentStr}${suiteResult.name}\n`;
      
      // Format tests
      for (const test of suiteResult.tests) {
        let status;
        if (test.skipped) {
          status = '-';  // Skipped indicator
        } else if (test.passed) {
          status = '✓';
        } else {
          status = '✗';
        }
        const duration = test.skipped ? '(skipped)' : `(${test.duration}ms)`;
        output += `${indentStr}  ${status} ${test.name} ${duration}\n`;
        
        if (!test.passed && !test.skipped && test.error) {
          output += `${indentStr}    Error: ${test.error.message}\n`;
          if (test.error.stack) {
            const stackLines = test.error.stack.split('\n').slice(0, 3);
            output += stackLines.map(line => `${indentStr}      ${line}`).join('\n') + '\n';
          }
        }
      }
      
      // Format nested suites
      if (suiteResult.suites.length > 0) {
        output += formatResults(suiteResult.suites, indent + 1);
      }
    }
    
    return output;
  }

  /**
   * Get summary statistics from results
   * @param {Array} results - Test results
   * @returns {Object} Summary statistics
   */
  function getSummary(results) {
    let total = 0;
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    
    for (const result of results) {
      total += result.passed + result.failed + result.skipped;
      passed += result.passed;
      failed += result.failed;
      skipped += result.skipped;
    }
    
    return {
      total: total,
      passed: passed,
      failed: failed,
      skipped: skipped,
      passRate: total > 0 ? (passed / total * 100).toFixed(1) + '%' : 'N/A'
    };
  }

  // Export public API
  module.exports = {
    describe,
    it,
    before,
    after,
    beforeEach,
    afterEach,
    getContext,
    resetContext,
    executeAll,
    formatResults,
    getSummary,
    formatLlmReport,
    buildLlmReport,
    // Internal (for test-runner)
    matchesGrep,
    filterByGrep
  };
}

__defineModule__(_main);