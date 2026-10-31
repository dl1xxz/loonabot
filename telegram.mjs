// A thin Telegram Bot API client over fetch, with long polling.

export class TelegramError extends Error {
  constructor(status, description) {
    super(`Telegram ${status}: ${description}`);
    this.status = status;
  }
}

export function telegramClient(token, base = 'https://api.telegram.org') {
  return async function call(method, params = {}, timeoutMs = 15000) {
    const res = await fetch(`${base}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) throw new TelegramError(res.status, json.description || 'no description');
    return json.result;
  };
}

// Feeds updates to onUpdate one at a time until signal aborts. One bad update is logged and skipped.
export async function poll(call, onUpdate, signal, log = console) {
  let offset = 0;
  while (!signal.aborted) {
    try {
      const updates = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 35000);
      for (const u of updates) {
        offset = u.update_id + 1;
        try {
          await onUpdate(u);
        } catch (e) {
          log.error('update failed', u.update_id, e);
        }
      }
    } catch (e) {
      if (signal.aborted) return;
      log.error('polling failed:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
