# iFood Order — detalhes do pedido e `confirm` (Checkpoint C)

> Escopo: buscar os **detalhes** do pedido, persistir sem perda, e enviar **`confirm`** com estado local
> intermediário. **Não** há readyToPickup, dispatch, cancelamento ativo, Handshake nem UI de operação (Checkpoint D+).
> Nada foi commitado, enviado ou implantado. Migration 102 **aplicada e validada no banco de TESTE**
> (`wiqqsxnysbzhcrzrrean` / `teste-multiempresarial`). **Nunca aplicada em produção.**
> Rótulo dos resultados com o Teste (C): **"VALIDAÇÃO TÉCNICA CENTRALIZADA"** — não é homologação. O modelo do produto segue **distribuído**.

## 1. Endpoints (portal oficial iFood, conferido em 2026-09-27)

| | |
|---|---|
| Detalhes | `GET https://merchant-api.ifood.com.br/order/v1.0/orders/{id}` — `200` detalhes · `404` id inválido, **ainda indisponível** ou pedido antigo · `401` token expirado |
| Confirm | `POST https://merchant-api.ifood.com.br/order/v1.0/orders/{id}/confirm` — **sem corpo**, `Authorization: Bearer`, `Content-Type: application/json` · `202 {"status":"ACCEPTED"}` · `401` token expirado |
| Prazo | confirmar em **até 8 min**; depois o iFood cancela o pedido (erro 902 "Pedido não confirmado") |
| Idempotência | confirm repetido é **ignorado** pelo iFood |
| Resultado | chega como **evento `CONFIRMED` (CFM)** no polling — é ele que confirma, não o 202 |
| Retenção | detalhes ficam **7 dias**; não reconsultar pedido antigo |
| Corrida | o evento `PLACED` pode chegar **antes** dos detalhes ficarem disponíveis → retentar com backoff exponencial (até 10 min) |

`idempotencyKey` é citado de forma vaga na documentação e **não** foi implementado (não inventamos contrato).

## 2. Duas verdades separadas

| Coluna | Quem escreve | Significado |
|---|---|---|
| `status_oficial` | **só** o service de Events, por **evento oficial** | o que o iFood disse |
| `action_state` | o service de Order | o que **nós** fizemos: `none` → `confirm_sending` → `confirm_requested` \| `confirm_failed` |

```
PLACED (evento) ── detalhes ── POST /confirm ── 202 ──▶ action_state = confirm_requested   (status_oficial AINDA = PLACED)
                                                              │
                              evento CFM chega ───────────────▼
                                   status_oficial = CONFIRMED, action_state = none, confirmed_event_at carimbado
```

- **202 nunca marca CONFIRMED.** Sem o evento, o pedido fica `PLACED` + `confirm_requested` e o SLA acusa estouro (>8 min).
- Qualquer evento de status posterior a PLACED **resolve** a ação pendente (`CANCELLED` também: o iFood cancela ao estourar 8 min).
- Compare-and-set nas duas pontas: se o CFM chegar **durante** o POST, o `confirm_requested` não sobrescreve a resolução.
- Estados terminais (`CANCELLED`/`CONCLUDED`) e o ciclo monotônico continuam valendo (evento anterior nunca regride).

### Resultado de `confirmarPedido`
`SOLICITADO` (202, aguardando evento) · `JA_SOLICITADO` (nenhum novo POST) · `JA_CONFIRMADO_OFICIAL` (CFM já chegou) · `EM_ENVIO`
(outra chamada enviando; `confirm_sending` com mais de 30 s pode ser reassumido — o iFood ignora confirm repetido).
Erros: pedido de outra unidade = `IFOOD_PEDIDO_LOCAL_NAO_ENCONTRADO`; estado ≠ PLACED = `IFOOD_PEDIDO_ESTADO_INVALIDO` (sem chamar o iFood);
recusa do iFood (400/409/422) = `IFOOD_ACAO_PEDIDO_RECUSADA` + `confirm_failed` (nova tentativa permitida).

## 3. Detalhes do pedido

`ifoodOrder.parser.js` guarda o **payload bruto inteiro** (`details_payload`) + `details_payload_hash` (sha256 estável) e extrai um **índice
operacional** sem achatar nada: `items` (com opções/complementos/customizações/observações/quantidades) permanece como o iFood enviou.
Extraídos: `order_id`, `display_id`, tipo, `orderTiming`, `createdAt`, `pickup_code`, observações de entrega, pagamento (métodos, **bandeira**,
**troco**, pré-pago/pendente), totais, **benefícios e quem financia** (`discount_sponsors` = IFOOD/MERCHANT/EXTERNAL/CHAIN), **CPF/CNPJ fiscal**,
`isTest`, agendamento. Tolerante: campo ausente = `null`, tipo inesperado = `null` + aviso; **inválido** só se não for objeto, sem `id`, `id`
diferente do consultado, ou `merchant.id` diferente do merchant do pedido local.

Persistência **idempotente**: mesmo hash = nada regravado; payload alterado regrava e preserva `details_fetched_at` (1ª busca).
`customer` (dado pessoal) só existe em coluna de tabela **backend-only (RLS deny-all)** e **nunca** vai para log.

Busca (`processarDetalhesPendentes`, no fim de cada ciclo do worker, **desligado por padrão**: `IFOOD_ORDER_DETAILS_ENABLED=true`):
backoff exponencial 2 s → teto 120 s; `404` só é retentado na janela de 10 min do 1º evento; nada com mais de 7 dias; até 12 tentativas;
10 pedidos por ciclo; **para no 1º 429**. Falha nesse passo **não** derruba o ciclo nem o ACK.

## 4. SLA (8 min)

Carimbos gravados: `order_created_at` (do iFood), `placed_event_received_at`, `details_fetched_at`, `confirm_requested_at`,
`confirmed_event_at` (+ `placed_event_created_at`, `confirmed_event_received_at`). `calcularSla()` devolve os intervalos e a situação:
`AGUARDANDO_CONFIRM` · `AGUARDANDO_EVENTO_CONFIRMED` · `SLA_ESTOURADO` · `CONFIRMADO_NO_SLA` · `CONFIRMADO_FORA_DO_SLA` · `ENCERRADO_SEM_CONFIRMACAO`.
Primeiro carimbo vale (evento reentregue não reescreve).

## 5. Multi-tenant

O pedido é sempre lido por **organização + unidade** (`obterPedidoDoTenant`); pedido de outra unidade é indistinguível de inexistente.
O token/`conexaoId` do confirm vem da conexão **viva da mesma unidade** (`obterConexaoAtivaDoMerchant`). Os detalhes só são buscados se a conexão
do merchant for do mesmo tenant do pedido. Tenant **nunca** vem do payload.

## 6. Migration 102 (revisão)

`database/migrations/102_ifood_pedidos_detalhes_confirm.sql` · rollback `102_rollback.sql` (**aborta** se houver detalhes/ações gravados).
Aditiva e idempotente: `ADD COLUMN IF NOT EXISTS` em `ifood_pedidos` + CHECKs (`details_status`, `action_state`) + tabela `ifood_pedido_acoes`
(auditoria; ação só `confirm`; RLS sem policy). Nada da 056/101 é alterado.
Validada num Postgres local descartável (PGlite): aplicação, reaplicação, defaults sobre pedido pré-existente, CHECKs, gravação jsonb/numeric/array,
CAS, RLS, abort do rollback com dados, rollback limpo e reaplicação.

## 7. Como validar

| | |
|---|---|
| Testes automáticos | `test/ifood-order-details-confirm.test.js` (parser, HTTP com fetch falso, persistência, multi-tenant, máquina de estados, confirm, SLA, poller) |
| Real, somente leitura, sem banco | `npm run ifood:order-check -- --order <orderId>` (GET detalhes + parser; imprime só estrutura, sem dado pessoal) |
| Real, banco de TESTE | `npm run ifood:order-e2e -- --merchant <id> --order <id> --ack-real` (prepara e para) · `… --confirm-real` (envia o confirm). **Exige migration 102 aplicada** e um pedido **novo** `PLACED` com `isTest=true` |

### Gerar um pedido de teste
No **Portal do Parceiro** (sandbox) da loja de teste, gerar um pedido de teste (guia "Gerar pedido de teste", em *Primeiros passos*). O pedido tem que estar
em `PLACED` (não confirmar/cancelar no Portal!) e o confirm precisa ser enviado antes de **8 min** da criação.
