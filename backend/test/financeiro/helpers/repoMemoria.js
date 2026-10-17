// Repositório EM MEMÓRIA com a mesma interface de repositorio.js — só para testes (dados sintéticos).
// Reproduz o escopo por organização+unidade e as regras de integridade essenciais do SQL (tenant, par de transferência, idempotência
// por chave_origem, período fechado); a fidelidade ao banco real é provada em backend/testes-financeiro-pg (PostgreSQL descartável).
import { randomUUID } from "node:crypto";
import { ApiError } from "../../../src/shared/ApiError.js";
import { exigirContexto } from "../../../src/modules/gestao-financeira/dominio/contexto.js";
import { falha } from "../../../src/modules/gestao-financeira/dominio/repositorio.util.js";
import { createHash } from "node:crypto";

export function criarRepoMemoria() {
  const t = { plano: [], contas: [], aberturas: [], lanc: [], transf: [], per: [], imp: [], aud: [], refs: [], resol: [], exc: [], exf: [] };
  const agora = () => new Date().toISOString();
  const noOrg = (c) => (x) => x.organizacao_id === c.organizacaoId;
  const noTen = (c) => (x) => x.organizacao_id === c.organizacaoId && x.unidade_id === c.unidadeId;
  const audita = (c, acao, entidade, antes, depois) => t.aud.push({ id: t.aud.length + 1, organizacao_id: c.organizacaoId, unidade_id: c.unidadeId, ator_id: c.usuarioId, acao, entidade, entidade_id: (depois ?? antes).id, antes, depois, created_at: agora() });
  const erro = (m, codigo) => { throw ApiError.badRequest(m, { codigo }); };
  const periodoFechado = (c, data) => t.per.some((p) => p.unidade_id === c.unidadeId && p.status === "fechado" && p.mes === `${data.slice(0, 7)}-01`);
  // mesma regra do banco: qualquer escrita datada garante a linha do período (aberto) e recusa mês fechado
  const garantirPeriodo = (c, data) => {
    const mes = `${data.slice(0, 7)}-01`;
    let p = t.per.find((x) => x.unidade_id === c.unidadeId && x.mes === mes);
    if (!p) { p = { id: randomUUID(), organizacao_id: c.organizacaoId, unidade_id: c.unidadeId, mes, status: "aberto", versao: 1, snapshot: null }; t.per.push(p); }
    if (p.status === "fechado") regra("fin_periodo_fechado");
    return p;
  };
  const regra = (codigo, code = "23514") => falha({ code, message: codigo });
  const par = (c, id) => t.transf.find((x) => x.id === id && noTen(c)(x));
  const parDaPerna = (lid) => t.transf.find((x) => x.lancamento_saida_id === lid || x.lancamento_entrada_id === lid);
  const impressao = (c, mes) => createHash("sha256").update(JSON.stringify([
    t.lanc.filter((l) => noTen(c)(l) && l.data_movimento.startsWith(mes)).map((l) => [l.id, l.valor_centavos, l.sentido, l.status, l.categoria_id, l.conta_id, l.classificacao_pendente]).sort(),
    t.refs.filter((r) => noTen(c)(r) && r.data.startsWith(mes)).map((r) => [r.id, r.valor_centavos, r.status, r.tipo, r.canal]).sort(),
    t.resol.filter((r) => noTen(c)(r) && r.chave.startsWith(mes)).map((r) => [r.id, r.valor_centavos, r.status]).sort(),
    t.aberturas.filter((a) => noTen(c)(a) && a.data_referencia.startsWith(mes)).map((a) => [a.id, a.valor_centavos]).sort(),
  ])).digest("hex");

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
      if (campos.papel && campos.papel !== n.papel && t.lanc.some((l) => l.categoria_id === id)) regra("fin_papel_em_uso");
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
      garantirPeriodo(c, a.data_referencia);
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
      garantirPeriodo(c, l.data_movimento);
      const n = { id: randomUUID(), revisao_motivos: [], ...l, organizacao_id: c.organizacaoId, unidade_id: c.unidadeId, origem: "manual", created_at: agora(), updated_at: agora() };
      t.lanc.push(n); audita(c, "fin_lancamentos.insert", "fin_lancamentos", null, n); return { ...n };
    },
    async atualizarLancamento(ctx, id, campos) {
      const c = exigirContexto(ctx); const n = t.lanc.find((x) => x.id === id && noTen(c)(x));
      if (!n) throw ApiError.notFound("Lançamento não encontrado.");
      garantirPeriodo(c, n.data_movimento);
      if (campos.data_movimento) garantirPeriodo(c, campos.data_movimento);
      const pr = parDaPerna(n.id);
      if (pr) {
        const mudou = (k) => k in campos && campos[k] !== n[k];
        if (["valor_centavos", "sentido", "conta_id", "data_movimento", "categoria_id"].some(mudou)) regra("fin_transferencia_vinculada");
        if (mudou("status")) regra("fin_transferencia_vinculada");
      }
      const antes = { ...n }; Object.assign(n, campos, { updated_at: agora() }); audita(c, "fin_lancamentos.update", "fin_lancamentos", antes, { ...n }); return { ...n };
    },
    async listarTransferencias(ctx) { const c = exigirContexto(ctx); return t.transf.filter(noTen(c)).map((x) => ({ ...x })); },
    async criarTransferenciaRpc(ctx, p) {
      const c = exigirContexto(ctx);
      const mk = (conta, sentido) => r.inserirLancamento(c, { conta_id: conta, categoria_id: p.categoriaId, descricao: p.descricao, sentido, valor_centavos: p.valorCentavos, data_movimento: p.data, status: "realizado", classificacao_pendente: false });
      const s = await mk(p.contaOrigemId, "saida"); const e = await mk(p.contaDestinoId, "entrada");
      const n = { id: randomUUID(), organizacao_id: c.organizacaoId, unidade_id: c.unidadeId, lancamento_saida_id: s.id, lancamento_entrada_id: e.id, origem: "manual", status: "vinculada", created_at: agora() };
      t.transf.push(n); audita(c, "fin_transferencias.insert", "fin_transferencias", null, n); return n.id;
    },
    async vincularTransferenciaRpc(ctx, saidaId, entradaId) {
      const c = exigirContexto(ctx); const s = t.lanc.find((x) => x.id === saidaId && noTen(c)(x)); const e = t.lanc.find((x) => x.id === entradaId && noTen(c)(x));
      if (!s || !e || s.sentido !== "saida" || e.sentido !== "entrada" || s.valor_centavos !== e.valor_centavos || s.conta_id === e.conta_id) erro("par invalido", "FIN_PAR_INVALIDO");
      const n = { id: randomUUID(), organizacao_id: c.organizacaoId, unidade_id: c.unidadeId, lancamento_saida_id: saidaId, lancamento_entrada_id: entradaId, origem: "manual", status: "vinculada", created_at: agora() };
      t.transf.push(n); s.classificacao_pendente = false; e.classificacao_pendente = false; audita(c, "fin_transferencias.insert", "fin_transferencias", null, n); return n.id;
    },
    async desvincularTransferenciaRpc(ctx, id, motivo) {
      const c = exigirContexto(ctx);
      if (String(motivo ?? "").trim().length < 10) regra("fin_transferencia_motivo_obrigatorio");
      const p = par(c, id); if (!p) return false;
      if (p.status !== "vinculada") regra("fin_transferencia_cancelada_imutavel");
      const pernas = t.lanc.filter((l) => l.id === p.lancamento_saida_id || l.id === p.lancamento_entrada_id);
      if (pernas.some((l) => l.status !== "realizado")) regra("fin_transferencia_estado_inconsistente");
      t.transf.splice(t.transf.indexOf(p), 1); audita(c, "fin_transferencias.delete", "fin_transferencias", { ...p }, null);
      for (const l of pernas) {
        const antes = { ...l };
        l.classificacao_pendente = true; l.atualizado_por = c.usuarioId;
        l.nota_revisao = l.nota_revisao ? `${l.nota_revisao} | Par desfeito: ${motivo.trim()}` : `Par desfeito: ${motivo.trim()}`;
        if (!l.revisao_motivos.includes("transferencia_sem_contraparte")) l.revisao_motivos = [...l.revisao_motivos, "transferencia_sem_contraparte"];
        audita(c, "fin_lancamentos.update", "fin_lancamentos", antes, { ...l });
      }
      return true;
    },
    /** Tudo ou nada: valida TUDO antes de mudar qualquer coisa (como a transação do banco). Idempotente. */
    async cancelarTransferenciaRpc(ctx, id, motivo) {
      const c = exigirContexto(ctx);
      const m = String(motivo ?? "").trim();
      if (m.length < 10) regra("fin_transferencia_motivo_obrigatorio");
      const p = par(c, id); if (!p) regra("fin_transferencia_nao_encontrada", "P0002");
      const pernas = [p.lancamento_saida_id, p.lancamento_entrada_id].map((x) => t.lanc.find((l) => l.id === x));
      if (p.status === "cancelada") {
        if (pernas.every((l) => l.status === "cancelado")) return { id: p.id, status: "cancelada", jaCancelada: true, lancamentos: pernas.map((l) => l.id) };
        regra("fin_transferencia_estado_inconsistente");
      }
      if (pernas.some((l) => l.status === "cancelado")) regra("fin_transferencia_estado_inconsistente");
      if (pernas.some((l) => l.status !== "realizado")) regra("fin_transferencia_nao_cancelavel");
      for (const l of pernas) garantirPeriodo(c, l.data_movimento);          // qualquer mês fechado → recusa ANTES de mudar algo
      const antesPar = { ...p };
      Object.assign(p, { status: "cancelada", cancelada_por: c.usuarioId, cancelada_em: agora(), motivo_cancelamento: m });
      audita(c, "fin_transferencias.update", "fin_transferencias", antesPar, { ...p });
      for (const l of pernas) {
        const antes = { ...l };
        Object.assign(l, { status: "cancelado", atualizado_por: c.usuarioId, nota_revisao: l.nota_revisao ? `${l.nota_revisao} | Transferencia cancelada: ${m}` : `Transferencia cancelada: ${m}`, updated_at: agora() });
        audita(c, "fin_lancamentos.update", "fin_lancamentos", antes, { ...l });
      }
      return { id: p.id, status: "cancelada", jaCancelada: false, lancamentos: pernas.map((l) => l.id) };
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
          garantirPeriodo(c, l.data);
          const cat = l.categoria ? t.plano.find((k) => noOrg(c)(k) && k.tipo === l.categoria.tipo && k.natureza === l.categoria.natureza && k.nome === l.categoria.nome) : null;
          t.lanc.push({ id: randomUUID(), organizacao_id: c.organizacaoId, unidade_id: c.unidadeId, conta_id: conta(l.conta).id, categoria_id: cat?.id ?? null, descricao: l.descricao, sentido: l.sentido, valor_centavos: l.valor_centavos, data_movimento: l.data, status: "realizado", origem: "importacao", importacao_id: id, chave_origem: l.chave, classificacao_pendente: Boolean(l.pendente) || !cat, nota_revisao: l.nota ?? null, revisao_motivos: l.motivos ?? [], created_at: agora(), updated_at: agora() });
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
    // ---- B7: referências, classificações manuais, exceções de sangria ----
    async listarReferencias(ctx, { mes, incluirCanceladas = false } = {}) {
      const c = exigirContexto(ctx);
      return t.refs.filter((x) => noTen(c)(x) && (!mes || x.data.startsWith(mes)) && (incluirCanceladas || x.status === "ativa")).map((x) => ({ ...x }));
    },
    async inserirReferencias(ctx, itens) {
      const c = exigirContexto(ctx);
      const existentes = new Set(t.refs.filter(noTen(c)).map((x) => x.chave_origem).filter(Boolean));
      const novos = itens.filter((i) => !i.chave_origem || !existentes.has(i.chave_origem));
      for (const i of novos) garantirPeriodo(c, i.data);
      for (const i of novos) t.refs.push({ id: randomUUID(), status: "ativa", ...i, organizacao_id: c.organizacaoId, unidade_id: c.unidadeId, criado_por: c.usuarioId, created_at: agora() });
      return { gravados: novos.length, ignorados: itens.length - novos.length };
    },
    async cancelarReferencia(ctx, id, motivo) {
      const c = exigirContexto(ctx); const x = t.refs.find((y) => y.id === id && noTen(c)(y) && y.status === "ativa");
      if (!x) return null; garantirPeriodo(c, x.data);
      const antes = { ...x }; Object.assign(x, { status: "cancelada", cancelada_por: c.usuarioId, cancelada_em: agora(), motivo_cancelamento: motivo }); audita(c, "fin_referencias.update", "fin_referencias", antes, { ...x }); return { ...x };
    },
    async listarResolucoes(ctx, { mes, de, ate, incluirRevogadas = false } = {}) {
      const c = exigirContexto(ctx);
      return t.resol.filter((x) => noTen(c)(x) && (!mes || x.chave.startsWith(mes)) && (!de || x.chave >= de) && (!ate || x.chave <= ate) && (incluirRevogadas || x.status === "vigente")).map((x) => ({ ...x }));
    },
    async inserirResolucao(ctx, r) {
      const c = exigirContexto(ctx); garantirPeriodo(c, r.chave);
      const n = { id: randomUUID(), status: "vigente", ...r, organizacao_id: c.organizacaoId, unidade_id: c.unidadeId, criado_por: c.usuarioId, created_at: agora() };
      t.resol.push(n); audita(c, "fin_conciliacao_resolucoes.insert", "fin_conciliacao_resolucoes", null, n); return { ...n };
    },
    async revogarResolucao(ctx, id, motivo) {
      const c = exigirContexto(ctx); const x = t.resol.find((y) => y.id === id && noTen(c)(y) && y.status === "vigente");
      if (!x) return null; garantirPeriodo(c, x.chave);
      const antes = { ...x }; Object.assign(x, { status: "revogada", revogada_por: c.usuarioId, revogada_em: agora(), motivo_revogacao: motivo }); audita(c, "fin_conciliacao_resolucoes.update", "fin_conciliacao_resolucoes", antes, { ...x }); return { ...x };
    },
    async listarExcecoesSangria(ctx, { apenasAtivas = false } = {}) { const c = exigirContexto(ctx); return t.exc.filter((x) => noTen(c)(x) && (!apenasAtivas || x.ativa)).map((x) => ({ ...x })); },
    async inserirExcecaoSangria(ctx, e) {
      const c = exigirContexto(ctx);
      if (!t.plano.some((x) => x.id === e.categoria_id && noOrg(c)(x))) regra("fin_escopo_invalido");
      if (t.exc.some((x) => noTen(c)(x) && x.categoria_id === e.categoria_id && x.ativa)) erro("Registro duplicado.", "DUPLICADO");
      const n = { id: randomUUID(), ativa: true, ...e, organizacao_id: c.organizacaoId, unidade_id: c.unidadeId, aprovada_por: c.usuarioId, aprovada_em: agora() };
      t.exc.push(n); audita(c, "fin_sangria_excecoes.insert", "fin_sangria_excecoes", null, n); return { ...n };
    },
    async desativarExcecaoSangria(ctx, id, motivo) {
      const c = exigirContexto(ctx); const x = t.exc.find((y) => y.id === id && noTen(c)(y) && y.ativa);
      if (!x) return null; const antes = { ...x }; Object.assign(x, { ativa: false, desativada_por: c.usuarioId, desativada_em: agora(), motivo_desativacao: motivo }); audita(c, "fin_sangria_excecoes.update", "fin_sangria_excecoes", antes, { ...x }); return { ...x };
    },
    // ---- B8: períodos e política ----
    async listarPeriodos(ctx) { const c = exigirContexto(ctx); return t.per.filter(noTen(c)).sort((a, b) => b.mes.localeCompare(a.mes)).map((x) => ({ ...x })); },
    async abrirPeriodoRpc(ctx, mes) {
      const c = exigirContexto(ctx); const dia = `${mes}-01`;
      let p = t.per.find((x) => x.unidade_id === c.unidadeId && x.mes === dia);
      if (!p) { p = { id: randomUUID(), organizacao_id: c.organizacaoId, unidade_id: c.unidadeId, mes: dia, status: "aberto", versao: 1, snapshot: null }; t.per.push(p); audita(c, "fin_periodos.insert", "fin_periodos", null, { ...p }); }
      return { ...p };
    },
    async fingerprintPeriodoRpc(ctx, mes) { return impressao(exigirContexto(ctx), mes); },
    async fecharPeriodoRpc(ctx, { mes, versao, fingerprint, snapshot, pendenciasConciliacaoIds, reconhecoPendencias }) {
      const c = exigirContexto(ctx); let p = t.per.find((x) => x.unidade_id === c.unidadeId && x.mes === `${mes}-01` && x.organizacao_id === c.organizacaoId);
      if (!p) { p = { id: randomUUID(), organizacao_id: c.organizacaoId, unidade_id: c.unidadeId, mes: `${mes}-01`, status: "aberto", versao: 1, snapshot: null }; t.per.push(p); }   // como no banco: cria sob trava
      if (p.status === "fechado") regra("fin_periodo_ja_fechado");
      if (p.versao !== versao) regra("fin_periodo_conflito_versao: o periodo mudou");
      if (impressao(c, mes) !== fingerprint) regra("fin_periodo_conflito_dados: ha dados alterados");
      const pendentes = t.lanc.filter((l) => noTen(c)(l) && l.data_movimento.startsWith(mes) && l.status !== "cancelado" && (l.classificacao_pendente || !l.categoria_id));
      const idsConc = pendenciasConciliacaoIds ?? [];
      const pend = pendentes.length + idsConc.length;
      let exc = null;
      if (pend > 0) {
        exc = t.exf.find((e) => e.unidade_id === c.unidadeId && e.organizacao_id === c.organizacaoId && e.mes === `${mes}-01` && e.status === "ativa" && Date.parse(e.expira_em) > Date.parse(agora()));
        if (!exc) regra(`fin_periodo_pendencias: ${pend} pendencia(s)`);
        if (reconhecoPendencias !== true) regra("fin_periodo_pendencias_nao_reconhecidas");
        const ids = new Set(exc.pendencias.map((x) => x.id));
        if (pendentes.some((l) => !ids.has(l.id)) || idsConc.some((i) => !exc.pendencias_conciliacao_ids.includes(i))) regra("fin_periodo_excecao_insuficiente: ha pendencia nao coberta");
        Object.assign(exc, { status: "consumida", consumida_por: c.usuarioId, consumida_em: agora() });          // uso único
      }
      const antes = { ...p };
      Object.assign(p, { status: "fechado", fechado_por: c.usuarioId, fechado_em: agora(), versao: p.versao + 1, snapshot: { ...snapshot, pendenciasNoFechamento: pend, fingerprint, excecaoFechamentoId: exc?.id ?? null } });
      audita(c, "fin_periodos.update", "fin_periodos", antes, { ...p }); return { ...p };
    },
    async reabrirPeriodoRpc(ctx, { mes, versao, motivo }) {
      const c = exigirContexto(ctx); const p = t.per.find((x) => x.unidade_id === c.unidadeId && x.mes === `${mes}-01` && x.organizacao_id === c.organizacaoId);
      if (String(motivo ?? "").trim().length < 10) regra("fin_periodo_motivo_obrigatorio");
      if (!p) regra("fin_periodo_nao_encontrado", "P0002");
      if (p.status !== "fechado") regra("fin_periodo_nao_fechado");
      if (p.versao !== versao) regra("fin_periodo_conflito_versao: o periodo mudou");
      const antes = { ...p }; Object.assign(p, { status: "reaberto", reaberto_por: c.usuarioId, reaberto_em: agora(), motivo_reabertura: motivo.trim(), versao: p.versao + 1 });
      audita(c, "fin_periodos.update", "fin_periodos", antes, { ...p }); return { ...p };
    },
    async obterPeriodo(ctx, mes) { const c = exigirContexto(ctx); const x = t.per.find((p) => p.unidade_id === c.unidadeId && p.organizacao_id === c.organizacaoId && p.mes === `${mes}-01`); return x ? { ...x } : null; },
    async listarExcecoesFechamento(ctx, { mes, apenasAtivas = false } = {}) {
      const c = exigirContexto(ctx);
      return t.exf.filter((e) => noTen(c)(e) && (!mes || e.mes === `${mes}-01`) && (!apenasAtivas || e.status === "ativa")).map((e) => structuredClone(e));
    },
    // Simula a função DEFINER do banco (SuperAdmin). Só existe no repositório de teste; o service_role real NÃO tem EXECUTE.
    async concederExcecaoFechamentoRpc(ctx, { mes, justificativa, validadeDias, pendenciasConciliacaoIds, mfaEvidencia }) {
      const c = exigirContexto(ctx);
      const idade = Date.now() - Date.parse(mfaEvidencia?.em ?? "");
      if (mfaEvidencia?.aal !== "aal2" || !(idade <= 10 * 60000 && idade >= -60000)) regra("fin_excecao_mfa_invalida");
      if (String(justificativa ?? "").trim().length < 20) regra("fin_excecao_justificativa_obrigatoria");
      if (!(validadeDias >= 1 && validadeDias <= 30)) regra("fin_excecao_validade_invalida");
      const pend = t.lanc.filter((l) => noTen(c)(l) && l.data_movimento.startsWith(mes) && l.status !== "cancelado" && (l.classificacao_pendente || !l.categoria_id));
      if (pend.length === 0 && !((pendenciasConciliacaoIds ?? []).length > 0)) regra("fin_excecao_sem_pendencias");
      if (t.exf.some((e) => e.unidade_id === c.unidadeId && e.mes === `${mes}-01` && e.status === "ativa")) erro("duplicado", "23505");
      const e = { id: randomUUID(), organizacao_id: c.organizacaoId, unidade_id: c.unidadeId, mes: `${mes}-01`, justificativa: justificativa.trim(), pendencias: pend.map((l) => ({ id: l.id, motivos: l.revisao_motivos ?? [] })),
        pendencias_conciliacao_ids: [...(pendenciasConciliacaoIds ?? [])], quantidade: pend.length, aprovada_por: c.usuarioId, mfa_evidencia: { ...mfaEvidencia }, aprovada_em: agora(), expira_em: new Date(Date.parse(agora()) + validadeDias * 86400000).toISOString(), status: "ativa" };
      t.exf.push(e); audita(c, "fin_excecoes_fechamento.insert", "fin_excecoes_fechamento", null, structuredClone(e)); return structuredClone(e);
    },
    fecharPeriodo(ctx, ym) { const c = exigirContexto(ctx); const ex = t.per.find((x) => x.unidade_id === c.unidadeId && x.mes === `${ym}-01`); if (ex) Object.assign(ex, { status: "fechado", snapshot: {}, versao: ex.versao + 1 }); else t.per.push({ id: randomUUID(), organizacao_id: c.organizacaoId, unidade_id: c.unidadeId, status: "fechado", mes: `${ym}-01`, versao: 1, snapshot: {} }); },
  };
  return r;
}
