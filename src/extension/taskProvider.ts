import * as vscode from 'vscode';
import { PRAutomator } from './prAutomator';

export class OmniCheckTaskProvider implements vscode.TaskProvider {
  private prAutomator: PRAutomator;

  constructor(prAutomator: PRAutomator) {
    this.prAutomator = prAutomator;
  }

  provideTasks(): vscode.Task[] {
    const task = this.createOmniCheckTask();
    return task ? [task] : [];
  }

  resolveTask(task: vscode.Task): vscode.Task | undefined {
    return task;
  }

  private createOmniCheckTask(): vscode.Task | undefined {
    const taskDef: vscode.TaskDefinition = {
      type: 'automated-qa',
      task: 'omnicheck',
    };

    const execution = new vscode.CustomExecution(async () => {
      return new OmniCheckPseudoterminal(this.prAutomator);
    });

    const task = new vscode.Task(
      taskDef,
      vscode.TaskScope.Workspace,
      'OmniCheck - Full Pre-Flight',
      'Automated QA',
      execution,
      []
    );

    task.group = vscode.TaskGroup.Build;
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
    };

    return task;
  }
}

class OmniCheckPseudoterminal implements vscode.Pseudoterminal {
  private writeEmitter = new vscode.EventEmitter<string>();
  onDidWrite: vscode.Event<string> = this.writeEmitter.event;
  private closeEmitter = new vscode.EventEmitter<number>();
  onDidClose: vscode.Event<number> = this.closeEmitter.event;
  private prAutomator: PRAutomator;

  constructor(prAutomator: PRAutomator) {
    this.prAutomator = prAutomator;
  }

  open(): void {
    this.writeEmitter.fire('🚀 Starting OmniCheck Pre-Flight...\r\n\r\n');
    this.runPipeline();
  }

  close(): void {
    // cleanup
  }

  private async runPipeline(): Promise<void> {
    const disposable = this.prAutomator.onStatusChanged((status) => {
      const stageIcons: Record<string, string> = {
        reviewing: '🔍',
        'generating-tests': '🧪',
        'running-tests': '▶️',
        'visual-check': '🖼️',
        'commit-message': '💬',
        done: '✅',
        error: '❌',
      };

      const icon = stageIcons[status.stage] || '⏳';
      this.writeEmitter.fire(`${icon} [${status.progress}%] ${status.message}\r\n`);

      if (status.commitMessage) {
        this.writeEmitter.fire(`\r\n📋 Commit Message:\r\n   ${status.commitMessage}\r\n`);
      }
    });

    try {
      await this.prAutomator.run();
      this.writeEmitter.fire('\r\n✅ OmniCheck complete!\r\n');
      this.closeEmitter.fire(0);
    } catch (err: any) {
      this.writeEmitter.fire(`\r\n❌ OmniCheck failed: ${err.message}\r\n`);
      this.closeEmitter.fire(1);
    } finally {
      disposable.dispose();
    }
  }
}
