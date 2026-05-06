import * as vscode from 'vscode';
import { SemanticReviewer, ReviewFinding } from './semanticReviewer';

export class CodeLensReviewProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
  private reviewer: SemanticReviewer;

  constructor(reviewer: SemanticReviewer) {
    this.reviewer = reviewer;
    reviewer.onFindingsChanged(() => {
      this._onDidChangeCodeLenses.fire();
    });
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const findings = this.reviewer.findings.filter(
      (f) => f.file === document.uri.fsPath
    );

    return findings.map((finding) => {
      const range = new vscode.Range(
        new vscode.Position(Math.max(0, finding.line - 1), 0),
        new vscode.Position(Math.max(0, finding.line - 1), 0)
      );

      const confidenceIcon =
        finding.confidence === 'HIGH' ? '🔴' :
        finding.confidence === 'MEDIUM' ? '🟠' : '⚪';

      const categoryIcon =
        finding.category === 'security' ? '🔒' :
        finding.category === 'performance' ? '⚡' :
        finding.category === 'architecture' ? '🏗️' : '🧠';

      return new vscode.CodeLens(range, {
        title: `${confidenceIcon} ${categoryIcon} ${finding.title}`,
        command: 'automated-qa.runReview',
        tooltip: `[${finding.confidence}] ${finding.description}\n\nSuggestion: ${finding.suggestion || 'None'}`,
      });
    });
  }
}
