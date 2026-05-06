import * as vscode from 'vscode';
import { SidebarProvider } from './sidebarProvider';
import { DockerManager } from './dockerManager';
import { SecretManager } from './secretManager';
import { WorkspaceIndexer } from './workspaceIndexer';
import { SemanticReviewer } from './semanticReviewer';
import { CodeLensReviewProvider } from './codeLensProvider';
import { TestArchitect } from './testArchitect';
import { VisualQAEngine } from './visualQAEngine';
import { PRAutomator } from './prAutomator';
import { PRReadinessTracker } from './prReadinessTracker';
import { OmniCheckTaskProvider } from './taskProvider';
import { Telemetry } from './telemetry';

export async function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Automated QA');
  outputChannel.appendLine('Automated QA extension activating...');

  // Core services
  const secretManager = new SecretManager(context);
  const dockerManager = new DockerManager(outputChannel, context.extensionPath);
  const workspaceIndexer = new WorkspaceIndexer();
  const telemetry = new Telemetry();
  const readinessTracker = new PRReadinessTracker(context);

  // Engine services
  const semanticReviewer = new SemanticReviewer(secretManager, workspaceIndexer, dockerManager, outputChannel);
  const codeLensProvider = new CodeLensReviewProvider(semanticReviewer);
  const testArchitect = new TestArchitect(secretManager, workspaceIndexer, dockerManager, outputChannel);
  const visualQAEngine = new VisualQAEngine(dockerManager, outputChannel);
  const prAutomator = new PRAutomator(
    semanticReviewer,
    testArchitect,
    visualQAEngine,
    readinessTracker,
    secretManager,
    dockerManager,
    outputChannel
  );

  // Sidebar webview
  const sidebarProvider = new SidebarProvider(
    context.extensionUri,
    dockerManager,
    secretManager,
    semanticReviewer,
    testArchitect,
    visualQAEngine,
    prAutomator,
    readinessTracker,
    workspaceIndexer
  );

  // Register providers
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('automated-qa.sidebarView', sidebarProvider),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider),
    vscode.tasks.registerTaskProvider('automated-qa', new OmniCheckTaskProvider(prAutomator)),
    outputChannel
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('automated-qa.runReview', async () => {
      await semanticReviewer.reviewActiveFile();
    }),
    vscode.commands.registerCommand('automated-qa.generateTests', async () => {
      await testArchitect.generateForSelection();
    }),
    vscode.commands.registerCommand('automated-qa.runVisualCheck', async () => {
      await visualQAEngine.runFromCommand();
    }),
    vscode.commands.registerCommand('automated-qa.readyForPR', async () => {
      await prAutomator.run();
    }),
    vscode.commands.registerCommand('automated-qa.startDocker', async () => {
      await dockerManager.startStack();
    }),
    vscode.commands.registerCommand('automated-qa.stopDocker', async () => {
      await dockerManager.stopStack();
    })
  );

  // Auto-start Docker stack
  try {
    const isDockerAvailable = await dockerManager.isDockerRunning();
    if (isDockerAvailable) {
      outputChannel.appendLine('Docker detected. Starting sidecar stack...');
      await dockerManager.startStack();
      const healthy = await dockerManager.pollUntilReady();
      if (healthy) {
        outputChannel.appendLine('Sidecar stack is healthy and ready.');
        sidebarProvider.updateDockerStatus(true);
      } else {
        outputChannel.appendLine('Sidecar stack failed health check. Some features will be unavailable.');
        sidebarProvider.updateDockerStatus(false);
      }
    } else {
      outputChannel.appendLine('Docker not detected. Visual QA and test runner features will be unavailable.');
      vscode.window.showWarningMessage(
        'Automated QA: Docker is not running. Visual QA and Test Runner require Docker.',
        'Install Docker'
      ).then(selection => {
        if (selection === 'Install Docker') {
          vscode.env.openExternal(vscode.Uri.parse('https://www.docker.com/products/docker-desktop/'));
        }
      });
      sidebarProvider.updateDockerStatus(false);
    }
  } catch (err) {
    outputChannel.appendLine(`Docker check failed: ${err}`);
    sidebarProvider.updateDockerStatus(false);
  }

  outputChannel.appendLine('Automated QA extension activated.');
}

export function deactivate() {
  // Docker stack cleanup is handled by DockerManager's dispose
}
