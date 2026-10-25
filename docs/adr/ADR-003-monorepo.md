# ADR-003 — Monorepo npm workspaces executado com tsx

- Status: aceito (2026-10-25)

## Decisão
npm workspaces (`apps/*`, `packages/*`). Os pacotes TypeScript do backend são executados direto do código-fonte com `tsx` (sem etapa de build), e cada pacote exporta `./src/index.ts`. O Angular tem seu próprio build (`@angular/build`) e TypeScript 6; o backend usa TypeScript 5.9 só para checagem de tipos (`npm run typecheck`).

## Por quê
Menos passos para o usuário: `npm run dev` liga tudo, `npm test` testa tudo. O Angular não importa os pacotes do backend (os tipos da UI ficam em `apps/web/src/app/models.ts`), o que mantém o bundle pequeno e evita conflito entre versões de TypeScript.

## Consequência
Se um contrato mudar em `packages/contracts`, atualize também `apps/web/src/app/models.ts`.
