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

const BASE = 'https://api.telegram.org';

async function sendMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return; // silently skip if not configured

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
      console.warn(`[Telegram] Failed to send message: ${res.status} ${body}`);
    }
  } catch (err) {
    console.warn(`[Telegram] Error: ${err.message}`);
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
    `🖥️ Desktop FAIL: <b>${stats.desktopFail}</b>\n` +
    `📱 iOS FAIL: <b>${stats.iosFail}</b>\n` +
    `🤖 Android FAIL: <b>${stats.androidFail}</b>\n\n` +
    `⏱ <i>${new Date().toISOString()}</i>`
  );
}

/**
 * Notify that a run crashed.
 */
export async function notifyFailure(runId, reason) {
  await sendMessage(
    `🚨 <b>Trustee Referral Monitor — CRASHED</b>\n` +
    `❌ Run <b>#${runId}</b> failed with an error:\n\n` +
    `<code>${String(reason).slice(0, 500)}</code>\n\n` +
    `⏱ <i>${new Date().toISOString()}</i>`
  );
}
