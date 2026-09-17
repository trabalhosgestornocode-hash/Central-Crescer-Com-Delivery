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

  async function salvarSnapshot(plaintext) {
    const cifrado = encriptar(plaintext, chave);
    await backendClient.salvarAuthState({ authStateEncrypted: cifrado, authStateVersion: `v${versao}` });
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
  function enfileirarPersistencia(plaintext) {
    const tarefa = filaPersistencia.then(() => salvarSnapshot(plaintext));
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
    return enfileirarPersistencia(plaintext);
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
