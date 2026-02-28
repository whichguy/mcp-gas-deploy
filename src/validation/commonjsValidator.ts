/**
 * CommonJS Validator for mcp_gas_deploy
 *
 * Pre-push validation of .gs files against CommonJS module conventions.
 * Uses regex + minimal structure checks (no full AST parse needed).
 *
 * Each rule-checking function detects a specific structural requirement
 * of the mcp_gas CommonJS module system and returns errors with exact
 * fix suggestions to guide the LLM toward correct patterns.
 */

// --- Public types ---

export interface ValidationResult {
  file: string;
  valid: boolean;
  errors: ValidationError[];
}

export interface ValidationError {
  rule: string;
  line?: number;
  message: string;
  suggestion: string;
}

// --- Rule IDs ---

const RULES = {
  MISSING_MAIN: 'MISSING_MAIN',
  MISSING_DEFINE: 'MISSING_DEFINE',
  LOADNOW_REQUIRED: 'LOADNOW_REQUIRED',
  TOP_LEVEL_REQUIRE: 'TOP_LEVEL_REQUIRE',
  TOP_LEVEL_EXPORTS: 'TOP_LEVEL_EXPORTS',
  EVENTS_OUTSIDE_MAIN: 'EVENTS_OUTSIDE_MAIN',
  REQUIRE_POSITION: 'REQUIRE_POSITION',
} as const;

// --- Trigger function names that require loadNow: true ---

const TRIGGER_NAMES = new Set([
  'doGet', 'doPost', 'onOpen', 'onEdit', 'onInstall',
  'onSelectionChange', 'onFormSubmit',
]);

// --- Helpers ---

/** Find the line number (1-based) of the first match */
function findLineNumber(source: string, pattern: RegExp): number | undefined {
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i + 1;
  }
  return undefined;
}

/**
 * Find the range of the _main() function body.
 * Returns [startLine, endLine] (1-based) or null if not found.
 *
 * Two-phase approach:
 *   Phase 1 — skip parameter list using paren tracking (handles `() => {}` in defaults).
 *   Phase 2 — count body braces from the opening `{` to find the closing `}`.
 */
function findMainFunctionRange(source: string): [number, number] | null {
  const lines = source.split('\n');
  const mainPattern = /^\s*function\s+_main\s*\(/;
  let startLine = -1;

  for (let i = 0; i < lines.length; i++) {
    if (mainPattern.test(lines[i])) {
      startLine = i;
      break;
    }
  }

  if (startLine === -1) return null;

  // Phase 1: track parens to find where the parameter list ends,
  // then the first `{` after that is the function body opener.
  let parenDepth = 0;
  let paramListClosed = false;
  let bodyStartLine = -1;

  for (let i = startLine; i < lines.length && bodyStartLine === -1; i++) {
    for (const ch of lines[i]) {
      if (!paramListClosed) {
        if (ch === '(') parenDepth++;
        else if (ch === ')') {
          parenDepth--;
          if (parenDepth === 0) paramListClosed = true;
        }
      } else {
        // Parameter list closed — next `{` is the body
        if (ch === '{') { bodyStartLine = i; break; }
      }
    }
  }

  if (bodyStartLine === -1) return null;

  // Phase 2: count braces to find the closing `}` of the body.
  let depth = 0;
  for (let i = bodyStartLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return [startLine + 1, i + 1]; // 1-based
      }
    }
  }

  return null;
}

/**
 * Check if a line is inside the _main function body.
 * lineNum is 1-based.
 */
function isInsideMain(mainRange: [number, number] | null, lineNum: number): boolean {
  if (!mainRange) return false;
  return lineNum > mainRange[0] && lineNum <= mainRange[1];
}

// --- Rule checks ---

/**
 * MISSING_MAIN: Every .gs file must have `function _main()`.
 * This is the module entry point that wraps all code.
 */
function checkMissingMain(source: string, _file: string): ValidationError[] {
  // Anchored pattern: `function _main(` at line start (with optional whitespace)
  if (/^\s*function\s+_main\s*\(/m.test(source)) return [];

  return [{
    rule: RULES.MISSING_MAIN,
    message: 'Missing `function _main()` wrapper',
    suggestion: 'Wrap all code inside `function _main() { ... }` at the top of the file',
  }];
}

/**
 * MISSING_DEFINE: Every .gs file must have `__defineModule__(_main, ...)`.
 * This registers the module with the CommonJS runtime.
 */
function checkMissingDefine(source: string, _file: string): ValidationError[] {
  // Match `__defineModule__(_main` — the second arg varies
  if (/__defineModule__\s*\(\s*_main\b/.test(source)) return [];

  return [{
    rule: RULES.MISSING_DEFINE,
    message: 'Missing `__defineModule__(_main, ...)` call',
    suggestion: 'Add `__defineModule__(_main, false);` at the end of the file (use `true` for trigger modules)',
  }];
}

/**
 * LOADNOW_REQUIRED: Trigger files (doGet, onOpen, etc.) must use loadNow: true.
 * Without eager loading, trigger functions won't be available at startup.
 */
function checkLoadNowRequired(source: string, _file: string): ValidationError[] {
  // Check if file uses __events__ with any trigger name
  const hasTrigger = Array.from(TRIGGER_NAMES).some(name => {
    const pattern = new RegExp(`__events__\\.${name}\\b`);
    return pattern.test(source);
  });

  if (!hasTrigger) return [];

  // Check the __defineModule__ call for loadNow value
  // Match `__defineModule__(_main, true)` or `__defineModule__(_main, { loadNow: true })`
  const defMatch = source.match(/__defineModule__\s*\(\s*_main\s*,\s*(.+?)\s*\)/);
  if (!defMatch) return []; // MISSING_DEFINE will catch this

  const secondArg = defMatch[1].trim();

  // `true` or `{ loadNow: true }` — both acceptable
  if (secondArg === 'true' || /loadNow\s*:\s*true/.test(secondArg)) return [];

  const line = findLineNumber(source, /__defineModule__/);
  return [{
    rule: RULES.LOADNOW_REQUIRED,
    line,
    message: 'Trigger module must use `loadNow: true` — triggers need eager loading',
    suggestion: 'Change to `__defineModule__(_main, true);` (eager load for trigger registration)',
  }];
}

/**
 * TOP_LEVEL_REQUIRE: `require()` must only appear inside `_main()`.
 * Top-level require fails because modules are not registered until _main runs.
 */
function checkTopLevelRequire(source: string, _file: string): ValidationError[] {
  const mainRange = findMainFunctionRange(source);
  const errors: ValidationError[] = [];
  const lines = source.split('\n');
  // Match `require(` — bounded, non-nested quantifier
  const requirePattern = /\brequire\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    if (requirePattern.test(lines[i]) && !isInsideMain(mainRange, i + 1)) {
      errors.push({
        rule: RULES.TOP_LEVEL_REQUIRE,
        line: i + 1,
        message: '`require()` used outside `function _main()`',
        suggestion: 'Move `require(...)` inside `function _main() { ... }`',
      });
    }
  }
  return errors;
}

/**
 * TOP_LEVEL_EXPORTS: `exports.*` must only appear inside `_main()`.
 * Exports outside _main are not captured by the module system.
 */
function checkTopLevelExports(source: string, _file: string): ValidationError[] {
  const mainRange = findMainFunctionRange(source);
  const errors: ValidationError[] = [];
  const lines = source.split('\n');
  // Match `exports.something = ` — bounded pattern
  const exportsPattern = /\bexports\.[A-Za-z_$][A-Za-z0-9_$]*\s*=/;

  for (let i = 0; i < lines.length; i++) {
    if (exportsPattern.test(lines[i]) && !isInsideMain(mainRange, i + 1)) {
      errors.push({
        rule: RULES.TOP_LEVEL_EXPORTS,
        line: i + 1,
        message: '`exports.*` assignment outside `function _main()`',
        suggestion: 'Move `exports.X = ...` inside `function _main() { ... }`',
      });
    }
  }
  return errors;
}

/**
 * EVENTS_OUTSIDE_MAIN: `__events__.*` must only appear inside `_main()`.
 * Event handlers registered outside _main won't be captured by the runtime.
 */
function checkEventsOutsideMain(source: string, _file: string): ValidationError[] {
  const mainRange = findMainFunctionRange(source);
  const errors: ValidationError[] = [];
  const lines = source.split('\n');
  // Match `__events__.something` — bounded pattern
  const eventsPattern = /\b__events__\.[A-Za-z_$][A-Za-z0-9_$]*/;

  for (let i = 0; i < lines.length; i++) {
    if (eventsPattern.test(lines[i]) && !isInsideMain(mainRange, i + 1)) {
      errors.push({
        rule: RULES.EVENTS_OUTSIDE_MAIN,
        line: i + 1,
        message: '`__events__` assignment outside `function _main()`',
        suggestion: 'Move `__events__.X = ...` inside `function _main() { ... }`',
      });
    }
  }
  return errors;
}

/**
 * REQUIRE_POSITION: In a file set, require.gs must be at position 0.
 * The CommonJS runtime must load before any modules that use it.
 */
function checkRequirePosition(files: { name: string; position?: number }[]): ValidationError[] {
  const requireFile = files.find(f =>
    f.name === 'require' || f.name === 'require.gs'
  );

  if (!requireFile) return []; // No require.gs in project — not an error (might not use CommonJS)

  if (requireFile.position !== undefined && requireFile.position !== 0) {
    return [{
      rule: RULES.REQUIRE_POSITION,
      message: `require.gs is at position ${requireFile.position} but must be at position 0`,
      suggestion: 'require.gs must be listed first in the project file order',
    }];
  }

  return [];
}

// --- Main validation entry point ---

/**
 * Validate a set of .gs files against CommonJS module conventions.
 *
 * @param files - Array of file objects with name and source content
 * @param options - Validation options
 * @returns ValidationResult per file, plus a project-level result for REQUIRE_POSITION
 */
export function validateFiles(
  files: Array<{ name: string; source: string; position?: number }>,
  options: { skipRequirePositionCheck?: boolean } = {}
): ValidationResult[] {
  const results: ValidationResult[] = [];

  // Skip system files that are not user modules
  const SKIP_FILES = new Set(['require', 'require.gs', 'appsscript', 'appsscript.json']);

  for (const file of files) {
    const baseName = file.name.replace(/\.gs$/, '');
    if (SKIP_FILES.has(baseName) || SKIP_FILES.has(file.name)) continue;

    // Only validate .gs files and extension-less files (GAS convention)
    if (file.name.includes('.') && !file.name.endsWith('.gs')) continue;

    const errors: ValidationError[] = [
      ...checkMissingMain(file.source, file.name),
      ...checkMissingDefine(file.source, file.name),
      ...checkLoadNowRequired(file.source, file.name),
      ...checkTopLevelRequire(file.source, file.name),
      ...checkTopLevelExports(file.source, file.name),
      ...checkEventsOutsideMain(file.source, file.name),
    ];

    results.push({
      file: file.name,
      valid: errors.length === 0,
      errors,
    });
  }

  // Project-level: require.gs position check
  if (!options.skipRequirePositionCheck) {
    const positionErrors = checkRequirePosition(files);
    if (positionErrors.length > 0) {
      results.push({
        file: 'require.gs',
        valid: false,
        errors: positionErrors,
      });
    }
  }

  return results;
}

/**
 * Convenience: validate and return only files with errors.
 */
export function validateFilesErrors(
  files: Array<{ name: string; source: string; position?: number }>,
  options: { skipRequirePositionCheck?: boolean } = {}
): ValidationResult[] {
  return validateFiles(files, options).filter(r => !r.valid);
}
