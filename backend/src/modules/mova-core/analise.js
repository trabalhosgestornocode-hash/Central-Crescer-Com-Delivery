// MOVA CORE — F2/F3: FERRAMENTA GENÉRICA DE ANÁLISE (`analisar`). Responde perguntas nunca programadas sem criar uma ferramenta por
// pergunta: o modelo escolhe MÉTRICA × AGRUPAMENTO × PERÍODO × UNIDADES × FILTRO × ORDEM, e o CÓDIGO busca, agrupa, ordena,
// compara e calcula (soma, diferença, variação %, participação no total, média, tendência). Só métricas e dimensões desta lista
// existem (nunca SQL, nunca acesso livre ao banco): cada uma é atendida pelas MESMAS leituras oficiais do Financeiro v2
// (porta.ler → b.consultar), com o escopo injetado pelo servidor.
// Várias unidades: só as permitidas NESTA conversa, e cada uma com a concessão `financeiro_v2.ver` relida agora.
// COBERTURA: o resultado diz o que entrou e o que ficou de fora (unidade sem permissão, mês sem dado, leitura truncada, linhas
// omitidas). Recorte parcial NUNCA sai como total consolidado.
import { COMPETENCIA, TEXTO_CURTO } from "./esquema.js";
import { bate, itemAPagar, todasAsPaginas } from "./leituras.js";
import { emReais } from "./executor.js";

const ACAO_VER = "financeiro_v2.ver";
const CANAIS = ["BALCAO", "IFOOD", "ANOTA_AI", "NOVENTA_E_NOVE_FOOD", "OUTRO"];

/**
 * Métrica → fonte, agrupamentos com significado, e o SIGNIFICADO do fato (o verificador distingue despesa × pagamento × em aberto).
 * Métricas de RAZÃO (média) somam numerador e denominador separadamente e dividem no fim — nunca média de médias.
 */
export const METRICAS = Object.freeze({
  DESPESAS: { fonte: "CONTAS", campo: "valorCentavos", significado: "VALOR_DAS_CONTAS:ANALISE", agrupa: ["NENHUM", "FORNECEDOR", "CATEGORIA", "UNIDADE"], rotulo: "despesas (valor das contas da competência)" },
  PAGAMENTOS: { fonte: "CONTAS", campo: "pagoCentavos", significado: "PAGO:ANALISE", agrupa: ["NENHUM", "FORNECEDOR", "CATEGORIA", "UNIDADE"], rotulo: "pagamentos feitos (contas da competência)" },
  EM_ABERTO: { fonte: "CONTAS", campo: "saldoCentavos", significado: "A_PAGAR_EM_ABERTO:ANALISE", agrupa: ["NENHUM", "FORNECEDOR", "CATEGORIA", "UNIDADE"], rotulo: "saldo em aberto", posicao: true },
  VENDAS_BRUTAS: { fonte: "VENDAS", campo: "brutoCentavos", significado: "VENDAS:brutoCentavos:ANALISE", agrupa: ["NENHUM", "CANAL", "UNIDADE"], rotulo: "vendas brutas" },
  VENDAS_LIQUIDAS: { fonte: "VENDAS", campo: "liquidoCentavos", significado: "VENDAS:liquidoCentavos:ANALISE", agrupa: ["NENHUM", "CANAL", "UNIDADE"], rotulo: "vendas líquidas" },
  QUANTIDADE_DE_VENDAS: { fonte: "VENDAS", campo: "quantidade", monetario: false, agrupa: ["NENHUM", "CANAL", "UNIDADE"], rotulo: "quantidade de vendas" },
  TICKET_MEDIO: { fonte: "VENDAS", razao: ["brutoCentavos", "quantidade"], significado: "CALCULO:MEDIA:TICKET", agrupa: ["NENHUM", "CANAL", "UNIDADE"], rotulo: "ticket médio (vendas brutas ÷ quantidade de vendas)" },
  ENTREGAS: { fonte: "ENTREGADORES", campo: "entregas", monetario: false, agrupa: ["NENHUM", "ENTREGADOR", "UNIDADE"], rotulo: "quantidade de entregas" },
  CUSTO_DE_ENTREGADORES: { fonte: "ENTREGADORES", campo: "aPagarCentavos", significado: "ENTREGADOR_A_PAGAR:ANALISE", agrupa: ["NENHUM", "ENTREGADOR", "UNIDADE"], rotulo: "custo de entregadores próprios" },
  CUSTO_POR_ENTREGA: { fonte: "ENTREGADORES", razao: ["aPagarCentavos", "entregas"], significado: "CALCULO:MEDIA:POR_ENTREGA", agrupa: ["NENHUM", "ENTREGADOR", "UNIDADE"], rotulo: "custo médio por entrega (custo ÷ entregas)" },
});
const AGRUPAMENTOS = ["NENHUM", "FORNECEDOR", "CATEGORIA", "CANAL", "ENTREGADOR", "UNIDADE"];
// 25/11 (homologação real): o modelo pedia combinações que a análise não tem (AGRUPAMENTO_NAO_SUPORTADO). O esquema agora diz,
// a partir de METRICAS (a mesma fonte da validação), exatamente quais agrupamentos cada métrica aceita.
const COMBINACOES_VALIDAS = `SÓ estas combinações existem — ${Object.entries(METRICAS).map(([k, m]) => `${k}: ${m.agrupa.join("/")}`).join("; ")}. Valor devido por entregador: use devido_aos_entregadores (não analisar).`;
/** Matriz de compatibilidade métrica × dimensão (fonte única: METRICAS.agrupa). Fora dela, a análise é recusada com explicação. */
export const MATRIZ_DE_COMPATIBILIDADE = Object.freeze(Object.fromEntries(Object.entries(METRICAS).map(([k, m]) => [k, Object.freeze(Object.fromEntries(AGRUPAMENTOS.map((a) => [a, m.agrupa.includes(a)])))])));
export const PERIODOS_RELATIVOS = Object.freeze(["MES_ATUAL", "MES_ANTERIOR", "ULTIMOS_3_MESES", "ULTIMOS_6_MESES", "ANO_ATUAL"]);
const MAX_LEITURAS = 30;
const MAX_COMPETENCIAS = 6;

/** Período relativo → competências (AAAA-MM), a partir da data de HOJE da conversa (servidor), nunca da memória do modelo. */
export function competenciasDoPeriodo(periodo, hoje) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(hoje ?? ""))) return null;
  const [a, m] = hoje.split("-").map(Number);
  const mes = (k) => { const d = new Date(Date.UTC(a, m - 1 - k, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
  const ultimos = (n) => Array.from({ length: n }, (_, i) => mes(n - 1 - i));
  switch (periodo) {
    case "MES_ATUAL": return [mes(0)];
    case "MES_ANTERIOR": return [mes(1)];
    case "ULTIMOS_3_MESES": return ultimos(3);
    case "ULTIMOS_6_MESES": return ultimos(6);
    case "ANO_ATUAL": return ultimos(m); // pode passar de 6: a análise recusa e pede recorte menor
    default: return null;
  }
}

async function linhasDeUmaUnidade({ porta, escopo, m, competencia, agruparPor, termo, leituras }) {
  const conta = () => { if (++leituras.n > MAX_LEITURAS) throw Object.assign(new Error("muitas leituras"), { codigo: "ANALISE_GRANDE_DEMAIS" }); };
  const campos = m.razao ?? [m.campo];
  if (m.fonte === "CONTAS") {
    conta();
    const r = await todasAsPaginas(porta, "consultarContasAPagar", escopo, { competencia });
    if (r.truncado) leituras.truncadas.push(`${escopo.unidadeId}|${competencia}`);
    const itens = (r.itens ?? []).filter((t) => t.situacao !== "CANCELADO").map(itemAPagar).filter((t) => !termo || bate(termo, t.fornecedor, t.descricao, t.categoria));
    const chave = (t) => (agruparPor === "FORNECEDOR" ? t.fornecedor ?? t.descricao ?? "—" : agruparPor === "CATEGORIA" ? t.categoria ?? "Sem categoria" : null);
    const g = new Map();
    for (const t of itens) { const k = chave(t); g.set(k, (g.get(k) ?? 0) + (t[m.campo] ?? 0)); }
    return [...g.entries()].map(([grupo, valor]) => ({ grupo, valores: [valor] }));
  }
  if (m.fonte === "VENDAS") {
    const canais = agruparPor === "CANAL" ? CANAIS : [null];
    const out = [];
    for (const canal of canais) {
      conta();
      const r = await porta.ler("consultarVendas", escopo, { competencia, ...(canal ? { canal } : {}), tamanho: 1 });
      const vs = campos.map((c) => r?.resumo?.[c]);
      if (vs.every(Number.isFinite) && (canal === null || vs.some((v) => v !== 0))) out.push({ grupo: canal, valores: vs });
    }
    return out;
  }
  conta();
  const r = await porta.ler("consultarEntregadoresProprios", escopo, { mes: competencia });
  const linhas = (r?.entregadores ?? r?.linhas ?? r?.itens ?? []).map((e) => ({ nome: e.nome ?? e.entregador ?? "—", entregas: e.entregas ?? e.quantidadeEntregas ?? 0, aPagarCentavos: e.totalCentavos ?? e.aPagarCentavos ?? e.valorCentavos ?? 0 }))
    .filter((e) => !termo || bate(termo, e.nome));
  if (agruparPor === "ENTREGADOR") return linhas.map((e) => ({ grupo: e.nome, valores: campos.map((c) => e[c] ?? 0) }));
  return linhas.length ? [{ grupo: null, valores: campos.map((c) => linhas.reduce((a, e) => a + (e[c] ?? 0), 0)) }] : [];
}

const pct = (x) => Math.round(x * 1000) / 10; // 1 casa decimal, sempre pelo código
/** Tendência pela inclinação da reta (mínimos quadrados) relativa à média: ±2% por mês ou mais = ALTA/QUEDA. */
function tendenciaDe(valores) {
  const ys = valores.filter(Number.isFinite);
  if (ys.length < 3) return null;
  const n = ys.length; const xm = (n - 1) / 2; const ym = ys.reduce((a, b) => a + b, 0) / n;
  const incl = ys.reduce((a, y, i) => a + (i - xm) * (y - ym), 0) / ys.reduce((a, _, i) => a + (i - xm) ** 2, 0);
  if (ym === 0) return incl > 0 ? "ALTA" : incl < 0 ? "QUEDA" : "ESTAVEL";
  const rel = incl / Math.abs(ym);
  return rel >= 0.02 ? "ALTA" : rel <= -0.02 ? "QUEDA" : "ESTAVEL";
}

export const FERRAMENTA_ANALISAR = Object.freeze({
  nome: "analisar",
  descricao: "Análise flexível (perguntas que nenhuma outra ferramenta responde direto): escolha a MÉTRICA, como AGRUPAR, o PERÍODO (relativo, como MES_ANTERIOR ou ULTIMOS_3_MESES, ou as COMPETÊNCIAS AAAA-MM, até 6), se compara TODAS as unidades da conversa, um filtro de texto e a ordem. O código busca, agrupa, ordena, soma, compara (diferença e variação % entre a 1ª e a última competência), calcula a PARTICIPAÇÃO de cada linha no total, médias (ticket médio, custo por entrega) e a TENDÊNCIA (3+ meses). O resultado traz a COBERTURA: se não estiver completo, não apresente como total. Ex.: 'qual fornecedor mais cresceu de outubro para novembro', 'top 5 categorias de despesa e quanto cada uma pesa', 'qual loja vendeu mais no iFood', 'custo por entrega de cada entregador no mês'.",
  esquema: { type: "object", properties: {
    metrica: { type: "string", enum: Object.keys(METRICAS), description: "DESPESAS = valor das contas da competência (não é pagamento). PAGAMENTOS = o que foi pago. EM_ABERTO = saldo a pagar. TICKET_MEDIO e CUSTO_POR_ENTREGA são médias calculadas pelo código." },
    agruparPor: { type: "string", enum: AGRUPAMENTOS, description: COMBINACOES_VALIDAS },
    periodo: { type: "string", enum: PERIODOS_RELATIVOS, description: "Período relativo à data de hoje da conversa (use no lugar de competencias)." },
    competencias: { type: "array", maxItems: MAX_COMPETENCIAS, items: COMPETENCIA, description: "Meses AAAA-MM, do mais antigo ao mais recente (ou use 'periodo')." },
    todasAsUnidades: { type: "boolean", description: "true = cada unidade que esta pessoa pode consultar nesta conversa, lado a lado." },
    termo: { ...TEXTO_CURTO, description: "Filtro por nome/descrição (fornecedor, entregador, item). Aceita singular/plural e erros leves." },
    ordem: { type: "string", enum: ["MAIOR_PRIMEIRO", "MENOR_PRIMEIRO", "MAIOR_CRESCIMENTO", "MAIOR_QUEDA"] },
    limite: { type: "integer", description: "Quantas linhas devolver (1 a 20)." },
  }, required: ["metrica"] },
  valores: true, ops: ["consultarContasAPagar", "consultarVendas", "consultarEntregadoresProprios"],
  async executar({ porta, escopo, args, sessao }) {
    const m = METRICAS[args.metrica];
    if (!m) return { erro: "ARGUMENTO_INVALIDO", dados: { mensagem: `Métrica desconhecida. Existem: ${Object.keys(METRICAS).join(", ")}.` }, fatos: [] };
    const agruparPor = args.agruparPor ?? "NENHUM";
    if (!m.agrupa.includes(agruparPor)) return { erro: "AGRUPAMENTO_NAO_SUPORTADO", dados: { mensagem: `${args.metrica} agrupa só por: ${m.agrupa.join(", ")} (${agruparPor} não tem significado para ${m.rotulo}). Métricas que agrupam por ${agruparPor}: ${Object.entries(METRICAS).filter(([, x]) => x.agrupa.includes(agruparPor)).map(([k]) => k).join(", ") || "nenhuma"}.` }, fatos: [] };
    let competencias = args.competencias?.length ? [...new Set(args.competencias)].sort() : null;
    if (!competencias && args.periodo) {
      competencias = competenciasDoPeriodo(args.periodo, sessao.hoje);
      if (!competencias) return { erro: "ARGUMENTO_INVALIDO", dados: { mensagem: "Não sei a data de hoje desta conversa: informe as competências (AAAA-MM)." }, fatos: [] };
    }
    if (!competencias?.length) return { erro: "ARGUMENTO_INVALIDO", dados: { mensagem: "Informe o período: 'periodo' relativo ou ao menos uma competência." }, fatos: [] };
    if (competencias.length > MAX_COMPETENCIAS) return { erro: "ANALISE_GRANDE_DEMAIS", dados: { mensagem: `No máximo ${MAX_COMPETENCIAS} meses por análise (${competencias.length} pedidos): divida o período.` }, fatos: [] };
    const limite = Math.min(20, Math.max(1, Number.isInteger(args.limite) ? args.limite : 10));
    const porUnidade = args.todasAsUnidades || agruparPor === "UNIDADE";
    const unidades = porUnidade ? sessao.unidadesPermitidas : sessao.unidadesPermitidas.filter((u) => u.id === escopo.unidadeId);
    const leituras = { n: 0, truncadas: [] }; const semPermissao = []; const consultadas = [];
    const brutas = []; const semDados = new Set();
    for (const u of unidades) {
      const esc = Object.freeze({ ...escopo, unidadeId: u.id });
      if (u.id !== escopo.unidadeId) { // a unidade da conversa já foi conferida pelo executor; as outras são conferidas AGORA
        const acoes = await porta.permissoesDoUsuario(esc).catch(() => []);
        if (!(acoes ?? []).includes(ACAO_VER)) { semPermissao.push(u.nome); continue; }
      }
      consultadas.push(u.nome);
      for (const competencia of competencias) {
        try {
          const ls = await linhasDeUmaUnidade({ porta, escopo: esc, m, competencia, agruparPor: agruparPor === "UNIDADE" ? "NENHUM" : agruparPor, termo: args.termo, leituras });
          if (!ls.length) semDados.add(`${u.nome} ${competencia}`);
          for (const l of ls) brutas.push({ unidade: u.nome, unidadeId: u.id, competencia, grupo: agruparPor === "UNIDADE" ? u.nome : l.grupo, valores: l.valores });
        } catch (e) { if (e.codigo === "ANALISE_GRANDE_DEMAIS") return { erro: e.codigo, dados: { mensagem: "Análise grande demais: reduza meses, unidades ou agrupamento." }, fatos: [] }; throw e; }
      }
    }
    // série por (unidade, grupo): acumuladores por competência (razão: numerador e denominador separados)
    const series = new Map();
    // agrupado por UNIDADE, o "grupo" é a própria unidade: participação e totais comparam unidades entre si
    const chaveSerie = (b) => (agruparPor === "UNIDADE" ? `U|${b.unidadeId}` : `${b.unidadeId}|${b.grupo ?? ""}`);
    for (const b of brutas) {
      const k = chaveSerie(b);
      if (!series.has(k)) series.set(k, { unidade: b.unidade, unidadeId: b.unidadeId, grupo: b.grupo, acc: {} });
      const s = series.get(k); const a = (s.acc[b.competencia] ??= b.valores.map(() => 0));
      b.valores.forEach((v, i) => { a[i] += v; });
    }
    const valorDe = (acc) => (m.razao ? (acc[1] > 0 ? Math.round(acc[0] / acc[1]) : null) : acc[0]);
    const [ini, fim] = [competencias[0], competencias.at(-1)];
    // totais por (escopo da participação, competência): por unidade, ou entre unidades quando o agrupamento é a unidade
    const escopoPart = (s) => (agruparPor === "UNIDADE" ? "*" : s.unidadeId);
    const totaisPart = new Map();
    if (!m.razao) for (const s of series.values()) for (const [c, acc] of Object.entries(s.acc)) { const k = `${escopoPart(s)}|${c}`; totaisPart.set(k, (totaisPart.get(k) ?? 0) + acc[0]); }
    const linhas = [...series.values()].map((s) => {
      const porCompetencia = Object.fromEntries(competencias.filter((c) => s.acc[c]).map((c) => [c, valorDe(s.acc[c])]));
      const a = porCompetencia[ini] ?? (m.razao ? null : 0); const z = porCompetencia[fim] ?? (m.razao ? null : 0);
      const somaAcc = competencias.reduce((acc, c) => (s.acc[c] ? acc.map((x, i) => x + s.acc[c][i]) : acc), (m.razao ?? [m.campo]).map(() => 0));
      const tot = valorDe(somaAcc);
      const linha = { unidade: s.unidade, unidadeId: s.unidadeId, grupo: s.grupo, porCompetencia, [m.razao ? "mediaDoPeriodo" : "total"]: tot };
      if (competencias.length > 1 && Number.isFinite(a) && Number.isFinite(z)) Object.assign(linha, { diferenca: z - a, variacaoPercentual: a !== 0 ? pct((z - a) / Math.abs(a)) : null });
      if (!m.razao && agruparPor !== "NENHUM") {
        const t = totaisPart.get(`${escopoPart(s)}|${fim}`) ?? 0;
        if (t > 0 && Number.isFinite(porCompetencia[fim])) linha.participacaoPercentual = pct(porCompetencia[fim] / t);
      }
      const tend = tendenciaDe(competencias.map((c) => porCompetencia[c]));
      if (tend) linha.tendencia = tend;
      return linha;
    });
    const ordem = args.ordem ?? "MAIOR_PRIMEIRO";
    const ultimo = (l) => l.porCompetencia[fim] ?? l.total ?? l.mediaDoPeriodo ?? 0;
    const chaveOrdem = (l) => (ordem === "MAIOR_CRESCIMENTO" ? l.diferenca ?? -Infinity : ordem === "MAIOR_QUEDA" ? -(l.diferenca ?? Infinity) : ordem === "MENOR_PRIMEIRO" ? -ultimo(l) : ultimo(l));
    linhas.sort((x, y) => chaveOrdem(y) - chaveOrdem(x));
    const devolvidas = linhas.slice(0, limite);
    const monetario = m.monetario !== false;
    const cobertura = {
      unidadesConsultadas: consultadas, unidadesSemPermissao: semPermissao, mesesSemDados: [...semDados], leituraTruncada: leituras.truncadas.length > 0,
      linhasOmitidas: Math.max(0, linhas.length - devolvidas.length),
    };
    cobertura.completa = !semPermissao.length && !cobertura.leituraTruncada;
    if (!cobertura.completa) cobertura.aviso = "RECORTE PARCIAL: não apresente estes números como total consolidado; diga o que ficou de fora.";
    if (m.posicao) cobertura.posicaoEm = sessao.hoje ?? null; // saldo em aberto é posição de AGORA (muda com pagamentos)
    const fatos = []; const numeros = [];
    const sig = m.significado;
    for (const l of devolvidas) {
      const ent = l.grupo ?? l.unidade;
      for (const [comp, v] of Object.entries(l.porCompetencia)) {
        if (!Number.isFinite(v)) continue;
        if (monetario) fatos.push({ valorCentavos: v, significado: sig, entidade: l.grupo ?? null, periodo: comp, unidadeId: l.unidadeId, unidade: l.unidade, ...(m.razao ? { derivado: true } : {}) });
        else numeros.push(v);
      }
      if (monetario && Number.isInteger(l.diferenca)) fatos.push({ valorCentavos: l.diferenca, significado: "CALCULO:DIFERENCA", entidade: ent, periodo: `${ini}..${fim}`, unidadeId: l.unidadeId, unidade: l.unidade, derivado: true });
      else if (Number.isFinite(l.diferenca)) numeros.push(l.diferenca);
      if (monetario && !m.razao && Number.isInteger(l.total) && competencias.length > 1) fatos.push({ valorCentavos: l.total, significado: "CALCULO:SOMA", entidade: ent, periodo: `${ini}..${fim}`, unidadeId: l.unidadeId, unidade: l.unidade, derivado: true });
      if (m.razao && Number.isInteger(l.mediaDoPeriodo) && competencias.length > 1) fatos.push({ valorCentavos: l.mediaDoPeriodo, significado: sig, entidade: ent, periodo: `${ini}..${fim}`, unidadeId: l.unidadeId, unidade: l.unidade, derivado: true });
      if (Number.isFinite(l.variacaoPercentual)) fatos.push({ valorCentavos: null, percentual: l.variacaoPercentual, significado: "CALCULO:VARIACAO_PERCENTUAL", entidade: ent, periodo: `${ini}..${fim}`, unidadeId: l.unidadeId, derivado: true });
      if (Number.isFinite(l.participacaoPercentual)) fatos.push({ valorCentavos: null, percentual: l.participacaoPercentual, significado: "CALCULO:PARTICIPACAO", entidade: ent, periodo: fim, unidadeId: l.unidadeId, derivado: true });
    }
    // total do conjunto devolvido (só como "total das linhas mostradas"; consolidado apenas com cobertura completa e sem omissões)
    const totalGeral = !m.razao && monetario ? devolvidas.reduce((a, l) => a + (l.porCompetencia[fim] ?? 0), 0) : null;
    const consolidado = cobertura.completa && cobertura.linhasOmitidas === 0;
    if (Number.isInteger(totalGeral) && agruparPor !== "NENHUM") fatos.push({ valorCentavos: totalGeral, significado: consolidado ? "CALCULO:SOMA" : "CALCULO:SOMA:RECORTE", entidade: consolidado ? null : "linhas mostradas", periodo: fim, derivado: true });
    // valores monetários também JÁ EM REAIS (formatados pelo código: o modelo cita, não converte)
    const r$ = (v) => (Number.isInteger(v) ? emReais(v) : undefined);
    const linhasSaida = !monetario ? devolvidas : devolvidas.map((l) => ({ ...l, emReais: {
      porCompetencia: Object.fromEntries(Object.entries(l.porCompetencia).filter(([, v]) => Number.isInteger(v)).map(([k, v]) => [k, emReais(v)])),
      total: r$(l.total), mediaDoPeriodo: r$(l.mediaDoPeriodo), diferenca: r$(l.diferenca) } }));
    const chaveTotal = consolidado ? "totalDoUltimoMes" : "totalDasLinhasMostradas";
    return { dados: { metrica: m.rotulo, agrupamento: agruparPor, competencias, linhas: linhasSaida, ...(Number.isInteger(totalGeral) && agruparPor !== "NENHUM" ? { [chaveTotal]: totalGeral, [`${chaveTotal}EmReais`]: emReais(totalGeral) } : {}), cobertura, valoresEm: monetario ? "centavos (com emReais ao lado)" : "quantidade" }, fatos, numeros };
  },
});
