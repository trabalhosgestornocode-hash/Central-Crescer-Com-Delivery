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

// Checkpoint C3.5-B.1 — categoria sanitizada de falha ao carregar auth
// state. NUNCA carrega chave, plaintext, ciphertext, creds ou QR — só o
// NOME da categoria. Achado ao vivo: `carregar()` costumava devolver um
// `false` puro para TUDO (não encontrado, fencing stale, decrypt AES-GCM
// falho, JSON malformado, erro HTTP) e `conectar()` tratava esse `false`
// como "nunca pareado", descartando creds reais e gerando um QR por cima de
// uma sessão já pareada. `carregar()` agora NUNCA devolve boolean: ausência
// legítima é `{status:'absent'}` (retorno normal); qualquer outra falha
// SEMPRE lança `AuthStateLoadError` com uma categoria — nunca mais um
// `false` silencioso escondendo qual dos dois realmente aconteceu.
export class AuthStateLoadError extends Error {
  /** @param {'lease_stale'|'http_error'|'decrypt_error'|'parse_error'|'invalid_structure'|'unknown'} categoria */
  constructor(categoria) {
    super(`auth_state.carregar falhou: ${categoria}`);
    this.name = "AuthStateLoadError";
    this.categoria = categoria;
  }
}

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
 * @param {() => ({gatewayProcessId: string, leaseEpoch: number}|null)} [deps.obterContextoLease]
 *   Checkpoint C3.5 — devolve o fencing atual (null se este processo não é
 *   leader agora). Sem isto injetado, o adapter funciona sem fencing (usado
 *   pelos testes que não envolvem lease) — mas em produção `server.js`
 *   SEMPRE injeta, e toda gravação passa a exigir contexto válido.
 * @param {(motivo: string) => void} [deps.aoLeaseStale]
 *   Chamado quando o backend rejeita uma gravação com 409
 *   WHATSAPP_GATEWAY_LEASE_STALE — plugado ao `leaseManager.notificarPerdaExterna`.
 */
export function criarAuthStateAdapter({ backendClient, chaveEncriptacaoEnv, obterContextoLease, aoLeaseStale }) {
  const chave = normalizarChave(chaveEncriptacaoEnv);

  // Cache em memória do processo — o Baileys lê/escreve chaves o tempo todo
  // durante uma sessão ativa; ir ao backend a cada leitura seria lento e
  // desnecessário. Só persistimos no backend quando algo muda.
  let creds = null;
  /** @type {Record<string, Record<string, any>>} */
  let keysPorTipo = {};
  let versao = 1;

  // FILA DE PERSISTÊNCIA (single-instance) — `creds.update` e `keys.set` do
  // Baileys podem disparar em sequência rápida, e cada um chama `persistir()`
  // de forma independente. Sem serialização, duas chamadas a
  // `backendClient.salvarAuthState()` ficam em voo ao mesmo tempo, e a rede
  // NÃO garante que a que foi disparada primeiro termine primeiro — se a
  // gravação de um estado mais antigo terminar DEPOIS da de um estado mais
  // novo, ela sobrescreve o mais novo no backend (auth state perdido/revertido
  // silenciosamente). Um único `Promise` encadeado por instância do adapter
  // garante que as gravações cheguem ao backend na MESMA ordem em que os
  // snapshots foram produzidos aqui, e que uma falha isolada não trava as
  // gravações seguintes (ver `enfileirarPersistencia`).
  let filaPersistencia = Promise.resolve();
  // Resultado CRU (não sanitizado) da última tarefa enfileirada — ao
  // contrário de `filaPersistencia`, ESTE pode rejeitar. Existem dois
  // consumidores com necessidades diferentes da mesma fila:
  //   * a PRÓPRIA fila, que precisa de uma cauda sempre resolvida para poder
  //     encadear a próxima gravação mesmo depois de uma falha (senão uma
  //     falha isolada travaria toda gravação futura — ver `filaPersistencia`);
  //   * quem espera a fila (`aguardarPersistenciasPendentes`, usado antes de
  //     `carregar()` numa reconexão), que precisa SABER se a última gravação
  //     enfileirada até aquele momento realmente deu certo — se essa espera
  //     também absorvesse o erro, uma falha real do SAVE do pair-success
  //     ficaria invisível, e o reconnect recarregaria do backend um estado
  //     mais antigo do que o que este processo já tinha produzido.
  let ultimaPersistencia = Promise.resolve();

  function serializarTudo() {
    return JSON.stringify({ creds, keys: keysPorTipo }, replacerBuffers);
  }

  async function salvarSnapshot(plaintext, contextoLease) {
    const cifrado = encriptar(plaintext, chave);
    try {
      await backendClient.salvarAuthState({
        authStateEncrypted: cifrado, authStateVersion: `v${versao}`,
        gatewayProcessId: contextoLease?.gatewayProcessId, leaseEpoch: contextoLease?.leaseEpoch,
      });
    } catch (e) {
      // Checkpoint C3.5, item 15: um processo stale NUNCA pode achar que
      // sobrescreveu o auth state de um epoch mais novo — o backend já
      // recusou (409); aqui só propagamos o aviso para quem coordena a
      // lease (fecha o socket, para de tentar escrever) e deixamos o erro
      // seguir para quem estava esperando este `persistir()`.
      if (e?.leaseStale) aoLeaseStale?.("auth_state_stale");
      throw e;
    }
    // Nunca logar o plaintext nem o cifrado — só o tamanho, útil para
    // dimensionar o crescimento do blob ao longo do tempo.
    log("info", "auth_state.persistido", { bytesPlaintext: plaintext.length });
  }

  /**
   * Encadeia `tarefa` no fim da fila desta instância. O erro de uma tarefa
   * SEMPRE chega a quem a enfileirou (o `await persistir()` original) E a
   * quem chamar `aguardarPersistenciasPendentes()` logo em seguida — mas
   * nunca envenena a fila em si: `filaPersistencia` (a cauda usada para
   * sequenciar a PRÓXIMA gravação) é sempre resolvida (`.catch(() => {})`),
   * então a próxima gravação começa normalmente mesmo que a anterior tenha
   * falhado.
   */
  function enfileirarPersistencia(plaintext, contextoLease) {
    const tarefa = filaPersistencia.then(() => salvarSnapshot(plaintext, contextoLease));
    filaPersistencia = tarefa.catch(() => {});
    ultimaPersistencia = tarefa;
    return tarefa;
  }

  async function persistir() {
    // Snapshot capturado AGORA, de forma síncrona (JSON.stringify não cede o
    // loop de eventos) — reflete exatamente o estado de `creds`/`keysPorTipo`
    // neste instante, antes de entrar na fila. Se essa captura fosse feita só
    // quando a tarefa chegasse a vez de rodar, uma atualização B já teria
    // mutado o mesmo objeto `creds` (merge in-place) e o snapshot de A sairia
    // errado — na verdade seria o de A+B.
    const plaintext = serializarTudo();
    // Fencing capturado no MESMO instante do snapshot — corresponde
    // exatamente a "sob qual epoch este estado foi produzido". Sem
    // `obterContextoLease` injetado (testes sem lease), segue sem fencing.
    const contextoLease = obterContextoLease?.();
    if (obterContextoLease && !contextoLease) {
      // Só falha fechado quando a função FOI injetada e disse "não sou
      // leader agora" — nunca tenta mandar isto para o backend (que
      // rejeitaria mesmo assim, mas sem gastar uma chamada de rede).
      throw new Error("authState.persistir: processo não é o dono atual da lease — gravação recusada localmente");
    }
    return enfileirarPersistencia(plaintext, contextoLease);
  }

  /**
   * Drain de verdade da fila — não só "a última tarefa que eu já conhecia".
   * `ultimaPersistencia` pode MUDAR enquanto este `await` está pendente (uma
   * nova gravação, ex.: `keys.set` do próprio handshake, pode entrar na fila
   * nesse meio-tempo). Sem o loop, aguardaríamos só a cauda vista no INSTANTE
   * da chamada e retornaríamos antes dessa gravação nova terminar — quem
   * depende do drain (ex.: `carregar()` na reconexão pós-515) poderia rodar
   * com uma gravação ainda em voo. Por isso recaptura `ultimaPersistencia`
   * e só sai quando ela ficar ESTÁVEL entre o início e o fim do `await`.
   *
   * Ao contrário de `filaPersistencia`, REJEITA se a gravação aguardada
   * tiver falhado — propaga IMEDIATAMENTE, sem continuar o loop (não faz
   * sentido esperar as próximas se a que falhou é a que motivou a espera).
   * Usado antes de `carregar()` numa reconexão (ex.: pós-515/restartRequired):
   * se a gravação do pair-success falhou, o backend ainda tem um estado mais
   * antigo do que este processo já produziu em memória — recarregar nessas
   * condições devolveria auth state obsoleto. Quem chama isto precisa tratar
   * a rejeição (nunca deixar sem `catch`).
   */
  async function aguardarPersistenciasPendentes() {
    for (;;) {
      const alvo = ultimaPersistencia;
      await alvo;
      if (alvo === ultimaPersistencia) return;
    }
  }

  /**
   * Carrega do backend no boot/reconexão/restore. Passa o fencing atual (se
   * `obterContextoLease` estiver injetado) para `carregarAuthState` —
   * Checkpoint C3.5-B, item 11: o backend só devolve o ciphertext ao dono
   * atual quando isto é informado (opcional/retrocompatível do lado dele).
   *
   * Checkpoint C3.5-B.1 — contrato explícito, NUNCA um boolean puro:
   *   { status: 'absent' }                    — nenhuma sessão persistida
   *                                              (única situação em que um
   *                                              pareamento novo é seguro)
   *   { status: 'loaded', registered: bool }  — encontrado, decifrado,
   *                                              parseado com sucesso
   *   lança AuthStateLoadError                — QUALQUER outra falha
   *                                              (fencing stale, erro HTTP,
   *                                              decrypt AES-GCM, JSON
   *                                              malformado, estrutura
   *                                              inesperada) — nunca
   *                                              colapsado em "absent".
   * @returns {Promise<{status: 'absent'} | {status: 'loaded', registered: boolean}>}
   */
  async function carregar() {
    try {
      let r;
      try {
        r = await backendClient.carregarAuthState(obterContextoLease?.());
      } catch (e) {
        throw new AuthStateLoadError(e?.leaseStale ? "lease_stale" : "http_error");
      }
      if (!r || r.status === "absent" || !r.authStateEncrypted) {
        return { status: "absent" };
      }

      let plaintext;
      try {
        plaintext = decriptar(r.authStateEncrypted, chave);
      } catch {
        throw new AuthStateLoadError("decrypt_error");
      }

      let dados;
      try {
        dados = JSON.parse(plaintext, reviverBuffers);
      } catch {
        throw new AuthStateLoadError("parse_error");
      }

      if (!dados || typeof dados !== "object" || !dados.creds || typeof dados.creds !== "object") {
        throw new AuthStateLoadError("invalid_structure");
      }

      creds = dados.creds;
      keysPorTipo = (dados.keys && typeof dados.keys === "object") ? dados.keys : {};
      return { status: "loaded", registered: !!creds.registered };
    } catch (e) {
      if (e instanceof AuthStateLoadError) throw e;
      // Rede de segurança — qualquer exceção inesperada aqui também precisa
      // lançar tipado (nunca um `false`/`undefined` silencioso), mesmo sem
      // categoria específica conhecida.
      throw new AuthStateLoadError("unknown");
    }
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
    aguardarPersistenciasPendentes,
    /**
     * Chamado pelo handler de `creds.update` do Baileys. O payload é
     * `Partial<AuthenticationCreds>` (node_modules/baileys/lib/Types/
     * Events.d.ts) — NUNCA o objeto completo. Confirmado ao vivo,
     * Checkpoint C3: o próprio `pair-success` do Baileys (Socket/socket.js
     * ~L487-489) emite só `{account, me, signalIdentities, platform}`,
     * disparado bem antes do 515/restartRequired. Substituir `creds`
     * inteiro por esse delta (bug anterior) apagava noiseKey/
     * signedIdentityKey/signedPreKey/registrationId/advSecretKey — e a
     * reconexão pós-515 quebrava com TypeError em noiseKey.public
     * (node_modules/baileys/lib/Utils/noise-handler.js:88).
     *
     * `Object.assign` faz o merge TOP-LEVEL (raso, igual ao contrato
     * `Partial<...>`) preservando a MESMA referência de `creds` — qualquer
     * lugar que já tenha pego `comoAuthState().creds` antes continua
     * enxergando o objeto atualizado, sem precisar re-obter a referência.
     * `persistir()` sempre serializa o `creds` (closure) inteiro, nunca só
     * o delta — a persistência do estado completo vem de graça por isso.
     */
    async aoAtualizarCreds(credsAtualizados) {
      if (creds) Object.assign(creds, credsAtualizados);
      else creds = credsAtualizados;
      await persistir();
    },
    // ---- só para teste/instrumentação ----
    _snapshot: () => ({ creds, keysPorTipo, versao }),
  };
}
