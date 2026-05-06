import express from 'express';
import cors from 'cors';
import { aiComplete } from './aiProxy';
import { runVisualCheck } from './visualCheck';
import { runTests } from './testRunner';

const app = express();
const PORT = parseInt(process.env.PORT || '4777', 10);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// AI Completion proxy
app.post('/ai-complete', async (req, res) => {
  try {
    const { prompt, provider, apiKey, model } = req.body;
    if (!prompt || !provider) {
      return res.status(400).json({ error: 'Missing prompt or provider' });
    }
    const response = await aiComplete(prompt, provider, apiKey, model);
    res.json({ response });
  } catch (err: any) {
    console.error('AI completion error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Visual QA check
app.post('/visual-check', async (req, res) => {
  try {
    const { localUrl, productionUrl } = req.body;
    if (!localUrl || !productionUrl) {
      return res.status(400).json({ error: 'Missing localUrl or productionUrl' });
    }
    const result = await runVisualCheck(localUrl, productionUrl);
    res.json(result);
  } catch (err: any) {
    console.error('Visual check error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Test runner
app.post('/run-tests', async (req, res) => {
  try {
    const { filePath, fileContent, framework, workspaceRoot, testConfigPath } = req.body;
    if (!filePath || !fileContent) {
      return res.status(400).json({ error: 'Missing filePath or fileContent' });
    }
    const result = await runTests(filePath, fileContent, framework || 'jest', workspaceRoot, testConfigPath);
    res.json(result);
  } catch (err: any) {
    console.error('Test runner error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Automated QA Sidecar running on port ${PORT}`);
});
