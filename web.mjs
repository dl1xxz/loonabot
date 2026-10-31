// The cabinet's HTTP server: static files and a JSON API. An admin manages everything; a master can only see
// and change their own schedule and bookings.
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  BOOK_DAYS_AHEAD, BookingError, addDays, bookingsOutsideHours, cancelBooking, closeDay, closeHours, createBooking, daysWithSlots,
  earliestStart, getBooking, isDate, isTime, localNow, mastersFor, normalizePhone, slotsFor, whenLabel,
} from './core.mjs';
import { tx } from './db.mjs';
import { createNotifier } from './notify.mjs';

const scryptAsync = promisify(scrypt);
const SESSION_DAYS = 30;
const COOKIE = 'cabinet_session';
const MAX_FAILS = 5;
const FAIL_WINDOW = 15 * 60000;
const STATIC = { '/cabinet/': ['index.html', 'text/html; charset=utf-8'], '/cabinet/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/cabinet/app.css': ['app.css', 'text/css; charset=utf-8'] };
const SITE_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.avif': 'image/avif', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json',
};
// The page keeps its settings in one inline script, so unlike the cabinet the site needs inline allowed.
const SITE_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const CABINET_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const PUBLIC = new URL('./public/', import.meta.url);

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 32);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

async function checkPassword(password, stored) {
  const [salt, key] = stored.split(':');
  const got = await scryptAsync(password, Buffer.from(salt, 'hex'), 32);
  return timingSafeEqual(got, Buffer.from(key, 'hex'));
}

export const newPassword = () => randomBytes(9).toString('base64url');
const sha = (s) => createHash('sha256').update(s).digest('hex');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (message) => new HttpError(400, message);

function cleanName(v, max = 80) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s || s.length > max) throw bad('Заполните название или имя');
  return s;
}

function checkHours(start, end) {
  if (!isTime(start) || !isTime(end) || start >= end) throw bad('Проверьте время: начало должно быть раньше конца');
}

function intIn(v, min, max, message) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(message);
  return n;
}

const publicMaster = (m) => ({ id: m.id, name: m.name, login: m.login, role: m.role, active: !!m.active, takes_bookings: !!m.takes_bookings, telegram_linked: !!m.tg_chat_id });

// Allows `max` events per key inside a sliding window. Kept in memory: a restart simply resets the counts.
function rateLimiter(max, windowMs, clock) {
  const hits = new Map();
  return (key) => {
    const now = clock();
    if (hits.size > 10000) hits.clear();
    const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
    recent.push(now);
    hits.set(key, recent);
    return recent.length <= max;
  };
}

export function createWeb({ db, call, studio, botUsername = () => null, secureCookies = false, siteOrigins = [], trustProxy = false, siteDir = null, publicHost = null, log = console, clock = Date.now }) {
  const offset = studio.utcOffsetMin;
  const fails = new Map();
  const notify = createNotifier({ db, call, log });
  const readLimit = rateLimiter(120, 60000, clock);
  const bookLimit = rateLimiter(5, 10 * 60000, clock);
  // Behind a proxy every request comes from 127.0.0.1; the proxy appends the real address last.
  const clientIp = (req) => (trustProxy && String(req.headers['x-forwarded-for'] ?? '').split(',').pop().trim()) || req.socket.remoteAddress;

  const masterServices = (id) => db.prepare('SELECT service_id FROM master_services WHERE master_id = ?').all(id).map((r) => r.service_id);
  const getMaster = (id) => db.prepare('SELECT * FROM masters WHERE id = ?').get(id);

  function setServices(masterId, ids) {
    if (!Array.isArray(ids)) return;
    db.prepare('DELETE FROM master_services WHERE master_id = ?').run(masterId);
    const add = db.prepare('INSERT OR IGNORE INTO master_services (master_id, service_id) SELECT ?, id FROM services WHERE id = ?');
    for (const s of ids) add.run(masterId, Number(s));
  }

  function currentUser(req) {
    const m = (req.headers.cookie ?? '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([\\w-]+)`));
    if (!m) return null;
    const s = db.prepare('SELECT master_id FROM sessions WHERE token_hash = ? AND expires_at > ?').get(sha(m[1]), clock());
    if (!s) return null;
    const user = getMaster(s.master_id);
    return user?.active ? user : null;
  }

  const requireAdmin = (user) => {
    if (user.role !== 'admin') throw new HttpError(403, 'Это доступно только администратору');
  };
  const requireSelfOrAdmin = (user, id) => {
    if (user.role !== 'admin' && user.id !== id) throw new HttpError(403, 'Можно менять только свой график');
    if (!getMaster(id)) throw new HttpError(404, 'Мастер не найден');
  };

  const today = () => localNow(offset, clock()).slice(0, 10);

  function schedule(id) {
    return {
      week: db.prepare('SELECT weekday, start, end FROM week_hours WHERE master_id = ? ORDER BY weekday').all(id),
      overrides: db.prepare('SELECT date, start, end FROM day_overrides WHERE master_id = ? AND date >= ? ORDER BY date').all(id, today()),
      blocks: db.prepare('SELECT id, start_at, end_at, note FROM blocks WHERE master_id = ? AND end_at >= ? ORDER BY start_at').all(id, `${today()} 00:00`),
    };
  }

  const conflictView = (list) => list.map((b) => ({ id: b.id, when: whenLabel(b.start_at), client: b.client, phone: b.phone, service: b.service }));
  const scheduleResult = (id) => ({ schedule: schedule(id), conflicts: conflictView(bookingsOutsideHours(db, id, today())) });

  const routes = [
    ['GET', /^\/api\/me$/, (ctx) => ({ user: publicMaster(ctx.user), studio: { name: studio.name }, today: today() })],

    ['GET', /^\/api\/meta$/, ({ user }) => ({
      services: db.prepare('SELECT * FROM services ORDER BY active DESC, name').all(),
      masters: (user.role === 'admin' ? db.prepare('SELECT * FROM masters ORDER BY active DESC, name').all() : [user])
        .map((m) => ({ ...publicMaster(m), service_ids: masterServices(m.id) })),
    })],

    ['GET', /^\/api\/bookings$/, ({ user, url }) => {
      const from = url.searchParams.get('from') ?? today();
      if (!isDate(from)) throw bad('Неверная дата');
      const days = intIn(url.searchParams.get('days') ?? 7, 1, 62, 'Неверный период');
      const wanted = Number(url.searchParams.get('master_id')) || 0;
      const only = user.role === 'admin' ? wanted : user.id;
      const rows = db.prepare(`
        SELECT b.id, b.start_at, b.end_at, b.source, b.note, b.master_id, s.name AS service, m.name AS master, c.name AS client, c.phone
        FROM bookings b JOIN services s ON s.id = b.service_id JOIN masters m ON m.id = b.master_id JOIN clients c ON c.id = b.client_id
        WHERE b.status = 'active' AND b.start_at >= ? AND b.start_at < ? AND (? = 0 OR b.master_id = ?)
        ORDER BY b.start_at
      `).all(`${from} 00:00`, `${addDays(from, days)} 00:00`, only, only);
      return { bookings: rows };
    }],

    ['POST', /^\/api\/bookings$/, async ({ user, body }) => {
      const masterId = user.role === 'admin' ? Number(body.master_id) : user.id;
      if (!getMaster(masterId)) throw bad('Выберите мастера');
      const phone = normalizePhone(body.client_phone);
      if (!phone) throw bad('Проверьте номер телефона: нужен российский номер');
      const booking = createBooking(db, {
        serviceId: Number(body.service_id), masterId, date: body.date, time: body.time, source: 'cabinet', anyTime: true,
        client: { name: cleanName(body.client_name, 60), phone }, note: String(body.note ?? '').slice(0, 200), offsetMin: offset, now: clock(),
      });
      await notify.booked(booking, user.tg_chat_id);
      return { id: booking.id };
    }],

    ['POST', /^\/api\/bookings\/(\d+)\/cancel$/, async ({ user, params }) => {
      const row = db.prepare('SELECT master_id FROM bookings WHERE id = ?').get(Number(params[0]));
      if (!row) throw new HttpError(404, 'Запись не найдена');
      if (user.role !== 'admin' && row.master_id !== user.id) throw new HttpError(403, 'Это запись другого мастера');
      const b = cancelBooking(db, Number(params[0]));
      if (b) await notify.cancelled(b, user.name, user.tg_chat_id);
      if (b?.client_tg && call) {
        await call('sendMessage', {
          chat_id: b.client_tg,
          text: `Вашу запись пришлось отменить: ${b.service}, ${whenLabel(b.start_at)}. Извините за неудобство. Свяжитесь с нами: ${studio.phone}`,
        }).catch((e) => log.error('cancel notice failed', b.id, e.message));
      }
      return { ok: true, client_notified: !!b?.client_tg && !!call };
    }],

    ['GET', /^\/api\/masters\/(\d+)\/schedule$/, ({ user, params }) => {
      requireSelfOrAdmin(user, Number(params[0]));
      return schedule(Number(params[0]));
    }],

    ['PUT', /^\/api\/masters\/(\d+)\/week$/, ({ user, params, body }) => {
      const id = Number(params[0]);
      requireSelfOrAdmin(user, id);
      if (!Array.isArray(body.week)) throw bad('Неверный график');
      const seen = new Set();
      for (const d of body.week) {
        const weekday = intIn(d.weekday, 0, 6, 'Неверный день недели');
        if (seen.has(weekday)) throw bad('День недели указан дважды');
        seen.add(weekday);
        checkHours(d.start, d.end);
      }
      tx(db, () => {
        db.prepare('DELETE FROM week_hours WHERE master_id = ?').run(id);
        const add = db.prepare('INSERT INTO week_hours (master_id, weekday, start, end) VALUES (?, ?, ?, ?)');
        for (const d of body.week) add.run(id, d.weekday, d.start, d.end);
      });
      return scheduleResult(id);
    }],

    ['PUT', /^\/api\/masters\/(\d+)\/overrides\/(\d{4}-\d{2}-\d{2})$/, ({ user, params, body }) => {
      const id = Number(params[0]);
      requireSelfOrAdmin(user, id);
      if (!isDate(params[1])) throw bad('Неверная дата');
      if (body.off) {
        closeDay(db, id, params[1]);
        return scheduleResult(id);
      }
      checkHours(body.start, body.end);
      db.prepare(`INSERT INTO day_overrides (master_id, date, start, end) VALUES (?, ?, ?, ?)
        ON CONFLICT (master_id, date) DO UPDATE SET start = excluded.start, end = excluded.end`)
        .run(id, params[1], body.start, body.end);
      return scheduleResult(id);
    }],

    ['DELETE', /^\/api\/masters\/(\d+)\/overrides\/(\d{4}-\d{2}-\d{2})$/, ({ user, params }) => {
      const id = Number(params[0]);
      requireSelfOrAdmin(user, id);
      db.prepare('DELETE FROM day_overrides WHERE master_id = ? AND date = ?').run(id, params[1]);
      return scheduleResult(id);
    }],

    ['POST', /^\/api\/masters\/(\d+)\/blocks$/, ({ user, params, body }) => {
      const id = Number(params[0]);
      requireSelfOrAdmin(user, id);
      if (!isDate(body.date)) throw bad('Выберите дату');
      checkHours(body.start, body.end);
      const { conflicts } = closeHours(db, id, body.date, body.start, body.end, String(body.note ?? '').slice(0, 100));
      return { schedule: schedule(id), conflicts: conflictView(conflicts) };
    }],

    ['DELETE', /^\/api\/blocks\/(\d+)$/, ({ user, params }) => {
      const row = db.prepare('SELECT master_id FROM blocks WHERE id = ?').get(Number(params[0]));
      if (!row) throw new HttpError(404, 'Не найдено');
      requireSelfOrAdmin(user, row.master_id);
      db.prepare('DELETE FROM blocks WHERE id = ?').run(Number(params[0]));
      return { schedule: schedule(row.master_id) };
    }],

    ['POST', /^\/api\/services$/, ({ user, body }) => {
      requireAdmin(user);
      const r = db.prepare('INSERT INTO services (name, minutes, price, price_from) VALUES (?, ?, ?, ?)').run(
        cleanName(body.name),
        intIn(body.minutes, 15, 720, 'Длительность: от 15 минут до 12 часов'),
        intIn(body.price, 0, 1000000, 'Проверьте цену'),
        body.price_from ? 1 : 0,
      );
      return { id: Number(r.lastInsertRowid) };
    }],

    ['PATCH', /^\/api\/services\/(\d+)$/, ({ user, params, body }) => {
      requireAdmin(user);
      const s = db.prepare('SELECT * FROM services WHERE id = ?').get(Number(params[0]));
      if (!s) throw new HttpError(404, 'Услуга не найдена');
      db.prepare('UPDATE services SET name = ?, minutes = ?, price = ?, price_from = ?, active = ? WHERE id = ?').run(
        body.name === undefined ? s.name : cleanName(body.name),
        body.minutes === undefined ? s.minutes : intIn(body.minutes, 15, 720, 'Длительность: от 15 минут до 12 часов'),
        body.price === undefined ? s.price : intIn(body.price, 0, 1000000, 'Проверьте цену'),
        body.price_from === undefined ? s.price_from : body.price_from ? 1 : 0,
        body.active === undefined ? s.active : body.active ? 1 : 0,
        s.id,
      );
      return { ok: true };
    }],

    ['POST', /^\/api\/masters$/, async ({ user, body }) => {
      requireAdmin(user);
      const login = String(body.login ?? '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,32}$/.test(login)) throw bad('Логин: от 3 символов, латиница, цифры, точка, дефис');
      if (db.prepare('SELECT 1 FROM masters WHERE login = ?').get(login)) throw bad('Такой логин уже есть');
      const password = newPassword();
      const r = db.prepare("INSERT INTO masters (name, login, pass_hash, role) VALUES (?, ?, ?, 'master')").run(cleanName(body.name, 60), login, await hashPassword(password));
      const id = Number(r.lastInsertRowid);
      setServices(id, body.service_ids);
      return { id, password };
    }],

    ['PATCH', /^\/api\/masters\/(\d+)$/, ({ user, params, body }) => {
      requireAdmin(user);
      const m = getMaster(Number(params[0]));
      if (!m) throw new HttpError(404, 'Мастер не найден');
      if (body.active === false && m.id === user.id) throw bad('Нельзя отключить самого себя');
      const active = body.active === undefined ? m.active : body.active ? 1 : 0;
      db.prepare('UPDATE masters SET name = ?, active = ?, takes_bookings = ? WHERE id = ?').run(
        body.name === undefined ? m.name : cleanName(body.name, 60), active,
        body.takes_bookings === undefined ? m.takes_bookings : body.takes_bookings ? 1 : 0, m.id,
      );
      setServices(m.id, body.service_ids);
      if (!active) db.prepare('DELETE FROM sessions WHERE master_id = ?').run(m.id);
      return { ok: true };
    }],

    ['POST', /^\/api\/masters\/(\d+)\/reset-password$/, async ({ user, params }) => {
      requireAdmin(user);
      const m = getMaster(Number(params[0]));
      if (!m) throw new HttpError(404, 'Мастер не найден');
      const password = newPassword();
      db.prepare('UPDATE masters SET pass_hash = ? WHERE id = ?').run(await hashPassword(password), m.id);
      db.prepare('DELETE FROM sessions WHERE master_id = ?').run(m.id);
      return { password };
    }],

    ['POST', /^\/api\/me\/password$/, async ({ user, body }) => {
      if (!(await checkPassword(String(body.current ?? ''), user.pass_hash))) throw bad('Текущий пароль указан неверно');
      if (String(body.next ?? '').length < 8) throw bad('Новый пароль: минимум 8 символов');
      db.prepare('UPDATE masters SET pass_hash = ? WHERE id = ?').run(await hashPassword(String(body.next)), user.id);
      return { ok: true };
    }],

    ['POST', /^\/api\/me\/telegram-link$/, ({ user }) => {
      const name = botUsername();
      if (!name) throw new HttpError(503, 'Бот пока не подключён');
      const code = randomBytes(12).toString('hex');
      db.prepare('UPDATE masters SET link_code = ? WHERE id = ?').run(code, user.id);
      return { url: `https://t.me/${name}?start=m_${code}` };
    }],
  ];

  // A hosting proxy may rewrite Host, so the address it forwarded and our configured one count as well.
  function sameSite(req, origin) {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      return false;
    }
    return host === req.headers.host || (trustProxy && host === req.headers['x-forwarded-host']) || host === publicHost;
  }

  // What the studio's site may see and do without a login. Only names and prices go out, never contacts of staff.
  const offeredService = (id) => {
    const s = db.prepare('SELECT id FROM services WHERE id = ? AND active = 1').get(Number(id));
    if (!s) throw new HttpError(404, 'Услуга недоступна');
    return s.id;
  };
  const offeredMaster = (serviceId, id) => {
    const masterId = Number(id) || 0;
    if (masterId && !mastersFor(db, serviceId).some((m) => m.id === masterId)) throw new HttpError(404, 'Этот мастер не делает такую услугу');
    return masterId;
  };
  const bookableDate = (date) => {
    if (!isDate(date) || date < today() || date > addDays(today(), BOOK_DAYS_AHEAD)) throw bad('На эту дату записаться нельзя');
    return date;
  };

  const publicRoutes = [
    ['GET', '/api/public/info', () => ({
      studio: { name: studio.name, address: studio.address, hours: studio.hours, phone: studio.phone, privacy_url: studio.privacyUrl },
      services: db.prepare('SELECT id, name, minutes, price, price_from FROM services WHERE active = 1 ORDER BY name').all()
        .map((s) => ({ ...s, masters: mastersFor(db, s.id).map((m) => ({ id: m.id, name: m.name })) }))
        .filter((s) => s.masters.length),
    })],
    ['GET', '/api/public/days', ({ url }) => {
      const serviceId = offeredService(url.searchParams.get('service_id'));
      const masterId = offeredMaster(serviceId, url.searchParams.get('master_id'));
      return { days: daysWithSlots(db, serviceId, masterId, offset, BOOK_DAYS_AHEAD, clock()) };
    }],
    ['GET', '/api/public/slots', ({ url }) => {
      const serviceId = offeredService(url.searchParams.get('service_id'));
      const masterId = offeredMaster(serviceId, url.searchParams.get('master_id'));
      return { slots: slotsFor(db, serviceId, masterId, bookableDate(url.searchParams.get('date')), earliestStart(offset, clock())) };
    }],
    ['POST', '/api/public/bookings', async ({ req, body }) => {
      // `website` is a field people never see: only a spam bot fills it in.
      if (body.website) throw bad('Неверный запрос');
      if (!bookLimit(clientIp(req))) throw new HttpError(429, 'Слишком много заявок. Попробуйте позже или позвоните нам.');
      if (body.consent !== true) throw bad('Нужно согласие на обработку персональных данных');
      const phone = normalizePhone(body.phone);
      if (!phone) throw bad('Проверьте номер телефона: нужен российский номер');
      const serviceId = offeredService(body.service_id);
      const b = createBooking(db, {
        serviceId, masterId: offeredMaster(serviceId, body.master_id), date: bookableDate(body.date), time: body.time, source: 'site',
        client: { name: cleanName(body.name, 60), phone }, limitPhone: true,
        after: earliestStart(offset, clock()), offsetMin: offset, now: clock(),
      });
      await notify.booked(b);
      let telegramUrl = null;
      const bot = botUsername();
      if (bot) {
        const code = randomBytes(12).toString('hex');
        db.prepare('UPDATE clients SET link_code = ? WHERE id = ?').run(code, b.client_id);
        telegramUrl = `https://t.me/${bot}?start=c_${code}`;
      }
      return { ok: true, service: b.service, master: b.master, when: whenLabel(b.start_at), address: studio.address, telegram_url: telegramUrl };
    }],
  ];

  async function publicApi(req, res, url) {
    const origin = req.headers.origin;
    const allowed = origin && siteOrigins.includes(origin);
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      if (allowed) {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Max-Age', '86400');
      }
      return {};
    }
    const route = publicRoutes.find(([method, path]) => method === req.method && path === url.pathname);
    if (!route) throw new HttpError(404, 'Не найдено');
    if (req.method === 'GET') {
      if (!readLimit(clientIp(req))) throw new HttpError(429, 'Слишком много запросов. Попробуйте позже.');
      return route[2]({ req, url, body: {} });
    }
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw bad('Нужен JSON');
    if (origin && !allowed && !sameSite(req, origin)) throw new HttpError(403, 'Запрос с другого сайта');
    return route[2]({ req, url, body: await readBody(req) });
  }

  async function login(req, res, body) {
    const name = String(body.login ?? '').trim().toLowerCase();
    const key = `${clientIp(req)}|${name}`;
    const f = fails.get(key);
    if (f && f.until > clock() && f.n >= MAX_FAILS) throw new HttpError(429, 'Слишком много попыток. Попробуйте через 15 минут.');
    const user = db.prepare('SELECT * FROM masters WHERE login = ? AND active = 1').get(name);
    // Hash even for an unknown login, so response time does not reveal which logins exist.
    const ok = await checkPassword(String(body.password ?? ''), user?.pass_hash ?? DUMMY_HASH);
    if (!user || !ok) {
      fails.set(key, { n: (f && f.until > clock() ? f.n : 0) + 1, until: clock() + FAIL_WINDOW });
      throw new HttpError(401, 'Неверный логин или пароль');
    }
    fails.delete(key);
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (token_hash, master_id, expires_at) VALUES (?, ?, ?)').run(sha(token), user.id, clock() + SESSION_DAYS * 864e5);
    res.setHeader('Set-Cookie', cookie(token, SESSION_DAYS * 86400));
    return { ok: true };
  }

  const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;

  function logout(req, res) {
    const m = (req.headers.cookie ?? '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([\\w-]+)`));
    if (m) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(m[1]));
    res.setHeader('Set-Cookie', cookie('', 0));
    return { ok: true };
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 64 * 1024) throw new HttpError(413, 'Слишком большой запрос');
      chunks.push(c);
    }
    if (!size) return {};
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {
      // answered below
    }
    throw bad('Неверный запрос');
  }

  async function api(req, res, url) {
    if (url.pathname.startsWith('/api/public/')) return publicApi(req, res, url);
    if (req.method !== 'GET') {
      // The cookie is SameSite=Strict; this also refuses cross-site form posts on old browsers.
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw bad('Нужен JSON');
      const origin = req.headers.origin;
      if (origin && !sameSite(req, origin)) throw new HttpError(403, 'Запрос с другого сайта');
    }
    const body = req.method === 'GET' ? {} : await readBody(req);
    if (url.pathname === '/api/login' && req.method === 'POST') return login(req, res, body);
    if (url.pathname === '/api/logout' && req.method === 'POST') return logout(req, res);
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'Войдите в кабинет');
    for (const [method, re, fn] of routes) {
      const m = re.exec(url.pathname);
      if (m && method === req.method) return fn({ user, url, body, params: m.slice(1) });
    }
    throw new HttpError(404, 'Не найдено');
  }

  function send(res, status, type, payload, { csp = CABINET_CSP, cache = 'no-store' } = {}) {
    res.writeHead(status, {
      'content-type': type,
      'cache-control': cache,
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'same-origin',
      'content-security-policy': csp,
    });
    res.end(payload);
  }

  // Serves the studio's static site from siteDir, refusing anything that could step outside it.
  async function sendSiteFile(res, pathname) {
    if (!siteDir) {
      if (pathname !== '/') throw new HttpError(404, 'Не найдено');
      res.writeHead(302, { location: '/cabinet/' });
      res.end();
      return;
    }
    let rel;
    try {
      rel = decodeURIComponent(pathname).slice(1) || 'index.html';
    } catch {
      throw new HttpError(404, 'Не найдено');
    }
    const type = SITE_TYPES[extname(rel).toLowerCase()];
    if (!type || rel.includes('\0') || rel.split(/[\\/]/).some((part) => part === '..' || part.startsWith('.'))) throw new HttpError(404, 'Не найдено');
    const body = await readFile(join(siteDir, rel)).catch(() => {
      throw new HttpError(404, 'Не найдено');
    });
    const longLived = rel.startsWith('img/') || rel.startsWith('fonts/');
    send(res, 200, type, body, { csp: SITE_CSP, cache: longLived ? 'public, max-age=604800' : 'no-cache' });
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    try {
      if (url.pathname.startsWith('/api/')) {
        send(res, 200, 'application/json; charset=utf-8', JSON.stringify(await api(req, res, url)));
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(404, 'Не найдено');
      if (url.pathname === '/health') {
        send(res, 200, 'text/plain; charset=utf-8', 'ok');
        return;
      }
      if (url.pathname === '/cabinet') {
        res.writeHead(301, { location: '/cabinet/' });
        res.end();
        return;
      }
      const file = STATIC[url.pathname];
      if (file) {
        send(res, 200, file[1], await readFile(new URL(file[0], PUBLIC)));
        return;
      }
      await sendSiteFile(res, url.pathname);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof BookingError ? 409 : 500;
      if (status === 500) log.error(req.method, url.pathname, e);
      send(res, status, 'application/json; charset=utf-8', JSON.stringify({ error: status === 500 ? 'Ошибка сервера. Попробуйте ещё раз.' : e.message }));
    }
  });
}

// Compared against when a login does not exist; matches nothing anyone can type (random salt and key).
const DUMMY_HASH = `${randomBytes(16).toString('hex')}:${randomBytes(32).toString('hex')}`;
