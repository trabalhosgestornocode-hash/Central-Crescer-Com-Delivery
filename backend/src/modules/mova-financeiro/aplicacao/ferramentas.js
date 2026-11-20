// FERRAMENTAS FINANCEIRAS do MOVA (Execução 03) — catálogo FECHADO, só leitura, acionado pelo MOTOR (a IA apenas escolhe a
// consulta no contrato estrito; não chama ferramenta, não escreve SQL, não redige números).
//
// Regras de conteúdo (todas cobertas por testes):
//   - cada resposta diz a UNIDADE e o PERÍODO/COMPETÊNCIA consultados;
//   - faturamento (vendas da competência/período) ≠ recebimento (dinheiro que entrou): mostrados separados quando houver;
//   - fluxo de caixa é CAIXA (entradas/saídas realizadas), nunca "lucro";
//   - DRE: só os indicadores do Financeiro, com a situação de cada um; valor ausente ou bloqueado = "sem dado confirmado";
//   - pagamento ≠ despesa da competência; comprovante ≠ conciliação;
//   - sem registros = `dadosInsuficientes` (o motor responde que não há dados, nunca estima);
//   - só agregados (política em dominio/privacidade.js): nada de conta bancária, pessoa ou linha a linha de fornecedor.
import { reais, dataBr } from "./respostas.js";

const SITUACOES_COM_VALOR = new Set(["CONFIRMADO", "CALCULADO_AGUARDANDO_CONFERENCIA", "PRELIMINAR", "PARCIAL"]);
const ROTULO_SITUACAO = { CONFIRMADO: "confirmado", CALCULADO_AGUARDANDO_CONFERENCIA: "calculado, aguardando conferência", PRELIMINAR: "preliminar", PARCIAL: "parcial", PENDENTE_DE_CLASSIFICACAO: "pendente de classificação", BLOQUEADO_POR_EVIDENCIA_INSUFICIENTE: "sem evidência suficiente" };
const DRE = [["FATURAMENTO_BRUTO_PROPRIO", "Faturamento bruto"], ["RECEITA_LIQUIDA_COMERCIAL", "Receita líquida comercial"], ["CUSTOS_OPERACIONAIS", "Custos operacionais"], ["DESPESAS_OPERACIONAIS", "Despesas operacionais"], ["RESULTADO_GERENCIAL", "Resultado gerencial"]];
const SITUACOES_ABERTAS = ["EM_ABERTO", "PARCIALMENTE_PAGO", "VENCIDO", "AGUARDANDO_CLASSIFICACAO_OU_EVIDENCIA"];
const mes = (d) => d.slice(0, 7);
const ultimoDia = (comp) => { const [a, m] = comp.split("-").map(Number); return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10); };
const somarDias = (data, n) => { const d = new Date(`${data}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const insuficiente = (motivo) => ({ dadosInsuficientes: true, motivo, linhas: [] });
const ok = (linhas, extra = {}) => ({ dadosInsuficientes: false, linhas, ...extra });

/** Período da consulta: o informado pela leitura; senão a competência; senão o mês corrente. Sempre explícito na resposta. */
export function periodoDaConsulta(saida, hoje) {
  if (saida.periodoInicio || saida.periodoFim) {
    const inicio = saida.periodoInicio ?? saida.periodoFim; const fim = saida.periodoFim ?? saida.periodoInicio;
    return { inicio, fim, competencia: mes(inicio) === mes(fim) ? mes(inicio) : null, rotulo: inicio === fim ? dataBr(inicio) : `${dataBr(inicio)} a ${dataBr(fim)}` };
  }
  const competencia = saida.competencia ?? mes(hoje);
  return { inicio: `${competencia}-01`, fim: competencia === mes(hoje) ? hoje : ultimoDia(competencia), competencia, rotulo: `competência ${competencia}` };
}

/**
 * @param {{porta:object, armazenamento:object}} deps
 */
export function criarFerramentas({ porta, armazenamento }) {
  const contasTodas = async (escopo) => porta.contasAPagarTodas(escopo);

  const ferramentas = {
    async FATURAMENTO(escopo, { periodo }) {
      const r = await porta.ler("consultarVendas", escopo, { inicio: periodo.inicio, fim: periodo.fim });
      const s = r?.resumo;
      if (!s || s.operacoes === 0 || s.brutoProprioCentavos === null) return insuficiente("SEM_VENDAS_REGISTRADAS");
      const linhas = [`faturamento bruto próprio: ${reais(s.brutoProprioCentavos)} (${s.operacoes} registros)`];
      if (s.recebidoComprovadoCentavos !== null && s.recebidoComprovadoCentavos !== undefined) linhas.push(`recebido com comprovação no período: ${reais(s.recebidoComprovadoCentavos)} (recebimento não é faturamento)`);
      return ok(linhas, { valorCentavos: s.brutoProprioCentavos });
    },
    async DRE_RESUMO(escopo, { periodo }) {
      if (!periodo.competencia) return insuficiente("DRE_EXIGE_UMA_COMPETENCIA");
      const ap = await porta.ler("apurarCompetencia", escopo, { competencia: periodo.competencia });
      const estado = ap?.dre?.estadoDaCompetencia ?? "DESCONHECIDO";
      const linhas = [];
      let algum = false;
      for (const [codigo, nome] of DRE) {
        const i = ap?.indicadores?.[codigo];
        if (i && i.valorCentavos !== null && SITUACOES_COM_VALOR.has(i.situacao)) { algum = true; linhas.push(`${nome}: ${reais(i.valorCentavos)} (${ROTULO_SITUACAO[i.situacao]})`); }
        else linhas.push(`${nome}: sem dado confirmado (${ROTULO_SITUACAO[i?.situacao] ?? "não apurado"})`);
      }
      if (!algum) return insuficiente("DRE_SEM_INDICADORES_APURADOS");
      linhas.push(`competência ${estado === "ABERTA" ? "aberta (números podem mudar)" : `em ${estado.toLowerCase().replaceAll("_", " ")}`}; metodologia ${ap?.metodologia?.nome ?? "-"}`);
      return ok(linhas);
    },
    async FLUXO_DE_CAIXA(escopo, { periodo }) {
      const f = await porta.ler("consultarFluxoDeCaixa", escopo, { inicio: periodo.inicio, fim: periodo.fim, granularidade: "MES" });
      const r = f?.realizado;
      if (!r || (r.entradasCentavos === 0 && r.saidasCentavos === 0)) return insuficiente("SEM_MOVIMENTACOES");
      return ok([`caixa realizado: entradas ${reais(r.entradasCentavos)}, saídas ${reais(r.saidasCentavos)}, variação ${reais(r.variacaoCentavos)} (movimentação de caixa, não é resultado)`]);
    },
    async CONTAS_A_RECEBER(escopo, { hoje }) {
      const r = await porta.resumo(escopo, mes(hoje));
      const x = r?.contasAReceber;
      if (!x || x.situacao !== "CALCULADO") return insuficiente("SEM_RECEBIVEIS");
      return ok([`a receber em aberto: ${reais(x.saldoCentavos)} (${x.registros} títulos)`]);
    },
    async CONTAS_A_PAGAR_ABERTAS(escopo) {
      const abertas = await porta.contasAPagarAbertas(escopo);
      const todas = await contasTodas(escopo);
      if (todas.length === 0) return insuficiente("SEM_CONTAS_A_PAGAR");
      const vencido = abertas.filter((t) => t.vencido).reduce((s, t) => s + t.saldoCentavos, 0);
      return ok([`a pagar em aberto: ${abertas.length} contas, ${reais(abertas.reduce((s, t) => s + t.saldoCentavos, 0))} (vencido: ${reais(vencido)})`]);
    },
    async CONTAS_VENCENDO(escopo, { periodo, hoje }) {
      const todas = await contasTodas(escopo);
      if (todas.length === 0) return insuficiente("SEM_CONTAS_A_PAGAR");
      const [de, ate] = periodo.explicito ? [periodo.inicio, periodo.fim] : [hoje, somarDias(hoje, 7)];
      const lista = (await porta.contasAPagarAbertas(escopo)).filter((t) => t.vencimento >= de && t.vencimento <= ate);
      return ok([`vencendo de ${dataBr(de)} a ${dataBr(ate)}: ${lista.length} contas, ${reais(lista.reduce((s, t) => s + t.saldoCentavos, 0))}`]);
    },
    async PENDENCIAS(escopo, { periodo }) {
      const comp = periodo.competencia ?? mes(periodo.fim);
      const p = await porta.ler("consultarPendencias", escopo, { competencia: comp });
      const total = Array.isArray(p?.itens) ? (p.paginacao?.total ?? p.itens.length) : 0;
      return ok([`pendências de conferência na competência ${comp}: ${total}`]);
    },
    async DESPESAS_POR_CATEGORIA(escopo, { periodo, saida }) {
      if (!saida.categoriaSugerida) return insuficiente("CATEGORIA_NAO_IDENTIFICADA");
      if (!periodo.competencia) return insuficiente("CATEGORIA_EXIGE_UMA_COMPETENCIA");
      const doMes = (await contasTodas(escopo)).filter((t) => t.competencia === periodo.competencia && t.categoria?.codigo === saida.categoriaSugerida && t.situacao !== "CANCELADO");
      if (doMes.length === 0) return insuficiente("SEM_CONTAS_NA_CATEGORIA");
      // Escopo honesto: contas a pagar REGISTRADAS na competência (despesa por competência), não pagamentos do mês.
      return ok([`contas registradas na categoria ${doMes[0].categoria.nome} na competência ${periodo.competencia}: ${doMes.length}, ${reais(doMes.reduce((s, t) => s + t.valorOriginalCentavos, 0))} (por competência; o pagamento pode cair em outro mês)`]);
    },
    async SITUACAO_DE_CONTA(escopo, { saida }) {
      if (!saida.valorCentavos && !saida.favorecido) return insuficiente("CONTA_NAO_IDENTIFICADA");
      const nome = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
      const c = (await contasTodas(escopo)).filter((t) => (!saida.valorCentavos || t.valorOriginalCentavos === saida.valorCentavos)
        && (!saida.favorecido || nome(t.fornecedor?.nome).includes(nome(saida.favorecido)) || nome(saida.favorecido).includes(nome(t.fornecedor?.nome)))
        && (!saida.vencimento || t.vencimento === saida.vencimento));
      if (c.length === 0) return insuficiente("CONTA_NAO_ENCONTRADA");
      if (c.length > 1) return ok([`encontrei ${c.length} contas compatíveis; informe valor e vencimento para eu dizer qual`]);
      const t = c[0];
      const situacao = { PAGO: "paga", PARCIALMENTE_PAGO: "parcialmente paga", EM_ABERTO: "em aberto", VENCIDO: "vencida e em aberto", CANCELADO: "cancelada", AGUARDANDO_CLASSIFICACAO_OU_EVIDENCIA: "em aberto (aguardando classificação)" }[t.situacao] ?? t.situacao;
      return ok([`conta de ${reais(t.valorOriginalCentavos)} com vencimento ${dataBr(t.vencimento)}: ${situacao}; saldo ${reais(t.saldoCentavos)} (pagamento registrado não significa conciliado com o extrato)`]);
    },
    async CATEGORIAS(escopo) {
      const p = await porta.ler("consultarPlanoDeContas", escopo, undefined);
      const cats = (p?.categorias ?? p?.itens ?? []).filter((c) => c.aceitaLancamento && c.ativa !== false && c.natureza !== "RECEITA");
      if (cats.length === 0) return insuficiente("PLANO_SEM_CATEGORIAS");
      return ok([`categorias de despesa/custo ativas: ${cats.length} (ex.: ${cats.slice(0, 5).map((c) => c.nome).join(", ")})`]);
    },
    async DOCUMENTOS(escopo, { periodo }) {
      const comp = periodo.competencia ?? mes(periodo.fim);
      const d = await porta.ler("consultarDocumentos", escopo, { competencia: comp, tamanho: 1 });
      const total = d?.paginacao?.total ?? d?.quantidade ?? 0;
      return ok([`documentos registrados na competência ${comp}: ${total}`]);
    },
    async RESUMO_DA_COMPETENCIA(escopo, { hoje }) {
      const r = await porta.resumo(escopo, mes(hoje));
      const pagar = r?.contasAPagar; const receber = r?.contasAReceber;
      if ((!pagar || pagar.situacao === "SEM_REGISTROS") && (!receber || receber.situacao === "SEM_REGISTROS")) return insuficiente("SEM_REGISTROS");
      const l = [];
      if (pagar?.situacao === "CALCULADO") l.push(`a pagar em aberto: ${reais(pagar.saldoCentavos)} (vencido: ${reais(pagar.vencidoCentavos)})`);
      if (receber?.situacao === "CALCULADO") l.push(`a receber em aberto: ${reais(receber.saldoCentavos)}`);
      return ok(l);
    },
    async SITUACAO_PROPOSTAS(escopo) {
      const ps = await armazenamento.propostas.listar(escopo);
      const n = (e) => ps.filter((p) => p.estado === e).length;
      return ok([`${n("AGUARDANDO_REVISAO")} aguardando revisão, ${n("APLICADA")} aplicadas, ${n("REJEITADA")} rejeitadas`]);
    },
  };
  ferramentas.COMPARATIVO_UNIDADES = ferramentas.CONTAS_A_PAGAR_ABERTAS;
  return Object.freeze(ferramentas);
}
