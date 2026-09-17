// Adaptador de Auth State do Baileys — substitui `useMultiFileAuthState`
// (que grava em disco, inadequado para o Render: o disco não é persistente
// e o Gateway não deve depender de volume).
//
// FORMA DO AUTH STATE DO BAILEYS (confirmada por instrumentação local em
// C1 — ver docs/gateway-whatsapp-auth-state-instrumentacao.md — chamando
// `initAuthCreds()` do próprio pacote, sem rede):
//   state.creds  — objeto único, serializável em JSON (com alguns valores
//                  Buffer/Uint8Array dentro, que precisam de um replacer).
//   state.keys   — um SignalKeyStore: `get(type, ids) -> {id: valor}` e
//                  `set({[type]: {[id]: valor|null}})`. Os "type" são um
//                  conjunto FECHADO (pre-key, session, sender-key,
//                  app-state-sync-key, app-state-sync-version,
//                  sender-key-memory) — ver KeyType em node_modules/baileys.
//
// DESENHO (Checkpoint C0, item 8): o Gateway NUNCA expõe isso em claro fora
// do processo. Toda vez que os creds mudam (`creds.update`) ou uma chave é
// escrita, o blob inteiro (creds + todas as chaves conhecidas) é serializado,
// cifrado (src/crypto.js) e mandado ao backend via backendClient — que só
// guarda o ciphertext, sem a chave de decifra.
//
// DECISÃO — BLOB MONOLÍTICO vs. TABELA POR CHAVE (Checkpoint C1, item 10):
// optamos por um ÚNICO blob monolítico (creds + keys serializados juntos)
// por linha de `whatsapp_conexoes`, não uma tabela `whatsapp_auth_keys`
// separada. Evidência que sustenta a escolha:
//   * volume por conexão é pequeno para o USO PRETENDIDO (um único número,
//     sem grupos, sem sincronizar histórico) — a maior parte do volume de
//     chaves do Baileys em uso real vem de `session` (uma por contato/
//     dispositivo com quem já houve troca) e `sender-key` (grupos). Como
//     o Checkpoint define explicitamente "sem grupos" e o número atende
//     poucos contatos administrativos, o número de chaves fica na casa das
//     dezenas, não milhares.
//   * escrita é em RAJADA no login (dezenas de chaves de uma vez) e depois
//     ESPARSA (poucas por conversa) — não há padrão de escrita quente que
//     justifique atualização por linha.
//   * um blob único mantém a invariante "o backend só guarda ciphertext
//     opaco" simples: uma tabela por chave obrigaria o backend a saber pelo
//     menos os NOMES/IDs das chaves em claro para ter uma PK útil — nomes de
//     chave do Signal Protocol (ex.: IDs de pre-key) não deveriam vazar para
//     fora do Gateway mesmo que o valor esteja cifrado.
//   * o próprio Baileys já resolve get/set em memória durante a sessão
//     ativa (ver `criarAuthStateAdapter` abaixo) — a ida ao backend só
//     acontece em `creds.update`, não a cada leitura de chave.
// Se o uso crescer para múltiplos números/grupos, revisitar esta decisão
// (o comentário do Checkpoint C0 já previa isso) — não é irrevogável.

import { log } from "./logsafe.js";
import { encriptar, decriptar, normalizarChave } from "./crypto.js";

// Serializa Buffer/Uint8Array como {__buffer: base64} — precisa de um par
// replacer/reviver simétrico porque JSON.stringify não sabe lidar com eles.
//
// ARMADILHA CONFIRMADA POR INSTRUMENTAÇÃO (rodando `initAuthCreds()` de
// verdade, sem rede — ver docs/gateway-whatsapp-auth-state-instrumentacao.md):
// `Buffer` tem `toJSON()` próprio, e o `JSON.stringify` SEMPRE chama
// `toJSON()` num valor ANTES de passar o resultado para o replacer — então
// checar `valor instanceof Uint8Array` dentro do replacer nunca bate para um
// Buffer real: quando o replacer o vê, ele já virou
// `{ type: "Buffer", data: [...] }` (um objeto plano). `noiseKey.private`,
// `signedIdentityKey.private` etc. em `initAuthCreds()` são Buffers reais —
// sem este ajuste, o round-trip corrompia silenciosamente essas chaves.
function replacerBuffers(_chave, valor) {
  if (valor instanceof Uint8Array) return { __buffer: Buffer.from(valor).toString("base64") };
  if (valor && typeof valor === "object" && valor.type === "Buffer" && Array.isArray(valor.data)) {
    return { __buffer: Buffer.from(valor.data).toString("base64") };
  }
  return valor;
}
function reviverBuffers(_chave, valor) {
  if (valor && typeof valor === "object" && typeof valor.__buffer === "string") {
    return Buffer.from(valor.__buffer, "base64");
  }
  return valor;
}

/**
 * @param {object} deps
 * @param {import('./backendClient.js').ReturnType} deps.backendClient
 * @param {string} deps.chaveEncriptacaoEnv variável de ambiente crua
 */
export function criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv }) {
  const chave = normalizarChave(chaveEncriptacaoEnv);

  // Cache em memória do processo — o Baileys lê/escreve chaves o tempo todo
  // durante uma sessão ativa; ir ao backend a cada leitura seria lento e
  // desnecessário. Só persistimos no backend quando algo muda.
  let creds = null;
  /** @type {Record<string, Record<string, any>>} */
  let keysPorTipo = {};
  let versao = 1;

  function serializarTudo() {
    return JSON.stringify({ creds, keys: keysPorTipo }, replacerBuffers);
  }

  async function persistir() {
    const plaintext = serializarTudo();
    const cifrado = encriptar(plaintext, chave);
    await backendClient.salvarAuthState({ authStateEncrypted: cifrado, authStateVersion: `v${versao}` });
    // Nunca logar o plaintext nem o cifrado — só o tamanho, útil para
    // dimensionar o crescimento do blob ao longo do tempo.
    log("info", "auth_state.persistido", { bytesPlaintext: plaintext.length });
  }

  /** Carrega do backend no boot/reconexão. Retorna false se não havia nada salvo ainda. */
  async function carregar() {
    const r = await backendClient.carregarAuthState();
    if (!r?.authStateEncrypted) return false;
    const plaintext = decriptar(r.authStateEncrypted, chave);
    const dados = JSON.parse(plaintext, reviverBuffers);
    creds = dados.creds ?? null;
    keysPorTipo = dados.keys ?? {};
    return !!creds;
  }

  function inicializarCreds(credsIniciais) {
    creds = credsIniciais;
  }

  /** Forma exigida pelo Baileys: `{ creds, keys: { get, set } }`. */
  function comoAuthState() {
    return {
      get creds() { return creds; },
      set creds(valor) { creds = valor; },
      keys: {
        async get(tipo, ids) {
          const doTipo = keysPorTipo[tipo] ?? {};
          const saida = {};
          for (const id of ids) {
            if (doTipo[id] !== undefined) saida[id] = doTipo[id];
          }
          return saida;
        },
        async set(dados) {
          for (const tipo of Object.keys(dados)) {
            keysPorTipo[tipo] ??= {};
            for (const id of Object.keys(dados[tipo])) {
              const valor = dados[tipo][id];
              if (valor === null) delete keysPorTipo[tipo][id];
              else keysPorTipo[tipo][id] = valor;
            }
          }
          await persistir();
        },
      },
    };
  }

  return {
    carregar,
    inicializarCreds,
    comoAuthState,
    /** Chamado pelo handler de `creds.update` do Baileys. */
    async aoAtualizarCreds(credsAtualizados) {
      creds = credsAtualizados;
      await persistir();
    },
    // ---- só para teste/instrumentação ----
    _snapshot: () => ({ creds, keysPorTipo, versao }),
  };
}
