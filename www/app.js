/* Batch QR Scanner
   Scans QR codes continuously, collects them in a list and copies the list
   as plain text, one code per line. Everything runs on-device. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    viewport: $('viewport'), video: $('video'),
    placeholder: $('placeholder'), phTitle: $('phTitle'), phText: $('phText'),
    chip: $('chip'), chipText: $('chipText'),
    pill: $('pill'), pillText: $('pillText'),
    toggleBtn: $('toggleBtn'), torchBtn: $('torchBtn'), switchBtn: $('switchBtn'),
    dedupe: $('dedupe'), count: $('count'), list: $('list'),
    copyBtn: $('copyBtn'), copyLabel: $('copyLabel'), clearBtn: $('clearBtn'),
    confirm: $('confirm'), toast: $('toast'),
  };

  const STORE_KEY = 'batchqr.v1';
  const MAX_SCAN_SIZE = 800;     // longest side (px) of the frame handed to the decoder
  const SCAN_INTERVAL_MS = 90;   // decode roughly 11 times per second
  const REPEAT_WINDOW_MS = 1500; // ignore the same code while it is still held in view

  const state = {
    codes: [],
    dedupe: true,
    facing: 'environment',
    stream: null,
    scanning: false,
    torchOn: false,
    resumeOnShow: false,
    lastValue: null,
    lastTime: 0,
    seq: 0,
  };

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  /* ---------- Persistence ---------- */

  function load() {
    try {
      const data = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!data) return;
      if (Array.isArray(data.codes)) {
        state.codes = data.codes
          .filter((c) => c && typeof c.value === 'string')
          .map((c) => ({ id: ++state.seq, value: c.value, time: Number(c.time) || Date.now() }));
      }
      if (typeof data.dedupe === 'boolean') state.dedupe = data.dedupe;
    } catch (_) { /* ignore corrupt storage */ }
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        codes: state.codes.map(({ value, time }) => ({ value, time })),
        dedupe: state.dedupe,
      }));
    } catch (_) { /* storage may be unavailable */ }
  }

  /* ---------- UI helpers ---------- */

  function setView(view, message) {
    el.viewport.dataset.state = view;
    el.pill.dataset.state = view;
    el.pillText.textContent = {
      idle: 'Camera off', starting: 'Starting…', scanning: 'Scanning', error: 'Camera error',
    }[view];

    if (view === 'idle') {
      el.phTitle.textContent = 'Camera is off';
      el.phText.textContent = 'Start scanning to capture codes one after another.';
    } else if (view === 'starting') {
      el.phTitle.textContent = 'Starting camera…';
      el.phText.textContent = 'Allow camera access if you are asked.';
    } else if (view === 'error') {
      el.phTitle.textContent = 'Camera unavailable';
      el.phText.textContent = message || 'Something went wrong while opening the camera.';
    }
    updateControls();
  }

  function updateControls() {
    const busy = el.viewport.dataset.state === 'starting';
    const label = el.toggleBtn.querySelector('span');
    const icon = el.toggleBtn.querySelector('use');
    if (state.scanning) {
      label.textContent = 'Stop';
      icon.setAttribute('href', '#i-stop');
      el.toggleBtn.classList.add('stop');
    } else {
      label.textContent = el.viewport.dataset.state === 'error' ? 'Try again' : 'Start scanning';
      icon.setAttribute('href', '#i-camera');
      el.toggleBtn.classList.remove('stop');
    }
    el.toggleBtn.disabled = busy;
    el.switchBtn.disabled = !state.scanning;

    const n = state.codes.length;
    el.copyBtn.disabled = n === 0;
    el.clearBtn.disabled = n === 0;
    el.copyLabel.textContent = n > 0 ? `Copy all (${n})` : 'Copy all';
  }

  let chipTimer = 0;
  function feedback(kind, text) {
    el.chipText.textContent = text;
    el.chip.classList.toggle('dup', kind === 'dup');
    el.chip.hidden = false;

    el.viewport.classList.remove('hit', 'dup');
    void el.viewport.offsetWidth; // restart the reticle colour change
    el.viewport.classList.add(kind === 'dup' ? 'dup' : 'hit');

    clearTimeout(chipTimer);
    chipTimer = setTimeout(() => {
      el.chip.hidden = true;
      el.viewport.classList.remove('hit', 'dup');
    }, 1400);

    if (kind === 'ok' && navigator.vibrate) navigator.vibrate(35);
  }

  let toastTimer = 0;
  function toast(text) {
    el.toast.textContent = text;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2200);
  }

  function truncate(text, n) {
    return text.length > n ? text.slice(0, n - 1) + '…' : text;
  }

  function formatTime(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  /* ---------- List ---------- */

  function render(newId) {
    el.list.textContent = '';
    state.codes.forEach((code, i) => {
      const li = document.createElement('li');
      li.className = 'row' + (code.id === newId ? ' new' : '');

      const idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = String(i + 1);

      const body = document.createElement('div');
      body.className = 'body';
      const val = document.createElement('div');
      val.className = 'val';
      val.textContent = code.value;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = formatTime(code.time);
      body.append(val, meta);

      const del = document.createElement('button');
      del.className = 'del';
      del.type = 'button';
      del.setAttribute('aria-label', `Remove code ${i + 1}`);
      del.innerHTML = '<svg class="ico"><use href="#i-close"/></svg>';
      del.addEventListener('click', () => removeCode(code.id));

      li.append(idx, body, del);
      el.list.append(li);
    });

    el.count.textContent = String(state.codes.length);
    updateControls();
    if (newId) el.list.scrollTop = el.list.scrollHeight;
  }

  function removeCode(id) {
    state.codes = state.codes.filter((c) => c.id !== id);
    save();
    render();
  }

  function addCode(raw) {
    // Keep one code per line in the exported list.
    const value = raw.replace(/\s*[\r\n]+\s*/g, ' ').trim();
    if (!value) return;

    const now = Date.now();
    if (value === state.lastValue && now - state.lastTime < REPEAT_WINDOW_MS) {
      state.lastTime = now; // still holding the same code in view
      return;
    }
    state.lastValue = value;
    state.lastTime = now;

    if (state.dedupe && state.codes.some((c) => c.value === value)) {
      feedback('dup', 'Already scanned');
      return;
    }

    const code = { id: ++state.seq, value, time: now };
    state.codes.push(code);
    save();
    render(code.id);
    feedback('ok', `Added · ${truncate(value, 34)}`);
  }

  async function copyAll() {
    const text = state.codes.map((c) => c.value).join('\n');
    if (!text) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (_) {
      ok = legacyCopy(text);
    }
    const n = state.codes.length;
    toast(ok ? `Copied ${n} code${n === 1 ? '' : 's'}` : 'Could not copy — try again');
  }

  function legacyCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { /* noop */ }
    ta.remove();
    return ok;
  }

  function askClear() {
    if (!state.codes.length) return;
    const n = state.codes.length;
    $('confirmText').textContent = `This removes ${n} scanned code${n === 1 ? '' : 's'} from the list.`;
    if (typeof el.confirm.showModal === 'function') {
      el.confirm.showModal();
    } else if (window.confirm(`Clear all ${n} codes?`)) {
      clearAll();
    }
  }

  function clearAll() {
    state.codes = [];
    state.lastValue = null;
    save();
    render();
    toast('List cleared');
  }

  /* ---------- Camera ---------- */

  async function openStream() {
    const attempts = [
      { video: { facingMode: { ideal: state.facing }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
      { video: { facingMode: state.facing }, audio: false },
      { video: true, audio: false },
    ];
    let lastError;
    for (const constraints of attempts) {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        lastError = err;
        if (err && err.name === 'NotAllowedError') break; // no point retrying a denial
      }
    }
    throw lastError;
  }

  function describeError(err) {
    switch (err && err.name) {
      case 'NotAllowedError':
        return 'Camera permission was denied. Allow it in the app settings and try again.';
      case 'NotFoundError':
        return 'No camera was found on this device.';
      case 'NotReadableError':
        return 'The camera is being used by another app. Close it and try again.';
      default:
        return (err && err.message) || 'Could not start the camera.';
    }
  }

  async function startCamera() {
    if (state.stream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setView('error', 'This environment does not support camera access.');
      return;
    }
    if (typeof jsQR !== 'function') {
      setView('error', 'The scanning library failed to load. Restart the app.');
      return;
    }

    setView('starting');
    try {
      state.stream = await openStream();
      el.video.srcObject = state.stream;
      await el.video.play();
      state.scanning = true;
      setView('scanning');
      setupTorch();
      requestAnimationFrame(loop);
    } catch (err) {
      releaseStream();
      setView('error', describeError(err));
    }
  }

  function releaseStream() {
    state.scanning = false;
    state.torchOn = false;
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
    el.video.srcObject = null;
    el.torchBtn.hidden = true;
    el.torchBtn.setAttribute('aria-pressed', 'false');
  }

  function stopCamera() {
    releaseStream();
    el.chip.hidden = true;
    setView('idle');
  }

  async function switchCamera() {
    state.facing = state.facing === 'environment' ? 'user' : 'environment';
    releaseStream();
    await startCamera();
  }

  function setupTorch() {
    const track = state.stream && state.stream.getVideoTracks()[0];
    let supported = false;
    try { supported = !!(track && track.getCapabilities && track.getCapabilities().torch); } catch (_) { /* noop */ }
    el.torchBtn.hidden = !supported;
  }

  async function toggleTorch() {
    const track = state.stream && state.stream.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !state.torchOn }] });
      state.torchOn = !state.torchOn;
      el.torchBtn.setAttribute('aria-pressed', String(state.torchOn));
    } catch (_) {
      toast('Flashlight is not available');
    }
  }

  /* ---------- Decoding ---------- */

  let lastRun = 0;
  function loop(ts) {
    if (!state.scanning) return;
    if (ts - lastRun >= SCAN_INTERVAL_MS && el.video.readyState >= 2 && el.video.videoWidth) {
      lastRun = ts;
      scanFrame();
    }
    requestAnimationFrame(loop);
  }

  // Decode only the part of the camera image that is actually visible in the
  // viewport (it is cropped with object-fit: cover), so codes outside the
  // picture the user sees are never picked up.
  function scanFrame() {
    const vw = el.video.videoWidth;
    const vh = el.video.videoHeight;
    const box = el.viewport.getBoundingClientRect();
    if (!box.width || !box.height) return;

    const cover = Math.max(box.width / vw, box.height / vh);
    const sw = box.width / cover;
    const sh = box.height / cover;
    const sx = (vw - sw) / 2;
    const sy = (vh - sh) / 2;

    const scale = Math.min(1, MAX_SCAN_SIZE / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    ctx.drawImage(el.video, sx, sy, sw, sh, 0, 0, w, h);
    const frame = ctx.getImageData(0, 0, w, h);
    const result = jsQR(frame.data, w, h, { inversionAttempts: 'dontInvert' });
    if (result && result.data) addCode(result.data);
  }

  /* ---------- Wiring ---------- */

  el.toggleBtn.addEventListener('click', () => (state.scanning ? stopCamera() : startCamera()));
  el.switchBtn.addEventListener('click', switchCamera);
  el.torchBtn.addEventListener('click', toggleTorch);
  el.copyBtn.addEventListener('click', copyAll);
  el.clearBtn.addEventListener('click', askClear);

  el.dedupe.addEventListener('change', () => {
    state.dedupe = el.dedupe.checked;
    save();
  });

  el.confirm.addEventListener('close', () => {
    if (el.confirm.returnValue === 'ok') clearAll();
    el.confirm.returnValue = '';
  });

  // The camera is released when the app goes to the background; pick it back up on return.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (state.scanning) {
        state.resumeOnShow = true;
        releaseStream();
        setView('idle');
      }
    } else if (state.resumeOnShow) {
      state.resumeOnShow = false;
      startCamera();
    }
  });

  load();
  el.dedupe.checked = state.dedupe;
  render();
  setView('idle');
})();
