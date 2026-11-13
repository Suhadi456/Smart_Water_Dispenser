'use strict';
// Dashboard tunggal: polling REST API Express (~10 dtk). Tidak ada koneksi langsung ke broker MQTT.
const $ = (s) => document.querySelector(s);
const POLL_MS = 1000; // polling setiap 1 detik agar pembaruan instan
const CHART_REFRESH_MS = 30000;
const GAP_MS = 2.5 * 3600e3; // lebih dari ini tanpa data -> garis diputus (tidak diinterpolasi)

const STATUS = {
  NORMAL: { cls: 's-ok', icon: 'i-check' },
  RENDAH: { cls: 's-warn', icon: 'i-low' },
  KRITIS: { cls: 's-crit', icon: 'i-crit' },
  HABIS: { cls: 's-empty', icon: 'i-empty' },
};
const STATE_VIEW = {
  TARE_REQUIRED: { text: 'BUTUH TARE', cls: 's-warn', icon: 'i-tare' },
  TARE_IN_PROGRESS: { text: 'MEMPROSES TARE', cls: 's-none', icon: 'i-tare' },
  TARE_FAILED: { text: 'TARE GAGAL', cls: 's-crit', icon: 'i-crit' },
  SENSOR_ERROR: { text: 'SENSOR ERROR', cls: 's-crit', icon: 'i-crit' },
};

const ui = { range: '24h', capDirty: false, thrDirty: false, last: null };

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function setPill(el, cls, icon, text) {
  el.className = `pill ${cls}`;
  el.querySelector('use').setAttribute('href', '#' + icon);
  el.querySelector('span').textContent = text;
}
function setBadge(el, cls, icon, text) {
  el.className = `badge ${cls}`;
  el.querySelector('use').setAttribute('href', '#' + icon);
  el.querySelector('span').textContent = text;
}
const ageText = (iso, now) => {
  if (!iso) return 'belum ada data';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s} dtk lalu` : s < 3600 ? `${Math.floor(s / 60)} mnt lalu` : `${Math.floor(s / 3600)} jam lalu`;
};
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 5000);
}

function notice(kind, text, busy = false) {
  const n = $('#notice');
  n.hidden = !text;
  if (!text) return;
  n.className = `notice ${kind}`;
  n.replaceChildren();
  if (busy) {
    const sp = document.createElement('span');
    sp.className = 'spinner';
    sp.setAttribute('aria-hidden', 'true');
    n.append(sp);
  }
  const p = document.createElement('span');
  p.textContent = text;
  n.append(p);
}

function render(m) {
  ui.last = m;
  const now = new Date(m.server_time).getTime();
  $('#devCode').textContent = m.device_code;
  $('#banner').hidden = true;

  const online = m.connection === 'ONLINE';
  setBadge($('#conn'), online ? 'b-on' : 'b-crit', online ? 'i-wifi' : 'i-wifi-off', online ? 'ONLINE' : 'OFFLINE');
  setBadge($('#fresh'), m.data_fresh ? 'b-on' : 'b-warn', 'i-clock',
    m.data_fresh ? `Data segar · ${ageText(m.last_raw_at, now)}` : `Data lama · ${ageText(m.last_raw_at, now)}`);

  const ds = m.device_state;
  const hasValue = ds === 'READY' && m.volume_liter != null;
  const stale = hasValue && (!m.data_fresh || !online);
  document.querySelectorAll('.card').forEach((c) => c.classList.toggle('stale', stale));
  $('#staleVol').hidden = !stale;
  $('#vol').textContent = hasValue ? m.volume_liter.toFixed(2) : '--';
  $('#pct').textContent = hasValue ? String(Math.round(m.percentage)) : '--';
  $('#pctBar').style.width = hasValue ? `${m.percentage}%` : '0%';
  $('#cap').textContent = m.capacity_liter;
  $('#updated').textContent = m.latest_at ? new Date(m.latest_at).toLocaleString('id-ID') : '—';

  if (hasValue && STATUS[m.water_status]) {
    setPill($('#status'), STATUS[m.water_status].cls, STATUS[m.water_status].icon, m.water_status + (stale ? ' (data lama)' : ''));
  } else if (STATE_VIEW[ds]) {
    setPill($('#status'), STATE_VIEW[ds].cls, STATE_VIEW[ds].icon, STATE_VIEW[ds].text);
  } else {
    setPill($('#status'), 's-none', 'i-info', '--');
  }

  // Aturan UX Bab 6.6
  if (ds === 'TARE_REQUIRED') {
    notice('', 'Butuh tare. Letakkan galon baru yang benar-benar kosong di timbangan, lalu tekan TARE GALON KOSONG. Status air belum ditampilkan.');
  } else if (ds === 'TARE_IN_PROGRESS') {
    notice('n-info', 'Tare sedang diproses perangkat. Menunggu konfirmasi (ACK) dari ESP32…', true);
  } else if (ds === 'TARE_FAILED') {
    notice('n-crit', `Tare gagal: ${m.tare_message || 'penyebab tidak diketahui'}. Volume sementara tidak valid; tekan TARE GALON KOSONG untuk mencoba lagi.`);
  } else if (ds === 'SENSOR_ERROR') {
    notice('n-crit', 'Sensor berat bermasalah atau pembacaan di luar batas wajar. Ini BUKAN berarti air habis.');
  } else if (!online) {
    notice('', 'Perangkat OFFLINE. Nilai yang tampil adalah data terakhir, bukan kondisi saat ini.');
  } else if (!m.data_fresh) {
    notice('', 'Data tidak terkini. Nilai yang tampil adalah pembacaan lama.');
  } else {
    notice('', '');
  }

  setPill($('#tareBadge'), ...(m.tare_state === 'READY' ? ['s-ok', 'i-check', 'READY']
    : [STATE_VIEW[m.tare_state].cls, STATE_VIEW[m.tare_state].icon, STATE_VIEW[m.tare_state].text]));
  const msg = $('#tareMsg');
  msg.hidden = !(m.tare_state === 'TARE_FAILED' && m.tare_message);
  msg.textContent = m.tare_message || '';
  $('#tareBtn').disabled = m.tare_state === 'TARE_IN_PROGRESS';

  // Jangan menimpa isian yang sedang diedit pengguna.
  if (!ui.capDirty) document.querySelectorAll('input[name=cap]').forEach((r) => (r.checked = Number(r.value) === m.capacity_liter));
  if (!ui.thrDirty) {
    $('#thH').value = m.threshold_habis_pct;
    $('#thK').value = m.threshold_kritis_pct;
    $('#thR').value = m.threshold_rendah_pct;
  }
}

function showOffline(err) {
  const b = $('#banner');
  b.textContent = `Tidak dapat menghubungi server/database: ${err.message}. Menampilkan data terakhir yang diterima.`;
  b.hidden = false;
  setBadge($('#conn'), 'b-crit', 'i-wifi-off', 'SERVER TIDAK TERJANGKAU');
  document.querySelectorAll('.card').forEach((c) => c.classList.add('stale'));
}

async function refresh() {
  try {
    render(await api('/monitoring'));
  } catch (e) {
    showOffline(e);
  }
}

// ---- Grafik (SVG): titik pada timestamp asli, garis putus pada celah, kapasitas sebagai garis tangga ----
const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}, text) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
};

async function drawChart() {
  const svg = $('#chart');
  let data;
  try {
    data = await api('/readings?range=' + ui.range);
  } catch (e) {
    return;
  }
  const rows = data.readings.map((r) => ({ ...r, t: new Date(r.recorded_at).getTime() }));
  svg.replaceChildren();
  $('#chartEmpty').hidden = rows.length > 0;
  if (!rows.length) return;

  const W = 640, H = 260, L = 44, R = 12, T = 12, B = 30;
  const span = ui.range === '7d' ? 7 * 24 * 3600e3 : 24 * 3600e3;
  const t1 = Date.now(), t0 = t1 - span;
  const maxCap = Math.max(5, ...rows.map((r) => r.capacity_liter));
  const x = (t) => L + ((t - t0) / span) * (W - L - R);
  const y = (v) => T + (1 - v / maxCap) * (H - T - B);

  for (let v = 0; v <= maxCap; v += maxCap / 5) {
    svg.append(el('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: 'var(--chart-grid)' }));
    svg.append(el('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, v.toFixed(v % 1 ? 1 : 0)));
  }
  const ticks = ui.range === '7d' ? 7 : 6;
  for (let i = 0; i <= ticks; i++) {
    const t = t0 + (span * i) / ticks;
    const d = new Date(t);
    const label = ui.range === '7d' ? d.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric' })
      : d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    svg.append(el('text', { x: x(t), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === ticks ? 'end' : 'middle' }, label));
  }

  // kapasitas (garis tangga, putus-putus)
  let cap = `M${x(Math.max(rows[0].t, t0))},${y(rows[0].capacity_liter)}`;
  rows.forEach((r, i) => { if (i) cap += `H${x(r.t)}V${y(r.capacity_liter)}`; });
  cap += `H${x(t1)}`;
  svg.append(el('path', { d: cap, fill: 'none', stroke: 'var(--chart-cap)', 'stroke-width': 2, 'stroke-dasharray': '5 4' }));

  // volume: segmen dipisah bila ada celah besar
  let path = '';
  rows.forEach((r, i) => {
    const gap = i === 0 || r.t - rows[i - 1].t > GAP_MS;
    path += `${gap ? 'M' : 'L'}${x(r.t).toFixed(1)},${y(r.volume_liter).toFixed(1)}`;
  });
  svg.append(el('path', { d: path, fill: 'none', stroke: 'var(--chart-line)', 'stroke-width': 2.5, 'stroke-linejoin': 'round' }));
  for (const r of rows) {
    const c = el('circle', { cx: x(r.t), cy: y(r.volume_liter), r: 3.5, fill: 'var(--chart-line)' });
    c.append(el('title', {}, `${new Date(r.t).toLocaleString('id-ID')}\n${r.volume_liter.toFixed(2)} L (${r.percentage}%) dari kapasitas ${r.capacity_liter} L\n${r.water_status || ''} · ${r.record_reason}`));
    svg.append(c);
  }
  const last = rows[rows.length - 1];
  svg.setAttribute('aria-label',
    `Grafik volume air ${ui.range === '7d' ? '7 hari' : '24 jam'} terakhir, ${rows.length} titik. Terakhir ${last.volume_liter.toFixed(2)} liter dari ${last.capacity_liter} liter.`);
}

document.querySelectorAll('.seg button').forEach((b) =>
  b.addEventListener('click', () => {
    ui.range = b.dataset.range;
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    drawChart();
  }));

// ---- Form ----
document.querySelectorAll('input[name=cap]').forEach((r) => r.addEventListener('change', () => (ui.capDirty = true)));
['#thH', '#thK', '#thR'].forEach((s) => $(s).addEventListener('input', () => { ui.thrDirty = true; $(s).removeAttribute('aria-invalid'); }));

async function mutate(btn, fn, okMsg) {
  btn.disabled = true;
  try {
    await fn();
    toast(okMsg);
    await refresh();
    drawChart();
  } catch (e) {
    toast(`Gagal: ${e.message}`);
    throw e;
  } finally {
    btn.disabled = btn === $('#tareBtn') && ui.last?.tare_state === 'TARE_IN_PROGRESS';
  }
}

$('#capForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const v = Number(document.querySelector('input[name=cap]:checked')?.value);
  if (!v || v === ui.last?.capacity_liter) return toast('Kapasitas tidak berubah.');
  if (!confirm(`Ganti kapasitas ke ${v} L? Status air dihentikan sampai Anda melakukan tare ulang dengan galon kosong.`)) return;
  await mutate($('#capBtn'), () => api('/device', { method: 'PATCH', body: { capacity_liter: v } }), `Kapasitas ${v} L diterapkan. Lakukan tare.`)
    .then(() => (ui.capDirty = false), () => {});
});

$('#thrForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const h = Number($('#thH').value), k = Number($('#thK').value), r = Number($('#thR').value);
  const err = $('#thrErr');
  const ok = [h, k, r].every(Number.isInteger) && h >= 0 && h < k && k < r && r < 100;
  err.hidden = ok;
  ['#thH', '#thK', '#thR'].forEach((s) => (ok ? $(s).removeAttribute('aria-invalid') : $(s).setAttribute('aria-invalid', 'true')));
  if (!ok) { err.textContent = 'Isi bilangan bulat dengan urutan 0 ≤ HABIS < KRITIS < RENDAH < 100.'; return; }
  await mutate($('#thrBtn'), () => api('/device', { method: 'PATCH', body: { threshold_habis_pct: h, threshold_kritis_pct: k, threshold_rendah_pct: r } }), 'Batas status disimpan.')
    .then(() => (ui.thrDirty = false), () => {});
});

const dlg = $('#tareDlg');
$('#tareBtn').addEventListener('click', () => { $('#tareChk').checked = false; $('#tareOk').disabled = true; dlg.showModal(); });
$('#tareChk').addEventListener('change', (e) => ($('#tareOk').disabled = !e.target.checked));
$('#tareCancel').addEventListener('click', () => dlg.close());
$('#tareDlgForm').addEventListener('submit', async () => {
  await mutate($('#tareBtn'), () => api('/tare', { method: 'POST', body: { confirm_empty: true } }), 'Perintah tare dikirim ke perangkat.').catch(() => {});
});

refresh();
drawChart();
setInterval(refresh, POLL_MS);
setInterval(drawChart, CHART_REFRESH_MS);
