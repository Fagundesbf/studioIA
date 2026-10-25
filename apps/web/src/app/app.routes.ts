import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', title: 'Painel — Racing Studio AI', loadComponent: () => import('./pages/dashboard').then((m) => m.DashboardPage) },
  { path: 'projetos/:id', title: 'Projeto — Racing Studio AI', loadComponent: () => import('./pages/project').then((m) => m.ProjectPage) },
  { path: 'configuracoes', title: 'Configurações — Racing Studio AI', loadComponent: () => import('./pages/settings').then((m) => m.SettingsPage) },
  { path: '**', redirectTo: '' },
];
