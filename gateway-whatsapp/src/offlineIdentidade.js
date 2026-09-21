// Checkpoint C3.5-C.9.7 — IDENTIDADE EFÊMERA dos nós da fila offline (só diagnóstico).
//
// PERGUNTA QUE ESTE MÓDULO RESPONDE (e só ela): "o servidor entregou, nesta conexão, os MESMOS nós da conexão anterior
// ou um trecho NOVO da fila?" — sem registrar em lugar nenhum um único identificador.
//
// COMO
//   Cada nó offline (message/receipt/notification) vira uma IMPRESSÃO = HMAC-SHA256(segredo do processo, material da stanza),
//   truncada em 128 bits. O segredo nasce aleatório neste módulo (crypto.randomBytes), vive só na closure, nunca é logado,
//   nunca é persistido e nunca é devolvido. As impressões ficam só em Map/Set em memória (limitados) e NUNCA saem: a única
//   saída deste módulo são CONTAGENS (inteiros e percentuais) e vocabulário fechado.
//
// MATERIAL DA IMPRESSÃO (nunca sai do processo; nunca é guardado; nunca é logado)
//   ESTRITA : [espécie, type, id, from, participant]      — identidade "de protocolo" da stanza
//   FROUXA  : [espécie, id]                               — controle para o caso de o servidor endereçar o MESMO item de outro jeito
//                                                           (ex.: PN numa conexão, LID na outra): estrita 0% + frouxa alta ⇒ mesmo item, outro endereço
//   O ID é o `id` da stanza (identificador do item no protocolo). NÃO se usa conteúdo, texto, legenda, nome nem payload decifrado.
//   `t` (timestamp) fica de fora de propósito: um reenvio do MESMO item pode ter outro `t`.
//   A ESPÉCIE entra no material: message X e receipt X (mesmo id) são itens diferentes.
//
// MEMÓRIA LIMITADA
//   No máximo `maxPorGeracao` (500) impressões por geração de socket; acima disso não guarda mais e só CONTA (`descartadosPorLimite`).
//   Guarda no máximo `geracoesRetidas` (3) gerações ANTERIORES além da atual; a mais antiga é descartada quando entra uma nova.
//   Gerações sem nenhum nó offline não entram no histórico (não deslocam a anterior útil).
//   Reiniciar o processo/deploy = segredo novo + histórico vazio ⇒ "sem_geracao_anterior" (intencional: nada é persistido).
//
// NÃO FAZ: log, emit, rede, disco, acesso a ev/ws/socket/Baileys, decisão sobre a fila. Só `registrar` (dado entra) e `comparar`
// (contagens saem). Testes estáticos (test/offlineIdentidade.test.js) travam isso.
import { createHmac, randomBytes } from "node:crypto";

export const PADROES_IDENTIDADE = Object.freeze({ maxPorGeracao: 500, geracoesRetidas: 3 });
export const ESPECIES_IDENTIDADE = Object.freeze(["message", "receipt", "notification"]);
/** vocabulário FECHADO do motivo de "não comparável" */
export const MOTIVOS_NAO_COMPARAVEL = Object.freeze(["sem_geracao_anterior", "sem_nos_offline_no_socket"]);

const MAX_PARTE = 512;                        // uma parte gigante não vira custo de RAM/CPU
const parte = (v) => (typeof v === "string" ? v.slice(0, MAX_PARTE) : "");
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

/**
 * @param {object} [o]
 * @param {number} [o.maxPorGeracao]
 * @param {number} [o.geracoesRetidas] gerações ANTERIORES retidas (a atual não conta)
 * @param {Buffer} [o.segredo] SÓ para testes; em produção nasce aleatório (32 bytes) e ninguém o enxerga
 */
export function criarIdentidadeOffline({ maxPorGeracao = PADROES_IDENTIDADE.maxPorGeracao, geracoesRetidas = PADROES_IDENTIDADE.geracoesRetidas, segredo } = {}) {
  if (!Number.isInteger(maxPorGeracao) || maxPorGeracao < 1) throw new RangeError("maxPorGeracao deve ser inteiro >= 1");
  if (!Number.isInteger(geracoesRetidas) || geracoesRetidas < 1) throw new RangeError("geracoesRetidas deve ser inteiro >= 1");
  const chave = Buffer.isBuffer(segredo) && segredo.length >= 16 ? Buffer.from(segredo) : randomBytes(32);

  const impressao = (dominio, itens) => createHmac("sha256", chave).update(JSON.stringify([dominio, ...itens])).digest().subarray(0, 16).toString("base64");

  /** @type {null | {g:number, mapa:Map<string,number>, frouxo:Set<string>, duplicados:number, semId:number, descartados:number}} */
  let atual = null;
  /** gerações anteriores COM nós (a mais antiga primeiro) */
  const historico = [];

  const nova = (g) => ({ g, mapa: new Map(), frouxo: new Set(), duplicados: 0, semId: 0, descartados: 0 });

  return {
    /** começa a geração `g` (a atual, se tinha nós, vira "anterior"; a mais antiga além do limite é descartada) */
    novaGeracao(g) {
      if (atual && atual.mapa.size > 0) {
        historico.push(atual);
        while (historico.length > geracoesRetidas) historico.shift();
      }
      atual = nova(g);
    },

    /**
     * Registra UM nó offline da geração `g`. Devolve só vocabulário fechado: novo | duplicado | sem_id | limite | ignorado.
     * @param {number} g
     * @param {string} especie message | receipt | notification
     * @param {{type?: any, id?: any, from?: any, participant?: any}} partes material BRUTO da stanza (nunca guardado nem devolvido)
     */
    registrar(g, especie, partes) {
      try {
        if (!atual || atual.g !== g) return "ignorado";                       // evento tardio de um socket antigo
        const idx = ESPECIES_IDENTIDADE.indexOf(especie);
        if (idx < 0) return "ignorado";
        const p = partes && typeof partes === "object" ? partes : {};
        const id = parte(p.id);
        if (id === "") { atual.semId += 1; return "sem_id"; }
        const estrita = impressao("estrita", [especie, parte(p.type), id, parte(p.from), parte(p.participant)]);
        if (atual.mapa.has(estrita)) { atual.duplicados += 1; return "duplicado"; }
        if (atual.mapa.size >= maxPorGeracao) { atual.descartados += 1; return "limite"; }
        atual.mapa.set(estrita, idx);
        atual.frouxo.add(impressao("frouxa", [especie, id]));
        return "novo";
      } catch { return "ignorado"; }                                          // identidade nunca lança
    },

    /**
     * Compara a geração ATUAL (`g`) com a anterior. SÓ contagens/percentuais/vocabulário fechado. `null` se `g` não é a atual.
     * "overlap" = estrito; "overlapIdOnly" = frouxo (espécie + id).
     */
    comparar(g) {
      try {
        if (!atual || atual.g !== g) return null;
        const base = {
          currentGeneration: atual.g, currentCount: atual.mapa.size,
          duplicadosNoSocket: atual.duplicados, semIdentidade: atual.semId, descartadosPorLimite: atual.descartados, currentTruncado: atual.descartados > 0,
          geracoesRetidasNoProcesso: historico.length,
        };
        const vazio = { comparavel: false, previousGeneration: null, geracoesEntre: null, previousCount: null, overlapCount: null, newCount: null, missingCount: null, overlapPct: null, newPct: null, missingPct: null, overlapIdOnlyCount: null, overlapIdOnlyPct: null, currentIdOnlyCount: null, previousIdOnlyCount: null, newIdOnlyCount: null, missingIdOnlyCount: null, newIdOnlyPct: null, missingIdOnlyPct: null, seenInRetainedCount: null, unseenInRetainedCount: null, previousTruncado: null, porEspecie: [] };
        if (atual.mapa.size === 0) return { ...base, ...vazio, motivo: "sem_nos_offline_no_socket" };
        const prev = historico[historico.length - 1];
        if (!prev) return { ...base, ...vazio, motivo: "sem_geracao_anterior" };
        let overlap = 0; let overlapId = 0; let visto = 0;
        const porEsp = ESPECIES_IDENTIDADE.map(() => ({ atual: 0, overlap: 0 }));
        for (const [k, idx] of atual.mapa) {
          porEsp[idx].atual += 1;
          if (prev.mapa.has(k)) { overlap += 1; porEsp[idx].overlap += 1; }
          if (historico.some((h) => h.mapa.has(k))) visto += 1;
        }
        for (const k of atual.frouxo) if (prev.frouxo.has(k)) overlapId += 1;
        const cur = atual.mapa.size; const antes = prev.mapa.size;
        return {
          ...base, comparavel: true, motivo: null,
          previousGeneration: prev.g, geracoesEntre: atual.g - prev.g,
          previousCount: antes, overlapCount: overlap, newCount: cur - overlap, missingCount: antes - overlap,
          overlapPct: pct(overlap, cur), newPct: pct(cur - overlap, cur), missingPct: pct(antes - overlap, antes),
          overlapIdOnlyCount: overlapId, overlapIdOnlyPct: pct(overlapId, atual.frouxo.size),
          currentIdOnlyCount: atual.frouxo.size, previousIdOnlyCount: prev.frouxo.size,
          newIdOnlyCount: atual.frouxo.size - overlapId, missingIdOnlyCount: prev.frouxo.size - overlapId,
          newIdOnlyPct: pct(atual.frouxo.size - overlapId, atual.frouxo.size), missingIdOnlyPct: pct(prev.frouxo.size - overlapId, prev.frouxo.size),
          seenInRetainedCount: visto, unseenInRetainedCount: cur - visto, previousTruncado: prev.descartados > 0,
          porEspecie: ESPECIES_IDENTIDADE.map((nome, i) => ({ nome, currentCount: porEsp[i].atual, overlapCount: porEsp[i].overlap, newCount: porEsp[i].atual - porEsp[i].overlap })),
        };
      } catch { return null; }
    },

    /** só tamanhos (nunca impressões) — para testes/diagnóstico do próprio módulo */
    estado() {
      return {
        geracaoAtual: atual ? atual.g : null, atualCount: atual ? atual.mapa.size : 0,
        historico: historico.map((h) => ({ geracao: h.g, count: h.mapa.size })),
        maxPorGeracao, geracoesRetidas,
      };
    },
  };
}
