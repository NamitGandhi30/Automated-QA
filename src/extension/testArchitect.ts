import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import { SecretManager } from './secretManager';
import { WorkspaceIndexer } from './workspaceIndexer';
import { DockerManager } from './dockerManager';
import { selectBestCopilotModel } from './copilotModelSelector';
import { analyzeSourceFile, CodeIntelligence } from './codeIntelligence';

// ─── Public types ──────────────────────────────────────────────────────────

export type LanguageId =
  | 'typescript' | 'javascript' | 'python' | 'go' | 'rust' | 'java' | 'c' | 'cpp';

export interface GeneratedTests {
  /** Host scratch path to the generated test file (ephemeral — for viewing). */
  filePath: string;
  sourceFilePath: string;
  language: LanguageId;
  framework: string;
  workspaceRoot: string;
  normal: string;
  edgeCase: string;
  stress: string;
  fullContent: string;
  /** Ephemeral scratch directory that holds this suite. */
  scratchDir: string;
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
  failureSummary?: string;
}

export interface TestFinding {
  severity: 'low' | 'medium' | 'high';
  title: string;
  plainExplanation: string;
  /** True when the failing test caught a likely real bug in the source (not a broken test). */
  likelyRealBug: boolean;
  suggestedFix?: string;
}

export interface TestExplanation {
  verdict: 'all-green' | 'found-issues' | 'cant-run';
  plainSummary: string;
  whatWeTested: string[];
  findings: TestFinding[];
  recommendation: string;
}

interface LanguageProfile {
  id: LanguageId;
  displayName: string;
  framework: string;
  /** Extensions used to resolve co-located sibling source files. */
  siblingExts: string[];
  /** Name the source-under-test is written as in the sandbox. */
  sourceFileName: (sourcePath: string) => string;
  /** Name the generated test is written as. */
  testFileName: (sourcePath: string) => string;
}

// ─── Language profiles ───────────────────────────────────────────────────────

function baseNameNoExt(p: string): string {
  return path.basename(p, path.extname(p));
}

const LANGUAGE_PROFILES: Record<LanguageId, LanguageProfile> = {
  typescript: {
    id: 'typescript', displayName: 'TypeScript', framework: 'jest',
    siblingExts: ['.ts', '.tsx', '.js', '.jsx'],
    sourceFileName: (p) => path.basename(p),
    testFileName: (p) => `${baseNameNoExt(p)}.qa.test.ts`,
  },
  javascript: {
    id: 'javascript', displayName: 'JavaScript', framework: 'jest',
    siblingExts: ['.js', '.jsx', '.mjs', '.cjs', '.ts'],
    sourceFileName: (p) => path.basename(p),
    testFileName: (p) => `${baseNameNoExt(p)}.qa.test.js`,
  },
  python: {
    id: 'python', displayName: 'Python', framework: 'pytest',
    siblingExts: ['.py'],
    sourceFileName: (p) => path.basename(p),
    testFileName: (p) => `test_${baseNameNoExt(p)}_qa.py`,
  },
  go: {
    id: 'go', displayName: 'Go', framework: 'go test',
    siblingExts: ['.go'],
    sourceFileName: (p) => path.basename(p),
    testFileName: (p) => `${baseNameNoExt(p)}_qa_test.go`,
  },
  rust: {
    id: 'rust', displayName: 'Rust', framework: 'cargo test',
    siblingExts: ['.rs'],
    sourceFileName: (p) => path.basename(p),
    testFileName: (p) => `${baseNameNoExt(p)}_qa_test.rs`,
  },
  java: {
    id: 'java', displayName: 'Java', framework: 'JUnit 5',
    siblingExts: ['.java'],
    sourceFileName: (p) => path.basename(p),
    testFileName: (p) => `${baseNameNoExt(p)}QaTest.java`,
  },
  c: {
    id: 'c', displayName: 'C', framework: 'utest.h',
    siblingExts: ['.c', '.h'],
    sourceFileName: (p) => path.basename(p),
    testFileName: (p) => `${baseNameNoExt(p)}_qa_test.c`,
  },
  cpp: {
    id: 'cpp', displayName: 'C++', framework: 'doctest',
    siblingExts: ['.cc', '.cpp', '.cxx', '.hpp', '.h'],
    sourceFileName: (p) => path.basename(p),
    testFileName: (p) => `${baseNameNoExt(p)}_qa_test.cpp`,
  },
};

function detectLanguageProfile(filePath: string): LanguageProfile | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts': case '.tsx': return LANGUAGE_PROFILES.typescript;
    case '.js': case '.jsx': case '.mjs': case '.cjs': return LANGUAGE_PROFILES.javascript;
    case '.py': return LANGUAGE_PROFILES.python;
    case '.go': return LANGUAGE_PROFILES.go;
    case '.rs': return LANGUAGE_PROFILES.rust;
    case '.java': return LANGUAGE_PROFILES.java;
    case '.c': case '.h': return LANGUAGE_PROFILES.c;
    case '.cc': case '.cpp': case '.cxx': case '.hpp': return LANGUAGE_PROFILES.cpp;
    default: return null;
  }
}

const SCRATCH_STATE_KEY = 'automatedqa.scratchDirs';

export class TestArchitect implements vscode.Disposable {
  private secretManager: SecretManager;
  private workspaceIndexer: WorkspaceIndexer;
  private dockerManager: DockerManager;
  private outputChannel: vscode.OutputChannel;
  private globalStorageUri: vscode.Uri;
  private globalState: vscode.Memento;

  private _lastGenerated: GeneratedTests | null = null;
  private _lastRun: TestRunResult | null = null;

  private _onTestsGenerated = new vscode.EventEmitter<GeneratedTests>();
  readonly onTestsGenerated = this._onTestsGenerated.event;
  private _onTestRun = new vscode.EventEmitter<TestRunResult>();
  readonly onTestRun = this._onTestRun.event;
  private _onExplanation = new vscode.EventEmitter<TestExplanation>();
  readonly onExplanation = this._onExplanation.event;

  constructor(
    secretManager: SecretManager,
    workspaceIndexer: WorkspaceIndexer,
    dockerManager: DockerManager,
    outputChannel: vscode.OutputChannel,
    globalStorageUri: vscode.Uri,
    globalState: vscode.Memento
  ) {
    this.secretManager = secretManager;
    this.workspaceIndexer = workspaceIndexer;
    this.dockerManager = dockerManager;
    this.outputChannel = outputChannel;
    this.globalStorageUri = globalStorageUri;
    this.globalState = globalState;
    // Clean up any scratch dirs orphaned by a previous crash/restart.
    void this.cleanupTrackedScratch();
  }

  dispose() {
    void this.cleanupTrackedScratch();
  }

  get lastGenerated(): GeneratedTests | null {
    return this._lastGenerated;
  }

  // ── Scratch lifecycle ──────────────────────────────────────────────────────

  private get scratchRoot(): string {
    return path.join(this.globalStorageUri.fsPath, 'qa-sandbox');
  }

  private async cleanupTrackedScratch(): Promise<void> {
    const tracked = this.globalState.get<string[]>(SCRATCH_STATE_KEY, []);
    for (const dir of tracked) {
      try {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
          this.outputChannel.appendLine(`Cleaned ephemeral test dir: ${dir}`);
        }
      } catch (err: any) {
        this.outputChannel.appendLine(`Failed to clean scratch dir "${dir}": ${err.message || err}`);
      }
    }
    // Also sweep any stray dirs left under the scratch root.
    try {
      if (fs.existsSync(this.scratchRoot)) {
        for (const name of fs.readdirSync(this.scratchRoot)) {
          const full = path.join(this.scratchRoot, name);
          try { fs.rmSync(full, { recursive: true, force: true }); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    await this.globalState.update(SCRATCH_STATE_KEY, []);
  }

  private createScratchDir(): string {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = path.join(this.scratchRoot, id);
    fs.mkdirSync(dir, { recursive: true });
    const tracked = this.globalState.get<string[]>(SCRATCH_STATE_KEY, []);
    void this.globalState.update(SCRATCH_STATE_KEY, [...tracked, dir]);
    return dir;
  }

  // ── Main entry point ─────────────────────────────────────────────────────

  async generateForSelection(): Promise<GeneratedTests | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('Open a source file first, then generate tests.');
      return null;
    }
    const sourceFilePath = editor.document.uri.fsPath;

    const profile = detectLanguageProfile(sourceFilePath);
    if (!profile) {
      vscode.window.showWarningMessage(
        `Automated QA: unsupported file type "${path.extname(sourceFilePath) || '(none)'}". ` +
        `Supported: TypeScript, JavaScript, Python, Go, Rust, Java, C, C++.`
      );
      return null;
    }
    if (this.isGeneratedTestFile(sourceFilePath)) {
      vscode.window.showWarningMessage('This already looks like a generated QA test. Open the source file instead.');
      return null;
    }

    const sourceContent = editor.document.getText();
    if (!sourceContent.trim()) {
      vscode.window.showWarningMessage('The file is empty — nothing to test.');
      return null;
    }
    const selection = editor.selection;
    const focusSnippet = selection && !selection.isEmpty ? editor.document.getText(selection) : '';

    // Clean previous run's scratch before creating a new one (one active suite).
    await this.cleanupTrackedScratch();

    const ctx = await this.workspaceIndexer.getContext();
    const codeIntel = analyzeSourceFile(
      sourceFilePath, sourceContent, ctx.workspaceRoot, ctx.dependencies, ctx.devDependencies
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

    this.outputChannel.appendLine(`Generating ${profile.displayName} tests using ${provider}...`);

    const prompt = this.buildTestPrompt(profile, sourceContent, focusSnippet, ctx, codeIntel);
    const response = await this.complete(prompt, provider, apiKey);
    if (!response) {
      vscode.window.showErrorMessage('Automated QA: the AI returned no test content.');
      return null;
    }

    const testContent = this.lightValidate(this.stripFences(response), profile, sourceFilePath);

    // Materialize the ephemeral suite on disk for the user to view.
    const scratchDir = this.createScratchDir();
    const sourceName = profile.sourceFileName(sourceFilePath);
    const testName = profile.testFileName(sourceFilePath);
    const scratchSourcePath = path.join(scratchDir, sourceName);
    const scratchTestPath = path.join(scratchDir, testName);
    try {
      fs.writeFileSync(scratchSourcePath, sourceContent, 'utf-8');
      fs.writeFileSync(scratchTestPath, testContent, 'utf-8');
    } catch (err: any) {
      this.outputChannel.appendLine(`Failed to write scratch files: ${err.message || err}`);
    }

    const tiers = this.splitTiers(testContent);
    let tests: GeneratedTests = {
      filePath: scratchTestPath,
      sourceFilePath,
      language: profile.id,
      framework: profile.framework,
      workspaceRoot: ctx.workspaceRoot || path.dirname(sourceFilePath),
      normal: tiers.normal,
      edgeCase: tiers.edgeCase,
      stress: tiers.stress,
      fullContent: testContent,
      scratchDir,
    };
    this._lastGenerated = tests;
    this._onTestsGenerated.fire(tests);

    // Run hermetically in the sandbox, with a self-healing repair loop.
    this._onTestRun.fire({
      status: 'running', command: '', cwd: tests.scratchDir, exitCode: null, output: '',
      framework: tests.framework, testFilePath: tests.filePath,
    });
    const siblings = this.gatherSiblings(profile, sourceFilePath, sourceContent, codeIntel);
    let runResult = await this.runScratchSuite(tests, sourceContent, siblings);

    if (runResult.status === 'failed' || runResult.status === 'error') {
      const repaired = await this.autoRepair(tests, runResult, profile, sourceContent, siblings, provider, apiKey);
      tests = repaired.tests;
      runResult = repaired.result;
    } else {
      this.outputChannel.appendLine('All generated tests passed on the first run.');
    }

    this._lastGenerated = tests;
    this._lastRun = runResult;
    this._onTestRun.fire(runResult);

    // Open the suite for viewing (ephemeral — not in the repo).
    try {
      const doc = await vscode.workspace.openTextDocument(tests.filePath);
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    } catch { /* ignore */ }

    // Plain-language report.
    const explanation = await this.explainResults(tests, runResult, provider, apiKey);
    this._onExplanation.fire(explanation);

    return tests;
  }

  /** Re-run the last generated suite (used by the Run button and the PR pipeline). */
  async runTests(testFilePath: string): Promise<TestRunResult> {
    const gen = this._lastGenerated;
    if (!gen || gen.filePath !== testFilePath) {
      return {
        status: 'error', command: '', cwd: '', exitCode: null, output: '',
        framework: 'unknown', testFilePath,
        failureReason: 'No generated suite to run. Click "Generate Tests" first.',
      };
    }
    const sourceContent = this.readIfExists(gen.sourceFilePath) ||
      this.readIfExists(path.join(gen.scratchDir, path.basename(gen.sourceFilePath)));
    const profile = LANGUAGE_PROFILES[gen.language];
    const ctx = await this.workspaceIndexer.getContext();
    const codeIntel = analyzeSourceFile(
      gen.sourceFilePath, sourceContent, ctx.workspaceRoot, ctx.dependencies, ctx.devDependencies
    );
    const siblings = this.gatherSiblings(profile, gen.sourceFilePath, sourceContent, codeIntel);
    const result = await this.runScratchSuite(gen, sourceContent, siblings);
    this._lastRun = result;
    return result;
  }

  /** Produce a fresh plain-language explanation for the last run (used by manual Run). */
  async explainLast(): Promise<TestExplanation | null> {
    if (!this._lastGenerated || !this._lastRun) { return null; }
    let provider: string; let apiKey: string | undefined;
    try {
      const r = await this.secretManager.getActiveKeyIfNeeded();
      provider = r.provider; apiKey = r.apiKey;
    } catch { return null; }
    return this.explainResults(this._lastGenerated, this._lastRun, provider, apiKey);
  }

  /** Persist the generated suite into the user's project (the ONLY repo write). */
  async saveToProject(): Promise<string | null> {
    const gen = this._lastGenerated;
    if (!gen) {
      vscode.window.showWarningMessage('No generated tests to save yet.');
      return null;
    }
    const profile = LANGUAGE_PROFILES[gen.language];
    const destDir = path.dirname(gen.sourceFilePath);
    const destName = profile.testFileName(gen.sourceFilePath);
    const destPath = path.join(destDir, destName);
    try {
      if (fs.existsSync(destPath)) {
        const choice = await vscode.window.showWarningMessage(
          `${destName} already exists. Overwrite?`, { modal: true }, 'Overwrite'
        );
        if (choice !== 'Overwrite') { return null; }
      }
      fs.writeFileSync(destPath, gen.fullContent, 'utf-8');
      const doc = await vscode.workspace.openTextDocument(destPath);
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(`Saved tests to ${vscode.workspace.asRelativePath(destPath)}`);
      this.outputChannel.appendLine(`Saved tests to ${destPath}`);
      return destPath;
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to save tests: ${err.message || err}`);
      return null;
    }
  }

  // ── Sandbox execution ──────────────────────────────────────────────────────

  private async runScratchSuite(
    tests: GeneratedTests,
    sourceContent: string,
    siblings: { name: string; content: string }[]
  ): Promise<TestRunResult> {
    if (!this.dockerManager.isStackRunning) {
      return {
        status: 'error', command: '', cwd: tests.scratchDir, exitCode: null, output: '',
        framework: tests.framework, testFilePath: tests.filePath,
        failureReason: 'The QA sandbox is not running. Start it from the sidebar (Start Docker) to run tests. ' +
          'No tools are installed on your machine — everything runs inside the sandbox container.',
      };
    }

    const profile = LANGUAGE_PROFILES[tests.language];
    const id = path.basename(tests.scratchDir);
    this.outputChannel.appendLine(`Running ${profile.displayName} tests hermetically in the sandbox...`);
    try {
      const result = await this.dockerManager.postToSidecar<TestRunResult>('/run-sandbox', {
        id,
        language: tests.language,
        sourceFileName: profile.sourceFileName(tests.sourceFilePath),
        sourceContent,
        siblingFiles: siblings,
        testFileName: profile.testFileName(tests.sourceFilePath),
        testContent: tests.fullContent,
      });
      if (result?.output) { result.output = this.stripAnsi(result.output); }
      this.outputChannel.appendLine(`Sandbox status: ${result.status}`);
      if (result.failureReason) { this.outputChannel.appendLine(`Reason: ${result.failureReason}`); }
      return result;
    } catch (err: any) {
      return {
        status: 'error', command: '', cwd: tests.scratchDir, exitCode: null, output: err.message || '',
        framework: tests.framework, testFilePath: tests.filePath,
        failureReason: `Could not reach the QA sandbox: ${err.message || err}`,
      };
    }
  }

  private async autoRepair(
    tests: GeneratedTests,
    initial: TestRunResult,
    profile: LanguageProfile,
    sourceContent: string,
    siblings: { name: string; content: string }[],
    provider: string,
    apiKey: string | undefined
  ): Promise<{ tests: GeneratedTests; result: TestRunResult }> {
    let result = initial;
    let attempt = 1;
    const maxAttempts = 3;

    while ((result.status === 'failed' || result.status === 'error') && attempt <= maxAttempts) {
      this.outputChannel.appendLine(`[self-heal] attempt ${attempt}: repairing generated tests...`);
      const repairPrompt = this.buildRepairPrompt(profile, sourceContent, tests.fullContent, result);
      const response = await this.complete(repairPrompt, provider, apiKey);
      if (!response) { break; }

      const repaired = this.lightValidate(this.stripFences(response), profile, tests.sourceFilePath);
      tests.fullContent = repaired;
      const tiers = this.splitTiers(repaired);
      tests.normal = tiers.normal; tests.edgeCase = tiers.edgeCase; tests.stress = tiers.stress;
      try { fs.writeFileSync(tests.filePath, repaired, 'utf-8'); } catch { /* ignore */ }

      result = await this.runScratchSuite(tests, sourceContent, siblings);
      attempt++;
    }

    if (result.status === 'passed') {
      this.outputChannel.appendLine('[self-heal] tests are now passing.');
    } else {
      this.outputChannel.appendLine(`[self-heal] could not get a green run after ${maxAttempts} attempts ` +
        `(the failure may be a real bug in your code — see the report).`);
    }
    return { tests, result };
  }

  // ── Sibling resolution (best-effort, for relative imports) ──────────────────

  private gatherSiblings(
    profile: LanguageProfile,
    sourcePath: string,
    sourceContent: string,
    codeIntel: CodeIntelligence
  ): { name: string; content: string }[] {
    if (!['typescript', 'javascript', 'python'].includes(profile.id)) { return []; }
    const dir = path.dirname(sourcePath);
    const out: { name: string; content: string }[] = [];
    const seen = new Set<string>([path.basename(sourcePath)]);

    for (const imp of codeIntel.internalImports || []) {
      if (out.length >= 8) { break; }
      let rel = imp.module;
      if (profile.id === 'python') {
        if (!rel.startsWith('.')) { continue; }
        rel = rel.replace(/^\.+/, '');
      } else {
        if (!rel.startsWith('./')) { continue; }
        rel = rel.slice(2);
      }
      if (rel.includes('/') || rel.includes('\\') || !rel) { continue; } // immediate-dir only
      for (const ext of profile.siblingExts) {
        const candidate = path.join(dir, rel + ext);
        const name = rel + ext;
        if (seen.has(name)) { continue; }
        if (fs.existsSync(candidate)) {
          try {
            out.push({ name, content: fs.readFileSync(candidate, 'utf-8') });
            seen.add(name);
          } catch { /* ignore */ }
          break;
        }
      }
    }
    return out;
  }

  // ── Prompt construction ─────────────────────────────────────────────────────

  private buildTestPrompt(
    profile: LanguageProfile,
    sourceContent: string,
    focusSnippet: string,
    ctx: any,
    codeIntel: CodeIntelligence
  ): string {
    const sourceName = profile.sourceFileName(ctx.activeFilePath || 'source');
    const base = baseNameNoExt(sourceName);
    const edgeCases = this.buildEdgeCaseList(profile, codeIntel);
    const contract = this.languageContract(profile, sourceName, codeIntel);

    const focus = focusSnippet
      ? `\nFocus your most thorough testing on this selected part, but you may test the whole file:\n\`\`\`\n${focusSnippet}\n\`\`\`\n`
      : '';

    const reference = (['typescript', 'javascript', 'python'].includes(profile.id) && ctx.nearbyTestFiles?.length)
      ? `\n### Existing test style to follow (imports/mocking/structure):\n` +
        ctx.nearbyTestFiles.slice(0, 2).map((f: any, i: number) =>
          `--- Example ${i + 1}: ${path.basename(f.path)} ---\n${f.content}`).join('\n\n') + '\n'
      : '';

    return `You are a senior QA engineer. Write a rigorous, production-grade ${profile.displayName} test suite for the code below.
Think like someone who has shipped software for 15 years and is paid to find bugs nobody else would.

Source file: ${sourceName}
Test framework: ${profile.framework}

**Code under test (the full file):**
\`\`\`
${sourceContent}
\`\`\`
${focus}${reference}
Generate THREE clearly separated tiers (use the language's comment syntax for the headers):
  TIER 1: NORMAL — happy-path behavior with typical valid inputs.
  TIER 2: EDGE CASE — be ruthless. Cover:
${edgeCases.map((e, i) => `    ${i + 1}. ${e}`).join('\n')}
  TIER 3: STRESS — run the code under repetition and assert it stays correct and fast. Use a MODEST, BOUNDED loop (≤ 1000 simple/sync iterations, ≤ 100 async iterations) and assert it finishes well under 2 seconds. Never write an unbounded or potentially infinite loop.

Senior-QA rules (do not violate):
- If the source does NOT guard an input and would crash/throw/overflow on it, ASSERT that it throws/errors. Never soften an assertion to make a test pass — a failing test that exposes a real bug is the goal.
- Test observable behavior and return values, not private implementation details, unless the language requires in-module tests.
- Keep every test deterministic and FAST (each test must finish in well under 2 seconds). No real network, no real filesystem, no real clock, no sleeps/delays, no setTimeout/setInterval (use fake timers if timing matters).
- Every promise/async path MUST resolve or reject within the test — never leave a promise pending or an async function awaiting something that never settles. Do not call code that starts a server, opens a socket, or schedules a recurring timer without stopping it.
${contract}

Return ONLY the test file content, ready to write to disk. No markdown fences, no prose.`;
  }

  private languageContract(profile: LanguageProfile, sourceName: string, codeIntel: CodeIntelligence): string {
    const base = baseNameNoExt(sourceName);
    const hasExternal = (codeIntel.externalImports || []).length > 0;
    switch (profile.id) {
      case 'typescript':
      case 'javascript':
        return `
Language contract (${profile.displayName} / Jest):
- Import the code under test with EXACTLY: import { ... } from './${base}';
- Use: import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
- The sandbox has NO network access. Any real HTTP/API/SDK call will fail. You MUST mock so the code never touches the network.
- ${hasExternal
            ? "Mock EVERY external module the source imports with a factory, e.g. jest.mock('pkg', () => ({ fn: jest.fn() })). Never call jest.mock('pkg') without a factory for a third-party package — it is NOT installed in the sandbox. If the source constructs SDK clients (e.g. new SomeClient()) or calls client.method(...), the factory must return objects whose methods are jest.fn() returning resolved/rejected promises with realistic fake data — never a real client."
            : 'The source has no external dependencies to mock.'}
- Give every it()/test() a per-test timeout as the last argument, e.g. it('name', async () => { ... }, 10000).`;
      case 'python':
        return `
Language contract (Python / pytest):
- The test runs in a FLAT directory (no package). Import with: import ${base}  (or: from ${base} import ...). Do NOT use a leading dot (no "from .${base}").
- Use pytest conventions: functions named test_*, plain assert, and pytest.raises(...) for expected exceptions.
- The sandbox has NO network access. You MUST mock so the code never makes a real API/HTTP call.
- ${hasExternal
            ? `Mock external dependencies with unittest.mock: from unittest.mock import patch, MagicMock, AsyncMock; patch them at '${base}.<name>'. Do not require third-party packages to be installed. For API/SDK clients, patch the client class/method so it returns fake data — never a real client.`
            : 'No external dependencies to mock.'}
- Never use any JavaScript/Jest APIs.`;
      case 'go':
        return `
Language contract (Go / testing):
- Put the test in the SAME package as the source file (match its 'package' line exactly).
- Use the standard testing package: func TestXxx(t *testing.T). Prefer table-driven tests for edge cases.
- Use only the Go standard library (no third-party modules — the sandbox has no network).
- Output the complete *_test.go file content, including the package declaration.`;
      case 'rust':
        return `
Language contract (Rust):
- Output ONLY a test module: #[cfg(test)] mod tests { use super::*; ... }. The code under test is already in the same crate — do NOT redeclare or re-paste it.
- Use #[test] functions and assert!/assert_eq!. Use #[should_panic] for expected panics.
- Use only std (no external crates — the sandbox has no network).
- Put the three tier headers as // comments inside the module.`;
      case 'java':
        return `
Language contract (Java / JUnit 5):
- Output ONE public class named EXACTLY ${base}QaTest (the file name must match). No 'package' declaration (default package).
- Use JUnit 5: import org.junit.jupiter.api.Test; import static org.junit.jupiter.api.Assertions.*;
- Reference the class under test directly (it is in the same default package). Use assertThrows(...) for expected exceptions.`;
      case 'c':
        return `
Language contract (C / utest.h):
- Start the file with: #include "utest.h"
- Then include the source under test: #include "${sourceName}"
- Write tests with the utest macros: UTEST(suite, name) { ASSERT_EQ(a, b); ASSERT_TRUE(x); ... }
- End the file with exactly: UTEST_MAIN();
- Use only the C standard library.`;
      case 'cpp':
        return `
Language contract (C++ / doctest):
- Start the file with: #define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
- Then: #include "doctest.h"
- Then include the source under test: #include "${sourceName}"
- Write tests with: TEST_CASE("name") { CHECK(...); REQUIRE(...); CHECK_THROWS(...); }
- Use only the C++ standard library (C++17).`;
      default:
        return '';
    }
  }

  private buildEdgeCaseList(profile: LanguageProfile, codeIntel: CodeIntelligence): string[] {
    const cases: string[] = [
      'Boundary values: zero, negative, max/min, off-by-one around limits.',
      'Empty / null / missing inputs (empty string, empty collection, null/None/nil where the type allows).',
      'Unusual but valid inputs: very large inputs, unicode/special characters, whitespace.',
      'Error propagation: confirm errors/exceptions are raised and surfaced, not swallowed.',
    ];
    const t = codeIntel.codeTraits;
    if (t) {
      if (t.hasAsyncCode) { cases.push('Async failures: rejected promises/futures propagate; concurrent calls do not race.'); }
      if (t.hasFetchOrHttp) { cases.push('Network: mock HTTP to return 4xx/5xx, invalid JSON, empty body, and to reject.'); }
      if (t.hasFileSystem) { cases.push('File system: mock missing file (ENOENT), permission denied, empty content.'); }
      if (t.hasDatabase) { cases.push('Database: connection failure, empty result set, constraint/duplicate-key violation.'); }
      if (t.hasClassInstances) { cases.push('Object state: verify state after methods; constructor with invalid args.'); }
      if (t.isReactComponent) { cases.push('Render with missing/null props; simulate user interaction.'); }
      if (t.hasTimers) { cases.push('Timers: use fake timers to test setTimeout/setInterval behavior.'); }
    }
    cases.push('Idempotency: calling the function twice with the same input gives the same result (no hidden state leak).');
    return cases;
  }

  private buildRepairPrompt(
    profile: LanguageProfile,
    sourceContent: string,
    testContent: string,
    result: TestRunResult
  ): string {
    return `You are a senior QA engineer. The ${profile.displayName} test suite you wrote did not pass. Fix it.

IMPORTANT: Decide WHY it failed before editing:
- If the test made a wrong assumption (bad mock, wrong expected value, wrong import), correct the TEST.
- If the test is correct and the SOURCE has a real bug, KEEP the failing assertion — do not weaken it to force a pass. A test that exposes a real bug is correct.

### Source under test:
\`\`\`
${sourceContent}
\`\`\`

### Current test (failed):
\`\`\`
${testContent}
\`\`\`

### Failure output:
\`\`\`
${(result.failureSummary || result.output || result.failureReason || '').slice(0, 4000)}
\`\`\`

Keep the three tiers (NORMAL / EDGE CASE / STRESS) and the same language contract. Return ONLY the corrected test file content. No markdown fences.`;
  }

  // ── Plain-language explanation ──────────────────────────────────────────────

  private async explainResults(
    tests: GeneratedTests,
    result: TestRunResult,
    provider: string,
    apiKey: string | undefined
  ): Promise<TestExplanation> {
    const prompt = `You are a senior QA engineer explaining a test run to a non-technical teammate. Be clear and concrete.

Language: ${tests.language}
Run status: ${result.status}${result.exitCode != null ? ` (exit ${result.exitCode})` : ''}

### Source under test:
\`\`\`
${tests.sourceFilePath ? this.readIfExists(tests.sourceFilePath).slice(0, 4000) : ''}
\`\`\`

### Generated tests:
\`\`\`
${tests.fullContent.slice(0, 4000)}
\`\`\`

### Run output:
\`\`\`
${(result.failureSummary || result.output || result.failureReason || 'No output.').slice(0, 4000)}
\`\`\`

Return ONLY strict JSON (no markdown) with this exact shape:
{
  "verdict": "all-green" | "found-issues" | "cant-run",
  "plainSummary": "2-3 plain-English sentences anyone can understand",
  "whatWeTested": ["short phrase", "..."],
  "findings": [
    { "severity": "low"|"medium"|"high", "title": "short", "plainExplanation": "what it means in plain words", "likelyRealBug": true|false, "suggestedFix": "optional" }
  ],
  "recommendation": "one sentence on what to do next"
}

Rules for the verdict:
- "all-green": every test passed.
- "found-issues": tests ran and at least one failed BECAUSE it caught a likely real bug in the source (set that finding's likelyRealBug=true).
- "cant-run": the suite could not compile/run (environment/setup), so we learned nothing yet (likelyRealBug=false).
Distinguish a failing test that found a real bug from a test that was simply written wrong.`;

    const raw = await this.complete(prompt, provider, apiKey);
    const parsed = this.parseExplanation(raw);
    if (parsed) { return parsed; }

    // Fallback if the model didn't return clean JSON.
    if (result.status === 'passed') {
      return {
        verdict: 'all-green',
        plainSummary: 'All generated tests passed. The code behaved as expected for every scenario we tried, including edge cases.',
        whatWeTested: ['Normal behavior', 'Edge cases', 'Stress/repetition'],
        findings: [],
        recommendation: 'Looks good. You can save these tests into your project.',
      };
    }
    const cantRun = result.status === 'error' || /compil|cannot find|no module|syntaxerror|build failed/i.test(result.output || '');
    return {
      verdict: cantRun ? 'cant-run' : 'found-issues',
      plainSummary: cantRun
        ? 'We could not finish running the tests due to a setup/compile problem, so the results are inconclusive.'
        : 'Some tests did not pass. This may mean the code has a real problem with certain inputs.',
      whatWeTested: ['Normal behavior', 'Edge cases', 'Stress/repetition'],
      findings: [{
        severity: 'medium',
        title: result.failureReason || 'Test run did not pass',
        plainExplanation: (result.failureSummary || result.output || '').slice(0, 600) || 'See the full console output below.',
        likelyRealBug: !cantRun,
      }],
      recommendation: cantRun ? 'Check the console output for the setup error.' : 'Review the failing scenarios — they may point to a real bug.',
    };
  }

  private parseExplanation(raw: string): TestExplanation | null {
    if (!raw) { return null; }
    let s = this.stripFences(raw).trim();
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) { return null; }
    s = s.slice(first, last + 1);
    try {
      const obj = JSON.parse(s);
      if (!obj || typeof obj.plainSummary !== 'string') { return null; }
      const verdict = ['all-green', 'found-issues', 'cant-run'].includes(obj.verdict) ? obj.verdict : 'found-issues';
      return {
        verdict,
        plainSummary: obj.plainSummary,
        whatWeTested: Array.isArray(obj.whatWeTested) ? obj.whatWeTested.map(String) : [],
        findings: Array.isArray(obj.findings) ? obj.findings.map((f: any) => ({
          severity: ['low', 'medium', 'high'].includes(f?.severity) ? f.severity : 'medium',
          title: String(f?.title || 'Finding'),
          plainExplanation: String(f?.plainExplanation || ''),
          likelyRealBug: Boolean(f?.likelyRealBug),
          suggestedFix: f?.suggestedFix ? String(f.suggestedFix) : undefined,
        })) : [],
        recommendation: String(obj.recommendation || ''),
      };
    } catch {
      return null;
    }
  }

  // ── Output post-processing (slim, safe only) ────────────────────────────────

  private stripFences(raw: string): string {
    return raw.replace(/^```[\w]*\n?/gm, '').replace(/```$/gm, '').trim();
  }

  private lightValidate(content: string, profile: LanguageProfile, sourceFilePath: string): string {
    let out = content;
    const base = baseNameNoExt(sourceFilePath);

    if (profile.id === 'typescript' || profile.id === 'javascript') {
      // Correct the import/require/mock path of the source file to './<base>'.
      const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const expected = `./${base}`;
      out = out.replace(new RegExp(`(from\\s+['"])(?:[^'"]*\\/)?${escaped}(?:\\.[a-zA-Z0-9]+)?(['"])`, 'g'), `$1${expected}$2`);
      out = out.replace(new RegExp(`(require\\(\\s*['"])(?:[^'"]*\\/)?${escaped}(?:\\.[a-zA-Z0-9]+)?(['"]\\s*\\))`, 'g'), `$1${expected}$2`);
      out = out.replace(new RegExp(`((?:jest|vi)\\.mock\\(\\s*['"])(?:[^'"]*\\/)?${escaped}(?:\\.[a-zA-Z0-9]+)?(['"])`, 'g'), `$1${expected}$2`);
      // Normalize vitest API → jest (sandbox runs jest).
      out = out.replace(/from\s+['"]vitest['"]/g, "from '@jest/globals'");
      out = out.replace(/\bvi\.(fn|mock|spyOn|clearAllMocks|resetAllMocks|restoreAllMocks|useFakeTimers|useRealTimers|advanceTimersByTime|resetModules)\b/g, 'jest.$1');
      out = this.injectTimeouts(out);
    } else if (profile.id === 'python') {
      // Strip a leading-dot relative import of the source module (flat sandbox).
      out = out.replace(new RegExp(`from\\s+\\.+${base}\\s+import`, 'g'), `from ${base} import`);
      if (!/^\s*import\s+pytest/m.test(out)) { out = 'import pytest\n' + out; }
    }
    // Other languages: trust the model + the repair loop. No risky surgery.
    return out;
  }

  private injectTimeouts(content: string): string {
    let result = '';
    let i = 0;
    while (i < content.length) {
      if ((content.startsWith('it(', i) || content.startsWith('test(', i)) && (i === 0 || !/[a-zA-Z0-9_$]/.test(content[i - 1]))) {
        const isIt = content.startsWith('it(', i);
        const startIdx = i;
        i += isIt ? 3 : 5;
        let parenDepth = 1, braceDepth = 0;
        let inString: string | null = null;
        const argCommas: number[] = [];
        let j = i;
        while (j < content.length && parenDepth > 0) {
          const char = content[j];
          if (inString) {
            if (char === '\\') { j += 2; continue; }
            if (char === inString) { inString = null; }
          } else {
            if (char === '"' || char === "'" || char === '`') { inString = char; }
            else if (char === '(') { parenDepth++; }
            else if (char === ')') { parenDepth--; if (parenDepth === 0) { break; } }
            else if (char === '{') { braceDepth++; }
            else if (char === '}') { braceDepth--; }
            else if (char === ',' && parenDepth === 1 && braceDepth === 0) { argCommas.push(j); }
          }
          j++;
        }
        if (parenDepth === 0 && j < content.length && argCommas.length === 1) {
          const beforeParen = content.slice(startIdx, j).trim();
          if (beforeParen.endsWith('}')) {
            result += content.slice(startIdx, j) + ', 10000)';
            i = j + 1;
            continue;
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

  private splitTiers(content: string): { normal: string; edgeCase: string; stress: string } {
    const normalMatch = content.match(/[\/#*]+\s*(?:TIER\s*1|NORMAL|Happy\s*Path)[\s\S]*?(?=[\/#*]+\s*(?:TIER\s*2|EDGE)|$)/i);
    const edgeMatch = content.match(/[\/#*]+\s*(?:TIER\s*2|EDGE\s*CASE)[\s\S]*?(?=[\/#*]+\s*(?:TIER\s*3|STRESS)|$)/i);
    const stressMatch = content.match(/[\/#*]+\s*(?:TIER\s*3|STRESS)[\s\S]*/i);
    return {
      normal: normalMatch?.[0]?.trim() || (normalMatch || edgeMatch || stressMatch ? '' : content),
      edgeCase: edgeMatch?.[0]?.trim() || 'No edge-case tier detected.',
      stress: stressMatch?.[0]?.trim() || 'No stress tier detected.',
    };
  }

  // ── Provider plumbing ──────────────────────────────────────────────────────

  private async complete(prompt: string, provider: string, apiKey: string | undefined): Promise<string> {
    if (provider === 'copilot') { return this.generateViaCopilot(prompt); }
    if (provider === 'ollama') {
      const cfg = await this.secretManager.getOllamaConfigWithKey();
      return this.generateViaOllama(prompt, cfg);
    }
    return this.generateViaSidecar(prompt, provider, apiKey!);
  }

  private async generateViaCopilot(prompt: string): Promise<string> {
    try {
      const model = await selectBestCopilotModel();
      const messages = [vscode.LanguageModelChatMessage.User(prompt)];
      const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
      let full = '';
      for await (const chunk of response.text) { full += chunk; }
      return full;
    } catch (err: any) {
      this.outputChannel.appendLine(`Copilot error: ${err.message}`);
      vscode.window.showErrorMessage(`Test generation failed: ${err.message}`);
      return '';
    }
  }

  private async generateViaSidecar(prompt: string, provider: string, apiKey: string): Promise<string> {
    try {
      const result = await this.dockerManager.postToSidecar<{ response: string }>('/ai-complete', { prompt, provider, apiKey });
      return result.response;
    } catch (err: any) {
      this.outputChannel.appendLine(`Sidecar AI error: ${err.message}`);
      return '';
    }
  }

  private async generateViaOllama(prompt: string, cfg: { baseUrl: string; model: string }): Promise<string> {
    return new Promise((resolve) => {
      const body = JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }], stream: false });
      const urlStr = cfg.baseUrl.replace(/\/$/, '') + '/api/chat';
      let urlObj: URL;
      try { urlObj = new URL(urlStr); }
      catch {
        vscode.window.showErrorMessage(`Automated QA — Ollama: invalid base URL "${cfg.baseUrl}".`);
        resolve(''); return;
      }
      const useHttps = urlObj.protocol === 'https:';
      const lib = useHttps ? https : http;
      const req = lib.request({
        hostname: urlObj.hostname,
        port: urlObj.port || (useHttps ? 443 : 80),
        path: urlObj.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 180000,
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            vscode.window.showErrorMessage(`Automated QA — Ollama HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
            resolve(''); return;
          }
          try {
            const parsed = JSON.parse(data);
            resolve(parsed?.message?.content || parsed?.response || '');
          } catch { resolve(''); }
        });
      });
      req.on('error', (e) => {
        vscode.window.showErrorMessage(`Automated QA — cannot reach Ollama at ${cfg.baseUrl}. Is it running?`);
        this.outputChannel.appendLine(`Ollama error: ${e.message}`);
        resolve('');
      });
      req.on('timeout', () => { req.destroy(); vscode.window.showErrorMessage('Automated QA — Ollama request timed out.'); resolve(''); });
      req.write(body);
      req.end();
    });
  }

  // ── Small helpers ───────────────────────────────────────────────────────────

  private isGeneratedTestFile(filePath: string): boolean {
    const base = path.basename(filePath);
    return /\.qa\.test\.(?:ts|tsx|js|jsx)$/i.test(base) ||
      /^test_.*_qa\.py$/i.test(base) ||
      /_qa_test\.(?:go|rs|c|cpp|cc|cxx)$/i.test(base) ||
      /QaTest\.java$/.test(base);
  }

  private readIfExists(filePath: string): string {
    try { return filePath && fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : ''; }
    catch { return ''; }
  }

  // eslint-disable-next-line no-control-regex
  private static readonly ANSI = /[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

  private stripAnsi(str: string): string {
    return str.replace(TestArchitect.ANSI, '');
  }
}
