// Vendas diárias (SAIPOS): cadastro, edição com histórico, importação sem duplicidade, totais, caixa físico e sangrias. Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import XLSX from "xlsx";
import * as vd from "../../src/modules/gestao-financeira/dominio/vendasDiarias.service.js";
import { lerVendasDiarias } from "../../src/modules/gestao-financeira/dominio/importacao/leitorVendasDiarias.js";

const ctx = { organizacaoId: "00000000-0000-4000-8000-000000000001", unidadeId: "00000000-0000-4000-8000-000000000002", usuarioId: "00000000-0000-4000-8000-000000000003" };
const PERM = { LANCAR: "gestao_financeira.lancar", EDITAR: "gestao_financeira.editar" };
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function mundo({ caixa = [], semente = [] } = {}) {
  const refs = [...semente]; let n = 100; const escritas = { lancamentos: 0 };
  const repo = {
    listarReferencias: async (_c, { mes, incluirCanceladas } = {}) => refs.filter((r) => (!mes || String(r.data).startsWith(mes)) && (incluirCanceladas || r.status === "ativa")),
    inserirReferenciasRetornando: async (_c, itens) => itens.map((i) => { const r = { id: U(++n), status: "ativa", created_at: `2026-11-07T12:00:${String(n % 60).padStart(2, "0")}Z`, criado_por: ctx.usuarioId, ...i }; refs.push(r); return r; }),
    cancelarReferencia: async (_c, id, motivo) => { const r = refs.find((x) => x.id === id && x.status === "ativa"); if (!r) return null; Object.assign(r, { status: "cancelada", cancelada_em: "2026-11-07T13:00:00Z", motivo_cancelamento: motivo }); return r; },
    listarAuditoria: async () => [], listarResolucoes: async () => [], listarExcecoesSangria: async () => [], listarPlanoContas: async () => [{ id: U(5), nome: "SANGRIA", papel: "despesa_variavel", ativo: true }, { id: U(6), nome: "VENDAS", papel: "receita_operacional", ativo: true }],
    listarContas: async () => [{ id: U(10), nome: "CAIXA", tipo_conta: "caixa_fisico", ativo: true }, { id: U(11), nome: "BANCO", tipo_conta: "banco", ativo: true }],
    listarTodosLancamentos: async () => caixa,
    inserirLancamento: async () => { escritas.lancamentos++; },
  };
  return { refs, escritas, deps: { repo, db: undefined, hoje: () => "2026-11-07" } };
}
const ref = (id, data, tipo, valor, extra = {}) => ({ id, data, tipo, canal: null, valor_centavos: valor, fonte: "planilha_complementar", status: "ativa", referencia_origem: "CONFERÊNCIA SACI linha 10", chave_origem: `k${id}`, nota: null, criado_por: ctx.usuarioId, created_at: "2026-10-20T10:00:00Z", ...extra });
const lanc = (id, conta, sentido, valor, data) => ({ id, conta_id: conta, categoria_id: sentido === "entrada" ? U(6) : U(5), sentido, valor_centavos: valor, data_movimento: data, status: "realizado", descricao: "x" });
const xlsx = (linhas, cab = ["Data", "Venda bruta (R$)", "Recebido em espécie (R$)", "Sangria (R$)"]) => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([cab, ...linhas]), "S"); return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }).toString("base64"); };

test("registrar: 3 campos, destino obrigatório com sangria, zero é permitido, nada de recebimento bancário nem despesa", async () => {
  const w = mundo();
  await assert.rejects(() => vd.registrar(ctx, { data: "2026-10-05", venda: "1000,00", especie: "100", sangria: "50" }, w.deps), /destino da sangria/);
  await assert.rejects(() => vd.registrar(ctx, { data: "2026-10-05", venda: "-1" }, w.deps), /negativo/);
  await assert.rejects(() => vd.registrar(ctx, { data: "2026-10-05" }, w.deps), /Venda bruta é obrigatório/);
  const r = await vd.registrar(ctx, { data: "2026-10-05", venda: "1.000,00", especie: "100", sangria: "50", destinoSangria: "Depósito no banco", observacao: "teste" }, w.deps);
  assert.equal(r.registros.length, 3);
  const [v, e, s] = w.refs; assert.deepEqual([v.tipo, v.valor_centavos], ["venda", 100000]); assert.deepEqual([e.tipo, e.valor_centavos], ["dinheiro", 10000]); assert.deepEqual([s.tipo, s.valor_centavos], ["sangria", 5000]);
  assert.match(s.nota, /Destino: Depósito no banco/); assert.equal(v.fonte, "manual"); assert.equal(v.canal, null, "sem canal inventado");
  assert.equal(w.escritas.lancamentos, 0, "não cria recebimento bancário nem despesa");
  assert.match(r.observacao, /Nenhum recebimento bancário/);
  await assert.rejects(() => vd.registrar(ctx, { data: "2026-10-05", venda: "5" }, w.deps), /Já existe venda registrada/);
  const zero = await vd.registrar(ctx, { data: "2026-10-06", venda: "0", especie: "0", sangria: "0" }, w.deps);
  assert.equal(zero.registros.length, 3, "zero informado é registrado como zero");
});

test("listar: totais, média diária, dias sem registro e identificadores/origem preservados", async () => {
  const w = mundo({ semente: [ref("a1", "2026-09-01", "venda", 300000), ref("a2", "2026-09-01", "dinheiro", 15000), ref("a3", "2026-09-01", "sangria", 4800), ref("b1", "2026-09-03", "venda", 200000), ref("b2", "2026-09-03", "dinheiro", 13900)] });
  const l = await vd.listar(ctx, { mes: "2026-09" }, w.deps);
  const I = l.indicadores;
  assert.equal(I.totalVendaBrutaCentavos, 500000); assert.equal(I.totalEspecieCentavos, 28900); assert.equal(I.totalSangriaCentavos, 4800);
  assert.equal(I.diasRegistrados, 2); assert.equal(I.mediaDiariaCentavos, 250000, "total ÷ dias com venda (arredonda no fim)");
  assert.equal(I.diasNoMes, 30); assert.equal(I.diasSemRegistro.length, 28); assert.ok(I.diasSemRegistro.includes("2026-09-02"));
  const d1 = l.linhas[0]; assert.equal(d1.venda.id, "a1"); assert.equal(d1.venda.referenciaOrigem, "CONFERÊNCIA SACI linha 10"); assert.equal(d1.venda.fonteRotulo, "Planilha complementar (importação)");
  assert.equal(d1.sangria.destinoPendente, true, "sangria sem destino escrito fica sinalizada");
  assert.equal(l.integracao.faturamentoBrutoCentavos, 500000);
});

test("conferência com o caixa físico: espécie e sangria batem ou mostram dia, campo e valores exatos", async () => {
  const w = mundo({ semente: [ref("a1", "2026-09-01", "venda", 100000), ref("a2", "2026-09-01", "dinheiro", 15000), ref("a3", "2026-09-01", "sangria", 4800), ref("b1", "2026-09-02", "venda", 90000), ref("b2", "2026-09-02", "dinheiro", 26900), ref("b3", "2026-09-02", "sangria", 6100)],
    caixa: [lanc("l1", U(10), "entrada", 15000, "2026-09-01"), lanc("l2", U(10), "saida", 4800, "2026-09-01"), lanc("l3", U(10), "entrada", 26900, "2026-09-02"), lanc("l4", U(10), "saida", 5100, "2026-09-02"), lanc("l5", U(11), "entrada", 999, "2026-09-02")] });
  const l = await vd.listar(ctx, { mes: "2026-09" }, w.deps);
  assert.equal(l.linhas[0].situacao, "conferido"); assert.deepEqual(l.linhas[0].divergencias, []);
  const d2 = l.linhas[1]; assert.equal(d2.situacao, "divergente");
  assert.deepEqual(d2.divergencias.map((x) => [x.campo, x.informadoCentavos, x.caixaCentavos, x.diferencaCentavos]), [["Sangria", 6100, 5100, -1000]], "dia, campo e valor exatos; espécie bate e a conta de banco não conta");
  assert.equal(l.indicadores.divergentes, 1); assert.equal(l.indicadores.conferidos, 1);
  assert.equal(l.conferencia.sangria.informadoCentavos, 10900); assert.equal(l.conferencia.sangria.caixaFisicoCentavos, 9900);
  const so = await vd.listar(ctx, { mes: "2026-09", situacao: "divergente" }, w.deps); assert.equal(so.linhas.length, 1); assert.equal(so.totalDias, 2);
  const busca = await vd.listar(ctx, { mes: "2026-09", busca: "02/09" }, w.deps); assert.equal(busca.linhas.length, 1);
});

test("editar: exige permissão e motivo; troca cancela a linha antiga com motivo e registra a nova ligada a ela", async () => {
  const w = mundo({ semente: [ref("a1", "2026-09-01", "venda", 300000), ref("a2", "2026-09-01", "dinheiro", 15000), ref("a3", "2026-09-01", "sangria", 4800)] });
  await assert.rejects(() => vd.editar(ctx, "2026-09-01", { venda: "3000", motivo: "correção" }, w.deps, { permissoes: [PERM.LANCAR] }), /não edita/);
  await assert.rejects(() => vd.editar(ctx, "2026-09-01", { venda: "3000" }, w.deps, { permissoes: [PERM.EDITAR] }), /motivo/);
  await assert.rejects(() => vd.editar(ctx, "2026-09-01", { venda: "3000,00", motivo: "sem mudança" }, w.deps, { permissoes: [PERM.EDITAR] }), /Nada mudou/);
  const r = await vd.editar(ctx, "2026-09-01", { venda: "2.900,00", sangria: "48", destinoSangria: "Pagamento em espécie ao fornecedor", motivo: "Conferido com o relatório do dia" }, w.deps, { permissoes: [PERM.EDITAR] });
  assert.deepEqual(r.alterados.map((a) => [a.campo, a.de, a.para]), [["Venda bruta", 300000, 290000], ["Sangria", 4800, 4800]]);
  const ativas = w.refs.filter((x) => x.status === "ativa"), canc = w.refs.filter((x) => x.status === "cancelada");
  assert.equal(ativas.length, 3, "continua UMA linha ativa por campo");
  assert.deepEqual(canc.map((x) => x.id).sort(), ["a1", "a3"]); assert.ok(canc.every((x) => x.motivo_cancelamento === "Conferido com o relatório do dia"));
  const nova = ativas.find((x) => x.tipo === "venda"); assert.equal(nova.valor_centavos, 290000); assert.match(nova.referencia_origem, /substitui a1/); assert.equal(nova.fonte, "manual");
  assert.match(ativas.find((x) => x.tipo === "sangria").nota, /Destino: Pagamento em espécie ao fornecedor/);
  const l = await vd.listar(ctx, { mes: "2026-09" }, w.deps); assert.equal(l.indicadores.totalVendaBrutaCentavos, 290000, "o indicador usa só o valor vigente");
  const det = await vd.detalhe(ctx, { data: "2026-09-01" }, w.deps);
  assert.equal(det.atuais.length, 3); assert.equal(det.anteriores.length, 2); assert.equal(det.anteriores.find((a) => a.id === "a1").referenciaOrigem, "CONFERÊNCIA SACI linha 10", "a origem da versão anterior continua consultável");
  const h = await vd.historico(ctx, { mes: "2026-09" }, w.deps); assert.ok(h.eventos.some((e) => e.evento === "cancelado" && /relatório do dia/.test(e.motivo)));
});

test("editar: se a linha antiga não pode ser cancelada, a nova é desfeita (nunca conta o dia duas vezes)", async () => {
  const w = mundo({ semente: [ref("a1", "2026-09-01", "venda", 100000)] });
  const cancelar = w.deps.repo.cancelarReferencia; let primeira = true;
  w.deps.repo.cancelarReferencia = async (c, id, m) => { if (primeira) { primeira = false; return null; } return cancelar(c, id, m); };
  await assert.rejects(() => vd.editar(ctx, "2026-09-01", { venda: "2000", motivo: "correção do dia" }, w.deps, { permissoes: [PERM.EDITAR] }));
  assert.equal(w.refs.filter((x) => x.status === "ativa").length, 1); assert.equal(w.refs.find((x) => x.status === "ativa").id, "a1", "o valor original segue vigente");
});

test("leitor: aceita os nomes de coluna da planilha e do relatório, ignora TOTAL, separa 'não informado' de zero e acusa erros por linha", () => {
  const ok = lerVendasDiarias(Buffer.from(xlsx([["01/09/2026", "3000,00", "150,00", null], ["2026-09-02", 2500, 269, 0], ["TOTAL", 5500, 413.75, 0]], ["Data", "Vendas Saci (R$)", "Caixa espécie Saci (R$)", "Sangria Saci (R$)"]), "base64"));
  assert.equal(ok.erros.length, 0); assert.equal(ok.dias.length, 2);
  assert.deepEqual([ok.dias[0].vendaCentavos, ok.dias[0].especieCentavos, ok.dias[0].sangriaCentavos], [300000, 15000, null], "vazio = não informado");
  assert.equal(ok.dias[1].sangriaCentavos, 0, "zero informado");
  const ruim = lerVendasDiarias(Buffer.from(xlsx([["2026-09-01", "100", "10", "0"], ["2026-09-01", "100", "10", "0"], ["x", "1", null, null], ["2026-09-03", "-5", null, null], ["2026-09-04", null, null, null]]), "base64"));
  assert.equal(ruim.dias.length, 1); assert.deepEqual(ruim.erros.map((e) => e.linha), [3, 4, 5, 6]);
  assert.match(ruim.erros[0].motivo, /data repetida/); assert.match(ruim.erros[2].motivo, /negativo/); assert.match(ruim.erros[3].motivo, /nenhum valor/);
  assert.throws(() => lerVendasDiarias(Buffer.from(xlsx([["1", "2"]], ["Foo", "Bar"]), "base64")), /Cabeçalho não encontrado/);
});

test("importação: prévia classifica sem gravar; importa só o novo; reimportar NÃO soma de novo (duplicidades rejeitadas)", async () => {
  const w = mundo({ semente: [ref("a1", "2026-09-01", "venda", 300000), ref("a2", "2026-09-01", "dinheiro", 15000)] });
  const arq = xlsx([["2026-09-01", 3000, 150, null], ["2026-09-02", 2500, 269, 61], ["2026-09-03", 2000, 139, 0]]);
  const p = await vd.previaImportacao(ctx, { conteudoBase64: arq, arquivoNome: "saipos.xlsx" }, w.deps);
  assert.deepEqual([p.resumo.novos, p.resumo.iguais, p.resumo.atualizar, p.resumo.erros], [2, 1, 0, 0]);
  assert.equal(w.refs.length, 2, "a prévia não grava nada");
  const r1 = await vd.importar(ctx, { conteudoBase64: arq, arquivoNome: "saipos.xlsx" }, w.deps, { permissoes: [PERM.LANCAR] });
  assert.equal(r1.registrosCriados, 6); assert.equal(r1.duplicidadesRejeitadas, 2);
  assert.equal(w.refs.length, 8); assert.ok(w.refs.slice(2).every((x) => x.fonte === "saipos" && /SAIPOS · saipos\.xlsx · linha \d/.test(x.referencia_origem) && x.chave_origem === null));
  const antes = JSON.stringify(w.refs);
  const r2 = await vd.importar(ctx, { conteudoBase64: arq, arquivoNome: "saipos.xlsx" }, w.deps, { permissoes: [PERM.LANCAR] });
  assert.equal(r2.registrosCriados, 0); assert.equal(r2.duplicidadesRejeitadas, 8, "tudo já existe: nada é somado outra vez");
  assert.equal(JSON.stringify(w.refs), antes, "reimportar não muda uma linha");
  assert.equal(w.escritas.lancamentos, 0);
  const l = await vd.listar(ctx, { mes: "2026-09" }, w.deps); assert.equal(l.indicadores.totalVendaBrutaCentavos, 300000 + 250000 + 200000);
});

test("importação: valores diferentes ficam como divergência; só atualiza com permissão de editar + motivo, preservando a linha antiga", async () => {
  const w = mundo({ semente: [ref("a1", "2026-09-01", "venda", 300000), ref("a2", "2026-09-01", "dinheiro", 15000)] });
  const arq = xlsx([["2026-09-01", 2900, 150, null]]);
  const p = await vd.previaImportacao(ctx, { conteudoBase64: arq }, w.deps);
  assert.equal(p.resumo.atualizar, 1); assert.deepEqual(p.dias[0].campos.map((c) => [c.campo, c.estado, c.atualCentavos, c.arquivoCentavos]), [["venda", "diferente", 300000, 290000], ["especie", "igual", 15000, 15000]]);
  const sem = await vd.importar(ctx, { conteudoBase64: arq }, w.deps, { permissoes: [PERM.LANCAR] });
  assert.equal(sem.registrosAtualizados, 0); assert.equal(sem.divergentesNaoAtualizados, 1); assert.equal(w.refs.find((r) => r.id === "a1").status, "ativa", "divergência não é corrigida em silêncio");
  await assert.rejects(() => vd.importar(ctx, { conteudoBase64: arq, atualizar: true, motivo: "relatório novo" }, w.deps, { permissoes: [PERM.LANCAR] }), /permissão de edição/);
  await assert.rejects(() => vd.importar(ctx, { conteudoBase64: arq, atualizar: true }, w.deps, { permissoes: [PERM.LANCAR, PERM.EDITAR] }), /motivo/);
  const ok = await vd.importar(ctx, { conteudoBase64: arq, atualizar: true, motivo: "relatório SAIPOS reemitido" }, w.deps, { permissoes: [PERM.LANCAR, PERM.EDITAR] });
  assert.equal(ok.registrosAtualizados, 1); assert.equal(w.refs.find((r) => r.id === "a1").status, "cancelada"); assert.equal(w.refs.find((r) => r.id === "a1").motivo_cancelamento, "relatório SAIPOS reemitido");
  assert.equal(w.refs.filter((r) => r.tipo === "venda" && r.status === "ativa").length, 1);
});

test("importação com erro no arquivo não grava NADA", async () => {
  const w = mundo();
  const arq = xlsx([["2026-09-01", 100, 10, 0], ["2026-09-01", 200, 20, 0], ["2026-09-02", 300, 30, 0]]);
  await assert.rejects(() => vd.importar(ctx, { conteudoBase64: arq }, w.deps, { permissoes: [PERM.LANCAR] }), /linha\(s\) com erro e nada foi importado/);
  assert.equal(w.refs.length, 0);
  await assert.rejects(() => vd.previaImportacao(ctx, { conteudoBase64: "***" }, w.deps), /formato inválido/);
  await assert.rejects(() => vd.previaImportacao(ctx, {}, w.deps), /não enviado/);
});
