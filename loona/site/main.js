// A nail master's page: reveals, the photo viewer and the booking form. The form sends a ready message to the
// master's WhatsApp. Free times are a demo here: busy slots are derived from the date, so they stay put between
// visits; a Telegram bot takes over from this once the master connects it.
(() => {
  const M = window.MASTER;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const rub = (n) => `${n.toLocaleString('ru-RU')} ₽`;

  // ---------- Reveals ----------
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches && 'IntersectionObserver' in window) {
    document.documentElement.classList.add('js');
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          e.target.classList.add('is-in');
          io.unobserve(e.target);
        }),
      { rootMargin: '0px 0px -8% 0px' },
    );
    $$('[data-reveal]').forEach((el) => io.observe(el));
  }

  // ---------- Photo viewer ----------
  const dialog = $('[data-dialog]');
  const big = $('[data-big]');
  let opener = null;
  $$('[data-lightbox]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const img = $('img', btn);
      big.src = img.currentSrc || img.src;
      big.alt = img.alt;
      opener = btn;
      dialog.showModal();
    }),
  );
  $('[data-close]', dialog).addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => e.target === dialog && dialog.close());
  dialog.addEventListener('close', () => opener?.focus());

  // ---------- Booking dock: hidden while the form is on screen ----------
  const dock = $('[data-dock]');
  const form = $('[data-book]');
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => dock.classList.toggle('is-hidden', e.isIntersecting), { threshold: 0.05 }).observe(form);
  }

  // ---------- Real booking against booking/: prices, masters and free time all come from the shared calendar ----------
  if (M.api !== undefined) {
    const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
    const servicesEl = $('[data-services]');
    const mastersWrap = $('[data-masters-wrap]');
    const mastersEl = $('[data-masters]');
    const daysBox = $('[data-days]');
    const timesBox = $('[data-times]');
    const err = $('[data-err]');
    const callUs = `Позвоните нам: ${M.phone}`;
    let services = [];
    let serviceChosen = null;
    let masterId = 0;
    let dayChosen = null;
    let timeChosen = null;
    let daysAsked = 0;
    let timesAsked = 0;

    const call = async (path, options) => {
      const res = await fetch(`${M.api}/api/public${path}`, options);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error || `Не получилось. ${callUs}`), { status: res.status });
      return data;
    };
    const dateOf = (iso) => new Date(`${iso}T12:00:00Z`);
    const dayName = (iso) => dateOf(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
    const priceOf = (s) => `${s.price_from ? 'от ' : ''}${rub(s.price)}`;
    const show = (msg) => {
      err.textContent = msg;
      err.hidden = false;
    };
    const summary = () => {
      $('[data-what]').textContent = serviceChosen?.name ?? '';
      $('[data-when]').textContent = dayChosen ? `${dayName(dayChosen)}${timeChosen ? `, ${timeChosen}` : ', выберите время'}` : 'Выберите день и время';
      $('[data-total]').textContent = serviceChosen ? priceOf(serviceChosen) : '';
    };
    const radio = (cls, text, onPick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = text;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.addEventListener('click', onPick);
      return b;
    };
    const mark = (box, sel, chosen) => $$(sel, box).forEach((b) => b.setAttribute('aria-checked', String(b === chosen)));

    async function loadTimes(iso) {
      const asked = ++timesAsked;
      dayChosen = iso;
      timeChosen = null;
      timesBox.textContent = '';
      summary();
      const { slots } = await call(`/slots?service_id=${serviceChosen.id}&master_id=${masterId}&date=${iso}`);
      if (asked !== timesAsked) return;
      slots.forEach((t) => {
        const b = radio('time', t, () => {
          timeChosen = t;
          mark(timesBox, '.time', b);
          err.hidden = true;
          summary();
        });
        timesBox.append(b);
      });
      if (!slots.length) show('На этот день время уже разобрали. Выберите другой.');
    }

    async function loadDays() {
      const asked = ++daysAsked;
      daysBox.textContent = '';
      timesBox.textContent = '';
      dayChosen = null;
      timeChosen = null;
      summary();
      const { days } = await call(`/days?service_id=${serviceChosen.id}&master_id=${masterId}`);
      if (asked !== daysAsked) return; // another service was picked while this answer travelled
      days.forEach((iso, i) => {
        const b = radio('day', '', () => {
          mark(daysBox, '.day', b);
          err.hidden = true;
          loadTimes(iso).catch((e) => show(e.message));
        });
        b.setAttribute('aria-label', dayName(iso));
        const small = document.createElement('small');
        small.textContent = WEEKDAYS[dateOf(iso).getUTCDay()];
        const big = document.createElement('b');
        big.textContent = dateOf(iso).getUTCDate();
        b.append(small, big);
        daysBox.append(b);
        if (i === 0) b.click();
      });
      if (!days.length) show(`На ближайший месяц свободного времени нет. ${callUs}`);
    }

    function pickService(s) {
      serviceChosen = s;
      masterId = 0;
      mastersEl.textContent = '';
      mastersWrap.hidden = s.masters.length < 2;
      if (s.masters.length > 1) {
        [{ id: 0, name: 'Любой свободный' }, ...s.masters].forEach((m, i) => {
          const b = radio('time', m.name, () => {
            masterId = m.id;
            mark(mastersEl, '.time', b);
            loadDays().catch((e) => show(e.message));
          });
          mastersEl.append(b);
          if (i === 0) b.setAttribute('aria-checked', 'true');
        });
      }
      err.hidden = true;
      loadDays().catch((e) => show(e.message));
    }

    function drawServices() {
      servicesEl.textContent = '';
      services.forEach((s, i) => {
        const label = document.createElement('label');
        label.className = 'service';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'service';
        input.checked = i === 0;
        input.addEventListener('change', () => pickService(s));
        const name = document.createElement('span');
        name.className = 'service-name';
        name.textContent = s.name;
        const price = document.createElement('span');
        price.className = 'service-price';
        price.textContent = priceOf(s);
        label.append(input, name, price);
        servicesEl.append(label);
      });
      if (services[0]) pickService(services[0]);
      else show(`Онлайн-запись скоро откроется. ${callUs}`);
    }

    function showBooked(r) {
      const box = document.createElement('div');
      box.className = 'booked';
      box.setAttribute('role', 'status');
      const title = document.createElement('h3');
      title.textContent = 'Вы записаны!';
      const text = document.createElement('p');
      text.textContent = `${r.service}, мастер ${r.master}. ${r.when[0].toUpperCase()}${r.when.slice(1)}. ${r.address}.`;
      box.append(title, text);
      if (r.telegram_url) {
        const link = document.createElement('a');
        link.className = 'btn btn-block';
        link.href = r.telegram_url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'Получать напоминания в Telegram';
        box.append(link);
      }
      form.replaceChildren(box);
      box.scrollIntoView({ block: 'center' });
    }

    form.addEventListener('input', () => {
      err.hidden = true;
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = form.elements;
      if (!timeChosen) return show('Выберите день и время.');
      if (!f.name.value.trim()) return show('Напишите, как вас зовут.');
      if (f.phone.value.replace(/\D/g, '').length < 10) return show('Проверьте номер телефона.');
      if (!f.consent.checked) return show('Подтвердите согласие на обработку данных.');
      const btn = $('button[type="submit"]', form);
      btn.disabled = true;
      try {
        showBooked(await call('/bookings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            service_id: serviceChosen.id, master_id: masterId, date: dayChosen, time: timeChosen,
            name: f.name.value, phone: f.phone.value, consent: true, website: f.website.value,
          }),
        }));
      } catch (error) {
        btn.disabled = false;
        // The time was taken a moment ago: show what is still free, keeping the message visible.
        if (error.status === 409) await loadTimes(dayChosen).catch(() => {});
        show(error.message);
      }
    });

    call('/info')
      .then((info) => {
        services = info.services;
        drawServices();
      })
      .catch(() => show(`Онлайн-запись сейчас недоступна. ${callUs}`));
    return;
  }

  // ---------- Days and times ----------
  const WEEK = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const daysEl = $('[data-days]');
  const timesEl = $('[data-times]');
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 21 }, (_, i) => new Date(start.getTime() + (i + 1) * 864e5));
  const seed = (d, t) => (d.getDate() * 31 + d.getMonth() * 17 + t * 13) % 7;
  const isBusy = (d, i) => seed(d, i) < 3;
  let day = null;
  let time = null;

  const fmtDay = (d) => d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

  function pickTime(t) {
    time = t;
    $$('.time', timesEl).forEach((b) => b.setAttribute('aria-checked', String(b.textContent === t)));
    render();
  }
  function pickDay(d) {
    day = d;
    time = null;
    $$('.day', daysEl).forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.t) === d.getTime())));
    timesEl.innerHTML = '';
    M.slots.forEach((t, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'time';
      b.textContent = t;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.disabled = isBusy(d, i);
      b.addEventListener('click', () => pickTime(t));
      timesEl.append(b);
    });
    render();
  }
  days.forEach((d) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'day';
    b.dataset.t = d.getTime();
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');
    b.setAttribute('aria-label', fmtDay(d));
    b.innerHTML = `<small>${WEEK[d.getDay()]}</small><b>${d.getDate()}</b>`;
    b.disabled = M.daysOff.includes(d.getDay());
    b.addEventListener('click', () => pickDay(d));
    daysEl.append(b);
  });

  // ---------- Sum ----------
  const service = () => M.services.find((s) => s.id === form.elements.service.value);
  const addons = () => $$('[name="addon"]:checked', form).map((el) => M.addons.find((a) => a.id === el.value));

  function render() {
    const s = service();
    const a = addons();
    $('[data-what]').textContent = [s.name, ...a.map((x) => x.name.toLowerCase())].join(' + ');
    $('[data-when]').textContent = day ? `${fmtDay(day)}${time ? `, ${time}` : ', выберите время'}` : 'Выберите день и время';
    const from = s.from || a.some((x) => x.from);
    $('[data-total]').textContent = s.price ? `${from ? 'от ' : ''}${rub(s.price + a.reduce((sum, x) => sum + x.price, 0))}` : s.priceLabel;
  }
  form.addEventListener('input', () => {
    $('[data-err]').hidden = true;
    $$('[aria-invalid]', form).forEach((el) => el.removeAttribute('aria-invalid'));
    render();
  });

  pickDay(days.find((d) => !M.daysOff.includes(d.getDay())));

  // ---------- Send ----------
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('[data-err]');
    const fail = (msg, el) => {
      err.textContent = msg;
      err.hidden = false;
      if (el) {
        el.setAttribute('aria-invalid', 'true');
        el.focus();
      }
    };
    if (!time) return fail('Выберите время.');
    const name = form.elements.name;
    const phone = form.elements.phone;
    if (!name.value.trim()) return fail('Напишите, как вас зовут.', name);
    if (phone.value.replace(/\D/g, '').length < 10) return fail('Проверьте номер телефона.', phone);
    const text = [
      `Здравствуйте, ${M.name.split(' ')[0]}! Хочу записаться.`,
      `Услуга: ${$('[data-what]').textContent}`,
      `Когда: ${fmtDay(day)}, ${time}`,
      `Предварительно: ${$('[data-total]').textContent}`,
      `Меня зовут ${name.value.trim()}, телефон ${phone.value.trim()}.`,
    ].join('\n');
    if (M.wa) {
      window.open(`https://wa.me/${M.wa}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
      return;
    }
    // A sample page has nowhere to send the request.
    if (!M.direct) {
      err.textContent = 'Это пример: на вашем сайте заявка придёт вам.';
      err.hidden = false;
      return;
    }
    // Instagram Direct takes no ready text: copy it and say so, then open the chat.
    navigator.clipboard?.writeText(text).catch(() => {});
    err.textContent = 'Текст заявки скопирован — вставьте его в сообщение мастеру.';
    err.hidden = false;
    window.open(M.direct, '_blank', 'noopener');
  });
})();
