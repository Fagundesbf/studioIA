import { HttpClient, HttpErrorResponse, HttpEvent, HttpHeaders } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom, Observable } from 'rxjs';
import type { Approval, Asset, Caption, Crop, ExportRecord, Job, Overview, Project, Render, ScriptVersion, Segment, StudioEvent, Timeline } from './models';

const BASE = '/api/v1';

export interface ApiErrorBody { code: string; message: string; requestId?: string; details?: any }

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: ApiErrorBody) { super(body.message); }
}

/** Mensagens curtas para o leitor de tela e para a faixa de avisos. */
@Injectable({ providedIn: 'root' })
export class Notifier {
  readonly message = signal<{ text: string; kind: 'info' | 'error' | 'success'; id: number } | null>(null);
  private n = 0;
  info(text: string) { this.message.set({ text, kind: 'info', id: ++this.n }); }
  success(text: string) { this.message.set({ text, kind: 'success', id: ++this.n }); }
  error(e: unknown) {
    const text = e instanceof ApiError ? describeError(e) : e instanceof Error ? e.message : String(e);
    this.message.set({ text, kind: 'error', id: ++this.n });
  }
}

export function describeError(e: ApiError): string {
  const d = e.body.details;
  if (Array.isArray(d) && d.length) {
    const items = d.slice(0, 5).map((x: any) => x.message ?? x.suggestion ?? JSON.stringify(x));
    return `${e.body.message}: ${items.join(' • ')}`;
  }
  return e.body.message;
}

const key = () => crypto.randomUUID();

@Injectable({ providedIn: 'root' })
export class Api {
  private http = inject(HttpClient);

  private async req<T>(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    try {
      return await firstValueFrom(this.http.request<T>(method, BASE + url, { body, headers: new HttpHeaders(headers ?? {}) }));
    } catch (e) {
      if (e instanceof HttpErrorResponse) {
        const body: ApiErrorBody = typeof e.error === 'object' && e.error?.message
          ? e.error
          : { code: 'NETWORK', message: e.status === 0 || e.status === 504 || e.status === 502 ? 'API indisponível. Verifique se `npm run dev` está rodando.' : `Erro HTTP ${e.status}` };
        throw new ApiError(e.status, body);
      }
      throw e;
    }
  }

  // Saúde e painel
  health() { return this.req<{ status: string }>('GET', '/health'); }
  capabilities() { return this.req<any>('GET', '/providers/capabilities'); }
  dashboard() { return this.req<{ projects: Project[]; recentJobs: Job[]; blocked: any[]; costs: any }>('GET', '/dashboard'); }

  // Projetos
  createProject(body: { title: string; gameLabel: string; template: string; objective: string }) { return this.req<Project>('POST', '/projects', body); }
  overview(id: string) { return this.req<Overview>('GET', `/projects/${id}`); }

  // Assets
  upload(projectId: string, file: File, fields: Record<string, string>): Observable<HttpEvent<{ asset: Asset; job: Job | null; warnings: string[] }>> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v); // campos antes do arquivo
    form.append('file', file, file.name);
    return this.http.post<{ asset: Asset; job: Job | null; warnings: string[] }>(`${BASE}/projects/${projectId}/assets`, form, { reportProgress: true, observe: 'events' });
  }
  updateAsset(id: string, body: { carLabel?: string | null; tags?: string[] }) { return this.req<Asset>('PATCH', `/assets/${id}`, body); }
  proxyUrl(a: Asset) { return `${BASE}/assets/${a.id}/proxy`; }
  thumbUrl(a: Asset) { return `${BASE}/assets/${a.id}/thumbnail`; }

  // Eventos
  analyze(projectId: string) { return this.req<{ job: Job }>('POST', `/projects/${projectId}/analysis`, {}, { 'Idempotency-Key': key() }); }
  createEvent(projectId: string, body: { assetId: string; startMs: number; endMs: number; type: string; description: string }) { return this.req<StudioEvent>('POST', `/projects/${projectId}/events`, body); }
  patchEvent(id: string, body: Partial<Pick<StudioEvent, 'review' | 'startMs' | 'endMs' | 'type' | 'description'>>) { return this.req<StudioEvent>('PATCH', `/events/${id}`, body); }

  // Roteiro
  saveScript(projectId: string, body: { status: 'draft' | 'reviewed'; segments: Segment[] }) {
    return this.req<{ script: ScriptVersion; pending: { path: string; code: string; message: string }[]; invalidated: string[]; unchanged: boolean }>('POST', `/projects/${projectId}/scripts`, body);
  }

  // Voz
  generateVoice(scriptId: string, voice: string, rate: number) { return this.req<{ job: Job; reused: boolean }>('POST', `/scripts/${scriptId}/voice`, { voice, rate }); }
  narration(scriptId: string) { return this.req<Record<string, { assetId: string; durationMs: number | null; voice: string }>>('GET', `/scripts/${scriptId}/narration`); }
  fitNarration(scriptId: string, narration: Record<string, string>) {
    return this.req<{ changed: boolean; changes: { segmentIndex: number; fromMs: number; toMs: number }[]; problems: string[]; script: ScriptVersion }>('POST', `/scripts/${scriptId}/fit-narration`, { narration });
  }
  frameUrl(assetId: string, ms: number) { return `${BASE}/assets/${assetId}/frame?t=${Math.round(ms / 100) * 100}`; }
  audioUrl(assetId: string) { return `${BASE}/assets/${assetId}/proxy`; }

  // Timeline
  createTimeline(projectId: string, body: { scriptVersionId: string; format: string; narration: Record<string, string>; crops: Record<string, Crop> }) {
    return this.req<{ timeline: Timeline; invalidated: string[] }>('POST', `/projects/${projectId}/timelines`, body);
  }
  reviseTimeline(id: string, body: { crops?: Record<string, Crop>; captions?: Caption[]; mix?: Timeline['mix'] }) {
    return this.req<{ timeline: Timeline; invalidated: string[] }>('POST', `/timelines/${id}/revisions`, body);
  }
  captionsVttUrl(timelineId: string) { return `${BASE}/timelines/${timelineId}/captions.vtt`; }

  // Render
  render(timelineId: string, profile: 'preview' | 'final') { return this.req<{ render: Render; reused: boolean }>('POST', `/timelines/${timelineId}/renders`, { profile }, { 'Idempotency-Key': key() }); }
  renderFileUrl(r: Render, download = false) { return `${BASE}/renders/${r.id}/file${download ? '?download=1' : ''}`; }

  // Aprovação e exportação
  approve(projectId: string, body: { renderId: string; metadata: { title: string; description: string; tags: string[]; channel: string | null }; thumbnailAssetId: string | null; checklistConfirmed: true }) {
    return this.req<Approval>('POST', `/projects/${projectId}/approvals`, body);
  }
  exportPackage(projectId: string, approvalId: string) { return this.req<{ job: Job }>('POST', `/projects/${projectId}/exports`, { approvalId }, { 'Idempotency-Key': `export-${approvalId}` }); }
  exportFileUrl(e: ExportRecord, name: string) { return `${BASE}/exports/${e.id}/files/${name}`; }

  // Jobs
  cancelJob(id: string) { return this.req<Job>('POST', `/jobs/${id}/cancel`); }
  retryJob(id: string) { return this.req<Job>('POST', `/jobs/${id}/retry`); }
}
