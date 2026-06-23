import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { DockerManager } from './dockerManager';
import { SecretManager } from './secretManager';
import { SemanticReviewer } from './semanticReviewer';
import { TestArchitect } from './testArchitect';
import { VisualQAEngine } from './visualQAEngine';
import { PRAutomator } from './prAutomator';
import { PRReadinessTracker } from './prReadinessTracker';
import { WorkspaceIndexer } from './workspaceIndexer';
import { listAvailableModelNames } from './copilotModelSelector';

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private extensionUri: vscode.Uri;
  private dockerManager: DockerManager;
  private secretManager: SecretManager;
  private semanticReviewer: SemanticReviewer;
  private testArchitect: TestArchitect;
  private visualQAEngine: VisualQAEngine;
  private prAutomator: PRAutomator;
  private readinessTracker: PRReadinessTracker;
  private workspaceIndexer: WorkspaceIndexer;
  private _dockerStatus = false;

  constructor(
    extensionUri: vscode.Uri,
    dockerManager: DockerManager,
    secretManager: SecretManager,
    semanticReviewer: SemanticReviewer,
    testArchitect: TestArchitect,
    visualQAEngine: VisualQAEngine,
    prAutomator: PRAutomator,
    readinessTracker: PRReadinessTracker,
    workspaceIndexer: WorkspaceIndexer
  ) {
    this.extensionUri = extensionUri;
    this.dockerManager = dockerManager;
    this.secretManager = secretManager;
    this.semanticReviewer = semanticReviewer;
    this.testArchitect = testArchitect;
    this.visualQAEngine = visualQAEngine;
    this.prAutomator = prAutomator;
    this.readinessTracker = readinessTracker;
    this.workspaceIndexer = workspaceIndexer;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void | Thenable<void> {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    // Listen for messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      try {
        await this.handleMessage(message);
      } catch (err: any) {
        const messageText = this.getErrorMessage(err);
        this.postMessage({
          type: 'operationError',
          data: {
            command: message?.command || 'unknown',
            message: messageText,
          },
        });
        vscode.window.showErrorMessage(`Automated QA: ${messageText}`);
      }
    });

    // Listen for engine events
    this.semanticReviewer.onFindingsChanged((findings) => {
      this.postMessage({ type: 'reviewFindings', data: findings });
    });

    this.semanticReviewer.onReviewResult((result) => {
      this.postMessage({
        type: 'reviewStatus',
        data: {
          kind: result.kind,
          summary: result.summary,
          reviewedFile: result.reviewedFile,
          timestamp: result.timestamp,
          rawOutput: result.rawOutput,
        },
      });
    });

    this.testArchitect.onTestsGenerated((tests) => {
      this.postMessage({ type: 'testsGenerated', data: {
        filePath: tests.filePath,
        sourceFilePath: tests.sourceFilePath,
        language: tests.language,
        framework: tests.framework,
        workspaceRoot: tests.workspaceRoot,
        normal: tests.normal,
        edgeCase: tests.edgeCase,
        stress: tests.stress,
      }});
    });

    this.testArchitect.onTestRun((result) => {
      this.postMessage({ type: 'testOutput', data: result });
    });

    this.testArchitect.onExplanation((explanation) => {
      this.postMessage({ type: 'testExplanation', data: explanation });
    });

    this.visualQAEngine.onResultReady((result) => {
      this.postMessage({ type: 'visualResult', data: result });
    });

    this.prAutomator.onStatusChanged((status) => {
      this.postMessage({ type: 'pipelineStatus', data: status });
    });

    // Send initial state
    this.postMessage({ type: 'dockerStatus', data: this._dockerStatus });
    this.postMessage({ type: 'readiness', data: {
      percent: this.readinessTracker.getReadinessPercent(),
      files: this.readinessTracker.getAll(),
    }});
    this.postMessage({ type: 'provider', data: this.secretManager.getActiveProvider() });
    this.postMessage({ type: 'ollamaConfig', data: this.secretManager.getOllamaConfig() });
    // Check if an Ollama API key is already stored and tell the UI
    this.secretManager.hasOllamaApiKey().then(hasKey => {
      this.postMessage({ type: 'ollamaKeyStatus', data: { hasKey } });
    });

    // Send codebase graph initial state
    this.workspaceIndexer.getContext().then(ctx => {
      this.workspaceIndexer.buildCodebaseGraph(ctx).then(graph => {
        this.postMessage({ type: 'codebaseGraph', data: graph });
      });
    }).catch(() => {});

    // Listen for text editor changes to auto-update graph
    vscode.window.onDidChangeActiveTextEditor(async () => {
      if (this._view?.visible) {
        try {
          const ctx = await this.workspaceIndexer.getContext();
          const graph = await this.workspaceIndexer.buildCodebaseGraph(ctx);
          this.postMessage({ type: 'codebaseGraph', data: graph });
        } catch {
          // ignore
        }
      }
    });
  }

  updateDockerStatus(running: boolean): void {
    this._dockerStatus = running;
    this.postMessage({ type: 'dockerStatus', data: running });
  }

  private postMessage(message: any): void {
    this._view?.webview.postMessage(this.toWebviewSafe(message));
  }

  private toWebviewSafe(value: any, seen = new WeakSet<object>()): any {
    if (value === null || value === undefined) {
      return value;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }
    if (Array.isArray(value)) {
      return value.map(item => this.toWebviewSafe(item, seen));
    }
    if (typeof value === 'object') {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);

      const safe: Record<string, any> = {};
      for (const [key, child] of Object.entries(value)) {
        if (typeof child !== 'function') {
          safe[key] = this.toWebviewSafe(child, seen);
        }
      }
      seen.delete(value);
      return safe;
    }
    return String(value);
  }

  private getErrorMessage(err: any): string {
    if (!err) {
      return 'Unknown error';
    }
    if (typeof err === 'string') {
      return err;
    }
    return err.message || String(err);
  }

  private async handleMessage(message: any): Promise<void> {
    switch (message.command) {
      case 'runReview':
        await this.semanticReviewer.reviewActiveFile();
        break;
      case 'clearReview':
        this.semanticReviewer.clearFindings();
        this.postMessage({ type: 'reviewFindings', data: [] });
        this.postMessage({ type: 'reviewStatus', data: null });
        break;
      case 'generateTests':
        await this.testArchitect.generateForSelection();
        break;
      case 'runTests':
        if (this.testArchitect.lastGenerated) {
          const pending = this.testArchitect.lastGenerated;
          this.postMessage({
            type: 'testOutput',
            data: {
              status: 'running',
              command: '',
              cwd: pending.workspaceRoot,
              exitCode: null,
              output: '',
              framework: pending.framework,
              testFilePath: pending.filePath,
            },
          });
          const output = await this.testArchitect.runTests(pending.filePath);
          this.postMessage({ type: 'testOutput', data: output });
          // Refresh the plain-language report for this re-run.
          try {
            const explanation = await this.testArchitect.explainLast();
            if (explanation) {
              this.postMessage({ type: 'testExplanation', data: explanation });
            }
          } catch { /* explanation is best-effort */ }
        } else {
          this.postMessage({
            type: 'testOutput',
            data: {
              status: 'error',
              command: '',
              cwd: '',
              exitCode: null,
              output: '',
              framework: 'unknown',
              testFilePath: '',
              failureReason: 'No tests have been generated yet. Click "Generate Tests" first.',
            },
          });
        }
        break;
      case 'saveTests':
        await this.testArchitect.saveToProject();
        break;
      case 'runVisualCheck':
        await this.visualQAEngine.run(message.localUrl, message.productionUrl);
        break;
      case 'readyForPR':
        await this.prAutomator.run();
        break;
      case 'startDocker':
        await this.dockerManager.startStack();
        const healthy = await this.dockerManager.pollUntilReady();
        this.updateDockerStatus(healthy);
        break;
      case 'stopDocker':
        await this.dockerManager.stopStack();
        this.updateDockerStatus(false);
        break;
      case 'setProvider': {
        await vscode.workspace.getConfiguration('automatedqa').update(
          'aiProvider', message.provider, vscode.ConfigurationTarget.Global
        );
        this.postMessage({ type: 'provider', data: message.provider });
        // Push updated Ollama config too so the UI stays consistent
        this.postMessage({ type: 'ollamaConfig', data: this.secretManager.getOllamaConfig() });
        break;
      }
      case 'setPinnedCopilotModel': {
        await vscode.workspace.getConfiguration('automatedqa').update(
          'copilotModel', message.model || '', vscode.ConfigurationTarget.Global
        );
        break;
      }
      case 'setOllamaConfig': {
        await this.secretManager.setOllamaConfig(message.baseUrl, message.model);
        this.postMessage({ type: 'ollamaConfig', data: { baseUrl: message.baseUrl, model: message.model } });
        this.postMessage({ type: 'keySet', data: { provider: 'ollama', success: true } });
        break;
      }
      case 'setOllamaApiKey': {
        if (message.apiKey && message.apiKey.trim()) {
          await this.secretManager.setOllamaApiKey(message.apiKey.trim());
          this.postMessage({ type: 'ollamaKeyStatus', data: { hasKey: true } });
        }
        break;
      }
      case 'deleteOllamaApiKey': {
        await this.secretManager.deleteOllamaApiKey();
        this.postMessage({ type: 'ollamaKeyStatus', data: { hasKey: false } });
        break;
      }
      case 'setApiKey':
        await this.secretManager.setKey(message.provider, message.apiKey);
        this.postMessage({ type: 'keySet', data: { provider: message.provider, success: true } });
        break;
      case 'deleteApiKey':
        await this.secretManager.deleteKey(message.provider);
        this.postMessage({ type: 'keyDeleted', data: { provider: message.provider } });
        break;
      case 'checkApiKey':
        const hasKey = await this.secretManager.hasKey(message.provider);
        this.postMessage({ type: 'keyStatus', data: { provider: message.provider, hasKey } });
        break;
      case 'testConnection':
        await this.testAIConnection(message.provider);
        break;
      case 'revealLine':
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const line = Math.max(0, (message.line || 1) - 1);
          const range = new vscode.Range(line, 0, line, 0);
          editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
          editor.selection = new vscode.Selection(line, 0, line, 0);
        }
        break;
      case 'getReadiness':
        this.postMessage({ type: 'readiness', data: {
          percent: this.readinessTracker.getReadinessPercent(),
          files: this.readinessTracker.getAll(),
        }});
        break;
      case 'getCodebaseGraph':
        try {
          const ctx = await this.workspaceIndexer.getContext();
          const graph = await this.workspaceIndexer.buildCodebaseGraph(ctx);
          this.postMessage({ type: 'codebaseGraph', data: graph });
        } catch (err: any) {
          this.postMessage({ type: 'operationError', data: { command: 'getCodebaseGraph', message: err.message } });
        }
        break;
      case 'installDependency':
        if (this.dockerManager.isStackRunning) {
          const pm = message.framework === 'pytest' ? 'pip3' : 'npm';
          this.postMessage({
            type: 'pipelineStatus',
            data: { stage: 'installing', progress: 50, message: `Installing "${message.packageName}" inside sidecar container...` }
          });
          try {
            const res = await this.dockerManager.postToSidecar<{ success: boolean; output: string; error?: string }>('/install-package', {
              packageManager: pm,
              packageName: message.packageName,
              cwd: message.cwd || '',
              workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
            });
            if (res.success) {
              this.postMessage({
                type: 'pipelineStatus',
                data: { stage: 'idle', progress: 100, message: `Successfully installed "${message.packageName}".` }
              });
              // Refresh graph
              const ctx = await this.workspaceIndexer.getContext();
              const graph = await this.workspaceIndexer.buildCodebaseGraph(ctx);
              this.postMessage({ type: 'codebaseGraph', data: graph });
            } else {
              throw new Error(res.error || res.output || 'Installation failed inside container.');
            }
          } catch (err: any) {
            this.postMessage({
              type: 'pipelineStatus',
              data: { stage: 'idle', progress: 0, message: `Failed to install "${message.packageName}": ${err.message}` }
            });
            vscode.window.showErrorMessage(`Automated QA: Failed to install "${message.packageName}" inside container: ${err.message}`);
          }
        } else {
          vscode.window.showWarningMessage('Docker stack is not running. Please start the Docker stack first.');
        }
        break;
    }
  }

  private async testAIConnection(provider: string): Promise<void> {
    try {
      if (provider === 'copilot') {
        const allModels = await listAvailableModelNames();
        const pinned = vscode.workspace.getConfiguration('automatedqa').get<string>('copilotModel', '').trim();

        if (allModels.length > 0) {
          const pinnedNote = pinned
            ? `\nPinned model: "${pinned}" — will be used if available.`
            : `\nTip: pin a model via Settings → automatedqa.copilotModel`;
          this.postMessage({
            type: 'connectionResult',
            data: {
              success: true,
              message: `✅ ${allModels.length} model(s) available:\n${allModels.join('\n')}${pinnedNote}`,
            },
          });
        } else {
          this.postMessage({
            type: 'connectionResult',
            data: {
              success: false,
              message:
                'No Language Model Chat models available.\n' +
                'Is GitHub Copilot installed and signed in? ' +
                'Try reloading VS Code after signing in.',
            },
          });
        }
        return;
      }

      if (provider === 'ollama') {
        await this.testOllamaConnection();
        return;
      }

      const apiKey = await this.secretManager.getKey(provider as any);
      if (!apiKey) {
        this.postMessage({ type: 'connectionResult', data: { success: false, message: `No API key saved for ${provider}. Save a key first.` } });
        return;
      }

      // Test directly from extension host — no Docker required
      const result = await this.testProviderDirectly(provider, apiKey);
      this.postMessage({ type: 'connectionResult', data: result });
    } catch (err: any) {
      this.postMessage({ type: 'connectionResult', data: { success: false, message: err.message } });
    }
  }

  private async testOllamaConnection(): Promise<void> {
    const cfg = this.secretManager.getOllamaConfig();
    const tagsUrl = cfg.baseUrl.replace(/\/$/, '') + '/api/tags';
    let urlObj: URL;
    try {
      urlObj = new URL(tagsUrl);
    } catch {
      this.postMessage({ type: 'connectionResult', data: { success: false, message: `Invalid Ollama base URL: ${cfg.baseUrl}` } });
      return;
    }

    return new Promise((resolve) => {
      const useHttps = urlObj.protocol === 'https:';
      const lib = useHttps ? https : http;
      const req = lib.get(
        {
          hostname: urlObj.hostname,
          port: urlObj.port || (useHttps ? 443 : 80),
          path: urlObj.pathname,
          timeout: 8000,
        },
        (res) => {
          let data = '';
          res.on('data', (c: any) => (data += c));
          res.on('end', () => {
            if (res.statusCode && res.statusCode < 400) {
              try {
                const body = JSON.parse(data);
                const models: string[] = (body.models || []).map((m: any) => m.name);
                const modelList = models.length ? models.slice(0, 5).join(', ') : '(none yet)';
                const configured = cfg.model;
                const modelFound = models.some(m => m === configured || m.startsWith(configured + ':'));
                const note = modelFound
                  ? `Model “${configured}” is available.`
                  : `⚠️ Model “${configured}” not found. Available: ${modelList}`;
                this.postMessage({
                  type: 'connectionResult',
                  data: { success: true, message: `✅ Ollama reachable at ${cfg.baseUrl}. ${note}` },
                });
              } catch {
                this.postMessage({
                  type: 'connectionResult',
                  data: { success: true, message: `✅ Ollama reachable at ${cfg.baseUrl} (HTTP ${res.statusCode})` },
                });
              }
            } else {
              this.postMessage({
                type: 'connectionResult',
                data: { success: false, message: `Ollama returned HTTP ${res.statusCode} from ${cfg.baseUrl}` },
              });
            }
            resolve();
          });
        }
      );
      req.on('error', (e: any) => {
        this.postMessage({
          type: 'connectionResult',
          data: { success: false, message: `Cannot reach Ollama at ${cfg.baseUrl}: ${e.message}` },
        });
        resolve();
      });
      req.on('timeout', () => {
        req.destroy();
        this.postMessage({
          type: 'connectionResult',
          data: { success: false, message: `Connection to Ollama at ${cfg.baseUrl} timed out (8s)` },
        });
        resolve();
      });
    });
  }

  private testProviderDirectly(provider: string, apiKey: string): Promise<{ success: boolean; message: string }> {
    return new Promise((resolve) => {
      const configs: Record<string, { host: string; path: string; body: object }> = {
        openai: {
          host: 'api.openai.com',
          path: '/v1/chat/completions',
          body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'reply: ok' }], max_tokens: 5 },
        },
        grok: {
          host: 'api.x.ai',
          path: '/v1/chat/completions',
          body: { model: 'grok-3', messages: [{ role: 'user', content: 'reply: ok' }], max_tokens: 5 },
        },
        claude: {
          host: 'api.anthropic.com',
          path: '/v1/messages',
          body: { model: 'claude-haiku-20240307', max_tokens: 5, messages: [{ role: 'user', content: 'reply: ok' }] },
        },
        gemini: {
          host: 'generativelanguage.googleapis.com',
          path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
          body: { contents: [{ parts: [{ text: 'reply: ok' }] }] },
        },
      };

      const cfg = configs[provider];
      if (!cfg) {
        resolve({ success: false, message: `Unknown provider: ${provider}` });
        return;
      }

      const body = JSON.stringify(cfg.body);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body).toString(),
      };

      if (provider === 'openai' || provider === 'grok') {
        headers['Authorization'] = `Bearer ${apiKey}`;
      } else if (provider === 'claude') {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
      }
      // gemini uses query param — no auth header

      const req = https.request(
        { hostname: cfg.host, path: cfg.path, method: 'POST', headers, timeout: 15000 },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            if (res.statusCode && res.statusCode < 400) {
              resolve({ success: true, message: `✅ ${provider} connected successfully (HTTP ${res.statusCode})` });
            } else {
              let detail = '';
              try { detail = JSON.parse(data)?.error?.message || data.slice(0, 120); } catch { detail = data.slice(0, 120); }
              resolve({ success: false, message: `HTTP ${res.statusCode}: ${detail}` });
            }
          });
        }
      );
      req.on('error', (e) => resolve({ success: false, message: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ success: false, message: 'Request timed out' }); });
      req.write(body);
      req.end();
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css'));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
  <link href="${styleUri}" rel="stylesheet">
  <title>Automated QA</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
