# Racing Studio AI

Estúdio **local** para produzir vídeos de gameplay de corrida com narração em pt-BR: você importa suas gravações, marca as cenas, escreve o roteiro, importa a narração, e o estúdio monta, renderiza (FFmpeg), valida e exporta o pacote pronto para publicar.

Estado atual: **marcos M0 + M1** da [especificação](RACING_STUDIO_AI.spec) — fluxo manual completo funcionando. Assistência por IA entra no M2.

## Começo rápido

Pré-requisitos: **Node 22.12+** e **FFmpeg**.

```bash
nvm install 22 && nvm use 22   # uma vez
brew install ffmpeg            # uma vez (macOS)
npm run setup                  # uma vez: cria .env, instala dependências, diagnostica
npm run dev                    # todo dia: liga tudo
```

Abra **http://127.0.0.1:4200**.

👉 **Leia o [Guia passo a passo](docs/GUIA_PASSO_A_PASSO.md)** — explica cada tela, do primeiro projeto ao vídeo exportado.

## Documentação

| Documento | Conteúdo |
|---|---|
| [docs/GUIA_PASSO_A_PASSO.md](docs/GUIA_PASSO_A_PASSO.md) | Instalação, uso de cada etapa, problemas comuns |
| [docs/ARQUITETURA.md](docs/ARQUITETURA.md) | Como o sistema é organizado, estados, segurança |
| [docs/RELATORIO_ENTREGA.md](docs/RELATORIO_ENTREGA.md) | O que foi entregue, testes, requisitos (RF/AC) e limitações |
| [docs/adr/](docs/adr/) | Decisões técnicas registradas |
| [agents/](agents/) | Contratos dos papéis de IA |

## Comandos

`npm run setup` · `npm run dev` · `npm run doctor` · `npm run demo:video` · `npm test` · `npm run typecheck` · `npm run build:web`
