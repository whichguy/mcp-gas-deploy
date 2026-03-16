/**
 * Unit tests for CommonJS Validator
 *
 * Tests each of the 7 validation rules with passing and failing examples.
 */

import { describe, it } from 'mocha';
import { strict as assert } from 'node:assert';
import { validateFiles, validateFilesErrors, type ValidationResult } from '../../src/validation/commonjsValidator.js';

// Helper to validate a single file
function validate(name: string, source: string): ValidationResult {
  const results = validateFiles([{ name, source, position: 1 }], { skipRequirePositionCheck: true });
  return results.find(r => r.file === name) ?? { file: name, valid: true, errors: [] };
}

// Helper to get error rules from a single file
function errorRules(name: string, source: string): string[] {
  return validate(name, source).errors.map(e => e.rule);
}

describe('CommonJS Validator', () => {

  describe('MISSING_MAIN', () => {
    it('passes when _main is present', () => {
      const src = `
function _main() {
  exports.add = function(a, b) { return a + b; };
}
__defineModule__(_main, false);`;
      assert.ok(!errorRules('Calculator.gs', src).includes('MISSING_MAIN'));
    });

    it('fails when _main is missing', () => {
      const src = `
exports.add = function(a, b) { return a + b; };
__defineModule__(_main, false);`;
      assert.ok(errorRules('Calculator.gs', src).includes('MISSING_MAIN'));
    });

    it('handles _main with whitespace', () => {
      const src = `
  function _main() {
    exports.x = 1;
  }
  __defineModule__(_main, false);`;
      assert.ok(!errorRules('Mod.gs', src).includes('MISSING_MAIN'));
    });
  });

  describe('MISSING_DEFINE', () => {
    it('passes when __defineModule__ is present', () => {
      const src = `
function _main() {
  exports.x = 1;
}
__defineModule__(_main, false);`;
      assert.ok(!errorRules('Mod.gs', src).includes('MISSING_DEFINE'));
    });

    it('fails when __defineModule__ is missing', () => {
      const src = `
function _main() {
  exports.x = 1;
}`;
      assert.ok(errorRules('Mod.gs', src).includes('MISSING_DEFINE'));
    });

    it('passes with loadNow: true', () => {
      const src = `
function _main() {
  __events__.doGet = function(e) {};
}
__defineModule__(_main, true);`;
      assert.ok(!errorRules('Web.gs', src).includes('MISSING_DEFINE'));
    });
  });

  describe('LOADNOW_REQUIRED', () => {
    it('passes when trigger uses loadNow: true', () => {
      const src = `
function _main() {
  __events__.doGet = function(e) { return ContentService.createTextOutput('ok'); };
}
__defineModule__(_main, true);`;
      assert.ok(!errorRules('Web.gs', src).includes('LOADNOW_REQUIRED'));
    });

    it('fails when trigger uses loadNow: false', () => {
      const src = `
function _main() {
  __events__.doGet = function(e) {};
}
__defineModule__(_main, false);`;
      assert.ok(errorRules('Web.gs', src).includes('LOADNOW_REQUIRED'));
    });

    it('detects onOpen trigger', () => {
      const src = `
function _main() {
  __events__.onOpen = function(e) {};
}
__defineModule__(_main, false);`;
      assert.ok(errorRules('Menu.gs', src).includes('LOADNOW_REQUIRED'));
    });

    it('ignores non-trigger modules', () => {
      const src = `
function _main() {
  exports.helper = function() {};
}
__defineModule__(_main, false);`;
      assert.ok(!errorRules('Utils.gs', src).includes('LOADNOW_REQUIRED'));
    });

    it('passes with object-form loadNow', () => {
      const src = `
function _main() {
  __events__.onEdit = function(e) {};
}
__defineModule__(_main, { loadNow: true });`;
      assert.ok(!errorRules('Edit.gs', src).includes('LOADNOW_REQUIRED'));
    });
  });

  describe('TOP_LEVEL_REQUIRE', () => {
    it('passes when require is inside _main', () => {
      const src = `
function _main() {
  const Utils = require('Utils');
  exports.run = function() { return Utils.go(); };
}
__defineModule__(_main, false);`;
      assert.ok(!errorRules('Runner.gs', src).includes('TOP_LEVEL_REQUIRE'));
    });

    it('fails when require is outside _main', () => {
      const src = `
const Utils = require('Utils');
function _main() {
  exports.run = function() { return Utils.go(); };
}
__defineModule__(_main, false);`;
      assert.ok(errorRules('Runner.gs', src).includes('TOP_LEVEL_REQUIRE'));
    });

    it('reports line number for top-level require', () => {
      const src = `const X = require('X');
function _main() {}
__defineModule__(_main, false);`;
      const result = validate('Bad.gs', src);
      const err = result.errors.find(e => e.rule === 'TOP_LEVEL_REQUIRE');
      assert.ok(err);
      assert.equal(err.line, 1);
    });
  });

  describe('TOP_LEVEL_EXPORTS', () => {
    it('passes when exports are inside _main', () => {
      const src = `
function _main() {
  exports.add = function(a, b) { return a + b; };
}
__defineModule__(_main, false);`;
      assert.ok(!errorRules('Calc.gs', src).includes('TOP_LEVEL_EXPORTS'));
    });

    it('fails when exports are outside _main', () => {
      const src = `
exports.add = function(a, b) { return a + b; };
function _main() {}
__defineModule__(_main, false);`;
      assert.ok(errorRules('Calc.gs', src).includes('TOP_LEVEL_EXPORTS'));
    });

    it('reports correct line number', () => {
      const src = `
exports.bad = 1;
function _main() {
  exports.good = 2;
}
__defineModule__(_main, false);`;
      const result = validate('Ex.gs', src);
      const err = result.errors.find(e => e.rule === 'TOP_LEVEL_EXPORTS');
      assert.ok(err);
      assert.equal(err.line, 2);
    });
  });

  describe('EVENTS_OUTSIDE_MAIN', () => {
    it('passes when __events__ is inside _main', () => {
      const src = `
function _main() {
  __events__.doGet = function(e) { return ContentService.createTextOutput('ok'); };
}
__defineModule__(_main, true);`;
      assert.ok(!errorRules('Web.gs', src).includes('EVENTS_OUTSIDE_MAIN'));
    });

    it('fails when __events__ is outside _main', () => {
      const src = `
__events__.doGet = function(e) {};
function _main() {}
__defineModule__(_main, true);`;
      assert.ok(errorRules('Web.gs', src).includes('EVENTS_OUTSIDE_MAIN'));
    });
  });

  describe('REQUIRE_POSITION', () => {
    it('passes when require.gs is at position 0', () => {
      const files = [
        { name: 'require.gs', source: '// runtime', position: 0 },
        { name: 'Utils.gs', source: 'function _main() {}\n__defineModule__(_main, false);', position: 1 },
      ];
      const results = validateFiles(files);
      const posErr = results.find(r => r.file === 'require.gs' && !r.valid);
      assert.ok(!posErr);
    });

    it('fails when require.gs is not at position 0', () => {
      const files = [
        { name: 'Utils.gs', source: 'function _main() {}\n__defineModule__(_main, false);', position: 0 },
        { name: 'require.gs', source: '// runtime', position: 1 },
      ];
      const results = validateFiles(files);
      const posErr = results.find(r => r.file === 'require.gs' && !r.valid);
      assert.ok(posErr);
      assert.ok(posErr!.errors[0].rule === 'REQUIRE_POSITION');
    });

    it('skips check when no require.gs in project', () => {
      const files = [
        { name: 'Utils.gs', source: 'function _main() {}\n__defineModule__(_main, false);', position: 0 },
      ];
      const results = validateFiles(files);
      assert.ok(!results.find(r => r.file === 'require.gs'));
    });
  });

  describe('System files', () => {
    it('skips require.gs from per-file validation', () => {
      const files = [
        { name: 'require.gs', source: '// CommonJS runtime — no _main needed', position: 0 },
      ];
      const results = validateFiles(files, { skipRequirePositionCheck: true });
      assert.equal(results.length, 0);
    });

    it('skips appsscript.json', () => {
      const files = [
        { name: 'appsscript.json', source: '{"timeZone":"America/New_York"}', position: 0 },
      ];
      const results = validateFiles(files, { skipRequirePositionCheck: true });
      assert.equal(results.length, 0);
    });

    it('skips common-js/require.gs (path-prefixed system file)', () => {
      const files = [
        { name: 'common-js/require.gs', source: '// runtime — no _main', position: 0 },
      ];
      const results = validateFiles(files, { skipRequirePositionCheck: true });
      assert.equal(results.length, 0);
    });

    it('skips common-js/__mcp_exec.gs (MCP runtime system file)', () => {
      const files = [
        { name: 'common-js/__mcp_exec.gs', source: 'var x = require("mod");', position: 1 },
      ];
      const results = validateFiles(files, { skipRequirePositionCheck: true });
      assert.equal(results.length, 0);
    });

    it('does not skip removed __mcp_exec_error and __mcp_exec_success files', () => {
      const files = [
        { name: 'common-js/__mcp_exec_error.gs', source: 'exports.x = 1;', position: 1 },
        { name: 'common-js/__mcp_exec_success.gs', source: 'exports.y = 2;', position: 2 },
      ];
      const results = validateFiles(files, { skipRequirePositionCheck: true });
      // These are no longer in SKIP_FILES — they'd be validated as normal .gs files
      assert.equal(results.length, 2);
    });

    it('still validates user modules in common-js/ subdirectory', () => {
      const files = [
        { name: 'common-js/ConfigManager.gs', source: '// no _main or __defineModule__', position: 1 },
      ];
      const results = validateFiles(files, { skipRequirePositionCheck: true });
      assert.equal(results.length, 1);
      assert.equal(results[0].errors[0].rule, 'MISSING_MAIN');
    });
  });

  describe('validateFilesErrors', () => {
    it('returns only files with errors', () => {
      const files = [
        { name: 'Good.gs', source: 'function _main() {\n  exports.x = 1;\n}\n__defineModule__(_main, false);', position: 1 },
        { name: 'Bad.gs', source: 'function _main() {\n}\n// missing __defineModule__', position: 2 },
      ];
      const errors = validateFilesErrors(files, { skipRequirePositionCheck: true });
      assert.equal(errors.length, 1);
      assert.equal(errors[0].file, 'Bad.gs');
      assert.equal(errors[0].errors[0].rule, 'MISSING_DEFINE');
    });
  });

  describe('Comment and string false positives', () => {
    it('ignores require() in single-line comments before _main', () => {
      const src = `// Run via: require('Module').run()
function _main() {
  const M = require('Module');
  exports.run = M.run;
}
__defineModule__(_main, false);`;
      const result = validate('Test.gs', src);
      assert.ok(result.valid, `Expected valid, got: ${JSON.stringify(result.errors)}`);
    });

    it('ignores require() in multi-line comments before _main', () => {
      const src = `/* Callers use require('Module') to access this */
function _main() {
  exports.x = 1;
}
__defineModule__(_main, false);`;
      const result = validate('Test.gs', src);
      assert.ok(result.valid, `Expected valid, got: ${JSON.stringify(result.errors)}`);
    });

    it('handles braces in single-quoted strings without breaking brace counting', () => {
      const src = `function _main() {
  const firstBrace = text.indexOf('{');
  const startChar = '{';
  exports.parse = function(t) { return t; };
}
__defineModule__(_main, false);`;
      const result = validate('Parser.gs', src);
      assert.ok(result.valid, `Expected valid, got: ${JSON.stringify(result.errors)}`);
    });

    it('handles braces in double-quoted strings without breaking brace counting', () => {
      const src = `function _main() {
  const x = "{ not a real brace }";
  exports.x = x;
}
__defineModule__(_main, false);`;
      const result = validate('Mod.gs', src);
      assert.ok(result.valid, `Expected valid, got: ${JSON.stringify(result.errors)}`);
    });

    it('handles quotes inside regex literals without breaking parse', () => {
      // /"/g regex contains a quote that must not start a false string
      const src = `function _main() {
  var clean = str.replace(/"/g, '""');
  exports.clean = clean;
}
__defineModule__(_main, false);`;
      const result = validate('CsvUtil.gs', src);
      assert.ok(result.valid, `Expected valid, got: ${JSON.stringify(result.errors)}`);
    });

    it('handles template literals with ${} expressions', () => {
      const src = `function _main() {
  const msg = \`Hello \${name}, score: \${score}\`;
  exports.greet = function(name, score) { return msg; };
}
__defineModule__(_main, false);`;
      const result = validate('Greeter.gs', src);
      assert.ok(result.valid, `Expected valid, got: ${JSON.stringify(result.errors)}`);
    });

    it('handles template literals with URL containing // (not a comment)', () => {
      const src = `function _main() {
  const url = \`https://api.example.com/\${path}\`;
  exports.url = url;
}
__defineModule__(_main, false);`;
      const result = validate('Api.gs', src);
      assert.ok(result.valid, `Expected valid, got: ${JSON.stringify(result.errors)}`);
    });

    it('allows require() in hoisted functions outside _main (brace depth > 0)', () => {
      const src = `function _main() {
  exports.ASK_AI = function(p) { return 'answer'; };
}
function ASK_AI(prompt) {
  return require('CustomFunctions').ASK_AI(prompt);
}
__defineModule__(_main, false);`;
      const result = validate('CustomFunctions.gs', src);
      assert.ok(result.valid, `Expected valid, got: ${JSON.stringify(result.errors)}`);
    });

    it('allows exports.* in hoisted functions outside _main (brace depth > 0)', () => {
      const src = `function _main() {
  exports.greet = function(name) { return name; };
}
function hoistedHelper() {
  exports.greet = function(name) { return name; };
}
__defineModule__(_main, false);`;
      const result = validate('HoistedExports.gs', src);
      assert.ok(result.valid, `Expected valid, got: ${JSON.stringify(result.errors)}`);
    });

    it('allows __events__.* in hoisted functions outside _main (brace depth > 0)', () => {
      const src = `function _main() {
  __events__.doGet = function(e) { return ContentService.createTextOutput('ok'); };
}
function hoistedHandler() {
  __events__.doGet = function(e) { return ContentService.createTextOutput('ok'); };
}
__defineModule__(_main, true);`;
      const result = validate('HoistedEvents.gs', src);
      assert.ok(result.valid, `Expected valid, got: ${JSON.stringify(result.errors)}`);
    });

    it('still detects real require() outside _main when comments also have require()', () => {
      const src = `// require('some-doc-example')
const Bad = require('Bad');
function _main() {
  exports.x = 1;
}
__defineModule__(_main, false);`;
      const result = validate('Mixed.gs', src);
      const rules = result.errors.map(e => e.rule);
      assert.ok(rules.includes('TOP_LEVEL_REQUIRE'));
      // Should only report line 2, not line 1 (the comment)
      const reqErr = result.errors.find(e => e.rule === 'TOP_LEVEL_REQUIRE');
      assert.equal(reqErr!.line, 2);
    });
  });

  describe('SKIP_FILES — html_utils', () => {
    it('skips html_utils (no path prefix)', () => {
      const src = `module.exports = { escape: function(s) { return s; } };`;
      const result = validate('html_utils.gs', src);
      assert.ok(result.valid, `Expected html_utils.gs to be skipped, got: ${JSON.stringify(result.errors)}`);
    });

    it('skips common-js/html_utils (with path prefix)', () => {
      const src = `module.exports = { escape: function(s) { return s; } };`;
      const results = validateFiles(
        [{ name: 'common-js/html_utils', source: src, position: 5 }],
        { skipRequirePositionCheck: true }
      );
      const result = results.find(r => r.file === 'common-js/html_utils');
      assert.ok(!result, 'common-js/html_utils should be skipped entirely (no result entry)');
    });
  });

  describe('Full valid module', () => {
    it('passes a complete utility module', () => {
      const src = `function _main() {
  const Utils = require('Utils');

  exports.add = function(a, b) { return a + b; };
  exports.multiply = function(a, b) { return a * b; };
}

__defineModule__(_main, false);`;
      const result = validate('Calculator.gs', src);
      assert.ok(result.valid, `Expected valid, got errors: ${JSON.stringify(result.errors)}`);
    });

    it('passes a complete trigger module', () => {
      const src = `function _main() {
  __events__.onOpen = function(e) {
    SpreadsheetApp.getUi().createMenu('MyApp').addItem('Run', 'runApp').addToUi();
  };

  __events__.doGet = function(e) {
    return ContentService.createTextOutput('ok');
  };
}

__defineModule__(_main, true);`;
      const result = validate('Triggers.gs', src);
      assert.ok(result.valid, `Expected valid, got errors: ${JSON.stringify(result.errors)}`);
    });

    it('passes a module with multi-line _main signature containing () => {}', () => {
      // Real mcp_gas module pattern: default params include `() => {}` which
      // contains braces inside the parameter list — must not confuse brace counting.
      const src = `function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  const hello = require('hello');
  exports.greet = hello.greet;
  exports.runTests = function() { return 'ok'; };
}

__defineModule__(_main, false);`;
      const result = validate('runner-api.gs', src);
      assert.ok(result.valid, `Expected valid, got errors: ${JSON.stringify(result.errors)}`);
    });

    it('passes a trigger module with multi-line _main signature', () => {
      const src = `function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  __events__.doPost = function(e) {
    const body = JSON.parse(e.postData.contents);
    const api = require('runner-api');
    return ContentService.createTextOutput(JSON.stringify({ result: api[body.function]() }));
  };
}

__defineModule__(_main, true);`;
      const result = validate('dispatcher.gs', src);
      assert.ok(result.valid, `Expected valid, got errors: ${JSON.stringify(result.errors)}`);
    });
  });
});
