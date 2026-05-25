import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';

const execAsync = promisify(exec);
const TEST_RUNNER_URL = process.env.TEST_RUNNER_URL || 'http://test-runner:5000';

export async function runTests(
  filePath: string,
  fileContent: string,
  framework: string,
  workspaceRoot?: string,
  testConfigPath?: string,
  cwd?: string
): Promise<{
  status: 'passed' | 'failed' | 'skipped' | 'error';
  command: string;
  cwd: string;
  exitCode: number | null;
  output: string;
  framework: string;
  testFilePath: string;
  failureReason?: string;
}> {
  console.log(`Running tests in container: framework=${framework}, file=${filePath}, cwd=${cwd}`);

  const mountedRoot = '/app/workspace';
  // Map cwd and test file path into /app/workspace volume
  const mappedCwd = cwd ? (mapIntoWorkspace(cwd, workspaceRoot || '', mountedRoot) || mountedRoot) : mountedRoot;
  const mappedTestPath = mapIntoWorkspace(filePath, workspaceRoot || '', mountedRoot);

  if (!mappedTestPath || !fs.existsSync(mappedTestPath)) {
    return {
      status: 'skipped',
      command: '',
      cwd: mappedCwd,
      exitCode: null,
      output: '',
      framework,
      testFilePath: filePath,
      failureReason:
        'The sidecar cannot see this workspace path. Run tests from the VS Code extension host or mount the workspace into /app/workspace.',
    };
  }

  // Check if workspace is writeable (to avoid EROFS error)
  try {
    fs.accessSync(mappedCwd, fs.constants.W_OK);
  } catch (err) {
    return {
      status: 'error',
      command: '',
      cwd: mappedCwd,
      exitCode: null,
      output: 'Error: EROFS: read-only file system',
      framework,
      testFilePath: filePath,
      failureReason: 'The Docker workspace volume is mounted as read-only. Please restart the Docker stack from the VS Code extension sidebar to update the volume mounts.',
    };
  }

  // Check for node_modules and package.json framework dependencies
  if (framework === 'jest' || framework === 'vitest') {
    const boundary = '/app/workspace';
    if (!hasNodeModules(mappedCwd, boundary)) {
      return {
        status: 'error',
        command: '',
        cwd: mappedCwd,
        exitCode: null,
        output: '',
        framework,
        testFilePath: filePath,
        failureReason: 'Project dependencies are not installed (node_modules not found). Please run "npm install" in your project directory first.',
      };
    }

    const isTypeScript = filePath.endsWith('.ts') || filePath.endsWith('.tsx');
    const hasFramework = isFrameworkDeclared(mappedCwd, boundary, framework) &&
      (framework !== 'jest' || !isTypeScript || isFrameworkDeclared(mappedCwd, boundary, 'ts-jest'));

    if (!hasFramework) {
      return {
        status: 'error',
        command: '',
        cwd: mappedCwd,
        exitCode: null,
        output: '',
        framework,
        testFilePath: filePath,
        failureReason: `Test framework "${framework}" is not declared in your package.json dependencies. Please run "${getInstallCommand(framework)}" in your project directory first.`,
      };
    }
  }

  let mappedConfigPath = '';
  if (testConfigPath) {
    if (path.isAbsolute(testConfigPath) || /^[A-Za-z]:/.test(testConfigPath)) {
      mappedConfigPath = mapIntoWorkspace(testConfigPath, workspaceRoot || '', mountedRoot) || testConfigPath;
    } else {
      mappedConfigPath = testConfigPath;
    }
  }

  let tempConfigPath = '';
  let runConfigPath = mappedConfigPath;

  if (framework === 'jest' && !mappedConfigPath) {
    const existingConfig = findExistingJestConfig(mappedCwd);
    if (existingConfig) {
      runConfigPath = existingConfig;
    } else if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
      tempConfigPath = path.join(mappedCwd, '.jest.config.qa.json');
      const inlineConfigObj = {
        preset: 'ts-jest',
        transform: { '^.+\\.tsx?$': ['ts-jest', { isolatedModules: true }] },
      };
      try {
        fs.writeFileSync(tempConfigPath, JSON.stringify(inlineConfigObj, null, 2), 'utf-8');
        runConfigPath = tempConfigPath;
      } catch (err: any) {
        console.error(`Failed to write temp Jest config in container: ${err.message}`);
        tempConfigPath = '';
      }
    }
  }

  const relativeTestPath = quote(toPosix(path.relative(mappedCwd, mappedTestPath) || mappedTestPath));
  const configArg = runConfigPath && !runConfigPath.includes('#')
    ? ` --config ${quote(toPosix(runConfigPath))}`
    : '';

  // Determine whether to use local node_modules executables or global ones
  let cmd = '';
  if (framework === 'jest') {
    const localJest = path.join(mappedCwd, 'node_modules', '.bin', 'jest');
    if (fs.existsSync(localJest)) {
      cmd = `npx --no-install jest --runTestsByPath ${relativeTestPath}${configArg} --verbose --passWithNoTests 2>&1`;
    } else {
      cmd = `jest --runTestsByPath ${relativeTestPath}${configArg} --verbose --passWithNoTests 2>&1`;
    }
  } else if (framework === 'vitest') {
    const localVitest = path.join(mappedCwd, 'node_modules', '.bin', 'vitest');
    if (fs.existsSync(localVitest)) {
      cmd = `npx --no-install vitest run ${relativeTestPath}${configArg} --reporter=verbose --pool=forks --testTimeout=10000 --passWithNoTests 2>&1`;
    } else {
      cmd = `vitest run ${relativeTestPath}${configArg} --reporter=verbose --pool=forks --testTimeout=10000 --passWithNoTests 2>&1`;
    }
  } else if (framework === 'pytest') {
    cmd = `python -m pytest ${relativeTestPath} -v 2>&1`;
  }

  if (!cmd) {
    if (tempConfigPath && fs.existsSync(tempConfigPath)) {
      try { fs.unlinkSync(tempConfigPath); } catch {}
    }
    return {
      status: 'skipped',
      command: '',
      cwd: mappedCwd,
      exitCode: null,
      output: '',
      framework,
      testFilePath: filePath,
      failureReason: 'No supported test framework was detected. Expected jest, vitest, or pytest.',
    };
  }

  try {
    console.log(`Delegating execution to test-runner container at ${TEST_RUNNER_URL}`);
    const runResult = await postRequest(`${TEST_RUNNER_URL}/run-tests`, {
      command: cmd,
      cwd: mappedCwd,
    });

    const output = stripAnsi((runResult.stdout + (runResult.stderr ? `\n${runResult.stderr}` : '')).trim());
    const exitCode = runResult.exitCode;

    if (exitCode === 0) {
      console.log(`Tests completed successfully`);
      return {
        status: 'passed',
        command: cmd,
        cwd: mappedCwd,
        exitCode: 0,
        output,
        framework,
        testFilePath: filePath
      };
    } else {
      console.log(`Tests completed with exit code: ${exitCode}`);
      const failureReason = describeFailure(framework, exitCode, output, runConfigPath || '', mappedCwd, filePath);
      return {
        status: 'failed',
        command: cmd,
        cwd: mappedCwd,
        exitCode,
        output,
        framework,
        testFilePath: filePath,
        failureReason,
      };
    }
  } catch (err: any) {
    console.error(`Delegation error: ${err.message}`);
    return {
      status: 'error',
      command: cmd,
      cwd: mappedCwd,
      exitCode: null,
      output: err.message || 'Sidecar failed to communicate with the test-runner container.',
      framework,
      testFilePath: filePath,
      failureReason: `Test runner agent communication failed: ${err.message}`,
    };
  } finally {
    if (tempConfigPath && fs.existsSync(tempConfigPath)) {
      try {
        fs.unlinkSync(tempConfigPath);
        console.log(`Deleted temp Jest config in container: ${tempConfigPath}`);
      } catch (err: any) {
        console.error(`Failed to delete temp Jest config in container: ${err.message}`);
      }
    }
  }
}

function postRequest(urlStr: string, body: any): Promise<{ exitCode: number; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(urlStr);

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname || '/run-tests',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 130000,
      },
      (res) => {
        let responseData = '';
        res.on('data', (chunk) => (responseData += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(responseData));
          } catch (err) {
            reject(new Error(`Invalid JSON response from test-runner: ${responseData.slice(0, 200)}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Test-runner request timed out'));
    });
    req.write(data);
    req.end();
  });
}

function describeFailure(framework: string, exitCode: number, output: string, testConfigPath: string, cwd?: string, filePath?: string): string {
  if (/EROFS|read-only file system/i.test(output)) {
    return 'The Docker workspace volume is mounted as read-only. Please restart the Docker stack from the VS Code extension sidebar to update the volume mounts.';
  }
  if (framework === 'jest' || framework === 'vitest') {
    const boundary = '/app/workspace';
    if (cwd && !hasNodeModules(cwd, boundary)) {
      return 'Project dependencies are not installed (node_modules not found). Please run "npm install" in your project directory first.';
    }
    if (cwd) {
      const isTypeScript = filePath ? (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) : false;
      const hasFramework = isFrameworkDeclared(cwd, boundary, framework) &&
        (framework !== 'jest' || !isTypeScript || isFrameworkDeclared(cwd, boundary, 'ts-jest'));
      if (!hasFramework) {
        return `Test framework "${framework}" is not declared in your package.json dependencies. Please run "${getInstallCommand(framework)}" in your project directory first.`;
      }
    }
  }
  if (/could not find a config file|Can't find a root directory|No tests found/i.test(output)) {
    return `${framework} could not find runnable tests or project config from the workspace root. Config detected: ${testConfigPath || 'none'}.`;
  }
  if (/Cannot find module|Module not found|ERR_MODULE_NOT_FOUND|ImportError|ModuleNotFoundError|Failed to resolve import/i.test(output)) {
    const lines = output.split('\n');
    const matchedLines = lines.filter(l => 
      /Cannot find module|Module not found|ERR_MODULE_NOT_FOUND|ImportError|ModuleNotFoundError|Failed to resolve import/i.test(l)
    );
    const details = matchedLines.length > 0
      ? matchedLines.map(l => l.trim()).slice(0, 3).join('\n')
      : output.slice(0, 300);
    return `The generated test could not import the code under test or a project dependency. Details:\n${details}`;
  }
  if (
    /command not found|not recognized as an internal or external command|could not determine executable/i.test(output) ||
    /npx canceled due to missing packages|npm error.*missing packages|npm ERR!.*missing packages/i.test(output)
  ) {
    return `${framework} is not available in this workspace. Make sure it is installed, then run again.`;
  }
  if (/timeout/i.test(output)) {
    return 'The test command timed out after 180 seconds. This usually means a generated test has a hanging promise or infinite loop. Check the test file for unresolved promises.';
  }
  // Assertion failures — tests ran but some failed. This is normal test behavior, not a pipeline bug.
  if (/FAIL|✕|✗|×|failed/i.test(output)) {
    // 1. Jest format: Tests: 5 failed, 5 passed, 10 total
    const jestMatch = output.match(/Tests:\s*(?:(\d+)\s+failed,\s*)?(?:(\d+)\s+passed)?/i);
    if (jestMatch) {
      const failed = jestMatch[1] || '0';
      const passed = jestMatch[2] || '0';
      if (failed !== '0' || passed !== '0') {
        return `Tests ran: ${passed} passed, ${failed} failed. Some test assertions did not match expected values. Review the test output for details.`;
      }
    }
    // 2. Vitest format: Tests  5 failed | 5 passed (10)
    const vitestMatch = output.match(/Tests\s+(?:(\d+)\s+failed)?\s*(?:\|)?\s*(?:(\d+)\s+passed)?/i);
    if (vitestMatch) {
      const failed = vitestMatch[1] || '0';
      const passed = vitestMatch[2] || '0';
      if (failed !== '0' || passed !== '0') {
        return `Tests ran: ${passed} passed, ${failed} failed. Some test assertions did not match expected values. Review the test output for details.`;
      }
    }
    // 3. Fallback matching
    const failCount = output.match(/(\d+)\s+(?:failing|failed)/i);
    const passCount = output.match(/(\d+)\s+(?:passing|passed)/i);
    if (failCount || passCount) {
      return `Tests ran: ${passCount?.[1] || '?'} passed, ${failCount?.[1] || '?'} failed. Some test assertions did not match expected values. Review the test output for details.`;
    }
  }
  if (/SyntaxError|Unexpected token|Parse error/i.test(output)) {
    return 'The generated test file contains a syntax error. The AI produced invalid code that could not be parsed.';
  }
  if (/ReferenceError:\s*(\w+)\s+is not defined/i.test(output)) {
    const match = output.match(/ReferenceError:\s*(\w+)\s+is not defined/i);
    return `The generated test references "${match?.[1]}" which is not defined. The AI likely used an import or variable that doesn't exist in the project.`;
  }
  if (/TypeError/i.test(output)) {
    return 'The generated test has a TypeError — likely calling a function incorrectly or using a mocked value wrong. Review mock setup in the test file.';
  }
  return `The test command exited with code ${exitCode}. Review the test output above for details.`;
}

function hasNodeModules(startDir: string, boundaryDir: string): boolean {
  let current = path.resolve(startDir);
  const boundary = boundaryDir ? path.resolve(boundaryDir) : current;
  while (true) {
    if (fs.existsSync(path.join(current, 'node_modules'))) {
      return true;
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
  return false;
}

function isFrameworkDeclared(startDir: string, boundaryDir: string, framework: string): boolean {
  let current = path.resolve(startDir);
  const boundary = boundaryDir ? path.resolve(boundaryDir) : current;
  while (true) {
    const pkgPath = path.join(current, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        if (allDeps[framework]) {
          return true;
        }
      } catch {
        // ignore
      }
    }
    if (fs.existsSync(path.join(current, 'node_modules'))) {
      break;
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
  return false;
}

function mapIntoWorkspace(filePath: string, workspaceRoot: string, mountedRoot: string): string {
  if (!workspaceRoot) {
    return path.join(mountedRoot, path.basename(filePath));
  }

  const normalizedFile = normalizeExternalPath(filePath);
  const normalizedRoot = normalizeExternalPath(workspaceRoot);
  const relative = path.posix.relative(normalizedRoot, normalizedFile);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return '';
  }
  return path.join(mountedRoot, relative);
}

function normalizeExternalPath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):/, (_match, drive) => `/${drive.toLowerCase()}`);
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

function stripAnsi(str: string): string {
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

function getInstallCommand(framework: string): string {
  if (framework === 'vitest') {
    return 'npm install -D vitest';
  }
  if (framework === 'jest') {
    return 'npm install -D jest @jest/globals ts-jest';
  }
  if (framework === 'pytest') {
    return 'python -m pip install pytest';
  }
  return `npm install -D ${framework}`;
}

function findExistingJestConfig(cwd: string): string {
  const configNames = [
    'jest.config.ts',
    'jest.config.js',
    'jest.config.mjs',
    'jest.config.cjs',
    'jest.config.json',
  ];
  let current = cwd;
  const boundary = '/app/workspace';
  for (let i = 0; i < 10; i++) {
    for (const name of configNames) {
      const configPath = path.join(current, name);
      if (fs.existsSync(configPath)) {
        return configPath;
      }
    }
    const pkgPath = path.join(current, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.jest) {
          return '';
        }
      } catch { /* ignore */ }
    }
    if (path.resolve(current) === path.resolve(boundary)) { break; }
    const parent = path.dirname(current);
    if (parent === current) { break; }
    current = parent;
  }
  return '';
}

export async function installPackage(
  packageManager: string,
  packageName: string,
  cwd?: string,
  workspaceRoot?: string
): Promise<{ success: boolean; output: string; error?: string }> {
  console.log(`Installing package in container: packageManager=${packageManager}, packageName=${packageName}, cwd=${cwd}, workspaceRoot=${workspaceRoot}`);

  const mountedRoot = '/app/workspace';
  const mappedCwd = cwd ? (mapIntoWorkspace(cwd, workspaceRoot || '', mountedRoot) || mountedRoot) : mountedRoot;

  let cmd = '';
  if (packageName.toLowerCase() === 'pytest') {
    cmd = 'pip3 install --break-system-packages pytest';
  } else {
    switch (packageManager) {
      case 'yarn':
        cmd = `yarn add ${packageName}`;
        break;
      case 'pnpm':
        cmd = `pnpm add ${packageName}`;
        break;
      case 'bun':
        cmd = `bun add ${packageName}`;
        break;
      default:
        cmd = `npm install ${packageName}`;
    }
  }

  try {
    const runResult = await postRequest(`${TEST_RUNNER_URL}/run-tests`, {
      command: cmd,
      cwd: mappedCwd,
    });

    const output = stripAnsi((runResult.stdout + (runResult.stderr ? `\n${runResult.stderr}` : '')).trim());
    if (runResult.exitCode === 0) {
      return { success: true, output };
    } else {
      return { success: false, output, error: runResult.error || `Exit code ${runResult.exitCode}` };
    }
  } catch (err: any) {
    return { success: false, output: err.message || '', error: err.message };
  }
}

