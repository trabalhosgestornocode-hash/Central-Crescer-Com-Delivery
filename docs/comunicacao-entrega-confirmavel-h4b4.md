# H.4-B.4 — Entrega confirmável do WhatsApp

Contexto: o 1º outbound real terminou em `SENT` sem que o destinatário recebesse, e nada persistia `DELIVERED`/`READ`
(`registrarStatusProvider` era um stub). Este checkpoint corrige a **infraestrutura**; não envia nada, não habilita empresa,
não muda `modo` (permanece `DISABLED`). O próximo envio real é um checkpoint separado.

## 1. Semântica dos status (enum do banco NÃO renomeado)

| Status | Significa | Significa **NÃO** |
|---|---|---|
| `SENT` | enviado/aceito pelo provider **local**: `socket.sendMessage()` resolveu (o stanza foi escrito no socket; o id `3EB0…` é gerado localmente) | entregue, nem sequer aceito pelo servidor do WhatsApp |
| `DELIVERED` | confirmação de entrega (receipt do WhatsApp) | — |
| `READ` | confirmação de leitura | — |
| `DELIVERY_UNKNOWN` / `FAILED` | inalterados (088/087) | — |

Na UI, `SENT` deve aparecer como **"Enviado ao WhatsApp"** (ou "Enviado ao provedor"), nunca como "Entregue".

## 2. Eventos do Baileys 6.7.24 (código instalado em `gateway-whatsapp/node_modules/baileys`)

"Significado comprovado" = comprovado **no código instalado** e por testes com nós sintéticos no socket Baileys real
(`gateway-whatsapp/test/entregaBufferReal.test.js`). **Nenhum receipt real do WhatsApp foi observado ainda** — o mapeamento é o do
Baileys, não uma garantia do protocolo.

| EVENTO | CAMPO | VALOR/ACK | SIGNIFICADO COMPROVADO | STATUS INTERNO RESULTANTE |
|---|---|---|---|---|
| nó `<ack class="message">` (`ws.on("CB:ack,class:message")`) | `attrs.error` ausente | — | o servidor respondeu ao stanza enviado. O Baileys **não emite evento** para isto (`handleBadAck` só trata `attrs.error`); observado direto no `ws` | `SERVER_ACK` → só `metadados.provider_ack.servidor_em` (status segue `SENT`) |
| nó `<ack class="message">` | `attrs.error` = código | ex. `479` | rejeição/erro do servidor. O Baileys emite `messages.update {status: 0 (ERROR), messageStubParameters:[error]}` | `PROVIDER_ERROR` → só `metadados.provider_erro` (status **não** muda — decisão de produto pendente) |
| `messages.update` (chat direto) | `update.status` | `2` `SERVER_ACK` | vem de `<receipt type="sender">` (`STATUS_MAP`) | `SERVER_ACK` (metadados) |
| `messages.update` | `update.status` | `3` `DELIVERY_ACK` | `<receipt>` **sem** `type` (`getStatusFromReceiptType(undefined)`): entrega ao aparelho | `DELIVERED` |
| `messages.update` | `update.status` | `4` `READ` | `<receipt type="read"|"read-self">` | `READ` (só se `key.fromMe !== false`; `read-self` = outro aparelho **nosso** leu — ignorado no leitor de `ws`) |
| `messages.update` | `update.status` | `5` `PLAYED` | `<receipt type="played">` | `READ` |
| `message-receipt.update` (grupo/status) | `receipt.receiptTimestamp` | segundos | receipt de um participante sem `type` | `DELIVERED` |
| `message-receipt.update` | `receipt.readTimestamp` | segundos | leitura por um participante | `READ` |
| `<receipt>` | `type` | `retry`, `inactive`, `hist_sync`, … | `STATUS_MAP` não os mapeia ⇒ **nenhum** evento de status | — (ignorado) |
| `messages.upsert` | — | — | mensagens recebidas; não é status | — |
| `connection.update` | `connection`, `receivedPendingNotifications` | — | estado do socket / fim da fila offline; **sem** informação de entrega | — |

Notas: (a) `messages.update`/`message-receipt.update` são **bufferáveis** (`BUFFERABLE_EVENT`); (b) para um recibo de chat direto,
`key.remoteJid` pode ser LID e a correlação é feita **só por `key.id`**; (c) não há timestamp em `messages.update` — o `ocorridoEm`
é o relógio do Gateway (limitado pelo banco a `[enviado_em, now()]`).

## 3. Correlação

`provider_message_id` = `key.id` da mensagem enviada. Para eliminar a corrida "o receipt chega antes de o backend gravar o id", o
Gateway **pré-gera o id** com a mesma função do Baileys (`generateMessageIDV2`), rastreia-o **antes** do `sendMessage` e o passa como
`messageId`. Só ids rastreados por este processo são reportados (o Baileys emite recibo de TODA mensagem de saída da conta, inclusive as
enviadas do celular do dono). Efeito colateral aceito: recibo de mensagem enviada por um processo que já reiniciou é descartado (fica
`SENT`). No backend a chave é `(organizacao_id, provider_message_id, direcao='saida')`; 0 linhas ⇒ `NAO_ENCONTRADA`, >1 ⇒ `AMBIGUA`
(nada é alterado). O Gateway faz retry limitado (1 s, 3 s, 10 s, 30 s) quando o backend responde `NAO_ENCONTRADA` (o backend grava o
id **depois** do `sendMessage`).

## 4. Persistência — migration 095

RPC `comunicacao_registrar_status_provider(org, provider_message_id, status, ocorrido_em, erro_codigo)`; atômica (`for update`),
idempotente e **monotônica**:

```
SENT → DELIVERED → READ        SENT → READ permitido (READ preenche entregue_em)
sem regressão (READ→DELIVERED, DELIVERED→SENT, READ→SENT); evento repetido = no-op
```

Só altera mensagens de saída em `SENT/DELIVERED/READ`; qualquer outro estado (SENDING, DELIVERY_UNKNOWN, FAILED, CANCELLED…) nunca é tocado
por receipt (`ESTADO_NAO_ELEGIVEL`). `SERVER_ACK`/`PROVIDER_ERROR` só em `metadados`. A propagação ao alerta é do trigger existente
(088/092): não sobrescreve `RESOLVED`/`CANCELLED` e **ignora** mensagem com `metadados.proposito='reforco'` (a proteção da 092 permanece).

## 5. Canal Gateway → backend

Reutiliza `POST /internal/comunicacao/eventos/status-provider` (HMAC + anti-replay do `exigirHmac`, montado antes de `requireAuth`);
**nenhuma rota pública nova**, nenhuma autenticação paralela. Contrato estrito (`comunicacao.statusProvider.js`): chaves fechadas
(`contratoStatus, providerMessageId, status, ocorridoEm?, ackTipo?, erroCodigo?`), 400 com código fechado, `organizacao_id` vem da config
do backend (nunca do payload). O formato numérico antigo do Gateway é recusado com 400 (o Gateway antigo só loga aviso).

## 6. Buffer offline (C.9) × receipts — evidência por execução

Prova com o socket Baileys real (`entregaBufferReal.test.js`; **sem** recovery, **sem** flush manual):

| Pergunta | Resposta |
|---|---|
| A) receipt live entra no buffer? | Só quando o nó vem **tagueado `offline`** (fila offline) e o buffer está ativo. Um nó **vivo** (sem `offline`) passa por `processNodeWithBuffer`: `buffer()` → handler → `flush()` |
| B) `messages.update` entra? | Sim (é bufferável) — mesma regra |
| C) `message-receipt.update` entra? | Sim — mesma regra |
| D) é descartado? | Não; fica retido |
| E) chega ao handler depois? | Sim: no `CB:ib,,offline` (fim da fila) **ou** quando qualquer nó vivo é processado (esse flush libera também o retido) |
| F) fica retido para sempre? | Só se nunca vier nem o marcador nem um nó vivo — situação observada nesta conta (o marcador não chega; C.9→G.4.1). |

Conclusão: o buffer **não bloqueia** um receipt vivo. O que não se sabe (não há acesso ao servidor) é se o WhatsApp entrega o receipt de
uma mensagem nova como nó vivo ou tagueado `offline` enquanto a fila offline não termina. Para não depender disso, o Gateway lê o **nó
cru no `ws`** (`CB:receipt`, `CB:ack,class:message`) — leitura pura, sem ack/flush/alteração do buffer, só ids rastreados —, com dedupe
contra o evento do Baileys. **Recovery permaneceu OFF**; nenhuma env foi alterada.

## 7. Destinatário — JID canônico

`socket.onWhatsApp(digitos)` (usync `contact`): existe ⇒ `[{jid, exists:true, lid?}]` com o **jid que o servidor respondeu**; não existe ⇒
`[]` (o Baileys filtra `contact=out`); falha ⇒ rejeita; resposta não-`result` ⇒ `undefined`. O Gateway consulta **antes** do
`sendMessage` e usa o JID devolvido (nunca o concatenado). **Fail-closed**: sem confirmação, não envia.

| Situação | Código do Gateway | Classificação no backend |
|---|---|---|
| não existe / `exists:false` | `WHATSAPP_GATEWAY_RECIPIENT_NOT_ON_WHATSAPP` | PERMANENTE (nada saiu) |
| retorno inesperado, >1 resultado, JID de LID/dispositivo/grupo, ou incoerente com o número | `…_RECIPIENT_UNVERIFIED` | PERMANENTE (nada saiu) |
| erro/timeout (10 s)/resposta vazia | `…_RECIPIENT_LOOKUP_FAILED` | RETRYAVEL (nada saiu) |

**9º dígito (Brasil): nenhuma heurística** de adicionar/remover. A única autoridade é a resposta do WhatsApp; a checagem de coerência
(últimos 8 dígitos iguais) só impede aceitar uma resposta que aponte para **outra pessoa**. O log traz só o JID mascarado e
`jidDifereDoPedido`.

## 8. Logs (sanitizados: sem telefone completo, conteúdo, auth state ou segredo)

`send_bloqueado_destinatario`, `send_start`, `send_resolved`, `send_falhou` (campos: `correlationId` = idempotencyKey, `providerMessageId`,
`jid` mascarado, `socketGeneration`, `leaseEpoch`, `lookupMs`/`durationMs`), `provider_receipt_received` (`fonte`, `ackTipo`,
`statusInterno`, `ocorridoEm`, `remoteJidTipo`, `latenciaDesdeEnvioMs`, `socketGeneration`), `provider_receipt_persistido`,
`provider_receipt_nao_aplicado`, `provider_receipt_entrega_esgotada`, `provider_receipt_rejeitado_contrato`,
`provider_receipt_nao_rastreado` (agregado, no máx. 1/min). O `mensagemId` interno não chega ao Gateway (só a `idempotencyKey`).

## 9. Limites conhecidos

- Retry de entrega do receipt é em memória; reinício do processo no meio perde o retry (status histórico segue `SENT`).
- `PROVIDER_ERROR` não muda o status (decisão de produto: hoje só evidência em `metadados`).
- A hipótese "o 1º envio foi para um JID inexistente (9º dígito)" **não foi verificada**; esta entrega elimina a incerteza no próximo envio.
- Sem receipts reais observados até aqui: a validação ponta a ponta com WhatsApp real é o próximo checkpoint.
