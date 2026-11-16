(function () {
  'use strict';

  const POLL_INTERVAL_MS = 1000;
  const CHART_REFRESH_INTERVAL_MS = 15000;
  const TARE_TIMEOUT_SEC = 60;
  const DEFAULT_THRESHOLDS = { habis: 4, kritis: 10, rendah: 20 };

  const STATUS_COLORS = {
    NORMAL: '#4edea3',
    RENDAH: '#f59e0b',
    KRITIS: '#f97316',
    HABIS: '#ef4444',
  };

  const state = {
    activeTab: 'telemetry',
    chartRange: '24h',
    monitoring: null,
    readings: [],
    selectedCapacity: 5,
    capacityDirty: false,
    thresholdsDirty: false,
    lastConfigVersion: null,
    tareCountdownTimer: null,
    tareDeadlineMs: null,
    lastTareRequestedAt: null,
    toastTimer: null,
  };

  const $ = (id) => document.getElementById(id);

  function fmtNum(val, decimals) {
    if (val === null || val === undefined || Number.isNaN(Number(val))) return '--';
    return Number(val).toFixed(decimals);
  }

  function fmtDateTime(isoStr) {
    if (!isoStr) return '--';
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return '--';
    return d.toLocaleString('id-ID', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function fmtShortTime(isoStr, range) {
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return '';
    if (range === '7d') {
      return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' }) + ' ' +
        d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  }

  function showToast(msg, isError) {
    const el = $('toastMsg');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('is-error', Boolean(isError));
    el.hidden = false;
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 4200);
  }

  async function apiJson(url, options) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    const text = typeof res.text === 'function' ? await res.text() : JSON.stringify(await res.json());
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: text };
    }
    if (!res.ok) {
      const msg = data.error || data.message || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  // Tab Navigation
  function switchTab(tabName) {
    state.activeTab = tabName;
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      const match = btn.dataset.tab === tabName;
      btn.classList.toggle('is-active', match);
      if (match) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });

    document.querySelectorAll('.tab-panel').forEach((panel) => {
      const match = panel.dataset.tabPanel === tabName;
      panel.classList.toggle('is-active', match);
      panel.hidden = !match;
    });

    if (tabName === 'chart') {
      loadReadings();
    }
  }

  // Banner & Topbar Status
  function renderTopbarAndBanner(m) {
    const devId = m.device_code || m.device_id || 'dispenser-001';
    $('deviceIdPill').textContent = devId;
    $('bannerDeviceId').textContent = devId;
    $('lastUpdateText').textContent = fmtDateTime(m.last_raw_at || m.latest_at || m.server_time);

    const online = m.connection === 'ONLINE';
    const fresh = Boolean(m.data_fresh);

    const connBadge = $('connBadge');
    connBadge.classList.toggle('is-online', online);
    connBadge.classList.toggle('is-offline', !online);
    $('connBadgeText').textContent = online ? 'MQTT ONLINE' : 'OFFLINE';

    const freshBadge = $('freshBadge');
    freshBadge.textContent = fresh ? 'Fresh' : 'Data Lama';
    freshBadge.classList.toggle('is-stale', !fresh);

    // Health strip
    const healthChip = $('healthFreshChip');
    healthChip.className = 'chip mono ' + (online && fresh ? 'is-ok' : 'is-warn');
    healthChip.textContent = online && fresh ? 'DATA FRESH (<= 30s)' : (online ? 'STALE > 30s' : 'OFFLINE');

    $('watchdogText').textContent = m.device_state === 'SENSOR_ERROR' ? 'ALERT' : (online ? 'NORMAL' : 'TIMEOUT');
    $('falseEmptyLockText').textContent = m.device_state === 'SENSOR_ERROR' ? 'TRIGGERED' : 'ARMED';

    // Banner state hierarchy
    const banner = $('systemBanner');
    const titleEl = $('bannerStateTitle');
    const msgEl = $('bannerMessage');
    const actionBtn = $('bannerActionBtn');
    banner.className = 'banner';
    actionBtn.classList.add('is-hidden');

    if (m.device_state === 'TARE_IN_PROGRESS') {
      banner.classList.add('is-info');
      titleEl.textContent = 'Kalibrasi Tare Berjalan';
      msgEl.textContent = m.tare_message || 'Menunggu konfirmasi zero offset dari ESP32...';
    } else if (m.device_state === 'TARE_REQUIRED') {
      banner.classList.add('is-warn');
      titleEl.textContent = 'Tare Diperlukan';
      msgEl.textContent = m.tare_message || 'Kapasitas berubah atau belum dikalibrasi. Lakukan Tare saat galon kosong.';
      actionBtn.textContent = 'Buka Tare & Kalibrasi';
      actionBtn.dataset.goto = 'tare';
      actionBtn.classList.remove('is-hidden');
    } else if (m.device_state === 'TARE_FAILED') {
      banner.classList.add('is-danger');
      titleEl.textContent = 'Kalibrasi Tare Gagal';
      msgEl.textContent = m.tare_message || 'Perangkat gagal melakukan Tare. Periksa galon lalu ulangi.';
      actionBtn.textContent = 'Ulangi Tare';
      actionBtn.dataset.goto = 'tare';
      actionBtn.classList.remove('is-hidden');
    } else if (m.device_state === 'SENSOR_ERROR') {
      banner.classList.add('is-danger');
      titleEl.textContent = 'Gangguan Sensor Load Cell';
      msgEl.textContent = 'Pembacaan dihentikan sementara agar gangguan sensor tidak terbaca sebagai galon habis.';
    } else if (!online || !fresh) {
      banner.classList.add('is-warn');
      titleEl.textContent = 'Perangkat Offline / Data Lama';
      msgEl.textContent = 'Nilai yang ditampilkan adalah data valid terakhir, bukan kondisi real-time saat ini.';
    } else {
      banner.classList.add('is-ok');
      titleEl.textContent = 'Sistem Normal & Terhubung';
      msgEl.textContent = 'Pembaruan otomatis telemetri Load Cell aktif.';
    }
  }

  // Gallon SVG & Water Fill
  function setWaterGradientColors(top, mid, bot) {
    $('waterStopTop').setAttribute('stop-color', top);
    $('waterStopMid').setAttribute('stop-color', mid);
    $('waterStopBot').setAttribute('stop-color', bot);
  }

  function renderGallonAndReadout(m) {
    const cap = Number(m.capacity_liter) || 5;
    const hPct = Number(m.threshold_habis_pct ?? 4);
    const kPct = Number(m.threshold_kritis_pct ?? 10);
    const rPct = Number(m.threshold_rendah_pct ?? 20);
    const ready = m.device_state === 'READY';
    const hasReading = m.volume_liter !== null && m.volume_liter !== undefined && m.percentage !== null && m.percentage !== undefined;
    const online = m.connection === 'ONLINE';
    const valid = ready && hasReading;

    $('gallonCapBadge').textContent = `${cap.toFixed(1)} LITER`;
    $('gallonFooterCap').textContent = `${cap.toFixed(1)} Liter`;
    $('volumeCapLabel').textContent = `${cap.toFixed(1)} L`;
    $('barMaxLabel').textContent = `100% (${cap.toFixed(1)} L)`;
    $('scaleMaxLabel').textContent = `${cap.toFixed(1)} L`;
    $('scaleMidLabel').textContent = `${(cap / 2).toFixed(1)} L`;
    $('scaleKritisLabel').textContent = `${((cap * kPct) / 100).toFixed(1)} L`;
    $('barThresholdKritis').textContent = `${kPct}% (${((cap * kPct) / 100).toFixed(2)} L) Ambang Kritis`;

    // Position kritis tripwire line inside tank (y: 82 at 100% .. 322 at 0%)
    const kritisY = 322 - (Math.max(0, Math.min(100, kPct)) / 100) * 240;
    const thrLine = $('gallonThresholdLine');
    thrLine.setAttribute('y1', kritisY.toFixed(1));
    thrLine.setAttribute('y2', kritisY.toFixed(1));

    const badge = $('waterStatusBadge');
    const fillRect = $('gallonFillRect');
    const waveGroup = $('gallonWaveGroup');
    const barFill = $('levelBarFill');
    const progressEl = $('levelProgressBar');

    if (!valid) {
      $('volumeValue').textContent = '--';
      $('pctValue').textContent = 'Sisa: --%';
      $('massValue').textContent = '-- kg (-- g)';
      $('scaleLiveVol').textContent = '-- L';
      $('scaleLivePct').textContent = '(--%)';
      $('barCurrentPct').textContent = '--%';
      barFill.style.width = '0%';
      progressEl.setAttribute('aria-valuenow', '0');

      fillRect.setAttribute('y', '322');
      fillRect.setAttribute('height', '0');
      waveGroup.setAttribute('transform', 'translate(0, 322)');
      waveGroup.setAttribute('opacity', '0');

      badge.className = 'status-badge ' + (m.device_state === 'SENSOR_ERROR' || m.device_state === 'TARE_FAILED' ? 'is-error' : 'is-muted');
      badge.textContent = m.device_state === 'TARE_REQUIRED' ? 'PERLU TARE' :
        m.device_state === 'TARE_IN_PROGRESS' ? 'SEDANG TARE' :
          m.device_state === 'SENSOR_ERROR' ? 'SENSOR ERROR' : 'TIDAK TERSEDIA';

      $('sensorActiveChip').className = 'chip mono is-warn';
      $('sensorActiveChip').textContent = m.device_state;
      $('sensorNote').textContent = m.tare_message || 'Menunggu sensor & kalibrasi siap';
      $('gallonFooterStatus').textContent = badge.textContent;
      renderHardwareIndicators(m, null);
      return;
    }

    const vol = Number(m.volume_liter);
    const pct = Math.max(0, Math.min(100, Number(m.percentage)));
    const grams = Math.round(vol * 1000);
    const status = (m.water_status || 'NORMAL').toUpperCase();

    $('volumeValue').textContent = vol.toFixed(2);
    $('pctValue').textContent = `Sisa: ${pct}%`;
    $('massValue').textContent = `${vol.toFixed(2)} kg (${grams.toLocaleString('id-ID')} g)`;
    $('scaleLiveVol').textContent = `${vol.toFixed(1)} L`;
    $('scaleLivePct').textContent = `(${pct}%)`;
    $('barCurrentPct').textContent = `${pct}% (${online ? 'Live' : 'Data Lama'})`;

    barFill.style.width = `${pct}%`;
    progressEl.setAttribute('aria-valuenow', String(pct));

    const fillHeight = (pct / 100) * 240;
    const fillY = 322 - fillHeight;
    fillRect.setAttribute('y', fillY.toFixed(1));
    fillRect.setAttribute('height', fillHeight.toFixed(1));
    waveGroup.setAttribute('transform', `translate(0, ${fillY.toFixed(1)})`);
    waveGroup.setAttribute('opacity', pct > 1 ? '1' : '0');

    // Gradient & status badges
    let badgeClass = 'is-normal';
    let footerLabel = 'Level Air Optimal';
    let barColor = 'linear-gradient(90deg, #8ed5ff, #38bdf8, #4edea3)';
    setWaterGradientColors('#38bdf8', '#0ea5e9', '#006080');

    if (status === 'RENDAH') {
      badgeClass = 'is-rendah';
      footerLabel = `Perlu Isi Ulang (<= ${rPct}%)`;
      barColor = 'linear-gradient(90deg, #fbbf24, #f59e0b)';
      setWaterGradientColors('#fbbf24', '#f59e0b', '#92400e');
    } else if (status === 'KRITIS') {
      badgeClass = 'is-kritis';
      footerLabel = `Level Kritis (<= ${kPct}%)`;
      barColor = 'linear-gradient(90deg, #fb923c, #f97316)';
      setWaterGradientColors('#fb923c', '#f97316', '#9a3412');
    } else if (status === 'HABIS') {
      badgeClass = 'is-habis';
      footerLabel = `Galon Habis (<= ${hPct}%)`;
      barColor = 'linear-gradient(90deg, #f87171, #ef4444)';
      setWaterGradientColors('#f87171', '#ef4444', '#7f1d1d');
    }

    barFill.style.background = barColor;
    badge.className = `status-badge ${badgeClass}`;
    badge.textContent = online ? status : `${status} (DATA LAMA)`;
    $('gallonFooterStatus').textContent = footerLabel;

    $('sensorActiveChip').className = 'chip mono ' + (online ? 'is-ok' : 'is-warn');
    $('sensorActiveChip').textContent = online ? 'AKTIF' : 'DATA LAMA';
    $('sensorNote').textContent = online ? 'Pembacaan HX711 terverifikasi' : 'Menunggu perangkat kembali online';

    renderHardwareIndicators(m, status);
  }

  function pad16(str) {
    return (str + '                ').slice(0, 16);
  }

  function renderHardwareIndicators(m, status) {
    const kPct = Number(m.threshold_kritis_pct ?? 10);
    const online = m.connection === 'ONLINE';
    const devState = m.device_state;

    $('ledRuleDesc').textContent = `Menyala merah saat level <= ${kPct}% (Kritis/Habis)`;

    const ledDot = $('ledDotIndicator');
    const ledBadge = $('ledStateBadge');
    const buzzIcon = document.querySelector('.buzzer-icon');
    const buzzBadge = $('buzzerStateBadge');

    ledDot.className = 'led-indicator';
    ledBadge.className = 'state-badge mono';
    buzzIcon.className = 'buzzer-icon';
    buzzBadge.className = 'state-badge mono';

    if (devState !== 'READY') {
      ledDot.classList.add('is-on-amber');
      ledBadge.classList.add('is-warn');
      ledBadge.textContent = devState === 'SENSOR_ERROR' ? 'BLINK ERR' : 'STANDBY';
      buzzBadge.textContent = 'DIAM';
    } else if (!online) {
      ledBadge.textContent = 'TERPUTUS';
      buzzBadge.textContent = 'DIHENTIKAN';
    } else if (status === 'HABIS' || status === 'KRITIS') {
      ledDot.classList.add('is-on-red');
      ledBadge.classList.add('is-alert');
      ledBadge.textContent = 'MERAH AKTIF';
      buzzIcon.classList.add('is-active');
      buzzBadge.classList.add('is-alert');
      buzzBadge.textContent = status === 'HABIS' ? 'ALARM KONTINU' : 'BEEP BERKALA';
    } else if (status === 'RENDAH') {
      ledDot.classList.add('is-on-amber');
      ledBadge.classList.add('is-warn');
      ledBadge.textContent = 'PERINGATAN';
      buzzBadge.textContent = 'STANDBY';
    } else {
      ledBadge.textContent = 'OFF (AMAN)';
      buzzBadge.textContent = 'DIAM';
    }

    // Simulated 16x2 LCD
    $('lcdStatusPill').textContent = online ? 'ONLINE' : 'OFFLINE';
    if (devState === 'TARE_REQUIRED') {
      $('lcdLine1').textContent = pad16('PERLU KALIBRASI');
      $('lcdLine2').textContent = pad16('TARE GALON KOSNG');
    } else if (devState === 'TARE_IN_PROGRESS') {
      $('lcdLine1').textContent = pad16('TARE DIPROSES..');
      $('lcdLine2').textContent = pad16('JANGAN SENTUH');
    } else if (devState === 'TARE_FAILED') {
      $('lcdLine1').textContent = pad16('TARE GAGAL!');
      $('lcdLine2').textContent = pad16('ULANGI KALIBRASI');
    } else if (devState === 'SENSOR_ERROR') {
      $('lcdLine1').textContent = pad16('SENSOR ERROR!');
      $('lcdLine2').textContent = pad16('CEK LOAD CELL');
    } else if (m.volume_liter !== null && m.percentage !== null) {
      const volText = `VOL:${Number(m.volume_liter).toFixed(2)}L`;
      const pctText = `[${Math.round(Number(m.percentage))}%]`;
      const space = Math.max(1, 16 - volText.length - pctText.length);
      $('lcdLine1').textContent = pad16(volText + ' '.repeat(space) + pctText);
      $('lcdLine2').textContent = pad16(`STATUS: ${online ? status : 'OFFLINE'}`);
    } else {
      $('lcdLine1').textContent = pad16('VOL: --.-L [--%]');
      $('lcdLine2').textContent = pad16('STATUS: WAIT');
    }

    // Quick calib badge
    const calibChip = $('calibStatusBadge');
    calibChip.className = 'chip mono ' + (devState === 'READY' ? 'is-ok' : 'is-warn');
    calibChip.textContent = devState === 'READY' ? 'TERKALIBRASI' : devState;
  }

  // Tab 2: Tare & Kapasitas
  function renderTareTab(m) {
    const cap = Number(m.capacity_liter) || 5;
    if (!state.capacityDirty) {
      state.selectedCapacity = cap;
    }

    const activeCap5 = state.selectedCapacity === 5;
    $('capCard5').classList.toggle('is-selected', activeCap5);
    $('capCard5').setAttribute('aria-checked', String(activeCap5));
    $('capCard10').classList.toggle('is-selected', !activeCap5);
    $('capCard10').setAttribute('aria-checked', String(!activeCap5));

    const capChanged = state.selectedCapacity !== cap;
    $('applyCapacityBtn').disabled = !capChanged || m.device_state === 'TARE_IN_PROGRESS';
    $('capacityActionHint').textContent = capChanged
      ? `Mengubah kapasitas ${cap}L -> ${state.selectedCapacity}L akan mewajibkan Tare ulang.`
      : `Kapasitas aktif saat ini: ${cap} Liter.`;

    $('tarePageStatusBadge').textContent = m.tare_state || '--';
    $('configVersionText').textContent = `v${m.config_version ?? '--'}`;
    $('tareStateText').textContent = m.tare_state || '--';
    $('tareIdText').textContent = m.tare_id || '--';
    $('tareRequestedAtText').textContent = fmtDateTime(m.tare_requested_at || state.lastTareRequestedAt);
    $('tareMessageText').textContent = m.tare_message || 'Siap menerima perintah kalibrasi.';
    $('modalCapText').textContent = `${cap} Liter`;

    const checked = $('confirmEmptyCheck').checked;
    const offline = m.connection !== 'ONLINE';
    const busy = m.tare_state === 'TARE_IN_PROGRESS';
    $('openTareModalBtn').disabled = !checked || busy || offline;

    // Update modal progress view if currently open
    const modal = $('tareModal');
    const progressView = $('tareModalProgressView');
    if (!modal.hidden && !progressView.hidden) {
      if (m.tare_state === 'READY') {
        stopTareCountdown();
        modal.hidden = true;
        showToast('Kalibrasi Tare selesai dan galon siap digunakan.');
      } else if (m.tare_state === 'TARE_FAILED') {
        stopTareCountdown();
        $('tareProgressMsg').textContent = m.tare_message || 'Tare gagal di perangkat.';
      } else if (m.tare_message) {
        $('tareProgressMsg').textContent = m.tare_message;
      }
    }
  }

  function startTareCountdown() {
    stopTareCountdown();
    state.tareDeadlineMs = Date.now() + TARE_TIMEOUT_SEC * 1000;
    const tick = () => {
      const remSec = Math.max(0, Math.ceil((state.tareDeadlineMs - Date.now()) / 1000));
      $('tareCountdownText').textContent = `${remSec} detik`;
      $('tareProgressBar').style.width = `${(remSec / TARE_TIMEOUT_SEC) * 100}%`;
      if (remSec <= 0) {
        stopTareCountdown();
        $('tareProgressMsg').textContent = 'Waktu tunggu habis. Periksa koneksi perangkat.';
      }
    };
    tick();
    state.tareCountdownTimer = setInterval(tick, 500);
  }

  function stopTareCountdown() {
    if (state.tareCountdownTimer) {
      clearInterval(state.tareCountdownTimer);
      state.tareCountdownTimer = null;
    }
  }

  // Tab 3: Grafik Analitik & CSV
  async function loadReadings() {
    try {
      const data = await apiJson(`/api/readings?range=${encodeURIComponent(state.chartRange)}`);
      state.readings = Array.isArray(data.readings) ? data.readings : [];
      renderChart();
    } catch (err) {
      showToast(`Gagal memuat grafik: ${err.message}`, true);
    }
  }

  function renderChart() {
    const readings = state.readings;
    const m = state.monitoring || {};
    const cap = Number(m.capacity_liter) || 5;
    $('chartCapBadge').textContent = `Kapasitas: ${cap.toFixed(1)} L`;

    $('kpiPointCount').textContent = String(readings.length);
    if (readings.length === 0) {
      $('kpiMinVol').textContent = '-- L';
      $('kpiMaxVol').textContent = '-- L';
      $('kpiLastPoint').textContent = 'Belum ada pencatatan';
      $('chartEmptyState').hidden = false;
      ['chartGrid', 'chartGaps', 'chartThresholds', 'chartArea', 'chartLine', 'chartPoints', 'chartAxes']
        .forEach((id) => { $(id).innerHTML = ''; });
      return;
    }

    $('chartEmptyState').hidden = true;
    const vols = readings.map((r) => Number(r.volume_liter));
    const minV = Math.min(...vols);
    const maxV = Math.max(...vols);
    const maxAxis = Math.max(cap, maxV, 5);
    $('kpiMinVol').textContent = `${minV.toFixed(2)} L`;
    $('kpiMaxVol').textContent = `${maxV.toFixed(2)} L`;
    $('kpiLastPoint').textContent = `Terakhir: ${fmtDateTime(readings[readings.length - 1].recorded_at)}`;

    const W = 960;
    const H = 340;
    const pad = { top: 20, right: 24, bottom: 38, left: 52 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    const times = readings.map((r) => new Date(r.recorded_at).getTime());
    const minT = times[0];
    const maxT = times[times.length - 1];
    const spanT = Math.max(60000, maxT - minT);

    const xOf = (t) => pad.left + ((t - minT) / spanT) * plotW;
    const yOf = (v) => pad.top + (1 - Math.max(0, Math.min(1, v / maxAxis))) * plotH;

    // Grid & Y labels
    let gridSvg = '';
    for (let i = 0; i <= 4; i++) {
      const val = (maxAxis * i) / 4;
      const y = yOf(val);
      gridSvg += `<line x1="${pad.left}" y1="${y}" x2="${W - pad.right}" y2="${y}" stroke="#31353e" stroke-dasharray="3 3" stroke-width="1"/>`;
      gridSvg += `<text x="${pad.left - 8}" y="${y + 4}" text-anchor="end" fill="#87929a" font-family="Space Mono, monospace" font-size="10">${val.toFixed(1)}L</text>`;
    }
    $('chartGrid').innerHTML = gridSvg;

    // Threshold tripwires
    const thr = [
      { label: 'RENDAH', pct: Number(m.threshold_rendah_pct ?? 20), color: '#f59e0b' },
      { label: 'KRITIS', pct: Number(m.threshold_kritis_pct ?? 10), color: '#f97316' },
      { label: 'HABIS', pct: Number(m.threshold_habis_pct ?? 4), color: '#ef4444' },
    ];
    $('chartThresholds').innerHTML = thr.map((t) => {
      const y = yOf((cap * t.pct) / 100);
      return `<line x1="${pad.left}" y1="${y}" x2="${W - pad.right}" y2="${y}" stroke="${t.color}" stroke-opacity="0.55" stroke-dasharray="5 4" stroke-width="1.2"/>
        <text x="${W - pad.right - 4}" y="${y - 4}" text-anchor="end" fill="${t.color}" font-family="Space Mono, monospace" font-size="9" font-weight="700">${t.label} ${t.pct}%</text>`;
    }).join('');

    // Segments & standby gaps (> 2.5h for 24h or > 8h for 7d)
    const gapLimitMs = (state.chartRange === '7d' ? 8 : 2.5) * 3600 * 1000;
    const segments = [];
    const gaps = [];
    let currentSeg = [];

    readings.forEach((r, idx) => {
      const pt = { x: xOf(times[idx]), y: yOf(Number(r.volume_liter)), r };
      if (idx > 0 && times[idx] - times[idx - 1] > gapLimitMs) {
        if (currentSeg.length) segments.push(currentSeg);
        gaps.push({ x1: xOf(times[idx - 1]), x2: pt.x });
        currentSeg = [pt];
      } else {
        currentSeg.push(pt);
      }
    });
    if (currentSeg.length) segments.push(currentSeg);

    $('chartGaps').innerHTML = gaps.map((g) => {
      const w = Math.max(4, g.x2 - g.x1);
      const mid = g.x1 + w / 2;
      return `<rect x="${g.x1}" y="${pad.top}" width="${w}" height="${plotH}" fill="url(#dataGapHatch)"/>` +
        (w > 54 ? `<text x="${mid}" y="${pad.top + 16}" text-anchor="middle" fill="#87929a" font-family="Space Mono, monospace" font-size="9">JEDA // OFFLINE</text>` : '');
    }).join('');

    $('chartArea').innerHTML = segments.map((seg) => {
      if (seg.length < 2) return '';
      const dLine = seg.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
      const dArea = `${dLine} L${seg[seg.length - 1].x.toFixed(1)},${pad.top + plotH} L${seg[0].x.toFixed(1)},${pad.top + plotH} Z`;
      return `<path d="${dArea}" fill="url(#chartAreaGrad)"/>`;
    }).join('');

    $('chartLine').innerHTML = segments.map((seg) => {
      if (seg.length < 2) return '';
      const dLine = seg.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
      return `<path d="${dLine}" fill="none" stroke="#38bdf8" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`;
    }).join('');

    // Points + hover hooks
    const pointsEl = $('chartPoints');
    pointsEl.innerHTML = readings.map((r, idx) => {
      const cx = xOf(times[idx]).toFixed(1);
      const cy = yOf(Number(r.volume_liter)).toFixed(1);
      const col = STATUS_COLORS[r.water_status] || '#38bdf8';
      return `<circle class="chart-dot" data-idx="${idx}" cx="${cx}" cy="${cy}" r="4.5" fill="${col}" stroke="#0a0e16" stroke-width="1.5" style="cursor:pointer"/>`;
    }).join('');

    pointsEl.querySelectorAll('.chart-dot').forEach((dot) => {
      dot.addEventListener('mouseenter', (ev) => {
        const rec = readings[Number(dot.dataset.idx)];
        const tip = $('chartTooltip');
        tip.innerHTML = `<strong>${Number(rec.volume_liter).toFixed(2)} L (${rec.percentage}%)</strong><br>${rec.water_status} • ${fmtDateTime(rec.recorded_at)}`;
        tip.hidden = false;
        const rect = $('chartStage').getBoundingClientRect();
        tip.style.left = `${Math.min(rect.width - 190, Math.max(8, ev.clientX - rect.left + 10))}px`;
        tip.style.top = `${Math.max(8, ev.clientY - rect.top - 48)}px`;
      });
      dot.addEventListener('mouseleave', () => {
        $('chartTooltip').hidden = true;
      });
    });

    // X-axis tick labels
    const tickCount = Math.min(5, readings.length);
    let axesSvg = '';
    for (let i = 0; i < tickCount; i++) {
      const idx = tickCount === 1 ? 0 : Math.round((i * (readings.length - 1)) / (tickCount - 1));
      const x = xOf(times[idx]);
      axesSvg += `<text x="${x}" y="${H - 12}" text-anchor="middle" fill="#87929a" font-family="Space Mono, monospace" font-size="10">${fmtShortTime(readings[idx].recorded_at, state.chartRange)}</text>`;
    }
    $('chartAxes').innerHTML = axesSvg;
  }

  function exportCsv() {
    if (!state.readings.length) {
      showToast('Belum ada data pembacaan untuk diekspor.', true);
      return;
    }
    const header = 'recorded_at,volume_liter,percentage,water_status,capacity_liter,record_reason\n';
    const rows = state.readings.map((r) => [
      r.recorded_at,
      Number(r.volume_liter).toFixed(2),
      r.percentage,
      r.water_status,
      r.capacity_liter,
      r.record_reason || '',
    ].join(',')).join('\n');

    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `water-telemetry-${state.chartRange}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast(`Berhasil mengekspor ${state.readings.length} baris CSV.`);
  }

  // Tab 4: Pengaturan Ambang
  function populateThresholdsFromMonitoring(m, force) {
    if (!force && state.thresholdsDirty && state.lastConfigVersion === m.config_version) {
      updateThresholdPreview();
      return;
    }
    state.lastConfigVersion = m.config_version;
    state.thresholdsDirty = false;
    setThresholdInputs(
      Number(m.threshold_habis_pct ?? 4),
      Number(m.threshold_kritis_pct ?? 10),
      Number(m.threshold_rendah_pct ?? 20)
    );
  }

  function setThresholdInputs(h, k, r) {
    $('thresholdHabisRange').value = String(h);
    $('thresholdHabisInput').value = String(h);
    $('thresholdKritisRange').value = String(k);
    $('thresholdKritisInput').value = String(k);
    $('thresholdRendahRange').value = String(r);
    $('thresholdRendahInput').value = String(r);
    updateThresholdPreview();
  }

  function updateThresholdPreview() {
    const cap = Number(state.monitoring?.capacity_liter) || 5;
    const h = Number($('thresholdHabisInput').value);
    const k = Number($('thresholdKritisInput').value);
    const r = Number($('thresholdRendahInput').value);

    const hLit = ((cap * h) / 100).toFixed(2);
    const kLit = ((cap * k) / 100).toFixed(2);
    const rLit = ((cap * r) / 100).toFixed(2);

    $('specCapText').textContent = `${cap.toFixed(1)} Liter`;
    $('specLitMax').textContent = `${cap.toFixed(2)} L`;
    $('habisLiterPreview').textContent = `<= ${hLit} L`;
    $('kritisLiterPreview').textContent = `<= ${kLit} L`;
    $('rendahLiterPreview').textContent = `<= ${rLit} L`;

    $('specLabelHabis').textContent = `Habis <= ${h}%`;
    $('specLitHabis').textContent = `${hLit} L`;
    $('specLabelKritis').textContent = `Kritis <= ${k}%`;
    $('specLitKritis').textContent = `${kLit} L`;
    $('specLabelRendah').textContent = `Rendah <= ${r}%`;
    $('specLitRendah').textContent = `${rLit} L`;

    const valid = Number.isInteger(h) && Number.isInteger(k) && Number.isInteger(r) &&
      h >= 0 && h < k && k < r && r < 100;

    if (valid) {
      $('specBarHabis').style.width = `${h}%`;
      $('specBarKritis').style.width = `${k - h}%`;
      $('specBarRendah').style.width = `${r - k}%`;
      $('specBarNormal').style.width = `${100 - r}%`;
    }

    const box = $('thresholdValidationBox');
    const chip = $('thresholdValidChip');
    const msg = $('thresholdValidationMsg');
    box.classList.toggle('is-invalid', !valid);
    chip.className = 'chip mono ' + (valid ? 'is-valid' : 'is-danger');
    chip.textContent = valid ? 'VALID' : 'TIDAK VALID';
    msg.textContent = valid
      ? 'Konfigurasi ambang memenuhi aturan 0 <= HABIS < KRITIS < RENDAH < 100 (+1% hysteresis pemulihan).'
      : 'Urutan ambang harus bilangan bulat dengan syarat 0 <= HABIS < KRITIS < RENDAH < 100.';
    $('saveThresholdsBtn').disabled = !valid;
    return valid;
  }

  // Polling & Mutations
  async function pollMonitoring() {
    try {
      const m = await apiJson('/api/monitoring');
      state.monitoring = m;
      renderTopbarAndBanner(m);
      renderGallonAndReadout(m);
      renderTareTab(m);
      populateThresholdsFromMonitoring(m, false);
      if (state.readings.length > 0 || state.activeTab === 'chart') renderChart();
    } catch {
      $('connBadge').classList.remove('is-online');
      $('connBadge').classList.add('is-offline');
      $('connBadgeText').textContent = 'API ERROR';
    }
  }

  async function applyCapacityChange() {
    const m = state.monitoring;
    if (!m || state.selectedCapacity === m.capacity_liter) return;
    if (m.tare_state === 'READY') {
      const ok = window.confirm(
        `Mengganti kapasitas galon ke ${state.selectedCapacity} Liter akan mewajibkan kalibrasi Tare ulang. Lanjutkan?`
      );
      if (!ok) return;
    }

    try {
      $('applyCapacityBtn').disabled = true;
      await apiJson('/api/device', {
        method: 'PATCH',
        body: JSON.stringify({ capacity_liter: state.selectedCapacity }),
      });
      state.capacityDirty = false;
      showToast(`Kapasitas diperbarui ke ${state.selectedCapacity} Liter. Lanjutkan Tare galon kosong.`);
      await pollMonitoring();
    } catch (err) {
      showToast(`Gagal mengubah kapasitas: ${err.message}`, true);
    }
  }

  async function submitTare() {
    try {
      $('confirmTareSubmitBtn').disabled = true;
      const res = await apiJson('/api/tare', {
        method: 'POST',
        body: JSON.stringify({ confirm_empty: true }),
      });
      state.lastTareRequestedAt = res.requested_at || new Date().toISOString();
      $('tareModalConfirmView').hidden = true;
      $('tareModalProgressView').hidden = false;
      $('tareProgressMsg').textContent = res.tare_message || 'Perintah Tare terkirim ke ESP32.';
      startTareCountdown();
      await pollMonitoring();
    } catch (err) {
      showToast(`Gagal memulai Tare: ${err.message}`, true);
    } finally {
      $('confirmTareSubmitBtn').disabled = false;
    }
  }

  async function saveThresholds() {
    if (!updateThresholdPreview()) return;
    const payload = {
      threshold_habis_pct: Number($('thresholdHabisInput').value),
      threshold_kritis_pct: Number($('thresholdKritisInput').value),
      threshold_rendah_pct: Number($('thresholdRendahInput').value),
    };
    try {
      $('saveThresholdsBtn').disabled = true;
      await apiJson('/api/device', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      state.thresholdsDirty = false;
      showToast('Ambang batas status air berhasil disimpan dan disinkronkan.');
      await pollMonitoring();
      if (state.activeTab === 'chart') await loadReadings();
    } catch (err) {
      showToast(`Gagal menyimpan ambang: ${err.message}`, true);
      $('saveThresholdsBtn').disabled = false;
    }
  }

  function bindThresholdPair(rangeId, inputId) {
    const rEl = $(rangeId);
    const nEl = $(inputId);
    rEl.addEventListener('input', () => {
      state.thresholdsDirty = true;
      nEl.value = rEl.value;
      updateThresholdPreview();
    });
    nEl.addEventListener('input', () => {
      state.thresholdsDirty = true;
      rEl.value = nEl.value;
      updateThresholdPreview();
    });
  }

  function init() {
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    $('quickGoTareBtn').addEventListener('click', () => switchTab('tare'));
    $('bannerActionBtn').addEventListener('click', () => {
      const dest = $('bannerActionBtn').dataset.goto || 'tare';
      switchTab(dest);
    });

    [$('capCard5'), $('capCard10')].forEach((card) => {
      card.addEventListener('click', () => {
        state.selectedCapacity = Number(card.dataset.capacity);
        state.capacityDirty = true;
        if (state.monitoring) renderTareTab(state.monitoring);
      });
    });
    $('applyCapacityBtn').addEventListener('click', applyCapacityChange);

    $('confirmEmptyCheck').addEventListener('change', () => {
      if (state.monitoring) renderTareTab(state.monitoring);
    });

    $('openTareModalBtn').addEventListener('click', () => {
      $('tareModalConfirmView').hidden = false;
      $('tareModalProgressView').hidden = true;
      $('tareModal').hidden = false;
    });

    $('cancelTareModalBtn').addEventListener('click', () => {
      $('tareModal').hidden = true;
    });
    $('closeTareProgressBtn').addEventListener('click', () => {
      stopTareCountdown();
      $('tareModal').hidden = true;
    });
    $('confirmTareSubmitBtn').addEventListener('click', submitTare);

    document.querySelectorAll('.range-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.chartRange = btn.dataset.range;
        document.querySelectorAll('.range-btn').forEach((b) => {
          b.classList.toggle('is-active', b.dataset.range === state.chartRange);
        });
        loadReadings();
      });
    });

    $('refreshChartBtn').addEventListener('click', loadReadings);
    $('exportCsvBtn').addEventListener('click', exportCsv);

    bindThresholdPair('thresholdHabisRange', 'thresholdHabisInput');
    bindThresholdPair('thresholdKritisRange', 'thresholdKritisInput');
    bindThresholdPair('thresholdRendahRange', 'thresholdRendahInput');

    $('resetThresholdsBtn').addEventListener('click', () => {
      state.thresholdsDirty = true;
      setThresholdInputs(DEFAULT_THRESHOLDS.habis, DEFAULT_THRESHOLDS.kritis, DEFAULT_THRESHOLDS.rendah);
      showToast('Nilai default (4% / 10% / 20%) dimuat. Klik Simpan Pengaturan untuk menerapkan.');
    });
    $('saveThresholdsBtn').addEventListener('click', saveThresholds);

    setThresholdInputs(DEFAULT_THRESHOLDS.habis, DEFAULT_THRESHOLDS.kritis, DEFAULT_THRESHOLDS.rendah);
    pollMonitoring();
    loadReadings();

    setInterval(pollMonitoring, POLL_INTERVAL_MS);
    setInterval(() => {
      if (state.activeTab === 'chart') loadReadings();
    }, CHART_REFRESH_INTERVAL_MS);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
})();
