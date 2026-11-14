// CONSULTAS do Financeiro v2 expostas pela plataforma (Execução 10) — SOMENTE LEITURA nesta fase.
// Cada consulta recebe o núcleo, o contexto verificado e os parâmetros da URL; os contratos do núcleo validam os filtros
// (campo desconhecido, data e competência inválidas, tamanho de página). Escritas, documentos (arquivos), concessões,
// homologação e reabertura NÃO estão aqui: só entram quando as dependências (cofre com antimalware, MFA comprovado em
// login real, matriz aprovada) estiverem comprovadas.

const INDICADORES = new Set(["FATURAMENTO_BRUTO_PROPRIO", "FATURAMENTO_LIQUIDO_GERENCIAL", "DEDUCOES_COMERCIAIS", "RECEITA_LIQUIDA_COMERCIAL", "CUSTOS_OPERACIONAIS", "RESULTADO_APOS_CUSTOS", "DESPESAS_OPERACIONAIS", "RESULTADO_FINANCEIRO", "DEMAIS_EFEITOS_GERENCIAIS", "RESULTADO_GERENCIAL"]);
const NUMERO = /^\d{1,9}$/;
const NENHUM = "00000000-0000-4000-8000-000000000000";

/** Parâmetros de texto → filtro do núcleo: só os campos permitidos, vazios fora, números convertidos. */
export function filtro(params, campos, numeros = []) {
  return Object.fromEntries(campos.filter((k) => typeof params[k] === "string" && params[k] !== "").map((k) => [k, numeros.includes(k) && NUMERO.test(params[k]) ? Number(params[k]) : params[k]]));
}
const PAGINA = ["pagina", "tamanho"];
const VENDAS = ["competencia", "inicio", "fim", "canal", "forma", "processador", "situacao", "valorMinimoCentavos", "valorMaximoCentavos", "identificador", "pagina", "tamanho"];
const VENDAS_N = ["pagina", "tamanho", "valorMinimoCentavos", "valorMaximoCentavos"];
const id = (p) => (typeof p.id === "string" && p.id ? p.id : NENHUM);
const competencia = (p) => ({ competencia: typeof p.competencia === "string" ? p.competencia : "" });

/** caminho → (núcleo, contexto, parâmetros) → resultado */
export const CONSULTAS = Object.freeze({
  "/visao-geral": async (n, c, p) => {
    const vg = await n.apurarVisaoGeral(c, competencia(p));
    const situacao = await n.consultarCompetencia(c, competencia(p));
    return { ...vg, financeiro: await n.consultarResumoFinanceiro(c, competencia(p)), fechamento: { estado: situacao.estado, revisoes: situacao.revisoes } };
  },
  "/dre": async (n, c, p) => {
    const ap = await n.apurarCompetencia(c, competencia(p));
    return { competencia: p.competencia, impressao: ap.impressao, versaoHomologada: ap.versaoHomologada, dre: ap.dre, cadaCem: ap.cadaCem, pendencias: ap.pendencias,
      faturamentoBruto: ap.indicadores.FATURAMENTO_BRUTO_PROPRIO, resultadoGerencial: ap.indicadores.RESULTADO_GERENCIAL, faturamentoLiquidoGerencial: ap.indicadores.FATURAMENTO_LIQUIDO_GERENCIAL };
  },
  "/composicao": (n, c, p) => {
    if (!INDICADORES.has(p.codigo)) throw Object.assign(new Error("Indicador desconhecido."), { codigoHttp: 400, codigo: "INDICADOR_DESCONHECIDO" });
    return n.composicaoDoIndicador(c, { ...competencia(p), codigo: p.codigo });
  },
  "/contas-a-pagar": (n, c, p) => n.consultarContasAPagar(c, filtro(p, ["competencia", "vencimentoDe", "vencimentoAte", "contraparteId", "categoria", "situacao", ...PAGINA], PAGINA)),
  "/conta-a-pagar": (n, c, p) => n.detalharContaAPagar(c, { id: id(p) }),
  "/contas-a-receber": (n, c, p) => n.consultarContasAReceber(c, filtro(p, ["competencia", "previstoDe", "previstoAte", "processador", "canal", "tipo", "situacao", ...PAGINA], PAGINA)),
  "/posicao-a-receber": (n, c, p) => n.consultarPosicaoAReceber(c, filtro(p, ["competencia", ...PAGINA], PAGINA)),
  "/conta-a-receber": (n, c, p) => n.detalharContaAReceber(c, { id: id(p) }),
  "/caixa-e-bancos": (n, c, p) => n.consultarCaixaEBancos(c, filtro(p, ["inicio", "fim", "contaId", ...PAGINA], PAGINA)),
  "/fluxo-de-caixa": (n, c, p) => n.consultarFluxoDeCaixa(c, filtro(p, ["inicio", "fim", "granularidade"])),
  "/calendario": (n, c, p) => n.consultarCalendarioFinanceiro(c, filtro(p, ["mes"])),
  "/vendas": (n, c, p) => n.consultarVendas(c, filtro(p, VENDAS, VENDAS_N)),
  "/vendas/pagamentos": (n, c, p) => n.consultarPagamentosDeVendas(c, filtro(p, VENDAS, VENDAS_N)),
  "/vendas/taxas": (n, c, p) => n.consultarTaxasEDescontos(c, filtro(p, [...VENDAS, "tipoComponente"], VENDAS_N)),
  "/vendas/recebiveis": (n, c, p) => n.consultarRecebiveisERepasses(c, filtro(p, [...VENDAS, "recebimento"], VENDAS_N)),
  "/vendas/divergencias": (n, c, p) => n.consultarDivergenciasDeVendas(c, filtro(p, [...VENDAS, "codigo"], VENDAS_N)),
  "/venda": (n, c, p) => n.detalharVenda(c, { id: id(p) }),
  "/recebimento": (n, c, p) => n.detalharRecebimento(c, { id: id(p) }),
  "/conferencias": (n, c, p) => n.consultarCentralDeConferencias(c, filtro(p, ["competencia"])),
  "/conferencias/documentos": (n, c, p) => n.consultarDocumentosImportados(c, filtro(p, ["competencia", "fonte", "estado", ...PAGINA], PAGINA)),
  "/conferencias/propostas": (n, c, p) => n.consultarPropostasParaRevisao(c, filtro(p, ["competencia", "estado", "operacao", ...PAGINA], PAGINA)),
  "/conferencias/correspondencias": (n, c, p) => n.consultarCorrespondencias(c, filtro(p, ["competencia", "situacao", "relacao", ...PAGINA], PAGINA)),
  "/conferencias/pendencias": (n, c, p) => n.consultarPendencias(c, filtro(p, ["competencia", "grupo", "situacao", ...PAGINA], PAGINA)),
  "/fechamento": (n, c, p) => n.consultarFechamento(c, filtro(p, ["competencia"])),
  "/configuracoes": (n, c) => n.consultarConfiguracoes(c),
  "/permissoes": (n, c) => n.consultarPermissoes(c),
});
