function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * @module test-framework/diff-utils
   * Deep structural diff computation for LLM-friendly test failure reports
   *
   * @example
   * const { computeDiff, safeStringify } = require('test-framework/diff-utils');
   * const diff = computeDiff(actual, expected);
   * // Returns { type, missing, extra, modified, summary }
   */

  /**
   * Safe JSON stringify with truncation for large objects
   * @param {*} value - Value to stringify
   * @param {number} maxLength - Maximum string length
   * @returns {string} JSON string or fallback representation
   */
  function safeStringify(value, maxLength = 500) {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'function') return '[Function]';
    
    try {
      const str = JSON.stringify(value);
      if (str.length > maxLength) {
        return str.slice(0, maxLength - 3) + '...';
      }
      return str;
    } catch (e) {
      return String(value);
    }
  }

  /**
   * Detect the type category for diff computation
   * @param {*} actual - Actual value
   * @param {*} expected - Expected value
   * @returns {string} Type category: 'array', 'object', 'primitive', 'mixed'
   */
  function detectType(actual, expected) {
    const isArrayA = Array.isArray(actual);
    const isArrayE = Array.isArray(expected);
    
    if (isArrayA && isArrayE) return 'array';
    if (isArrayA !== isArrayE) return 'mixed';
    
    const isObjA = typeof actual === 'object' && actual !== null;
    const isObjE = typeof expected === 'object' && expected !== null;
    
    if (isObjA && isObjE) return 'object';
    if (isObjA !== isObjE) return 'mixed';
    
    return 'primitive';
  }

  /**
   * Detect common key fields for array item matching
   * @param {Array} arr - Array to analyze
   * @returns {string|null} Key field name or null
   */
  function detectKeyField(arr) {
    if (!arr || !arr.length) return null;
    const sample = arr[0];
    if (typeof sample !== 'object' || sample === null) return null;
    
    // Common key field names in order of preference
    const keyFields = ['id', 'athleteId', 'name', 'key', '_id', 'memberId', 'email'];
    for (const key of keyFields) {
      if (key in sample) return key;
    }
    return null;
  }

  /**
   * Find matching item in array by key field or deep equality
   * @param {Array} arr - Array to search
   * @param {*} item - Item to find
   * @param {string|null} keyField - Key field for matching
   * @returns {*} Matching item or undefined
   */
  function findMatch(arr, item, keyField) {
    if (!arr || !arr.length) return undefined;
    
    if (keyField && typeof item === 'object' && item !== null && keyField in item) {
      return arr.find(a => a && typeof a === 'object' && a[keyField] === item[keyField]);
    }
    
    // Fall back to deep equality
    return arr.find(a => deepEqual(a, item));
  }

  /**
   * Deep equality comparison with circular reference protection
   * @param {*} a - First value
   * @param {*} b - Second value
   * @param {WeakMap} [visitedA] - Visited objects from a (for circular detection)
   * @param {WeakMap} [visitedB] - Visited objects from b (for circular detection)
   * @returns {boolean} True if deeply equal
   */
  function deepEqual(a, b, visitedA, visitedB) {
    // Initialize visited maps on first call
    if (!visitedA) {
      visitedA = new WeakMap();
      visitedB = new WeakMap();
    }
    
    // Handle primitives and same reference
    if (a === b) return true;
    
    // Handle null and undefined (use strict equality)
    if (a === null || a === undefined || b === null || b === undefined) {
      return a === b;
    }
    
    // Handle different types
    if (typeof a !== typeof b) return false;
    
    // Handle Date objects
    if (a instanceof Date && b instanceof Date) {
      return a.getTime() === b.getTime();
    }
    
    // Handle Arrays
    if (Array.isArray(a) && Array.isArray(b)) {
      // Check for circular references
      if (visitedA.has(a)) {
        return visitedB.has(b) && visitedA.get(a) === visitedB.get(b);
      }
      
      // Mark as visited with unique ID
      const idA = visitedA.size;
      visitedA.set(a, idA);
      visitedB.set(b, idA);
      
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!deepEqual(a[i], b[i], visitedA, visitedB)) return false;
      }
      return true;
    }
    
    // Handle Objects
    if (typeof a === 'object') {
      // Check for circular references
      if (visitedA.has(a)) {
        return visitedB.has(b) && visitedA.get(a) === visitedB.get(b);
      }
      
      // Mark as visited with unique ID
      const idA = visitedA.size;
      visitedA.set(a, idA);
      visitedB.set(b, idA);
      
      const keysA = Object.keys(a);
      const keysB = Object.keys(b);
      if (keysA.length !== keysB.length) return false;
      for (const key of keysA) {
        if (!keysB.includes(key)) return false;
        if (!deepEqual(a[key], b[key], visitedA, visitedB)) return false;
      }
      return true;
    }
    
    return false;
  }

  /**
   * Find items that exist in both arrays but have different values
   * @param {Array} actual - Actual array
   * @param {Array} expected - Expected array
   * @param {string|null} keyField - Key field for matching
   * @returns {Array} Array of {key, expected, actual} objects
   */
  function findModified(actual, expected, keyField) {
    if (!keyField) return [];
    
    const modified = [];
    for (const expItem of expected) {
      if (typeof expItem !== 'object' || expItem === null) continue;
      
      const actItem = findMatch(actual, expItem, keyField);
      if (actItem && !deepEqual(actItem, expItem)) {
        modified.push({
          key: expItem[keyField],
          expected: expItem,
          actual: actItem,
          differences: computeObjectDiff(actItem, expItem)
        });
      }
    }
    return modified;
  }

  /**
   * Compute object-level diff for property changes
   * @param {Object} actual - Actual object
   * @param {Object} expected - Expected object
   * @returns {Object} Diff with added, removed, modified
   */
  function computeObjectDiff(actual, expected) {
    const diff = {
      added: [],
      removed: [],
      modified: []
    };
    
    const actualKeys = Object.keys(actual || {});
    const expectedKeys = Object.keys(expected || {});
    const allKeys = new Set([...actualKeys, ...expectedKeys]);
    
    for (const key of allKeys) {
      const inActual = key in (actual || {});
      const inExpected = key in (expected || {});
      
      if (inActual && !inExpected) {
        diff.added.push({ key, value: actual[key] });
      } else if (!inActual && inExpected) {
        diff.removed.push({ key, value: expected[key] });
      } else if (!deepEqual(actual[key], expected[key])) {
        diff.modified.push({
          key,
          expected: expected[key],
          actual: actual[key]
        });
      }
    }
    
    return diff;
  }

  /**
   * Compute deep structural diff between actual and expected values
   * @param {*} actual - Actual value
   * @param {*} expected - Expected value
   * @returns {Object} Diff result with type, changes, and summary
   */
  function computeDiff(actual, expected) {
    const diff = {
      type: detectType(actual, expected),
      changes: [],
      summary: ''
    };
    
    // Array diff
    if (diff.type === 'array') {
      const keyField = detectKeyField(expected) || detectKeyField(actual);
      diff.byKey = keyField;
      
      // Find missing items (in expected but not in actual)
      diff.missing = (expected || []).filter(e => !findMatch(actual, e, keyField));
      
      // Find extra items (in actual but not in expected)
      diff.extra = (actual || []).filter(a => !findMatch(expected, a, keyField));
      
      // Find modified items (same key, different values)
      diff.modified = findModified(actual, expected, keyField);
      
      // Build summary
      const parts = [];
      if (diff.missing.length) parts.push(`Missing: ${diff.missing.length}`);
      if (diff.extra.length) parts.push(`Extra: ${diff.extra.length}`);
      if (diff.modified.length) parts.push(`Modified: ${diff.modified.length}`);
      diff.summary = parts.join(', ') || 'Arrays differ';
      
      // Add descriptive missing/extra with key values
      if (keyField) {
        if (diff.missing.length) {
          diff.missingKeys = diff.missing.map(m => m[keyField]).filter(Boolean);
        }
        if (diff.extra.length) {
          diff.extraKeys = diff.extra.map(e => e[keyField]).filter(Boolean);
        }
      }
    }
    // Object diff
    else if (diff.type === 'object') {
      const objDiff = computeObjectDiff(actual, expected);
      diff.added = objDiff.added;
      diff.removed = objDiff.removed;
      diff.modified = objDiff.modified;
      
      const parts = [];
      if (diff.added.length) parts.push(`+${diff.added.length} added`);
      if (diff.removed.length) parts.push(`-${diff.removed.length} removed`);
      if (diff.modified.length) parts.push(`~${diff.modified.length} modified`);
      diff.summary = parts.join(', ') || 'Objects differ';
    }
    // Mixed type diff
    else if (diff.type === 'mixed') {
      diff.expected = expected;
      diff.actual = actual;
      diff.expectedType = Array.isArray(expected) ? 'array' : typeof expected;
      diff.actualType = Array.isArray(actual) ? 'array' : typeof actual;
      diff.summary = `Type mismatch: expected ${diff.expectedType}, got ${diff.actualType}`;
    }
    // Primitive diff
    else {
      diff.expected = expected;
      diff.actual = actual;
      diff.summary = `${safeStringify(actual, 50)} !== ${safeStringify(expected, 50)}`;
    }
    
    return diff;
  }

  /**
   * Format diff as human-readable text
   * @param {Object} diff - Diff result from computeDiff
   * @param {number} indent - Indentation level
   * @returns {string} Formatted diff text
   */
  function formatDiff(diff, indent = 0) {
    const pad = '  '.repeat(indent);
    let output = '';
    
    output += `${pad}Type: ${diff.type}\n`;
    output += `${pad}Summary: ${diff.summary}\n`;
    
    if (diff.type === 'array') {
      if (diff.byKey) {
        output += `${pad}Key field: ${diff.byKey}\n`;
      }
      if (diff.missing && diff.missing.length) {
        output += `${pad}Missing (${diff.missing.length}):\n`;
        for (const item of diff.missing.slice(0, 5)) {
          output += `${pad}  - ${safeStringify(item, 100)}\n`;
        }
        if (diff.missing.length > 5) {
          output += `${pad}  ... and ${diff.missing.length - 5} more\n`;
        }
      }
      if (diff.extra && diff.extra.length) {
        output += `${pad}Extra (${diff.extra.length}):\n`;
        for (const item of diff.extra.slice(0, 5)) {
          output += `${pad}  + ${safeStringify(item, 100)}\n`;
        }
        if (diff.extra.length > 5) {
          output += `${pad}  ... and ${diff.extra.length - 5} more\n`;
        }
      }
      if (diff.modified && diff.modified.length) {
        output += `${pad}Modified (${diff.modified.length}):\n`;
        for (const mod of diff.modified.slice(0, 3)) {
          output += `${pad}  ~ ${mod.key}:\n`;
          if (mod.differences) {
            for (const m of mod.differences.modified.slice(0, 3)) {
              output += `${pad}      ${m.key}: ${safeStringify(m.actual, 30)} -> ${safeStringify(m.expected, 30)}\n`;
            }
          }
        }
      }
    } else if (diff.type === 'object') {
      if (diff.removed && diff.removed.length) {
        output += `${pad}Removed properties:\n`;
        for (const r of diff.removed) {
          output += `${pad}  - ${r.key}: ${safeStringify(r.value, 50)}\n`;
        }
      }
      if (diff.added && diff.added.length) {
        output += `${pad}Added properties:\n`;
        for (const a of diff.added) {
          output += `${pad}  + ${a.key}: ${safeStringify(a.value, 50)}\n`;
        }
      }
      if (diff.modified && diff.modified.length) {
        output += `${pad}Modified properties:\n`;
        for (const m of diff.modified) {
          output += `${pad}  ~ ${m.key}: ${safeStringify(m.actual, 30)} -> ${safeStringify(m.expected, 30)}\n`;
        }
      }
    } else {
      output += `${pad}Expected: ${safeStringify(diff.expected, 200)}\n`;
      output += `${pad}Actual:   ${safeStringify(diff.actual, 200)}\n`;
    }
    
    return output;
  }

  // Export public API
  module.exports = {
    computeDiff,
    formatDiff,
    safeStringify,
    detectType,
    detectKeyField,
    findMatch,
    deepEqual,
    computeObjectDiff
  };
}

__defineModule__(_main);