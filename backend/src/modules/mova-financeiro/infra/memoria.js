// Armazenamento em MEMÓRIA do MOVA — simulação/demonstração e testes rápidos. MESMO contrato de infra/postgres.js (a versão
// durável, Execução 02): eventos, participantes, propostas (com transição condicional), histórico, documentos, mensagens
// pendentes, caixa de saída, aprovações e auditoria. Tudo separado por organização + unidade.
import { randomUUID } from "node:crypto";
import { linhaDoRecebido } from "../dominio/documentos.js";

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
  const conferencias = new Map(); // sha256 → conferências em ordem (estado atual = a última)
  const pendentes = new Map();
  const saida = [];
  const aprovacoes = [];
  const auditoria = [];
  const conversas = new Map();
  const retratos = new Map();
  const politicas = [];
  const operacoes = new Map();
  const notas = new Map();
  const envios = new Map();
  const automacoes = new Map();
  const cadastrados = [];

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
      async anotar(escopo, id, alteracoes) {
        const p = propostas.get(id);
        if (!p || chave(p) !== chave(escopo) || p.estado !== "AGUARDANDO_REVISAO") return null;
        const nova = Object.freeze({ ...p, ...alteracoes, versao: p.versao + 1 });
        propostas.set(id, nova);
        return nova;
      },
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
      async porChave({ organizacaoId, chave }) { return [...documentos.values()].find((d) => d.organizacaoId === organizacaoId && d.leitura?.chaveDocumento === chave) ?? null; },
      async porTransacao({ organizacaoId, idTransacao }) { return [...documentos.values()].find((d) => d.organizacaoId === organizacaoId && d.leitura?.idTransacao === idTransacao) ?? null; },
    }),
    // Agente 2 — documentos recebidos SEM leitura e a conferência humana deles (trilha só de inclusão, como mova.auditoria).
    documentosRecebidos: Object.freeze({
      async listar({ organizacaoId, unidadeId, limite = 200 }) {
        return [...documentos.entries()].filter(([, d]) => d.organizacaoId === organizacaoId && d.unidadeId === unidadeId && d.leitura?.modo === "SEM_LEITURA")
          .map(([sha256, d]) => linhaDoRecebido(sha256, d, conferencias.get(sha256) ?? [])).sort((x, y) => y.recebidoEm.localeCompare(x.recebidoEm)).slice(0, limite);
      },
      async obter({ organizacaoId, unidadeId, sha256 }) {
        const d = documentos.get(sha256);
        return d && d.organizacaoId === organizacaoId && d.unidadeId === unidadeId && d.leitura?.modo === "SEM_LEITURA" ? linhaDoRecebido(sha256, d, conferencias.get(sha256) ?? []) : null;
      },
      async conferir({ organizacaoId, unidadeId, sha256, versao, por, ...dados }) {
        const d = documentos.get(sha256);
        if (!d || d.organizacaoId !== organizacaoId || d.unidadeId !== unidadeId || d.leitura?.modo !== "SEM_LEITURA") return null;
        const lista = conferencias.get(sha256) ?? [];
        if (lista.length !== versao) throw Object.assign(new Error("versão"), { codigo: "CONFLITO_VERSAO" });
        lista.push(Object.freeze({ ...dados, organizacaoId, unidadeId, por, em: relogio().toISOString() }));
        conferencias.set(sha256, lista);
        auditoria.push(Object.freeze({ acao: "DOCUMENTO_CONFERENCIA", atorTipo: "USUARIO", atorRef: por, alvo: sha256, dados: { ...dados, organizacaoId, unidadeId, versao } }));
        return linhaDoRecebido(sha256, d, lista);
      },
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
    /** Agente 2 — continuidade (mesma regra do Postgres). */
    conversas: Object.freeze({
      async registrar({ grupoId, participanteId, unidadeId = null, consulta = null, validadeMs }) {
        const k = `${grupoId}|${participanteId}`; const atual = conversas.get(k);
        conversas.set(k, { ate: relogio().getTime() + validadeMs, unidadeId: unidadeId ?? atual?.unidadeId ?? null, consulta: consulta ?? atual?.consulta ?? null });
      },
      async obter({ grupoId, participanteId }) {
        const c = conversas.get(`${grupoId}|${participanteId}`);
        return c && c.ate > relogio().getTime() ? { unidadeId: c.unidadeId, consulta: c.consulta } : null;
      },
      async encerrar({ grupoId, participanteId }) { conversas.delete(`${grupoId}|${participanteId}`); },
    }),
    politicas: Object.freeze({
      async listar(organizacaoId) { return politicas.filter((p) => p.organizacaoId === organizacaoId); },
      async criar(p, { criadaPor }) {
        if (politicas.some((x) => !x.revogadaEm && x.operacao === p.operacao && x.organizacaoId === p.organizacaoId && (x.unidadeId ?? null) === (p.unidadeId ?? null))) throw Object.assign(new Error("política ativa já existe"), { codigo: "POLITICA_ATIVA_EXISTE" });
        const id = gerarId(); politicas.push({ ...p, unidadeId: p.unidadeId ?? null, vigenteAte: p.vigenteAte ?? null, id, criadaPor, revogadaEm: null }); return id;
      },
      async revogar({ id, organizacaoId, por }) {
        const i = politicas.findIndex((x) => x.id === id && x.organizacaoId === organizacaoId && !x.revogadaEm);
        if (i < 0) return false; politicas[i] = { ...politicas[i], revogadaEm: relogio().toISOString(), revogadaPor: por }; return true;
      },
    }),
    operacoes: Object.freeze({
      async reservar(o) {
        const ex = [...operacoes.values()].find((x) => x.chave === o.chave);
        if (ex) return { operacao: ex, nova: false };
        const op = Object.freeze({ ...o, id: gerarId(), estado: "EXECUTANDO", resultado: null, motivo: null, criadaEm: relogio().toISOString(), revertidaPor: null, revertidaEm: null, justificativaReversao: null });
        operacoes.set(op.id, op); return { operacao: op, nova: true };
      },
      async concluir(id, resultado) { const o = operacoes.get(id); if (o?.estado !== "EXECUTANDO") return null; const n = Object.freeze({ ...o, estado: "EXECUTADA", resultado }); operacoes.set(id, n); return n; },
      async falhar(id, motivo) { const o = operacoes.get(id); if (o?.estado !== "EXECUTANDO") return null; const n = Object.freeze({ ...o, estado: "FALHOU", motivo }); operacoes.set(id, n); return n; },
      async reverter(id, escopo, { por, justificativa, resultado }) {
        const o = operacoes.get(id);
        if (!o || o.estado !== "EXECUTADA" || o.organizacaoId !== escopo.organizacaoId || o.unidadeId !== escopo.unidadeId) return null;
        const n = Object.freeze({ ...o, estado: "REVERTIDA", revertidaPor: por, revertidaEm: relogio().toISOString(), justificativaReversao: justificativa, resultado: { ...o.resultado, reversao: resultado ?? {} } });
        operacoes.set(id, n); return n;
      },
      async obter(id, escopo) { const o = operacoes.get(id); return o && o.organizacaoId === escopo.organizacaoId && o.unidadeId === escopo.unidadeId ? o : null; },
      async listar(escopo) { return [...operacoes.values()].filter((o) => o.organizacaoId === escopo.organizacaoId && o.unidadeId === escopo.unidadeId).reverse(); },
    }),
    // Agente 2 — Frente D: notas recebidas dos entregadores, envios da rotina (chave única) e automações com pausa.
    notasEntregador: Object.freeze({
      async registrar(n) {
        const k = `${n.unidadeId}|${n.entregador}|${n.semanaInicio}|${n.sha256}`;
        if (notas.has(k)) return { nota: notas.get(k), nova: false };
        const nota = { id: randomUUID(), ...n, estado: "PENDENTE_ANEXO", motivo: null, documentoId: null, situacaoDocumental: null, criadaEm: relogio().toISOString() };
        notas.set(k, nota); return { nota: Object.freeze({ ...nota }), nova: true };
      },
      async concluir(id, { estado, motivo = null, documentoId = null, situacaoDocumental = null }) {
        const n = [...notas.values()].find((x) => x.id === id); if (!n || n.estado !== "PENDENTE_ANEXO") return false;
        Object.assign(n, { estado, motivo, documentoId, situacaoDocumental }); return true;
      },
      async registrarLeitura(id, { leitura, conferencia }) { const n = [...notas.values()].find((x) => x.id === id); if (n) Object.assign(n, { leitura, conferencia }); },
      async listar(escopo) { return [...notas.values()].filter((n) => n.organizacaoId === escopo.organizacaoId && n.unidadeId === escopo.unidadeId).map((n) => Object.freeze({ ...n })).reverse(); },
    }),
    entregadores: Object.freeze({
      async cadastrar(e) {
        if (cadastrados.some((x) => x.ativo && x.unidadeId === e.unidadeId && (x.chave === e.chave || x.telefoneE164 === e.telefoneE164))) return { conflito: true };
        const id = randomUUID(); cadastrados.push({ id, ...e, observacoes: e.observacoes ?? null, ativo: true, criadoEm: relogio().toISOString(), revogadoEm: null, revogadoPor: null, motivoRevogacao: null }); return { id };
      },
      async revogar({ organizacaoId, unidadeId, chave, por = null, motivo = "DESATIVADO" }) {
        let n = 0; for (const x of cadastrados) if (x.ativo && x.organizacaoId === organizacaoId && x.unidadeId === unidadeId && x.chave === chave) { Object.assign(x, { ativo: false, revogadoEm: relogio().toISOString(), revogadoPor: por, motivoRevogacao: motivo }); n++; } return n;
      },
      async alterar({ organizacaoId, unidadeId, chave, por, mudancas }) {
        const v = cadastrados.find((x) => x.ativo && x.organizacaoId === organizacaoId && x.unidadeId === unidadeId && x.chave === chave);
        if (!v) return { naoEncontrado: true };
        const nova = { telefoneE164: mudancas.telefoneE164 ?? v.telefoneE164, privado: mudancas.privado ?? v.privado, nome: mudancas.nome !== undefined ? mudancas.nome : v.nome, observacoes: mudancas.observacoes !== undefined ? mudancas.observacoes : v.observacoes };
        if (nova.telefoneE164 === v.telefoneE164 && nova.nome === v.nome && nova.observacoes === v.observacoes) return { semMudanca: true };
        if (cadastrados.some((x) => x !== v && x.ativo && x.unidadeId === unidadeId && x.telefoneE164 === nova.telefoneE164)) return { conflito: true };
        const motivo = nova.telefoneE164 !== v.telefoneE164 ? "TROCA_DE_NUMERO" : "EDICAO";
        Object.assign(v, { ativo: false, revogadoEm: relogio().toISOString(), revogadoPor: por, motivoRevogacao: motivo });
        const id = randomUUID(); cadastrados.push({ id, organizacaoId, unidadeId, chave, ...nova, cadastradoPor: por, ativo: true, criadoEm: relogio().toISOString(), revogadoEm: null, revogadoPor: null, motivoRevogacao: null });
        return { id, motivo, anterior: `…${v.telefoneE164.slice(-4)}`, atual: `…${nova.telefoneE164.slice(-4)}` };
      },
      async reativar({ organizacaoId, unidadeId, chave, por }) {
        if (cadastrados.some((x) => x.ativo && x.unidadeId === unidadeId && x.chave === chave)) return { conflito: true };
        const u = cadastrados.filter((x) => x.organizacaoId === organizacaoId && x.unidadeId === unidadeId && x.chave === chave).at(-1);
        if (!u) return { naoEncontrado: true };
        if (cadastrados.some((x) => x.ativo && x.unidadeId === unidadeId && x.telefoneE164 === u.telefoneE164)) return { conflito: true };
        const id = randomUUID(); cadastrados.push({ ...u, id, cadastradoPor: por, ativo: true, criadoEm: relogio().toISOString(), revogadoEm: null, revogadoPor: null, motivoRevogacao: null });
        return { id, telefone: `…${u.telefoneE164.slice(-4)}` };
      },
      async listar(escopo) {
        return cadastrados.filter((x) => x.organizacaoId === escopo.organizacaoId && x.unidadeId === escopo.unidadeId).map((x) => ({ id: x.id, chave: x.chave, telefone: `…${x.telefoneE164.slice(-4)}`, nome: x.nome ?? null,
          observacoes: x.observacoes ?? null, ativo: x.ativo, criadoEm: x.criadoEm, cadastradoPor: x.cadastradoPor ?? null, verificadoEm: null, revogadoEm: x.revogadoEm, revogadoPor: x.revogadoPor ?? null, motivoRevogacao: x.motivoRevogacao ?? null })).reverse();
      },
    }),
    enviosEntregador: Object.freeze({
      async registrar(e) { if (envios.has(e.chave)) return false; envios.set(e.chave, Object.freeze({ ...e, criadoEm: relogio().toISOString() })); return true; },
      async listar(escopo) { return [...envios.values()].filter((e) => e.organizacaoId === escopo.organizacaoId && e.unidadeId === escopo.unidadeId).reverse(); },
    }),
    automacoes: Object.freeze({
      async obter(nome, unidadeId) { const x = automacoes.get(`${nome}|${unidadeId}`); return x ? Object.freeze({ ...x }) : null; },
      async listar(escopo) { return [...automacoes.values()].filter((x) => x.organizacaoId === escopo.organizacaoId && x.unidadeId === escopo.unidadeId).map((x) => Object.freeze({ ...x })); },
      async definir({ nome, organizacaoId, unidadeId, ativa, horario = "09:00" }) {
        const k = `${nome}|${unidadeId}`; const atual = automacoes.get(k);
        automacoes.set(k, { nome, organizacaoId, unidadeId, ativa, horario, pausadaEm: atual?.pausadaEm ?? null, pausadaPor: atual?.pausadaPor ?? null, motivo: atual?.motivo ?? null, ultimaExecucao: atual?.ultimaExecucao ?? null });
        return Object.freeze({ ...automacoes.get(k) });
      },
      async pausar({ nome, unidadeId, por, motivo = null }) { const x = automacoes.get(`${nome}|${unidadeId}`); if (!x) return null; Object.assign(x, { pausadaEm: relogio().toISOString(), pausadaPor: por, motivo }); return Object.freeze({ ...x }); },
      async retomar({ nome, unidadeId }) { const x = automacoes.get(`${nome}|${unidadeId}`); if (!x) return null; Object.assign(x, { pausadaEm: null, pausadaPor: null, motivo: null }); return Object.freeze({ ...x }); },
      async marcarExecucao(nome, unidadeId, em) { const x = automacoes.get(`${nome}|${unidadeId}`); if (x) x.ultimaExecucao = em; },
    }),
    membros: Object.freeze({
      async registrar({ grupoId, membros, verificadoEm = null }) { retratos.set(grupoId, { membros: [...membros], verificadoEm: verificadoEm ?? relogio().toISOString() }); },
      async obter(grupoId) { return retratos.get(grupoId) ?? null; },
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
