import * as path from 'path';
import * as fs from 'fs';

// ─── Public types ────────────────────────────────────────────────────────────

export interface ExportInfo {
  name: string;
  kind: 'function' | 'class' | 'const' | 'type' | 'default';
  /** Compact signature, e.g. "(text: string): Promise<Classification>" */
  signature?: string;
  isAsync: boolean;
}

export interface ImportInfo {
  module: string;
  names: string[];
  isDefault: boolean;
  isNamespace: boolean;
}

export interface ExistingTestPattern {
  /** Path to the sample test file we found */
  filePath?: string;
  /** First few import lines from the test file */
  sampleImports?: string;
  /** Mock setup block (vi.mock / jest.mock calls) */
  sampleMock?: string;
  /** 'vi.mock' | 'jest.mock' | 'manual' | 'none' */
  mockingStyle: string;
  /** The framework the existing tests use */
  detectedFramework?: 'jest' | 'vitest' | 'pytest';
}

export interface CodeTraits {
  hasAsyncCode: boolean;
  hasFetchOrHttp: boolean;
  hasFileSystem: boolean;
  hasDatabase: boolean;
  hasStateMutation: boolean;
  hasClassInstances: boolean;
  isReactComponent: boolean;
  isPureFunction: boolean;
  hasEventEmitters: boolean;
  hasStreams: boolean;
  hasTimers: boolean;
  hasErrorHandling: boolean;
  hasModuleState: boolean;
}

export interface CodeIntelligence {
  exports: ExportInfo[];
  externalImports: ImportInfo[];
  internalImports: ImportInfo[];
  installedPackages: Set<string>;
  existingTestPattern: ExistingTestPattern;
  pathAliases: Record<string, string>;
  codeTraits: CodeTraits;
  /** The suggested mock setup block for the generated test */
  suggestedMockSetup: string;
  /** Human-readable summary of what this code does */
  codeSummary: string;
}

// ─── Main analysis function ──────────────────────────────────────────────────

export function analyzeSourceFile(
  filePath: string,
  content: string,
  workspaceRoot: string,
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>
): CodeIntelligence {
  const allDeps = { ...dependencies, ...devDependencies };
  const exports = extractExports(content, filePath);
  const { external, internal } = extractImports(content, filePath);
  const installedPackages = resolveInstalledPackages(external, workspaceRoot, allDeps);
  const existingTestPattern = findExistingTestPattern(filePath, workspaceRoot);
  const pathAliases = readTsconfigPaths(workspaceRoot);
  const codeTraits = analyzeCodeTraits(content);
  const suggestedMockSetup = buildMockSetup(external, installedPackages, existingTestPattern, content);
  const codeSummary = buildCodeSummary(exports, codeTraits, external);

  return {
    exports,
    externalImports: external,
    internalImports: internal,
    installedPackages,
    existingTestPattern,
    pathAliases,
    codeTraits,
    suggestedMockSetup,
    codeSummary,
  };
}

// ─── Export extraction ───────────────────────────────────────────────────────

function extractExports(content: string, filePath: string): ExportInfo[] {
  const results: ExportInfo[] = [];
  const isPython = filePath.endsWith('.py');

  if (isPython) {
    // Python: find top-level def, class, and module-level assignments
    const funcPattern = /^(async\s+)?def\s+(\w+)\s*\(([^)]*)\)/gm;
    let match;
    while ((match = funcPattern.exec(content))) {
      const isAsync = Boolean(match[1]);
      results.push({
        name: match[2],
        kind: 'function',
        signature: `(${match[3].trim()})`,
        isAsync,
      });
    }
    const classPattern = /^class\s+(\w+)/gm;
    while ((match = classPattern.exec(content))) {
      results.push({ name: match[1], kind: 'class', isAsync: false });
    }
    return results;
  }

  // TypeScript/JavaScript
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // export default
    if (/^\s*export\s+default\s+/.test(line)) {
      const nameMatch = line.match(/export\s+default\s+(?:function|class|abstract\s+class)\s+(\w+)/);
      const isAsync = /async\s+function/.test(line);
      results.push({
        name: nameMatch?.[1] || 'default',
        kind: 'default',
        isAsync,
      });
      continue;
    }

    // export function
    const funcMatch = line.match(/^\s*export\s+(async\s+)?function\s+(\w+)\s*(\([^)]*\))/);
    if (funcMatch) {
      const returnType = extractReturnType(lines, i);
      results.push({
        name: funcMatch[2],
        kind: 'function',
        signature: `${funcMatch[3]}${returnType ? `: ${returnType}` : ''}`,
        isAsync: Boolean(funcMatch[1]),
      });
      continue;
    }

    // export class
    const classMatch = line.match(/^\s*export\s+(?:abstract\s+)?class\s+(\w+)/);
    if (classMatch) {
      results.push({ name: classMatch[1], kind: 'class', isAsync: false });
      continue;
    }

    // export const/let/var
    const constMatch = line.match(/^\s*export\s+(?:const|let|var)\s+(\w+)/);
    if (constMatch) {
      const isAsync = /=\s*async\b/.test(line);
      const isArrowFunc = /=\s*(?:async\s*)?\(/.test(line) || /=\s*(?:async\s*)?\w+\s*=>/.test(line);
      results.push({
        name: constMatch[1],
        kind: isArrowFunc ? 'function' : 'const',
        isAsync,
      });
      continue;
    }

    // export type/interface
    const typeMatch = line.match(/^\s*export\s+(?:type|interface|enum)\s+(\w+)/);
    if (typeMatch) {
      results.push({ name: typeMatch[1], kind: 'type', isAsync: false });
      continue;
    }
  }

  // module.exports pattern (CommonJS)
  const moduleExportsMatch = content.match(/module\.exports\s*=\s*\{([^}]+)\}/);
  if (moduleExportsMatch && results.length === 0) {
    const names = moduleExportsMatch[1].split(',').map(s => s.trim().split(/[\s:]/)[0]).filter(Boolean);
    for (const name of names) {
      results.push({ name, kind: 'function', isAsync: false });
    }
  }

  return results;
}

function extractReturnType(lines: string[], lineIndex: number): string {
  // Look for ): ReturnType on the same or next few lines
  const combined = lines.slice(lineIndex, lineIndex + 5).join(' ');
  const match = combined.match(/\)\s*:\s*([^{]+?)\s*\{/);
  if (match) {
    return match[1].trim();
  }
  return '';
}

// ─── Import extraction ───────────────────────────────────────────────────────

function extractImports(content: string, filePath: string): { external: ImportInfo[]; internal: ImportInfo[] } {
  const external: ImportInfo[] = [];
  const internal: ImportInfo[] = [];
  const isPython = filePath.endsWith('.py');

  if (isPython) {
    // Python imports
    const importPattern = /^\s*(?:from\s+(\S+)\s+import\s+(.+)|import\s+(\S+))/gm;
    let match;
    while ((match = importPattern.exec(content))) {
      const module = match[1] || match[3];
      const names = match[2] ? match[2].split(',').map(s => s.trim()) : [module];
      const isInternal = module.startsWith('.');
      (isInternal ? internal : external).push({
        module,
        names,
        isDefault: false,
        isNamespace: Boolean(match[3]),
      });
    }
    return { external, internal };
  }

  // TypeScript/JavaScript
  // import { A, B } from 'module'
  // import A from 'module'
  // import * as A from 'module'
  // import 'module'
  // const A = require('module')

  const importPattern = /^\s*import\s+(?:(?:type\s+)?(?:\{([^}]+)\}|(\w+)|\*\s+as\s+(\w+))(?:\s*,\s*(?:\{([^}]+)\}|(\w+)|\*\s+as\s+(\w+)))?\s+from\s+)?['"]([^'"]+)['"]/gm;
  let match;
  while ((match = importPattern.exec(content))) {
    const namedImports = (match[1] || match[4] || '').split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    const defaultImport = match[2] || match[5] || '';
    const namespaceImport = match[3] || match[6] || '';
    const modulePath = match[7];

    const names = [...namedImports];
    if (defaultImport) { names.unshift(defaultImport); }
    if (namespaceImport) { names.unshift(namespaceImport); }

    const isInternal = modulePath.startsWith('.') || modulePath.startsWith('/');
    const info: ImportInfo = {
      module: modulePath,
      names,
      isDefault: Boolean(defaultImport),
      isNamespace: Boolean(namespaceImport),
    };

    (isInternal ? internal : external).push(info);
  }

  // require() pattern
  const requirePattern = /(?:const|let|var)\s+(?:\{([^}]+)\}|(\w+))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;
  while ((match = requirePattern.exec(content))) {
    const names = match[1] ? match[1].split(',').map(s => s.trim().split(/[\s:]/)[0]).filter(Boolean) : [match[2]];
    const modulePath = match[3];
    const isInternal = modulePath.startsWith('.') || modulePath.startsWith('/');
    (isInternal ? internal : external).push({
      module: modulePath,
      names,
      isDefault: Boolean(match[2]),
      isNamespace: false,
    });
  }

  return { external, internal };
}

// ─── Package resolution ──────────────────────────────────────────────────────

function resolveInstalledPackages(
  externalImports: ImportInfo[],
  workspaceRoot: string,
  allDeps: Record<string, string>
): Set<string> {
  const installed = new Set<string>();

  for (const imp of externalImports) {
    const pkgName = getPackageName(imp.module);
    // Check package.json deps first (fast)
    if (allDeps[pkgName]) {
      installed.add(pkgName);
      continue;
    }
    // Check node_modules as fallback
    const nmPath = findNodeModules(workspaceRoot);
    if (nmPath && fs.existsSync(path.join(nmPath, pkgName))) {
      installed.add(pkgName);
    }
  }

  return installed;
}

function getPackageName(importPath: string): string {
  if (importPath.startsWith('@')) {
    const parts = importPath.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : importPath;
  }
  return importPath.split('/')[0];
}

function findNodeModules(startDir: string): string {
  let current = startDir;
  for (let i = 0; i < 10; i++) {
    const nm = path.join(current, 'node_modules');
    if (fs.existsSync(nm)) { return nm; }
    const parent = path.dirname(current);
    if (parent === current) { break; }
    current = parent;
  }
  return '';
}

// ─── Existing test pattern detection ─────────────────────────────────────────

function findExistingTestPattern(sourceFilePath: string, workspaceRoot: string): ExistingTestPattern {
  const dir = path.dirname(sourceFilePath);
  const testDirs = [dir, path.join(dir, '__tests__'), path.join(dir, 'tests'), path.join(dir, '..', '__tests__')];
  const testPatterns = [/\.test\.\w+$/, /\.spec\.\w+$/, /_test\.\w+$/, /\.qa\.test\.\w+$/];

  let testFile = '';

  for (const testDir of testDirs) {
    if (!fs.existsSync(testDir)) { continue; }
    try {
      const files = fs.readdirSync(testDir);
      for (const f of files) {
        if (testPatterns.some(p => p.test(f)) && !f.endsWith('.qa.test.ts') && !f.endsWith('.qa.test.js')) {
          testFile = path.join(testDir, f);
          break;
        }
      }
    } catch { /* ignore */ }
    if (testFile) { break; }
  }

  // Also search workspaceRoot/src for any test file
  if (!testFile) {
    testFile = findFirstTestFileRecursive(workspaceRoot, 3);
  }

  if (!testFile) {
    return { mockingStyle: 'none' };
  }

  try {
    const testContent = fs.readFileSync(testFile, 'utf-8');
    const lines = testContent.split('\n');

    // Extract import lines (first ~20 lines or until first describe/test/it)
    const importLines: string[] = [];
    for (const line of lines.slice(0, 30)) {
      if (/^\s*(import\s|const\s.*require|from\s|vi\.|jest\.)/.test(line) || /^\s*$/.test(line)) {
        importLines.push(line);
      } else if (/^\s*(describe|test|it)\s*\(/.test(line)) {
        break;
      }
    }

    // Extract mock setup
    const mockLines: string[] = [];
    let inMock = false;
    let braceDepth = 0;
    for (const line of lines) {
      if (/^\s*(vi\.mock|jest\.mock)\s*\(/.test(line)) {
        inMock = true;
        braceDepth = 0;
      }
      if (inMock) {
        mockLines.push(line);
        braceDepth += (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
        if (braceDepth <= 0) {
          inMock = false;
          mockLines.push('');
        }
      }
    }

    // Detect mocking style
    let mockingStyle = 'none';
    if (/vi\.mock\s*\(/.test(testContent)) { mockingStyle = 'vi.mock'; }
    else if (/jest\.mock\s*\(/.test(testContent)) { mockingStyle = 'jest.mock'; }
    else if (/__mocks__/.test(testContent) || /manual\s*mock/i.test(testContent)) { mockingStyle = 'manual'; }

    // Detect framework
    let detectedFramework: 'jest' | 'vitest' | 'pytest' | undefined;
    if (/from\s+['"]vitest['"]|vi\./.test(testContent)) { detectedFramework = 'vitest'; }
    else if (/from\s+['"]@jest\/globals['"]|jest\./.test(testContent)) { detectedFramework = 'jest'; }
    else if (/import\s+pytest/.test(testContent)) { detectedFramework = 'pytest'; }

    return {
      filePath: testFile,
      sampleImports: importLines.join('\n').trim() || undefined,
      sampleMock: mockLines.join('\n').trim() || undefined,
      mockingStyle,
      detectedFramework,
    };
  } catch {
    return { mockingStyle: 'none' };
  }
}

function findFirstTestFileRecursive(dir: string, maxDepth: number): string {
  if (maxDepth <= 0) { return ''; }
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    // Check files first
    for (const entry of entries) {
      if (entry.isFile() && /\.(test|spec)\.\w+$/.test(entry.name) && !entry.name.endsWith('.qa.test.ts')) {
        return path.join(dir, entry.name);
      }
    }
    // Then recurse into directories
    for (const entry of entries) {
      if (entry.isDirectory() && !['node_modules', '.git', 'dist', 'build', 'coverage', '.next'].includes(entry.name)) {
        const found = findFirstTestFileRecursive(path.join(dir, entry.name), maxDepth - 1);
        if (found) { return found; }
      }
    }
  } catch { /* ignore */ }
  return '';
}

// ─── tsconfig path aliases ───────────────────────────────────────────────────

export function readTsconfigPaths(workspaceRoot: string): Record<string, string> {
  const aliases: Record<string, string> = {};
  const tsconfigFiles = ['tsconfig.json', 'tsconfig.app.json', 'jsconfig.json'];

  for (const name of tsconfigFiles) {
    const tsconfigPath = path.join(workspaceRoot, name);
    if (!fs.existsSync(tsconfigPath)) { continue; }

    try {
      // Strip comments and trailing commas for JSON.parse
      let raw = fs.readFileSync(tsconfigPath, 'utf-8');
      raw = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      raw = raw.replace(/,\s*([}\]])/g, '$1');
      const tsconfig = JSON.parse(raw);
      const paths = tsconfig?.compilerOptions?.paths;
      const baseUrl = tsconfig?.compilerOptions?.baseUrl || '.';

      if (paths) {
        for (const [alias, targets] of Object.entries(paths)) {
          const cleanAlias = alias.replace('/*', '');
          const target = (targets as string[])?.[0]?.replace('/*', '') || '';
          aliases[cleanAlias] = path.resolve(workspaceRoot, baseUrl, target);
        }
      }
    } catch { /* ignore parse errors */ }
  }

  return aliases;
}

// ─── Code trait analysis ─────────────────────────────────────────────────────

function analyzeCodeTraits(content: string): CodeTraits {
  return {
    hasAsyncCode: /\basync\b|\bPromise\b|\.then\s*\(|\bawait\b/.test(content),
    hasFetchOrHttp: /\bfetch\s*\(|\baxios\b|\bhttp\b|\bhttps\b|\bRequest\b|\bResponse\b|\bXMLHttpRequest\b|\bgot\b|\bky\b|\bsuperagent\b/.test(content),
    hasFileSystem: /\bfs\b|\breadFileSync\b|\bwriteFileSync\b|\breadFile\b|\bwriteFile\b|\bpath\.join\b|\b__dirname\b/.test(content),
    hasDatabase: /\bprisma\b|\bmongoose\b|\bsequelize\b|\bknex\b|\btypeorm\b|\bdrizzle\b|\bsql\b|\bquery\b|\bfindMany\b|\bfindOne\b|\bcreate\b|\bupdate\b|\bdelete\b/i.test(content) &&
                 /\bprisma\b|\bmongoose\b|\bsequelize\b|\bknex\b|\btypeorm\b|\bdrizzle\b/i.test(content),
    hasStateMutation: /\bsetState\b|\buseState\b|\bthis\.\w+\s*=\b|\bstore\b|\bdispatch\b|\breducer\b/i.test(content),
    hasClassInstances: /\bclass\s+\w+\b/.test(content) && /\bnew\s+\w+/.test(content),
    isReactComponent: /\bReact\b|\bjsx\b|\btsx\b|\buseState\b|\buseEffect\b|\buseRef\b|<\w+[\s/>]/i.test(content) &&
                      (/\bexport\s+(?:default\s+)?(?:function|const)\b/.test(content) || /\bReact\.FC\b/.test(content)),
    isPureFunction: !(/\basync\b/.test(content)) && !(/\bthis\b/.test(content)) && !(/\bfetch\b|\bfs\b/.test(content)),
    hasEventEmitters: /\bEventEmitter\b|\b\.on\s*\(|\b\.emit\s*\(|\b\.addEventListener\b/.test(content),
    hasStreams: /\bReadable\b|\bWritable\b|\bTransform\b|\bStream\b|\bpipe\s*\(/.test(content),
    hasTimers: /\bsetTimeout\b|\bsetInterval\b|\bclearTimeout\b|\bclearInterval\b/.test(content),
    hasErrorHandling: /\btry\s*\{|\bcatch\s*\(|\bthrow\s+new\b|\b\.catch\s*\(/.test(content),
    hasModuleState: /^(?:let|var)\s+\w+/m.test(content),
  };
}

// ─── Mock setup generation ───────────────────────────────────────────────────

function buildMockSetup(
  externalImports: ImportInfo[],
  installedPackages: Set<string>,
  existingPattern: ExistingTestPattern,
  content: string
): string {
  if (externalImports.length === 0) {
    return '// No external dependencies to mock';
  }

  const isVitest = existingPattern.mockingStyle === 'vi.mock' || existingPattern.detectedFramework === 'vitest';
  const mockFn = isVitest ? 'vi.mock' : 'jest.mock';
  const fnFactory = isVitest ? 'vi.fn()' : 'jest.fn()';

  const mockBlocks: string[] = [];

  for (const imp of externalImports) {
    const pkgName = getPackageName(imp.module);

    // Skip test framework imports
    if (['vitest', '@jest/globals', 'jest', 'pytest'].includes(pkgName)) { continue; }

    // Build mock factory based on how the import is used in source
    const mockEntries: string[] = [];
    for (const name of imp.names) {
      // Check if it's used as a function call in the source
      const isCalled = new RegExp(`\\b${name}\\s*\\(`).test(content);
      if (isCalled) {
        mockEntries.push(`  ${name}: ${fnFactory},`);
      } else {
        mockEntries.push(`  ${name}: ${fnFactory},`);
      }
    }

    if (imp.isDefault || imp.isNamespace) {
      mockBlocks.push(`${mockFn}('${imp.module}', () => ({\n  default: ${fnFactory},\n${mockEntries.join('\n')}\n}));`);
    } else if (mockEntries.length > 0) {
      mockBlocks.push(`${mockFn}('${imp.module}', () => ({\n${mockEntries.join('\n')}\n}));`);
    } else {
      mockBlocks.push(`${mockFn}('${imp.module}');`);
    }
  }

  return mockBlocks.join('\n\n');
}

// ─── Code summary ────────────────────────────────────────────────────────────

function buildCodeSummary(exports: ExportInfo[], traits: CodeTraits, externalImports: ImportInfo[]): string {
  const parts: string[] = [];

  // What it exports
  const funcs = exports.filter(e => e.kind === 'function');
  const classes = exports.filter(e => e.kind === 'class');
  const consts = exports.filter(e => e.kind === 'const');

  if (funcs.length > 0) {
    parts.push(`Exports ${funcs.length} function(s): ${funcs.map(f => f.name).join(', ')}`);
  }
  if (classes.length > 0) {
    parts.push(`Exports ${classes.length} class(es): ${classes.map(c => c.name).join(', ')}`);
  }
  if (consts.length > 0) {
    parts.push(`Exports ${consts.length} constant(s): ${consts.map(c => c.name).join(', ')}`);
  }

  // What kind of code it is
  const traitLabels: string[] = [];
  if (traits.hasAsyncCode) { traitLabels.push('async'); }
  if (traits.hasFetchOrHttp) { traitLabels.push('HTTP/fetch'); }
  if (traits.hasFileSystem) { traitLabels.push('file system'); }
  if (traits.hasDatabase) { traitLabels.push('database'); }
  if (traits.isReactComponent) { traitLabels.push('React component'); }
  if (traits.hasClassInstances) { traitLabels.push('OOP/classes'); }
  if (traits.hasEventEmitters) { traitLabels.push('event-driven'); }
  if (traits.isPureFunction) { traitLabels.push('pure functions'); }
  if (traits.hasErrorHandling) { traitLabels.push('error handling'); }

  if (traitLabels.length > 0) {
    parts.push(`Code traits: ${traitLabels.join(', ')}`);
  }

  // External deps
  if (externalImports.length > 0) {
    const depNames = externalImports.map(i => getPackageName(i.module));
    parts.push(`Depends on: ${[...new Set(depNames)].join(', ')}`);
  }

  return parts.join('. ') + '.';
}
