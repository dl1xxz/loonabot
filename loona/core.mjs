// Booking rules, shared by the bot and the cabinet: free slots, creating and cancelling a booking.
import { tx } from './db.mjs';

export const SLOT_STEP = 30; // minutes between possible starts
export const LEAD_MINUTES = 60; // the soonest a client can book themselves
export const MAX_ACTIVE_PER_CLIENT = 3;
export const BOOK_DAYS_AHEAD = 30;

export class BookingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const pad = (n) => String(n).padStart(2, '0');
export const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const toHhmm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
export const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

// The current studio-local time as 'YYYY-MM-DD HH:MM'. offsetMin is the zone's offset from UTC (Anapa: +180).
export function localNow(offsetMin, now = Date.now()) {
  return new Date(now + offsetMin * 60000).toISOString().slice(0, 16).replace('T', ' ');
}

export function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
}

// 0 is Monday, matching week_hours.
export const weekdayOf = (date) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;

// Whole minutes from local timestamp a to local timestamp b.
export const minutesBetween = (a, b) => (Date.parse(`${b.replace(' ', 'T')}:00Z`) - Date.parse(`${a.replace(' ', 'T')}:00Z`)) / 60000;

export function normalizePhone(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 11 && (d[0] === '7' || d[0] === '8')) return `+7${d.slice(1)}`;
  if (d.length === 10 && d[0] === '9') return `+7${d}`;
  return null;
}

// The master's working hours on a date, or null for a day off.
export function dayHours(db, masterId, date) {
  const o = db.prepare('SELECT start, end FROM day_overrides WHERE master_id = ? AND date = ?').get(masterId, date);
  if (o) return o.start ? { start: o.start, end: o.end } : null;
  const w = db.prepare('SELECT start, end FROM week_hours WHERE master_id = ? AND weekday = ?').get(masterId, weekdayOf(date));
  return w ? { start: w.start, end: w.end } : null;
}

// Busy intervals on a date as minutes from midnight: active bookings and closed hours.
function busy(db, masterId, date) {
  const from = `${date} 00:00`;
  const to = `${addDays(date, 1)} 00:00`;
  const rows = db.prepare(`
    SELECT start_at, end_at FROM bookings WHERE master_id = ? AND status = 'active' AND start_at < ? AND end_at > ?
    UNION ALL SELECT start_at, end_at FROM blocks WHERE master_id = ? AND start_at < ? AND end_at > ?
  `).all(masterId, to, from, masterId, to, from);
  return rows.map((r) => [Math.max(0, minutesBetween(from, r.start_at)), Math.min(1440, minutesBetween(from, r.end_at))]);
}

// Start times the service fits on a date for one master. `after` is a local timestamp; earlier starts are hidden.
export function freeSlots(db, masterId, serviceId, date, after) {
  const svc = db.prepare('SELECT minutes FROM services WHERE id = ?').get(serviceId);
  const hours = dayHours(db, masterId, date);
  if (!svc || !hours) return [];
  const taken = busy(db, masterId, date);
  const end = toMin(hours.end);
  const out = [];
  for (let m = toMin(hours.start); m + svc.minutes <= end; m += SLOT_STEP) {
    if (after && `${date} ${toHhmm(m)}` < after) continue;
    if (taken.every(([a, b]) => m + svc.minutes <= a || m >= b)) out.push(toHhmm(m));
  }
  return out;
}

export function mastersFor(db, serviceId) {
  return db.prepare(`
    SELECT m.id, m.name, m.tg_chat_id FROM masters m JOIN master_services ms ON ms.master_id = m.id
    WHERE ms.service_id = ? AND m.active = 1 AND m.takes_bookings = 1 ORDER BY m.name
  `).all(serviceId);
}

// Slots for one master, or for anyone who does the service when masterId is 0.
export function slotsFor(db, serviceId, masterId, date, after) {
  const ids = masterId ? [masterId] : mastersFor(db, serviceId).map((m) => m.id);
  return [...new Set(ids.flatMap((id) => freeSlots(db, id, serviceId, date, after)))].sort();
}

// The earliest moment a client can book right now.
export function earliestStart(offsetMin, now = Date.now()) {
  return localNow(offsetMin, now + LEAD_MINUTES * 60000);
}

// Upcoming dates with at least one free slot.
export function daysWithSlots(db, serviceId, masterId, offsetMin, limit, now = Date.now()) {
  const after = earliestStart(offsetMin, now);
  const today = localNow(offsetMin, now).slice(0, 10);
  const out = [];
  for (let i = 0; i < BOOK_DAYS_AHEAD && out.length < limit; i++) {
    const date = addDays(today, i);
    if (slotsFor(db, serviceId, masterId, date, after).length) out.push(date);
  }
  return out;
}

function upsertClient(db, { tgId, name, phone }) {
  if (tgId) {
    db.prepare(`INSERT INTO clients (tg_id, name, phone) VALUES (?, ?, ?)
      ON CONFLICT (tg_id) DO UPDATE SET name = excluded.name, phone = excluded.phone`).run(tgId, name, phone);
    return db.prepare('SELECT id FROM clients WHERE tg_id = ?').get(tgId).id;
  }
  return Number(db.prepare('INSERT INTO clients (name, phone) VALUES (?, ?)').run(name, phone).lastInsertRowid);
}

// Creates a booking after re-checking the slot inside one transaction, so two clients cannot take the same time.
// masterId 0 picks the first free master. `after` limits how soon the booking may start; the cabinet may omit it
// and also skip the working-hours check with `anyTime`, since a master can squeeze a client in.
export function createBooking(db, { serviceId, masterId, date, time, client, source, note = '', after, anyTime = false, limitPhone = false, offsetMin, now = Date.now() }) {
  return tx(db, () => {
    const svc = db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(serviceId);
    if (!svc) throw new BookingError('no_service', 'Услуга недоступна');
    if (!isDate(date) || !isTime(time)) throw new BookingError('bad_time', 'Неверная дата или время');
    const startAt = `${date} ${time}`;
    if (after && startAt < after) throw new BookingError('slot_taken', 'Это время уже недоступно');
    if (client.tgId) {
      const n = db.prepare(`SELECT count(*) AS n FROM bookings b JOIN clients c ON c.id = b.client_id
        WHERE c.tg_id = ? AND b.status = 'active' AND b.start_at >= ?`).get(client.tgId, localNow(offsetMin, now)).n;
      if (n >= MAX_ACTIVE_PER_CLIENT) throw new BookingError('too_many', 'Слишком много активных записей');
    }
    // The site has no account behind a client, so the phone number stands in for one.
    if (limitPhone) {
      const n = db.prepare(`SELECT count(*) AS n FROM bookings b JOIN clients c ON c.id = b.client_id
        WHERE c.phone = ? AND b.status = 'active' AND b.start_at >= ?`).get(client.phone, localNow(offsetMin, now)).n;
      if (n >= MAX_ACTIVE_PER_CLIENT) throw new BookingError('too_many', 'На этот номер уже есть несколько записей. Позвоните нам, чтобы записаться ещё.');
    }
    // Callback data can be forged, so a client may only pick a master who really does this service.
    const offering = mastersFor(db, serviceId).map((m) => m.id);
    const ids = !masterId ? offering : anyTime || offering.includes(masterId) ? [masterId] : [];
    const endMin = toMin(time) + svc.minutes;
    if (endMin > 1440) throw new BookingError('slot_taken', 'Услуга не помещается в этот день');
    const fits = (id) => {
      if (!anyTime) return freeSlots(db, id, serviceId, date).includes(time);
      return busy(db, id, date).every(([a, b]) => endMin <= a || toMin(time) >= b);
    };
    const chosen = ids.find(fits);
    if (!chosen) throw new BookingError('slot_taken', 'Это время уже занято');
    const clientId = upsertClient(db, client);
    const endAt = `${date} ${toHhmm(endMin)}`;
    // A reminder whose moment has already passed at booking time is not owed.
    const lead = minutesBetween(localNow(offsetMin, now), startAt);
    const id = Number(db.prepare(`INSERT INTO bookings
      (master_id, service_id, client_id, start_at, end_at, source, note, reminded_day, reminded_soon, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(chosen, serviceId, clientId, startAt, endAt, source, note,
      lead <= 24 * 60 ? 1 : 0, lead <= 2 * 60 ? 1 : 0, localNow(offsetMin, now)).lastInsertRowid);
    return getBooking(db, id);
  });
}

export function getBooking(db, id) {
  return db.prepare(`
    SELECT b.*, s.name AS service, s.price, s.price_from, m.name AS master, m.tg_chat_id AS master_chat,
      c.name AS client, c.phone AS phone, c.tg_id AS client_tg
    FROM bookings b JOIN services s ON s.id = b.service_id JOIN masters m ON m.id = b.master_id JOIN clients c ON c.id = b.client_id
    WHERE b.id = ?
  `).get(id);
}

// Cancels an active booking; returns it, or null if it was already cancelled or does not exist.
export function cancelBooking(db, id) {
  const r = db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status = 'active'").run(id);
  return r.changes ? getBooking(db, id) : null;
}

// Active bookings that the master's current hours no longer cover, from a date on: shown after a schedule change.
export function bookingsOutsideHours(db, masterId, fromDate) {
  const rows = db.prepare(`SELECT id, start_at, end_at FROM bookings WHERE master_id = ? AND status = 'active' AND start_at >= ? ORDER BY start_at`).all(masterId, `${fromDate} 00:00`);
  return rows.filter((b) => {
    const h = dayHours(db, masterId, b.start_at.slice(0, 10));
    return !h || b.start_at.slice(11) < h.start || b.end_at.slice(11) > h.end;
  }).map((b) => getBooking(db, b.id));
}

// Active bookings that overlap an interval.
export function bookingsOverlapping(db, masterId, startAt, endAt) {
  return db.prepare("SELECT id FROM bookings WHERE master_id = ? AND status = 'active' AND start_at < ? AND end_at > ? ORDER BY start_at")
    .all(masterId, endAt, startAt).map((r) => getBooking(db, r.id));
}

// Closes hours on a date. Existing bookings stay: the caller shows them, so the master can warn those clients.
export function closeHours(db, masterId, date, start, end, note = '') {
  const startAt = `${date} ${start}`;
  const endAt = `${date} ${end}`;
  const blockId = Number(db.prepare('INSERT INTO blocks (master_id, start_at, end_at, note) VALUES (?, ?, ?, ?)').run(masterId, startAt, endAt, note).lastInsertRowid);
  return { blockId, conflicts: bookingsOverlapping(db, masterId, startAt, endAt) };
}

// Makes a date a day off, returning that day's bookings for the same reason.
export function closeDay(db, masterId, date) {
  db.prepare(`INSERT INTO day_overrides (master_id, date, start, end) VALUES (?, ?, NULL, NULL)
    ON CONFLICT (master_id, date) DO UPDATE SET start = NULL, end = NULL`).run(masterId, date);
  return bookingsOverlapping(db, masterId, `${date} 00:00`, `${addDays(date, 1)} 00:00`);
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const DAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
export const dayLabel = (date) => `${Number(date.slice(8))} ${MONTHS[Number(date.slice(5, 7)) - 1]}, ${DAYS[weekdayOf(date)]}`;
export const whenLabel = (startAt) => `${dayLabel(startAt.slice(0, 10))} в ${startAt.slice(11)}`;
export const priceLabel = (s) => `${s.price_from ? 'от ' : ''}${s.price.toLocaleString('ru-RU').replace(/ /g, ' ')} ₽`;
export const bookingText = (b) => `${b.service}, ${priceLabel(b)}\nМастер: ${b.master}\nКогда: ${whenLabel(b.start_at)}`;
