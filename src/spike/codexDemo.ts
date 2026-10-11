/**
 * Codex lab (codex.html): the Codex overlay, the "How do we know this?" dialog and unlock toasts over a static sky,
 * with sample content. Exposes window.__ksCodex for tests/e2e/codex.spec.ts.
 *
 * Content: public/data/codex/en.json and citations.json when present, else the test fixtures.
 * URL parameters: source=fixtures|data, reset=1, discover=<id,id>, open=codex|hwk, entry=<id>, textScale=<0.8..2>,
 * colorblind=<mode>, reduced=1.
 */
import '../game/styles.css';
import codexFixture from '../../tests/fixtures/codex_sample.json';
import citationsFixture from '../../tests/fixtures/citations_sample.json';
import { Rng } from '../core/rng';
import { createCodexUI } from '../game/codex';
import { CODEX_STORAGE_KEY, CodexStore, publicDataSource, staticSource, withFallback } from '../game/codex/codexStore';
import { t } from '../game/i18n';
import { provenanceBadge } from '../game/ui/badge';

const params = new URLSearchParams(location.search);
const root = document.documentElement;

if (params.get('reset') === '1') {
  try {
    localStorage.removeItem(CODEX_STORAGE_KEY);
  } catch {
    // Storage blocked: nothing to reset.
  }
}
const ts = Number(params.get('textScale'));
if (ts >= 0.8 && ts <= 2) root.style.fontSize = `${ts * 100}%`;
const cb = params.get('colorblind');
if (cb) root.dataset['colorblind'] = cb;
if (params.get('reduced') === '1') root.dataset['reducedMotion'] = 'true';

// --- Static sky: deterministic stars over a soft nebula and a lit planet limb -------------------------------------------

const sky = document.getElementById('sky') as HTMLCanvasElement;
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
  bg.addColorStop(1, '#060c1c');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  const neb = g.createRadialGradient(w * 0.3, h * 0.25, 0, w * 0.3, h * 0.25, Math.max(w, h) * 0.6);
  neb.addColorStop(0, 'rgba(110, 90, 200, 0.2)');
  neb.addColorStop(0.5, 'rgba(60, 110, 190, 0.08)');
  neb.addColorStop(1, 'rgba(0, 0, 0, 0)');
  g.fillStyle = neb;
  g.fillRect(0, 0, w, h);
  const rng = new Rng(0x5eed_c0de);
  const n = Math.round((w * h) / 850);
  for (let i = 0; i < n; i++) {
    const m = rng.next() ** 3;
    g.fillStyle = `rgba(${200 + rng.next() * 55}, ${210 + rng.next() * 45}, 255, ${0.25 + m * 0.75})`;
    g.beginPath();
    g.arc(rng.next() * w, rng.next() * h, 0.35 + m * 1.3, 0, Math.PI * 2);
    g.fill();
  }
  const cx = w * 0.88;
  const cy = h * 1.2;
  const R = Math.max(w, h) * 0.55;
  const body = g.createRadialGradient(cx - R * 0.4, cy - R * 0.5, R * 0.1, cx, cy, R);
  body.addColorStop(0, '#7fb0e6');
  body.addColorStop(0.5, '#2c5591');
  body.addColorStop(1, '#0a1630');
  g.fillStyle = body;
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.fill();
  const atm = g.createRadialGradient(cx, cy, R * 0.97, cx, cy, R * 1.07);
  atm.addColorStop(0, 'rgba(140, 200, 255, 0.55)');
  atm.addColorStop(1, 'rgba(140, 200, 255, 0)');
  g.fillStyle = atm;
  g.beginPath();
  g.arc(cx, cy, R * 1.07, 0, Math.PI * 2);
  g.fill();
}
drawSky();
addEventListener('resize', drawSky);

// --- Codex ----------------------------------------------------------------------------------------------------------

const fixtures = staticSource(codexFixture, citationsFixture);
const sourceParam = params.get('source');
let usedFixtures = sourceParam === 'fixtures';
const source =
  sourceParam === 'fixtures'
    ? fixtures
    : sourceParam === 'data'
      ? publicDataSource()
      : withFallback(publicDataSource(), {
          codex: () => {
            usedFixtures = true;
            return fixtures.codex();
          },
          citations: () => fixtures.citations(),
        });
const store = new CodexStore({ source });
const ui = createCodexUI(store, { closeKeys: ['KeyC'] });

// --- Lab panels -----------------------------------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function button(id: string, text: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = el('button', primary ? 'ks-cx-btn ks-cx-btn--primary' : 'ks-cx-btn', text);
  b.type = 'button';
  b.id = id;
  b.addEventListener('click', onClick);
  return b;
}

/** The "current target" of this lab, standing in for the ship's target in the game. */
const TARGET_ID = 'earth';

function nextLocked(): string | undefined {
  return store.entries().find((e) => !store.discovered(e.id))?.id;
}
function discoverNext(): void {
  const id = nextLocked();
  if (id) store.discover(id);
}

const lab = document.getElementById('lab')!;
const intro = el('section', 'lab lab-intro');
intro.setAttribute('aria-labelledby', 'lab-title');
const h1 = el('h1', '', t('codex.demo.title'));
h1.id = 'lab-title';
const discoverBtn = button('lab-discover', t('codex.demo.discover'), discoverNext);
const actions = el('div', 'lab-actions');
actions.append(
  button('lab-open', t('codex.demo.open'), () => ui.panel.open(), true),
  button('lab-explain', t('codex.demo.explain'), () => ui.howWeKnow.showById(TARGET_ID)),
  discoverBtn,
  button('lab-reset', t('codex.demo.reset'), () => store.reset()),
);

const paletteSel = el('select', '');
paletteSel.id = 'lab-palette';
for (const m of ['none', 'deuteranopia', 'protanopia', 'tritanopia', 'high-contrast']) {
  const o = el('option', '', t(`codex.demo.palette.${m}`));
  o.value = m;
  paletteSel.append(o);
}
paletteSel.value = cb ?? 'none';
paletteSel.addEventListener('change', () => {
  root.dataset['colorblind'] = paletteSel.value;
});
const scale = el('input', '');
scale.id = 'lab-scale';
scale.type = 'range';
scale.min = '0.8';
scale.max = '2';
scale.step = '0.1';
scale.value = String(ts >= 0.8 && ts <= 2 ? ts : 1);
scale.addEventListener('input', () => {
  root.style.fontSize = `${Number(scale.value) * 100}%`;
});
const motion = el('input', '');
motion.id = 'lab-motion';
motion.type = 'checkbox';
motion.checked = root.dataset['reducedMotion'] === 'true';
motion.addEventListener('change', () => {
  root.dataset['reducedMotion'] = String(motion.checked);
});
function row(label: string, control: HTMLElement): HTMLElement {
  const r = el('div', 'lab-row');
  const l = el('label', '', label);
  l.htmlFor = control.id;
  r.append(l, control);
  return r;
}
const src = el('p', 'lab-src', t('codex.loading'));
intro.append(
  h1,
  el('p', '', t('codex.demo.lede')),
  actions,
  row(t('codex.demo.palette'), paletteSel),
  row(t('codex.demo.textScale'), scale),
  row(t('codex.demo.motion'), motion),
  src,
);

// A HUD-like target card: what the game shows next to a targeted object.
const target = el('section', 'lab lab-target');
target.setAttribute('aria-label', t('codex.demo.target'));
const targetName = el('div', 'n');
target.append(el('div', 'k', t('codex.demo.target')), targetName, provenanceBadge('measured'), el('div', 'hint', t('codex.demo.targetHint')));

const badges = el('section', 'lab lab-badges');
badges.setAttribute('aria-label', t('codex.legend.title'));
for (const p of ['measured', 'inferred', 'generated'] as const) badges.append(provenanceBadge(p));
for (const p of ['measured', 'inferred', 'generated'] as const) badges.append(provenanceBadge(p, { compact: true }));

lab.append(intro, target, badges);

function syncLab(): void {
  discoverBtn.disabled = nextLocked() === undefined;
  discoverBtn.textContent = nextLocked() === undefined ? t('codex.demo.discoverDone') : t('codex.demo.discover');
  targetName.textContent = store.entry(TARGET_ID)?.title ?? TARGET_ID;
}
store.onChange(syncLab);

// Lab shortcuts (the Codex dialogs keep their own keys while open).
addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey || ui.isOpen) return;
  if (e.code === 'KeyC') ui.panel.open();
  else if (e.code === 'KeyI') ui.howWeKnow.showById(TARGET_ID);
  else if (e.code === 'KeyD') discoverNext();
  else return;
  e.preventDefault();
});

void store.load().then(() => {
  src.textContent = usedFixtures || sourceParam === 'fixtures' ? t('codex.demo.sourceFixtures') : store.error ? t('codex.error') : t('codex.demo.sourceData');
  for (const id of (params.get('discover') ?? '').split(',').filter(Boolean)) store.discover(id);
  syncLab();
  const open = params.get('open');
  const entry = params.get('entry') ?? undefined;
  if (open === 'codex') ui.panel.open(entry);
  else if (open === 'hwk') ui.howWeKnow.showById(entry ?? TARGET_ID);
  (window as unknown as { __ksCodex: unknown }).__ksCodex = { store, ui, t, discoverNext };
});
