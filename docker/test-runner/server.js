const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 5000;

function rmrf(target) {
  if (!target) { return; }
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    console.error(`Failed to clean up "${target}": ${err.message}`);
  }
}

const server = http.createServer((req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.url === '/run-tests' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      let cleanupDir = null;
      try {
        const payload = JSON.parse(body);
        const { command, cwd, files, cleanupDir: cleanup } = payload;
        cleanupDir = cleanup || null;

        if (!command) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing command' }));
          return;
        }

        // Optionally materialize an ephemeral sandbox of files BEFORE running.
        // These are written under /app/sandbox/<id> — never the mounted workspace.
        if (Array.isArray(files)) {
          for (const file of files) {
            if (!file || !file.path) { continue; }
            const target = path.isAbsolute(file.path)
              ? file.path
              : path.join('/app/sandbox', file.path);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, file.content != null ? String(file.content) : '', 'utf-8');
          }
        }

        console.log(`Executing command: "${command}" in cwd: "${cwd || '.'}"`);

        exec(command, { cwd: cwd || undefined, timeout: 120000, killSignal: 'SIGKILL', maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
          // Always wipe the ephemeral sandbox after the run.
          rmrf(cleanupDir);

          const exitCode = error ? (error.code !== undefined && error.code !== null ? error.code : 1) : 0;
          const timedOut = Boolean(error && error.killed);
          const note = timedOut
            ? '\n[runner] The test process exceeded the 120s limit and was killed. ' +
              'A test (often the stress tier) is too slow, has an infinite loop, or never finishes.'
            : '';
          const responsePayload = {
            exitCode,
            stdout,
            stderr: (stderr || '') + note,
            error: error ? error.message : null
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(responsePayload));
        });
      } catch (err) {
        rmrf(cleanupDir);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Test Runner Server listening on port ${PORT}`);
});
