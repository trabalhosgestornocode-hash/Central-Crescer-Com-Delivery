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
// 16A — faturamento por canal: o valor de cada canal é o da DRE (o Financeiro já escolhe a fonte oficial de cada canal e
// nunca soma fontes diferentes); o MOVA só mostra, com a situação e a cobertura de dias do calendário do canal.
const NOME_DO_CANAL = Object.freeze({ BALCAO: "Balcão", IFOOD: "iFood", ANOTA_AI: "Anota AI", NOVENTA_E_NOVE_FOOD: "99Food", OUTRO: "Outros canais" });
const FONTE_DO_CANAL = Object.freeze({ IFOOD: "relatório oficial do iFood", NOVENTA_E_NOVE_FOOD: "relatório oficial da 99Food", ANOTA_AI: "SAIPOS" });
const DIA_COM_DADO = ["PROVISORIO", "FECHAMENTO_MANUAL", "IMPORTADO", "CONCILIADO", "SEM_MOVIMENTO_CONFIRMADO"];
const ROTULO_SITUACAO_CURTO = { CONFIRMADO: "confirmado", CALCULADO_AGUARDANDO_CONFERENCIA: "aguardando conferência", PRELIMINAR: "preliminar", PARCIAL: "parcial" };
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
  /** Cobertura de dias do canal no mês (calendário do Financeiro). Erro de REGRA (canal fora da unidade) ⇒ sem cobertura. */
  async function coberturaDoCanal(escopo, canal, competencia) {
    let cal;
    try { cal = await porta.ler("consultarCalendarioDeFaturamento", escopo, { canal, mes: competencia }); }
    catch (e) { if (porta.ehErroDeRegra?.(e)) return null; throw e; }
    const dias = Array.isArray(cal?.dias) ? cal.dias : [];
    const comDado = dias.filter((d) => (d.estados ?? []).some((x) => DIA_COM_DADO.includes(x))).map((d) => d.data).sort();
    const r = cal?.resumo ?? {};
    const textos = [];
    if (comDado.length) textos.push(`dados até ${dataBr(comDado.at(-1))}`); else if (!cal?.granularidadeDiaria) textos.push("relatório por período, sem valor por dia");
    if (r.semRegistro) textos.push(`${r.semRegistro} dia(s) sem registro`);
    if (r.comPendencias) textos.push(`${r.comPendencias} dia(s) com pendência de conferência`);
    if (r.comDivergencias) textos.push(`${r.comDivergencias} dia(s) com divergência`);
    const fonte = canal === "BALCAO" ? (cal?.swf ? "SWF" : cal?.sistemaDeLoja ?? null) : null;
    return { texto: textos.join(", ") || null, fonte, diasComDado: comDado.length };
  }

  const ferramentas = {
    async FATURAMENTO(escopo, { periodo, hoje }) {
      const comp = periodo.competencia;
      const competenciaInteira = comp && periodo.inicio === `${comp}-01` && (periodo.fim === ultimoDia(comp) || periodo.fim === hoje);
      // 16C (achado no ensaio com dados reais): na competência inteira (ou até hoje, no mês corrente) a MANCHETE e os canais saem da
      // MESMA fonte, a DRE — a mesma conta da tela do Financeiro. A lista de vendas venda a venda NÃO inclui os relatórios oficiais
      // por período (iFood/99Food) e subestimava o total.
      if (competenciaInteira) {
        const ap = await porta.ler("apurarCompetencia", escopo, { competencia: comp });
        const fb = ap?.indicadores?.FATURAMENTO_BRUTO_PROPRIO;
        if (fb && typeof fb.valorCentavos === "number" && SITUACOES_COM_VALOR.has(fb.situacao)) {
          const porCanal = Array.isArray(fb.porCanal) ? fb.porCanal : [];
          const linhas = [`faturamento bruto próprio: ${reais(fb.valorCentavos)} — na DRE: ${ROTULO_SITUACAO_CURTO[fb.situacao]}`];
          const coberturas = await Promise.all(porCanal.map((c) => coberturaDoCanal(escopo, c.canal, comp)));
          porCanal.forEach((c, i) => {
            const cob = coberturas[i];
            const fonte = FONTE_DO_CANAL[c.canal] ?? cob?.fonte ?? null;
            // Valor zero sem nenhum dia com dado (ou sem cobertura conhecida) NÃO é "zero confirmado": é ausência de dado.
            if (c.valorCentavos === 0 && (!cob || cob.diasComDado === 0)) { linhas.push(`${NOME_DO_CANAL[c.canal] ?? c.canal}: sem dados registrados${fonte ? ` (${fonte})` : ""} — não é zero confirmado`); return; }
            const partes = [fonte, c.comprovado ? "comprovado" : "sem comprovação", cob?.texto ?? null].filter(Boolean);
            linhas.push(`${NOME_DO_CANAL[c.canal] ?? c.canal}: ${reais(c.valorCentavos)} (${partes.join("; ")})`);
          });
          const soma = porCanal.reduce((t, c) => t + (c.valorCentavos ?? 0), 0);
          if (porCanal.length && soma !== fb.valorCentavos) linhas.push("atenção: a soma dos canais difere do total da DRE; confira no Centro Financeiro antes de usar");
          return ok(linhas, { valorCentavos: fb.valorCentavos });
        }
      }
      // Período parcial (ou competência ainda sem faturamento apurado na DRE): só as vendas registradas venda a venda — e a resposta diz isso.
      const r = await porta.ler("consultarVendas", escopo, { inicio: periodo.inicio, fim: periodo.fim });
      const s = r?.resumo;
      if (!s || s.operacoes === 0 || s.brutoProprioCentavos === null) return insuficiente("SEM_VENDAS_REGISTRADAS");
      const linhas = [`faturamento bruto próprio: ${reais(s.brutoProprioCentavos)} (${s.operacoes} registros)`];
      linhas.push(competenciaInteira
        ? "a DRE desta competência ainda não tem faturamento apurado: o valor acima é só das vendas registradas venda a venda"
        : "valor parcial: só as vendas registradas venda a venda; os relatórios oficiais de iFood e 99Food entram apenas na consulta da competência inteira (peça o mês)");
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
      // 16C: UMA varredura das contas (as abertas saem do mesmo resultado); antes eram duas, o dobro do tempo.
      const todas = await contasTodas(escopo);
      if (todas.length === 0) return insuficiente("SEM_CONTAS_A_PAGAR");
      const abertas = todas.filter((t) => SITUACOES_ABERTAS.includes(t.situacao));
      const vencido = abertas.filter((t) => t.vencido).reduce((s, t) => s + t.saldoCentavos, 0);
      return ok([`a pagar em aberto: ${abertas.length} contas, ${reais(abertas.reduce((s, t) => s + t.saldoCentavos, 0))} (vencido: ${reais(vencido)})`]);
    },
    async CONTAS_VENCENDO(escopo, { periodo, hoje }) {
      const todas = await contasTodas(escopo);
      if (todas.length === 0) return insuficiente("SEM_CONTAS_A_PAGAR");
      const [de, ate] = periodo.explicito ? [periodo.inicio, periodo.fim] : [hoje, somarDias(hoje, 7)];
      const lista = todas.filter((t) => SITUACOES_ABERTAS.includes(t.situacao) && t.vencimento >= de && t.vencimento <= ate);
      return ok([`vencendo de ${dataBr(de)} a ${dataBr(ate)}: ${lista.length} contas, ${reais(lista.reduce((s, t) => s + t.saldoCentavos, 0))}`]);
    },
    /** Agente 2: contas VENCIDAS e não pagas (até hoje), com a mais antiga. */
    async CONTAS_VENCIDAS(escopo, { hoje }) {
      const todas = await contasTodas(escopo);
      if (todas.length === 0) return insuficiente("SEM_CONTAS_A_PAGAR");
      const vencidas = todas.filter((t) => SITUACOES_ABERTAS.includes(t.situacao) && t.saldoCentavos > 0 && t.vencimento < hoje).sort((a, b) => a.vencimento.localeCompare(b.vencimento));
      if (vencidas.length === 0) return ok([`nenhuma conta a pagar vencida até ${dataBr(hoje)}`], { valorCentavos: 0 });
      const total = vencidas.reduce((s, t) => s + t.saldoCentavos, 0);
      return ok([`vencidas e não pagas: ${vencidas.length} contas, ${reais(total)} (a mais antiga venceu em ${dataBr(vencidas[0].vencimento)})`], { valorCentavos: total });
    },
    /**
     * Agente 2: fechamento semanal dos entregadores próprios — AGREGADO da unidade (nunca o valor de uma pessoa no grupo).
     * Semana anterior por padrão; período informado ⇒ a semana que contém o início. Fonte e situação sempre explícitas.
     */
    async FECHAMENTO_ENTREGADORES(escopo, { periodo, hoje }) {
      const referencia = periodo.explicito ? periodo.inicio : somarDias(hoje, -7);
      let r;
      try { r = await porta.ler("consultarEntregadoresProprios", escopo, { semana: referencia }); }
      catch (e) { if (porta.ehErroDeRegra?.(e)) return insuficiente("ENTREGADORES_INDISPONIVEL"); throw e; }
      const sem = r?.semana; const ind = r?.indicadores;
      if (!sem || !ind || (ind.entregadoresAtivos === 0 && !(r.fechamentos ?? []).length)) return insuficiente("SEM_FECHAMENTO_DE_ENTREGADORES");
      const situacao = { CONSOLIDADA: "fechada", PENDENTE: "com pendências para fechar", AGUARDANDO_FECHAMENTO: "aguardando fechamento", EM_ANDAMENTO: "em andamento (valores provisórios)" }[sem.situacao] ?? String(sem.situacao).toLowerCase();
      const l = [`semana ${dataBr(sem.inicio)} a ${dataBr(sem.fim)} (${situacao}): ${ind.entregadoresAtivos} entregadores, ${ind.entregas} entregas, ${reais(ind.acumuladoSemanaCentavos)}`];
      if (sem.pendencias?.length) l.push(`${sem.pendencias.length} pendência(s) de apuração na semana`);
      l.push(`em aberto (todas as semanas): aguardando nota fiscal ${reais(ind.aguardandoNotaCentavos)}; liberado para pagamento ${reais(ind.liberadoCentavos)}; vencido ${reais(ind.vencidoCentavos)}`);
      if (ind.proximaQuarta?.quantidade) l.push(`a pagar na quarta ${dataBr(ind.proximaQuarta.data)}: ${ind.proximaQuarta.quantidade} conta(s), ${reais(ind.proximaQuarta.valorCentavos)}`);
      if (sem.fonteDisponivel === false) l.push("fonte das entregas indisponível agora: valores da semana podem estar incompletos");
      return ok(l, { valorCentavos: ind.acumuladoSemanaCentavos });
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
