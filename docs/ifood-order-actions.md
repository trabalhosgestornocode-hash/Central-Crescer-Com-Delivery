# iFood Order — ready, dispatch, cancelamento e Handshake (Checkpoint D)

> Escopo: `readyToPickup`, `dispatch`, cancelamento (motivos oficiais + `requestCancellation`) e Plataforma de negociação
> (Handshake). Ready, Dispatch e Cancelamento foram **validados de verdade** no sandbox (seção 8); Handshake está
> **implementado e testado automaticamente**, com o E2E real pendente da homologação assistida (seção 10). A migration 103
> foi aplicada e validada no banco de TESTE (`wiqqsxnysbzhcrzrrean` / `teste-multiempresarial`, seção 7). Sem
> commit/push/deploy, sem UI final, sem rotas HTTP. Modelo do produto: **distribuído**; o Teste (C) é só o ambiente técnico.
> Resultados rotulados **"VALIDAÇÃO TÉCNICA CENTRALIZADA"** — não é homologação.

## 1. Documentação oficial conferida (portal iFood, 2026-09-27)

Páginas: Order › Endpoints, Guia de implementação, Eventos de pedido, Cancelamento de pedidos, Plataforma de negociação, Guia de negociação.

| Ação | Endpoint | Corpo | Resposta | Evento esperado |
|---|---|---|---|---|
| readyToPickup | `POST /order/v1.0/orders/{id}/readyToPickup` | — | `202 {"status":"ACCEPTED"}` | `READY_TO_PICKUP` (RTP); a doc também cita `SEPARATION_ENDED` (SPE) |
| dispatch | `POST /order/v1.0/orders/{id}/dispatch` | `{"deliveredBy":"MERCHANT"}` (fixo) | `202` | `DISPATCHED` (DSP) |
| motivos | `GET /order/v1.0/orders/{id}/cancellationReasons` | — | `200 {"reasons":[{code,description}]}` · `204` sem política | — |
| cancelar | `POST /order/v1.0/orders/{id}/requestCancellation` | `{"cancellationCode":"<code>","reason":"<descrição oficial>"}` (ver divergência 8) | `202` | `CANCELLED` (CAN) **ou** `CANCELLATION_REQUEST_FAILED` (CARF) |
| aceitar disputa | `POST /order/v1.0/disputes/{id}/accept` | opcional `{reason?, detailReason?}` | `201 {id,status:"ACCEPTED",disputeId}` | `HANDSHAKE_SETTLEMENT` (HSS) |
| rejeitar | `POST /order/v1.0/disputes/{id}/reject` | `{reason}` | `201` | HSS |
| contraproposta | `POST /order/v1.0/disputes/{id}/alternative` | `{type, metadata}` | `201` | HSS `ALTERNATIVE_REPLIED` e depois outro HSS final |

Headers: `Authorization: Bearer` (+ `Content-Type: application/json` quando há corpo). Erros: `401` token · `404` pedido/disputa · `400` (`OrderExceededCancellationDeadline`,
`OrderHasACancellationInProgress`, `InvalidParameter`, `INVALID_REASON`, `INVALID_AMOUNT`) · `422 DISPUTE_ALREADY_ANSWERED` · `429` · `5xx`.

Regras por tipo: **ready** é obrigatório para `TAKEOUT`, `DINE_IN` e `DELIVERY`; **dispatch** só para `DELIVERY` com entrega própria (`deliveredBy = MERCHANT`) e **depois**
do ready; entrega iFood (marketplace) e TAKEOUT/DINE_IN não têm dispatch. Cancelamento: o motivo vem sempre da lista retornada pelo iFood (`reason` é string, sem lista fixa).

### Divergências encontradas na documentação (interpretação conservadora adotada)

| # | Divergência | Adotado |
|---|---|---|
| 1 | `dispatch`: a página *Endpoints* mostra corpo `{"deliveredBy":"MERCHANT"}`; o *Guia de implementação* não mostra corpo | **RESOLVIDO (revisão do Checkpoint D):** segue a documentação oficial atual — corpo `{"deliveredBy":"MERCHANT"}`, Content-Type JSON. O cliente recusa qualquer outro valor (nunca chega à rede) e o corpo é auditado em `request_payload`. Só é enviado depois da elegibilidade local (DELIVERY + entrega própria + RTP oficial) |
| 2 | Polling/ACK: a página *Endpoints* cita `/order/v1.0/orders:polling` e `acknowledgedEventIds`, mas o fluxo **validado ao vivo** (Checkpoint B) usa `/events/v1.0/events:polling` e `[{id}]` | mantido o que funciona ao vivo |
| 3 | Eventos: a página *Eventos de pedido* mistura `code`/`fullCode` (ex.: `CONFIRMED`/`ORDER_CONFIRMED`); ao vivo chegam `CFM`/`CONFIRMED`, `PLC`… | mantido o catálogo observado |
| 4 | `readyToPickup` gera `SEPARATION_ENDED` (SPE) **ou** `READY_TO_PICKUP` (RTP)? A doc diz as duas coisas | o ready é **resolvido** por SPE, RTP ou qualquer estágio posterior; o **dispatch exige RTP oficial** (mais restritivo). O D1 mostra qual chega no sandbox |
| 5 | Handshake: *Eventos de pedido* mostra `metadata.dispute {status,proposalValue,…}`; *Plataforma de negociação* mostra `metadata` = `HandshakeDispute` (id, action, handshakeType, expiresAt…) | forma da *Plataforma* é a principal; a aninhada é aceita como fallback; o payload bruto é sempre guardado |
| 6 | A página de confirm cita `CANCELLATION_REQUEST_FAILED` como resultado possível do `/confirm` (provável erro da doc) | CARF só afeta a ação `cancel`; nunca o confirm |
| 7 | `cancellationReasons`: a documentação mostra `{"reasons":[{code,description}]}`; o sandbox devolve uma **lista** `[{cancelCodeId,description}]` (11 motivos, confirmado ao vivo em 2026-09-27) | o cliente aceita as duas formas e normaliza para `code` (preservando `cancelCodeId`). Defeito encontrado no D3 (a lista chegava vazia); coberto por teste na forma real |
| 8 | `requestCancellation`: a documentação mostra corpo `{"reason":"503"}`; o iFood respondeu **HTTP 400 `InvalidParameter`: "Invalid cancellation request: Field 'cancellationCode' is required"** (D3, 2026-09-27) | corpo `{cancellationCode, reason}`: `cancellationCode` = código oficial; `reason` = descrição oficial de cancellationReasons (fallback: o código). Descoberto graças à captura de `code`/`message` do erro na auditoria |

## 2. Regra central (inalterada)

```
ação enviada → HTTP aceito → registra a INTENÇÃO (<acao>_requested) → status_oficial NÃO muda → evento oficial chega → status_oficial muda
```

Resolução da ação pelo evento (`extrasDoEvento`): ready ← SPE/RTP e posteriores · dispatch ← DSP e posteriores · cancel ← **só** CAN (a falha chega como CARF → `cancel_failed`) ·
confirm ← qualquer estágio após PLACED. CANCELLED/CONCLUDED encerram o que estava pendente. Carimbos oficiais: `ready_event_at`, `dispatch_event_at`, `cancel_event_at`.

### Elegibilidade local (função pura `avaliarElegibilidade`, nenhum POST fora dela)

| Ação | Estado oficial exigido | Tipo | Resultado nos demais casos |
|---|---|---|---|
| ready | CONFIRMED (ou SEPARATION_STARTED) | TAKEOUT · DINE_IN · DELIVERY | já pronto → `JA_EXECUTADO`; outro estado → `IFOOD_PEDIDO_ESTADO_INVALIDO`; INDOOR/desconhecido → `IFOOD_ACAO_NAO_ELEGIVEL`; detalhes ausentes → estado inválido |
| dispatch | **READY_TO_PICKUP** (evento oficial) | DELIVERY **e** `deliveredBy = MERCHANT` | antes do ready → estado inválido (`ready_nao_comprovado`); ready pedido e evento pendente → `AGUARDANDO_EVENTO`; marketplace/TAKEOUT/DINE_IN → não elegível; já despachado → `JA_EXECUTADO` |
| cancel | PLACED … DISPATCHED (não terminal) | qualquer | CANCELLED → `JA_EXECUTADO`; CONCLUDED → estado inválido; motivo fora da lista oficial → `IFOOD_MOTIVO_CANCELAMENTO_INVALIDO` (sem POST) |

Regras completas de coexistência entre ações (quem bloqueia quem, qual evento limpa o quê): §3. Nenhuma ação começa por cima de outra pendente.

## 3. `action_state` único + `action_uncertain` — regras de coexistência (APROVADO CONDICIONALMENTE; condição cumprida por código e testes)

Modelo: **um único `action_state`** por pedido com `none` + `{confirm|ready|dispatch|cancel}_{sending|requested|failed}` (13 valores, CHECK por padrão) e `action_uncertain`
(só com `*_requested`, garantido por CHECK). A auditoria de **todas** as tentativas de **todas** as ações mora em `ifood_pedido_acoes`; os carimbos `<acao>_requested_at` / `<acao>_event_at`
ficam no pedido. **Handshake não usa o `action_state`**: vive em `ifood_disputas`.

**Princípio anti-sobrescrita:** o `action_state` só é escrito quando NADA está pendente no iFood. Enquanto houver uma ação pendente, nenhuma outra começa por cima dela — então nenhuma informação
é perdida e não há "pilha" de ações para reconstruir.

### Quais ações bloqueiam quais

| Estado atual | Bloqueia | Resultado para a outra ação | Pode coexistir com |
|---|---|---|---|
| `<X>_sending` (fresco, < 30 s) | **todas** as outras | `EM_ENVIO` (nenhum POST) | Handshake (independente) |
| `<X>_sending` (> 30 s, envio interrompido) | **todas** as outras | `AGUARDANDO_EVENTO` `envio_interrompido` (pode ter sido processado = incerto) | Handshake |
| `<X>_requested` (iFood aceitou, evento pendente) | **todas** as outras | `AGUARDANDO_EVENTO` `acao_pendente` (+ `pendente: <X>`) | Handshake |
| `<X>_requested` + `action_uncertain` (timeout/5xx) | **todas** as outras | `AGUARDANDO_EVENTO` `acao_incerta_pendente`, `incerto: true`; a incerteza é preservada | Handshake |
| `cancel_sending/requested` | ready · dispatch · confirm | `IFOOD_PEDIDO_ESTADO_INVALIDO` `cancelamento_em_andamento` (nada enviado) | Handshake |
| `<X>_failed` | **nada** (recusa definitiva: nada pendente no iFood) | a próxima ação parte e sobrescreve o `failed` | tudo |
| `none` | nada | — | tudo |

Além do `action_state`, cada ação tem a sua **elegibilidade por estado oficial** (§2). Consequências práticas:
`ready_requested` + cancelar ⇒ espera o RTP; `dispatch` com `ready_requested` ⇒ espera o RTP (não envia); `cancel_requested` ⇒ nenhum ready/dispatch/confirm.

**Exceção explícita e auditável — `substituirPendente: true`:** só depois de `IFOOD_ORDER.reenvioIncertoAposMs` (3 min) sem o evento, e só por pedido explícito, uma ação pode passar por cima
de outra pendente. A ação substituída continua rastreável (carimbo `<acao>_requested_at` preenchido, `<acao>_event_at` vazio e a linha da auditoria `ACEITA_202`/`INCERTO`); a nova parte com
`action_uncertain = false`. O mesmo vale, para a *mesma* ação incerta, com `permitirReenvioIncerto` (reenvio).

### Qual evento limpa cada `action_state`

| Ação pendente | Evento que limpa (→ `none`, `action_uncertain=false`) | Não limpa (eventos atrasados/de estágio anterior) |
|---|---|---|
| `confirm_*` | CFM e qualquer estágio posterior | PLC |
| `ready_*` | SPE · RTP · DSP · CON · CAN | PLC · CFM · SPS |
| `dispatch_*` | DSP · CON · CAN | PLC · CFM · SPS · SPE · **RTP** |
| `cancel_*` | **só CAN** | RTP · DSP · CON · qualquer outro. Falha: `CANCELLATION_REQUEST_FAILED` (CARF) ⇒ `cancel_failed` |
| `none` / `*_failed` | — (`*_failed` também é zerado quando um evento posterior supera a ação) | — |

Nenhum evento **cria** um `action_state` — só zera (ou, CARF, converte `cancel_*` pendente em `cancel_failed`). CARF não toca em nenhum outro estado. Os eventos atrasados ainda
carimbam o pedido (`ready_event_at`, `dispatch_event_at`…) e avançam o estado oficial (monotônico), mas nunca apagam a ação mais recente.

### Como a disputa Handshake coexiste com o estado operacional

`HANDSHAKE_DISPUTE`/`SETTLEMENT` e as respostas (`accept|reject|alternative`) **não leem nem escrevem** o `action_state` (teste percorre os 13 estados). Uma disputa pode estar aberta com
`dispatch_requested` pendente; cada uma segue seu ciclo (`ifood_disputas.status`). Se a disputa resultar em cancelamento, o **CAN oficial** encerra a ação operacional pendente (CANCELLED zera
qualquer ação) e o HSS encerra a disputa, cada um por seu evento.

### Prova (testes)

`test/ifood-order-action-coexistence.test.js` (17): `ready_requested`+cancel · `dispatch_requested`+HSD · `action_uncertain`+nova ação · `cancel_requested`+RTP tardio · `cancel_requested`+DSP tardio ·
matriz pura 13 estados × 8 status + CARF · **propriedade** "toda ação X pendente × toda outra ação Y ⇒ nenhum POST e estado idêntico" · Handshake × 13 estados · confirm não sobrescreve cancelamento.
Verificado por mutação: desligar o bloqueio faz 4 desses testes falharem.

### Por que não foi preciso outra modelagem

A única perda de informação possível seria sobrescrever uma ação pendente; o bloqueio impede isso e a exceção explícita preserva o rastro nos carimbos e na auditoria. Se no futuro for
necessário **enviar duas ações em paralelo** (não é o caso do ciclo de vida do pedido), aí sim valeria uma tabela/colunas por ação.

## 4. Falhas e retries — ações mutantes nunca são repetidas às cegas

`postJson(..., {semRetry:true})` em ready/dispatch/cancel/disputas (1 chamada, sem backoff). Leituras (detalhes, motivos) continuam podendo repetir.

| Resultado da chamada | Significado | Estado local | Retorno |
|---|---|---|---|
| 202/201 | iFood aceitou | `<acao>_requested` (auditoria `ACEITA_202`/`ACEITA`) | `SOLICITADO` |
| 400 / 401 / 403 / 404 / 409 / 422 / **429** | recusou / pediu calma: **não executou** | `<acao>_failed` (nova tentativa permitida) | erro do iFood (`RECUSADA`/`FALHOU`) |
| **timeout / rede / 5xx / resposta ilegível** | **incerto — o iFood pode ter processado** | `<acao>_requested` + `action_uncertain=true` (auditoria `INCERTO`) | `AGUARDANDO_EVENTO` (`incerto:true`) |
| repetição com `_requested` | — | intacto | `JA_SOLICITADO` (ou `AGUARDANDO_EVENTO` se incerto) — **sem POST** |
| repetição com `_sending` fresco | outra chamada em voo | intacto | `EM_ENVIO` |

Reenvio de uma ação incerta: só com `permitirReenvioIncerto: true` **e** depois de 3 min sem o evento. O evento oficial que chegar antes/durante/depois resolve tudo (CAS).

## 5. Auditoria (`ifood_pedido_acoes`, migration 103)

Por tentativa: `pedido_id, organizacao_id, unidade_id, conexao_id, acao, tentativa, requested_at, responded_at, http_status, resultado, erro_codigo, error_message,
request_payload, response_payload, dispute_id`. `resultado`: `ACEITA_202 | ACEITA | RECUSADA | FALHOU | JA_SOLICITADA | INCERTO` (+ `ENVIADA` legado). Payloads passam por
`sanitizarParaAuditoria` (remove token, secret, Authorization, refresh, verifier…); teste garante que o token não aparece.

## 6. Cancelamento por solicitação da plataforma (consumidor/iFood) → Handshake

Segundo a documentação, o cliente pede cancelamento (após a entrega, no preparo, por atraso) **pela Plataforma de negociação**: chega `HANDSHAKE_DISPUTE` (HSD) e o merchant responde
`accept` / `reject` / `alternative` antes de `expiresAt`. Sem resposta, o iFood executa `timeoutAction` (`ACCEPT_CANCELLATION` | `REJECT_CANCELLATION` | `VOID`) e emite HSS `EXPIRED`.
Cancelamento automático por falta de confirmação (8 min) e manual pelo atendimento chegam como `CANCELLED`. `CANCELLATION_REQUESTED` (CAR) é informativo (o pedido de cancelamento
nosso ou do cliente) e é guardado sem efeito.

`ifood_disputas` persiste: id da negociação, pedido, tenant, ação, tipo, motivo/mensagem do cliente, prazo (`expires_at`), `timeout_action`, alternativas, motivos de aceite, evidências,
payload bruto, decisão enviada (`decision*`, resposta sanitizada, tentativas) e settlement(s) recebido(s) (`settlements` + `settlement_status`).

Matriz validada localmente antes de qualquer POST: PREPARATION_TIME só accept/reject · DELAY accept (exige motivo de `acceptCancellationReasons`) ou ADDITIONAL_TIME (minutos e motivo dentro do
permitido) · AFTER_DELIVERY(_PARTIALLY) accept/reject/REFUND (≤ `maxAmount`, centavos inteiros, moeda). Uma resposta por `disputeId`. Prazo vencido → nada é enviado.
HTTP `201` **não** encerra a negociação (`RESPONDIDA`); só o HSS encerra (`ENCERRADA`). `ALTERNATIVE_REPLIED` aguarda o settlement final do cliente. Settlement antes da disputa cria esqueleto encerrado;
o HSD tardio só completa campos. Merchant do evento ≠ merchant do pedido → `MERCHANT_DIVERGENTE`; disputa/pedido de outro tenant nunca é tocado.

Eventos desconhecidos/inválidos continuam sendo persistidos, marcados e reconhecidos (HSD/HSS com metadata inválido viram `IGNORADO`, nunca quebram o worker).

## 7. Migration 103 (revisão)

`database/migrations/103_ifood_order_actions.sql` · rollback `103_rollback.sql` (**aborta** se houver disputas, ações novas ou estados novos). Aditiva/idempotente: amplia o CHECK de `action_state`
(DDL nova; o arquivo da 102 não é editado), adiciona colunas de carimbo/estado a `ifood_pedidos`, estende `ifood_pedido_acoes` (colunas + CHECKs de `acao`/`resultado`) e cria `ifood_disputas` (RLS sem policy).
Validada num Postgres local descartável (PGlite): aplicação, reaplicação, preservação de dados da 102, 13 valores válidos e inválidos recusados, estados impossíveis, UNIQUE, RLS, abort do rollback
com dados, rollback limpo e reaplicação. **Não aplicada.**

## 8. Validação real planejada (cada etapa para e aguarda aprovação)

`npm run ifood:order-action -- --acao <acao> --merchant 55c8f464-e65f-4340-b2c7-62d143027040 --order <id> --ack-real [--enviar-real]` (sem `--enviar-real` = dry-run).
Exige Supabase de TESTE, sem Render, `NODE_ENV != production`, sem apps reais, `isTest=true`, merchant único da loja sandbox, binding, detalhes OK, migration 103 e elegibilidade local.

| Etapa | Ação | Pedido |
|---|---|---|
| D1 | `--acao ready` | novo, confirmado (o sandbox auto-confirma ~1 min; usar o `order-e2e --confirm-real` para confirmar por nós) |
| D2 | `--acao dispatch` | pedido DELIVERY `deliveredBy=MERCHANT` já com RTP |
| D3 | `--acao cancel-reasons` e depois `--acao cancel --motivo <code>` | pedido **exclusivo** para cancelamento |
| D4 | `--acao dispute-status` / `dispute-accept|reject|alternative` | cenário de disputa (ver abaixo) |

**D4 — gerar o cenário**: pela documentação, as negociações são iniciadas pelo *cliente no app iFood* (ajuda › “Comprei sem querer” para PREPARATION_TIME — pedido confirmado e **não** despachado;
“Não chegou” para DELAY — exige a config `LC_OPS_ORDER_LATE_MARKETPLACE_CHAT_HANDSHAKE_ENABLED = S`; após a entrega, “Pedido veio errado”). Não há endpoint para o merchant simular isso;
no sandbox isso depende de um pedido de teste feito no app de consumidor de homologação. A viabilidade será explicada e confirmada **antes** de executar o D4.

## 9. D4 — Handshake: investigação (sem nenhuma ação real)

Legenda: **[DOC]** fato confirmado na documentação oficial · **[SANDBOX]** fato observado no sandbox · **[HIPÓTESE]** ainda não validada.

### 9.1 Como nasce a negociação
- **[DOC]** É **iniciativa do cliente**, pelo app do consumidor (Ajuda): *após a entrega* (cancelamento total/parcial, "Pedido veio errado"), *durante o preparo* ("Comprei sem querer", pedido confirmado e **não** despachado) e *por atraso* ("Não chegou"). Fundamentos: "Essa é a iniciativa da loja [cancelar pela API]. Quando a iniciativa parte do cliente, a resolução acontece por negociação (Handshake)".
- **[DOC]** A loja **não** tem endpoint para abrir uma negociação. O cancelamento feito pela loja (`requestCancellation`) **não** é uma negociação.
- **[SANDBOX]** Nos 20 eventos guardados (8 códigos: PLC, CFM, DDCR, RTP, DSP, CAR, CAN, CON) **não houve nenhum HSD nem HSS**, mesmo depois de 3 cancelamentos (1 pela API do Crescer, 1 pelo Portal, 1 automático do iFood).

### 9.2 Eventos
| | Evento | Fonte |
|---|---|---|
| Inicia | `HANDSHAKE_DISPUTE` (code `HSD`) com `action`, `handshakeType`, `expiresAt`, `timeoutAction`, `alternatives`, `acceptCancellationReasons`, `evidences` | [DOC] |
| Encerra | `HANDSHAKE_SETTLEMENT` (code `HSS`): `ACCEPTED` · `REJECTED` · `EXPIRED` · `ALTERNATIVE_REPLIED` (este último é seguido de outro HSS com a resposta final do cliente) | [DOC] |
| Consequência | `ACCEPTED` de cancelamento leva ao `CANCELLED` do pedido (evento CAN) | [DOC] (fluxo) — [HIPÓTESE] sobre a ordem exata HSS × CAN |

### 9.3 O CAN do D3 pode originar uma disputa?
- **[SANDBOX]** O CAN traz `CANCELLATION_DISPUTE = {REASON/IS_CONTESTABLE: CANCELLATION_IS_CONTESTABLE, AUTOMATIC_REFUND: false}`. **O mesmo bloco, idêntico, aparece nos 3 CANs**, inclusive no cancelamento automático do iFood (`CANCEL_ORIGIN=SCHEDULER`, código 902, estágio `PRE_CONFIRMED`). Logo é um bloco **padrão**, não um sinal de que existe uma disputa.
- **[HIPÓTESE]** `IS_CONTESTABLE` sugere que o cliente *poderia* contestar um cancelamento da loja no app (o que geraria um HSD). **Não validada.** O CAN do D3 ficou em `CANCELLED` sem nenhum HSD até agora.
- Resposta: **INDETERMINADO** (a doc diz que cancelamento da loja não é negociação; o campo `IS_CONTESTABLE` deixa a porta aberta).

### 9.4 Como gerar no sandbox
- **[DOC]** Os cenários da doc têm *Setup* que passa pelo **app do consumidor** (Ajuda › …). Para atraso, exige a configuração da loja `LC_OPS_ORDER_LATE_MARKETPLACE_CHAT_HANDSHAKE_ENABLED = S`.
- **[SANDBOX]** Os pedidos de teste do Portal do Parceiro chegam já com `isTest=true` e são confirmados/cancelados sem consumidor real. **Não sabemos** se há app de consumidor apontado para o sandbox nem se um pedido de teste pode ser disputado.
- **[NÃO ENCONTRADO]** A página *Critérios de homologação* do módulo Order não foi localizável pelo navegador (slug do portal novo desconhecido; a busca do portal não respondeu) — não há evidência escrita de "como provocar HSD" em homologação. A doc de *Erros e troubleshooting* também não trata do assunto.
- Caminho realista: **perguntar ao suporte/homologação do iFood** como provocar `HANDSHAKE_DISPUTE` na loja sandbox (texto sugerido no relatório do D4).

### 9.5 Respostas do merchant (endpoints) — [DOC]
`POST /order/v1.0/disputes/{disputeId}/accept` (corpo opcional `{reason?, detailReason?}`; DELAY exige `reason` de `acceptCancellationReasons`) · `/reject` (`{reason}`) · `/alternative` (`{type: REFUND|BENEFIT|ADDITIONAL_TIME, metadata}`), todos `201`. Respostas permitidas por cenário: PREPARATION_TIME accept/reject; DELAY accept/ADDITIONAL_TIME; AFTER_DELIVERY(_PARTIALLY) accept/reject/REFUND. **[HIPÓTESE]** os corpos exatos (ex.: `accept` sem corpo quando `acceptCancellationReasons` é não vazio) — a doc já se mostrou incompleta em `requestCancellation` (D3); o `code`/`message` do erro do iFood agora fica na disputa e na auditoria.

### 9.6 `expiresAt`
**[DOC]** Prazo de resposta; sem resposta o iFood executa `timeoutAction` (`ACCEPT_CANCELLATION` | `REJECT_CANCELLATION` | `VOID`) e emite HSS `EXPIRED`. **Implementado:** vencido ⇒ nenhum POST (`prazo_expirado`); a negociação só é dada como terminada pelo HSS. **Lacuna conhecida:** o worker não alerta sobre prazos *prestes* a vencer (a consulta `listarDisputasDoTenant` ordena por `expires_at`; um alerta/painel fica para a UI).

### 9.7 Como saber que terminou
HSS final (`ACCEPTED`/`REJECTED`/`EXPIRED`) ⇒ `ifood_disputas.status = ENCERRADA`. O HTTP 201 da resposta só leva a `RESPONDIDA`. `ALTERNATIVE_REPLIED` continua `RESPONDIDA` até o settlement final.

### 9.8 Divergências novas
| # | Divergência | Tratamento |
|---|---|---|
| 9 | *Fundamentos*: disputa = "após a entrega"; *Guia de negociação*: 3 cenários (após entrega, preparo, atraso) | implementado o conjunto maior (3 cenários) |
| 10 | Corpo do evento HSD nos exemplos usa `id`/`action`/…; *Eventos de pedido* usa `metadata.dispute`; o sandbox já trouxe chaves diferentes da doc em outros eventos (ex.: CAN com `CANCEL_*`) | parser tolerante (`id`/`disputeId`, aninhado) + **log de ERRO com os nomes das chaves** quando o HSD não é interpretável (evento e payload bruto ficam guardados e reconhecidos) |

## 10. Validação assistida — Handshake

Orientação recebida do suporte/homologação do iFood (2026-09-27), tratada como fato oficial confirmado, substituindo as hipóteses da seção 9:

- **Como a disputa nasce:** por iniciativa do **cliente**, no app do consumidor. A loja não tem endpoint para abrir uma negociação.
- **App consumidor de homologação:** existe. É por ele que a disputa é aberta durante a homologação assistida.
- **Pedidos do Portal podem ser disputados:** confirmado — um pedido de teste criado no Portal do Parceiro pode receber HSD normalmente.
- **Ausência de simulador no Portal:** confirmado — não existe ferramenta no Portal do Parceiro para simular a contestação do cliente. A única via é o app de consumidor.
- **Flag específica apenas para atraso:** `LC_OPS_ORDER_LATE_MARKETPLACE_CHAT_HANDSHAKE_ENABLED = S` é exigida **só** para o cenário de atraso (`handshakeType: DELAY`). Os cenários de pós-entrega (`AFTER_DELIVERY`, `AFTER_DELIVERY_PARTIALLY`) e de preparo (`PREPARATION_TIME`) não dependem dela.
- **E2E real pendente:** o ciclo `HSD → resposta do merchant → HSS` será validado durante a **homologação assistida** com o iFood, quando o app de consumidor de homologação estiver disponível para gerar o cenário do lado do cliente. Não é obrigatório provar esse E2E antes da homologação.

Consequência para este checkpoint: a implementação (parser, persistência de HSD/HSS, `responderDisputa` com validação de `accept`/`reject`/`alternative`, `expiresAt`, idempotência e auditoria) está pronta e coberta por testes automatizados com dados sintéticos, mas **nenhuma disputa real foi observada ou fabricada** — nem artificialmente no banco, nem por um HSD forjado. O comando `ifood:order-action -- --acao dispute-status` já roda o polling real e lista as negociações do tenant; é o passo a usar assim que o iFood gerar o cenário na homologação assistida. Quando isso acontecer, a disputa chega pelo mesmo caminho já implementado (evento real → `aplicarHandshake` → `ifood_disputas`), sem mudança de código.
