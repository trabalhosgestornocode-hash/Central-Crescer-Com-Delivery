# Entrega local — Central de Performance e Fechamento Mensal

Implementação de 09/09/2026. A regra de negócio esclarecida pelo usuário prevalece: **Centro e Avenida não usam Parser Food Delivery**. O parser não é consultado por essas unidades e sua ausência não afeta a completude.

## Resultado funcional

Painel Administrativo → Central de Performance → Fechamento Mensal.

A tela permite escolher unidade/competência, consultar a visão unificada, identificar AUTOMÁTICO / MANUAL / CALCULADO / SEM DADOS, editar somente os complementos permitidos, salvar, fechar e reabrir. Mostra disponibilidade percentual, pendências, cobertura financeira, versão e auditoria. O layout móvel apresenta cada indicador com valor, origem e status, sem exigir uma planilha larga.

A visão gerencial oferece filtro mensal, últimos 3/6 meses, todas as unidades ou uma unidade, cards, comparação, evolução de faturamento com Chart.js existente, diagnósticos e atalhos para abrir cada competência.

**A migration está no repositório e foi validada somente em PostgreSQL isolado em memória. Não foi aplicada em nenhum banco persistente, local remoto ou de produção.** Em um ambiente onde a migration ainda não exista, a API retorna 503 com explicação de que a migration 078 está pendente. A validação funcional utilizou dependências controladas; não foi necessária conexão com produção.

## Migration e estrutura

Arquivo: `database/migrations/078_performance_mensal_complemento.sql`.

Cria apenas `performance_mensal_complemento` para os complementos. Não copia lançamentos oficiais, não cria tabela de BI, não importa a planilha e não altera valores históricos.

| Grupo | Colunas |
|---|---|
| Identidade | `id`, `organizacao_id`, `unidade_id`, `competencia` |
| Complementos permitidos | `faturamento_ifood_manual`, `despesas_ifood_manual`, `pedidos_manual`, `novos_clientes_manual`, `conversao_manual`, `taxas_entregadores_ifood_manual` |
| Complemento opcional separado | `despesas_entregadores_externos_manual` |
| Estado e concorrência | `status` (rascunho/fechado), `versao` |
| Auditoria mínima | `criado_em`, `criado_por`, `atualizado_em`, `atualizado_por`, `fechado_em`, `fechado_por` |
| Revisão do fechamento | `fechamento_hash` — hash dos valores/origens/cobertura; não armazena cópia de dados oficiais |

Constraints:

- PK UUID.
- UNIQUE (`unidade_id`, `competencia`), impedindo dois complementos da mesma competência.
- FK composta (`unidade_id`, `organizacao_id`) para a unidade e sua organização real.
- FKs de organização e autores em `organizacoes` / `perfis`.
- Competência sempre no primeiro dia do mês.
- Dinheiro não negativo e não NaN; precisão numeric(14,2).
- Quantidades inteiras não negativas; conversão entre 0 e 100, quatro casas decimais.
- Estado fechado exige data, autor e hash; rascunho exige esses campos nulos.
- Versão positiva.

Índices: PK, UNIQUE unidade/competência, índice organização/competência e índice único `(id, organizacao_id)` em `unidades`, necessário à FK composta.

Trigger `performance_complemento_versionar`: impede mudar organização/unidade/competência, preserva criação, atualiza timestamp e incrementa a versão. A API atualiza usando a versão lida como condição; conflitos respondem 409. Criação concorrente é protegida pelo UNIQUE e também responde 409.

RLS habilitada. Sem policies de acesso direto para clientes. Privilégios revogados de `anon` e `authenticated`; `service_role` recebe SELECT/INSERT/UPDATE. O backend continua responsável pela autorização administrativa e pelo escopo explícito das consultas, como nos módulos atuais do painel.

## Fontes e precedência

1. Fonte oficial válida, inclusive valor zero.
2. Complemento apenas se não houver valor automático recuperável.
3. Indicadores derivados calculados sobre essa combinação, nunca persistidos.

O backend recusa edição de campo automático ou derivado mesmo em chamadas diretas à API. Reconsulta as fontes antes de salvar. Se uma fonte oficial aparecer posteriormente, ela prevalece, e a resposta sinaliza que o complemento anterior foi ignorado. Nenhum valor automático é copiado para a tabela complementar.

| Campo | Automático | Manual | Calculado |
|---|---|---|---|
| Faturamento | `lancamentos_financeiros_diarios.valor_vendas_ifood`, snapshot oficial | Só quando ausente | — |
| Despesas iFood | Deduções do snapshot: comissões + serviços + taxas entregadores iFood + ajustes contra | Só quando ausentes | Soma oficial reutilizada |
| Pedidos | Par oficial de Desempenho, `desempenhoParaTicketMedio` | Só quando ausentes | — |
| Novos clientes | `novosClientesAcumulados` da fonte de Desempenho | Só quando ausentes | — |
| Conversão | Nenhuma fonte atual | Complemento mensal, 0–100% | Não inferida |
| Taxas entregadores iFood | `taxas_entregadores` do snapshot financeiro | Só quando ausentes | — |
| Entregadores externos | **Nenhuma fonte automática para Centro/Avenida** | Opcional, complemento específico | Não entra nas deduções iFood |
| Após despesas | — | Não editável | Faturamento − despesas iFood |
| Retenção após iFood | — | Não editável | Após despesas / faturamento × 100 |
| Ticket médio da Central | — | Não editável | Faturamento iFood / pedidos |
| Custos percentuais | — | Não editáveis | Despesa identificada / faturamento × 100 |
| Custo por pedido | — | Não editável | Despesa identificada / pedidos |
| Variação | — | Não editável | (atual − anterior) / anterior × 100 |

Reutiliza `snapshotFinanceiroMaisRecente`, `totalDeducoes`, `desempenhoParaTicketMedio` e `novosClientesAcumulados` do Dashboard iFood. Não soma snapshots diários acumulados; distribuições mensais são fallback oficial.

Taxas de entregadores iFood já compõem as deduções. O custo externo é um indicador distinto, não somado automaticamente às deduções nem descontado novamente da retenção. A retenção não é lucro real. O ticket da Central segue o pedido mais recente; o Dashboard continua usando bruto do Desempenho / pedidos.

## Completude e fechamento

Seis indicadores obrigatórios centralizados: faturamento, despesas iFood, pedidos, novos clientes, conversão e taxas de entregadores iFood. Custo externo **não é obrigatório**.

Percentual = quantidade dos seis indicadores conhecidos / 6 × 100. Zero conta como disponível; null não. Indicadores derivados com base zero mostram ausência de base, sem NaN ou Infinity.

Estados exibidos: Em andamento, Incompleto, Completo, Fechado e Revisão necessária. A existência de uma linha na tabela não torna o mês completo. O mês atual não pode ser fechado. Snapshot financeiro anterior ao último dia ou lançamento em rascunho bloqueia fechamento. É possível ter 100% dos campos disponíveis e cobertura parcial — o estado permanece Incompleto.

Campos de meses fechados exigem reabertura para edição. Alteração das fontes após fechamento muda o estado apresentado para Revisão necessária; o hash antigo serve apenas para detectar a mudança, nunca para congelar valores oficiais.

## Comportamento do histórico

| Período | Comportamento |
|---|---|
| Abril–junho/2026 | SEM DADOS onde não há fonte. Permite preencher os seis complementos históricos; nenhum valor foi inserido. Com todos os campos, pode fechar a competência passada. Custo externo continua opcional. |
| Julho/2026 | Recupera financeiro mensal da fonte oficial e permite complementar somente os indicadores ausentes (pedidos, clientes e conversão, conforme auditoria). Não duplica faturamento/despesas/taxas existentes. |
| Agosto/2026 | Recupera financeiro e Desempenho; permite complementar conversão. Com snapshot até 29/08, permanece parcial e não fecha. O financeiro deve ser concluído na origem. |

## Unidades e Parser opcional

`performance.config.js` contém os dois UUIDs verificados na auditoria como seleção inicial. `PERFORMANCE_UNIDADE_IDS` pode substituir essa lista. A lista sempre é intersectada com unidades elegíveis do painel: ativas, não teste, organização ativa/não modelo e módulo iFood efetivo. Nenhum ID ou nome de Centro/Avenida foi fixado no frontend.

`PERFORMANCE_PARSER_UNIDADE_IDS` é vazio por padrão. Uma unidade futura somente consulta o Parser quando explicitamente incluída nessa configuração **e** elegível no módulo `parser_food_delivery`. Ausência do Parser nunca reduz completude. Não habilitei essa configuração para Centro/Avenida ou Saci.

Quando habilitado, a fonte opcional considera taxas válidas das importações concluídas contidas na competência; sobreposição ou cruzamento de meses exige revisão na origem e não gera uma soma ambígua. É uma extensão opcional, sem dependência operacional para as unidades atuais.

## Endpoints

Todos sob `/api/v1/administrativo/performance`, após autenticação, senha definitiva, gate administrativo, MFA quando habilitado e limite de taxa existentes.

| Método / caminho | Uso |
|---|---|
| GET `/` | Visão gerencial: `inicio=AAAA-MM`, `fim=AAAA-MM`, `unidade_id` opcional |
| GET `/unidades` | Unidades configuradas e elegíveis |
| GET `/competencias` | Lista competências e completude; mesmos filtros, até 24 meses |
| GET `/unidades/:unidadeId/competencias/:competencia` | Abre competência unificada |
| PATCH `/unidades/:unidadeId/competencias/:competencia` | Salvar, fechar ou reabrir |

PATCH recebe `{ "versao": 0, "campos": { "conversao": 16.49 }, "acao": "salvar" }`. Ações: salvar/fechar/reabrir. Reabertura não aceita campos. Organização e autor vêm do backend, nunca do corpo. Valores null removem complementos. Resposta no envelope `{data}` existente.

Permissão do painel permanece global/cross-tenant para administradores autorizados e SuperAdmin, conforme a arquitetura existente. Contexto operacional de usuário comum não concede acesso à Central. Cada leitura/escrita de dados usa organização **e** unidade; o frontend não envia Context Token nesse ambiente.

## Arquivos

Criados para esta implementação:

- `database/migrations/078_performance_mensal_complemento.sql`
- `backend/src/modules/administrativo/performance/performance.repo.js`
- `backend/src/modules/administrativo/performance/performance.competencia.js`
- `backend/src/modules/administrativo/performance/performance.service.js`
- `backend/src/modules/administrativo/performance/performance.controller.js`
- `backend/src/modules/administrativo/performance/performance.routes.js`
- `frontend/src/performance.js`, `frontend/src/performance.css`
- `backend/test/performance-service.test.js`, `backend/test/performance-migration.test.js`
- `frontend/test/performance.test.js`, `frontend/test/performance.browser.test.js`
- Este relatório, logs e screenshots em `docs/performance-validacao/`.

Alterados:

- `performance.config.js` e `performance.calc.js` criados na auditoria anterior.
- `backend/src/modules/administrativo/administrativo.routes.js` — montagem após os gates.
- `frontend/src/painelAdmApi.js` — métodos da Central.
- `frontend/src/painelAdmViews.js` — registro e despacho da aba.
- `frontend/index.html` — CSS da área.
- `frontend/test/painelAdm.test.js` — expectativa de menu com a nova aba.

Artefatos anteriores preservados: script da auditoria, relatório original, evidência JSON e testes de cálculo. `scratchpad/` já estava não rastreado e não foi alterado.

## Testes e evidências

- **232 testes de backend passaram**, zero falhas/ignorados: suítes administrativas existentes, autorização, cálculos, service, HTTP e migration.
- **247 testes de frontend passaram**, zero falhas/ignorados: suítes do painel, renderização e navegador Edge headless em desktop/mobile.
- Coberturas novas: leitura oficial, fallback, prioridade inclusive zero, criação/edição/remoção, UUID e competência, isolamento de linhas entre organizações, configuração do Parser, custo externo opcional, julho distribuído, agosto parcial, mês atual, revisão pós-fechamento, edição concorrente, origem recém-disponível e bloqueio de sobrescrita/derivados.
- PostgreSQL PGlite foi instalado apenas na pasta temporária de validação. Migration executada sobre tabelas-base mínimas em memória: PK/UNIQUE/FK composta, checks, trigger/versão, RLS e privilégios testados. Nenhuma dependência adicionada ao package.json do produto. Não é teste de aplicação da migration sobre uma cópia integral de produção.
- Browser validou seleção de aba, inputs permitidos, PATCH somente do campo alterado, botão de fechamento parcial bloqueado, ausência de erros JS e layout sem transbordamento horizontal. Screenshots contêm dados ilustrativos de teste, identificados na tela.
- A única falha na primeira rodada foi a expectativa antiga do menu sem a nova aba; expectativa atualizada e suíte passou. Nenhuma regressão funcional detectada.

Logs: `docs/performance-validacao/backend.log` e `frontend.log`. Capturas: `performance-fechamento-desktop.png`, `performance-fechamento-mobile.png`.

Execução reproduzível: backend usa `.env.test-http`, com `PERFORMANCE_PGLITE_PATH` apontando para PGlite temporário; frontend usa `PERFORMANCE_PLAYWRIGHT_PATH` para o runtime e `PERFORMANCE_BROWSER_CHANNEL=msedge`. Nenhum teste desta entrega precisa de `.env` de produção.

Limitações deliberadas: conversão consolidada entre meses/unidades permanece indisponível sem denominador de visitas; cada competência individual mostra a conversão manual. Totais com um mês/unidade sem dados ficam indisponíveis, não ocultam lacunas. Migração em ambiente persistente e deploy não fazem parte desta execução.

## Git e produção

Mudanças locais, sem commit, push, merge ou deploy. `git diff --check` sem erros. **Produção permaneceu intocada nesta execução: nenhuma migration aplicada, nenhum lançamento alterado e nenhum histórico importado.**
