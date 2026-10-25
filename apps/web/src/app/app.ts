import { Component, inject, OnDestroy, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Notifier } from './api.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <a class="skip-link" href="#conteudo">Pular para o conteúdo</a>
    <header class="topbar">
      <a routerLink="/" class="brand" aria-label="Racing Studio AI — Painel">🏁 Racing Studio AI</a>
      <nav aria-label="Principal">
        <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }" ariaCurrentWhenActive="page">Painel</a>
        <a routerLink="/configuracoes" routerLinkActive="active" ariaCurrentWhenActive="page">Configurações</a>
      </nav>
    </header>
    <!-- Região anunciada por leitores de tela: status não depende só de cor -->
    <div class="toast-region" role="status" aria-live="polite" aria-atomic="true">
      @if (notifier.message(); as m) {
        <div class="toast" [class]="'toast ' + m.kind">
          <strong>{{ m.kind === 'error' ? 'Erro: ' : m.kind === 'success' ? 'Pronto: ' : 'Aviso: ' }}</strong>{{ m.text }}
          <button type="button" class="link" (click)="notifier.message.set(null)" aria-label="Fechar aviso">✕</button>
        </div>
      }
    </div>
    @if (offline()) {
      <div class="offline-banner" role="alert">
        <strong>O estúdio está desligado</strong> — os botões não funcionam enquanto a API estiver fora do ar.
        Abra um terminal na pasta do projeto e rode <code>npm run dev</code>. Esta faixa some sozinha quando voltar.
      </div>
    }
    <main id="conteudo" tabindex="-1">
      <router-outlet />
    </main>
  `,
})
export class App implements OnDestroy {
  protected readonly notifier = inject(Notifier);
  /** Verifica a API a cada 5 s para avisar quando o `npm run dev` foi encerrado. */
  protected readonly offline = signal(false);
  private readonly timer = setInterval(() => this.check(), 5000);

  constructor() { this.check(); }

  ngOnDestroy() { clearInterval(this.timer); }

  private async check() {
    try {
      const r = await fetch('/api/v1/health', { cache: 'no-store' });
      this.offline.set(!r.ok);
    } catch {
      this.offline.set(true);
    }
  }
}
