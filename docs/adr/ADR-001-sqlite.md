# ADR-001 — SQLite no lugar de PostgreSQL no MVP

- Status: aceito (2026-10-25, aprovado pelo usuário)
- Spec: §7 propõe PostgreSQL (PROPOSTO, reversível).

## Contexto
A máquina não tinha PostgreSQL nem Docker. O objetivo do usuário é usar o estúdio "da maneira mais simples". O MVP é de um usuário, local.

## Decisão
Usar o SQLite embutido no Node 22 (`node:sqlite`), em um arquivo (`data/studio.db`), com modo WAL e `BEGIN IMMEDIATE` nas transações. A fila de jobs fica no mesmo banco (spec: "evitar Redis no MVP").

## Consequências
- Zero instalação e zero serviço extra.
- `node:sqlite` ainda é marcado como experimental no Node 22 (aparece um aviso; o `npm run dev` o oculta).
- Acesso ao banco está concentrado em `packages/db` (`Db`, `JobQueue`). Migrar para PostgreSQL significa reimplementar essas duas classes; casos de uso e domínio não mudam.
- Não serve para vários usuários simultâneos em rede — isso é P2.
