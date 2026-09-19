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
import { AuthPersistenciaError, classificarFalhaBackend } from "./classificacaoFalhas.js";

// Backoff do RETRY em segundo plano do snapshot mais novo ainda não persistido
// (Checkpoint C3.5-C.8.2). LIMITADO de propósito: 5 tentativas em ~48 s. Depois
// disso o estado segue marcado como "sujo" e quem o resolve é o próximo evento
// do Baileys (que grava o estado COMPLETO de novo) ou o flush do reconnect
// (`garantirPersistido()`) — nunca um loop infinito silencioso.
export const BACKOFF_RETRY_PERSISTENCIA_MS = Object.freeze([1_000, 2_000, 5_000, 10_000, 30_000]);

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
  /**
   * `pendente_nao_persistido` (Checkpoint C3.5-C.8.2): a memória deste processo
   * tem mutações que o backend ainda NÃO confirmou. Recarregar do backend agora
   * sobrescreveria o estado mais novo com o mais velho — recusado, sempre.
   * @param {'lease_stale'|'http_error'|'decrypt_error'|'parse_error'|'invalid_structure'|'pendente_nao_persistido'|'unknown'} categoria
   */
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
 * @param {(fn: () => void, ms: number) => any} [deps.agendar] injeção de
 *   setTimeout para o retry em segundo plano (teste sem tempo real).
 * @param {(handle: any) => void} [deps.cancelar] injeção de clearTimeout.
 * @param {readonly number[]} [deps.backoffRetryMs] backoff do retry em segundo
 *   plano — o TAMANHO da lista é o número máximo de retries (limitado).
 */
export function criarAuthStateAdapter({
  backendClient, chaveEncriptacaoEnv, obterContextoLease, aoLeaseStale,
  agendar = setTimeout, cancelar = clearTimeout, backoffRetryMs = BACKOFF_RETRY_PERSISTENCIA_MS,
}) {
  const chave = normalizarChave(chaveEncriptacaoEnv);

  // Cache em memória do processo — o Baileys lê/escreve chaves o tempo todo
  // durante uma sessão ativa; ir ao backend a cada leitura seria lento e
  // desnecessário. Só persistimos no backend quando algo muda.
  let creds = null;
  /** @type {Record<string, Record<string, any>>} */
  let keysPorTipo = {};
  let versao = 1;
  // Checkpoint C3.5-C.2/C.3 — identidade da GERAÇÃO atual de auth, sempre
  // capturada do backend (carregar() ou toda persistência bem-sucedida),
  // NUNCA gerada aqui. `null` enquanto não houver nenhuma geração conhecida
  // (ABSENT, ou ainda não persistiu nada nesta sessão do processo).
  let authSessionIdAtual = null;

  // FILA DE PERSISTÊNCIA (single-instance) — `creds.update` e `keys.set` do
  // Baileys podem disparar em sequência rápida, e cada um chama `persistir()`
  // de forma independente. Sem serialização, duas chamadas a
  // `backendClient.salvarAuthState()` ficam em voo ao mesmo tempo, e a rede
  // NÃO garante que a que foi disparada primeiro termine primeiro — se a
  // gravação de um estado mais antigo terminar DEPOIS da de um estado mais
  // novo, ela sobrescreve o mais novo no backend (auth state perdido/revertido
  // silenciosamente). Um único `Promise` encadeado por instância do adapter
  // garante que as gravações cheguem ao backend na MESMA ordem em que os
  // snapshots foram produzidos aqui.
  //
  // `filaPersistencia` é SEMPRE uma cauda RESOLVIDA (cada tarefa termina em
  // `.catch(() => {})`): é só a "vez" da próxima gravação, nunca um veredito.
  //
  // MODELO DE ESTADO (Checkpoint C3.5-C.8.2 — o incidente de 2026-09-19).
  // Antes existia `ultimaPersistencia`, a Promise CRUA da última gravação, que
  // podia estar REJEITADA — e `aguardarPersistenciasPendentes()` a relançava
  // para sempre: uma única falha antiga (HTTP 413) impedia toda reconexão
  // enquanto o processo vivesse, porque nada mais enfileirava uma gravação
  // nova para substituí-la (o socket estava morto). Uma Promise rejeitada NÃO
  // pode ser estado. O estado agora é explícito e monotônico:
  //
  //   geracaoProduzida  — contador local: cada snapshot capturado recebe a
  //                       próxima geração (NÃO é o `auth_session_id`, que é a
  //                       identidade da sessão no backend; são conceitos
  //                       distintos).
  //   geracaoPersistida — maior geração que o backend CONFIRMOU. Só sobe.
  //   geracaoDescartada — maior geração abandonada de propósito (lease
  //                       perdida/mudou, reset): não pode mais ser gravada,
  //                       nem faz a memória contar como "suja".
  //   sujo              — geracaoProduzida > max(persistida, descartada): a
  //                       memória tem algo que o backend não confirmou.
  //   snapshotMaisNovo  — o snapshot da geração mais nova. Cada snapshot é o
  //                       estado COMPLETO, então o retry SEMPRE regrava o mais
  //                       novo ("latest wins") e nunca um antigo.
  let geracaoProduzida = 0;
  let geracaoPersistida = 0;
  let geracaoDescartada = 0;
  /** @type {{geracao: number, plaintext: string, contexto: ({gatewayProcessId: string, leaseEpoch: number}|null|undefined)}|null} */
  let snapshotMaisNovo = null;
  /** @type {{geracao: number, classe: string, causa: string, status: number|null}|null} */
  let ultimaFalha = null;
  // true depois de uma perda/mudança de lease: a memória não é mais confiável (ver
  // `marcarMemoriaObsoleta`). Só `carregar()` bem-sucedido, um novo pareamento
  // (`inicializarCreds`) ou um reset (`invalidarLocal`) o limpam.
  let memoriaObsoleta = false;
  let filaPersistencia = Promise.resolve();
  // Retry em segundo plano do snapshot mais novo (único timer; LIMITADO).
  // `epocaRetry` invalida callbacks de timers já cancelados.
  const retry = { timer: null, pendente: false, tentativas: 0, esgotado: false, epoca: 0 };

  const geracaoResolvida = () => Math.max(geracaoPersistida, geracaoDescartada);
  const estaSujo = () => geracaoProduzida > geracaoResolvida();

  function serializarTudo() {
    return JSON.stringify({ creds, keys: keysPorTipo }, replacerBuffers);
  }

  function cancelarRetry() {
    retry.epoca += 1;
    if (retry.pendente) {
      try { cancelar(retry.timer); } catch { /* best-effort */ }
    }
    retry.timer = null;
    retry.pendente = false;
  }

  /**
   * Abandona de propósito o que ainda não foi persistido (lease perdida/mudou,
   * reset). Nunca grava; só deixa de contar a memória como "suja" — o próximo
   * `carregar()` passa a ser a fonte da verdade.
   */
  function descartarPendente(causa) {
    const estavaSujo = estaSujo();
    geracaoDescartada = geracaoProduzida;
    cancelarRetry();
    if (estavaSujo) log("warn", "auth_state.snapshot_descartado", { causa, geracao: geracaoProduzida });
    return estavaSujo;
  }

  /**
   * INVARIANTE DE PERDA DE LEASE (Checkpoint C3.5-C.8.2): quando este processo
   * deixa de ser o dono da lease (perdida, mudou de epoch, 409 do backend), TUDO
   * que existe em memória foi produzido sob um epoch que já não é o nosso — outro
   * dono pode ter escrito no backend nesse meio-tempo. Então: (1) o pendente é
   * descartado e os retries cancelados; (2) a memória inteira passa a ser
   * OBSOLETA — nenhuma gravação nova sai dela, nem sob o epoch antigo nem sob um
   * epoch novo que este mesmo processo venha a adquirir, até que `carregar()`
   * traga o estado autorizado pelo backend. Nunca reutiliza em silêncio a
   * memória descartada.
   */
  function marcarMemoriaObsoleta(causa) {
    const estavaSujo = descartarPendente(causa);
    if (!memoriaObsoleta) log("warn", "auth_state.memoria_obsoleta", { causa, estavaSujo });
    memoriaObsoleta = true;
    return estavaSujo;
  }

  function agendarRetry() {
    if (retry.pendente) return; // no máximo UM timer
    if (retry.tentativas >= backoffRetryMs.length) {
      if (!retry.esgotado) {
        retry.esgotado = true;
        // ERROR e visível: o estado segue sujo e nada mais o retenta sozinho.
        log("error", "auth_state.retry_esgotado", { geracao: geracaoProduzida, tentativa: retry.tentativas });
      }
      return;
    }
    const esperaMs = backoffRetryMs[retry.tentativas];
    retry.tentativas += 1;
    const epoca = retry.epoca;
    retry.pendente = true;
    log("warn", "auth_state.retry_agendado", { geracao: geracaoProduzida, tentativa: retry.tentativas, esperaMs });
    const handle = agendar(() => { executarRetry(epoca).catch(() => {}); }, esperaMs);
    handle?.unref?.(); // um retry pendente nunca deve segurar o processo vivo
    if (epoca === retry.epoca && retry.pendente) retry.timer = handle;
  }

  async function executarRetry(epoca) {
    if (epoca !== retry.epoca) return; // cancelado/obsoleto
    retry.pendente = false;
    retry.timer = null;
    if (!estaSujo()) return; // outra gravação já limpou o estado
    const snap = snapshotMaisNovo;
    if (!snap) return;
    if (contextoMudou(snap)) { marcarMemoriaObsoleta("lease_mudou"); return; }
    try {
      await enfileirar(snap, "retry");
    } catch {
      // enfileirar() já classificou, logou e reagendou (se transitória).
    }
  }

  /**
   * Fencing: um snapshot é do epoch sob o qual foi produzido. Se este processo
   * não é mais o dono desse epoch, o snapshot está OBSOLETO — regravá-lo sob
   * um epoch novo poderia sobrescrever o que outro dono escreveu nesse meio
   * tempo. Sem `obterContextoLease` injetado (testes sem lease), nunca muda.
   */
  function contextoMudou(snap) {
    if (!obterContextoLease) return false;
    const atual = obterContextoLease();
    return !atual
      || atual.leaseEpoch !== snap.contexto?.leaseEpoch
      || atual.gatewayProcessId !== snap.contexto?.gatewayProcessId;
  }

  async function salvarSnapshot(snap) {
    let cifrado;
    try {
      cifrado = encriptar(snap.plaintext, chave);
    } catch {
      // Falha local de cifra (chave inválida etc.) — repetir não ajuda.
      throw new AuthPersistenciaError("permanente", "cripto");
    }
    try {
      const r = await backendClient.salvarAuthState({
        authStateEncrypted: cifrado, authStateVersion: `v${versao}`,
        gatewayProcessId: snap.contexto?.gatewayProcessId, leaseEpoch: snap.contexto?.leaseEpoch,
      });
      // Checkpoint C3.5-C.2/C.3 — captura a geração (mintada ou preservada
      // pela RPC) depois de TODA persistência bem-sucedida — nunca gerado
      // aqui. Nunca logado (é só um UUID interno de correlação, mas mesmo
      // assim segue a mesma disciplina de nunca logar identificadores sem
      // necessidade).
      if (r?.authSessionId) authSessionIdAtual = r.authSessionId;
    } catch (e) {
      // Checkpoint C3.5, item 15: um processo stale NUNCA pode achar que
      // sobrescreveu o auth state de um epoch mais novo — o backend já
      // recusou (409); aqui só propagamos o aviso para quem coordena a
      // lease (fecha o socket, para de tentar escrever) e deixamos o erro
      // seguir para quem estava esperando este `persistir()`.
      if (e?.leaseStale) aoLeaseStale?.("auth_state_stale");
      throw e;
    }
  }

  /**
   * Uma tentativa de gravar `snap` (SEMPRE executada dentro da fila serial —
   * nunca duas em voo). Guarda anti-stale: NUNCA grava uma geração que não
   * seja mais nova que a já persistida (isso é o que impede um retry de A de
   * sobrescrever B). Classifica e loga toda falha; só reagenda retry quando a
   * falha é transitória. O erro ORIGINAL segue para quem enfileirou.
   */
  async function gravar(snap, origem) {
    if (snap.geracao <= geracaoPersistida) {
      // Já coberta por uma gravação igual/mais nova — nada a fazer (sucesso).
      log("info", "auth_state.gravacao_dispensada", { geracao: snap.geracao, origem, causa: "ja_persistida" });
      return;
    }
    if (snap.geracao <= geracaoDescartada) {
      // Abandonada de propósito (lease perdida/mudou, reset) — regravar poderia
      // sobrescrever o que outro dono escreveu. NUNCA finge que deu certo.
      log("warn", "auth_state.gravacao_dispensada", { geracao: snap.geracao, origem, causa: "descartada" });
      throw new AuthPersistenciaError("permanente", "snapshot_descartado");
    }
    try {
      await salvarSnapshot(snap);
    } catch (e) {
      const c = classificarFalhaBackend(e);
      ultimaFalha = { geracao: snap.geracao, classe: c.classe, causa: c.causa, status: c.status };
      // Nunca a mensagem do erro (pode conter detalhe do backend/payload) —
      // só o vocabulário fechado da classificação.
      log("error", "auth_state.persistencia_falhou", { geracao: snap.geracao, origem, classe: c.classe, causa: c.causa, statusHttp: c.status });
      if (e?.leaseStale) marcarMemoriaObsoleta("lease_stale");
      else if (c.classe === "transitoria") agendarRetry();
      else cancelarRetry(); // permanente: nunca em loop — o retry daquele snapshot para aqui
      throw e;
    }
    geracaoPersistida = Math.max(geracaoPersistida, snap.geracao);
    if (ultimaFalha && ultimaFalha.geracao <= geracaoPersistida) ultimaFalha = null;
    retry.tentativas = 0;
    retry.esgotado = false;
    if (!estaSujo()) cancelarRetry();
    // Nunca logar o plaintext nem o cifrado — só o tamanho, útil para
    // dimensionar o crescimento do blob ao longo do tempo.
    log("info", "auth_state.persistido", { bytesPlaintext: snap.plaintext.length, geracao: snap.geracao, origem });
  }

  /** Encadeia a gravação de `snap` no fim da fila serial desta instância. */
  function enfileirar(snap, origem) {
    const tarefa = filaPersistencia.then(() => gravar(snap, origem));
    filaPersistencia = tarefa.catch(() => {});
    return tarefa;
  }

  async function persistir() {
    // Snapshot capturado AGORA, de forma síncrona (JSON.stringify não cede o
    // loop de eventos) — reflete exatamente o estado de `creds`/`keysPorTipo`
    // neste instante, antes de entrar na fila. Se essa captura fosse feita só
    // quando a tarefa chegasse a vez de rodar, uma atualização B já teria
    // mutado o mesmo objeto `creds` (merge in-place) e o snapshot de A sairia
    // errado — na verdade seria o de A+B.
    if (memoriaObsoleta) {
      // Memória de uma lease que já não é nossa: nunca vira snapshot. A geração
      // conta como descartada (não deixa o estado "sujo") e o erro é permanente
      // para ESTA gravação — some quando `carregar()` trouxer o estado do backend.
      const geracaoObsoleta = ++geracaoProduzida;
      geracaoDescartada = Math.max(geracaoDescartada, geracaoObsoleta);
      log("warn", "auth_state.gravacao_recusada_memoria_obsoleta", { geracao: geracaoObsoleta });
      throw new AuthPersistenciaError("permanente", "memoria_obsoleta");
    }
    const plaintext = serializarTudo();
    // Fencing capturado no MESMO instante do snapshot — corresponde
    // exatamente a "sob qual epoch este estado foi produzido". Sem
    // `obterContextoLease` injetado (testes sem lease), segue sem fencing.
    const contextoLease = obterContextoLease?.();
    const geracao = ++geracaoProduzida;
    if (obterContextoLease && !contextoLease) {
      // Só falha fechado quando a função FOI injetada e disse "não sou
      // leader agora" — nunca tenta mandar isto para o backend (que
      // rejeitaria mesmo assim, mas sem gastar uma chamada de rede). Sem
      // lease esta memória já não é a fonte da verdade: a geração conta como
      // descartada (não deixa o estado "sujo" para sempre).
      geracaoDescartada = Math.max(geracaoDescartada, geracao);
      log("warn", "auth_state.snapshot_descartado", { causa: "sem_lease_local", geracao });
      memoriaObsoleta = true; // mutou-se memória sem ser dono: ela não é fonte da verdade
      throw new AuthPersistenciaError("permanente", "sem_lease_local");
    }
    const snap = { geracao, plaintext, contexto: contextoLease };
    snapshotMaisNovo = snap;
    return enfileirar(snap, "evento");
  }

  /**
   * DRAIN da fila: resolve quando NÃO há mais nenhuma gravação em voo ou
   * enfileirada — e SÓ isso. Responde "há uma persistência ATUALMENTE
   * pendente?", nunca "alguma persistência falhou em algum momento da história
   * deste processo?" (era esta segunda pergunta que travava o reconnect para
   * sempre — ver o comentário do MODELO DE ESTADO acima). NUNCA rejeita.
   *
   * Recaptura a cauda em loop: uma gravação nova pode entrar na fila enquanto
   * este `await` está pendente (ex.: `keys.set` do próprio handshake) e o
   * drain só termina quando a cauda fica ESTÁVEL entre o início e o fim do
   * `await`.
   *
   * Para saber se o estado mais novo REALMENTE está no backend (e tentar
   * regravá-lo se não estiver), use `garantirPersistido()`.
   */
  async function aguardarPersistenciasPendentes() {
    for (;;) {
      const alvo = filaPersistencia;
      await alvo;
      if (alvo === filaPersistencia) return;
    }
  }

  /**
   * Garante que o snapshot MAIS NOVO desta memória está persistido no backend
   * — o que quem vai RECARREGAR do backend (reconnect) ou CONFIRMAR uma geração
   * precisa saber. Passos: (1) drena a fila; (2) se nada está sujo, pronto;
   * (3) se está, faz UMA tentativa de gravar o snapshot mais novo pela mesma
   * fila serial (uma falha anterior — até uma permanente, como o 413 de antes
   * do hotfix — não impede esta nova tentativa: o backend pode ter mudado).
   *
   * Resolve `{status}`:
   *   'limpo'      — nada pendente.
   *   'persistido' — o snapshot mais novo foi gravado agora.
   *   'descartado' — o snapshot era de um epoch de lease que não é mais o nosso
   *                  (memória obsoleta; NÃO foi gravado). O backend é a verdade.
   * Rejeita com `AuthPersistenciaError` ({classe, causa, status}) — só o
   * vocabulário fechado; quem chama decide retry (transitória) ou fail-safe
   * (permanente). NUNCA vaza a mensagem do erro original.
   */
  async function garantirPersistido() {
    await aguardarPersistenciasPendentes();
    if (!estaSujo()) return { status: "limpo" };
    const snap = snapshotMaisNovo;
    if (!snap) return { status: "limpo" };
    if (contextoMudou(snap)) {
      marcarMemoriaObsoleta("lease_mudou");
      return { status: "descartado" };
    }
    try {
      await enfileirar(snap, "flush");
    } catch (e) {
      const c = classificarFalhaBackend(e);
      throw new AuthPersistenciaError(c.classe, c.causa, { status: c.status });
    }
    return { status: "persistido" };
  }

  /** Observabilidade sanitizada — só números/vocabulário fechado, nunca o auth. */
  function estadoPersistencia() {
    return {
      geracaoProduzida, geracaoPersistida, geracaoDescartada,
      sujo: estaSujo(),
      memoriaObsoleta,
      ultimaFalha: ultimaFalha ? { ...ultimaFalha } : null,
      retryAgendado: retry.pendente,
      retryTentativas: retry.tentativas,
      retryEsgotado: retry.esgotado,
    };
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
    // Checkpoint C3.5-C.8.2 — NUNCA sobrescrever a memória com o backend
    // enquanto ela tem mutações que o backend não confirmou: `creds`/
    // `keysPorTipo` abaixo seriam substituídos por um estado mais VELHO e o
    // que só existia aqui se perderia em silêncio. Quem recarrega (reconnect)
    // deve chamar `garantirPersistido()` antes; se ainda estiver sujo, é
    // transitório (tenta-se de novo depois) — nunca destrutivo.
    if (estaSujo()) {
      log("warn", "auth_state.carregar_recusado_estado_sujo", { geracaoProduzida, geracaoPersistida });
      throw new AuthStateLoadError("pendente_nao_persistido");
    }
    try {
      let r;
      try {
        r = await backendClient.carregarAuthState(obterContextoLease?.());
      } catch (e) {
        throw new AuthStateLoadError(e?.leaseStale ? "lease_stale" : "http_error");
      }
      if (!r || r.status === "absent" || !r.authStateEncrypted) {
        // Checkpoint C3.5-C.2/C.3 — ABSENT nunca deixa uma geração antiga
        // "pendurada" localmente (ex.: depois de um reset).
        authSessionIdAtual = null;
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
      // Checkpoint C3.5-C.2/C.3 — captura a geração e o marcador durável do
      // backend, só depois do blob ter sido decifrado/parseado com sucesso
      // (nunca adota uma geração associada a um blob em que não confiamos).
      // `registered` (Baileys) segue devolvido só para diagnóstico/log — ver
      // Checkpoint C3.5-C.1: nunca controla fluxo, nunca é usado por quem
      // chama para decidir nada.
      authSessionIdAtual = r.authSessionId ?? null;
      // A memória agora É o estado autorizado pelo backend: deixa de ser obsoleta.
      memoriaObsoleta = false;
      return { status: "loaded", registered: !!creds.registered, authConfirmado: r.authConfirmado === true };
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
    // Creds novos (pareamento do zero): nada da memória antiga sobrevive.
    memoriaObsoleta = false;
  }

  /**
   * Checkpoint C3.5-B.2 — limpa a memória DESTE processo (creds + todas as
   * chaves conhecidas). Só deve ser chamado DEPOIS que o backend já
   * confirmou o reset do ciphertext (nunca antes — ver
   * baileysSession.js#resetarSessao) — defesa em profundidade: mesmo que
   * `conectar()` já reescrevesse `creds` via `inicializarCreds(initAuthCreds())`
   * no próximo pareamento, isto garante que nenhuma referência ao auth
   * antigo sobrevive na memória do processo entre o reset e esse próximo
   * `/connect`. Não persiste nada — só estado local.
   */
  function invalidarLocal() {
    creds = null;
    keysPorTipo = {};
    // Reset: nada da memória antiga pode ser regravado nem contar como "sujo".
    descartarPendente("reset");
    memoriaObsoleta = false; // a memória foi zerada — não há mais nada obsoleto nela
    snapshotMaisNovo = null;
    ultimaFalha = null;
    retry.tentativas = 0;
    retry.esgotado = false;
    // Checkpoint C3.5-C.2/C.3 — a geração antiga nunca pode sobreviver a um
    // reset na memória do processo; o próximo pareamento nasce sem ID
    // conhecido, igual a um boot novo em ABSENT.
    authSessionIdAtual = null;
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
    invalidarLocal,
    comoAuthState,
    aguardarPersistenciasPendentes,
    // Checkpoint C3.5-C.8.2 — ver os comentários de cada função acima.
    garantirPersistido,
    estadoPersistencia,
    descartarPendente,
    marcarMemoriaObsoleta,
    /** Cancela o retry em segundo plano (shutdown/perda de lease) — nunca deixa timer órfão. */
    cancelarRetries: cancelarRetry,
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
    // Checkpoint C3.5-C.2/C.3 — leitura síncrona, usada por
    // baileysSession.js para capturar `authSessionIdEsperado` no INSTANTE
    // do connection:"open" (antes de qualquer await) — é essa captura
    // síncrona que garante que um callback de socket/geração antiga nunca
    // consiga confirmar uma geração mais nova.
    obterAuthSessionIdAtual: () => authSessionIdAtual,
    // ---- só para teste/instrumentação ----
    _snapshot: () => ({ creds, keysPorTipo, versao, authSessionIdAtual }),
  };
}
