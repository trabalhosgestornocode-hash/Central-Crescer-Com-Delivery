// Telemetria ESTRUTURAL do auth state (Checkpoint C3.5-C.9.1).
//
// Objetivo: descobrir QUAL parte do auth state cresce (+~9,7 KB por reconexão em produção, C.9)
// sem jamais expor material. Só sai daqui: NOME de categoria (vocabulário fechado do Baileys),
// contagem de entradas, bytes serializados e totais. Nunca: IDs, JIDs, valores, hashes, conteúdo
// de creds, ciphertext, SessionEntry, device IDs.
//
// Duas peças:
//   medirAuthState()        função PURA — recebe { creds, keys } e devolve as métricas.
//   criarTelemetriaAuth()   estado da telemetria (flag, dedupe de emissão, contadores de snapshots
//                           byte-idênticos). Desligada por padrão: `habilitada:false` devolve um
//                           objeto inerte e o adapter não faz nenhum trabalho extra.

import { createHash } from "node:crypto";

// Categoria só entra pelo nome se for um slug simples (o vocabulário do Baileys é fechado:
// pre-key, session, sender-key, sender-key-memory, app-state-sync-key, app-state-sync-version).
// Qualquer outra coisa é agregada em "outra" — o conteúdo do nome nunca vaza por acidente.
const NOME_SEGURO = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const CATEGORIA_DESCONHECIDA = "outra";

const bytesUtf8 = (s) => Buffer.byteLength(s ?? "", "utf8");
const ehObjeto = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array);

/**
 * Contagens estruturais adicionais (NÚMEROS, nunca conteúdo) que separam as hipóteses de
 * crescimento. Defensivo: se a forma não for a esperada, simplesmente não devolve nada.
 *  - session: cada valor é um SessionRecord serializado com `_sessions` (uma entrada por sessão
 *    aberta/fechada). Separa "mais REGISTROS (dispositivos)" de "mais sessões FECHADAS dentro do
 *    mesmo registro" (a libsignal poda em 40 por registro).
 *  - app-state-sync-version: `indexValueMap` tem 1 entrada por mutação viva do app state.
 */
function detalhesDe(nome, mapa) {
  try {
    if (nome === "session") {
      let sub = 0, fechadas = 0, maxPorRegistro = 0;
      for (const rec of Object.values(mapa)) {
        const sessoes = ehObjeto(rec) && ehObjeto(rec._sessions) ? Object.values(rec._sessions) : null;
        if (!sessoes) continue;
        sub += sessoes.length;
        maxPorRegistro = Math.max(maxPorRegistro, sessoes.length);
        for (const s of sessoes) if (ehObjeto(s) && ehObjeto(s.indexInfo) && s.indexInfo.closed !== -1) fechadas++;
      }
      return { subentradas: sub, fechadas, maxPorRegistro };
    }
    if (nome === "app-state-sync-version") {
      let mutacoes = 0;
      for (const est of Object.values(mapa)) if (ehObjeto(est) && ehObjeto(est.indexValueMap)) mutacoes += Object.keys(est.indexValueMap).length;
      return { mutacoes };
    }
  } catch {
    // métrica auxiliar nunca pode quebrar a principal
  }
  return {};
}

/**
 * @param {{creds: any, keys: Record<string, Record<string, any>>}} estado
 * @param {{serializar: (valor: any) => string, plaintext?: string}} opcoes
 *   `serializar` DEVE ser o mesmo serializador do adapter (Buffers como {__buffer}) para que os
 *   bytes batam com o que é realmente cifrado/enviado. `plaintext` (opcional) reaproveita o
 *   snapshot já serializado em vez de serializar tudo de novo.
 * @returns {{plaintextBytes: number, credsBytes: number, categories: Record<string, {entries: number, bytes: number, [k: string]: number}>}}
 */
export function medirAuthState({ creds, keys }, { serializar, plaintext } = {}) {
  if (typeof serializar !== "function") throw new TypeError("medirAuthState: serializar é obrigatório");
  const plaintextBytes = bytesUtf8(plaintext ?? serializar({ creds, keys }));
  const credsBytes = creds == null ? 0 : bytesUtf8(serializar(creds));

  /** @type {Record<string, {entries: number, bytes: number}>} */
  const categories = {};
  for (const [tipo, mapa] of Object.entries(keys ?? {})) {
    if (!ehObjeto(mapa)) continue;
    const nome = NOME_SEGURO.test(tipo) ? tipo : CATEGORIA_DESCONHECIDA;
    const atual = categories[nome] ?? { entries: 0, bytes: 0 };
    atual.entries += Object.keys(mapa).length;
    atual.bytes += bytesUtf8(serializar(mapa));
    if (nome !== CATEGORIA_DESCONHECIDA) Object.assign(atual, detalhesDe(nome, mapa));
    categories[nome] = atual;
  }
  return { plaintextBytes, credsBytes, categories };
}

const sha256 = (s) => createHash("sha256").update(s).digest();

/**
 * @param {object} deps
 * @param {boolean} [deps.habilitada] default false (env WHATSAPP_AUTH_METRICS_ENABLED)
 * @param {(dados: object) => void} deps.emitir recebe o payload JÁ sanitizado (sem nomes de chave sensíveis)
 * @param {(valor: any) => string} deps.serializar mesmo serializador do adapter
 */
export function criarTelemetriaAuth({ habilitada = false, emitir, serializar } = {}) {
  if (!habilitada) return { habilitada: false };

  let cargaSeq = 0;               // "geração de conexão": sobe a cada carregar() bem-sucedido (cada reconexão)
  let assinaturaEmitida = null;   // o que já foi emitido (dedupe de ruído)
  let cargaEmitida = -1;
  let hashConfirmado = null;      // sha256 do último plaintext CONFIRMADO — só em memória, jamais logado
  let escritas = 0;               // snapshots confirmados desde a última emissão
  let identicas = 0;              // …dos quais byte-idênticos ao confirmado imediatamente antes

  const linhas = (m) => [
    { nome: "creds", entradas: 1, bytes: m.credsBytes },
    ...Object.entries(m.categories).map(([nome, c]) => {
      const { entries, bytes, ...extra } = c;
      return { nome, entradas: entries, bytes, ...extra };
    }),
  ];
  const assinatura = (m) => `${cargaSeq}|${m.plaintextBytes}|${Object.entries(m.categories).map(([n, c]) => `${n}:${c.entries}`).join(",")}`;

  return {
    habilitada: true,

    /** chamada por carregar() com sucesso — marca uma nova "geração de conexão". */
    aoCarregar() { cargaSeq++; },

    /** Captura SÍNCRONA junto do snapshot (mesmo instante). Nunca lança. */
    capturar(estado, plaintext) {
      try { return medirAuthState(estado, { serializar, plaintext }); } catch { return null; }
    },

    /** Chamada só DEPOIS de o backend confirmar o snapshot. Nunca lança. */
    aoConfirmar(snap, { cifradoChars, corpoBytes, geracao, epoch }) {
      try {
        const digest = sha256(snap.plaintext);
        escritas++;
        if (hashConfirmado && digest.equals(hashConfirmado)) identicas++;
        hashConfirmado = digest;

        const m = snap.metricas;
        if (!m) return;
        const sig = assinatura(m);
        if (sig === assinaturaEmitida) return;

        const motivo = cargaSeq !== cargaEmitida ? "nova_carga"
          : (assinaturaEmitida?.split("|")[2] !== sig.split("|")[2] ? "contagem" : "tamanho");
        assinaturaEmitida = sig;
        cargaEmitida = cargaSeq;
        emitir({
          geracao, epoch, cargaSeq, motivo,
          plaintextBytes: m.plaintextBytes, cipherChars: cifradoChars, corpoBytes,
          categorias: linhas(m),
          escritasDesdeUltima: escritas, identicasDesdeUltima: identicas,
        });
        escritas = 0;
        identicas = 0;
      } catch {
        // telemetria nunca interfere na persistência
      }
    },
  };
}
