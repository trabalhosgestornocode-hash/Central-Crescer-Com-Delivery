// Medição de DESEMPENHO do Financeiro v2 (Execução 07) — somente no PostgreSQL LOCAL ISOLADO, com dados SINTÉTICOS.
//   node scripts/fv2-desempenho.mjs [meses=6] [vendasPorMes=400]
// Gera vários meses de operação sintética pelo próprio núcleo (vendas por canal e processador, taxas, obrigações,
// pagamentos e movimentações) e mede as consultas das telas. Não lê .env, não abre nada além do banco de teste isolado.
// Os tempos são OBSERVAÇÕES deste computador, não metas: não há requisito de desempenho aprovado.
import { performance } from "node:perf_hooks";
import { ESCOPOS_PADRAO, ctx, montar } from "../test/financeiro-v2/helpers/cenario.js";
import { repositorioPostgresDeTeste } from "../test/financeiro-v2/helpers/postgres.js";

const MESES = Number(process.argv[2] ?? 6);
const VENDAS = Number(process.argv[3] ?? 400);
const c = ctx();
const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO);
const { nucleo: n } = montar({ repositorio });
const { pool } = await repositorio.interno();
const mesesAte = (fim, qtd) => Array.from({ length: qtd }, (_, i) => { const d = new Date(Date.UTC(2026, 8 - (qtd - 1 - i), 1)); return d.toISOString().slice(0, 7); });
const competencias = mesesAte("2026-09", MESES);

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
}
const carga = performance.now() - t0;
// Contagem pelo núcleo (o papel da aplicação sem escopo declarado não enxerga nada: RLS).
const contagem = { vendas: (await n.consultarRegistros(c, { tipo: "VENDA" })).length, lancamentos: (await n.consultarRegistros(c, { tipo: "LANCAMENTO" })).length, obrigacoes: (await n.consultarRegistros(c, { tipo: "OBRIGACAO" })).length };

const medir = async (nome, fn, vezes = 3) => {
  const tempos = [];
  let r;
  for (let i = 0; i < vezes; i += 1) { const a = performance.now(); r = await fn(); tempos.push(performance.now() - a); }
  tempos.sort((x, y) => x - y);
  return { nome, medianaMs: Math.round(tempos[Math.floor(tempos.length / 2)]), r };
};
const SET = { competencia: "2026-09" };
const resultados = [];
resultados.push(await medir("Apuração / DRE (mês)", () => n.apurarCompetencia(c, SET)));
resultados.push(await medir("Visão Geral (apuração + resumo)", async () => [await n.apurarVisaoGeral(c, SET), await n.consultarResumoFinanceiro(c, SET)]));
resultados.push(await medir("Composição de um indicador", () => n.composicaoDoIndicador(c, { ...SET, codigo: "DESPESAS_OPERACIONAIS" })));
resultados.push(await medir("Contas a pagar (página)", () => n.consultarContasAPagar(c, { tamanho: 25 })));
resultados.push(await medir("Contas a receber (página)", () => n.consultarContasAReceber(c, { tamanho: 25 })));
resultados.push(await medir("Caixa e bancos (mês)", () => n.consultarCaixaEBancos(c, { inicio: "2026-09-01", fim: "2026-09-30" })));
resultados.push(await medir("Vendas (página)", () => n.consultarVendas(c, { ...SET, tamanho: 25 })));
resultados.push(await medir("Central de Conferências", () => n.consultarCentralDeConferencias(c, SET)));
resultados.push(await medir("Pendências (página)", () => n.consultarPendencias(c, { ...SET, tamanho: 25 })));
resultados.push(await medir("Fechamento (situação)", () => n.consultarFechamento(c, SET)));
resultados.push(await medir("Prévia de homologação", () => n.previaDaMudancaDeEstado(c, { ...SET, novoEstado: "FECHAMENTO_HOMOLOGADO" })));
const simultaneas = await medir("10 apurações simultâneas", () => Promise.all(Array.from({ length: 10 }, () => n.apurarCompetencia(c, SET))), 1);
resultados.push(simultaneas);
const mem = process.memoryUsage();
console.log(JSON.stringify({
  meses: MESES, vendasPorMes: VENDAS, registros: contagem, cargaS: Math.round(carga / 1000),
  medicoes: resultados.map(({ nome, medianaMs }) => ({ nome, medianaMs })),
  memoriaMb: { rss: Math.round(mem.rss / 1048576), heap: Math.round(mem.heapUsed / 1048576) },
}, null, 2));
await pool.end?.();
process.exit(0);
