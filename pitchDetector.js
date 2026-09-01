/**
 * pitchDetector.js
 * Módulo de detección de tono y utilidades de teoría musical
 */

// Nombres de notas estándar
export const NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const NOTE_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
export const NOTE_NAMES_SOLFEGE = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];

// Definición de escalas por intervalos de semitonos (desde la tónica)
export const SCALES = {
  chromatic: { name: 'Cromática (Todas las notas)', intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  major: { name: 'Mayor (Jónica)', intervals: [0, 2, 4, 5, 7, 9, 11] },
  minor_natural: { name: 'Menor Natural (Eólica)', intervals: [0, 2, 3, 5, 7, 8, 10] },
  minor_harmonic: { name: 'Menor Armónica', intervals: [0, 2, 3, 5, 7, 8, 11] },
  minor_melodic: { name: 'Menor Melódica', intervals: [0, 2, 3, 5, 7, 9, 11] },
  pentatonic_major: { name: 'Pentatónica Mayor', intervals: [0, 2, 4, 7, 9] },
  pentatonic_minor: { name: 'Pentatónica Menor', intervals: [0, 3, 5, 7, 10] },
  blues: { name: 'Blues', intervals: [0, 3, 5, 6, 7, 10] },
  dorian: { name: 'Dórica', intervals: [0, 2, 3, 5, 7, 9, 10] },
  phrygian: { name: 'Frigia', intervals: [0, 1, 3, 5, 7, 8, 10] },
  lydian: { name: 'Lidia', intervals: [0, 2, 4, 6, 7, 9, 11] },
  mixolydian: { name: 'Mixolidia', intervals: [0, 2, 4, 5, 7, 9, 10] },
  locrian: { name: 'Locria', intervals: [0, 1, 3, 5, 6, 8, 10] },
};

/**
 * Convierte una frecuencia en Hz a número MIDI fraccionario (A4 = 440Hz = MIDI 69)
 */
export function frequencyToMidi(frequency, a4 = 440) {
  return 69 + 12 * Math.log2(frequency / a4);
}

/**
 * Convierte un número MIDI a frecuencia en Hz
 */
export function midiToFrequency(midi, a4 = 440) {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Obtiene la información detallada de una nota a partir de la frecuencia
 */
export function getNoteDetails(frequency, a4 = 440, notationType = 'sharp') {
  if (!frequency || frequency <= 0) return null;

  const midiFloat = frequencyToMidi(frequency, a4);
  const midiRounded = Math.round(midiFloat);
  const cents = Math.round((midiFloat - midiRounded) * 100);

  const noteIndex = ((midiRounded % 12) + 12) % 12;
  const octave = Math.floor(midiRounded / 12) - 1;

  let noteNames = NOTE_NAMES_SHARP;
  if (notationType === 'flat') noteNames = NOTE_NAMES_FLAT;
  if (notationType === 'solfege') noteNames = NOTE_NAMES_SOLFEGE;

  const noteName = noteNames[noteIndex];
  const isAccidental = [1, 3, 6, 8, 10].includes(noteIndex);

  return {
    frequency,
    midiFloat,
    midiRounded,
    cents,
    noteIndex,
    noteName,
    fullName: `${noteName}${octave}`,
    octave,
    isAccidental,
    targetFrequency: midiToFrequency(midiRounded, a4)
  };
}

/**
 * Obtiene el conjunto de notas MIDI que pertenecen a una escala dada
 */
export function getScaleMidiNotes(rootNoteIndex, scaleKey, minMidi = 36, maxMidi = 84) {
  const scale = SCALES[scaleKey] || SCALES.chromatic;
  const scaleSet = new Set();
  const intervals = scale.intervals;

  for (let midi = minMidi; midi <= maxMidi; midi++) {
    const pitchClass = ((midi % 12) + 12) % 12;
    const intervalFromRoot = ((pitchClass - rootNoteIndex) % 12 + 12) % 12;
    if (intervals.includes(intervalFromRoot)) {
      scaleSet.add(midi);
    }
  }

  return scaleSet;
}

/**
 * Algoritmo de detección de tono por autocorrelación normalizada (MPM / YIN-style)
 */
export function autoCorrelate(buffer, sampleRate, rmsThreshold = 0.01) {
  const SIZE = buffer.length;
  let sumOfSquares = 0;
  for (let i = 0; i < SIZE; i++) {
    const val = buffer[i];
    sumOfSquares += val * val;
  }

  const rms = Math.sqrt(sumOfSquares / SIZE);
  if (rms < rmsThreshold) {
    return { frequency: -1, clarity: 0, rms };
  }

  // Recorte de los extremos para evitar falsos positivos
  let r1 = 0;
  let r2 = SIZE - 1;
  const thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++) {
    if (Math.abs(buffer[i]) < thres) {
      r1 = i;
      break;
    }
  }
  for (let i = 1; i < SIZE / 2; i++) {
    if (Math.abs(buffer[SIZE - i]) < thres) {
      r2 = SIZE - i;
      break;
    }
  }

  const trimmedBuffer = buffer.slice(r1, r2);
  const c = new Float32Array(trimmedBuffer.length).fill(0);

  for (let i = 0; i < trimmedBuffer.length; i++) {
    for (let j = 0; j < trimmedBuffer.length - i; j++) {
      c[i] += trimmedBuffer[j] * trimmedBuffer[j + i];
    }
  }

  // Buscar el primer mínimo
  let d = 0;
  while (c[d] > c[d + 1]) {
    d++;
    if (d >= c.length - 1) return { frequency: -1, clarity: 0, rms };
  }

  // Buscar el pico máximo después del mínimo
  let maxval = -1;
  let maxpos = -1;
  for (let i = d; i < c.length; i++) {
    if (c[i] > maxval) {
      maxval = c[i];
      maxpos = i;
    }
  }

  if (maxpos === -1 || maxval <= 0) {
    return { frequency: -1, clarity: 0, rms };
  }

  // Interpolación parabólica para precisión sub-muestra
  let T0 = maxpos;
  const x1 = c[T0 - 1] || 0;
  const x2 = c[T0];
  const x3 = c[T0 + 1] || 0;

  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  if (a !== 0) {
    T0 = T0 - b / (2 * a);
  }

  const frequency = sampleRate / T0;
  const clarity = maxval / c[0];

  // Rango audible musical estándar (25Hz a 4200Hz)
  if (frequency >= 25 && frequency <= 4200 && clarity > 0.4) {
    return { frequency, clarity, rms };
  }

  return { frequency: -1, clarity, rms };
}
