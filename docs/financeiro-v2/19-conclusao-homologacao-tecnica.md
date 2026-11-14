# Financeiro v2 — 19. Conclusão da homologação técnica sintética (Execução 08C)

Data: 13/11/2026. Branch local `feat/financeiro-v2-conclusao-homologacao`, derivada de `5aa3d12` (08B).

> **Homologação técnica SINTÉTICA, não autorização de produção.**
> - Identidades, empresa, unidades, contas, documentos e valores são fictícios.
> - Tudo em 127.0.0.1, em instâncias PostgreSQL próprias e descartáveis; credenciais geradas localmente, fora do Git.
> - Produção não foi acessada; `backend/.env` não foi lido; o financeiro antigo não foi tocado; nada foi publicado.
> - A integração definitiva continua decidida como na 08B (§ 0 do doc 18): login, empresa/unidade e navegação da
>   plataforma; o Financeiro v2 mantém só as permissões por ação e a proteção PostgreSQL.

## 1. Diagnóstico (Fase A)

**Estado de partida conferido:** `5aa3d12` limpo (só arquivos não rastreados preexistentes, preservados).

| Suíte | Resultado em `5aa3d12` |
|---|---|
| Financeiro v2 em memória | 306/306 |
| Financeiro v2 no PostgreSQL | 306/306 |
| Frontend | 1.931 aprovados, 0 falhas, 26 pulados |
| Backend completo (worktree limpa, ambiente fictício) | 6.469 testes; 16 falhas e 1 cancelado preexistentes |

**O que já existia e foi reaproveitado (não recriado):**
- `reclassificarLancamento` no núcleo — mas sob a ação genérica `corrigir`, sem prévia, sem versão esperada, sem
  evidência e sem regra de natureza além de "receita ≠ despesa";
- Central de Conferências com detalhe de pendência, correspondências e ação de confirmar conciliação;
- fechamento com impedimentos calculados pelo núcleo (`impedimentosDeHomologacao`), inclusive `CLASSIFICACAO_PROVISORIA`;
- carga dirigida da 07B (Contas a Pagar/Receber) e seu teste de equivalência — modelo para a otimização desta execução.

**Lacunas encontradas:**
1. Nenhuma ação de reclassificação na interface; a pendência de classificação só podia ser documentada, não resolvida.
2. Vendas, Recebimentos, Central, Pendências, Fechamento e a **guarda de homologação** liam o histórico inteiro
   (`carregarRegistros`: 23 tabelas completas por consulta).
3. Uma candidata de conciliação **"FRACA" (só valor e data)** podia ser confirmada sem justificativa — contraria a regra
   "nenhuma conciliação por proximidade".
4. A tela de conciliação não oferecia **recusar** uma candidata (necessário para desfazer ambiguidade).
5. Lacunas de teste que a mutação expõe: "importar não confirma importação" e "ação de outra unidade não vale aqui"
   não eram exercitadas no banco.

## 2. Fluxo de reclassificação (Fase B)

**Núcleo:** `aplicacao/reclassificacao.js` (consulta + confirmação) e `dominio/reclassificacao.js` (regras puras).

| Passo | Como |
|---|---|
| Abrir a pendência | Central → Pendências → "Revisar" → botão "Revisar e reclassificar o lançamento" (despesa ou desconto a classificar) |
| Consultar a origem | lançamento, valor, data, canal, origem (conta a pagar, venda, retenção…), fonte |
| Classificação atual | categoria, natureza, selo "provisória" |
| Sugestão | categoria mais usada em OUTRAS contas da mesma contraparte (só sugestão; nunca aplicada sozinha) |
| Categoria permitida | só categorias lançáveis, ativas, não provisórias e de natureza compatível |
| Justificativa | obrigatória |
| Evidência | documento existente do escopo; obrigatória para sair de "a classificar" ou para categoria que exige documento |
| Prévia | calculada no servidor pelo motor de apuração; nada é gravado |
| Confirmar | revalida permissão, escopo, versão, competência, natureza e evidência dentro da transação |
| Resultado e histórico | versão nova, evento `RECLASSIFICACAO` com antes/depois e justificativa; vínculo documental da evidência |

**Casos econômicos distinguidos (`CASO`):**
- `MOVIMENTACAO_SEM_NATUREZA` — saída/entrada bancária sem título. **Não é reclassificada**: vincula-se a uma conta
  (senão a despesa seria reconhecida duas vezes). A tela explica o caminho.
- `OBRIGACAO_SEM_CATEGORIA_CONFIRMADA` — conta a pagar em "a classificar" (fora da DRE).
- `DESCONTO_SEM_FINANCIADOR` — dedução provisória; só vai para outra dedução.
- `CLASSIFICACAO_DE_RECEITA` — receita só vira outra receita.
- `CLASSIFICACAO_DE_DESPESA` — despesa provisória fora de obrigação.
- `REATRIBUICAO_ENTRE_CATEGORIAS` — categoria confirmada trocada por outra da mesma natureza.
- `CORRECAO_DOCUMENTAL` — só falta o documento: usa-se o vínculo de documento; a categoria não muda.
- `OPERACAO_CANCELADA_OU_ESTORNADA` — recusada.

**Regras econômicas:**
- Nenhum lançamento novo é criado; id, valor, competência, origem, canal, data e fonte são preservados.
- Natureza preservada; única troca aceita: despesa ⇄ patrimonial em conta a pagar (ex.: boleto que era principal de
  empréstimo — continua dívida, sai do resultado).
- Categoria provisória nunca é destino; categoria genérica (`OUTRAS_DESPESAS`) **também exige evidência** para tirar um
  lançamento da provisória — não serve de atalho para o fechamento passar.
- Sem compensações artificiais na DRE.

**Competências:**
- Aberta: reclassificação autorizada.
- Fechamento com pendências: exige também `corrigir` e deixa marca no histórico da competência (regra comum).
- Homologada: recusada (`COMPETENCIA_HOMOLOGADA`); a tela informa que é preciso reabrir formalmente. Testado:
  homologar → recusa → reabrir com justificativa (ação `reabrir`) → reclassificar → a versão homologada anterior
  continua reproduzível (só deixa de ser a vigente).

**Transação, idempotência, concorrência:**
- `versaoEsperada` obrigatória: prévia antiga → `CONFLITO_VERSAO` (nada gravado).
- Confirmar de novo o mesmo destino → `repetido: true`, sem gravação nem histórico novo.
- Duas confirmações concorrentes com a mesma versão → exatamente uma vence.

## 3. Permissões

- Ação nova `financeiro_v2.reclassificar`, separada de `corrigir`. **Migração restritiva**: nenhuma concessão existente a
  recebe (teste: concessão com `corrigir`/`revisar` continua sem `reclassificar`).
- **Núcleo**: `reclassificarLancamento` exige `reclassificar` (com `exigirConcessaoPersistida`, conferida na concessão
  gravada dentro da transação).
- **PostgreSQL (migração 0014)**:
  - catálogo do banco com a ação nova;
  - `fv2_lancamento`: gatilho `fv2_exigir_acao_do_lancamento` — mudar categoria/classificação/natureza exige
    `reclassificar`; na mesma gravação, valor, moeda, competência, situação, data, descrição, origem, canal, retenção e
    fonte não podem mudar (FV037); natureza incompatível, destino provisório ou categoria que não confere com o plano da
    unidade → FV038; sem mudança de categoria continuam valendo `cancelar`/`corrigir`/`revisar` (`reclassificar`
    sozinho não altera valor nem cancela);
  - USING de alteração de todas as tabelas inclui a ação nova (alcançar linhas referenciadas); o WITH CHECK de cada
    tabela continua decidindo a escrita;
  - evidência (vínculo documental) e histórico aceitam a ação nova.
- **Testado no banco** (núcleo "ingênuo" que alega todas as ações; SQL direto como papel da aplicação): `corrigir`
  não muda categoria (42501); `reclassificar` não cancela nem corrige; categoria + valor juntos → FV037; despesa →
  receita → FV038; código × id forjado → FV038; revogação vale na hora; unidade: ação concedida em outra unidade não vale
  nesta; escopo: lançamento de outra unidade não é alcançado.
- **Auditoria**: histórico do lançamento (antes/depois, justificativa, usuário), vínculo documental e, em fechamento com
  pendências, marca na competência.

## 4. Impacto econômico (Fase C)

A prévia (`consultarReclassificacao` com `categoria`) troca UM lançamento em memória e roda os MESMOS motores sobre os
registros reais:
- valor original, competência, categoria anterior/nova (com natureza e classificação);
- **DRE**: linhas que mudam (antes/depois), lançamentos fora do resultado antes/depois;
- **composição por canal**: canais cujo líquido muda (ou "lançamento sem canal");
- **contas a pagar**: efeito na DRE do título (ex.: "fora até classificar" → "na linha da categoria"); saldo não muda;
- **caixa/bancos**: sempre "nenhum efeito" — reclassificar não movimenta dinheiro;
- **impedimentos** de homologação antes/depois e **pendências que permanecem**.

Nenhuma fórmula no frontend: a tela só exibe. A prévia não grava (teste: DRE, versão, categoria e histórico idênticos
depois da consulta). A confirmação revalida tudo na transação; prévia velha não autoriza.

## 6. Consultas otimizadas (Fase E)

**Antes:** `carregarRegistros` lia 23 tabelas inteiras do escopo em cada consulta de Vendas, Recebimentos consolidados,
Central, Pendências, Fechamento, prévia e guarda de homologação.

**Agora — `aplicacao/cargaDaCompetencia.js`:**
1. cadastros e controle pequenos inteiros (categorias, contas, saldos informados, sessões de caixa, contrapartes,
   competências, documentos, importações, divergências entre relatórios, transferências);
2. **sementes** da competência, filtradas no banco: vendas, lançamentos, recebíveis, obrigações, ajustes e propostas por
   competência; liquidações e estornos pela data do período; movimentações **desde a âncora de saldo** que o cálculo do
   período usa (saldo inicial e conferência de saldos informados dentro do período);
3. **fecho dos vínculos nos dois sentidos**, até não aparecer registro novo: venda ⇄ pagamentos ⇄ recebíveis ⇄ liquidações
   ⇄ movimentações ⇄ estornos; título → ajustes → lançamentos; lançamento → origem (venda, recebível, ajuste, obrigação,
   proposta, estorno) pelos subcampos `origem.id`/`origem.vendaId`;
4. propostas e pedidos importados das **competências tocadas** pelos registros carregados; vínculos documentais dos
   registros carregados; conciliações da competência (pela competência dos registros e da conciliação) e todas as
   divergentes.

Detalhes de PostgreSQL:
- filtros por organização + unidade em toda consulta (e RLS por baixo);
- `em` em lotes de 200 valores, cada lote **paginado no banco** (500 por página), na ordem de gravação;
- a ordem final de cada tabela é a de **gravação** (propriedade não enumerável `ORDEM_DE_GRAVACAO`, devolvida pelas duas
  persistências), igual à de `listar` — os cálculos que dependem de ordem não mudam;
- agregações e totais continuam calculados sobre o conjunto da competência, nunca sobre a página;
- **migração 0015**: índices das sementes (competência, data efetiva) e do fecho (venda, grupo, pagamento, alvo,
  registro, `origem->>'id'`, `origem->>'vendaId'`);
- a prévia de reclassificação usa a mesma carga dirigida (e lê o histórico só da contraparte para a sugestão).

**Sem N+1 por registro:** o fecho faz, por volta, uma consulta por (tabela, campo) para todos os registros novos.

**O que continua lendo mais que a competência (e por quê):**
- cadastros/controle (item 1): pequenos e necessários a qualquer competência (plano de contas, contas, âncoras de saldo,
  importações que podem cobrir o período). Crescem com o número de arquivos importados, não com as vendas.
- **detalhes** de uma venda/recebimento (`detalharVenda`, `detalharRecebimento`) ainda usam a carga completa: são
  consultas de UM registro, abertas sob demanda; não estavam no escopo das listas. Plano mínimo: carregar a partir do
  fecho do próprio registro (mesma função, semente = o id).
- movimentações desde a âncora de saldo: se uma conta não tiver saldo informado há meses, a carga volta até a última
  âncora (o cálculo do saldo precisa disso). Plano: registrar saldo informado mensal (rotina de conferência bancária).

## 7. Prova de equivalência

1. **Teste dedicado** `desempenho-equivalencia-competencia.test.js` (memória e PostgreSQL): cenário com venda de
   setembro recebida em outubro, recebível de agosto parcialmente liquidado, pagamento agregado (um crédito, dois
   recebíveis de meses diferentes), obrigação de setembro paga em outubro, estorno posterior (devolução em outubro de
   venda de setembro; liquidação de julho estornada), retificação de documento (v2 substitui v1), conciliação entre
   competências, fechamento com pendências, saída sem natureza, crédito não identificado, saldo informado divergente,
   descontos sem financiador. Compara, mês a mês (jul–out), carga dirigida × carga completa:
   Central, Fechamento, prévia de homologação, Pendências (6 filtros, páginas) e o **detalhe de cada pendência**;
   Vendas, Pagamentos, Taxas, Recebíveis/repasses e Divergências (competência, período entre meses, canal, forma,
   processador, páginas). Igualdade profunda e estrita (valores, contagens, estados, vínculos, pendências, documentos,
   histórico, confiabilidade, saldos, versões).
2. **A suíte inteira como prova**: com `FV2_CONFERIR_CARGA=1`, cada consulta otimizada também calcula com a carga
   completa e falha se diferir. Resultado: **319/319 em memória e 319/319 no PostgreSQL** — todos os cenários das
   execuções 01–08C (vendas, estornos, reaberturas, homologações, conciliações, importações, concorrência...) produziram
   resultado idêntico.
3. **A prova tem dentes**: um repositório que "perde" uma liquidação só nas consultas da carga dirigida é recusado pela
   conferência (`INTEGRIDADE_VIOLADA`, com o caminho da diferença). Mutações M16/M17 (§ 9) removem arestas do fecho e
   são detectadas.
4. **No conjunto de 12 meses** do teste de desempenho, cada mês e cada tela otimizada foi comparada (§ 8).

## 8. Desempenho antes e depois (Fase F)

**Conjunto:** gerado pelo próprio núcleo no PostgreSQL isolado. A versão de 12 meses tem 4.800 vendas, 3.600 recebíveis,
480 obrigações, 6.480 lançamentos, 1.472 movimentações (com repasses agregados liquidando recebíveis do mês anterior),
480 propostas e 84 documentos. Também foi medida uma versão de 3 meses, com 400 vendas por mês.

**Condições comparáveis:** "antes" é a carga completa (`cargaCompletaDeReferencia`, o comportamento até a 08B), medida
no MESMO banco, com os mesmos dados, na mesma máquina e na mesma execução. Mediana de 5 execuções. Estatísticas do
planejador atualizadas (`ANALYZE`, como o autovacuum faz num banco em uso). Tempos reais deste computador, não metas.

| Tela | 3 meses: antes → depois | 12 meses: antes → depois |
|---|---|---|
| Vendas (página) | 140 → 191 ms | 536 → 257 ms |
| Recebimentos consolidados | 123 → 188 ms | 474 → 256 ms |
| Central de Conferências | 136 → 197 ms | 537 → 261 ms |
| Pendências (página) | 132 → 203 ms | 556 → 255 ms |
| Fechamento (situação) | 136 → 203 ms | 511 → 266 ms |
| Prévia de homologação | 100 → 179 ms | 410 → 247 ms |

**Crescimento com o histórico (4× mais meses):**
- carga completa: cerca de 4×;
- carga dirigida: cerca de 1,3×, lendo **exatamente as mesmas linhas** nos dois tamanhos (perfil da Central: 1.320
  lançamentos, 760 recebíveis, 560 pagamentos e 480 vendas, tanto em 3 quanto em 12 meses).

**Equivalência no conjunto de 12 meses:** Central, Pendências, Fechamento, Vendas, Recebimentos e Divergências deram
resultado IDÊNTICO nos 12 meses.

**Outras medições, 12 meses, depois:**

| Medição | Tempo |
|---|---|
| DRE | 40 ms |
| Visão Geral | 363 ms |
| Contas a Pagar | 50 ms |
| Contas a Receber | 248 ms |
| Caixa e bancos | 300 ms |
| 10 telas simultâneas | 1.248 ms |
| Memória (RSS / heap) | 180 / 64 MB |

**Achado durante a medição:** sem estatísticas, o PostgreSQL usava só o prefixo organização+unidade dos índices novos e
percorria a unidade inteira. O plano mostrava "Rows Removed by Filter: 6480". Com `ANALYZE`, a mesma consulta passa a
usar o índice certo: 2–3 ms caem para menos de 1 ms. Um banco de produção roda `ANALYZE` automaticamente; mesmo assim,
fica como item de operação: rodar `ANALYZE` depois de cargas grandes, como a importação inicial.

**O que continua — por isso o domínio Desempenho fica PARCIAL, não PASS:**
1. Crescimento residual da carga dirigida (~1,3× para 4× de histórico). As linhas lidas não mudam; o tempo por
   consulta cresce um pouco (lançamentos: 48 → 81 ms). Causa: o fecho repete leituras. Os lançamentos voltam pela
   competência e de novo por `origem.id` e `origem.vendaId`, e cada consulta paginada faz uma contagem. Plano mínimo:
   - não pedir de novo, por origem, os registros que já vieram pela competência;
   - trocar `count(*)` por "página cheia → pede a próxima".
2. Histórico curto: com 3 meses, a carga dirigida fica 40–80 ms mais lenta que a completa, por causa das dezenas de idas
   ao banco do fecho. Plano: juntar as consultas de cada volta do fecho numa função SQL única.
3. Telas fora do escopo desta execução também crescem com o histórico:
   - Visão Geral: 116 → 363 ms;
   - Contas a Receber: 59 → 248 ms;
   - Caixa e bancos: 79 → 300 ms.

   A Visão Geral usa o resumo de tesouraria sobre o histórico inteiro. Caixa precisa das movimentações desde a âncora
   de saldo. Plano: a mesma carga dirigida para o resumo e saldo informado mensal.
4. Os detalhes de venda e de recebimento ainda usam a carga completa (§ 6).
5. Carga de dados da medição: 3 dos 11 fechamentos "com pendências" do gerador foram recusados com
   `TRANSICAO_INVALIDA` (causa no gerador de dados não investigada nesta execução). As telas medidas são
   do último mês, que fica aberto, e a equivalência foi conferida em todos os meses mesmo assim.
