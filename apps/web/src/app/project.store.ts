import { computed, inject, Injectable, signal } from '@angular/core';
import { Api, Notifier } from './api.service';
import { JOB_LABEL, type Overview } from './models';

/** Estado do projeto aberto. Faz polling enquanto houver job ativo (progresso real). */
@Injectable()
export class ProjectStore {
  private api = inject(Api);
  private notifier = inject(Notifier);
  readonly id = signal<string | null>(null);
  readonly data = signal<Overview | null>(null);
  readonly activeJobs = computed(() => (this.data()?.jobs ?? []).filter((j) => j.status === 'queued' || j.status === 'running'));
  private timer?: ReturnType<typeof setTimeout>;
  private lastFinished = new Set<string>();

  async load(id = this.id()) {
    if (!id) return;
    this.id.set(id);
    clearTimeout(this.timer);
    try {
      const d = await this.api.overview(id);
      // Avisa quando um job termina (anunciado no aria-live).
      for (const j of d.jobs) {
        const prev = this.data()?.jobs.find((x) => x.id === j.id);
        if (prev && (prev.status === 'running' || prev.status === 'queued') && !this.lastFinished.has(j.id)) {
          if (j.status === 'succeeded') { this.notifier.success(`${JOB_LABEL[j.type]} concluído.`); this.lastFinished.add(j.id); }
          if (j.status === 'failed') { this.notifier.error(new Error(`${JOB_LABEL[j.type]} falhou: ${j.errorMessage}`)); this.lastFinished.add(j.id); }
        }
      }
      this.data.set(d);
      if (this.activeJobs().length) this.timer = setTimeout(() => this.load(), 1500);
    } catch (e) { this.notifier.error(e); }
  }

  stop() { clearTimeout(this.timer); }
}
