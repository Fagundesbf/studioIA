import { Component, inject, OnInit, signal } from '@angular/core';
import { KeyValuePipe } from '@angular/common';
import { Api, Notifier } from '../api.service';

@Component({
  selector: 'app-settings',
  imports: [KeyValuePipe],
  template: `
    <h1>Configurações e capacidades</h1>
    <p class="muted">Mostra o que está realmente disponível nesta máquina. Nada aqui é simulado. Para alterar limites, edite o arquivo <code>.env</code> e reinicie (<code>npm run dev</code>).</p>
    @if (caps(); as c) {
      <section class="card">
        <h2>Mídia (FFmpeg)</h2>
        <table>
          <tbody>
            <tr><th scope="row">FFmpeg</th><td>{{ c.media.ffmpeg.available ? '✅ ' + c.media.ffmpeg.version : '❌ não encontrado' }}</td></tr>
            <tr><th scope="row">ffprobe</th><td>{{ c.media.ffprobe.available ? '✅ disponível' : '❌ não encontrado' }}</td></tr>
            <tr><th scope="row">Encoder H.264 (libx264)</th><td>{{ c.media.encoders.libx264 ? '✅ sim' : '❌ não' }}</td></tr>
            <tr><th scope="row">Aceleração (VideoToolbox / NVENC)</th><td>{{ c.media.encoders.h264_videotoolbox ? 'VideoToolbox ✅' : '' }} {{ c.media.encoders.h264_nvenc ? 'NVENC ✅' : '' }} <span class="muted">(o render usa libx264 por padrão — CPU, resultado previsível)</span></td></tr>
            <tr><th scope="row">Legenda gravada na imagem</th><td>{{ c.media.burnInCaptions ? '✅ disponível (libass)' : 'Indisponível nesta instalação — as legendas saem como arquivo SRT e faixa embutida no MP4.' }}</td></tr>
            <tr><th scope="row">Espaço livre</th><td>{{ (c.storage.freeMb / 1024).toFixed(1) }} GB</td></tr>
          </tbody>
        </table>
      </section>
      <section class="card">
        <h2>Provedores de IA</h2>
        <table>
          <thead><tr><th scope="col">Função</th><th scope="col">Situação</th><th scope="col">Observação</th></tr></thead>
          <tbody>
            @for (p of c.providers | keyvalue; track p.key) {
              <tr>
                <th scope="row">{{ names[$any(p.key)] ?? p.key }}</th>
                <td><span class="badge" [class.ok]="p.value.configured" [class.warn]="!p.value.configured">{{ p.value.configured ? 'Configurado' : 'Não configurado' }}</span></td>
                <td class="muted">{{ p.value.note }}</td>
              </tr>
            }
          </tbody>
        </table>
      </section>
      <section class="card">
        <h2>Limites</h2>
        <ul>
          <li>Tamanho máximo de importação: {{ c.limits.maxImportMb }} MB</li>
          <li>Duração máxima de importação: {{ c.limits.maxImportDurationMin }} min</li>
          <li>Espaço livre mínimo para renderizar: {{ c.limits.minFreeDiskMb }} MB</li>
          <li>Limiar de triagem de confiança: {{ c.limits.confidenceTriageThreshold }}</li>
        </ul>
      </section>
    } @else { <p class="muted">Carregando…</p> }
  `,
})
export class SettingsPage implements OnInit {
  private api = inject(Api);
  private notifier = inject(Notifier);
  protected caps = signal<any>(null);
  protected names: Record<string, string> = { llm: 'Texto (LLM)', vision: 'Análise visual', voice: 'Voz', transcription: 'Transcrição', publication: 'Publicação', grokbot: 'Grokbot' };

  async ngOnInit() {
    try { this.caps.set(await this.api.capabilities()); } catch (e) { this.notifier.error(e); }
  }
}
