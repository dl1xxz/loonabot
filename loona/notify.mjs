// Tells the staff about a booking in Telegram, wherever it came from: the bot, the site or the cabinet.
import { bookingText } from './core.mjs';

const SOURCE = { telegram: 'из Telegram', site: 'с сайта', cabinet: 'из кабинета' };

export function createNotifier({ db, call, log = console }) {
  // The booking's master and every admin, except whoever made the change: they already know.
  async function tell(b, text, exceptChat) {
    if (!call) return;
    const admins = db.prepare("SELECT tg_chat_id AS id FROM masters WHERE role = 'admin' AND active = 1 AND tg_chat_id IS NOT NULL").all();
    const targets = new Set(admins.map((r) => r.id));
    if (b.master_chat) targets.add(b.master_chat);
    targets.delete(exceptChat);
    for (const chat of targets) {
      await call('sendMessage', { chat_id: chat, text }).catch((e) => log.error('notify failed', chat, e.message));
    }
  }
  const details = (b) => `${bookingText(b)}\nКлиент: ${b.client}, ${b.phone}`;
  return {
    booked: (b, exceptChat) => tell(b, `Новая запись ${SOURCE[b.source]}\n\n${details(b)}`, exceptChat),
    cancelled: (b, who, exceptChat) => tell(b, `${who} отменил(а) запись\n\n${details(b)}`, exceptChat),
  };
}
