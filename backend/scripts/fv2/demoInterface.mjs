// AMBIENTE DEMONSTRATIVO LOCAL da interface do Financeiro v2 (Execuções 05 e 06A).
//
// - Dados 100% SINTÉTICOS em memória (nenhum banco, nenhum .env, nenhuma rede além de 127.0.0.1).
// - Sessão SIMULADA pelo seletor do próprio ambiente (cabeçalho x-fv2-demo-sessao), mas passando pelo adaptador de sessão
//   e pelas concessões financeiro_v2.* reais do módulo: organização vem da sessão, unidade é validada, ação VER exigida.
// - Consome SOMENTE as consultas aprovadas do motor (apuração, composição e, desde a 06A, tesouraria: contas a pagar/receber,
//   caixa e bancos, calendário, fluxo de caixa e resumo financeiro). SOMENTE LEITURA: as escritas da tesouraria (saldo
//   informado, abertura/operação/fechamento de caixa) existem no núcleo, mas NÃO são expostas aqui — a sessão desta
//   demonstração é simulada, então uma escrita "funcionando" seria sucesso simulado (ver doc 11).
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
  const banco = await nucleo.configurarContaFinanceira(A, { tipo: "BANCARIA", nome: "Unicred (demonstração)", instituicao: "Conta sintética" });
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
  await tesouraria(nucleo, A, { caixa, banco, ifoodRecebivel: ifood.recebiveis[0] });
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
  const reverso = new Map();
  const refDe = (id) => { const r = ref(id); reverso.set(r, id); return r; };
  const sanitizarComRef = (v) => JSON.parse(JSON.stringify(v, (k, x) => {
    if (k === "documentoIds" && Array.isArray(x)) return x.map((id) => ({ referencia: refDe(id), situacao: "REGISTRADO_NAO_ACESSIVEL" }));
    return typeof x === "string" ? x.replace(UUID, (u) => refDe(u)) : x;
  }));
  /** Parâmetros de texto da URL → filtro do núcleo: vazios saem; referências opacas voltam a ser ids; números viram inteiros. */
  const filtro = (params, campos, numeros = []) => Object.fromEntries(campos.filter((k) => params[k] !== undefined && params[k] !== "").map((k) => {
    const v = params[k];
    if (numeros.includes(k)) return [k, /^\d{1,6}$/.test(v) ? Number(v) : v];
    return [k, v.startsWith("ref-") ? reverso.get(v) ?? v : v];
  }));
  const NENHUM = "00000000-0000-4000-8000-000000000000";
  const TESOURARIA = {
    "/api/fv2/contas-a-pagar": (ctx, p) => nucleo.consultarContasAPagar(ctx, filtro(p, ["competencia", "vencimentoDe", "vencimentoAte", "contraparteId", "categoria", "situacao", "pagina", "tamanho"], ["pagina", "tamanho"])),
    "/api/fv2/contas-a-receber": (ctx, p) => nucleo.consultarContasAReceber(ctx, filtro(p, ["competencia", "previstoDe", "previstoAte", "processador", "canal", "tipo", "situacao", "pagina", "tamanho"], ["pagina", "tamanho"])),
    "/api/fv2/caixa-e-bancos": (ctx, p) => nucleo.consultarCaixaEBancos(ctx, filtro(p, ["inicio", "fim", "contaId", "pagina", "tamanho"], ["pagina", "tamanho"])),
    "/api/fv2/fluxo-de-caixa": (ctx, p) => nucleo.consultarFluxoDeCaixa(ctx, filtro(p, ["inicio", "fim", "granularidade"])),
    "/api/fv2/calendario": (ctx, p) => nucleo.consultarCalendarioFinanceiro(ctx, filtro(p, ["mes"])),
    "/api/fv2/conta-a-pagar": (ctx, p) => nucleo.detalharContaAPagar(ctx, { id: reverso.get(p.id) ?? NENHUM }),
    "/api/fv2/conta-a-receber": (ctx, p) => nucleo.detalharContaAReceber(ctx, { id: reverso.get(p.id) ?? NENHUM }),
  };
  /** Tratador puro (testável): caminho + parâmetros + perfil de sessão → { status, corpo }. */
  async function responder(caminho, params, perfil) {
    try {
      const s = sessaoDemo(perfil);
      if (caminho === "/api/fv2/sessao") {
        const unidades = await sessoes.unidadesAutorizadas(s);
        return { status: 200, corpo: { dataBase: m.tempo.hojeEm(relogio()), unidades: unidades.map((u) => ({ id: u.unidadeId, nome: UNIDADES.find((x) => x.id === u.unidadeId)?.nome ?? "Unidade" })) } };
      }
      const unidadeId = UNIDADES.find((u) => u.id === params.unidade)?.id ?? params.unidade;
      const ctx = await sessoes.contextoPara(s, { unidadeId });
      const competencia = params.competencia;
      if (caminho === "/api/fv2/visao-geral") {
        const vg = await nucleo.apurarVisaoGeral(ctx, { competencia });
        return { status: 200, corpo: sanitizar({ ...vg, financeiro: await nucleo.consultarResumoFinanceiro(ctx, { competencia }) }) };
      }
      if (TESOURARIA[caminho]) return { status: 200, corpo: sanitizarComRef(await TESOURARIA[caminho](ctx, params)) };
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
      const mapa = { [m.CODIGO.SESSAO_AUSENTE]: 401, [m.CODIGO.SESSAO_INVALIDA]: 401, [m.CODIGO.ESCOPO_NAO_AUTORIZADO]: 403, [m.CODIGO.PERMISSAO_INSUFICIENTE]: 403, [m.CODIGO.ENTRADA_INVALIDA]: 400, [m.CODIGO.DATA_INVALIDA]: 400, [m.CODIGO.NAO_ENCONTRADO]: 404 };
      if (e?.codigo && mapa[e.codigo]) return { status: mapa[e.codigo], corpo: { erro: e.codigo, mensagem: e.message } };
      return { status: 500, corpo: { erro: "FALHA_DA_CONSULTA", mensagem: "Não foi possível consultar agora." } };
    }
  }
  return { responder, unidades: UNIDADES };
}

/**
 * Tesouraria sintética (Execução 06A), sobre o mesmo cenário. Data-base da demonstração: 12/11/2026.
 *   - Unicred e Caixa com saldo INFORMADO em 01/09 (âncoras); depósito do caixa no banco como transferência interna;
 *   - aluguel recorrente (setembro e outubro pagos, novembro VENCIDO em aberto → dezembro só como previsão estimada);
 *   - freezer parcelado em 3x (patrimonial), energia a vencer, frutas pagas em parte; insumos e embalagens vencidos;
 *   - repasse iFood recebido no banco; Stone recebido em parte (sem previsão para o resto); Anota AI sem previsão;
 *   - vale-refeição com demonstrativo e data prevista documentada; um Pix recebido sem vínculo;
 *   - caixa físico: sessão de 10/11 fechada com diferença justificada e sessão de 11/11 aberta (suprimento e sangria).
 */
async function tesouraria(nucleo, A, { caixa, banco, ifoodRecebivel }) {
  const doc = async (n, tipo, descricao) => (await nucleo.registrarDocumento(A, { origem: "MANUAL", arquivoId: `demo-${n}`, hashSha256: createHash("sha256").update(`demo-${n}`).digest("hex"), tipo, recebidoEm: "2026-09-01", descricao })).documento.id;
  const extrato = await doc("e", "EXTRATO_BANCARIO", "Extrato de abertura (demonstração)");
  await nucleo.registrarSaldoDeConta(A, { contaId: banco.id, data: "2026-09-01", valorCentavos: 1845000, documentoId: extrato, observacao: "Saldo do extrato de abertura." });
  await nucleo.registrarSaldoDeConta(A, { contaId: caixa.id, data: "2026-09-01", valorCentavos: 50000, observacao: "Contagem de abertura." });
  await nucleo.registrarTransferencia(A, { contaOrigemId: caixa.id, contaDestinoId: banco.id, valorCentavos: 437350, dataEfetiva: "2026-09-10", descricao: "Depósito do caixa no banco" });
  const pagar = async (obrigacaoId, valor, data, descricao) => {
    const mv = await nucleo.registrarMovimentacao(A, { contaId: banco.id, dataEfetiva: data, sentido: "SAIDA", valorCentavos: valor, natureza: "PAGAMENTO", descricao });
    await nucleo.registrarLiquidacao(A, { movimentacaoId: mv.movimentacao.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: obrigacaoId, valorCentavos: valor }] });
  };
  const receber = async (recebivelId, valor, data, descricao) => {
    const mv = await nucleo.registrarMovimentacao(A, { contaId: banco.id, dataEfetiva: data, sentido: "ENTRADA", valorCentavos: valor, natureza: "RECEBIMENTO", descricao });
    await nucleo.registrarLiquidacao(A, { movimentacaoId: mv.movimentacao.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: recebivelId, valorCentavos: valor }] });
  };
  const imobiliaria = await nucleo.registrarContraparte(A, { tipo: "FORNECEDOR", nome: "Imobiliária (demonstração)" });
  const energia = await nucleo.registrarContraparte(A, { tipo: "FORNECEDOR", nome: "Energia (demonstração)" });
  const equipamentos = await nucleo.registrarContraparte(A, { tipo: "FORNECEDOR", nome: "Equipamentos (demonstração)" });
  const boleto = await doc("b", "BOLETO", "Boleto do aluguel (demonstração)");
  const aluguel = async (mes, id) => (await nucleo.registrarObrigacao(A, { contraparteId: imobiliaria.id, valorOriginalCentavos: 280000, categoria: "DESPESAS_ADMINISTRATIVAS_GERAIS", descricao: "Aluguel da loja", competencia: mes, dataEmissao: `${mes}-01`, vencimento: `${mes}-10`, recorrencia: { periodicidade: "MENSAL", diaDoMes: 10 }, documentoIds: [boleto], fonte: { sistema: "MANUAL", idExterno: id } })).obrigacoes[0];
  await pagar((await aluguel("2026-09", "DEMO-AL-09")).id, 280000, "2026-09-10", "PAG BOLETO 0001 SINT");
  await pagar((await aluguel("2026-10", "DEMO-AL-10")).id, 280000, "2026-10-09", "PAG BOLETO 0002 SINT");
  await aluguel("2026-11", "DEMO-AL-11");
  const nota = await doc("n", "NOTA_FISCAL", "Nota do freezer (demonstração)");
  const eq = await nucleo.registrarObrigacao(A, { contraparteId: equipamentos.id, valorOriginalCentavos: 360000, parcelas: 3, categoria: "IMOBILIZADO", descricao: "Freezer", competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-15", documentoIds: [nota] });
  await pagar(eq.obrigacoes[0].id, 120000, "2026-10-15", "PAG PARC 1/3 SINT");
  await nucleo.registrarObrigacao(A, { contraparteId: energia.id, valorOriginalCentavos: 61850, categoria: "DESPESAS_ADMINISTRATIVAS_GERAIS", descricao: "Conta de energia", competencia: "2026-10", dataEmissao: "2026-11-01", vencimento: "2026-11-20" });
  const frutas = (await nucleo.consultarContasAPagar(A, { categoria: "FRUTAS" })).itens[0];
  await pagar(frutas.id, 200000, "2026-09-18", "PAG FORNEC FRUTAS SINT");
  // Recebimentos (o recebível iFood já tem as taxas abatidas como ajustes; recebe-se o saldo).
  const ifoodAtual = (await nucleo.consultarContasAReceber(A, { processador: "IFOOD" })).itens.find((t) => t.id === ifoodRecebivel.id);
  await receber(ifoodRecebivel.id, ifoodAtual.saldoCentavos, "2026-10-08", "CRED REPASSE IFOOD SINT");
  const stone = (await nucleo.consultarContasAReceber(A, { processador: "STONE" })).itens[0];
  await receber(stone.id, 150000, "2026-10-02", "CRED STONE SINT");
  const vr = await doc("v", "DEMONSTRATIVO_REPASSE", "Demonstrativo do vale-refeição (demonstração)");
  await nucleo.registrarRecebivel(A, { processador: "OPERADORA_BENEFICIOS", brutoCentavos: 48000, retencoes: [{ categoria: "TAXAS_DE_PROCESSAMENTO", valorCentavos: 2880 }], dataPrevista: "2026-11-28", competencia: "2026-10", descricao: "Vale-refeição de outubro", documentoIds: [vr] });
  await nucleo.registrarMovimentacao(A, { contaId: banco.id, dataEfetiva: "2026-11-05", sentido: "ENTRADA", valorCentavos: 12000, natureza: "OUTRA", descricao: "PIX RECEBIDO 99887 SINT" });
  // Caixa físico: abertura de 10/11 confere com o saldo calculado da conta (R$ 250,00).
  const s1 = (await nucleo.abrirCaixa(A, { contaId: caixa.id, dataAbertura: "2026-11-10", saldoContadoCentavos: 25000 })).sessao;
  await nucleo.registrarVenda(A, { canal: "BALCAO", dataVenda: "2026-11-10", brutoCentavos: 6000, fonte: { sistema: "MANUAL", idExterno: "DEMO-D1" }, composicao: { itensCentavos: 6000 }, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 6000, contaId: caixa.id }] });
  await nucleo.registrarOperacaoDeCaixa(A, { sessaoId: s1.id, operacao: "SAIDA", valorCentavos: 1500, data: "2026-11-10", descricao: "Compra de gelo" });
  await nucleo.fecharCaixa(A, { sessaoId: s1.id, dataFechamento: "2026-11-10", contadoCentavos: 29000, justificativa: "Troco dado a mais (demonstração).", confirmar: true });
  const s2 = (await nucleo.abrirCaixa(A, { contaId: caixa.id, dataAbertura: "2026-11-11", saldoContadoCentavos: 29000 })).sessao;
  await nucleo.registrarOperacaoDeCaixa(A, { sessaoId: s2.id, operacao: "SUPRIMENTO", valorCentavos: 10000, data: "2026-11-11", descricao: "Troco", contraContaId: banco.id });
  await nucleo.registrarOperacaoDeCaixa(A, { sessaoId: s2.id, operacao: "SANGRIA", valorCentavos: 20000, data: "2026-11-12", descricao: "Depósito no banco", contraContaId: banco.id });
}
