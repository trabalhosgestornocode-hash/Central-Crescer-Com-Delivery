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
| `direct_lid` — chat direto (LID `@lid`) | `isLidUser` | **SIM** | mesma conversa, endereçada por LID |
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
`stanzasMensagem/Receipt/Notificacao, ignoradas, recebidas, decryptTentado, decryptOk, decryptFalha, motivos, retries,
retriesComChave`. Nunca JID, participant, author, remoteJid, ID, texto, hash ou chave. Nota: "Bad MAC" por tipo = falhas cujo
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
contato; (3) resolver contato/consentimento/opt-out só para `direct_pn` (e `direct_lid` já mapeado). Não corrigido no C.9.3
por estar fora do escopo (o backend hoje só repassa o evento).

## Como validar em produção (depois de aprovado)

1. Ligar só `WHATSAPP_INBOUND_DIAG_ENABLED=true` (escopo padrão) e ler `inbound.contadores` por 1–2 reconexões:
   quantas stanzas/mensagens e quantas falhas por tipo (`direct` × `group` × ...).
2. Se o volume de grupo/status for relevante, trocar para `DIRECT_ONLY` e comparar `auth_state.metricas`
   (session, sender-key, pre-key) e a contagem de `Bad MAC` por reconexão.
3. Reversão: remover a env (volta a `ALL_SUPPORTED`). Sessões/sender-keys já gravadas **não** são apagadas por isso.
