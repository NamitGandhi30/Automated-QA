import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface WorkspaceContext {
  testFramework: 'jest' | 'vitest' | 'pytest' | 'unknown';
  language: 'typescript' | 'javascript' | 'python' | 'unknown';
  projectName: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  fileTree: string[];
  activeFileContent: string;
  activeFilePath: string;
  adjacentSnippets: { path: string; content: string }[];
}

export class WorkspaceIndexer {
  private cachedContext: WorkspaceContext | null = null;
  private lastIndexTime = 0;
  private readonly CACHE_TTL_MS = 30000; // 30s

  async getContext(): Promise<WorkspaceContext> {
    const now = Date.now();
    if (this.cachedContext && now - this.lastIndexTime < this.CACHE_TTL_MS) {
      // Update active file content even if cache is fresh
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        this.cachedContext.activeFileContent = editor.document.getText();
        this.cachedContext.activeFilePath = editor.document.uri.fsPath;
      }
      return this.cachedContext;
    }

    this.cachedContext = await this.buildContext();
    this.lastIndexTime = now;
    return this.cachedContext;
  }

  private async buildContext(): Promise<WorkspaceContext> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const editor = vscode.window.activeTextEditor;

    let testFramework: WorkspaceContext['testFramework'] = 'unknown';
    let language: WorkspaceContext['language'] = 'unknown';
    let projectName = 'unknown';
    let dependencies: Record<string, string> = {};
    let devDependencies: Record<string, string> = {};

    // Read package.json
    if (workspaceFolder) {
      const pkgPath = path.join(workspaceFolder.uri.fsPath, 'package.json');
      try {
        const pkgRaw = fs.readFileSync(pkgPath, 'utf-8');
        const pkg = JSON.parse(pkgRaw);
        projectName = pkg.name || 'unknown';
        dependencies = pkg.dependencies || {};
        devDependencies = pkg.devDependencies || {};

        // Detect test framework
        const allDeps = { ...dependencies, ...devDependencies };
        if (allDeps['vitest']) {
          testFramework = 'vitest';
        } else if (allDeps['jest']) {
          testFramework = 'jest';
        }

        // Detect language
        if (allDeps['typescript']) {
          language = 'typescript';
        } else {
          language = 'javascript';
        }
      } catch {
        // No package.json
      }

      // Check for Python
      const requirementsTxt = path.join(workspaceFolder.uri.fsPath, 'requirements.txt');
      const pyprojectToml = path.join(workspaceFolder.uri.fsPath, 'pyproject.toml');
      if (fs.existsSync(requirementsTxt) || fs.existsSync(pyprojectToml)) {
        language = 'python';
        testFramework = 'pytest';
      }
    }

    // Build file tree (top-level, shallow)
    const fileTree: string[] = [];
    if (workspaceFolder) {
      try {
        const files = await vscode.workspace.findFiles('**/*.{ts,tsx,js,jsx,py}', '**/node_modules/**', 200);
        for (const f of files) {
          fileTree.push(vscode.workspace.asRelativePath(f));
        }
      } catch {
        // fallback
      }
    }

    // Active file
    const activeFileContent = editor?.document.getText() || '';
    const activeFilePath = editor?.document.uri.fsPath || '';

    // Adjacent snippets: files in the same directory
    const adjacentSnippets: { path: string; content: string }[] = [];
    if (activeFilePath) {
      const dir = path.dirname(activeFilePath);
      try {
        const siblings = fs.readdirSync(dir).filter(f => {
          const ext = path.extname(f).toLowerCase();
          return ['.ts', '.tsx', '.js', '.jsx', '.py'].includes(ext) && path.join(dir, f) !== activeFilePath;
        });
        for (const sib of siblings.slice(0, 3)) {
          const content = fs.readFileSync(path.join(dir, sib), 'utf-8');
          adjacentSnippets.push({
            path: sib,
            content: content.slice(0, 2000), // First 2000 chars only
          });
        }
      } catch {
        // ignore
      }
    }

    return {
      testFramework,
      language,
      projectName,
      dependencies,
      devDependencies,
      fileTree,
      activeFileContent,
      activeFilePath,
      adjacentSnippets,
    };
  }

  invalidateCache(): void {
    this.cachedContext = null;
    this.lastIndexTime = 0;
  }
}
