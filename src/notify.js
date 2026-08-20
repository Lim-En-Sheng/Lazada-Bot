import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

let cachedConfig = null;
export function getConfig() {
  if (cachedConfig) return cachedConfig;
  try {
    const configPath = new URL('../config.json', import.meta.url);
    if (existsSync(configPath)) {
      cachedConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    }
  } catch {
    cachedConfig = {};
  }
  return cachedConfig || {};
}

export async function sendTelegramMessage(botToken, chatId, text) {
  if (!botToken || !chatId) {
    console.log('  [Telegram] ⚠️ Disabled or missing "botToken" / "chatId" in config.json.');
    return false;
  }

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      }),
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      console.error(`  [Telegram Error] API returned: ${data.description || res.statusText} (Error Code: ${data.error_code})`);
      return false;
    }
    console.log('  [Telegram] ✅ Notification sent successfully to Telegram!');
    return true;
  } catch (err) {
    console.error(`  [Telegram Error] Network failure: ${err.message}`);
    return false;
  }
}

function triggerWindowsNotification(title, message, options = { desktop: true }) {
  if (options.desktop === false) return;

  const safeTitle = String(title || '').replace(/["<>&]/g, '');
  const safeMessage = String(message || '').replace(/["<>&]/g, '');

  const psScript = `
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    $xmlText = @"
<toast duration="short">
    <visual>
        <binding template="ToastGeneric">
            <text>${safeTitle}</text>
            <text>${safeMessage}</text>
        </binding>
    </visual>
    <audio silent="true" />
</toast>
"@
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml($xmlText)
    $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
    try {
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
    } catch {
        # Fallback
    }
  `;

  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');

  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    detached: true,
    stdio: 'ignore',
  });
  ps.unref();
}

export function notify(title, message, extra = {}) {
  const cfg = getConfig();
  const notifConfig = cfg.notifications || {};

  const line = `*** ${title} — ${message} ***`;
  console.log(`\n${'='.repeat(Math.max(line.length, 50))}`);
  console.log(line);
  if (extra.url) {
    console.log(`Link: ${extra.url}`);
  }
  console.log(`${'='.repeat(Math.max(line.length, 50))}\n`);

  // 1. Silent Windows Desktop Toast
  triggerWindowsNotification(title, message, {
    desktop: notifConfig.desktop,
  });

  // 2. Telegram Notification
  const tg = notifConfig.telegram;
  if (tg && tg.enabled) {
    let tgText = `🔔 <b>${title}</b>\n\n${message}`;
    if (extra.url) {
      tgText += `\n\n🛒 <a href="${extra.url}">View Product on Lazada</a>`;
    }
    if (extra.time) {
      tgText += `\n⏰ <i>${extra.time}</i>`;
    }
    sendTelegramMessage(tg.botToken, tg.chatId, tgText).catch(() => {});
  }
}

// Standalone execution test: npm run test:notify
if (process.argv[1] && process.argv[1].endsWith('notify.js')) {
  console.log('🔍 Testing notification channels...\n');
  const cfg = getConfig();
  const notifConfig = cfg.notifications || {};
  const tg = notifConfig.telegram || {};

  console.log('1. Testing Silent Windows Toast Notification:');
  triggerWindowsNotification('Lazada Stock Bot', 'Test notification (silent) is working!', {
    desktop: true,
  });
  console.log('  [Desktop] ✅ Triggered silent Windows Toast notification.');

  console.log('\n2. Testing Telegram Channel:');
  if (!tg.enabled) {
    console.log('  [Telegram] ⚠️ Telegram is currently disabled in config.json ("enabled": false).');
    console.log('  To enable, set "enabled": true and provide your "botToken" and "chatId" in config.json.');
  } else {
    console.log(`  [Telegram] Attempting to send test message with botToken ${tg.botToken.slice(0, 6)}... to Chat ID ${tg.chatId}...`);
    let tgText = `🔔 <b>TEST ALERT</b>\n\nThis is a test notification from your Lazada Stock Bot.\n\n🛒 <a href="https://www.lazada.sg">View Lazada</a>\n⏰ <i>${new Date().toLocaleTimeString()}</i>`;
    await sendTelegramMessage(tg.botToken, tg.chatId, tgText);
  }
  console.log('\n✅ Test complete.');
}



