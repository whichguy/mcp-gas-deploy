function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * @module test-framework/test-helpers
   * Test utilities: spies, stubs, mocks, fixtures
   *
   * @example
   * const {createSpy, createStub, createMock} = require('test-framework/test-helpers');
   * const spy = createSpy(); fn(spy); spy.callCount; spy.calledWith(arg);
   * const stub = createStub('value'); stub() === 'value';
   * const mock = createMock({method: 'ret'}); mock.method();
   * createFixture(data); // deep clone
   * retryFlaky(fn, 3); // retry flaky tests
   */

  /**
   * Create a spy function that tracks calls
   * @param {Function} fn - Optional function to wrap
   * @returns {Function} Spy function with call tracking
   */
  function createSpy(fn) {
    const spy = function(...args) {
      spy.calls.push({
        args: args,
        timestamp: Date.now()
      });
      spy.callCount++;
      
      if (fn) {
        const result = fn(...args);
        spy.results.push(result);
        return result;
      }
    };
    
    spy.calls = [];
    spy.results = [];
    spy.callCount = 0;
    spy.reset = function() {
      spy.calls = [];
      spy.results = [];
      spy.callCount = 0;
    };
    spy.calledWith = function(...expectedArgs) {
      return spy.calls.some(call => 
        call.args.length === expectedArgs.length &&
        call.args.every((arg, i) => arg === expectedArgs[i])
      );
    };
    
    return spy;
  }

  /**
   * Create a stub function that returns a fixed value
   * @param {*} returnValue - Value to return
   * @returns {Function} Stub function
   */
  function createStub(returnValue) {
    return createSpy(() => returnValue);
  }

  /**
   * Create a mock object with stubbed methods
   * @param {Object} methods - Methods to stub with their return values
   * @returns {Object} Mock object
   */
  function createMock(methods) {
    const mock = {};
    
    for (const [name, returnValue] of Object.entries(methods)) {
      mock[name] = createStub(returnValue);
    }
    
    return mock;
  }

  /**
   * Measure execution time of a function
   * @param {Function} fn - Function to measure
   * @returns {Object} Result with duration and return value
   */
  function measureTime(fn) {
    const start = Date.now();
    const result = fn();
    const duration = Date.now() - start;
    
    return {
      result,
      duration
    };
  }

  /**
   * Wait for a condition to be true (polling with timeout)
   * @param {Function} condition - Function that returns boolean
   * @param {Object} options - Options {timeout, interval, message}
   * @returns {boolean} True if condition met, throws if timeout
   */
  function waitFor(condition, options = {}) {
    const timeout = options.timeout || 5000;
    const interval = options.interval || 100;
    const message = options.message || 'Condition not met within timeout';
    
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      if (condition()) {
        return true;
      }
      Utilities.sleep(interval);
    }
    
    throw new Error(message);
  }

  /**
   * Create a mock UrlFetchApp response
   * @param {Object} options - Response options {statusCode, content, headers, contentText}
   * @returns {Object} Mock response object
   */
  function createMockResponse(options = {}) {
    const statusCode = options.statusCode || 200;
    const content = options.content || '';
    const headers = options.headers || {};
    const contentText = options.contentText || JSON.stringify(content);
    
    return {
      getResponseCode: () => statusCode,
      getContentText: () => contentText,
      getHeaders: () => headers,
      getContent: () => Utilities.newBlob(contentText).getBytes(),
      getAllHeaders: () => headers
    };
  }

  /**
   * Create a mock failed UrlFetchApp response
   * @param {number} statusCode - HTTP status code
   * @param {string} statusText - HTTP status text
   * @returns {Object} Mock response object
   */
  function createMockErrorResponse(statusCode, statusText = '') {
    return {
      getResponseCode: () => statusCode,
      getContentText: () => `Error: ${statusCode} ${statusText}`,
      getHeaders: () => ({}),
      getAllHeaders: () => ({}),
      getContent: () => Utilities.newBlob('').getBytes()
    };
  }

  /**
   * Capture console.log output during function execution
   * @param {Function} fn - Function to execute
   * @returns {Object} Result with logs and return value
   */
  function captureConsoleLog(fn) {
    const logs = [];
    const originalLog = console.log;
    
    console.log = function(...args) {
      logs.push(args.map(arg => String(arg)).join(' '));
    };
    
    try {
      const result = fn();
      return { result, logs };
    } finally {
      console.log = originalLog;
    }
  }

  /**
   * Capture Logger.log output during function execution
   * @param {Function} fn - Function to execute
   * @returns {Object} Result with logs and return value
   */
  function captureLoggerLog(fn) {
    const logs = [];
    const originalLog = Logger.log;
    
    Logger.log = function(...args) {
      logs.push(args.map(arg => String(arg)).join(' '));
    };
    
    try {
      const result = fn();
      return { result, logs };
    } finally {
      Logger.log = originalLog;
    }
  }

  /**
   * Generate random string
   * @param {number} length - String length
   * @returns {string} Random string
   */
  function randomString(length = 10) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    return result;
  }

  /**
   * Generate random integer between min and max (inclusive)
   * @param {number} min - Minimum value
   * @param {number} max - Maximum value
   * @returns {number} Random integer
   */
  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Deep clone an object
   * @param {*} obj - Object to clone
   * @returns {*} Cloned object
   */
  function deepClone(obj) {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }
    
    if (obj instanceof Date) {
      return new Date(obj.getTime());
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => deepClone(item));
    }
    
    const cloned = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        cloned[key] = deepClone(obj[key]);
      }
    }
    
    return cloned;
  }

  /**
   * Create a temporary property on an object (auto-restore after test)
   * @param {Object} obj - Object to modify
   * @param {string} property - Property name
   * @param {*} value - Temporary value
   * @returns {Function} Restore function
   */
  function temporaryProperty(obj, property, value) {
    const original = obj[property];
    const hasOriginal = property in obj;
    
    obj[property] = value;
    
    return function restore() {
      if (hasOriginal) {
        obj[property] = original;
      } else {
        delete obj[property];
      }
    };
  }

  /**
   * Create a fake timer for testing time-dependent code
   * @returns {Object} Fake timer with advance() method
   */
  function createFakeTimer() {
    let currentTime = Date.now();
    const originalDateNow = Date.now;
    
    Date.now = function() {
      return currentTime;
    };
    
    return {
      advance: function(ms) {
        currentTime += ms;
      },
      reset: function() {
        currentTime = originalDateNow();
      },
      restore: function() {
        Date.now = originalDateNow;
      },
      getCurrentTime: function() {
        return currentTime;
      }
    };
  }

  /**
   * Expect function to throw an error with specific message
   * @param {Function} fn - Function that should throw
   * @param {string|RegExp} expectedMessage - Expected error message or pattern
   * @returns {Error} The caught error
   */
  function expectToThrow(fn, expectedMessage) {
    let error = null;
    
    try {
      fn();
    } catch (e) {
      error = e;
    }
    
    if (!error) {
      throw new Error('Expected function to throw an error but it did not');
    }
    
    if (expectedMessage) {
      const message = error.message || String(error);
      
      if (expectedMessage instanceof RegExp) {
        if (!expectedMessage.test(message)) {
          throw new Error(
            `Expected error message to match ${expectedMessage} but got: ${message}`
          );
        }
      } else {
        if (!message.includes(expectedMessage)) {
          throw new Error(
            `Expected error message to include "${expectedMessage}" but got: ${message}`
          );
        }
      }
    }
    
    return error;
  }

  /**
   * Create a test fixture (setup/teardown helper)
   * @param {Function} setup - Setup function
   * @param {Function} teardown - Teardown function
   * @returns {Object} Fixture object
   */
  function createFixture(setup, teardown) {
    return {
      setup: setup,
      teardown: teardown,
      run: function(testFn) {
        const context = setup ? setup() : {};
        try {
          testFn(context);
        } finally {
          if (teardown) {
            teardown(context);
          }
        }
      }
    };
  }

  /**
   * Retry a flaky test multiple times
   * @param {Function} testFn - Test function
   * @param {number} maxAttempts - Maximum attempts
   * @returns {Object} Result with success and attempts
   */
  function retryFlaky(testFn, maxAttempts = 3) {
    let lastError = null;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        testFn();
        return { success: true, attempts: attempt };
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          Utilities.sleep(100 * attempt); // Exponential backoff
        }
      }
    }
    
    throw new Error(
      `Test failed after ${maxAttempts} attempts. Last error: ${lastError.message}`
    );
  }

  // Export public API
  module.exports = {
    createSpy,
    createStub,
    createMock,
    measureTime,
    waitFor,
    createMockResponse,
    createMockErrorResponse,
    captureConsoleLog,
    captureLoggerLog,
    randomString,
    randomInt,
    deepClone,
    temporaryProperty,
    createFakeTimer,
    expectToThrow,
    createFixture,
    retryFlaky
  };
}

__defineModule__(_main);