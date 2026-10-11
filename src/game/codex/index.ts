/**
 * Codex UI wiring: one store, the Codex overlay, the "How do we know this?" dialog and unlock toasts, connected so
 * that "Read Codex entry" and a toast's "View" open the Codex at that entry, and every new discovery shows a toast.
 *
 * Typical game integration:
 *   const codex = createCodexUI(new CodexStore(), { closeKeys: ['KeyC'] });
 *   void codex.store.load();
 *   codex.onOpenChange((open) => { input.enabled = !open; });  // the Codex can also open itself (toast "View")
 *   // C toggles the Codex, I explains the current target, arrivals unlock entries:
 *   codex.panel.toggle();  codex.howWeKnow.showForBody(targetId);  codex.howWeKnow.showForStar(starName);
 *   codex.store.discover(entryId);  // or store.byBodyId(id) / store.byStarName(name) / store.bySystem(id) first
 */
import { CodexPanel } from './codexPanel';
import type { CodexStore } from './codexStore';
import { HowWeKnowPanel } from './howWeKnow';
import { CodexToast } from './toast';

export interface CodexUI {
  readonly store: CodexStore;
  readonly panel: CodexPanel;
  readonly howWeKnow: HowWeKnowPanel;
  readonly toast: CodexToast;
  /** True while the Codex or the "How do we know this?" dialog is open (game input should pause). */
  readonly isOpen: boolean;
  /**
   * Called with the new isOpen whenever it changes, however the dialogs were opened or closed (keys, buttons, toasts,
   * gamepad). Handing over from one dialog to the other ("Read Codex entry") does not report a brief close. Called
   * in a microtask after the change, so before the next frame. Returns an unsubscribe function.
   */
  onOpenChange(cb: (open: boolean) => void): () => void;
  dispose(): void;
}

export interface CodexUIOptions {
  /** KeyboardEvent.code values that close the Codex while it has focus (usually the key that opens it); see CodexPanelOptions. */
  closeKeys?: readonly string[] | (() => readonly string[]);
  parent?: HTMLElement;
  toastDurationMs?: number;
}

export function createCodexUI(store: CodexStore, opts: CodexUIOptions = {}): CodexUI {
  const ref: { panel?: CodexPanel } = {};
  const parent = opts.parent ? { parent: opts.parent } : {};
  const howWeKnow = new HowWeKnowPanel(store, { onReadEntry: (id) => ref.panel?.open(id), ...parent });
  const panel = new CodexPanel(store, {
    howWeKnow,
    ...(opts.closeKeys ? { closeKeys: opts.closeKeys } : {}),
    ...parent,
  });
  ref.panel = panel;
  const toast = new CodexToast({
    onView: (id) => panel.open(id),
    ...(opts.toastDurationMs ? { durationMs: opts.toastDurationMs } : {}),
    ...parent,
  });

  const isOpen = (): boolean => panel.isOpen || howWeKnow.isOpen;
  const openCbs = new Set<(open: boolean) => void>();
  let reported = false;
  let pending = false;
  const sync = (): void => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      const now = isOpen();
      if (now === reported) return;
      reported = now;
      for (const cb of [...openCbs]) {
        try {
          cb(now);
        } catch (err) {
          console.error('Codex open-change listener failed', err);
        }
      }
    });
  };
  const offs = [
    store.onDiscover((e) => toast.show(e)),
    panel.onOpen(sync),
    panel.onClose(sync),
    howWeKnow.onOpen(sync),
    howWeKnow.onClose(sync),
  ];

  return {
    store,
    panel,
    howWeKnow,
    toast,
    get isOpen() {
      return isOpen();
    },
    onOpenChange(cb) {
      openCbs.add(cb);
      return () => openCbs.delete(cb);
    },
    dispose() {
      for (const off of offs) off();
      openCbs.clear();
      toast.dispose();
      panel.dispose();
      howWeKnow.dispose();
    },
  };
}

export { CodexPanel, CODEX_TABS, type CodexTab } from './codexPanel';
export { CodexStore, formatCitation, citationHref, publicDataSource, staticSource, withFallback } from './codexStore';
export { HowWeKnowPanel } from './howWeKnow';
export { CodexToast } from './toast';
export { dispatchCodexNav, setCodexGamepadPolling, type CodexNavCommand } from './nav';
export type { CodexEntry, CodexFact, CodexClaim, CodexCitation, CodexKind } from './types';
