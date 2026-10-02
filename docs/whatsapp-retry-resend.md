# WhatsApp — reenvio sob retry receipt ("Aguardando mensagem")

Status: implementado localmente, com a flag **desligada** por padrão. A migration 105 ainda **não** foi aplicada em nenhum banco.
Branch: `fix/whatsapp-retry-resend`.

## 1. Problema comprovado

Quando um aparelho destinatário não consegue decifrar uma mensagem nossa, o WhatsApp mostra *"Aguardando mensagem.
Essa ação pode levar alguns instantes."* e o aparelho envia um **retry receipt**. No Baileys 6.7.24, o tratamento é este (`lib/Socket/messages-recv.js`, `handleReceipt` → `sendMessagesAgain`):

1. força uma sessão Signal nova com o aparelho (`assertSessions([participant], true)`);
2. chama `config.getMessage(key)` para obter o **conteúdo** original;
3. só reenvia se receber esse conteúdo de volta.

O padrão do pacote é `getMessage: async () => undefined`. O Gateway nunca configurou essa função, então o reenvio não acontecia e o destinatário ficava preso para sempre. O próprio tipo do pacote documenta isso: *"implement this so that messages failed to send (solves the 'this message can take a while' issue) can be retried"*.

Evidência em produção (auditoria de 02/10/2026): depois de cada alerta aparece um `libsignal.session_fechada` sem a linha "incoming prekey bundle", entre 0,5 e 1,5 s depois do envio. Essa é a assinatura exclusiva do passo 1.

## 2. Contrato do `getMessage` no 6.7.24 (lido do código instalado)

| Item | Valor |
|---|---|
| Assinatura | `getMessage(key: proto.IMessageKey) => Promise<proto.IMessage \| undefined>` |
| `key.remoteJid` | `attrs.from` (o aparelho que pediu, às vezes com sufixo `:N`, às vezes LID), ou `attrs.recipient` quando o pedido vem de um aparelho da nossa própria conta |
| `key.participant` | `attrs.participant \|\| attrs.from` |
| `key.fromMe` | `true` para retry de mensagem nossa (só esse caso chega a `sendMessagesAgain`) |
| Retorno | o **conteúdo** (`WebMessageInfo.message`), que o Baileys passa direto a `relayMessage(key.remoteJid, msg, { messageId, participant })` |
| Limite | `msgRetryCounterCache` por `${id}:${participant}`, até `maxMsgRetryCount` (5). O padrão é um NodeCache de 1 h **por socket** |

## 3. Arquitetura

```
enviar() ─ marcarEnvioIniciado(id) ─ sendMessage (real) ─ registrarEnvio(fullMsg.message)
                                                           │ memória (síncrono, libera o getMessage em espera)
                                                           └ POST /internal/comunicacao/eventos/retry-cache  (cifrado, fenced)
retry receipt ─ Baileys ─ getMessage(key) ─ memória? ─ POST …/retry-cache/consumir (atômico, conta 1 reenvio)
                                      └ decifra (AAD) ─ confere o destino (HMAC) ─ proto.Message ─ Baileys reenvia
```

- **Fonte da verdade:** o banco (`whatsapp_retry_cache`, migration 105), acessado pelo backend via HMAC e com fencing pela lease.
- **Cache:** a memória do processo. Ela cobre a janela de cerca de 1 s entre o envio e a gravação e também uma queda curta do backend.
- Restart, reconnect e deploy não afetam o resultado: o banco continua respondendo.
- O que é guardado: os bytes de `proto.Message.encode(fullMsg.message)`, exatamente o que foi cifrado no primeiro envio. Para um alerta de texto, são cerca de 70 a 300 bytes.
- Um envio **nunca** falha por causa do cache. Toda chamada ao cache fica dentro de `try`, e a gravação é assíncrona.

## 4. Segurança

- **Cifra:** AES-256-GCM no Gateway, com subchave HKDF-SHA256 (`crescer/whatsapp/retry-cache/payload/v1`) da mesma chave mestra (`WHATSAPP_AUTH_ENCRYPTION_KEY`). Não é preciso criar env nova. A chave do auth state não decifra o cache, e vice-versa.
- **IV:** 12 bytes aleatórios a cada cifragem. Há teste provando que a mesma mensagem cifrada duas vezes gera IV e ciphertext diferentes.
- **AAD:** `r1|<instância>|<providerMessageId>`. Se o payload de uma linha for trocado pelo de outra no banco, a decifragem falha.
- **Destino:** é guardado como HMAC (subchave `…/destino/v1`) do usuário PN e, quando o `onWhatsApp` informa, também do LID. O conteúdo **nunca** é reenviado a outro usuário:
  - PN precisa bater;
  - LID precisa bater quando é conhecido;
  - grupo, status e outros tipos são sempre recusados.
  - Usamos HMAC, e não hash simples, porque telefone tem pouca entropia e um hash simples seria revertido por força bruta.
- **Formato** `r1:` distinto do `v1:` do auth state. O `logsafe` mascara os dois.
- **Logs:** só tipos (PN/LID/GROUP/OUTRO/NONE), contagens e `idHash` (12 caracteres hex do sha256). Nunca aparecem telefone, JID, texto, payload, chaves ou QR. Há testes que verificam isso.
- **Backend:** nunca decifra nada. Valida o formato na fronteira (400 com o nome do campo, sem ecoar o valor), e o banco repete as mesmas regras em CHECKs. O payload só sai para o dono atual da lease, pelo canal HMAC.

## 5. TTL: 7 dias (configurável de 1 h a 30 dias)

| Fato | Fonte |
|---|---|
| Retries chegam 0,5–1,5 s após o envio | Logs de produção (29/09, 30/09, 02/10) |
| Rajadas de retry 2–28 min depois | 30/09 13:33, 29/09 18:10, 02/10 13:51/13:58 |
| Rajada às 12:03 de 02/10 sem envio no intervalo (o envio anterior mais próximo foi em 30/09 23:09, cerca de 37 h antes) | Logs |
| Um aparelho offline recebe as mensagens pendentes quando volta e **só então** pede o retry | Comportamento do protocolo |
| O `msgRetryCounterCache` do Baileys expira em 1 h, mas isso **não** limita *receber* um retry depois | `DEFAULT_CACHE_TTLS.MSG_RETRY` |

Por que 7 dias:
- cobre o maior intervalo observado (cerca de 37 h) com folga para fim de semana ou feriado com o aparelho desligado;
- limita a exposição do conteúdo, mesmo cifrado;
- alerta operacional perde valor depois de dias.

O teto de 30 dias acompanha o horizonte em que o WhatsApp ainda entrega mensagens pendentes.

**Teto de reenvios:** 15 por mensagem (5 por aparelho × ~3 aparelhos), configurável de 1 a 50. Ele é atômico no banco e serve de reforço ao contador do Baileys.

**Limpeza:**
- cada gravação apaga até 200 linhas expiradas;
- `whatsapp_retry_cache_limpar(limite)` existe para um job;
- uma linha expirada nunca é devolvida, mesmo antes de ser apagada.

## 6. `msgRetryCounterCache`: alterado (escopo de processo)

- **Antes:** um NodeCache novo **por socket**. O Gateway reconecta cerca de 10 vezes por dia (fechamentos 428/503, `socketGeneration` 54 em uma semana), e cada reconexão zerava os contadores.
- **Agora:** um `CacheStore` (get/set/del/flushAll) com o **mesmo TTL** do padrão (1 h), compartilhado entre os sockets do processo.
- **Por que é seguro:** a chave é `${msgId}:${participant}`, escopo de **mensagem**, não de socket. O limite de 5 passa a valer de fato por mensagem e aparelho, e não "5 por conexão".
- Só entra no socket com a flag ligada. Desligada, o Baileys usa o próprio cache, como antes.

## 7. `userDevicesCache`: NÃO alterado

O Baileys 6.7.24 **não invalida** esse cache ao receber notificação de aparelhos (`case 'devices'` em `messages-recv.js` só registra log). O único limite é o TTL de 5 minutos.

Compartilhar o cache entre sockets:
1. quase não traria ganho, porque as reconexões acontecem a cada 1–2 h e o TTL é de 5 min;
2. tiraria a renovação natural que acontece a cada reconexão;
3. uma lista de aparelhos desatualizada é justamente uma das causas possíveis de "Aguardando mensagem" (um aparelho novo do destinatário que não recebe a cópia cifrada).

Além disso, o reenvio para o aparelho primário (`sendToAll`) já ignora o cache (`useUserDevicesCache = false`). Por isso o cache fica como está.

## 8. Feature flag e configuração (Gateway)

| Env | Padrão | Efeito |
|---|---|---|
| `WHATSAPP_RETRY_RESEND_ENABLED` | desligado | Desligada: o socket é criado **idêntico** ao de antes (sem `getMessage`/`msgRetryCounterCache`) e nada é gravado. A observação passiva continua ligada. |
| `WHATSAPP_RETRY_CACHE_TTL_HORAS` | 168 | 1–720; um valor inválido faz o boot falhar |
| `WHATSAPP_RETRY_MAX_REENVIOS` | 15 | 1–50; um valor inválido faz o boot falhar |

Ligar ou desligar exige só a env e um restart. Não há migration nem rollback de banco.

## 9. Observabilidade (sempre ligada, sanitizada)

| Evento | Quando | Campos |
|---|---|---|
| `whatsapp.retry.received` | chega um retry receipt (leitura passiva do `CB:receipt`) | `idHash`, `remoteJidType`, `participantType`, `recipientType`, `dispositivo` (primario/companion), `deContaPropria`, `fromMe`, `retryCount`, `comChaves`, `offline`, `mensagemConhecida`, `habilitado`, `socketGeneration` |
| `whatsapp.retry.message_found` | `getMessage` acertou | o mesmo, mais `fonte` (banco/memoria_*), `destinoVerificado`, `reenvios` |
| `whatsapp.retry.message_missing` | `getMessage` não serviu | `motivo` (nao_encontrada, expirada, destino_divergente, sem_lease, backend_indisponivel, desligado, …) |
| `whatsapp.retry.resend_requested` | o conteúdo foi devolvido ao Baileys | — |
| `whatsapp.retry.resend_sent` | o Baileys de fato enviou a stanza (`sending message to N devices` com o id em curso) | `dispositivos` |
| `whatsapp.retry.resend_failed` | `error in sending message again` | `idHash` |
| `whatsapp.retry.exhausted` | teto do cache, ou `will not send message again…` do Baileys | `fonteLimite` |
| `whatsapp.retry.cache_registrado` / `cache_persistido` / `cache_persistencia_falhou` / `cache_nao_registrado` | ciclo de gravação | `bytes`, `classe`, `causa`, `capacidadeAusente` |
| `whatsapp.retry.metricas` | a cada 5 min, se algo mudou, e no shutdown | contadores + `cacheHitRate` |

As **métricas** também saem em `GET /internal/whatsapp/retry/metricas` (HMAC, `no-store`): `retryRecebido`, `getMessageChamado`, `cacheHit`, `cacheMiss`, `reenvioSolicitado`, `reenvioEnviado`, `reenvioFalhou`, `esgotado`, `cacheHitRate`, `hitBanco`, `hitMemoria`, `destinoDivergente`, `lidNaoVerificado`.

O `send_start` passou a trazer `idHash`, o mesmo dos eventos de retry, e `destinoLidConhecido`. Isso correlaciona cada envio com o retry correspondente.

**PN/LID (para investigar o primeiro erro):**
- `remoteJidType` + `participantType` + `dispositivo` + `deContaPropria` dizem quem pediu o retry e em qual endereçamento;
- `destinoLidConhecido` (no envio) e `destinoVerificado` / `lidNaoVerificado` (no hit) dizem se o destinatário já aparece como LID.

## 10. Rollout (sem derrubar a sessão)

1. **Banco:** aplicar a migration 105, que é aditiva e não toca `whatsapp_conexoes`.
2. **Backend:** deploy com as rotas novas. Com o Gateway antigo, elas ficam sem uso.
3. **Gateway:** deploy com a flag **desligada**. O socket fica idêntico ao atual e passa a emitir `whatsapp.retry.received`, o que dá a medição do "antes". O handover pela lease preserva a sessão, sem QR.
4. Ligar `WHATSAPP_RETRY_RESEND_ENABLED=true` e reiniciar o Gateway. Validar primeiro com um número de teste (seção 12).
5. Acompanhar `cacheHitRate`, `reenvioEnviado` e a queda de `READ` ausente/"Aguardando" nos destinatários.

## 11. Rollback

- **Imediato:** desligar a flag e reiniciar. O socket volta exatamente ao comportamento anterior. Não há mudança de banco.
- **Completo:** aplicar `105_rollback.sql`, que remove só a tabela e as funções do cache. A sessão, o auth state e as credenciais não são tocados (há teste em Postgres real provando isso).

## 12. Teste com número de teste (manual, antes dos clientes)

Provocar o "Aguardando mensagem" de propósito exige que um aparelho destinatário **perca a sessão** com o nosso. O caminho mais confiável:

1. Use um celular de teste (destinatário) com WhatsApp e **um aparelho vinculado** (WhatsApp Web/Desktop).
2. Deixe o aparelho vinculado **desligado** (feche o navegador ou o app Desktop).
3. Pela Central, envie um alerta de teste para esse número.
4. No aparelho vinculado: **desvincule e vincule de novo** (gera chaves novas) e só então abra a conversa.
5. Esperado com a flag **desligada**: "Aguardando mensagem" no aparelho vinculado. Com a flag **ligada**: a mensagem aparece depois de alguns segundos. Nos logs: `whatsapp.retry.received` → `message_found` → `resend_sent`.

## 13. Testes

- `gateway-whatsapp/test/retryCache.test.js`: itens 1–6 e 8–12 do checkpoint, mais robustez, segurança, logs e métricas.
- `gateway-whatsapp/test/baileysSession-retry.test.js`: item 4 (o socket recriado ainda serve a mensagem), equivalência com a flag desligada, e a garantia de que o envio nunca cai por causa do cache.
- `gateway-whatsapp/test/retryResendReal.test.js`: **Baileys real** com Signal real. Envio → aparelho perde a sessão → retry → getMessage HIT → reenvio → **o aparelho decifra o mesmo texto**. Inclui o controle negativo (flag desligada = preso) e o restart do processo.
- `backend/test/whatsapp-retry-cache-routes.test.js`: rotas, item 7 (isolamento entre organizações), idempotência, teto, TTL, limpeza, fencing, validação, e o **contrato real Gateway↔Backend** (HTTP + HMAC + cifra).
- `backend/test/whatsapp-retry-cache-migration-pg.test.js`: a migration 105 em **Postgres real e descartável**, incluindo a prova de que `whatsapp_conexoes`/auth state não mudam e que o rollback é seguro.
