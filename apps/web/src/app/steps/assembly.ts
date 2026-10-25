import { Component, computed, effect, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, ApiError, Notifier } from '../api.service';
import { type Asset, type Caption, type Crop, fmtMs, ROLE_LABEL, type Timeline } from '../models';
import { ProjectStore } from '../project.store';

const TARGET = { horizontal: 16 / 9, vertical: 9 / 16 };

/** Mesmo cálculo do domínio: maior recorte centralizado na proporção do formato (nunca estica). */
function defaultCrop(format: 'horizontal' | 'vertical', w: number, h: number): Crop {
  const t = TARGET[format], src = w / h;
  if (Math.abs(src - t) < 0.01) return { x: 0, y: 0, width: 1, height: 1 };
  if (src > t) { const cw = t / src; return { x: (1 - cw) / 2, y: 0, width: cw, height: 1 }; }
  const ch = src / t; return { x: 0, y: (1 - ch) / 2, width: 1, height: ch };
}

@Component({
  selector: 'app-assembly-step',
  imports: [FormsModule],
  template: `
    @if (script(); as s) {
      @if (s.status !== 'reviewed') {
        <p class="notice">O roteiro mais recente (v{{ s.version }}) é um rascunho. Marque-o como revisado na etapa 3 antes de montar.</p>
      } @else {
        <section class="card stack">
          <h2>1. Narração e enquadramento</h2>
          @if (voices().length) {
            <fieldset class="card stack">
              <legend><strong>Gerar narração automaticamente</strong></legend>
              <p class="muted">Usa a voz sintética do seu Mac (local, offline e gratuita). Gera um áudio para cada trecho com texto. Se preferir, grave sua própria voz e importe na etapa 1.</p>
              <div class="row">
                <div class="field" style="max-width:260px">
                  <label for="voz">Voz</label>
                  <select id="voz" [ngModel]="voice()" (ngModelChange)="voice.set($event)">
                    @for (v of voices(); track v.id) { <option [value]="v.id">{{ v.name }}</option> }
                  </select>
                </div>
                <div class="field" style="max-width:260px">
                  <label for="vel">Velocidade: {{ rate() }} palavras/min {{ rate() > 190 ? '(rápida)' : rate() < 160 ? '(calma)' : '' }}</label>
                  <input id="vel" type="range" min="120" max="240" step="5" [ngModel]="rate()" (ngModelChange)="rate.set(+$event)" />
                </div>
                <button class="primary" type="button" (click)="generateVoice(s.id)" [disabled]="voiceBusy()">{{ voiceBusy() ? 'Gerando…' : 'Gerar narração de todos os trechos' }}</button>
              </div>
              <p class="muted">Dica: vozes melhores (“Melhorada”/“Premium”) podem ser baixadas em Ajustes do Sistema → Acessibilidade → Conteúdo Falado → Voz do Sistema → Gerenciar Vozes. Reinicie o <code>npm run dev</code> depois.</p>
            </fieldset>
          } @else {
            <p class="muted">Grave a narração de cada trecho fora do sistema e importe os áudios na etapa 1. Nenhuma fala é cortada: se o áudio for maior que a cena, o sistema avisa.</p>
          }
          @if (tooLongCount() > 0) {
            <div class="notice err" role="alert">
              <strong>{{ tooLongCount() }} trecho(s) com narração maior que a cena.</strong> Nada é cortado. Você pode estender as cenas automaticamente (o vídeo continua mostrando a gameplay logo depois do trecho marcado) ou encurtar o texto no roteiro.
              <p><button class="primary" type="button" (click)="fit(s.id)">Estender cenas para caber a narração</button></p>
            </div>
          }
          <div class="field" style="max-width:320px">
            <label for="fmt">Formato de saída</label>
            <select id="fmt" [ngModel]="format()" (ngModelChange)="setFormat($event)">
              <option value="horizontal">Horizontal 1920x1080 (vídeo longo)</option>
              <option value="vertical">Vertical 1080x1920 (Short)</option>
            </select>
          </div>
          @for (seg of s.segments; track seg.id; let i = $index) {
            <fieldset class="card">
              <legend><strong>Trecho {{ i + 1 }}</strong> — {{ roleLabel[seg.role] }} · cena {{ fmtMs(seg.sourceRefs[0]!.startMs) }}–{{ fmtMs(seg.sourceRefs[0]!.endMs) }} ({{ (seg.targetDurationMs / 1000).toFixed(1) }} s)</legend>
              <p>“{{ seg.narrationText || '(sem texto)' }}”</p>
              <div class="row">
                <div class="field">
                  <label [for]="'nar-' + i">Áudio da narração</label>
                  <select [id]="'nar-' + i" [ngModel]="narration()[seg.id] ?? ''" (ngModelChange)="setNarration(seg.id, $event)">
                    <option value="">— sem narração (só som do jogo) —</option>
                    @for (a of audios(); track a.id) { <option [value]="a.id">{{ a.originalName }} ({{ fmtMs(a.durationMs) }})</option> }
                  </select>
                  @if (narrationTooLong(seg.id, seg.targetDurationMs); as over) {
                    <span class="badge err">Áudio {{ (over / 1000).toFixed(1) }} s maior que a cena</span>
                  }
                </div>
                @if (narration()[seg.id]; as aid) {
                  <div class="field"><span class="muted">Ouvir narração do trecho {{ i + 1 }}</span><audio controls preload="none" [src]="api.audioUrl(aid)" [attr.aria-label]="'Ouvir narração do trecho ' + (i + 1)" style="width:100%"></audio></div>
                }
              </div>
              @if (sourceOf(seg.sourceRefs[0]!.assetId); as src) {
                @if (needsCrop(src)) {
                  <div class="row">
                    <div class="crop-box">
                      <img [src]="api.frameUrl(src.id, midMs(seg))" [alt]="'Quadro do meio da cena do trecho ' + (i + 1) + ' com a área enquadrada'" />
                      <div class="frame" [style.left.%]="crop(seg.id, src).x * 100" [style.top.%]="crop(seg.id, src).y * 100" [style.width.%]="crop(seg.id, src).width * 100" [style.height.%]="crop(seg.id, src).height * 100"></div>
                    </div>
                    <div class="field" style="max-width:300px">
                      <label [for]="'cx-' + i">Posição do enquadramento {{ format() === 'vertical' ? '(esquerda ↔ direita)' : '(cima ↕ baixo)' }}</label>
                      <input type="range" [id]="'cx-' + i" min="0" max="1" step="0.01" [ngModel]="pos(seg.id)" (ngModelChange)="setCropPos(seg.id, $event)"
                        [attr.aria-valuetext]="Math.round(pos(seg.id) * 100) + '%'" />
                      <div class="row" style="margin-top:6px">
                        <button type="button" class="small" (click)="nudge(seg.id, -0.05)" [attr.aria-label]="'Mover enquadramento do trecho ' + (i + 1) + ' para ' + (format() === 'vertical' ? 'a esquerda' : 'cima')">{{ format() === 'vertical' ? '← Esquerda' : '↑ Cima' }}</button>
                        <button type="button" class="small" (click)="setCropPos(seg.id, 0.5)">Centro</button>
                        <button type="button" class="small" (click)="nudge(seg.id, 0.05)" [attr.aria-label]="'Mover enquadramento do trecho ' + (i + 1) + ' para ' + (format() === 'vertical' ? 'a direita' : 'baixo')">{{ format() === 'vertical' ? 'Direita →' : 'Baixo ↓' }}</button>
                      </div>
                      @if (isDirty(seg.id)) { <span class="badge warn" role="status">Enquadramento alterado — não salvo</span> }
                      @else if (savedPos()[seg.id] != null) { <span class="badge ok">Enquadramento salvo</span> }
                      <span class="muted">A imagem mostra o meio da cena deste trecho. Mantenha visível o carro e o HUD (posição/volta) quando forem importantes.</span>
                    </div>
                  </div>
                } @else { <p class="muted">Proporção do vídeo já é {{ format() === 'vertical' ? '9:16' : '16:9' }}: quadro inteiro, sem recorte.</p> }
              }
            </fieldset>
          }
          @if (buildError(); as err) {
            <div class="notice err" role="alert"><strong>{{ err.message }}</strong>
              @if (err.items.length) { <ul>@for (it of err.items; track $index) { <li>{{ it }}</li> }</ul> }
            </div>
          }
          <div class="row">
            @if (canReviseCrops()) {
              <button class="primary" type="button" (click)="saveCrops()" [disabled]="!anyDirty()">Salvar enquadramento</button>
              <button type="button" (click)="build()">Montar timeline de novo (narração/formato)</button>
              @if (!anyDirty()) { <span class="muted">Enquadramento salvo na timeline v{{ timeline()!.version }}.</span> }
            } @else {
              <button class="primary" type="button" (click)="build()">Montar timeline (salva narração e enquadramento)</button>
              @if (timeline() && timeline()!.format !== format()) { <span class="muted">A timeline atual é {{ timeline()!.format }}; montar cria uma nova no formato {{ format() }}.</span> }
            }
          </div>
        </section>

        @if (timeline(); as t) {
          <section class="card stack">
            <h2>2. Revisar a timeline v{{ t.version }} ({{ t.format === 'vertical' ? 'vertical' : 'horizontal' }})</h2>
            @if (t.stale) { <p class="notice">Esta timeline ficou desatualizada por uma alteração posterior. Monte novamente.</p> }
            <p>Duração total: <strong>{{ fmtMs(total(t)) }}</strong> · {{ t.clips.length }} clip(s) · {{ t.audioTracks.length }} narração(ões)</p>
            <h3>Legendas</h3>
            <p class="muted">{{ t.captionsOrigin === 'edited' ? 'Editadas por você.' : 'Estimadas a partir do texto e da duração real do áudio — confira e corrija.' }} Máximo de 2 linhas por legenda (use Enter para quebrar).</p>
            @if (captions().length === 0) { <p class="muted">Sem legendas (nenhum trecho com narração).</p> }
            <table>
              <caption class="sr-only">Legendas editáveis</caption>
              <thead><tr><th scope="col">Início (s)</th><th scope="col">Fim (s)</th><th scope="col">Texto</th><th scope="col"><span class="sr-only">Ações</span></th></tr></thead>
              <tbody>
                @for (c of captions(); track $index; let i = $index) {
                  <tr>
                    <td><input type="number" step="0.1" min="0" [(ngModel)]="c.startS" [attr.aria-label]="'Início da legenda ' + (i + 1)" style="max-width:90px" /></td>
                    <td><input type="number" step="0.1" min="0" [(ngModel)]="c.endS" [attr.aria-label]="'Fim da legenda ' + (i + 1)" style="max-width:90px" /></td>
                    <td><textarea rows="2" style="min-height:52px" [(ngModel)]="c.text" [attr.aria-label]="'Texto da legenda ' + (i + 1)"></textarea></td>
                    <td><button class="small" type="button" (click)="removeCaption(i)" [attr.aria-label]="'Remover legenda ' + (i + 1)">Remover</button></td>
                  </tr>
                }
              </tbody>
            </table>
            <button class="small" type="button" (click)="addCaption()">+ Legenda</button>
            <h3>Mixagem</h3>
            <div class="row">
              <div class="field" style="max-width:260px">
                <label for="duck">Som do jogo durante a narração: {{ Math.round(mix.duckedGameVolume * 100) }}%</label>
                <input id="duck" type="range" min="0" max="1" step="0.05" [(ngModel)]="mix.duckedGameVolume" />
              </div>
              <div class="field" style="max-width:260px">
                <label for="game">Som do jogo sem narração: {{ Math.round(mix.gameVolume * 100) }}%</label>
                <input id="game" type="range" min="0" max="1.5" step="0.05" [(ngModel)]="mix.gameVolume" />
              </div>
              <div class="field" style="max-width:260px">
                <label for="narv">Volume da narração: {{ Math.round(mix.narrationVolume * 100) }}%</label>
                <input id="narv" type="range" min="0" max="2" step="0.05" [(ngModel)]="mix.narrationVolume" />
              </div>
            </div>
            <p class="muted">Volume final é normalizado para {{ t.mix.targetLufs }} LUFS (pico até {{ t.mix.truePeakDb }} dBTP) e medido no render.</p>
            <div class="row">
              <button type="button" (click)="saveAdjustments(t)" [disabled]="t.stale">Salvar ajustes (nova versão)</button>
              <button class="primary" type="button" (click)="renderPreview(t)" [disabled]="t.stale">Renderizar preview</button>
            </div>
          </section>

          @if (preview(); as r) {
            <section class="card stack">
              <h2>3. Preview</h2>
              @if (r.status === 'succeeded') {
                <video controls [src]="api.renderFileUrl(r)" crossorigin="anonymous" aria-label="Preview do vídeo">
                  <track kind="captions" srclang="pt-BR" label="Português" [src]="api.captionsVttUrl(r.timelineVersionId)" default />
                </video>
                <p class="muted">Preview em meia resolução. Loudness medido: {{ r.diagnostics['loudness']?.integratedLufs ?? '—' }} LUFS. Se algo estiver errado, ajuste acima ou volte ao roteiro.</p>
                <button class="primary" type="button" (click)="next.emit()">Ficou bom: ir para a entrega →</button>
              } @else if (r.status === 'failed') {
                <p class="notice err" role="alert">O render falhou. Veja o aviso no topo da página e tente de novo.</p>
              } @else { <p class="muted">Renderizando… acompanhe o progresso no topo da página.</p> }
            </section>
          }
        }
      }
    } @else { <p class="notice">Escreva e revise o roteiro na etapa 3.</p> }
  `,
})
export class AssemblyStep {
  protected api = inject(Api);
  private notifier = inject(Notifier);
  protected store = inject(ProjectStore);
  readonly next = output<void>();
  protected readonly Math = Math;
  protected readonly fmtMs = fmtMs;
  protected readonly roleLabel = ROLE_LABEL;

  protected script = computed(() => this.store.data()?.latestScript ?? null);
  protected audios = computed(() => (this.store.data()?.assets ?? []).filter((a) => a.kind === 'audio'));
  protected timeline = computed(() => { const t = this.store.data()?.latestTimeline; return t && t.scriptVersionId === this.script()?.id ? t : null; });
  protected preview = computed(() => { const t = this.timeline(); return t ? (this.store.data()?.renders ?? []).find((r) => r.timelineVersionId === t.id && r.profile === 'preview') ?? null : null; });

  protected format = signal<'horizontal' | 'vertical'>('horizontal');
  protected narration = signal<Record<string, string>>({});
  protected cropPos = signal<Record<string, number>>({});
  protected buildError = signal<{ message: string; items: string[] } | null>(null);
  protected captions = signal<{ startS: number; endS: number; text: string }[]>([]);
  protected mix: Timeline['mix'] = { gameVolume: 1, duckedGameVolume: 0.25, narrationVolume: 1, targetLufs: -14, truePeakDb: -1 };
  private syncedTimeline: string | null = null;
  private initialized = false;

  protected voices = signal<{ id: string; name: string }[]>([]);
  protected voice = signal('');
  protected rate = signal(175);
  protected voiceBusy = computed(() => (this.store.data()?.jobs ?? []).some((j) => j.type === 'voice' && (j.status === 'queued' || j.status === 'running')));
  protected tooLongCount = computed(() => (this.script()?.segments ?? []).filter((s) => this.narrationTooLong(s.id, s.targetDurationMs)).length);
  private narrationKey: string | null = null;

  constructor() {
    this.api.capabilities().then((c) => {
      const vs = (c.providers?.voice?.voices ?? []) as { id: string; name: string }[];
      this.voices.set(vs);
      this.voice.set(vs.find((v) => v.name === 'Luciana')?.id ?? vs[0]?.id ?? '');
    }).catch(() => this.voices.set([]));

    // Quando o roteiro muda ou uma geração de voz termina, preenche os áudios gerados de cada trecho.
    effect(() => {
      const s = this.script();
      const done = (this.store.data()?.jobs ?? []).filter((j) => j.type === 'voice' && j.status === 'succeeded').length;
      if (!s) return;
      const key = `${s.id}:${done}`;
      if (key === this.narrationKey) return;
      this.narrationKey = key;
      this.api.narration(s.id).then((map) => {
        this.narration.update((n) => {
          const x = { ...n };
          for (const [segId, v] of Object.entries(map)) x[segId] = v.assetId;
          return x;
        });
      }).catch((e) => this.notifier.error(e));
    });

    effect(() => {
      const d = this.store.data();
      if (!d) return;
      if (!this.initialized) {
        this.initialized = true;
        this.format.set(d.latestTimeline?.format ?? (d.project.template === 'short' ? 'vertical' : 'horizontal'));
        if (d.latestTimeline) this.narration.set(Object.fromEntries(d.latestTimeline.audioTracks.map((a) => [a.segmentId, a.assetId])));
      }
      const t = this.timeline();
      if (t && t.id !== this.syncedTimeline) {
        this.syncedTimeline = t.id;
        this.captions.set(t.captions.map((c) => ({ startS: c.startMs / 1000, endS: c.endMs / 1000, text: c.text })));
        this.mix = { ...t.mix };
      }
    });
  }

  sourceOf(assetId: string): Asset | undefined { return this.store.data()?.assets.find((a) => a.id === assetId); }
  needsCrop(a: Asset) { const c = defaultCrop(this.format(), a.width ?? 1920, a.height ?? 1080); return c.width < 1 || c.height < 1; }

  /** Posição salva na timeline atual (mesmo formato), por trecho: 0 = esquerda/topo, 1 = direita/base. */
  protected savedPos = computed(() => {
    const t = this.timeline();
    if (!t || t.stale || t.format !== this.format()) return {} as Record<string, number>;
    const out: Record<string, number> = {};
    for (const clip of t.clips) {
      const a = this.sourceOf(clip.sourceRef.assetId);
      const c = defaultCrop(t.format, a?.width ?? 1920, a?.height ?? 1080);
      out[clip.segmentId] = c.width < 1 ? clip.crop.x / (1 - c.width) : c.height < 1 ? clip.crop.y / (1 - c.height) : 0.5;
    }
    return out;
  });
  protected canReviseCrops = computed(() => { const t = this.timeline(); return !!t && !t.stale && t.format === this.format(); });
  protected anyDirty = computed(() => Object.keys(this.cropPos()).some((id) => this.isDirty(id)));

  pos(segId: string) { return this.cropPos()[segId] ?? this.savedPos()[segId] ?? 0.5; }
  isDirty(segId: string) { const v = this.cropPos()[segId]; return v != null && Math.abs(v - (this.savedPos()[segId] ?? 0.5)) > 0.001; }
  nudge(segId: string, d: number) { this.setCropPos(segId, Math.min(1, Math.max(0, Math.round((this.pos(segId) + d) * 100) / 100))); }
  midMs(seg: { sourceRefs: { startMs: number; endMs: number }[] }) { const r = seg.sourceRefs[0]!; return Math.round((r.startMs + r.endMs) / 2); }

  private currentCrops(): Record<string, Crop> {
    const crops: Record<string, Crop> = {};
    for (const seg of this.script()?.segments ?? []) { const src = this.sourceOf(seg.sourceRefs[0]!.assetId); if (src) crops[seg.id] = this.crop(seg.id, src); }
    return crops;
  }

  async saveCrops() {
    const t = this.timeline();
    if (!t) return;
    try {
      const r = await this.api.reviseTimeline(t.id, { crops: this.currentCrops() });
      this.cropPos.set({});
      this.notifier.success(`Enquadramento salvo (timeline v${r.timeline.version}). Renderize o preview para conferir.`);
      await this.store.load();
    } catch (e) { this.notifier.error(e); }
  }

  crop(segId: string, a: Asset): Crop {
    const c = defaultCrop(this.format(), a.width ?? 1920, a.height ?? 1080);
    const pos = this.pos(segId);
    return { ...c, x: c.width < 1 ? (1 - c.width) * pos : 0, y: c.height < 1 ? (1 - c.height) * pos : 0 };
  }

  narrationTooLong(segId: string, sceneMs: number): number | null {
    const a = this.audios().find((x) => x.id === this.narration()[segId]);
    return a?.durationMs && a.durationMs > sceneMs ? a.durationMs - sceneMs : null;
  }

  setFormat(f: 'horizontal' | 'vertical') { this.format.set(f); this.cropPos.set({}); }
  setNarration(segId: string, assetId: string) { this.narration.update((n) => { const x = { ...n }; if (assetId) x[segId] = assetId; else delete x[segId]; return x; }); }
  setCropPos(segId: string, v: number) { this.cropPos.update((c) => ({ ...c, [segId]: Number(v) })); }
  addCaption() { const last = this.captions().at(-1); this.captions.update((c) => [...c, { startS: last?.endS ?? 0, endS: (last?.endS ?? 0) + 2, text: '' }]); }
  removeCaption(i: number) { this.captions.update((c) => c.filter((_, j) => j !== i)); }
  total(t: Timeline) { return t.clips.reduce((n, c) => n + c.durationMs, 0); }

  async generateVoice(scriptId: string) {
    if (!this.voice()) return;
    try {
      const r = await this.api.generateVoice(scriptId, this.voice(), this.rate());
      this.notifier.info(r.reused ? 'Esta narração já foi gerada com essa voz e velocidade.' : 'Gerando a narração… acompanhe no topo da página.');
      await this.store.load();
    } catch (e) { this.notifier.error(e); }
  }

  async fit(scriptId: string) {
    try {
      const r = await this.api.fitNarration(scriptId, this.narration());
      const msg = r.changes.map((c) => `trecho ${c.segmentIndex + 1}: ${(c.fromMs / 1000).toFixed(1)} s → ${(c.toMs / 1000).toFixed(1)} s`).join('; ');
      if (r.problems.length) this.notifier.error(new Error(r.problems.join(' ')));
      else this.notifier.success(r.changed ? `Cenas estendidas (roteiro v${r.script.version}): ${msg}. Agora clique em "Montar timeline".` : 'Todas as narrações já cabem nas cenas.');
      await this.store.load();
    } catch (e) { this.notifier.error(e); }
  }

  async build() {
    const s = this.script();
    const id = this.store.id();
    if (!s || !id) return;
    const crops = this.currentCrops();
    this.buildError.set(null);
    try {
      const r = await this.api.createTimeline(id, { scriptVersionId: s.id, format: this.format(), narration: this.narration(), crops });
      this.cropPos.set({});
      this.notifier.success(`Timeline v${r.timeline.version} montada com narração e enquadramento.`);
      await this.store.load();
    } catch (e) {
      if (e instanceof ApiError) {
        const items = Array.isArray(e.body.details) ? e.body.details.map((d: any) => d.segmentIndex != null
          ? `Trecho ${d.segmentIndex + 1}: narração de ${(d.narrationMs / 1000).toFixed(1)} s para ${(d.availableMs / 1000).toFixed(1)} s de cena. ${d.suggestion}`
          : d.message ?? JSON.stringify(d)) : [];
        this.buildError.set({ message: e.body.message, items });
      }
      this.notifier.error(e);
    }
  }

  async saveAdjustments(t: Timeline) {
    const captions: Caption[] = this.captions().filter((c) => c.text.trim()).map((c) => ({ startMs: Math.round(c.startS * 1000), endMs: Math.round(c.endS * 1000), text: c.text.trim() }));
    try {
      const r = await this.api.reviseTimeline(t.id, { captions, mix: this.mix, crops: this.currentCrops() });
      this.cropPos.set({});
      this.notifier.success(`Ajustes salvos na timeline v${r.timeline.version}.`);
      await this.store.load();
    } catch (e) { this.notifier.error(e); }
  }

  async renderPreview(t: Timeline) {
    try {
      const r = await this.api.render(t.id, 'preview');
      this.notifier.info(r.reused ? 'Este preview já existe ou está em andamento.' : 'Preview enviado para a fila.');
      await this.store.load();
    } catch (e) { this.notifier.error(e); }
  }
}
