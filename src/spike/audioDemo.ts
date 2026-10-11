/**
 * Audio Lab (audio.html): drives the procedural audio engine with sliders and cue buttons, shows the live output
 * (spectrum + oscilloscope), the generative score as a piano roll with a playhead, captions, and an offline render
 * with a spectrogram and level/click statistics. Exposes window.__ksAudio for tests/e2e/audio.spec.ts.
 */
import { AUDIO_CUES, AudioEngine, type AudioCue, type AudioState } from '../game/audio/audioEngine';
import { clickScore, countNonFinite, mixDown, peak, rms, spectralCentroid, spectrogramDb } from '../game/audio/analysis';
import { DEFAULT_STATE } from '../game/audio/mappings';
import { DEFAULT_VOLUMES, measureScenario, renderScenario, type Scenario } from '../game/audio/offlineRender';
import { bellsForCycle, chordIndexAt, type Score } from '../game/audio/score';
import { formatNumber, t } from '../game/i18n';

type NumericKey = 'thrust' | 'rcs' | 'speedFraction' | 'hyperspeed' | 'atmosphereDensity' | 'airspeed' | 'scoopHeat';
type Mode = AudioState['mode'];

const SHIP_CUES = new Set<AudioCue>(['mode-change', 'hyperspeed-spool', 'hyperspeed-engage', 'hyperspeed-exit', 'landing-contact']);
const WARN_CUES = new Set<AudioCue>(['scoop-warning', 'heat-critical', 'alert', 'fuel-low']);
const MODES: readonly Mode[] = ['thrusters', 'impulse', 'cruise', 'hyperspeed'];

const pct = (v: number): string => t('audio.demo.percent', { v: Math.round(v * 100) });
const db = (v: number): string => (v > 0 ? t('audio.demo.db', { v: formatNumber(20 * Math.log10(v), 1, 1) }) : '-∞');

const SLIDERS: { key: NumericKey; label: string; max: number; step: number; fmt: (v: number) => string }[] = [
  { key: 'thrust', label: 'audio.demo.thrust', max: 1, step: 0.01, fmt: pct },
  { key: 'rcs', label: 'audio.demo.rcs', max: 1, step: 0.01, fmt: pct },
  { key: 'speedFraction', label: 'audio.demo.speed', max: 1, step: 0.01, fmt: pct },
  { key: 'hyperspeed', label: 'audio.demo.hyper', max: 1, step: 0.01, fmt: pct },
  { key: 'atmosphereDensity', label: 'audio.demo.density', max: 1, step: 0.01, fmt: (v) => formatNumber(v, 2, 2) },
  { key: 'airspeed', label: 'audio.demo.airspeed', max: 600, step: 1, fmt: (v) => t('unit.mps', { v: Math.round(v) }) },
  { key: 'scoopHeat', label: 'audio.demo.heat', max: 1, step: 0.01, fmt: pct },
];

// --- state ------------------------------------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
let seed = Number.parseInt(params.get('seed') ?? '7', 10) || 7;
const state: AudioState = { ...DEFAULT_STATE };
const volumes = { ...DEFAULT_VOLUMES };
let muted = false;
let wantAudio = false;
let engine = makeEngine(seed);

function makeEngine(s: number): AudioEngine {
  const e = new AudioEngine({ seed: s, onCaption: (key, dur) => showCaption(t(key), dur) });
  e.setVolumes(volumes);
  e.setMuted(muted);
  return e;
}

// --- DOM helpers ------------------------------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { cls?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  const { cls, ...rest } = props;
  if (cls) n.className = cls;
  Object.assign(n, rest);
  for (const k of kids) n.append(k);
  return n;
}

function panel(titleKey: string, ...kids: (Node | string)[]): { root: HTMLElement; meta: HTMLElement } {
  const meta = el('span', { cls: 'meta' });
  const root = el('section', { cls: 'panel' }, el('h2', {}, t(titleKey), meta), ...kids);
  root.setAttribute('aria-label', t(titleKey));
  return { root, meta };
}

function setFill(input: HTMLInputElement): void {
  const v = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min));
  input.style.setProperty('--p', `${(v * 100).toFixed(1)}%`);
}

function slider(id: string, labelKey: string, value: number, max: number, step: number, fmt: (v: number) => string, onInput: (v: number) => void): { root: HTMLElement; set: (v: number) => void } {
  const input = el('input', { type: 'range', id, min: '0', max: String(max), step: String(step), value: String(value) });
  const out = el('output');
  out.setAttribute('for', id);
  out.textContent = fmt(value);
  const set = (v: number): void => {
    input.value = String(v);
    out.textContent = fmt(v);
    setFill(input);
  };
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = fmt(v);
    setFill(input);
    onInput(v);
  });
  setFill(input);
  return { root: el('div', { cls: 'ctl' }, el('label', { htmlFor: id }, t(labelKey)), out, input), set };
}

function toggle(labelKey: string, checked: boolean, onChange: (v: boolean) => void): { root: HTMLElement; set: (v: boolean) => void } {
  const input = el('input', { type: 'checkbox', checked });
  input.setAttribute('role', 'switch');
  input.addEventListener('change', () => onChange(input.checked));
  return { root: el('label', { cls: 'toggle' }, input, t(labelKey)), set: (v) => (input.checked = v) };
}

// --- layout -----------------------------------------------------------------------------------------------------

document.title = t('audio.demo.pageTitle');
const app = document.getElementById('app')!;

const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
mark.setAttribute('viewBox', '0 0 30 30');
mark.setAttribute('class', 'lab-mark');
mark.setAttribute('aria-hidden', 'true');
mark.innerHTML =
  '<circle cx="15" cy="15" r="13.5" fill="none" stroke="rgba(127,212,255,.45)"/>' +
  '<path d="M4 15 Q7.5 6 11 15 T18 15 T25 15" fill="none" stroke="#7fd4ff" stroke-width="1.6" stroke-linecap="round"/>' +
  '<circle cx="15" cy="15" r="2" fill="#c49bff"/>';

const startBtn = el('button', { cls: 'btn-start', type: 'button' }, t('audio.demo.start'));
const statusPill = el('span', { cls: 'pill' }, t('audio.demo.status.locked'));
statusPill.setAttribute('role', 'status');
app.append(
  el(
    'header',
    { cls: 'lab-head' },
    el('div', { cls: 'lab-title' }, mark, el('div', {}, el('h1', {}, 'Known Sky ', el('span', { cls: 'accent' }, t('audio.demo.title'))), el('p', {}, t('audio.demo.subtitle')))),
    el('div', { cls: 'lab-actions' }, statusPill, startBtn),
  ),
);

// Ship state.
const sliderSet = new Map<NumericKey, (v: number) => void>();
const stateKids: HTMLElement[] = [];
for (const s of SLIDERS) {
  const c = slider(`s-${s.key}`, s.label, state[s.key], s.max, s.step, s.fmt, (v) => {
    state[s.key] = v;
    sequence = null;
  });
  sliderSet.set(s.key, c.set);
  stateKids.push(c.root);
}
const modeButtons = new Map<Mode, HTMLButtonElement>();
const seg = el('div', { cls: 'seg' });
seg.setAttribute('role', 'group');
seg.setAttribute('aria-label', t('audio.demo.driveMode'));
for (const m of MODES) {
  const b = el('button', { type: 'button' }, t(`audio.drive.${m}`));
  b.addEventListener('click', () => {
    if (state.mode !== m) {
      state.mode = m;
      engine.play('mode-change');
    }
    syncUi();
  });
  modeButtons.set(m, b);
  seg.append(b);
}
const landedToggle = toggle('audio.demo.landed', state.landed, (v) => {
  state.landed = v;
  if (v) engine.play('landing-contact');
});
const jumpBtn = el('button', { cls: 'chip-btn', type: 'button' }, t('audio.demo.jump'));
const descentBtn = el('button', { cls: 'chip-btn', type: 'button' }, t('audio.demo.descent'));
const statePanel = panel(
  'audio.demo.section.state',
  ...stateKids,
  el('div', { cls: 'ctl' }, el('label', {}, t('audio.demo.driveMode'))),
  seg,
  el('div', { cls: 'toggles' }, landedToggle.root),
  el('div', { cls: 'row-btns' }, jumpBtn, descentBtn),
);

// Output scope + captions.
const scopeCanvas = el('canvas');
scopeCanvas.setAttribute('aria-hidden', 'true');
const captionsBox = el('div', { cls: 'captions' });
captionsBox.setAttribute('aria-live', 'polite');
captionsBox.setAttribute('aria-label', t('audio.demo.captionsLabel'));
const hint = el('div', { cls: 'caption hint' }, t('audio.demo.captionsEmpty'));
captionsBox.append(hint);
const scopePanel = panel('audio.demo.section.scope', el('div', { cls: 'scope-wrap' }, scopeCanvas, captionsBox));

// Score.
const scoreCanvas = el('canvas');
scoreCanvas.setAttribute('aria-hidden', 'true');
const scoreMeta = el('div', { cls: 'score-meta' });
const scorePanel = panel('audio.demo.section.score', el('div', { cls: 'score-wrap' }, scoreCanvas), scoreMeta);

// Offline render.
const cueSelect = el('select', {});
cueSelect.setAttribute('aria-label', t('audio.demo.renderCue'));
cueSelect.append(el('option', { value: '' }, t('audio.demo.renderNone')));
for (const c of AUDIO_CUES) cueSelect.append(el('option', { value: c }, t(`audio.cue.${c}`)));
const renderBtn = el('button', { cls: 'chip-btn', type: 'button' }, t('audio.demo.render'));
const spectroCanvas = el('canvas');
spectroCanvas.setAttribute('aria-hidden', 'true');
const statsBox = el('div', { cls: 'stats' });
const offlinePanel = panel('audio.demo.section.offline', el('div', { cls: 'offline-bar' }, renderBtn, cueSelect), el('div', { cls: 'spectro-wrap' }, spectroCanvas), statsBox);

// Cues.
const cueButtons = new Map<AudioCue, HTMLButtonElement>();
const cuesGrid = el('div', { cls: 'cues' });
for (const c of AUDIO_CUES) {
  const b = el('button', { cls: `cue-btn${SHIP_CUES.has(c) ? ' ship' : WARN_CUES.has(c) ? ' warn' : ''}`, type: 'button' }, el('i'), t(`audio.cue.${c}`));
  b.dataset['cue'] = c;
  b.addEventListener('click', () => void fire(c));
  b.addEventListener('pointerenter', () => {
    if (engine.unlocked && c !== 'ui-hover') engine.play('ui-hover');
  });
  cueButtons.set(c, b);
  cuesGrid.append(b);
}
const cuesPanel = panel('audio.demo.section.cues', cuesGrid);

// Mix.
const mixKids: HTMLElement[] = [];
for (const k of ['master', 'music', 'sfx'] as const) {
  mixKids.push(
    slider(`v-${k}`, `audio.demo.${k}`, volumes[k], 1, 0.01, pct, (v) => {
      volumes[k] = v;
      engine.setVolumes(volumes);
    }).root,
  );
}
const muteToggle = toggle('audio.demo.mute', muted, (v) => {
  muted = v;
  engine.setMuted(v);
});
const seedInput = el('input', { type: 'number', id: 'seed', min: '0', max: '999999', value: String(seed) });
seedInput.addEventListener('change', () => {
  const s = Number.parseInt(seedInput.value, 10);
  if (!Number.isFinite(s) || s === seed) return;
  seed = s;
  engine.dispose();
  engine = makeEngine(seed);
  if (wantAudio) void startAudio();
  layoutScore();
});
const mixPanel = panel(
  'audio.demo.section.mix',
  ...mixKids,
  el('div', { cls: 'toggles' }, muteToggle.root),
  el('div', { cls: 'seed-row' }, el('label', { htmlFor: 'seed' }, t('audio.demo.seed')), seedInput),
);
const rulePanel = panel('audio.demo.section.rule', el('p', { cls: 'rule' }, t('audio.demo.rule')));

app.append(
  el(
    'main',
    { cls: 'grid' },
    el('div', { cls: 'col col-state' }, statePanel.root),
    el('div', { cls: 'col col-main' }, scopePanel.root, scorePanel.root, offlinePanel.root),
    el('div', { cls: 'col col-side' }, cuesPanel.root, mixPanel.root, rulePanel.root),
  ),
);

// --- behaviour --------------------------------------------------------------------------------------------------

function syncUi(): void {
  for (const s of SLIDERS) sliderSet.get(s.key)?.(state[s.key]);
  for (const [m, b] of modeButtons) b.setAttribute('aria-pressed', String(state.mode === m));
  landedToggle.set(state.landed);
}

function updateStatus(): void {
  const on = engine.unlocked;
  statusPill.classList.toggle('on', on);
  statusPill.textContent = on ? t('audio.demo.status.running') : typeof AudioContext === 'undefined' ? t('audio.demo.status.unavailable') : t('audio.demo.status.locked');
  startBtn.hidden = on;
}

async function startAudio(): Promise<void> {
  wantAudio = true;
  await engine.unlock();
  updateStatus();
}

async function fire(c: AudioCue): Promise<void> {
  if (!engine.unlocked) await startAudio();
  engine.play(c);
  const b = cueButtons.get(c);
  if (b) {
    b.classList.add('fire');
    setTimeout(() => b.classList.remove('fire'), 450);
  }
}

startBtn.addEventListener('click', () => void startAudio());

const captionTimers: number[] = [];
function showCaption(text: string, durationS: number): void {
  hint.remove();
  const c = el('div', { cls: 'caption' }, text);
  captionsBox.append(c);
  while (captionsBox.children.length > 3) captionsBox.firstElementChild?.remove();
  captionTimers.push(
    window.setTimeout(() => {
      c.classList.add('out');
      window.setTimeout(() => {
        c.remove();
        if (captionsBox.children.length === 0) captionsBox.append(hint);
      }, 480);
    }, durationS * 1000),
  );
}

// Scripted sequences (jump, descent) that move the sliders like the game would.
let sequence: { t: number; fired: Set<string>; run: (t: number, once: (k: string) => boolean) => boolean } | null = null;
const smooth = (x: number): number => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};

jumpBtn.addEventListener('click', () => {
  void startAudio();
  const prev = state.mode === 'hyperspeed' ? 'cruise' : state.mode;
  sequence = {
    t: 0,
    fired: new Set(),
    run: (tt, once) => {
      if (once('spool')) {
        state.mode = 'hyperspeed';
        state.thrust = 0.4;
        engine.play('hyperspeed-spool');
      }
      if (tt < 3.2) state.hyperspeed = smooth(tt / 3.2);
      else if (tt < 8) state.hyperspeed = 1;
      if (tt >= 3.2 && once('engage')) engine.play('hyperspeed-engage');
      if (tt >= 8 && once('exit')) engine.play('hyperspeed-exit');
      if (tt >= 8) state.hyperspeed = Math.max(0, 1 - (tt - 8) / 1.2);
      if (tt >= 9.4) {
        state.hyperspeed = 0;
        state.mode = prev;
        return false;
      }
      return true;
    },
  };
});

descentBtn.addEventListener('click', () => {
  void startAudio();
  sequence = {
    t: 0,
    fired: new Set(),
    run: (tt, once) => {
      if (once('start')) {
        state.mode = 'thrusters';
        state.landed = false;
        state.hyperspeed = 0;
      }
      const k = Math.min(1, tt / 10);
      state.atmosphereDensity = smooth(tt / 7);
      state.airspeed = 4 + 560 * Math.pow(1 - k, 1.6);
      state.thrust = tt < 10 ? 0.3 + 0.4 * smooth((tt - 5) / 4) : Math.max(0, 0.7 - (tt - 10) * 2);
      state.scoopHeat = 0;
      if (tt >= 10 && once('land')) {
        state.landed = true;
        engine.play('landing-contact');
      }
      if (tt >= 11) {
        state.thrust = 0;
        state.airspeed = 3;
        return false;
      }
      return true;
    },
  };
});

function runSequence(dt: number): void {
  if (!sequence) return;
  const s = sequence;
  s.t += dt;
  const once = (k: string): boolean => {
    if (s.fired.has(k)) return false;
    s.fired.add(k);
    return true;
  };
  if (!s.run(s.t, once)) sequence = null;
  syncUi();
}

// --- canvases ---------------------------------------------------------------------------------------------------

function fit(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const h = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

const F_LO = 30;
const F_HI = 16000;
const xOfHz = (f: number, w: number): number => (Math.log(f / F_LO) / Math.log(F_HI / F_LO)) * w;

function freqGrid(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.font = '9px ui-monospace, Menlo, monospace';
  g.textBaseline = 'bottom';
  for (const [f, label] of [
    [100, '100'],
    [1000, '1k'],
    [10000, '10k'],
  ] as const) {
    const x = xOfHz(f, w);
    g.strokeStyle = 'rgba(127,212,255,0.10)';
    g.beginPath();
    g.moveTo(x + 0.5, 0);
    g.lineTo(x + 0.5, h);
    g.stroke();
    g.fillStyle = 'rgba(138,160,192,0.7)';
    g.fillText(label, x + 3, h - 3);
  }
}

let timeData = new Float32Array(2048);
let freqData = new Float32Array(1024);
let meterRms = 0;

function drawScope(): void {
  const g = fit(scopeCanvas);
  const w = scopeCanvas.clientWidth;
  const h = scopeCanvas.clientHeight;
  g.clearRect(0, 0, w, h);
  for (let i = 1; i < 4; i++) {
    g.strokeStyle = i === 2 ? 'rgba(127,212,255,0.12)' : 'rgba(127,212,255,0.05)';
    g.beginPath();
    g.moveTo(0, (h * i) / 4 + 0.5);
    g.lineTo(w, (h * i) / 4 + 0.5);
    g.stroke();
  }
  freqGrid(g, w, h);
  const an = engine.unlocked ? engine.analyser() : null;
  if (!an) {
    g.strokeStyle = 'rgba(127,212,255,0.25)';
    g.beginPath();
    g.moveTo(0, h / 2 + 0.5);
    g.lineTo(w, h / 2 + 0.5);
    g.stroke();
    return;
  }
  if (timeData.length !== an.fftSize) timeData = new Float32Array(an.fftSize);
  if (freqData.length !== an.frequencyBinCount) freqData = new Float32Array(an.frequencyBinCount);
  an.getFloatTimeDomainData(timeData);
  an.getFloatFrequencyData(freqData);
  const nyq = an.context.sampleRate / 2;

  // Spectrum (log frequency), filled.
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(127,212,255,0.42)');
  grad.addColorStop(0.6, 'rgba(196,155,255,0.16)');
  grad.addColorStop(1, 'rgba(196,155,255,0.02)');
  g.beginPath();
  g.moveTo(0, h);
  for (let x = 0; x <= w; x += 2) {
    const f = F_LO * Math.pow(F_HI / F_LO, x / w);
    const bin = Math.min(freqData.length - 1, Math.round((f / nyq) * freqData.length));
    const d = Number.isFinite(freqData[bin]!) ? freqData[bin]! : -140;
    const y = h - Math.max(0, Math.min(1, (d + 110) / 90)) * h * 0.92;
    g.lineTo(x, y);
  }
  g.lineTo(w, h);
  g.closePath();
  g.fillStyle = grad;
  g.fill();
  g.strokeStyle = 'rgba(127,212,255,0.55)';
  g.lineWidth = 1;
  g.stroke();

  // Oscilloscope.
  let s2 = 0;
  for (const v of timeData) s2 += v * v;
  const level = Math.sqrt(s2 / timeData.length);
  meterRms = meterRms * 0.85 + level * 0.15;
  const n = Math.min(timeData.length, 1024);
  g.save();
  g.shadowColor = 'rgba(127,212,255,0.9)';
  g.shadowBlur = 8;
  g.strokeStyle = 'rgba(220,245,255,0.95)';
  g.lineWidth = 1.4;
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * w;
    const y = h / 2 - Math.max(-1, Math.min(1, timeData[i]! * 3)) * h * 0.42;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
  g.restore();

  // Level meter.
  const mw = 5;
  const lv = Math.max(0, Math.min(1, (20 * Math.log10(meterRms + 1e-9) + 60) / 60));
  g.fillStyle = 'rgba(127,212,255,0.12)';
  g.fillRect(w - mw - 6, 8, mw, h - 16);
  g.fillStyle = '#7fd4ff';
  g.fillRect(w - mw - 6, 8 + (h - 16) * (1 - lv), mw, (h - 16) * lv);
  g.fillStyle = 'rgba(216,230,255,0.85)';
  g.font = '10px ui-monospace, Menlo, monospace';
  g.textAlign = 'right';
  g.textBaseline = 'top';
  g.fillText(db(meterRms), w - mw - 12, 7);
  g.textAlign = 'left';
}

let scoreLayout: { score: Score; lo: number; hi: number } | null = null;
function layoutScore(): void {
  const sc = engine.score;
  let lo = 200;
  let hi = 0;
  for (const c of sc.chords) {
    lo = Math.min(lo, c.bass, ...c.notes);
    hi = Math.max(hi, ...c.notes);
  }
  scoreLayout = { score: sc, lo: lo - 3, hi: Math.max(hi + 3, 93) };
}

function drawScore(): void {
  if (!scoreLayout) layoutScore();
  const { score, lo, hi } = scoreLayout!;
  const g = fit(scoreCanvas);
  const w = scoreCanvas.clientWidth;
  const h = scoreCanvas.clientHeight;
  g.clearRect(0, 0, w, h);
  const L = score.loopSeconds;
  const st = engine.stats();
  const mt = st.musicTime;
  const cycle = mt === null ? 0 : Math.floor(mt / L);
  const ph = mt === null ? null : mt - cycle * L;
  const cur = mt === null ? -1 : chordIndexAt(score, mt);
  const padY = 14;
  const yOf = (m: number): number => padY + ((hi - m) / (hi - lo)) * (h - padY - 16);
  const xOf = (s: number): number => 6 + (s / L) * (w - 12);
  const noteH = Math.max(2.5, ((h - padY - 16) / (hi - lo)) * 1.15);

  // Bar grid.
  for (let b = 0; b * score.barSeconds < L; b++) {
    const x = Math.round(xOf(b * score.barSeconds)) + 0.5;
    g.strokeStyle = 'rgba(196,155,255,0.07)';
    g.beginPath();
    g.moveTo(x, padY - 4);
    g.lineTo(x, h - 14);
    g.stroke();
  }
  g.font = '9px ui-monospace, Menlo, monospace';
  g.textBaseline = 'alphabetic';
  score.chords.forEach((c, i) => {
    const x0 = xOf(c.start) + 1;
    const x1 = xOf(c.start + c.dur) - 1;
    const active = i === cur;
    const a = 0.28 + 0.5 * c.brightness;
    g.save();
    if (active) {
      g.shadowColor = 'rgba(196,155,255,0.9)';
      g.shadowBlur = 10;
    }
    // Release tail: the pad keeps ringing into the next chord.
    const tail = Math.min(xOf(5.5) - xOf(0), w - x1);
    for (const m of [...c.notes, c.bass]) {
      const y = yOf(m) - noteH / 2;
      const tg = g.createLinearGradient(x1, 0, x1 + tail, 0);
      tg.addColorStop(0, `rgba(196,155,255,${a * 0.45})`);
      tg.addColorStop(1, 'rgba(196,155,255,0)');
      g.fillStyle = tg;
      g.fillRect(x1, y, tail, noteH);
    }
    for (const m of c.notes) {
      g.fillStyle = active ? `rgba(232,218,255,${Math.min(1, a + 0.4)})` : `rgba(196,155,255,${a})`;
      g.fillRect(x0, yOf(m) - noteH / 2, x1 - x0, noteH);
    }
    g.fillStyle = active ? 'rgba(196,155,255,0.8)' : 'rgba(196,155,255,0.32)';
    g.fillRect(x0, yOf(c.bass) - noteH / 2, x1 - x0, noteH);
    g.restore();
    g.fillStyle = active ? '#e2d0ff' : 'rgba(138,160,192,0.75)';
    g.fillText(t(`audio.note.${c.pcs[0]}`), x0 + 2, h - 3);
  });
  // Bells of the current cycle.
  for (const b of bellsForCycle(score, cycle)) {
    const x = xOf(b.t);
    const y = yOf(b.midi);
    const played = ph !== null && b.t <= ph;
    const r = 2.2 + 2.2 * b.vel;
    g.fillStyle = played ? 'rgba(127,212,255,0.95)' : 'rgba(127,212,255,0.35)';
    g.beginPath();
    g.moveTo(x, y - r);
    g.lineTo(x + r, y);
    g.lineTo(x, y + r);
    g.lineTo(x - r, y);
    g.closePath();
    g.fill();
  }
  if (ph !== null) {
    const x = xOf(ph);
    g.save();
    g.strokeStyle = '#7fd4ff';
    g.shadowColor = '#7fd4ff';
    g.shadowBlur = 8;
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(x, 4);
    g.lineTo(x, h - 14);
    g.stroke();
    g.restore();
  }
  scoreMeta.replaceChildren(
    el('span', {}, el('b', {}, t('audio.demo.key', { note: t(`audio.note.${score.tonic % 12}`), mode: t(`audio.mode.${score.mode.name}`) }))),
    el('span', {}, t('audio.demo.loop', { v: formatNumber(L, 1, 1) })),
    el('span', {}, t('audio.demo.chord', { n: Math.max(0, cur) + 1, total: score.chords.length })),
    el('span', {}, t('audio.demo.bells', { v: bellsForCycle(score, cycle).length })),
  );
}

// Spectrogram colour map: deep navy -> blue -> accent cyan -> white.
const STOPS: [number, number, number, number][] = [
  [0, 2, 4, 10],
  [0.35, 18, 34, 78],
  [0.6, 52, 92, 170],
  [0.8, 127, 212, 255],
  [1, 240, 250, 255],
];
function colour(v: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, v));
  for (let i = 1; i < STOPS.length; i++) {
    const [p1, r1, g1, b1] = STOPS[i]!;
    const [p0, r0, g0, b0] = STOPS[i - 1]!;
    if (x <= p1) {
      const k = (x - p0) / (p1 - p0);
      return [r0 + (r1 - r0) * k, g0 + (g1 - g0) * k, b0 + (b1 - b0) * k];
    }
  }
  return [240, 250, 255];
}

function drawSpectrogram(mono: Float32Array, sampleRate: number): void {
  const g = fit(spectroCanvas);
  const w = spectroCanvas.clientWidth;
  const h = spectroCanvas.clientHeight;
  const { frames, bins } = spectrogramDb(mono, 2048, 384);
  const all: number[] = [];
  for (const fr of frames) for (let k = 1; k < fr.length; k += 3) all.push(fr[k]!);
  all.sort((a, b) => a - b);
  const top = all[Math.floor(all.length * 0.995)] ?? -20;
  const range = 85;
  const H = 160;
  const img = new ImageData(Math.max(1, frames.length), H);
  const nyq = sampleRate / 2;
  for (let fi = 0; fi < frames.length; fi++) {
    const fr = frames[fi]!;
    for (let y = 0; y < H; y++) {
      const f = F_LO * Math.pow(20000 / F_LO, 1 - y / (H - 1));
      const bin = Math.min(bins - 1, Math.max(1, Math.round((f / nyq) * bins)));
      const v = Math.pow(Math.max(0, (fr[bin]! - (top - range)) / range), 1.25);
      const [r, gg, b] = colour(v);
      const o = (y * frames.length + fi) * 4;
      img.data[o] = r;
      img.data[o + 1] = gg;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
  }
  const tmp = document.createElement('canvas');
  tmp.width = img.width;
  tmp.height = img.height;
  tmp.getContext('2d')!.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = true;
  g.clearRect(0, 0, w, h);
  g.drawImage(tmp, 0, 0, w, h);
  // Axes.
  g.font = '9px ui-monospace, Menlo, monospace';
  g.fillStyle = 'rgba(216,230,255,0.8)';
  for (const [f, label] of [
    [100, '100 Hz'],
    [1000, '1 kHz'],
    [10000, '10 kHz'],
  ] as const) {
    const y = (1 - Math.log(f / F_LO) / Math.log(20000 / F_LO)) * h;
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(0, Math.round(y), w, 1);
    g.fillStyle = 'rgba(216,230,255,0.85)';
    g.fillText(label, 4, y - 3);
  }
  const secs = mono.length / sampleRate;
  g.textAlign = 'center';
  for (let s = 1; s < secs; s++) g.fillText(`${s}`, (s / secs) * w, h - 3);
  g.textAlign = 'left';
}

function statChip(labelKey: string, value: string, ok: boolean | null): HTMLElement {
  return el('span', { cls: `stat${ok === null ? '' : ok ? ' ok' : ' bad'}` }, t(labelKey), el('b', {}, value));
}

async function renderPreview(): Promise<void> {
  renderBtn.disabled = true;
  renderBtn.textContent = t('audio.demo.rendering');
  try {
    const cue = cueSelect.value as AudioCue | '';
    const sc: Scenario = { seconds: 6, seed, volumes: { ...volumes }, muted, state: { ...state }, steps: cue ? [{ at: 1, cue }] : [] };
    const r = await renderScenario(sc);
    const mono = mixDown(r.left, r.right);
    drawSpectrogram(mono, r.sampleRate);
    const pk = Math.max(peak(r.left), peak(r.right));
    const nf = countNonFinite(r.left) + countNonFinite(r.right);
    const click = Math.max(clickScore(r.left), clickScore(r.right));
    statsBox.replaceChildren(
      statChip('audio.demo.stat.rms', db(rms(mono)), null),
      statChip('audio.demo.stat.peak', db(pk), pk < 0.98),
      statChip('audio.demo.stat.nonFinite', formatNumber(nf), nf === 0),
      statChip('audio.demo.stat.click', formatNumber(click, 1, 1), click < 12),
      statChip('audio.demo.stat.centroid', t('audio.demo.hz', { v: Math.round(spectralCentroid(mono, r.sampleRate)) }), null),
    );
  } finally {
    renderBtn.disabled = false;
    renderBtn.textContent = t('audio.demo.render');
  }
}
renderBtn.addEventListener('click', () => void renderPreview());

// --- loop -------------------------------------------------------------------------------------------------------

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  runSequence(dt);
  engine.update(dt, state);
  drawScope();
  drawScore();
  updateStatus();
  requestAnimationFrame(frame);
}
syncUi();
updateStatus();
layoutScore();
requestAnimationFrame(frame);

// Hooks for tests/e2e/audio.spec.ts and tools.
Object.assign(window, {
  __ksAudio: {
    get engine(): AudioEngine {
      return engine;
    },
    state,
    cues: AUDIO_CUES,
    measure: measureScenario,
    renderPreview,
    start: startAudio,
  },
});
