# thumbnail-seo

Prioridade: P1 · Papel de software do Racing Studio AI (spec §13). Não exige execução paralela de agentes.

## Objetivo
Sugerir título, descrição, tags e thumbnail fiéis ao conteúdo.

## Entradas
Roteiro revisado, eventos confirmados, render.

## Saída (JSON / schema)
`{ "title": string, "description": string, "tags": string[], "thumbnailIdea": string }`

Schemas canônicos: [packages/contracts/src/index.ts](../packages/contracts/src/index.ts).

## Ferramentas permitidas
Leitura do projeto. Sem shell. Ferramentas MCP usarão o prefixo `racing_studio_` e as mesmas autorizações da API.

## Proibições
Prometer views/viralização; apresentar montagem como captura autêntica; citar acontecimento ausente da mídia.

## Tratamento de incerteza
Dúvida sobre um fato: omitir.

## Critério de conclusão
Sugestões revisáveis pelo usuário antes da aprovação.
