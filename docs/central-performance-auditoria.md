# Central de Performance — auditoria e decisão antes da migration

> Relatório histórico da etapa anterior. A autorização posterior e o esclarecimento de que Centro/Avenida não usam Parser Food Delivery estão incorporados em `central-performance-fechamento-entrega.md`. Custo externo é opcional e sua ausência não reduz completude; a proposta anterior não substitui essa regra atual.

Consulta em 09/09/2026, 03:46 UTC, usando o banco configurado em backend/.env, exclusivamente por SELECT e leitura do catálogo OpenAPI. Nenhum registro alterado. Evidência estruturada: `performance-auditoria-dados.json`. Foram inspecionadas as colunas das 88 tabelas expostas no catálogo; nenhuma coluna de conversão comercial/visitas foi encontrada. A busca no backend também não encontrou regra ou integração que produza esse indicador.

**Decisão: a etapa de fechamento precisa de persistência complementar. Nenhuma migration foi criada. Implementação da tela, endpoint e escrita aguarda autorização, conforme a seção 16 do segundo pedido.** Foi preparada apenas a base local de cálculos e a auditoria reproduzível, sem montagem na aplicação.

## 1. Arquitetura atual

- SPA em JavaScript nativo, backend Node/Express e Supabase/PostgreSQL.
- Shell administrativo: `frontend/src/painelAdm.js`. Menu gerado de `TELAS_PADM` em `painelAdmViews.js`. Views registradas nessa lista e despachadas por `renderViewPadm`. Navegação interna por pilha, não por URLs próprias do navegador.
- Cliente: `painelAdmApi.js`, Bearer da sessão e envelope `{data}`, sem Context Token.
- API: `backend/src/routes.js` monta `/administrativo`; `administrativo.routes.js` aplica os gates a todas as rotas.
- Proteção: autenticação em `app.js`, senha definitiva, `requirePainelAdministrativo`, MFA quando habilitado e limite de taxa. SuperAdmin ou flag administrativo ativo concede acesso ao painel. Não foi alterado middleware algum.
- O painel existente tem autorização global entre organizações. Não existe escopo individual de empresas para usuários administrativos. Não se deve substituir isso silenciosamente pelo contexto operacional do tenant.
- Universo elegível: `administrativo.repo.js#listarUnidadesElegiveis`: organização ativa e não modelo, unidade ativa e não teste, módulo iFood efetivo na organização e na unidade.
- No ambiente operacional, `sessao.service.js` resolve vínculos ativos em `usuarios_organizacoes` e `usuarios_unidades`, inclusive herança organizacional; perfis operacionais e Context Token restringem a unidade. Esse é um ambiente distinto do administrativo.
- Chart.js 4.4.1 já carregado em `frontend/index.html`. Não há necessidade de dependência nova.

## 2. Identificação real

| Referência | Nome cadastrado | unidade_id | organizacao_id |
|---|---|---|---|
| Centro | Matriz  Subway Centro Montes Claros | 1ef5aace-345b-4417-9559-e7c27a230a48 | 074f6ba1-cd42-4970-a983-4647aedd1e91 |
| Avenida | Matriz Subway Avenida Montes Claros | aa1da7d9-794c-43ec-bd7c-8c5e2cf80b6e | 0c7b9f50-8ebc-41d6-afad-d35f207b8e52 |

Ambas ativas, não teste e elegíveis no painel. Os nomes fornecidos no pedido não são os nomes exatos cadastrados. A busca por nome serviu apenas para descoberta nesta auditoria. A implementação deverá configurar os UUIDs no backend (`PERFORMANCE_UNIDADE_IDS`), intersectar com o universo elegível e filtrar cada consulta por organização e unidade. Nenhum nome ou ID de unidade será chave fixa no frontend.

## 3. Fonte real por indicador

Abreviações nesta seção: LFD = `lancamentos_financeiros_diarios`; DEC = `backend/src/modules/dashboard-executivo/dashboardExecutivo.calc.js`; DES = `dashboardExecutivo.service.js` no mesmo diretório. Todas as fontes operacionais citadas têm `unidade_id` e `organizacao_id` no catálogo real.

| Indicador | Tabela / coluna | Service e regra oficial | Granularidade e reconstrução |
|---|---|---|---|
| Faturamento iFood | LFD.`valor_vendas_ifood` | DES `obterHistorico`; DEC `snapshotFinanceiroMaisRecente` | Linha datada, acumulado mensal. Último snapshot operacional real do mês; sem diário real, soma apenas fatias de `origem_lancamento=distribuicao_mensal`. Nunca somar snapshots diários. Recuperável em julho/agosto. |
| Despesas iFood | LFD.`taxas_comissoes`, `servicos_promocoes`, `taxas_entregadores`, `ajustes_contra_loja` | DEC `totalDeducoes` sobre o mesmo snapshot financeiro | Mensal acumulado; inclui componentes conhecidos. Todos ausentes => null. Ajustes a favor não são despesa. Recuperável em julho/agosto. |
| Pedidos iFood | LFD.`qtd_vendas`, pareado com `valor_vendas_bruto` | DEC `desempenhoParaTicketMedio`, usado por DES `obterHistorico` | Último par real acumulado; fallback para soma de fatias mensais. A regra atual exige ambos os campos. Recuperável em agosto. Pedidos Food Delivery/Visio não substituem pedidos iFood. |
| Ticket médio atual do Dashboard | LFD.`valor_vendas_bruto` / `qtd_vendas` | DEC `ticketMedio` + `desempenhoParaTicketMedio` | Calculado, sem média de tickets diários. Agosto disponível. |
| Ticket médio solicitado para a Central | Faturamento oficial / pedidos oficiais | Novo cálculo puro `performance.calc.js#derivar` | Regra explícita do segundo pedido. Diferente do Dashboard, que permanece intacto. Sem persistência. |
| Novos clientes | LFD.`novos_clientes` | DEC `novosClientesAcumulados` / `listaDesempenhoDiario` | Último acumulado real conhecido do mês; a regra oficial exclui fatias mensais estimadas. Agosto disponível. |
| Conversão em vendas | Nenhuma coluna/fonte comercial encontrada | Nenhum service existente produz conversão ou denominador de visitas | Não reconstruível no sistema atual. Não inferir de novos clientes/pedidos. |
| Taxas de entregadores no Financeiro iFood | LFD.`taxas_entregadores` | Mesmo snapshot financeiro da despesa; DEC `snapshotFinanceiroMaisRecente` | Acumulado mensal; recuperável julho/agosto. Já incluído em despesas iFood. Não descontar novamente. |
| Despesa de entregadores Food Delivery | `parser_fd_pedidos.taxa_entregador`, `status_conciliacao`; `parser_fd_importacoes.taxas_validas` | `parserFoodDelivery.calc.js#resumoConciliacao`; `parserFoodDelivery.service.js#resumoCancelamentosPeriodo` | Por pedido/importação conciliada. Soma oficial de importações concluídas inteiramente contidas no mês. **Nenhuma importação** nas duas unidades. Não equivale automaticamente à taxa iFood. |

O catálogo confirmou também `lancamentos_financeiros_distribuicao_mensal`: registros de julho nas duas unidades, com `valor_total_centavos`. A fonte de leitura oficial continua sendo as fatias em LFD; não somar cabeçalho mensal e fatias. Não há totais de pedidos/clientes escondidos no cabeçalho dessa tabela no banco consultado.

Integração iFood existente administra conexão/OAuth/merchant, sem fonte persistida de conversão comercial. Bonificação mensal/Visio atende outras bases e canais; seus totais não podem ser apresentados como faturamento ou pedidos iFood.

## 4. Matriz do histórico real

Legenda: disponível = valor recuperável na fonte oficial; parcial = snapshot existente, sem fechamento financeiro no último dia; ausente = nenhum valor recuperável. Entregadores nesta matriz significa **taxas registradas no Financeiro iFood**. Food Delivery está ausente em todos os meses, para ambas as unidades.

| Unidade | Competência | Faturamento | Despesas iFood | Pedidos | Novos clientes | Conversão | Taxas entregadores iFood | Disponibilidade |
|---|---|---|---|---|---|---|---|---|
| Centro | 2026-04 | Ausente | Ausente | Ausente | Ausente | Ausente | Ausente | 0/6 |
| Centro | 2026-05 | Ausente | Ausente | Ausente | Ausente | Ausente | Ausente | 0/6 |
| Centro | 2026-06 | Ausente | Ausente | Ausente | Ausente | Ausente | Ausente | 0/6 |
| Centro | 2026-07 | Disponível | Disponível | Ausente | Ausente | Ausente | Disponível | 3/6 (50%) |
| Centro | 2026-08 | Parcial | Parcial | Disponível | Disponível | Ausente | Parcial | 5/6 (83,33%) |
| Avenida | 2026-04 | Ausente | Ausente | Ausente | Ausente | Ausente | Ausente | 0/6 |
| Avenida | 2026-05 | Ausente | Ausente | Ausente | Ausente | Ausente | Ausente | 0/6 |
| Avenida | 2026-06 | Ausente | Ausente | Ausente | Ausente | Ausente | Ausente | 0/6 |
| Avenida | 2026-07 | Disponível | Disponível | Ausente | Ausente | Ausente | Disponível | 3/6 (50%) |
| Avenida | 2026-08 | Parcial | Parcial | Disponível | Disponível | Ausente | Parcial | 5/6 (83,33%) |

Cada unidade tem 62 linhas entre abril e agosto, concentradas em julho/agosto. Não foram preenchidos valores da planilha ou dos exemplos.

| Unidade/mês | Faturamento | Despesas iFood | Taxas entregadores iFood | Pedidos | Clientes novos | Financeiro até |
|---|---:|---:|---:|---:|---:|---|
| Centro/julho | R$ 74.317,28 | R$ 30.779,88 | R$ 10.971,50 | — | — | 31/07 |
| Centro/agosto | R$ 49.411,54 | R$ 19.291,38 | R$ 7.340,97 | 968 | 290 | 29/08 |
| Avenida/julho | R$ 69.563,40 | R$ 29.888,61 | R$ 12.950,41 | — | — | 31/07 |
| Avenida/agosto | R$ 67.548,04 | R$ 30.009,76 | R$ 11.150,19 | 1.356 | 407 | 29/08 |

Todos esses meses estão **incompletos para Performance**, inclusive julho: ter os dias financeiros finalizados não significa ter todos os indicadores. Percentual de disponibilidade não é cobertura temporal nem prova de fechamento. Agosto tem 5 de 6 campos recuperáveis, mas o financeiro é parcial. Se o indicador escolhido for o custo externo Food Delivery, sua ausência reduz esses percentuais a 2/6 e 4/6, respectivamente; é necessário manter explícito qual custo o card representa.

## 5. Cálculos e diferenças semânticas

- Após despesas iFood = faturamento − deduções.
- Retenção após iFood = após despesas / faturamento × 100. Não é lucro real: não contempla CMV, folha, aluguel e demais custos.
- Ticket da Central = faturamento iFood / pedidos, conforme o pedido mais recente. Em agosto: Centro R$ 51,04; Avenida R$ 49,81. O Dashboard continua com bruto de Desempenho / pedidos.
- Custo iFood % = deduções / faturamento × 100.
- Custo entregadores % = despesa da fonte identificada / faturamento × 100.
- Custo por pedido = mesma despesa / pedidos.
- Variação = (atual − anterior) / anterior × 100, sem saltar mês ausente.
- O cálculo oficial `receitaLiquida` do Dashboard acrescenta `ajustes_favor_loja`. A métrica pedida aqui não acrescenta esses créditos, por isso os valores podem diferir.
- Consolidados dividem totais; não fazem média simples de tickets ou percentuais. Um mês/unidade ausente não desaparece do total.
- Zero preservado; denominador zero/negativo, null e não finitos produzem null. Nenhum NaN/Infinity.
- Lista de seis indicadores obrigatórios centralizada em `performance.config.js`. Fechado deverá ser estado persistido com autor e data, nunca inferido pela passagem do calendário.
- Regras puras iniciais: queda de receita acompanhada de pedidos ≤ −5% e ticket estável/crescente; receita entre −3% e +3% com aumento de custo relativo; três pontos consecutivos de queda de novos clientes; conversão abaixo de referência configurável (20% padrão). Competências incompletas suspendem conclusões de tendência. Sem conversão real, esse alerta não dispara.

## 6. O que falta e proposta mínima — NÃO criada

Lacunas comprovadas: abril a junho sem os seis indicadores; julho sem pedidos, novos clientes e conversão; agosto sem conversão e com financeiro ainda parcial. Taxas externas Food Delivery ausentes em todo o intervalo.

Primeira preferência para campos que já têm fonte: complementar/importar pelo módulo oficial existente quando houver documento válido. Não criar um segundo faturamento de julho/agosto. Snapshot parcial existente também bloqueia substituição manual: corrigir/completar na origem, preservando auditoria.

Para permitir **o fluxo específico solicitado** de guardar somente campos historicamente ausentes na Central, proposta de uma tabela `performance_mensal_complemento`, uma linha por unidade/competência:

| Coluna proposta | Tipo/regra |
|---|---|
| id | uuid PK |
| organizacao_id, unidade_id | uuid NOT NULL; vínculo composto validando que a unidade pertence à organização |
| competencia | date, sempre primeiro dia do mês; UNIQUE(unidade_id, competencia) |
| faturamento_ifood_manual | numeric(14,2), nullable, ≥ 0; somente se fonte oficial não fornecer valor |
| despesas_ifood_manual | numeric(14,2), nullable, ≥ 0; mesma condição |
| pedidos_manual | integer, nullable, ≥ 0; mesma condição |
| novos_clientes_manual | integer, nullable, ≥ 0; mesma condição |
| conversao_manual | numeric(7,4), nullable, entre 0 e 100; fonte ausente em todos os meses |
| despesa_entregadores_manual | numeric(14,2), nullable, ≥ 0; origem de custo explícita e sem somar taxa iFood com Food Delivery |
| origem_entregadores | enum/check: ifood ou food_delivery, para impedir misturar conceitos |
| status | rascunho/fechado, com checks de consistência |
| fechado_em, fechado_por | timestamptz / uuid da identidade autenticada |
| created_at, updated_at, atualizado_por | timestamps e uuid para rastreabilidade |
| versao | integer para impedir sobrescrita concorrente |

Não armazenar ticket, margem, custos percentuais, variações, cópia de dados automáticos ou JSON genérico de métricas. Essas seis colunas complementares são justificadas pelas competências realmente ausentes; não são um novo BI. Se os campos históricos forem recuperados nos módulos oficiais antes da implementação, remover da proposta os complementos que deixarem de ser necessários.

Leitura: automático primeiro, complemento apenas quando automático for null, depois cálculo. Escrita: reconsultar fonte oficial, rejeitar campo automático/calculado, validar autorização e organização/unidade. Zero automático bloqueia edição tanto quanto qualquer outro valor. Caso a fonte apareça depois, prevalece automaticamente e o complemento não pode ser contado. Fechamento requer todos os indicadores e cobertura suficiente; mudanças posteriores na fonte exigem sinalização de revisão do fechamento. Política RLS sem acesso direto do cliente, com verificações explícitas no backend service_role, seguindo o painel atual.

Essa estrutura é necessária porque nenhuma tabela atual representa complementos e fechamento de Performance; conversão não possui coluna existente. Reutilizar a tabela de bonificação misturaria módulos e regras. **Aguardar autorização antes de escrever SQL. Não aplicar em produção.**

## 7. Arquivos e próximos passos após autorização

Criados nesta execução:

- `backend/scripts/auditar-performance.mjs`: leitura das duas unidades, catálogo real e reconstrução mensal, sem escrita no banco.
- `backend/src/modules/administrativo/performance/performance.config.js`: indicadores obrigatórios e limites centralizados; configuração por IDs.
- `backend/src/modules/administrativo/performance/performance.calc.js`: cálculos puros reutilizando funções oficiais; não montado em rota.
- `backend/test/performance-calc.test.js`: sete testes de regressão de cálculo.
- `docs/performance-auditoria-dados.json`: evidência da consulta.
- Este relatório e logs de testes relacionados.

Nenhum arquivo preexistente foi alterado. `scratchpad/` já estava não rastreado antes da tarefa e foi preservado.

Após aprovação: criar repository/service/controller/routes de Performance; montar em `administrativo.routes.js` após os gates; adicionar método em `painelAdmApi.js`; registrar view em `painelAdmViews.js`; criar view de Performance/Fechamento e CSS próprio ou extensão do padrão administrativo. Endpoints propostos: GET `/api/v1/administrativo/performance` e GET/PATCH de complemento por UUID e competência, mais ação de fechamento. **Nenhum endpoint criado nesta etapa.**

Tela planejada: período mensal reutilizado do cabeçalho, seleção de unidade por dados do backend, matriz mensal com origem Automático/Manual/Calculado/Sem dados, completude e pendências; campos automáticos/calculados sem edição; gráfico Chart.js e comparação na tela principal. Não há print de tela implementada, pois a execução parou antes da migration conforme instrução.

## 8. Validação e Git

- Backend: 216 testes, 216 passaram, zero falhas, nenhum ignorado. Inclui `administrativo-*.test.js`, `painel-administrativo-acesso.test.js` e os sete novos testes. Banco fake nos testes administrativos, `.env.test-http` como configuração de execução.
- Frontend: 243 testes `painelAdm*.test.js`, todos passaram, zero falhas, nenhum ignorado.
- Novos testes: variações, null/zero/divisão inválida, custos e retenção, mês ausente, prioridade de snapshots reais, fallback mensal, comparação/consolidado de duas unidades, diagnósticos com período incompleto.
- Segurança: suíte administrativa existente cobre gates e acessos; não há novo endpoint para alegar teste HTTP específico de Performance. Isso deverá ser acrescentado junto à implementação.
- Logs: `performance-testes-backend.log`, `performance-testes-frontend.log`.
- Git: apenas arquivos novos locais; sem commit, push, merge ou deploy. Nenhuma migration criada/aplicada. Nenhum dado de produção alterado.

Limite da evidência: retrato do banco configurado no momento da consulta, não arquivos externos nem outros ambientes. Ausência de dados não significa zero. Valores monetários no JSON preservam a precisão do motor existente; apresentação arredonda para centavos.
