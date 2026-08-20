import { readFileSync, existsSync, rmSync } from 'node:fs';
import { launch, saveSession, SESSION_FILE, DATA_DIR } from './browser.js';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

// Check for --fresh flag to start from scratch if cookies were corrupted
if (process.argv.includes('--fresh') && existsSync(SESSION_FILE)) {
  try {
    rmSync(SESSION_FILE, { force: true });
    console.log('Cleared existing session.json to start fresh.');
  } catch {
    // ignore
  }
}

console.log('Launching browser for login...');
const context = await launch(config, { blockImages: false, headless: false });

// Reuse the first tab that Playwright automatically creates in persistent context
const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

try {
  await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
} catch (err) {
  if (err.message.includes('ERR_ABORTED') || err.message.includes('frame was detached')) {
    console.log('Initial navigation redirected by Lazada. Waiting for page to settle...');
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  } else {
    console.warn(`Initial navigation notice: ${err.message}`);
  }
}

console.log('\n======================================================');
console.log('Browser opened. Please log in to Lazada in that window:');
console.log('  1. Sign in to your account.');
console.log('  2. Solve any slide CAPTCHA if prompted.');
console.log('  3. Ensure the homepage or your account name is visible.');
console.log('======================================================');
console.log('\nPress Enter in THIS terminal once you have logged in...\n');

await new Promise((resolve) => process.stdin.once('data', resolve));

// Check if user is logged in
try {
  const loginLinks = await page.locator('a[href*="login"], button:has-text("Login"), span:has-text("Login")').count();
  if (loginLinks > 0) {
    console.log('\n⚠️ NOTE: The page still shows a Login link. If you did not finish logging in, run "npm run login" again.');
  } else {
    console.log('\n✅ Confirmed login — session captured!');
  }
} catch {
  // Proceed with saving session
}

await saveSession(context);
console.log(`\nSession saved to: ${SESSION_FILE}`);
console.log('You can close the browser window now. Then run "npm start" to monitor products.\n');

await context.close();
process.exit(0);

