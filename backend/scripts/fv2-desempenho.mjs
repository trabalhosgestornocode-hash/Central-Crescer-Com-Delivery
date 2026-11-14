// Medição de DESEMPENHO do Financeiro v2 (Execuções 07 e 07B) — somente no PostgreSQL LOCAL ISOLADO, dados SINTÉTICOS.
//   node scripts/fv2-desempenho.mjs [meses=6] [vendasPorMes=400]
// Gera vários meses de operação sintética pelo próprio núcleo — vendas por canal e processador, taxas, obrigações,
// pagamentos, movimentações sem classificação (pendências), importações SAIPOS com propostas, documentos no cofre,
// candidatas de conciliação e versões de fechamento — e mede as consultas das telas.
// Não lê .env, não abre nada além do banco de teste isolado. Os tempos são OBSERVAÇÕES deste computador, não metas.
import { performance } from "node:perf_hooks";
import { AGORA, ESCOPOS_PADRAO, ctx, montar } from "../test/financeiro-v2/helpers/cenario.js";
import { criarNucleoFinanceiro } from "../src/modules/financeiro-v2/index.js";
import { saiposVendas } from "../test/financeiro-v2/helpers/arquivos.js";
import { repositorioPostgresDeTeste } from "../test/financeiro-v2/helpers/postgres.js";

const MESES = Number(process.argv[2] ?? 6);
const VENDAS = Number(process.argv[3] ?? 400);
const c = ctx();
const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO);
const { nucleo: n, cofre } = montar({ repositorio });
const { pool } = await repositorio.interno();
const mesesAte = (qtd) => Array.from({ length: qtd }, (_, i) => new Date(Date.UTC(2026, 8 - (qtd - 1 - i), 1)).toISOString().slice(0, 7));
const competencias = mesesAte(MESES);
const ultimoDia = (comp) => new Date(Date.UTC(Number(comp.slice(0, 4)), Number(comp.slice(5)), 0)).getUTCDate();
const falhasDeCarga = {};
const tentar = async (nome, fn) => { try { return await fn(); } catch (e) { falhasDeCarga[nome] = (falhasDeCarga[nome] ?? 0) + 1; falhasDeCarga[`${nome}:ultimo`] = e?.codigo ?? e?.message; return null; } };

const t0 = performance.now();
const caixa = await n.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa" });
const banco = await n.configurarContaFinanceira(c, { tipo: "BANCARIA", nome: "Banco" });
const forn = await n.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Fornecedor sintético" });
let k = 0;
for (const comp of competencias) {
  for (let i = 0; i < VENDAS; i += 1) {
    const dia = String(1 + (i % 28)).padStart(2, "0");
    const valor = 1500 + ((i * 37) % 4000);
    const tipo = i % 4;
    const canal = ["BALCAO", "IFOOD", "ANOTA_AI", "BALCAO"][tipo];
    const pagamento = tipo === 0 ? { forma: "DINHEIRO", valorCentavos: valor, contaId: caixa.id } : tipo === 3 ? { forma: "CREDITO", processador: "STONE", valorCentavos: valor } : { forma: "OUTRA", processador: canal, valorCentavos: valor };
    const v = await n.registrarVenda(c, { canal, dataVenda: `${comp}-${dia}`, brutoCentavos: valor, fonte: { sistema: "MANUAL", idExterno: `D-${(k += 1)}` }, pagamentos: [pagamento] });
    if (tipo === 3) await n.registrarAjuste(c, { alvoTipo: "RECEBIVEL", alvoId: v.recebiveis[0].id, valorCentavos: -Math.max(1, Math.floor(valor / 40)), motivo: "Taxa", categoria: "TAXAS_STONE" });
  }
  for (let j = 0; j < Math.max(4, Math.floor(VENDAS / 10)); j += 1) {
    const o = (await n.registrarObrigacao(c, { contraparteId: forn.id, valorOriginalCentavos: 5000 + j * 10, categoria: j % 2 ? "INSUMOS" : "EMBALAGENS", descricao: `Compra ${j}`, competencia: comp, dataEmissao: `${comp}-02`, vencimento: `${comp}-20` })).obrigacoes[0];
    if (j % 3 === 0) {
      const m = (await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: `${comp}-20`, sentido: "SAIDA", valorCentavos: 5000 + j * 10, natureza: "PAGAMENTO" })).movimentacao;
      await n.registrarLiquidacao(c, { movimentacaoId: m.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: o.id, valorCentavos: 5000 + j * 10 }] });
    }
  }
  // 08C: repasses AGREGADOS do mês seguinte liquidando recebíveis Stone do mês anterior (vínculos entre competências).
  if (comp !== competencias[0]) {
    await tentar("repasse", async () => {
      const anterior = competencias[competencias.indexOf(comp) - 1];
      const abertos = (await n.consultarContasAReceber(c, { competencia: anterior, processador: "STONE", tamanho: 100 })).itens.filter((t) => t.saldoCentavos > 0).slice(0, 80);
      for (let s0 = 0; s0 < abertos.length; s0 += 20) {
        const lote = abertos.slice(s0, s0 + 20);
        const total = lote.reduce((x, t) => x + t.saldoCentavos, 0);
        const mov = (await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: `${comp}-0${1 + s0 / 20}`, sentido: "ENTRADA", valorCentavos: total, natureza: "RECEBIMENTO" })).movimentacao;
        await n.registrarLiquidacao(c, { movimentacaoId: mov.id, alocacoes: lote.map((t) => ({ alvoTipo: "RECEBIVEL", alvoId: t.id, valorCentavos: t.saldoCentavos })) });
      }
    });
  }
  // Pendências: saídas bancárias sem classificação.
  for (let j = 0; j < 5; j += 1) await n.registrarMovimentacao(c, { contaId: banco.id, dataEfetiva: `${comp}-2${j}`, sentido: "SAIDA", valorCentavos: 300 + j, natureza: "OUTRA" });
  // Importação SAIPOS do mês → propostas em aberto (formação).
  const pedidos = Array.from({ length: 40 }, (_, i) => ({ pedido: `P-${comp}-${i}`, data: `${String(1 + (i % 27)).padStart(2, "0")}/${comp.slice(5)}/${comp.slice(0, 4)} 12:00`, canal: "Balcão", itens: 1200 + i, forma: "Dinheiro" }));
  await tentar("importacao", async () => {
    const r = await n.receberArquivoParaImportacao(c, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "text/csv", periodoInicio: `${comp}-01`, periodoFim: `${comp}-${ultimoDia(comp)}`, conteudo: saiposVendas(pedidos) });
    const conf = await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia });
    await n.gerarPropostas(c, { importacaoId: conf.importacao.id, contaCaixaId: caixa.id });
  });
  // Documentos no cofre.
  for (let j = 0; j < 6; j += 1) {
    await tentar("documento", async () => {
      const g = await cofre.guardar(c, { conteudo: new TextEncoder().encode(`%PDF-1.4\n% ${comp} ${j}\n%%EOF\n`), tipoMime: "application/pdf" });
      await n.registrarDocumento(c, { origem: "MANUAL", arquivoId: g.arquivoId, hashSha256: g.hashSha256, tipo: "COMPROVANTE", recebidoEm: `${comp}-15`, descricao: `Comprovante ${comp} ${j}` });
    });
  }
  // Candidatas de conciliação do mês.
  await tentar("conciliacao", () => n.gerarCandidatasDeConciliacao(c, { relacao: "SAIPOS_X_STONE", periodoInicio: `${comp}-01`, periodoFim: `${comp}-${ultimoDia(comp)}` }));
}
// Versões de fechamento: todo mês anterior ao último fecha COM PENDÊNCIAS documentadas (preliminar → com pendências).
for (const comp of competencias.slice(0, -1)) {
  await tentar("fechamento", async () => {
    await n.alterarEstadoDaCompetencia(c, { competencia: comp, novoEstado: "FECHAMENTO_PRELIMINAR" });
    await n.alterarEstadoDaCompetencia(c, { competencia: comp, novoEstado: "FECHAMENTO_COM_PENDENCIAS", pendencias: [{ descricao: "Propostas da importação ainda em revisão (sintético)", impacto: "Pode alterar o resultado (sintético)." }], justificativa: "Fechamento sintético com pendências." });
  });
}
const carga = performance.now() - t0;
// Contagem pelo núcleo (o papel da aplicação sem sessão de banco não enxerga nada: RLS).
const contagem = {};
for (const tipo of ["VENDA", "RECEBIVEL", "OBRIGACAO", "MOVIMENTACAO", "LANCAMENTO", "DOCUMENTO", "PROPOSTA", "CORRESPONDENCIA"]) {
  contagem[tipo] = await tentar(`contar ${tipo}`, async () => (await n.consultarRegistros(c, { tipo })).length);
}

const medir = async (nome, fn, vezes = 3) => {
  const tempos = [];
  for (let i = 0; i < vezes; i += 1) { const a = performance.now(); await fn(); tempos.push(performance.now() - a); }
  tempos.sort((x, y) => x - y);
  return { nome, medianaMs: Math.round(tempos[Math.floor(tempos.length / 2)]) };
};
const ULT = competencias.at(-1);
const MES = { competencia: ULT };
const resultados = [];
// 08C: ANTES × DEPOIS nas MESMAS condições (mesmo banco, dados e máquina): a referência lê o histórico inteiro, como até a 08B.
const antes = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, cofre, cargaCompletaDeReferencia: true });
const telas = {
  "Vendas (página)": (x) => x.consultarVendas(c, { ...MES, tamanho: 25 }),
  "Recebimentos consolidados": (x) => x.consultarRecebiveisERepasses(c, { ...MES, tamanho: 25 }),
  "Central de Conferências": (x) => x.consultarCentralDeConferencias(c, MES),
  "Pendências (página)": (x) => x.consultarPendencias(c, { ...MES, tamanho: 25 }),
  "Fechamento (situação)": (x) => x.consultarFechamento(c, MES),
  "Prévia de homologação": (x) => x.previaDaMudancaDeEstado(c, { ...MES, novoEstado: "FECHAMENTO_HOMOLOGADO" }),
};
const antesDepois = [];
for (const [nome, fn] of Object.entries(telas)) {
  const a = await medir(nome, () => fn(antes), 5);
  const d = await medir(nome, () => fn(n), 5);
  antesDepois.push({ nome, antesMs: a.medianaMs, depoisMs: d.medianaMs });
}
// Equivalência no conjunto de 12 meses: cada mês, cada tela otimizada, dirigida = completa.
const { primeiraDiferenca } = await import("../src/modules/financeiro-v2/aplicacao/cargaDaCompetencia.js");
const equivalencia = {};
for (const comp of competencias) {
  const M = { competencia: comp };
  const pares = [["central", (x) => x.consultarCentralDeConferencias(c, M)], ["pendencias", (x) => x.consultarPendencias(c, { ...M, tamanho: 100 })], ["fechamento", (x) => x.consultarFechamento(c, M)],
    ["vendas", (x) => x.consultarVendas(c, { ...M, tamanho: 50 })], ["recebimentos", (x) => x.consultarRecebiveisERepasses(c, { ...M, tamanho: 50 })], ["divergencias", (x) => x.consultarDivergenciasDeVendas(c, { ...M, tamanho: 50 })]];
  const difs = [];
  for (const [nome, fn] of pares) { const dif = primeiraDiferenca(await fn(n), await fn(antes)); if (dif) difs.push(`${nome}: ${dif}`); }
  equivalencia[comp] = difs.length ? difs : "IDENTICO";
}
resultados.push(await medir("Apuração / DRE (mês)", () => n.apurarCompetencia(c, MES)));
resultados.push(await medir("Visão Geral (apuração + resumo)", async () => [await n.apurarVisaoGeral(c, MES), await n.consultarResumoFinanceiro(c, MES)]));
resultados.push(await medir("Composição de um indicador", () => n.composicaoDoIndicador(c, { ...MES, codigo: "DESPESAS_OPERACIONAIS" })));
resultados.push(await medir("Contas a pagar (página)", () => n.consultarContasAPagar(c, { tamanho: 25 })));
resultados.push(await medir("Contas a receber (página)", () => n.consultarContasAReceber(c, { tamanho: 25 })));
resultados.push(await medir("Caixa e bancos (mês)", () => n.consultarCaixaEBancos(c, { inicio: `${ULT}-01`, fim: `${ULT}-${ultimoDia(ULT)}` })));
resultados.push(await medir("Vendas (página)", () => n.consultarVendas(c, { ...MES, tamanho: 25 })));
resultados.push(await medir("Central de Conferências", () => n.consultarCentralDeConferencias(c, MES)));
resultados.push(await medir("Pendências (página)", () => n.consultarPendencias(c, { ...MES, tamanho: 25 })));
resultados.push(await medir("Fechamento (situação)", () => n.consultarFechamento(c, MES)));
resultados.push(await medir("Prévia de homologação", () => n.previaDaMudancaDeEstado(c, { ...MES, novoEstado: "FECHAMENTO_HOMOLOGADO" })));
resultados.push(await medir("10 apurações simultâneas", () => Promise.all(Array.from({ length: 10 }, () => n.apurarCompetencia(c, MES))), 1));
resultados.push(await medir("10 telas simultâneas (mistas)", () => Promise.all([
  n.apurarVisaoGeral(c, MES), n.consultarResumoFinanceiro(c, MES), n.consultarContasAPagar(c, { tamanho: 25 }), n.consultarContasAReceber(c, { tamanho: 25 }),
  n.consultarVendas(c, { ...MES, tamanho: 25 }), n.consultarCentralDeConferencias(c, MES), n.consultarPendencias(c, { ...MES, tamanho: 25 }),
  n.consultarFechamento(c, MES), n.apurarCompetencia(c, MES), n.composicaoDoIndicador(c, { ...MES, codigo: "DESPESAS_OPERACIONAIS" }),
]), 1));
const mem = process.memoryUsage();
console.log(JSON.stringify({
  meses: MESES, vendasPorMes: VENDAS, registros: contagem, falhasDeCarga, cargaS: Math.round(carga / 1000),
  medicoes: resultados, antesDepois, equivalencia,
  memoriaMb: { rss: Math.round(mem.rss / 1048576), heap: Math.round(mem.heapUsed / 1048576) },
}, null, 2));
await pool.end?.();
process.exit(0);
