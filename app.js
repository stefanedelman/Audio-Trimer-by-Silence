// ─── Audio Trimmer App ───────────────────────────────────────────────────────
(function () {
  'use strict';

  // ── Config ───────────────────────────────────────────────────────────────────
  const FILENAME_PREFIX = 'Female_IDA_Word_';

  // ── State ────────────────────────────────────────────────────────────────────
  let audioContext = null;
  let audioBuffer = null;
  let fileName = '';
  let segments = [];          // { start: seconds, end: seconds }
  let zoomLevel = 1;          // pixels-per-second scale factor
  const BASE_PPS = 100;       // base pixels per second at zoom 1
  let isPlaying = false;
  let playbackSource = null;
  let playbackStart = 0;      // audioContext time when playback started
  let playbackOffset = 0;     // offset into buffer
  let animFrameId = null;
  let currentlyPlayingSegIdx = -1;

  // ── DOM Refs ─────────────────────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const uploadSection   = $('#upload-section');
  const loadingSection  = $('#loading-section');
  const editorSection   = $('#editor-section');
  const dropZone        = $('#drop-zone');
  const fileInput       = $('#file-input');
  const loadingText     = $('#loading-text');

  const fileNameEl      = $('#file-name');
  const fileDurationEl  = $('#file-duration');
  const btnChangeFile   = $('#btn-change-file');

  const thresholdInput  = $('#silence-threshold');
  const thresholdVal    = $('#silence-threshold-val');
  const minSilInput     = $('#min-silence-duration');
  const minSilVal       = $('#min-silence-duration-val');
  const paddingInput    = $('#padding');
  const paddingVal      = $('#padding-val');
  const btnDetect       = $('#btn-detect');

  const waveformWrapper = $('#waveform-wrapper');
  const waveformCanvas  = $('#waveform-canvas');
  const overlayCanvas   = $('#overlay-canvas');
  const playhead        = $('#playhead');
  const timeRuler       = $('#time-ruler');

  const btnPlay         = $('#btn-play');
  const btnStop         = $('#btn-stop');
  const iconPlay        = $('#icon-play');
  const iconPause       = $('#icon-pause');
  const currentTimeEl   = $('#current-time');
  const totalTimeEl     = $('#total-time');
  const btnZoomIn       = $('#btn-zoom-in');
  const btnZoomOut      = $('#btn-zoom-out');
  const btnZoomFit      = $('#btn-zoom-fit');

  const segmentsPanel   = $('#segments-panel');
  const segmentCount    = $('#segment-count');
  const segmentsList    = $('#segments-list');
  const btnPlayAll      = $('#btn-play-all');
  const btnDownloadAll  = $('#btn-download-all');
  const prefixInput     = $('#filename-prefix');
  const prefixPreview   = $('#prefix-preview-text');
  const batchNamesInput = $('#batch-names');
  const btnApplyNames   = $('#btn-apply-names');
  let batchWords = [];  // parsed words from batch names textarea

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
  }

  function formatTimeFull(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.round((sec % 1) * 1000);
    return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  }

  function parseTimeInput(str) {
    // Accepts m:ss.mmm or just seconds
    str = str.trim();
    const parts = str.split(':');
    if (parts.length === 2) {
      const m = parseFloat(parts[0]) || 0;
      const s = parseFloat(parts[1]) || 0;
      return m * 60 + s;
    }
    return parseFloat(str) || 0;
  }

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function pps() {
    return BASE_PPS * zoomLevel;
  }

  function showToast(msg, type = 'success') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    $('#toast-container').appendChild(el);
    setTimeout(() => el.remove(), 3100);
  }

  // ── Audio Context ────────────────────────────────────────────────────────────
  function ensureAudioContext() {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }
  }

  // ── File Handling ────────────────────────────────────────────────────────────
  function handleFile(file) {
    if (!file || !file.type.startsWith('audio/')) {
      // Also accept common extensions when MIME is not set
      const ext = file ? file.name.split('.').pop().toLowerCase() : '';
      if (!['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'webm', 'wma'].includes(ext)) {
        showToast('Please select an audio file', 'error');
        return;
      }
    }
    fileName = file.name;
    showSection('loading');
    loadingText.textContent = 'Decoding audio…';

    ensureAudioContext();

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        audioBuffer = await audioContext.decodeAudioData(e.target.result);
        showSection('editor');
        initEditor();
      } catch (err) {
        showToast('Failed to decode audio: ' + err.message, 'error');
        showSection('upload');
      }
    };
    reader.onerror = () => {
      showToast('Failed to read file', 'error');
      showSection('upload');
    };
    reader.readAsArrayBuffer(file);
  }

  function showSection(name) {
    uploadSection.classList.toggle('hidden', name !== 'upload');
    loadingSection.classList.toggle('hidden', name !== 'loading');
    editorSection.classList.toggle('hidden', name !== 'editor');
  }

  // ── Editor Init ──────────────────────────────────────────────────────────────
  function initEditor() {
    fileNameEl.textContent = fileName;
    fileDurationEl.textContent = formatTime(audioBuffer.duration);
    totalTimeEl.textContent = formatTime(audioBuffer.duration);
    currentTimeEl.textContent = '0:00.0';
    segments = [];
    segmentsPanel.classList.add('hidden');
    zoomLevel = 1;
    fitZoom();
    drawWaveform();
    drawOverlay();
    drawTimeRuler();
  }

  function fitZoom() {
    const containerWidth = waveformWrapper.clientWidth;
    zoomLevel = containerWidth / (audioBuffer.duration * BASE_PPS);
    if (zoomLevel < 0.01) zoomLevel = 0.01;
  }

  // ── Waveform Drawing ─────────────────────────────────────────────────────────
  function drawWaveform() {
    const ctx = waveformCanvas.getContext('2d');
    const width = Math.max(Math.ceil(audioBuffer.duration * pps()), waveformWrapper.clientWidth);
    const height = waveformCanvas.offsetHeight || 180;
    const dpr = window.devicePixelRatio || 1;

    waveformCanvas.width = width * dpr;
    waveformCanvas.height = height * dpr;
    waveformCanvas.style.width = width + 'px';
    ctx.scale(dpr, dpr);

    overlayCanvas.width = width * dpr;
    overlayCanvas.height = height * dpr;
    overlayCanvas.style.width = width + 'px';

    // Merge all channels
    const rawData = audioBuffer.getChannelData(0);
    const samples = rawData.length;
    const step = Math.max(1, Math.floor(samples / width));
    const mid = height / 2;

    // Draw background
    ctx.fillStyle = 'transparent';
    ctx.clearRect(0, 0, width, height);

    // Draw center line
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(width, mid);
    ctx.stroke();

    // Draw waveform bars
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(124, 58, 237, 0.9)');
    gradient.addColorStop(0.5, 'rgba(167, 139, 250, 0.7)');
    gradient.addColorStop(1, 'rgba(45, 212, 191, 0.9)');

    ctx.fillStyle = gradient;

    for (let i = 0; i < width; i++) {
      const start = i * step;
      let min = 0, max = 0;
      for (let j = start; j < start + step && j < samples; j++) {
        const val = rawData[j];
        if (val < min) min = val;
        if (val > max) max = val;
      }
      const barTop = mid + min * mid * 0.9;
      const barBottom = mid + max * mid * 0.9;
      const barHeight = Math.max(1, barBottom - barTop);
      ctx.fillRect(i, barTop, 1, barHeight);
    }
  }

  // ── Overlay Drawing (silence regions + segment handles) ──────────────────
  function drawOverlay() {
    const ctx = overlayCanvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const width = parseInt(overlayCanvas.style.width);
    const height = overlayCanvas.offsetHeight || 180;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // Draw segment regions
    segments.forEach((seg, idx) => {
      const x1 = seg.start * pps();
      const x2 = seg.end * pps();
      const w = x2 - x1;

      // Segment fill
      const hue = (idx * 47 + 200) % 360;
      ctx.fillStyle = `hsla(${hue}, 60%, 55%, 0.08)`;
      ctx.fillRect(x1, 0, w, height);

      // Segment borders
      ctx.strokeStyle = `hsla(${hue}, 60%, 55%, 0.5)`;
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x1, 0); ctx.lineTo(x1, height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x2, 0); ctx.lineTo(x2, height);
      ctx.stroke();

      // Segment label
      if (w > 30) {
        ctx.fillStyle = `hsla(${hue}, 60%, 75%, 0.85)`;
        ctx.font = '600 11px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${idx + 1}`, x1 + w / 2, 14);
      }
    });
  }

  // ── Time Ruler ───────────────────────────────────────────────────────────────
  function drawTimeRuler() {
    const width = parseInt(waveformCanvas.style.width) || waveformWrapper.clientWidth;
    timeRuler.innerHTML = '';
    timeRuler.style.width = width + 'px';

    const interval = getTickInterval();
    const duration = audioBuffer.duration;

    for (let t = 0; t <= duration; t += interval) {
      const x = t * pps();
      const tick = document.createElement('span');
      tick.style.cssText = `position:absolute;left:${x}px;top:2px;transform:translateX(-50%);white-space:nowrap`;
      tick.textContent = formatTime(t);
      timeRuler.appendChild(tick);
    }
  }

  function getTickInterval() {
    const pixPerSec = pps();
    if (pixPerSec > 200) return 1;
    if (pixPerSec > 80) return 2;
    if (pixPerSec > 40) return 5;
    if (pixPerSec > 15) return 10;
    if (pixPerSec > 5) return 30;
    return 60;
  }

  // ── Silence Detection ────────────────────────────────────────────────────────
  function detectSilence() {
    if (!audioBuffer) return;

    const thresholdDb = parseFloat(thresholdInput.value);
    const minSilMs = parseFloat(minSilInput.value);
    const paddingMs = parseFloat(paddingInput.value);

    const threshold = Math.pow(10, thresholdDb / 20);
    const minSilSamples = Math.floor((minSilMs / 1000) * audioBuffer.sampleRate);
    const paddingSamples = Math.floor((paddingMs / 1000) * audioBuffer.sampleRate);

    const data = audioBuffer.getChannelData(0);
    const len = data.length;

    // Find silence regions
    const silenceRegions = [];
    let silStart = -1;
    // Use a window for RMS
    const windowSize = Math.floor(audioBuffer.sampleRate * 0.01); // 10ms window

    for (let i = 0; i < len; i += windowSize) {
      let rms = 0;
      const end = Math.min(i + windowSize, len);
      for (let j = i; j < end; j++) {
        rms += data[j] * data[j];
      }
      rms = Math.sqrt(rms / (end - i));

      if (rms < threshold) {
        if (silStart === -1) silStart = i;
      } else {
        if (silStart !== -1) {
          const silLen = i - silStart;
          if (silLen >= minSilSamples) {
            silenceRegions.push({ start: silStart, end: i });
          }
          silStart = -1;
        }
      }
    }
    // Handle trailing silence
    if (silStart !== -1 && (len - silStart) >= minSilSamples) {
      silenceRegions.push({ start: silStart, end: len });
    }

    // Build segments (the non-silent parts)
    segments = [];
    const sr = audioBuffer.sampleRate;

    if (silenceRegions.length === 0) {
      // No silence found — entire file is one segment
      segments.push({ start: 0, end: audioBuffer.duration, name: 'Segment 1' });
    } else {
      // Before first silence
      const firstSilStart = silenceRegions[0].start;
      if (firstSilStart > paddingSamples) {
        segments.push({
          start: 0,
          end: clamp((firstSilStart + paddingSamples) / sr, 0, audioBuffer.duration),
          name: ``
        });
      }

      // Between silences
      for (let i = 0; i < silenceRegions.length - 1; i++) {
        const segStart = clamp((silenceRegions[i].end - paddingSamples) / sr, 0, audioBuffer.duration);
        const segEnd = clamp((silenceRegions[i + 1].start + paddingSamples) / sr, 0, audioBuffer.duration);
        if (segEnd - segStart > 0.05) { // skip tiny fragments
          segments.push({ start: segStart, end: segEnd, name: `` });
        }
      }

      // After last silence
      const lastSilEnd = silenceRegions[silenceRegions.length - 1].end;
      if (lastSilEnd < len - paddingSamples) {
        segments.push({
          start: clamp((lastSilEnd - paddingSamples) / sr, 0, audioBuffer.duration),
          end: audioBuffer.duration,
          name: ``
        });
      }
    }

    renderSegments();
    drawOverlay();
    renderTrimHandles();
    showToast(`Found ${segments.length} segment${segments.length !== 1 ? 's' : ''}`);
  }

  // ── Segment List Rendering ───────────────────────────────────────────────────
  function renderSegments() {
    segmentsPanel.classList.toggle('hidden', segments.length === 0);
    segmentCount.textContent = segments.length;
    segmentsList.innerHTML = '';
    updatePrefixPreview();

    segments.forEach((seg, idx) => {
      const li = document.createElement('li');
      li.className = 'segment-card';
      li.id = `segment-card-${idx}`;
      li.style.animationDelay = `${idx * 0.05}s`;

      const dur = seg.end - seg.start;

      li.innerHTML = `
        <div class="segment-number">${idx + 1}</div>
        <div class="segment-info">
          <input type="text" class="segment-name-input" id="seg-name-${idx}" value="${seg.name}" spellcheck="false">
          <div class="segment-meta">
            <div class="segment-time-inputs">
              <input type="text" class="segment-time-input" id="seg-start-${idx}" value="${formatTimeFull(seg.start)}" title="Start time">
              <span class="segment-time-sep">→</span>
              <input type="text" class="segment-time-input" id="seg-end-${idx}" value="${formatTimeFull(seg.end)}" title="End time">
            </div>
            <span>Duration: ${formatTime(dur)}</span>
          </div>
        </div>
        <div class="segment-actions">
          <button class="btn-icon" title="Play this segment" data-action="play" data-idx="${idx}">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M5 3l11 6-11 6V3z" fill="currentColor"/></svg>
          </button>
          <button class="btn-icon" title="Download this segment" data-action="download" data-idx="${idx}">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M9 2v9m0 0l-3-3m3 3l3-3M3 13v1.5A1.5 1.5 0 004.5 16h9a1.5 1.5 0 001.5-1.5V13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button class="btn-danger-icon" title="Delete this segment" data-action="delete" data-idx="${idx}">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </div>
      `;

      segmentsList.appendChild(li);

      // Name input event
      const nameInput = li.querySelector(`#seg-name-${idx}`);
      nameInput.addEventListener('change', () => {
        seg.name = nameInput.value.trim() || `Segment ${idx + 1}`;
        nameInput.value = seg.name;
        updatePrefixPreview();
      });

      // Time input events
      const startInput = li.querySelector(`#seg-start-${idx}`);
      const endInput = li.querySelector(`#seg-end-${idx}`);

      startInput.addEventListener('change', () => {
        const val = parseTimeInput(startInput.value);
        if (val >= 0 && val < seg.end) {
          seg.start = clamp(val, 0, audioBuffer.duration);
          startInput.value = formatTimeFull(seg.start);
          refreshAfterEdit();
        } else {
          startInput.value = formatTimeFull(seg.start);
        }
      });

      endInput.addEventListener('change', () => {
        const val = parseTimeInput(endInput.value);
        if (val > seg.start && val <= audioBuffer.duration) {
          seg.end = clamp(val, 0, audioBuffer.duration);
          endInput.value = formatTimeFull(seg.end);
          refreshAfterEdit();
        } else {
          endInput.value = formatTimeFull(seg.end);
        }
      });
    });
  }

  function refreshAfterEdit() {
    drawOverlay();
    renderTrimHandles();
    renderSegments();
  }

  // ── Batch Names ──────────────────────────────────────────────────────────────
  function parseBatchNames() {
    batchWords = batchNamesInput.value
      .split('.')
      .map(w => w.trim())
      .filter(w => w.length > 0);
  }

  function applyBatchNames() {
    parseBatchNames();
    segments.forEach((seg, idx) => {
      if (idx < batchWords.length) {
        seg.name = batchWords[idx];
      }
    });
    renderSegments();
    showToast(`Applied ${Math.min(batchWords.length, segments.length)} name${Math.min(batchWords.length, segments.length) !== 1 ? 's' : ''}`);
  }

  function reapplyBatchNames() {
    if (batchWords.length === 0) return;
    segments.forEach((seg, idx) => {
      seg.name = idx < batchWords.length ? batchWords[idx] : '';
    });
  }

  // ── Trim Handles on Waveform ─────────────────────────────────────────────────
  function renderTrimHandles() {
    // Remove old handles
    waveformWrapper.querySelectorAll('.trim-handle').forEach(el => el.remove());

    segments.forEach((seg, idx) => {
      createHandle(seg, idx, 'start');
      createHandle(seg, idx, 'end');
    });
  }

  function createHandle(seg, idx, side) {
    const handle = document.createElement('div');
    handle.className = `trim-handle trim-handle-${side === 'start' ? 'left' : 'right'}`;
    const pos = side === 'start' ? seg.start * pps() : seg.end * pps();
    handle.style.left = (pos - 4) + 'px';
    waveformWrapper.appendChild(handle);

    let dragging = false;
    let startX = 0;
    let origTime = 0;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      startX = e.clientX;
      origTime = side === 'start' ? seg.start : seg.end;
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dt = dx / pps();
      let newTime = origTime + dt;

      if (side === 'start') {
        newTime = clamp(newTime, 0, seg.end - 0.05);
        seg.start = newTime;
      } else {
        newTime = clamp(newTime, seg.start + 0.05, audioBuffer.duration);
        seg.end = newTime;
      }

      const newPos = (side === 'start' ? seg.start : seg.end) * pps();
      handle.style.left = (newPos - 4) + 'px';
      drawOverlay();
    });

    document.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        renderSegments();
        renderTrimHandles();
      }
    });
  }

  // ── Playback ─────────────────────────────────────────────────────────────────
  function playFromTime(startTime, endTime) {
    stopPlayback();
    ensureAudioContext();

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);

    playbackOffset = startTime;
    playbackStart = audioContext.currentTime;

    const duration = endTime !== undefined ? endTime - startTime : undefined;
    source.start(0, startTime, duration);

    playbackSource = source;
    isPlaying = true;
    updatePlayIcon();

    source.onended = () => {
      if (playbackSource === source) {
        isPlaying = false;
        playbackSource = null;
        updatePlayIcon();
        cancelAnimationFrame(animFrameId);

        // If playing a segment, highlight is done
        if (currentlyPlayingSegIdx >= 0) {
          const card = $(`#segment-card-${currentlyPlayingSegIdx}`);
          if (card) card.classList.remove('playing');
          currentlyPlayingSegIdx = -1;
        }
      }
    };

    updatePlayhead();
  }

  function stopPlayback() {
    if (playbackSource) {
      try { playbackSource.stop(); } catch (_) {}
      playbackSource = null;
    }
    isPlaying = false;
    cancelAnimationFrame(animFrameId);
    updatePlayIcon();

    if (currentlyPlayingSegIdx >= 0) {
      const card = $(`#segment-card-${currentlyPlayingSegIdx}`);
      if (card) card.classList.remove('playing');
      currentlyPlayingSegIdx = -1;
    }
  }

  function togglePlayback() {
    if (isPlaying) {
      stopPlayback();
    } else {
      const startTime = getCurrentPlaybackTime();
      playFromTime(startTime);
    }
  }

  function getCurrentPlaybackTime() {
    if (isPlaying && playbackSource) {
      return playbackOffset + (audioContext.currentTime - playbackStart);
    }
    return playbackOffset;
  }

  function updatePlayIcon() {
    iconPlay.classList.toggle('hidden', isPlaying);
    iconPause.classList.toggle('hidden', !isPlaying);
  }

  function updatePlayhead() {
    if (!isPlaying) return;
    const time = getCurrentPlaybackTime();
    const x = time * pps();
    playhead.style.left = x + 'px';
    currentTimeEl.textContent = formatTime(time);

    // Auto-scroll waveform wrapper to keep playhead visible
    const wrapperLeft = waveformWrapper.scrollLeft;
    const wrapperWidth = waveformWrapper.clientWidth;
    if (x > wrapperLeft + wrapperWidth - 50 || x < wrapperLeft) {
      waveformWrapper.scrollLeft = x - 100;
    }

    animFrameId = requestAnimationFrame(updatePlayhead);
  }

  function playSegment(idx) {
    const seg = segments[idx];
    if (!seg) return;

    // Highlight
    currentlyPlayingSegIdx = idx;
    document.querySelectorAll('.segment-card').forEach(c => c.classList.remove('playing'));
    const card = $(`#segment-card-${idx}`);
    if (card) card.classList.add('playing');

    playFromTime(seg.start, seg.end);
  }

  // ── Download ─────────────────────────────────────────────────────────────────
  function downloadSegment(idx) {
    const seg = segments[idx];
    if (!seg) return;

    const mp3Blob = encodeMP3(seg.start, seg.end);
    const url = URL.createObjectURL(mp3Blob);
    const a = document.createElement('a');
    const prefix = prefixInput.value.trim();
    const safeName = seg.name.replace(/[\\/:*?"<>|]/g, '').trim() || `segment_${idx + 1}`;
    a.href = url;
    a.download = `${prefix}${safeName}.mp3`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Downloaded segment ${idx + 1}`);
  }

  function downloadAllSegments() {
    if (segments.length === 0) return;

    segments.forEach((_, idx) => {
      setTimeout(() => downloadSegment(idx), idx * 200);
    });
  }

  function encodeMP3(startSec, endSec) {
    const sampleRate = audioBuffer.sampleRate;
    const numChannels = Math.min(audioBuffer.numberOfChannels, 2); // lamejs supports max 2
    const startSample = Math.floor(startSec * sampleRate);
    const endSample = Math.min(Math.floor(endSec * sampleRate), audioBuffer.length);
    const numSamples = endSample - startSample;
    const kbps = 128;

    // Convert float samples to Int16
    function floatTo16Bit(floatArr, start, length) {
      const int16 = new Int16Array(length);
      for (let i = 0; i < length; i++) {
        let s = floatArr[start + i];
        s = Math.max(-1, Math.min(1, s));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      return int16;
    }

    const left = floatTo16Bit(audioBuffer.getChannelData(0), startSample, numSamples);
    const right = numChannels === 2
      ? floatTo16Bit(audioBuffer.getChannelData(1), startSample, numSamples)
      : null;

    const mp3Encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, kbps);
    const mp3Data = [];
    const blockSize = 1152;

    for (let i = 0; i < numSamples; i += blockSize) {
      const leftChunk = left.subarray(i, Math.min(i + blockSize, numSamples));
      let mp3buf;
      if (numChannels === 2) {
        const rightChunk = right.subarray(i, Math.min(i + blockSize, numSamples));
        mp3buf = mp3Encoder.encodeBuffer(leftChunk, rightChunk);
      } else {
        mp3buf = mp3Encoder.encodeBuffer(leftChunk);
      }
      if (mp3buf.length > 0) {
        mp3Data.push(mp3buf);
      }
    }

    const end = mp3Encoder.flush();
    if (end.length > 0) {
      mp3Data.push(end);
    }

    return new Blob(mp3Data, { type: 'audio/mpeg' });
  }

  // ── Click on Waveform to Seek ────────────────────────────────────────────────
  waveformWrapper.addEventListener('click', (e) => {
    if (e.target.classList.contains('trim-handle')) return;
    const rect = waveformCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left + waveformWrapper.scrollLeft;
    const time = clamp(x / pps(), 0, audioBuffer.duration);
    playbackOffset = time;
    playhead.style.left = (time * pps()) + 'px';
    currentTimeEl.textContent = formatTime(time);

    if (isPlaying) {
      playFromTime(time);
    }
  });

  // ── Zoom ─────────────────────────────────────────────────────────────────────
  function zoom(factor) {
    const oldPps = pps();
    const scrollCenter = waveformWrapper.scrollLeft + waveformWrapper.clientWidth / 2;
    const centerTime = scrollCenter / oldPps;

    zoomLevel = clamp(zoomLevel * factor, 0.01, 50);

    drawWaveform();
    drawOverlay();
    drawTimeRuler();
    renderTrimHandles();

    // Restore scroll to keep the center time stable
    const newX = centerTime * pps();
    waveformWrapper.scrollLeft = newX - waveformWrapper.clientWidth / 2;

    // Update playhead position
    playhead.style.left = (getCurrentPlaybackTime() * pps()) + 'px';
  }

  // ── Event Listeners ──────────────────────────────────────────────────────────

  // Upload
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  // Change file
  btnChangeFile.addEventListener('click', () => {
    stopPlayback();
    fileInput.value = '';
    showSection('upload');
  });

  // Settings sliders
  thresholdInput.addEventListener('input', () => {
    thresholdVal.textContent = thresholdInput.value + ' dB';
  });
  $('#threshold-minus').addEventListener('click', () => {
    thresholdInput.value = Math.max(-80, parseInt(thresholdInput.value) - 1);
    thresholdVal.textContent = thresholdInput.value + ' dB';
  });
  $('#threshold-plus').addEventListener('click', () => {
    thresholdInput.value = Math.min(-10, parseInt(thresholdInput.value) + 1);
    thresholdVal.textContent = thresholdInput.value + ' dB';
  });
  minSilInput.addEventListener('input', () => {
    minSilVal.textContent = minSilInput.value + ' ms';
  });
  paddingInput.addEventListener('input', () => {
    paddingVal.textContent = paddingInput.value + ' ms';
  });

  // Initialize prefix input from hardcoded default
  prefixInput.value = FILENAME_PREFIX;

  // Prefix preview
  function updatePrefixPreview() {
    const prefix = prefixInput.value.trim();
    const firstName = segments.length > 0 ? segments[0].name : 'Segment 1';
    const safeName = firstName.replace(/[\\/:*?"<>|]/g, '').trim() || 'Segment 1';
    prefixPreview.textContent = `${prefix}${safeName}.mp3`;
  }
  prefixInput.addEventListener('input', updatePrefixPreview);

  // Detect
  btnDetect.addEventListener('click', detectSilence);

  // Transport
  btnPlay.addEventListener('click', togglePlayback);
  btnStop.addEventListener('click', () => {
    stopPlayback();
    playbackOffset = 0;
    playhead.style.left = '0px';
    currentTimeEl.textContent = '0:00.0';
  });

  // Batch names
  btnApplyNames.addEventListener('click', applyBatchNames);
  btnDownloadAll.addEventListener('click', downloadAllSegments);

  // Zoom
  btnZoomIn.addEventListener('click', () => zoom(1.5));
  btnZoomOut.addEventListener('click', () => zoom(1 / 1.5));
  btnZoomFit.addEventListener('click', () => {
    fitZoom();
    drawWaveform();
    drawOverlay();
    drawTimeRuler();
    renderTrimHandles();
    playhead.style.left = (getCurrentPlaybackTime() * pps()) + 'px';
  });

  // Segment actions (delegated)
  segmentsList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const idx = parseInt(btn.dataset.idx, 10);

    if (action === 'play') playSegment(idx);
    else if (action === 'download') downloadSegment(idx);
    else if (action === 'delete') {
      segments.splice(idx, 1);
      reapplyBatchNames();
      refreshAfterEdit();
      showToast(`Deleted segment ${idx + 1}`);
    }
  });

  // Play all / Download all
  btnPlayAll.addEventListener('click', () => {
    if (segments.length === 0) return;
    playSegment(0);
    // Chain playback
    let idx = 0;
    const chainPlay = () => {
      if (!isPlaying && idx < segments.length - 1) {
        idx++;
        playSegment(idx);
      }
    };
    // Check periodically
    const interval = setInterval(() => {
      if (idx >= segments.length - 1 && !isPlaying) {
        clearInterval(interval);
        return;
      }
      chainPlay();
    }, 100);
  });

  btnDownloadAll.addEventListener('click', downloadAllSegments);

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlayback();
    }
  });

  // Resize handler
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (audioBuffer) {
        drawWaveform();
        drawOverlay();
        drawTimeRuler();
        renderTrimHandles();
      }
    }, 200);
  });

})();
