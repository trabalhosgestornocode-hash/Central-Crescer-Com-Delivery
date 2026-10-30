# 05 — Catálogo de indicadores operacionais

> Disponibilidade:
> - **PRONTO** — já calculado e exibido;
> - **DADO PRONTO** — o dado existe estruturado e só falta o cálculo;
> - **DADO BRUTO** — o dado existe só em JSON e precisa de extração;
> - **DEPENDÊNCIA** — exige outra API ou fonte;
> - **INDISPONÍVEL**.
>
> Regras de exclusão comuns a todos os indicadores (as mesmas do Checklist, `checklistOperacional.calc.js:33-37`):
> - `is_test = true` fora de tudo;
> - cancelados fora das médias de tempo;
> - TAKEOUT fora dos tempos de entrega;
> - agendados fora de preparo/vida;
> - durações ≤ 0 ou acima do teto (`TETO_MIN`) descartadas **e contadas**.
>
> Dia = dia civil em America/Sao_Paulo pelo **PLC** (`checklistOperacional.calc.js:28-32`).

## 1. Pedidos e vendas

| Indicador | Fórmula exata | Fonte / campos | Disponibilidade | Precisão e limitações | Ausentes | API extra? | Histórico |
|---|---|---|---|---|---|---|---|
| Total de pedidos | `count(*)` em `ifood_pedidos` com `is_test` não verdadeiro, pelo dia do PLC | `placed_event_created_at`, `is_test` | **PRONTO** (Checklist, contagem do dia/período) | Exato para o que o Events entregou desde a ativação | Pedido sem PLC (2): usar `order_created_at` só para **contar**, nunca para tempo | Não | Desde 10/10 (Saci), 18/10 (North), 21/10 (3ª unidade) |
| Pedidos por dia / hora / dia da semana | Agrupar o total por `date_trunc` no fuso | idem | **PRONTO** (dashboard do Checklist: `demandaPorHora`, `volumePorDiaDaSemana`, `evolucaoDiaria` em `checklistOperacional.indicadores.js:273-312`) | — | — | Não | idem |
| Pedidos concluídos / cancelados | `status_oficial` | `status_oficial` | **PRONTO** | O estado final pode mudar até 15 dias depois (cancelamento pós-conclusão; [DOC] Analytics) | — | Não | idem |
| Faturamento operacional (GMV pago pelo cliente) | `Σ total_order_amount` dos não cancelados | `total_order_amount` | **DADO PRONTO** | **Não é receita do restaurante**: inclui taxa de entrega e taxas do iFood e desconta benefícios, inclusive os pagos pelo iFood. Divergirá do Financial | Detalhes ausentes: 0 hoje | Não (operacional) / **Financial** para o repasse real | idem |
| Faturamento de itens | `Σ total_sub_total` dos não cancelados | `total_sub_total` | **DADO PRONTO** | Valor de tabela dos itens, antes dos descontos | — | Não | idem |
| Ticket médio operacional | `Σ total_order_amount / n` dos concluídos | idem | **DADO PRONTO** | Declarar a base: com ou sem taxa de entrega | — | Não | idem |
| Produtos mais vendidos / quantidade por produto | `Σ items[].quantity` agrupado por `items[].externalCode` (fallback: `name`) | `items` jsonb | **DADO BRUTO** | `externalCode` presente em 100% [BD]. Combos e complementos exigem regra (o item-pai ou o complemento conta como venda?) | — | Não | idem |
| Adicionais/complementos mais vendidos | `Σ options[].quantity` por `externalCode`/`name` | `items[].options` | **DADO BRUTO** | 84.433 opções: muitas são componentes de montagem com preço 0, então filtrar `price > 0` para "adicional pago" | — | Não | idem |
| Participação por categoria de produto | Σ por categoria ÷ total | `items` + mapeamento `externalCode → categoria` | **DEPENDÊNCIA (interna)** | `items[].type` = "DEFAULT" em 100%, sem categoria útil; exige o **cadastro de Produtos** da Crescer (ou a Catalog API) | — | Catalog API (opcional) | idem |
| Clientes novos | pedidos com `customer.ordersCountOnMerchant = 0` ÷ pedidos | `customer` jsonb | **DADO BRUTO** | Novo **na loja (merchant)** nos últimos 5 anos [DOC]. Na 1ª ocorrência: 1.095 de 4.545 = 24,1% [BD]. Campo "opcional" [DOC] | Ausente = "desconhecido", nunca "novo" | Não | idem |
| Clientes recorrentes | `ordersCountOnMerchant ≥ 1` ÷ pedidos; ou recompras do mesmo `customer.id` no período | `customer` | **DADO BRUTO** | Dois conceitos distintos que **não podem ser somados**: (a) histórico do iFood; (b) recompra observada por nós desde a ativação. Não usar `segmentation` (confidencial e divergente da doc) | — | Não | (b) cresce com o tempo |

## 2. Tempos operacionais

| Indicador | Fórmula | Campos | Disponibilidade | Precisão / limitações |
|---|---|---|---|---|
| Tempo até confirmação | `CFM.createdAt − PLC.createdAt` | colunas `confirmed_event_at`, `placed_event_created_at` | **DADO PRONTO** (o `calcularSla` existe, `ifoodOrder.service.js:253-282`) | Mediana 0,0 min: o PDV confirma sozinho. Útil só como **alarme** (> 8 min = SLA [DOC]) |
| Preparo (régua do Checklist) | `DSP − PLC` (DELIVERY, não agendado, não cancelado) | colunas | **PRONTO** | Inclui a espera do entregador em logística iFood (ver 02 §3). EXATO nos carimbos |
| Tempo até sinalizar pronto | `RTP − PLC` | colunas | **DADO PRONTO** | Só quando há RTP: 53% dos DELIVERY concluídos. Ausente = **não medir**, nunca inferir |
| Aderência ao preparo recomendado | `RTP − preparation_start_at` (ou `RTP − RPS.expectedPreparationEndTimestamp`) | `preparation_start_at` (100%) | **DADO PRONTO** (parcial) | O significado de `preparationStartDateTime` é "horário recomendado para início" [DOC]: comparar o **início**, não o fim. O início real (PRS) é marcação do PDV, não física |
| Pronto → coleta (aguardando entregador) | `CLT − RTP` | RTP (coluna) + CLT (bruto) | **DADO BRUTO** | Só logística iFood com RTP. Mediana RTP→DSP ≈ 8 min no iFood |
| Entregador aguardando na loja | `CLT − AAO` | bruto | **DADO BRUTO** | Mediana 1,6 min (iFood). Só quando há AAO |
| Atribuição de entregador | `ADR − PLC` ou `ADR − RTP` | bruto | **DADO BRUTO** | — |
| Coleta → conclusão (entrega) | `CON − DSP` | colunas | **PRONTO** (Checklist "entrega") | O CON **não prova entrega física** [DOC]; o texto do Checklist já usa "conclusão registrada" |
| Atraso contra a previsão do iFood | `CON − delivery.deliveryDateTime` (> 0 = atrasado) | coluna + JSON | **DADO BRUTO** | A previsão pode ser recalculada pelo iFood (CPT, disputas DELAY); usar a previsão do Details (a 1ª) e declarar isso |
| Tempo total | `CON − PLC` | colunas | **PRONTO** (Checklist "vida") | — |
| Pedidos acima do tempo esperado | `count(etapa > meta)` | colunas + `checklist_metas` | **PRONTO** (atrasos e evidências, `checklistOperacional.indicadores.js:314-330`) | Metas configuráveis (127); metas definitivas pendentes de decisão (memória do Checklist) |
| Comparação por período e unidade | Δ e Δ% entre períodos | idem | **PRONTO** por unidade (`comparar`, `:334-352`); **entre unidades: AUSENTE** | Consolidado multiunidade não existe no Checklist |

## 3. Cancelamentos

| Indicador | Fórmula | Campos | Disponibilidade | Limitações |
|---|---|---|---|---|
| Quantidade / taxa | `CANCELLED ÷ pedidos` (sem teste) | `status_oficial` | **PRONTO** (contagem) / **DADO PRONTO** (taxa) | 99 cancelados de 4.549 = 2,2% no período [BD] |
| Por motivo | agrupar CAN `metadata.CANCEL_CODE` + descrição | `ifood_eventos.payload` | **DADO BRUTO** | 26 códigos; as descrições vêm do iFood (não traduzir) |
| Por origem | `CANCEL_ORIGIN` | bruto | **DADO BRUTO** | RESTAURANT 42, CONSUMER_VIA_OPERATION 27, LOGISTICS_VIA_OPERATION 14, CONSUMER 13 |
| Por estágio | `CANCEL_STAGE` | bruto | **DADO BRUTO** | PREPARATION_TIME 58, DISPATCHED 33, CONCLUDED 6, PRE_CONFIRMED 1. "Antes da confirmação" = PRE_CONFIRMED; "durante o preparo" = PREPARATION_TIME; "após a coleta" = DISPATCHED/CONCLUDED |
| Por horário | hora do CAN `createdAt` | coluna `cancel_event_at` | **DADO PRONTO** | — |
| Valor associado | `Σ total_order_amount` dos cancelados | coluna | **DADO PRONTO** | É GMV perdido operacional; o impacto financeiro real (estorno, quem paga) só vem de `CANCELLATION_OCCURRENCE` (bruto) e do **Financial** |
| Responsável financeiro | `CANCELLATION_OCCURRENCE.{CONSUMER,LOGISTIC,RESTAURANT}.FINANCIAL_OCCURRENCE` | bruto | **DADO BRUTO** | Indício; o valor debitado está no Financial |

## 4. Logística

| Indicador | Fórmula | Disponibilidade | Limitações |
|---|---|---|---|
| Pronto → coleta | `CLT − RTP` | DADO BRUTO | Só iFood com RTP |
| Espera do entregador | `CLT − AAO` | DADO BRUTO | Só iFood |
| Atraso após a coleta | `CON − DSP` vs previsão | DADO BRUTO | Ver "atraso contra previsão" |
| Devoluções | count(DRGO/DRDO) | **INDISPONÍVEL por enquanto** (0 eventos) | O código reconhece; só falta o handler/indicador |
| Ocorrências logísticas | count(DDD), RDR `isDelayed`, DG* | DADO BRUTO | DGA está "deprecado" [DOC], mas chega |
| iFood × entrega própria | qualquer tempo agrupado por `delivery_by` | **DADO PRONTO** | Própria: PLC→CON p50 21,0 min; iFood: 31,7 min [BD]. Comparar com cautela (perfis de pedido diferentes) |
| Modo de entrega | agrupado por `delivery.mode` | DADO BRUTO | DEFAULT / HIGH_DENSITY / PRIORITY |

## 5. Promoções

| Indicador | Fórmula | Disponibilidade | Limitações / cuidados |
|---|---|---|---|
| Pedidos com desconto | `total_benefits > 0` | **DADO PRONTO** | 3.907 de 4.544 reais (86%) |
| Valor concedido pela loja | `Σ sponsorshipValues[name=MERCHANT].value` | **DADO PRONTO** (resumo `discount_sponsors`) | R$ 29.312,56 no período [BD] |
| Valor financiado pelo iFood | `Σ …[name=IFOOD].value` | DADO PRONTO | R$ 26.808,43 |
| Rede / externo | `CHAIN` / `EXTERNAL` | DADO PRONTO | R$ 452,22 / R$ 15,00 |
| Participação de pedidos promocionais | pedidos com benefício ÷ total | DADO PRONTO | — |
| Receita associada às promoções | `Σ total_order_amount` dos pedidos com benefício | DADO PRONTO | **Associação, não causalidade**: não dizer "a promoção gerou R$ X" |
| Por campanha | agrupado por `benefits[].campaign.id/name` | DADO BRUTO | — |
| Por alvo | `target` ITEM / DELIVERY_FEE / CART | DADO BRUTO | — |

**Regras contra dupla contagem:**

1. Somar `sponsorshipValues` **por benefício**, nunca `benefits[].value` + `sponsorshipValues` (o primeiro já é a soma do segundo: 100% conferido [BD]).
2. Cada benefício traz as 4 patrocinadoras, quase sempre com valor 0: **não contar entradas, somar valores**.
3. Um pedido pode ter vários benefícios (10.757 em 3.907 pedidos): "pedidos com promoção" é `count(distinct pedido)`.
4. IFOOD/EXTERNAL/CHAIN são tratados como **pagamento** e MERCHANT como **desconto** [DOC]. O custo da loja é só MERCHANT (e CHAIN, se a loja for cobrada pela rede).
5. Este é o valor **operacional**. O valor efetivamente repassado ou cobrado é do **Financial**, e os dois não devem ser apresentados como o mesmo número.

## 6. Disputas

| Indicador | Fórmula | Disponibilidade |
|---|---|---|
| Disputas abertas por tipo | `ifood_disputas.handshake_type` | DADO PRONTO (104 com tipo; 66 sem) |
| Desfecho | `settlement_status` | DADO PRONTO (EXPIRED 56, ALTERNATIVE_REPLIED 40, REJECTED 38, ACCEPTED 36) |
| Disputas expiradas sem resposta | `settlement_status = EXPIRED` | DADO PRONTO: 56/170 = **33%**. [DOC] "Sem resposta = reembolso automático"; nos casos observados, porém, `timeoutAction = REJECT_CANCELLATION`. Não afirmar reembolso sem o Financial |

## 7. Indicadores que dependem de fontes externas

| Indicador | Fonte necessária |
|---|---|
| Avaliações, nota, comentários, NPS | **Review API** (não integrada) |
| Repasse, taxas e comissões efetivas, estornos cobrados | **Financial** (integração existe; homologação em andamento, memória `ifood-homologacao-financial-merchant`) |
| Visualizações, conversão de cardápio, funil, ranking na plataforma | **Não há API pública identificada** para funil/visitas. A Analytics API oferece KPIs agregados de pedidos (D-1), não funil (**NÃO VERIFICADO** em profundidade) |
| Critérios do Super Restaurante | Sem API identificada (**NÃO VERIFICADO**) |
| Chamados de suporte | Sem API identificada; as disputas (Handshake) cobrem só parte |
| Histórico anterior à ativação do Events | Analytics (D-1, agregado) ou Parser Food Delivery (CSV já existente) |
