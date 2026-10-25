import { HttpErrorResponse, HttpEventType } from '@angular/common/http';
import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, ApiError, describeError, Notifier } from '../api.service';
import { type Asset, fmtBytes, fmtMs } from '../models';
import { ProjectStore } from '../project.store';

@Component({
  selector: 'app-media-step',
  imports: [FormsModule],
  template: `
    <section class="card" aria-labelledby="imp-titulo">
      <h2 id="imp-titulo">Importar arquivos</h2>
      <p class="muted">Vídeo da gameplay (MP4, MOV, MKV) e, depois, os áudios da narração (WAV, MP3, M4A). O arquivo original é copiado para o estúdio e nunca é alterado.</p>
      <form class="stack" (ngSubmit)="upload()">
        <div class="row">
          <div class="field"><label for="owner">1. Dono/autor do material (obrigatório)</label><input id="owner" name="owner" [(ngModel)]="rights.owner" required placeholder="Ex.: Fabio — gravação própria" [attr.aria-invalid]="ownerMissing()" /></div>
          <div class="field">
            <label for="usage">Direito de uso</label>
            <select id="usage" name="usage" [(ngModel)]="rights.usage">
              <option value="proprio">Gravação/criação própria</option>
              <option value="licenciado">Licenciado (tenho licença)</option>
              <option value="outro">Outro (explique nas notas)</option>
            </select>
          </div>
          <div class="field"><label for="notes">Notas de direitos (opcional)</label><input id="notes" name="notes" [(ngModel)]="rights.notes" /></div>
        </div>
        <div class="row">
          <div class="field"><label for="car">Carro (opcional)</label><input id="car" name="car" [(ngModel)]="meta.carLabel" /></div>
          <div class="field"><label for="tags">Tags separadas por vírgula (opcional)</label><input id="tags" name="tags" [(ngModel)]="meta.tags" /></div>
        </div>
        <div class="field">
          <label for="file">2. Escolha o arquivo — o envio começa automaticamente</label>
          <input id="file" type="file" accept=".mp4,.mov,.mkv,.wav,.mp3,.m4a,.aac,.flac,.ogg,.jpg,.jpeg,.png" (change)="pick($event)" aria-describedby="file-help" />
          <span id="file-help" class="muted">Dica: grave a gameplay em 1080p ou mais, 30/60 fps.</span>
        </div>
        @if (file() && uploadPct() == null) {
          <p class="notice">Arquivo selecionado: <strong>{{ file()!.name }}</strong> ({{ fmtBytes(file()!.size) }}).
            @if (ownerMissing()) { Preencha o <strong>dono/autor</strong> acima e clique em Importar. }</p>
          <button class="primary" type="submit">Importar</button>
        }
        @if (uploadPct() != null) {
          <label for="up-prog">Enviando {{ file()?.name }}… {{ uploadPct() }}%</label>
          <progress id="up-prog" max="100" [value]="uploadPct()"></progress>
        }
        @if (lastError(); as err) { <div class="notice err" role="alert"><strong>Não foi possível importar:</strong> {{ err }}</div> }
        @if (lastOk(); as ok) { <div class="notice ok" role="status">{{ ok }}</div> }
      </form>
    </section>

    <section aria-labelledby="bib-titulo">
      <h2 id="bib-titulo">Biblioteca do projeto</h2>
      <div class="row" role="group" aria-label="Filtro">
        <div class="field" style="max-width:220px">
          <label for="filtro">Mostrar</label>
          <select id="filtro" [ngModel]="filter()" (ngModelChange)="filter.set($event)">
            <option value="all">Todos</option><option value="video">Vídeos</option><option value="audio">Áudios</option><option value="image">Imagens</option>
          </select>
        </div>
      </div>
      @if (shown().length === 0) { <p class="muted">Nada importado ainda.</p> }
      <div class="grid">
        @for (a of shown(); track a.id) {
          <article class="card">
            @if (a.kind === 'video' && a.status === 'ready') { <img class="thumb" [src]="api.thumbUrl(a)" [alt]="'Miniatura de ' + a.originalName" /> }
            @if (a.kind === 'image') { <img class="thumb" [src]="api.thumbUrl(a)" [alt]="a.originalName" /> }
            <h3>{{ a.originalName }}</h3>
            <p>
              <span class="badge" [class.ok]="a.status === 'ready'" [class.warn]="a.status === 'processing'" [class.err]="a.status === 'failed'">
                {{ a.status === 'ready' ? 'Pronto' : a.status === 'processing' ? 'Processando (proxy e miniatura)…' : 'Falhou' }}
              </span>
              <span class="badge">{{ kindLabel[a.kind] }}</span>
              @if (a.duplicateOf) { <span class="badge warn">Duplicata</span> }
            </p>
            <p class="muted">
              @if (a.durationMs != null) { Duração {{ fmtMs(a.durationMs) }} · }
              @if (a.width) { {{ a.width }}x{{ a.height }} · {{ a.fps }} fps · }
              {{ a.videoCodec ?? a.audioCodec ?? '' }} · {{ fmtBytes(a.sizeBytes) }} · {{ a.hasAudio ? 'com áudio' : 'sem áudio' }}
            </p>
            @if (a.carLabel || a.tags.length) { <p class="muted">{{ a.carLabel }} {{ a.tags.length ? '· ' + a.tags.join(', ') : '' }}</p> }
            <p class="muted">Direitos: {{ a.rightsDeclaration.owner }} ({{ a.rightsDeclaration.usage }})</p>
            <details><summary>SHA-256</summary><code style="word-break:break-all">{{ a.sha256 }}</code></details>
            @if (a.kind === 'audio') { <audio controls [src]="api.proxyUrl(a)" [attr.aria-label]="'Ouvir ' + a.originalName" style="width:100%"></audio> }
          </article>
        }
      </div>
      @if (hasReadyVideo()) { <button class="primary" type="button" (click)="next.emit()">Próximo: marcar cenas →</button> }
    </section>
  `,
})
export class MediaStep {
  protected api = inject(Api);
  private notifier = inject(Notifier);
  protected store = inject(ProjectStore);
  readonly next = output<void>();
  protected readonly fmtMs = fmtMs;
  protected readonly fmtBytes = fmtBytes;
  protected readonly kindLabel = { video: 'Vídeo', audio: 'Áudio', image: 'Imagem' };
  protected file = signal<File | null>(null);
  protected uploadPct = signal<number | null>(null);
  protected filter = signal<'all' | Asset['kind']>('all');
  protected rights = { owner: readOwner(), usage: 'proprio', notes: '' };
  protected meta = { carLabel: '', tags: '' };
  protected lastError = signal<string | null>(null);
  protected lastOk = signal<string | null>(null);
  protected shown = computed(() => (this.store.data()?.assets ?? []).filter((a) => this.filter() === 'all' || a.kind === this.filter()));
  protected hasReadyVideo = computed(() => (this.store.data()?.assets ?? []).some((a) => a.kind === 'video' && a.status === 'ready'));

  ownerMissing() { return !this.rights.owner.trim(); }

  pick(ev: Event) {
    this.file.set((ev.target as HTMLInputElement).files?.[0] ?? null);
    this.lastError.set(null);
    this.lastOk.set(null);
    if (this.file() && !this.ownerMissing()) this.upload();
  }

  upload() {
    const file = this.file();
    const id = this.store.id();
    if (!file || !id) return;
    if (this.ownerMissing()) {
      this.lastError.set('Preencha o campo "Dono/autor do material" e clique em Importar.');
      document.getElementById('owner')?.focus();
      return;
    }
    try { localStorage.setItem('rs.rightsOwner', this.rights.owner); } catch { /* armazenamento indisponível */ }
    this.lastError.set(null);
    this.lastOk.set(null);
    this.uploadPct.set(0);
    this.api.upload(id, file, { rightsOwner: this.rights.owner, rightsUsage: this.rights.usage, rightsNotes: this.rights.notes, carLabel: this.meta.carLabel, tags: this.meta.tags }).subscribe({
      next: (ev) => {
        if (ev.type === HttpEventType.UploadProgress && ev.total) this.uploadPct.set(Math.round((ev.loaded / ev.total) * 100));
        if (ev.type === HttpEventType.Response) {
          const body = ev.body!;
          const msg = `${body.asset.originalName} importado.${body.warnings.length ? ' Atenção: ' + body.warnings.join(' ') : ''}${body.job ? ' Gerando a versão leve para o player — aguarde a etiqueta "Pronto" abaixo.' : ''}`;
          this.lastOk.set(msg);
          this.notifier.success(msg);
          this.uploadPct.set(null);
          this.file.set(null);
          (document.getElementById('file') as HTMLInputElement).value = '';
          this.store.load();
        }
      },
      error: (e: HttpErrorResponse) => {
        this.uploadPct.set(null);
        const err = e.error?.message ? new ApiError(e.status, e.error) : new Error(e.status === 0 ? 'Conexão interrompida. Verifique se o `npm run dev` está rodando.' : `Falha no envio (HTTP ${e.status}).`);
        this.lastError.set(err instanceof ApiError ? describeError(err) : err.message);
        this.notifier.error(err);
      },
    });
  }
}

function readOwner(): string {
  try { return localStorage.getItem('rs.rightsOwner') ?? ''; } catch { return ''; }
}
