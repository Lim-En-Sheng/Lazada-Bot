import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getConfig, sendTelegramMessage } from './notify.js';

const notificationConfig = getConfig();
const telegram = notificationConfig.notifications?.telegram || {};
const botToken = telegram.botToken;
const authorizedChatId = String(telegram.chatId || '');
const monitorScript = fileURLToPath(new URL('./monitor.js', import.meta.url));
const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const configPath = fileURLToPath(new URL('../config.json', import.meta.url));
const configTempPath = `${configPath}.tmp`;

const MAX_CRASH_RESTARTS = 3;
const CRASH_WINDOW_MS = 15 * 60 * 1000;
const CRASH_RESTART_DELAY_MS = 5000;

let monitorProcess = null;
let monitorStartedAt = null;
let monitorAccountingStartedAt = null;
let monitorTelemetry = {};
let expectedStop = false;
let restartTimer = null;
let crashRestartTimes = [];
let updateOffset = 0;
let shuttingDown = false;

let dailyStats = createDailyStats();

function createDailyStats() {
  return {
    startedAt: new Date(),
    monitoringMs: 0,
    cycles: 0,
    productChecks: 0,
    errors: 0,
    restocks: 0,
    captchas: 0,
    totalCycleMs: 0,
    slowestProduct: null,
  };
}

function log(message) {
  console.log(`[Controller ${new Date().toLocaleTimeString()}] ${message}`);
}

function readConfig() {
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

function saveConfig(config) {
  writeFileSync(configTempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  renameSync(configTempPath, configPath);
}

function updateConfig(mutator) {
  const config = readConfig();
  mutator(config);
  saveConfig(config);
  if (monitorIsRunning() && monitorProcess.connected) {
    monitorProcess.send({ type: 'reload-config' });
  }
  return config;
}

function monitorIsRunning() {
  return !!monitorProcess && monitorProcess.exitCode === null && !monitorProcess.killed;
}

async function reply(text) {
  return sendTelegramMessage(botToken, authorizedChatId, text);
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function handleMonitorMessage(message) {
  if (message?.type === 'telemetry') {
    monitorTelemetry = { ...monitorTelemetry, ...message.snapshot };
  } else if (message?.type === 'cycle') {
    const metrics = message.metrics || {};
    dailyStats.cycles += 1;
    dailyStats.productChecks += Number(metrics.checkedCount) || 0;
    dailyStats.errors += Number(metrics.errors) || 0;
    dailyStats.totalCycleMs += Number(metrics.durationMs) || 0;
    if (
      metrics.slowestProduct &&
      (!dailyStats.slowestProduct || metrics.slowestProduct.durationMs > dailyStats.slowestProduct.durationMs)
    ) {
      dailyStats.slowestProduct = metrics.slowestProduct;
    }
  } else if (message?.type === 'restock') {
    dailyStats.restocks += 1;
  } else if (message?.type === 'captcha') {
    dailyStats.captchas += 1;
    monitorTelemetry.lastCaptchaAt = message.at;
  } else if (message?.type === 'login-status') {
    monitorTelemetry.loggedIn = message.loggedIn;
  } else if (message?.type === 'config-error') {
    reply(`⚠️ Monitor could not reload config.json: ${escapeHtml(message.error)}`).catch(() => {});
  }
}

function startMonitor({ automaticRestart = false } = {}) {
  if (monitorIsRunning()) return false;

  expectedStop = false;
  monitorTelemetry = { state: 'starting' };
  const child = spawn(process.execPath, [monitorScript], {
    cwd: projectDirectory,
    env: process.env,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    windowsHide: !!readConfig().headless,
  });
  monitorProcess = child;
  monitorStartedAt = new Date();
  monitorAccountingStartedAt = Date.now();

  log(`Monitor started (PID ${child.pid}${automaticRestart ? ', automatic crash recovery' : ''}).`);
  child.on('message', handleMonitorMessage);
  child.once('error', (err) => log(`Monitor process error: ${err.message}`));
  child.once('exit', (code, signal) => handleMonitorExit(child, code, signal));
  return true;
}

function handleMonitorExit(child, code, signal) {
  if (monitorAccountingStartedAt) {
    dailyStats.monitoringMs += Date.now() - monitorAccountingStartedAt;
    monitorAccountingStartedAt = null;
  }
  if (monitorProcess === child) monitorProcess = null;
  monitorStartedAt = null;
  monitorTelemetry = {};
  log(`Monitor exited (code=${code ?? 'none'}, signal=${signal ?? 'none'}).`);

  const shouldRecover = !expectedStop && !shuttingDown;
  expectedStop = false;
  if (!shouldRecover) return;

  const now = Date.now();
  crashRestartTimes = crashRestartTimes.filter((time) => now - time < CRASH_WINDOW_MS);
  if (crashRestartTimes.length >= MAX_CRASH_RESTARTS) {
    reply(
      `🚨 <b>Lazada monitor stopped</b>\n\nIt crashed more than ${MAX_CRASH_RESTARTS} times within 15 minutes, so automatic recovery was disabled. Send /start_monitor after checking the PC logs.`
    ).catch(() => {});
    return;
  }

  crashRestartTimes.push(now);
  const attempt = crashRestartTimes.length;
  reply(
    `⚠️ Lazada monitor exited unexpectedly (code ${code ?? 'unknown'}). Automatic restart ${attempt}/${MAX_CRASH_RESTARTS} will run in 5 seconds.`
  ).catch(() => {});
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!shuttingDown && !monitorIsRunning()) startMonitor({ automaticRestart: true });
  }, CRASH_RESTART_DELAY_MS);
}

async function endMonitor() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (!monitorIsRunning()) return false;

  expectedStop = true;
  const child = monitorProcess;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');

  const timeout = new Promise((resolve) => setTimeout(resolve, 15000, 'timeout'));
  const result = await Promise.race([exited, timeout]);
  if (result === 'timeout' && child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  return true;
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return 'n/a';
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : `${minutes}m ${seconds}s`;
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : 'never';
}

function parseProductIndex(rawIndex, products) {
  const index = Number(rawIndex) - 1;
  return Number.isInteger(index) && index >= 0 && index < products.length ? index : null;
}

function buildSummary(reset = false) {
  const elapsedMs = Date.now() - dailyStats.startedAt.getTime();
  const activeMonitoringMs = monitorAccountingStartedAt ? Date.now() - monitorAccountingStartedAt : 0;
  const monitoringMs = dailyStats.monitoringMs + activeMonitoringMs;
  const averageCycleMs = dailyStats.cycles ? dailyStats.totalCycleMs / dailyStats.cycles : 0;
  const summary =
    '<b>Lazada monitoring summary</b>\n\n' +
    `<b>Period:</b> ${formatDuration(elapsedMs)}\n` +
    `<b>Monitoring time:</b> ${formatDuration(monitoringMs)}\n` +
    `<b>Cycles:</b> ${dailyStats.cycles}\n` +
    `<b>Targets checked:</b> ${dailyStats.productChecks}\n` +
    `<b>Restocks:</b> ${dailyStats.restocks}\n` +
    `<b>CAPTCHAs:</b> ${dailyStats.captchas}\n` +
    `<b>Errors:</b> ${dailyStats.errors}\n` +
    `<b>Average cycle:</b> ${formatDuration(averageCycleMs)}\n` +
    `<b>Slowest target:</b> ${dailyStats.slowestProduct ? `${escapeHtml(dailyStats.slowestProduct.name)} (${formatDuration(dailyStats.slowestProduct.durationMs)})` : 'n/a'}`;
  if (reset) {
    dailyStats = createDailyStats();
    if (monitorAccountingStartedAt) monitorAccountingStartedAt = Date.now();
  }
  return summary;
}

async function handleCommand(text) {
  const parts = text.trim().split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();

  switch (command) {
    case '/start':
    case '/help':
      await reply(
        '<b>Lazada Bot Controller</b>\n\n' +
          '/start_monitor - Start immediately\n' +
          '/end_monitor - End monitoring\n' +
          '/status - Detailed monitor health\n' +
          '/summary - Current daily summary\n' +
          '/list_products - List configured products\n' +
          '/enable_product N - Enable a product\n' +
          '/disable_product N - Disable a product\n' +
          '/check_product N - Check one product now\n' +
          '/list_snipe_targets - List storefront targets\n' +
          '/toggle_snipe N - Enable or disable a storefront target\n' +
          '/set_interval SECONDS - Set 15–300 seconds\n' +
          '/set_quantity N QTY - Set product quantity\n' +
          '/show_config - Show safe configuration'
      );
      break;

    case '/start_monitor':
      if (startMonitor()) {
        crashRestartTimes = [];
        await reply('✅ Lazada monitoring started immediately. It will run until /end_monitor is sent.');
      } else {
        await reply('ℹ️ Lazada monitoring is already running.');
      }
      break;

    case '/end_monitor':
      if (await endMonitor()) {
        await reply('⏹️ Lazada monitoring ended. The Telegram controller remains online.');
      } else {
        await reply('ℹ️ Lazada monitoring is already stopped.');
      }
      break;

    case '/status': {
      const config = readConfig();
      if (!monitorIsRunning()) {
        await reply('<b>Lazada monitor:</b> stopped\nUse /start_monitor to start it.');
        break;
      }
      await reply(
        '<b>Lazada monitor:</b> running\n' +
          `<b>Mode:</b> ${monitorTelemetry.browserMode || (config.headless ? 'headless' : 'visible')}\n` +
          `<b>PID:</b> ${monitorProcess.pid}\n` +
          `<b>Uptime:</b> ${formatDuration(Date.now() - monitorStartedAt.getTime())}\n` +
          `<b>Current target:</b> ${escapeHtml(monitorTelemetry.currentProduct || 'between cycles')}\n` +
          `<b>Last successful cycle:</b> ${formatDate(monitorTelemetry.lastSuccessfulCycleAt)}\n` +
          `<b>Last cycle:</b> ${formatDuration(monitorTelemetry.lastCycleDurationMs)}\n` +
          `<b>Slowest target:</b> ${monitorTelemetry.slowestProduct ? `${escapeHtml(monitorTelemetry.slowestProduct.name)} (${formatDuration(monitorTelemetry.slowestProduct.durationMs)})` : 'n/a'}\n` +
          `<b>Enabled:</b> ${monitorTelemetry.enabledProducts ?? 0} product(s), ${monitorTelemetry.enabledSnipeTargets ?? 0} sniper(s)\n` +
          `<b>Errors:</b> ${monitorTelemetry.errors ?? 0}\n` +
          `<b>Restocks:</b> ${monitorTelemetry.restocks ?? 0}\n` +
          `<b>Last CAPTCHA:</b> ${formatDate(monitorTelemetry.lastCaptchaAt)}\n` +
          `<b>Login:</b> ${monitorTelemetry.loggedIn === false ? 'logged out' : monitorTelemetry.loggedIn === true ? 'logged in' : 'not checked yet'}`
      );
      break;
    }

    case '/summary':
      await reply(buildSummary(false));
      break;

    case '/list_products': {
      const products = readConfig().products || [];
      const lines = products.map(
        (product, index) =>
          `${index + 1}. ${product.enabled === false ? '⛔' : '✅'} ${escapeHtml(product.name)} (qty ${Math.max(1, Number(product.quantity) || 1)})`
      );
      await reply(`<b>Configured products</b>\n\n${lines.length ? lines.join('\n') : 'No products configured.'}`);
      break;
    }

    case '/enable_product':
    case '/disable_product': {
      const config = readConfig();
      const index = parseProductIndex(parts[1], config.products || []);
      if (index === null) {
        await reply('⚠️ Invalid product number. Use /list_products first.');
        break;
      }
      const enabled = command === '/enable_product';
      const productName = config.products[index].name;
      updateConfig((nextConfig) => {
        nextConfig.products[index].enabled = enabled;
      });
      await reply(`${enabled ? '✅ Enabled' : '⛔ Disabled'} product ${index + 1}: ${escapeHtml(productName)}`);
      break;
    }

    case '/check_product': {
      if (!monitorIsRunning() || !monitorProcess.connected) {
        await reply('⚠️ Monitoring is stopped. Send /start_monitor first.');
        break;
      }
      const products = readConfig().products || [];
      const index = parseProductIndex(parts[1], products);
      if (index === null) {
        await reply('⚠️ Invalid product number. Use /list_products first.');
        break;
      }
      monitorProcess.send({ type: 'check-product', index });
      await reply(`🔎 Manual check queued for product ${index + 1}: ${escapeHtml(products[index].name)}`);
      break;
    }

    case '/list_snipe_targets': {
      const targets = readConfig().snipeTargets || [];
      const lines = targets.map(
        (target, index) =>
          `${index + 1}. ${target.enabled === false ? '⛔' : '✅'} ${escapeHtml(target.name)} — ${escapeHtml((target.keywords || []).join(', ') || 'no keywords')}`
      );
      await reply(`<b>Storefront snipe targets</b>\n\n${lines.length ? lines.join('\n') : 'No snipe targets configured.'}`);
      break;
    }

    case '/toggle_snipe': {
      const config = readConfig();
      const targets = config.snipeTargets || [];
      const index = parseProductIndex(parts[1], targets);
      if (index === null) {
        await reply('⚠️ Invalid snipe target number. Use /list_snipe_targets first.');
        break;
      }
      const targetName = targets[index].name;
      const enabled = targets[index].enabled === false;
      updateConfig((nextConfig) => {
        nextConfig.snipeTargets[index].enabled = enabled;
      });
      await reply(`${enabled ? '✅ Enabled' : '⛔ Disabled'} snipe target ${index + 1}: ${escapeHtml(targetName)}`);
      break;
    }

    case '/set_interval': {
      const seconds = Number(parts[1]);
      if (!Number.isInteger(seconds) || seconds < 15 || seconds > 300) {
        await reply('⚠️ Interval must be a whole number from 15 to 300 seconds.');
        break;
      }
      updateConfig((config) => {
        config.pollIntervalSeconds = seconds;
      });
      await reply(`✅ Poll interval set to ${seconds} seconds.`);
      break;
    }

    case '/set_quantity': {
      const config = readConfig();
      const index = parseProductIndex(parts[1], config.products || []);
      const quantity = Number(parts[2]);
      if (index === null || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
        await reply('⚠️ Usage: /set_quantity PRODUCT_NUMBER QUANTITY (quantity 1–99).');
        break;
      }
      const productName = config.products[index].name;
      updateConfig((nextConfig) => {
        nextConfig.products[index].quantity = quantity;
      });
      await reply(`✅ Quantity for ${escapeHtml(productName)} set to ${quantity}.`);
      break;
    }

    case '/show_config': {
      const config = readConfig();
      await reply(
        '<b>Safe configuration</b>\n\n' +
          `<b>Headless:</b> ${!!config.headless}\n` +
          `<b>Poll interval:</b> ${config.pollIntervalSeconds || 25}s\n` +
          `<b>Block images:</b> ${!!config.blockImages}\n` +
          `<b>Products:</b> ${(config.products || []).length}\n` +
          `<b>Enabled products:</b> ${(config.products || []).filter((product) => product.enabled !== false).length}\n` +
          `<b>Slow-cycle alert:</b> ${config.health?.slowCycleSeconds || 60}s\n` +
          `<b>Error-cycle threshold:</b> ${config.health?.consecutiveErrorAlertThreshold || 3}`
      );
      break;
    }

    default:
      await reply('Unknown command. Send /help to see the available controls.');
  }
}

async function discardPendingUpdates() {
  const url = new URL(`https://api.telegram.org/bot${botToken}/getUpdates`);
  url.searchParams.set('offset', '-1');
  url.searchParams.set('timeout', '0');
  url.searchParams.set('allowed_updates', JSON.stringify(['message']));
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.description || response.statusText);
  for (const update of data.result || []) updateOffset = Math.max(updateOffset, update.update_id + 1);
  if (updateOffset > 0) log('Discarded Telegram commands queued before controller startup.');
}

async function pollTelegram() {
  while (!shuttingDown) {
    try {
      const url = new URL(`https://api.telegram.org/bot${botToken}/getUpdates`);
      url.searchParams.set('offset', String(updateOffset));
      url.searchParams.set('timeout', '25');
      url.searchParams.set('allowed_updates', JSON.stringify(['message']));
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.description || response.statusText);

      for (const update of data.result || []) {
        updateOffset = Math.max(updateOffset, update.update_id + 1);
        const message = update.message;
        if (!message?.text) continue;
        if (String(message.chat?.id) !== authorizedChatId) {
          log(`Ignored Telegram command from unauthorized chat ${message.chat?.id ?? 'unknown'}.`);
          continue;
        }
        await handleCommand(message.text);
      }
    } catch (err) {
      if (!shuttingDown && err.name !== 'TimeoutError') log(`Telegram polling error: ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Received ${signal}. Stopping controller and monitor...`);
  await reply(
    `🔴 <b>Lazada Telegram controller is going offline</b>\n\n` +
      `The controller received ${escapeHtml(signal)} and is shutting down. Telegram commands will be unavailable until it starts again.`
  );
  await endMonitor();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (!telegram.enabled || !botToken || !authorizedChatId) {
  console.error('Telegram controller requires notifications.telegram.enabled plus TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');
  process.exit(1);
}

setInterval(() => {
  if (dailyStats.cycles || dailyStats.errors || dailyStats.restocks || dailyStats.captchas) {
    reply(buildSummary(true)).catch(() => {});
  } else {
    dailyStats = createDailyStats();
  }
}, 24 * 60 * 60 * 1000).unref();

log('Telegram controller online. Monitoring remains stopped until /start_monitor is received.');
try {
  await discardPendingUpdates();
} catch (err) {
  log(`Could not clear pending Telegram updates: ${err.message}`);
}
await reply('🟢 Lazada Telegram controller is online. Monitoring is stopped; send /start_monitor to begin.');
await pollTelegram();
