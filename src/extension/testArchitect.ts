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

export class TestArchitect {
  private secretManager: SecretManager;
  private workspaceIndexer: WorkspaceIndexer;
  private dockerManager: DockerManager;
  private outputChannel: vscode.OutputChannel;
  private _lastGenerated: GeneratedTests | null = null;
  private _onTestsGenerated = new vscode.EventEmitter<GeneratedTests>();
  readonly onTestsGenerated = this._onTestsGenerated.event;

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

    const prompt = this.buildTestPrompt(selectedCode, ctx);
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
      this._lastGenerated = tests;

      // Write to file
      fs.writeFileSync(tests.filePath, tests.fullContent, 'utf-8');
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

  private buildTestPrompt(code: string, ctx: any): string {
    const frameworkImports: Record<string, string> = {
      jest: `import { describe, it, expect } from '@jest/globals';`,
      vitest: `import { describe, it, expect } from 'vitest';`,
      pytest: `import pytest`,
    };

    return `You are a Test Architect. Generate a comprehensive test suite for the following code.

**Test Framework:** ${ctx.testFramework}
**Language:** ${ctx.language}
**Workspace root:** ${ctx.workspaceRoot || '(unknown)'}
**Test config:** ${ctx.testConfigPath || '(auto-detect from workspace root)'}
**Source file:** ${ctx.activeFilePath}

**Code under test:**
\`\`\`
${code}
\`\`\`

Generate tests in THREE TIERS, clearly separated by comments:

### TIER 1: NORMAL (Happy Path)
Basic functional tests covering standard input/output scenarios.

### TIER 2: EDGE CASE
Tests for: null, undefined, empty strings, boundary numbers (0, -1, MAX_SAFE_INTEGER), empty arrays/objects.

### TIER 3: STRESS TEST
Wrap the function in a loop with 100,000+ iterations OR pass a massive data object (100k+ items).
Measure execution time using \`performance.now()\` or equivalent.
Assert that execution completes within a reasonable time (e.g., < 5 seconds).
Check for memory leaks if applicable.

Use this import: ${frameworkImports[ctx.testFramework] || frameworkImports.jest}
The generated test file will be written next to the source file. Import the code under test with a local relative import from the test file to the source file.
For pytest, use Python comments beginning with # for the tier headers. For Jest and Vitest, use // comments.
Do not mix test-runner APIs. If using Jest, use jest.fn(), jest.clearAllMocks(), and imports from @jest/globals. If using Vitest, use vi.fn(), vi.clearAllMocks(), and imports from vitest.

Return ONLY the test file content, ready to be written to disk. No markdown wrapping.
Start the file with the appropriate import statements.`;
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
    testConfigPath: string
  ): Promise<TestRunResult> {
    const testContent = this.readFileIfExists(testFilePath);
    const resolvedFramework = framework === 'unknown'
      ? this.inferFrameworkFromContent(testContent, testFilePath)
      : framework;
    const cwd = this.resolveRunRoot(testFilePath, resolvedFramework, workspaceRoot);
    const commandInfo = this.buildRunCommand(testFilePath, resolvedFramework, cwd, testConfigPath);

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

    this.outputChannel.appendLine(`Running tests from ${cwd}`);
    this.outputChannel.appendLine(`Command: ${commandInfo.command}`);

    try {
      const { stdout, stderr } = await execAsync(commandInfo.command, {
        cwd,
        timeout: 120000,
        maxBuffer: 1024 * 1024 * 10,
        windowsHide: true,
      });
      const output = stdout + (stderr ? `\n${stderr}` : '');
      const result: TestRunResult = {
        status: 'passed',
        command: commandInfo.command,
        cwd,
        exitCode: 0,
        output,
        framework: resolvedFramework,
        testFilePath,
      };
      this.outputChannel.appendLine(`Test output:\n${output}`);
      return result;
    } catch (err: any) {
      const output = `${err.stdout || ''}${err.stderr ? `\n${err.stderr}` : ''}`.trim();
      const exitCode = typeof err.code === 'number' ? err.code : 1;
      const result: TestRunResult = {
        status: exitCode === 0 ? 'passed' : 'failed',
        command: commandInfo.command,
        cwd,
        exitCode,
        output: output || err.message || '',
        framework: resolvedFramework,
        testFilePath,
        failureReason: this.describeFailure(resolvedFramework, exitCode, output || err.message || '', testConfigPath),
      };
      this.outputChannel.appendLine(`Test run failed with exit code ${exitCode}: ${result.failureReason}`);
      this.outputChannel.appendLine(`Test output:\n${result.output}`);
      return result;
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
      return { command: `npx --no-install jest --runTestsByPath ${relativeTestPath}${configArg} --verbose` };
    }
    if (framework === 'vitest') {
      return { command: `npx --no-install vitest run ${relativeTestPath}${configArg}` };
    }
    if (framework === 'pytest') {
      return { command: `python -m pytest ${relativeTestPath} -v` };
    }

    return {
      command: '',
      failureReason: 'No supported test framework was detected. Install/configure Jest, Vitest, or Pytest in the workspace first.',
    };
  }

  private describeFailure(framework: string, exitCode: number, output: string, testConfigPath: string): string {
    if (/could not find a config file|Can't find a root directory|No tests found/i.test(output)) {
      return `${framework} could not find runnable tests or project config from the workspace root. Config detected: ${testConfigPath || 'none'}.`;
    }
    if (/Cannot find module|Module not found|ERR_MODULE_NOT_FOUND|ImportError|ModuleNotFoundError/i.test(output)) {
      return 'The generated test could not import the code under test or a project dependency.';
    }
    if (
      /command not found|not recognized as an internal or external command|could not determine executable/i.test(output) ||
      /npx canceled due to missing packages|npm error.*missing packages|npm ERR!.*missing packages/i.test(output)
    ) {
      return `${framework} is not available in this workspace. Run "${this.getInstallCommand(framework)}" from the shown CWD, then run again.`;
    }
    if (/timeout/i.test(output)) {
      return 'The test command timed out after 120 seconds.';
    }
    return `The test command exited with code ${exitCode}.`;
  }

  private getInstallCommand(framework: string): string {
    if (framework === 'vitest') {
      return 'npm install -D vitest';
    }
    if (framework === 'jest') {
      return 'npm install -D jest @jest/globals';
    }
    if (framework === 'pytest') {
      return 'python -m pip install pytest';
    }
    return 'install a supported test runner';
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

  private quote(value: string): string {
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  private toPosix(value: string): string {
    return value.replace(/\\/g, '/');
  }
}
