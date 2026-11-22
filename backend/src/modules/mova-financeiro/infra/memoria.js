// Armazenamento em MEMÓRIA do MOVA — simulação/demonstração e testes rápidos. MESMO contrato de infra/postgres.js (a versão
// durável, Execução 02): eventos, participantes, propostas (com transição condicional), histórico, documentos, mensagens
// pendentes, caixa de saída, aprovações e auditoria. Tudo separado por organização + unidade.
import { randomUUID } from "node:crypto";

export const ESTADO_PROPOSTA_MOVA = Object.freeze({ AGUARDANDO_REVISAO: "AGUARDANDO_REVISAO", APLICANDO: "APLICANDO", APLICADA: "APLICADA", REJEITADA: "REJEITADA" });
const TRANSICOES = { AGUARDANDO_REVISAO: ["APLICANDO", "REJEITADA"], APLICANDO: ["APLICADA", "AGUARDANDO_REVISAO"] };
const chave = (e) => `${e.organizacaoId}|${e.unidadeId}`;

export function criarArmazenamentoMemoria({ gerarId = randomUUID, relogio = () => new Date() } = {}) {
  const eventos = new Map();
  const participantes = new Map();
  const propostas = new Map();
  const propostaPorChave = new Map();
  const historico = [];
  const documentos = new Map();
  const pendentes = new Map();
  const saida = [];
  const aprovacoes = [];
  const auditoria = [];

  return Object.freeze({
    eventos: Object.freeze({
      async registrar(e) { if (eventos.has(e.eventoId)) return { novo: false }; eventos.set(e.eventoId, e); return { novo: true }; },
      /** Por eventoId; com grupoId, pela mensagemId DENTRO do grupo (mensagem respondida). */
      async obter(id, grupoId = null) { return grupoId ? [...eventos.values()].find((e) => e.mensagemId === id && e.grupoId === grupoId) ?? null : eventos.get(id) ?? null; },
    }),
    participantes: Object.freeze({
      async registrar({ grupoId, participanteId, nomeExibicao = null }) {
        const k = `${grupoId}|${participanteId}`;
        const atual = participantes.get(k);
        participantes.set(k, { grupoId, participanteId, nomeExibicao: nomeExibicao ?? atual?.nomeExibicao ?? null, mensagens: (atual?.mensagens ?? 0) + 1 });
        return { novo: !atual };
      },
      async listar(grupoId) { return [...participantes.values()].filter((p) => p.grupoId === grupoId); },
    }),
    propostas: Object.freeze({
      async criar(escopo, dados) {
        const existente = propostaPorChave.get(dados.chaveIdempotencia);
        if (existente) return { proposta: propostas.get(existente), repetida: true };
        const p = Object.freeze({ id: gerarId(), organizacaoId: escopo.organizacaoId, unidadeId: escopo.unidadeId, estado: ESTADO_PROPOSTA_MOVA.AGUARDANDO_REVISAO, simulada: true, versao: 1, resultado: null, criadaEm: relogio().toISOString(), ...dados });
        propostas.set(p.id, p);
        propostaPorChave.set(dados.chaveIdempotencia, p.id);
        return { proposta: p, repetida: false };
      },
      async listar(escopo) { return [...propostas.values()].filter((p) => chave(p) === chave(escopo)); },
      async obter(escopo, id) { const p = propostas.get(id); return p && chave(p) === chave(escopo) ? p : null; },
      async transicionar(escopo, id, de, para, resultado = null) {
        const p = propostas.get(id);
        if (!p || chave(p) !== chave(escopo) || p.estado !== de || !TRANSICOES[de]?.includes(para)) return null;
        const nova = Object.freeze({ ...p, estado: para, versao: p.versao + 1, resultado: resultado ?? p.resultado });
        propostas.set(id, nova);
        return nova;
      },
      async quantidade() { return propostas.size; },
    }),
    historico: Object.freeze({
      async registrar(entrada) { historico.push(Object.freeze({ id: gerarId(), em: relogio().toISOString(), ...entrada })); },
      async listar({ organizacaoId, unidadeId }) { return historico.filter((h) => (h.organizacaoId ?? null) === organizacaoId && (h.unidadeId ?? null) === unidadeId); },
      async todos() { return [...historico]; },
      async temDecisao(eventoId) {
        const doEvento = historico.filter((h) => h.eventoId === eventoId);
        const corte = doEvento.map((h) => h.decisao).lastIndexOf("REPROCESSAR");
        return doEvento.slice(corte + 1).some((h) => !["FALHOU", "REPROCESSAR"].includes(h.decisao));
      },
    }),
    documentos: Object.freeze({
      async visto(sha256) { return documentos.get(sha256) ?? null; },
      async marcar(sha256, dados) { if (!documentos.has(sha256)) documentos.set(sha256, Object.freeze({ ...dados })); },
    }),
    mensagens: Object.freeze({
      async lembrar(mensagemId, { grupoId, pendente }) { if (pendente) pendentes.set(mensagemId, { grupoId, pendente, criadaEm: relogio() }); else pendentes.delete(mensagemId); },
      async tomarPendente(mensagemId) { const p = pendentes.get(mensagemId) ?? null; pendentes.delete(mensagemId); return p; },
      /** 15A — memória curta (mesma regra do Postgres): mais recente da mesma conversa e participante, depois de `desde`. */
      async tomarPendenteRecente({ grupoId, participanteId, validadeMs }) {
        const desde = new Date(relogio().getTime() - validadeMs);
        const [id, p] = [...pendentes.entries()].filter(([, x]) => x.grupoId === grupoId && x.pendente?.evento?.participanteId === participanteId && x.criadaEm >= desde)
          .sort((a, b) => b[1].criadaEm - a[1].criadaEm)[0] ?? [];
        if (!id) return null;
        pendentes.delete(id);
        return p;
      },
    }),
    saida: Object.freeze({
      /** Caixa de saída SIMULADA: nada é enviado ao WhatsApp nesta execução. */
      async enfileirar(resposta) { saida.push(Object.freeze({ estado: "PENDENTE", ...resposta })); },
      async listar() { return [...saida]; },
      async ehRespostaPropria(mensagemId) { return saida.some((r) => r.providerMessageId && r.providerMessageId === mensagemId); },
    }),
    aprovacoes: Object.freeze({
      async registrar(a) { aprovacoes.push(Object.freeze({ ...a })); },
      async listar(propostaId) { return aprovacoes.filter((a) => a.propostaId === propostaId); },
    }),
    auditoria: Object.freeze({
      async registrar(a) { auditoria.push(Object.freeze({ ...a })); },
      async listar() { return [...auditoria]; },
    }),
  });
}
