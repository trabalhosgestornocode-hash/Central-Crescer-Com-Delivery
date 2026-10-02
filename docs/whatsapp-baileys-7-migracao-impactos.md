# Impactos potenciais da migração Baileys 6.7.24 → 7.x

**Nota técnica: nada aqui foi implementado.** O Gateway continua no 6.7.24.

Fontes:
- [guia oficial de migração v7](https://baileys.wiki/migration/v7)
- [guia de migração (Mintlify)](https://www.mintlify.com/whiskeysockets/baileys/migration)
- [releases do pacote](https://github.com/WhiskeySockets/Baileys/releases)

Todo item abaixo precisa ser reconferido no código da versão-alvo **instalada** antes de qualquer mudança.

## Por que isso importa para nós

A auditoria de 02/10/2026 encontrou sinais de endereçamento misto PN × LID:
- o ack do servidor chega como `pn`, mas o DELIVERED chega como `lid`;
- as respostas dos contatos chegam como `direct_lid_other`;
- falhas de decrypt `direct_lid_self` 9/9 e `fromMe` 174/405.

O 6.7.24 guarda a sessão Signal por `user.device`, **descartando o domínio** (`lib/Signal/libsignal.js#jidToSignalProtocolAddress`). Ele **não tem** mapeamento PN↔LID. A hipótese PN/LID para o primeiro erro de decrypt continua aberta; a observabilidade do checkpoint "Retry Resend" foi feita para prová-la ou descartá-la.

## Mudanças da v7 e impacto no Crescer

| Mudança da v7 | Impacto no nosso código | Risco |
|---|---|---|
| O auth state precisa suportar as chaves **`lid-mapping`**, **`device-list`** e **`tctoken`** (`SignalDataTypeMap`) | `gateway-whatsapp/src/authState.js` usa adaptador próprio: blob monolítico, tipos de chave abertos (`keysPorTipo[tipo]`). Ele aceita tipos novos, mas o **tamanho do blob** cresce (mapeamentos e listas de aparelhos), o que afeta o teto de 1 MiB / `authHeadroom.js` e a telemetria `authMetrics.js` (categorias conhecidas) | ALTO |
| **Migração unidirecional** das sessões Signal para o formato LID na primeira abertura | Um rollback para a 6.x depois de abrir com a 7.x pode deixar sessões incompatíveis. Exige **backup do `auth_state_encrypted`** (e da geração `auth_session_id`) antes e um plano de restauração fenced. Hoje o reset é a única via de "voltar", e ele exige QR novo | ALTO |
| `onWhatsApp()` **não devolve mais LID**; usar `signalRepository.lidMapping.getLIDForPN/getLIDsForPNs/getPNForLID` | `src/destinatario.js` (validação do destinatário e o `lid` usado pelo cache de retry) e `src/retryCache.js#verificarDestino` precisam passar a obter o LID pelo mapeamento | MÉDIO |
| `isJidUser` **removido** (passa a ser `isPnUser`) | `src/inboundScope.js#classificarJid`, `src/retryCache.js#tipoJid` e os testes de contrato que importam helpers | BAIXO (mecânico) |
| `MessageKey` ganha `remoteJidAlt` / `participantAlt` | O inbound (`inboundContrato.js#extrairTelefoneReal`) pode usar o PN alternativo em vez de heurística. O `getMessage` pode receber a chave com campos novos (ignorar com segurança) | MÉDIO (oportunidade) |
| `Contact` unifica `jid`/`lid` em `id` (+ `phoneNumber` quando o id é LID) | `identidadeDe(me)` e o `perfilConta()` da aba Conexão | BAIXO |
| `GroupMetadata` ganha pares `*Pn` | Não usamos grupos (escopo de envio é só direto) | BAIXO |
| Para de enviar ACK de entrega com sucesso (contas que faziam isso foram banidas) | Muda a semântica observada por `entregaProvider.js` e os testes `entregaBufferReal`/`receipts-*`. É preciso revalidar SERVER_ACK/DELIVERED/READ | MÉDIO |
| Só ESM | O Gateway já é ESM (`"type": "module"`) | NENHUM |
| Protobuf: só `.create()/.encode()/.decode()`; **`.fromObject()` removido**; novo `decodeAndHydrate()` | `src/retryCache.js` usa `proto.Message.fromObject` (fallback quando o conteúdo não é instância) e `proto.Message.decode`. O harness de teste e outros testes usam `fromObject`/`toObject` | MÉDIO (mecânico, com testes) |
| Evento novo `lid-mapping.update` | Persistir os mapeamentos (já cobertos pelo auth state se o tipo `lid-mapping` for guardado) e observar de forma sanitizada | BAIXO |

## Pontos que dependem de código interno (precisam de releitura na versão-alvo)

- O contrato de `getMessage` / `sendMessagesAgain` / `msgRetryCounterCache` / `maxMsgRetryCount`. O cache de retry depende dele, e os testes `retryResendReal.test.js` exercitam o pipeline real, então rodá-los contra a 7.x é o primeiro passo.
- `addTransactionCapability` (commit das chaves depois do `sendNode`) e a semântica de erro de `keys.set`. O adaptador `authState.js` assume o comportamento do 6.7.24.
- `userDevicesCache` e a invalidação por notificação `devices` (no 6.7.24 ela não existe).
- A mensagem exata dos logs internos que `retryCache.envolverLogger` observa (`sending message to N devices`, `error in sending message again`, `will not send message again, as sent too many times`, `recv retry for not fromMe message`). Se o texto mudar, os eventos `resend_sent`/`exhausted` param de ser emitidos (o `getMessage` em si continua funcionando).
- `libsignal` (fork e commit) e as mensagens de console que `libsignalLogGuard.js` desvia. O teste-canário já falha se elas mudarem.

## Sequência sugerida (quando for decidido migrar)

1. Ligar o cache de retry na 6.7.24 e coletar uma a duas semanas de `whatsapp.retry.received` (`remoteJidType`/`participantType`/`dispositivo`), para confirmar ou descartar PN/LID com dados.
2. Branch de migração: subir a versão, rodar toda a suíte do Gateway (os testes com Baileys real são os sensores) e ajustar `destinatario.js`, `tipoJid`/`classificarJid`, `fromObject` e o adaptador de auth para os tipos novos.
3. Medir o crescimento do blob com `WHATSAPP_AUTH_METRICS_ENABLED` em ambiente de teste.
4. Backup do `auth_state_encrypted` (somente leitura, cifrado) antes da primeira abertura com a 7.x. Definir e testar o caminho de restauração.
5. Rollout com número de teste primeiro e janela de observação. Rollback só com o backup (a migração de sessões é unidirecional).
