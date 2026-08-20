import { chromium } from 'playwright';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LOCAL_DATA_DIR =
  process.env.LAZADA_BOT_DATA_DIR ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'lazada-stock-bot');

export const DATA_DIR = LOCAL_DATA_DIR;
export const PROFILE_DIR = path.join(DATA_DIR, 'profile');
export const SESSION_FILE = path.join(DATA_DIR, 'session.json');

mkdirSync(PROFILE_DIR, { recursive: true });

export async function launch(config, options = {}) {
  const isHeadless = options.headless !== undefined ? !!options.headless : !!config.headless;
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: isHeadless,
    viewport: { width: 1366, height: 900 },
    locale: 'en-SG',
    timezoneId: 'Asia/Singapore',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });

  // Stealth script to mask Playwright/automation fingerprints
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = window.chrome || { runtime: {} };

    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    }
  });

  context.setDefaultTimeout(30000);

  // Block images, videos, and fonts during monitoring if configured (reduces bandwidth and speeds up page checks)
  const shouldBlockImages = options.blockImages !== undefined ? options.blockImages : config.blockImages;
  if (shouldBlockImages) {
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'media' || type === 'font') {
        return route.abort();
      }
      return route.continue();
    });
  }

  await applySavedSession(context);

  return context;
}

async function applySavedSession(context) {
  if (!existsSync(SESSION_FILE)) return;

  try {
    const state = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
    const cookies = state.cookies || [];
    if (cookies.length) {
      await context.addCookies(cookies);
      console.log(`Applied saved Lazada session (${cookies.length} cookies) from ${SESSION_FILE}`);
    }
  } catch (err) {
    console.log(`Could not load saved session (${err.message}) — starting fresh.`);
  }
}

export async function saveSession(context) {
  try {
    await context.storageState({ path: SESSION_FILE });
  } catch (err) {
    console.log(`Could not save session state: ${err.message}`);
  }
}

export function randomDelay(minMs, maxMs) {
  return new Promise((resolve) => {
    const ms = Math.floor(minMs + Math.random() * (maxMs - minMs));
    setTimeout(resolve, ms);
  });
}
