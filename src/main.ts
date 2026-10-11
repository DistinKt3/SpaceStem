import './game/styles.css';
import { App } from './game/app';
import { FreeCamera } from './game/freeCamera';
import { ShipController } from './game/ship/shipController';
import { createGameShare } from './game/share/gameShare';
import './game/hud/hud.css';
import './game/map/map.css';
import './game/ui/ui.css';
import { t } from './game/i18n';

const app = new App(document.getElementById('c') as HTMLCanvasElement);
app
  .boot()
  .then(async () => {
    app.controller = app.params.get('free') === '1' ? new FreeCamera(app) : new ShipController(app);
    // A shared location (#ks1.…) is applied before the first frame (docs/SHARE.md).
    app.share = createGameShare(app);
    await app.share.applyFragment(location.hash);
    (window as unknown as { __ks: unknown }).__ks = {
      app,
      share: app.share,
      setView: (name: string) => app.place(app.view(name)),
      stats: () => app.stats(),
      capture: () => {
        app.tick();
        return app.renderer.domElement.toDataURL('image/png');
      },
      pending: () => app.pool.pending,
    };
    app.start();
  })
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    const el = document.getElementById('boot-status');
    if (el) {
      // Announce the failure at once (the status line is otherwise a polite live region).
      el.setAttribute('role', 'alert');
      el.textContent = t('boot.failed', { reason: msg });
    }
    console.error(err);
  });
