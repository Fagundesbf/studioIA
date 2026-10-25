import { Component, computed, ElementRef, inject, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, Notifier } from '../api.service';
import { EVENT_TYPES, fmtMs, type StudioEvent } from '../models';
import { ProjectStore } from '../project.store';

@Component({
  selector: 'app-scenes-step',
  imports: [FormsModule],
  template: `
    @if (videos().length === 0) {
      <p class="notice">Importe um vídeo e aguarde o processamento na etapa 1.</p>
    } @else {
      <section class="card" aria-labelledby="player-titulo">
        <h2 id="player-titulo">Marcar cenas</h2>
        <div class="row">
          <div class="field" style="max-width:420px">
            <label for="video-sel">Vídeo</label>
            <select id="video-sel" [ngModel]="assetId()" (ngModelChange)="assetId.set($event)">
              @for (v of videos(); track v.id) { <option [value]="v.id">{{ v.originalName }}</option> }
            </select>
          </div>
        </div>
        @if (asset(); as a) {
          <video #player controls preload="metadata" [src]="api.proxyUrl(a)" (timeupdate)="now.set(currentMs())" (keydown)="onKey($event)"
            [attr.aria-label]="'Player de ' + a.originalName + '. Atalhos: I marca início, O marca fim.'"></video>
          <p class="muted">Posição: <strong>{{ fmtMs(now()) }}</strong>. Atalhos com o player focado: <kbd>I</kbd> início · <kbd>O</kbd> fim · <kbd>espaço</kbd> play/pausa.</p>
          <form class="row" (ngSubmit)="save()">
            <div class="field"><label for="ini">Início (s)</label><input id="ini" name="ini" type="number" step="0.1" min="0" [(ngModel)]="form.start" /></div>
            <button type="button" (click)="setStart()">Usar posição atual como início</button>
            <div class="field"><label for="fim">Fim (s)</label><input id="fim" name="fim" type="number" step="0.1" min="0" [(ngModel)]="form.end" /></div>
            <button type="button" (click)="form.end = round(now() / 1000)">Usar posição atual como fim</button>
            <div class="field">
              <label for="tipo">O que acontece</label>
              <select id="tipo" name="tipo" [(ngModel)]="form.type">@for (t of types; track t[0]) { <option [value]="t[0]">{{ t[1] }}</option> }</select>
            </div>
            <div class="field" style="flex-basis:100%"><label for="desc">Descrição do que você viu (fato observável)</label><input id="desc" name="desc" [(ngModel)]="form.description" placeholder="Ex.: passa o carro azul por dentro na curva 4" /></div>
            <button class="primary" type="submit">Salvar cena</button>
          </form>
        }
      </section>

      <section class="card" aria-labelledby="cand-titulo">
        <h2 id="cand-titulo">Cenas do projeto</h2>
        <p class="muted">Cenas que você marca já entram como <strong>confirmadas</strong>. Candidatos automáticos entram como <strong>pendentes</strong> e só podem ser narrados como fato depois de confirmados.</p>
        <button type="button" (click)="analyze()">Sugerir candidatos (heurística de mudança de cena)</button>
        <span class="muted"> — não usa IA: só detecta cortes bruscos de imagem e não prova ultrapassagem, colisão ou vitória.</span>
        <div class="row" style="margin-top:8px">
          <div class="field" style="max-width:240px">
            <label for="ev-filter">Mostrar</label>
            <select id="ev-filter" [ngModel]="evFilter()" (ngModelChange)="evFilter.set($event)">
              <option value="all">Todas</option><option value="pending">Pendentes</option><option value="confirmed">Confirmadas</option><option value="rejected">Rejeitadas</option>
            </select>
          </div>
        </div>
        @if (events().length === 0) { <p class="muted">Nenhuma cena ainda.</p> }
        @else {
          <table>
            <caption class="sr-only">Cenas e candidatos</caption>
            <thead><tr><th scope="col">Trecho</th><th scope="col">Tipo / descrição</th><th scope="col">Origem</th><th scope="col">Situação</th><th scope="col">Ações</th></tr></thead>
            <tbody>
              @for (e of events(); track e.id) {
                <tr>
                  <td><button class="link" type="button" (click)="seek(e)" [attr.aria-label]="'Tocar trecho de ' + fmtMs(e.startMs)">▶ {{ fmtMs(e.startMs) }}–{{ fmtMs(e.endMs) }}</button></td>
                  <td><strong>{{ typeLabel(e.type) }}</strong><br /><span class="muted">{{ e.description }}</span></td>
                  <td>{{ originLabel[e.origin] }}@if (e.origin !== 'manual') { <br /><span class="muted">score {{ e.confidence }}</span> }</td>
                  <td><span class="badge" [class.ok]="e.review === 'confirmed'" [class.warn]="e.review === 'pending'" [class.err]="e.review === 'rejected'">{{ reviewLabel[e.review] }}</span></td>
                  <td>
                    @if (e.review !== 'confirmed') { <button class="small" type="button" (click)="review(e, 'confirmed')">Confirmar</button> }
                    @if (e.review !== 'rejected') { <button class="small" type="button" (click)="review(e, 'rejected')">Rejeitar</button> }
                    <button class="small" type="button" (click)="edit(e)">Editar</button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        }
        @if (confirmedCount() > 0) { <p><button class="primary" type="button" (click)="next.emit()">Próximo: escrever roteiro →</button></p> }
      </section>
    }
  `,
})
export class ScenesStep {
  protected api = inject(Api);
  private notifier = inject(Notifier);
  protected store = inject(ProjectStore);
  readonly next = output<void>();
  private player = viewChild<ElementRef<HTMLVideoElement>>('player');
  protected readonly fmtMs = fmtMs;
  protected readonly types = EVENT_TYPES;
  protected readonly originLabel = { manual: 'Você', model: 'Modelo', heuristic: 'Heurística' };
  protected readonly reviewLabel = { pending: 'Pendente', confirmed: 'Confirmada', rejected: 'Rejeitada' };
  protected now = signal(0);
  protected evFilter = signal<'all' | StudioEvent['review']>('all');
  protected editingId: string | null = null;
  protected form = { start: 0, end: 0, type: 'ultrapassagem', description: '' };

  protected videos = computed(() => (this.store.data()?.assets ?? []).filter((a) => a.kind === 'video' && a.status === 'ready'));
  protected assetId = signal<string | null>(null);
  protected asset = computed(() => this.videos().find((v) => v.id === this.assetId()) ?? this.videos()[0] ?? null);
  protected events = computed(() => (this.store.data()?.events ?? []).filter((e) => this.evFilter() === 'all' || e.review === this.evFilter()).sort((a, b) => a.startMs - b.startMs));
  protected confirmedCount = computed(() => (this.store.data()?.events ?? []).filter((e) => e.review === 'confirmed').length);

  round(n: number) { return Math.round(n * 10) / 10; }
  currentMs() { return Math.round((this.player()?.nativeElement.currentTime ?? 0) * 1000); }
  typeLabel(t: string) { return EVENT_TYPES.find((x) => x[0] === t)?.[1] ?? t.replace(/_/g, ' '); }

  onKey(ev: KeyboardEvent) {
    if (ev.key === 'i' || ev.key === 'I') { this.setStart(); this.notifier.info(`Início marcado em ${fmtMs(this.currentMs())}`); }
    if (ev.key === 'o' || ev.key === 'O') { this.form.end = this.round(this.currentMs() / 1000); this.notifier.info(`Fim marcado em ${fmtMs(this.currentMs())}`); }
  }

  /** Marca o início e, se o fim ficou antes dele, sugere 8 s de cena (cabe uma frase narrada). */
  setStart() {
    this.form.start = this.round(this.currentMs() / 1000);
    const max = (this.asset()?.durationMs ?? Infinity) / 1000;
    if (this.form.end <= this.form.start) this.form.end = this.round(Math.min(this.form.start + 8, max));
  }

  seek(e: StudioEvent) {
    if (this.asset()?.id !== e.assetId) this.assetId.set(e.assetId);
    queueMicrotask(() => { const v = this.player()?.nativeElement; if (v) { v.currentTime = e.startMs / 1000; v.focus(); void v.play(); } });
  }

  edit(e: StudioEvent) {
    this.editingId = e.id;
    this.form = { start: e.startMs / 1000, end: e.endMs / 1000, type: e.type, description: e.description };
    this.seek(e);
    this.notifier.info('Editando cena: ajuste os campos e clique em "Salvar cena".');
  }

  async save() {
    const a = this.asset();
    const id = this.store.id();
    if (!a || !id) return;
    const body = { startMs: Math.round(this.form.start * 1000), endMs: Math.round(this.form.end * 1000), type: this.form.type, description: this.form.description };
    if (body.endMs <= body.startMs) {
      this.notifier.error(new Error(`O fim (${fmtMs(body.endMs)}) precisa ser depois do início (${fmtMs(body.startMs)}). Avance o vídeo e clique em "Usar posição atual como fim" (ou tecla O).`));
      return;
    }
    try {
      if (this.editingId) { await this.api.patchEvent(this.editingId, body); this.editingId = null; }
      else await this.api.createEvent(id, { assetId: a.id, ...body });
      this.notifier.success('Cena salva.');
      this.form = { ...this.form, description: '' };
      await this.store.load();
    } catch (e) { this.notifier.error(e); }
  }

  async review(e: StudioEvent, review: 'confirmed' | 'rejected') {
    try { await this.api.patchEvent(e.id, { review }); await this.store.load(); this.notifier.success(review === 'confirmed' ? 'Cena confirmada.' : 'Cena rejeitada.'); } catch (err) { this.notifier.error(err); }
  }

  async analyze() {
    const id = this.store.id();
    if (!id) return;
    try { await this.api.analyze(id); this.notifier.info('Análise enviada para a fila.'); await this.store.load(); } catch (e) { this.notifier.error(e); }
  }
}
