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
      await this.handleMessage(message);
    });

    // Listen for engine events
    this.semanticReviewer.onFindingsChanged((findings) => {
      this.postMessage({ type: 'reviewFindings', data: findings });
    });

    this.testArchitect.onTestsGenerated((tests) => {
      this.postMessage({ type: 'testsGenerated', data: {
        filePath: tests.filePath,
        framework: tests.framework,
        normal: tests.normal,
        edgeCase: tests.edgeCase,
        stress: tests.stress,
      }});
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
  }

  updateDockerStatus(running: boolean): void {
    this._dockerStatus = running;
    this.postMessage({ type: 'dockerStatus', data: running });
  }

  private postMessage(message: any): void {
    this._view?.webview.postMessage(message);
  }

  private async handleMessage(message: any): Promise<void> {
    switch (message.command) {
      case 'runReview':
        await this.semanticReviewer.reviewActiveFile();
        break;
      case 'generateTests':
        await this.testArchitect.generateForSelection();
        break;
      case 'runTests':
        if (this.testArchitect.lastGenerated) {
          const output = await this.testArchitect.runTests(this.testArchitect.lastGenerated.filePath);
          this.postMessage({ type: 'testOutput', data: output });
        }
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
    }
  }

  private async testAIConnection(provider: string): Promise<void> {
    try {
      if (provider === 'copilot') {
        const models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
        if (models.length > 0) {
          this.postMessage({ type: 'connectionResult', data: { success: true, message: `✅ Connected to ${models[0].name}` } });
        } else {
          this.postMessage({ type: 'connectionResult', data: { success: false, message: 'No Copilot model found. Is GitHub Copilot installed and signed in?' } });
        }
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
