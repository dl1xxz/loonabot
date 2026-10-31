// Sends visit reminders to Telegram clients: a day before and two hours before.
import { localNow, minutesBetween, whenLabel } from './core.mjs';
import { TelegramError } from './telegram.mjs';

const KINDS = [
  { column: 'reminded_soon', minutes: 2 * 60, text: (b) => `Скоро ждём вас: ${b.service}, мастер ${b.master}, ${whenLabel(b.start_at)}.` },
  { column: 'reminded_day', minutes: 24 * 60, text: (b) => `Напоминаем о записи: ${b.service}, мастер ${b.master}, ${whenLabel(b.start_at)}.` },
];

export async function sendReminders({ db, call, studio, log = console, now = Date.now() }) {
  const current = localNow(studio.utcOffsetMin, now);
  const rows = db.prepare(`
    SELECT b.id, b.start_at, b.reminded_day, b.reminded_soon, s.name AS service, m.name AS master, c.tg_id AS tg
    FROM bookings b JOIN services s ON s.id = b.service_id JOIN masters m ON m.id = b.master_id JOIN clients c ON c.id = b.client_id
    WHERE b.status = 'active' AND b.start_at > ? AND (b.reminded_day = 0 OR b.reminded_soon = 0)
    ORDER BY b.start_at
  `).all(current);
  let sent = 0;
  for (const b of rows) {
    const left = minutesBetween(current, b.start_at);
    const due = KINDS.find((k) => !b[k.column] && left <= k.minutes);
    if (!due) continue;
    // Whichever reminder is due now also settles the later-window one, so nobody gets two at once.
    const settle = () => db.prepare(`UPDATE bookings SET ${due.column} = 1${due.column === 'reminded_soon' ? ', reminded_day = 1' : ''} WHERE id = ?`).run(b.id);
    if (!b.tg) {
      settle();
      continue;
    }
    try {
      await call('sendMessage', {
        chat_id: b.tg,
        text: `${due.text(b)}\n\nАдрес: ${studio.address}\nЕсли планы изменились, отмените запись.`,
        reply_markup: { inline_keyboard: [[{ text: 'Отменить запись', callback_data: `x:${b.id}` }]] },
      });
      settle();
      sent++;
    } catch (e) {
      // A client who blocked the bot will not get it on retry either; a network failure will be retried next tick.
      if (e instanceof TelegramError && (e.status === 403 || e.status === 400)) settle();
      log.error('reminder failed', b.id, e.message);
    }
  }
  return sent;
}
