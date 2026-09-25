# Incidente 25/09/2026 — respostas de clientes e confirmações de entrega/leitura não aparecem na Central

Registro do diagnóstico feito em produção (somente leitura), do que foi corrigido em código e do que NÃO é corrigível em código.
Produção permaneceu em modo `DISABLED` durante toda a investigação; nenhum UPDATE/DELETE/migration foi feito.

## 1. Resposta curta

Os dois sintomas têm causas diferentes (não misturar):

| Pipeline | Onde para | Causa | Corrigível em código? |
|---|---|---|---|
| A — resposta do cliente | **WhatsApp → gateway** (a mensagem nunca chega à aplicação) | o companion Baileys nunca termina o sync offline: nenhum nó "vivo" é entregue | Não (upstream/servidor). Exige decisão operacional (ver §5) |
| B — DELIVERED/READ | (1) mesma causa de A, para o evento em si; (2) **backend**, para envios manuais do Central | receipts eram correlacionados só na org da conexão do gateway; envio manual fica na empresa do responsável | (2) sim — corrigido nesta branch |

## 2. Evidência do pipeline A (resposta do cliente)

Perguntas do roteiro, com a etapa em que a mensagem desaparece:

1. Chegou ao gateway? **Não.** Em todas as gerações de socket (39 no processo anterior, 1..9 no atual) `nosVivosVistos = 0`.
2. Chegou ao backend? Não (o gateway nunca a emitiu).
3. Chegou ao banco? Não: `whatsapp_inbound_mensagens`, `comunicacao_inbox_mensagens` e `comunicacao_conversas` têm 0 linhas, sempre.
4. API da Central / DOM? Consequência: nada a mostrar.

Padrão repetido a cada conexão (logs do serviço `gateway-whatsapp`, eventos `inbound.*`):

- o servidor envia `offline_preview` com `count ≈ 15.9 mil` (≈ 6,7 mil mensagens, 7,8 mil receipts, 1,4 mil notificações);
- o Baileys 6.7.24 responde com **um único** `offline_batch count=100` (`node_modules/baileys/lib/Socket/socket.js:520-526`);
- chegam ~105 nós, todos com mais de 24 h; depois **silêncio**: `offlineFimRecebido=false`, `fase=OFFLINE_STALLED_OBSERVED`;
- o buffer de eventos do Baileys só é liberado no marcador `CB:ib,,offline` (`socket.js:547-555`; sem timeout de segurança), então `messages.upsert`, `messages.update` e `message-receipt.update` ficam retidos (`flushes=0`, `mensagensRetidas 28..43`);
- o WhatsApp derruba o socket a cada ~35–50 min e o ciclo recomeça; cada reconexão consome ~100 nós do backlog (15.987 → 15.894).

Não é regressão desta janela: o mesmo padrão aparece nos logs de 22/09 (epoch 26) e foi investigado antes (C.9 → G.4.1, `docs/gateway-whatsapp-offline-recovery-investigacao.md`). O `baileys@7.0.0-rc14` tem o mesmo comportamento.

Fatos verificados no código do gateway e do backend (o que aconteceria se o nó chegasse):

- texto de `@s.whatsapp.net` é encaminhado com `telefoneE164` e `texto`; `@lid` só ganha telefone se a chave trouxer `senderPn`; sem ele o backend ignora (`sem_telefone`);
- o backend casa o remetente com o roster por **E.164 exato** (`comunicacao.roster.js:92-96`): não há normalização do 9º dígito. Um contato salvo com 9 não casa com resposta sem 9 e vice-versa (nunca atribui ao contato errado). O contato usado no teste (13 caracteres, sem 9) casa com o JID canônico; o irmão de 14 caracteres não;
- o inbox descarta origem `OFFLINE_RECOVERY` e aceita `OFFLINE_NORMAL`/vivo; a persistência é idempotente por `(organizacao_id, provider_message_id)`.

## 3. Evidência do pipeline B (receipts)

- Eventos reais do Baileys 6.7.24 para status: `messages.update` (chat direto), `message-receipt.update` (grupo/status) e o `ws.ack` cru; todos exceto o ack cru passam pelo buffer do §2. O gateway também escuta `CB:receipt` cru, mas com o socket preso no sync offline o servidor não entrega nem os receipts vivos.
- Único evento de status recebido para a mensagem de teste: `ws.ack SERVER_ACK` (05:58:30Z), seguido de cinco `NAO_ENCONTRADA`.
- **Causa do NAO_ENCONTRADA (provada no banco):** a mensagem manual (`eac0bef8`) tem `organizacao_id = b1448c7b…` (empresa do responsável, escolhida em `enviarMensagem` por `contato.organizacoes[0]`); a rota `/eventos/status-provider` usa sempre a org da conexão (`WHATSAPP_GATEWAY_ORGANIZACAO_ID`, `00000000…`). As 5 saídas automáticas (org = conexão) têm `provider_ack` gravado; a manual não.
- Toda a cadeia SENT→DELIVERED→READ existe (gateway → rota → RPC 095 → coluna → API → UI); nunca foi exercitada com evento real. A API já devolve `entregueEm`/`lidoEm`; a UI só mostrava pontos/tooltip.

## 4. Correções desta branch (`fix/comunicacao-inbound-receipts`)

Somente código e testes; **sem migration, sem mudança de schema**.

1. **Receipts vinculados à origem do envio (contrato v2)** — decisão do dono do produto: NÃO aceitar lookup só por `provider_message_id` + HMAC.
   - Gateway (`entregaProvider.js`): quando conhece a instância (`WHATSAPP_PROVIDER_INSTANCE_ID`, padrão `default`) e a chave de correlação do envio (a `idempotencyKey` do pedido, guardada em `rastrear()`), emite `contratoStatus: 2` com `providerInstanceId` + `correlationId`; senão, o v1 legado. Se o backend recusar o v2 (400), reenvia UMA vez como v1: o rollout funciona em qualquer ordem de deploy (recomendado: backend primeiro).
   - Backend (`comunicacao.statusProvider.js`, rota, `whatsappGateway.repo.js`): v2 exige os dois campos (formato fechado); a rota confere a instância contra a configurada (divergência ⇒ `NAO_ENCONTRADA`, resposta idêntica a "não existe"); o repositório resolve a org do registro de saída que casa com `direcao='saida'` + `idempotency_key` (UNIQUE) + `provider_message_id` e chama o RPC 095 (inalterado) com ESSA org. v1 continua só na org da conexão.
   - O que cada peça prova, sem exagero: o que tem força real é o par `(idempotencyKey, providerMessageId)` de UM registro (chave baseada em UUID, não enumerável); a checagem de instância hoje é formalidade (há uma instância só, `default`, e o valor vem de payload já autenticado por HMAC) — só vira prova de origem se a instância for persistida na saída (coluna aditiva opcional, ver §7) ou houver chave HMAC por instância. Não afirmar "prova de mesma instância".
2. `gateway-whatsapp/src/entregaProvider.js` — a chave de dedupe do receipt é liberada quando os retries se esgotam sem o backend conhecer o id; antes, um reenvio legítimo do mesmo id+status era engolido como duplicado até reiniciar o processo.
3. `frontend` — a bolha mostra o último estado comprovado em texto: `Enviada`, `Entregue 03:00`, `Lida 03:02` (hora só do carimbo do próprio estado; "Lida" só com `READ`, que só o RPC de receipts real produz).
4. Testes: inbound ponta a ponta (backend, 27), formas de JID (gateway, 30), ordem/tenant de receipts (gateway 17 + backend), org do receipt (backend 15), rótulos de entrega (frontend 13).

## 5. O que falta e por que não é código

Enquanto o companion não sair do sync offline, nenhum nó vivo chega e portanto **nenhuma resposta e nenhum DELIVERED/READ real** aparecem, com ou sem as correções acima. A documentação G.4.1 proíbe, sem decisão explícita: ativar o recovery, repetir o dreno, forçar flush, limpar auth-state e QR/logout/re-pareamento.

Caminho recomendado (decisão do responsável pelo produto): **re-parear o companion** (novo registro sem backlog) e validar com o teste controlado da §6. Alternativas do doc §11: persistir antes do ACK, fork/upgrade do Baileys, investigação upstream, WhatsApp Business Cloud API.

## 6. Teste real controlado (a fazer depois da decisão do §5)

Contato autorizado de teste, modo `DISABLED`, um envio manual pelo Central:

1. observar `SENT` e o horário; 2. receber no aparelho; 3. responder no WhatsApp; 4. conferir no gateway `nosVivosVistos > 0`, `offlineFimRecebido=true`, `flushes > 0` e `provider_receipt_persistido`; 5. conferir a resposta na mesma conversa da Central; 6. ler a mensagem no aparelho e conferir `DELIVERED`/`READ` no banco e na UI (com horário); registrar os timestamps entre as etapas. Se o contato tiver leitura desativada, o estado correto é `Entregue`.

## 7. Latentes registrados (não corrigidos)

- 9º dígito / duplicidade "Jailton Matos" (dois `contatos_whatsapp`, mesmo perfil): matching exato; proposta futura sem migration: candidatos por variantes com/sem 9º dígito, escolher o contato com a saída mais recente, nunca mesclar, gravar o tipo de match. Histórico preservado.
- `@lid` sem `senderPn` é ignorado (`sem_telefone`): observar no teste vivo.
- Persistir `provider_instance_id` na saída (coluna aditiva nullable, escrita junto com `provider_message_id`) transformaria a checagem de instância em comparação com estado gravado; opcional, exige migration aditiva.
- A `idempotencyKey` aparece nos logs do gateway e como `envio_id` para quem lê a conversa: quem tiver log + segredo HMAC forjaria recibo só daquela mensagem (efeito limitado e monotônico). Mascarar a chave nos logs é melhoria pendente.
- Mensagens agendadas ficam atrasadas enquanto o modo é `DISABLED` (2 pendentes em 25/09): decidir antes de voltar a `NORMAL`.
