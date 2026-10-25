import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, Notifier } from '../api.service';
import { JOB_LABEL, JOB_STATUS_LABEL, type Job, type Project, STATUS_LABEL } from '../models';

@Component({
  selector: 'app-dashboard',
  imports: [FormsModule, RouterLink, DatePipe],
  template: `
    <h1>Painel</h1>

    <section class="card" aria-labelledby="novo-titulo">
      <h2 id="novo-titulo">Novo projeto</h2>
      <p class="muted">Um projeto = um vídeo (gameplay narrado ou Short). Você vai importar a gravação no próximo passo.</p>
      <form class="row" (ngSubmit)="create()">
        <div class="field"><label for="np-title">Título do vídeo</label><input id="np-title" name="title" [(ngModel)]="form.title" required placeholder="Ex.: Corrida de Porsche em Guanajuato" /></div>
        <div class="field">
          <label for="np-game">Jogo</label>
          <input id="np-game" name="game" [(ngModel)]="form.gameLabel" list="jogos" required />
          <datalist id="jogos">@for (g of games; track g) { <option [value]="g"></option> }</datalist>
        </div>
        <div class="field">
          <label for="np-template">Formato</label>
          <select id="np-template" name="template" [(ngModel)]="form.template">
            <option value="gameplay_narrado">Gameplay narrado (6–12 min, horizontal)</option>
            <option value="short">Short (20–60 s, vertical)</option>
          </select>
        </div>
        <div class="field" style="flex-basis:100%"><label for="np-obj">Objetivo (opcional)</label><input id="np-obj" name="objective" [(ngModel)]="form.objective" placeholder="Ex.: mostrar a melhor ultrapassagem da corrida" /></div>
        <button class="primary" type="submit" [disabled]="busy()">Criar projeto</button>
      </form>
    </section>

    <section aria-labelledby="proj-titulo">
      <h2 id="proj-titulo">Projetos</h2>
      @if (!loaded()) { <p class="muted">Carregando…</p> }
      @else if (projects().length === 0) { <p class="muted">Nenhum projeto ainda. Crie o primeiro acima.</p> }
      <div class="grid">
        @for (p of projects(); track p.id) {
          <article class="card">
            <h3><a [routerLink]="['/projetos', p.id]">{{ p.title }}</a></h3>
            <p class="muted">{{ p.gameLabel }} · {{ p.template === 'short' ? 'Short' : 'Gameplay narrado' }}</p>
            <span class="badge">Etapa: {{ statusLabel[p.status] }}</span>
            <p class="muted">Criado em {{ p.createdAt | date: 'dd/MM/yyyy HH:mm' }}</p>
          </article>
        }
      </div>
    </section>

    <section class="card" aria-labelledby="jobs-titulo">
      <h2 id="jobs-titulo">Tarefas recentes</h2>
      @if (blocked().length) {
        <div class="notice err" role="alert">{{ blocked().length }} tarefa(s) com falha precisam da sua atenção (veja abaixo).</div>
      }
      @if (jobs().length === 0) { <p class="muted">Nenhuma tarefa executada ainda.</p> }
      @else {
        <table>
          <caption class="sr-only">Tarefas recentes</caption>
          <thead><tr><th scope="col">Tarefa</th><th scope="col">Situação</th><th scope="col">Detalhe</th><th scope="col">Atualizado</th></tr></thead>
          <tbody>
            @for (j of jobs(); track j.id) {
              <tr>
                <td><a [routerLink]="['/projetos', j.projectId]">{{ jobLabel[j.type] }}</a></td>
                <td><span class="badge" [class.ok]="j.status === 'succeeded'" [class.err]="j.status === 'failed'">{{ jobStatus[j.status] }}</span></td>
                <td class="muted">{{ j.errorMessage ?? j.stage ?? '' }}</td>
                <td class="muted">{{ j.updatedAt | date: 'dd/MM HH:mm:ss' }}</td>
              </tr>
            }
          </tbody>
        </table>
      }
      <p class="muted">Custos conhecidos: {{ costs() }}</p>
    </section>
  `,
})
export class DashboardPage implements OnInit, OnDestroy {
  private api = inject(Api);
  private notifier = inject(Notifier);
  private router = inject(Router);
  protected readonly statusLabel = STATUS_LABEL;
  protected readonly jobLabel = JOB_LABEL;
  protected readonly jobStatus = JOB_STATUS_LABEL;
  protected readonly games = ['Forza Horizon 5', 'Forza Motorsport', 'Assetto Corsa', 'F1 25', 'F1 26', 'Need for Speed'];
  protected form = { title: '', gameLabel: 'Forza Horizon 5', template: 'gameplay_narrado', objective: '' };
  protected projects = signal<Project[]>([]);
  protected jobs = signal<Job[]>([]);
  protected blocked = signal<any[]>([]);
  protected costs = signal('—');
  protected loaded = signal(false);
  protected busy = signal(false);
  private timer?: ReturnType<typeof setInterval>;

  ngOnInit() { this.load(); this.timer = setInterval(() => this.load(), 5000); }
  ngOnDestroy() { clearInterval(this.timer); }

  async load() {
    try {
      const d = await this.api.dashboard();
      this.projects.set(d.projects);
      this.jobs.set(d.recentJobs);
      this.blocked.set(d.blocked);
      this.costs.set(`${d.costs.knownTotal.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })} — ${d.costs.note}`);
    } catch (e) {
      clearInterval(this.timer);
      this.notifier.error(e);
    } finally {
      this.loaded.set(true);
    }
  }

  async create() {
    if (!this.form.title.trim() || !this.form.gameLabel.trim()) { this.notifier.error(new Error('Preencha título e jogo.')); return; }
    this.busy.set(true);
    try {
      const p = await this.api.createProject(this.form);
      this.notifier.success(`Projeto "${p.title}" criado.`);
      await this.router.navigate(['/projetos', p.id]);
    } catch (e) { this.notifier.error(e); } finally { this.busy.set(false); }
  }
}
