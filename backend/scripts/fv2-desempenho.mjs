// Medição de DESEMPENHO do Financeiro v2 (Execuções 07 e 07B) — somente no PostgreSQL LOCAL ISOLADO, dados SINTÉTICOS.
//   node scripts/fv2-desempenho.mjs [meses=6] [vendasPorMes=400]
// Gera vários meses de operação sintética pelo próprio núcleo — vendas por canal e processador, taxas, obrigações,
// pagamentos, movimentações sem classificação (pendências), importações SAIPOS com propostas, documentos no cofre,
// candidatas de conciliação e versões de fechamento — e mede as consultas das telas.
// Não lê .env, não abre nada além do banco de teste isolado. Os tempos são OBSERVAÇÕES deste computador, não metas.
import { performance } from "node:perf_hooks";
import { AGORA, ESCOPOS_PADRAO, ORG_A, UNI_A2, ctx, montar } from "../test/financeiro-v2/helpers/cenario.js";
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

if (process.env.FV2_SEM_ESTATISTICAS === "1") {
  const dono = await (await repositorio.interno()).dono();
  for (const { relname } of (await dono.query("select relname from pg_class where relkind = 'r' and relname like 'fv2\_%'")).rows) await dono.query(`alter table ${relname} set (autovacuum_enabled = false)`);
}
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
// 08D: diagnóstico por mês e por passo (antes: um contador "fechamento" sem dizer qual mês nem qual passo falhou).
const diagnosticoFechamentos = [];
for (const comp of competencias.slice(0, -1)) {
  for (const [passo, cmd] of [["preliminar", { competencia: comp, novoEstado: "FECHAMENTO_PRELIMINAR" }],
    ["com_pendencias", { competencia: comp, novoEstado: "FECHAMENTO_COM_PENDENCIAS", pendencias: [{ descricao: "Propostas da importação ainda em revisão (sintético)", impacto: "Pode alterar o resultado (sintético)." }], justificativa: "Fechamento sintético com pendências." }]]) {
    const antes = (await n.consultarFechamento(c, { competencia: comp })).estado;
    try {
      await n.alterarEstadoDaCompetencia(c, cmd);
      diagnosticoFechamentos.push({ comp, passo, de: antes, ok: true });
    } catch (e) {
      // Competência anterior à vigência da metodologia publicada: a recusa é a REGRA (nada para homologar sem critério).
      const esperado = e?.codigo === "FV2_TRANSICAO_INVALIDA" && /metodologia vigente/.test(e?.message ?? "");
      diagnosticoFechamentos.push({ comp, passo, de: antes, ok: false, esperado, codigo: e?.codigo ?? null, mensagem: e?.message, detalhes: e?.detalhes ?? null });
      if (!esperado) falhasDeCarga.fechamento = (falhasDeCarga.fechamento ?? 0) + 1;
      break;
    }
  }
}
// 08D: SEGUNDA unidade, pequena (distribuição desigual entre unidades no mesmo banco).
const c2 = ctx(ORG_A, UNI_A2);
await tentar("unidade pequena", async () => {
  const cx2 = await n.configurarContaFinanceira(c2, { tipo: "CAIXA_FISICO", nome: "Caixa 2" });
  for (let i = 0; i < 20; i += 1) await n.registrarVenda(c2, { canal: "BALCAO", dataVenda: `${competencias.at(-1)}-${String(1 + (i % 28)).padStart(2, "0")}`, brutoCentavos: 1000 + i, fonte: { sistema: "MANUAL", idExterno: `P2-${i}` }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 1000 + i, contaId: cx2.id }] });
});
const carga = performance.now() - t0;
// 08C/08D: estatísticas do planejador, como o autovacuum faria num banco em uso. Com FV2_SEM_ESTATISTICAS=1 mede o pior
// caso (banco recém-carregado): autovacuum desligado nas tabelas antes da carga e nenhum ANALYZE.
const SEM_ESTATISTICAS = process.env.FV2_SEM_ESTATISTICAS === "1";
if (!SEM_ESTATISTICAS) await (await (await repositorio.interno()).dono()).query("analyze");
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
const umaVenda = (await n.consultarVendas(c, { ...MES, tamanho: 1 })).itens[0]?.id;
const umRecebivel = (await n.consultarContasAReceber(c, { competencia: ULT, tamanho: 1 })).itens[0]?.id;
const umaConta = (await n.consultarContasAPagar(c, { competencia: ULT, tamanho: 1 })).itens[0]?.id;
const telas = {
  "Visão Geral (resumo)": (x) => x.consultarResumoFinanceiro(c, MES),
  "Caixa e bancos (mês)": (x) => x.consultarCaixaEBancos(c, { inicio: `${ULT}-01`, fim: `${ULT}-${ultimoDia(ULT)}` }),
  "Fluxo de caixa (mês)": (x) => x.consultarFluxoDeCaixa(c, { inicio: `${ULT}-01`, fim: `${ULT}-${ultimoDia(ULT)}`, granularidade: "DIA" }),
  "Contas a receber (página)": (x) => x.consultarContasAReceber(c, { tamanho: 25 }),
  "Contas a pagar (página)": (x) => x.consultarContasAPagar(c, { tamanho: 25 }),
  "Detalhe de venda": (x) => x.detalharVenda(c, { id: umaVenda }),
  "Detalhe de recebível": (x) => x.detalharRecebimento(c, { id: umRecebivel }),
  "Detalhe de conta a pagar": (x) => x.detalharContaAPagar(c, { id: umaConta }),
  "Central — unidade pequena": (x) => x.consultarCentralDeConferencias(c2, MES),
  "Vendas — unidade pequena": (x) => x.consultarVendas(c2, { ...MES, tamanho: 25 }),
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
  const { primeiraDiferenca: dif } = await import("../src/modules/financeiro-v2/aplicacao/cargaDaCompetencia.js");
  antesDepois.push({ nome, antesMs: a.medianaMs, depoisMs: d.medianaMs, identico: dif(await fn(n), await fn(antes)) ?? "IDENTICO" });
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
// 08C: PERFIL da carga dirigida — tempo por (operação da porta, tabela) numa consulta da Central (onde o tempo cresce?).
const perfil = {};
const perfilado = {
  transacao: (fn, op) => repositorio.transacao(fn, op),
  leitura: (fn, op) => repositorio.leitura((tx) => fn(new Proxy(tx, { get: (alvo, prop) => (typeof alvo[prop] !== "function" ? alvo[prop] : async (...a) => {
    const t = performance.now(); const r = await alvo[prop](...a); const k = `${String(prop)} ${typeof a[1] === "string" ? a[1] : ""}`;
    const e = (perfil[k] ??= { chamadas: 0, ms: 0, linhas: 0 }); e.chamadas += 1; e.ms += performance.now() - t; e.linhas += Array.isArray(r) ? r.length : r?.itens?.length ?? 0; return r;
  }) })), op),
};
const nPerfil = criarNucleoFinanceiro({ repositorio: perfilado, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, cofre });
const nPerfilCompleto = criarNucleoFinanceiro({ repositorio: perfilado, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, cofre, cargaCompletaDeReferencia: true });
const consultasPorTela = [];
for (const [nome, fn] of Object.entries(telas)) {
  const medir2 = async (nucleo) => { for (const k of Object.keys(perfil)) delete perfil[k]; await fn(nucleo); return Object.values(perfil).reduce((a, v) => ({ consultas: a.consultas + v.chamadas, linhas: a.linhas + v.linhas }), { consultas: 0, linhas: 0 }); };
  consultasPorTela.push({ nome, dirigida: await medir2(nPerfil), completa: await medir2(nPerfilCompleto) });
}
for (const k of Object.keys(perfil)) delete perfil[k];
const tPerfil = performance.now();
await nPerfil.consultarCentralDeConferencias(c, MES);
const totalPerfil = Math.round(performance.now() - tPerfil);
const perfilOrdenado = Object.entries(perfil).map(([k, v]) => ({ k, chamadas: v.chamadas, ms: Math.round(v.ms), linhas: v.linhas })).sort((a, b) => b.ms - a.ms).slice(0, 15);
// 08D: EXPLAIN (ANALYZE, BUFFERS) das consultas REAIS que a Central dirigida emite — texto e parâmetros capturados do
// driver durante uma chamada da tela. O EXPLAIN roda como dono (sem RLS): mostra a escolha de índice para o filtro da
// própria consulta; a RLS só acrescenta o filtro de escopo (organização/unidade), coberto pelos mesmos índices.
const capturadas = new Map();
let capturando = false;
const conectarOriginal = pool.connect.bind(pool);
pool.connect = async (...a) => {
  const cl = await conectarOriginal(...a);
  if (!cl.__fv2Explain) {
    const q = cl.query.bind(cl);
    cl.query = (texto, params, ...r) => {
      const res = q(texto, params, ...r);
      if (!capturando || typeof texto !== "string" || !/^\s*select/i.test(texto) || !/fv2_/.test(texto)) return res;
      const t = performance.now();
      return Promise.resolve(res).then((x) => {
        const k = texto.replace(/\s+/g, " ").trim();
        const e = capturadas.get(k) ?? { texto, params, ms: 0, vezes: 0, linhas: 0 };
        e.ms += performance.now() - t; e.vezes += 1; e.linhas = Math.max(e.linhas, x?.rowCount ?? 0); capturadas.set(k, e);
        return x;
      });
    };
    cl.__fv2Explain = true;
  }
  return cl;
};
capturando = true;
await n.consultarCentralDeConferencias(c, MES);
capturando = false;
const donoExplain = await (await repositorio.interno()).dono();
const planos = [];
for (const e of [...capturadas.values()].sort((a, b) => b.ms - a.ms).slice(0, 8)) {
  try {
    const { rows } = await donoExplain.query(`explain (analyze, buffers, format json) ${e.texto}`, e.params);
    const p = rows[0]["QUERY PLAN"][0];
    const nos = [];
    const visitar = (x) => { nos.push(`${x["Node Type"]}${x["Index Name"] ? ` ${x["Index Name"]}` : ""}${x["Relation Name"] ? ` em ${x["Relation Name"]}` : ""}`); for (const f of x.Plans ?? []) visitar(f); };
    visitar(p.Plan);
    planos.push({ consulta: e.texto.replace(/\s+/g, " ").slice(0, 180), vezes: e.vezes, linhas: e.linhas, msNaTela: Math.round(e.ms), execucaoMs: p["Execution Time"], planejamentoMs: p["Planning Time"], blocosLidos: (p.Plan["Shared Hit Blocks"] ?? 0) + (p.Plan["Shared Read Blocks"] ?? 0), nos: nos.slice(0, 8) });
  } catch (erro) { planos.push({ consulta: e.texto.replace(/\s+/g, " ").slice(0, 180), erro: erro.message }); }
}
const mem = process.memoryUsage();
console.log(JSON.stringify({
  meses: MESES, vendasPorMes: VENDAS, semEstatisticas: process.env.FV2_SEM_ESTATISTICAS === "1", registros: contagem, falhasDeCarga, cargaS: Math.round(carga / 1000),
  diagnosticoFechamentos: diagnosticoFechamentos.filter((x) => !x.ok), medicoes: resultados, antesDepois, equivalencia, perfilCentral: { totalMs: totalPerfil, porOperacao: perfilOrdenado }, consultasPorTela, explainCentral: planos,
  memoriaMb: { rss: Math.round(mem.rss / 1048576), heap: Math.round(mem.heapUsed / 1048576) },
}, null, 2));
await pool.end?.();
process.exit(0);
