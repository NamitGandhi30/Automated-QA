import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import { exec } from 'child_process';
import { promisify } from 'util';
import { SecretManager } from './secretManager';
import { WorkspaceIndexer } from './workspaceIndexer';
import { DockerManager } from './dockerManager';
import { selectBestCopilotModel } from './copilotModelSelector';
import { analyzeSourceFile, CodeIntelligence } from './codeIntelligence';

const execAsync = promisify(exec);

export interface GeneratedTests {
  filePath: string;
  sourceFilePath: string;
  framework: string;
  workspaceRoot: string;
  testConfigPath: string;
  normal: string;
  edgeCase: string;
  stress: string;
  fullContent: string;
}

export interface TestRunResult {
  status: 'passed' | 'failed' | 'skipped' | 'error' | 'running';
  command: string;
  cwd: string;
  exitCode: number | null;
  output: string;
  framework: string;
  testFilePath: string;
  failureReason?: string;
}

export class TestArchitect implements vscode.Disposable {
  private secretManager: SecretManager;
  private workspaceIndexer: WorkspaceIndexer;
  private dockerManager: DockerManager;
  private outputChannel: vscode.OutputChannel;
  private _lastGenerated: GeneratedTests | null = null;
  private _onTestsGenerated = new vscode.EventEmitter<GeneratedTests>();
  readonly onTestsGenerated = this._onTestsGenerated.event;
  private generatedTestFiles = new Set<string>();

  constructor(
    secretManager: SecretManager,
    workspaceIndexer: WorkspaceIndexer,
    dockerManager: DockerManager,
    outputChannel: vscode.OutputChannel
  ) {
    this.secretManager = secretManager;
    this.workspaceIndexer = workspaceIndexer;
    this.dockerManager = dockerManager;
    this.outputChannel = outputChannel;
  }

  dispose() {
    this.outputChannel.appendLine('TestArchitect: Cleaning up generated test files...');
    for (const filePath of this.generatedTestFiles) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          this.outputChannel.appendLine(`Deleted generated test file: ${filePath}`);
        }
      } catch (err: any) {
        this.outputChannel.appendLine(`Failed to delete generated test file "${filePath}": ${err.message || err}`);
      }
    }
    this.generatedTestFiles.clear();
  }

  get lastGenerated(): GeneratedTests | null {
    return this._lastGenerated;
  }

  async generateForSelection(): Promise<GeneratedTests | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active editor.');
      return null;
    }
    const sourceFilePath = editor.document.uri.fsPath;
    if (this.isGeneratedTestFile(sourceFilePath)) {
      vscode.window.showWarningMessage('Open a source file before generating tests. This file already looks like a generated QA test.');
      return null;
    }

    const selection = editor.selection;
    let selectedCode: string;

    if (selection.isEmpty) {
      // Use entire file if no selection
      selectedCode = editor.document.getText();
    } else {
      selectedCode = editor.document.getText(selection);
    }

    if (!selectedCode.trim()) {
      vscode.window.showWarningMessage('No code selected for test generation.');
      return null;
    }

    const ctx = await this.workspaceIndexer.getContext();

    // Perform static analysis on the source file for codebase intelligence
    const fullFileContent = editor.document.getText();
    const codeIntel = analyzeSourceFile(
      sourceFilePath,
      fullFileContent,
      ctx.workspaceRoot,
      ctx.dependencies,
      ctx.devDependencies
    );

    let provider: string;
    let apiKey: string | undefined;
    try {
      const result = await this.secretManager.getActiveKeyIfNeeded();
      provider = result.provider;
      apiKey = result.apiKey;
    } catch (err: any) {
      this.outputChannel.appendLine(`Provider error: ${err.message}`);
      vscode.window.showErrorMessage(`Automated QA — Provider Error: ${err.message}`);
      return null;
    }

    this.outputChannel.appendLine(`Generating tests for selection using ${provider}...`);

    const prompt = this.buildTestPrompt(selectedCode, ctx, codeIntel);
    let response: string;

    if (provider === 'copilot') {
      response = await this.generateViaCopilot(prompt);
    } else if (provider === 'ollama') {
      const ollamaCfg = await this.secretManager.getOllamaConfigWithKey();
      response = await this.generateViaOllama(prompt, ollamaCfg);
    } else {
      response = await this.generateViaSidecar(prompt, provider, apiKey!);
    }

    if (!response) { return null; }

    const tests = this.parseTestOutput(response, sourceFilePath, ctx);
    if (tests) {
      // Validate and auto-correct generated test content
      const validatedContent = this.validateGeneratedTests(tests.fullContent, sourceFilePath, ctx, codeIntel);
      tests.fullContent = validatedContent;

      // Re-parse to split validated content into tiers correctly
      const splitTiers = this.parseTestOutput(validatedContent, sourceFilePath, ctx);
      if (splitTiers) {
        tests.normal = splitTiers.normal;
        tests.edgeCase = splitTiers.edgeCase;
        tests.stress = splitTiers.stress;
      }

      this._lastGenerated = tests;

      // Write to file
      fs.writeFileSync(tests.filePath, tests.fullContent, 'utf-8');
      this.generatedTestFiles.add(tests.filePath);
      this.outputChannel.appendLine(`Tests written to ${tests.filePath}`);

      // Open the file
      const doc = await vscode.workspace.openTextDocument(tests.filePath);
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);

      this._onTestsGenerated.fire(tests);
    }

    return tests;
  }

  async runTests(testFilePath: string): Promise<TestRunResult> {
    const ctx = await this.workspaceIndexer.getContext();
    const generated = this._lastGenerated?.filePath === testFilePath ? this._lastGenerated : null;
    return this.runInWorkspace(
      testFilePath,
      generated?.framework || ctx.testFramework,
      generated?.workspaceRoot || ctx.workspaceRoot,
      generated?.testConfigPath || ctx.testConfigPath
    );
  }

  private buildTestPrompt(code: string, ctx: any, codeIntel: CodeIntelligence): string {
    const frameworkImports: Record<string, string> = {
      jest: `import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';`,
      vitest: `import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';`,
      pytest: `import pytest`,
    };

    // Compute the exact relative import path the test file should use
    const sourceFilePath = ctx.activeFilePath || '';
    const sourceDir = path.dirname(sourceFilePath);
    const sourceExt = path.extname(sourceFilePath);
    const sourceBaseName = path.basename(sourceFilePath, sourceExt);
    const relativeImportPath = `./${sourceBaseName}`;

    // Format path aliases
    const aliasesStr = Object.keys(codeIntel.pathAliases).length > 0
      ? `Path aliases configured:\n${JSON.stringify(codeIntel.pathAliases, null, 2)}`
      : 'No path aliases configured.';

    // Format imports/exports info
    const exportsStr = codeIntel.exports.map(e => `- ${e.kind} ${e.name} ${e.signature || ''}`).join('\n');
    const externalImportsStr = codeIntel.externalImports.map(i => `- ${i.module}: ${i.names.join(', ')}`).join('\n');

    // Format traits
    const traitsList: string[] = [];
    if (codeIntel.codeTraits.hasAsyncCode) { traitsList.push('- Async operations / Promises'); }
    if (codeIntel.codeTraits.hasFetchOrHttp) { traitsList.push('- Network / HTTP calls'); }
    if (codeIntel.codeTraits.hasFileSystem) { traitsList.push('- File system operations'); }
    if (codeIntel.codeTraits.hasDatabase) { traitsList.push('- Database queries'); }
    if (codeIntel.codeTraits.hasStateMutation) { traitsList.push('- State management / mutations'); }
    if (codeIntel.codeTraits.hasClassInstances) { traitsList.push('- Class instances / OOP'); }
    if (codeIntel.codeTraits.isReactComponent) { traitsList.push('- React components / hooks'); }
    if (codeIntel.codeTraits.hasEventEmitters) { traitsList.push('- Event emitters / event handlers'); }
    if (codeIntel.codeTraits.hasStreams) { traitsList.push('- Streams'); }
    if (codeIntel.codeTraits.hasTimers) { traitsList.push('- Timers (setTimeout, setInterval)'); }
    if (codeIntel.codeTraits.hasErrorHandling) { traitsList.push('- Error handling / try-catch blocks'); }

    const traitsStr = traitsList.length > 0 ? traitsList.join('\n') : '- Pure / synchronous functions';

    // Build trait-driven edge cases — only include relevant ones
    const edgeCases: string[] = [];
    // Always include these universal edge cases
    edgeCases.push('- Null/undefined input parameters: pass null, undefined to every exported function');
    edgeCases.push('- Empty string / zero / empty array inputs');

    if (codeIntel.codeTraits.hasAsyncCode) {
      edgeCases.push('- Async error handling: ensure rejected promises propagate correctly');
      edgeCases.push('- Concurrent execution: call the same async function with Promise.all to detect race conditions');
    }
    if (codeIntel.codeTraits.hasFetchOrHttp) {
      edgeCases.push('- Network failure: mock fetch/HTTP to reject with Error("Network Error")');
      edgeCases.push('- HTTP error status codes: mock responses with 400, 401, 403, 404, 500, 503');
      edgeCases.push('- Invalid JSON response: mock response.json() to throw');
      edgeCases.push('- Empty response body (204 No Content)');
      edgeCases.push('- Malformed response shape (missing fields, wrong types)');
    }
    if (codeIntel.codeTraits.hasFileSystem) {
      edgeCases.push('- File not found: mock fs to throw ENOENT');
      edgeCases.push('- Permission denied: mock fs to throw EACCES');
      edgeCases.push('- Empty file content');
    }
    if (codeIntel.codeTraits.hasDatabase) {
      edgeCases.push('- Database connection failure');
      edgeCases.push('- Empty query result (no rows/documents)');
      edgeCases.push('- Duplicate key / constraint violation');
    }
    if (codeIntel.codeTraits.hasClassInstances) {
      edgeCases.push('- Verify class instance state after method calls');
      edgeCases.push('- Test constructor with missing/invalid arguments');
    }
    if (codeIntel.codeTraits.isReactComponent) {
      edgeCases.push('- Render with missing/null props');
      edgeCases.push('- Simulate user interactions (click, input change)');
    }
    if (codeIntel.codeTraits.hasErrorHandling) {
      edgeCases.push('- Verify error messages and error types thrown');
      edgeCases.push('- Verify catch blocks handle errors gracefully');
    }
    if (codeIntel.codeTraits.hasEventEmitters) {
      edgeCases.push('- Event not emitted / emitted multiple times');
    }
    if (codeIntel.codeTraits.hasTimers) {
      edgeCases.push('- Use fake timers to test setTimeout/setInterval behavior');
    }

    const edgeCaseStr = edgeCases.map((ec, i) => `${i + 1}. ${ec.replace(/^- /, '')}`).join('\n');

    // Format nearby test files as examples
    let referenceTests = '';
    if (ctx.nearbyTestFiles && ctx.nearbyTestFiles.length > 0) {
      referenceTests = `
### Existing Test Reference Examples
Follow the import conventions, mocking style, and structure of these existing tests in the project:
` + ctx.nearbyTestFiles.map((f: any, idx: number) => `
--- Example ${idx + 1}: ${path.basename(f.path)} ---
${f.content}
`).join('\n');
    }

    // Build the mock instruction block
    let mockInstruction = codeIntel.externalImports.length > 0
      ? `
**MOCK SETUP (REQUIRED):**
You MUST mock ALL external dependencies listed above. Use the suggested mock setup from section 4.
Do NOT import external packages without mocking them first — the test runner may not have them installed.
${codeIntel.suggestedMockSetup || ''}
`
      : `
**MOCK SETUP:**
No external dependencies to mock. Do NOT add unnecessary mock declarations.
`;

    if (codeIntel.codeTraits.hasModuleState) {
      mockInstruction += `
**SINGLETON/MODULE STATE DETECTED (CRITICAL):**
The code under test contains module-level state variables (like caches, singleton instances, or initialization flags) that persist across function calls.
To prevent test pollution and mock leakage:
1. You MUST NOT import the functions/classes under test statically at the top of the test file.
2. Instead, declare variables for the functions/classes at the describe block scope (e.g., let classifyLocal: any; let classifyLocalEnhanced: any; let pipelineMock: any;).
3. In a \`beforeEach\` block, call \`jest.resetModules();\` (or \`vi.resetModules();\` if Vitest) and dynamically require the module under test (e.g., \`const module = require('${relativeImportPath}'); classifyLocal = module.classifyLocal; classifyLocalEnhanced = module.classifyLocalEnhanced;\`).
4. Also require external mocked dependencies dynamically in \`beforeEach\` after \`jest.resetModules()\` to ensure mock references are fresh (e.g., \`const transformers = require('@xenova/transformers'); pipelineMock = transformers.pipeline;\`), and use those mock references (e.g., \`pipelineMock\`) in your tests.
`;
    }

    return `You are a Test Architect. Generate a robust, comprehensive, and production-grade test suite for the following code.

**Test Framework:** ${ctx.testFramework}
**Language:** ${ctx.language}
**Module System:** ${ctx.moduleSystem}
**Workspace root:** ${ctx.workspaceRoot || '(unknown)'}
**Test config:** ${ctx.testConfigPath || '(auto-detect from workspace root)'}
**Source file:** ${ctx.activeFilePath}

### Codebase Intelligence Context
1. **Module Exports:**
${exportsStr || 'No explicit exports found.'}

2. **Dependencies Imported in Source:**
${externalImportsStr || 'No external dependencies.'}

3. **Code Traits & Behaviors:**
${traitsStr}

4. **Suggested Mocks / Setup:**
${codeIntel.suggestedMockSetup || 'No mock setup suggested.'}

5. **Path Resolution:**
${aliasesStr}
${referenceTests}
${mockInstruction}

**Code under test:**
\`\`\`
${code}
\`\`\`

Generate tests in THREE TIERS, clearly separated by comments:

### TIER 1: NORMAL (Happy Path)
Basic functional tests covering standard input/output scenarios.
Test each exported function/class with typical valid inputs and verify the output.

### TIER 2: EDGE CASE
Based on code analysis, test the following specific edge cases:
${edgeCaseStr}

### TIER 3: STRESS TEST
Wrap the functions in loops with a reasonable number of iterations (e.g. 50 to 500 for async operations, up to 500 for simple synchronous operations) to test race conditions and performance.
Measure execution time using \`performance.now()\` or equivalent.
Assert that execution completes within a reasonable time (e.g. < 5 seconds).

Use this import: ${frameworkImports[ctx.testFramework] || frameworkImports.jest}

**IMPORT PATH**: The test file is placed next to the source file. Import the code under test using EXACTLY this relative path:
\`import { ... } from '${relativeImportPath}';\`
Do NOT guess the import path. Use the exact path shown above.

For pytest, use Python comments beginning with # for the tier headers. For Jest and Vitest, use // comments.
Do not mix test-runner APIs. If using Jest, use jest.fn(), jest.clearAllMocks(), and imports from @jest/globals. If using Vitest, use vi.fn(), vi.clearAllMocks(), and imports from vitest.

CRITICAL RULES (violating any of these makes the test suite invalid):
1. Every it() or test() call MUST include a per-test timeout as the last argument: it('name', async () => { ... }, 10000)
2. NEVER use \`new Promise(() => {})\` or any promise that never resolves or rejects
3. NEVER use setTimeout, setInterval, or delays without fake timers (vi.useFakeTimers / jest.useFakeTimers)
4. All async operations MUST resolve or reject within the test timeout — no hanging promises
5. If mocking a function that returns a promise, always make it resolve or reject, never leave it pending
6. Only mock modules that the source code actually imports. Do NOT mock modules the code does not use.
7. Only test exported functions/classes. Do NOT test internal implementation details.
8. When testing edge cases (like null, undefined, or unexpected types like passing numbers where strings are expected), inspect the source code. If the code does not check/cast the input and will throw (e.g. calling .substring() on a number or undefined), you MUST assert that it rejects/throws (e.g. expect(...).rejects.toThrow()). Do NOT assert that it returns a valid result if it will crash.

Return ONLY the test file content, ready to be written to disk. No markdown wrapping.
Start the file with the appropriate import statements.`;
  }

  private validateGeneratedTests(
    content: string,
    sourceFilePath: string,
    ctx: any,
    codeIntel: CodeIntelligence
  ): string {
    const ext = path.extname(sourceFilePath);
    const baseName = path.basename(sourceFilePath, ext);
    const expectedImport = `./${baseName}`;
    const framework = ctx.testFramework === 'unknown'
      ? this.inferFrameworkFromContent(content, sourceFilePath)
      : ctx.testFramework;

    let validated = content;

    // 1. Correct relative imports of the source file
    const importRegex = new RegExp(`(from\\s+['"])(?:[^'"]*\\/)?${baseName}(?:\\.[a-zA-Z0-9]+)?(['"])`, 'g');
    validated = validated.replace(importRegex, `$1${expectedImport}$2`);

    const requireRegex = new RegExp(`(require\\(\\s*['"])(?:[^'"]*\\/)?${baseName}(?:\\.[a-zA-Z0-9]+)?(['"]\\s*\\))`, 'g');
    validated = validated.replace(requireRegex, `$1${expectedImport}$2`);

    // 2. Correct mock targets of the source file
    const mockRegex = new RegExp(`(jest\\.mock|vi\\.mock)\\(\\s*['"](?:[^'"]*\\/)?${baseName}(?:\\.[a-zA-Z0-9]+)?['"]`, 'g');
    validated = validated.replace(mockRegex, `$1('${expectedImport}'`);

    // 3. Normalize framework mismatches
    if (framework === 'vitest') {
      validated = validated.replace(/['"]@jest\/globals['"]/g, "'vitest'");
      validated = validated.replace(/\bjest\.(fn|mock|spyOn|clearAllMocks|resetAllMocks|restoreAllMocks|useFakeTimers|useRealTimers|advanceTimersByTime|requireActual|resetModules)\b/g, 'vi.$1');
      
      const vitestImportMatch = validated.match(/import\s*\{([^}]+)\}\s*from\s*['"]vitest['"]/);
      if (vitestImportMatch) {
        const imports = vitestImportMatch[1].split(',').map(s => s.trim());
        if (!imports.includes('vi')) {
          imports.push('vi');
          const newImport = `import { ${imports.join(', ')} } from 'vitest'`;
          validated = validated.replace(vitestImportMatch[0], newImport);
        }
      } else if (!/from\s*['"]vitest['"]/.test(validated) && !/require\(\s*['"]vitest['"]\s*\)/.test(validated)) {
        validated = `import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';\n` + validated;
      }
    } else if (framework === 'jest') {
      validated = validated.replace(/['"]vitest['"]/g, "'@jest/globals'");
      validated = validated.replace(/\bvi\.(fn|mock|spyOn|clearAllMocks|resetAllMocks|restoreAllMocks|useFakeTimers|useRealTimers|advanceTimersByTime|importActual|resetModules)\b/g, 'jest.$1');
      validated = validated.replace(/\bjest\.importActual\b/g, 'jest.requireActual');

      const jestImportMatch = validated.match(/import\s*\{([^}]+)\}\s*from\s*['"]@jest\/globals['"]/);
      if (jestImportMatch) {
        const imports = jestImportMatch[1].split(',').map(s => s.trim());
        if (!imports.includes('jest')) {
          imports.push('jest');
          const newImport = `import { ${imports.join(', ')} } from '@jest/globals'`;
          validated = validated.replace(jestImportMatch[0], newImport);
        }
      } else if (!/from\s*['"]@jest\/globals['"]/.test(validated) && !/require\(\s*['"]@jest\/globals['"]\s*\)/.test(validated)) {
        validated = `import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';\n` + validated;
      }
    }

    // 4. Remove hanging promise patterns
    validated = validated.replace(/new\s+Promise\s*\(\s*\(\s*\)\s*=>\s*\{[^}]*\}\s*\)/g,
      'new Promise((resolve) => { resolve(undefined); })');
    validated = validated.replace(/new\s+Promise\s*\(\s*function\s*\(\s*\)\s*\{[^}]*\}\s*\)/g,
      'new Promise(function(resolve) { resolve(undefined); })');

    // 5. Ensure all external deps are mocked
    if (codeIntel.externalImports && codeIntel.externalImports.length > 0) {
      const mockFn = framework === 'vitest' ? 'vi.mock' : 'jest.mock';
      for (const imp of codeIntel.externalImports) {
        // Skip test framework imports
        const pkgName = imp.module.startsWith('@') 
          ? imp.module.split('/').slice(0, 2).join('/') 
          : imp.module.split('/')[0];
        if (['vitest', '@jest/globals', 'jest', 'react', 'react-dom'].includes(pkgName)) { continue; }

        const mockPattern = new RegExp(`(?:jest|vi)\\.mock\\s*\\(\\s*['"]${imp.module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);
        if (!mockPattern.test(validated)) {
          // Inject mock after the last import statement
          const lastImportIdx = Math.max(
            validated.lastIndexOf('\nimport '),
            validated.lastIndexOf('\nconst '),
            validated.lastIndexOf("\nfrom '")
          );
          const insertPos = lastImportIdx > 0 ? validated.indexOf('\n', lastImportIdx + 1) : 0;
          const mockLine = `\n${mockFn}('${imp.module}');\n`;
          if (insertPos > 0) {
            validated = validated.slice(0, insertPos) + mockLine + validated.slice(insertPos);
          } else {
            validated = mockLine + validated;
          }
        }
      }
    }

    // 5.5 If the module has module/singleton state, rewrite static imports to dynamic imports within beforeEach
    if (codeIntel.codeTraits.hasModuleState && (framework === 'jest' || framework === 'vitest')) {
      const mockedModules = new Set<string>();
      const mockDeclRegex = /(?:jest|vi)\.mock\(\s*['"]([^'"]+)['"]/g;
      let mockMatch;
      mockDeclRegex.lastIndex = 0;
      while ((mockMatch = mockDeclRegex.exec(validated)) !== null) {
        mockedModules.add(mockMatch[1]);
      }

      const targetModules = Array.from(mockedModules);
      targetModules.push(expectedImport);
      targetModules.push(baseName);

      const importRegex = /import\s+(?:(\w+)|\{\s*([\s\S]*?)\s*\}|\*\s+as\s+(\w+))\s+from\s+['"]([^'"]+)['"];?/g;
      let match;
      importRegex.lastIndex = 0;
      const bindingsByModule = new Map<string, { localName: string, propName?: string, type: 'default' | 'named' | 'namespace' }[]>();
      const matchedImportTexts: string[] = [];

      while ((match = importRegex.exec(validated)) !== null) {
        const fullImportText = match[0];
        const defaultImport = match[1];
        const namedImportsStr = match[2];
        const namespaceImport = match[3];
        const importPath = match[4];

        const isTarget = targetModules.some(tm => 
          importPath === tm || 
          importPath === tm + '.ts' || 
          importPath === tm + '.js' ||
          importPath.endsWith('/' + tm) ||
          importPath.endsWith('/' + tm + '.ts') ||
          importPath.endsWith('/' + tm + '.js')
        );

        if (isTarget) {
          matchedImportTexts.push(fullImportText);
          const bindings = bindingsByModule.get(importPath) || [];
          if (defaultImport) {
            bindings.push({ localName: defaultImport, type: 'default' });
          } else if (namespaceImport) {
            bindings.push({ localName: namespaceImport, type: 'namespace' });
          } else if (namedImportsStr) {
            const parts = namedImportsStr.split(',');
            for (const part of parts) {
              const trimmed = part.trim();
              if (!trimmed) continue;
              if (trimmed.includes(' as ')) {
                const [propName, localName] = trimmed.split(/\s+as\s+/);
                bindings.push({ localName: localName.trim(), propName: propName.trim(), type: 'named' });
              } else {
                bindings.push({ localName: trimmed, propName: trimmed, type: 'named' });
              }
            }
          }
          bindingsByModule.set(importPath, bindings);
        }
      }

      if (bindingsByModule.size > 0) {
        // Remove the static imports
        for (const importText of matchedImportTexts) {
          validated = validated.replace(importText, '');
        }

        // Collect all local names to declare
        const allLocalNames: string[] = [];
        for (const [_, bindings] of bindingsByModule) {
          for (const binding of bindings) {
            allLocalNames.push(binding.localName);
          }
        }

        // Declare let variables right inside the main describe block
        const declarations = '\n' + allLocalNames.map(name => `  let ${name}: any;`).join('\n') + '\n';
        const describeRegex = /describe\s*\(\s*['"][^'"]+['"]\s*,\s*\(\s*\)\s*=>\s*\{/;
        const describeMatch = validated.match(describeRegex);
        if (describeMatch) {
          const insertIdx = describeMatch.index! + describeMatch[0].length;
          validated = validated.slice(0, insertIdx) + declarations + validated.slice(insertIdx);
        }

        // Create the require logic code block
        let requireCode = `\n    // Dynamic module loading to prevent singleton pollution\n    ${framework === 'vitest' ? 'vi' : 'jest'}.resetModules();\n`;
        for (const [importPath, bindings] of bindingsByModule) {
          const tempVarName = `_${importPath.replace(/[^a-zA-Z0-9]/g, '_')}`;
          requireCode += `    const ${tempVarName} = require('${importPath}');\n`;
          for (const binding of bindings) {
            if (binding.type === 'named') {
              requireCode += `    ${binding.localName} = ${tempVarName}.${binding.propName};\n`;
            } else {
              requireCode += `    ${binding.localName} = ${tempVarName};\n`;
            }
          }
        }

        // Find or create beforeEach
        const beforeEachRegex = /beforeEach\s*\(\s*(?:async\s*)?\(\s*\)\s*=>\s*\{/;
        const beforeEachMatch = validated.match(beforeEachRegex);
        if (beforeEachMatch) {
          const insertIdx = beforeEachMatch.index! + beforeEachMatch[0].length;
          validated = validated.slice(0, insertIdx) + requireCode + validated.slice(insertIdx);
        } else {
          const newBeforeEach = `\n  beforeEach(() => {${requireCode}  });\n`;
          const newDescribeMatch = validated.match(describeRegex);
          if (newDescribeMatch) {
            const insertIdx = newDescribeMatch.index! + newDescribeMatch[0].length + declarations.length;
            validated = validated.slice(0, insertIdx) + newBeforeEach + validated.slice(insertIdx);
          }
        }
      }
    }

    // 6. Inject timeouts to all test/it calls
    validated = this.injectTimeouts(validated);

    return validated;
  }

  private injectTimeouts(content: string): string {
    let result = '';
    let i = 0;
    while (i < content.length) {
      if ((content.startsWith('it(', i) || content.startsWith('test(', i)) && (i === 0 || !/[a-zA-Z0-9_$]/.test(content[i - 1]))) {
        const isIt = content.startsWith('it(', i);
        const startIdx = i;
        i += isIt ? 3 : 5;
        
        let parenDepth = 1;
        let braceDepth = 0;
        let inString: string | null = null;
        let argCommas: number[] = [];
        let j = i;
        
        while (j < content.length && parenDepth > 0) {
          const char = content[j];
          
          if (inString) {
            if (char === '\\') {
              j += 2;
              continue;
            }
            if (char === inString) {
              inString = null;
            }
          } else {
            if (char === '"' || char === "'" || char === '`') {
              inString = char;
            } else if (char === '(') {
              parenDepth++;
            } else if (char === ')') {
              parenDepth--;
              if (parenDepth === 0) {
                break;
              }
            } else if (char === '{') {
              braceDepth++;
            } else if (char === '}') {
              braceDepth--;
            } else if (char === ',' && parenDepth === 1 && braceDepth === 0) {
              argCommas.push(j);
            }
          }
          j++;
        }
        
        if (parenDepth === 0 && j < content.length) {
          if (argCommas.length === 1) {
            const beforeParen = content.slice(startIdx, j).trim();
            if (beforeParen.endsWith('}')) {
              result += content.slice(startIdx, j) + ', 10000)';
              i = j + 1;
              continue;
            }
          }
        }
        
        result += content[startIdx];
        i = startIdx + 1;
      } else {
        result += content[i];
        i++;
      }
    }
    return result;
  }

  private async generateViaOllama(
    prompt: string,
    cfg: { baseUrl: string; model: string }
  ): Promise<string> {
    return new Promise((resolve) => {
      const body = JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      });

      const urlStr = cfg.baseUrl.replace(/\/$/, '') + '/api/chat';
      let urlObj: URL;
      try {
        urlObj = new URL(urlStr);
      } catch {
        this.outputChannel.appendLine(`Invalid Ollama base URL: ${cfg.baseUrl}`);
        vscode.window.showErrorMessage(
          `Automated QA — Ollama Error: Invalid base URL "${cfg.baseUrl}".`
        );
        resolve('');
        return;
      }

      const useHttps = urlObj.protocol === 'https:';
      const lib = useHttps ? https : http;

      const req = lib.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port || (useHttps ? 443 : 80),
          path: urlObj.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 180000,
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 400) {
              const detail = data.slice(0, 200);
              this.outputChannel.appendLine(`Ollama HTTP ${res.statusCode}: ${detail}`);
              vscode.window.showErrorMessage(
                `Automated QA — Ollama HTTP ${res.statusCode}: ${detail}`
              );
              resolve('');
              return;
            }
            try {
              const parsed = JSON.parse(data);
              resolve(parsed?.message?.content || parsed?.response || '');
            } catch {
              this.outputChannel.appendLine('Failed to parse Ollama response');
              resolve('');
            }
          });
        }
      );
      req.on('error', (e) => {
        this.outputChannel.appendLine(`Ollama connection error: ${e.message}`);
        vscode.window.showErrorMessage(
          `Automated QA — Cannot reach Ollama at ${cfg.baseUrl}. Is the server running?`
        );
        resolve('');
      });
      req.on('timeout', () => {
        req.destroy();
        vscode.window.showErrorMessage(
          `Automated QA — Ollama request timed out. Model: ${cfg.model}.`
        );
        resolve('');
      });
      req.write(body);
      req.end();
    });
  }

  private async generateViaCopilot(prompt: string): Promise<string> {
    try {
      const model = await selectBestCopilotModel();

      const messages = [vscode.LanguageModelChatMessage.User(prompt)];
      const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

      let fullResponse = '';
      for await (const chunk of response.text) {
        fullResponse += chunk;
      }
      return fullResponse;
    } catch (err: any) {
      this.outputChannel.appendLine(`Copilot test generation error: ${err.message}`);
      vscode.window.showErrorMessage(`Test generation failed: ${err.message}`);
      return '';
    }
  }

  private async generateViaSidecar(prompt: string, provider: string, apiKey: string): Promise<string> {
    try {
      const result = await this.dockerManager.postToSidecar<{ response: string }>('/ai-complete', {
        prompt,
        provider,
        apiKey,
      });
      return result.response;
    } catch (err: any) {
      this.outputChannel.appendLine(`Sidecar test generation error: ${err.message}`);
      return '';
    }
  }

  private parseTestOutput(raw: string, sourceFilePath: string, ctx: any): GeneratedTests | null {
    // Strip markdown code fences if present
    let content = raw.replace(/^```[\w]*\n?/gm, '').replace(/```$/gm, '').trim();

    const framework = ctx.testFramework === 'unknown'
      ? this.inferFrameworkFromContent(content, sourceFilePath)
      : ctx.testFramework;
    const ext = framework === 'pytest' ? '.py' : '.ts';
    const baseName = this.getSourceBaseName(sourceFilePath);
    const dir = path.dirname(sourceFilePath);
    const testFileName = `${baseName}.qa.test${ext}`;
    const testFilePath = path.join(dir, testFileName);

    // Try to split into tiers
    const normalMatch = content.match(/[\/#]+\s*(?:TIER\s*1|NORMAL|Happy\s*Path)[\s\S]*?(?=[\/#]+\s*(?:TIER\s*2|EDGE)|$)/i);
    const edgeMatch = content.match(/[\/#]+\s*(?:TIER\s*2|EDGE\s*CASE)[\s\S]*?(?=[\/#]+\s*(?:TIER\s*3|STRESS)|$)/i);
    const stressMatch = content.match(/[\/#]+\s*(?:TIER\s*3|STRESS)[\s\S]*/i);

    return {
      filePath: testFilePath,
      sourceFilePath,
      framework,
      workspaceRoot: ctx.workspaceRoot || path.dirname(sourceFilePath),
      testConfigPath: ctx.testConfigPath || '',
      normal: normalMatch?.[0] || 'No normal tests generated',
      edgeCase: edgeMatch?.[0] || 'No edge-case tests generated',
      stress: stressMatch?.[0] || 'No stress tests generated',
      fullContent: content,
    };
  }

  private async runInWorkspace(
    testFilePath: string,
    framework: string,
    workspaceRoot: string,
    testConfigPath: string,
    retryCount = 0
  ): Promise<TestRunResult> {
    const testContent = this.readFileIfExists(testFilePath);
    const resolvedFramework = framework === 'unknown'
      ? this.inferFrameworkFromContent(testContent, testFilePath)
      : framework;
    const cwd = this.resolveRunRoot(testFilePath, resolvedFramework, workspaceRoot);

    let tempConfigPath = '';
    let runConfigPath = testConfigPath;

    if (resolvedFramework === 'jest' && !testConfigPath) {
      const existingConfig = this.findExistingJestConfig(cwd);
      if (!existingConfig && (testFilePath.endsWith('.ts') || testFilePath.endsWith('.tsx'))) {
        tempConfigPath = path.join(cwd, '.jest.config.qa.json');
        const inlineConfigObj = {
          preset: 'ts-jest',
          transform: { '^.+\\.tsx?$': ['ts-jest', { isolatedModules: true }] },
        };
        try {
          fs.writeFileSync(tempConfigPath, JSON.stringify(inlineConfigObj, null, 2), 'utf-8');
          runConfigPath = '.jest.config.qa.json';
        } catch (err: any) {
          this.outputChannel.appendLine(`Failed to write temp Jest config: ${err.message}`);
          tempConfigPath = '';
        }
      }
    }

    try {
      const commandInfo = this.buildRunCommand(testFilePath, resolvedFramework, cwd, runConfigPath);

      if (!commandInfo.command) {
        const result: TestRunResult = {
          status: 'skipped',
          command: '',
          cwd,
          exitCode: null,
          output: '',
          framework: resolvedFramework,
          testFilePath,
          failureReason: commandInfo.failureReason || 'No supported test framework was detected.',
        };
        this.outputChannel.appendLine(`Test run skipped: ${result.failureReason}`);
        return result;
      }

      const boundary = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
      const depsOk = await this.ensureDependencies(cwd, boundary, resolvedFramework, testFilePath);
      if (!depsOk) {
        return {
          status: 'error',
          command: commandInfo.command || '',
          cwd,
          exitCode: null,
          output: '',
          framework: resolvedFramework,
          testFilePath,
          failureReason: `Required test dependencies are missing and automatic installation failed.`,
        };
      }

      let result: TestRunResult | null = null;

      if (this.dockerManager.isStackRunning) {
        const activeFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (activeFolder) {
          try {
            const workspaceCorrect = await this.dockerManager.isSidecarWorkspaceCorrect(activeFolder);
            if (!workspaceCorrect) {
              this.outputChannel.appendLine(`Sidecar workspace mount is mismatching or outdated. Aligning sidecar with ${activeFolder}...`);
              await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Automated QA: Aligning sidecar workspace mount...`,
                cancellable: false
              }, async (progress) => {
                progress.report({ message: `Stopping sidecar container...` });
                await this.dockerManager.stopStack();
                progress.report({ message: `Starting sidecar container with correct workspace...` });
                await this.dockerManager.startStack();
                await this.dockerManager.pollUntilReady();
              });
              this.outputChannel.appendLine(`Docker stack successfully aligned with workspace: ${activeFolder}`);
            }
          } catch (err: any) {
            this.outputChannel.appendLine(`Failed to align sidecar workspace: ${err.message || err}`);
          }
        }

        this.outputChannel.appendLine(`Docker stack is running. Routing test execution to sidecar...`);
        try {
          result = await this.dockerManager.postToSidecar<TestRunResult>('/run-tests', {
            filePath: testFilePath,
            fileContent: testContent,
            framework: resolvedFramework,
            workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || workspaceRoot,
            cwd,
            testConfigPath: runConfigPath,
          });

          if (result && result.output) {
            result.output = this.stripAnsi(result.output);
          }

          this.outputChannel.appendLine(`Sidecar test run status: ${result.status}`);
          if (result.failureReason) {
            this.outputChannel.appendLine(`Sidecar failure reason: ${result.failureReason}`);
          }
          this.outputChannel.appendLine(`Sidecar test output:\n${result.output}`);
        } catch (err: any) {
          this.outputChannel.appendLine(`Sidecar test run failed: ${err.message || err}. Falling back to local execution.`);
        }
      }

      if (!result) {
        if (resolvedFramework === 'jest' || resolvedFramework === 'vitest') {
          const boundary = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
          if (!this.hasNodeModules(cwd, boundary)) {
            const result: TestRunResult = {
              status: 'error',
              command: commandInfo.command || '',
              cwd,
              exitCode: null,
              output: '',
              framework: resolvedFramework,
              testFilePath,
              failureReason: 'Project dependencies are not installed (node_modules not found). Please run "npm install" in your project directory first.',
            };
            this.outputChannel.appendLine(`Local test run skipped: ${result.failureReason}`);
            return result;
          }

          if (!this.isFrameworkDeclared(cwd, boundary, resolvedFramework)) {
            const result: TestRunResult = {
              status: 'error',
              command: commandInfo.command || '',
              cwd,
              exitCode: null,
              output: '',
              framework: resolvedFramework,
              testFilePath,
              failureReason: `Test framework "${resolvedFramework}" is not declared in your package.json dependencies. Please run "${this.getInstallCommand(resolvedFramework)}" in your project directory first.`,
            };
            this.outputChannel.appendLine(`Local test run skipped: ${result.failureReason}`);
            return result;
          }
        }

        this.outputChannel.appendLine(`Running tests locally from ${cwd}`);
        this.outputChannel.appendLine(`Command: ${commandInfo.command}`);

        try {
          const { stdout, stderr } = await execAsync(commandInfo.command, {
            cwd,
            timeout: 180000,
            maxBuffer: 1024 * 1024 * 10,
            windowsHide: true,
          });
          const output = this.stripAnsi(stdout + (stderr ? `\n${stderr}` : ''));
          result = {
            status: 'passed',
            command: commandInfo.command,
            cwd,
            exitCode: 0,
            output,
            framework: resolvedFramework,
            testFilePath,
          };
          this.outputChannel.appendLine(`Test output:\n${output}`);
        } catch (err: any) {
          const output = this.stripAnsi(`${err.stdout || ''}${err.stderr ? `\n${err.stderr}` : ''}`.trim() || err.message || '');
          const exitCode = typeof err.code === 'number' ? err.code : 1;
          result = {
            status: exitCode === 0 ? 'passed' : 'failed',
            command: commandInfo.command,
            cwd,
            exitCode,
            output,
            framework: resolvedFramework,
            testFilePath,
            failureReason: this.describeFailure(resolvedFramework, exitCode, output, runConfigPath, cwd, testFilePath),
          };
          this.outputChannel.appendLine(`Test run failed with exit code ${exitCode}: ${result.failureReason}`);
          this.outputChannel.appendLine(`Test output:\n${result.output}`);
        }
      }

      // Auto-install missing packages and retry
      if (result && (result.status === 'failed' || result.status === 'error')) {
        const missingPkg = this.extractMissingPackage(result.output, resolvedFramework);
        if (missingPkg && retryCount < 2) {
          this.outputChannel.appendLine(`Detected missing dependency: "${missingPkg}". Attempting auto-installation...`);
          const pm = this.getPackageManager(cwd, boundary);
          const installCmd = this.getInstallPackageCommand(pm, missingPkg);
          const pkgDir = this.findNearestPackageRoot(path.join(cwd, 'dummy.js'), boundary) || cwd;

          try {
            await vscode.window.withProgress({
              location: vscode.ProgressLocation.Notification,
              title: `Automated QA: Installing missing package "${missingPkg}"...`,
              cancellable: false
            }, async (progress) => {
              progress.report({ message: `Running ${installCmd} in ${pkgDir}...` });
              await execAsync(installCmd, { cwd: pkgDir });
            });
            this.outputChannel.appendLine(`Successfully installed package "${missingPkg}". Retrying test run (attempt ${retryCount + 1})...`);
            return await this.runInWorkspace(testFilePath, framework, workspaceRoot, testConfigPath, retryCount + 1);
          } catch (installErr: any) {
            const hostMsg = installErr.message || installErr;
            this.outputChannel.appendLine(`Host auto-installation of "${missingPkg}" failed: ${hostMsg}`);

            // If Docker stack is running, attempt to install inside the container as fallback
            if (this.dockerManager.isStackRunning) {
              this.outputChannel.appendLine(`Docker stack is running. Retrying installation of "${missingPkg}" inside container...`);
              try {
                await vscode.window.withProgress({
                  location: vscode.ProgressLocation.Notification,
                  title: `Automated QA: Installing "${missingPkg}" in container...`,
                  cancellable: false
                }, async (progress) => {
                  progress.report({ message: `Running installation in Docker container...` });
                  const installResult = await this.dockerManager.postToSidecar<{ success: boolean; output: string; error?: string }>('/install-package', {
                    packageManager: pm,
                    packageName: missingPkg,
                    cwd,
                    workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || workspaceRoot,
                  });
                  if (!installResult.success) {
                    throw new Error(installResult.error || installResult.output || 'Installation failed inside container.');
                  }
                });
                this.outputChannel.appendLine(`Successfully installed "${missingPkg}" inside container. Retrying test run (attempt ${retryCount + 1})...`);
                return await this.runInWorkspace(testFilePath, framework, workspaceRoot, testConfigPath, retryCount + 1);
              } catch (containerErr: any) {
                const containerMsg = containerErr.message || containerErr;
                this.outputChannel.appendLine(`Container installation of "${missingPkg}" failed: ${containerMsg}`);
                result.failureReason = `${result.failureReason || ''}\n(Auto-install of "${missingPkg}" failed: Host: ${hostMsg} / Container: ${containerMsg})`;
              }
            } else {
              result.failureReason = `${result.failureReason || ''}\n(Auto-install of "${missingPkg}" failed: ${hostMsg})`;
            }
          }
        }
      }

      return result;
    } finally {
      if (tempConfigPath && fs.existsSync(tempConfigPath)) {
        try {
          fs.unlinkSync(tempConfigPath);
          this.outputChannel.appendLine(`Deleted temp Jest config: ${tempConfigPath}`);
        } catch (err: any) {
          this.outputChannel.appendLine(`Failed to delete temp Jest config: ${err.message}`);
        }
      }
    }
  }

  private extractMissingPackage(output: string, framework: string): string | null {
    if (framework === 'pytest') {
      const match = /ModuleNotFoundError:\s*No\s*module\s*named\s*['"]([^'"]+)['"]/i.exec(output) ||
                    /ImportError:\s*No\s*module\s*named\s*['"]([^'"]+)['"]/i.exec(output);
      if (match) {
        return match[1].trim();
      }
      return null;
    }

    // JS/TS frameworks (Jest/Vitest)
    const match = /Failed\s*to\s*resolve\s*import\s*["']([^"']+)["']/i.exec(output) ||
                  /Cannot\s*find\s*module\s*['"]([^'"]+)['"]/i.exec(output) ||
                  /Cannot\s*find\s*package\s*['"]([^'"]+)['"]/i.exec(output) ||
                  /ERR_MODULE_NOT_FOUND.*package\s*['"]([^'"]+)['"]/i.exec(output);

    if (match) {
      const importPath = match[1].trim();
      // Skip relative/absolute imports or aliases
      if (importPath.startsWith('.') || importPath.startsWith('/') || importPath.startsWith('\\') || /^[A-Za-z]:/.test(importPath)) {
        return null;
      }
      if (importPath.startsWith('~/') || importPath.startsWith('@/')) {
        return null;
      }
      
      // Resolve package name (e.g. axios/lib/adapters/http -> axios)
      if (importPath.startsWith('@')) {
        const parts = importPath.split('/');
        if (parts.length >= 2) {
          if (!parts[1].trim()) { return null; }
          return `${parts[0]}/${parts[1]}`;
        }
      }
      return importPath.split('/')[0];
    }

    return null;
  }

  private getInstallPackageCommand(packageManager: 'npm' | 'yarn' | 'pnpm' | 'bun', packageName: string): string {
    switch (packageManager) {
      case 'yarn': return `yarn add ${packageName}`;
      case 'pnpm': return `pnpm add ${packageName}`;
      case 'bun': return `bun add ${packageName}`;
      default: return `npm install ${packageName}`;
    }
  }

  private buildRunCommand(
    testFilePath: string,
    framework: string,
    cwd: string,
    testConfigPath: string
  ): { command: string; failureReason?: string } {
    const relativeTestPath = this.quote(this.toPosix(path.relative(cwd, testFilePath) || testFilePath));
    const configArg = testConfigPath && !testConfigPath.includes('#')
      ? ` --config ${this.quote(this.toPosix(testConfigPath))}`
      : '';

    if (framework === 'jest') {
      let configOption = configArg;
      if (!configOption) {
        // Prefer existing project config over inline config
        const existingConfig = this.findExistingJestConfig(cwd);
        if (existingConfig) {
          configOption = ` --config ${this.quote(this.toPosix(existingConfig))}`;
        } else if (testFilePath.endsWith('.ts') || testFilePath.endsWith('.tsx')) {
          const inlineConfig = JSON.stringify({
            preset: 'ts-jest',
            transform: { '^.+\\.tsx?$': ['ts-jest', { isolatedModules: true }] },
          });
          configOption = ` --config ${this.quote(inlineConfig)}`;
        }
      }
      return { command: `npx --no-install jest --runTestsByPath ${relativeTestPath}${configOption} --verbose --passWithNoTests` };
    }
    if (framework === 'vitest') {
      return { command: `npx --no-install vitest run ${relativeTestPath}${configArg} --reporter=verbose --pool=forks --testTimeout=10000 --passWithNoTests` };
    }
    if (framework === 'pytest') {
      return { command: `python -m pytest ${relativeTestPath} -v` };
    }

    return {
      command: '',
      failureReason: 'No supported test framework was detected. Install/configure Jest, Vitest, or Pytest in the workspace first.',
    };
  }

  private describeFailure(framework: string, exitCode: number, output: string, testConfigPath: string, cwd?: string, testFilePath?: string): string {
    if (/EROFS|read-only file system/i.test(output)) {
      return 'The Docker workspace volume is mounted as read-only. Please restart the Docker stack from the VS Code extension sidebar to update the volume mounts.';
    }
    if (framework === 'jest' || framework === 'vitest') {
      const boundary = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
      if (cwd && !this.hasNodeModules(cwd, boundary)) {
        return 'Project dependencies are not installed (node_modules not found). Please run "npm install" in your project directory first.';
      }
      if (cwd) {
        const isTypeScript = testFilePath ? (testFilePath.endsWith('.ts') || testFilePath.endsWith('.tsx')) : false;
        const hasFramework = this.isFrameworkDeclared(cwd, boundary, framework) &&
          (framework !== 'jest' || !isTypeScript || this.isFrameworkDeclared(cwd, boundary, 'ts-jest'));
        if (!hasFramework) {
          return `Test framework "${framework}" is not declared in your package.json dependencies. Please run "${this.getInstallCommand(framework)}" in your project directory first.`;
        }
      }
    }
    if (/could not find a config file|Can't find a root directory|No tests found/i.test(output)) {
      return `${framework} could not find runnable tests or project config from the workspace root. Config detected: ${testConfigPath || 'none'}.`;
    }
    if (/Cannot find module|Module not found|ERR_MODULE_NOT_FOUND|ImportError|ModuleNotFoundError|Failed to resolve import/i.test(output)) {
      const lines = output.split('\n');
      const matchedLines = lines.filter(l => 
        /Cannot find module|Module not found|ERR_MODULE_NOT_FOUND|ImportError|ModuleNotFoundError|Failed to resolve import/i.test(l)
      );
      const details = matchedLines.length > 0
        ? matchedLines.map(l => l.trim()).slice(0, 3).join('\n')
        : output.slice(0, 300);
      return `The generated test could not import the code under test or a project dependency. Details:\n${details}`;
    }
    if (
      /command not found|not recognized as an internal or external command|could not determine executable/i.test(output) ||
      /npx canceled due to missing packages|npm error.*missing packages|npm ERR!.*missing packages/i.test(output)
    ) {
      return `${framework} is not available in this workspace. Run "${this.getInstallCommand(framework)}" from the shown CWD, then run again.`;
    }
    if (/timeout/i.test(output)) {
      return 'The test command timed out after 180 seconds. This usually means a generated test has a hanging promise or infinite loop. Check the test file for unresolved promises.';
    }
    // Assertion failures — tests ran but some failed. Normal test behavior, not a pipeline bug.
    if (/FAIL|\u2715|\u2717|\u00d7|failed/i.test(output)) {
      // 1. Jest format: Tests: 5 failed, 5 passed, 10 total
      const jestMatch = output.match(/Tests:\s*(?:(\d+)\s+failed,\s*)?(?:(\d+)\s+passed)?/i);
      if (jestMatch) {
        const failed = jestMatch[1] || '0';
        const passed = jestMatch[2] || '0';
        if (failed !== '0' || passed !== '0') {
          return `Tests ran: ${passed} passed, ${failed} failed. Some test assertions did not match expected values. Review the test output for details.`;
        }
      }
      // 2. Vitest format: Tests  5 failed | 5 passed (10)
      const vitestMatch = output.match(/Tests\s+(?:(\d+)\s+failed)?\s*(?:\|)?\s*(?:(\d+)\s+passed)?/i);
      if (vitestMatch) {
        const failed = vitestMatch[1] || '0';
        const passed = vitestMatch[2] || '0';
        if (failed !== '0' || passed !== '0') {
          return `Tests ran: ${passed} passed, ${failed} failed. Some test assertions did not match expected values. Review the test output for details.`;
        }
      }
      // 3. Fallback matching
      const failCount = output.match(/(\d+)\s+(?:failing|failed)/i);
      const passCount = output.match(/(\d+)\s+(?:passing|passed)/i);
      if (failCount || passCount) {
        return `Tests ran: ${passCount?.[1] || '?'} passed, ${failCount?.[1] || '?'} failed. Some test assertions did not match expected values. Review the test output for details.`;
      }
    }
    if (/SyntaxError|Unexpected token|Parse error/i.test(output)) {
      return 'The generated test file contains a syntax error. The AI produced invalid code that could not be parsed.';
    }
    if (/ReferenceError:\s*(\w+)\s+is not defined/i.test(output)) {
      const match = output.match(/ReferenceError:\s*(\w+)\s+is not defined/i);
      return `The generated test references "${match?.[1]}" which is not defined. The AI likely used an import or variable that doesn't exist in the project.`;
    }
    if (/TypeError/i.test(output)) {
      return 'The generated test has a TypeError — likely calling a function incorrectly or using a mocked value wrong. Review mock setup in the test file.';
    }
    return `The test command exited with code ${exitCode}. Review the test output above for details.`;
  }

  private getInstallCommand(framework: string): string {
    if (framework === 'vitest') {
      return 'npm install -D vitest';
    }
    if (framework === 'jest') {
      return 'npm install -D jest @jest/globals ts-jest';
    }
    if (framework === 'pytest') {
      return 'python -m pip install pytest';
    }
    return 'install a supported test runner';
  }

  private findExistingJestConfig(cwd: string): string {
    const configNames = [
      'jest.config.ts',
      'jest.config.js',
      'jest.config.mjs',
      'jest.config.cjs',
      'jest.config.json',
    ];
    // Walk up from cwd to find an existing jest config
    let current = cwd;
    const boundary = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || cwd;
    for (let i = 0; i < 10; i++) {
      for (const name of configNames) {
        const configPath = path.join(current, name);
        if (fs.existsSync(configPath)) {
          return configPath;
        }
      }
      // Also check package.json for "jest" key
      const pkgPath = path.join(current, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          if (pkg.jest) {
            return ''; // Jest config is in package.json, no --config needed
          }
        } catch { /* ignore */ }
      }
      if (path.resolve(current) === path.resolve(boundary)) { break; }
      const parent = path.dirname(current);
      if (parent === current) { break; }
      current = parent;
    }
    return '';
  }

  private isGeneratedTestFile(filePath: string): boolean {
    return /\.qa\.test(?:\.qa\.test)*\.(?:ts|tsx|js|jsx|py)$/i.test(filePath);
  }

  private getSourceBaseName(filePath: string): string {
    const ext = path.extname(filePath);
    return path.basename(filePath, ext).replace(/(?:\.qa\.test)+$/i, '');
  }

  private resolveRunRoot(testFilePath: string, framework: string, workspaceRoot: string): string {
    const fallbackRoot = workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(testFilePath);
    const packageRoot = this.findNearestPackageRoot(testFilePath, fallbackRoot);
    if (packageRoot) {
      return packageRoot;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.find(folder => {
      const relative = path.relative(folder.uri.fsPath, testFilePath);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
    const root = workspaceFolder?.uri.fsPath || fallbackRoot;
    const descendantRoot = this.findDescendantPackageRoot(root, framework);
    return descendantRoot || fallbackRoot;
  }

  private findNearestPackageRoot(filePath: string, boundaryRoot: string): string {
    let current = fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()
      ? filePath
      : path.dirname(filePath);
    const boundary = path.resolve(boundaryRoot || current);

    while (path.resolve(current).startsWith(boundary)) {
      if (fs.existsSync(path.join(current, 'package.json')) || fs.existsSync(path.join(current, 'pyproject.toml'))) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }

    return '';
  }

  private findDescendantPackageRoot(root: string, framework: string): string {
    const queue = [root];
    while (queue.length) {
      const current = queue.shift()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }

      if (this.packageSupportsFramework(current, framework)) {
        return current;
      }

      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          !['node_modules', '.git', 'dist', 'build', '.next', 'coverage'].includes(entry.name)
        ) {
          queue.push(path.join(current, entry.name));
        }
      }
    }
    return '';
  }

  private packageSupportsFramework(root: string, framework: string): boolean {
    const pkgPath = path.join(root, 'package.json');
    if (framework === 'pytest') {
      return fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'pytest.ini'));
    }
    if (!fs.existsSync(pkgPath)) {
      return false;
    }
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      return Boolean(allDeps[framework] || pkg[framework] || this.scriptMentionsFramework(pkg.scripts || {}, framework));
    } catch {
      return false;
    }
  }

  private scriptMentionsFramework(scripts: Record<string, string>, framework: string): boolean {
    return Object.values(scripts).some(script => new RegExp(`\\b${framework}\\b`, 'i').test(script));
  }

  private readFileIfExists(filePath: string): string {
    try {
      return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
    } catch {
      return '';
    }
  }

  private inferFrameworkFromContent(
    content: string,
    sourceFilePath: string
  ): 'jest' | 'vitest' | 'pytest' | 'unknown' {
    if (path.extname(sourceFilePath).toLowerCase() === '.py' || /(?:^|\n)\s*import\s+pytest\b/.test(content)) {
      return 'pytest';
    }
    if (/from\s+['"]@jest\/globals['"]|\bjest\./.test(content)) {
      return 'jest';
    }
    if (/from\s+['"]vitest['"]|vi\./.test(content)) {
      return 'vitest';
    }
    return 'unknown';
  }

  private hasNodeModules(startDir: string, boundaryDir: string): boolean {
    let current = path.resolve(startDir);
    const boundary = boundaryDir ? path.resolve(boundaryDir) : current;
    while (true) {
      if (fs.existsSync(path.join(current, 'node_modules'))) {
        return true;
      }
      if (current === boundary) {
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
    return false;
  }

  private isFrameworkDeclared(startDir: string, boundaryDir: string, framework: string): boolean {
    let current = path.resolve(startDir);
    const boundary = boundaryDir ? path.resolve(boundaryDir) : current;
    while (true) {
      const pkgPath = path.join(current, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
          if (allDeps[framework]) {
            return true;
          }
        } catch {
          // ignore
        }
      }
      if (fs.existsSync(path.join(current, 'node_modules'))) {
        break;
      }
      if (current === boundary) {
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
    return false;
  }

  private quote(value: string): string {
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  private toPosix(value: string): string {
    return value.replace(/\\/g, '/');
  }

  private getPackageManager(dir: string, boundaryDir: string): 'npm' | 'yarn' | 'pnpm' | 'bun' {
    let current = path.resolve(dir);
    const boundary = boundaryDir ? path.resolve(boundaryDir) : current;
    while (true) {
      if (fs.existsSync(path.join(current, 'package-lock.json'))) { return 'npm'; }
      if (fs.existsSync(path.join(current, 'yarn.lock'))) { return 'yarn'; }
      if (fs.existsSync(path.join(current, 'pnpm-lock.yaml'))) { return 'pnpm'; }
      if (fs.existsSync(path.join(current, 'bun.lockb')) || fs.existsSync(path.join(current, 'bun.lock'))) { return 'bun'; }
      if (current === boundary) { break; }
      const parent = path.dirname(current);
      if (parent === current) { break; }
      current = parent;
    }
    return 'npm';
  }

  private getInstallDependenciesCommand(packageManager: 'npm' | 'yarn' | 'pnpm' | 'bun'): string {
    switch (packageManager) {
      case 'yarn': return 'yarn install';
      case 'pnpm': return 'pnpm install';
      case 'bun': return 'bun install';
      default: return 'npm install';
    }
  }

  private getInstallFrameworkCommand(packageManager: 'npm' | 'yarn' | 'pnpm' | 'bun', framework: string): string {
    if (framework === 'pytest') {
      return 'python -m pip install pytest';
    }
    const packages = framework === 'jest' ? 'jest @jest/globals ts-jest' : 'vitest';
    switch (packageManager) {
      case 'yarn': return `yarn add -D ${packages}`;
      case 'pnpm': return `pnpm add -D ${packages}`;
      case 'bun': return `bun add -D ${packages}`;
      default: return `npm install -D ${packages}`;
    }
  }

  private async ensureDependencies(cwd: string, boundary: string, framework: string, testFilePath?: string): Promise<boolean> {
    if (framework === 'jest' || framework === 'vitest') {
      const pm = this.getPackageManager(cwd, boundary);
      
      // 1. Check if node_modules exists
      if (!this.hasNodeModules(cwd, boundary)) {
        const installCmd = this.getInstallDependenciesCommand(pm);
        this.outputChannel.appendLine(`node_modules not found in ${cwd} or parents. Automatically running: ${installCmd}`);
        try {
          await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Automated QA: Installing project dependencies...`,
            cancellable: false
          }, async (progress) => {
            progress.report({ message: `Running ${installCmd} in ${cwd}...` });
            await execAsync(installCmd, { cwd });
          });
          this.outputChannel.appendLine('Dependencies installed successfully.');
        } catch (err: any) {
          const msg = `Failed to install dependencies: ${err.message || err}`;
          this.outputChannel.appendLine(msg);
          vscode.window.showErrorMessage(msg);
          return false;
        }
      }

      // 2. Check if framework is declared
      const isTypeScript = testFilePath ? (testFilePath.endsWith('.ts') || testFilePath.endsWith('.tsx')) : false;
      const hasFramework = this.isFrameworkDeclared(cwd, boundary, framework) &&
        (framework !== 'jest' || !isTypeScript || this.isFrameworkDeclared(cwd, boundary, 'ts-jest'));

      if (!hasFramework) {
        const installCmd = this.getInstallFrameworkCommand(pm, framework);
        this.outputChannel.appendLine(`Test framework "${framework}" not declared in package.json. Automatically running: ${installCmd}`);
        try {
          const pkgDir = this.findNearestPackageRoot(path.join(cwd, 'dummy.js'), boundary) || cwd;
          await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Automated QA: Installing ${framework}...`,
            cancellable: false
          }, async (progress) => {
            progress.report({ message: `Running ${installCmd} in ${pkgDir}...` });
            await execAsync(installCmd, { cwd: pkgDir });
          });
          this.outputChannel.appendLine(`Framework "${framework}" installed successfully.`);
        } catch (err: any) {
          const msg = `Failed to install framework "${framework}": ${err.message || err}`;
          this.outputChannel.appendLine(msg);
          vscode.window.showErrorMessage(msg);
          return false;
        }
      }
    } else if (framework === 'pytest') {
      try {
        await execAsync('pytest --version');
      } catch {
        const installCmd = 'python -m pip install pytest';
        this.outputChannel.appendLine(`pytest not found in environment. Automatically running: ${installCmd}`);
        try {
          await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Automated QA: Installing pytest...`,
            cancellable: false
          }, async (progress) => {
            progress.report({ message: `Running ${installCmd}...` });
            await execAsync(installCmd);
          });
          this.outputChannel.appendLine('pytest installed successfully.');
        } catch (err: any) {
          const msg = `Failed to install pytest: ${err.message || err}`;
          this.outputChannel.appendLine(msg);
          vscode.window.showErrorMessage(msg);
          return false;
        }
      }
    }
    return true;
  }

  private stripAnsi(str: string): string {
    return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
  }
}
