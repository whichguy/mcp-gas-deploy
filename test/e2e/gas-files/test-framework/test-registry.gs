function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Test modules organized by repo and type
   * Structure: { repo: { unit: [paths...], integration: [paths...] } }
   * 
   * File naming convention:
   * - Unit tests: {repo}/test/{ModuleName}.unit.test
   * - Integration tests: {repo}/test/{ModuleName}.integration.test
   */
  const TEST_MODULES = {
    'common-js': {
      unit: [
        'common-js/test/UrlFetchUtils.unit.test',
        'common-js/test/require-loading.unit.test',
        'common-js/test/require-resolution.unit.test',
        'common-js/test/require-exports.unit.test',
        'common-js/test/require-circular.unit.test',
        'common-js/test/require-errors.unit.test'
      ],
      integration: [
        'common-js/test/UrlFetchUtils.integration.test',
        'common-js/test/require.integration.test'
      ]
    },
    
    'sheets-chat': {
      unit: [
        // Add sheets-chat unit tests here
        // Example: 'sheets-chat/test/ClaudeConversation.unit.test'
      ],
      integration: [
        'sheets-chat/test/ThreadContinuation.integration.test'
      ]
    },
    
    'gas-queue': {
      unit: [
        // Add gas-queue unit tests here (if this repo exists)
      ],
      integration: [
        // Add gas-queue integration tests here (if this repo exists)
      ]
    },
    
    'tools': {
      unit: [
        'tools/test/UsawStandards.unit.test'
      ],
      integration: [
        'tools/test/NtpSelection.integration.test'
      ]
    },
    
    'test-framework': {
      unit: [
        // Add test-framework unit tests here (tests for the test framework itself)
        // Example: 'test-framework/test/mocha-adapter.unit.test'
        // Example: 'test-framework/test/chai-assertions.unit.test'
      ],
      integration: [
        // Test framework integration tests
      ]
    },
    
    'knowledge-tests': {
      unit: [
        'knowledge-tests/Knowledge.unit.test',
        'knowledge-tests/USAW-Tools.unit.test.gs'
      ],
      integration: [
        'knowledge-tests/Knowledge.integration.test',
        'knowledge-tests/USAW-Tools.integration.test.gs',
        'knowledge-tests/USAW-API.contract.test',
        'knowledge-tests/Knowledge.e2e.test',
        'knowledge-tests/USAW-Prompt.test.gs'
      ]
    }
  };

  /**
   * Cross-repo integration tests at root level
   * These tests verify interactions between different repos
   */
  const CROSS_REPO_INTEGRATION_TESTS = [
    // Add cross-repo integration tests here
    // Example: 'test-integration/ClaudeConversation-UrlFetchUtils.integration.test'
  ];

  /**
   * Discover all test modules
   * @returns {Object} All test modules organized by repo and type
   */
  function discoverAll() {
    const loaded = {};
    
    for (const [repo, types] of Object.entries(TEST_MODULES)) {
      loaded[repo] = {};
      
      for (const [type, paths] of Object.entries(types)) {
        loaded[repo][type] = paths.map(path => {
          try {
            return require(path);
          } catch (error) {
            console.log(`⚠️  Warning: Failed to load test module '${path}': ${error.message}`);
            return null;
          }
        }).filter(module => module !== null);
      }
    }
    
    // Load cross-repo integration tests
    loaded['cross-repo'] = {
      integration: CROSS_REPO_INTEGRATION_TESTS.map(path => {
        try {
          return require(path);
        } catch (error) {
          console.log(`⚠️  Warning: Failed to load cross-repo test '${path}': ${error.message}`);
          return null;
        }
      }).filter(module => module !== null)
    };
    
    return loaded;
  }

  /**
   * Discover only unit tests
   * @returns {Object} Unit test modules organized by repo
   */
  function discoverUnitTests() {
    const loaded = {};
    
    for (const [repo, types] of Object.entries(TEST_MODULES)) {
      if (types.unit && types.unit.length > 0) {
        loaded[repo] = types.unit.map(path => {
          try {
            return require(path);
          } catch (error) {
            console.log(`⚠️  Warning: Failed to load unit test '${path}': ${error.message}`);
            return null;
          }
        }).filter(module => module !== null);
      }
    }
    
    return loaded;
  }

  /**
   * Discover only integration tests
   * @returns {Object} Integration test modules organized by repo
   */
  function discoverIntegrationTests() {
    const loaded = {};
    
    // Repo integration tests
    for (const [repo, types] of Object.entries(TEST_MODULES)) {
      if (types.integration && types.integration.length > 0) {
        loaded[repo] = types.integration.map(path => {
          try {
            return require(path);
          } catch (error) {
            console.log(`⚠️  Warning: Failed to load integration test '${path}': ${error.message}`);
            return null;
          }
        }).filter(module => module !== null);
      }
    }
    
    // Cross-repo integration tests
    loaded['cross-repo'] = CROSS_REPO_INTEGRATION_TESTS.map(path => {
      try {
        return require(path);
      } catch (error) {
        console.log(`⚠️  Warning: Failed to load cross-repo test '${path}': ${error.message}`);
        return null;
      }
    }).filter(module => module !== null);
    
    return loaded;
  }

  /**
   * Discover tests for a specific repo
   * @param {string} repoName - Repository name
   * @returns {Object|null} Test modules for the repo organized by type
   */
  function discoverRepoTests(repoName) {
    if (!TEST_MODULES[repoName]) {
      return null;
    }
    
    const loaded = {};
    const repoTests = TEST_MODULES[repoName];
    
    for (const [type, paths] of Object.entries(repoTests)) {
      loaded[type] = paths.map(path => {
        try {
          return require(path);
        } catch (error) {
          console.log(`⚠️  Warning: Failed to load test '${path}': ${error.message}`);
          return null;
        }
      }).filter(module => module !== null);
    }
    
    return loaded;
  }

  /**
   * Discover tests for a specific repo and type
   * @param {string} repoName - Repository name
   * @param {string} type - Test type ('unit' or 'integration')
   * @returns {Array|null} Test modules for the repo and type
   */
  function discoverRepoTypeTests(repoName, type) {
    if (!TEST_MODULES[repoName] || !TEST_MODULES[repoName][type]) {
      return null;
    }
    
    const paths = TEST_MODULES[repoName][type];
    
    return paths.map(path => {
      try {
        return require(path);
      } catch (error) {
        console.log(`⚠️  Warning: Failed to load test '${path}': ${error.message}`);
        return null;
      }
    }).filter(module => module !== null);
  }

  /**
   * Get list of all registered test paths
   * @returns {Object} All test paths organized by repo and type
   */
  function listAllTestPaths() {
    return {
      byRepo: TEST_MODULES,
      crossRepo: CROSS_REPO_INTEGRATION_TESTS
    };
  }

  /**
   * Get count of registered tests
   * @returns {Object} Test counts by repo and type
   */
  function getTestCounts() {
    const counts = {
      byRepo: {},
      crossRepo: CROSS_REPO_INTEGRATION_TESTS.length,
      total: CROSS_REPO_INTEGRATION_TESTS.length
    };
    
    for (const [repo, types] of Object.entries(TEST_MODULES)) {
      const unitCount = types.unit ? types.unit.length : 0;
      const integrationCount = types.integration ? types.integration.length : 0;
      
      counts.byRepo[repo] = {
        unit: unitCount,
        integration: integrationCount,
        total: unitCount + integrationCount
      };
      
      counts.total += unitCount + integrationCount;
    }
    
    return counts;
  }

  // Export public API
  module.exports = {
    discoverAll,
    discoverUnitTests,
    discoverIntegrationTests,
    discoverRepoTests,
    discoverRepoTypeTests,
    listAllTestPaths,
    getTestCounts
  };
}

__defineModule__(_main);