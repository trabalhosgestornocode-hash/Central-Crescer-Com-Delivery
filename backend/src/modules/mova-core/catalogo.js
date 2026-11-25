// MOVA CORE — F1: CATÁLOGO CENTRAL DE FERRAMENTAS (somente LEITURA + preparação de intenção sem execução).
// Cada ferramenta declara: esquema estrito (o que o modelo pode pedir), operação(ões) do núcleo do Financeiro v2 que a atendem
// (sempre via porta.ler → b.consultar: nenhuma escrita), se expõe VALORES (só perfis com consultas "TODAS" e em conversa
// que permite valores), e como transformar o resultado em (a) dados compactos para o modelo e (b) FATOS tipados para o
// verificador de fidelidade (valor × entidade × período × unidade × significado financeiro).
// O escopo (organização, unidade, usuário) NUNCA vem do modelo: é injetado pelo executor a partir da conversa autorizada.
// Nada aqui inventa capacidade: ferramenta sem fonte no núcleo não existe no catálogo; o que não existe é dito como indisponível.
import { COMPETENCIA, DATA, REFERENCIA, TEXTO_CURTO } from "./esquema.js";
import { resolverEntidade } from "./resolucao.js";
import { bate, itemAPagar, todasAsPaginas, lerUmaVez, formatarListaDeContas, dataBr, SEM_FORNECEDOR } from "./leituras.js";
export { bate, itemAPagar, todasAsPaginas };
import { FERRAMENTA_ANALISAR } from "./analise.js"; // F2 (import circular seguro: analise só usa os auxiliares daqui em tempo de chamada)

const UNIDADE = { ...REFERENCIA, description: "SÓ para OUTRA unidade: a referência exata (ex.: ref_2) devolvida por listar_unidades. Para a unidade desta conversa, OMITA este campo. Nunca invente referência." };
const norm = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
/** Mais de um registro DIFERENTE (fornecedor/entregador) combina igualmente com o nome pedido? Então a ferramenta avisa. */
function ambiguidadeDeNome(termo, nomes) {
  const distintos = [...new Set(nomes.filter(Boolean))].map((nome) => ({ nome }));
  if (distintos.length < 2) return null;
  const r = resolverEntidade(termo, distintos);
  return r.estado === "AMBIGUO" ? { termo, candidatos: r.candidatos.map((c) => c.nome).slice(0, 6), orientacao: "o termo combina com mais de um cadastro: pergunte qual (ou use o que a pessoa já esclareceu); não some os dois como se fossem um" } : null;
}
const mesDe = (d) => String(d ?? "").slice(0, 7);
const rotulo = (o) => o?.nome ?? o?.fornecedor?.nome ?? o?.contraparte?.nome ?? o?.entregador?.nome ?? o?.entregadorNome ?? o?.descricao ?? o?.titulo ?? o?.canal ?? o?.codigo ?? null;

// ------------------------------------------------------------------------------------------------ fatos para o verificador
/** Fato = um valor que a resposta pode citar, com o que ele SIGNIFICA. */
const semAcento = (x) => String(x ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** A linha pedida ("cmv", "resultado") está na apuração? Compara pelo código e pelo nome oficiais, sem acento. */
const linhaPedidaPresente = (pedido, linhas) => { const q = semAcento(pedido); return q.length > 0 && linhas.some((l) => semAcento(l.codigo).includes(q) || semAcento(l.nome).includes(q)); };
const fato = (valorCentavos, significado, { entidade = null, periodo = null } = {}) => (Number.isInteger(valorCentavos) ? { valorCentavos, significado, entidade, periodo } : null);
const fatos = (...xs) => xs.flat().filter(Boolean);



// ------------------------------------------------------------------------------------- contas a pagar (uma leitura)
const SITUACOES_A_PAGAR = ["TODAS_EM_ABERTO", "VENCIDO", "VENCE_HOJE", "A_VENCER", "EM_ABERTO", "PARCIALMENTE_PAGO", "PAGO", "AGUARDANDO_CLASSIFICACAO_OU_EVIDENCIA", "TODAS"];
const TITULO_DA_SITUACAO = Object.freeze({ TODAS_EM_ABERTO: "Contas a pagar em aberto", VENCIDO: "Contas vencidas", VENCE_HOJE: "Contas que vencem hoje", A_VENCER: "Contas a vencer",
  EM_ABERTO: "Contas em aberto sem pagamento", PARCIALMENTE_PAGO: "Contas pagas em parte", PAGO: "Contas pagas", AGUARDANDO_CLASSIFICACAO_OU_EVIDENCIA: "Contas aguardando classificação", TODAS: "Contas a pagar" });
const MAX_ITENS_NA_CONSULTA = 20;
const emAberto = (t) => t.situacao !== "CANCELADO" && (t.saldoCentavos ?? 0) > 0;
/**
 * TODAS as contas da unidade numa ÚNICA leitura por mensagem (sem filtro no Financeiro: as ferramentas compartilham a mesma
 * carga), filtradas aqui. A situação de vencimento é a do CÓDIGO (itemAPagar com a data de hoje), nunca a do modelo.
 */
async function contasFiltradas({ porta, escopo, args, hoje }) {
  const r = await todasAsPaginas(porta, "consultarContasAPagar", escopo, {});
  const todas = (r.itens ?? []).filter((t) => t.situacao !== "CANCELADO").map((t) => itemAPagar(t, hoje));
  const situacao = args.situacao ?? (args.competencia || args.vencimentoDe || args.vencimentoAte ? "TODAS" : "TODAS_EM_ABERTO");
  const porSituacao = {
    TODAS: () => true, TODAS_EM_ABERTO: emAberto,
    VENCIDO: (t) => t.situacaoDoVencimento === "VENCIDA", VENCE_HOJE: (t) => t.situacaoDoVencimento === "VENCE_HOJE", A_VENCER: (t) => t.situacaoDoVencimento === "A_VENCER",
    PAGO: (t) => t.situacaoDoVencimento === "LIQUIDADA",
    EM_ABERTO: (t) => emAberto(t) && !(t.pagoCentavos > 0), PARCIALMENTE_PAGO: (t) => emAberto(t) && t.pagoCentavos > 0,
    AGUARDANDO_CLASSIFICACAO_OU_EVIDENCIA: (t) => t.situacao === "AGUARDANDO_CLASSIFICACAO_OU_EVIDENCIA",
  }[situacao] ?? emAberto;
  let itens = todas.filter((t) => porSituacao(t) && (!args.competencia || t.competencia === args.competencia)
    && (!args.vencimentoDe || (t.vencimento && t.vencimento >= args.vencimentoDe)) && (!args.vencimentoAte || (t.vencimento && t.vencimento <= args.vencimentoAte)));
  if (args.termo) itens = itens.filter((t) => bate(args.termo, t.fornecedor, t.descricao, t.categoria));
  const ambiguidade = args.termo ? ambiguidadeDeNome(args.termo, itens.filter((t) => bate(args.termo, t.fornecedor)).map((t) => t.fornecedor)) : null;
  const soma = (lista, k = "saldoCentavos") => lista.reduce((a, t) => a + (t[k] ?? 0), 0);
  const vencidas = itens.filter((t) => t.vencido);
  const totais = { quantidade: itens.length, valorCentavos: soma(itens, "valorCentavos"), pagoCentavos: soma(itens, "pagoCentavos"), saldoCentavos: soma(itens), vencidoCentavos: soma(vencidas), contasVencidas: vencidas.length };
  const grupo = (f) => { const l = itens.filter(f); return { quantidade: l.length, saldoCentavos: soma(l) }; };
  const porVencimento = { vencidas: grupo((t) => t.situacaoDoVencimento === "VENCIDA"), vencemHoje: grupo((t) => t.situacaoDoVencimento === "VENCE_HOJE"), aVencer: grupo((t) => t.situacaoDoVencimento === "A_VENCER"), semVencimento: grupo((t) => t.situacaoDoVencimento === "SEM_VENCIMENTO") };
  const mapa = new Map();
  for (const t of itens) { const k = t.fornecedor ?? SEM_FORNECEDOR; mapa.set(k, [...(mapa.get(k) ?? []), t]); }
  const porFornecedor = [...mapa.entries()].map(([fornecedor, l]) => ({ fornecedor, quantidade: l.length, saldoCentavos: soma(l), vencidoCentavos: soma(l.filter((t) => t.vencido)),
    proximoVencimento: l.map((t) => t.vencimento).filter(Boolean).sort()[0] ?? null })).sort((a, b) => b.saldoCentavos - a.saldoCentavos || a.fornecedor.localeCompare(b.fornecedor, "pt-BR"));
  const periodo = args.competencia ?? (args.vencimentoDe || args.vencimentoAte ? `${args.vencimentoDe ?? ""}..${args.vencimentoAte ?? ""}` : null);
  return { itens, totais, porVencimento, porFornecedor, periodo, ent: args.termo ?? null, ambiguidade, dataBase: r.dataBase ?? null, truncado: Boolean(r.truncado),
    filtroAplicado: { situacao, ...(args.competencia ? { competencia: args.competencia } : {}), ...(args.vencimentoDe ? { vencimentoDe: args.vencimentoDe } : {}), ...(args.vencimentoAte ? { vencimentoAte: args.vencimentoAte } : {}), ...(args.termo ? { termo: args.termo } : {}) } };
}
// ------------------------------------------------------------------------------------------------------ entregadores
/** Mesmo código de categoria das contas geradas pelo fechamento semanal (dominio/entregadoresProprios.js do Financeiro v2). */
const CATEGORIA_ENTREGADORES = "ENTREGADORES_PROPRIOS";
const normNome = (s) => norm(s).replace(/[^a-z0-9]+/g, " ").trim();
/** O painel dos entregadores é uma leitura pesada (apuração do Foody): uma vez por mensagem e por semana. */
const painelDeEntregadores = (porta, escopo, entrada) => lerUmaVez(porta, `consultarEntregadoresProprios|${escopo.organizacaoId}|${escopo.unidadeId}|${escopo.usuarioId}|${JSON.stringify(entrada)}`,
  () => porta.ler("consultarEntregadoresProprios", escopo, entrada));

const compactarConta = (t) => ({ id: t.id, fornecedor: t.fornecedor, descricao: t.descricao, categoria: t.categoria, competencia: t.competencia, vencimento: t.vencimento, situacaoDoVencimento: t.situacaoDoVencimento,
  ...(t.diasEmAtraso ? { diasEmAtraso: t.diasEmAtraso } : {}), valorCentavos: t.valorCentavos, pagoCentavos: t.pagoCentavos, saldoCentavos: t.saldoCentavos, ...(t.parcela ? { parcela: t.parcela } : {}) });
function fatosDasContas({ itens, totais, porFornecedor, periodo, ent }) {
  return fatos(
    fato(totais.saldoCentavos, "A_PAGAR_EM_ABERTO", { entidade: ent, periodo }), fato(totais.vencidoCentavos, "A_PAGAR_VENCIDO", { entidade: ent, periodo }),
    fato(totais.pagoCentavos, "PAGO", { entidade: ent, periodo }), fato(totais.valorCentavos, "VALOR_DAS_CONTAS", { entidade: ent, periodo }),
    porFornecedor.flatMap((g) => [fato(g.saldoCentavos, "A_PAGAR_EM_ABERTO", { entidade: g.fornecedor, periodo }), fato(g.vencidoCentavos || null, "A_PAGAR_VENCIDO", { entidade: g.fornecedor, periodo })]),
    itens.flatMap((t) => [
      fato(t.saldoCentavos, t.vencido ? "A_PAGAR_VENCIDO" : "A_PAGAR_EM_ABERTO", { entidade: t.fornecedor ?? t.descricao, periodo: t.competencia ?? mesDe(t.vencimento) }),
      fato(t.valorCentavos, "VALOR_DAS_CONTAS", { entidade: t.fornecedor ?? t.descricao, periodo: t.competencia ?? mesDe(t.vencimento) }),
      fato(t.pagoCentavos, "PAGO", { entidade: t.fornecedor ?? t.descricao, periodo: t.competencia ?? mesDe(t.vencimento) }),
    ]),
  );
}

// --------------------------------------------------------------------------------------------------------- definições
export const FERRAMENTAS = [
  {
    nome: "listar_unidades",
    descricao: "Lista as unidades que esta pessoa pode consultar nesta conversa (nome e referência). Use antes de comparar unidades ou quando a pergunta citar outra unidade pelo nome.",
    esquema: { type: "object", properties: {} },
    valores: false, local: true,
    async executar({ sessao }) {
      return { dados: { unidades: sessao.unidadesPermitidas.map((u) => ({ id: u.id, nome: u.nome, daConversa: u.id === sessao.unidadeId })) }, fatos: [] };
    },
  },
  {
    nome: "contas_a_pagar",
    descricao: "Contas a pagar (obrigações com fornecedores, entregadores e despesas) da unidade: em aberto, vencidas, a vencer, pagas, por fornecedor/termo, categoria, competência ou faixa de vencimento. Traz totais, totais por situação de vencimento e por FORNECEDOR (sempre completos) e os itens quando são poucos. Use para 'quanto devemos a X', 'quais fornecedores temos para pagar', 'contas que vencem', 'quanto gastamos com Y no mês' (contas com competência no mês), 'o que precisa de atenção'. Para MOSTRAR todas as contas, use lista_completa_de_contas.",
    esquema: {
      type: "object",
      properties: {
        situacao: { type: "string", enum: SITUACOES_A_PAGAR, description: "TODAS_EM_ABERTO = tudo com saldo (vencidas, vencendo hoje e a vencer). VENCIDO / VENCE_HOJE / A_VENCER são calculados pelo servidor com a data de hoje. Sem situação, competência ou vencimento = TODAS_EM_ABERTO; com competência ou vencimento = todas (inclusive pagas)." },
        competencia: COMPETENCIA, vencimentoDe: DATA, vencimentoAte: DATA,
        termo: { ...TEXTO_CURTO, description: "Nome do fornecedor/entregador ou palavra da descrição (ex.: 'Matheus', 'brownie')." },
        unidade: UNIDADE,
      },
    },
    valores: true, ops: ["consultarContasAPagar"],
    async executar({ porta, escopo, args, sessao }) {
      const c = await contasFiltradas({ porta, escopo, args, hoje: sessao?.hoje ?? null });
      const { itens, totais, periodo, ent } = c;
      // 25/11 (homologação real): o resultado cortado em 12 mil caracteres fazia o modelo repetir a consulta 3–4 vezes e
      // estourar a saída. Agora: totais e agrupamento por fornecedor SEMPRE completos (calculados aqui); itens só quando cabem.
      const cabem = itens.length <= MAX_ITENS_NA_CONSULTA;
      return {
        dados: { dataBase: c.dataBase, hoje: sessao?.hoje ?? null, filtro: c.filtroAplicado, totais, porVencimento: c.porVencimento,
          porFornecedor: c.porFornecedor.slice(0, 40), fornecedoresOmitidos: Math.max(0, c.porFornecedor.length - 40),
          itens: cabem ? itens.map(compactarConta) : null,
          ...(cabem ? {} : { itensNaoMostradosAqui: itens.length, comoMostrarTodos: `São ${itens.length} contas: para a pessoa ver todas (descrição, fornecedor, valor, vencimento, situação), chame lista_completa_de_contas com os MESMOS filtros — o servidor envia a lista inteira. Não liste itens de cabeça.` }),
          leituraTruncada: c.truncado, ...(c.ambiguidade ? { ambiguidade: c.ambiguidade } : {}),
          nota: "situacaoDoVencimento é calculada pelo servidor com a data de hoje: use-a como está (VENCIDA = já venceu; nunca diga 'vence' para uma conta VENCIDA)." },
        fatos: fatosDasContas({ itens, totais, porFornecedor: c.porFornecedor, periodo, ent }),
      };
    },
  },
  {
    nome: "lista_completa_de_contas",
    descricao: "Envia à pessoa a LISTA COMPLETA de contas a pagar (descrição, fornecedor, valor, vencimento e situação), montada e conferida pelo SERVIDOR e dividida em mensagens organizadas. Use quando pedirem 'todas as contas', 'liste', 'com datas e descrições', 'quais fornecedores' com detalhe, ou 'continuar' depois de uma lista paginada. Mesmos filtros de contas_a_pagar; agruparPor FORNECEDOR agrupa por fornecedor. Você NÃO recebe os itens: escreva só uma introdução curta (quantidade e total).",
    esquema: {
      type: "object",
      properties: {
        situacao: { type: "string", enum: SITUACOES_A_PAGAR, description: "Sem situação, competência ou vencimento = TODAS_EM_ABERTO." },
        competencia: COMPETENCIA, vencimentoDe: DATA, vencimentoAte: DATA,
        termo: { ...TEXTO_CURTO, description: "Nome do fornecedor/entregador ou palavra da descrição." },
        agruparPor: { type: "string", enum: ["NENHUM", "FORNECEDOR"] },
        ordem: { type: "string", enum: ["VENCIMENTO", "MAIOR_SALDO"] },
        pagina: { type: "integer", minimum: 1, maximum: 50, description: "Página da lista (cada página tem até 120 contas). Use a próxima para 'continuar'." },
        unidade: UNIDADE,
      },
    },
    valores: true, ops: ["consultarContasAPagar"],
    async executar({ porta, escopo, args, sessao }) {
      const c = await contasFiltradas({ porta, escopo, args, hoje: sessao?.hoje ?? null });
      if (c.ambiguidade) return { situacao: "PARCIAL", dados: { ambiguidade: c.ambiguidade, orientacao: "Pergunte qual cadastro a pessoa quer antes de enviar a lista." }, fatos: [] };
      const itens = [...c.itens].sort(args.ordem === "MAIOR_SALDO"
        ? (a, b) => (b.saldoCentavos ?? 0) - (a.saldoCentavos ?? 0) || String(a.vencimento).localeCompare(String(b.vencimento))
        : (a, b) => String(a.vencimento ?? "9999").localeCompare(String(b.vencimento ?? "9999")) || String(a.fornecedor ?? "").localeCompare(String(b.fornecedor ?? ""), "pt-BR"));
      const unidade = sessao?.unidadesPermitidas?.find((u) => u.id === escopo.unidadeId)?.nome ?? null;
      const titulo = `*${TITULO_DA_SITUACAO[c.filtroAplicado.situacao ?? "TODAS"] ?? "Contas a pagar"}${args.termo ? ` — ${args.termo}` : ""}${c.periodo ? ` — ${c.periodo}` : ""}*${unidade ? ` (${unidade})` : ""}`;
      if (!itens.length) return { situacao: "SEM_REGISTROS", dados: { quantidade: 0, filtro: c.filtroAplicado }, fatos: [] };
      const l = formatarListaDeContas(itens, { titulo, agruparPor: args.agruparPor ?? "NENHUM", pagina: args.pagina ?? 1, totais: c.totais });
      if (sessao) sessao.entregas = [{ tipo: "LISTA_DE_CONTAS", blocos: l.blocos, pagina: l.pagina, paginas: l.paginas, filtro: { ...args, pagina: undefined } }];
      return {
        dados: { entreguePeloServidor: true, quantidade: itens.length, totais: c.totais, porVencimento: c.porVencimento, pagina: l.pagina, paginas: l.paginas, contasDestaPagina: `${l.inicio} a ${l.fim}`, mensagens: l.blocos.length,
          orientacao: `O servidor envia a lista (${l.fim - l.inicio + 1} contas${l.paginas > 1 ? `, página ${l.pagina} de ${l.paginas}` : ", completa"}) logo depois da sua resposta, em ${l.blocos.length} ${l.blocos.length === 1 ? "mensagem" : "mensagens"}. Escreva SÓ uma frase curta de introdução (quantidade e total em aberto/vencido); NÃO repita nenhum item.${l.pagina < l.paginas ? " Diga que dá para pedir 'continuar' para o restante." : ""}` },
        fatos: fatos(fato(c.totais.saldoCentavos, "A_PAGAR_EM_ABERTO", { entidade: c.ent, periodo: c.periodo }), fato(c.totais.vencidoCentavos, "A_PAGAR_VENCIDO", { entidade: c.ent, periodo: c.periodo }),
          fato(c.totais.valorCentavos, "VALOR_DAS_CONTAS", { entidade: c.ent, periodo: c.periodo }), fato(c.totais.pagoCentavos, "PAGO", { entidade: c.ent, periodo: c.periodo })),
      };
    },
  },
  {
    nome: "detalhe_conta_a_pagar",
    descricao: "Detalhe de UMA conta a pagar (parcelas, pagamentos, documentos, histórico) pela referência vinda de contas_a_pagar.",
    esquema: { type: "object", properties: { conta: REFERENCIA, unidade: UNIDADE }, required: ["conta"] },
    valores: true, ops: ["detalharContaAPagar"],
    async executar({ porta, escopo, args }) {
      const r = await porta.ler("detalharContaAPagar", escopo, { id: args.conta });
      const t = r?.titulo ?? r?.conta ?? r;
      const pagamentos = (r?.pagamentos ?? []).map((p) => ({ data: p.dataEfetiva ?? p.data ?? null, valorCentavos: p.valorCentavos ?? null, situacao: p.situacao ?? null }));
      const ent = t?.fornecedor?.nome ?? t?.descricao ?? null;
      return {
        dados: { conta: itemAPagar(t ?? {}), pagamentos, documentos: (r?.documentos ?? []).length, historico: (r?.historico ?? []).slice(-10).map((h) => ({ em: h.em ?? h.data ?? null, evento: h.tipo ?? h.evento ?? null })) },
        fatos: fatos(fato(t?.saldoCentavos, "A_PAGAR_EM_ABERTO", { entidade: ent, periodo: t?.competencia }), fato(t?.valorOriginalCentavos ?? t?.valorCentavos, "VALOR_DAS_CONTAS", { entidade: ent, periodo: t?.competencia }),
          pagamentos.map((p) => fato(p.valorCentavos, "PAGO", { entidade: ent, periodo: mesDe(p.data) }))),
      };
    },
  },
  {
    nome: "contas_a_receber",
    descricao: "Contas a receber (repasses de iFood e outras plataformas, cartões, PIX a receber): previsto, recebido, atrasado, por canal e período.",
    esquema: { type: "object", properties: { situacao: { type: "string", enum: ["A_RECEBER", "PARCIALMENTE_RECEBIDO", "RECEBIDO", "ATRASADO", "SEM_PREVISAO_CONFIAVEL", "EM_DIVERGENCIA"] }, competencia: COMPETENCIA, previstoDe: DATA, previstoAte: DATA, canal: { type: "string", enum: ["BALCAO", "IFOOD", "ANOTA_AI", "NOVENTA_E_NOVE_FOOD", "OUTRO"] }, unidade: UNIDADE } },
    valores: true, ops: ["consultarContasAReceber"],
    async executar({ porta, escopo, args }) {
      const { unidade: _u, ...filtro } = args;
      const r = await todasAsPaginas(porta, "consultarContasAReceber", escopo, filtro);
      const itens = (r.itens ?? []).filter((t) => t.situacao !== "CANCELADO").map((t) => ({ id: t.id, processador: t.processador ?? null, canal: t.canal ?? null, dataPrevista: t.dataPrevista ?? null, situacao: t.situacao, liquidoCentavos: t.liquidoCentavos ?? t.valorCentavos ?? null, recebidoCentavos: t.recebidoCentavos ?? null, saldoCentavos: t.saldoCentavos ?? null }));
      const soma = (k) => itens.reduce((a, t) => a + (t[k] ?? 0), 0);
      const totais = { quantidade: itens.length, liquidoCentavos: soma("liquidoCentavos"), recebidoCentavos: soma("recebidoCentavos"), saldoCentavos: soma("saldoCentavos") };
      const periodo = args.competencia ?? null;
      return { dados: { totais, itens: itens.slice(0, 40), itensOmitidos: Math.max(0, itens.length - 40) },
        fatos: fatos(fato(totais.saldoCentavos, "A_RECEBER", { entidade: args.canal ?? null, periodo }), fato(totais.recebidoCentavos, "RECEBIDO", { entidade: args.canal ?? null, periodo }), fato(totais.liquidoCentavos, "A_RECEBER_PREVISTO", { entidade: args.canal ?? null, periodo }),
          // avaliação real 24/11: cada ITEM também é fonte ("iFood R$ 23.100,00 em 26/11")
          itens.slice(0, 40).flatMap((t) => [fato(t.saldoCentavos, "A_RECEBER", { entidade: t.processador ?? t.canal, periodo: t.dataPrevista }), fato(t.liquidoCentavos, "A_RECEBER_PREVISTO", { entidade: t.processador ?? t.canal, periodo: t.dataPrevista }), fato(t.recebidoCentavos, "RECEBIDO", { entidade: t.processador ?? t.canal, periodo: t.dataPrevista })])) };
    },
  },
  {
    nome: "resultado_do_mes",
    descricao: "Apuração (DRE gerencial) de uma competência: receita, custos, despesas, resultado e indicadores, com o que ainda está pendente de conferência.",
    esquema: { type: "object", properties: { competencia: COMPETENCIA, unidade: UNIDADE,
      indicadores: { type: "array", items: { type: "string", maxLength: 40 }, maxItems: 8, description: "Linhas pedidas pela pessoa, como ela disse (ex.: [\"cmv\"], [\"resultado\"]). As que a apuração não trouxer voltam como NÃO CALCULÁVEIS." } }, required: ["competencia"] },
    valores: true, ops: ["apurarCompetencia"],
    async executar({ porta, escopo, args }) {
      const r = await porta.ler("apurarCompetencia", escopo, { competencia: args.competencia });
      // indicadores oficiais da apuração; valor nulo = BLOQUEADO (evidência insuficiente) — a resposta deve dizer isso, não "zero"
      const linhas = Object.values(r?.indicadores ?? {}).map((l) => ({ codigo: l.codigo, nome: l.nome, valorCentavos: l.valorCentavos ?? null, situacao: l.situacao ?? null, percentualDoBruto: l.percentualDoBruto ?? null }));
      // §3: linhas-padrão da DRE que a apuração desta unidade NÃO trouxe são NÃO CALCULÁVEIS aqui (não existem, não são zero)
      const naoApuradas = (args.indicadores ?? []).filter((x) => !linhaPedidaPresente(x, linhas));
      const bloqueadas = linhas.filter((l) => l.valorCentavos === null).map((l) => l.nome);
      return { situacao: linhas.length === 0 ? "SEM_REGISTROS" : naoApuradas.length && naoApuradas.length === (args.indicadores ?? []).length ? "NAO_CALCULAVEL" : naoApuradas.length ? "PARCIAL" : undefined,
        dados: { competencia: args.competencia, metodologia: r?.metodologia?.nome ?? null, indicadores: linhas.slice(0, 60), pendencias: (r?.pendencias ?? []).length,
        indicadoresNaoCalculaveis: [...naoApuradas, ...bloqueadas],
        aviso: naoApuradas.length || bloqueadas.length ? `NÃO CALCULÁVEIS nesta apuração (não informar valor, não são zero): ${[...naoApuradas, ...bloqueadas].join(", ")}.` : null },
        fatos: linhas.map((l) => fato(l.valorCentavos, `DRE:${l.codigo}`, { entidade: l.nome, periodo: args.competencia })).filter(Boolean) };
    },
  },
  {
    nome: "resumo_financeiro",
    descricao: "Visão geral financeira de uma competência (a mesma da tela Resumo): a pagar, a receber, caixa e alertas do mês.",
    esquema: { type: "object", properties: { competencia: COMPETENCIA, unidade: UNIDADE }, required: ["competencia"] },
    valores: true, ops: ["consultarResumoFinanceiro"],
    async executar({ porta, escopo, args }) {
      const r = await porta.ler("consultarResumoFinanceiro", escopo, { competencia: args.competencia });
      const fs = [];
      const andar = (o, caminho) => { for (const [k, v] of Object.entries(o ?? {})) { if (k.endsWith("Centavos") && Number.isInteger(v)) fs.push(fato(v, `RESUMO:${[...caminho, k].join(".")}`, { periodo: args.competencia })); else if (v && typeof v === "object" && !Array.isArray(v) && caminho.length < 3) andar(v, [...caminho, k]); } };
      andar(r, []);
      return { dados: r, fatos: fs };
    },
  },
  {
    nome: "fluxo_de_caixa",
    descricao: "Fluxo de caixa realizado e previsto (entradas e saídas) num período, por dia, semana ou mês.",
    esquema: { type: "object", properties: { inicio: DATA, fim: DATA, granularidade: { type: "string", enum: ["DIA", "SEMANA", "MES"] }, unidade: UNIDADE }, required: ["inicio", "fim"] },
    valores: true, ops: ["consultarFluxoDeCaixa"],
    async executar({ porta, escopo, args }) {
      const r = await porta.ler("consultarFluxoDeCaixa", escopo, { inicio: args.inicio, fim: args.fim, granularidade: args.granularidade ?? "SEMANA" });
      const periodos = (r?.periodos ?? r?.itens ?? []).slice(0, 40);
      const periodo = `${args.inicio}..${args.fim}`;
      const tot = r?.totais ?? r?.resumo ?? {};
      return { dados: { totais: tot, periodos },
        fatos: fatos(Object.entries(tot).map(([k, v]) => fato(v, `FLUXO:${k}`, { periodo })),
          periodos.flatMap((p) => Object.entries(p).filter(([k]) => k.endsWith("Centavos")).map(([k, v]) => fato(v, `FLUXO:${k}`, { periodo: p.inicio ?? p.data ?? periodo })))) };
    },
  },
  {
    nome: "prestacao_de_sangrias",
    descricao: "Sangrias (retiradas de dinheiro do caixa) e a PRESTAÇÃO DE CONTAS de cada uma: quanto saiu, o que já foi gasto (despesas), o troco devolvido, quanto ainda está PENDENTE, o prazo e o estado (aguardando destino, parcial, atrasada, prestada). Uma retirada só vira despesa quando se informa o que foi comprado com ela.",
    esquema: { type: "object", properties: { somentePendentes: { type: "boolean", description: "true = só as que ainda têm valor a prestar contas" }, inicio: DATA, fim: DATA, unidade: UNIDADE } },
    valores: true, ops: ["consultarPrestacaoDeSangrias"],
    async executar({ porta, escopo, args }) {
      const r = await porta.ler("consultarPrestacaoDeSangrias", escopo, { ...(args.inicio ? { inicio: args.inicio } : {}), ...(args.fim ? { fim: args.fim } : {}), somentePendentes: args.somentePendentes === true });
      const itens = (r?.itens ?? []).slice(0, 40).map((x) => ({ ref: x.movimentacaoId, data: x.data, descricao: x.descricao ?? null, estado: x.estado, retiradoCentavos: x.valorCentavos,
        despesasCentavos: x.despesasCentavos ?? x.alocadoCentavos ?? 0, trocoCentavos: x.trocoDevolvidoCentavos ?? x.devolvidoCentavos ?? 0, pendenteCentavos: x.pendenteCentavos, prazoAte: x.prazoAte ?? x.vencePrestacaoEm ?? null,
        despesas: (x.despesas ?? []).slice(0, 10).map((d) => ({ descricao: d.descricao ?? null, valorCentavos: d.valorCentavos })) }));
      const tot = r?.totais ?? {};
      return { dados: { prazoHoras: r?.prazoHoras ?? null, totais: tot, itens, nota: "Pendente NÃO é despesa: é dinheiro que saiu do caixa e ainda não teve destino informado." },
        fatos: fatos(fato(tot.retiradoCentavos, "SANGRIA:retirado"), fato(tot.pendenteCentavos, "SANGRIA:pendente"),
          itens.flatMap((x) => [fato(x.retiradoCentavos, "SANGRIA:retirado", { entidade: x.descricao, periodo: x.data }), fato(x.pendenteCentavos, x.estado === "ATRASADA" ? "SANGRIA:pendente_atrasada" : "SANGRIA:pendente", { entidade: x.descricao, periodo: x.data }),
            fato(x.despesasCentavos, "SANGRIA:despesas", { entidade: x.descricao, periodo: x.data }), fato(x.trocoCentavos, "SANGRIA:troco", { entidade: x.descricao, periodo: x.data }),
            ...x.despesas.map((d) => fato(d.valorCentavos, "SANGRIA:despesa", { entidade: d.descricao, periodo: x.data }))])) };
    },
  },
  {
    nome: "caixa_e_bancos",
    descricao: "Saldos e movimentos das contas de CAIXA FÍSICO e BANCOS (saldo informado, saldo calculado, diferença) num período. Use para 'saldo real do caixa', 'quanto tem no banco'.",
    esquema: { type: "object", properties: { inicio: DATA, fim: DATA, unidade: UNIDADE }, required: ["inicio", "fim"] },
    valores: true, ops: ["consultarCaixaEBancos"],
    async executar({ porta, escopo, args }) {
      const r = await porta.ler("consultarCaixaEBancos", escopo, { inicio: args.inicio, fim: args.fim, tamanho: 100 });
      const contas = (r?.contas ?? []).filter((c) => c.ativa !== false).map((c) => ({
        id: c.id, nome: c.nome ?? null, tipo: c.tipo ?? null, instituicao: c.instituicao ?? null,
        saldoInicialCentavos: c.saldoInicialCentavos ?? null, entradasCentavos: c.entradasCentavos ?? null, saidasCentavos: c.saidasCentavos ?? null,
        saldoFinalCalculadoCentavos: c.saldoFinalCentavos ?? null, situacaoDoSaldo: c.situacaoDoSaldo ?? null,
        saldoInformado: c.saldoInformado ? { data: c.saldoInformado.data, referencia: c.saldoInformado.referencia, valorCentavos: c.saldoInformado.valorCentavos } : null,
        saldosDivergentes: c.saldosDivergentes ?? 0, diferencasDeCaixaNaoAjustadasCentavos: c.diferencasDeCaixaNaoAjustadasCentavos ?? null,
        semVinculo: c.pendencias?.semVinculo ?? 0,
      }));
      const k = r?.consolidado ?? {};
      return { dados: { periodo: r?.periodo ?? { inicio: args.inicio, fim: args.fim }, consolidado: { saldoFinalCentavos: k.saldoFinalCentavos ?? null, saldoBancarioCentavos: k.saldoBancarioCentavos ?? null, saldoCaixaFisicoCentavos: k.saldoCaixaFisicoCentavos ?? null, entradasCentavos: k.entradasCentavos ?? null, saidasCentavos: k.saidasCentavos ?? null, contasSemSaldoInformado: k.contasSemSaldoInformado ?? [] }, contas, pendencias: r?.pendencias ?? null },
        fatos: fatos(
          fato(k.saldoFinalCentavos, "SALDO_CALCULADO", { entidade: "todas as contas", periodo: args.fim }), fato(k.saldoBancarioCentavos, "SALDO_CALCULADO", { entidade: "bancos", periodo: args.fim }),
          fato(k.saldoCaixaFisicoCentavos, "SALDO_CALCULADO", { entidade: "caixa físico", periodo: args.fim }), fato(k.entradasCentavos, "FLUXO:entradas", { periodo: args.fim }), fato(k.saidasCentavos, "FLUXO:saidas", { periodo: args.fim }),
          contas.flatMap((c) => [fato(c.saldoFinalCalculadoCentavos, "SALDO_CALCULADO", { entidade: c.nome, periodo: args.fim }), fato(c.saldoInformado?.valorCentavos, "SALDO_INFORMADO", { entidade: c.nome, periodo: c.saldoInformado?.data ?? args.fim }),
            fato(c.saldoInicialCentavos, "SALDO_CALCULADO", { entidade: c.nome, periodo: args.inicio }), fato(c.entradasCentavos, "FLUXO:entradas", { entidade: c.nome, periodo: args.fim }), fato(c.saidasCentavos, "FLUXO:saidas", { entidade: c.nome, periodo: args.fim }), fato(c.diferencasDeCaixaNaoAjustadasCentavos, "DIFERENCA_DE_SALDO", { entidade: c.nome, periodo: args.fim })]),
        ) };
    },
  },
  {
    nome: "movimentos_do_caixa_fisico",
    descricao: "Movimentos do CAIXA FÍSICO (sangrias, suprimentos, retiradas) já registrados num período.",
    esquema: { type: "object", properties: { inicio: DATA, fim: DATA, unidade: UNIDADE }, required: ["inicio", "fim"] },
    valores: true, ops: ["consultarMovimentosDeCaixa"],
    async executar({ porta, escopo, args }) {
      const r = await porta.ler("consultarMovimentosDeCaixa", escopo, { periodoInicio: args.inicio, periodoFim: args.fim });
      const t = r?.totais ?? {};
      const periodo = `${args.inicio}..${args.fim}`;
      const dias = (r?.dias ?? []).slice(0, 31);
      return { dados: { periodo, totais: t, dias, observacao: r?.observacao ?? null },
        fatos: fatos(fato(t.retiradas?.totalCentavos, "RETIRADAS_DO_CAIXA", { entidade: "sangrias", periodo }), fato(t.reforcos?.totalCentavos, "REFORCOS_DO_CAIXA", { entidade: "reforços", periodo }),
          fato(t.transferencias?.totalCentavos, "MOVIMENTO_DE_CAIXA", { entidade: "transferências", periodo }), fato(t.desconhecidas?.totalCentavos, "MOVIMENTO_DE_CAIXA", { entidade: "não identificados", periodo }),
          dias.flatMap((d) => Object.entries(d ?? {}).filter(([kk, v]) => kk.endsWith("Centavos") && Number.isInteger(v)).map(([kk, v]) => fato(v, `MOVIMENTO_DE_CAIXA:${kk}`, { periodo: d.data })))) };
    },
  },
  {
    nome: "vendas",
    descricao: "Vendas registradas (bruto, descontos, líquido, quantidade) por período e canal. Use para faturamento e comparação de vendas.",
    esquema: { type: "object", properties: { competencia: COMPETENCIA, inicio: DATA, fim: DATA, canal: { type: "string", enum: ["BALCAO", "IFOOD", "ANOTA_AI", "NOVENTA_E_NOVE_FOOD", "OUTRO"] }, unidade: UNIDADE } },
    valores: true, ops: ["consultarVendas"],
    async executar({ porta, escopo, args }) {
      const { unidade: _u, ...filtro } = args;
      const r = await porta.ler("consultarVendas", escopo, { ...filtro, tamanho: 1 });
      const res = r?.resumo ?? {};
      const periodo = args.competencia ?? (args.inicio ? `${args.inicio}..${args.fim ?? ""}` : null);
      return { dados: { resumo: res, filtro: args },
        fatos: Object.entries(res).filter(([k, v]) => k.endsWith("Centavos") && Number.isInteger(v)).map(([k, v]) => fato(v, `VENDAS:${k}`, { entidade: args.canal ?? null, periodo })) };
    },
  },
  {
    nome: "cobertura_de_faturamento",
    descricao: "Calendário do faturamento de um canal no mês: até quando há dados, dias sem registro, com pendência ou divergência. Use antes de afirmar faturamento de um mês e para 'faltam dias?'.",
    esquema: { type: "object", properties: { canal: { type: "string", enum: ["BALCAO", "IFOOD", "ANOTA_AI", "NOVENTA_E_NOVE_FOOD", "OUTRO"] }, mes: COMPETENCIA, unidade: UNIDADE }, required: ["canal", "mes"] },
    valores: false, ops: ["consultarCalendarioDeFaturamento"],
    async executar({ porta, escopo, args }) {
      const r = await porta.ler("consultarCalendarioDeFaturamento", escopo, { canal: args.canal, mes: args.mes });
      const dias = (r?.dias ?? []).map((d) => ({ data: d.data, estados: d.estados ?? [] }));
      return { dados: { resumo: r?.resumo ?? null, granularidadeDiaria: r?.granularidadeDiaria ?? null, diasComDado: dias.filter((d) => d.estados.length).length, ultimoDiaComDado: dias.filter((d) => d.estados.length).map((d) => d.data).sort().at(-1) ?? null }, fatos: [] };
    },
  },
  {
    nome: "pendencias_de_conferencia",
    descricao: "Pendências da Central de Conferências de uma competência (o que falta conferir, classificar ou conciliar), por grupo.",
    esquema: { type: "object", properties: { competencia: COMPETENCIA, grupo: { type: "string", enum: ["VENDAS_E_AJUSTES", "RECEBIMENTOS_E_REPASSES", "CONTAS_E_PAGAMENTOS", "CUSTOS_E_RATEIOS", "CAIXA_E_CONCILIACAO", "CLASSIFICACOES", "DOCUMENTAIS"] }, unidade: UNIDADE }, required: ["competencia"] },
    valores: false, ops: ["consultarPendencias"],
    async executar({ porta, escopo, args }) {
      const r = await porta.ler("consultarPendencias", escopo, { competencia: args.competencia, ...(args.grupo ? { grupo: args.grupo } : {}), situacao: "A_RESOLVER", tamanho: 100 });
      const itens = (r?.itens ?? r?.pendencias ?? []).map((p) => ({ grupo: p.grupo ?? null, titulo: p.titulo ?? p.descricao ?? p.tipo ?? null, situacao: p.situacao ?? null }));
      const porGrupo = {};
      for (const p of itens) porGrupo[p.grupo ?? "OUTRO"] = (porGrupo[p.grupo ?? "OUTRO"] ?? 0) + 1;
      return { dados: { total: r?.paginacao?.total ?? itens.length, porGrupo, itens: itens.slice(0, 30) }, fatos: [] };
    },
  },
  {
    nome: "documentos",
    descricao: "Documentos guardados no cofre documental (notas, comprovantes, extratos) por competência e tipo — contagens e lista.",
    esquema: { type: "object", properties: { competencia: COMPETENCIA, tipo: { ...TEXTO_CURTO, maxLength: 40 }, unidade: UNIDADE } },
    valores: false, ops: ["consultarDocumentos"],
    async executar({ porta, escopo, args }) {
      const r = await porta.ler("consultarDocumentos", escopo, { ...(args.competencia ? { competencia: args.competencia } : {}), ...(args.tipo ? { tipo: args.tipo } : {}), situacao: "VIGENTE", tamanho: 50 });
      const itens = (r?.itens ?? []).map((d) => ({ tipo: d.tipo ?? null, descricao: d.descricao ?? null, recebidoEm: d.recebidoEm ?? null, vinculado: Boolean(d.vinculos?.length ?? d.vinculado) }));
      return { dados: { total: r?.paginacao?.total ?? itens.length, itens: itens.slice(0, 30) }, fatos: [] };
    },
  },
  {
    nome: "categorias",
    descricao: "Plano de contas (categorias de receita, custo e despesa) da unidade.",
    esquema: { type: "object", properties: { unidade: UNIDADE } },
    valores: false, ops: ["consultarPlanoDeContas"],
    async executar({ porta, escopo }) {
      const r = await porta.ler("consultarPlanoDeContas", escopo, {});
      const itens = (r?.itens ?? r?.categorias ?? r ?? []).map?.((c) => ({ codigo: c.codigo, nome: c.nome, classificacao: c.classificacao ?? null })) ?? [];
      return { dados: { total: itens.length, itens: itens.slice(0, 80) }, fatos: [] };
    },
  },
  {
    nome: "entregadores_da_semana",
    descricao: "Fechamento SEMANAL dos entregadores próprios: entregas, valor a pagar, pago, situação, por entregador. Sem semana = semana atual; 'semana' é a segunda-feira de início (AAAA-MM-DD). Use 'entregador' com o nome para um só.",
    esquema: { type: "object", properties: { semana: DATA, mes: COMPETENCIA, entregador: TEXTO_CURTO, unidade: UNIDADE } },
    valores: true, ops: ["consultarEntregadoresProprios"],
    async executar({ porta, escopo, args }) {
      const r = await painelDeEntregadores(porta, escopo, { ...(args.semana ? { semana: args.semana } : {}), ...(args.mes ? { mes: args.mes } : {}) });
      // 25/11: campos REAIS do painel (antes: entregas e valor da semana saíam nulos e o "a pagar" misturava semanas)
      let linhas = (r?.entregadores ?? []).map((e) => ({ chave: e.chave, nome: e.nome, entregasNaSemana: e.entregasSemana ?? 0, valorDaSemanaCentavos: e.valorSemanaCentavos ?? 0,
        emAbertoDeSemanasFechadasCentavos: e.aPagarCentavos ?? 0, aguardandoNota: e.aguardandoNota ?? 0 }));
      if (args.entregador) linhas = linhas.filter((e) => bate(args.entregador, e.nome, e.chave));
      const ambiguidade = args.entregador ? ambiguidadeDeNome(args.entregador, linhas.map((e) => e.nome)) : null;
      const s = r?.semana ?? {};
      const periodo = s.inicio ?? null;
      const ind = r?.indicadoresDaSemana ?? {};
      return { dados: { semana: { inicio: s.inicio ?? null, fim: s.fim ?? null, rotulo: s.rotulo ?? null, situacao: s.situacao ?? null, provisoria: s.provisoria ?? null },
        totaisDaSemana: { devidoCentavos: ind.devidoCentavos ?? null, pagoCentavos: ind.pagoCentavos ?? null, saldoCentavos: ind.saldoCentavos ?? null },
        entregadores: linhas.slice(0, 40), ...(ambiguidade ? { ambiguidade } : {}),
        nota: "valorDaSemana é a apuração da semana mostrada (provisória enquanto a semana não é fechada); emAbertoDeSemanasFechadas são contas já geradas de semanas anteriores. Para o TOTAL devido, use devido_aos_entregadores." },
        fatos: fatos(fato(ind.devidoCentavos, "ENTREGADOR_A_PAGAR", { periodo }), fato(ind.pagoCentavos, "ENTREGADOR_PAGO", { periodo }), fato(ind.saldoCentavos, "ENTREGADOR_A_PAGAR", { periodo }),
          linhas.flatMap((e) => [fato(e.valorDaSemanaCentavos, "ENTREGADOR_A_PAGAR", { entidade: e.nome, periodo }), fato(e.emAbertoDeSemanasFechadasCentavos || null, "A_PAGAR_EM_ABERTO", { entidade: e.nome })])) };
    },
  },
  {
    nome: "devido_aos_entregadores",
    descricao: "TOTAL devido aos entregadores próprios (todos ou um): contas JÁ GERADAS em aberto de semanas fechadas (com semana, vencimento, situação e pagamentos parciais) + o valor PROVISÓRIO das semanas ainda não fechadas (semana atual e semanas encerradas sem fechamento). Sem duplicar: semana fechada só conta pela conta gerada. Use para 'quanto devemos aos entregadores', 'quem tem mais a receber', 'quanto falta pagar ao X'.",
    esquema: { type: "object", properties: { entregador: { ...TEXTO_CURTO, description: "Nome (ou parte/apelido) de um entregador; omita para todos." }, unidade: UNIDADE } },
    valores: true, ops: ["consultarEntregadoresProprios", "consultarContasAPagar"],
    tempoMs: 15_000, // até 3 leituras do painel (apuração do Foody) + contas, em sequência
    async executar({ porta, escopo, args, sessao }) {
      const hoje = sessao?.hoje ?? null;
      const r = await painelDeEntregadores(porta, escopo, {});
      // semanas ainda SEM fechamento (atual + encerradas aguardando): só elas entram como provisórias (nenhuma conta existe)
      const semanasProvisorias = [];
      if (r?.semana?.situacao !== "CONSOLIDADA") semanasProvisorias.push(r);
      for (const s of (r?.semanas ?? []).filter((x) => x.semRegistro && x.inicio !== r?.semana?.inicio).slice(0, 2)) semanasProvisorias.push(await painelDeEntregadores(porta, escopo, { semana: s.inicio }));
      const contas = await todasAsPaginas(porta, "consultarContasAPagar", escopo, {});
      const abertas = (contas.itens ?? []).filter((t) => t.situacao !== "CANCELADO" && (t.saldoCentavos ?? 0) > 0 && t.categoria?.codigo === CATEGORIA_ENTREGADORES).map((t) => itemAPagar(t, hoje));
      const pessoas = new Map();
      const de = (nome, chave = null) => { const k = normNome(nome); if (!pessoas.has(k)) pessoas.set(k, { nome, chave, contas: [], provisorio: [] }); const p = pessoas.get(k); p.chave ??= chave; return p; };
      for (const t of abertas) de(t.fornecedor ?? SEM_FORNECEDOR).contas.push({ descricao: t.descricao, vencimento: t.vencimento, situacaoDoVencimento: t.situacaoDoVencimento, ...(t.diasEmAtraso ? { diasEmAtraso: t.diasEmAtraso } : {}), valorCentavos: t.valorCentavos, pagoCentavos: t.pagoCentavos, saldoCentavos: t.saldoCentavos });
      for (const w of semanasProvisorias) for (const e of w?.entregadores ?? []) if ((e.valorSemanaCentavos ?? 0) > 0) de(e.nome, e.chave).provisorio.push({ semanaInicio: w.semana.inicio, semanaFim: w.semana.fim, situacaoDaSemana: w.semana.situacao, entregas: e.entregasSemana ?? 0, valorCentavos: e.valorSemanaCentavos });
      let lista = [...pessoas.values()].map((p) => {
        const confirmado = p.contas.reduce((a, c) => a + c.saldoCentavos, 0); const provisorio = p.provisorio.reduce((a, c) => a + c.valorCentavos, 0);
        return { nome: p.nome, confirmadoEmAbertoCentavos: confirmado, vencidoCentavos: p.contas.filter((c) => c.situacaoDoVencimento === "VENCIDA").reduce((a, c) => a + c.saldoCentavos, 0), provisorioCentavos: provisorio, totalCentavos: confirmado + provisorio, contasEmAberto: p.contas, semanasProvisorias: p.provisorio };
      }).sort((a, b) => b.totalCentavos - a.totalCentavos || a.nome.localeCompare(b.nome, "pt-BR"));
      let ambiguidade = null;
      if (args.entregador) {
        const rr = resolverEntidade(args.entregador, lista.map((x) => ({ nome: x.nome })));
        if (rr.estado === "AMBIGUO") ambiguidade = { termo: args.entregador, candidatos: rr.candidatos.map((c) => c.nome).slice(0, 6), orientacao: "pergunte qual entregador; não some os dois" };
        lista = rr.estado === "UNICO" ? lista.filter((x) => x.nome === rr.escolhido.nome) : rr.estado === "AMBIGUO" ? [] : [];
      }
      const soma = (k) => lista.reduce((a, x) => a + x[k], 0);
      const totais = { entregadores: lista.length, confirmadoEmAbertoCentavos: soma("confirmadoEmAbertoCentavos"), vencidoCentavos: soma("vencidoCentavos"), provisorioCentavos: soma("provisorioCentavos"), totalCentavos: soma("totalCentavos") };
      if (!lista.length && !ambiguidade) return { situacao: "SEM_REGISTROS", dados: { totais, mensagem: args.entregador ? "Nenhum entregador com esse nome tem valor em aberto ou em apuração." : "Nada devido aos entregadores agora." }, fatos: [] };
      return { dados: { hoje, totais, entregadores: lista.slice(0, 40), ...(ambiguidade ? { ambiguidade } : {}),
        semanasProvisorias: semanasProvisorias.map((w) => ({ inicio: w.semana.inicio, fim: w.semana.fim, situacao: w.semana.situacao })),
        nota: "confirmado = contas já geradas e ainda não pagas (pagamento parcial já descontado); provisório = apuração de semana ainda não fechada (pode mudar). Diga as duas partes quando houver provisório." },
        fatos: fatos(fato(totais.totalCentavos, "CALCULO:SOMA", { entidade: "entregadores" }), fato(totais.confirmadoEmAbertoCentavos, "A_PAGAR_EM_ABERTO", { entidade: "entregadores" }), fato(totais.vencidoCentavos || null, "A_PAGAR_VENCIDO", { entidade: "entregadores" }),
          fato(totais.provisorioCentavos || null, "ENTREGADOR_A_PAGAR", { entidade: "entregadores" }),
          lista.flatMap((x) => [fato(x.totalCentavos, "CALCULO:SOMA", { entidade: x.nome }), fato(x.confirmadoEmAbertoCentavos || null, "A_PAGAR_EM_ABERTO", { entidade: x.nome }), fato(x.vencidoCentavos || null, "A_PAGAR_VENCIDO", { entidade: x.nome }),
            fato(x.provisorioCentavos || null, "ENTREGADOR_A_PAGAR", { entidade: x.nome }),
            ...x.contasEmAberto.flatMap((c) => [fato(c.saldoCentavos, c.situacaoDoVencimento === "VENCIDA" ? "A_PAGAR_VENCIDO" : "A_PAGAR_EM_ABERTO", { entidade: x.nome, periodo: mesDe(c.vencimento) }), fato(c.valorCentavos, "VALOR_DAS_CONTAS", { entidade: x.nome }), fato(c.pagoCentavos || null, "PAGO", { entidade: x.nome })]),
            ...x.semanasProvisorias.map((w) => fato(w.valorCentavos, "ENTREGADOR_A_PAGAR", { entidade: x.nome, periodo: w.semanaInicio }))])) };
    },
  },
  {
    nome: "historico_do_entregador",
    descricao: "Histórico de UM entregador nesta unidade: cada semana fechada (início e fim, entregas, valor apurado, pago, saldo, situação, data do pagamento) e a semana em apuração. 'entregador' = nome, parte do nome ou apelido (o servidor resolve e avisa se houver mais de um).",
    esquema: { type: "object", properties: { entregador: TEXTO_CURTO, unidade: UNIDADE }, required: ["entregador"] },
    valores: true, ops: ["consultarEntregador", "consultarEntregadoresProprios", "detalharContaAPagar"],
    tempoMs: 12_000, // painel + histórico + até 8 detalhes de pagamento, em sequência
    async executar({ porta, escopo, args }) {
      // 25/11: o nome dito na conversa ("o Vitor") é resolvido aqui contra os entregadores da unidade (antes, exigia a chave e falhava)
      const painel = await painelDeEntregadores(porta, escopo, {});
      const candidatos = new Map();
      for (const e of painel?.entregadores ?? []) candidatos.set(e.chave, { id: e.chave, nome: e.nome });
      for (const f of painel?.fechamentos ?? []) if (f.entregador?.chave) candidatos.set(f.entregador.chave, { id: f.entregador.chave, nome: f.entregador.nome });
      const exato = candidatos.get(args.entregador);
      const rr = exato ? { estado: "UNICO", escolhido: exato } : resolverEntidade(args.entregador, [...candidatos.values()]);
      if (rr.estado === "NENHUM") return { situacao: "SEM_REGISTROS", dados: { mensagem: `Nenhum entregador com o nome "${args.entregador}" nesta unidade.` }, fatos: [] };
      if (rr.estado === "AMBIGUO") return { situacao: "PARCIAL", dados: { ambiguidade: { termo: args.entregador, candidatos: rr.candidatos.map((c) => c.nome).slice(0, 6), orientacao: "pergunte qual entregador" } }, fatos: [] };
      const chave = rr.escolhido.id;
      let r = null;
      try { r = await porta.ler("consultarEntregador", escopo, { entregador: chave }); } catch (e) { if (!porta.ehErroDeRegra?.(e)) throw e; } // sem fechamentos ainda: só a apuração
      const fechamentos = (r?.fechamentos ?? []).slice(0, 12);
      const semanas = [];
      let detalhados = 0;
      for (const f of fechamentos) {
        let pagamentos = [];
        if ((f.pagoCentavos ?? 0) > 0 && f.obrigacaoId && detalhados < 8) {
          detalhados++;
          try { const d = await porta.ler("detalharContaAPagar", escopo, { id: f.obrigacaoId }); pagamentos = (d?.titulo?.pagamentos ?? []).filter((p) => p.valorCentavos > 0).map((p) => ({ data: p.data ?? null, valorCentavos: p.valorCentavos })); }
          catch (e) { if (!porta.ehErroDeRegra?.(e)) throw e; }
        }
        semanas.push({ semanaInicio: f.semanaInicio, semanaFim: f.semanaFim, rotulo: f.rotuloSemana ?? null, vencimento: f.vencimento, entregas: f.entregas, valorApuradoCentavos: f.valorCentavos, pagoCentavos: f.pagoCentavos ?? 0,
          saldoCentavos: f.saldoCentavos ?? null, situacaoDoPagamento: f.situacaoPagamento, situacaoDaNota: f.situacaoDocumental, pagamentos, dataDoUltimoPagamento: pagamentos.map((p) => p.data).filter(Boolean).sort().at(-1) ?? null, origem: "FECHAMENTO_SEMANAL" });
      }
      const card = (painel?.entregadores ?? []).find((e) => e.chave === chave);
      const emApuracao = card && painel?.semana?.situacao !== "CONSOLIDADA" && (card.valorSemanaCentavos ?? 0) > 0
        ? { semanaInicio: painel.semana.inicio, semanaFim: painel.semana.fim, entregas: card.entregasSemana ?? 0, valorApuradoCentavos: card.valorSemanaCentavos, situacao: painel.semana.situacao, provisoria: true, origem: "APURACAO_FOODY" } : null;
      const nome = r?.nome ?? rr.escolhido.nome;
      const pagos = semanas.flatMap((s) => s.pagamentos.map((p) => p.data)).filter(Boolean).sort();
      return { dados: { entregador: nome, semanasFechadas: semanas, semanaEmApuracao: emApuracao, ultimoPagamentoEm: pagos.at(-1) ?? null,
        totais: { apuradoCentavos: r?.totalCentavos ?? null, pagoCentavos: r?.pagoCentavos ?? null, entregas: r?.entregas ?? null, saldoCentavos: semanas.reduce((a, s) => a + (s.saldoCentavos ?? 0), 0) },
        nota: "Cite cada semana pelas datas (dd/mm a dd/mm). Data de pagamento só quando 'pagamentos' trouxer; se não houver, diga que o pagamento não tem data registrada." },
        fatos: fatos(fato(r?.totalCentavos, "ENTREGADOR_A_PAGAR", { entidade: nome }), fato(r?.pagoCentavos, "ENTREGADOR_PAGO", { entidade: nome }),
          semanas.flatMap((s) => [fato(s.valorApuradoCentavos, "ENTREGADOR_A_PAGAR", { entidade: nome, periodo: s.semanaInicio }), fato(s.pagoCentavos, "ENTREGADOR_PAGO", { entidade: nome, periodo: s.semanaInicio }),
            fato(s.saldoCentavos || null, "A_PAGAR_EM_ABERTO", { entidade: nome, periodo: s.semanaInicio }), ...s.pagamentos.map((p) => fato(p.valorCentavos, "ENTREGADOR_PAGO", { entidade: nome, periodo: p.data }))]),
          emApuracao ? fato(emApuracao.valorApuradoCentavos, "ENTREGADOR_A_PAGAR", { entidade: nome, periodo: emApuracao.semanaInicio }) : null) };
    },
  },
  {
    nome: "calcular",
    descricao: "Faz contas EXATAS com valores que vieram das ferramentas (soma, diferença, média, divisão, variação percentual). Use SEMPRE que a resposta tiver um número derivado (ex.: custo por entrega = valor ÷ entregas; diferença entre meses). Valores monetários em centavos.",
    esquema: { type: "object", properties: {
      operacao: { type: "string", enum: ["SOMA", "DIFERENCA", "MEDIA", "DIVISAO", "VARIACAO_PERCENTUAL", "PERCENTUAL"] },
      valores: { type: "array", maxItems: 50, items: { type: "integer" }, description: "Números (centavos ou quantidades). DIFERENCA e VARIACAO_PERCENTUAL: [atual, anterior]. DIVISAO: [dividendo, divisor]. PERCENTUAL: [parte, total] → % da parte no total." },
      significado: { ...TEXTO_CURTO, maxLength: 200, description: "O que o resultado representa (ex.: 'custo médio por entrega do Matheus na semana de 16/11')." },
      monetario: { type: "boolean" },
    }, required: ["operacao", "valores", "significado", "monetario"] },
    valores: false, local: true,
    async executar({ args, fatosDaConversa }) {
      const v = args.valores;
      // código calcula: só aceita números que JÁ apareceram nas ferramentas desta conversa (nada inventado entra na conta)
      const conhecidos = new Set(fatosDaConversa().flatMap((f) => [f.valorCentavos]).concat(fatosDaConversa().flatMap((f) => f.numeros ?? [])));
      const estranhos = v.filter((x) => !conhecidos.has(x));
      if (estranhos.length) return { erro: "VALOR_SEM_ORIGEM", dados: { mensagem: `Estes números não vieram de nenhuma ferramenta: ${estranhos.join(", ")}. Consulte antes de calcular.` }, fatos: [] };
      let r = null;
      if (args.operacao === "SOMA") r = v.reduce((a, b) => a + b, 0);
      else if (args.operacao === "DIFERENCA" && v.length === 2) r = v[0] - v[1];
      else if (args.operacao === "MEDIA" && v.length) r = Math.round(v.reduce((a, b) => a + b, 0) / v.length);
      else if (args.operacao === "DIVISAO" && v.length === 2 && v[1] !== 0) r = Math.round(v[0] / v[1]);
      else if (args.operacao === "VARIACAO_PERCENTUAL" && v.length === 2 && v[1] !== 0) r = Math.round(((v[0] - v[1]) / Math.abs(v[1])) * 1000) / 10;
      else if (args.operacao === "PERCENTUAL" && v.length === 2 && v[1] !== 0) r = Math.round((v[0] / v[1]) * 1000) / 10;
      if (r === null) return { erro: "CALCULO_INVALIDO", dados: { mensagem: "Operação sem os valores necessários (ou divisão por zero)." }, fatos: [] };
      return { dados: { resultado: r, unidade: ["VARIACAO_PERCENTUAL", "PERCENTUAL"].includes(args.operacao) ? "%" : args.monetario ? "centavos" : "número" },
        fatos: args.monetario && Number.isInteger(r) && !["VARIACAO_PERCENTUAL", "PERCENTUAL"].includes(args.operacao) ? [{ valorCentavos: r, significado: `CALCULO:${args.operacao}`, entidade: args.significado, periodo: null, derivado: true }] : [], numeros: [r] };
    },
  },
  {
    nome: "como_funciona",
    descricao: "Explica como funciona um processo do sistema (conciliação, baixa por comprovante, fechamento de entregadores, competência, documentos). Use para perguntas 'como funciona…'. Não consulta dados.",
    esquema: { type: "object", properties: { tema: { type: "string", enum: ["CONCILIACAO", "BAIXA_POR_COMPROVANTE", "FECHAMENTO_DE_ENTREGADORES", "COMPETENCIA", "DOCUMENTOS", "CAIXA_FISICO"] } }, required: ["tema"] },
    valores: false, local: true,
    async executar({ args }) { return { dados: { tema: args.tema, explicacao: EXPLICACOES[args.tema] }, fatos: [] }; },
  },
  {
    nome: "preparar_registro",
    descricao: "Quando a pessoa INFORMA algo a registrar (retirada/sangria do caixa, despesa paga, pagamento de conta, compra nova). NÃO registra nada nesta fase: prepara o pedido, diz o que falta e o caminho (enviar o comprovante ao MOVA, ou registrar na tela do Financeiro). Nunca diga que registrou.",
    esquema: { type: "object", properties: {
      tipo: { type: "string", enum: ["RETIRADA_DO_CAIXA", "DESPESA_JA_PAGA", "PAGAMENTO_DE_CONTA_EXISTENTE", "COMPRA_NOVA_PAGA", "OUTRO"] },
      valorCentavos: { type: "integer", minimum: 1, maximum: 100_000_000 }, descricao: TEXTO_CURTO, data: DATA,
    }, required: ["tipo"] },
    valores: false, local: true, escrita: "PREPARACAO",
    async executar({ args }) {
      const faltando = [];
      if (!args.valorCentavos) faltando.push("valor");
      if (!args.descricao) faltando.push("o que foi comprado / para quê");
      if (["DESPESA_JA_PAGA", "COMPRA_NOVA_PAGA", "PAGAMENTO_DE_CONTA_EXISTENTE"].includes(args.tipo)) faltando.push("comprovante (foto ou PDF)");
      return { dados: { executado: false, registrado: false, tipo: args.tipo, entendido: { valorCentavos: args.valorCentavos ?? null, descricao: args.descricao ?? null, data: args.data ?? null }, faltando,
        caminho: CAMINHOS[args.tipo], aviso: "Nada foi registrado. Escritas financeiras pela conversa ainda não estão habilitadas." }, fatos: args.valorCentavos ? [{ valorCentavos: args.valorCentavos, significado: "INFORMADO_PELA_PESSOA", entidade: args.descricao ?? null, periodo: args.data ?? null }] : [] };
    },
  },
];

// Textos de "como funciona" — resumos fiéis do que o sistema faz HOJE (módulos baixaPorExtrato, baixaPorComprovante,
// entregadoresProprios, competencias, cofreDocumental, movimentosDeCaixa). Nada aqui promete capacidade que não existe.
const EXPLICACOES = Object.freeze({
  CONCILIACAO: "A conciliação liga cada saída do extrato bancário a uma conta a pagar já registrada. O sistema mostra a prévia oficial (saídas elegíveis, bloqueios e o efeito na conta); quem tem permissão confirma o vínculo na tela do Financeiro, e a conta é baixada com a saída como evidência. Pendências que não casam ficam na Central de Conferências.",
  BAIXA_POR_COMPROVANTE: "Quando um comprovante de pagamento chega, ele é lido, conferido contra as contas em aberto da unidade (fornecedor, valor e data) e vira uma proposta de baixa. A baixa só é aplicada por quem tem a permissão de pagar; diferenças de valor (juros, pagamento parcial) são perguntadas antes.",
  FECHAMENTO_DE_ENTREGADORES: "Os entregadores próprios são fechados por SEMANA (segunda a domingo): entregas e valores da semana viram uma conta a pagar por entregador quando a semana é oficialmente fechada; o pagamento é baixado por comprovante ou na tela.",
  COMPETENCIA: "Competência é o mês a que um valor pertence (não a data em que foi pago). A apuração do mês (DRE) usa a competência; uma competência pode estar aberta, em revisão ou fechada.",
  DOCUMENTOS: "Notas, comprovantes e extratos ficam no cofre documental com o hash do arquivo; cada documento pode ser vinculado a uma conta, pagamento ou movimento, e um documento novo pode substituir outro sem apagar o histórico.",
  CAIXA_FISICO: "O caixa físico é uma conta da unidade com saldo calculado pelos movimentos (vendas em dinheiro, sangrias, suprimentos) e saldo informado na contagem; a diferença entre os dois aparece em Caixa e Bancos.",
});
const CAMINHOS = Object.freeze({
  RETIRADA_DO_CAIXA: "Registrar a retirada como movimento do caixa físico na tela Caixa e Bancos do Financeiro (pela conversa ainda não é registrado).",
  DESPESA_JA_PAGA: "Enviar o comprovante (foto ou PDF) aqui no MOVA: ele segue o fluxo de documentos (conferência na Central). O lançamento pela conversa ainda não está habilitado; pode ser feito na tela do Financeiro.",
  PAGAMENTO_DE_CONTA_EXISTENTE: "Enviar o comprovante (foto ou PDF) aqui no MOVA: ele segue o fluxo de documentos (conferência com a conta em aberto na Central). A baixa pela conversa ainda não está habilitada; pode ser feita na tela do Financeiro.",
  COMPRA_NOVA_PAGA: "Enviar o comprovante (foto ou PDF) aqui no MOVA: ele segue o fluxo de documentos (conferência na Central). A criação da despesa pela conversa ainda não está habilitada; pode ser feita na tela do Financeiro.",
  OUTRO: "Registrar na tela do Financeiro.",
});

FERRAMENTAS.push(FERRAMENTA_ANALISAR); // F2: análise genérica parametrizada

export const CATALOGO = Object.freeze(Object.fromEntries(FERRAMENTAS.map((f) => [f.nome, Object.freeze(f)])));
/** Operações do núcleo que o catálogo usa (a porta do MOVA CORE só permite estas — todas leituras via b.consultar). */
export const OPERACOES_DO_CATALOGO = Object.freeze([...new Set(FERRAMENTAS.flatMap((f) => f.ops ?? []))]);

/** Definições no formato da API (tools), em ordem estável (prefixo cacheável). */
export function definicoesParaApi(nomes = FERRAMENTAS.map((f) => f.nome)) {
  return FERRAMENTAS.filter((f) => nomes.includes(f.nome)).map((f) => ({ name: f.nome, description: f.descricao, input_schema: f.esquema }));
}
