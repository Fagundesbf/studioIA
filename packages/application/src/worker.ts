// Laço do worker: lease + heartbeat, cancelamento por AbortSignal, retry só para erro transitório.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Job } from '@rs/contracts';
import { DomainError, TRANSIENT_ERRORS } from '@rs/domain';
import { HANDLERS } from './handlers.ts';
import type { StudioService } from './usecases.ts';

export interface WorkerOptions {
  leaseMs?: number;
  heartbeatMs?: number;
  pollMs?: number;
  log?: (entry: Record<string, unknown>) => void;
}

export class Worker {
  readonly id = `${os.hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
  private stopped = false;
  private active = new Set<Promise<void>>();

  constructor(private readonly svc: StudioService, private readonly opts: WorkerOptions = {}) {}

  private get leaseMs() { return this.opts.leaseMs ?? 30_000; }
  private log(entry: Record<string, unknown>) { (this.opts.log ?? ((e) => console.log(JSON.stringify(e))))({ at: new Date().toISOString(), worker: this.id, ...entry }); }

  /** Processa um job, se houver. Retorna false quando a fila está vazia. */
  async tick(): Promise<boolean> {
    const job = this.svc.s.jobs.claim(this.id, this.leaseMs);
    if (!job) return false;
    await this.execute(job);
    return true;
  }

  /** Esvazia a fila (usado em testes e no modo "uma vez"). */
  async drain(max = 100) {
    for (let i = 0; i < max && (await this.tick()); i++);
  }

  async loop() {
    const concurrency = this.svc.s.config.workerConcurrency;
    this.log({ msg: 'worker iniciado', concurrency });
    while (!this.stopped) {
      if (this.active.size < concurrency) {
        const job = this.svc.s.jobs.claim(this.id, this.leaseMs);
        if (job) {
          const p = this.execute(job).finally(() => this.active.delete(p));
          this.active.add(p);
          continue;
        }
      }
      await new Promise((r) => setTimeout(r, this.opts.pollMs ?? 1000));
    }
    await Promise.allSettled([...this.active]);
  }

  stop() { this.stopped = true; }

  private async execute(job: Job) {
    const controller = new AbortController();
    const tmpDir = this.svc.s.storage.tmpPath(`job-${job.id}-${job.attempt}`);
    await fsp.mkdir(tmpDir, { recursive: true });
    let progress: number | null = null;
    let stage = 'iniciando';
    const beat = () => {
      const { cancelRequested } = this.svc.s.jobs.heartbeat(job.id, this.leaseMs, progress, stage);
      if (cancelRequested && !controller.signal.aborted) controller.abort();
    };
    const timer = setInterval(beat, this.opts.heartbeatMs ?? 2000);
    const started = Date.now();
    this.log({ jobId: job.id, projectId: job.projectId, type: job.type, stage: 'start', attempt: job.attempt });
    try {
      const handler = HANDLERS[job.type];
      const result = await handler(this.svc, job, {
        signal: controller.signal,
        progress: (p, s) => { progress = p; stage = s; },
        tmp: (name) => path.join(tmpDir, name),
      });
      if (controller.signal.aborted) throw new DomainError('CANCELLED', 'Cancelado');
      this.svc.s.jobs.succeed(job.id, result);
      this.log({ jobId: job.id, type: job.type, stage: 'succeeded', ms: Date.now() - started });
    } catch (e) {
      const err = e as DomainError & NodeJS.ErrnoException & { transient?: boolean };
      if (err.code === 'CANCELLED' || controller.signal.aborted) {
        this.svc.s.jobs.markCancelled(job.id);
        this.markRenderStatus(job, 'cancelled');
        this.log({ jobId: job.id, type: job.type, stage: 'cancelled', ms: Date.now() - started });
      } else {
        const code = err.code ?? 'INTERNAL_ERROR';
        const transient = !!err.transient || TRANSIENT_ERRORS.has(code);
        this.svc.s.jobs.fail(job.id, code, err.message ?? String(e), transient);
        if (!transient || job.attempt >= job.maxAttempts) this.markRenderStatus(job, 'failed', { errorCode: code, errorMessage: err.message, details: err.details });
        this.log({ jobId: job.id, type: job.type, stage: 'failed', code, transient, ms: Date.now() - started });
      }
    } finally {
      clearInterval(timer);
      // Remove apenas os temporários deste job; originais e saídas promovidas ficam intactos.
      if (fs.existsSync(tmpDir)) await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  }

  private markRenderStatus(job: Job, status: 'failed' | 'cancelled', diagnostics: Record<string, unknown> = {}) {
    if (job.type !== 'render') return;
    try {
      const r = this.svc.render(String(job.payload.renderId));
      if (r.status !== 'succeeded') this.svc.s.db.update('renders', { ...r, status, diagnostics: { ...r.diagnostics, ...diagnostics } });
    } catch { /* render inexistente: nada a atualizar */ }
  }
}
