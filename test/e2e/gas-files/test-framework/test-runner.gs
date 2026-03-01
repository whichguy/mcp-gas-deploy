function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * @module test-framework/test-runner
   * Test execution with failures-first LLM-friendly output
   *
   * @example
   * const runner = require('test-framework/test-runner');
   * runner.runAllTests();           // all discovered tests
   * runner.runFiltered(/memory/i);  // grep by test name
   * runner.runTestFile('path/test'); // single file
   *
   * OUTPUT FORMAT:
   * ❌ FAILURES (n): at TOP with Expected/Actual
   * 📊 passed/total (rate%) [skipped]
   * ✓ pass (Xms) | - skip (skipped) | ✗ fail (Xms)
   */

  const mocha = require('test-framework/mocha-adapter');
  const registry = require('test-framework/test-registry');

  /**
   * Safely require a test module, logging errors but not crashing
   * @param {string} modulePath - Path to module
   * @returns {boolean} True if loaded successfully
   */
  function safeRequire(modulePath) {
    try {
      require(modulePath);
      return true;
    } catch (error) {
      Logger.log(`⚠️ Failed to load test module '${modulePath}': ${error.message}`);
      return false;
    }
  }

  /**
   * Collect all failures from test results (recursive)
   * @param {Array} results - Test results
   * @param {string} parentPath - Parent suite path
   * @returns {Array} Array of failure objects with llmReport
   */
  function collectFailures(results, parentPath = '') {
    const failures = [];
    
    for (const suiteResult of results) {
      const suitePath = parentPath ? `${parentPath} > ${suiteResult.name}` : suiteResult.name;
      
      // Collect test failures
      for (const test of suiteResult.tests) {
        if (!test.passed && !test.skipped && test.error) {
          failures.push({
            suite: suitePath,
            name: test.name,
            error: test.error,
            llmReport: test.llmReport  // Include LLM report if available
          });
        }
      }
      
      // Recurse into nested suites
      if (suiteResult.suites && suiteResult.suites.length > 0) {
        failures.push(...collectFailures(suiteResult.suites, suitePath));
      }
    }
    
    return failures;
  }

  /**
   * Format failures-first summary for LLM-friendly output
   * @param {Array} results - Test results
   * @param {Object} summary - Test summary
   * @returns {string} Formatted output
   */
  function formatFailuresFirst(results, summary) {
    let output = '';
    
    const failures = collectFailures(results);
    
    if (failures.length > 0) {
      output += '\n❌ FAILURES (' + failures.length + '):\n';
      output += '─'.repeat(50) + '\n';
      
      for (const f of failures) {
        // Use LLM report if available for enhanced output
        if (f.llmReport) {
          output += mocha.formatLlmReport(f.llmReport);
        } else {
          // Fallback to basic output
          output += `\n  ${f.suite} > ${f.name}\n`;
          output += `    ${f.error.message}\n`;
          
          // Show expected/actual if available
          if (f.error.expected !== undefined) {
            output += `    Expected: ${JSON.stringify(f.error.expected)}\n`;
            output += `    Actual:   ${JSON.stringify(f.error.actual)}\n`;
          }
        }
      }
      output += '\n';
    }
    
    // Quick summary line
    const statusIcon = summary.failed > 0 ? '❌' : '✅';
    output += `${statusIcon} ${summary.passed}/${summary.total} passed (${summary.passRate})`;
    if (summary.skipped > 0) {
      output += ` [${summary.skipped} skipped]`;
    }
    output += '\n';
    
    return output;
  }

  /**
   * Run all tests
   * @returns {Object} Aggregated test results
   */
  function runAllTests() {
    console.log('🧪 Running all tests...\n');
    
    // Reset mocha context
    mocha.resetContext();
    
    // Discover and load all test modules
    const testModules = registry.discoverAll();
    
    // Load all tests (with error handling to prevent single failure from crashing suite)
    let loadErrors = 0;
    for (const [repo, types] of Object.entries(testModules)) {
      for (const [type, modules] of Object.entries(types)) {
        for (const testModule of modules) {
          // Load test module - it registers itself with mocha via describe() and it() calls
          if (!safeRequire(testModule)) loadErrors++;
        }
      }
    }
    if (loadErrors > 0) {
      Logger.log(`⚠️ ${loadErrors} test module(s) failed to load`);
    }
    
    // Execute all tests
    const startTime = Date.now();
    const results = mocha.executeAll();
    const duration = Date.now() - startTime;
    
    // Get summary first for failures-first output
    const summary = mocha.getSummary(results);
    
    // Show failures at TOP (LLM-friendly)
    const failuresFirst = formatFailuresFirst(results, summary);
    console.log(failuresFirst);
    
    // Then detailed results
    const formatted = mocha.formatResults(results);
    console.log(formatted);
    
    // Display summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 Test Summary');
    console.log('='.repeat(60));
    console.log(`Total:   ${summary.total}`);
    console.log(`Passed:  ${summary.passed} ✓`);
    console.log(`Failed:  ${summary.failed} ✗`);
    console.log(`Skipped: ${summary.skipped}`);
    console.log(`Pass Rate: ${summary.passRate}`);
    console.log(`Duration: ${duration}ms`);
    console.log('='.repeat(60) + '\n');
    
    return {
      results,
      summary,
      duration
    };
  }

  /**
   * Run only unit tests
   * @returns {Object} Aggregated test results
   */
  function runUnitTests() {
    console.log('🧪 Running unit tests...\n');
    
    // Reset mocha context
    mocha.resetContext();
    
    // Discover and load only unit test modules
    const testModules = registry.discoverUnitTests();
    
    // Load all unit tests (with error handling)
    let loadErrors = 0;
    for (const [repo, modules] of Object.entries(testModules)) {
      for (const testModule of modules) {
        // Load test module - it registers itself with mocha when loaded
        if (!safeRequire(testModule)) loadErrors++;
      }
    }
    if (loadErrors > 0) {
      Logger.log(`⚠️ ${loadErrors} test module(s) failed to load`);
    }
    
    // Execute all tests
    const startTime = Date.now();
    const results = mocha.executeAll();
    const duration = Date.now() - startTime;
    
    // Format and display results
    const formatted = mocha.formatResults(results);
    console.log(formatted);
    
    // Display summary
    const summary = mocha.getSummary(results);
    console.log('\n' + '='.repeat(60));
    console.log('📊 Unit Test Summary');
    console.log('='.repeat(60));
    console.log(`Total:   ${summary.total}`);
    console.log(`Passed:  ${summary.passed} ✓`);
    console.log(`Failed:  ${summary.failed} ✗`);
    console.log(`Skipped: ${summary.skipped}`);
    console.log(`Pass Rate: ${summary.passRate}`);
    console.log(`Duration: ${duration}ms`);
    console.log('='.repeat(60) + '\n');
    
    return {
      results,
      summary,
      duration
    };
  }

  /**
   * Run only integration tests
   * @returns {Object} Aggregated test results
   */
  function runIntegrationTests() {
    console.log('🧪 Running integration tests...\n');
    
    // Reset mocha context
    mocha.resetContext();
    
    // Discover and load only integration test modules
    const testModules = registry.discoverIntegrationTests();
    
    // Load all integration tests (with error handling)
    let loadErrors = 0;
    for (const [repo, modules] of Object.entries(testModules)) {
      for (const testModule of modules) {
        // Load test module - it registers itself with mocha when loaded
        if (!safeRequire(testModule)) loadErrors++;
      }
    }
    if (loadErrors > 0) {
      Logger.log(`⚠️ ${loadErrors} test module(s) failed to load`);
    }
    
    // Execute all tests
    const startTime = Date.now();
    const results = mocha.executeAll();
    const duration = Date.now() - startTime;
    
    // Format and display results
    const formatted = mocha.formatResults(results);
    console.log(formatted);
    
    // Display summary
    const summary = mocha.getSummary(results);
    console.log('\n' + '='.repeat(60));
    console.log('📊 Integration Test Summary');
    console.log('='.repeat(60));
    console.log(`Total:   ${summary.total}`);
    console.log(`Passed:  ${summary.passed} ✓`);
    console.log(`Failed:  ${summary.failed} ✗`);
    console.log(`Skipped: ${summary.skipped}`);
    console.log(`Pass Rate: ${summary.passRate}`);
    console.log(`Duration: ${duration}ms`);
    console.log('='.repeat(60) + '\n');
    
    return {
      results,
      summary,
      duration
    };
  }

  /**
   * Run tests for a specific repo
   * @param {string} repoName - Repository name (e.g., 'common-js', 'sheets-chat')
   * @returns {Object} Aggregated test results
   */
  function runRepoTests(repoName) {
    console.log(`🧪 Running tests for ${repoName}...\n`);
    
    // Reset mocha context
    mocha.resetContext();
    
    // Discover and load tests for specific repo
    const testModules = registry.discoverRepoTests(repoName);
    
    if (!testModules) {
      console.log(`❌ No tests found for repo: ${repoName}\n`);
      return {
        results: [],
        summary: { total: 0, passed: 0, failed: 0, skipped: 0, passRate: 'N/A' },
        duration: 0
      };
    }
    
    // Load all tests for this repo (with error handling)
    let loadErrors = 0;
    for (const [type, modules] of Object.entries(testModules)) {
      for (const testModule of modules) {
        // Load test module - it registers itself with mocha when loaded
        if (!safeRequire(testModule)) loadErrors++;
      }
    }
    if (loadErrors > 0) {
      Logger.log(`⚠️ ${loadErrors} test module(s) failed to load`);
    }
    
    // Execute all tests
    const startTime = Date.now();
    const results = mocha.executeAll();
    const duration = Date.now() - startTime;
    
    // Format and display results
    const formatted = mocha.formatResults(results);
    console.log(formatted);
    
    // Display summary
    const summary = mocha.getSummary(results);
    console.log('\n' + '='.repeat(60));
    console.log(`📊 ${repoName} Test Summary`);
    console.log('='.repeat(60));
    console.log(`Total:   ${summary.total}`);
    console.log(`Passed:  ${summary.passed} ✓`);
    console.log(`Failed:  ${summary.failed} ✗`);
    console.log(`Skipped: ${summary.skipped}`);
    console.log(`Pass Rate: ${summary.passRate}`);
    console.log(`Duration: ${duration}ms`);
    console.log('='.repeat(60) + '\n');
    
    return {
      results,
      summary,
      duration
    };
  }

  /**
   * Run tests for a specific repo and type
   * @param {string} repoName - Repository name
   * @param {string} type - Test type ('unit' or 'integration')
   * @returns {Object} Aggregated test results
   */
  function runRepoTypeTests(repoName, type) {
    console.log(`🧪 Running ${type} tests for ${repoName}...\n`);
    
    // Reset mocha context
    mocha.resetContext();
    
    // Discover and load tests for specific repo and type
    const testModules = registry.discoverRepoTypeTests(repoName, type);
    
    if (!testModules || testModules.length === 0) {
      console.log(`❌ No ${type} tests found for repo: ${repoName}\n`);
      return {
        results: [],
        summary: { total: 0, passed: 0, failed: 0, skipped: 0, passRate: 'N/A' },
        duration: 0
      };
    }
    
    // Load all tests (with error handling)
    let loadErrors = 0;
    for (const testModule of testModules) {
      // Load test module - it registers itself with mocha when loaded
      if (!safeRequire(testModule)) loadErrors++;
    }
    if (loadErrors > 0) {
      Logger.log(`⚠️ ${loadErrors} test module(s) failed to load`);
    }
    
    // Execute all tests
    const startTime = Date.now();
    const results = mocha.executeAll();
    const duration = Date.now() - startTime;
    
    // Format and display results
    const formatted = mocha.formatResults(results);
    console.log(formatted);
    
    // Display summary
    const summary = mocha.getSummary(results);
    console.log('\n' + '='.repeat(60));
    console.log(`📊 ${repoName} ${type} Test Summary`);
    console.log('='.repeat(60));
    console.log(`Total:   ${summary.total}`);
    console.log(`Passed:  ${summary.passed} ✓`);
    console.log(`Failed:  ${summary.failed} ✗`);
    console.log(`Skipped: ${summary.skipped}`);
    console.log(`Pass Rate: ${summary.passRate}`);
    console.log(`Duration: ${duration}ms`);
    console.log('='.repeat(60) + '\n');
    
    return {
      results,
      summary,
      duration
    };
  }

  /**
   * Run a specific test file
   * @param {string} testPath - Full path to test file (e.g., 'common-js/test/UrlFetchUtils.unit.test')
   * @returns {Object} Aggregated test results
   */
  function runTestFile(testPath) {
    console.log(`🧪 Running test file: ${testPath}...\n`);
    
    // Reset mocha context
    mocha.resetContext();
    
    // Load the specific test file
    try {
      require(testPath);
    } catch (error) {
      console.log(`❌ Error loading test file: ${error.message}\n`);
      return {
        results: [],
        summary: { total: 0, passed: 0, failed: 0, skipped: 0, passRate: 'N/A' },
        duration: 0,
        error: error.message
      };
    }
    
    // Execute all tests
    const startTime = Date.now();
    const results = mocha.executeAll();
    const duration = Date.now() - startTime;
    
    // Format and display results
    const formatted = mocha.formatResults(results);
    console.log(formatted);
    
    // Display summary
    const summary = mocha.getSummary(results);
    console.log('\n' + '='.repeat(60));
    console.log(`📊 Test File Summary: ${testPath}`);
    console.log('='.repeat(60));
    console.log(`Total:   ${summary.total}`);
    console.log(`Passed:  ${summary.passed} ✓`);
    console.log(`Failed:  ${summary.failed} ✗`);
    console.log(`Skipped: ${summary.skipped}`);
    console.log(`Pass Rate: ${summary.passRate}`);
    console.log(`Duration: ${duration}ms`);
    console.log('='.repeat(60) + '\n');
    
    return {
      results,
      summary,
      duration
    };
  }

  /**
   * Run tests matching a grep pattern
   * @param {string|RegExp} pattern - Pattern to match test names against
   * @returns {Object} Aggregated test results
   */
  function runFiltered(pattern) {
    console.log(`🔍 Running tests matching: ${pattern}\n`);
    
    // Reset mocha context
    mocha.resetContext();
    
    // Discover and load all test modules
    const testModules = registry.discoverAll();
    
    // Load all tests (with error handling)
    let loadErrors = 0;
    for (const [repo, types] of Object.entries(testModules)) {
      for (const [type, modules] of Object.entries(types)) {
        for (const testModule of modules) {
          if (!safeRequire(testModule)) loadErrors++;
        }
      }
    }
    if (loadErrors > 0) {
      Logger.log(`⚠️ ${loadErrors} test module(s) failed to load`);
    }
    
    // Execute with grep filter
    const startTime = Date.now();
    const results = mocha.executeAll({ grep: pattern });
    const duration = Date.now() - startTime;
    
    // Get summary first for failures-first output
    const summary = mocha.getSummary(results);
    
    // Show failures at TOP
    const failuresFirst = formatFailuresFirst(results, summary);
    console.log(failuresFirst);
    
    // Then detailed results
    const formatted = mocha.formatResults(results);
    console.log(formatted);
    
    // Display summary
    console.log('\n' + '='.repeat(60));
    console.log(`📊 Filtered Test Summary (${pattern})`);
    console.log('='.repeat(60));
    console.log(`Total:   ${summary.total}`);
    console.log(`Passed:  ${summary.passed} ✓`);
    console.log(`Failed:  ${summary.failed} ✗`);
    console.log(`Skipped: ${summary.skipped}`);
    console.log(`Pass Rate: ${summary.passRate}`);
    console.log(`Duration: ${duration}ms`);
    console.log('='.repeat(60) + '\n');
    
    return {
      results,
      summary,
      duration
    };
  }

  // Export public API
  module.exports = {
    runAllTests,
    runUnitTests,
    runIntegrationTests,
    runRepoTests,
    runRepoTypeTests,
    runTestFile,
    runFiltered,
    // Helpers (for advanced usage)
    collectFailures,
    formatFailuresFirst
  };
}

__defineModule__(_main);