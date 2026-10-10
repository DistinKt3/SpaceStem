import { buildChunk, type ChunkRequest } from './chunkBuild';
import type { HeightConfig } from './heights';

const configs = new Map<string, HeightConfig>();

export type WorkerIn =
  | { type: 'config'; config: HeightConfig }
  | { type: 'build'; id: number; key: string; req: ChunkRequest };

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<WorkerIn>) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

ctx.onmessage = (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  if (msg.type === 'config') {
    configs.set(msg.config.key, msg.config);
    return;
  }
  const cfg = configs.get(msg.key);
  if (!cfg) {
    ctx.postMessage({ id: msg.id, error: `no config ${msg.key}` });
    return;
  }
  const data = buildChunk(cfg, msg.req);
  ctx.postMessage({ id: msg.id, data }, [
    data.positions.buffer,
    data.normals.buffer,
    data.uvs.buffer,
    data.extras.buffer,
  ]);
};
