import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { SecretManager } from './secretManager';
import { WorkspaceIndexer } from './workspaceIndexer';
import { DockerManager } from './dockerManager';
import { selectBestCopilotModel } from './copilotModelSelector';

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

/**
 * Discriminated result envelope — callers and the UI can distinguish
 * between "clean file", "found issues", "LLM output was unparseable",
 * and "the call itself failed".
 */
export type ReviewResultKind =
  | 'no-issues'      // LLM returned [] or CLEAN_FILE — code looks good
  | 'findings'       // parsed 1+ structured findings
  | 'parse-failure'  // LLM responded but the JSON was malformed / missing
  | 'runtime-error'; // provider/network error — never reached the LLM

export interface ReviewResult {
  kind: ReviewResultKind;
  findings: ReviewFinding[];
  /** Human-readable summary shown in the UI status bar */
  summary: string;
  /** The raw LLM output — only set on parse-failure so users can debug */
  rawOutput?: string;
  reviewedFile?: string;
  timestamp: number;
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

  private _onReviewResult = new vscode.EventEmitter<ReviewResult>();
  readonly onReviewResult = this._onReviewResult.event;

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

    // Signal "reviewing in progress" immediately
    this._onReviewResult.fire({
      kind: 'no-issues',
      findings: [],
      summary: `Reviewing ${ctx.activeFilePath}…`,
      reviewedFile: ctx.activeFilePath,
      timestamp: Date.now(),
    });

    let provider: string;
    let apiKey: string | undefined;
    try {
      const result = await this.secretManager.getActiveKeyIfNeeded();
      provider = result.provider;
      apiKey = result.apiKey;
    } catch (err: any) {
      this.outputChannel.appendLine(`Provider error: ${err.message}`);
      vscode.window.showErrorMessage(`Automated QA — Provider Error: ${err.message}`);
      const errorResult: ReviewResult = {
        kind: 'runtime-error',
        findings: [],
        summary: `Provider error: ${err.message}`,
        reviewedFile: ctx.activeFilePath,
        timestamp: Date.now(),
      };
      this._onReviewResult.fire(errorResult);
      this._onFindingsChanged.fire([]);
      return [];
    }

    this.outputChannel.appendLine(`Running semantic review on ${ctx.activeFilePath} using ${provider}...`);

    const prompt = this.buildReviewPrompt(ctx);
    let result: ReviewResult;

    if (provider === 'copilot') {
      result = await this.reviewViaCopilot(prompt, ctx.activeFilePath);
    } else if (provider === 'ollama') {
      const ollamaCfg = await this.secretManager.getOllamaConfigWithKey();
      result = await this.reviewViaOllama(prompt, ctx.activeFilePath, ollamaCfg);
    } else {
      result = await this.reviewViaSidecar(prompt, provider, apiKey!, ctx.activeFilePath);
    }

    this._findings = result.findings;
    this.pushDiagnostics(result.findings, editor.document.uri);
    this._onFindingsChanged.fire(result.findings);
    this._onReviewResult.fire(result);

    // Surface clear result in the output channel
    this.outputChannel.appendLine(
      `Review complete [${result.kind}]: ${result.summary}`
    );
    if (result.kind === 'parse-failure') {
      this.outputChannel.appendLine(`--- Raw LLM output ---\n${result.rawOutput}\n--- End ---`);
    }

    return result.findings;
  }

  private buildReviewPrompt(ctx: any): string {
    // Keep file content under ~8000 chars to avoid LLMs dropping the JSON format
    const maxContentChars = 8000;
    const content = ctx.activeFileContent?.length > maxContentChars
      ? ctx.activeFileContent.slice(0, maxContentChars) + '\n\n[... file truncated for length ...]'
      : ctx.activeFileContent;

    const adjacentContext = ctx.adjacentSnippets?.length > 0
      ? ctx.adjacentSnippets
          .slice(0, 3)
          .map((s: any) => `--- ${s.path} ---\n${(s.content || '').slice(0, 1000)}`)
          .join('\n')
      : '(none)';

    return `You are a Senior Principal Engineer performing a deep, actionable code review.

FILE: ${ctx.activeFilePath}
PROJECT: ${ctx.projectName} (language: ${ctx.language}, test framework: ${ctx.testFramework})

ADJACENT FILES FOR CONTEXT:
${adjacentContext}

CODE TO REVIEW:
\`\`\`
${content}
\`\`\`

REVIEW CHECKLIST:
1. Logic flaws — race conditions, infinite loops, off-by-one errors, unreachable branches.
2. Architecture — does this code follow the patterns in adjacent files? Naming, structure, coupling.
3. Security — hardcoded secrets, injection risks, unsafe eval/exec, missing input validation.
4. Performance — O(n²)+ algorithms, memory leaks, unnecessary allocations, blocking calls.

OUTPUT RULES (CRITICAL — non-compliance makes your response useless):
- If you find issues, respond with ONLY a valid JSON array. No prose, no markdown, no code fences.
- If the file is clean, respond with exactly: []
- Do NOT wrap the array in \`\`\`json ... \`\`\` fences.
- Do NOT add any text before or after the JSON array.
- Every finding MUST include all fields shown below.

JSON FORMAT (repeat for each finding):
[
  {
    "line": <integer — first affected line>,
    "endLine": <integer or null>,
    "severity": "error" | "warning" | "info",
    "confidence": "HIGH" | "MEDIUM" | "LOW",
    "category": "logic" | "architecture" | "security" | "performance",
    "title": "<10 words max>",
    "description": "<what is wrong and why it matters>",
    "suggestion": "<concrete fix — code snippet preferred>"
  }
]`;
  }

  // ─── LLM backends ────────────────────────────────────────────────────────────

  private async reviewViaCopilot(prompt: string, filePath: string): Promise<ReviewResult> {
    try {
      const model = await selectBestCopilotModel();

      const messages = [vscode.LanguageModelChatMessage.User(prompt)];
      const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

      let raw = '';
      for await (const chunk of response.text) {
        raw += chunk;
      }

      return this.buildResult(raw, filePath, 'copilot');
    } catch (err: any) {
      this.outputChannel.appendLine(`Copilot review error: ${err.message}`);
      vscode.window.showErrorMessage(`Review failed: ${err.message}`);
      return this.runtimeError(filePath, err.message);
    }
  }

  private async reviewViaOllama(
    prompt: string,
    filePath: string,
    cfg: { baseUrl: string; model: string; apiKey?: string }
  ): Promise<ReviewResult> {
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
        const msg = `Invalid Ollama base URL: "${cfg.baseUrl}"`;
        this.outputChannel.appendLine(msg);
        vscode.window.showErrorMessage(`Automated QA — Ollama Error: ${msg}. Update it in Settings tab.`);
        resolve(this.runtimeError(filePath, msg));
        return;
      }

      const useHttps = urlObj.protocol === 'https:';
      const lib = useHttps ? https : http;
      const headers: Record<string, string | number> = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      };
      if (cfg.apiKey) { headers['Authorization'] = `Bearer ${cfg.apiKey}`; }

      const req = lib.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port || (useHttps ? 443 : 80),
          path: urlObj.pathname,
          method: 'POST',
          headers,
          timeout: 120000,
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 400) {
              const detail = data.slice(0, 200);
              this.outputChannel.appendLine(`Ollama HTTP ${res.statusCode}: ${detail}`);
              vscode.window.showErrorMessage(`Automated QA — Ollama HTTP ${res.statusCode}: ${detail}`);
              resolve(this.runtimeError(filePath, `HTTP ${res.statusCode}: ${detail}`));
              return;
            }
            try {
              const parsed = JSON.parse(data);
              const content = parsed?.message?.content || parsed?.response || '';
              resolve(this.buildResult(content, filePath, `ollama/${cfg.model}`));
            } catch (e) {
              this.outputChannel.appendLine(`Failed to parse Ollama envelope: ${e}`);
              resolve(this.runtimeError(filePath, `Ollama returned non-JSON envelope: ${String(e)}`));
            }
          });
        }
      );
      req.on('error', (e) => {
        this.outputChannel.appendLine(`Ollama connection error: ${e.message}`);
        vscode.window.showErrorMessage(
          `Automated QA — Cannot reach Ollama at ${cfg.baseUrl}. Is the server running? (${e.message})`
        );
        resolve(this.runtimeError(filePath, `Cannot connect to Ollama: ${e.message}`));
      });
      req.on('timeout', () => {
        req.destroy();
        vscode.window.showErrorMessage(
          `Automated QA — Ollama request timed out (120s). Model: ${cfg.model}. Try a smaller/faster model.`
        );
        resolve(this.runtimeError(filePath, `Ollama timeout (120s) — model: ${cfg.model}`));
      });
      req.write(body);
      req.end();
    });
  }

  private async reviewViaSidecar(
    prompt: string,
    provider: string,
    apiKey: string,
    filePath: string
  ): Promise<ReviewResult> {
    try {
      const result = await this.dockerManager.postToSidecar<{ response: string }>('/ai-complete', {
        prompt,
        provider,
        apiKey,
      });
      return this.buildResult(result.response, filePath, provider);
    } catch (err: any) {
      this.outputChannel.appendLine(`Sidecar review error: ${err.message}`);
      vscode.window.showErrorMessage(`Review failed: ${err.message}`);
      return this.runtimeError(filePath, err.message);
    }
  }

  // ─── Result building ─────────────────────────────────────────────────────────

  /**
   * Converts a raw LLM string into a typed ReviewResult.
   * Carefully handles:
   *  - Markdown code fences (```json ... ```)
   *  - Prose preamble before the JSON array
   *  - The special CLEAN_FILE sentinel
   *  - Completely non-JSON responses (parse-failure)
   */
  private buildResult(raw: string, filePath: string, source: string): ReviewResult {
    const ts = Date.now();
    const trimmed = raw.trim();

    // Strip markdown fences (```json ... ``` or ``` ... ```)
    const stripped = trimmed
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();

    // Detect clean-file signals
    if (
      stripped === '[]' ||
      stripped === '' ||
      /clean[_\s-]?file/i.test(stripped) ||
      /no\s+issues?\s+found/i.test(stripped)
    ) {
      return {
        kind: 'no-issues',
        findings: [],
        summary: `✅ No issues found in ${this.basename(filePath)}`,
        reviewedFile: filePath,
        timestamp: ts,
      };
    }

    // Try to extract the JSON array — allow prose before/after
    const jsonMatch = stripped.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      this.outputChannel.appendLine(`[${source}] No JSON array found in response. Raw output logged.`);
      return {
        kind: 'parse-failure',
        findings: [],
        summary: `⚠️ Review ran but the response could not be parsed as findings. Check the Output channel for the raw response.`,
        rawOutput: trimmed.slice(0, 2000),
        reviewedFile: filePath,
        timestamp: ts,
      };
    }

    try {
      const parsed: any[] = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) { throw new Error('Not an array'); }

      if (parsed.length === 0) {
        return {
          kind: 'no-issues',
          findings: [],
          summary: `✅ No issues found in ${this.basename(filePath)}`,
          reviewedFile: filePath,
          timestamp: ts,
        };
      }

      const findings: ReviewFinding[] = parsed.map((f: any) => ({
        file: filePath,
        line: Math.max(1, Number(f.line) || 1),
        endLine: f.endLine ? Math.max(1, Number(f.endLine)) : undefined,
        severity: this.sanitizeSeverity(f.severity),
        confidence: this.sanitizeConfidence(f.confidence),
        category: this.sanitizeCategory(f.category),
        title: String(f.title || 'Issue found').slice(0, 120),
        description: String(f.description || '').slice(0, 800),
        suggestion: f.suggestion ? String(f.suggestion).slice(0, 800) : undefined,
      }));

      const errors = findings.filter(f => f.severity === 'error').length;
      const warnings = findings.filter(f => f.severity === 'warning').length;
      const infos = findings.filter(f => f.severity === 'info').length;
      const parts: string[] = [];
      if (errors) { parts.push(`${errors} error${errors > 1 ? 's' : ''}`); }
      if (warnings) { parts.push(`${warnings} warning${warnings > 1 ? 's' : ''}`); }
      if (infos) { parts.push(`${infos} info`); }

      return {
        kind: 'findings',
        findings,
        summary: `Found ${parts.join(', ')} in ${this.basename(filePath)}`,
        reviewedFile: filePath,
        timestamp: ts,
      };
    } catch (err) {
      this.outputChannel.appendLine(`[${source}] JSON parse error: ${err}\nRaw: ${jsonMatch[0].slice(0, 500)}`);
      return {
        kind: 'parse-failure',
        findings: [],
        summary: `⚠️ Review ran but the JSON findings could not be parsed. Check the Output channel.`,
        rawOutput: trimmed.slice(0, 2000),
        reviewedFile: filePath,
        timestamp: ts,
      };
    }
  }

  private runtimeError(filePath: string, message: string): ReviewResult {
    return {
      kind: 'runtime-error',
      findings: [],
      summary: `❌ Review failed: ${message}`,
      reviewedFile: filePath,
      timestamp: Date.now(),
    };
  }

  private basename(p: string): string {
    return p.split(/[\\/]/).pop() || p;
  }

  private sanitizeSeverity(v: any): 'error' | 'warning' | 'info' {
    if (v === 'error' || v === 'warning' || v === 'info') { return v; }
    return 'info';
  }

  private sanitizeConfidence(v: any): 'HIGH' | 'MEDIUM' | 'LOW' {
    if (v === 'HIGH' || v === 'MEDIUM' || v === 'LOW') { return v; }
    return 'LOW';
  }

  private sanitizeCategory(v: any): 'logic' | 'architecture' | 'security' | 'performance' {
    if (v === 'logic' || v === 'architecture' || v === 'security' || v === 'performance') { return v; }
    return 'logic';
  }

  // ─── Diagnostics ─────────────────────────────────────────────────────────────

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

      const diag = new vscode.Diagnostic(
        range,
        `[${f.confidence}] ${f.title}: ${f.description}`,
        severity
      );
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
