import './game/styles.css';
import { App } from './game/app';
import { FreeCamera } from './game/freeCamera';
import { ShipController } from './game/ship/shipController';
import './game/hud/hud.css';
import { t } from './game/i18n';

const app = new App(document.getElementById('c') as HTMLCanvasElement);
app
  .boot()
  .then(() => {
    app.controller = app.params.get('free') === '1' ? new FreeCamera(app) : new ShipController(app);
    if (app.params.get('free') === '1') document.getElementById('hud')?.style.setProperty('display', 'block');
    (window as unknown as { __ks: unknown }).__ks = {
      app,
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
    if (el) el.textContent = t('boot.failed', { reason: msg });
    console.error(err);
  });
