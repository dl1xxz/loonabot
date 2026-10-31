// Loona, Anapa. Address, phone and hours are from the 2GIS card (firm 70000001079092101).
// The services, prices, durations and masters below are samples until the studio sends its own list:
// 2GIS shows only the directions (brows and lashes, make-up, nails). All of it is editable in the cabinet.
export const studio = {
  name: 'Loona',
  address: 'Анапа, Анапское шоссе, 32 к5, 1 этаж',
  hours: 'Ежедневно с 10:00 до 22:00',
  phone: '+7 950 589-51-53',
  utcOffsetMin: 180,
  privacyUrl: '',
};

export const services = [
  { key: 'gel', name: 'Маникюр с гель-лаком', minutes: 120, price: 2000 },
  { key: 'extend', name: 'Наращивание ногтей', minutes: 180, price: 3000, from: true },
  { key: 'brows', name: 'Оформление бровей', minutes: 60, price: 1000 },
  { key: 'lashes', name: 'Наращивание ресниц', minutes: 120, price: 2500, from: true },
  { key: 'makeup', name: 'Макияж', minutes: 90, price: 3000, from: true },
];

const daily = { weekdays: [0, 1, 2, 3, 4, 5, 6], start: '10:00', end: '22:00' };

export const masters = [
  { name: 'Светлана', login: 'admin', role: 'admin', takesBookings: false },
  { name: 'Мастер ногтей', login: 'nails', role: 'master', services: ['gel', 'extend'], ...daily },
  { name: 'Мастер бровей и ресниц', login: 'brows', role: 'master', services: ['brows', 'lashes', 'makeup'], ...daily },
];
