// CONSULTAS do Financeiro v2 expostas pela plataforma (Execução 10) — SOMENTE LEITURA nesta fase.
// Cada consulta recebe o núcleo, o contexto verificado e os parâmetros da URL; os contratos do núcleo validam os filtros
// (campo desconhecido, data e competência inválidas, tamanho de página). Escritas, documentos (arquivos), concessões,
// homologação e reabertura NÃO estão aqui: só entram quando as dependências (cofre com antimalware, MFA comprovado em
// login real, matriz aprovada) estiverem comprovadas.

import { centavos } from "./escritas.js"; // mesma leitura de "1.234,56" da ação de registro (a prévia e o registro não podem divergir)

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
  { tipoRelatorio: "SAIPOS_VENDAS", nome: "SAIPOS — Vendas por período (XLSX, por pedido: Presencial e Anota Aí)" },
  { tipoRelatorio: "SAIPOS_FORMAS_PAGAMENTO", nome: "SAIPOS — Formas de pagamento (XLSX)" },
  { tipoRelatorio: "SAIPOS_FATURAMENTO_POR_DIA", nome: "SAIPOS — Faturamento por dia (PDF)" },
  { tipoRelatorio: "SAIPOS_MOVIMENTOS_CAIXA", nome: "SAIPOS — Movimentações de Frente de Caixa (XLSX do Financeiro)" },
]);

/** Só para exibir: acrescenta o NOME do fornecedor às contas a pagar da composição (a apuração em si não muda). */
async function comFornecedores(n, c, resultado) {
  const nomes = new Map((await n.consultarRegistros(c, { tipo: "CONTRAPARTE" })).map((x) => [x.id, x.nome]));
  const ajustes = new Map((await n.consultarRegistros(c, { tipo: "AJUSTE" })).map((x) => [x.id, x]));
  const obrig = new Map((await n.consultarRegistros(c, { tipo: "OBRIGACAO" })).map((x) => [x.id, x]));
  // Ajuste de valor de uma conta a pagar entra na linha da própria conta (uma linha por pessoa); o total do grupo não muda.
  const fundirAjustes = (lista) => {
    const dono = new Map();
    for (const f of lista) for (const o of f.detalhe?.obrigacoes ?? []) dono.set(o.obrigacaoId, f);
    return lista.filter((f) => {
      if (f.origem?.tipo !== "AJUSTE") return true;
      const aj = ajustes.get(f.origem.id);
      const alvo = dono.get(aj?.alvoId);
      if (!alvo || typeof aj.valorCentavos !== "number") return true;
      alvo.valorCentavos += f.valorCentavos;
      if (typeof alvo.percentualDoBruto === "number" && typeof f.percentualDoBruto === "number") alvo.percentualDoBruto += f.percentualDoBruto;
      for (const o of alvo.detalhe.obrigacoes) if (o.obrigacaoId === aj.alvoId) o.valorReconhecidoCentavos += aj.valorCentavos;
      return false;
    });
  };
  const nomear = (no) => {
    if (Array.isArray(no)) { no.forEach(nomear); return; }
    if (!no || typeof no !== "object") return;
    if (Array.isArray(no.filhos)) no.filhos = fundirAjustes(no.filhos);
    if (no.origem?.tipo === "AJUSTE" && typeof no.nome === "string" && !no.nome.includes("·")) {
      const f = nomes.get(obrig.get(ajustes.get(no.origem.id)?.alvoId)?.contraparteId);
      if (f) no.nome = `${f} · ajuste de valor · ${no.nome}`;
    }
    for (const o of no.detalhe?.obrigacoes ?? []) {
      if (o.contraparteId && nomes.has(o.contraparteId)) o.fornecedor = nomes.get(o.contraparteId);
      const juros = [...ajustes.values()].filter((a) => a.alvoId === o.obrigacaoId && /^Juros\/multa/.test(a.motivo ?? "")).reduce((t, a) => t + (a.valorCentavos ?? 0), 0);
      if (juros) o.jurosCentavos = juros;
    }
    Object.values(no).forEach(nomear);
  };
  nomear(resultado);
  return resultado;
}
export const CONSULTAS = Object.freeze({
  "/visao-geral": async (n, c, p) => {
    const vg = await n.apurarVisaoGeral(c, competencia(p));
    const situacao = await n.consultarCompetencia(c, competencia(p));
    return { ...vg, financeiro: await n.consultarResumoFinanceiro(c, competencia(p)), fechamento: { estado: situacao.estado, revisoes: situacao.revisoes } };
  },
  "/dre": async (n, c, p) => {
    const ap = await n.apurarCompetencia(c, competencia(p));
    return { competencia: p.competencia, impressao: ap.impressao, versaoHomologada: ap.versaoHomologada, dre: await comFornecedores(n, c, structuredClone(ap.dre)), cadaCem: ap.cadaCem, pendencias: ap.pendencias,
      faturamentoBruto: ap.indicadores.FATURAMENTO_BRUTO_PROPRIO, resultadoGerencial: ap.indicadores.RESULTADO_GERENCIAL, faturamentoLiquidoGerencial: ap.indicadores.FATURAMENTO_LIQUIDO_GERENCIAL };
  },
  "/composicao": async (n, c, p) => {
    if (!INDICADORES.has(p.codigo)) throw Object.assign(new Error("Indicador desconhecido."), { codigoHttp: 400, codigo: "INDICADOR_DESCONHECIDO" });
    return comFornecedores(n, c, structuredClone(await n.composicaoDoIndicador(c, { ...competencia(p), codigo: p.codigo })));
  },
  "/contas-a-pagar": async (n, c, p) => {
    const r = await n.consultarContasAPagar(c, filtro(p, ["competencia", "vencimentoDe", "vencimentoAte", "contraparteId", "categoria", "situacao", ...PAGINA], PAGINA));
    const cats = (await n.consultarRegistros(c, { tipo: "CATEGORIA" })).filter((x) => x.aceitaLancamento && x.ativa !== false && x.natureza !== "RECEITA").map((x) => ({ codigo: x.codigo, nome: x.nome })).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
    const fornecedores = (await n.consultarRegistros(c, { tipo: "CONTRAPARTE" })).map((x) => ({ id: x.id, nome: x.nome })).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
    return { ...r, opcoesDeRegistro: { categorias: cats, fornecedores } };
  },
  "/conta-a-pagar": async (n, c, p) => ({
    ...(await n.detalharContaAPagar(c, { id: id(p) })),
    entregadorProprio: await n.resumoDoEntregadorDaConta(c, { obrigacaoId: id(p) }),
    contasParaPagar: (await n.consultarRegistros(c, { tipo: "CONTA" })).filter((x) => x.ativa).map((x) => ({ id: x.id, nome: x.nome, tipo: x.tipo })),
    vinculoExtrato: await n.previaDoVinculoDoExtrato(c, { obrigacaoId: id(p) }),
    fornecedores: (await n.consultarRegistros(c, { tipo: "CONTRAPARTE" })).map((x) => ({ id: x.id, nome: x.nome })).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR")),
  }),
  // Entregadores Próprios: painel único da área, prévia sem efeito, demonstrativo da semana e histórico do entregador.
  "/entregadores": (n, c, p) => n.consultarEntregadoresProprios(c, filtro(p, ["semana", "mes", "entregador", "situacao"])),
  "/entregadores/previa": (n, c, p) => n.previaDoFechamentoSemanal(c, { inicio: p.inicio }),
  "/entregadores/fechamento": (n, c, p) => n.detalharFechamentoDoEntregador(c, { inicio: p.inicio, entregador: p.entregador }),
  "/entregadores/pessoa": (n, c, p) => n.consultarEntregador(c, { entregador: p.entregador }),
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
  // Fase 02 (doc 40): operadoras e o líquido esperado (ESTIMATIVA) por modalidade × bandeira do período.
  // 18/11/2026: com período, traz também o painel (bruto, taxa estimada e líquido por operadora e modalidade).
  "/operadoras": async (n, c, p) => ({ ...(await n.consultarOperadoras(c)), ...(p.periodoInicio && p.periodoFim ? { painel: await n.consultarTaxasPorOperadora(c, { periodoInicio: p.periodoInicio, periodoFim: p.periodoFim }) } : {}) }),
  "/vendas/liquido-esperado": (n, c, p) => n.consultarLiquidoEsperado(c, { periodoInicio: p.periodoInicio, periodoFim: p.periodoFim, ...(p.canal ? { canal: p.canal } : {}), ...(p.modalidade ? { modalidade: p.modalidade } : {}), ...(p.chave ? { chave: p.chave } : {}) }),
  // Fases 04/05 (docs 42/43): área SAIPOS (resumo + cards de Presencial e Anota Aí) e fechamento manual com a comparação diária.
  "/saipos": async (n, c, p) => {
    const periodo = { periodoInicio: p.periodoInicio, periodoFim: p.periodoFim };
    return { ...(await n.consultarCanalSaipos(c, periodo)), cards: Object.fromEntries(await Promise.all(["BALCAO", "ANOTA_AI"].map(async (canal) => { const r = await n.consultarLiquidoEsperado(c, { ...periodo, canal }); return [canal, { modalidades: r.modalidades, total: r.total }]; }))) };
  },
  // Fase 07 (doc 44): iFood e 99Food só pela fonte oficial (demonstrativo iFood; 99Food aguarda o relatório real).
  "/canal-plataforma": (n, c, p) => n.consultarCanalPlataforma(c, { canal: p.canal, competencia: p.competencia }),
  // Fase 10 (doc 47): calendário de controle de faturamento — UMA consulta mensal consolidada por canal.
  "/calendario-faturamento": (n, c, p) => n.consultarCalendarioDeFaturamento(c, { canal: p.canal, mes: p.mes }),
  // Sangrias, reforços e transferências em dinheiro importados da SAIPOS (nunca faturamento): totais por dia e a lista que os compõe.
  "/movimentos-caixa": (n, c, p) => n.consultarMovimentosDeCaixa(c, { periodoInicio: p.periodoInicio, periodoFim: p.periodoFim }),
  // Prévia do lançamento das retiradas como despesas pagas em dinheiro (o que é NOVO × o que já foi lançado à mão ou pela importação).
  "/sangrias-despesa": (n, c, p) => n.previaSangriasComoDespesa(c, { periodoInicio: p.periodoInicio, periodoFim: p.periodoFim }),
  // Fase 11 (doc 48): importações por canal (formatos, estado de cada um e histórico) e a PRÉVIA do demonstrativo oficial do iFood.
  "/importacoes-canal": (n, c, p) => n.consultarImportacoesDoCanal(c, { canal: p.canal }),
  "/previa-relatorio-99food": (n, c, p) => n.previaDoRelatorio99Food(c, { importacaoId: p.importacao }),
  "/previa-conciliacao-ifood": (n, c, p) => n.previaDaConciliacaoIfood(c, { importacaoId: p.importacao }),
  "/movimentos-conciliacao-ifood": (n, c, p) => n.listarMovimentosDaConciliacaoIfood(c, { data: p.data }),
  "/previa-demonstrativo-ifood": (n, c, p) => n.previaDoDemonstrativoIfood(c, {
    periodoInicio: p.periodoInicio, periodoFim: p.periodoFim, vendasCentavos: centavos(p.vendas), comissoesCentavos: centavos(p.comissoes || "0,00"), taxaPagamentoCentavos: centavos(p.taxaPagamento || "0,00"),
    mensalidadeCentavos: centavos(p.mensalidade || "0,00"), servicosEPromocoesCentavos: centavos(p.servicosEPromocoes || "0,00"), ajustesCentavos: centavos(p.ajustes || "0,00"),
    liquidoInformadoCentavos: centavos(p.liquido), origem: p.origem, justificativa: p.justificativa || "Prévia: justificativa informada na confirmação.",
  }),
  "/fechamento-manual": async (n, c, p) => ({ ...(await n.consultarFechamentoManual(c, { periodoInicio: p.periodoInicio, periodoFim: p.periodoFim })), operadoras: (await n.consultarOperadoras(c)).operadoras.map((o) => ({ codigo: o.codigo, nome: o.nome, processador: o.processador, modalidades: o.modalidades, situacao: o.situacao ?? "ATIVA" })) }),
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
  "/vinculo-extrato": async (n, c, p) => {
    const r = await n.previaDoVinculoDoExtrato(c, { obrigacaoId: uuidOu(p.obrigacao), ...(p.movimentacao ? { movimentacaoId: uuidOu(p.movimentacao) } : {}) });
    if (!r?.escolhida) return r;
    // Documentos que podem comprovar a baixa: o extrato de onde a saída veio vem primeiro (a tela não os listava e a baixa ficava sem como confirmar).
    let docs = [];
    try { docs = (await n.consultarDocumentos(c, { situacao: "VIGENTE", tamanho: 100 })).itens ?? []; } catch { docs = []; }
    const da = new Set(r.escolhida.evidencia?.documentosDaSaida ?? []);
    const lista = docs.map((d) => ({ id: d.id, tipo: d.tipo, descricao: d.descricao ?? "" })).sort((a, b) => Number(da.has(b.id)) - Number(da.has(a.id)));
    return { ...r, escolhida: { ...r.escolhida, documentosDisponiveis: lista } };
  },
});

/** Pessoas com concessão ATIVA nesta unidade (para escolher responsável/conceder), com o nome da plataforma. */
export async function pessoasDaUnidade(n, c, nomeDe) {
  const { itens } = await n.consultarPermissoes(c);
  const ativas = itens.filter((i) => i.situacao === "ATIVA");
  const nomes = await nomeDe(ativas.map((i) => i.usuarioId));
  return { pessoas: ativas.map((i) => ({ perfil: i.usuarioId, nome: nomes.get(i.usuarioId) ?? "Pessoa sem nome cadastrado" })) };
}
