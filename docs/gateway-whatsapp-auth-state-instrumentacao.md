# Instrumentação do Auth State do Baileys — Checkpoint C1, item 10

Evidência real, obtida rodando **localmente e sem rede** funções puras do
próprio pacote `baileys@6.7.24` já instalado em `gateway-whatsapp/`. Nenhuma
conexão com o WhatsApp foi feita — `initAuthCreds()` só gera pares de chaves
criptográficas novas (curva25519 + registrationId), o mesmo que aconteceria
no primeiro boot de qualquer instância do Gateway antes de parear.

## 1. Forma de `creds` (`initAuthCreds()`)

Chaves de topo observadas (rodando `Object.keys(initAuthCreds())`):

```
noiseKey, pairingEphemeralKeyPair, signedIdentityKey, signedPreKey,
registrationId, advSecretKey, processedHistoryMessages, nextPreKeyId,
firstUnuploadedPreKeyId, accountSyncCounter, accountSettings, registered,
pairingCode, lastPropHash, routingInfo
```

Tamanho serializado de um `creds` recém-criado (antes de qualquer pareamento
real, que adiciona `me`, `account`, `signalIdentities` etc.): **1819 bytes**.
Pequeno — cabe folgado num único blob.

## 2. Armadilha real encontrada: `Buffer.toJSON()`

`noiseKey.private`, `signedIdentityKey.private` etc. são **`Buffer` reais**
(confirmado por `Buffer.isBuffer`), não `Uint8Array` genéricos. `Buffer` tem
um método `toJSON()` próprio, e `JSON.stringify` **sempre chama `toJSON()`
num valor antes de repassar o resultado ao `replacer`** — então um replacer
que testa `valor instanceof Uint8Array` nunca bate para um Buffer real: pelo
momento em que o replacer o vê, já virou `{ type: "Buffer", data: [...] }`
(um objeto plano).

Sem tratar esse caso, `gateway-whatsapp/src/authState.js#replacerBuffers`
serializaria (e mais tarde tentaria reviver) esse formato incorretamente —
corrompendo silenciosamente `noiseKey`/`signedIdentityKey`/`signedPreKey` a
cada ciclo de persistência. **Corrigido em `authState.js`** para reconhecer
também a forma pós-`toJSON()` (`{type: "Buffer", data: [...]}`) e convertê-la
para o mesmo formato `{__buffer: base64}` usado no resto do blob. Coberto por
`gateway-whatsapp/test/authState.test.js` com um `creds` real gerado por
`initAuthCreds()` (round-trip completo, não um mock).

## 3. Categorias de `keys` (`SignalDataTypeMap`, `lib/Types/Auth.d.ts`)

Conjunto **fechado**, direto do `.d.ts` do pacote instalado:

| Categoria | Tipo do valor |
|---|---|
| `pre-key` | `KeyPair` (`{public, private}`, ambos `Uint8Array`) |
| `session` | `Uint8Array` |
| `sender-key` | `Uint8Array` |
| `sender-key-memory` | `{[jid: string]: boolean}` |
| `app-state-sync-key` | `proto.Message.IAppStateSyncKeyData` |
| `app-state-sync-version` | `LTHashState` (`{version, hash: Buffer, indexValueMap: {...}}`) — **tem Buffer aninhado**, confirma que o replacer precisa varrer profundidade arbitrária, não só o nível 1 |

`SignalKeyStore.get(type, ids)` devolve `{[id]: valor}` só para os ids
pedidos; `.set(data)` recebe `{[type]: {[id]: valor | null}}` (`null` =
apagar). Isso já bate exatamente com o adaptador em memória escrito em
`authState.js`.

## 4. Padrão de leitura/escrita (decisão blob vs. tabela)

Sem conectar a uma conta real não é possível medir o volume de `session`/
`sender-key` em produção (essas só existem depois de trocar mensagens com
contatos reais). Mas o **escopo já fechado do C0/C1** — sem grupos, sem
sincronizar histórico, um único número, poucos contatos administrativos —
limita estruturalmente esse volume: `session`/`sender-key` crescem por
contato/dispositivo com quem já houve troca, não por mensagem. Dezenas de
entradas, não milhares.

## 5. Decisão

**Blob monolítico** (`creds` + todas as `keys` serializados juntos num único
`auth_state_encrypted`), não uma tabela `whatsapp_auth_keys` separada.
Motivos, à luz da evidência acima:

- Volume pequeno para o escopo atual (item 4).
- Escrita em rajada no pareamento, depois esparsa — sem padrão de "hot
  path" por chave que justifique uma linha por chave.
- Uma tabela por chave obrigaria o backend a conhecer nomes/ids de chaves do
  Signal Protocol em claro (para ter uma PK), mesmo com o *valor* cifrado —
  pior superfície do que um blob opaco único.
- O Gateway já resolve `get`/`set` em memória durante a sessão ativa; só vai
  ao backend em `creds.update` (ver `authState.js#persistir`), não a cada
  leitura de chave.

Não é irrevogável — se o uso crescer para múltiplos números/grupos, revisitar
(o próprio relatório do C0 já previa isso).
