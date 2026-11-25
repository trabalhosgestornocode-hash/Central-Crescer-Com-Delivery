# MOVA CORE — Relatório da F0 (24/11/2026)

Nada foi mesclado na main, publicado, migrado em produção nem enviado a ninguém. As consultas em produção foram **somente leitura**.

## 1. PR #203: citação exata (corrigido, não mesclado)

**Antes:** a 1ª versão do PR estendia a memória curta a qualquer mensagem citada. Com isso, um "sim" citando **qualquer** mensagem confirmava a pendência mais recente, por aproximação.

**Agora** (commit `c918200` no ramo do PR):
- **Citação do documento:** continua igual (chave = id da mensagem original).
- **Citação de uma resposta do MOVA:**
  - Busca em `mova.resposta` pelo `provider_message_id` confirmado pelo Gateway/relé, na mesma conversa.
  - Retoma a pendência **do evento que gerou aquela resposta**.
  - Funciona no privado, onde `resposta_a` é nulo.
- **Citação que não resolve:** nunca usa a memória curta. A memória curta (10 min) vale só **sem** citação.
- **Pendência citada com mais de 72 h:** não executa, pede o reenvio, e a pendência fica aberta (`PENDENCIA_EXPIRADA`).
- **Worker:** confirmação do relé sem id grava nulo. Antes gravava `"SEM_ID"`, e a coluna é UNIQUE: o 2º "SEM_ID" falharia.

**Conferência do relé em produção (leitura):** 69/69 respostas ENVIADAS têm `provider_message_id`; 0 com "SEM_ID"; 38 sem `resposta_a` (privado). A pendência real dos brownies (23/11 23:38) tem a pergunta na mesma conversa e 1 mensagem citando-a. A correção a resolveria.

**Regressões novas:**

| Caso | O que prova |
|---|---|
| AUT-C3 | caso real de produção ("Outra compra" citando a pergunta) |
| AUT-C4 | texto livre citando outra mensagem não retoma nada |
| AUT-C5 | citar mensagem humana não confirma por aproximação, e a citação certa depois funciona |
| AUT-C6 | "sim" citando uma resposta do MOVA sem pendência não vira juros de outra pergunta |
| AUT-C7 | duas pendências: a citação escolhe a certa (a mais antiga) e a outra continua aberta |
| AUT-C8 | atrasada 30 min com citação retoma; sem citação, não |
| AUT-C9 | 73 h: não executa |
| AUT-C10 | a mesma citação chegando duas vezes ao mesmo tempo gera uma única operação |

**Suíte MOVA no ramo:** 505/505.

## 2. Incidente em produção: MOVA parado desde 24/11 03:04Z

- **O que aconteceu:** no deploy do #202, a montagem falhou com **53300** (excesso de conexões durante a troca de instância). O banco tem `max_connections` = 60; 27 estavam em uso na leitura.
- **Por que não voltou:** `iniciarMovaEmbutido` só roda no boot e não tenta de novo, então worker e consumidor do relé não subiram.
- **Estado no banco:** `mova.controle` está todo ligado e `orcamento_ia` tem 500 chamadas e US$ 10. O consumo total é de 7 chamadas e US$ 0,0043.
- **Correção de código:** **PR #205** (não mesclado). Falha transitória agenda nova tentativa (15 s → 5 min, sem limite); falha de configuração ou segurança continua parando. Testes MR-01..05; suíte 502/502.
- **Ação que depende de você:** reiniciar o serviço `crescercomdelivery` no Render religa o MOVA agora. Não fiz isso.

## 3. Estado real das chaves em produção (leitura)

- **Texto para a IA:** está **ligado na prática**. Depois do redeploy de 23/11 23:20Z, mensagens só de texto foram lidas pela IA (`CONTAS_VENCENDO`, `CONVERSA_SEM_PEDIDO_FINANCEIRO`). Isso é coerente com `MOVA_IA_SOMENTE_DOCUMENTOS=0`. A variável em si não é legível pela API; o padrão do código, se ausente, é **1** (só documentos).
- **Controle:** suspenso=false; recebimento, processamento, IA e envio ligados.
- **Orçamento de produção (não alterado):** acumulado, 500 chamadas e US$ 10, reserva de US$ 0,02.
- **Pendências abertas:** 2. Uma de 21:15Z sem resposta citando; a dos brownies, de 23:38Z, foi citada, mas o evento já foi processado com a regra antiga e precisa de reenvio ou revisão.

## 4. Linha de base da inteligência atual

**Produção, todas as decisões registradas, 22–23/11 (33 decisões):**
- 12 falhas de leitura de IA por configuração:
  - IA desligada: 8
  - 401 de autorização: 2
  - requisição inválida: 1
  - contagem indisponível: 1
- 9 `FALHOU/ERRO_PERMANENTE` em 23/11 (causa a investigar na F1).
- 4 consultas.
- 3 perguntas de juros (`VALOR_MAIOR_QUE_SALDO`).
- 1 conversa sem pedido; 1 bloqueio de unidade fora do grupo; 1 participante não autorizado; 1 documento aguardando conferência.
- **Conclusão:** a amostra real é pequena e dominada por falhas de configuração, não de compreensão. Ainda não serve como medida de acerto.

**Avaliação existente (simulada, leitura ideal):**
- 23 casos e 27 temas; 17 marcados para rodada paga.
- 100% aprovados junto com `conversa-inteligente` e `conversa-ferramentas` (29/29).
- Ela mede o **motor determinístico**, não a escolha de ferramenta nem texto livre, e **não existe ainda o conjunto de 150 conversas** nem a suíte independente. Os dois são entregas da F1.

**Custo real medido:** 7 chamadas, US$ 0,00429, média de US$ 0,00061 por chamada (Haiku, sem cache).

## 5. Orçamento renovável da homologação (implementado, desligado)

Commit `ddc7e97` no ramo `feat/mova-core-f0`.

**Migração 0018** (aditiva, política `ativo=false`) + reversão oficial `reverter-0018.sql` (recusa com a política ativa).

**Limites:**

| Limite | Padrão |
|---|---|
| Mensal | US$ 10 |
| Diário | US$ 1 |
| Por requisição | US$ 0,10 |
| Etapas por mensagem | 6 |

- Os limites são tetos **no código**: o banco só reduz (OR-07).
- **Reserva atômica** antes de cada chamada, com o mesmo bloqueio consultivo do acumulado. 30 reservas simultâneas nunca passam do limite (OR-08).
- **Renovação** mensal e diária no fuso America/Fortaleza, **sem apagar histórico** (OR-04/05).
- **Alertas** em 50/80/100%, uma vez por período, com evento `MOVA_ORCAMENTO_ALERTA` (OR-09).
- **Controle** por organização, unidade, modelo e requisição, mais tokens de leitura e escrita de cache em cada linha (OR-10/11).
- **Painel:** `resumo()` com mês, dia, por modelo, por unidade e alertas, já servido em `/mova/estado` e `/mova/visao-geral`. A tela visual fica para a F1.
- **Fail-closed:** o renovável vale **só** com `MOVA_ORCAMENTO_RENOVAVEL=1` **e** modo HOMOLOGACAO. Produção (OPERACAO/PILOTO) segue no acumulado, idêntica (OR-02/OR-12).
- **Testes:** OR-01..13, incluindo o rollback (OR-13). Suíte MOVA **518/518**.
- O pacote de produção foi regenerado e contém a 0018 inerte. **Aplicar em produção exige sua autorização.**

## 6. Estimativas de custo recalculadas

Preços oficiais por milhão de tokens:
- **Haiku 5.5:** US$ 0,10 entrada e US$ 0,50 saída.
- **Sonnet 5.5:** US$ 2 entrada e US$ 10 saída.
- **Cache:** leitura a 0,1× e escrita a 1,25× do preço de entrada; prefixo mínimo de 512 tokens.

| Cenário | Sem cache | Com cache do prefixo |
|---|---|---|
| Haiku, 1 chamada de texto (~3,2K entrada, 300 saída) | ~US$ 0,0005 | ~US$ 0,0002 |
| Haiku, comprovante PDF de 1 página (+~2,5K) | ~US$ 0,0008 | ~US$ 0,0005 |
| Haiku, laço de ferramentas com 3 etapas (~6K por etapa, 900 de saída) | ~US$ 0,0023 | ~US$ 0,0008 |
| Sonnet, análise complexa com 3 etapas (~10K por etapa, 2K de saída) | ~US$ 0,08 | ~US$ 0,03 |

- **Capacidade dos US$ 10/mês:** entre ~4.000 e 12.000 requisições Haiku, ou ~120 a 300 análises Sonnet.
- **Limite diário de US$ 1:** ~400 a 1.200 requisições Haiku por dia.
- **Sonnet sem cache:** fica perto do limite de US$ 0,10 por requisição. O roteador deve usar Sonnet só com cache e no máximo 3 etapas.
- **Rodada paga da avaliação F1** (150 + 50 conversas): ~US$ 0,40 a 1,00 com Haiku.

## 7. Matriz de cobertura inicial

Gerada e verificável: `docs/mova-core/02-matriz-cobertura.md`, a partir de `backend/scripts/mova/matrizCobertura.mjs`.

| Situação | Quantidade |
|---|---|
| DISPONÍVEL (leitura ou escrita estreita hoje) | 24 |
| PARCIAL (só proposta, aplicação humana) | 4 |
| PLANEJADA (leituras na F1, administrativas na F3, financeiras na F4) | 118 |
| RESTRITA (CRÍTICA ou sem classificação) | 46 |
| **Total de operações do núcleo** | **192** (eram 182 no inventário anterior) |
| INEXISTENTE (pedido sem operação no sistema) | 4 |

Os 4 pedidos INEXISTENTES:
- Sangria com prestação de contas pendente.
- Vínculo da despesa em dinheiro com a saída da sessão.
- Vínculo participante ↔ usuário da plataforma.
- Base de conhecimento.

Além disso, **13 ferramentas de leitura do Agente Crescer** ficam PLANEJADAS para a F1: checklist, dashboards, CMV, insumos, parser, navegação e diagnóstico.

**Sangrias:** a tesouraria registra SANGRIA via `registrarOperacaoDeCaixa`, mas exige sessão aberta. Os casos 1 e 2 da sua decisão precisam de **operação nova no núcleo** (F4). Não vou simular essas operações no MOVA.

## 8. Plano detalhado da F1 (ambiente isolado, sem envio real)

**Objetivo:** o agente central com ferramentas **de leitura**, em **modo sombra** ao lado do motor atual.

1. **Catálogo de leitura:**
   - As 19 leituras da `portaFinanceira` e as 13 ferramentas do Agente Crescer, com JSON Schema estrito e descrição em PT-BR.
   - **Escopo de unidade injetado pelo servidor**, nunca pelo modelo.
   - Cada ferramenta com status da matriz; nada fora dela.
2. **Roteador N0–N2:**
   - N0, determinístico e sem IA: citações, pendências, comandos, saudações.
   - N1: o extrator Haiku atual.
   - N2: laço de ferramentas Haiku, no máximo 6 etapas, com orçamento por requisição.
   - Sonnet só em homologação e só por regra do servidor. Opus desligado.
3. **Cache de prompt:** `cache_control` no prefixo de sistema e ferramentas (≥512 tokens). O custo de cache já é contabilizado.
4. **Verificador de fidelidade:** cada afirmação da resposta (entidade, valor, período, unidade) é casada **em tupla** com o resultado da ferramenta. Qualquer divergência faz a resposta voltar ao modelo pronto (template).
5. **Modo sombra:** o laço roda sobre cópias dos eventos no banco isolado e grava a decisão para comparação, **sem enviar**.
6. **Avaliação:**
   - `avaliacao-core` com 150 conversas: 60 consultas, 30 operações, 20 de continuidade, 20 de segurança e isolamento, 20 conversacionais.
   - Mais 50 conversas independentes, nunca usadas para ajuste.
   - Rodada real com Haiku no ambiente isolado, sob o orçamento renovável.
7. **Critérios de aceite:**

| Métrica | Meta |
|---|---|
| Ferramenta correta | ≥95% |
| Decisão final | ≥98% |
| Valores | 100% |
| Violações de isolamento | 0 |
| Escritas não autorizadas | 0 |
| Brownies, sangrias e pagamentos | 100% |
| Regressão | 100% |
| Esclarecimentos desnecessários | ≤10% |

8. **Rollback:** chave `MOVA_CORE_FERRAMENTAS=0`, o padrão. O motor atual continua sendo o caminho de produção.

## 9. Riscos e bloqueadores

**Material para produção (não para a F1 isolada):**
- MOVA parado até alguém reiniciar o serviço.
- PRs #203 e #205 aguardam a sua revisão e merge.

**Para a rodada REAL da F1:**
- É preciso uma chave Anthropic de homologação e um banco isolado marcado como homologação, com a 0018 aplicada e a política ligada. A chave hoje só existe no serviço de produção, e não a uso sem autorização.
- Até a autorização, a F1 avança com o cliente simulado.

**Riscos técnicos:**
- **Orçamento de conexões:** pools do MOVA de 4+2+2 por instância, que dobram durante o deploy.
- **9 `ERRO_PERMANENTE` de 23/11** sem causa conhecida.
- **Restrições do 5.5:** Haiku aceita `thinking` desligado só com esforço alto ou menor; Sonnet/Opus recusam `tool_choice` forçado.
- **Confirmação por qualquer participante:** a confirmação por citação não exige ainda o mesmo participante autorizado (F2).
- **Validade fixa:** a validade de 72 h é constante (configurável na F2).
- **Pendência dos brownies:** continua aberta em produção.

## 10. Onde está cada coisa

| Item | Ramo / PR | Situação |
|---|---|---|
| Citação exata | `fix/mova-resposta-citando-pergunta` / #203 | atualizado, aguardando revisão |
| Nova tentativa de montagem | `fix/mova-montagem-retenta` / #205 | aberto, aguardando revisão |
| Orçamento renovável + matriz + relatório | `feat/mova-core-f0` (sobre o #203) | rascunho |
| Diagnóstico e plano original | `docs/mova-core/01-diagnostico-e-plano.md` (pasta principal) | não versionado |
