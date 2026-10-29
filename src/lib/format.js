const nf = new Intl.NumberFormat('vi-VN');

function num(n) {
  return n === null || n === undefined || n === '' ? '' : nf.format(Number(n));
}

function money(n) {
  return n === null || n === undefined || n === '' ? '' : nf.format(Math.round(Number(n))) + ' ₫';
}

// '2026-10-29' hoặc '2026-10-29 10:20:30' -> '29/10/2026' / '29/10/2026 10:20'
function date(s) {
  if (!s) return '';
  const [d, t] = String(s).split(' ');
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}

function datetime(s) {
  if (!s) return '';
  const [d, t = ''] = String(s).split(' ');
  return `${date(d)} ${t.slice(0, 5)}`.trim();
}

function today() {
  const d = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

module.exports = { num, money, date, datetime, today };
