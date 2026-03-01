function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * @module test-framework/fix-hints
   * Auto-generated debugging hints for LLM-friendly test failure reports
   *
   * @example
   * const { generateFixHints } = require('test-framework/fix-hints');
   * const hints = generateFixHints(llmReport);
   * // Returns array of actionable debugging hints
   */

  const { safeStringify } = require('test-framework/diff-utils');

  /**
   * Generate fix hints based on diff and assertion context
   * @param {Object} llmReport - LLM report with diff, values, assertion info
   * @returns {Array<string>} Array of debugging hints
   */
  function generateFixHints(llmReport) {
    const hints = [];
    if (!llmReport) return hints;
    
    const { diff, values, assertion, context } = llmReport;
    
    // RULE: Missing array items
    if (diff?.missing?.length) {
      const keyField = diff.byKey || 'item';
      const count = diff.missing.length;
      
      if (count <= 3) {
        diff.missing.forEach(item => {
          const identifier = item[diff.byKey] || safeStringify(item, 50);
          hints.push(`MISSING: "${identifier}" - check filter/selection criteria`);
        });
      } else {
        hints.push(`MISSING: ${count} items not found in actual result`);
        if (diff.missingKeys) {
          hints.push(`  Keys: ${diff.missingKeys.slice(0, 5).join(', ')}${count > 5 ? '...' : ''}`);
        }
      }
    }
    
    // RULE: Extra unexpected items
    if (diff?.extra?.length) {
      const count = diff.extra.length;
      
      if (count <= 3) {
        diff.extra.forEach(item => {
          const identifier = item[diff.byKey] || safeStringify(item, 50);
          hints.push(`UNEXPECTED: "${identifier}" - check why this passed filters`);
        });
      } else {
        hints.push(`UNEXPECTED: ${count} extra items in actual result`);
        if (diff.extraKeys) {
          hints.push(`  Keys: ${diff.extraKeys.slice(0, 5).join(', ')}${count > 5 ? '...' : ''}`);
        }
      }
    }
    
    // RULE: Modified items (same key, different values)
    if (diff?.modified?.length) {
      diff.modified.slice(0, 3).forEach(mod => {
        if (mod.differences?.modified?.length) {
          const propChanges = mod.differences.modified.map(m => 
            `${m.key}: ${safeStringify(m.actual, 20)} → ${safeStringify(m.expected, 20)}`
          ).join(', ');
          hints.push(`MODIFIED "${mod.key}": ${propChanges}`);
        } else {
          hints.push(`MODIFIED at key "${mod.key}": values differ`);
        }
      });
    }
    
    // RULE: Object property mismatch
    if (diff?.type === 'object') {
      if (diff.removed?.length) {
        hints.push(`MISSING PROPERTIES: ${diff.removed.map(r => r.key).join(', ')}`);
      }
      if (diff.added?.length) {
        hints.push(`UNEXPECTED PROPERTIES: ${diff.added.map(a => a.key).join(', ')}`);
      }
    }
    
    // RULE: Type mismatch
    if (values?.actualType !== values?.expectedType) {
      hints.push(`TYPE MISMATCH: expected ${values.expectedType}, got ${values.actualType}`);
    }
    if (diff?.type === 'mixed') {
      hints.push(`TYPE MISMATCH: expected ${diff.expectedType}, got ${diff.actualType}`);
    }
    
    // RULE: Null/undefined actual
    if (values?.actual === null) {
      hints.push(`ACTUAL IS NULL - check function return value or data loading`);
    }
    if (values?.actual === undefined) {
      hints.push(`ACTUAL IS UNDEFINED - check function return value or property access`);
    }
    
    // RULE: Empty result when expecting items
    if (Array.isArray(values?.actual) && values.actual.length === 0) {
      if (values.expected?.length > 0) {
        hints.push(`EMPTY ARRAY returned but expected ${values.expected.length} items`);
        hints.push(`  Check: filter conditions, data source, date range, API response`);
      }
    }
    
    // RULE: Object is empty when expecting properties
    if (values?.actual && typeof values.actual === 'object' && 
        !Array.isArray(values.actual) && Object.keys(values.actual).length === 0) {
      if (values.expected && Object.keys(values.expected).length > 0) {
        hints.push(`EMPTY OBJECT returned but expected properties`);
      }
    }
    
    // RULE: String mismatch patterns
    if (typeof values?.actual === 'string' && typeof values?.expected === 'string') {
      if (values.actual.toLowerCase() === values.expected.toLowerCase()) {
        hints.push(`CASE MISMATCH: strings differ only in capitalization`);
      }
      if (values.actual.trim() === values.expected.trim()) {
        hints.push(`WHITESPACE MISMATCH: strings differ only in leading/trailing spaces`);
      }
    }
    
    // RULE: Numeric near-miss
    if (typeof values?.actual === 'number' && typeof values?.expected === 'number') {
      const diff = Math.abs(values.actual - values.expected);
      const pctDiff = (diff / Math.abs(values.expected)) * 100;
      if (pctDiff < 1 && pctDiff > 0) {
        hints.push(`NEAR MISS: values differ by ${pctDiff.toFixed(2)}% - possible rounding issue`);
      }
    }
    
    // RULE: Date comparison issues
    if (values?.actual instanceof Date || values?.expected instanceof Date) {
      hints.push(`DATE COMPARISON: ensure both values are Date objects, consider timezone differences`);
    }
    
    // RULE: Based on assertion type
    if (assertion?.type === 'include') {
      hints.push(`INCLUDE CHECK: verify the item exists in the collection`);
    }
    if (assertion?.type === 'property') {
      hints.push(`PROPERTY CHECK: verify object structure and property name spelling`);
    }
    if (assertion?.type === 'throw') {
      hints.push(`THROW CHECK: verify function throws the expected error type/message`);
    }
    
    // RULE: Context-specific hints
    if (context?.scenario) {
      hints.push(`SCENARIO: ${context.scenario}`);
    }
    if (context?.customHints) {
      hints.push(...context.customHints);
    }
    
    return hints;
  }

  /**
   * Format hints as text block
   * @param {Array<string>} hints - Array of hints
   * @param {string} prefix - Line prefix
   * @returns {string} Formatted hints
   */
  function formatHints(hints, prefix = '  → ') {
    if (!hints || !hints.length) return '';
    return hints.map(h => `${prefix}${h}`).join('\n');
  }

  /**
   * Generate domain-specific hints for USAW/NTP testing
   * @param {Object} llmReport - LLM report
   * @param {string} domain - Domain context ('ntp', 'usaw', etc.)
   * @returns {Array<string>} Domain-specific hints
   */
  function generateDomainHints(llmReport, domain) {
    const hints = [];
    const { diff, values } = llmReport || {};
    
    if (domain === 'ntp' || domain === 'usaw') {
      // NTP-specific hints
      if (diff?.missing?.length) {
        diff.missing.forEach(athlete => {
          if (athlete.name || athlete.athleteId) {
            const id = athlete.name || athlete.athleteId;
            hints.push(`Check if "${id}" meets tier criteria:`);
            hints.push(`  - Has required event type (international/national)?`);
            hints.push(`  - Meets age group standards (A/B)?`);
            hints.push(`  - Not in _NTP_Ineligible sheet?`);
            hints.push(`  - Performance in qualifying period?`);
          }
        });
      }
      
      if (diff?.extra?.length) {
        diff.extra.forEach(athlete => {
          if (athlete.name || athlete.athleteId) {
            const id = athlete.name || athlete.athleteId;
            hints.push(`Check why "${id}" incorrectly included:`);
            hints.push(`  - Should be in _NTP_Ineligible?`);
            hints.push(`  - Event type classification correct?`);
            hints.push(`  - Age group calculated correctly?`);
          }
        });
      }
      
      // Check for common NTP issues
      if (values?.actual && Array.isArray(values.actual)) {
        const hasDuplicates = values.actual.some((a, i) => 
          values.actual.findIndex(b => b.athleteId === a.athleteId) !== i
        );
        if (hasDuplicates) {
          hints.push(`DUPLICATE ATHLETES detected - check deduplication logic`);
        }
      }
    }
    
    return hints;
  }

  // Export public API
  module.exports = {
    generateFixHints,
    formatHints,
    generateDomainHints
  };
}

__defineModule__(_main);