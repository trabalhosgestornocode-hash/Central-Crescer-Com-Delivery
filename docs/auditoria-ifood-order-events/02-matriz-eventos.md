# 02 — Matriz completa dos eventos

> Fontes: [DOC] Order › Eventos de pedido (lida em 29/10/2026); catálogo do código `ifoodEvents.parser.js:40-81` (conferido com o portal em 27/09/2026, segundo o próprio arquivo); [BD] `ifood_eventos` em produção, de 10/10 a 30/10/2026 01:29Z.

## 1. Contagens (com denominador e escopo)

| Pergunta | Resposta | Denominador / escopo |
|---|---|---|
| Eventos na referência rápida oficial atual | **25** | [DOC] tabela "Referência rápida — Todos os eventos" |
| Aplicáveis à nossa modalidade (FOOD, restaurante, DELIVERY + TAKEOUT, logística iFood + entrega própria) | **23** | 25 menos SPS e SPE ("Somente pedidos GROCERY" [DOC]) |
| Eventos fora da referência rápida, mas observados em produção | **11** (DDCR, DDCS, DPCR, CPT, DGA, DGD, DGDC, DGU, RDR, RDS, DDD) | Existem de fato para a nossa operação; estão no catálogo do código (página de Events de 27/09) |
| Catálogo do nosso código | **48** códigos | `ifoodEvents.parser.js:40-81` |
| Reconhecidos pelo código, sobre os 25 oficiais | **25/25** | Todos estão em `CATALOGO_EVENTOS` |
| Reconhecidos, sobre os observados | **29/29** | [BD] 0 linhas `DESCONHECIDO` |
| **Observados** (recebidos) em produção | **29 códigos distintos, 51.331 eventos** | [BD], 3 unidades, de 10/10 a 30/10/2026 |
| Aplicáveis e oficiais, mas **não observados** | **5** (RPS, DRGO, DRDO, DRCR, DAR) | 23 aplicáveis − 18 observados da referência rápida |
| **Persistidos** (payload bruto integral) | **29/29** observados (100%) | `ifood_eventos.payload` |
| Persistidos **estruturados** (colunas/tabelas próprias) | **9** códigos: PLC, CFM, RTP, DSP, CON, CAN, CARF, HSD, HSS (20.770 eventos) | `ifood_pedidos` / `ifood_disputas` |
| Persistidos só no bruto (sem estrutura) | **20** códigos (30.561 eventos = 59,5%) | `processing_status = IGNORADO` |
| **Utilizados** por alguma funcionalidade | **6** códigos: PLC, CFM, RTP, DSP, CON, CAN | Checklist Operacional (`checklistOperacional.repository.js:12-16`). HSD/HSS/CARF são persistidos, mas **nenhuma tela** os lê |

## 2. Matriz por evento

Legendas. **Rec** = reconhecido no catálogo. **Handler**: `ESTADO` (altera `status_oficial` + carimbo), `CARIMBO`, `DISPUTA`, `CARF`, `INFO` (só `primeiro/ultimo_evento_em`; `IGNORADO`). **Pers**: B = bruto em `ifood_eventos.payload`; E = estruturado. **Obs** = quantidade observada [BD]. **Uso** = consumido por tela ou módulo.

### 2.1 Status do pedido (ORDER_STATUS)

| Código | fullCode | Fluxos [DOC] | Metadata observado [BD] (só chaves) | Data/hora | Rec | Handler | Pers | Uso | Obs | Indicador | Alerta possível | Limitações |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PLC | PLACED | Todos | (sem metadata) | `createdAt` → `placed_event_created_at`; recebimento → `placed_event_received_at` | ✓ | ESTADO + CARIMBO | B+E | Checklist (chegada) | 4.541 | Volume por hora/dia; início de preparo/vida | Pedido sem confirmação há X min | 2 pedidos sem PLC [BD] |
| CFM | CONFIRMED | Todos | `triggerEvent`, `minimumTtl`, `DELIVERY_DATE`, `client_type`, `additional_info` (4.350) ou `appName/CLIENT_ID/ORIGIN/ownerName` (193) | `confirmed_event_at` | ✓ | ESTADO + CARIMBO | B+E | Checklist (exibição) | 4.541 | Tempo até confirmação | Confirmação > 8 min (SLA [DOC]) | Mediana PLC→CFM = 0,0 min [BD]: o PDV confirma automaticamente |
| SPS | SEPARATION_STARTED | Só GROCERY | — | — | ✓ | ESTADO | — | — | 0 | n/a | n/a | Não aplicável (FOOD) |
| SPE | SEPARATION_ENDED | Só GROCERY | — | — | ✓ | ESTADO | — | — | 0 | n/a | n/a | Não aplicável |
| RTP | READY_TO_PICKUP | FOOD | `appName/CLIENT_ID/ORIGIN/ownerName` | `ready_event_at` | ✓ | ESTADO + CARIMBO | B+E | Checklist (exibição; **não** encerra o preparo) | 2.416 | Tempo até pronto; pronto → coleta | Pronto aguardando coleta | Só 2.344 de 4.406 (53,2%) DELIVERY concluídos reais têm RTP [BD] (iFood 1.482/1.793; própria 862/2.613); depende de a loja sinalizar no PDV |
| DSP | DISPATCHED | Todos | `appName…` (2.448) ou vazio (1.994) | `dispatch_event_at` | ✓ | ESTADO + CARIMBO | B+E | Checklist (fim do preparo) | 4.442 | Preparo PLC→DSP; entrega DSP→CON | Atraso de preparo | Em logística iFood, o DSP sai ~0,02 min após o CLT [BD]: o DSP marca a **coleta**, não a "saída da cozinha" |
| CON | CONCLUDED | Todos | `triggerEvent`; às vezes `ORDER_HANDSHAKE_CODE_SUCCESSFUL`, `DELIVERY_CONFIRMATION_VERSION`, `APP_NAME/OWNER_NAME` | `status_oficial_em` | ✓ | ESTADO | B+E | Checklist (fim da vida) | 4.443 | Entrega DSP→CON; vida PLC→CON | — | [DOC] "Entrega confirmada/Timeout": **não** prova entrega física; `ORDER_HANDSHAKE_CODE_SUCCESSFUL=true` em 2.259 é evidência forte, mas não universal |
| CAN | CANCELLED | Todos | `CANCEL_CODE`, `CANCEL_CODE_DESCRIPTION`, `CANCEL_ORIGIN`, `CANCEL_REASON`, `CANCEL_STAGE`, `CANCEL_USER`, `CANCELLATION_DISPUTE`, `CANCELLATION_OCCURRENCE`, `CANCELLATION_REQUESTED_EVENT_ID`, `TIMEOUT_EVENT` | `cancel_event_at` | ✓ | ESTADO + CARIMBO | B+E (motivo/origem/estágio **só no bruto**) | Checklist (contagem) | 98 | Taxa, motivo, origem e estágio de cancelamento | Cancelamento imediato | `cancel_reason_code` da 103 só é preenchido quando **nós** cancelamos; motivo, origem e estágio oficiais ficam só no JSON |

### 2.2 Cancelamento (controle)

| Código | fullCode | Metadata [BD] | Rec | Handler | Pers | Uso | Obs | Indicador | Alerta | Limitações |
|---|---|---|---|---|---|---|---|---|---|---|
| CAR | CANCELLATION_REQUESTED | `ORIGIN`, `reason_code`, `details` (+ `CLIENT_ID`) | ✓ | INFO | B | — | 69 | Pedidos de cancelamento por origem (ORDER_API 25, BACKOFFICE 20, APP 19, PORTAL 2, LOGISTICS_INTERVENTIONS 2, AGENT_HELPER 1) | Cancelamento solicitado | — |
| CARF | CANCELLATION_REQUEST_FAILED | `CANCEL_CODE`, `CANCELLATION_REQUEST_FAILED_REASON`, … | ✓ | CARF | B+E (`cancel_failed_event_at`) | — | 15 | Cancelamentos recusados | Cancelamento recusado | Não há tela |

### 2.3 Logística (DELIVERY / DELIVERY_GROUP / ONDEMAND)

| Código | fullCode | Metadata [BD] | Rec | Handler | Pers | Uso | Obs | Indicador | Alerta | Limitações |
|---|---|---|---|---|---|---|---|---|---|---|
| ADR | ASSIGN_DRIVER | `deliveryId`, `deliveryType`, `workerExternalUuid`, **`workerName`**, `workerPhotoUrl`, `workerVehicleType` (2.100) ou `appName…`, **`workerPhone`**, `isTrackable` (1.865) | ✓ | INFO | B | — | 3.963 | Tempo até atribuir entregador; veículo | Pedido pronto sem entregador | **PII do entregador** no bruto (ver 04) |
| GTO | GOING_TO_ORIGIN | `deliveryId`, `deliveryType` / `appName…` | ✓ | INFO | B | — | 3.963 | — | — | — |
| AAO | ARRIVED_AT_ORIGIN | `deliveryId`, `deliveryType`, `workerExternalUuid` | ✓ | INFO | B | — | 2.041 | Espera do entregador (AAO→CLT): mediana 1,6 min (iFood) | Entregador aguardando na loja | Só existe com logística iFood (1.793/1.793 nos concluídos `deliveredBy=IFOOD`; 181/2.613 em `MERCHANT`) |
| CLT | COLLECTED | idem | ✓ | INFO | B | — | 1.995 | Coleta; pronto→coleta | — | Idem |
| AAD | ARRIVED_AT_DESTINATION | `deliveryId`, `deliveryType` / `appName…` | ✓ | INFO | B | — | 2.236 | Chegada ao cliente; AAD→CON (mediana 1,0 min) | — | — |
| DDD | DELIVERY_DRIVER_DEALLOCATED | `reasonDeliveryDriverDeallocated` (REMOVED 35, REJECTED 1) | ✓ | INFO | B | — | 36 | Realocações de entregador | Entregador desalocado | Não está na referência rápida atual |
| DRGO | DELIVERY_RETURNING_TO_ORIGIN | [DOC] `deliveryId`, `deliveryType` | ✓ | INFO | — | — | **0** | Devoluções | Devolução em andamento | Não observado no período |
| DRDO | DELIVERY_RETURNED_TO_ORIGIN | [DOC] idem | ✓ | INFO | — | — | **0** | Devoluções | Pedido devolvido | Não observado |
| DRCR | DELIVERY_RETURN_CODE_REQUESTED | [DOC] `HANDSHAKE_CODE`… | ✓ | INFO | — | — | **0** | — | — | Não observado |
| DDCR | DELIVERY_DROP_CODE_REQUESTED | (sem metadata) | ✓ | INFO | B | — | 4.488 | Uso do código de entrega | — | — |
| DDCS | DELIVERY_DROP_CODE_VALIDATION_SUCCESS | — / `deliveryId`, `deliveryType` | ✓ | INFO | B | — | 4.275 | Entrega com código validado (evidência de entrega) | — | — |
| DPCR | DELIVERY_PICKUP_CODE_REQUESTED | `HANDSHAKE_CODE`, `HANDSHAKE_STATUS`, `HANDSHAKE_VALIDATION_TYPE` | ✓ | INFO | B | — | 2.012 | — | — | **Código de coleta** guardado no bruto (dado sensível operacional) |
| DGA | DELIVERY_GROUP_ASSIGNED | `delivery`, `deliveryGroupId`, `logisticProduct`, `orderIds` | ✓ | INFO | B | — | 288 | Entregas agrupadas | — | [DOC] "deprecado desde 13/10/2025", mas **ainda chega** |
| DGD | DELIVERY_GROUP_DISMISSED | idem | ✓ | INFO | B | — | 200 | — | — | — |
| DGAC | DELIVERY_GROUP_ASSOCIATED | `deliveryGroupId`, `orderIds` | ✓ | INFO | B | — | 757 | % de pedidos em rota agrupada | — | — |
| DGDC | DELIVERY_GROUP_DISSOCIATED | idem | ✓ | INFO | B | — | 48 | — | — | — |
| DGU | DELIVERY_GROUP_UPDATED | idem | ✓ | INFO | B | — | 10 | — | — | — |
| RDR | REQUEST_DRIVER | `amount`, `isDelayed` (true 160 / false 26) | ✓ | INFO | B | — | 186 | Entregador sob demanda; custo | Chamado atrasado | Só lojas com entrega própria + sob demanda |
| RDS | REQUEST_DRIVER_SUCCESS | `delivery`, `enableTip`, `logisticProduct` | ✓ | INFO | B | — | 186 | — | — | — |
| DCR, DPCS, RDF, DCRA, DCRR, RTS | (catálogo) | — | ✓ | INFO | — | — | 0 | — | — | Não observados |

### 2.4 Disputas (Plataforma de negociação)

| Código | fullCode | Metadata [BD] | Rec | Handler | Pers | Uso | Obs | Indicador | Alerta | Limitações |
|---|---|---|---|---|---|---|---|---|---|---|
| HSD | HANDSHAKE_DISPUTE | `action`, `alternatives`, `createdAt`, `disputeId`, `expiresAt`, `handshakeGroup`, `handshakeType`, `message`, `metadata`, `timeoutAction` | ✓ | DISPUTA | B+E (`ifood_disputas`) | **Nenhuma tela** | 104 | Disputas por tipo (DELAY 49, AFTER_DELIVERY_PARTIALLY 30, AFTER_DELIVERY 13, PREPARATION_TIME 12) | **Disputa aberta com prazo** (`expiresAt`, ~5 min no exemplo [DOC]) | O código lê `id` e aceita `disputeId` como alias (`ifoodHandshake.parser.js:34`); [BD] mostra `disputeId` |
| HSS | HANDSHAKE_SETTLEMENT | `createdAt`, `disputeId`, `status`, `reason`, `selectedDisputeAlternative` | ✓ | DISPUTA | B+E | Nenhuma | 170 | Desfecho: EXPIRED 56, ALTERNATIVE_REPLIED 40, REJECTED 38, ACCEPTED 36 | Disputa expirada sem resposta | 66 disputas sem HSD correspondente; 40 presas em `RESPONDIDA` |

### 2.5 Outros / informativos

| Código | fullCode | Metadata [BD] | Rec | Handler | Pers | Uso | Obs | Indicador | Alerta | Limitações |
|---|---|---|---|---|---|---|---|---|---|---|
| PRS | PREPARATION_STARTED | `appName/CLIENT_ID/ORIGIN/ownerName` (100%) | ✓ | INFO | B | — | 3.249 | Início de preparo **registrado no PDV** | Preparo não iniciado | Presente em 99% (MERCHANT) e 31% (IFOOD) dos concluídos [BD]; PLC→PRS mediana 0,4 min (marcação automática, não o início real na cozinha) |
| RPS | RECOMMENDED_PREPARATION_START | [DOC] `expectedPreparationStartTimestamp`, `expectedPreparationEndTimestamp` | ✓ | INFO | — | — | **0** | Aderência ao preparo recomendado | — | Só lojas com "Preparo Inteligente" [DOC]; o Order Details traz `preparationStartDateTime` em 100% |
| CPT | CHANGE_PREPARATION_TIME | `changePreparationTimeInSeconds`, `ORIGIN` (iFood), `reason` ("Changed by AI model") | ✓ | INFO | B | — | 545 | Ajustes de tempo de preparo feitos pelo iFood | — | Fora da referência rápida |
| OPA | ORDER_PATCHED | `changes` (array), `payments`, `total` | ✓ | INFO | B | — | 14 | Pedidos alterados após a confirmação | Pedido alterado | Order Details **não** é rebuscado (ver 01, I-3) |
| DAR | DELIVERY_ADDRESS_CHANGE_REQUESTED | [DOC] `address` | ✓ | INFO | — | — | **0** | — | — | Contém endereço (PII) se chegar |
| DAU, DAA, DAD, CPR, BOA, RFI | (catálogo) | — | ✓ | INFO | — | — | 0 | — | — | — |

## 3. Observações relevantes

1. **Nenhum evento é perdido**: 29/29 códigos observados estão persistidos integralmente. O que se "descarta" é a **estrutura**: 59,5% dos eventos não viram colunas e ficam só em JSON.
2. **A cronologia logística completa existe no banco**: ADR→GTO→AAO→CLT→DSP→AAD→DDCS→CON. Hoje só é recuperável por consulta ao JSON (é assim que este relatório calculou as medianas).
3. **O DSP tem semântica diferente conforme a logística**: na logística iFood ele coincide com a coleta (CLT→DSP mediana 0,02 min); na entrega própria é a saída marcada no PDV. O preparo PLC→DSP do Checklist mistura "cozinha + espera do entregador" em logística iFood (o código já documenta isso em `checklistOperacional.calc.js:9-14`).
4. **O CON não prova entrega**: [DOC] "Entrega confirmada/Timeout". `ORDER_HANDSHAKE_CODE_SUCCESSFUL=true` ou DDCS são evidências mais fortes e opcionais.
5. **SPS e SPE não se aplicam** (GROCERY). **RPS** depende do Preparo Inteligente. **DRGO/DRDO/DRCR/DAR** podem chegar a qualquer momento: o código os reconhece, mas não há handler específico nem teste com payload real.
