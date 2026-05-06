import * as vscode from 'vscode';
import { DockerManager } from './dockerManager';

export interface VisualCheckResult {
  diffBase64: string;
  localBase64: string;
  productionBase64: string;
  deltaPercent: number;
  pixelsChanged: number;
  totalPixels: number;
}

export class VisualQAEngine {
  private dockerManager: DockerManager;
  private outputChannel: vscode.OutputChannel;
  private _lastResult: VisualCheckResult | null = null;
  private _onResultReady = new vscode.EventEmitter<VisualCheckResult>();
  readonly onResultReady = this._onResultReady.event;

  constructor(dockerManager: DockerManager, outputChannel: vscode.OutputChannel) {
    this.dockerManager = dockerManager;
    this.outputChannel = outputChannel;
  }

  get lastResult(): VisualCheckResult | null {
    return this._lastResult;
  }

  async run(localUrl: string, productionUrl: string): Promise<VisualCheckResult | null> {
    if (!this.dockerManager.isStackRunning) {
      vscode.window.showErrorMessage('Docker stack is not running. Start it first.');
      return null;
    }

    if (!localUrl || !productionUrl) {
      vscode.window.showWarningMessage('Both local and production URLs are required.');
      return null;
    }

    this.outputChannel.appendLine(`Visual QA: Comparing ${localUrl} vs ${productionUrl}...`);

    try {
      const result = await this.dockerManager.postToSidecar<VisualCheckResult>('/visual-check', {
        localUrl,
        productionUrl,
      });

      this._lastResult = result;
      this._onResultReady.fire(result);

      this.outputChannel.appendLine(
        `Visual QA complete. Delta: ${result.deltaPercent.toFixed(2)}% (${result.pixelsChanged}/${result.totalPixels} pixels)`
      );

      if (result.deltaPercent > 5) {
        vscode.window.showWarningMessage(
          `Visual QA: ${result.deltaPercent.toFixed(1)}% pixel difference detected!`
        );
      } else if (result.deltaPercent > 0) {
        vscode.window.showInformationMessage(
          `Visual QA: ${result.deltaPercent.toFixed(2)}% pixel difference (minor).`
        );
      } else {
        vscode.window.showInformationMessage('Visual QA: No visual differences detected! ✅');
      }

      return result;
    } catch (err: any) {
      this.outputChannel.appendLine(`Visual QA error: ${err.message}`);
      vscode.window.showErrorMessage(`Visual QA failed: ${err.message}`);
      return null;
    }
  }

  async runFromCommand(): Promise<void> {
    const localUrl = await vscode.window.showInputBox({
      prompt: 'Enter the local dev URL',
      value: 'http://localhost:3000',
      placeHolder: 'http://localhost:3000',
    });
    if (!localUrl) { return; }

    const productionUrl = await vscode.window.showInputBox({
      prompt: 'Enter the production/base URL to compare against',
      placeHolder: 'https://example.com',
    });
    if (!productionUrl) { return; }

    await this.run(localUrl, productionUrl);
  }
}
