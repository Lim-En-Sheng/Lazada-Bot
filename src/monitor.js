import { readFileSync } from 'node:fs';
import { launch, saveSession, randomDelay, DATA_DIR } from './browser.js';
import { notify } from './notify.js';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

const once = process.argv.includes('--once');
const pollIntervalMs = (config.pollIntervalSeconds || 25) * 1000;
const status = new Map();
let wasLoggedIn = null;
let lastKeepAliveTime = 0;
const KEEP_ALIVE_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function humanLikeWait(minMs = 1200, maxMs = 3000) {
  return randomDelay(minMs, maxMs);
}

function cleanUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const u = new URL(rawUrl);
    // Keep pathname and protocol/host, strip heavy affiliate/share tracking query params
    return `${u.origin}${u.pathname}`;
  } catch {
    return rawUrl;
  }
}

async function pageText(page) {
  return page.locator('body').innerText().catch(() => '');
}

async function isCaptchaOrBlock(page) {
  const currentUrl = page.url();
  if (
    currentUrl.includes('punish') ||
    currentUrl.includes('challenge') ||
    currentUrl.includes('verify.lazada') ||
    currentUrl.includes('x5sec')
  ) {
    return true;
  }

  const captchaSelectors = [
    '#punish-box',
    '.nc_wrapper',
    '#nc_1_wrapper',
    '.baxia-dialog',
    '#baxia-dialog-content',
    'iframe[src*="punish"]',
    'iframe[src*="challenge"]',
    '.nc-container',
  ];

  for (const selector of captchaSelectors) {
    if ((await page.locator(selector).count()) > 0) {
      return true;
    }
  }

  return false;
}

async function selectVariant(page, product) {
  if (!product.variantLabel) return true;

  try {
    const option = page
      .getByRole('button', { name: new RegExp(`^${product.variantLabel}$`, 'i') })
      .or(page.getByRole('button', { name: new RegExp(product.variantLabel, 'i') }))
      .or(page.locator(`[title="${product.variantLabel}"]`))
      .or(
        page
          .locator(`button, [role="button"], span, div.sku-prop-content`)
          .filter({ hasText: new RegExp(product.variantLabel, 'i') })
      )
      .first();

    if (await option.count()) {
      await option.scrollIntoViewIfNeeded().catch(() => {});
      await humanLikeWait(300, 700);
      await option.click().catch(() => {});
      await humanLikeWait(800, 1500);
      log(`Selected variant "${product.variantLabel}" for ${product.name}`);
      return true;
    } else {
      log(`Warning: Variant "${product.variantLabel}" not found on page for ${product.name}`);
      return false;
    }
  } catch (err) {
    log(`Failed to select variant "${product.variantLabel}": ${err.message}`);
    return false;
  }
}

async function detectStock(page, product) {
  const targetUrl = cleanUrl(product.url);
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (err) {
    if (err.message.includes('ERR_ABORTED') || err.message.includes('frame was detached')) {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    } else {
      throw err;
    }
  }
  await randomDelay(800, 1400);

  // 1. Check for anti-bot / CAPTCHA challenge
  if (await isCaptchaOrBlock(page)) {
    log(`⚠️ CAPTCHA / Punish verification triggered on ${product.name}!`);
    notify(
      'CAPTCHA REQUIRED',
      `Lazada requires manual verification for ${product.name}. Please solve it in the browser window!`,
      { url: product.url, time: new Date().toLocaleTimeString() }
    );
    return 'captcha';
  }

  // 2. Select variant FIRST before evaluating button disabled state
  if (product.variantLabel) {
    await selectVariant(page, product);
  }

  // 3. Inspect Add to Cart / Buy Now buttons
  const addBtn = page.getByRole('button', { name: /add to cart|buy now/i }).first();

  if (await addBtn.count()) {
    const disabled = await addBtn.isDisabled().catch(() => true);
    const ariaDisabled = (await addBtn.getAttribute('aria-disabled')) === 'true';
    const classAttr = (await addBtn.getAttribute('class')) || '';
    const hasDisabledClass = /disabled|sold-out|unavailable/i.test(classAttr);

    if (!disabled && !ariaDisabled && !hasDisabledClass) {
      return 'in';
    }
    return 'out';
  }

  // 4. Text fallbacks for out-of-stock messages
  const text = await pageText(page);

  if (/out of stock|sold out|temporarily unavailable|item is unavailable/i.test(text)) {
    return 'out';
  }

  if (await page.getByRole('button', { name: /notify me|notify me when available/i }).first().count()) {
    return 'out';
  }

  return 'unknown';
}

async function addToCart(page, product) {
  if (product.variantLabel) {
    await selectVariant(page, product);
  }

  const quantity = Math.max(1, Number(product.quantity) || 1);

  // If quantity > 1, attempt to set the quantity input
  if (quantity > 1) {
    try {
      const qtyInput = page.locator('input.next-number-picker-input, input[type="number"]').first();
      if (await qtyInput.count()) {
        await qtyInput.click().catch(() => {});
        await qtyInput.fill(String(quantity)).catch(() => {});
        await qtyInput.press('Enter').catch(() => {});
        await humanLikeWait(400, 800);
      }
    } catch {
      // Stepper fallback
    }
  }

  const addBtn = page.getByRole('button', { name: /add to cart/i }).first();
  if (!(await addBtn.count())) {
    log(`Could not find "Add to Cart" button for ${product.name}`);
    return false;
  }

  await addBtn.scrollIntoViewIfNeeded().catch(() => {});
  await humanLikeWait(400, 800);
  await addBtn.click();

  // Wait for confirmation drawer or popup
  const ok = await page
    .getByRole('button', { name: /checkout now|view cart|go to cart|checkout/i })
    .or(page.getByText(/added to cart/i))
    .first()
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);

  if (ok) {
    log(`✅ ${product.name}: Successfully added to cart (Qty: ${quantity}).`);
  } else {
    const text = await pageText(page);
    if (/please select|choose (a )?(variant|option|sku)/i.test(text)) {
      log(`${product.name}: Needs a variant selected — set "variantLabel" in config.json.`);
      return false;
    }
    log(`${product.name}: Added to cart (modal not explicitly confirmed — check cart).`);
  }

  await humanLikeWait(1000, 2000);

  // Close any drawer / popup modal so it doesn't block future interactions
  const closeBtn = page
    .locator('button, .next-dialog-close, [aria-label="Close"]')
    .filter({ hasText: /close|skip|×/i })
    .first();
  if (await closeBtn.count()) {
    await closeBtn.click().catch(() => {});
  }

  return true;
}

async function looksLoggedIn(page) {
  const loginLink = page.locator('a[href*="login"], button:has-text("Login"), span:has-text("Login")').first();
  return (await loginLink.count()) === 0;
}

async function keepAlive(page) {
  const now = Date.now();
  if (now - lastKeepAliveTime < KEEP_ALIVE_INTERVAL_MS) {
    return;
  }
  lastKeepAliveTime = now;

  try {
    await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await randomDelay(1500, 3000);
    const loggedIn = await looksLoggedIn(page);
    if (loggedIn !== wasLoggedIn) {
      log(
        loggedIn
          ? 'Session: Logged in (keep-alive verified).'
          : '⚠️ WARNING: Session looks logged OUT — re-run "npm run login".'
      );
    }
    wasLoggedIn = loggedIn;
  } catch (err) {
    if (err.message.includes('ERR_ABORTED') || err.message.includes('frame was detached')) {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    } else {
      log(`Keep-alive ping failed: ${err.message}`);
    }
  }
}

async function checkProduct(page, product) {
  try {
    const prev = status.get(product.url) || 'unknown';
    const stock = await detectStock(page, product);

    if (stock === 'out') {
      if (prev !== 'out') {
        log(`${product.name}: OUT OF STOCK`);
      }
    } else if (stock === 'in') {
      log(`🎉 ${product.name}: IN STOCK!`);
      if (prev !== 'in') {
        log(`${product.name}: Restock detected — adding to cart...`);
        await addToCart(page, product);
        notify('IN STOCK', `${product.name} was added to your Lazada cart. Check out now!`, {
          url: product.url,
          time: new Date().toLocaleTimeString(),
        });
      }
    } else if (stock === 'captcha') {
      log(`${product.name}: Waiting for user to solve CAPTCHA...`);
    } else {
      log(`${product.name}: Unknown stock state — page structure may have changed or is loading slowly.`);
    }
    status.set(product.url, stock);
  } catch (err) {
    log(`ERROR checking ${product.name}: ${err.message}`);
    status.set(product.url, 'unknown');
  }
}

async function searchStoreForSnipe(page, target) {
  if (target.discoveredUrl) {
    // If URL was already discovered in a previous check, monitor it directly
    return checkProduct(page, {
      name: `${target.name} [SNIPED]`,
      url: target.discoveredUrl,
      quantity: target.quantity || 1,
      variantLabel: target.variantLabel || null,
    });
  }

  const storeUrl = target.storeUrl || 'https://www.lazada.sg/shop/pokemon-store-online-singapore/?tab=products';
  log(`[Sniper] Scanning store for "${target.name}" matching [${target.keywords.join(', ')}]...`);

  try {
    await page.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (err) {
    if (err.message.includes('ERR_ABORTED') || err.message.includes('frame was detached')) {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    } else {
      log(`[Sniper] Store page navigation notice: ${err.message}`);
    }
  }

  await randomDelay(800, 1400);

  if (await isCaptchaOrBlock(page)) {
    log(`⚠️ CAPTCHA / Punish verification triggered on store page!`);
    notify(
      'CAPTCHA REQUIRED',
      `Lazada requires manual verification on seller store page. Please solve it in the browser!`,
      { url: storeUrl, time: new Date().toLocaleTimeString() }
    );
    return;
  }

  // Extract all product links and their titles from the store page
  const items = await page.locator('a[href*="/products/"]').evaluateAll((anchors) => {
    return anchors.map((a) => {
      const href = a.href || '';
      let title = a.getAttribute('title') || a.innerText || '';
      if (!title || title.trim().length < 3) {
        const parent = a.closest('[data-qa-locator="product-item"], .product-card, .shop-product-item, div');
        if (parent) {
          title = parent.innerText || '';
        }
      }
      return { href, title: title.replace(/\s+/g, ' ').trim() };
    });
  });

  const keywords = (target.keywords || []).map((k) => k.toLowerCase().trim());
  const excludeKeywords = (target.excludeKeywords || []).map((k) => k.toLowerCase().trim());

  let matchedItem = null;

  for (const item of items) {
    if (!item.href || !item.href.includes('/products/')) continue;
    const lowerTitle = (item.title + ' ' + item.href).toLowerCase();

    // Check if title/href matches all required keywords
    const matchesAll = keywords.every((kw) => lowerTitle.includes(kw));
    // Check if title/href matches any excluded keywords
    const hasExcluded = excludeKeywords.some((ex) => lowerTitle.includes(ex));

    if (matchesAll && !hasExcluded) {
      matchedItem = item;
      break;
    }
  }

  if (matchedItem) {
    const cleanFoundUrl = cleanUrl(matchedItem.href);
    target.discoveredUrl = cleanFoundUrl;

    log(`🚨 SNIPER HIT! Discovered unpublished listing: "${matchedItem.title}"`);
    log(`🔗 Direct link: ${cleanFoundUrl}`);

    notify(
      '🚨 SNIPER HIT: PRODUCT DISCOVERED!',
      `Found newly published product: "${matchedItem.title}"!\nNavigating & auto-adding to cart now...`,
      {
        url: cleanFoundUrl,
        time: new Date().toLocaleTimeString(),
      }
    );

    // Immediately evaluate stock and add to cart
    await checkProduct(page, {
      name: `${target.name} (${matchedItem.title})`,
      url: cleanFoundUrl,
      quantity: target.quantity || 1,
      variantLabel: target.variantLabel || null,
    });
  } else {
    log(`[Sniper] No matching product for [${target.keywords.join(', ')}] yet (${items.length} store items scanned).`);
  }
}

function getScheduleStatus(scheduleConfig) {
  if (!scheduleConfig || !scheduleConfig.enabled) {
    return { active: true };
  }

  const tz = scheduleConfig.timezone || 'Asia/Singapore';
  const now = new Date();

  // Extract current time in 24-hr format for Singapore timezone
  const timeFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const [hourStr, minStr] = timeFormatter.format(now).split(':');
  const currentMinutes = Number(hourStr) * 60 + Number(minStr);

  const [startH, startM] = (scheduleConfig.startTime || '00:30').split(':').map(Number);
  const startMinutes = startH * 60 + startM;

  const [endH, endM] = (scheduleConfig.endTime || '14:00').split(':').map(Number);
  const endMinutes = endH * 60 + endM;

  let isActive = false;
  if (startMinutes <= endMinutes) {
    isActive = currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Overnight window
    isActive = currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }

  let minutesUntilStart = startMinutes - currentMinutes;
  if (minutesUntilStart <= 0) {
    minutesUntilStart += 24 * 60;
  }

  return {
    active: isActive,
    timeString: `${hourStr}:${minStr}`,
    minutesUntilStart,
    startString: scheduleConfig.startTime || '00:30',
    endString: scheduleConfig.endTime || '14:00',
    timezone: tz,
  };
}

const activeProducts = (config.products || []).filter((p) => p.enabled !== false);
const activeSnipeTargets = (config.snipeTargets || []).filter((t) => t.enabled !== false);

if (activeProducts.length === 0 && activeSnipeTargets.length === 0) {
  console.log('config.json has no enabled products or snipe targets. Enable at least one item, then run npm start.');
  process.exit(1);
}

let context = null;
let monitorPage = null;
let isShuttingDown = false;

async function cleanup(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log(`Received ${signal}. Shutting down cleanly...`);
  try {
    if (context) {
      await saveSession(context);
      await context.close();
    }
  } catch {
    // Ignore close errors during shutdown
  }
  process.exit(0);
}

process.on('SIGINT', () => cleanup('SIGINT'));
process.on('SIGTERM', () => cleanup('SIGTERM'));

async function ensureBrowserOpen() {
  if (!context) {
    context = await launch(config);
    monitorPage = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  } else if (!monitorPage || monitorPage.isClosed()) {
    monitorPage = await context.newPage();
  }
  return { context, monitorPage };
}

async function closeBrowserContext() {
  if (context) {
    try {
      await saveSession(context);
      await context.close();
    } catch {
      // ignore
    }
    context = null;
    monitorPage = null;
  }
}

if (config.schedule && config.schedule.enabled) {
  console.log(`⏰ Schedule Enabled: Active daily from ${config.schedule.startTime || '00:30'} to ${config.schedule.endTime || '14:00'} (${config.schedule.timezone || 'Asia/Singapore'}).`);
}
console.log(`Monitoring ${activeProducts.length} active direct product(s) and ${activeSnipeTargets.length} active storefront snipe target(s) every ${config.pollIntervalSeconds || 10}s.`);
console.log(`Bot is ${config.headless ? 'headless (silent background)' : 'visible'}.`);
console.log(`Profile & session stored at: ${DATA_DIR}`);
if (once) console.log('Running a single check (--once).');

let firstRun = true;
let wasInActiveWindow = null;

for (;;) {
  const sched = getScheduleStatus(config.schedule);

  // If outside active schedule window
  if (!sched.active && !once) {
    if (wasInActiveWindow !== false) {
      const hrs = Math.floor(sched.minutesUntilStart / 60);
      const mins = sched.minutesUntilStart % 60;
      log(`[Scheduler] 🌙 Current time is ${sched.timeString} ${sched.timezone}. Outside active monitoring window (${sched.startString} - ${sched.endString}).`);
      log(`[Scheduler] 💤 Sleeping until ${sched.startString} ${sched.timezone} (~${hrs}h ${mins}m remaining). Browser closed to conserve RAM.`);
      await closeBrowserContext();
      wasInActiveWindow = false;
    }

    // Sleep in 30-second increments so user can stop or adjust anytime
    await randomDelay(30000, 31000);
    continue;
  }

  // Inside active schedule window
  if (wasInActiveWindow === false) {
    log(`[Scheduler] ☀️ Active monitoring window started (${sched.timeString} ${sched.timezone})! Launching browser...`);
  }
  wasInActiveWindow = true;

  try {
    const { context: ctx, monitorPage: page } = await ensureBrowserOpen();

    if (!firstRun) {
      log('--- poll ---');
    }
    firstRun = false;

    await keepAlive(page);

    // 1. Check active direct product URLs
    for (const product of activeProducts) {
      await checkProduct(page, product);
      await randomDelay(800, 1500); // Jitter between multi-product checks
    }

    // 2. Check active storefront snipe targets
    for (const snipeTarget of activeSnipeTargets) {
      await searchStoreForSnipe(page, snipeTarget);
      await randomDelay(800, 1500);
    }

    await saveSession(ctx);
  } catch (loopErr) {
    log(`Loop error: ${loopErr.message}`);
  }

  if (once) break;
  await randomDelay(pollIntervalMs, pollIntervalMs + 1500);
}

await closeBrowserContext();
process.exit(0);


