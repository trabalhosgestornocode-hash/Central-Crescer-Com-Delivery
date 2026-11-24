# MOVA CORE — Diagnóstico e planejamento técnico (24/11/2026)

Base analisada: `origin/main` em `4017bf9` (inclui o PR #199 da conversa inteligente e o #202). PR #203 lido pelo diff.
Nada foi implementado, mergeado, publicado ou alterado em produção. Os preços dos modelos foram conferidos na referência oficial da API (cache de 03/11/2026).

---

## 1. Arquitetura atual do MOVA

```
WhatsApp ─ Gateway Baileys (gateway-whatsapp/: movaGrupo, movaPrivados, movaSaida, retryCache)
   │  HMAC + relé (supabase/functions/mova-rele)            ▲ saída: mova.resposta → relé → Gateway
   ▼                                                        │
backend/src/modules/mova-financeiro
   gateway/receptor → fila (Postgres, idempotente) → worker
        ▼
   aplicacao/motor.js  (826 linhas, pipeline DETERMINÍSTICO, fail-closed)
     1 grupo autorizado → 2 eco próprio → 3 evento repetido → participante (lista) → entregador (fluxo próprio, sem IA)
     5 resposta citada a pendência → 5b memória curta (10 min) → documento repetido
     7 guardas por regex ANTES da IA (dado restrito, pedido de execução, fora do escopo, saudação, aprovação)
     8 comando determinístico (comandos.js) | seguimento sem IA | IA (extrator)
     9 intenção proibida → 10 consulta (catálogo fechado) → 11 unidade (determinística) → duplicidade (sha256, E2E, chave)
     12 revisão | 13 transferência | 14 receita | pagamento (divergências) | conta → PROPOSTA → execução por política
        │                         │                                   │
        ▼                         ▼                                   ▼
   ia/provedorAnthropic      aplicacao/ferramentas(+Conversa)     aplicacao/execucao + portaOperacional
   (extrator: Haiku 5.5,     30 consultas só-leitura via          8 escritas estreitas, identidade
   JSON estrito, sem tools)  portaFinanceira (19 ops, só VER)     operacional própria, concessão por unidade
        │
   infra/operacao: controle (interruptores) + orçamento persistente (reserva antes de cada chamada)
```

**Papel da IA hoje:** um único `messages.create` (`claude-haiku-5-5`, sem raciocínio, `max_tokens` 600, saída por JSON Schema) que **classifica** a mensagem em `intencao` (11 valores) + `consulta` (30 valores) + campos do documento. A IA não chama ferramentas; o motor escolhe o caminho pelo enum. As respostas são modelos fixos (`respostas.js`); o redator natural (`redator.js`) existe, valida números, e está desligado.

**Ligado em produção (pela memória do projeto e pelos docs 18/19):** leitura de documentos por IA, envio no grupo financeiro, 0017 aplicada (24/11). `MOVA_IA_SOMENTE_DOCUMENTOS` tem padrão `true`, ou seja, texto livre não vai à IA. **Não conferi o Render** para saber se foi trocado.

## 2. Limitações encontradas

| # | Limitação | Onde | Efeito |
|---|---|---|---|
| L1 | A IA **classifica em enums fechados**; não usa ferramentas | `ia/contratos.js` (`CONSULTAS`, `INTENCAO`) | Cada pergunta nova exige enum novo + linha de prompt + função nova. A lista de palavras-chave só mudou de lugar. |
| L2 | Texto livre não chega à IA por padrão | `fv2-integracao/mova.js:146` | Fora de `comandos.js` (10 regex) a resposta é "não entendi". |
| L3 | Respostas são modelos fixos | `respostas.js`; redator desligado | Não há resposta livre nem explicação; "por que caiu" vira lista de fatos. |
| L4 | Contexto = última consulta + recorte ≤ 512 B, 10 min, por participante | `mova.conversa_ativa` (0005/0017) | Não há memória de entidades ("ele", "essa compra"), resumo, retomada de assunto nem continuidade depois de 10 min. |
| L5 | Pendências: busca pelo id da mensagem **original**; memória curta pega só a **mais recente** | `mensagens.tomarPendente/tomarPendenteRecente` | Resposta citando a pergunta do MOVA não acha a pendência (caso dos brownies). Várias pendências se atropelam. |
| L6 | Guardas por regex antes da IA | `motor.js:51`, `privacidade.js` (18 regex), `divergencia.js` (17) | Útil para segurança, mas decide intenção por padrão de texto (falso positivo bloqueia, falso negativo passa à IA). |
| L7 | Domínios fora do MOVA | — | Sem sangria/operação de caixa, sem entregas por entregador ("quantas ele fez ontem"), sem CMV/insumos/checklist/dashboard iFood. **Não existe módulo de funcionários** no sistema (nenhum serviço encontrado). |
| L8 | Nenhum prompt caching | 0 ocorrências de `cache_control` em `mova-financeiro` e `agente` | O prompt fixo do extrator (~5.500 tokens com o schema) é pago inteiro a cada chamada. |
| L9 | Orçamento **total acumulado** (US$ 10, não mensal) e 20 chamadas em produção | `infra/operacao.js` (`TETO_TOTAL_IA_MICROUSD`), `mova.orcamento_ia` | Qualquer uso conversacional esgota o limite em minutos. Não é um teto por período: ele não reinicia. |
| L10 | Motor monolítico, ordem de passos como regra de negócio | `motor.js` | Cada recurso novo é mais um ramo; difícil de testar em combinação. |
| L11 | Duas pilhas de IA paralelas | `modules/agente` (Agente Crescer, web) × `mova-financeiro` | Loop de ferramentas, cota, preço e auditoria duplicados. A tabela de preços do Agente não tem os modelos 5.5 e o padrão é `claude-opus-5` ($5/$25). |
| L12 | Avaliação limitada | `test/mova-financeiro/avaliacao/casos.mjs` (23 casos) | Só mede a extração de uma mensagem. Não mede conversa com várias trocas, escolha de ferramenta, custo nem latência. |

## 3. Inventário de módulos e serviços existentes

| Módulo | O que oferece | Situação para o MOVA |
|---|---|---|
| `financeiro-v2` (núcleo) | **182 operações** já classificadas em `docs/mova-matriz-capacidades.md`: LEITURA 77, ADMINISTRATIVA 40, FINANCEIRA 28, CRÍTICA 37. DRE (`apurarCompetencia`), fluxo, caixa e bancos, contas a pagar e a receber, conciliação, baixa agrupada, comprovante, entregadores próprios, quantidades de entregas, sangrias SWF/Saipos, plano de contas, documentos | 19 leituras e 8 escritas já passam pelas portas do MOVA |
| `mova-financeiro` | Fila, idempotência, participantes/perfis, unidade determinística, propostas, políticas de autonomia, execução, entregadores, Central de conferência, orçamento | Base do CORE |
| `agente` (Agente Crescer) | **Loop de tool use** manual (6 iterações), registro de ferramentas com `access/mode/risk`, filtro do catálogo por permissão, histórico de 12 mensagens, cota atômica (RPC 067), medição de custo | Padrão a reutilizar; ferramentas de dashboard executivo, dia, evolução diária, CMV de produto, insumos, cancelamentos do parser, checklist, diagnóstico, navegação |
| `dashboard-executivo`, `dashboard`, `inteligencia` | Indicadores por canal, confiabilidade, período misto | Leitura (já usada pelo Agente) |
| `checklist-operacional`, `cmv`, `insumos`, `produtos` | Operação de loja e custo | Leitura (já usada pelo Agente) |
| `foody`, `parser-food-delivery`, `ifood`, `martinbrower`, `vendas` | Pedidos, entregas, cancelamentos, compras | Leitura indireta (via FV2 e Agente) |
| `usuarios`, `unidade`, `sessao`, `plataforma`, `shared/permissoes.js` | Identidade da plataforma, unidades, permissões | Necessário para ligar participante ↔ usuário |
| `gateway-whatsapp` | Grupos, privados, citação (`respostaA`), saída por relé, retry | Sem mudança prevista |

## 4. Ferramentas disponíveis para integração

**Já prontas no MOVA (30 consultas, só leitura, por unidade):** FATURAMENTO, DRE_RESUMO, FLUXO_DE_CAIXA, CONTAS_A_RECEBER, CONTAS_A_PAGAR_ABERTAS, CONTAS_VENCENDO, CONTAS_VENCIDAS, FECHAMENTO_ENTREGADORES, PENDENCIAS, DESPESAS_POR_CATEGORIA, CONTAS_SEM_COMPROVANTE, PAGAMENTOS_A_CONCILIAR, MAIORES_CONTAS_ABERTAS, CONTAS_PARCIAIS, FORNECEDORES_COM_PENDENCIAS, SITUACAO_DE_CONTA, CATEGORIAS, DOCUMENTOS, RESUMO_DA_COMPETENCIA, SITUACAO_PROPOSTAS, COMPARATIVO_UNIDADES, PAGAMENTOS_A_FORNECEDOR, COMPARATIVO_DE_DESPESAS, ENTREGADORES_SEM_NOTA.

**Escritas já existentes (porta operacional, por concessão + política):** enviarEvidencia, vincularPagamentoDoExtrato, anexarDocumentoDoEntregador, registrarPagamentoPorComprovante, conciliarPagamentoPorComprovante, registrarObrigacaoDocumental, registrarPagamentoComEncargo (+ propostas aplicadas por humano: registrarObrigacao, pagarContaAPagar).

**Prontas no núcleo, ainda fora do MOVA (leitura, baixo risco):** consultarCaixaEBancos, consultarMovimentosDeCaixa, consultarCalendarioFinanceiro, consultarPosicaoAReceber, detalharContaAReceber, consultarEntregador / detalharFechamentoDoEntregador (entregas por entregador e por dia vêm da apuração Foody), quantidades de entregas da DRE, consultarConferenciaSwf, consultarDivergenciasDeVendas, consultarHistorico; mais as 13 ferramentas do Agente Crescer.

**Escritas que exigem decisão antes:** sangria (`tesouraria.registrarOperacaoDeCaixa` exige **sessão de caixa aberta** e a ação REGISTRAR; o MOVA não tem essa ação). "Tirei 15 reais do caixa para grampos" = operação SANGRIA + despesa paga em dinheiro. Precisa de uma regra aprovada: a sangria entra na sessão do dia ou vira só despesa paga pela conta "caixa da loja"?

**Não existe e não será simulado:** funcionários/RH, folha, escala.

## 5. Arquitetura proposta do MOVA CORE

**Recomendação: um agente central com ferramentas especializadas, dentro do módulo `mova-financeiro`. Sem multiagente e sem framework novo.** As guardas determinísticas atuais continuam como camadas externas; a IA passa a escolher ferramentas e redigir respostas.

```
evento ─► [A] Guardas determinísticas (mantidas: grupo, eco, duplicidade, participante, dado restrito,
              pedido de execução de pagamento, mídia recusada)
        ─► [B] Resolução de contexto (sem IA): pendência citada → pendências abertas da pessoa → fio da conversa
        ─► [C] Roteador por nível
              N0 determinístico (comandos, seguimentos, resposta a pendência, saudação)  → sem IA
              N1 interpretação econômica (Haiku 5.5, 1 chamada, JSON estrito: intenção + ferramenta + args)
              N2 agente com ferramentas (Haiku 5.5, loop ≤ 4 passos)
              N3 análise (Sonnet 5.5, loop ≤ 6 passos; só com flag + orçamento)
        ─► [D] Executor de ferramentas (servidor): escopo injetado pelo backend, permissão revalidada,
              resultado com IDENTIFICADORES OPACOS (ref#1, ref#2) mapeados no servidor
        ─► [E] Composição: resposta livre verificada contra os fatos (todo número/data/nome vem de um resultado)
              senão, volta o texto determinístico
        ─► [F] Escrita: só "preparar_*" → PROPOSTA versionada → confirmação ligada a (proposta, versão)
              → execucao.js + políticas + porta operacional (como hoje)
        ─► [G] Saída + memória + auditoria + métricas
```

O que muda no `motor.js`: os passos 8–10 (extrator → enum → ferramenta) dão lugar a [C]–[E], e os passos 11–14 (unidade, transferência, receita, pagamento, conta) viram o **validador das ferramentas de escrita**, sem perder nenhuma regra. O motor atual continua sendo o caminho padrão até o CORE passar na avaliação (modo sombra).

## 6. Estratégia de memória e contexto

| Camada | Armazenamento | Validade | Conteúdo |
|---|---|---|---|
| 1. Imediato | mensagem + citada (`mova.evento`) | a requisição | texto atual, mensagem citada |
| 2. Fio da conversa | **nova** `mova.conversa_fio` (grupo × participante) | 24 h sem atividade (configurável) | últimas 6 trocas resumidas (≤ 1,5 KB), **entidades referidas** com id opaco (entregador, fornecedor, conta, proposta, período, unidade) e o assunto atual |
| 3. Pendências | `mova.mensagem_pendente` (já existe) + coluna de validade e tipo | própria por tipo (pergunta de unidade 30 min; divergência financeira até a competência fechar ou 72 h) | várias por pessoa; retomada por citação, por id ou por escolha explícita ("a do brownie") |
| 4. Memória corporativa | **nova** `mova.conhecimento` | até revogar | fatos aprovados, com versão, origem, escopo (org/empresa/unidade), aprovador |
| 5. Preferências | **nova** `mova.preferencia` | até revogar | ex.: "brownies → categoria INSUMOS_SOBREMESA na Unidade X"; só depois de aprovada |
| 6. Decisões | `mova.decisao`, `mova.auditoria`, propostas (já existem) | permanente | recuperável por ferramenta, nunca injetado inteiro |

Regras: a chave de todo registro inclui conversa + participante + organização; nada atravessa empresa. Ao retomar pendência ou proposta antiga, a permissão e os dados são **relidos** (o motor já faz isso para o saldo da conta, `porId`). A janela de 10 min continua valendo só para a "resposta curta sem citação"; deixa de ser o único mecanismo.

**Resolução de citação (sem IA, sem migração):** `mova.resposta` guarda `provider_message_id` e `resposta_a`. Quando a pessoa cita uma resposta do MOVA, o sistema chega à mensagem original e à pendência dela de forma exata. Isso resolve o caso do PR #203 sem heurística (ver §16).

## 7. Estratégia de RAG e conhecimento corporativo

1. **Agora não existe conteúdo pronto.** Os docs do repositório são técnicos (runbooks, migrações). Para o MOVA, a base precisa de material curado: manual de uso, processo de caixa, compras, entregadores, glossário financeiro (receita × recebimento etc.), particularidades das unidades.
2. **Infraestrutura: PostgreSQL que já existe.** Busca textual (`tsvector` português + `unaccent` + `pg_trgm`) sobre `mova.conhecimento`, filtrada por escopo e permissão. Exposta como **uma ferramenta** (`buscar_conhecimento`), chamada só quando a pergunta for de processo ou regra.
3. **Busca semântica (pgvector/embeddings): só se a avaliação mostrar perda de recall** com a textual. Com algumas centenas de trechos, a textual com sinônimos costuma bastar, sem custo de embeddings.
4. Dados financeiros **nunca** entram na base: são sempre lidos das ferramentas na hora.
5. Cada trecho tem `versao`, `origem`, `valido_de/ate`, `escopo`, `aprovado_por`; o trecho recuperado volta com a origem citada na resposta.

## 8. Estratégia de Tool Calling

**Registro central** (`mova-financeiro/core/catalogo.js`) no formato do `REGISTRO` do Agente Crescer, ampliado:

```js
{ nome, descricao, parametros /* JSON Schema estrito, additionalProperties:false */, validar,
  modo: "leitura"|"preparacao", risco: "baixo"|"medio"|"alto",
  exige: { perfil: "CONSULTA"|"FINANCEIRO", acaoFinanceiro: "financeiro_v2.ver" },
  escopo: "unidade"|"empresa"|"grupo", retorno: "fatos"|"proposta",
  confirmacao: "nenhuma"|"proposta_versionada", custoEstimado, executar }
```

- **Gerado a partir do que existe:** as 30 consultas viram cerca de 12 ferramentas semânticas com parâmetros (por exemplo, `contas_a_pagar{situacao, vencimentoDe/Ate, fornecedor, categoria, ordenar, limite}` substitui 9 enums). A classificação de risco vem da matriz de 182 operações. Operação sem classificação continua PROIBIDA.
- **Catálogo por requisição:** só as ferramentas que a pessoa pode usar naquela conversa e unidade, e só o grupo temático relevante (financeiro, entregadores, operação). O catálogo fica estável dentro do grupo para não quebrar o cache.
- **O modelo nunca informa `organizacaoId`/`unidadeId`/`usuarioId`:** o escopo vem do servidor. Para escolher a unidade, a IA usa o nome; `resolverUnidade` continua sendo a autoridade.
- **IDs opacos:** os resultados trazem `ref#n`; o modelo usa `ref#n` numa ferramenta seguinte e o servidor confere se a referência saiu desta conversa.
- **Escrita em duas fases:** `preparar_despesa_paga`, `preparar_conta_a_pagar`, `preparar_baixa`, `preparar_sangria` (depois da decisão do §4), `preparar_vinculo_documento` e `pedir_revisao` só criam uma PROPOSTA (`mova.proposta`, com versão). A execução é sempre do backend, depois de confirmação ligada a `(propostaId, versão)` ou de política de autonomia já aprovada. Os passos 11–14 do motor validam a proposta.
- **Sem SQL, sem credenciais e sem acesso ao núcleo fora das portas** (`portaFinanceira` só VER, `portaOperacional` por concessão).
- Erros voltam como `tool_result` com `is_error` e código (nunca mensagem interna).
- Detalhe técnico: em Haiku 5.5 o `tool_choice` forçado é aceito, mas o padrão será `auto` + `strict: true` para manter a troca de modelo simples.

## 9. Estratégia de modelos e economia de tokens

**Hoje:** só `claude-haiku-5-5` (decisão do proprietário em 21/11, sem fallback). Preços oficiais por milhão de tokens (entrada/saída): Haiku 5.5 US$ 0,10/0,50 (prompts até 100K); Sonnet 5.5 US$ 2/10; Opus 5.5 US$ 4/20. A tabela `PRECOS_IA` do MOVA está correta; a do Agente Crescer está desatualizada.

| Nível | Quando | Modelo | Limites |
|---|---|---|---|
| N0 | comando conhecido, seguimento, resposta a pendência, saudação, bloqueios | nenhum | — |
| N1 | uma pergunta com uma ferramenta óbvia | Haiku 5.5, 1 chamada, esforço `low` | saída 400 |
| N2 | conversa, referência, 2–4 ferramentas | Haiku 5.5, loop | ≤ 4 passos, ≤ 12K tokens de entrada acumulados, 20 s |
| N3 | "por que caiu", comparação entre unidades e períodos, plano com várias etapas | Sonnet 5.5 (**exige autorização**: muda a decisão de "só Haiku") | ≤ 6 passos, ≤ 40K tokens, 45 s, teto por pedido |

O Opus 5.5 não entra no plano inicial. A escalada N2→N3 é decidida pelo servidor (tipo de pergunta + falha do N2), nunca pelo modelo.

**Economia:** (1) **prompt caching** no prefixo estável (instruções + ferramentas; o mínimo cacheável no Haiku 5.5 é 512 tokens), com o cálculo de custo incluindo leitura e escrita de cache; (2) o schema de 5.500 tokens do extrator encolhe, porque cada ferramenta leva só os seus campos; (3) resumo do fio em vez do histórico bruto; (4) resultados de ferramenta compactados (linhas prontas, sem JSON bruto do núcleo); (5) extração de documento reaproveitada por sha256 (já existe `documentos.visto`); (6) proteção contra laço: limite de passos, de chamadas repetidas iguais e de custo por pedido; (7) métricas em `mova.consumo_ia` com nível, ferramenta, unidade e tipo de pedido.

**Orçamento:** o teto atual (US$ 10 **acumulados**, 20 chamadas) fica como está até haver autorização. Para operar, a proposta é: teto mensal por organização + teto diário + teto por pedido, todos no banco e com um teto máximo no código. **A decisão é do proprietário.**

## 10. Estratégia de segurança e autorização

Mantido sem alteração: lista de grupos e participantes, perfil por unidade (`CAPACIDADES`), unidade determinística, identidade de leitura ≠ identidade operacional, concessões gravadas relidas a cada chamada, políticas de autonomia, interruptores de `mova.controle`, mascaramento, regra de valor só no privado, regex de "pedido de execução de pagamento" antes da IA.

Acrescentado:
1. Filtro do catálogo por permissão (1ª camada) + revalidação dentro de cada `executar` (2ª camada), como no Agente Crescer.
2. Verificador de fidelidade: todo número, data, nome de pessoa ou fornecedor da resposta precisa estar nos resultados das ferramentas desta requisição. Generaliza o `validarRedacao`.
3. Conteúdo de documento e resultado de ferramenta entram como DADO delimitado; instrução dentro deles não muda o catálogo nem o escopo.
4. Confirmação só vale para `(propostaId, versão, participante)` e expira; "sim" solto sem pendência não executa nada.
5. Idempotência por `eventoId|ferramenta|args-hash`; a concorrência continua no núcleo (`tx.travar`).
6. Ligar participante do WhatsApp a usuário da plataforma: **não existe hoje**. Sem esse vínculo, as ferramentas do Agente Crescer (que exigem permissão de módulo da plataforma) não podem ser oferecidas no WhatsApp.

## 11. Estimativa de custos (cenários)

Premissas por pedido (com cache no prefixo; sem cache, cerca de 2,5× nos níveis N1/N2):

| Tipo | Tokens aprox. | Custo/pedido |
|---|---|---|
| N0 | 0 | US$ 0 |
| N1 Haiku | 5,5K entrada (5K cacheados) + 250 saída | ≈ US$ 0,0002 (sem cache: 0,0007) |
| N2 Haiku, 3 passos | ~21K entrada acumulada + 800 saída | ≈ US$ 0,001 (sem cache: 0,0025) |
| N3 Sonnet, 4 passos | ~40K entrada + 2K saída | ≈ US$ 0,04 (sem cache: 0,10) |
| Documento (imagem/PDF) Haiku | ~7K entrada + 300 saída | ≈ US$ 0,0008 |

Mistura considerada: 50% N0, 35% N1, 12% N2, 3% N3.

| Cenário (organização inteira) | Mensagens/mês | Documentos/mês | Estimativa/mês |
|---|---|---|---|
| Leve (30 msgs/dia) | 900 | 300 | ≈ US$ 1,5 com cache (US$ 3,3 sem) |
| Médio (100/dia) | 3.000 | 900 | ≈ US$ 5 (US$ 11) |
| Intenso (300/dia) | 9.000 | 2.700 | ≈ US$ 15 (US$ 33) |

Quase todo o custo vem do N3: cada 1% de pedidos no Sonnet custa mais que todos os N1+N2 somados. Sem N3 (só Haiku), o cenário intenso fica abaixo de US$ 5/mês. Estes números são **estimativas**; a fase 1 mede o real em modo sombra.

## 12. Plano de avaliação da inteligência

Suíte nova `test/mova-financeiro/avaliacao-core/` com **conversas** (cada caso tem várias trocas e um estado inicial de dados fictícios), em três modos: simulado (CI, sem custo), gravado (respostas reais guardadas e reexecutadas) e real (só com autorização e teto do script, como o `validacaoConversaReal.mjs`).

- **Conjunto inicial: 150 conversas**: 60 consultas (financeiro, entregadores, fornecedores), 30 operações (sangria, compra já paga, conta, baixa, parcial, juros), 20 de continuidade e referência ("ele", "essa compra", retomar assunto, corrigir valor), 15 de isolamento (outra unidade/empresa, participante sem perfil), 15 adversariais (instrução em documento, "ignore", pedido de pagamento, injeção em nome de fornecedor), 10 de dados ausentes ou competência incompleta.
- **Obrigatórios:** (a) **brownies**: comprovante maior que a conta aberta do mesmo fornecedor, legenda "comprei brownies e já paguei" → despesa NOVA paga, conta antiga intacta, com e sem citação; (b) "Tirei 15 reais do caixa para comprar grampos"; (c) "Quanto devemos ao Matheus?" + "Quantas entregas ele fez ontem?"; (d) "Por que nosso resultado caiu?" com competência em andamento.
- **Métricas** por caso e no total: ferramenta correta, argumentos corretos, decisão final, números iguais aos do Financeiro, violação de isolamento (tem que ser 0), escrita sem confirmação (tem que ser 0), esclarecimento desnecessário, tokens, custo, latência, passos.
- Os 23 casos atuais (`casos.mjs`) e as ~500 regressões da suíte `mova-financeiro` continuam obrigatórios.

## 13. Plano de implementação por fases

| Fase | Entrega | Flag / ambiente |
|---|---|---|
| F0 | Correção exata do caso citado (§16) + suíte de avaliação conversacional com a linha de base do motor atual + proposta de modelo de orçamento | sem mudança de comportamento além da correção |
| F1 | Catálogo de ferramentas de leitura (as 30 atuais reagrupadas + caixa/bancos, entregas por entregador) + roteador N0/N1/N2 + executor com escopo e refs opacas + prompt caching | `MOVA_CORE=sombra` (roda, mede, **não responde**) em homologação |
| F2 | Memória: `conversa_fio`, entidades, várias pendências, citação exata, retomada com revalidação | sombra → piloto num grupo |
| F3 | Resposta livre com verificador de fidelidade (fallback para o texto determinístico) | piloto |
| F4 | Ferramentas de preparação + confirmação versionada, reaproveitando `execucao.js`/políticas; compra já paga; sangria (depois da decisão) | escritas continuam atrás das chaves atuais |
| F5 | Base de conhecimento (busca textual) + aprendizado supervisionado (preferências propostas e aprovadas na Central) | — |
| F6 | N3 analítico (Sonnet 5.5) com limites | só com autorização de modelo e orçamento |
| F7 | Proatividade (vencimentos, divergências, duplicidades, margem): projeto e simulação, **sem envio** | desligado |

Cada fase é um PR independente, com teste e reversão por flag.

## 14. Dependências e riscos

**Decisões do proprietário:** (1) modelo de orçamento (o atual não comporta conversa); (2) liberar texto livre para a IA; (3) permitir Sonnet 5.5 no N3 (hoje "só Haiku"); (4) regra contábil da sangria; (5) vínculo participante ↔ usuário da plataforma; (6) quem escreve e aprova o conteúdo da base de conhecimento.

**Riscos:** respostas livres erradas, mitigadas pelo verificador e pelo fallback; custo crescer com o N3, mitigado por teto por pedido e escalada decidida pelo servidor; regressão no motor, mitigada pelo modo sombra e pela suíte atual; quebra de cache por catálogo variável, mitigada por grupos fixos de ferramentas; vazamento entre empresas por memória, mitigado pela chave composta e por testes de isolamento; dependência do relé para `provider_message_id` (conferir se a saída pelo relé grava esse campo antes de usar a citação exata); motor e CORE convivendo e divergindo durante a transição.

## 15. Critérios objetivos de aceitação

1. Avaliação conversacional: ≥ 90% de ferramenta correta e ≥ 95% de decisão final correta nas 150 conversas; brownies e sangria 100%.
2. **0** violação de isolamento, **0** escrita sem confirmação ou política, **0** número na resposta que não venha das ferramentas.
3. Esclarecimento desnecessário ≤ 10%; "não entendi" em pergunta com dado disponível ≤ 5%.
4. Custo médio N1+N2 ≤ US$ 0,0015 por mensagem (com cache), medido em sombra; nenhum pedido acima do teto por pedido.
5. Latência p95: N1 ≤ 5 s, N2 ≤ 12 s.
6. Suíte `mova-financeiro` atual 100% verde; os 23 casos de extração sem regressão.
7. Reversão por flag em menos de 1 minuto, sem migração.

## 16. Recomendações sobre o PR #203

O PR resolve o caso real, mas o faz **ampliando a heurística**: tira a condição `!evento.respostaA` da memória curta. Com isso, qualquer mensagem curta ("sim", "2", "outra compra") que **cite qualquer mensagem** retoma a pendência mais recente da pessoa dentro de 10 minutos, mesmo citando outra resposta do MOVA que não tem nada a ver com ela.

**Recomendação: não mergear como está; trocar pela resolução exata, que é pequena e não precisa de migração:**
1. Quando `tomarPendente(respostaA)` não achar nada, buscar `mova.resposta` com `provider_message_id = respostaA` (mesma conversa) e obter `resposta_a`, que é a mensagem original perguntada;
2. `tomarPendente(resposta_a)`, e então a pendência certa é retomada;
3. Se a citação for de uma resposta do MOVA **sem** pendência, não retomar nada (segue o fluxo normal);
4. Manter AUT-C3 e AUT-C4 e acrescentar: "sim" citando outra resposta do MOVA não retoma; duas pendências abertas, com a citação escolhendo a certa.

Antes, conferir se a saída pelo relé grava `provider_message_id`. Se não gravar, o passo 1 precisa desse ajuste primeiro.

## 17. Reutilizar × criar

| Reutilizar (como está) | Adaptar | Criar |
|---|---|---|
| Gateway, relé, fila, idempotência, receptor | `motor.js`: passos 8–10 viram roteador + loop; 11–14 viram validador das ferramentas de escrita | `core/catalogo.js` (registro com risco/confirmação/escopo) |
| `portaFinanceira`, `portaOperacional`, concessões, identidades | `ferramentas.js` (+Conversa): de 30 enums para ~12 ferramentas com parâmetros | `core/roteador.js` (N0–N3) e `core/loop.js` (passos, custo, laço) |
| `resolverUnidade`, perfis, `CAPACIDADES`, privacidade | `provedorAnthropic.js`: aceitar tools, cache, nível→modelo (com a lista permitida) | `core/verificador.js` (fidelidade, generalizando `validarRedacao`) |
| `mova.proposta`, `execucao.js`, políticas, Central | `infra/operacao.js`: teto por pedido/dia/mês (só com autorização) | `mova.conversa_fio`, `mova.conhecimento`, `mova.preferencia` (migrações novas, só em homologação) |
| Orçamento com reserva, controle, auditoria | `redator.js` → composição livre verificada | Suíte `avaliacao-core` (150 conversas) |
| Loop e registro do Agente Crescer (padrão) | Tabela de preços única (MOVA + Agente) | Vínculo participante ↔ usuário (depende de decisão) |

---
**Não feito nesta etapa:** nenhum código, merge, deploy, migração, alteração de orçamento, flag, escrita financeira ou envio de mensagem.
