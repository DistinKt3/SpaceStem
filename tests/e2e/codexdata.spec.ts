/**
 * Codex content review page (codexdata.html). Loads the real public/data/codex/en.json and citations.json, opens every
 * entry and checks that the page shows each fact and claim, that every citation resolves to a numbered source, and
 * that the provenance badges match the data. Data rules themselves are covered by tests/unit/codex.test.ts.
 */
import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

interface Item {
  provenance: string;
  citation: string;
}
interface Entry {
  id: string;
  title: string;
  kind: string;
  facts: Item[];
  howWeKnow: Item[];
  related: string[];
}
interface KS {
  ready: boolean;
  stats(): { entries: number; facts: number; measured: number; inferred: number; generated: number };
  select(id: string): void;
  selectedId(): string;
}

const codex = JSON.parse(readFileSync('public/data/codex/en.json', 'utf8')) as { entries: Entry[] };
const entries = codex.entries;

async function open(page: Page, query = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`${String(r.status())} ${r.url()}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`/codexdata.html${query}`);
  await page.waitForFunction(() => (window as unknown as { __ks?: KS }).__ks?.ready === true, null, {
    timeout: 60_000,
  });
  return errors;
}

test('review page loads the whole Codex with matching totals', async ({ page }) => {
  const errors = await open(page);
  const stats = await page.evaluate(() => (window as unknown as { __ks: KS }).__ks.stats());
  const all = entries.flatMap((e) => e.facts);
  expect(stats.entries).toBe(entries.length);
  expect(stats.facts).toBe(all.length);
  expect(stats.measured).toBe(all.filter((f) => f.provenance === 'measured').length);
  expect(stats.inferred).toBe(all.filter((f) => f.provenance === 'inferred').length);
  expect(stats.generated).toBe(all.filter((f) => f.provenance === 'generated').length);
  await expect(page.locator('.cx-item')).toHaveCount(entries.length);
  expect(errors).toEqual([]);
});

test('every entry renders all facts and claims with resolved, numbered sources', async ({ page }) => {
  const errors = await open(page);
  for (const e of entries) {
    await page.evaluate((id) => {
      (window as unknown as { __ks: KS }).__ks.select(id);
    }, e.id);
    await expect(page.locator('.cx-detail h2')).toHaveText(e.title);
    await expect(page.locator('.cx-fact')).toHaveCount(e.facts.length);
    await expect(page.locator('.cx-claim')).toHaveCount(e.howWeKnow.length);
    await expect(page.locator('.cx-detail .cx-ref.unresolved')).toHaveCount(0);
    const keys = new Set([...e.facts, ...e.howWeKnow].map((i) => i.citation));
    await expect(page.locator('.cx-sources > li')).toHaveCount(keys.size);
    // Each fact row carries the badge for its own provenance tier.
    const badges = await page
      .locator('.cx-fact .cx-prov')
      .evaluateAll((els: Element[]) => els.map((b) => b.getAttribute('class') ?? ''));
    expect(badges).toEqual(e.facts.map((f) => `cx-prov cx-prov-${f.provenance}`));
    // A measured uncertainty must never round away to "± 0".
    const uncertainties = await page.locator('.cx-detail .cx-unc').allTextContents();
    for (const u of uncertainties) expect(u.trim(), `${e.id}: ${u}`).not.toMatch(/^± 0([.,]0*)?$/);
  }
  expect(errors).toEqual([]);
});

test('tiny values share their exponent with their uncertainty, and text comes from the locale', async ({ page }) => {
  const valueOf = (label: string) =>
    page
      .locator('.cx-fact')
      .filter({ has: page.locator('td:first-child').getByText(label, { exact: true }) })
      .locator('.cx-val');
  const errors = await open(page, '?id=phobos');
  await expect(page).toHaveTitle('Known Sky: Codex content review');
  await expect(valueOf('GM (gravitational parameter)')).toHaveText('(7.087 ± 0.006) × 10⁻⁴ km³/s²');
  const lum = await open(page, '?id=trappist-1');
  await expect(valueOf('Luminosity')).toHaveText('(5.53 ± 0.19) × 10⁻⁴ L☉');
  // A source without a year shows the localised "n.d.".
  await page.evaluate(() => {
    (window as unknown as { __ks: KS }).__ks.select('sirius');
  });
  await expect(page.locator('#src-hyg-v41')).toContainText('(n.d.)');
  expect([...errors, ...lum]).toEqual([]);
});

test('layout fits a phone and a short 800x450 window', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await open(page, '?id=trappist-1e');
  const detail = page.locator('.cx-detail');
  const overflow = await detail.evaluate((d) => d.scrollWidth - d.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  // Nothing on the page is wider than the screen.
  const pageOverflow = await page.locator('#cx-root').evaluate((r) => r.scrollWidth - r.clientWidth);
  expect(pageOverflow).toBeLessThanOrEqual(1);
  const right = await page.locator('.cx-main').evaluate((m) => m.getBoundingClientRect().right);
  expect(right).toBeLessThanOrEqual(390);
  // The entry opened from the address is scrolled into view in the (short) list.
  const list = await page.locator('.cx-list').boundingBox();
  const current = await page.locator('.cx-item[aria-current="true"]').boundingBox();
  expect(list && current && current.y >= list.y && current.y + current.height <= list.y + list.height).toBe(true);
  // Every provenance badge in the fact list is fully inside the panel.
  const box = await detail.boundingBox();
  for (const badge of await page.locator('.cx-fact .cx-prov').all()) {
    const b = await badge.boundingBox();
    expect(b && box && b.x >= box.x && b.x + b.width <= box.x + box.width + 0.5).toBe(true);
  }
  await page.screenshot({ path: 'test-results/codexdata-shots/phone.png' });

  await page.setViewportSize({ width: 800, height: 450 });
  await page.evaluate(() => {
    (window as unknown as { __ks: KS }).__ks.select('phobos');
  });
  const head = await page.locator('.cx-head').boundingBox();
  expect(head?.height ?? 999).toBeLessThan(450 * 0.2);
  await page.screenshot({ path: 'test-results/codexdata-shots/short.png' });
  expect(errors).toEqual([]);
});

test('URL parameters, kind filter, search and related links navigate entries', async ({ page }) => {
  const errors = await open(page, '?id=trappist-1e&kind=exoplanet');
  const exoplanets = entries.filter((e) => e.kind === 'exoplanet');
  await expect(page.locator('.cx-item')).toHaveCount(exoplanets.length);
  await expect(page.locator('.cx-item[aria-current="true"]')).toHaveText('TRAPPIST-1 e');
  // Exoplanet surfaces are game-made: the page must show at least one Generated badge for TRAPPIST-1e.
  await expect(page.locator('.cx-fact .cx-prov-generated').first()).toBeVisible();

  await page.locator('.cx-related .cx-chip').first().click();
  const selected = await page.evaluate(() => (window as unknown as { __ks: KS }).__ks.selectedId());
  expect(selected).not.toBe('trappist-1e');
  expect(entries.find((e) => e.id === 'trappist-1e')?.related).toContain(selected);

  await page.locator('.cx-chip[data-kind="all"]').click();
  await expect(page.locator('.cx-item')).toHaveCount(entries.length);
  await page.locator('.cx-search').fill('parallax');
  const hits = await page.locator('.cx-item').allTextContents();
  expect(hits).toContain('Stellar parallax');
  expect(hits.length).toBeLessThan(entries.length);
  expect(errors).toEqual([]);
});
