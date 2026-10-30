# 03 — Dicionário de dados dos pedidos (Order Details + eventos)

> Fontes: [DOC] Order › Detalhes de pedido (29/10/2026); parser `ifoodOrder.parser.js:69-149`; colunas das migrations 101/102/103; [BD] frequência de **chaves** em `ifood_pedidos.details_payload` (4.543 pedidos com detalhes no momento da consulta; 4.549 na consulta de preenchimento, porque os pedidos continuavam chegando) e taxa de preenchimento das colunas. Nenhum valor pessoal foi lido para este documento: só nomes de chaves, contagens e categorias.

## Regra de leitura

**Nada que o iFood envia em Order Details é descartado.** O payload inteiro fica em `ifood_pedidos.details_payload` (jsonb) com hash (`ifoodOrder.service.js:89-96`). O parser só **extrai** um subconjunto para colunas. Por isso a coluna "Persistido" distingue:

- **COL** — coluna própria, consultável e indexável;
- **JSON-col** — subobjeto copiado para uma coluna jsonb própria (`customer`, `delivery`, `items`, `benefits`, `payments`, `additional_fees`…);
- **BRUTO** — só dentro de `details_payload` ou de `ifood_eventos.payload`.

Para campos não presentes, a coluna "Recebido" usa:

- **NÃO RETORNADO** — a chave não aparece em nenhum payload do cenário atual;
- **PARCIAL n/N** — aparece em parte dos pedidos;
- **NÃO VERIFICADO** — sem acesso para confirmar.

"Utilizado" = lido por alguma funcionalidade em produção.

## 1. Identificação

| Campo | Doc | Recebido [BD] | Persistido | Utilizado | Potencial | Evidência |
|---|---|---|---|---|---|---|
| `id` (orderId) | ✓ | 4.543/4.543 | COL `order_id` (UNIQUE) | Interno | Chave de cruzamento com Financial (conciliação por pedido) | parser `:72`; mig. 101 |
| `displayId` | ✓ | 4.543 | COL `display_id` | Checklist e tela de pedidos | Comunicação humana do pedido (alertas) | parser `:105` |
| `merchant.id` | ✓ | 4.543 | Validado contra o tenant; não gravado (`merchant_id` vem do evento) | Proteção multi-tenant | — | parser `:76-79`; service `:89` |
| `merchant.name` / `merchant.business.name` | ✓ | 4.543 | BRUTO | `merchant.name` → rótulo da loja no Checklist | — | `checklistOperacional.repository.js:73` |
| `orderType` | ✓ | 4.543 (DELIVERY 4.507 / TAKEOUT 36) | COL `order_type` | Checklist (filtro) | Comparação por modalidade | parser `:82` |
| `category` | ✓ | 4.543 (FOOD 100%) | COL `category` | — | — | parser `:108` |
| `salesChannel` | ✓ | 4.543 (IFOOD 100%) | COL `sales_channel` | Tela de pedidos | Multicanal futuro | parser `:109` |
| `isTest` | ✓ | 4.543 (1 teste) | COL `is_test` | Checklist (exclusão) | Regra de exclusão em todo indicador | parser `:110` |
| `orderTiming` | ✓ | 4.543 (IMMEDIATE 100%) | COL `order_timing` | Checklist (exclusão de agendados) | — | parser `:107` |
| `extraInfo` | ✓ | NÃO RETORNADO | COL `extra_info` (vazia) | — | — | [BD] 0/4.549 |
| `additionalInfo.metadata` | ✓ (POS) | NÃO RETORNADO | JSON-col `additional_info` (vazia) | — | — | [BD] 0 |
| `picking.picker` | ✓ (mercado) | 4.543 | BRUTO | — | Nenhum (FOOD) | [BD] |

## 2. Datas e horários

| Momento | Fonte | Doc | Recebido [BD] | Persistido | Utilizado | Observação |
|---|---|---|---|---|---|---|
| Criação do pedido | Details `createdAt` | ✓ | 4.549/4.549 | COL `order_created_at` | SLA de confirmação (`calcularSla`) | Difere do PLC em segundos a minutos; o Checklist **não** o usa como chegada (`checklistOperacional.calc.js:17-19`) |
| Chegada oficial | Evento PLC `createdAt` | ✓ | 4.547 | COL `placed_event_created_at` (+ `placed_event_received_at`) | Checklist (chegada) | 2 pedidos sem PLC |
| Confirmação | Evento CFM | ✓ | 4.547 | COL `confirmed_event_at` (+ `_received_at`) | Checklist (exibição) | — |
| Agendamento | Details `schedule.deliveryDateTimeStart/End` | ✓ | NÃO RETORNADO (0 agendados) | COL `scheduled_start_at/end_at` (vazias) | Exclusão no Checklist | — |
| Início **recomendado** do preparo | Details `preparationStartDateTime` | ✓ | 4.549 | COL `preparation_start_at` | **Não** | Base para aderência ao preparo |
| Início recomendado (Preparo Inteligente) | Evento RPS (`expectedPreparationStart/EndTimestamp`) | ✓ | NÃO RETORNADO (0 eventos) | — | — | Só lojas com Preparo Inteligente |
| Início **registrado** do preparo | Evento PRS `createdAt` | ✓ | 3.249 eventos | BRUTO | **Não** | Marcado pelo PDV (`appName` em 100%); PLC→PRS mediana 0,4 min: marcação automática, **não** o início físico |
| Tempo de preparo alterado | Evento CPT (`changePreparationTimeInSeconds`) | fora da ref. rápida | 545 | BRUTO | Não | Origem iFood, "Changed by AI model" |
| Pedido pronto | Evento RTP | ✓ | 2.419 pedidos | COL `ready_event_at` | Checklist (exibição) | Ausente em ~47% dos DELIVERY concluídos |
| Despacho | Evento DSP | ✓ | 4.446 | COL `dispatch_event_at` | Checklist (fim do preparo) | Em logística iFood ≈ coleta (ver 02 §3) |
| Atribuição de entregador | Evento ADR | ✓ | 3.963 | BRUTO | Não | — |
| Chegada do entregador à loja | Evento AAO | ✓ | 2.041 | BRUTO | Não | Só logística iFood (e 181 casos de entrega própria com sob demanda) |
| Coleta | Evento CLT | ✓ | 1.995 | BRUTO | Não | Idem |
| Chegada ao destino | Evento AAD | ✓ | 2.236 | BRUTO | Não | — |
| Previsão de entrega | Details `delivery.deliveryDateTime` | ✓ | 4.509 | JSON-col `delivery` / BRUTO | **Não** | Permite medir "atraso contra a previsão do iFood" |
| Retirada prevista | Details `takeout.takeoutDateTime` | ✓ | 36 | JSON-col `takeout` | Não | — |
| Conclusão | Evento CON | ✓ | 4.443 eventos | COL `status_oficial_em`, enquanto o estado for CONCLUDED | Checklist (fim da entrega/vida) | **Sem coluna própria**: nos 6 pedidos cancelados **após** o CON [BD], `status_oficial_em` passou a ser o horário do CAN e o horário do CON fica só no bruto |
| Cancelamento | Evento CAN | ✓ | 99 | COL `cancel_event_at` | Checklist (contagem) | — |
| Primeiro/último evento | Qualquer evento | — | — | COL `primeiro_evento_em`/`ultimo_evento_em` | Janela de reprocessamento | — |

## 3. Cliente (dados pessoais — LGPD)

| Campo | Doc | Recebido [BD] | Persistido | Utilizado | Potencial | Evidência / risco |
|---|---|---|---|---|---|---|
| `customer.id` | ✓ | 4.543 | JSON-col `customer` + BRUTO | Não | **Recorrência por cliente sem nome** (identificador pseudônimo) | — |
| `customer.name` | ✓ | 4.543 | JSON-col + BRUTO | Não | Nenhum para analytics | PII |
| `customer.phone` (`number`, `localizer`, `localizerExpiration`) | ✓ | 4.543 | JSON-col + BRUTO | Não | Nenhum para analytics | PII. [DOC] "deixa de ser enviado 3 horas após a data de entrega"; nós guardamos **sem prazo** |
| `customer.documentNumber`/`documentType` | ✓ (opcional, para NF) | 159 | COL `customer_document_number/type` + BRUTO | Não | Nenhum | PII (CPF) em coluna própria |
| `customer.ordersCountOnMerchant` | ✓ | 4.543 (0: 1.095 · 1: 547 · 2–5: 1.030 · 6+: 1.873) | JSON-col + BRUTO | **Não** | **Clientes novos × recorrentes** (0 = primeiro pedido na loja) | "Últimos 5 anos, opcional" [DOC] |
| `customer.segmentation` | ✓ (Explorer, Bronze… [DOC]) | 4.543 (observado: "Cliente" 3.813, "Cliente Frequente" 732) | JSON-col + BRUTO | Não | Perfil de base | **Divergência**: os valores observados diferem da documentação. [DOC] "Dados de segmentação são confidenciais. Não divulgue a terceiros" |
| `customer.billingAddress` | ✓ | 36 | JSON-col + BRUTO | Não | Nenhum | PII |

## 4. Produtos

| Campo | Doc | Recebido [BD] | Persistido | Utilizado | Potencial |
|---|---|---|---|---|---|
| `items[]` (lista) | ✓ | 4.543 pedidos, 5.096 itens | JSON-col `items` + COL `items_count` | Não | **Mix e ranking de produtos** |
| `items[].id`, `uniqueId`, `index`, `name`, `type` | ✓ | 5.096/5.096 | JSON | Não | Ranking por nome/código |
| `items[].externalCode` | ✓ | 5.096 preenchidos (100%) | JSON | Não | **Ligação com Produtos/CMV pelo código do PDV**: margem por pedido |
| `items[].quantity`, `unit`, `unitPrice`, `price`, `optionsPrice`, `customizationPrice`, `totalPrice` | ✓ | 5.096 | JSON | Não | Quantidades e receita por produto |
| `items[].observations` | ✓ | 158 preenchidas | JSON | Não | Frequência de pedidos com observação (sem expor o texto) |
| `items[].imageUrl` | ✓ | 5.096 | JSON | Não | — |
| `items[].ean`, `scalePrices` | ✓ | NÃO RETORNADO | — | — | — |
| `items[].options[]` (complementos) | ✓ | 84.433 opções: `id, name, groupName, groupExternalCode, externalCode, quantity, unit, unitPrice, price, addition, index, type, customizations` | JSON | Não | **Adicionais mais vendidos; receita de adicionais** |
| `options[].customizations` (3º nível) | ✓ | chave presente em 84.433 opções | JSON | Não | Idem |

Não existe tabela normalizada de itens. Ranking e mix exigem `jsonb_array_elements` em `items`. Funciona no volume atual, mas não escala sem tabela derivada.

## 5. Valores e pagamentos

| Campo | Doc | Recebido [BD] | Persistido | Utilizado | Potencial | Evidência |
|---|---|---|---|---|---|---|
| `total.subTotal` | ✓ | 4.543 | COL `total_sub_total` | Não | GMV de itens | — |
| `total.deliveryFee` | ✓ | 4.543 | COL `total_delivery_fee` | Não | — | — |
| `total.additionalFees` | ✓ | 4.543 | COL `total_additional_fees` | Não | — | — |
| `total.benefits` | ✓ | 4.543 | COL `total_benefits` | Não | Descontos totais | — |
| `total.orderAmount` | ✓ | 4.543 | COL `total_order_amount` | Tela de pedidos | Ticket médio (valor pago pelo cliente) | [BD] fórmula oficial `subTotal + deliveryFee + additionalFees − benefits = orderAmount` confere em **4.544/4.544** pedidos reais (0 divergências) |
| `benefits[].value`, `target` (ITEM 7.165, DELIVERY_FEE 2.971, CART 621), `targetId` | ✓ | 3.907 pedidos com benefício | JSON-col `benefits` | Não | Promoções por alvo | Σ `benefits[].value` = `total.benefits` em 100% |
| `benefits[].sponsorshipValues[]` (`name`, `value`, `description`) | ✓ | 43.028 entradas (as 4 patrocinadoras em cada benefício, com valor possivelmente 0) | JSON-col + resumo COL `discount_sponsors` (4.443 pedidos) | Não | **Quem financia o desconto** | Σ patrocínios = `value` em 100% dos benefícios |
| `benefits[].campaign` (`id`, `name`, `description`) | ✓ | 10.757 | JSON | Não | **Desempenho por campanha** | — |
| `additionalFees[]` (`type`, `description`, `fullDescription`, `value`, `liabilities`) | ✓ | 4.562 taxas; tipos observados: `RESTAURANT_SERVICE_FEE_…` 4.254, `TESTE_SF_…` 232, `PAYMENT_CONVENIENCE_FEE` 78 | JSON-col `additional_fees` | Não | Taxas por responsável | [DOC] são receita do iFood, não do restaurante |
| `payments.prepaid` / `pending` | ✓ | 4.543 | COL `payment_prepaid/pending` | Não | Online × na entrega | — |
| `payments.methods[]` `method` (PIX 2.078, CREDIT 876, OTHER 603, DIGITAL_WALLET 554, DEBIT 253, CASH 145, MEAL_VOUCHER 102), `type` (ONLINE 4.311 / OFFLINE 300) | ✓ | 4.609 métodos | COL `payment_methods[]`, `has_offline_payment` + JSON | Não | Mix de pagamento | — |
| `methods[].card.brand` | ✓ | 4.464 | COL `card_brands[]` | Não | — | — |
| `methods[].cash.changeFor` | ✓ | 145 | COL `cash_change_for` | Não | — | — |
| `methods[].wallet` | ✓ | 554 | JSON | Não | — | — |
| `methods[].transaction` (`authorizationCode`, `acquirerDocument`) | ✓ | 4.309 | JSON | Não | Conciliação fina | Dado financeiro sensível |

## 6. Logística

| Campo | Doc | Recebido [BD] | Persistido | Utilizado | Potencial |
|---|---|---|---|---|---|
| `delivery.deliveredBy` | ✓ | IFOOD 1.842 · MERCHANT 2.667 · ausente 36 (retirada) | COL `delivery_by` | Tela de pedidos | **Comparação logística iFood × própria** |
| `delivery.mode` | ✓ | DEFAULT 3.842 · HIGH_DENSITY 617 · PRIORITY 50 | JSON | Não | Impacto do modo no tempo |
| `delivery.description` | ✓ | 4.507 | JSON | Não | — |
| `delivery.deliveryDateTime` | ✓ | 4.509 | JSON | Não | **Atraso contra a previsão** |
| `delivery.pickupCode` | ✓ | 4.513 | COL `pickup_code` | Não | — (código de segurança: não deveria virar coluna sem necessidade) |
| `delivery.observations` | ✓ | NÃO RETORNADO | COL `delivery_observations` (vazia) | — | — |
| `delivery.deliveryAddress` (rua, número, bairro, cidade, CEP, coordenadas…) | ✓ | 4.507 | JSON-col `delivery` + BRUTO | Não | **Região (bairro/cidade) agregada**; PII no nível de endereço |
| `takeout.mode`, `takeoutDateTime`, `location` | ✓ | 36 | JSON-col `takeout` | Não | — |
| Eventos ADR/GTO/AAO/CLT/AAD/DDD/DDCR/DDCS/DPCR/DG*/RDR/RDS | ✓ | ver 02 | BRUTO | Não | Linha do tempo logística, espera do entregador, agrupamento |
| `workerName`, `workerPhone`, `workerPhotoUrl` (ADR) | ✓ | 2.100 / 1.865 | BRUTO | Não | Nenhum para analytics | PII de terceiros |
| Devoluções (DRGO/DRDO/DRCR) | ✓ | NÃO RETORNADO (0 eventos) | — | — | Taxa de devolução |

## 7. Cancelamentos e disputas

| Campo | Fonte | Recebido [BD] | Persistido | Utilizado | Potencial |
|---|---|---|---|---|---|
| Código e descrição | CAN `CANCEL_CODE`, `CANCEL_CODE_DESCRIPTION` | 98 (26 códigos distintos; top: 502 "duplicado" 21, 411 "atrasado" 17, 520 "endereço incompleto e cliente não atende" 10, 416 "atraso com alerta para loja" 8) | BRUTO | Não | Motivos |
| Origem | CAN `CANCEL_ORIGIN` | RESTAURANT 42 · CONSUMER_VIA_OPERATION 27 · LOGISTICS_VIA_OPERATION 14 · CONSUMER 13 · RESTAURANT_VIA_OPERATION 2 | BRUTO | Não | Responsável indicado |
| Estágio | CAN `CANCEL_STAGE` | PREPARATION_TIME 58 · DISPATCHED 33 · CONCLUDED 6 · PRE_CONFIRMED 1 | BRUTO | Não | Antes/durante/após o preparo |
| Usuário | CAN `CANCEL_USER` | 98 (UUID) | BRUTO | Não | Nenhum |
| Disputa e ocorrência financeira | CAN `CANCELLATION_DISPUTE`, `CANCELLATION_OCCURRENCE` | 98 | BRUTO | Não | Contestabilidade; estorno por parte |
| Timeout | CAN `TIMEOUT_EVENT` | false 98 | BRUTO | Não | — |
| Pedido de cancelamento | CAR `ORIGIN`, `reason_code`, `details` | 69 | BRUTO | Não | Quem pediu |
| Recusa de cancelamento | CARF `CANCELLATION_REQUEST_FAILED_REASON` | 15 | COL `cancel_failed_event_at` + BRUTO | Não | — |
| Negociação | HSD (tipo, ação, alternativas, prazo, mensagem do cliente) | 104 | `ifood_disputas` + BRUTO | Não | **Disputas por tipo e desfecho** |
| Desfecho | HSS `status`, `reason`, `selectedDisputeAlternative` | 170 | `ifood_disputas.settlement_*` | Não | Taxa de aceite, de expiração e de reembolso |

## 8. Resumo: o que perdemos hoje

| Categoria | Situação |
|---|---|
| Recebido e **descartado** | **Nenhum campo de Order Details nem de evento.** Única perda funcional: o **conteúdo atualizado** do pedido após `ORDER_PATCHED` (o Details não é rebuscado; o delta fica só no evento OPA) |
| Recebido e só no bruto (sem uso) | Linha do tempo logística, motivos/origem/estágio de cancelamento, recorrência (`ordersCountOnMerchant`), campanhas, patrocínio por benefício, itens/complementos, previsão de entrega, modo de entrega |
| Não retornado no cenário atual | `extraInfo`, `additionalInfo`, `delivery.observations`, `schedule` (sem agendados), `dineIn`, `indoor`, `ean`, `scalePrices`, eventos RPS/DRGO/DRDO/DRCR/DAR |
| Perdido por desenho de coluna | Horário do CON quando o pedido é cancelado depois da conclusão (6 casos): fica só no bruto |
| Limite externo | Order Details só fica disponível por **7 dias** (`ifood.constants.js:261`): se a busca falhar nesse prazo, o detalhe não é recuperável. Hoje 100% foram buscados (mediana de 2,6 s após o PLC [BD]) |
