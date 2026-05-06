import * as vscode from 'vscode';
import { SecretManager } from './secretManager';
import { WorkspaceIndexer } from './workspaceIndexer';
import { DockerManager } from './dockerManager';

export interface ReviewFinding {
  file: string;
  line: number;
  endLine?: number;
  severity: 'error' | 'warning' | 'info';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  category: 'logic' | 'architecture' | 'security' | 'performance';
  title: string;
  description: string;
  suggestion?: string;
}

export class SemanticReviewer {
  private secretManager: SecretManager;
  private workspaceIndexer: WorkspaceIndexer;
  private dockerManager: DockerManager;
  private outputChannel: vscode.OutputChannel;
  private diagnosticCollection: vscode.DiagnosticCollection;
  private _findings: ReviewFinding[] = [];
  private _onFindingsChanged = new vscode.EventEmitter<ReviewFinding[]>();
  readonly onFindingsChanged = this._onFindingsChanged.event;

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
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection('automated-qa');
  }

  get findings(): ReviewFinding[] {
    return this._findings;
  }

  async reviewActiveFile(): Promise<ReviewFinding[]> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active file to review.');
      return [];
    }

    const ctx = await this.workspaceIndexer.getContext();
    const { provider, apiKey } = await this.secretManager.getActiveKeyIfNeeded();

    this.outputChannel.appendLine(`Running semantic review on ${ctx.activeFilePath} using ${provider}...`);

    const prompt = this.buildReviewPrompt(ctx);

    let findings: ReviewFinding[];

    if (provider === 'copilot') {
      findings = await this.reviewViaCopilot(prompt, ctx.activeFilePath);
    } else {
      findings = await this.reviewViaSidecar(prompt, provider, apiKey!, ctx.activeFilePath);
    }

    this._findings = findings;
    this.pushDiagnostics(findings, editor.document.uri);
    this._onFindingsChanged.fire(findings);

    this.outputChannel.appendLine(`Review complete. Found ${findings.length} issues.`);
    return findings;
  }

  private buildReviewPrompt(ctx: any): string {
    return `You are a Senior Principal Engineer performing a deep code review.

**File under review:** ${ctx.activeFilePath}
**Project:** ${ctx.projectName} (${ctx.language}, test framework: ${ctx.testFramework})

**Adjacent files for context:**
${ctx.adjacentSnippets.map((s: any) => `--- ${s.path} ---\n${s.content}`).join('\n')}

**Code to review:**
\`\`\`
${ctx.activeFileContent}
\`\`\`

Perform a thorough review checking for:
1. **Logic Flaws**: Race conditions, infinite loops, off-by-one errors, nested loops with high complexity.
2. **Architectural Drift**: Does the code follow patterns established in adjacent files? Inconsistent naming, structure, or patterns.
3. **Security**: Hardcoded secrets, SQL injection, XSS vulnerabilities, unsafe eval/exec.
4. **Performance**: O(n²) or worse algorithms, memory leaks, unnecessary re-renders.

For EACH finding, respond with EXACTLY this JSON array format:
[
  {
    "line": <line_number>,
    "endLine": <end_line_number_or_null>,
    "severity": "error" | "warning" | "info",
    "confidence": "HIGH" | "MEDIUM" | "LOW",
    "category": "logic" | "architecture" | "security" | "performance",
    "title": "<short title>",
    "description": "<detailed explanation>",
    "suggestion": "<how to fix>"
  }
]

If the AI is unsure about a finding, mark it as "LOW" confidence rather than omitting it.
If no issues are found, return an empty array: []
Return ONLY the JSON array, no other text.`;
  }

  private async reviewViaCopilot(prompt: string, filePath: string): Promise<ReviewFinding[]> {
    try {
      const models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
      const model = models[0];
      if (!model) {
        vscode.window.showErrorMessage('No Copilot model available. Please install GitHub Copilot.');
        return [];
      }

      const messages = [vscode.LanguageModelChatMessage.User(prompt)];
      const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

      let fullResponse = '';
      for await (const chunk of response.text) {
        fullResponse += chunk;
      }

      return this.parseFindings(fullResponse, filePath);
    } catch (err: any) {
      this.outputChannel.appendLine(`Copilot review error: ${err.message}`);
      vscode.window.showErrorMessage(`Review failed: ${err.message}`);
      return [];
    }
  }

  private async reviewViaSidecar(
    prompt: string,
    provider: string,
    apiKey: string,
    filePath: string
  ): Promise<ReviewFinding[]> {
    try {
      const result = await this.dockerManager.postToSidecar<{ response: string }>('/ai-complete', {
        prompt,
        provider,
        apiKey,
      });
      return this.parseFindings(result.response, filePath);
    } catch (err: any) {
      this.outputChannel.appendLine(`Sidecar review error: ${err.message}`);
      vscode.window.showErrorMessage(`Review failed: ${err.message}`);
      return [];
    }
  }

  private parseFindings(raw: string, filePath: string): ReviewFinding[] {
    try {
      // Extract JSON from possible markdown code blocks
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) { return []; }

      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.map((f: any) => ({
        file: filePath,
        line: f.line || 1,
        endLine: f.endLine || f.line || 1,
        severity: f.severity || 'info',
        confidence: f.confidence || 'LOW',
        category: f.category || 'logic',
        title: f.title || 'Issue found',
        description: f.description || '',
        suggestion: f.suggestion || '',
      }));
    } catch (err) {
      this.outputChannel.appendLine(`Failed to parse review findings: ${err}`);
      return [];
    }
  }

  private pushDiagnostics(findings: ReviewFinding[], uri: vscode.Uri): void {
    const diagnostics: vscode.Diagnostic[] = findings.map((f) => {
      const range = new vscode.Range(
        new vscode.Position(Math.max(0, f.line - 1), 0),
        new vscode.Position(Math.max(0, (f.endLine || f.line) - 1), Number.MAX_SAFE_INTEGER)
      );

      const severity =
        f.severity === 'error' ? vscode.DiagnosticSeverity.Error :
        f.severity === 'warning' ? vscode.DiagnosticSeverity.Warning :
        vscode.DiagnosticSeverity.Information;

      const diag = new vscode.Diagnostic(range, `[${f.confidence}] ${f.title}: ${f.description}`, severity);
      diag.source = 'Automated QA';
      diag.code = f.category;
      return diag;
    });

    this.diagnosticCollection.set(uri, diagnostics);
  }

  clearFindings(): void {
    this._findings = [];
    this.diagnosticCollection.clear();
    this._onFindingsChanged.fire([]);
  }
}
