# Gateway WhatsApp — escopo de inbound (C3.5-C.9.3)

## Decisão de produto (invariante)

O WhatsApp do Crescer com Delivery **não é somente outbound**. Mensagens **diretas de clientes** devem
permanecer disponíveis para: respostas a alertas, consentimento/opt-out (`contatos_whatsapp.opt_out`),
o futuro **Agente Crescer** e handoff humano. Nenhuma política de inbound pode fechar essa porta.

## Por que existe

Telemetria de produção (C.9.2): a cada reconexão o servidor reentrega as mensagens offline e o Baileys
tenta decifrar tudo — dezenas de `Bad MAC` de sessão 1:1, novas sessões (inclusive as de participantes de
grupo, que carregam a *SenderKeyDistribution*), sender-keys e pré-chaves de retry. O auth state cresce com isso.

## Mecanismo (Baileys 6.7.24, código instalado)

`config.shouldIgnoreJid(jid)` é consultado no **primeiro passo** de `handleMessage`
(`Socket/messages-recv.js`, antes de `decryptMessageNode`), de `handleReceipt`, de `handleNotification` e das
presenças. Ignorar = **só ACK e return**: nenhum decrypt, sessão, sender-key, pré-chave de retry ou Bad MAC. O ACK
também tira a stanza da fila offline do servidor (não é reentregue a cada reconexão). O JID técnico
`@s.whatsapp.net` nunca é ignorado pelo Baileys. Pareamento, restore de auth, lease e mensagens de protocolo do
próprio aparelho (`from` = nosso JID, um chat direto) não passam por nenhum filtro de tipo.

Cuidado provado no harness: passar `shouldIgnoreJid: undefined` **sobrescreve** o default do Baileys
(`{...DEFAULT_CONNECTION_CONFIG, ...config}`) e quebra todo o recebimento (`shouldIgnoreJid is not a function`).
`criarInboundGateway().opcoesSocket()` devolve `{}` quando nada deve mudar.

## Tipos de JID (helpers oficiais de `WABinary/jid-utils.js`)

| tipo | helper | receber? | justificativa |
|---|---|---|---|
| `direct_pn` — chat direto (PN `@s.whatsapp.net`) | `isJidUser` | **SIM** | clientes, opt-out, Agente Crescer |
| `direct_lid_self` / `direct_lid_other` — chat direto (LID `@lid`; C.9.4 separa o LID do próprio usuário autenticado do de terceiros) | `isLidUser` | **SIM** | mesma conversa, endereçada por LID |
| `group` — grupo `@g.us` | `isJidGroup` | NÃO (v1) | nenhum uso no produto; gera sessão+sender-key |
| `status` — `status@broadcast` | `isJidStatusBroadcast` | NÃO (v1) | idem |
| `broadcast` — lista de transmissão `@broadcast` | `isJidBroadcast` | NÃO (v1) | idem |
| `newsletter` — canal `@newsletter` | `isJidNewsletter` | NÃO (v1) | sem uso |
| `meta_ai` — bot / Meta AI (`@bot`, `13135550002@c.us`) | `isJidMetaIa` | passa | não listado como não suportado (fail-safe) |
| `technical` — `@s.whatsapp.net` (servidor), `*@c.us` | (constantes) | **passa sempre** | servidor/protocolo |
| `unknown` — qualquer outro | — | **passa e é contado** | nunca descartar por dúvida |

## Política

`WHATSAPP_INBOUND_SCOPE` (não é booleano):

- `ALL_SUPPORTED` (**padrão**): nada é ignorado — idêntico ao comportamento anterior.
- `DIRECT_ONLY`: ignora **somente** grupo, status, broadcast e newsletter. Valor inválido → padrão + evento
  `inbound.escopo_invalido_usando_padrao`.

`WHATSAPP_INBOUND_DIAG_ENABLED` (padrão `false`): evento `inbound.contadores` (a cada 30 s, só se algo mudou; valores
**cumulativos desde o boot**; a leitura de uma reconexão é a diferença entre dois resumos). Só OBSERVA — não injeta
`shouldIgnoreJid` (em ALL_SUPPORTED as opções do socket são as de antes; o log `inbound.escopo` traz
`shouldIgnoreJidInjetado`). Fontes: listeners de leitura `ws.on('CB:message'|'CB:receipt'|'CB:notification')` (stanzas por
tipo), `messages.upsert` (decrypt ok/falha e motivo em vocabulário fechado), wrapper do logger do Baileys (retry receipts,
com/sem pré-chave) e a linha `Session error:… Bad MAC` da libsignal (total global, sem JID). Por tipo:
`stanzasMensagem/Receipt/Notificacao, ignoradas, decryptTentado, decryptOk, decryptFalha, motivos, enfileiradas, emitidasDireto,
entregues, encaminhadas, retryTotal, retryComPreChave, retrySemPreChave` (C.9.4 substituiu `recebidas/retries/retriesComChave`). Nunca JID, participant, author, remoteJid, ID, texto, hash ou chave. Nota: "Bad MAC" por tipo = falhas cujo
motivo é `sem_sessao_compativel` (é como a falha de MAC da sessão chega ao stub; cada uma gera ≥ 1 linha Bad MAC).

## Risco conhecido, fora deste escopo

`aoMessagesUpsert` (baileysSession.js) encaminha **toda** mensagem recebida ao backend com
`telefoneE164 = deJid(remoteJid)` — para grupo/status isso vira um "telefone" falso, e um `@lid` vira um número que não
é telefone. Hoje o backend só repassa o evento (Checkpoint F ainda não resolve contato), mas o Checkpoint F **deve**
receber o *tipo* do JID e nunca tratar `remoteJid` de grupo/LID como telefone. `DIRECT_ONLY` elimina os de grupo/status
na origem; LID precisa de mapeamento próprio.

## DÍVIDA FORMAL — Checkpoint F (resolução de contato/conversas)

O encaminhamento atual (`aoMessagesUpsert` → `telefoneE164 = deJid(remoteJid)`) **não é válido** para grupo, status nem LID.
O Checkpoint F **deve**: (1) transportar explicitamente o **tipo de origem** do JID (`classificarJid`) no evento
Gateway→backend; (2) **nunca** tratar `@lid` (nem `@g.us`/status) como telefone — LID exige mapeamento próprio para o
contato; (3) resolver contato/consentimento/opt-out só para `direct_pn` (e `direct_lid_*` já mapeado). Não corrigido no C.9.3
por estar fora do escopo (o backend hoje só repassa o evento).

## Como validar em produção (depois de aprovado)

1. Ligar só `WHATSAPP_INBOUND_DIAG_ENABLED=true` (escopo padrão) e ler `inbound.contadores` por 1–2 reconexões:
   quantas stanzas/mensagens e quantas falhas por tipo (`direct` × `group` × ...).
2. Se o volume de grupo/status for relevante, trocar para `DIRECT_ONLY` e comparar `auth_state.metricas`
   (session, sender-key, pre-key) e a contagem de `Bad MAC` por reconexão.
3. Reversão: remover a env (volta a `ALL_SUPPORTED`). Sessões/sender-keys já gravadas **não** são apagadas por isso.

## C3.5-C.9.4 — atribuição real de decrypt e a fila offline (diagnóstico aprimorado)

### Por que `messages.upsert` fica em zero (mecanismo PROVADO localmente com Baileys/libsignal reais)

Estado do buffer de eventos do Baileys 6.7.24 (`Utils/event-buffer.js`):

1. `Socket/socket.js`: no boot, se `creds.me.id` existe, `process.nextTick(() => ev.buffer())`. O buffer nasce **ativo**.
2. `messages.upsert` é um evento *bufferável*: enquanto o buffer está ativo ele **não** chega aos listeners.
3. `CB:ib,,offline` (o servidor avisando "acabou a fila offline") faz `ev.flush()` e emite `receivedPendingNotifications`.
   `Socket/chats.js` então chama `ev.buffer()` e, com history-sync desligado (**padrão do Gateway**:
   `Socket/index.js` deriva `shouldSyncHistoryMessage` de `syncFullHistory=false`), `setTimeout(() => ev.flush(), 0)`.
   Não existe timer de 20 s no Gateway.
4. `upsertMessage` é `ev.createBufferedFunction(...)`: **só chama `buffer()` e nunca `flush()`**. Cada mensagem que termina de ser
   processada **rearma** o buffer.
5. Nós offline (`attrs.offline`) vão para a fila **serial** `offlineNodeProcessor` (decrypt→`upsertMessage`), **sem flush**.
   Só nós **vivos** (sem `attrs.offline`) usam `processNodeWithBuffer` (`buffer→exec→flush`).

Consequência (ordem de produção): o servidor despeja a fila offline e manda `CB:ib,,offline` quase junto. O Baileys ainda está no começo
do decrypt serial (com I/O do adapter de auth entre as etapas) quando o `flush` do "fim do offline" roda. **Tudo o que é decifrado depois
fica retido** — inclusive os stubs `CIPHERTEXT` de falha — até um nó vivo ser processado. É uma **corrida**: só é liberado o que termina
antes do `setTimeout(0)` (com crypto puro em CPU, as poucas primeiras; com I/O, nenhuma).
Testes: `test/inboundFilaOffline.test.js` (buffer ativo no boot; stanza offline sem fim ⇒ retida; fim ⇒ liberada; ordem de produção ⇒
retida com a fila "finalizada"; nó vivo ⇒ libera; canários lendo o código do Baileys).

Extra: o 1º retry de cada mensagem espera `requestPlaceholderResend` (5 s) numa fila serial (`retryMutex`). Em produção isso aparece como
+5 retries por 30 s (≈ 1 a cada 6 s) — a fila de retries de ~150 stanzas leva ~12 min por reconexão.

### O que o diagnóstico passa a mostrar (só nomes, contadores, booleanos e segundos)

`inbound.contadores` (cumulativo desde o boot, por tipo): `stanzasMensagem/Receipt/Notificacao`, `ignoradas`, `decryptTentado/Ok/Falha`,
`motivos[{motivo,n}]`, `enfileiradas` (emitida com o buffer ativo), `emitidasDireto`, `entregues` (chegou ao listener = buffer liberado),
`encaminhadas` (foi ao backend), `retryTotal`, `retryComPreChave`, `retrySemPreChave`; global `badMacLinhas`.
Tipos: `direct_pn`, `direct_lid_self`, `direct_lid_other`, `group`, `status`, `broadcast`, `newsletter`, `meta_ai`, `technical`, `unknown`.

* Ponto da atribuição: a emissão de `messages.upsert` no `ev` (wrapper transparente de `ev.emit`), **antes** do buffer — é o ponto mais
  próximo do decrypt em que o tipo de JID e o resultado (ok / stub `CIPHERTEXT` + motivo) coexistem. Não se usa o log global da libsignal
  (não tem JID).
* `direct_lid_self` × `direct_lid_other`: comparação booleana, **só em memória**, do usuário do LID com o de `socket.user.lid`.
  Nada disso é guardado, logado ou hasheado.
* Pré-chave de retry: regra real do Baileys `retryCount > 1 || !<enc>` (a stanza sem `<enc>` força `<keys>` já no 1º retry). O contador
  reproduz a regra e os testes o comparam com os recibos realmente enviados (nós com `<keys>`). O campo se chama `...PreChave` porque o
  `logsafe` mascara qualquer chave que contenha "prekey" (`retryComPreKey` sairia `[REDACTED]`).

`inbound.fila_offline` (só muda ⇒ só emite, no máx. 1×/30 s): `bufferAtivo`, `mensagensRetidas`, `bufferChamadasExternas`, `flushes`,
`flushesEfetivos`, `offlinePreviewRecebido`, `offlineFimRecebido`, `offlineFimContagem`, `receivedPendingNotifications`,
`conexoesAbertas`, `myAppStateKeyIdPresente`, `nosOfflineVistos`, `nosVivosVistos`, `segundosDesdeOfflineFim`,
`segundosDesdeUltimoFlush`, `segundosDesdeUltimaEnfileirada`.
Leitura: `offlineFimRecebido=1` + `bufferAtivo=true` + `mensagensRetidas>0` + `nosVivosVistos=0` confirma a retenção em produção;
`offlineFimRecebido=0` significaria que o servidor nunca enviou o fim (hipótese alternativa).
`bufferChamadasExternas` não inclui `createBufferedFunction` (usa o `buffer()` interno) — por isso `bufferAtivo` é lido ao vivo.

### Auditoria do backend (`mensagem-recebida`)

Único chamador: `aoMessagesUpsert` do Gateway (só `!fromMe`) → `backendClient.notificarMensagemRecebida` →
`POST /internal/comunicacao/eventos/mensagem-recebida` (HMAC) → `repo.registrarMensagemRecebida` (**stub**: devolve o payload, não persiste
nem loga) → `provider._receberEventoMensagem` (opcional). Payload atual: `{providerMessageId, telefoneE164, recebidoEm}` — **sem** tipo de origem e
**sem** conteúdo. Esperado hoje: uma chamada por `messages.upsert` não-`fromMe` entregue ao listener — com o buffer retendo, zero.
Provado no teste `inboundWiring`: `deJid(remoteJid)` gera `+<dígitos>` também para LID, grupo (`+120363…`) e `status@broadcast` (`+status`).

### RISCO ao consertar a retenção (não consertado aqui)

Liberar o buffer também libera os **stubs de falha de decrypt** e as mensagens de grupo/status/LID, que o encaminhamento atual enviaria ao
backend como "mensagem recebida" com um "telefone" inválido. Antes de qualquer flush ocioso/pós-fila, o Checkpoint F precisa do contrato:
`origemTipo` (`direct|group|status|broadcast|newsletter|unknown`), `origemJidTipo` (`pn|lid_self|lid_other|…`), `telefoneE164` somente
quando o JID for realmente `@s.whatsapp.net` de usuário (senão `null`), `falhaDecrypt: boolean` (stub `CIPHERTEXT` não é conteúdo) e
descarte explícito do que o produto v1 não suporta.

## C3.5-C.9.6 — instrumentação da fila offline + watchdog em modo OBSERVE (só diagnóstico)

**Pergunta que este código responde (e só ela):** "se o failsafe futuro estivesse ativo, ele teria disparado aqui?". Nada aqui faz flush, libera
buffer, encaminha mensagem, pede `offline_batch`, pagina ou aciona Agente/automação.

### Garantia estrutural de não interferência
`src/offlineObserve.js` **não importa o Baileys e não recebe `ev`/`ws`/socket**. Recebe só: eventos como dados, dois LEITORES por geração de socket
(`lerBufferAtivo` → `ev.isBuffering()`, `lerSocketAberto` → `ws.isOpen`), `emitir` (log), `agendar/cancelar` (timer) e `obterEpoch`. Testes estáticos proíbem
`flush`/`.buffer(`/`.emit(`/`sendNode`/`end`/`close`/`offline_batch` no módulo e restringem o wiring em `inboundScope.js` à lista fechada de métodos de registro.
Teste dinâmico com o Baileys real compara NENHUMA instrumentação × diagnóstico sem observador × OBSERVE com a mesma sequência de nós: frames enviados
(receipts/retries/acks), decrypts, retries, upserts, buffer, flushes e auth são idênticos; a única diferença são os eventos.

### Ligar/desligar
`WHATSAPP_INBOUND_DIAG_ENABLED=true` (já ligado em produção) + `WHATSAPP_OFFLINE_OBSERVE_ENABLED` (padrão LIGADO quando o diagnóstico está ligado; `0/false/no/off` é o
kill-switch). O boot loga `inbound.escopo.offlineObserve`.

### Máquina de estados (por geração de socket; `socketGeneration` é um inteiro incremental interno, ≈ `cargaSeq`)
`CONNECTING → OFFLINE_LOADING` (1º preview OU 1º nó offline; registra o gatilho) → `LIVE` (só pelo marcador `CB:ib,,offline`; o marcador observado ANTES do handler do Baileys via
`prependListener`, para registrar `retidasAntesDoFlush`) ; `OFFLINE_LOADING → OFFLINE_STALLED_OBSERVED` (o failsafe teria disparado) ; `OFFLINE_STALLED_OBSERVED → OFFLINE_LOADING`
(retomada: houve progresso) ; qualquer → `CLOSED` (fechamento do socket daquela geração ou surgimento de uma geração nova; timer cancelado; eventos tardios ignorados).
Um flush do Baileys SEM marcador (nó vivo) é só registrado (`flushesSemMarcador`); não é fim do offline.

### Regra do watchdog (só avalia com todas as condições)
`fase=OFFLINE_LOADING` E `bufferAtivo` E `!offlineFimRecebido` E `mensagensRetidas>0` (do buffer do socket ATUAL) E `socketHealthy` (`ws.isOpen` E algum frame/nó nos últimos 35 s) E
(`sem progresso ≥ stallDetectionMs` OU `desde o início ≥ absoluteMaxOfflineMs`). Progresso = preview, nó offline, mensagem enfileirada, batch (inferido: 1 por preview), flush efetivo, marcador.
Valores iniciais (experimentais, injetáveis): `stallDetectionMs=30 s` (a rajada de ~100 nós terminou em T+6,3 s nas 2 amostras de produção; 30 s ≈ 5× isso, > 20 s do sync do
Baileys e < 35 s do keep-alive), `absoluteMaxOfflineMs=180 s`, tick 1 s, heartbeat 60 s. Se o padrão de produção se repetir, `stalled_observed` deve sair em ≈ T+36 s de CADA conexão.

### Eventos (todos sem identificadores: só inteiros, booleanos, buckets e vocabulário fechado)
* `inbound.offline_preview` — por preview: `atributos:[{nome,classe,valor?}]` sanitizados (nome só se `^[a-z][a-z0-9_-]{0,23}$`; inteiro ≤ 7 dígitos ⇒ `numerico`; `true/false` ⇒ `booleano`; vocabulário fechado ⇒ `enum`;
  parece id/telefone/timestamp/token ⇒ `sensivel` SEM valor; resto ⇒ `desconhecido` só com o tamanho), `atributosIgnorados`, `filhos`, `atributosNoIb`, `sinceSocketMs`. O Baileys não interpreta esses atributos
  (só faz log do nó), então os nomes reais são desconhecidos até a 1ª amostra.
* `inbound.offline_node_progress` — nos marcos 1 e 100 (configurável): `sinceSocketMs`, `sincePreviewMs`, `offlineNodes`, agregados por espécie/tipo, distribuição de `attrs.offline` e idade. Não existe evento "último nó"
  (não há como saber em tempo real): use `offlineLastProgressAt`/`segundosDesdeProgresso`.
* `inbound.offline_stalled_observed` — UM por ENTRADA em OFFLINE_STALLED_OBSERVED (teto de 5 por geração): `stallReason` (`no_progress`|`absolute_max`), `secondsSinceProgress`, `secondsSinceOfflineStart`,
  retidas, nós offline/vivos, preview/fim, `socketHealthy`, `RECOVERY_PATH_USED=false`, `observeOnly=true`.
* `inbound.offline_state` — `gatilho`: `heartbeat` (a cada 60 s, só em LOADING/STALLED_OBSERVED; enxuto), `marcador`, `fechamento` (com `retidasPerdidas`), `retomada`, `flush_sem_marcador` (1× por geração).
  Campos: fase, tempos, retidas, nós offline/vivos, preview/fim, `bufferAtivo`, `socketHealthy`, `observeWouldRecover`, flushes.
* `inbound.fila_offline` — ganhou `retidasPerdidasNoFechamento` (+ `socketGeneration`, `fase` com o observador). **Semântica corrigida:** `mensagensRetidas` agora é do buffer do socket ATUAL (zera em cada socket
  novo; o buffer velho morreu com ele) — antes era cumulativo por processo (por isso 80 → 170 nas amostras).
* `inbound.contadores` — cada tipo ganhou `fromMe:[{v:'sim'|'nao'|'desconhecido', tentado, falha}]`, que explica o `direct_lid_other` (mensagens de OUTRO aparelho da própria conta = `fromMe=sim`), sem reinterpretar o JID.

### Distribuição de `attrs.offline` e idade (métricas, nunca decisão)
`attrOffline` por espécie (message/receipt/notification): `missing|empty|zero|one|other`, classificada sobre o valor BRUTO antes da coerção truthy do Baileys (`"0"` conta como offline no Baileys; aqui só medimos).
`idade`: buckets `lt1m|m1a5|m5a30|m30a120|h2a24|gt24h|ausente|invalido` do `t` da stanza, por origem (offline × vivo), só mensagens. O timestamp original nunca é registrado.
