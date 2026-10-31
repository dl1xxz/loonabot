// Runs one studio: the cabinet, the Telegram bot, reminders and a daily database backup.
// Run: node --env-file=booking/.env booking/server.mjs   (see booking/README.md)
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBot } from './bot.mjs';
import { localNow } from './core.mjs';
import { openDb } from './db.mjs';
import { sendReminders } from './reminders.mjs';
import { seedStudio } from './seed.mjs';
import { poll, telegramClient } from './telegram.mjs';
import { createWeb } from './web.mjs';

const clientName = process.env.BOOKING_CLIENT || 'loona';
if (!/^[a-z0-9-]+$/.test(clientName)) throw new Error('BOOKING_CLIENT: only a-z, 0-9 and dashes');
const client = await import(`./clients/${clientName}.mjs`);
const studio = { ...client.studio };
const dataDir = process.env.BOOKING_DATA || join('booking', 'data', clientName);
const db = openDb(join(dataDir, 'booking.db'));
if (!db.prepare('SELECT 1 FROM masters LIMIT 1').get()) await seedStudio(db, client, dataDir);

const token = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const call = token ? telegramClient(token, process.env.TELEGRAM_API_BASE || undefined) : null;
let username = null;

// The site sits next to this file in a deploy package; SITE_DIR points at it when running from the repo.
const packagedSite = fileURLToPath(new URL('./site', import.meta.url));
const siteDir = process.env.SITE_DIR || (existsSync(packagedSite) ? packagedSite : null);
const publicUrl = process.env.PUBLIC_URL || (process.env.DOMAIN ? `https://${process.env.DOMAIN.replace(/^https?:\/\//, '')}` : '');
if (publicUrl && siteDir && !studio.privacyUrl) studio.privacyUrl = `${publicUrl}/privacy.html`;

const server = createWeb({
  db, call, studio, botUsername: () => username, siteDir,
  publicHost: publicUrl ? new URL(publicUrl).host : null,
  secureCookies: process.env.COOKIE_SECURE === '1',
  trustProxy: process.env.TRUST_PROXY === '1',
  siteOrigins: (process.env.SITE_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
});
const port = Number(process.env.PORT || 4340);
const host = process.env.HOST || '127.0.0.1';
server.listen(port, host, () => console.log(`cabinet: http://${host}:${port}`));

const stop = new AbortController();
const timers = [];

function backup() {
  const dir = join(dataDir, 'backups');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${localNow(studio.utcOffsetMin).slice(0, 10)}.db`);
  rmSync(file, { force: true });
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  for (const old of readdirSync(dir).filter((f) => f.endsWith('.db')).sort().slice(0, -14)) rmSync(join(dir, old));
}

function housekeeping() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  try {
    backup();
  } catch (e) {
    console.error('backup failed:', e.message);
  }
}
housekeeping();
timers.push(setInterval(housekeeping, 24 * 3600 * 1000));

if (call) {
  // Retry until Telegram answers: the VPS may start before its network does.
  const connect = async () => {
    try {
      username = (await call('getMe')).username;
      console.log(`bot: @${username}`);
    } catch (e) {
      console.error('Telegram is not answering:', e.message);
      if (!stop.signal.aborted) timers.push(setTimeout(connect, 15000));
    }
  };
  await connect();
  const bot = createBot({ db, call, studio });
  poll(call, bot.onUpdate, stop.signal);
  const tick = () => sendReminders({ db, call, studio }).catch((e) => console.error('reminders failed:', e.message));
  tick();
  timers.push(setInterval(tick, 60000));
} else {
  console.log('TELEGRAM_BOT_TOKEN is not set: the cabinet runs, the bot and reminders are off');
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stop.abort();
    timers.forEach(clearInterval);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
