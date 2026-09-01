import {
  NOTE_NAMES_SHARP,
  NOTE_NAMES_FLAT,
  NOTE_NAMES_SOLFEGE,
  SCALES,
  autoCorrelate,
  getNoteDetails,
  getScaleMidiNotes,
  midiToFrequency
} from './pitchDetector.js';

// Estado de la aplicación
const state = {
  audioContext: null,
  analyser: null,
  microphone: null,
  stream: null,
  isListening: false,
  isPaused: false,
  buffer: null,
  sampleRate: 44100,

  // Teoría musical y configuración
  a4Freq: 440,
  notation: 'sharp', // 'sharp', 'flat', 'solfege'
  rootNote: 0, // 0 = C, 1 = C#, etc.
  scaleType: 'chromatic', // clave de SCALES
  
  // Rango de visualización en MIDI
  minMidi: 48, // C3
  maxMidi: 72, // C5
  zoomSpeed: 2.5, // Velocidad de desplazamiento horizontal (px/frame)
  sensitivity: 0.015, // Umbral RMS mínimo

  // Historial de puntos de pitch para el gráfico horizontal
  history: [], // Array de { x, midiFloat, cents, clarity, timestamp, inScale }
  currentNote: null,
  scaleMidiSet: new Set()
};

// Elementos DOM
const canvas = document.getElementById('pitchCanvas');
const ctx = canvas.getContext('2d', { alpha: false });

const btnToggleMic = document.getElementById('btnToggleMic');
const btnPause = document.getElementById('btnPause');
const btnClear = document.getElementById('btnClear');
const selectScale = document.getElementById('selectScale');
const selectRoot = document.getElementById('selectRoot');
const selectNotation = document.getElementById('selectNotation');
const selectRange = document.getElementById('selectRange');
const inputSensitivity = document.getElementById('inputSensitivity');
const inputSpeed = document.getElementById('inputSpeed');

// HUD DOM
const hudNote = document.getElementById('hudNote');
const hudOctave = document.getElementById('hudOctave');
const hudFreq = document.getElementById('hudFreq');
const hudCents = document.getElementById('hudCents');
const centsBar = document.getElementById('centsBar');
const micVolumeLevel = document.getElementById('micVolumeLevel');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');

/**
 * Inicializar selectores y estado
 */
function initUI() {
  // Llenar selector de notas raíz
  selectRoot.innerHTML = '';
  NOTE_NAMES_SHARP.forEach((note, idx) => {
    const opt = document.createElement('option');
    opt.value = idx;
    opt.textContent = note;
    selectRoot.appendChild(opt);
  });

  // Llenar selector de escalas
  selectScale.innerHTML = '';
  Object.keys(SCALES).forEach(key => {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = SCALES[key].name;
    selectScale.appendChild(opt);
  });

  updateScaleSet();
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Event Listeners
  btnToggleMic.addEventListener('click', toggleMicrophone);
  btnPause.addEventListener('click', togglePause);
  btnClear.addEventListener('click', clearHistory);

  selectRoot.addEventListener('change', (e) => {
    state.rootNote = parseInt(e.target.value);
    updateScaleSet();
  });

  selectScale.addEventListener('change', (e) => {
    state.scaleType = e.target.value;
    const badge = document.getElementById('badgeScale');
    if (badge && SCALES[state.scaleType]) {
      badge.textContent = SCALES[state.scaleType].name.split(' ')[0];
    }
    updateScaleSet();
  });

  selectNotation.addEventListener('change', (e) => {
    state.notation = e.target.value;
    updateNoteLabels();
  });

  selectRange.addEventListener('change', (e) => {
    const [min, max] = e.target.value.split('-').map(Number);
    state.minMidi = min;
    state.maxMidi = max;
    updateScaleSet();
  });

  inputSensitivity.addEventListener('input', (e) => {
    // Escala inversa: mayor valor slider = menor umbral (más sensible)
    state.sensitivity = 0.05 - (parseFloat(e.target.value) * 0.048);
  });

  inputSpeed.addEventListener('input', (e) => {
    state.zoomSpeed = parseFloat(e.target.value);
  });

  // Loop de renderizado
  requestAnimationFrame(animationLoop);
}

function updateScaleSet() {
  state.scaleMidiSet = getScaleMidiNotes(state.rootNote, state.scaleType, 12, 108);
}

function updateNoteLabels() {
  let noteList = NOTE_NAMES_SHARP;
  if (state.notation === 'flat') noteList = NOTE_NAMES_FLAT;
  if (state.notation === 'solfege') noteList = NOTE_NAMES_SOLFEGE;

  Array.from(selectRoot.options).forEach((opt, idx) => {
    opt.textContent = noteList[idx];
  });
}

function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
}

/**
 * Control del Micrófono y Web Audio
 */
async function toggleMicrophone() {
  if (state.isListening) {
    stopAudio();
    btnToggleMic.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
      Iniciar Micrófono
    `;
    btnToggleMic.classList.remove('recording');
    statusDot.classList.remove('active');
    statusText.textContent = 'Detenido';
  } else {
    try {
      await startAudio();
      btnToggleMic.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
        Detener Micrófono
      `;
      btnToggleMic.classList.add('recording');
      statusDot.classList.add('active');
      statusText.textContent = 'Escuchando en tiempo real';
    } catch (err) {
      alert('No se pudo acceder al micrófono: ' + err.message);
      console.error(err);
    }
  }
}

async function startAudio() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  state.audioContext = new AudioContext();
  state.sampleRate = state.audioContext.sampleRate;

  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  });

  state.microphone = state.audioContext.createMediaStreamSource(state.stream);
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = 2048;

  state.microphone.connect(state.analyser);
  state.buffer = new Float32Array(state.analyser.fftSize);
  state.isListening = true;
}

function stopAudio() {
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop());
  }
  if (state.audioContext && state.audioContext.state !== 'closed') {
    state.audioContext.close();
  }
  state.isListening = false;
  state.currentNote = null;
  resetHUD();
}

function togglePause() {
  state.isPaused = !state.isPaused;
  btnPause.classList.toggle('active', state.isPaused);
  btnPause.innerHTML = state.isPaused
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Reanudar`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pausar`;
}

function clearHistory() {
  state.history = [];
}

function resetHUD() {
  hudNote.textContent = '--';
  hudOctave.textContent = '';
  hudFreq.textContent = '0.0 Hz';
  hudCents.textContent = '+0¢';
  centsBar.style.width = '0%';
  micVolumeLevel.style.width = '0%';
}

/**
 * Renderizado de Piano Roll y Trayectoria de Pitch
 */
function animationLoop() {
  processAudioInput();
  renderCanvas();
  requestAnimationFrame(animationLoop);
}

function processAudioInput() {
  if (!state.isListening || !state.analyser || state.isPaused) return;

  state.analyser.getFloatTimeDomainData(state.buffer);
  const result = autoCorrelate(state.buffer, state.sampleRate, state.sensitivity);

  // Actualizar volumen
  const volPercent = Math.min(100, Math.round(result.rms * 500));
  micVolumeLevel.style.width = `${volPercent}%`;

  if (result.frequency > 0) {
    const note = getNoteDetails(result.frequency, state.a4Freq, state.notation);
    state.currentNote = note;

    // Actualizar HUD
    hudNote.textContent = note.noteName;
    hudOctave.textContent = note.octave;
    hudFreq.textContent = `${result.frequency.toFixed(1)} Hz`;
    const sign = note.cents >= 0 ? '+' : '';
    hudCents.textContent = `${sign}${note.cents}¢`;

    // Barra de Cents (-50 a +50)
    const absCents = Math.abs(note.cents);
    const widthPct = (absCents / 50) * 50; // máximo 50% hacia un lado
    centsBar.style.width = `${widthPct}%`;

    if (note.cents < 0) {
      centsBar.style.left = `${50 - widthPct}%`;
      centsBar.className = 'cents-bar flat';
    } else {
      centsBar.style.left = '50%';
      centsBar.className = 'cents-bar sharp';
    }

    if (absCents <= 5) {
      centsBar.className = 'cents-bar in-tune';
    }

    // Agregar punto a la trayectoria histórica
    const inScale = state.scaleMidiSet.has(note.midiRounded);
    state.history.push({
      midiFloat: note.midiFloat,
      cents: note.cents,
      clarity: result.clarity,
      inScale,
      time: performance.now()
    });
  } else {
    // Si no hay voz/instrumento, agregar punto nulo para romper la línea continua
    if (state.history.length > 0 && state.history[state.history.length - 1].midiFloat !== null) {
      state.history.push({ midiFloat: null, time: performance.now() });
    }
  }
}

function midiToY(midi, height, minMidi, maxMidi) {
  const totalSemitones = maxMidi - minMidi;
  const normalized = (midi - minMidi) / totalSemitones;
  return height - (normalized * height);
}

function renderCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;

  // Fondo
  ctx.fillStyle = '#0f1117';
  ctx.fillRect(0, 0, width, height);

  const minM = state.minMidi;
  const maxM = state.maxMidi;
  const laneHeight = height / (maxM - minM);

  // 1. Dibujar Carriles de Notas y Pentagrama/Piano Roll
  const noteList = state.notation === 'flat' ? NOTE_NAMES_FLAT : (state.notation === 'solfege' ? NOTE_NAMES_SOLFEGE : NOTE_NAMES_SHARP);

  for (let m = minM; m <= maxM; m++) {
    const yTop = midiToY(m + 0.5, height, minM, maxM);
    const yCenter = midiToY(m, height, minM, maxM);
    const pitchClass = ((m % 12) + 12) % 12;
    const isAccidental = [1, 3, 6, 8, 10].includes(pitchClass);
    const inScale = state.scaleMidiSet.has(m);
    const isC = pitchClass === 0;

    // Fondo del carril
    if (inScale && state.scaleType !== 'chromatic') {
      ctx.fillStyle = isAccidental ? 'rgba(79, 172, 254, 0.09)' : 'rgba(79, 172, 254, 0.16)';
    } else {
      ctx.fillStyle = isAccidental ? 'rgba(15, 17, 23, 0.6)' : 'rgba(255, 255, 255, 0.03)';
    }
    ctx.fillRect(0, yTop, width, laneHeight);

    // Líneas divisoras
    ctx.beginPath();
    ctx.strokeStyle = isC ? 'rgba(0, 242, 254, 0.35)' : 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = isC ? 1.5 : 1;
    ctx.moveTo(0, yCenter);
    ctx.lineTo(width, yCenter);
    ctx.stroke();

    // Etiquetas de Notas en el lateral izquierdo
    const octave = Math.floor(m / 12) - 1;
    const noteName = noteList[pitchClass];

    ctx.font = isAccidental ? '10px Outfit, sans-serif' : 'bold 12px Outfit, sans-serif';
    ctx.fillStyle = inScale
      ? (isC ? '#00f2fe' : '#e2e8f0')
      : 'rgba(156, 163, 175, 0.35)';

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${noteName}${octave}`, 12, yCenter);

    // Si está en escala, marcar un pequeño indicador visual
    if (inScale && state.scaleType !== 'chromatic') {
      ctx.fillStyle = '#4facfe';
      ctx.beginPath();
      ctx.arc(4, yCenter, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 2. Dibujar Línea de Tiempo / Cabezal de lectura
  const playheadX = width * 0.75; // La nota actual se dibuja al 75% del ancho

  ctx.beginPath();
  ctx.strokeStyle = 'rgba(0, 242, 254, 0.3)';
  ctx.setLineDash([4, 4]);
  ctx.moveTo(playheadX, 0);
  ctx.lineTo(playheadX, height);
  ctx.stroke();
  ctx.setLineDash([]);

  // 3. Desplazar e iterar sobre el historial de pitch
  if (!state.isPaused && state.isListening) {
    // Desplazar puntos hacia la izquierda
    for (let i = 0; i < state.history.length; i++) {
      if (state.history[i].x === undefined) {
        state.history[i].x = playheadX;
      } else {
        state.history[i].x -= state.zoomSpeed;
      }
    }
    // Eliminar puntos que salieron de la pantalla
    state.history = state.history.filter(pt => pt.x === undefined || pt.x > -50);
  }

  // 4. Dibujar Curva Continua de Tono (Pitch Trace con Glow)
  if (state.history.length > 1) {
    ctx.save();
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    let isDrawing = false;

    for (let i = 0; i < state.history.length - 1; i++) {
      const p1 = state.history[i];
      const p2 = state.history[i + 1];

      if (p1.midiFloat === null || p2.midiFloat === null || p1.x === undefined || p2.x === undefined) {
        isDrawing = false;
        continue;
      }

      const y1 = midiToY(p1.midiFloat, height, minM, maxM);
      const y2 = midiToY(p2.midiFloat, height, minM, maxM);

      // Color dinámico según afinación y escala
      ctx.beginPath();
      ctx.moveTo(p1.x, y1);
      ctx.lineTo(p2.x, y2);

      const absCents = Math.abs(p2.cents);
      if (absCents <= 7) {
        ctx.strokeStyle = '#10b981'; // Perfecto verde
        ctx.shadowColor = 'rgba(16, 185, 129, 0.6)';
        ctx.shadowBlur = 10;
      } else if (p2.inScale) {
        ctx.strokeStyle = '#00f2fe'; // Azul/Cyan afinado a la escala
        ctx.shadowColor = 'rgba(0, 242, 254, 0.5)';
        ctx.shadowBlur = 8;
      } else {
        ctx.strokeStyle = '#f59e0b'; // Nota fuera de escala o desviada
        ctx.shadowColor = 'rgba(245, 158, 11, 0.4)';
        ctx.shadowBlur = 6;
      }

      ctx.stroke();
    }
    ctx.restore();
  }

  // 5. Dibujar cursor/punto brillante de la nota en vivo
  if (state.isListening && state.currentNote && !state.isPaused) {
    const currentY = midiToY(state.currentNote.midiFloat, height, minM, maxM);
    
    ctx.save();
    ctx.beginPath();
    ctx.arc(playheadX, currentY, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#00f2fe';
    ctx.shadowColor = '#00f2fe';
    ctx.shadowBlur = 15;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(playheadX, currentY, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();
  }
}

// Iniciar aplicación al cargar el DOM
window.addEventListener('DOMContentLoaded', initUI);
