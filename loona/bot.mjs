// The Telegram bot. For clients: service, master, day, time, name and phone, confirm, plus "my bookings".
// For a master who linked their Telegram: today's bookings and closing time. Conversation state lives in
// the database, so a restart does not lose a half-finished booking.
import {
  BookingError, SLOT_STEP, addDays, bookingText, bookingsOverlapping, cancelBooking, closeDay, closeHours, createBooking, dayHours,
  daysWithSlots, dayLabel, earliestStart, getBooking, isDate, isTime, localNow, mastersFor, normalizePhone, priceLabel, slotsFor,
  toHhmm, toMin, whenLabel,
} from './core.mjs';
import { tx } from './db.mjs';
import { createNotifier } from './notify.mjs';

const DAYS_SHOWN = 12;
const CLOSE_DAYS_SHOWN = 14;
const button = (text, data) => ({ text, callback_data: data });
const rows = (items, perRow) => Array.from({ length: Math.ceil(items.length / perRow) }, (_, i) => items.slice(i * perRow, i * perRow + perRow));
const compactTime = (t) => t.replace(':', '');
const fromCompact = (t) => `${t.slice(0, 2)}:${t.slice(2)}`;

export function createBot({ db, call, studio, log = console, clock = Date.now }) {
  const offset = studio.utcOffsetMin;
  const notify = createNotifier({ db, call, log });
  const getState = (id) => JSON.parse(db.prepare('SELECT state FROM bot_state WHERE tg_id = ?').get(id)?.state ?? 'null');
  const setState = (id, s) => db.prepare('INSERT INTO bot_state (tg_id, state) VALUES (?, ?) ON CONFLICT (tg_id) DO UPDATE SET state = excluded.state').run(id, JSON.stringify(s));
  const clearState = (id) => db.prepare('DELETE FROM bot_state WHERE tg_id = ?').run(id);
  const knownClient = (id) => db.prepare('SELECT name, phone FROM clients WHERE tg_id = ?').get(id);

  const send = (chat, text, keyboard) => call('sendMessage', { chat_id: chat, text, reply_markup: keyboard ?? { remove_keyboard: true } });
  // Moves the conversation on in the same message, so old buttons do not pile up.
  const edit = (q, text, buttons) => call('editMessageText', {
    chat_id: q.message.chat.id, message_id: q.message.message_id, text, reply_markup: { inline_keyboard: buttons },
  }).catch((e) => {
    if (!/message is not modified/.test(e.message)) throw e;
  });

  // A master is recognised by the Telegram they linked in the cabinet, on every tap: callback data can be forged.
  const masterOf = (tgId) => db.prepare('SELECT * FROM masters WHERE tg_chat_id = ? AND active = 1 AND takes_bookings = 1').get(tgId);
  const menuButtons = (tgId) => [
    [button('Записаться', 'book')], [button('Мои записи', 'my')], [button('Цены и контакты', 'info')],
    ...(tgId && masterOf(tgId) ? [[button('Меню мастера', 'wm')]] : []),
  ];
  const backButton = [button('« В меню', 'menu')];
  const menuText = () => `Здравствуйте! Это бот записи в ${studio.name}. Выберите, что нужно.`;

  function serviceScreen() {
    const services = db.prepare(`SELECT DISTINCT s.* FROM services s
      JOIN master_services ms ON ms.service_id = s.id JOIN masters m ON m.id = ms.master_id
      WHERE s.active = 1 AND m.active = 1 AND m.takes_bookings = 1 ORDER BY s.name`).all();
    if (!services.length) return ['Сейчас записи через бот нет. Позвоните нам: ' + studio.phone, [backButton]];
    return ['Выберите услугу:', [...services.map((s) => [button(`${s.name} · ${priceLabel(s)}`, `s:${s.id}`)]), backButton]];
  }

  function masterScreen(serviceId) {
    const masters = mastersFor(db, serviceId);
    if (masters.length === 1) return dayScreen(serviceId, masters[0].id);
    return ['Выберите мастера:', [
      [button('Любой свободный', `m:${serviceId}:0`)],
      ...masters.map((m) => [button(m.name, `m:${serviceId}:${m.id}`)]),
      [button('« К услугам', 'book')],
    ]];
  }

  function dayScreen(serviceId, masterId) {
    const days = daysWithSlots(db, serviceId, masterId, offset, DAYS_SHOWN, clock());
    if (!days.length) return [`Свободного времени на ближайший месяц нет. Позвоните нам: ${studio.phone}`, [[button('« К услугам', 'book')]]];
    return ['Выберите день:', [
      ...rows(days.map((d) => button(dayLabel(d), `d:${serviceId}:${masterId}:${d}`)), 2),
      [button('« К услугам', 'book')],
    ]];
  }

  function timeScreen(serviceId, masterId, date) {
    const slots = slotsFor(db, serviceId, masterId, date, earliestStart(offset, clock()));
    if (!slots.length) return ['На этот день время уже разобрали.', dayScreen(serviceId, masterId)[1]];
    return [`${dayLabel(date)}. Выберите время:`, [
      ...rows(slots.map((t) => button(t, `t:${serviceId}:${masterId}:${date}:${compactTime(t)}`)), 4),
      [button('« К дням', `m:${serviceId}:${masterId}`)],
    ]];
  }

  function summary(p) {
    const s = db.prepare('SELECT * FROM services WHERE id = ?').get(p.serviceId);
    const m = p.masterId ? db.prepare('SELECT name FROM masters WHERE id = ?').get(p.masterId) : null;
    return [`Услуга: ${s.name}, ${priceLabel(s)}`, m ? `Мастер: ${m.name}` : null, `Когда: ${whenLabel(`${p.date} ${p.time}`)}`].filter(Boolean).join('\n');
  }

  const consent = () => (studio.privacyUrl
    ? `Отправляя номер, вы соглашаетесь на обработку персональных данных для записи: ${studio.privacyUrl}`
    : 'Отправляя номер, вы соглашаетесь на обработку персональных данных для записи.');

  async function askConfirm(chat, tgId, p, client) {
    setState(tgId, { step: 'confirm', pending: p, name: client.name, phone: client.phone });
    await send(chat, `Проверьте запись:\n\n${summary(p)}\nИмя: ${client.name}\nТелефон: ${client.phone}`, {
      inline_keyboard: [[button('Подтвердить', 'ok')], [button('Изменить имя и телефон', 'rename')], [button('Отмена', 'menu')]],
    });
  }

  async function confirm(q, tgId) {
    const st = getState(tgId);
    if (st?.step !== 'confirm') return edit(q, 'Запись уже оформлена или устарела.', menuButtons(tgId));
    const p = st.pending;
    clearState(tgId);
    let b;
    try {
      b = createBooking(db, {
        serviceId: p.serviceId, masterId: p.masterId, date: p.date, time: p.time, source: 'telegram',
        client: { tgId, name: st.name, phone: st.phone },
        after: earliestStart(offset, clock()), offsetMin: offset, now: clock(),
      });
    } catch (e) {
      if (!(e instanceof BookingError)) throw e;
      if (e.code === 'too_many') return edit(q, 'У вас уже три активные записи. Чтобы записаться ещё, отмените одну или позвоните нам: ' + studio.phone, [[button('Мои записи', 'my')], backButton]);
      if (e.code === 'no_service') return edit(q, 'Эта услуга сейчас недоступна.', [backButton]);
      const [text, buttons] = timeScreen(p.serviceId, p.masterId, p.date);
      return edit(q, `Это время только что заняли. ${text}`, buttons);
    }
    await edit(q, `Вы записаны!\n\n${bookingText(b)}\n\n${studio.address}\n\nНапомним за день и за 2 часа.`, [[button('Мои записи', 'my')], backButton]);
    await notify.booked(b);
  }

  // The master's menu.
  const masterMenu = (m) => [`${m.name}, меню мастера.`, [
    [button('Записи на сегодня', `wd:${localNow(offset, clock()).slice(0, 10)}`)],
    [button('Закрыть время', 'wc')],
    [button('Открыть закрытое время', 'wo')],
    [button('« В меню клиента', 'menu')],
  ]];
  const toMaster = [button('« Меню мастера', 'wm')];

  function masterDay(m, date) {
    const list = bookingsOverlapping(db, m.id, `${date} 00:00`, `${addDays(date, 1)} 00:00`);
    const hours = dayHours(db, m.id, date);
    const head = `${dayLabel(date)}. ${hours ? `Работаете ${hours.start}–${hours.end}.` : 'Выходной.'}`;
    const body = list.length
      ? list.map((b) => `${b.start_at.slice(11)}–${b.end_at.slice(11)} ${b.service}\n${b.client}, ${b.phone}`).join('\n\n')
      : 'Записей нет.';
    return [`${head}\n\n${body}`, [
      [button('‹ Назад', `wd:${addDays(date, -1)}`), button('Вперёд ›', `wd:${addDays(date, 1)}`)],
      toMaster,
    ]];
  }

  function closeDayScreen() {
    const today = localNow(offset, clock()).slice(0, 10);
    const days = Array.from({ length: CLOSE_DAYS_SHOWN }, (_, i) => addDays(today, i));
    return ['Какой день?', [...rows(days.map((d) => button(dayLabel(d), `wc:${d}`)), 2), toMaster]];
  }

  // Starts on the working grid; an already passed time today is not offered.
  function closeStartScreen(m, date) {
    const hours = dayHours(db, m.id, date);
    if (!hours) return [`${dayLabel(date)} у вас и так выходной.`, [[button('« К дням', 'wc')], toMaster]];
    const now = localNow(offset, clock());
    const starts = [];
    for (let t = toMin(hours.start); t < toMin(hours.end); t += SLOT_STEP) {
      if (`${date} ${toHhmm(t)}` >= now) starts.push(toHhmm(t));
    }
    return [`${dayLabel(date)}. С какого времени закрыть?`, [
      [button('Весь день: выходной', `wf:${date}`)],
      ...rows(starts.map((t) => button(t, `ws:${date}:${t.replace(':', '')}`)), 4),
      [button('« К дням', 'wc')],
    ]];
  }

  function closeEndScreen(m, date, start) {
    const hours = dayHours(db, m.id, date);
    if (!hours) return closeStartScreen(m, date);
    const ends = [];
    for (let t = toMin(start) + SLOT_STEP; t <= toMin(hours.end); t += SLOT_STEP) ends.push(toHhmm(t));
    return [`${dayLabel(date)}, с ${start}. До какого времени?`, [
      ...rows(ends.map((t) => button(t, `we:${date}:${start.replace(':', '')}:${t.replace(':', '')}`)), 4),
      [button('« Другое начало', `wc:${date}`)],
    ]];
  }

  const conflictText = (list) => (list.length
    ? `\n\nВнимание, на это время уже есть записи, они не отменились. Свяжитесь с клиентами:\n${list.map((b) => `${whenLabel(b.start_at)}: ${b.client}, ${b.phone}`).join('\n')}`
    : '');

  function openScreen(m) {
    const today = localNow(offset, clock()).slice(0, 10);
    const blocks = db.prepare('SELECT id, start_at, end_at FROM blocks WHERE master_id = ? AND end_at >= ? ORDER BY start_at LIMIT 20').all(m.id, `${today} 00:00`);
    const off = db.prepare('SELECT date FROM day_overrides WHERE master_id = ? AND date >= ? AND start IS NULL ORDER BY date LIMIT 20').all(m.id, today);
    if (!blocks.length && !off.length) return ['Закрытого времени нет.', [toMaster]];
    return ['Нажмите, чтобы открыть время снова:', [
      ...off.map((o) => [button(`${dayLabel(o.date)}: весь день`, `wfu:${o.date}`)]),
      ...blocks.map((b) => [button(`${dayLabel(b.start_at.slice(0, 10))}: ${b.start_at.slice(11)}–${b.end_at.slice(11)}`, `wu:${b.id}`)]),
      toMaster,
    ]];
  }

  const hhmm = (s) => {
    const t = `${String(s ?? '').slice(0, 2)}:${String(s ?? '').slice(2)}`;
    return isTime(t) ? t : null;
  };

  // Every master action, after checking who taps. Returns [text, buttons] for the screen to show.
  function masterAction(m, kind, parts) {
    const date = isDate(parts[1]) ? parts[1] : null;
    if (kind === 'wm') return masterMenu(m);
    if (kind === 'wo') return openScreen(m);
    if (kind === 'wc' && !parts[1]) return closeDayScreen();
    if (kind === 'wu') {
      db.prepare('DELETE FROM blocks WHERE id = ? AND master_id = ?').run(Number(parts[1]), m.id);
      return openScreen(m);
    }
    if (!date) return masterMenu(m);
    if (kind === 'wd') return masterDay(m, date);
    if (kind === 'wc') return closeStartScreen(m, date);
    if (kind === 'wfu') {
      db.prepare('DELETE FROM day_overrides WHERE master_id = ? AND date = ? AND start IS NULL').run(m.id, date);
      return openScreen(m);
    }
    if (kind === 'wf') {
      const conflicts = closeDay(db, m.id, date);
      return [`${dayLabel(date)} теперь выходной, клиенты не смогут записаться.${conflictText(conflicts)}`, [[button('Отменить выходной', `wfu:${date}`)], toMaster]];
    }
    const start = hhmm(parts[2]);
    if (!start) return masterMenu(m);
    if (kind === 'ws') return closeEndScreen(m, date, start);
    if (kind === 'we') {
      const end = hhmm(parts[3]);
      if (!end || end <= start) return closeEndScreen(m, date, start);
      const { blockId, conflicts } = closeHours(db, m.id, date, start, end);
      return [`Закрыто: ${dayLabel(date)}, ${start}–${end}. Клиенты не смогут записаться на это время.${conflictText(conflicts)}`, [[button('Открыть снова', `wu:${blockId}`)], [button('Закрыть ещё', 'wc')], toMaster]];
    }
    return masterMenu(m);
  }

  function myScreen(tgId) {
    const list = db.prepare(`SELECT b.id FROM bookings b JOIN clients c ON c.id = b.client_id
      WHERE c.tg_id = ? AND b.status = 'active' AND b.start_at >= ? ORDER BY b.start_at`).all(tgId, localNow(offset, clock()));
    if (!list.length) return ['Активных записей нет.', [[button('Записаться', 'book')], backButton]];
    const items = list.map((r) => getBooking(db, r.id));
    return [items.map((b) => bookingText(b)).join('\n\n'), [
      ...items.map((b) => [button(`Отменить: ${whenLabel(b.start_at)}`, `x:${b.id}`)]),
      backButton,
    ]];
  }

  // The owner check matters: callback data can be replayed, so the id alone proves nothing.
  const ownBooking = (id, tgId) => {
    const b = getBooking(db, id);
    return b && b.client_tg === tgId ? b : null;
  };

  async function onCallback(q) {
    const tgId = q.from.id;
    const parts = String(q.data).split(':');
    const kind = parts[0];
    await call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
    if (q.message?.chat?.type !== 'private') return;
    const nums = parts.slice(1, 3).map(Number);
    if (kind === 'menu') {
      clearState(tgId);
      return edit(q, menuText(), menuButtons(tgId));
    }
    if (/^w[a-z]+$/.test(kind)) {
      const m = masterOf(tgId);
      if (!m) return edit(q, menuText(), menuButtons(tgId));
      return edit(q, ...masterAction(m, kind, parts));
    }
    if (kind === 'book') return edit(q, ...serviceScreen());
    if (kind === 'my') return edit(q, ...myScreen(tgId));
    if (kind === 'info') return edit(q, infoText(), [[button('Записаться', 'book')], backButton]);
    if (kind === 's') return edit(q, ...masterScreen(nums[0]));
    if (kind === 'm') return edit(q, ...dayScreen(nums[0], nums[1]));
    if (kind === 'd') return edit(q, ...timeScreen(nums[0], nums[1], parts[3]));
    if (kind === 't') {
      const p = { serviceId: nums[0], masterId: nums[1], date: parts[3], time: fromCompact(parts[4]) };
      const client = knownClient(tgId);
      if (client) return askConfirm(q.message.chat.id, tgId, p, client);
      setState(tgId, { step: 'name', pending: p });
      return send(q.message.chat.id, 'Как вас зовут?');
    }
    if (kind === 'rename') {
      const st = getState(tgId);
      if (st?.step !== 'confirm') return edit(q, menuText(), menuButtons(tgId));
      setState(tgId, { step: 'name', pending: st.pending });
      return send(q.message.chat.id, 'Как вас зовут?');
    }
    if (kind === 'ok') return confirm(q, tgId);
    if (kind === 'x') {
      const b = ownBooking(nums[0], tgId);
      if (!b || b.status !== 'active') return edit(q, ...myScreen(tgId));
      return edit(q, `Отменить запись?\n\n${bookingText(b)}`, [[button('Да, отменить', `xx:${b.id}`)], [button('Нет, оставить', 'my')]]);
    }
    if (kind === 'xx') {
      const b = ownBooking(nums[0], tgId);
      const done = b ? cancelBooking(db, b.id) : null;
      if (done) await notify.cancelled(done, 'Клиент');
      const [text, buttons] = myScreen(tgId);
      return edit(q, `Запись отменена.\n\n${text}`, buttons);
    }
    return undefined;
  }

  function infoText() {
    const services = db.prepare('SELECT * FROM services WHERE active = 1 ORDER BY name').all();
    return [`${studio.name}`, '', ...services.map((s) => `${s.name}: ${priceLabel(s)}`), '', studio.address, studio.hours, studio.phone].join('\n');
  }

  async function linkMaster(chat, code) {
    const m = db.prepare('SELECT id, name FROM masters WHERE link_code = ? AND active = 1').get(code);
    if (!m) return send(chat, 'Ссылка устарела. Откройте новую в кабинете.');
    db.prepare('UPDATE masters SET tg_chat_id = ?, link_code = NULL WHERE id = ?').run(chat, m.id);
    const linked = masterOf(chat);
    return send(chat, `${m.name}, готово: уведомления о записях будут приходить сюда.`, linked
      ? { inline_keyboard: masterMenu(linked)[1] }
      : undefined);
  }

  // A client who booked on the site opens the bot by a one-time link, so their reminders can reach them.
  async function linkClient(chat, tgId, code) {
    const linked = tx(db, () => {
      const c = db.prepare('SELECT id FROM clients WHERE link_code = ?').get(code);
      if (!c) return false;
      const known = db.prepare('SELECT id FROM clients WHERE tg_id = ?').get(tgId);
      if (known) {
        db.prepare('UPDATE bookings SET client_id = ? WHERE client_id = ?').run(known.id, c.id);
        db.prepare('DELETE FROM clients WHERE id = ?').run(c.id);
      } else {
        db.prepare('UPDATE clients SET tg_id = ?, link_code = NULL WHERE id = ?').run(tgId, c.id);
      }
      return true;
    });
    if (!linked) return send(chat, 'Ссылка устарела.', { inline_keyboard: menuButtons(tgId) });
    return send(chat, 'Готово: напомним о визите за день и за 2 часа. Запись можно посмотреть и отменить здесь.', { inline_keyboard: menuButtons(tgId) });
  }

  async function onMessage(msg) {
    if (msg.chat.type !== 'private' || !msg.from) return undefined;
    const tgId = msg.from.id;
    const text = msg.text?.trim() ?? '';
    if (text.startsWith('/start')) {
      const arg = text.split(/\s+/)[1];
      if (arg?.startsWith('m_')) return linkMaster(msg.chat.id, arg.slice(2));
      if (arg?.startsWith('c_')) return linkClient(msg.chat.id, tgId, arg.slice(2));
      clearState(tgId);
      const m = masterOf(tgId);
      if (m) {
        const [menuTitle, buttons] = masterMenu(m);
        return send(msg.chat.id, menuTitle, { inline_keyboard: buttons });
      }
      return send(msg.chat.id, menuText(), { inline_keyboard: menuButtons(tgId) });
    }
    const st = getState(tgId);
    if (st?.step === 'name') {
      const name = text.replace(/\s+/g, ' ').slice(0, 60);
      if (!name || name.startsWith('/')) return send(msg.chat.id, 'Напишите, пожалуйста, имя текстом.');
      setState(tgId, { step: 'phone', pending: st.pending, name });
      return send(msg.chat.id, `Оставьте номер для связи: нажмите кнопку или напишите его.\n\n${consent()}`, {
        keyboard: [[{ text: 'Отправить мой номер', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true,
      });
    }
    if (st?.step === 'phone') {
      const phone = normalizePhone(msg.contact?.phone_number ?? text);
      if (!phone) return send(msg.chat.id, 'Не похоже на российский номер. Пример: +7 900 123-45-67', {
        keyboard: [[{ text: 'Отправить мой номер', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true,
      });
      await send(msg.chat.id, 'Спасибо!');
      return askConfirm(msg.chat.id, tgId, st.pending, { name: st.name, phone });
    }
    return send(msg.chat.id, menuText(), { inline_keyboard: menuButtons(tgId) });
  }

  return {
    onUpdate: (u) => (u.callback_query ? onCallback(u.callback_query) : u.message ? onMessage(u.message) : undefined),
  };
}
