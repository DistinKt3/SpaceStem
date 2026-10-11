/**
 * Connects the game to the Codex: maps targets (Solar System bodies, catalogue stars, exoplanets) to Codex entries,
 * and records discoveries from play.
 *
 * - visit: entering a body's sphere of influence, or arriving at a star or system by hyperspeed.
 * - scan: concepts unlock when the game first shows what they explain (first star targeted -> parallax and
 *   catalogues; first exoplanet targeted -> transits, exoplanet count; TRAPPIST-1 -> tidal locking, habitable zone,
 *   transit-timing variations; Earth's daytime sky -> why the sky is blue; the map -> ephemerides).
 * Entries with unlock "start" are always known (CodexStore).
 */
import type { App } from './app';
import type { CodexEntry } from './codex/codexStore';
import type { CodexUI } from './codex';

export class CodexDirector {
  private lastDominant = '';
  private lastTarget: string | null = null;

  constructor(
    private readonly app: App,
    readonly ui: CodexUI,
  ) {}

  /** Codex entry for a target id: a body ("399"), an exoplanet system member ("trappist-1b") or a star ("*12"). */
  entryFor(id: string): CodexEntry | undefined {
    const store = this.ui.store;
    const byBody = store.byBodyId(id);
    if (byBody) return byBody;
    const direct = store.entry(id);
    if (direct) return direct;
    if (id.startsWith('*') && this.app.catalog) {
      return store.byStarName(this.app.catalog.name(Number(id.slice(1))));
    }
    return undefined;
  }

  /** Open "How do we know this?" for a target; false when the Codex has no entry for it. */
  explain(id: string | null): boolean {
    if (!id) return false;
    const e = this.entryFor(id);
    if (!e) return false;
    this.ui.howWeKnow.show(e);
    return true;
  }

  private discover(id: string | undefined): void {
    if (id) this.ui.store.discover(id);
  }

  /** Per frame (cheap): visits, arrivals and first-time scans. */
  update(targetId: string | null, dominant: string, opts: { inDaylightAtmosphere: boolean; mapOpen: boolean }): void {
    if (dominant !== this.lastDominant) {
      this.lastDominant = dominant;
      this.discover(this.entryFor(dominant)?.id);
    }
    if (targetId !== this.lastTarget) {
      this.lastTarget = targetId;
      if (targetId) {
        const e = this.entryFor(targetId);
        if (targetId.startsWith('*') || e?.kind === 'star') {
          this.discover('concept-parallax');
          this.discover('concept-star-catalogues');
        }
        if (e?.kind === 'exoplanet' || this.app.exoOf(targetId)) {
          this.discover('concept-transit');
          this.discover('concept-exoplanet-count');
        }
        if (e?.id === 'proxima-centauri-b') this.discover('concept-radial-velocity');
      }
    }
    if (opts.inDaylightAtmosphere) this.discover('concept-sky-blue');
    if (opts.mapOpen) this.discover('concept-ephemerides');
  }

  /** Hyperspeed arrival at a star or exoplanet system. */
  arrived(anchor: string): void {
    this.discover(this.entryFor(anchor)?.id);
    const system = this.app.exoOf(anchor);
    if (system) {
      this.discover('concept-tidal-locking');
      this.discover('concept-habitable-zone');
      this.discover('concept-ttv');
    }
  }
}
