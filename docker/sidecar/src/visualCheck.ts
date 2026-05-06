import { chromium, Browser } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const PLAYWRIGHT_SERVICE_URL = process.env.PLAYWRIGHT_SERVICE_URL || 'http://playwright-runner:3000';

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    try {
      // Try connecting to the playwright-runner service
      browser = await chromium.connect(`ws://${new URL(PLAYWRIGHT_SERVICE_URL).host}`);
    } catch {
      // Fallback: launch locally (if Chromium is available in this container)
      browser = await chromium.launch({ headless: true });
    }
  }
  return browser;
}

async function takeScreenshot(url: string): Promise<Buffer> {
  const browserInstance = await getBrowser();
  const page = await browserInstance.newPage({ viewport: { width: 1280, height: 720 } });

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    return screenshot;
  } finally {
    await page.close();
  }
}

function pngFromBuffer(buf: Buffer): PNG {
  return PNG.sync.read(buf);
}

export async function runVisualCheck(
  localUrl: string,
  productionUrl: string
): Promise<{
  diffBase64: string;
  localBase64: string;
  productionBase64: string;
  deltaPercent: number;
  pixelsChanged: number;
  totalPixels: number;
}> {
  console.log(`Visual check: ${localUrl} vs ${productionUrl}`);

  // Take screenshots in parallel
  const [localBuf, prodBuf] = await Promise.all([
    takeScreenshot(localUrl),
    takeScreenshot(productionUrl),
  ]);

  const localPng = pngFromBuffer(localBuf);
  const prodPng = pngFromBuffer(prodBuf);

  // Normalize dimensions to the larger of the two
  const width = Math.max(localPng.width, prodPng.width);
  const height = Math.max(localPng.height, prodPng.height);

  // Create canvases with normalized dimensions
  const normalizeToSize = (png: PNG, w: number, h: number): PNG => {
    if (png.width === w && png.height === h) { return png; }
    const normalized = new PNG({ width: w, height: h });
    PNG.bitblt(png, normalized, 0, 0, Math.min(png.width, w), Math.min(png.height, h), 0, 0);
    return normalized;
  };

  const normLocal = normalizeToSize(localPng, width, height);
  const normProd = normalizeToSize(prodPng, width, height);

  // Compute diff
  const diff = new PNG({ width, height });
  const pixelsChanged = pixelmatch(
    normLocal.data,
    normProd.data,
    diff.data,
    width,
    height,
    { threshold: 0.1 }
  );

  const totalPixels = width * height;
  const deltaPercent = (pixelsChanged / totalPixels) * 100;

  // Encode to base64
  const diffBase64 = PNG.sync.write(diff).toString('base64');
  const localBase64 = localBuf.toString('base64');
  const productionBase64 = prodBuf.toString('base64');

  console.log(`Visual check complete: ${deltaPercent.toFixed(2)}% diff (${pixelsChanged}/${totalPixels})`);

  return {
    diffBase64,
    localBase64,
    productionBase64,
    deltaPercent,
    pixelsChanged,
    totalPixels,
  };
}
