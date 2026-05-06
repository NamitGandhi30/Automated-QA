import * as vscode from 'vscode';

export interface FileReadiness {
  reviewed: boolean;
  tested: boolean;
  visualChecked: boolean;
}

export class PRReadinessTracker {
  private context: vscode.ExtensionContext;
  private readonly STORAGE_KEY = 'automatedqa.readiness';

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  getStatus(filePath: string): FileReadiness {
    const all = this.getAll();
    return all[filePath] || { reviewed: false, tested: false, visualChecked: false };
  }

  getAll(): Record<string, FileReadiness> {
    return this.context.workspaceState.get<Record<string, FileReadiness>>(this.STORAGE_KEY) || {};
  }

  markReviewed(filePath: string): void {
    this.update(filePath, { reviewed: true });
  }

  markTested(filePath: string): void {
    this.update(filePath, { tested: true });
  }

  markVisualChecked(filePath: string): void {
    this.update(filePath, { visualChecked: true });
  }

  resetFile(filePath: string): void {
    const all = this.getAll();
    delete all[filePath];
    this.context.workspaceState.update(this.STORAGE_KEY, all);
  }

  resetAll(): void {
    this.context.workspaceState.update(this.STORAGE_KEY, {});
  }

  getReadinessPercent(): number {
    const all = this.getAll();
    const files = Object.values(all);
    if (files.length === 0) { return 0; }

    let total = 0;
    let completed = 0;
    for (const f of files) {
      total += 3;
      if (f.reviewed) { completed++; }
      if (f.tested) { completed++; }
      if (f.visualChecked) { completed++; }
    }
    return Math.round((completed / total) * 100);
  }

  private update(filePath: string, partial: Partial<FileReadiness>): void {
    const all = this.getAll();
    const current = all[filePath] || { reviewed: false, tested: false, visualChecked: false };
    all[filePath] = { ...current, ...partial };
    this.context.workspaceState.update(this.STORAGE_KEY, all);
  }
}
