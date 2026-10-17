// Repositório EM MEMÓRIA com a mesma interface de repositorio.js — só para testes (dados sintéticos).
// Reproduz o escopo por organização+unidade e as regras de integridade essenciais do SQL (tenant, par de transferência, idempotência
// por chave_origem, período fechado); a fidelidade ao banco real é provada em backend/testes-financeiro-pg (PostgreSQL descartável).
import { randomUUID } from "node:crypto";
import { ApiError } from "../../../src/shared/ApiError.js";
import { exigirContexto } from "../../../src/modules/gestao-financeira/dominio/contexto.js";

export function criarRepoMemoria() {
  const t = { plano: [], contas: [], aberturas: [], lanc: [], transf: [], per: [], imp: [], aud: [] };
  const agora = () => new Date().toISOString();
  const noOrg = (c) => (x) => x.organizacao_id === c.organizacaoId;
  const noTen = (c) => (x) => x.organizacao_id === c.organizacaoId && x.unidade_id === c.unidadeId;
  const audita = (c, acao, entidade, antes, depois) => t.aud.push({ id: t.aud.length + 1, organizacao_id: c.organizacaoId, unidade_id: c.unidadeId, ator_id: c.usuarioId, acao, entidade, entidade_id: (depois ?? antes).id, antes, depois, created_at: agora() });
  const erro = (m, codigo) => { throw ApiError.badRequest(m, { codigo }); };
  const periodoFechado = (c, data) => t.per.some((p) => p.unidade_id === c.unidadeId && p.status === "fechado" && p.mes === `${data.slice(0, 7)}-01`);

  const r = {
    _t: t,
    async listarPlanoContas(ctx) { const c = exigirContexto(ctx); return t.plano.filter(noOrg(c)).map((x) => ({ ...x })); },
    async inserirCategoria(ctx, v) {
      const c = exigirContexto(ctx);
      if (t.plano.some((x) => noOrg(c)(x) && x.tipo === v.tipo && x.natureza === v.natureza && x.nome === v.nome)) erro("Registro duplicado.", "DUPLICADO");
      const n = { id: randomUUID(), ...v, ativo: true, organizacao_id: c.organizacaoId, created_at: agora() }; t.plano.push(n); audita(c, "fin_plano_contas.insert", "fin_plano_contas", null, n); return { ...n };
    },
    async atualizarCategoria(ctx, id, campos) {
      const c = exigirContexto(ctx); const n = t.plano.find((x) => x.id === id && noOrg(c)(x));
      if (!n) throw ApiError.notFound("Categoria não encontrada.");
      if (campos.papel && campos.papel !== n.papel && t.lanc.some((l) => l.categoria_id === id)) erro("categoria ja possui lancamentos; crie outra categoria e reclassifique com auditoria", "FIN_PAPEL_EM_USO");
      const antes = { ...n }; Object.assign(n, campos); audita(c, "fin_plano_contas.update", "fin_plano_contas", antes, { ...n }); return { ...n };
    },
    async listarContas(ctx) { const c = exigirContexto(ctx); return t.contas.filter(noTen(c)).map((x) => ({ ...x })); },
    async inserirConta(ctx, v) {
      const c = exigirContexto(ctx);
      if (t.contas.some((x) => noTen(c)(x) && x.nome === v.nome)) erro("Registro duplicado.", "DUPLICADO");
      const n = { id: randomUUID(), ...v, ativo: true, organizacao_id: c.organizacaoId, unidade_id: c.unidadeId, created_at: agora() }; t.contas.push(n); audita(c, "fin_contas.insert", "fin_contas", null, n); return { ...n };
    },
    async atualizarConta(ctx, id, campos) {
      const c = exigirContexto(ctx); const n = t.contas.find((x) => x.id === id && noTen(c)(x));
      if (!n) throw ApiError.notFound("Conta não encontrada."); Object.assign(n, campos); return { ...n };
    },
    async listarAberturas(ctx) { const c = exigirContexto(ctx); return t.aberturas.filter(noTen(c)).map((x) => ({ ...x })); },
    async gravarAbertura(ctx, a) {
      const c = exigirContexto(ctx);
      if (!t.contas.some((x) => x.id === a.conta_id && noTen(c)(x))) erro("conta de outro tenant", "FIN_ESCOPO_INVALIDO");
      let n = t.aberturas.find((x) => x.conta_id === a.conta_id && x.data_referencia === a.data_referencia);
      if (n) Object.assign(n, a); else { n = { id: randomUUID(), ...a, organizacao_id: c.organizacaoId, unidade_id: c.unidadeId, origem: "manual" }; t.aberturas.push(n); }
      return { ...n };
    },
    async listarLancamentos(ctx, f = {}) {
      const c = exigirContexto(ctx);
      let l = t.lanc.filter(noTen(c));
      if (f.de) l = l.filter((x) => x.data_movimento >= f.de); if (f.ate) l = l.filter((x) => x.data_movimento <= f.ate);
      if (f.contaId) l = l.filter((x) => x.conta_id === f.contaId); if (f.categoriaId) l = l.filter((x) => x.categoria_id === f.categoriaId);
      if (f.sentido) l = l.filter((x) => x.sentido === f.sentido); if (f.status) l = l.filter((x) => x.status === f.status);
      if (f.pendente != null) l = l.filter((x) => x.classificacao_pendente === f.pendente);
      if (f.busca) l = l.filter((x) => x.descricao.toLowerCase().includes(String(f.busca).toLowerCase()));
      l.sort((a, b) => b.data_movimento.localeCompare(a.data_movimento) || b.created_at.localeCompare(a.created_at));
      return { itens: l.slice(f.deslocamento ?? 0, (f.deslocamento ?? 0) + (f.limite ?? 200)).map((x) => ({ ...x })), total: l.length };
    },
    async listarTodosLancamentos(ctx, { de, ate } = {}) { const c = exigirContexto(ctx); return t.lanc.filter(noTen(c)).filter((x) => (!de || x.data_movimento >= de) && (!ate || x.data_movimento <= ate)).map((x) => ({ ...x })); },
    async obterLancamento(ctx, id) { const c = exigirContexto(ctx); const x = t.lanc.find((y) => y.id === id && noTen(c)(y)); return x ? { ...x } : null; },
    async inserirLancamento(ctx, l) {
      const c = exigirContexto(ctx);
      if (!t.contas.some((x) => x.id === l.conta_id && noTen(c)(x))) erro("conta de outro tenant", "FIN_ESCOPO_INVALIDO");
      if (l.categoria_id && !t.plano.some((x) => x.id === l.categoria_id && noOrg(c)(x))) erro("categoria de outra organizacao", "FIN_ESCOPO_INVALIDO");
      if (periodoFechado(c, l.data_movimento)) erro("periodo fechado", "FIN_PERIODO_FECHADO");
      const n = { id: randomUUID(), ...l, organizacao_id: c.organizacaoId, unidade_id: c.unidadeId, origem: "manual", created_at: agora(), updated_at: agora() };
      t.lanc.push(n); audita(c, "fin_lancamentos.insert", "fin_lancamentos", null, n); return { ...n };
    },
    async atualizarLancamento(ctx, id, campos) {
      const c = exigirContexto(ctx); const n = t.lanc.find((x) => x.id === id && noTen(c)(x));
      if (!n) throw ApiError.notFound("Lançamento não encontrado.");
      if (periodoFechado(c, n.data_movimento)) erro("periodo fechado", "FIN_PERIODO_FECHADO");
      const antes = { ...n }; Object.assign(n, campos, { updated_at: agora() }); audita(c, "fin_lancamentos.update", "fin_lancamentos", antes, { ...n }); return { ...n };
    },
    async listarTransferencias(ctx) { const c = exigirContexto(ctx); return t.transf.filter(noTen(c)).map((x) => ({ ...x })); },
    async criarTransferenciaRpc(ctx, p) {
      const c = exigirContexto(ctx);
      const mk = (conta, sentido) => r.inserirLancamento(c, { conta_id: conta, categoria_id: p.categoriaId, descricao: p.descricao, sentido, valor_centavos: p.valorCentavos, data_movimento: p.data, status: "realizado", classificacao_pendente: false });
      const s = await mk(p.contaOrigemId, "saida"); const e = await mk(p.contaDestinoId, "entrada");
      const n = { id: randomUUID(), organizacao_id: c.organizacaoId, unidade_id: c.unidadeId, lancamento_saida_id: s.id, lancamento_entrada_id: e.id, origem: "manual", created_at: agora() };
      t.transf.push(n); return n.id;
    },
    async vincularTransferenciaRpc(ctx, saidaId, entradaId) {
      const c = exigirContexto(ctx); const s = t.lanc.find((x) => x.id === saidaId && noTen(c)(x)); const e = t.lanc.find((x) => x.id === entradaId && noTen(c)(x));
      if (!s || !e || s.sentido !== "saida" || e.sentido !== "entrada" || s.valor_centavos !== e.valor_centavos || s.conta_id === e.conta_id) erro("par invalido", "FIN_PAR_INVALIDO");
      const n = { id: randomUUID(), organizacao_id: c.organizacaoId, unidade_id: c.unidadeId, lancamento_saida_id: saidaId, lancamento_entrada_id: entradaId, origem: "manual", created_at: agora() };
      t.transf.push(n); s.classificacao_pendente = false; e.classificacao_pendente = false; return n.id;
    },
    async desvincularTransferenciaRpc(ctx, id) {
      const c = exigirContexto(ctx); const i = t.transf.findIndex((x) => x.id === id && noTen(c)(x)); if (i < 0) return false;
      const [p] = t.transf.splice(i, 1); for (const l of t.lanc) if ([p.lancamento_saida_id, p.lancamento_entrada_id].includes(l.id)) l.classificacao_pendente = true; return true;
    },
    async inserirImportacao(ctx, i) { const c = exigirContexto(ctx); const n = { id: randomUUID(), status: "previa", ...i, organizacao_id: c.organizacaoId, unidade_id: c.unidadeId, created_at: agora() }; t.imp.push(n); return { ...n }; },
    async obterImportacao(ctx, id) { const c = exigirContexto(ctx); const x = t.imp.find((y) => y.id === id && noTen(c)(y)); return x ? structuredClone(x) : null; },
    async listarImportacoes(ctx) { const c = exigirContexto(ctx); return t.imp.filter(noTen(c)).map(({ previa, ...x }) => x); },
    async atualizarPreviaImportacao(ctx, id, previa) {
      const c = exigirContexto(ctx); const x = t.imp.find((y) => y.id === id && noTen(c)(y) && y.status === "previa");
      if (!x) erro("A importação não está mais em estado de prévia.", "IMPORTACAO_ESTADO_INVALIDO"); x.previa = structuredClone(previa);
    },
    async cancelarImportacao(ctx, id) {
      const c = exigirContexto(ctx); const x = t.imp.find((y) => y.id === id && noTen(c)(y) && y.status === "previa");
      if (!x) erro("Só uma prévia pode ser cancelada.", "IMPORTACAO_ESTADO_INVALIDO"); x.status = "cancelada";
    },
    async listarExistentesImportacao(ctx) { const c = exigirContexto(ctx); return t.lanc.filter((x) => noTen(c)(x) && x.chave_origem).map((x) => ({ ...x })); },
    /** Emula fin_confirmar_importacao: tudo ou nada (snapshot + restauração em caso de erro). */
    async confirmarImportacaoRpc(ctx, id) {
      const c = exigirContexto(ctx); const imp = t.imp.find((y) => y.id === id && noTen(c)(y));
      if (!imp) erro("importacao nao encontrada", "P0002"); if (imp.status === "confirmada") return { ...imp.resumo, jaConfirmada: true }; if (imp.status !== "previa") erro("estado invalido", "FIN_IMPORTACAO_ESTADO_INVALIDO");
      const snap = structuredClone({ plano: t.plano, contas: t.contas, aberturas: t.aberturas, lanc: t.lanc, transf: t.transf });
      try {
        const p = imp.previa;
        for (const x of p.contas ?? []) if (!t.contas.some((k) => noTen(c)(k) && k.nome === x.nome)) t.contas.push({ id: randomUUID(), organizacao_id: c.organizacaoId, unidade_id: c.unidadeId, nome: x.nome, tipo_conta: x.tipo_conta ?? "outra", ativo: true, created_at: agora() });
        for (const x of p.categorias ?? []) if (!t.plano.some((k) => noOrg(c)(k) && k.tipo === x.tipo && k.natureza === x.natureza && k.nome === x.nome)) t.plano.push({ id: randomUUID(), organizacao_id: c.organizacaoId, ...x, ativo: true, created_at: agora() });
        const conta = (n) => t.contas.find((k) => noTen(c)(k) && k.nome === n);
        let saldos = 0;
        for (const s of p.saldos ?? []) if (!t.aberturas.some((k) => k.conta_id === conta(s.conta).id && k.data_referencia === s.data)) { t.aberturas.push({ id: randomUUID(), organizacao_id: c.organizacaoId, unidade_id: c.unidadeId, conta_id: conta(s.conta).id, data_referencia: s.data, valor_centavos: s.valor_centavos, origem: "importacao" }); saldos++; }
        let gravados = 0, dup = 0;
        for (const l of (p.lancamentos ?? []).filter((x) => x.importar !== false)) {
          if (t.lanc.some((k) => noTen(c)(k) && k.chave_origem === l.chave)) { dup++; continue; }
          if (periodoFechado(c, l.data)) erro("periodo fechado", "FIN_PERIODO_FECHADO");
          const cat = l.categoria ? t.plano.find((k) => noOrg(c)(k) && k.tipo === l.categoria.tipo && k.natureza === l.categoria.natureza && k.nome === l.categoria.nome) : null;
          t.lanc.push({ id: randomUUID(), organizacao_id: c.organizacaoId, unidade_id: c.unidadeId, conta_id: conta(l.conta).id, categoria_id: cat?.id ?? null, descricao: l.descricao, sentido: l.sentido, valor_centavos: l.valor_centavos, data_movimento: l.data, status: "realizado", origem: "importacao", importacao_id: id, chave_origem: l.chave, classificacao_pendente: Boolean(l.pendente) || !cat, nota_revisao: l.nota ?? null, created_at: agora(), updated_at: agora() });
          gravados++;
        }
        let pares = 0;
        for (const q of (p.pares ?? []).filter((x) => x.confirmado)) {
          const s = t.lanc.find((k) => noTen(c)(k) && k.chave_origem === q.saida); const e = t.lanc.find((k) => noTen(c)(k) && k.chave_origem === q.entrada);
          if (s && e && !t.transf.some((k) => k.lancamento_saida_id === s.id)) { t.transf.push({ id: randomUUID(), organizacao_id: c.organizacaoId, unidade_id: c.unidadeId, lancamento_saida_id: s.id, lancamento_entrada_id: e.id, origem: "importacao", created_at: agora() }); pares++; }
        }
        imp.resumo = { lancamentosGravados: gravados, jaExistentes: dup, saldosGravados: saldos, paresVinculados: pares }; imp.status = "confirmada";
        return imp.resumo;
      } catch (e) { Object.assign(t, snap); throw e; }
    },
    async listarAuditoria(ctx, { entidade, entidadeId } = {}) { const c = exigirContexto(ctx); return t.aud.filter((a) => noTen(c)(a) || (a.organizacao_id === c.organizacaoId && !a.unidade_id)).filter((a) => (!entidade || a.entidade === entidade) && (!entidadeId || a.entidade_id === entidadeId)).reverse(); },
    fecharPeriodo(ctx, ym) { const c = exigirContexto(ctx); t.per.push({ unidade_id: c.unidadeId, status: "fechado", mes: `${ym}-01` }); },
  };
  return r;
}
