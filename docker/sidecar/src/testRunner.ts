import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

export async function runTests(
  filePath: string,
  fileContent: string,
  framework: string,
  workspaceRoot?: string,
  testConfigPath?: string
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
  console.log(`Running tests: framework=${framework}, file=${filePath}`);

  const mountedRoot = '/app/workspace';
  const cwd = fs.existsSync(mountedRoot) ? mountedRoot : (workspaceRoot || path.dirname(filePath));
  const mappedTestPath = mapIntoWorkspace(filePath, workspaceRoot || '', mountedRoot);

  if (!mappedTestPath || !fs.existsSync(mappedTestPath)) {
    return {
      status: 'skipped',
      command: '',
      cwd,
      exitCode: null,
      output: '',
      framework,
      testFilePath: filePath,
      failureReason:
        'The sidecar cannot see this workspace path. Run tests from the VS Code extension host or mount the workspace into /app/workspace.',
    };
  }

  const relativeTestPath = quote(toPosix(path.relative(cwd, mappedTestPath) || mappedTestPath));
  const configArg = testConfigPath && !testConfigPath.includes('#')
    ? ` --config ${quote(toPosix(testConfigPath))}`
    : '';

  const commands: Record<string, string> = {
    jest: `npx --no-install jest --runTestsByPath ${relativeTestPath}${configArg} --verbose 2>&1`,
    vitest: `npx --no-install vitest run ${relativeTestPath}${configArg} 2>&1`,
    pytest: `python -m pytest ${relativeTestPath} -v 2>&1`,
  };

  const cmd = commands[framework];
  if (!cmd) {
    return {
      status: 'skipped',
      command: '',
      cwd,
      exitCode: null,
      output: '',
      framework,
      testFilePath: filePath,
      failureReason: 'No supported test framework was detected. Expected jest, vitest, or pytest.',
    };
  }

  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: 120000, // 2 min timeout
      cwd,
      maxBuffer: 1024 * 1024 * 10,
    });

    const output = stdout + (stderr ? `\n${stderr}` : '');
    console.log(`Tests completed successfully`);

    return { status: 'passed', command: cmd, cwd, exitCode: 0, output, framework, testFilePath: filePath };
  } catch (err: any) {
    const output = `${err.stdout || ''}${err.stderr ? `\n${err.stderr}` : ''}`.trim() || err.message || '';
    console.log(`Tests completed with exit code: ${err.code || 1}`);

    return {
      status: 'failed',
      command: cmd,
      cwd,
      exitCode: err.code || 1,
      output,
      framework,
      testFilePath: filePath,
      failureReason: `The test command exited with code ${err.code || 1}.`,
    };
  }
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
