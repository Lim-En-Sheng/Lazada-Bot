<div align="center">

# 🛒 Lazada SG Stock Bot

**An automated stock monitor and cart sniper for Lazada Singapore.**  
Instantly alerts you and auto-adds items to cart the moment they restock — or the second a new product drops.

[![Node.js](https://img.shields.io/badge/Node.js-24%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Playwright](https://img.shields.io/badge/Playwright-1.48%2B-2EAD33?style=flat-square&logo=playwright&logoColor=white)](https://playwright.dev/)
[![Telegram](https://img.shields.io/badge/Telegram-Notifications-26A5E4?style=flat-square&logo=telegram&logoColor=white)](https://telegram.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D4?style=flat-square&logo=windows&logoColor=white)](https://www.microsoft.com/windows)

</div>

---

## ✨ Features

| Feature | Description |
|---|---|
| 🎯 **Accurate Stock Detection** | Selects the correct variant *before* checking the Add to Cart button — no false positives |
| 🔍 **Storefront Sniper** | Continuously scans a seller's store for newly published listings matching your keywords |
| 📱 **Telegram Alerts** | Instant mobile push notifications with product link when stock is detected |
| 🩺 **Health Telemetry** | Reports current target, cycle timing, errors, login state, CAPTCHA history, and recovery |
| 🎛️ **Telegram Controls** | Start/end monitoring, manage products, run manual checks, and adjust safe settings remotely |
| ♻️ **Crash Recovery** | Restarts unexpected monitor crashes up to three times within 15 minutes |
| 🛡️ **Anti-Bot Stealth** | Masks `navigator.webdriver`, applies human-like delays and randomized jitter |
| ⚠️ **CAPTCHA Detection** | Detects Lazada slide verification and immediately alerts you to solve it |
| 🔢 **Multi-Quantity Support** | Uses the page quantity stepper before clicking Add to Cart |
| 💤 **Resource Efficient** | Headless mode, image/media blocking, and page recycling keeps CPU/RAM usage minimal |
| 🔒 **Secure Credentials** | Telegram secrets loaded from `.env` — never committed to Git |

---

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Secrets

Copy the example env file and fill in your Telegram credentials:

```bash
copy .env.example .env
```

Then edit `.env`:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=your_chat_id_here
```

> **How to get these** — see the [Telegram Setup](#-telegram-setup) section below.

### 3. Add Your Products to `config.json`

```json
{
  "headless": true,
  "pollIntervalSeconds": 10,
  "blockImages": true,
  "health": {
    "slowCycleSeconds": 60,
    "consecutiveErrorAlertThreshold": 3
  },
  "notifications": {
    "sound": false,
    "desktop": true,
    "telegram": {
      "enabled": true,
      "botToken": "",
      "chatId": ""
    }
  },
  "products": [
    {
      "name": "My Product Name",
      "url": "https://www.lazada.sg/products/...",
      "quantity": 1,
      "variantLabel": null
    }
  ],
  "snipeTargets": [
    {
      "enabled": false,
      "name": "Upcoming Drop",
      "storeUrl": "https://www.lazada.sg/shop/some-store/?tab=products",
      "keywords": ["Keyword To Match"],
      "excludeKeywords": [],
      "quantity": 1,
      "variantLabel": null
    }
  ]
}
```

> 💡 `botToken` and `chatId` in `config.json` can be left empty — they are automatically read from your `.env` file.

### 4. Login to Lazada

```bash
npm run login
```

A browser window will open. Sign in to your Lazada account, then press **Enter** in the terminal. Your session is saved to `%LOCALAPPDATA%\lazada-stock-bot` (outside OneDrive to prevent file lock corruption).

### 5. Start the Telegram Controller

```bash
npm start
```

This starts only the Telegram controller; monitoring remains stopped until `/start_monitor` is sent. The controller must already be running on the PC to receive Telegram commands, so Telegram cannot bootstrap `npm start` while the controller is offline.

Available Telegram commands:

```text
/start_monitor
/end_monitor
/status
/summary
/list_products
/enable_product N
/disable_product N
/check_product N
/list_snipe_targets
/toggle_snipe N
/set_interval SECONDS
/set_quantity N QTY
/show_config
/help
```

`/start_monitor` begins monitoring immediately and it continues until `/end_monitor` is sent. Only the chat ID configured through `TELEGRAM_CHAT_ID` is allowed to issue commands.

Configuration commands update `config.json` atomically and notify a running monitor to reload it. `/set_interval` accepts 15–300 seconds. `/set_quantity` accepts quantities from 1–99. The controller sends an automatic summary every 24 hours when activity occurred; `/summary` shows the current totals at any time.

Use `/list_snipe_targets` to see each configured storefront target and `/toggle_snipe N` to switch target `N` on or off.

Unexpected monitor exits are restarted after five seconds, up to three times in a 15-minute window. `/end_monitor` is treated as an intentional stop and never triggers recovery.

---

## 📱 Telegram Setup

<details>
<summary><strong>Click to expand step-by-step guide</strong></summary>

**Step 1 — Create a Bot:**
1. Open Telegram and search for [@BotFather](https://t.me/botfather)
2. Send `/newbot`
3. Choose a display name (e.g. `My Lazada Bot`) and a username ending in `bot`
4. Copy the **HTTP API Token** it gives you

**Step 2 — Get Your Chat ID:**
1. Open [@userinfobot](https://t.me/userinfobot) on Telegram
2. Send any message — it will reply with your numerical **`Id`**
3. Copy that number

**Step 3 — Save to `.env`:**
```env
TELEGRAM_BOT_TOKEN=7123456789:AAFxxx_your_token_here
TELEGRAM_CHAT_ID=123456789
```

**Step 4 — Test it:**
```bash
npm run test:notify
```

You should receive a Telegram message and see a Windows toast notification.

</details>

---

If a CAPTCHA is detected while running headlessly, the bot automatically relaunches its saved browser profile in visible mode and pauses monitoring. Complete the verification in that browser window; once the challenge disappears, the bot saves the updated session, closes the visible browser, and resumes monitoring headlessly.

---

## 🔍 Storefront Sniper

For products that haven't been listed yet, the bot can watch a seller's storefront and snipe the listing the moment it appears.

```json
"snipeTargets": [
  {
    "enabled": true,
    "name": "Pokémon 30th Anniversary Drop",
    "storeUrl": "https://www.lazada.sg/shop/pokemon-store-online-singapore/?tab=products",
    "keywords": ["30th Anniversary"],
    "excludeKeywords": ["Sleeve", "Case"],
    "quantity": 1,
    "variantLabel": null
  }
]
```

When a match is found, the bot will:
1. 🚨 Send an urgent Telegram notification with the live link
2. 🛒 Automatically navigate to the product and add it to your cart

Set `"enabled": false` to disable a snipe target without removing it.

---

## 🛠️ Available Commands

| Command | Description |
|---|---|
| `npm start` | Start the Telegram controller; monitoring remains stopped |
| `npm run start:monitor` | Start only the stock monitor without Telegram command polling |
| `npm run setup:autostart` | Install controller startup at Windows logon |
| `npm run remove:autostart` | Remove the Windows startup task |
| `npm run login` | Open browser to log in to Lazada |
| `npm run test:notify` | Test Windows toast + Telegram notification |
| `node src/monitor.js --once` | Run a single check cycle and exit |
| `node src/login.js --fresh` | Clear old session and log in fresh |

---

## 📁 Project Structure

```
lazada-stock-bot/
├── src/
│   ├── monitor.js      # Main polling loop, stock detection, sniper
│   ├── controller.js   # Telegram commands, telemetry, crash recovery
│   ├── browser.js      # Playwright launcher with stealth & image blocking
│   ├── login.js        # Interactive Lazada login script
│   └── notify.js       # Telegram + Windows Toast notifications
├── scripts/            # Opt-in Windows startup setup/removal
├── config.json         # Products and settings (safe to commit)
├── .env                # 🔒 Secret Telegram credentials (gitignored)
├── .env.example        # Template for .env
└── package.json
```

---

## ⚙️ Configuration Reference

| Key | Default | Description |
|---|---|---|
| `headless` | `true` | Run browser invisibly in background |
| `pollIntervalSeconds` | `10` | How often to check each product (seconds) |
| `blockImages` | `true` | Block images/videos for faster page loads |
| `health.slowCycleSeconds` | `60` | Alert threshold for an unusually slow complete cycle |
| `health.consecutiveErrorAlertThreshold` | `3` | Consecutive error cycles before alerting |
| `product.variantLabel` | `null` | Variant text to click (e.g. `"Series 3"`) |
| `product.quantity` | `1` | Number of items to add to cart |
| `snipeTarget.enabled` | `true` | Toggle individual snipe targets on/off |

## Windows automatic controller startup

To keep Telegram commands available after you sign into Windows, install the opt-in scheduled task:

```powershell
npm run setup:autostart
```

This starts only the controller at Windows logon. Monitoring still waits for `/start_monitor`. Remove the task with:

```powershell
npm run remove:autostart
```
