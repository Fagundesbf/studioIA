# Guia passo a passo — Racing Studio AI

Este guia leva você do zero até o primeiro vídeo exportado. Cada passo diz **o que fazer**, **o que você deve ver** e **o que fazer se der errado**.

> Resumo em 3 comandos (depois da instalação):
> ```bash
> nvm use 22
> npm run dev
> # abra http://127.0.0.1:4200
> ```

---

## Parte A — Instalação (só na primeira vez)

### A1. Instale o Node.js 22

O projeto precisa do **Node 22.12 ou maior** (o Angular atual e o banco SQLite embutido exigem isso).

**macOS (você já tem o nvm):**
```bash
nvm install 22
nvm use 22
node --version      # deve mostrar v22.x
```
Para não precisar digitar `nvm use 22` toda vez (opcional):
```bash
nvm alias default 22
```
A pasta do projeto tem um arquivo `.nvmrc`, então dentro dela basta digitar `nvm use`.

**Windows:** instale o [nvm-windows](https://github.com/coreybutler/nvm-windows) e rode `nvm install 22` e `nvm use 22`. *(Os passos para Windows foram escritos, mas ainda não foram testados numa máquina Windows.)*

### A2. Instale o FFmpeg

O FFmpeg é o programa que lê, corta e renderiza os vídeos.

- **macOS:** `brew install ffmpeg`
- **Windows:** `winget install Gyan.FFmpeg` (depois feche e abra o terminal)

Teste: `ffmpeg -version` deve mostrar a versão.

> Opcional: para **gravar a legenda dentro da imagem** (em vez de só no arquivo SRT e na faixa de legenda do MP4) é preciso um FFmpeg com `libass`. No macOS: `brew install ffmpeg-full`. A tela **Configurações** mostra se está disponível. O estúdio funciona normalmente sem isso.

### A3. Prepare o projeto

Na pasta do projeto (`StudioIA`):
```bash
npm run setup
```
O que ele faz:
1. Cria o arquivo `.env` com um **token local aleatório** (a senha que protege a API).
2. Instala as dependências (`npm install`) se ainda não estiverem instaladas.
3. Roda um diagnóstico.

**Você deve ver:** uma lista com ✔ e no final `Tudo pronto! Rode agora: npm run dev`.

**Se aparecer ✘:** a própria linha diz o que instalar. Corrija e rode `npm run setup` de novo (pode repetir à vontade, ele não apaga nada).

A qualquer momento, `npm run doctor` repete o diagnóstico.

---

## Parte B — Ligar o estúdio (todo dia)

```bash
nvm use 22        # se não definiu o 22 como padrão
npm run dev
```
Isso liga 3 programas ao mesmo tempo, cada um com uma cor no terminal:

| Prefixo | O que é | Endereço |
|---|---|---|
| `[api]` | Servidor que guarda os dados e recebe os comandos | http://127.0.0.1:4310/api/v1/health |
| `[worker]` | Executa as tarefas pesadas (proxy, render, exportação) | — |
| `[web]` | A interface que você usa no navegador | **http://127.0.0.1:4200** |

Abra **http://127.0.0.1:4200** no navegador.

Para desligar tudo: **Ctrl + C** no terminal.

> Tudo roda só no seu computador (endereço 127.0.0.1). Nada é enviado para a internet.

---

## Parte C — Seu primeiro vídeo

Quer treinar antes de usar uma gravação real? Rode `npm run demo:video`. Ele cria em `data/demo/` um vídeo de teste (barras coloridas, **não é gameplay**), dois áudios de narração e uma thumbnail.

### C1. Criar o projeto
Tela **Painel** → **Novo projeto**:
- **Título**, **Jogo** (ex.: Forza Horizon 5) e **Formato**: *Gameplay narrado* (horizontal) ou *Short* (vertical).
- Clique **Criar projeto**. Você vai para a tela do projeto, que tem 5 etapas em abas (use o mouse ou as setas ← → do teclado).

### C2. Etapa 1 — Mídia
1. **Primeiro** preencha **Dono/autor do material** (obrigatório — ex.: "Fabio, gravação própria") e o **Direito de uso**. O estúdio lembra esse valor para os próximos envios.
2. Opcional: carro e tags.
3. Em **Escolha o arquivo**, selecione a gravação (MP4, MOV ou MKV). **O envio começa sozinho** e aparece a barra "Enviando… %".
   - Se você escolheu o arquivo antes de preencher o dono, aparece *"Arquivo selecionado… Preencha o dono/autor"*: preencha e clique **Importar**.
4. Depois do envio, o vídeo aparece na **Biblioteca** com a etiqueta *"Processando (proxy e miniatura)…"* e o topo mostra **Em andamento → Processar mídia**.
5. Quando a etiqueta mudar para **Pronto** (alguns segundos, ou alguns minutos para gravações longas), aparece o botão **Próximo: marcar cenas →** no fim da página.

**Importe também os áudios da narração** (WAV, MP3 ou M4A) — um arquivo por trecho do roteiro. Você pode fazer isso agora ou depois de escrever o roteiro (é o mais comum).

> Como gravar a narração no M1: grave cada trecho do roteiro separadamente (celular, microfone, ou uma ferramenta de voz que você tenha direito de usar) e importe aqui. A geração de voz dentro do estúdio entra no marco M2.

**Se der erro:** a mensagem explica (ex.: "arquivo corrompido", "extensão não suportada"). Arquivo idêntico a outro já importado gera um aviso de **duplicata**.

### C3. Etapa 2 — Cenas
Aqui você marca os momentos que vão aparecer no vídeo.
1. Dê play no vídeo. Clique no player e use os atalhos: **I** marca o início, **O** marca o fim (ou use os botões "Usar posição atual").
2. Escolha **O que acontece** (ultrapassagem, largada, chegada…) e descreva o que você **viu** (ex.: "passa o carro azul por dentro na curva 4").
3. **Salvar cena**. Cenas marcadas por você já entram como **Confirmadas**.

Botão **Sugerir candidatos**: detecta mudanças bruscas de imagem automaticamente. Esses candidatos entram como **Pendentes** — confirme, edite ou rejeite. Atenção: mudança de imagem **não prova** ultrapassagem, colisão ou vitória; é só uma sugestão de onde olhar.

### C4. Etapa 3 — Roteiro
Cada **trecho** = um pedaço de narração + a cena que aparece enquanto ela toca.
1. Para cada trecho escolha a **Função** (gancho, contexto, desenvolvimento, fechamento), a **Cena mostrada** e escreva o **Texto da narração**.
2. Abaixo do texto aparece a estimativa: *"Fala estimada ~X s · cena Y s"*. Se a fala for maior que a cena, encurte o texto ou aumente o trecho.
3. Se o trecho **afirma um fato** da corrida ("ultrapassou o líder"), marque *"Este trecho afirma um fato"*, escreva a afirmação e marque *"Conferi no vídeo"*. O fato precisa estar ligado a uma cena **confirmada**.
4. **Salvar rascunho** (pode ter pendências) ou **Salvar como revisado** (só funciona sem pendências).

Cada salvamento cria uma **nova versão**; as anteriores ficam no histórico. Mudar o roteiro depois de montar/aprovar **invalida** a montagem e a aprovação antigas — isso é proposital, para nunca publicar uma versão diferente da aprovada.

### C5. Etapa 4 — Voz e montagem
1. Escolha o **Formato de saída** (horizontal 1920x1080 ou vertical 1080x1920).
2. **Narração** — duas opções:
   - **Gerar automaticamente (recomendado para começar):** em *"Gerar narração automaticamente"* escolha a **Voz** (ex.: Luciana) e a **Velocidade**, e clique **Gerar narração de todos os trechos**. Usa a voz sintética do macOS: local, offline e gratuita. Em poucos segundos cada trecho recebe seu áudio, com um player para **ouvir**.
     - Vozes de melhor qualidade: *Ajustes do Sistema → Acessibilidade → Conteúdo Falado → Voz do Sistema → Gerenciar Vozes*, baixe uma versão "Melhorada"/"Premium" em Português (Brasil) e reinicie o `npm run dev`.
     - Se mudar o texto de um trecho no roteiro, gere a voz de novo (a antiga deixa de valer para aquele texto).
   - **Sua própria voz:** grave cada trecho, importe na etapa 1 e escolha o arquivo em **Áudio da narração**.
   - Se a fala ficar **maior que a cena**, aparece um aviso vermelho com o botão **Estender cenas para caber a narração**. Ele cria uma nova versão do roteiro com as cenas mais longas (o vídeo continua mostrando a gameplay logo depois do trecho marcado). Nenhuma fala é cortada. Se preferir, encurte o texto no roteiro.
   - Dica: cenas automáticas (candidatos da heurística) têm só 3 s. Uma frase narrada costuma precisar de 5 a 10 s.
3. No formato vertical, ajuste o **enquadramento** de cada trecho: a imagem mostra o quadro do **meio da cena** e o retângulo vermelho é o que vai aparecer no Short. Use o controle deslizante ou os botões **← Esquerda / Centro / Direita →**. Deixe o carro e o HUD visíveis quando forem importantes.
   - Trecho alterado mostra **"Enquadramento alterado — não salvo"**. Clique **Salvar enquadramento** (ou, se ainda não houver timeline nesse formato, **Montar timeline**, que salva narração e enquadramento juntos).
   - Depois de salvo aparece **"Enquadramento salvo"**, e a posição continua lá quando você volta à página.
4. Clique **Montar timeline**.
   - Se a narração for maior que a cena, aparece o aviso com quantos segundos faltam. **Nada é cortado**: encurte a fala ou aumente a cena no roteiro.
5. Revise as **legendas** (são estimadas pelo texto e pela duração do áudio — corrija os tempos e o texto) e a **mixagem** (quanto o som do jogo abaixa durante a narração).
6. **Salvar ajustes** cria nova versão. Depois clique **Renderizar preview**: um vídeo em meia resolução para conferir.

### C6. Etapa 5 — Entrega
1. **Renderizar versão final** (resolução cheia). A tabela mostra a validação técnica: duração, codecs, loudness (~-14 LUFS) e hash.
2. Preencha **Título**, **Descrição**, **Tags** e (opcional) a **Thumbnail** (uma imagem importada na etapa 1).
3. Marque os 4 itens do **checklist** e clique **Aprovar versão**.
4. Na lista de aprovações, clique **Exportar pacote**.
5. Baixe os arquivos pelos links, ou pegue-os direto na pasta `data/storage/exports/<id>/`:

| Arquivo | Para que serve |
|---|---|
| `video.mp4` | O vídeo final (H.264 + AAC, com faixa de legenda embutida) |
| `legendas.srt` | Legendas para enviar ao YouTube |
| `metadados.json` | Título, descrição e tags aprovados |
| `roteiro.json` | O roteiro da versão aprovada |
| `thumbnail.*` | A thumbnail, se escolheu uma |
| `manifesto.json` | Versões, hashes, fontes de cada cena e declaração de direitos |

6. Publique **manualmente** no YouTube Studio (envie o MP4, cole título/descrição, envie o SRT em "Legendas"). A publicação automática é uma etapa futura (P1).

---

## Parte D — Problemas comuns

| Sintoma | Causa provável | Solução |
|---|---|---|
| `npm run dev` diz que o Node é antigo | Terminal está com Node 18 | `nvm use 22` |
| Aviso "API indisponível" na interface | A API não está rodando | Veja se `npm run dev` está aberto; olhe as linhas `[api]` |
| "Token ausente ou inválido" | `.env` mudou e o servidor não foi reiniciado | Ctrl+C e `npm run dev` de novo |
| "FFmpeg não encontrado" | FFmpeg não instalado ou fora do PATH | `brew install ffmpeg` ou defina `FFMPEG_PATH` no `.env` |
| Tarefa com **Falhou** | Veja a mensagem vermelha no topo do projeto | Corrija a causa e clique **Tentar de novo** |
| "Espaço livre insuficiente" | Disco cheio | Libere espaço; o mínimo é `MIN_FREE_DISK_MB` no `.env` |
| Quero recomeçar do zero | — | Desligue o estúdio e apague a pasta `data/` (isso apaga **todos** os projetos e cópias dos vídeos; suas gravações originais fora do estúdio não são afetadas) |

## Parte E — Comandos úteis

| Comando | O que faz |
|---|---|
| `npm run setup` | Prepara tudo (primeira vez ou depois de atualizar) |
| `npm run dev` | Liga API + worker + interface |
| `npm run doctor` | Diagnóstico do ambiente |
| `npm run demo:video` | Cria arquivos de teste em `data/demo/` |
| `npm test` | Roda os testes automáticos (unitários + fluxo completo com FFmpeg real) |
| `npm run typecheck` | Verifica os tipos do backend |
| `npm run build:web` | Gera a versão de produção da interface |

## Onde ficam as coisas

- `data/studio.db` — banco de dados (SQLite, um arquivo só).
- `data/storage/originals/` — cópias **somente leitura** das suas gravações (nome = hash SHA-256).
- `data/storage/proxies/`, `thumbs/` — versões leves para o player.
- `data/storage/renders/` — previews e finais.
- `data/storage/exports/` — pacotes exportados.
- `.env` — configuração local (limites, token). **Não compartilhe** este arquivo.

Para entender como o sistema funciona por dentro, veja [ARQUITETURA.md](ARQUITETURA.md).
