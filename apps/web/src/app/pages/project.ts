import { Component, computed, effect, inject, input, OnDestroy, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, Notifier } from '../api.service';
import { JOB_LABEL, JOB_STATUS_LABEL, type Overview, STATUS_LABEL } from '../models';
import { ProjectStore } from '../project.store';
import { MediaStep } from '../steps/media';
import { ScenesStep } from '../steps/scenes';
import { ScriptStep } from '../steps/script';
import { AssemblyStep } from '../steps/assembly';
import { DeliveryStep } from '../steps/delivery';

type StepId = 'midia' | 'cenas' | 'roteiro' | 'montagem' | 'entrega';

@Component({
  selector: 'app-project',
  imports: [RouterLink, MediaStep, ScenesStep, ScriptStep, AssemblyStep, DeliveryStep],
  providers: [ProjectStore],
  template: `
    @if (store.data(); as d) {
      <p><a routerLink="/">← Painel</a></p>
      <h1>{{ d.project.title }}</h1>
      <p class="muted">{{ d.project.gameLabel }} · {{ d.project.template === 'short' ? 'Short vertical' : 'Gameplay narrado' }} · Etapa atual: <strong>{{ statusLabel[d.project.status] }}</strong></p>
      @if (d.project.objective) { <p>Objetivo: {{ d.project.objective }}</p> }

      @if (store.activeJobs().length) {
        <section class="card" aria-labelledby="jobs-ativos">
          <h2 id="jobs-ativos">Em andamento</h2>
          @for (j of store.activeJobs(); track j.id) {
            <div class="stack">
              <label [for]="'p-' + j.id">{{ jobLabel[j.type] }} — {{ jobStatus[j.status] }}{{ j.stage ? ' (' + j.stage + ')' : '' }}</label>
              @if (j.progress != null) { <progress [id]="'p-' + j.id" max="1" [value]="j.progress">{{ pct(j.progress) }}</progress> <span class="muted">{{ pct(j.progress) }}</span> }
              @else { <progress [id]="'p-' + j.id">em andamento</progress> }
              <button class="small" type="button" (click)="cancel(j.id)">Cancelar</button>
            </div>
          }
        </section>
      }
      @for (j of failedJobs(); track j.id) {
        <div class="notice err" role="alert">
          <strong>{{ jobLabel[j.type] }} falhou</strong> ({{ j.errorCode }}): {{ j.errorMessage }}
          <button class="small" type="button" (click)="retry(j.id)">Tentar de novo</button>
        </div>
      }

      <div class="steps" role="tablist" aria-label="Etapas do projeto">
        @for (s of steps; track s.id; let i = $index) {
          <button type="button" role="tab" [id]="'tab-' + s.id" [attr.aria-selected]="step() === s.id" [attr.aria-controls]="'panel-' + s.id"
            [attr.tabindex]="step() === s.id ? 0 : -1" (click)="step.set(s.id)" (keydown)="onTabKey($event, i)">
            {{ i + 1 }}. {{ s.label }} <span class="sr-only">{{ s.done(d) ? '(concluída)' : '' }}</span><span aria-hidden="true">{{ s.done(d) ? ' ✓' : '' }}</span>
          </button>
        }
      </div>

      <section role="tabpanel" [id]="'panel-' + step()" [attr.aria-labelledby]="'tab-' + step()" tabindex="0">
        @switch (step()) {
          @case ('midia') { <app-media-step (next)="step.set('cenas')" /> }
          @case ('cenas') { <app-scenes-step (next)="step.set('roteiro')" /> }
          @case ('roteiro') { <app-script-step (next)="step.set('montagem')" /> }
          @case ('montagem') { <app-assembly-step (next)="step.set('entrega')" /> }
          @case ('entrega') { <app-delivery-step /> }
        }
      </section>
    } @else { <p class="muted">Carregando projeto…</p> }
  `,
})
export class ProjectPage implements OnDestroy {
  readonly id = input.required<string>();
  protected store = inject(ProjectStore);
  private api = inject(Api);
  private notifier = inject(Notifier);
  protected readonly statusLabel = STATUS_LABEL;
  protected readonly jobLabel = JOB_LABEL;
  protected readonly jobStatus = JOB_STATUS_LABEL;
  protected step = signal<StepId>('midia');
  protected failedJobs = computed(() => {
    const jobs = this.store.data()?.jobs ?? [];
    // Mostra só a falha mais recente de cada tipo, se ela não foi superada por um sucesso.
    const latestByType = new Map<string, (typeof jobs)[number]>();
    for (const j of jobs) if (!latestByType.has(j.type)) latestByType.set(j.type, j);
    return [...latestByType.values()].filter((j) => j.status === 'failed');
  });

  protected readonly steps: { id: StepId; label: string; done: (d: Overview) => boolean }[] = [
    { id: 'midia', label: 'Mídia', done: (d) => d.assets.some((a) => a.kind === 'video' && a.status === 'ready') },
    { id: 'cenas', label: 'Cenas', done: (d) => d.events.some((e) => e.review === 'confirmed') },
    { id: 'roteiro', label: 'Roteiro', done: (d) => d.latestScript?.status === 'reviewed' },
    { id: 'montagem', label: 'Voz e montagem', done: (d) => !!d.latestTimeline && !d.latestTimeline.stale },
    { id: 'entrega', label: 'Entrega', done: (d) => d.exports.length > 0 && d.project.status === 'exported' },
  ];

  constructor() {
    effect(() => { this.store.load(this.id()); });
  }

  ngOnDestroy() { this.store.stop(); }

  pct(p: number) { return `${Math.round(p * 100)}%`; }

  onTabKey(ev: KeyboardEvent, i: number) {
    const dir = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    ev.preventDefault();
    const next = this.steps[(i + dir + this.steps.length) % this.steps.length]!;
    this.step.set(next.id);
    queueMicrotask(() => document.getElementById('tab-' + next.id)?.focus());
  }

  async cancel(id: string) {
    try { await this.api.cancelJob(id); this.notifier.info('Cancelamento solicitado.'); await this.store.load(); } catch (e) { this.notifier.error(e); }
  }

  async retry(id: string) {
    try { await this.api.retryJob(id); this.notifier.info('Tarefa enviada novamente para a fila.'); await this.store.load(); } catch (e) { this.notifier.error(e); }
  }
}
