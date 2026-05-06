import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execAsync = promisify(exec);
const TEST_RUNNER_URL = process.env.TEST_RUNNER_URL || 'http://test-runner:5000';

export async function runTests(
  filePath: string,
  fileContent: string,
  framework: string
): Promise<{ output: string; exitCode: number }> {
  console.log(`Running tests: framework=${framework}, file=${filePath}`);

  // Write the test content to a temporary file
  const tmpDir = path.join(os.tmpdir(), 'automated-qa-tests');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  const basename = path.basename(filePath);
  const tmpFile = path.join(tmpDir, basename);
  fs.writeFileSync(tmpFile, fileContent, 'utf-8');

  // Also copy the original source file if referenced in imports
  const sourceDir = path.dirname(filePath);
  const workspaceRoot = '/app/workspace';
  const relativeSourceDir = sourceDir.replace(/^[A-Z]:\\/i, '').replace(/\\/g, '/');

  // Build the test command
  const commands: Record<string, string> = {
    jest: `npx jest "${tmpFile}" --no-cache --verbose --forceExit 2>&1`,
    vitest: `npx vitest run "${tmpFile}" 2>&1`,
    pytest: `python -m pytest "${tmpFile}" -v 2>&1`,
  };

  const cmd = commands[framework] || commands.jest;

  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: 120000, // 2 min timeout
      cwd: tmpDir,
      env: {
        ...process.env,
        NODE_PATH: path.join(workspaceRoot, 'node_modules'),
      },
    });

    const output = stdout + (stderr ? `\n${stderr}` : '');
    console.log(`Tests completed successfully`);

    // Cleanup
    try { fs.unlinkSync(tmpFile); } catch {}

    return { output, exitCode: 0 };
  } catch (err: any) {
    const output = err.stdout || '' + (err.stderr ? `\n${err.stderr}` : '') + (err.message || '');
    console.log(`Tests completed with exit code: ${err.code || 1}`);

    // Cleanup
    try { fs.unlinkSync(tmpFile); } catch {}

    return { output, exitCode: err.code || 1 };
  }
}
