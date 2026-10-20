// B9 — Relatórios tabulares, exportações CSV/XLSX e Configurações Financeiras. HTTP → rotas → serviços → motor homologado, com repositório
// em memória e dados 100% SINTÉTICOS. Garantias de banco (travas, RLS) seguem provadas em backend/testes-financeiro-pg.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import XLSX from "xlsx";

process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = "teste-local-nao-e-segredo";
process.env.SUPABASE_ANON_KEY = "teste-local-nao-e-segredo";
const { criarDominioRouter } = await import("../../src/modules/gestao-financeira/dominio/rotas.js");
const { criarRepoMemoria } = await import("./helpers/repoMemoria.js");
const tab = await import("../../src/modules/gestao-financeira/dominio/tabelas.service.js");
const perSvc = await import("../../src/modules/gestao-financeira/dominio/periodos.service.js");
/** Simula a exceção futura de SuperAdmin (concessão real está desabilitada e sem rota) para os testes que fecham meses com pendências sintéticas. */
const liberarExcecao = (a, mes) => perSvc.concederExcecaoFechamento({ organizacaoId: U(1), unidadeId: U(2), usuarioId: U(3), permissoes: [] }, mes,
  { justificativa: "excecao sintetica de teste para fechar o mes", validadeDias: 5, mfaEvidencia: MFA() }, { repo: a.repo, excecaoFechamentoHabilitada: true, agora: () => "2026-10-01T12:00:00.000Z" });

const MFA = () => ({ aal: "aal2", em: new Date().toISOString() });
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = (...a) => a.map((x) => `gestao_financeira.${x}`);
const NIVEL = { leitura: P("ver"), operador: P("ver", "lancar", "editar"), gestor: P("ver", "lancar", "editar", "conciliar", "cancelar", "fechar", "configurar") };

async function ambiente() {
  const repo = criarRepoMemoria();
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  const gate = (acao) => (req, _res, next) => {
    const t = req.headers["x-t"] ?? "A";
    const perms = (req.headers["x-perms"] ?? NIVEL.gestor.join(",")).split(",");
    req.financeiro = { organizacaoId: t === "A" ? U(1) : U(11), unidadeId: t === "A" ? U(2) : U(12), permissoes: perms };
    req.user = { id: U(3) };
    if (!perms.includes(acao)) return next(Object.assign(new Error("Permissão financeira insuficiente."), { statusCode: 403, details: { codigo: "FINANCEIRO_PERMISSAO_INSUFICIENTE" } }));
    next();
  };
  app.use("/fin", criarDominioRouter({ autorizar: gate, deps: { repo, db: undefined, agora: () => "2026-10-17T12:00:00.000Z" } }));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message, details: err.details }));
  const srv = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/fin`;
  const chamar = async (metodo, caminho, corpo, { tenant = "A", perms } = {}) => {
    const r = await fetch(base + caminho, { method: metodo, headers: { "content-type": "application/json", "x-t": tenant, ...(perms ? { "x-perms": perms.join(",") } : {}) }, body: corpo ? JSON.stringify(corpo) : undefined });
    return { status: r.status, corpo: await r.json().catch(() => null) };
  };
  const baixar = async (caminho, { tenant = "A", perms } = {}) => {
    const r = await fetch(base + caminho, { headers: { "x-t": tenant, ...(perms ? { "x-perms": perms.join(",") } : {}) } });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, cab: r.headers, buf, texto: buf.toString("utf8") };
  };
  return { repo, chamar, baixar, fechar: () => new Promise((ok) => srv.close(ok)) };
}

async function semear(a, t = "A", { abertura = true } = {}) {
  const c = async (m, p, b) => { const r = await a.chamar(m, p, b, { tenant: t }); assert.ok(r.status < 300, `${m} ${p} → ${r.status} ${JSON.stringify(r.corpo)}`); return r.corpo.data; };
  const caixa = await c("POST", "/contas", { nome: "CAIXA", tipoConta: "caixa_fisico" });
  const banco = await c("POST", "/contas", { nome: "BANCO", tipoConta: "banco" });
  const cat = {};
  for (const [nome, tipo, nat, papel] of [["VENDAS", "RECEITA", "R", "receita_operacional"], ["INSUMOS", "CUSTO", "V", "custo_variavel"], ["ALUGUEL", "DESPESA", "FIXA", "despesa_fixa"], ["ENTRE CONTAS", "TRANSFERENCIA", "T", "transferencia"]]) {
    cat[nome] = await c("POST", "/plano-contas", { tipo, natureza: nat, nome, papel });
  }
  if (abertura) await c("PUT", "/aberturas", { contaId: banco.id, dataReferencia: "2026-09-01", valor: "100,00" });   // só o BANCO tem abertura conhecida
  const l = (conta, categoria, sentido, valor, data, desc) => c("POST", "/lancamentos", { contaId: conta.id, categoriaId: cat[categoria].id, descricao: desc, sentido, valor, dataMovimento: data });
  await l(caixa, "VENDAS", "entrada", "1.000,00", "2026-09-01", "venda caixa dia 1");
  await l(banco, "VENDAS", "entrada", "2.000,07", "2026-09-02", "venda banco dia 2");
  await l(caixa, "INSUMOS", "saida", "300,01", "2026-09-02", "compra de insumos");
  await l(banco, "ALUGUEL", "saida", "800,00", "2026-09-05", "aluguel");
  await l(banco, "VENDAS", "entrada", "50,00", "2026-10-03", "venda de outubro");
  await c("POST", "/transferencias", { contaOrigemId: caixa.id, contaDestinoId: banco.id, valor: "200,00", data: "2026-09-10", descricao: "deposito do caixa" });
  return { caixa, banco, cat, l, c };
}
const q = (o) => "?" + new URLSearchParams(o).toString();
const csvLinhas = (texto) => texto.replace("﻿", "").split("\r\n").filter((x) => x !== "");

test("catálogo: 7 relatórios, cada um com seus filtros; exige `ver`", async () => {
  const a = await ambiente();
  try {
    const r = await a.chamar("GET", "/relatorios/tabelas/catalogo", null, { perms: NIVEL.leitura });
    assert.equal(r.status, 200);
    assert.deepEqual(r.corpo.data.map((x) => x.id), ["movimentacoes", "dre", "fluxo-caixa", "movimentacao-conta", "categorias", "conciliacoes", "periodos"]);
    assert.ok(r.corpo.data.every((x) => x.titulo && x.filtros.includes("periodo")));
    assert.equal((await a.chamar("GET", "/relatorios/tabelas/catalogo", null, { perms: [] })).status, 403);
    assert.equal((await a.chamar("GET", "/relatorios/tabelas/inexistente?de=2026-09-01")).status, 404);
  } finally { await a.fechar(); }
});

test("histórico de movimentações: filtros de período, conta, categoria e tipo; totais só de realizados; pendências sinalizadas", async () => {
  const a = await ambiente();
  try {
    const s = await semear(a);
    await a.chamar("POST", "/lancamentos", { contaId: s.caixa.id, descricao: "sem categoria", sentido: "saida", valor: "5,00", dataMovimento: "2026-09-20" });
    const get = async (o) => (await a.chamar("GET", `/relatorios/tabelas/movimentacoes${q(o)}`)).corpo.data;
    const todos = await get({ de: "2026-09-01", ate: "2026-09-30" });
    assert.equal(todos.linhas.length, 7);                                                   // 4 lançamentos + 2 pernas da transferência + 1 sem categoria
    assert.equal(todos.meta.regime, "caixa");
    assert.equal(todos.meta.parcial, true);                                                 // há lançamento sem categoria
    assert.ok(todos.meta.avisos.some((x) => /pendentes de classificação/.test(x)));
    assert.equal(todos.totais.entrada, 100000 + 200007 + 20000);
    assert.equal(todos.totais.saida, 30001 + 80000 + 500 + 20000);
    const semCat = todos.linhas.find((l) => l.descricao === "sem categoria");
    assert.equal(semCat.pendente, true); assert.equal(semCat.grupo, "Sem classificação"); assert.equal(semCat.entrada, null);  // ausente, não zero
    assert.equal((await get({ de: "2026-10-01", ate: "2026-10-31" })).linhas.length, 1);
    assert.equal((await get({ de: "2026-09-01", ate: "2026-09-30", contaId: s.caixa.id })).linhas.every((l) => l.conta === "CAIXA"), true);
    assert.equal((await get({ de: "2026-09-01", ate: "2026-09-30", categoriaId: s.cat.ALUGUEL.id })).linhas.length, 1);
    const saidas = await get({ de: "2026-09-01", ate: "2026-09-30", tipo: "saida" });
    assert.ok(saidas.linhas.every((l) => l.saida !== null && l.entrada === null));
    assert.equal(saidas.meta.filtros.find((f) => f.rotulo === "Tipo").valor, "Saídas");
    // cancelado aparece (rastreabilidade) mas não soma
    const alug = a.repo._t.lanc.find((l) => l.descricao === "aluguel");
    await a.chamar("POST", `/lancamentos/${alug.id}/cancelar`, { motivo: "lancado em duplicidade" });
    const apos = await get({ de: "2026-09-01", ate: "2026-09-30" });
    assert.equal(apos.linhas.find((l) => l.descricao === "aluguel").situacao, "Cancelado");
    assert.equal(apos.totais.saida, 30001 + 500 + 20000);
    assert.equal((await get({ de: "2026-09-01", ate: "2026-09-30", status: "cancelado" })).linhas.length, 1);
    // estado vazio: período sem lançamentos
    const vazio = await get({ de: "2025-01-01", ate: "2025-01-31" });
    assert.equal(vazio.linhas.length, 0); assert.equal(vazio.total, 0); assert.equal(vazio.totais.entrada, 0);
  } finally { await a.fechar(); }
});

test("demonstrativo de resultados: usa o MESMO motor da DRE do dashboard (valores idênticos); filtro de conta marca parcial", async () => {
  const a = await ambiente();
  try {
    await semear(a);
    const p = "?de=2026-09-01&ate=2026-09-30";
    const dre = (await a.chamar("GET", `/relatorios/dre${p}`)).corpo.data;
    const tabela = (await a.chamar("GET", `/relatorios/tabelas/dre${p}`)).corpo.data;
    for (const id of ["receita", "custos", "margem_contribuicao", "desp_fixas", "resultado"]) {
      const esperado = dre.linhas.find((l) => l.id === id);
      const linha = tabela.linhas.find((l) => l.linha === esperado.rotulo && l.natureza === "Total");
      assert.equal(linha.valor, esperado.centavos, id);
      assert.equal(linha.pctReceita, esperado.percentualReceitaBps, id);
    }
    const ml = tabela.linhas.find((l) => l.natureza === "Percentual");
    assert.equal(ml.valor, null); assert.equal(ml.pctReceita, dre.linhas.find((l) => l.id === "margem_liquida").bps);
    assert.ok(tabela.linhas.some((l) => /^ {2}· /.test(l.linha) && /Detalhe/.test(l.natureza)));
    assert.equal(tabela.meta.parcial, false);
    const conta = a.repo._t.contas.find((x) => x.nome === "CAIXA");
    const filtrado = (await a.chamar("GET", `/relatorios/tabelas/dre${p}&contaId=${conta.id}`)).corpo.data;
    assert.equal(filtrado.meta.parcial, true);
    assert.ok(filtrado.meta.avisos.some((x) => /filtrado/.test(x)));
  } finally { await a.fechar(); }
});

test("fluxo de caixa: dia e mês; transferências internas fora por padrão (e dentro com a opção); bate com a variação do caixa do dashboard", async () => {
  const a = await ambiente();
  try {
    await semear(a);
    const p = "?de=2026-09-01&ate=2026-09-30";
    const dia = (await a.chamar("GET", `/relatorios/tabelas/fluxo-caixa${p}`)).corpo.data;
    assert.deepEqual(dia.linhas.map((l) => l.periodo), ["2026-09-01", "2026-09-02", "2026-09-05"]);
    assert.equal(dia.colunas[0].tipo, "data");
    const geral = (await a.chamar("GET", `/relatorios/visao-geral${p}`)).corpo.data;
    assert.equal(dia.totais.saldo, geral.indicadores.variacaoCaixa);                       // transferência pareada soma zero
    assert.equal(dia.linhas.at(-1).acumulado, dia.totais.saldo);
    const mes = (await a.chamar("GET", `/relatorios/tabelas/fluxo-caixa?de=2026-09-01&ate=2026-10-31&agrupar=mes`)).corpo.data;
    assert.deepEqual(mes.linhas.map((l) => l.periodo), ["2026-09", "2026-10"]);
    assert.equal(mes.colunas[0].tipo, "texto");
    const com = (await a.chamar("GET", `/relatorios/tabelas/fluxo-caixa${p}&transferencias=true`)).corpo.data;
    assert.equal(com.totais.entradas, dia.totais.entradas + 20000);
    assert.equal(com.totais.saldo, dia.totais.saldo);
    assert.ok(com.meta.avisos.some((x) => /INCLUÍDAS/.test(x)));
    assert.ok(dia.meta.avisos.some((x) => /saldo anterior/.test(x)));
    assert.equal((await a.chamar("GET", `/relatorios/tabelas/fluxo-caixa${p}&agrupar=ano`)).status, 400);
  } finally { await a.fechar(); }
});

test("movimentação por conta: saldo parcial quando a abertura é desconhecida (nunca zero); total só quando todas conhecidas; igual ao dashboard", async () => {
  const a = await ambiente();
  try {
    await semear(a);
    const p = "?de=2026-09-01&ate=2026-09-30";
    const t = (await a.chamar("GET", `/relatorios/tabelas/movimentacao-conta${p}`)).corpo.data;
    const caixa = t.linhas.find((l) => l.conta === "CAIXA"), banco = t.linhas.find((l) => l.conta === "BANCO");
    assert.equal(caixa.abertura, null); assert.equal(caixa.saldo, null); assert.match(caixa.situacao, /abertura desconhecida/);
    assert.equal(banco.abertura, 10000);
    assert.equal(banco.saldo, 10000 + 200007 - 80000 + 20000);
    assert.equal(t.totais.saldo, null);
    assert.equal(t.meta.parcial, true);
    const geral = (await a.chamar("GET", `/relatorios/visao-geral${p}`)).corpo.data;
    assert.equal(geral.saldosPorConta.contas.find((c) => c.nome === "BANCO").saldoCentavos, banco.saldo);
    assert.equal(caixa.transfSaida, 20000); assert.equal(banco.transfEntrada, 20000);
    // com todas as aberturas conhecidas o total aparece
    const cx = a.repo._t.contas.find((x) => x.nome === "CAIXA");
    await a.chamar("PUT", "/aberturas", { contaId: cx.id, dataReferencia: "2026-09-01", valor: "0,00" });
    const t2 = (await a.chamar("GET", `/relatorios/tabelas/movimentacao-conta${p}`)).corpo.data;
    assert.equal(t2.totais.saldo, t2.linhas.reduce((s, l) => s + l.saldo, 0));
    assert.equal(t2.meta.parcial, false);
    // filtro de categoria: saldo indisponível e relatório marcado como parcial
    const cat = a.repo._t.plano.find((x) => x.nome === "VENDAS");
    const f = (await a.chamar("GET", `/relatorios/tabelas/movimentacao-conta${p}&categoriaId=${cat.id}`)).corpo.data;
    assert.ok(f.linhas.every((l) => l.saldo === null)); assert.equal(f.meta.parcial, true);
  } finally { await a.fechar(); }
});

test("análise de categorias, histórico de conciliações e situação dos períodos usam as fontes do domínio", async () => {
  const a = await ambiente();
  try {
    const s = await semear(a);
    const p = "?de=2026-09-01&ate=2026-09-30";
    const cat = (await a.chamar("GET", `/relatorios/categorias${p}`)).corpo.data;
    const tcat = (await a.chamar("GET", `/relatorios/tabelas/categorias${p}`)).corpo.data;
    assert.deepEqual(tcat.linhas.map((l) => [l.categoria, l.valor]), cat.itens.map((i) => [i.nome, i.centavos]));
    assert.equal(tcat.totais.valor, cat.totalCentavos);
    assert.equal(tcat.linhas[0].posicao, 1);
    // conciliações: classificação + revogação aparecem (nada some)
    await a.chamar("POST", "/conciliacao/referencias", { itens: [{ data: "2026-09-30", tipo: "venda", valor: "4.000,00" }, { data: "2026-09-30", tipo: "taxa", valor: "50,00" }] });
    const resumo = (await a.chamar("GET", "/conciliacao/resumo?mes=2026-09")).corpo.data;
    const res = await a.chamar("POST", "/conciliacao/resolucoes", { escopo: "ponte_mensal", chave: "2026-09-01", classificacao: "prazo", valor: (resumo.ponte.residualCentavos / 100).toFixed(2).replace(".", ","), nota: "vendas do fim do mes recebidas depois" });
    assert.equal(res.status, 201);
    await a.chamar("POST", `/conciliacao/resolucoes/${res.corpo.data.id}/revogar`, { motivo: "classificacao feita por engano" });
    const hist = (await a.chamar("GET", `/relatorios/tabelas/conciliacoes${p}`)).corpo.data;
    assert.equal(hist.linhas.length, 1);
    assert.equal(hist.linhas[0].situacao, "Revogada"); assert.equal(hist.linhas[0].classificacao, "Diferença de prazo"); assert.match(hist.linhas[0].motivoRevogacao, /engano/);
    assert.equal((await a.chamar("GET", "/relatorios/tabelas/conciliacoes?de=2026-10-01&ate=2026-10-31")).corpo.data.linhas.length, 0);
    // períodos: fechado mostra o resultado congelado
    await liberarExcecao(a, "2026-09");
    const pre = (await a.chamar("GET", "/periodos/2026-09/pre-fechamento")).corpo.data;
    const f = await a.chamar("POST", "/periodos/2026-09/fechar", { confirmo: true, versao: pre.periodo.versao, fingerprint: pre.fingerprint, reconhecoPendencias: true });
    assert.equal(f.status, 200);
    const per = (await a.chamar("GET", "/relatorios/tabelas/periodos?de=2026-09-01&ate=2026-10-31")).corpo.data;
    const set = per.linhas.find((l) => l.mes === "2026-09");
    assert.equal(set.situacao, "Fechado");
    const dre = (await a.chamar("GET", `/relatorios/dre${p}`)).corpo.data;
    assert.equal(set.resultado, dre.linhas.find((l) => l.id === "resultado").centavos);
    assert.ok(set.fechadoEm);
    assert.ok(s);
  } finally { await a.fechar(); }
});

test("exportação CSV: cabeçalhos HTTP seguros, regime/período/filtros/parcial/geração, centavos exatos, totais iguais à tela", async () => {
  const a = await ambiente();
  try {
    await semear(a);
    const p = "?de=2026-09-01&ate=2026-09-30";
    const tela = (await a.chamar("GET", `/relatorios/tabelas/movimentacoes${p}`)).corpo.data;
    const r = await a.baixar(`/relatorios/tabelas/movimentacoes/exportar${p}&formato=csv`, { perms: NIVEL.leitura });
    assert.equal(r.status, 200);
    assert.match(r.cab.get("content-type"), /^text\/csv; charset=utf-8/);
    assert.match(r.cab.get("content-disposition"), /^attachment; filename="movimentacoes_2026-09-01_2026-09-30_\d{12}\.csv"$/);
    assert.equal(r.cab.get("x-content-type-options"), "nosniff"); assert.equal(r.cab.get("cache-control"), "no-store");
    assert.equal(Number(r.cab.get("x-linhas")), tela.total);
    assert.equal(r.buf[0], 0xef); assert.equal(r.buf[1], 0xbb); assert.equal(r.buf[2], 0xbf);       // BOM UTF-8
    const t = r.texto;
    assert.match(t, /Regime;"Regime de caixa/); assert.match(t, /Período;01\/09\/2026 a 30\/09\/2026/); assert.match(t, /Gerado em;2026-10-17T12:00:00.000Z/);
    assert.match(t, /Situação dos dados;Completo/);
    assert.match(t, /Código de verificação;[0-9A-F]{4}-/);
    assert.match(t, /;2000,07;/);                                                                      // 2.000,07 exato, sem float
    assert.match(t, /;300,01;/);
    assert.doesNotMatch(t, /2000\.07|300\.01/);
    const ult = csvLinhas(t).at(-1);
    assert.equal(ult.startsWith("TOTAL;"), true);
    assert.ok(ult.includes(`;${(tela.totais.entrada / 100).toFixed(2).replace(".", ",")};`));
    assert.ok(ult.includes(`;${(tela.totais.saida / 100).toFixed(2).replace(".", ",")};`));
    // filtro aplicado aparece nas informações
    const f = await a.baixar(`/relatorios/tabelas/movimentacoes/exportar${p}&formato=csv&tipo=saida`);
    assert.match(f.texto, /Filtros;Tipo: Saídas/);
  } finally { await a.fechar(); }
});

test("exportação XLSX: abas Dados/Informações, moeda numérica exata, sem fórmulas, parcial identificado", async () => {
  const a = await ambiente();
  try {
    const s = await semear(a);
    await a.chamar("POST", "/lancamentos", { contaId: s.caixa.id, descricao: "sem categoria", sentido: "saida", valor: "0,07", dataMovimento: "2026-09-21" });
    const r = await a.baixar("/relatorios/tabelas/movimentacoes/exportar?de=2026-09-01&ate=2026-09-30&formato=xlsx");
    assert.equal(r.status, 200);
    assert.equal(r.cab.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    assert.match(r.cab.get("content-disposition"), /\.xlsx"$/);
    const wb = XLSX.read(r.buf, { type: "buffer" });
    assert.deepEqual(wb.SheetNames, ["Dados", "Informações"]);
    const linhas = XLSX.utils.sheet_to_json(wb.Sheets.Dados, { header: 1, raw: true });
    const cab = linhas[0], iEnt = cab.indexOf("Entrada (R$)"), iSai = cab.indexOf("Saída (R$)"), iDesc = cab.indexOf("Descrição");
    const venda = linhas.find((l) => l[iDesc] === "venda banco dia 2");
    assert.equal(Math.round(venda[iEnt] * 100), 200007);
    const sem = linhas.find((l) => l[iDesc] === "sem categoria");
    assert.equal(Math.round(sem[iSai] * 100), 7);
    const info = XLSX.utils.sheet_to_json(wb.Sheets["Informações"], { header: 1 }).map((l) => l.join(" ")).join("\n");
    assert.match(info, /PARCIAL/); assert.match(info, /Regime de caixa/); assert.match(info, /01\/09\/2026 a 30\/09\/2026/);
    for (const aba of Object.values(wb.Sheets)) for (const k of Object.keys(aba).filter((x) => !x.startsWith("!"))) assert.equal(aba[k].f, undefined);
  } finally { await a.fechar(); }
});

test("segurança do arquivo: descrições/categorias/contas com fórmula são neutralizadas em CSV e XLSX", async () => {
  const a = await ambiente();
  try {
    const s = await semear(a);
    const cx = (await a.chamar("POST", "/contas", { nome: "=CONTA", tipoConta: "outra" })).corpo.data;
    const cat = (await a.chamar("POST", "/plano-contas", { tipo: "DESPESA", natureza: "VARIAVEL", nome: "+categoria", papel: "despesa_variavel" })).corpo.data;
    for (const d of ["=HYPERLINK(\"http://x\",\"clique\")", "+55 11 99999", "-2+3", "@SUM(A1)", "ok; com \"aspas\""]) {
      await a.chamar("POST", "/lancamentos", { contaId: cx.id, categoriaId: cat.id, descricao: d, sentido: "saida", valor: "1,00", dataMovimento: "2026-09-22" });
    }
    const csv = (await a.baixar("/relatorios/tabelas/movimentacoes/exportar?de=2026-09-22&ate=2026-09-22&formato=csv")).texto;
    for (const linha of csvLinhas(csv)) assert.doesNotMatch(linha, /^[=+@]/);
    assert.match(csv, /'=HYPERLINK/); assert.match(csv, /'\+55 11 99999/); assert.match(csv, /'-2\+3/); assert.match(csv, /'@SUM/);
    assert.match(csv, /'=CONTA/); assert.match(csv, /'\+CATEGORIA/);
    assert.match(csv, /"ok; com ""aspas"""/);
    const x = await a.baixar("/relatorios/tabelas/movimentacoes/exportar?de=2026-09-22&ate=2026-09-22&formato=xlsx");
    const dados = XLSX.read(x.buf, { type: "buffer" }).Sheets.Dados;
    const textos = Object.keys(dados).filter((k) => !k.startsWith("!") && dados[k].t === "s").map((k) => dados[k].v);
    assert.ok(textos.includes("'=HYPERLINK(\"http://x\",\"clique\")")); assert.ok(textos.includes("'=CONTA"));
    assert.ok(textos.every((v) => !/^[=+@]/.test(v)));
    assert.ok(s);
  } finally { await a.fechar(); }
});

test("isolamento multiempresa: exportação da outra unidade não vê dados; unidade fora do contexto → 403; conta/categoria alheia → 400", async () => {
  const a = await ambiente();
  try {
    const sa = await semear(a, "A");
    const sb = await semear(a, "B");
    await sb.l(sb.caixa, "VENDAS", "entrada", "77,77", "2026-09-15", "venda EXCLUSIVA da unidade B");
    const p = "?de=2026-09-01&ate=2026-09-30&formato=csv";
    const csvA = (await a.baixar(`/relatorios/tabelas/movimentacoes/exportar${p}`, { tenant: "A" })).texto;
    const csvB = (await a.baixar(`/relatorios/tabelas/movimentacoes/exportar${p}`, { tenant: "B" })).texto;
    assert.doesNotMatch(csvA, /EXCLUSIVA/); assert.match(csvB, /EXCLUSIVA/);
    // unidade informada diferente da do contexto é recusada (mesma unidade é aceita)
    const outra = await a.chamar("GET", `/relatorios/tabelas/dre?de=2026-09-01&ate=2026-09-30&unidadeId=${U(12)}`, null, { tenant: "A" });
    assert.equal(outra.status, 403); assert.equal(outra.corpo.details.codigo, "UNIDADE_FORA_DO_CONTEXTO");
    assert.equal((await a.baixar(`/relatorios/tabelas/dre/exportar${p}&unidadeId=${U(12)}`, { tenant: "A" })).status, 403);
    assert.equal((await a.chamar("GET", `/relatorios/tabelas/dre?de=2026-09-01&ate=2026-09-30&unidadeId=${U(2)}`, null, { tenant: "A" })).status, 200);
    // ids de outra unidade como filtro → "não encontrado", sem revelar nada
    const contaDeB = a.repo._t.contas.find((x) => x.unidade_id === U(12));
    const r = await a.chamar("GET", `/relatorios/tabelas/movimentacoes?contaId=${contaDeB.id}`, null, { tenant: "A" });
    assert.equal(r.status, 400); assert.equal(r.corpo.details.codigo, "CONTA_INEXISTENTE");
    const catDeB = a.repo._t.plano.find((x) => x.organizacao_id === U(11));
    assert.equal((await a.chamar("GET", `/relatorios/tabelas/movimentacoes?categoriaId=${catDeB.id}`, null, { tenant: "A" })).status, 400);
    assert.ok(sa);
  } finally { await a.fechar(); }
});

test("autorização e entradas inválidas da exportação: sem `ver` → 403; formato/relatório/datas inválidos recusados sem vazar detalhes internos", async () => {
  const a = await ambiente();
  try {
    await semear(a);
    assert.equal((await a.baixar("/relatorios/tabelas/dre/exportar?formato=csv", { perms: [] })).status, 403);
    assert.equal((await a.baixar("/relatorios/tabelas/dre/exportar?formato=csv", { perms: NIVEL.leitura })).status, 200);
    assert.equal((await a.baixar("/relatorios/tabelas/dre/exportar?formato=pdf")).status, 400);
    assert.equal((await a.baixar("/relatorios/tabelas/dre/exportar")).status, 400);
    assert.equal((await a.baixar("/relatorios/tabelas/nada/exportar?formato=csv")).status, 404);
    assert.equal((await a.baixar("/relatorios/tabelas/dre/exportar?formato=csv&de=2026-02-30")).status, 400);
    assert.equal((await a.baixar("/relatorios/tabelas/dre/exportar?formato=csv&de=2026-09-30&ate=2026-09-01")).status, 400);
    const ruim = await a.baixar("/relatorios/tabelas/dre/exportar?formato=pdf");
    assert.doesNotMatch(ruim.texto, /fin_[a-z_]{4,}|organizacao_id|unidade_id|violates/i);
  } finally { await a.fechar(); }
});

test("exportação grande: acima do limite é recusada com orientação (sem estourar memória)", async () => {
  const lanc = Array.from({ length: 50_001 }, (_, i) => ({ id: `l${i}`, conta_id: U(31), categoria_id: null, sentido: "entrada", valor_centavos: 100, data_movimento: "2026-09-01", status: "realizado", classificacao_pendente: true, descricao: "x", origem: "manual" }));
  const repo = { listarContas: async () => [{ id: U(31), nome: "A", ativo: true, tipo_conta: "banco" }], listarPlanoContas: async () => [], listarAberturas: async () => [], listarTodosLancamentos: async () => lanc };
  const ctx = { organizacaoId: U(1), unidadeId: U(2), usuarioId: U(3) };
  await assert.rejects(() => tab.exportar(ctx, "movimentacoes", "csv", { de: "2026-09-01" }, { repo, db: undefined }), (e) => e.statusCode === 400 && e.details?.codigo === "EXPORTACAO_GRANDE");
  const tela = await tab.gerar(ctx, "movimentacoes", { de: "2026-09-01" }, { repo, db: undefined });
  assert.equal(tela.truncado, true); assert.equal(tela.linhas.length, tab.LIMITE_LINHAS_TELA); assert.equal(tela.total, 50_001);
});

// ---------------------------------------------------------------------------------------------------------------------
// Configurações financeiras
// ---------------------------------------------------------------------------------------------------------------------
test("configurações: mostra só o que o domínio suporta; abertura desconhecida, uso de categorias, política e itens indisponíveis", async () => {
  const a = await ambiente();
  try {
    await semear(a);
    const r = await a.chamar("GET", "/configuracoes", null, { perms: NIVEL.leitura });
    assert.equal(r.status, 200);
    const d = r.corpo.data;
    assert.deepEqual(d.saldosAberturaDesconhecidos.map((x) => x.nome), ["CAIXA"]);
    assert.equal(d.contas.find((x) => x.nome === "BANCO").aberturaConhecida, true);
    assert.equal(d.contas.find((x) => x.nome === "CAIXA").aberturaCentavos, null);
    const vendas = d.categorias.find((x) => x.nome === "VENDAS");
    assert.ok(vendas.lancamentos >= 3); assert.equal(vendas.podeTrocarPapel, false);
    const sem = d.categorias.find((x) => x.nome === "ENTRE CONTAS");
    assert.ok(sem.lancamentos >= 2);
    assert.equal(d.politicaFechamento, undefined);
    assert.deepEqual(d.fechamentoComPendencias, { modo: "excecao_por_competencia", habilitada: false, excecoesAtivas: 0, competenciasComExcecao: [] });
    assert.ok(d.indisponiveis.some((x) => x.id === "excecao-fechamento" && /MFA/.test(x.motivo) && /SuperAdmin/.test(x.motivo)));
    assert.ok(d.indisponiveis.some((x) => x.id === "reabertura-periodos" && /MFA recente/.test(x.motivo)));
    assert.ok(d.indisponiveis.some((x) => x.id === "regras-classificacao" && /decisão empresarial/.test(x.motivo)));
    assert.equal(d.conciliacao.contasSemCanal, 2);
    assert.equal((await a.chamar("GET", "/configuracoes", null, { perms: [] })).status, 403);
    // isolamento: outra unidade não vê nada
    const b = (await a.chamar("GET", "/configuracoes", null, { tenant: "B" })).corpo.data;
    assert.equal(b.contas.length, 0); assert.equal(b.categorias.length, 0);
  } finally { await a.fechar(); }
});

test("configurações: regras históricas protegidas — papel de categoria em uso e tipo/canal de conta com movimento fechado não mudam", async () => {
  const a = await ambiente();
  try {
    const s = await semear(a);
    // papel de categoria em uso: recusado (mensagem amigável)
    const r1 = await a.chamar("PATCH", `/plano-contas/${s.cat.VENDAS.id}`, { papel: "despesa_fixa" });
    assert.equal(r1.status, 400); assert.match(r1.corpo.error, /já possui lançamentos/); assert.doesNotMatch(r1.corpo.error, /fin_/);
    // antes de fechar, o canal da conta pode mudar
    assert.equal((await a.chamar("PATCH", `/contas/${s.banco.id}`, { canalReferencia: "stone" })).status, 200);
    assert.equal(a.repo._t.contas.find((x) => x.id === s.banco.id).canal_referencia, "STONE");
    // fecha setembro (este cenário não tem pendências: nenhuma exceção é necessária)
    const pre = (await a.chamar("GET", "/periodos/2026-09/pre-fechamento")).corpo.data;
    const f = await a.chamar("POST", "/periodos/2026-09/fechar", { confirmo: true, versao: pre.periodo.versao, fingerprint: pre.fingerprint, reconhecoPendencias: true });
    assert.equal(f.status, 200);
    const cfg = (await a.chamar("GET", "/configuracoes")).corpo.data;
    assert.equal(cfg.contas.find((x) => x.id === s.banco.id).podeAlterarTipoCanal, false);
    assert.ok(cfg.contas.find((x) => x.id === s.banco.id).lancamentosEmMesFechado > 0);
    // tipo e canal travados; nome e ativo continuam livres
    const t = await a.chamar("PATCH", `/contas/${s.banco.id}`, { tipoConta: "outra" });
    assert.equal(t.status, 400); assert.equal(t.corpo.details.codigo, "CONTA_COM_MOVIMENTO_FECHADO");
    assert.equal((await a.chamar("PATCH", `/contas/${s.banco.id}`, { canalReferencia: "ifood" })).status, 400);
    assert.equal(a.repo._t.contas.find((x) => x.id === s.banco.id).canal_referencia, "STONE");
    assert.equal((await a.chamar("PATCH", `/contas/${s.banco.id}`, { canalReferencia: "stone" })).status, 200);   // mesmo valor: não é mudança
    assert.equal((await a.chamar("PATCH", `/contas/${s.banco.id}`, { nome: "BANCO PRINCIPAL" })).status, 200);
    // lançamento em mês fechado continua protegido (nada a configurar muda isso)
    const cx = a.repo._t.contas.find((x) => x.nome === "CAIXA");
    assert.equal((await a.chamar("POST", "/lancamentos", { contaId: cx.id, descricao: "novo", sentido: "saida", valor: "1,00", dataMovimento: "2026-09-25" })).status, 400);
    // permissões de escrita das configurações seguem as rotas: operador não altera contas/plano
    assert.equal((await a.chamar("PATCH", `/contas/${s.caixa.id}`, { nome: "X" }, { perms: NIVEL.operador })).status, 403);
  } finally { await a.fechar(); }
});
