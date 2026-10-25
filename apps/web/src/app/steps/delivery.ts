import { DatePipe } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, Notifier } from '../api.service';
import { fmtBytes, fmtMs, type Render } from '../models';
import { ProjectStore } from '../project.store';

@Component({
  selector: 'app-delivery-step',
  imports: [FormsModule, DatePipe],
  template: `
    @if (timeline(); as t) {
      <section class="card stack">
        <h2>1. Render final</h2>
        <p class="muted">Gera o MP4 em resolução cheia ({{ t.format === 'vertical' ? '1080x1920' : '1920x1080' }}, 30 fps, H.264 + AAC) a partir da timeline v{{ t.version }}.</p>
        @if (t.stale) { <p class="notice">A timeline ficou desatualizada. Monte novamente na etapa 4.</p> }
        @if (!finalRender()) { <button class="primary" type="button" (click)="renderFinal()" [disabled]="t.stale">Renderizar versão final</button> }
        @if (finalRender(); as r) {
          @if (r.status === 'succeeded') {
            <video controls [src]="api.renderFileUrl(r)" crossorigin="anonymous" aria-label="Vídeo final">
              <track kind="captions" srclang="pt-BR" label="Português" [src]="api.captionsVttUrl(r.timelineVersionId)" default />
            </video>
            <table>
              <caption class="sr-only">Verificação técnica do arquivo</caption>
              <tbody>
                <tr><th scope="row">Validação (ffprobe + decodificação)</th><td>{{ r.diagnostics['check']?.ok ? '✅ aprovado' : '❌ ' + (r.diagnostics['check']?.problems ?? []).join('; ') }}</td></tr>
                <tr><th scope="row">Duração</th><td>{{ fmtMs(r.durationMs) }}</td></tr>
                <tr><th scope="row">Resolução / codecs</th><td>{{ r.diagnostics['check']?.width }}x{{ r.diagnostics['check']?.height }} · {{ r.diagnostics['check']?.videoCodec }} {{ r.diagnostics['check']?.pixFmt }} · {{ r.diagnostics['check']?.audioCodec }}</td></tr>
                <tr><th scope="row">Loudness</th><td>{{ r.diagnostics['loudness']?.integratedLufs ?? '—' }} LUFS integrado (alvo {{ t.mix.targetLufs }})</td></tr>
                <tr><th scope="row">Legendas</th><td>{{ r.diagnostics['captions'] }}</td></tr>
                <tr><th scope="row">SHA-256</th><td><code style="word-break:break-all">{{ r.sha256 }}</code></td></tr>
              </tbody>
            </table>
            <a class="btn" [href]="api.renderFileUrl(r, true)" download>Baixar MP4</a>
          } @else if (r.status === 'failed' || r.status === 'cancelled') {
            <p class="notice err" role="alert">O render final {{ r.status === 'failed' ? 'falhou' : 'foi cancelado' }}.</p>
            <button class="primary" type="button" (click)="renderFinal()">Renderizar novamente</button>
          } @else { <p class="muted">Renderizando… acompanhe o progresso no topo da página.</p> }
        }
      </section>

      @if (finalRender()?.status === 'succeeded') {
        <section class="card stack">
          <h2>2. Aprovar esta versão</h2>
          <p class="muted">A aprovação vale para o pacote exato: este MP4, as legendas, o título/descrição e a thumbnail escolhida. Qualquer alteração depois disso invalida a aprovação.</p>
          <div class="field"><label for="title">Título (sugestão sua — não prometa o que não aparece no vídeo)</label><input id="title" [(ngModel)]="meta.title" maxlength="100" /></div>
          <div class="field"><label for="desc">Descrição</label><textarea id="desc" [(ngModel)]="meta.description"></textarea></div>
          <div class="row">
            <div class="field"><label for="tags">Tags (separadas por vírgula)</label><input id="tags" [(ngModel)]="meta.tags" /></div>
            <div class="field">
              <label for="thumb">Thumbnail (opcional — imagem importada na etapa 1)</label>
              <select id="thumb" [(ngModel)]="meta.thumbnailAssetId">
                <option value="">— nenhuma —</option>
                @for (img of images(); track img.id) { <option [value]="img.id">{{ img.originalName }}</option> }
              </select>
            </div>
          </div>
          <fieldset>
            <legend><strong>Checklist antes de aprovar</strong></legend>
            @for (c of checklist; track c.id) {
              <label class="check"><input type="checkbox" [(ngModel)]="checks[c.id]" [name]="c.id" /> {{ c.label }}</label>
            }
          </fieldset>
          <button class="primary" type="button" (click)="approve(finalRender()!)" [disabled]="!allChecked() || !meta.title.trim()">Aprovar versão</button>
          @if (!allChecked()) { <span class="muted">Marque todos os itens do checklist.</span> }
        </section>
      }

      <section class="card stack">
        <h2>3. Aprovações e exportação</h2>
        @if (approvals().length === 0) { <p class="muted">Nenhuma aprovação ainda.</p> }
        <table>
          <caption class="sr-only">Histórico de aprovações</caption>
          @if (approvals().length) { <thead><tr><th scope="col">Aprovado</th><th scope="col">Título</th><th scope="col">Situação</th><th scope="col">Ação</th></tr></thead> }
          <tbody>
            @for (a of approvals(); track a.id) {
              <tr>
                <td>{{ a.approvedAt | date: 'dd/MM/yyyy HH:mm' }} por {{ a.approvedBy }}</td>
                <td>{{ a.manifest['metadata']?.title }}</td>
                <td>
                  @if (a.invalidatedAt) { <span class="badge err">Invalidada</span> <span class="muted">{{ a.invalidationReason }}</span> }
                  @else { <span class="badge ok">Válida</span> }
                </td>
                <td>@if (!a.invalidatedAt) { <button class="primary small" type="button" (click)="exportPkg(a.id)">Exportar pacote</button> }</td>
              </tr>
            }
          </tbody>
        </table>
        @for (e of exports(); track e.id) {
          <article class="card">
            <h3>Pacote exportado em {{ e.createdAt | date: 'dd/MM/yyyy HH:mm' }}</h3>
            <ul>
              @for (f of e.files; track f.name) { <li><a [href]="api.exportFileUrl(e, f.name)" download>{{ f.name }}</a> <span class="muted">({{ fmtBytes(f.sizeBytes) }})</span></li> }
            </ul>
            <p class="muted">Os arquivos também ficam em <code>data/storage/exports/{{ e.id }}/</code>. Publique manualmente no YouTube — a integração automática é uma etapa futura (P1).</p>
          </article>
        }
      </section>
    } @else { <p class="notice">Monte a timeline na etapa 4 primeiro.</p> }
  `,
})
export class DeliveryStep {
  protected api = inject(Api);
  private notifier = inject(Notifier);
  protected store = inject(ProjectStore);
  protected readonly fmtMs = fmtMs;
  protected readonly fmtBytes = fmtBytes;
  protected timeline = computed(() => this.store.data()?.latestTimeline ?? null);
  protected finalRender = computed(() => { const t = this.timeline(); return t ? (this.store.data()?.renders ?? []).find((r) => r.timelineVersionId === t.id && r.profile === 'final') ?? null : null; });
  protected images = computed(() => (this.store.data()?.assets ?? []).filter((a) => a.kind === 'image'));
  protected approvals = computed(() => this.store.data()?.approvals ?? []);
  protected exports = computed(() => this.store.data()?.exports ?? []);
  protected meta = { title: '', description: '', tags: '', thumbnailAssetId: '' };
  protected readonly checklist = [
    { id: 'fontes', label: 'Assisti ao vídeo inteiro e a narração só afirma o que aparece na gameplay.' },
    { id: 'audio', label: 'O som do jogo e a narração estão audíveis e sincronizados.' },
    { id: 'legendas', label: 'As legendas estão corretas e não cobrem o HUD/carro em momentos importantes.' },
    { id: 'direitos', label: 'Tenho direito de uso de todas as gravações, músicas e vozes usadas.' },
  ];
  protected checks: Record<string, boolean> = {};

  allChecked() { return this.checklist.every((c) => this.checks[c.id]); }

  async renderFinal() {
    const t = this.timeline();
    if (!t) return;
    try { await this.api.render(t.id, 'final'); this.notifier.info('Render final enviado para a fila.'); await this.store.load(); } catch (e) { this.notifier.error(e); }
  }

  async approve(r: Render) {
    const id = this.store.id();
    if (!id) return;
    try {
      await this.api.approve(id, {
        renderId: r.id, checklistConfirmed: true, thumbnailAssetId: this.meta.thumbnailAssetId || null,
        metadata: { title: this.meta.title.trim(), description: this.meta.description, tags: this.meta.tags.split(',').map((x) => x.trim()).filter(Boolean), channel: null },
      });
      this.notifier.success('Versão aprovada. Agora você pode exportar o pacote.');
      this.checks = {};
      await this.store.load();
    } catch (e) { this.notifier.error(e); }
  }

  async exportPkg(approvalId: string) {
    const id = this.store.id();
    if (!id) return;
    try { await this.api.exportPackage(id, approvalId); this.notifier.info('Exportação enviada para a fila.'); await this.store.load(); } catch (e) { this.notifier.error(e); }
  }
}
