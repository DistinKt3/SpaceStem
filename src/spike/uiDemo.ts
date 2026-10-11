/**
 * Input and accessibility lab (ui.html): the InputManager, Settings, SettingsPanel and Captions wired together over a
 * static sky, with a live monitor of axes and pressed actions. Exposes window.__ks for tests/e2e/ui.spec.ts.
 *
 * URL parameters (for screenshots): open=<tab>, textScale=<0.8..2>, colorblind=<mode>, device=kbm|pad, reset=1.
 */
import '../game/styles.css';
import { t } from '../game/i18n';
import { ACTIONS, type ActionId } from '../game/input/actions';
import { InputManager } from '../game/input/inputManager';
import { COLORBLIND_MODES, Settings, type ColorblindMode } from '../game/settings/settings';
import { Captions } from '../game/ui/captions';
import { SettingsPanel, SETTINGS_TABS, type SettingsTab } from '../game/ui/settingsPanel';

const params = new URLSearchParams(location.search);
if (params.get('reset') === '1') {
  try {
    localStorage.removeItem('knownsky.settings');
  } catch {
    // Storage blocked: nothing to reset.
  }
}

const settings = new Settings();
const ts = Number(params.get('textScale'));
if (ts) settings.set({ textScale: ts });
const cb = params.get('colorblind');
if (cb && (COLORBLIND_MODES as readonly string[]).includes(cb)) settings.set({ colorblind: cb as ColorblindMode });
settings.applyToDocument();

const sky = document.getElementById('sky') as HTMLCanvasElement;
const input = new InputManager(sky, settings);
const panel = new SettingsPanel(settings, input);
const captions = new Captions(settings);

// --- Static sky: deterministic stars over a soft nebula and a planet limb ---------------------------------------------

function drawSky(): void {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = innerWidth;
  const h = innerHeight;
  sky.width = Math.round(w * dpr);
  sky.height = Math.round(h * dpr);
  const g = sky.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const bg = g.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, '#02040a');
  bg.addColorStop(1, '#050b18');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  const neb = g.createRadialGradient(w * 0.72, h * 0.28, 0, w * 0.72, h * 0.28, Math.max(w, h) * 0.55);
  neb.addColorStop(0, 'rgba(90, 120, 200, 0.22)');
  neb.addColorStop(0.5, 'rgba(120, 70, 160, 0.08)');
  neb.addColorStop(1, 'rgba(0, 0, 0, 0)');
  g.fillStyle = neb;
  g.fillRect(0, 0, w, h);
  let s = 0x2f6b9a1d;
  const rnd = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const n = Math.round((w * h) / 900);
  for (let i = 0; i < n; i++) {
    const m = rnd() ** 3;
    g.fillStyle = `rgba(${200 + rnd() * 55}, ${210 + rnd() * 45}, 255, ${0.25 + m * 0.75})`;
    const r = 0.35 + m * 1.3;
    g.beginPath();
    g.arc(rnd() * w, rnd() * h, r, 0, Math.PI * 2);
    g.fill();
  }
  // A lit planet limb in the lower right, so glass panels have something bright behind them.
  const cx = w * 1.02;
  const cy = h * 1.25;
  const R = Math.max(w, h) * 0.62;
  const body = g.createRadialGradient(cx - R * 0.35, cy - R * 0.45, R * 0.1, cx, cy, R);
  body.addColorStop(0, '#6f9fd8');
  body.addColorStop(0.55, '#2a4f86');
  body.addColorStop(1, '#0a1630');
  g.fillStyle = body;
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.fill();
  const atm = g.createRadialGradient(cx, cy, R * 0.97, cx, cy, R * 1.06);
  atm.addColorStop(0, 'rgba(140, 200, 255, 0.55)');
  atm.addColorStop(1, 'rgba(140, 200, 255, 0)');
  g.fillStyle = atm;
  g.beginPath();
  g.arc(cx, cy, R * 1.06, 0, Math.PI * 2);
  g.fill();
}
drawSky();
addEventListener('resize', drawSky);

// --- Lab panels -----------------------------------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const lab = document.getElementById('lab')!;
const intro = el('section', 'lab-panel lab-intro');
intro.setAttribute('aria-labelledby', 'lab-title');
const h1 = el('h1', '', t('settings.demo.title'));
h1.id = 'lab-title';
const actions = el('div', 'lab-actions');
const openBtn = el('button', 'ks-btn', t('settings.demo.open'));
openBtn.id = 'lab-open';
openBtn.type = 'button';
openBtn.addEventListener('click', () => panel.open());
const capBtn = el('button', 'ks-btn', t('settings.demo.caption'));
capBtn.id = 'lab-caption';
capBtn.type = 'button';
const samples = ['settings.demo.captionA', 'settings.demo.captionB', 'settings.demo.captionC'];
let sample = 0;
capBtn.addEventListener('click', () => captions.show(samples[sample++ % samples.length]!, 4));
const lockBtn = el('button', 'ks-btn', t('settings.demo.lock'));
lockBtn.type = 'button';
lockBtn.addEventListener('click', () => input.requestPointerLock());
actions.append(openBtn, capBtn, lockBtn);
intro.append(h1, el('p', '', t('settings.demo.lede')), actions);

const monitor = el('section', 'lab-panel lab-monitor');
monitor.setAttribute('aria-hidden', 'true');
monitor.append(el('h2', 'lab-h', t('settings.demo.axes')));
const AXES: ActionId[] = ['pitch', 'yaw', 'roll', 'thrust', 'strafeX', 'strafeY'];
const bars = new Map<ActionId, { fill: HTMLElement; val: HTMLElement }>();
for (const id of AXES) {
  const row = el('div', 'lab-axis');
  const bar = el('div', 'lab-bar');
  const fill = el('div', 'lab-fill');
  bar.append(fill);
  const val = el('span', 'lab-val', '0.00');
  row.append(el('span', '', t(`input.action.${id}`)), bar, val);
  monitor.append(row);
  bars.set(id, { fill, val });
}
monitor.append(el('h2', 'lab-h', t('settings.demo.actions')));
const log = el('ul', 'lab-log');
log.append(el('li', 'old', t('settings.demo.idle')));
monitor.append(log);
const device = el('p', 'lab-device');
monitor.append(device);

const legend = el('section', 'lab-panel lab-legend');
legend.setAttribute('aria-hidden', 'true');
legend.append(el('h2', 'lab-h', t('settings.demo.palette')));
for (const p of ['measured', 'inferred', 'generated'] as const) {
  const b = el('span', `ks-prov ks-prov-${p}`);
  b.append(el('span', 'ks-prov-mark'), document.createTextNode(t(`settings.preview.${p}`)));
  legend.append(b);
}
const status = el('div', 'lab-status');
for (const k of ['ok', 'warn', 'danger'] as const) {
  const s = el('span', '');
  const dot = el('i', '');
  dot.style.background = `var(--ks-${k})`;
  s.append(dot, document.createTextNode(t(`settings.demo.status.${k}`)));
  status.append(s);
}
legend.append(status);

const fps = el('div', 'lab-panel lab-fps');
fps.setAttribute('aria-hidden', 'true');
lab.append(intro, monitor, legend, fps);

// --- Loop -----------------------------------------------------------------------------------------------------------

const recent: string[] = [];
let last = performance.now();
let fpsAvg = 60;
function frame(now: number): void {
  const dt = Math.min(0.1, Math.max(0.001, (now - last) / 1000));
  last = now;
  fpsAvg += (1 / dt - fpsAvg) * 0.05;
  input.update(dt);
  if (!panel.isOpen && input.justPressed('pause')) panel.open();
  for (const id of AXES) {
    const v = input.axis(id);
    const b = bars.get(id)!;
    b.fill.style.left = v >= 0 ? '50%' : `${50 + v * 50}%`;
    b.fill.style.width = `${Math.abs(v) * 50}%`;
    b.val.textContent = v.toFixed(2);
  }
  let changed = false;
  for (const a of ACTIONS) {
    if (a.kind === 'button' && a.id !== 'pause' && input.justPressed(a.id)) {
      recent.unshift(t(a.label));
      changed = true;
    }
  }
  if (changed) {
    recent.length = Math.min(recent.length, 4);
    log.replaceChildren(...recent.map((r, i) => el('li', i === 0 ? '' : 'old', r)));
  }
  device.textContent = `${t('settings.demo.device')}: ${t(input.activeDevice === 'pad' ? 'settings.controls.device.pad' : 'settings.controls.device.kbm')}`;
  fps.hidden = !settings.data.showFps;
  if (settings.data.showFps) fps.textContent = t('settings.demo.fps', { v: Math.round(fpsAvg) });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

const openTab = params.get('open');
if (openTab !== null) {
  const dev = params.get('device');
  if (dev === 'pad' || dev === 'kbm') input.activeDevice = dev;
  panel.open((SETTINGS_TABS as readonly string[]).includes(openTab) ? (openTab as SettingsTab) : undefined);
}

(window as unknown as { __ks: unknown }).__ks = { settings, input, panel, captions, t };
