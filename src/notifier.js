/**
 * Telegram Notifier
 * Sends monitoring alerts to a Telegram chat via Bot API.
 *
 * Required env vars:
 *   TELEGRAM_BOT_TOKEN  — token from @BotFather
 *   TELEGRAM_CHAT_ID    — your chat or channel ID (use @userinfobot to find it)
 *
 * If either var is missing, all functions silently do nothing.
 */

import fs from 'fs';
import path from 'path';

const BASE = 'https://api.telegram.org';
const SUBSCRIBERS_FILE = path.join(process.cwd(), 'subscribers.json');

async function getSubscribers(token) {
  let subs = [];
  let lastUpdateId = 0;
  if (fs.existsSync(SUBSCRIBERS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf8'));
      subs = data.chatIds || [];
      lastUpdateId = data.lastUpdateId || 0;
    } catch {}
  }
  
  if (!token) return subs;
  
  try {
    const res = await fetch(`${BASE}/bot${token}/getUpdates?offset=${lastUpdateId + 1}&allowed_updates=["message"]`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      let changed = false;
      for (const update of data.result) {
        lastUpdateId = Math.max(lastUpdateId, update.update_id);
        if (update.message && update.message.text && update.message.text.startsWith('/start')) {
          const cid = String(update.message.chat.id);
          if (!subs.includes(cid)) {
            subs.push(cid);
            changed = true;
          }
        }
      }
      if (changed || data.result.length > 0) {
        fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify({ chatIds: subs, lastUpdateId }, null, 2));
      }
    }
  } catch (err) {
    console.warn(`[Telegram] Failed to fetch updates: ${err.message}`);
  }
  
  return subs;
}

async function sendMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const defaultChatId = process.env.TELEGRAM_CHAT_ID;
  const subs = await getSubscribers(token);
  
  const allChats = new Set(subs);
  if (defaultChatId) allChats.add(String(defaultChatId));
  
  if (allChats.size === 0) return;

  for (const chatId of allChats) {
    try {
      const res = await fetch(`${BASE}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        const body = await res.text();
        console.warn(`[Telegram] Failed to send message to ${chatId}: ${res.status} ${body}`);
      }
    } catch (err) {
      console.warn(`[Telegram] Error sending to ${chatId}: ${err.message}`);
    }
  }
}

/**
 * Notify that a run has started.
 */
export async function notifyStart(runId, pages) {
  await sendMessage(
    `🔍 <b>Trustee Referral Monitor</b>\n` +
    `▶️ Run <b>#${runId}</b> started\n` +
    `📄 Pages to check: <b>${pages}</b>\n` +
    `⏱ <i>${new Date().toISOString()}</i>`
  );
}

/**
 * Notify that a run completed successfully.
 * @param {object} stats - { pass, fail, inconclusive, total, pages }
 */
export async function notifySuccess(runId, stats) {
  const icon = stats.fail > 0 ? '⚠️' : '✅';
  const overallStatus = stats.fail > 0 ? 'ISSUES FOUND' : 'ALL CHECKS PASSED';
  await sendMessage(
    `${icon} <b>Trustee Referral Monitor</b>\n` +
    `✔️ Run <b>#${runId}</b> completed — <b>${overallStatus}</b>\n\n` +
    `📊 <b>Results:</b>\n` +
    `  ✓ PASS: <b>${stats.pass}</b>\n` +
    `  ✗ FAIL: <b>${stats.fail}</b>\n` +
    `  ○ No store link: <b>${stats.noStoreLink}</b>\n` +
    `  ? Inconclusive: <b>${stats.inconclusive}</b>\n` +
    `  📄 Pages crawled: <b>${stats.pages}</b>\n\n` +
    `🖥️ Win FAIL: <b>${stats.desktopFail}</b>\n` +
    `📱 iOS FAIL: <b>${stats.iosFail}</b>\n` +
    `🤖 Android FAIL: <b>${stats.androidFail}</b>\n\n` +
    `🔗 <a href="https://m0riko.github.io/Ref-Test-Trustee/report.html">Переглянути повний звіт (Full Report)</a>\n\n` +
    `⏱ <i>${new Date().toISOString()}</i>`
  );
}

/**
 * Notify that a run crashed.
 */
export async function notifyFailure(runId, reason) {
  const safeReason = String(reason).slice(0, 500).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  await sendMessage(
    `🚨 <b>Trustee Referral Monitor — CRASHED</b>\n` +
    `❌ Run <b>#${runId}</b> failed with an error:\n\n` +
    `<code>${safeReason}</code>\n\n` +
    `🔗 <a href="https://m0riko.github.io/Ref-Test-Trustee/report.html">Переглянути останній звіт</a>\n\n` +
    `⏱ <i>${new Date().toISOString()}</i>`
  );
}
