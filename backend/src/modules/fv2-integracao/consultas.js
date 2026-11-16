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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOu = (v) => (typeof v === "string" && UUID.test(v) ? v.toLowerCase() : NENHUM);
const id = (p) => uuidOu(p.id);
const competencia = (p) => ({ competencia: typeof p.competencia === "string" ? p.competencia : "" });

/** caminho → (núcleo, contexto, parâmetros) → resultado */
/** doc 37: relatórios aceitos na importação pela plataforma (rótulo para a tela). */
const RELATORIOS_DA_PLATAFORMA = Object.freeze([
  { tipoRelatorio: "SAIPOS_DESEMPENHO_POR_ATENDENTE", nome: "SAIPOS — Canais de venda (desempenho por atendente, XLSX)" },
  { tipoRelatorio: "UNICRED_EXTRATO", nome: "Unicred — Extrato (PDF)" },
  { tipoRelatorio: "STONE_VENDAS", nome: "Stone — Vendas (XLSX)" },
  { tipoRelatorio: "SAIPOS_FORMAS_PAGAMENTO", nome: "SAIPOS — Formas de pagamento (XLSX)" },
  { tipoRelatorio: "SAIPOS_FATURAMENTO_POR_DIA", nome: "SAIPOS — Faturamento por dia (PDF)" },
]);

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
  "/contas-a-pagar": async (n, c, p) => {
    const r = await n.consultarContasAPagar(c, filtro(p, ["competencia", "vencimentoDe", "vencimentoAte", "contraparteId", "categoria", "situacao", ...PAGINA], PAGINA));
    const cats = (await n.consultarRegistros(c, { tipo: "CATEGORIA" })).filter((x) => x.aceitaLancamento && x.ativa !== false && x.natureza !== "RECEITA").map((x) => ({ codigo: x.codigo, nome: x.nome })).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
    const fornecedores = (await n.consultarRegistros(c, { tipo: "CONTRAPARTE" })).map((x) => ({ id: x.id, nome: x.nome })).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
    return { ...r, opcoesDeRegistro: { categorias: cats, fornecedores } };
  },
  "/conta-a-pagar": async (n, c, p) => ({
    ...(await n.detalharContaAPagar(c, { id: id(p) })),
    contasParaPagar: (await n.consultarRegistros(c, { tipo: "CONTA" })).filter((x) => x.ativa).map((x) => ({ id: x.id, nome: x.nome })),
    vinculoExtrato: await n.previaDoVinculoDoExtrato(c, { obrigacaoId: id(p) }),
    fornecedores: (await n.consultarRegistros(c, { tipo: "CONTRAPARTE" })).map((x) => ({ id: x.id, nome: x.nome })).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR")),
  }),
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
  // Abertura + o necessário do roteiro (contas, plano): uma consulta por tela, como as demais.
  // doc 35: taxas contratadas × cobradas (Stone), por modalidade e bandeira, transação a transação.
  "/taxas-contratadas": (n, c, p) => n.consultarTaxasContratadas(c, { competencia: p.competencia, ...(p.processador ? { processador: p.processador } : {}) }),
  "/abertura": async (n, c) => ({ ...(await n.consultarAbertura(c)), configuracoes: await n.consultarConfiguracoes(c) }),
  "/configuracoes/plano": (n, c) => n.consultarPlanoDeContas(c),
  "/configuracoes/categoria": (n, c, p) => n.consultarCategoria(c, { codigo: String(p.codigo ?? "") }),
  "/permissoes": (n, c) => n.consultarPermissoes(c),
  // Detalhes usados pelos painéis (somente leitura; ids são UUIDs conferidos no escopo pelo núcleo/RLS)
  "/conferencias/documento": (n, c, p) => n.detalharImportacao(c, { id: id(p) }),
  "/conferencias/proposta": (n, c, p) => n.detalharProposta(c, { id: id(p) }),
  "/conferencias/correspondencia": (n, c, p) => n.detalharCorrespondencia(c, { id: id(p) }),
  "/conferencias/pendencia": async (n, c, p) => {
    const d = await n.detalharPendencia(c, { competencia: p.competencia, chave: String(p.chave ?? "").slice(0, 400) });
    const f = await n.consultarFechamento(c, { competencia: d.pendencia.competencia ?? p.competencia });
    const a = f.avaliacaoDasPendencias;
    const item = [...a.ressalvas, ...a.bloqueantes, ...a.naoDocumentadas, ...a.semEvidencia].find((x) => x.chave === p.chave) ?? null;
    return { ...d, fechamentoDaPendencia: { estado: f.estado, competencia: f.competencia, item, documentavel: ["FECHAMENTO_PRELIMINAR", "FECHAMENTO_COM_PENDENCIAS"].includes(f.estado) && d.pendencia.efeitoNoFechamento === "EXIGE_DOCUMENTACAO" && d.pendencia.situacao !== "INFORMATIVA" } };
  },
  "/conferencias/fechamento": async (n, c, p) => {
    const f = await n.consultarFechamento(c, filtro(p, ["competencia"]));
    const destinos = { ABERTA: ["FECHAMENTO_PRELIMINAR"], FECHAMENTO_PRELIMINAR: ["FECHAMENTO_COM_PENDENCIAS", "FECHAMENTO_HOMOLOGADO", "ABERTA"], FECHAMENTO_COM_PENDENCIAS: ["FECHAMENTO_HOMOLOGADO", "FECHAMENTO_PRELIMINAR", "ABERTA"], FECHAMENTO_HOMOLOGADO: ["ABERTA"] }[f.estado] ?? [];
    const acoes = [];
    for (const novoEstado of destinos) acoes.push(await n.previaDaMudancaDeEstado(c, { competencia: f.competencia, novoEstado }));
    return { ...f, acoes, versoes: (await n.consultarVersoesDeFechamento(c, { competencia: f.competencia })).versoes };
  },
  // doc 37: na plataforma o envio é REAL e sem guarda do arquivo (lido, conferido e descartado).
  "/conferencias/catalogo": () => ({ arquivos: [], envioReal: true, relatorios: RELATORIOS_DA_PLATAFORMA,
    observacao: "O arquivo é lido e descartado: ficam só a impressão digital (SHA-256) e as linhas extraídas. Revise a prévia e confirme em até 30 minutos; depois disso, envie o mesmo arquivo de novo (é a mesma importação)." }),
  "/documentos": (n, c, p) => n.consultarDocumentos(c, filtro(p, ["competencia", "situacao", ...PAGINA], PAGINA)),
  "/documento": (n, c, p) => n.detalharDocumento(c, { id: id(p) }),
  "/reclassificacao": (n, c, p) => n.consultarReclassificacao(c, p.movimentacao ? { movimentacaoId: uuidOu(p.movimentacao) } : { lancamentoId: id(p), ...(p.categoria ? { categoria: String(p.categoria) } : {}) }),
  "/vinculo-extrato": (n, c, p) => n.previaDoVinculoDoExtrato(c, { obrigacaoId: uuidOu(p.obrigacao), ...(p.movimentacao ? { movimentacaoId: uuidOu(p.movimentacao) } : {}) }),
});

/** Pessoas com concessão ATIVA nesta unidade (para escolher responsável/conceder), com o nome da plataforma. */
export async function pessoasDaUnidade(n, c, nomeDe) {
  const { itens } = await n.consultarPermissoes(c);
  const ativas = itens.filter((i) => i.situacao === "ATIVA");
  const nomes = await nomeDe(ativas.map((i) => i.usuarioId));
  return { pessoas: ativas.map((i) => ({ perfil: i.usuarioId, nome: nomes.get(i.usuarioId) ?? "Pessoa sem nome cadastrado" })) };
}
