import { Component, computed, effect, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, ApiError, Notifier } from '../api.service';
import { EVENT_TYPES, fmtMs, ROLE_LABEL, type Segment, type SegmentRole } from '../models';
import { ProjectStore } from '../project.store';

interface Draft {
  id?: string; role: SegmentRole; narrationText: string; isOpinion: boolean; eventId: string; assetId: string;
  startS: number; endS: number; overlayText: string; notes: string; claim: boolean; claimText: string; claimReviewed: boolean;
}

@Component({
  selector: 'app-script-step',
  imports: [FormsModule],
  template: `
    @if (confirmed().length === 0) {
      <p class="notice">Confirme pelo menos uma cena na etapa 2 — cada trecho do roteiro precisa apontar para uma cena real.</p>
    } @else {
      <section class="card">
        <h2>Roteiro em pt-BR</h2>
        <p class="muted">Estrutura sugerida: <strong>gancho</strong> (primeiros segundos) → <strong>contexto</strong> → <strong>desenvolvimento</strong> → <strong>fechamento</strong>. Cada trecho mostra uma ou mais cenas enquanto a narração toca.
          Afirmações sobre o que aconteceu na corrida precisam apontar para uma cena <strong>confirmada</strong> e ser marcadas como revisadas.</p>
        @if (store.data()?.latestScript; as s) { <p class="muted">Versão salva atual: v{{ s.version }} ({{ s.status === 'reviewed' ? 'revisado' : 'rascunho' }}). Salvar cria uma nova versão; as anteriores ficam no histórico.</p> }
      </section>

      @for (d of drafts(); track $index; let i = $index) {
        <fieldset class="card stack">
          <legend><strong>Trecho {{ i + 1 }}</strong> — {{ roleLabel[d.role] }}</legend>
          <div class="row">
            <div class="field" style="max-width:220px">
              <label [for]="'role-' + i">Função</label>
              <select [id]="'role-' + i" [(ngModel)]="d.role" [name]="'role-' + i">@for (r of roles; track r) { <option [value]="r">{{ roleLabel[r] }}</option> }</select>
            </div>
            <div class="field">
              <label [for]="'ev-' + i">Cena mostrada</label>
              <select [id]="'ev-' + i" [ngModel]="d.eventId" (ngModelChange)="pickEvent(d, $event)" [name]="'ev-' + i">
                <option value="">— escolha uma cena confirmada —</option>
                @for (e of confirmed(); track e.id) { <option [value]="e.id">{{ fmtMs(e.startMs) }}–{{ fmtMs(e.endMs) }} · {{ typeLabel(e.type) }} {{ e.description ? '· ' + e.description : '' }}</option> }
              </select>
            </div>
            <div class="field" style="max-width:120px"><label [for]="'s-' + i">Início (s)</label><input type="number" step="0.1" min="0" [id]="'s-' + i" [(ngModel)]="d.startS" [name]="'s-' + i" /></div>
            <div class="field" style="max-width:120px"><label [for]="'e-' + i">Fim (s)</label><input type="number" step="0.1" min="0" [id]="'e-' + i" [(ngModel)]="d.endS" [name]="'e-' + i" /></div>
          </div>
          <div class="field">
            <label [for]="'txt-' + i">Texto da narração</label>
            <textarea [id]="'txt-' + i" [(ngModel)]="d.narrationText" [name]="'txt-' + i" [attr.aria-describedby]="'est-' + i"></textarea>
            <span class="muted" [id]="'est-' + i">
              Fala estimada: ~{{ estimate(d.narrationText) }} s · cena: {{ (d.endS - d.startS).toFixed(1) }} s
              @if (estimate(d.narrationText) > d.endS - d.startS) { — <strong>⚠ texto provavelmente maior que a cena</strong>: encurte o texto ou aumente o trecho. }
            </span>
          </div>
          <label class="check"><input type="checkbox" [(ngModel)]="d.isOpinion" [name]="'op-' + i" /> Este trecho é opinião/comentário (não afirma fatos da corrida)</label>
          <label class="check"><input type="checkbox" [(ngModel)]="d.claim" [name]="'cl-' + i" /> Este trecho afirma um fato sobre a gameplay (ex.: “ultrapassou o líder”)</label>
          @if (d.claim) {
            <div class="row">
              <div class="field"><label [for]="'ct-' + i">Afirmação factual</label><input [id]="'ct-' + i" [(ngModel)]="d.claimText" [name]="'ct-' + i" placeholder="Ex.: ultrapassa o carro vermelho na curva 3" /></div>
              <label class="check"><input type="checkbox" [(ngModel)]="d.claimReviewed" [name]="'cr-' + i" /> Conferi no vídeo que isso aconteceu</label>
            </div>
            @if (!d.eventId) { <p class="notice">Para afirmar um fato, escolha uma cena confirmada acima.</p> }
          }
          <div class="row">
            <div class="field"><label [for]="'ov-' + i">Texto na tela (opcional)</label><input [id]="'ov-' + i" [(ngModel)]="d.overlayText" [name]="'ov-' + i" /></div>
            <div class="field"><label [for]="'nt-' + i">Notas (opcional)</label><input [id]="'nt-' + i" [(ngModel)]="d.notes" [name]="'nt-' + i" /></div>
          </div>
          <div class="row">
            <button type="button" class="small" (click)="move(i, -1)" [disabled]="i === 0">↑ Subir</button>
            <button type="button" class="small" (click)="move(i, 1)" [disabled]="i === drafts().length - 1">↓ Descer</button>
            <button type="button" class="small" (click)="remove(i)" [disabled]="drafts().length === 1">Remover trecho</button>
          </div>
        </fieldset>
      }
      <p><button type="button" (click)="add()">+ Adicionar trecho</button></p>

      @if (pending().length) {
        <div class="notice" role="alert">
          <strong>Pendências factuais ({{ pending().length }})</strong> — o roteiro foi salvo como rascunho, mas só pode ser marcado como revisado depois de resolvê-las:
          <ul>@for (p of pending(); track $index) { <li>{{ describe(p.path) }}: {{ p.message }}</li> }</ul>
        </div>
      }
      <div class="card row">
        <button type="button" (click)="save('draft')">Salvar rascunho</button>
        <button type="button" class="primary" (click)="save('reviewed')">Salvar como revisado</button>
        @if (store.data()?.latestScript?.status === 'reviewed') { <button type="button" class="primary" (click)="next.emit()">Próximo: voz e montagem →</button> }
      </div>
    }
  `,
})
export class ScriptStep {
  private api = inject(Api);
  private notifier = inject(Notifier);
  protected store = inject(ProjectStore);
  readonly next = output<void>();
  protected readonly fmtMs = fmtMs;
  protected readonly roleLabel = ROLE_LABEL;
  protected readonly roles: SegmentRole[] = ['gancho', 'contexto', 'desenvolvimento', 'fechamento'];
  protected drafts = signal<Draft[]>([]);
  protected pending = signal<{ path: string; message: string }[]>([]);
  protected confirmed = computed(() => (this.store.data()?.events ?? []).filter((e) => e.review === 'confirmed').sort((a, b) => a.startMs - b.startMs));
  private loadedFrom: string | null = 'none';

  constructor() {
    // Carrega a última versão salva no editor (uma vez por versão).
    effect(() => {
      const d = this.store.data();
      if (!d) return;
      const s = d.latestScript;
      if ((s?.id ?? null) === this.loadedFrom) return;
      this.loadedFrom = s?.id ?? null;
      if (s) this.drafts.set(s.segments.map((seg) => this.toDraft(seg)));
      else if (!this.drafts().length) this.drafts.set(this.confirmed().slice(0, 4).map((e, i) => this.blank(this.roles[Math.min(i, 3)]!, e.id)));
    });
  }

  typeLabel(t: string) { return EVENT_TYPES.find((x) => x[0] === t)?.[1] ?? t; }
  estimate(text: string) { return Math.round((text.trim().split(/\s+/).filter(Boolean).length / 150) * 60 * 10) / 10; }
  describe(path: string) { const m = /segments\.(\d+)/.exec(path); return m ? `Trecho ${Number(m[1]) + 1}` : path; }

  private blank(role: SegmentRole, eventId = ''): Draft {
    const e = this.confirmed().find((x) => x.id === eventId);
    return { role, narrationText: '', isOpinion: false, eventId, assetId: e?.assetId ?? this.confirmed()[0]?.assetId ?? '', startS: (e?.startMs ?? 0) / 1000, endS: (e?.endMs ?? 0) / 1000, overlayText: '', notes: '', claim: false, claimText: '', claimReviewed: false };
  }

  private toDraft(s: Segment & { id: string }): Draft {
    const ref = s.sourceRefs[0]!;
    const c = s.factualClaims[0];
    return { id: s.id, role: s.role, narrationText: s.narrationText, isOpinion: s.isOpinion, eventId: ref.eventId ?? '', assetId: ref.assetId, startS: ref.startMs / 1000, endS: ref.endMs / 1000, overlayText: s.overlayText ?? '', notes: s.notes ?? '', claim: !!c, claimText: c?.text ?? '', claimReviewed: c?.reviewed ?? false };
  }

  pickEvent(d: Draft, eventId: string) {
    d.eventId = eventId;
    const e = this.confirmed().find((x) => x.id === eventId);
    if (e) { d.assetId = e.assetId; d.startS = e.startMs / 1000; d.endS = e.endMs / 1000; }
    this.drafts.update((x) => [...x]);
  }

  add() { this.drafts.update((x) => [...x, this.blank('desenvolvimento')]); }
  remove(i: number) { this.drafts.update((x) => x.filter((_, j) => j !== i)); }
  move(i: number, dir: number) {
    this.drafts.update((x) => { const y = [...x]; const [it] = y.splice(i, 1); y.splice(i + dir, 0, it!); return y; });
  }

  private toSegments(): Segment[] {
    return this.drafts().map((d) => {
      const ref = { assetId: d.assetId, startMs: Math.round(d.startS * 1000), endMs: Math.round(d.endS * 1000), ...(d.eventId ? { eventId: d.eventId } : {}) };
      return {
        ...(d.id ? { id: d.id } : {}), role: d.role, narrationText: d.narrationText.trim(), isOpinion: d.isOpinion, sourceRefs: [ref], targetDurationMs: ref.endMs - ref.startMs,
        ...(d.overlayText ? { overlayText: d.overlayText } : {}), ...(d.notes ? { notes: d.notes } : {}),
        factualClaims: d.claim && d.claimText.trim() ? [{ text: d.claimText.trim(), reviewed: d.claimReviewed, sourceRefs: [ref] }] : [],
      };
    });
  }

  async save(status: 'draft' | 'reviewed') {
    const id = this.store.id();
    if (!id) return;
    if (this.drafts().some((d) => !d.assetId || d.endS <= d.startS)) { this.notifier.error(new Error('Cada trecho precisa de uma cena com fim maior que o início.')); return; }
    try {
      const r = await this.api.saveScript(id, { status, segments: this.toSegments() });
      this.pending.set(r.pending);
      this.loadedFrom = r.script.id;
      this.drafts.set(r.script.segments.map((s) => this.toDraft(s)));
      const inv = r.invalidated.length ? ` ${r.invalidated.length} item(ns) dependente(s) (timeline/aprovação) foram invalidados.` : '';
      this.notifier.success(r.unchanged ? 'Nada mudou desde a última versão.' : `Roteiro v${r.script.version} salvo como ${status === 'reviewed' ? 'revisado' : 'rascunho'}.${inv}`);
      await this.store.load();
    } catch (e) {
      if (e instanceof ApiError && e.body.code === 'SCRIPT_HAS_PENDING_CLAIMS' && Array.isArray(e.body.details)) this.pending.set(e.body.details);
      this.notifier.error(e);
    }
  }
}
