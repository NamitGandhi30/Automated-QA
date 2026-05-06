import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SecretManager } from './secretManager';
import { WorkspaceIndexer } from './workspaceIndexer';
import { DockerManager } from './dockerManager';

export interface GeneratedTests {
  filePath: string;
  framework: string;
  normal: string;
  edgeCase: string;
  stress: string;
  fullContent: string;
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
    const { provider, apiKey } = await this.secretManager.getActiveKeyIfNeeded();

    this.outputChannel.appendLine(`Generating tests for selection using ${provider}...`);

    const prompt = this.buildTestPrompt(selectedCode, ctx);
    let response: string;

    if (provider === 'copilot') {
      response = await this.generateViaCopilot(prompt);
    } else {
      response = await this.generateViaSidecar(prompt, provider, apiKey!);
    }

    if (!response) { return null; }

    const tests = this.parseTestOutput(response, editor.document.uri.fsPath, ctx.testFramework);
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

  async runTests(testFilePath: string): Promise<string> {
    const ctx = await this.workspaceIndexer.getContext();

    // Buffer flush: read current content from disk (just written)
    const fileContent = fs.readFileSync(testFilePath, 'utf-8');

    if (this.dockerManager.isStackRunning) {
      try {
        const result = await this.dockerManager.postToSidecar<{ output: string; exitCode: number }>('/run-tests', {
          filePath: testFilePath,
          fileContent,
          framework: ctx.testFramework,
        });
        this.outputChannel.appendLine(`Test output:\n${result.output}`);
        return result.output;
      } catch (err: any) {
        this.outputChannel.appendLine(`Sidecar test run error: ${err.message}`);
      }
    }

    // Fallback: run in VS Code terminal
    return this.runInTerminal(testFilePath, ctx.testFramework);
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

Return ONLY the test file content, ready to be written to disk. No markdown wrapping.
Start the file with the appropriate import statements.`;
  }

  private async generateViaCopilot(prompt: string): Promise<string> {
    try {
      const models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
      const model = models[0];
      if (!model) {
        vscode.window.showErrorMessage('No Copilot model available.');
        return '';
      }

      const messages = [vscode.LanguageModelChatMessage.User(prompt)];
      const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

      let fullResponse = '';
      for await (const chunk of response.text) {
        fullResponse += chunk;
      }
      return fullResponse;
    } catch (err: any) {
      this.outputChannel.appendLine(`Copilot test generation error: ${err.message}`);
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

  private parseTestOutput(raw: string, sourceFilePath: string, framework: string): GeneratedTests | null {
    // Strip markdown code fences if present
    let content = raw.replace(/^```[\w]*\n?/gm, '').replace(/```$/gm, '').trim();

    const ext = framework === 'pytest' ? '.py' : '.ts';
    const baseName = path.basename(sourceFilePath, path.extname(sourceFilePath));
    const dir = path.dirname(sourceFilePath);
    const testFileName = `${baseName}.qa.test${ext}`;
    const testFilePath = path.join(dir, testFileName);

    // Try to split into tiers
    const normalMatch = content.match(/\/\/\s*(?:TIER\s*1|NORMAL|Happy\s*Path)[\s\S]*?(?=\/\/\s*(?:TIER\s*2|EDGE)|$)/i);
    const edgeMatch = content.match(/\/\/\s*(?:TIER\s*2|EDGE\s*CASE)[\s\S]*?(?=\/\/\s*(?:TIER\s*3|STRESS)|$)/i);
    const stressMatch = content.match(/\/\/\s*(?:TIER\s*3|STRESS)[\s\S]*/i);

    return {
      filePath: testFilePath,
      framework,
      normal: normalMatch?.[0] || 'No normal tests generated',
      edgeCase: edgeMatch?.[0] || 'No edge-case tests generated',
      stress: stressMatch?.[0] || 'No stress tests generated',
      fullContent: content,
    };
  }

  private runInTerminal(testFilePath: string, framework: string): Promise<string> {
    return new Promise((resolve) => {
      const terminal = vscode.window.createTerminal('Automated QA - Tests');
      terminal.show();

      const commands: Record<string, string> = {
        jest: `npx jest "${testFilePath}" --verbose`,
        vitest: `npx vitest run "${testFilePath}"`,
        pytest: `python -m pytest "${testFilePath}" -v`,
      };

      const cmd = commands[framework] || commands.jest;
      terminal.sendText(cmd);
      resolve(`Tests running in terminal: ${cmd}`);
    });
  }
}
