import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface WorkspaceContext {
  testFramework: 'jest' | 'vitest' | 'pytest' | 'unknown';
  language: 'typescript' | 'javascript' | 'python' | 'unknown';
  projectName: string;
  workspaceRoot: string;
  testConfigPath: string;
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
    const editor = vscode.window.activeTextEditor;
    if (this.cachedContext && now - this.lastIndexTime < this.CACHE_TTL_MS) {
      const activeFilePath = editor?.document.uri.fsPath || '';
      if (activeFilePath && activeFilePath !== this.cachedContext.activeFilePath) {
        this.cachedContext = await this.buildContext();
        this.lastIndexTime = now;
        return this.cachedContext;
      }

      // Update active file content even if cache is fresh
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
    const editor = vscode.window.activeTextEditor;
    const workspaceFolder = editor
      ? vscode.workspace.getWorkspaceFolder(editor.document.uri)
      : vscode.workspace.workspaceFolders?.[0];

    let testFramework: WorkspaceContext['testFramework'] = 'unknown';
    let language: WorkspaceContext['language'] = 'unknown';
    let projectName = 'unknown';
    let workspaceRoot = workspaceFolder?.uri.fsPath || '';
    let testConfigPath = '';
    let dependencies: Record<string, string> = {};
    let devDependencies: Record<string, string> = {};

    const activeFilePath = editor?.document.uri.fsPath || '';

    // Read package.json
    if (workspaceFolder) {
      workspaceRoot = this.findProjectRoot(activeFilePath, workspaceFolder.uri.fsPath);
      const pkgPath = path.join(workspaceRoot, 'package.json');
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
          testConfigPath = this.findFirstExisting(workspaceRoot, [
            'vitest.config.ts',
            'vitest.config.mts',
            'vitest.config.js',
            'vite.config.ts',
            'vite.config.mts',
            'vite.config.js',
          ]);
        } else if (allDeps['jest']) {
          testFramework = 'jest';
          testConfigPath = this.findFirstExisting(workspaceRoot, [
            'jest.config.ts',
            'jest.config.js',
            'jest.config.mjs',
            'jest.config.cjs',
          ]);
          if (!testConfigPath && pkg.jest) {
            testConfigPath = 'package.json#jest';
          }
        }

        const viteConfigPath = this.findFirstExisting(workspaceRoot, [
          'vitest.config.ts',
          'vitest.config.mts',
          'vitest.config.js',
          'vite.config.ts',
          'vite.config.mts',
          'vite.config.js',
        ]);
        if (testFramework === 'unknown' && viteConfigPath) {
          testFramework = 'vitest';
          testConfigPath = viteConfigPath;
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
      const requirementsTxt = path.join(workspaceRoot, 'requirements.txt');
      const pyprojectToml = path.join(workspaceRoot, 'pyproject.toml');
      const pytestIni = path.join(workspaceRoot, 'pytest.ini');
      if (
        this.fileLooksLikePython(activeFilePath) ||
        fs.existsSync(requirementsTxt) ||
        fs.existsSync(pyprojectToml) ||
        fs.existsSync(pytestIni)
      ) {
        language = 'python';
        const pythonConfig = this.findFirstExisting(workspaceRoot, [
          'pyproject.toml',
          'pytest.ini',
          'tox.ini',
          'setup.cfg',
        ]);
        if (pythonConfig || this.fileContains(requirementsTxt, /pytest/i) || this.fileContains(pyprojectToml, /pytest/i)) {
          testFramework = 'pytest';
          testConfigPath = pythonConfig;
        }
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

    const activeFileContent = editor?.document.getText() || '';

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
      workspaceRoot,
      testConfigPath,
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

  private findFirstExisting(root: string, relativePaths: string[]): string {
    for (const relativePath of relativePaths) {
      if (fs.existsSync(path.join(root, relativePath))) {
        return relativePath;
      }
    }
    return '';
  }

  private findProjectRoot(activeFilePath: string, workspaceRoot: string): string {
    if (!activeFilePath) {
      return workspaceRoot;
    }

    let current = fs.existsSync(activeFilePath) && fs.statSync(activeFilePath).isDirectory()
      ? activeFilePath
      : path.dirname(activeFilePath);
    const workspaceBoundary = path.resolve(workspaceRoot);

    while (path.resolve(current).startsWith(workspaceBoundary)) {
      if (
        fs.existsSync(path.join(current, 'package.json')) ||
        fs.existsSync(path.join(current, 'pyproject.toml')) ||
        fs.existsSync(path.join(current, 'pytest.ini'))
      ) {
        return current;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }

    return workspaceRoot;
  }

  private fileLooksLikePython(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === '.py';
  }

  private fileContains(filePath: string, pattern: RegExp): boolean {
    try {
      return fs.existsSync(filePath) && pattern.test(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return false;
    }
  }
}
