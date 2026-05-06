import * as vscode from 'vscode';
import { SemanticReviewer } from './semanticReviewer';
import { TestArchitect } from './testArchitect';
import { VisualQAEngine } from './visualQAEngine';
import { PRReadinessTracker } from './prReadinessTracker';
import { SecretManager } from './secretManager';
import { DockerManager } from './dockerManager';
import { selectBestCopilotModel } from './copilotModelSelector';

export type PipelineStage = 'idle' | 'reviewing' | 'generating-tests' | 'running-tests' | 'visual-check' | 'commit-message' | 'done' | 'error';

export interface PipelineStatus {
  stage: PipelineStage;
  progress: number; // 0-100
  message: string;
  commitMessage?: string;
  error?: string;
}

export class PRAutomator {
  private semanticReviewer: SemanticReviewer;
  private testArchitect: TestArchitect;
  private visualQAEngine: VisualQAEngine;
  private readinessTracker: PRReadinessTracker;
  private secretManager: SecretManager;
  private dockerManager: DockerManager;
  private outputChannel: vscode.OutputChannel;
  private _status: PipelineStatus = { stage: 'idle', progress: 0, message: 'Ready' };
  private _onStatusChanged = new vscode.EventEmitter<PipelineStatus>();
  readonly onStatusChanged = this._onStatusChanged.event;

  constructor(
    semanticReviewer: SemanticReviewer,
    testArchitect: TestArchitect,
    visualQAEngine: VisualQAEngine,
    readinessTracker: PRReadinessTracker,
    secretManager: SecretManager,
    dockerManager: DockerManager,
    outputChannel: vscode.OutputChannel
  ) {
    this.semanticReviewer = semanticReviewer;
    this.testArchitect = testArchitect;
    this.visualQAEngine = visualQAEngine;
    this.readinessTracker = readinessTracker;
    this.secretManager = secretManager;
    this.dockerManager = dockerManager;
    this.outputChannel = outputChannel;
  }

  get status(): PipelineStatus {
    return this._status;
  }

  private updateStatus(stage: PipelineStage, progress: number, message: string, extra?: Partial<PipelineStatus>) {
    this._status = { stage, progress, message, ...extra };
    this._onStatusChanged.fire(this._status);
  }

  async run(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active file for PR automation.');
      return;
    }

    const filePath = editor.document.uri.fsPath;

    try {
      // Stage 1: Semantic Review
      this.updateStatus('reviewing', 10, 'Running semantic review...');
      const findings = await this.semanticReviewer.reviewActiveFile();
      const highSeverity = findings.filter(f => f.confidence === 'HIGH' && f.severity === 'error');
      if (highSeverity.length > 0) {
        this.updateStatus('reviewing', 20, `Found ${highSeverity.length} high-severity issues. Review recommended.`);
      }
      this.readinessTracker.markReviewed(filePath);

      // Stage 2: Generate Tests
      this.updateStatus('generating-tests', 30, 'Generating test suite...');
      const tests = await this.testArchitect.generateForSelection();
      if (!tests) {
        this.updateStatus('generating-tests', 40, 'Test generation skipped (no testable code detected).');
      }

      // Stage 3: Run Tests
      if (tests) {
        this.updateStatus('running-tests', 50, 'Running tests (including stress tier)...');
        const output = await this.testArchitect.runTests(tests.filePath);
        this.outputChannel.appendLine(`Pipeline test output: ${output}`);
      }
      this.readinessTracker.markTested(filePath);

      // Stage 4: Visual QA (optional — only if Docker is running)
      if (this.dockerManager.isStackRunning) {
        this.updateStatus('visual-check', 70, 'Running visual regression check...');
        // Use configured URLs or skip
        const config = vscode.workspace.getConfiguration('automatedqa');
        const localUrl = config.get<string>('localUrl');
        const prodUrl = config.get<string>('productionUrl');

        if (localUrl && prodUrl) {
          await this.visualQAEngine.run(localUrl, prodUrl);
          this.readinessTracker.markVisualChecked(filePath);
        } else {
          this.updateStatus('visual-check', 75, 'Visual QA skipped (no URLs configured).');
        }
      } else {
        this.updateStatus('visual-check', 75, 'Visual QA skipped (Docker not running).');
      }

      // Stage 5: Generate Commit Message
      this.updateStatus('commit-message', 85, 'Generating semantic commit message...');
      const commitMessage = await this.generateCommitMessage(filePath, findings, tests);
      
      this.updateStatus('done', 100, 'PR pre-flight complete! ✅', { commitMessage });
      vscode.window.showInformationMessage('Automated QA: Pre-flight check complete!');

    } catch (err: any) {
      this.updateStatus('error', 0, `Pipeline error: ${err.message}`, { error: err.message });
      this.outputChannel.appendLine(`Pipeline error: ${err.message}`);
      vscode.window.showErrorMessage(`PR Automation failed: ${err.message}`);
    }
  }

  private async generateCommitMessage(filePath: string, findings: any[], tests: any): Promise<string> {
    let provider: string;
    let apiKey: string | undefined;
    try {
      const result = await this.secretManager.getActiveKeyIfNeeded();
      provider = result.provider;
      apiKey = result.apiKey;
    } catch (err: any) {
      this.outputChannel.appendLine(`Provider error in commit message generation: ${err.message}`);
      return 'chore: automated QA pre-flight check';
    }

    const prompt = `Generate a semantic commit message for the following changes.

File: ${filePath}
Review findings: ${findings.length} issues found (${findings.filter((f: any) => f.severity === 'error').length} errors, ${findings.filter((f: any) => f.severity === 'warning').length} warnings)
Tests generated: ${tests ? 'Yes (3-tier)' : 'No'}

Use the format: type(scope): description

Where type is one of: feat, fix, refactor, test, docs, chore, perf, style
Scope should be derived from the file path.
Description should be concise and descriptive.

Return ONLY the commit message, nothing else.`;

    if (provider === 'copilot') {
      try {
        const model = await selectBestCopilotModel();
        const messages = [vscode.LanguageModelChatMessage.User(prompt)];
        const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
        let result = '';
        for await (const chunk of response.text) { result += chunk; }
        return result.trim();
      } catch {
        return 'chore: automated QA pre-flight check';
      }
    } else {
      try {
        const result = await this.dockerManager.postToSidecar<{ response: string }>('/ai-complete', {
          prompt, provider, apiKey,
        });
        return result.response.trim();
      } catch {
        return 'chore: automated QA pre-flight check';
      }
    }
  }
}
