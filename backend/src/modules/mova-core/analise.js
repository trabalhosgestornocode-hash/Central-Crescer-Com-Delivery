// MOVA CORE — F2: FERRAMENTA GENÉRICA DE ANÁLISE (`analisar`). Responde perguntas nunca programadas sem criar uma ferramenta por
// pergunta: o modelo escolhe MÉTRICA × AGRUPAMENTO × COMPETÊNCIAS × UNIDADES × FILTRO × ORDEM, e o CÓDIGO busca, agrupa, ordena,
// compara e calcula. Só métricas e dimensões desta lista existem (nunca SQL, nunca acesso livre ao banco): cada uma é atendida
// pelas MESMAS leituras oficiais do Financeiro v2 (porta.ler → b.consultar), com o escopo injetado pelo servidor.
// Várias unidades: só as permitidas NESTA conversa, e cada uma com a concessão `financeiro_v2.ver` relida agora.
import { COMPETENCIA, TEXTO_CURTO } from "./esquema.js";
import { bate, itemAPagar, todasAsPaginas } from "./catalogo.js";

const ACAO_VER = "financeiro_v2.ver";
const CANAIS = ["BALCAO", "IFOOD", "ANOTA_AI", "NOVENTA_E_NOVE_FOOD", "OUTRO"];

/** Métrica → de onde vem, que agrupamentos aceita, e o SIGNIFICADO do fato (o verificador distingue despesa × pagamento × em aberto). */
export const METRICAS = Object.freeze({
  DESPESAS: { fonte: "CONTAS", campo: "valorCentavos", significado: "VALOR_DAS_CONTAS:ANALISE", agrupa: ["NENHUM", "FORNECEDOR", "CATEGORIA", "UNIDADE"], rotulo: "despesas (valor das contas da competência)" },
  PAGAMENTOS: { fonte: "CONTAS", campo: "pagoCentavos", significado: "PAGO:ANALISE", agrupa: ["NENHUM", "FORNECEDOR", "CATEGORIA", "UNIDADE"], rotulo: "pagamentos feitos" },
  EM_ABERTO: { fonte: "CONTAS", campo: "saldoCentavos", significado: "A_PAGAR_EM_ABERTO:ANALISE", agrupa: ["NENHUM", "FORNECEDOR", "CATEGORIA", "UNIDADE"], rotulo: "saldo em aberto" },
  VENDAS_BRUTAS: { fonte: "VENDAS", campo: "brutoCentavos", significado: "VENDAS:brutoCentavos:ANALISE", agrupa: ["NENHUM", "CANAL", "UNIDADE"], rotulo: "vendas brutas" },
  VENDAS_LIQUIDAS: { fonte: "VENDAS", campo: "liquidoCentavos", significado: "VENDAS:liquidoCentavos:ANALISE", agrupa: ["NENHUM", "CANAL", "UNIDADE"], rotulo: "vendas líquidas" },
  QUANTIDADE_DE_VENDAS: { fonte: "VENDAS", campo: "quantidade", monetario: false, agrupa: ["NENHUM", "CANAL", "UNIDADE"], rotulo: "quantidade de vendas" },
  ENTREGAS: { fonte: "ENTREGADORES", campo: "entregas", monetario: false, agrupa: ["NENHUM", "ENTREGADOR", "UNIDADE"], rotulo: "entregas" },
  CUSTO_DE_ENTREGADORES: { fonte: "ENTREGADORES", campo: "aPagarCentavos", significado: "ENTREGADOR_A_PAGAR:ANALISE", agrupa: ["NENHUM", "ENTREGADOR", "UNIDADE"], rotulo: "custo de entregadores próprios" },
});
const AGRUPAMENTOS = ["NENHUM", "FORNECEDOR", "CATEGORIA", "CANAL", "ENTREGADOR", "UNIDADE"];
const MAX_LEITURAS = 30;

async function linhasDeUmaUnidade({ porta, escopo, metrica, competencia, agruparPor, termo, leituras }) {
  const m = METRICAS[metrica];
  const conta = () => { if (++leituras.n > MAX_LEITURAS) throw Object.assign(new Error("muitas leituras"), { codigo: "ANALISE_GRANDE_DEMAIS" }); };
  if (m.fonte === "CONTAS") {
    conta();
    const r = await todasAsPaginas(porta, "consultarContasAPagar", escopo, { competencia });
    const itens = (r.itens ?? []).filter((t) => t.situacao !== "CANCELADO").map(itemAPagar).filter((t) => !termo || bate(termo, t.fornecedor, t.descricao, t.categoria));
    const chave = (t) => (agruparPor === "FORNECEDOR" ? t.fornecedor ?? t.descricao ?? "—" : agruparPor === "CATEGORIA" ? t.categoria ?? "Sem categoria" : null);
    const g = new Map();
    for (const t of itens) { const k = chave(t); g.set(k, (g.get(k) ?? 0) + (t[m.campo] ?? 0)); }
    return [...g.entries()].map(([grupo, valor]) => ({ grupo, valor, itens: itens.filter((t) => chave(t) === grupo).length }));
  }
  if (m.fonte === "VENDAS") {
    const canais = agruparPor === "CANAL" ? CANAIS : [null];
    const out = [];
    for (const canal of canais) {
      conta();
      const r = await porta.ler("consultarVendas", escopo, { competencia, ...(canal ? { canal } : {}), tamanho: 1 });
      const v = r?.resumo?.[m.campo];
      if (Number.isFinite(v) && (canal === null || v !== 0)) out.push({ grupo: canal, valor: v });
    }
    return out;
  }
  conta();
  const r = await porta.ler("consultarEntregadoresProprios", escopo, { mes: competencia });
  const linhas = (r?.entregadores ?? r?.linhas ?? r?.itens ?? []).map((e) => ({ nome: e.nome ?? e.entregador ?? "—", entregas: e.entregas ?? e.quantidadeEntregas ?? 0, aPagarCentavos: e.totalCentavos ?? e.aPagarCentavos ?? e.valorCentavos ?? 0 }))
    .filter((e) => !termo || bate(termo, e.nome));
  if (agruparPor === "ENTREGADOR") return linhas.map((e) => ({ grupo: e.nome, valor: e[m.campo] ?? 0 }));
  return [{ grupo: null, valor: linhas.reduce((a, e) => a + (e[m.campo] ?? 0), 0) }];
}

export const FERRAMENTA_ANALISAR = Object.freeze({
  nome: "analisar",
  descricao: "Análise flexível (perguntas que nenhuma outra ferramenta responde direto): escolha a MÉTRICA, como AGRUPAR, as COMPETÊNCIAS (1 a 6 meses, para comparar meses ou ver tendência), se compara TODAS as unidades da conversa, um filtro de texto e a ordem. O código busca, agrupa, ordena, soma, compara (diferença e variação % entre a 1ª e a última competência) e devolve linhas prontas. Ex.: 'qual fornecedor mais cresceu de outubro para novembro', 'top 5 categorias de despesa', 'qual loja vendeu mais no iFood', 'entregas por entregador no mês'.",
  esquema: { type: "object", properties: {
    metrica: { type: "string", enum: Object.keys(METRICAS), description: "DESPESAS = valor das contas da competência (não é pagamento). PAGAMENTOS = o que foi pago. EM_ABERTO = saldo a pagar." },
    agruparPor: { type: "string", enum: AGRUPAMENTOS },
    competencias: { type: "array", maxItems: 6, items: COMPETENCIA, description: "Meses AAAA-MM, do mais antigo ao mais recente." },
    todasAsUnidades: { type: "boolean", description: "true = cada unidade que esta pessoa pode consultar nesta conversa, lado a lado." },
    termo: { ...TEXTO_CURTO, description: "Filtro por nome/descrição (fornecedor, entregador, item)." },
    ordem: { type: "string", enum: ["MAIOR_PRIMEIRO", "MENOR_PRIMEIRO", "MAIOR_CRESCIMENTO", "MAIOR_QUEDA"] },
    limite: { type: "integer", description: "Quantas linhas devolver (1 a 20)." },
  }, required: ["metrica", "competencias"] },
  valores: true, ops: ["consultarContasAPagar", "consultarVendas", "consultarEntregadoresProprios"],
  async executar({ porta, escopo, args, sessao }) {
    const m = METRICAS[args.metrica];
    const agruparPor = args.agruparPor ?? "NENHUM";
    if (!m.agrupa.includes(agruparPor)) return { erro: "AGRUPAMENTO_NAO_SUPORTADO", dados: { mensagem: `${args.metrica} agrupa só por: ${m.agrupa.join(", ")}.` }, fatos: [] };
    const competencias = [...new Set(args.competencias)].sort();
    if (!competencias.length) return { erro: "ARGUMENTO_INVALIDO", dados: { mensagem: "Informe ao menos uma competência." }, fatos: [] };
    const limite = Math.min(20, Math.max(1, Number.isInteger(args.limite) ? args.limite : 10));
    const porUnidade = args.todasAsUnidades || agruparPor === "UNIDADE";
    const unidades = porUnidade ? sessao.unidadesPermitidas : sessao.unidadesPermitidas.filter((u) => u.id === escopo.unidadeId);
    const leituras = { n: 0 }; const semPermissao = [];
    const brutas = [];
    for (const u of unidades) {
      const esc = Object.freeze({ ...escopo, unidadeId: u.id });
      if (u.id !== escopo.unidadeId) { // a unidade da conversa já foi conferida pelo executor; as outras são conferidas AGORA
        const acoes = await porta.permissoesDoUsuario(esc).catch(() => []);
        if (!(acoes ?? []).includes(ACAO_VER)) { semPermissao.push(u.nome); continue; }
      }
      for (const competencia of competencias) {
        try {
          for (const l of await linhasDeUmaUnidade({ porta, escopo: esc, metrica: args.metrica, competencia, agruparPor: agruparPor === "UNIDADE" ? "NENHUM" : agruparPor, termo: args.termo, leituras }))
            brutas.push({ unidade: u.nome, unidadeId: u.id, competencia, grupo: agruparPor === "UNIDADE" ? u.nome : l.grupo, valor: l.valor });
        } catch (e) { if (e.codigo === "ANALISE_GRANDE_DEMAIS") return { erro: e.codigo, dados: { mensagem: "Análise grande demais: reduza meses, unidades ou agrupamento." }, fatos: [] }; throw e; }
      }
    }
    // série por (unidade, grupo): valor em cada competência + diferença e variação entre a primeira e a última
    const series = new Map();
    for (const b of brutas) { const k = `${b.unidadeId}|${b.grupo ?? ""}`; if (!series.has(k)) series.set(k, { unidade: b.unidade, unidadeId: b.unidadeId, grupo: b.grupo, porCompetencia: {} }); series.get(k).porCompetencia[b.competencia] = (series.get(k).porCompetencia[b.competencia] ?? 0) + b.valor; }
    const [ini, fim] = [competencias[0], competencias.at(-1)];
    const linhas = [...series.values()].map((s) => {
      const a = s.porCompetencia[ini] ?? 0; const z = s.porCompetencia[fim] ?? 0;
      return { ...s, total: Object.values(s.porCompetencia).reduce((x, y) => x + y, 0), ...(competencias.length > 1 ? { diferenca: z - a, variacaoPercentual: a !== 0 ? Math.round(((z - a) / Math.abs(a)) * 1000) / 10 : null } : {}) };
    });
    const ordem = args.ordem ?? "MAIOR_PRIMEIRO";
    const chaveOrdem = (l) => (ordem.startsWith("MAIOR_C") ? l.diferenca ?? l.total : ordem === "MAIOR_QUEDA" ? -(l.diferenca ?? l.total) : ordem === "MENOR_PRIMEIRO" ? -(l.porCompetencia[fim] ?? 0) : l.porCompetencia[fim] ?? l.total);
    linhas.sort((x, y) => chaveOrdem(y) - chaveOrdem(x));
    const devolvidas = linhas.slice(0, limite);
    const monetario = m.monetario !== false;
    const fatos = []; const numeros = [];
    for (const l of devolvidas) {
      for (const [comp, v] of Object.entries(l.porCompetencia)) {
        if (monetario && Number.isInteger(v)) fatos.push({ valorCentavos: v, significado: m.significado, entidade: l.grupo ?? null, periodo: comp, unidadeId: l.unidadeId, unidade: l.unidade });
        else if (Number.isInteger(v)) numeros.push(v);
      }
      if (monetario && Number.isInteger(l.diferenca)) fatos.push({ valorCentavos: l.diferenca, significado: "CALCULO:DIFERENCA", entidade: l.grupo ?? l.unidade, periodo: `${ini}..${fim}`, unidadeId: l.unidadeId, unidade: l.unidade, derivado: true });
      if (Number.isInteger(l.total) && monetario && competencias.length > 1) fatos.push({ valorCentavos: l.total, significado: "CALCULO:SOMA", entidade: l.grupo ?? l.unidade, periodo: `${ini}..${fim}`, unidadeId: l.unidadeId, unidade: l.unidade, derivado: true });
    }
    return { dados: { metrica: m.rotulo, agrupamento: agruparPor, competencias, linhas: devolvidas, linhasOmitidas: Math.max(0, linhas.length - devolvidas.length), unidadesSemPermissao: semPermissao, valoresEm: monetario ? "centavos" : "quantidade" }, fatos, numeros };
  },
});
