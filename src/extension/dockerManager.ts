import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';

const execAsync = promisify(exec);

export class DockerManager {
  private outputChannel: vscode.OutputChannel;
  private _isStackRunning = false;
  private _composeCmd: string | null = null;
  private extensionPath: string;

  constructor(outputChannel: vscode.OutputChannel, extensionPath: string) {
    this.outputChannel = outputChannel;
    this.extensionPath = extensionPath;
  }

  get isStackRunning(): boolean {
    return this._isStackRunning;
  }

  get sidecarPort(): number {
    return vscode.workspace.getConfiguration('automatedqa').get<number>('sidecarPort') || 4777;
  }

  get sidecarBaseUrl(): string {
    return `http://localhost:${this.sidecarPort}`;
  }

  /**
   * Always use the extension's own directory as the compose root.
   * This is where docker-compose.yml lives regardless of what project is opened.
   */
  private getComposeDir(): string {
    return this.extensionPath;
  }

  async isDockerRunning(): Promise<boolean> {
    try {
      await execAsync('docker info', { timeout: 10000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Detect whether 'docker compose' (V2 plugin) or 'docker-compose' (V1) is available.
   */
  private async getComposeCmd(): Promise<string> {
    if (this._composeCmd) { return this._composeCmd; }

    try {
      await execAsync('docker compose version', { timeout: 5000 });
      this._composeCmd = 'docker compose';
      this.outputChannel.appendLine('Using Docker Compose V2 (docker compose)');
    } catch {
      try {
        await execAsync('docker-compose --version', { timeout: 5000 });
        this._composeCmd = 'docker-compose';
        this.outputChannel.appendLine('Using Docker Compose V1 (docker-compose)');
      } catch {
        throw new Error(
          'Neither "docker compose" nor "docker-compose" found. ' +
          'Please install Docker Desktop: https://www.docker.com/products/docker-desktop/'
        );
      }
    }

    return this._composeCmd!;
  }

  async startStack(): Promise<void> {
    const cwd = this.getComposeDir();
    this.outputChannel.appendLine(`Starting Docker stack in ${cwd}...`);

    // Verify docker-compose.yml exists
    const composePath = path.join(cwd, 'docker-compose.yml');
    if (!fs.existsSync(composePath)) {
      const msg = `docker-compose.yml not found at ${composePath}`;
      this.outputChannel.appendLine(msg);
      throw new Error(msg);
    }

    try {
      const cmd = await this.getComposeCmd();
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || cwd;
      this.outputChannel.appendLine(`Running: ${cmd} up -d --build with WORKSPACE_ROOT=${workspaceFolder}`);

      const { stdout, stderr } = await execAsync(
        `${cmd} up -d --build`,
        {
          cwd,
          timeout: 180000, // 3 min — first build can take time
          env: {
            ...process.env,
            WORKSPACE_ROOT: workspaceFolder,
          }
        }
      );
      if (stdout) { this.outputChannel.appendLine(stdout); }
      if (stderr) { this.outputChannel.appendLine(stderr); }
      this._isStackRunning = true;
      this.outputChannel.appendLine('Docker stack started successfully.');
    } catch (err: any) {
      this.outputChannel.appendLine(`Failed to start Docker stack: ${err.message}`);
      if (err.stdout) { this.outputChannel.appendLine(`stdout: ${err.stdout}`); }
      if (err.stderr) { this.outputChannel.appendLine(`stderr: ${err.stderr}`); }
      vscode.window.showErrorMessage(
        `Automated QA: Failed to start Docker stack. Check Output → "Automated QA" for details.`,
        'Open Output'
      ).then(sel => {
        if (sel === 'Open Output') { this.outputChannel.show(); }
      });
      throw err;
    }
  }

  async stopStack(): Promise<void> {
    const cwd = this.getComposeDir();
    this.outputChannel.appendLine('Stopping Docker stack...');

    try {
      const cmd = await this.getComposeCmd();
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || cwd;
      await execAsync(`${cmd} down`, {
        cwd,
        timeout: 30000,
        env: {
          ...process.env,
          WORKSPACE_ROOT: workspaceFolder,
        }
      });
      this._isStackRunning = false;
      this.outputChannel.appendLine('Docker stack stopped.');
    } catch (err: any) {
      this.outputChannel.appendLine(`Failed to stop Docker stack: ${err.message}`);
    }
  }

  async pollUntilReady(timeoutMs: number = 60000): Promise<boolean> {
    const start = Date.now();
    const url = `${this.sidecarBaseUrl}/health`;
    this.outputChannel.appendLine(`Polling ${url} for readiness...`);

    while (Date.now() - start < timeoutMs) {
      try {
        const ok = await this.httpGet(url);
        if (ok) {
          this._isStackRunning = true;
          return true;
        }
      } catch {
        // Not ready yet
      }
      await this.sleep(1000);
    }

    this.outputChannel.appendLine('Health check timed out after ' + timeoutMs / 1000 + 's.');
    return false;
  }

  /**
   * Single quick probe — does NOT start anything.
   * Returns true and marks the stack as running if the sidecar is already healthy.
   * Used on extension activation to avoid an unnecessary compose up.
   */
  async isSidecarHealthy(): Promise<boolean> {
    try {
      const ok = await this.httpGet(`${this.sidecarBaseUrl}/health`);
      if (ok) { this._isStackRunning = true; }
      return ok;
    } catch {
      return false;
    }
  }

  async isSidecarWorkspaceCorrect(workspaceFolder: string): Promise<boolean> {
    const probeFilename = `.qa-probe-${Date.now()}-${Math.random().toString(36).substring(2, 9)}.tmp`;
    const probePath = path.join(workspaceFolder, probeFilename);
    try {
      fs.writeFileSync(probePath, 'probe', 'utf-8');
      
      const response = await this.postToSidecar<{ exists: boolean }>('/check-file', {
        relativePath: probeFilename
      });
      
      try {
        fs.unlinkSync(probePath);
      } catch {
        // ignore
      }
      
      return Boolean(response && response.exists);
    } catch (err) {
      try {
        if (fs.existsSync(probePath)) {
          fs.unlinkSync(probePath);
        }
      } catch {
        // ignore
      }
      return false;
    }
  }

  async postToSidecar<T = any>(endpoint: string, body: Record<string, any>): Promise<T> {
    const url = `${this.sidecarBaseUrl}${endpoint}`;
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const urlObj = new URL(url);

      const req = http.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port,
          path: urlObj.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
          },
          timeout: 300000,
        },
        (res) => {
          let responseData = '';
          res.on('data', (chunk) => (responseData += chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(responseData) as T);
            } catch {
              reject(new Error(`Invalid JSON response from sidecar: ${responseData.slice(0, 200)}`));
            }
          });
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Sidecar request timed out'));
      });
      req.write(data);
      req.end();
    });
  }

  private httpGet(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      const urlObj = new URL(url);
      const req = http.get(
        { hostname: urlObj.hostname, port: urlObj.port, path: urlObj.pathname, timeout: 3000 },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            try {
              const data = JSON.parse(body);
              resolve(data.status === 'ok');
            } catch {
              resolve(false);
            }
          });
        }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
