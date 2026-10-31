// The cabinet's interface. Every value goes through textContent, since client names come from Telegram.
const root = document.getElementById('app');
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const state = { user: null, studio: null, today: null, tab: 'bookings', from: null, masterId: 0, meta: null };

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el[k] = v;
    else if (k in el && k !== 'list') el[k] = v;
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  el.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') {
    state.user = null;
    renderLogin();
    throw new Error(data.error);
  }
  if (!res.ok) throw new Error(data.error || 'Не получилось. Попробуйте ещё раз.');
  return data;
}

const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const weekday = (date) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
const dayText = (date) => `${WEEKDAYS[weekday(date)]}, ${Number(date.slice(8))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
const rubles = (s) => `${s.price_from ? 'от ' : ''}${Number(s.price).toLocaleString('ru-RU')} ₽`;
const field = (label, input) => h('label', { class: 'field' }, label, input);
const message = (kind, text) => h('p', { class: `msg msg-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, text);

// A slot under a form that shows the outcome of the last action.
function statusSlot() {
  const el = h('div', {});
  el.show = (kind, text) => el.replaceChildren(message(kind, text));
  el.clear = () => el.replaceChildren();
  return el;
}

// Runs a button's action with the button disabled, so a double tap cannot create two bookings.
function act(btn, slot, fn) {
  return async (e) => {
    e?.preventDefault();
    if (btn.disabled) return;
    btn.disabled = true;
    slot?.clear();
    try {
      await fn();
    } catch (err) {
      (slot ?? fallbackError).show('error', err.message);
    } finally {
      btn.disabled = false;
    }
  };
}
const fallbackError = { show: (_, text) => alert(text) };

function conflictsNotice(list) {
  if (!list?.length) return null;
  return h('div', { class: 'msg msg-warn', role: 'status' },
    h('p', {}, 'На это время уже есть записи, они не отменились. Свяжитесь с клиентами или отмените их в «Записях»:'),
    list.map((c) => h('p', {}, `${c.when}: ${c.client}, ${c.phone}, ${c.service}`)));
}

function renderLogin() {
  const login = h('input', { autocomplete: 'username', autocapitalize: 'none', required: true });
  const password = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const slot = statusSlot();
  const btn = h('button', { class: 'btn btn-main', type: 'submit' }, 'Войти');
  const form = h('form', { class: 'login' }, h('h1', {}, 'Кабинет записи'), field('Логин', login), field('Пароль', password), slot, btn);
  form.onsubmit = act(btn, slot, async () => {
    await api('POST', '/login', { login: login.value, password: password.value });
    await start();
  });
  root.replaceChildren(form);
  login.focus();
}

function shell(content) {
  const tabs = [['bookings', 'Записи'], ['schedule', 'График']];
  if (state.user.role === 'admin') tabs.push(['services', 'Услуги'], ['masters', 'Мастера']);
  tabs.push(['settings', 'Настройки']);
  root.replaceChildren(
    h('header', { class: 'top' },
      h('span', { class: 'top-name' }, `${state.studio.name} · ${state.user.name}`),
      h('button', {
        class: 'btn btn-small',
        onclick: async () => {
          await api('POST', '/logout');
          state.user = null;
          renderLogin();
        },
      }, 'Выйти')),
    h('nav', { class: 'tabs', 'aria-label': 'Разделы' }, tabs.map(([id, label]) => h('button', {
      'aria-current': state.tab === id ? 'page' : null,
      onclick: () => {
        state.tab = id;
        render();
      },
    }, label))),
    h('main', {}, content),
  );
}

const loadMeta = async () => {
  state.meta = await api('GET', '/meta');
};
const mastersThatWork = () => state.meta.masters.filter((m) => m.active && m.takes_bookings);

function masterPicker(onchange, { all = false } = {}) {
  const select = h('select', { onchange: () => onchange(Number(select.value)) },
    all ? h('option', { value: '0' }, 'Все мастера') : null,
    mastersThatWork().map((m) => h('option', { value: String(m.id) }, m.name)));
  select.value = String(state.masterId);
  return field('Мастер', select);
}

async function renderBookings() {
  await loadMeta();
  const isAdmin = state.user.role === 'admin';
  if (!isAdmin) state.masterId = state.user.id;
  const query = `/bookings?from=${state.from}&days=7${isAdmin && state.masterId ? `&master_id=${state.masterId}` : ''}`;
  const { bookings } = await api('GET', query);
  const slot = statusSlot();
  const byDay = {};
  for (const b of bookings) (byDay[b.start_at.slice(0, 10)] ??= []).push(b);
  const list = Object.keys(byDay).sort().map((day) => h('section', { class: 'card' },
    h('h2', {}, dayText(day)),
    byDay[day].map((b) => {
      const cancel = h('button', { class: 'btn btn-small btn-danger' }, 'Отменить');
      cancel.onclick = act(cancel, slot, async () => {
        if (!confirm(`Отменить запись: ${b.client}, ${b.start_at.slice(11)}?`)) return;
        const r = await api('POST', `/bookings/${b.id}/cancel`);
        await renderBookings();
        if (r.client_notified) alert('Клиенту ушло сообщение об отмене в Telegram.');
        else alert('Запись отменена. Клиенту сообщение не отправлено: предупредите его сами.');
      });
      return h('article', { class: 'booking' },
        h('div', { class: 'row between' },
          h('span', { class: 'booking-time' }, `${b.start_at.slice(11)}–${b.end_at.slice(11)}`),
          isAdmin ? h('span', { class: 'muted' }, b.master) : null),
        h('span', {}, b.service),
        h('span', {}, `${b.client}, `, h('a', { href: `tel:${b.phone}` }, b.phone)),
        b.note ? h('span', { class: 'muted' }, b.note) : null,
        h('div', { class: 'row between' }, h('span', { class: 'muted' }, { telegram: 'Из Telegram', site: 'С сайта', cabinet: 'Добавлена в кабинете' }[b.source]), cancel));
    })));

  const go = (n) => {
    state.from = n ? addDays(state.from, n) : state.today;
    renderBookings();
  };
  shell([
    h('div', { class: 'row between' },
      h('button', { class: 'btn btn-small', onclick: () => go(-7), 'aria-label': 'Предыдущая неделя' }, '‹ Неделя'),
      h('button', { class: 'btn btn-small', onclick: () => go(0) }, 'Сегодня'),
      h('button', { class: 'btn btn-small', onclick: () => go(7), 'aria-label': 'Следующая неделя' }, 'Неделя ›')),
    h('p', { class: 'muted' }, `${dayText(state.from)} — ${dayText(addDays(state.from, 6))}`),
    isAdmin ? masterPicker((v) => {
      state.masterId = v;
      renderBookings();
    }, { all: true }) : null,
    slot,
    list.length ? list : h('section', { class: 'card' }, h('p', { class: 'muted' }, 'На эту неделю записей нет.')),
    addBookingForm(),
  ]);
}

function addBookingForm() {
  const isAdmin = state.user.role === 'admin';
  const masters = isAdmin ? mastersThatWork() : [state.user];
  const master = h('select', {}, masters.map((m) => h('option', { value: String(m.id) }, m.name)));
  if (state.masterId) master.value = String(state.masterId);
  const service = h('select', {});
  const fillServices = () => {
    const own = state.meta.masters.find((m) => m.id === Number(master.value))?.service_ids ?? [];
    service.replaceChildren(...state.meta.services.filter((s) => s.active && own.includes(s.id)).map((s) => h('option', { value: String(s.id) }, `${s.name} · ${rubles(s)}`)));
  };
  master.onchange = fillServices;
  fillServices();
  const date = h('input', { type: 'date', value: state.today, min: state.today, required: true });
  const time = h('input', { type: 'time', value: '10:00', step: 300, required: true });
  const name = h('input', { required: true, autocomplete: 'off', maxLength: 60 });
  const phone = h('input', { type: 'tel', required: true, autocomplete: 'off', placeholder: '+7 900 123-45-67' });
  const slot = statusSlot();
  const btn = h('button', { class: 'btn btn-main', type: 'submit' }, 'Добавить запись');
  const form = h('form', { class: 'card' },
    h('h2', {}, 'Добавить запись вручную'),
    h('p', { class: 'muted' }, 'Для клиентов, которые позвонили или написали. Можно записать и вне рабочих часов, если время свободно.'),
    isAdmin ? field('Мастер', master) : null,
    field('Услуга', service),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, field('Дата', date)), h('div', { class: 'grow' }, field('Время', time))),
    field('Имя клиента', name), field('Телефон', phone), slot, btn);
  form.onsubmit = act(btn, slot, async () => {
    await api('POST', '/bookings', { master_id: Number(master.value), service_id: Number(service.value), date: date.value, time: time.value, client_name: name.value, client_phone: phone.value });
    state.from = date.value;
    await renderBookings();
  });
  return form;
}

async function renderSchedule() {
  await loadMeta();
  const isAdmin = state.user.role === 'admin';
  const working = mastersThatWork();
  if (!isAdmin) state.masterId = state.user.id;
  else if (!working.some((m) => m.id === state.masterId)) state.masterId = working[0]?.id ?? 0;
  if (!state.masterId) {
    shell(h('section', { class: 'card' }, h('p', {}, 'Сначала добавьте мастера.')));
    return;
  }
  const data = await api('GET', `/masters/${state.masterId}/schedule`);
  shell(scheduleView(data, isAdmin));
}

function scheduleView(data, isAdmin) {
  const id = state.masterId;
  const notice = statusSlot();
  const redraw = async (result) => {
    await renderSchedule();
    const warn = conflictsNotice(result.conflicts);
    if (warn) {
      document.querySelector('main').prepend(warn);
      scrollTo(0, 0);
    }
  };

  const rows = WEEKDAYS.map((label, weekdayIndex) => {
    const cur = data.week.find((d) => d.weekday === weekdayIndex);
    const on = h('input', { type: 'checkbox', checked: !!cur });
    const start = h('input', { type: 'time', value: cur?.start ?? '10:00', disabled: !cur, 'aria-label': `${label}: начало` });
    const end = h('input', { type: 'time', value: cur?.end ?? '20:00', disabled: !cur, 'aria-label': `${label}: конец` });
    on.onchange = () => {
      start.disabled = !on.checked;
      end.disabled = !on.checked;
    };
    return { el: h('div', { class: 'week-row' }, h('label', { class: 'check' }, on, label), start, end), value: () => (on.checked ? { weekday: weekdayIndex, start: start.value, end: end.value } : null) };
  });
  const saveWeek = h('button', { class: 'btn btn-main', type: 'submit' }, 'Сохранить неделю');
  const weekForm = h('form', { class: 'card' },
    h('h2', {}, 'Обычная неделя'), h('p', { class: 'muted' }, 'Снимите галочку, если день выходной.'),
    h('div', { class: 'week' }, rows.map((r) => r.el)), notice, saveWeek);
  weekForm.onsubmit = act(saveWeek, notice, async () => {
    const result = await api('PUT', `/masters/${id}/week`, { week: rows.map((r) => r.value()).filter(Boolean) });
    await redraw(result);
  });

  // One date that differs from the usual week.
  const oDate = h('input', { type: 'date', value: state.today, min: state.today, required: true });
  const oOff = h('input', { type: 'checkbox', checked: true });
  const oStart = h('input', { type: 'time', value: '10:00', disabled: true });
  const oEnd = h('input', { type: 'time', value: '20:00', disabled: true });
  oOff.onchange = () => {
    oStart.disabled = oOff.checked;
    oEnd.disabled = oOff.checked;
  };
  const oSlot = statusSlot();
  const oBtn = h('button', { class: 'btn', type: 'submit' }, 'Сохранить день');
  const oForm = h('form', { class: 'card' },
    h('h2', {}, 'Отдельный день'), h('p', { class: 'muted' }, 'Выходной или другие часы в конкретную дату.'),
    field('Дата', oDate), h('label', { class: 'check' }, oOff, 'Выходной'),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, field('С', oStart)), h('div', { class: 'grow' }, field('До', oEnd))),
    oSlot, oBtn,
    data.overrides.length ? h('ul', { class: 'list' }, data.overrides.map((o) => h('li', {},
      h('span', {}, `${dayText(o.date)}: ${o.start ? `${o.start}–${o.end}` : 'выходной'}`),
      removeButton(oSlot, async () => redraw(await api('DELETE', `/masters/${id}/overrides/${o.date}`, {})))))) : null);
  oForm.onsubmit = act(oBtn, oSlot, async () => {
    const result = await api('PUT', `/masters/${id}/overrides/${oDate.value}`, oOff.checked ? { off: true } : { start: oStart.value, end: oEnd.value });
    await redraw(result);
  });

  // Closed hours inside a working day.
  const bDate = h('input', { type: 'date', value: state.today, min: state.today, required: true });
  const bStart = h('input', { type: 'time', value: '13:00', required: true });
  const bEnd = h('input', { type: 'time', value: '14:00', required: true });
  const bNote = h('input', { maxLength: 100 });
  const bSlot = statusSlot();
  const bBtn = h('button', { class: 'btn', type: 'submit' }, 'Закрыть время');
  const bForm = h('form', { class: 'card' },
    h('h2', {}, 'Закрыть часы'), h('p', { class: 'muted' }, 'Перерыв или личные дела: клиенты не смогут записаться на это время.'),
    field('Дата', bDate),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, field('С', bStart)), h('div', { class: 'grow' }, field('До', bEnd))),
    field('Заметка для себя, необязательно', bNote), bSlot, bBtn,
    data.blocks.length ? h('ul', { class: 'list' }, data.blocks.map((b) => h('li', {},
      h('span', {}, `${dayText(b.start_at.slice(0, 10))}, ${b.start_at.slice(11)}–${b.end_at.slice(11)}${b.note ? `: ${b.note}` : ''}`),
      removeButton(bSlot, async () => redraw(await api('DELETE', `/blocks/${b.id}`, {})))))) : null);
  bForm.onsubmit = act(bBtn, bSlot, async () => {
    const result = await api('POST', `/masters/${id}/blocks`, { date: bDate.value, start: bStart.value, end: bEnd.value, note: bNote.value });
    await redraw(result);
  });

  return [
    isAdmin ? masterPicker((v) => {
      state.masterId = v;
      renderSchedule();
    }) : null,
    weekForm, oForm, bForm,
  ];
}

function removeButton(slot, fn) {
  const btn = h('button', { class: 'btn btn-small', type: 'button', 'aria-label': 'Убрать' }, 'Убрать');
  btn.onclick = act(btn, slot, fn);
  return btn;
}

async function renderServices() {
  await loadMeta();
  const editors = state.meta.services.map((s) => {
    const name = h('input', { value: s.name, required: true, maxLength: 80 });
    const minutes = h('input', { type: 'number', inputMode: 'numeric', value: String(s.minutes), min: 15, max: 720, step: 5, required: true });
    const price = h('input', { type: 'number', inputMode: 'numeric', value: String(s.price), min: 0, required: true });
    const from = h('input', { type: 'checkbox', checked: !!s.price_from });
    const active = h('input', { type: 'checkbox', checked: !!s.active });
    const slot = statusSlot();
    const btn = h('button', { class: 'btn', type: 'submit' }, 'Сохранить');
    const form = h('form', { class: 'card' },
      field('Название', name),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, field('Цена, ₽', price)), h('div', { class: 'grow' }, field('Минут', minutes))),
      h('label', { class: 'check' }, from, 'Показывать «от»'),
      h('label', { class: 'check' }, active, 'Показывать клиентам'),
      slot, btn);
    form.onsubmit = act(btn, slot, async () => {
      await api('PATCH', `/services/${s.id}`, { name: name.value, minutes: Number(minutes.value), price: Number(price.value), price_from: from.checked, active: active.checked });
      slot.show('ok', 'Сохранено');
    });
    return form;
  });

  const name = h('input', { required: true, maxLength: 80 });
  const minutes = h('input', { type: 'number', inputMode: 'numeric', value: '60', min: 15, max: 720, step: 5, required: true });
  const price = h('input', { type: 'number', inputMode: 'numeric', min: 0, required: true });
  const from = h('input', { type: 'checkbox' });
  const slot = statusSlot();
  const btn = h('button', { class: 'btn btn-main', type: 'submit' }, 'Добавить услугу');
  const add = h('form', { class: 'card' },
    h('h2', {}, 'Новая услуга'),
    h('p', { class: 'muted' }, 'Потом отметьте её у мастеров в разделе «Мастера», иначе клиенты её не увидят.'),
    field('Название', name),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, field('Цена, ₽', price)), h('div', { class: 'grow' }, field('Минут', minutes))),
    h('label', { class: 'check' }, from, 'Показывать «от»'), slot, btn);
  add.onsubmit = act(btn, slot, async () => {
    await api('POST', '/services', { name: name.value, minutes: Number(minutes.value), price: Number(price.value), price_from: from.checked });
    await renderServices();
  });
  shell([add, ...editors]);
}

function serviceChecks(selected) {
  const boxes = state.meta.services.filter((s) => s.active).map((s) => ({ id: s.id, el: h('input', { type: 'checkbox', checked: selected.includes(s.id) }), name: s.name }));
  return {
    el: h('div', { class: 'chips' }, boxes.map((b) => h('label', { class: 'check' }, b.el, b.name))),
    value: () => boxes.filter((b) => b.el.checked).map((b) => b.id),
  };
}

async function renderMasters() {
  await loadMeta();
  const cards = state.meta.masters.map((m) => {
    const name = h('input', { value: m.name, required: true, maxLength: 60 });
    const checks = serviceChecks(m.service_ids);
    const takes = h('input', { type: 'checkbox', checked: m.takes_bookings });
    const active = h('input', { type: 'checkbox', checked: m.active, disabled: m.id === state.user.id });
    const slot = statusSlot();
    const save = h('button', { class: 'btn', type: 'submit' }, 'Сохранить');
    const reset = h('button', { class: 'btn', type: 'button' }, 'Новый пароль');
    const secret = h('div', {});
    reset.onclick = act(reset, slot, async () => {
      if (!confirm(`Выдать новый пароль: ${m.name}? Старый перестанет работать.`)) return;
      const r = await api('POST', `/masters/${m.id}/reset-password`);
      secret.replaceChildren(passwordNotice(m.login, r.password));
    });
    const form = h('form', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', {}, m.name), h('span', { class: 'muted' }, m.role === 'admin' ? 'Администратор' : 'Мастер')),
      h('p', { class: 'muted' }, `Логин: ${m.login}. Telegram ${m.telegram_linked ? 'подключён' : 'не подключён'}.`),
      field('Имя', name),
      h('h3', {}, 'Услуги'), checks.el,
      h('label', { class: 'check' }, takes, 'Принимает клиентов'),
      h('label', { class: 'check' }, active, 'Доступ к кабинету'),
      slot, secret, h('div', { class: 'row' }, save, reset));
    form.onsubmit = act(save, slot, async () => {
      await api('PATCH', `/masters/${m.id}`, { name: name.value, service_ids: checks.value(), takes_bookings: takes.checked, active: active.checked });
      slot.show('ok', 'Сохранено');
    });
    return form;
  });

  const name = h('input', { required: true, maxLength: 60 });
  const login = h('input', { required: true, autocapitalize: 'none', autocomplete: 'off', placeholder: 'например, anna' });
  const checks = serviceChecks([]);
  const slot = statusSlot();
  const btn = h('button', { class: 'btn btn-main', type: 'submit' }, 'Добавить мастера');
  const secret = h('div', {});
  const add = h('form', { class: 'card' },
    h('h2', {}, 'Новый мастер'), field('Имя', name), field('Логин для входа', login), h('h3', {}, 'Услуги'), checks.el, slot, secret, btn);
  add.onsubmit = act(btn, slot, async () => {
    const r = await api('POST', '/masters', { name: name.value, login: login.value, service_ids: checks.value() });
    const typed = login.value.trim().toLowerCase();
    await renderMasters();
    document.querySelector('main').prepend(h('section', { class: 'card' }, h('h2', {}, 'Мастер добавлен. Настройте ему график.'), passwordNotice(typed, r.password)));
  });
  shell([add, ...cards]);
}

function passwordNotice(login, password) {
  return h('div', { class: 'chips' },
    h('p', { class: 'muted' }, 'Передайте эти данные мастеру. Пароль показывается один раз.'),
    h('p', { class: 'secret' }, `Логин: ${login} · Пароль: ${password}`));
}

async function renderSettings() {
  await loadMeta();
  const me = state.meta.masters.find((m) => m.id === state.user.id);
  const tgSlot = statusSlot();
  const tgBtn = h('button', { class: 'btn', type: 'button' }, me.telegram_linked ? 'Подключить другой Telegram' : 'Получить ссылку');
  const linkBox = h('div', {});
  tgBtn.onclick = act(tgBtn, tgSlot, async () => {
    const { url } = await api('POST', '/me/telegram-link');
    linkBox.replaceChildren(h('a', { class: 'btn btn-main', href: url, target: '_blank', rel: 'noopener' }, 'Открыть бота и нажать «Запустить»'));
  });

  const current = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', autocomplete: 'new-password', minLength: 8, required: true });
  const slot = statusSlot();
  const btn = h('button', { class: 'btn btn-main', type: 'submit' }, 'Сменить пароль');
  const form = h('form', { class: 'card' }, h('h2', {}, 'Пароль'), field('Текущий пароль', current), field('Новый пароль, от 8 символов', next), slot, btn);
  form.onsubmit = act(btn, slot, async () => {
    await api('POST', '/me/password', { current: current.value, next: next.value });
    current.value = '';
    next.value = '';
    slot.show('ok', 'Пароль изменён');
  });
  shell([
    h('section', { class: 'card' },
      h('h2', {}, 'Уведомления в Telegram'),
      h('p', { class: 'muted' }, me.telegram_linked ? 'Подключены: новые записи и отмены приходят вам в Telegram.' : 'Подключите, чтобы получать новые записи и отмены в Telegram.'),
      tgSlot, tgBtn, linkBox),
    form,
  ]);
}

function render() {
  const views = { bookings: renderBookings, schedule: renderSchedule, services: renderServices, masters: renderMasters, settings: renderSettings };
  views[state.tab]().catch((e) => {
    if (state.user) shell(h('section', { class: 'card' }, message('error', e.message)));
  });
}

async function start() {
  const me = await api('GET', '/me');
  state.user = me.user;
  state.studio = me.studio;
  state.today = me.today;
  state.from = me.today;
  state.masterId = me.user.role === 'admin' ? 0 : me.user.id;
  render();
}

start().catch(() => {
  if (!state.user) renderLogin();
});
