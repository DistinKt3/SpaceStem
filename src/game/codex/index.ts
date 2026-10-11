/**
 * Codex UI wiring: one store, the Codex overlay, the "How do we know this?" dialog and unlock toasts, connected so
 * that "Read Codex entry" and a toast's "View" open the Codex at that entry, and every new discovery shows a toast.
 *
 * Typical game integration:
 *   const codex = createCodexUI(new CodexStore(), { closeKeys: ['KeyC'] });
 *   void codex.store.load();
 *   // C toggles the Codex, I explains the current target, arrivals unlock entries:
 *   codex.panel.toggle();  codex.howWeKnow.showForBody(targetId);  codex.store.discover(entryId);
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
  dispose(): void;
}

export interface CodexUIOptions {
  /** KeyboardEvent.code values that close the Codex while it has focus (usually the key that opens it). */
  closeKeys?: readonly string[];
  parent?: HTMLElement;
  toastDurationMs?: number;
}

export function createCodexUI(store: CodexStore, opts: CodexUIOptions = {}): CodexUI {
  const ref: { panel?: CodexPanel } = {};
  const parent = opts.parent ? { parent: opts.parent } : {};
  const howWeKnow = new HowWeKnowPanel(store, { onReadEntry: (id) => ref.panel?.open(id), ...parent });
  const panel = new CodexPanel(store, { howWeKnow, ...(opts.closeKeys ? { closeKeys: opts.closeKeys } : {}), ...parent });
  ref.panel = panel;
  const toast = new CodexToast({ onView: (id) => panel.open(id), ...(opts.toastDurationMs ? { durationMs: opts.toastDurationMs } : {}), ...parent });
  const off = store.onDiscover((e) => toast.show(e));
  return {
    store,
    panel,
    howWeKnow,
    toast,
    get isOpen() {
      return panel.isOpen || howWeKnow.isOpen;
    },
    dispose() {
      off();
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
