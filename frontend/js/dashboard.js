'use strict';
// Dashboard tunggal: polling REST API Express (1 dtk). Tidak ada koneksi langsung ke broker MQTT.
// Desain visual mengadaptasi komponen FluidMeter, Mesh Gradient, Multi-Unit Converter, dan Grade Badge
// dari referensi https://github.com/loty2019/water-dispenser-web (WaterHub).
const $ = (s) => document.querySelector(s);
const POLL_MS = 1000;
const CHART_REFRESH_MS = 30000;
const GAP_MS = 2.5 * 3600e3; // lebih dari ini tanpa data -> garis diputus (tidak diinterpolasi)

const STATUS = {
  NORMAL: { cls: 's-ok', icon: 'i-check', dot: 'var(--ok-dot)', act: 'LED: OFF · Buzzer: Mati' },
  RENDAH: { cls: 's-warn', icon: 'i-low', dot: 'var(--warn-dot)', act: 'LED: Kedip 1 dtk · Buzzer: 1x / 10 mnt' },
  KRITIS: { cls: 's-crit', icon: 'i-crit', dot: 'var(--crit-dot)', act: 'LED: Kedip 200 ms · Buzzer: 2x / 5 mnt' },
  HABIS:  { cls: 's-empty', icon: 'i-empty', dot: 'var(--empty-dot)', act: 'LED: ON Konstan · Buzzer: 3x / 2 mnt' },
};
const STATE_VIEW = {
  TARE_REQUIRED:    { text: 'BUTUH TARE', cls: 's-warn', icon: 'i-tare', act: 'LED: Standby · Buzzer: Dihentikan' },
  TARE_IN_PROGRESS: { text: 'MEMPROSES TARE', cls: 's-none', icon: 'i-tare', act: 'LED: Standby · Buzzer: Dihentikan' },
  TARE_FAILED:      { text: 'TARE GAGAL', cls: 's-crit', icon: 'i-crit', act: 'LED: Standby · Buzzer: Dihentikan' },
  SENSOR_ERROR:     { text: 'SENSOR ERROR', cls: 's-crit', icon: 'i-crit', act: 'LED: 3 Pulsa Cepat · Buzzer: Dihentikan' },
};

const ui = { range: '24h', unit: 'glasses', capDirty: false, thrDirty: false, last: null };

// ---- Animated Mesh Gradient Canvas (inspirasi Gradient.js WaterHub) ----
function initMeshCanvas() {
  const cvs = $('#gradient-canvas');
  if (!cvs || /jsdom/i.test(navigator.userAgent) || typeof cvs.getContext !== 'function') return () => {};
  let ctx = null;
  try { ctx = cvs.getContext('2d'); } catch { return () => {}; }
  if (!ctx) return () => {};

  let w = 0, h = 0, t = 0;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const readColors = () => {
    const cs = getComputedStyle(document.documentElement);
    return [1, 2, 3, 4].map((i) => cs.getPropertyValue(`--gradient-color-${i}`).trim() || '#6ec3f4');
  };
  let colors = readColors();
  const resize = () => {
    w = cvs.width = Math.max(320, Math.floor((window.innerWidth || 640) * 0.5));
    h = cvs.height = Math.max(240, Math.floor((window.innerHeight || 480) * 0.5));
  };
  resize();
  window.addEventListener('resize', resize);

  const drawFrame = () => {
    ctx.fillStyle = colors[0];
    ctx.fillRect(0, 0, w, h);
    const orbs = [
      { x: w * (0.25 + 0.15 * Math.cos(t * 0.7)), y: h * (0.28 + 0.14 * Math.sin(t * 0.5)), r: Math.max(w, h) * 0.65, c: colors[1] },
      { x: w * (0.78 + 0.14 * Math.sin(t * 0.6)), y: h * (0.24 + 0.16 * Math.cos(t * 0.4)), r: Math.max(w, h) * 0.58, c: colors[2] },
      { x: w * (0.52 + 0.18 * Math.cos(t * 0.5 + 1.4)), y: h * (0.76 + 0.12 * Math.sin(t * 0.8)), r: Math.max(w, h) * 0.68, c: colors[3] },
    ];
    ctx.globalAlpha = 0.55;
    for (const o of orbs) {
      const g = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, o.r);
      g.addColorStop(0, o.c);
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalAlpha = 1;
  };
  drawFrame();
  if (!reduced) {
    setInterval(() => {
      if (document.hidden) return;
      t += 0.035;
      drawFrame();
    }, 80);
  }
  return () => { colors = readColors(); drawFrame(); };
}
const refreshMeshColors = initMeshCanvas();

// ---- Tema Terang / Gelap ----
function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'dark' || t === 'light') root.setAttribute('data-theme', t);
  else root.removeAttribute('data-theme');
  const isDark = t === 'dark' || (!t && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  $('#themeIcon')?.setAttribute('href', isDark ? '#i-sun' : '#i-moon');
  refreshMeshColors();
}
try { applyTheme(localStorage.getItem('swd_theme')); } catch { applyTheme(null); }
$('#themeBtn')?.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const sysDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const next = cur ? (cur === 'dark' ? 'light' : 'dark') : (sysDark ? 'light' : 'dark');
  try { localStorage.setItem('swd_theme', next); } catch { /* abaikan bila storage diblokir */ }
  applyTheme(next);
});

// ---- Konverter Multi-Satuan (inspirasi WaterHub individual/page.js) ----
function formatConvertedVolume(liters, unit) {
  if (liters == null || !Number.isFinite(liters)) return '—';
  switch (unit) {
    case 'ml':      return `≈ ${Math.round(liters * 1000).toLocaleString('id-ID')} mL`;
    case 'oz':      return `≈ ${(liters * 33.814).toFixed(1)} fl oz`;
    case 'gallons': return `≈ ${(liters * 0.264172).toFixed(2)} gal`;
    case 'glasses':
    default:        return `≈ ${(liters / 0.25).toFixed(1)} gelas`;
  }
}
try {
  const savedUnit = localStorage.getItem('swd_unit');
  if (savedUnit && ['glasses', 'ml', 'oz', 'gallons'].includes(savedUnit)) {
    ui.unit = savedUnit;
    if ($('#unitSelect')) $('#unitSelect').value = savedUnit;
  }
} catch { /* abaikan */ }
$('#unitSelect')?.addEventListener('change', (e) => {
  ui.unit = e.target.value;
  try { localStorage.setItem('swd_unit', ui.unit); } catch { /* abaikan */ }
  const hasValue = ui.last?.device_state === 'READY' && ui.last?.volume_liter != null;
  if ($('#volConverted')) $('#volConverted').textContent = formatConvertedVolume(hasValue ? ui.last.volume_liter : null, ui.unit);
});

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
  el.querySelector('span:last-child').textContent = text;
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

function updateZoneBars(h, k, r, cap) {
  const ok = [h, k, r].every(Number.isInteger) && h >= 0 && h < k && k < r && r < 100;
  if (!ok) return;
  const wH = h, wK = k - h, wR = r - k, wN = 100 - r;
  for (const [id, w] of [['#zHabis', wH], ['#zKritis', wK], ['#zRendah', wR], ['#zNormal', wN],
                         ['#pHabis', wH], ['#pKritis', wK], ['#pRendah', wR], ['#pNormal', wN]]) {
    const el = $(id);
    if (el) el.style.width = `${w}%`;
  }
  const c = cap || ui.last?.capacity_liter || 5;
  const toL = (p) => ((p / 100) * c).toFixed(2);
  if ($('#thHVol')) $('#thHVol').textContent = `≤ ${toL(h)} L`;
  if ($('#thKVol')) $('#thKVol').textContent = `> ${toL(h)} – ${toL(k)} L`;
  if ($('#thRVol')) $('#thRVol').textContent = `> ${toL(k)} – ${toL(r)} L`;
  if ($('#thNVol')) $('#thNVol').textContent = `NORMAL > ${toL(r)} L`;
  if ($('#markH')) { $('#markH').style.bottom = `${h}%`; $('#markH span').textContent = `H ${h}%`; }
  if ($('#markK')) { $('#markK').style.bottom = `${k}%`; $('#markK span').textContent = `K ${k}%`; }
  if ($('#markR')) { $('#markR').style.bottom = `${r}%`; $('#markR span').textContent = `R ${r}%`; }
}

function render(m) {
  ui.last = m;
  const now = new Date(m.server_time).getTime();
  $('#devCode').textContent = m.device_code;
  if ($('#cfgMeta')) $('#cfgMeta').textContent = `Konfigurasi v${m.config_version}`;
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
  if ($('#volConverted')) $('#volConverted').textContent = formatConvertedVolume(hasValue ? m.volume_liter : null, ui.unit);
  if ($('#volRangeHint')) $('#volRangeHint').textContent = `Kapasitas penuh ${m.capacity_liter.toFixed(2)} L`;
  $('#pct').textContent = hasValue ? String(Math.round(m.percentage)) : '--';
  $('#pctBar').style.width = hasValue ? `${m.percentage}%` : '0%';
  $('#cap').textContent = m.capacity_liter;
  $('#updated').textContent = m.latest_at ? new Date(m.latest_at).toLocaleString('id-ID') : '—';

  // FluidMeter botol berlekuk
  if ($('#tankCapTag')) $('#tankCapTag').textContent = `${m.capacity_liter} L`;
  if ($('#tankFill')) $('#tankFill').style.height = hasValue ? `${Math.max(0, Math.min(100, m.percentage))}%` : '0%';
  if ($('#tankVessel')) $('#tankVessel').setAttribute('data-status', hasValue && m.water_status ? m.water_status : 'NONE');
  if ($('#tankPctText')) $('#tankPctText').textContent = hasValue ? `${Math.round(m.percentage)}%` : '--%';
  if ($('#tankVolText')) {
    $('#tankVolText').textContent = hasValue
      ? `${m.volume_liter.toFixed(2)} / ${m.capacity_liter} L`
      : (STATE_VIEW[ds]?.text || 'Menunggu data');
  }

  if (hasValue && STATUS[m.water_status]) {
    setPill($('#status'), STATUS[m.water_status].cls, STATUS[m.water_status].icon, m.water_status + (stale ? ' (data lama)' : ''));
    if ($('#actuatorHint')) $('#actuatorHint').textContent = online ? STATUS[m.water_status].act : 'LED: 3 Pulsa · Buzzer: Dihentikan (Offline)';
  } else if (STATE_VIEW[ds]) {
    setPill($('#status'), STATE_VIEW[ds].cls, STATE_VIEW[ds].icon, STATE_VIEW[ds].text);
    if ($('#actuatorHint')) $('#actuatorHint').textContent = STATE_VIEW[ds].act;
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
  if ($('#tareIdText')) $('#tareIdText').textContent = `ID Tare: ${m.tare_id || '—'}`;
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
    updateZoneBars(m.threshold_habis_pct, m.threshold_kritis_pct, m.threshold_rendah_pct, m.capacity_liter);
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

$('#refreshBtn')?.addEventListener('click', async () => {
  const btn = $('#refreshBtn');
  btn.classList.add('spinning');
  await Promise.all([refresh(), drawChart()]);
  setTimeout(() => btn.classList.remove('spinning'), 450);
});

// ---- Grafik (SVG): titik pada timestamp asli, garis putus pada celah, kapasitas sebagai garis tangga ----
const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}, text) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
};

function updateGradeBadge(rows) {
  const gEl = $('#avgGrade');
  if (!gEl) return;
  const pcts = rows.map((r) => r.percentage).filter((p) => Number.isFinite(p));
  if (!pcts.length) {
    gEl.textContent = '—';
    gEl.className = 'grade-val';
    return;
  }
  const avg = Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
  gEl.textContent = `${avg}%`;
  gEl.className = `grade-val ${avg >= 60 ? 'g-good' : avg >= 40 ? 'g-mid' : 'g-low'}`;
}

async function drawChart() {
  const svg = $('#chart');
  const tip = $('#chartTip');
  if (tip) tip.hidden = true;
  let data;
  try {
    data = await api('/readings?range=' + ui.range);
  } catch {
    return;
  }
  const rows = data.readings.map((r) => ({ ...r, t: new Date(r.recorded_at).getTime() }));
  svg.replaceChildren();
  $('#chartEmpty').hidden = rows.length > 0;
  if ($('#stCount')) $('#stCount').textContent = String(rows.length);
  updateGradeBadge(rows);
  if (!rows.length) {
    if ($('#stMin')) $('#stMin').textContent = '—';
    if ($('#stMax')) $('#stMax').textContent = '—';
    return;
  }

  const vols = rows.map((r) => r.volume_liter);
  if ($('#stMin')) $('#stMin').textContent = `${Math.min(...vols).toFixed(2)} L`;
  if ($('#stMax')) $('#stMax').textContent = `${Math.max(...vols).toFixed(2)} L`;

  const W = 640, H = 260, L = 44, R = 14, T = 14, B = 30;
  const span = ui.range === '7d' ? 7 * 24 * 3600e3 : 24 * 3600e3;
  const t1 = Date.now(), t0 = t1 - span;
  const maxCap = Math.max(5, ...rows.map((r) => r.capacity_liter));
  const x = (t) => L + ((t - t0) / span) * (W - L - R);
  const y = (v) => T + (1 - v / maxCap) * (H - T - B);
  const baseY = y(0);

  // Gradien area di bawah kurva (#55C0F3 dengan opasitas bertingkat seperti WaterHub)
  const defs = el('defs');
  const grad = el('linearGradient', { id: 'chartAreaGrad', x1: '0', y1: '0', x2: '0', y2: '1' });
  grad.append(
    el('stop', { offset: '0%', 'stop-color': 'var(--chart-line)', 'stop-opacity': '0.35' }),
    el('stop', { offset: '100%', 'stop-color': 'var(--chart-line)', 'stop-opacity': '0.02' }),
  );
  defs.append(grad);
  svg.append(defs);

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

  // kapasitas (garis tangga merah/aksen putus-putus seperti Ideal Consumption di WaterHub)
  let cap = `M${x(Math.max(rows[0].t, t0))},${y(rows[0].capacity_liter)}`;
  rows.forEach((r, i) => { if (i) cap += `H${x(r.t)}V${y(r.capacity_liter)}`; });
  cap += `H${x(t1)}`;
  svg.append(el('path', { d: cap, fill: 'none', stroke: 'var(--chart-cap)', 'stroke-width': 2.2, 'stroke-dasharray': '8 5' }));

  // volume: segmen dipisah bila ada celah besar (tanpa interpolasi)
  let path = '', area = '', segStart = null;
  rows.forEach((r, i) => {
    const px = x(r.t).toFixed(1), py = y(r.volume_liter).toFixed(1);
    const gap = i === 0 || r.t - rows[i - 1].t > GAP_MS;
    if (gap) {
      if (segStart !== null && i > segStart + 1) {
        area += `L${x(rows[i - 1].t).toFixed(1)},${baseY.toFixed(1)}L${x(rows[segStart].t).toFixed(1)},${baseY.toFixed(1)}Z`;
      }
      segStart = i;
      path += `M${px},${py}`;
      area += `M${px},${py}`;
    } else {
      path += `L${px},${py}`;
      area += `L${px},${py}`;
    }
  });
  if (segStart !== null && rows.length > segStart + 1) {
    area += `L${x(rows[rows.length - 1].t).toFixed(1)},${baseY.toFixed(1)}L${x(rows[segStart].t).toFixed(1)},${baseY.toFixed(1)}Z`;
    svg.append(el('path', { d: area, fill: 'url(#chartAreaGrad)' }));
  }

  svg.append(el('path', { d: path, fill: 'none', stroke: 'var(--chart-line)', 'stroke-width': 2.8, 'stroke-linejoin': 'round' }));
  for (const r of rows) {
    const cx = x(r.t), cy = y(r.volume_liter);
    const dotColor = STATUS[r.water_status]?.dot || 'var(--chart-line)';
    const label = `${new Date(r.t).toLocaleString('id-ID')}\n${r.volume_liter.toFixed(2)} L (${r.percentage}%) dari kapasitas ${r.capacity_liter} L\n${r.water_status || ''} · ${r.record_reason}`;
    const c = el('circle', { cx, cy, r: 4.5, fill: dotColor, stroke: 'var(--card-solid)', 'stroke-width': 2 });
    c.append(el('title', {}, label));
    if (tip) {
      c.addEventListener('mouseenter', () => {
        tip.textContent = label;
        tip.style.left = `${(cx / W) * 100}%`;
        tip.style.top = `${(cy / H) * 100}%`;
        tip.hidden = false;
      });
      c.addEventListener('mouseleave', () => { tip.hidden = true; });
    }
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
document.querySelectorAll('input[name=cap]').forEach((r) => r.addEventListener('change', () => {
  ui.capDirty = true;
  const v = Number(document.querySelector('input[name=cap]:checked')?.value);
  updateZoneBars(Number($('#thH').value), Number($('#thK').value), Number($('#thR').value), v);
}));
['#thH', '#thK', '#thR'].forEach((s) => $(s).addEventListener('input', () => {
  ui.thrDirty = true;
  $(s).removeAttribute('aria-invalid');
  updateZoneBars(Number($('#thH').value), Number($('#thK').value), Number($('#thR').value));
}));

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
