/** Small pool of chunk-building workers with a priority queue (lower priority value first). */
import type { ChunkData, ChunkRequest } from './chunkBuild';
import type { HeightConfig } from './heights';
import type { WorkerIn } from './chunkWorker';

interface Job {
  id: number;
  key: string;
  req: ChunkRequest;
  priority: number;
  resolve: (d: ChunkData) => void;
  reject: (e: Error) => void;
}

export class ChunkWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly busy: boolean[] = [];
  private readonly queue: Job[] = [];
  private readonly inflight = new Map<number, Job>();
  private nextId = 1;

  constructor(size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./chunkWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent<{ id: number; data?: ChunkData; error?: string }>) => this.onDone(i, ev.data);
      w.onerror = (ev: ErrorEvent) => {
        console.error('[chunk worker]', ev.message);
        ev.preventDefault();
      };
      this.workers.push(w);
      this.busy.push(false);
    }
  }

  get pending(): number {
    return this.queue.length + this.inflight.size;
  }

  register(config: HeightConfig): void {
    const msg: WorkerIn = { type: 'config', config };
    for (const w of this.workers) w.postMessage(msg);
  }

  /** Forget a height config (its body was removed). Builds already posted for it run first: messages are FIFO. */
  unregister(key: string): void {
    const msg: WorkerIn = { type: 'unregister', key };
    for (const w of this.workers) w.postMessage(msg);
  }

  build(key: string, req: ChunkRequest, priority: number): Promise<ChunkData> {
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, key, req, priority, resolve, reject });
      this.pump();
    });
  }

  /** Drop queued (not started) jobs, e.g. when the camera moved on. */
  clearQueue(predicate: (req: ChunkRequest, key: string) => boolean): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const j = this.queue[i]!;
      if (predicate(j.req, j.key)) {
        this.queue.splice(i, 1);
        j.reject(new Error('cancelled'));
      }
    }
  }

  private pump(): void {
    for (let i = 0; i < this.workers.length; i++) {
      if (this.busy[i] || this.queue.length === 0) continue;
      let best = 0;
      for (let k = 1; k < this.queue.length; k++) if (this.queue[k]!.priority < this.queue[best]!.priority) best = k;
      const job = this.queue.splice(best, 1)[0]!;
      this.busy[i] = true;
      this.inflight.set(job.id, job);
      const msg: WorkerIn = { type: 'build', id: job.id, key: job.key, req: job.req };
      this.workers[i]!.postMessage(msg);
    }
  }

  private onDone(worker: number, msg: { id: number; data?: ChunkData; error?: string }): void {
    this.busy[worker] = false;
    const job = this.inflight.get(msg.id);
    this.inflight.delete(msg.id);
    if (job) {
      if (msg.data) job.resolve(msg.data);
      else job.reject(new Error(msg.error ?? 'worker error'));
    }
    this.pump();
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
  }
}
