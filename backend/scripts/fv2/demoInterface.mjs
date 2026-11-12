// AMBIENTE DEMONSTRATIVO LOCAL da interface do Financeiro v2 (Execução 05).
//
// - Dados 100% SINTÉTICOS em memória (nenhum banco, nenhum .env, nenhuma rede além de 127.0.0.1).
// - Sessão SIMULADA pelo seletor do próprio ambiente (cabeçalho x-fv2-demo-sessao), mas passando pelo adaptador de sessão
//   e pelas concessões financeiro_v2.* reais do módulo: organização vem da sessão, unidade é validada, ação VER exigida.
// - Consome SOMENTE as consultas aprovadas do motor (apurarVisaoGeral, apurarCompetencia, composicaoDoIndicador).
// - Respostas saem SANITIZADAS: identificadores internos viram referências opacas; documentos aparecem como
//   "registrado, não acessível nesta versão" (não há link nem caminho de arquivo).
// NÃO é rota do aplicativo: não é montado em backend/src e não deve ser publicado.
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const aqui = dirname(fileURLToPath(import.meta.url));
const m = await import(pathToFileURL(join(aqui, "..", "..", "src", "modules", "financeiro-v2", "index.js")));
const { faturamentoSaiposPdf } = await import(pathToFileURL(join(aqui, "..", "..", "test", "financeiro-v2", "helpers", "formatos.js")));
const { foodyEntregas } = await import(pathToFileURL(join(aqui, "..", "..", "test", "financeiro-v2", "helpers", "arquivos.js")));

export const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
export const UNIDADES = Object.freeze([
  { id: "aaaaaaaa-0000-4000-8000-0000000000a1", nome: "Unidade Demonstração (Saci)" },
  { id: "aaaaaaaa-0000-4000-8000-0000000000a2", nome: "Unidade Demonstração 2" },
]);
const USUARIOS = { gestor: "dddddddd-0000-4000-8000-000000000001", leitor: "dddddddd-0000-4000-8000-000000000002" };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Monta o núcleo e o cenário sintético (setembro com pendências, agosto homologado, unidade 2 com zero confirmado). */
export async function criarDemo({ relogio = () => new Date("2026-11-12T15:00:00Z") } = {}) {
  const escopos = UNIDADES.map((u) => ({ organizacaoId: ORG, unidadeId: u.id }));
  const sal = randomUUID();
  const nucleo = m.criarNucleoFinanceiro({ repositorio: m.criarRepositorioMemoria(), escoposAutorizados: escopos, relogio, cofre: m.criarCofreMemoria() });
  const tudo = Object.values(m.ACAO);
  const c = (u = UNIDADES[0].id) => ({ organizacaoId: ORG, unidadeId: u, usuarioId: "cccccccc-0000-4000-8000-000000000001", permissoes: tudo });
  for (const u of UNIDADES) await nucleo.implantarPlanoDeContas(c(u.id), { modelo: "ACAITERIA" });
  const A = c();
  const caixa = await nucleo.configurarContaFinanceira(A, { tipo: "CAIXA_FISICO", nome: "Caixa" });
  const banco = await nucleo.configurarContaFinanceira(A, { tipo: "BANCARIA", nome: "Banco Demonstração" });
  let n = 0;
  const venda = (canal, data, bruto, extra = {}) => nucleo.registrarVenda(A, { canal, dataVenda: data, brutoCentavos: bruto, fonte: { sistema: "MANUAL", idExterno: `DEMO-${(n += 1)}` }, composicao: { itensCentavos: bruto }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: bruto, contaId: caixa.id }], ...extra });
  // Agosto: competência homologada, sem pendências → CONFIRMADO.
  await venda("BALCAO", "2026-08-10", 380000);
  await nucleo.registrarObrigacao(A, { contraparteId: (await nucleo.registrarContraparte(A, { tipo: "FORNECEDOR", nome: "Fornecedor Demonstração" })).id, valorOriginalCentavos: 120000, categoria: "INSUMOS", descricao: "Insumos (demonstração)", competencia: "2026-08", dataEmissao: "2026-08-05", vencimento: "2026-08-20" });
  await nucleo.alterarEstadoDaCompetencia(A, { competencia: "2026-08", novoEstado: "FECHAMENTO_PRELIMINAR" });
  await nucleo.alterarEstadoDaCompetencia(A, { competencia: "2026-08", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Homologação da demonstração." });
  // Setembro: canais, taxas, descontos (inclusive a classificar), agregado sem canal, motoboys, saída sem classificação.
  await venda("BALCAO", "2026-09-05", 412350);
  await nucleo.registrarVenda(A, { canal: "BALCAO", dataVenda: "2026-09-06", brutoCentavos: 250000, fonte: { sistema: "MANUAL", idExterno: "DEMO-C1" }, composicao: { itensCentavos: 240000, acrescimosCentavos: 10000, descontos: [{ valorCentavos: 12500, financiador: "LOJA" }] }, pagamentos: [{ forma: "CREDITO", processador: "STONE", valorCentavos: 237500 }] })
    .then((r) => nucleo.registrarAjuste(A, { alvoTipo: "RECEBIVEL", alvoId: r.recebiveis[0].id, valorCentavos: -5937, motivo: "Taxa Stone (demonstração)", categoria: "TAXAS_STONE" }));
  const ifood = await nucleo.registrarVenda(A, { canal: "IFOOD", dataVenda: "2026-09-07", brutoCentavos: 528000, fonte: { sistema: "MANUAL", idExterno: "DEMO-I1" }, composicao: { itensCentavos: 528000, descontos: [{ valorCentavos: 21000, financiador: "LOJA" }, { valorCentavos: 9000, financiador: "PENDENTE" }] }, pagamentos: [{ forma: "OUTRA", processador: "IFOOD", valorCentavos: 498000 }] });
  for (const [cat, v] of [["COMISSOES_IFOOD", 63360], ["TAXAS_DE_PROCESSAMENTO", 16700], ["ANUNCIOS_IFOOD", 15000], ["MENSALIDADE_IFOOD", 12900]]) await nucleo.registrarAjuste(A, { alvoTipo: "RECEBIVEL", alvoId: ifood.recebiveis[0].id, valorCentavos: -v, motivo: `${cat} (demonstração)`, categoria: cat });
  await nucleo.registrarVenda(A, { canal: "ANOTA_AI", dataVenda: "2026-09-08", brutoCentavos: 98000, fonte: { sistema: "MANUAL", idExterno: "DEMO-A1" }, composicao: { itensCentavos: 98000 }, pagamentos: [{ forma: "OUTRA", processador: "ANOTA_AI", valorCentavos: 98000 }] });
  const importar = async (fonte, tipoRelatorio, conteudo, periodo) => {
    const r = await nucleo.receberArquivoParaImportacao(A, { fonte, tipoRelatorio, tipoMime: "application/octet-stream", conteudo, ...periodo });
    return (await nucleo.confirmarImportacao(A, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, ...(r.previa.totalDivergencias ? { aceitarPendencias: true, justificativa: "Demonstração." } : {}) })).importacao;
  };
  const agr = await importar("SAIPOS", "SAIPOS_FATURAMENTO_POR_DIA", faturamentoSaiposPdf([{ data: "02/09/2026", valor: 185000, desconto: 7400 }]), { periodoInicio: "2026-09-02", periodoFim: "2026-09-02" });
  await nucleo.gerarPropostas(A, { importacaoId: agr.id });
  for (const p of await nucleo.listarPropostas(A, { operacao: "VENDA_AGREGADA" })) { await nucleo.aprovarProposta(A, { propostaId: p.id }); await nucleo.aplicarProposta(A, { propostaId: p.id }); }
  const foody = await importar("FOODY", "FOODY_ENTREGAS", foodyEntregas([
    { pedido: "DEMO-F1", data: "03/09/2026", entregador: "Entregador Demonstração A", taxa: 700, custo: 650 },
    { pedido: "DEMO-F2", data: "04/09/2026", entregador: "Entregador Demonstração A", taxa: 900, custo: 800 },
    { pedido: "DEMO-F3", data: "04/09/2026", entregador: "Entregador Demonstração A", taxa: 700, custo: 650, situacao: "Taxa rejeitada" },
    { pedido: "DEMO-F4", data: "05/09/2026", entregador: "Entregador Demonstração B", taxa: 700, custo: 700 },
  ], { subtotais: { "Entregador Demonstração A": 1450, "Entregador Demonstração B": 700 }, total: 2150 }), { periodoInicio: "2026-09-01", periodoFim: "2026-09-30" });
  await nucleo.gerarPropostas(A, { importacaoId: foody.id });
  for (const p of await nucleo.listarPropostas(A, { operacao: "OBRIGACAO_ENTREGADOR" })) {
    await nucleo.aprovarProposta(A, { propostaId: p.id });
    const r = await nucleo.aplicarProposta(A, { propostaId: p.id });
    if (p.entregador.endsWith("A")) {
      const pix = await nucleo.registrarMovimentacao(A, { contaId: banco.id, dataEfetiva: "2026-10-05", sentido: "SAIDA", valorCentavos: 1000, natureza: "PAGAMENTO" });
      await nucleo.registrarLiquidacao(A, { movimentacaoId: pix.movimentacao.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: r.efeitos.find((e) => e.tipo === "OBRIGACAO").id, valorCentavos: 1000 }] });
    }
  }
  const forn = await nucleo.registrarContraparte(A, { tipo: "FORNECEDOR", nome: "Fornecedor de Insumos (demonstração)" });
  await nucleo.registrarObrigacao(A, { contraparteId: forn.id, valorOriginalCentavos: 431900, categoria: "FRUTAS", descricao: "Frutas (demonstração)", competencia: "2026-09", dataEmissao: "2026-09-03", vencimento: "2026-09-18" });
  await nucleo.registrarObrigacao(A, { contraparteId: forn.id, valorOriginalCentavos: 118000, categoria: "EMBALAGENS", descricao: "Embalagens (demonstração)", competencia: "2026-09", dataEmissao: "2026-09-04", vencimento: "2026-09-19" });
  await nucleo.registrarObrigacao(A, { contraparteId: forn.id, valorOriginalCentavos: 3200, categoria: "JUROS_E_TARIFAS_BANCARIAS", descricao: "Tarifa bancária (demonstração)", competencia: "2026-09", dataEmissao: "2026-09-10", vencimento: "2026-09-10" });
  await nucleo.registrarMovimentacao(A, { contaId: banco.id, dataEfetiva: "2026-09-21", sentido: "SAIDA", valorCentavos: 15000, natureza: "PAGAMENTO" });
  // Unidade 2: só uma despesa e competência homologada → faturamento ZERO CONFIRMADO.
  const B = c(UNIDADES[1].id);
  const f2 = await nucleo.registrarContraparte(B, { tipo: "FORNECEDOR", nome: "Fornecedor (demonstração 2)" });
  await nucleo.registrarObrigacao(B, { contraparteId: f2.id, valorOriginalCentavos: 50000, categoria: "INSUMOS", descricao: "Insumos (demonstração 2)", competencia: "2026-09", dataEmissao: "2026-09-02", vencimento: "2026-09-20" });
  await nucleo.alterarEstadoDaCompetencia(B, { competencia: "2026-09", novoEstado: "FECHAMENTO_PRELIMINAR" });
  await nucleo.alterarEstadoDaCompetencia(B, { competencia: "2026-09", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Homologação da demonstração." });

  const concessoes = m.criarConcessoesMemoria([
    ...UNIDADES.map((u) => ({ organizacaoId: ORG, usuarioId: USUARIOS.gestor, unidadeId: u.id, acoes: [m.ACAO.VER] })),
  ]);
  const sessoes = m.criarAdaptadorDeSessao({ concessoes, relogio });
  const sessaoDemo = (perfil) => (perfil === "ausente" || !perfil ? null : {
    user: { id: perfil === "sem-acesso" ? USUARIOS.leitor : USUARIOS.gestor, ativo: true },
    tenant: { organizacaoId: ORG, unidadeId: null },
    acesso: { sessionId: `demo-${perfil}`, expiraEm: "2099-01-01T00:00:00.000Z", impersonando: false },
  });
  const ref = (id) => `ref-${createHash("sha256").update(sal + id).digest("hex").slice(0, 10)}`;
  /** Identificadores internos → referências opacas; documentos → registrados, não acessíveis nesta versão. */
  const sanitizar = (v) => JSON.parse(JSON.stringify(v, (k, x) => {
    if (k === "documentoIds" && Array.isArray(x)) return x.map((id) => ({ referencia: ref(id), situacao: "REGISTRADO_NAO_ACESSIVEL" }));
    return typeof x === "string" ? x.replace(UUID, (u) => ref(u)) : x;
  }));

  const CODIGOS = new Set(["FATURAMENTO_BRUTO_PROPRIO", "FATURAMENTO_LIQUIDO_GERENCIAL", "DEDUCOES_COMERCIAIS", "RECEITA_LIQUIDA_COMERCIAL", "CUSTOS_OPERACIONAIS", "RESULTADO_APOS_CUSTOS", "DESPESAS_OPERACIONAIS", "RESULTADO_FINANCEIRO", "DEMAIS_EFEITOS_GERENCIAIS", "RESULTADO_GERENCIAL"]);
  /** Tratador puro (testável): caminho + parâmetros + perfil de sessão → { status, corpo }. */
  async function responder(caminho, params, perfil) {
    try {
      const s = sessaoDemo(perfil);
      if (caminho === "/api/fv2/sessao") {
        const unidades = await sessoes.unidadesAutorizadas(s);
        return { status: 200, corpo: { unidades: unidades.map((u) => ({ id: u.unidadeId, nome: UNIDADES.find((x) => x.id === u.unidadeId)?.nome ?? "Unidade" })) } };
      }
      const unidadeId = UNIDADES.find((u) => u.id === params.unidade)?.id ?? params.unidade;
      const ctx = await sessoes.contextoPara(s, { unidadeId });
      const competencia = params.competencia;
      if (caminho === "/api/fv2/visao-geral") return { status: 200, corpo: sanitizar(await nucleo.apurarVisaoGeral(ctx, { competencia })) };
      if (caminho === "/api/fv2/dre") {
        const ap = await nucleo.apurarCompetencia(ctx, { competencia });
        return { status: 200, corpo: sanitizar({ competencia, impressao: ap.impressao, dre: ap.dre, cadaCem: ap.cadaCem, pendencias: ap.pendencias, faturamentoBruto: ap.indicadores.FATURAMENTO_BRUTO_PROPRIO, resultadoGerencial: ap.indicadores.RESULTADO_GERENCIAL, faturamentoLiquidoGerencial: ap.indicadores.FATURAMENTO_LIQUIDO_GERENCIAL }) };
      }
      if (caminho === "/api/fv2/composicao") {
        if (!CODIGOS.has(params.codigo)) return { status: 400, corpo: { erro: "INDICADOR_DESCONHECIDO", mensagem: "Indicador desconhecido." } };
        return { status: 200, corpo: sanitizar(await nucleo.composicaoDoIndicador(ctx, { competencia, codigo: params.codigo })) };
      }
      return { status: 404, corpo: { erro: "NAO_ENCONTRADO", mensagem: "Consulta inexistente." } };
    } catch (e) {
      const mapa = { [m.CODIGO.SESSAO_AUSENTE]: 401, [m.CODIGO.SESSAO_INVALIDA]: 401, [m.CODIGO.ESCOPO_NAO_AUTORIZADO]: 403, [m.CODIGO.PERMISSAO_INSUFICIENTE]: 403, [m.CODIGO.ENTRADA_INVALIDA]: 400 };
      if (e?.codigo && mapa[e.codigo]) return { status: mapa[e.codigo], corpo: { erro: e.codigo, mensagem: e.message } };
      return { status: 500, corpo: { erro: "FALHA_DA_CONSULTA", mensagem: "Não foi possível consultar agora." } };
    }
  }
  return { responder, unidades: UNIDADES };
}
