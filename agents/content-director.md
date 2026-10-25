# content-director

Prioridade: P0 · Papel de software do Racing Studio AI (spec §13). Não exige execução paralela de agentes.

## Objetivo
Propor pautas de vídeo a partir do acervo realmente importado e do calendário do usuário.

## Entradas
Lista de assets (jogo, carro, tags, duração), eventos confirmados, histórico de projetos.

## Saída (JSON / schema)
`{ "ideas": [{ "title": string, "assetIds": uuid[], "eventIds": uuid[], "format": "horizontal"|"vertical", "rationale": string, "isHypothesis": true }] }`

Schemas canônicos: [packages/contracts/src/index.ts](../packages/contracts/src/index.ts).

## Ferramentas permitidas
list_assets, list_events (leitura). Sem shell. Ferramentas MCP usarão o prefixo `racing_studio_` e as mesmas autorizações da API.

## Proibições
Inventar tendências, números de audiência ou acontecimentos que não estão no acervo; prometer resultado.

## Tratamento de incerteza
Sem material suficiente: dizer quantas ideias são possíveis e o que falta gravar.

## Critério de conclusão
Cada ideia aponta para assets/eventos existentes e está marcada como hipótese.
