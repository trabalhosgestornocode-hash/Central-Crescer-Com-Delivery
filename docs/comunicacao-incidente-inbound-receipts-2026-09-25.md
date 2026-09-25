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

1. `backend/.../whatsappGateway.repo.js` — `registrarStatusProvider` resolve a org pelo registro de saída que carrega o id do provider (`escolherOrganizacaoDaSaida`): um dono ⇒ ele; vários ⇒ só a da conexão; senão `NAO_ENCONTRADA` (o RPC não é chamado); lote saturado (≥20) ⇒ ambíguo. O RPC 095 continua exigindo org + id + `direcao='saida'`. **Muda uma regra de tenant deliberada** (o teste antigo "uma mensagem de OUTRA organização não é alcançada" foi substituído): precisa de aprovação explícita antes de publicar.
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
- Consulta por `provider_message_id` sem `organizacao_id` não usa o índice da 095 (tabela pequena hoje); índice parcial é opcional.
- Mensagens agendadas ficam atrasadas enquanto o modo é `DISABLED` (2 pendentes em 25/09): decidir antes de voltar a `NORMAL`.
