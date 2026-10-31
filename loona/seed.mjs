// Creates the first accounts, services and hours from booking/clients/<name>.mjs. The server runs this once, on
// its first start with an empty database. Generated passwords go to <data>/first-logins.txt, not the logs;
// delete the file after handing them out.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tx } from './db.mjs';
import { hashPassword, newPassword } from './web.mjs';

export async function seedStudio(db, { services, masters }, dataDir) {
  const logins = [];
  const hashed = await Promise.all(masters.map(async (m) => {
    const password = newPassword();
    logins.push(`${m.name}: логин ${m.login}, пароль ${password}`);
    return hashPassword(password);
  }));

  tx(db, () => {
    const ids = new Map(services.map((s) => [s.key, Number(db.prepare('INSERT INTO services (name, minutes, price, price_from) VALUES (?, ?, ?, ?)')
      .run(s.name, s.minutes, s.price, s.from ? 1 : 0).lastInsertRowid)]));
    masters.forEach((m, i) => {
      const id = Number(db.prepare('INSERT INTO masters (name, login, pass_hash, role, takes_bookings) VALUES (?, ?, ?, ?, ?)')
        .run(m.name, m.login, hashed[i], m.role, m.takesBookings === false ? 0 : 1).lastInsertRowid);
      for (const key of m.services ?? []) db.prepare('INSERT INTO master_services (master_id, service_id) VALUES (?, ?)').run(id, ids.get(key));
      for (const weekday of m.weekdays ?? []) db.prepare('INSERT INTO week_hours (master_id, weekday, start, end) VALUES (?, ?, ?, ?)').run(id, weekday, m.start, m.end);
    });
  });

  const file = join(dataDir, 'first-logins.txt');
  writeFileSync(file, `${logins.join('\n')}\n`, { mode: 0o600 });
  console.log(`${masters.length} accounts and ${services.length} services created; passwords are in ${file}`);
}
