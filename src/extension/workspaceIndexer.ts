import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { readTsconfigPaths, analyzeSourceFile } from './codeIntelligence';

export interface GraphNode {
  id: string; // relative file path or package name
  label: string; // display name
  type: 'main' | 'file' | 'lib';
  language?: string;
  isMain: boolean;
  imports: string[];
  missingDeps: string[];
}

export interface GraphEdge {
  source: string;
  target: string;
  type: 'import' | 'dependency';
}

export interface CodebaseGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  mainFiles: string[];
  externalLibs: string[];
}

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
  pathAliases: Record<string, string>;
  nearbyTestFiles: { path: string; content: string }[];
  moduleSystem: 'commonjs' | 'esm' | 'unknown';
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
      const boundaryFsPath = workspaceFolder.uri.fsPath;

      // Find all package.json files from workspaceRoot up to the workspace boundary to aggregate dependencies
      const pkgPaths: string[] = [];
      let currentDir = workspaceRoot;
      const boundary = path.resolve(boundaryFsPath);
      
      while (true) {
        const pkgFile = path.join(currentDir, 'package.json');
        if (fs.existsSync(pkgFile)) {
          pkgPaths.push(pkgFile);
        }
        if (currentDir === boundary) {
          break;
        }
        const parent = path.dirname(currentDir);
        if (parent === currentDir) {
          break;
        }
        currentDir = parent;
      }

      let pkgJestExists = false;
      for (let i = pkgPaths.length - 1; i >= 0; i--) {
        try {
          const pkgRaw = fs.readFileSync(pkgPaths[i], 'utf-8');
          const pkg = JSON.parse(pkgRaw);
          if (pkg.name) {
            projectName = pkg.name;
          }
          dependencies = { ...dependencies, ...(pkg.dependencies || {}) };
          devDependencies = { ...devDependencies, ...(pkg.devDependencies || {}) };
          if (pkg.jest) {
            pkgJestExists = true;
          }
        } catch {
          // ignore
        }
      }

      const allDeps = { ...dependencies, ...devDependencies };

      // 1. Search upwards for configuration files first to establish high-confidence detection.
      // If a Vitest/Vite config file is present, prioritize Vitest over Jest.
      const vitestConfig = this.findConfigUpwards(workspaceRoot, boundaryFsPath, [
        'vitest.config.ts',
        'vitest.config.mts',
        'vitest.config.js',
        'vite.config.ts',
        'vite.config.mts',
        'vite.config.js',
      ]);

      const jestConfig = this.findConfigUpwards(workspaceRoot, boundaryFsPath, [
        'jest.config.ts',
        'jest.config.js',
        'jest.config.mjs',
        'jest.config.cjs',
        'jest.config.json',
      ]);

      if (vitestConfig) {
        testFramework = 'vitest';
        testConfigPath = vitestConfig;
      } else if (jestConfig) {
        testFramework = 'jest';
        testConfigPath = jestConfig;
      } else if (pkgJestExists) {
        testFramework = 'jest';
        testConfigPath = 'package.json#jest';
      } else if (allDeps['vitest']) {
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

      // Check for Python
      const requirementsTxtRel = this.findConfigUpwards(workspaceRoot, boundaryFsPath, ['requirements.txt']);
      const pyprojectTomlRel = this.findConfigUpwards(workspaceRoot, boundaryFsPath, ['pyproject.toml']);
      const pytestIniRel = this.findConfigUpwards(workspaceRoot, boundaryFsPath, ['pytest.ini']);

      const requirementsTxt = requirementsTxtRel ? (path.isAbsolute(requirementsTxtRel) ? requirementsTxtRel : path.join(workspaceRoot, requirementsTxtRel)) : '';
      const pyprojectToml = pyprojectTomlRel ? (path.isAbsolute(pyprojectTomlRel) ? pyprojectTomlRel : path.join(workspaceRoot, pyprojectTomlRel)) : '';
      const pytestIni = pytestIniRel ? (path.isAbsolute(pytestIniRel) ? pytestIniRel : path.join(workspaceRoot, pytestIniRel)) : '';

      if (
        this.fileLooksLikePython(activeFilePath) ||
        requirementsTxt ||
        pyprojectToml ||
        pytestIni
      ) {
        language = 'python';
        const pythonConfig = this.findConfigUpwards(workspaceRoot, boundaryFsPath, [
          'pyproject.toml',
          'pytest.ini',
          'tox.ini',
          'setup.cfg',
        ]);
        const hasPytestInRequirements = requirementsTxt && this.fileContains(requirementsTxt, /pytest/i);
        const hasPytestInPyproject = pyprojectToml && this.fileContains(pyprojectToml, /pytest/i);

        if (pythonConfig || hasPytestInRequirements || hasPytestInPyproject) {
          testFramework = 'pytest';
          testConfigPath = pythonConfig;
        }
      }

      if (language === 'python' && testFramework === 'unknown') {
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

    // Path aliases from tsconfig
    const pathAliases = readTsconfigPaths(workspaceRoot);

    // Nearby test files
    const nearbyTestFiles: { path: string; content: string }[] = [];
    if (activeFilePath) {
      const testDir = path.dirname(activeFilePath);
      const testDirs = [testDir, path.join(testDir, '__tests__'), path.join(testDir, 'tests')];
      for (const td of testDirs) {
        if (!fs.existsSync(td)) { continue; }
        try {
          const files = fs.readdirSync(td).filter(f =>
            (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(f) || /^(test_.*|.*_test)\.py$/.test(f)) &&
            !f.includes('.qa.test.') && !f.includes('_qa.')
          );
          for (const f of files.slice(0, 2)) {
            nearbyTestFiles.push({
              path: path.join(td, f),
              content: fs.readFileSync(path.join(td, f), 'utf-8').slice(0, 3000),
            });
          }
        } catch { /* ignore */ }
        if (nearbyTestFiles.length > 0) { break; }
      }
    }

    // Module system detection
    let moduleSystem: 'commonjs' | 'esm' | 'unknown' = 'unknown';
    if (workspaceFolder) {
      // Check package.json type field
      const rootPkgPath = path.join(workspaceRoot, 'package.json');
      if (fs.existsSync(rootPkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf-8'));
          if (pkg.type === 'module') { moduleSystem = 'esm'; }
          else if (pkg.type === 'commonjs' || !pkg.type) { moduleSystem = 'commonjs'; }
        } catch { /* ignore */ }
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
      pathAliases,
      nearbyTestFiles,
      moduleSystem,
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

  private findConfigUpwards(startDir: string, boundaryDir: string, relativePaths: string[]): string {
    let current = path.resolve(startDir);
    const boundary = boundaryDir ? path.resolve(boundaryDir) : current;

    while (true) {
      for (const rel of relativePaths) {
        const fullPath = path.join(current, rel);
        if (fs.existsSync(fullPath)) {
          const relativeToStart = path.relative(startDir, fullPath);
          return relativeToStart || rel;
        }
      }
      if (current === boundary) {
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
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

  async buildCodebaseGraph(context: WorkspaceContext): Promise<CodebaseGraph> {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const mainFilesSet = new Set<string>();
    const externalLibsSet = new Set<string>();
    const fileToNodeMap = new Map<string, GraphNode>();

    const isMainFile = (relPath: string) => {
      const base = path.basename(relPath).toLowerCase();
      return ['index.ts', 'index.js', 'server.ts', 'server.js', 'app.ts', 'app.js', 'main.py', 'manage.py', 'main.ts', 'main.js'].includes(base);
    };

    const resolveInternalImport = (sourceRelPath: string, importModule: string, fileTree: string[]): string | null => {
      const sourceDir = path.dirname(sourceRelPath);
      const absDir = path.join(context.workspaceRoot, sourceDir);
      
      const potentialExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py'];
      for (const ext of ['', ...potentialExtensions]) {
        let trial = importModule;
        if (ext) {
          trial = importModule + ext;
        }
        const trialAbs = path.resolve(absDir, trial);
        const trialRel = path.relative(context.workspaceRoot, trialAbs).replace(/\\/g, '/');
        if (fileTree.includes(trialRel)) {
          return trialRel;
        }
        const indexAbs = path.resolve(absDir, importModule, 'index' + ext);
        const indexRel = path.relative(context.workspaceRoot, indexAbs).replace(/\\/g, '/');
        if (fileTree.includes(indexRel)) {
          return indexRel;
        }
      }
      return null;
    };

    const pythonStdLibs = new Set([
      'os', 'sys', 'json', 'typing', 'datetime', 'time', 'math', 're', 'collections', 'itertools', 'functools',
      'shutil', 'tempfile', 'hashlib', 'uuid', 'logging', 'pathlib', 'random', 'importlib', 'abc', 'unittest',
      'asyncio', 'contextlib', 'argparse', 'urllib', 'http', 'socket', 'threading', 'subprocess', 'select'
    ]);

    for (const relPath of context.fileTree) {
      const absPath = path.join(context.workspaceRoot, relPath);
      if (!fs.existsSync(absPath)) continue;

      let content = '';
      try {
        content = fs.readFileSync(absPath, 'utf-8');
      } catch {
        continue;
      }

      const isPython = relPath.endsWith('.py');
      const lang = isPython ? 'python' : (relPath.endsWith('.ts') || relPath.endsWith('.tsx') ? 'typescript' : 'javascript');
      const isMain = isMainFile(relPath);
      if (isMain) {
        mainFilesSet.add(relPath);
      }

      const codeIntel = analyzeSourceFile(
        absPath,
        content,
        context.workspaceRoot,
        context.dependencies,
        context.devDependencies
      );

      const importsList: string[] = [];
      const missingDepsList: string[] = [];

      for (const extImp of codeIntel.externalImports) {
        let pkgName = extImp.module.split('/')[0];
        
        if (isPython) {
          if (pythonStdLibs.has(pkgName)) {
            continue;
          }
          const pipNameMap: Record<string, string> = {
            'dateutil': 'python-dateutil',
            'yaml': 'pyyaml',
            'dotenv': 'python-dotenv',
            'PIL': 'Pillow',
            'bs4': 'beautifulsoup4',
            'jwt': 'pyjwt',
            'jose': 'python-jose',
            'websocket': 'websocket-client',
            'github': 'pygithub'
          };
          if (pipNameMap[pkgName]) {
            pkgName = pipNameMap[pkgName];
          }
          const allDeps = { ...context.dependencies, ...context.devDependencies };
          const hasDep = allDeps[pkgName] !== undefined;
          importsList.push(pkgName);
          externalLibsSet.add(pkgName);
          if (!hasDep && pkgName !== 'pytest') {
            missingDepsList.push(pkgName);
          }
        } else {
          const allDeps = { ...context.dependencies, ...context.devDependencies };
          const hasDep = allDeps[pkgName] !== undefined;
          importsList.push(pkgName);
          externalLibsSet.add(pkgName);
          if (!hasDep) {
            missingDepsList.push(pkgName);
          }
        }
      }

      for (const intImp of codeIntel.internalImports) {
        const resolvedRelPath = resolveInternalImport(relPath, intImp.module, context.fileTree);
        if (resolvedRelPath) {
          edges.push({
            source: relPath.replace(/\\/g, '/'),
            target: resolvedRelPath.replace(/\\/g, '/'),
            type: 'import'
          });
        }
      }

      const node: GraphNode = {
        id: relPath.replace(/\\/g, '/'),
        label: path.basename(relPath),
        type: isMain ? 'main' : 'file',
        language: lang,
        isMain,
        imports: importsList,
        missingDeps: missingDepsList
      };

      nodes.push(node);
      fileToNodeMap.set(node.id, node);
    }

    for (const lib of externalLibsSet) {
      for (const node of nodes) {
        if (node.imports.includes(lib)) {
          edges.push({
            source: node.id,
            target: lib,
            type: 'dependency'
          });
        }
      }

      const isMissing = nodes.some(n => n.missingDeps.includes(lib));
      nodes.push({
        id: lib,
        label: lib,
        type: 'lib',
        isMain: false,
        imports: [],
        missingDeps: isMissing ? [lib] : []
      });
    }

    return {
      nodes,
      edges,
      mainFiles: Array.from(mainFilesSet).map(f => f.replace(/\\/g, '/')),
      externalLibs: Array.from(externalLibsSet)
    };
  }
}
