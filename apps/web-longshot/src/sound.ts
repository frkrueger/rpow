let ctx: AudioContext | null = null;
let muted = (typeof localStorage !== 'undefined' && localStorage.getItem('longshot:muted') === '1');

function ac(): AudioContext {
  if (!ctx) ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  return ctx;
}

function envelopedTone(freq: number, durationMs: number, type: OscillatorType, master = 0.15) {
  if (muted) return;
  const a = ac();
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.value = 0;
  osc.connect(gain).connect(a.destination);
  const now = a.currentTime;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(master, now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.001, now + durationMs / 1000);
  osc.start(now);
  osc.stop(now + durationMs / 1000 + 0.05);
}

function sweepTone(startFreq: number, endFreq: number, durationMs: number, type: OscillatorType, master = 0.15) {
  if (muted) return;
  const a = ac();
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = type;
  gain.gain.value = 0;
  osc.connect(gain).connect(a.destination);
  const now = a.currentTime;
  osc.frequency.setValueAtTime(startFreq, now);
  osc.frequency.linearRampToValueAtTime(endFreq, now + durationMs / 1000);
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(master, now + 0.005);
  gain.gain.linearRampToValueAtTime(0, now + durationMs / 1000);
  osc.start(now);
  osc.stop(now + durationMs / 1000 + 0.05);
}

export function playSpin() { envelopedTone(440, 80, 'square'); }

export function playWin() {
  envelopedTone(660, 120, 'square');
  setTimeout(() => envelopedTone(990, 160, 'square'), 110);
}

export function playLose() {
  sweepTone(220, 130, 250, 'sawtooth');
}

export function isMuted(): boolean { return muted; }

export function toggleMute(): boolean {
  muted = !muted;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('longshot:muted', muted ? '1' : '0');
  }
  return muted;
}
