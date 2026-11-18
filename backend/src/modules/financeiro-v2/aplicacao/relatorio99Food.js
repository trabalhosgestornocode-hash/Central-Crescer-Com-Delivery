// Relatório oficial da 99Food → lançamentos por dia. Só entra na DRE o que o relatório nomeia com natureza clara:
// vendas de itens, taxas de processamento, comissões e marketing. Recompensas e receita de ofertas ficam guardadas e visíveis.
// O repasse informado NÃO vira recebível nem crédito: o arquivo não traz data, ciclo nem comprovante de pagamento.
// A SAIPOS só confere, por dia. Reaplicar não duplica; um dia corrigido ganha nova versão e a anterior fica cancelada.
import { CODIGO, falhar } from "../dominio/erros.js";
import { ESTADO_IMPORTACAO as E, EVENTO_HISTORICO, SITUACAO_LANCAMENTO, SITUACAO_REGISTRO_FONTE, SITUACAO_VENDA, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { aceitaEscrita, exigeCorrecaoAuditada } from "../dominio/fechamento.js";
import { exigirTexto, exigirUuid, semCamposDesconhecidos } from "../dominio/validacao.js";
import { RELATORIO_99FOOD, consolidar99Food } from "../importacao/fontes/noventaENoveFood.js";

const CANAL = "NOVENTA_E_NOVE_FOOD";
const CONCLUIDAS = [E.IMPORTADO, E.IMPORTADO_COM_PENDENCIAS];
const COMPONENTES = Object.freeze([
  { componente: "VENDAS", campo: "itensCentavos", sistema: "VENDA_NOVENTA_E_NOVE_FOOD", descricao: "Vendas de itens na 99Food", retido: false },
  { componente: "PROCESSAMENTO", campo: "processamentoCentavos", categoria: "TAXAS_DE_PROCESSAMENTO", descricao: "Taxas de processamento da 99Food", retido: true },
  { componente: "COMISSOES", campo: "comissaoCentavos", categoria: "COMISSOES_DE_PLATAFORMA", descricao: "Comissões da 99Food", retido: true },
  { componente: "MARKETING", campo: "marketingCentavos", categoria: "ANUNCIOS_E_DIVULGACAO", descricao: "Marketing na 99Food", retido: true },
]);
const dataBR = (d) => d.split("-").reverse().join("/");
const soma = (lista, f) => lista.reduce((s, x) => s + (f(x) ?? 0), 0);
const movimentosAtivos = (tx, cx) => tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { fonte: "OUTRO", tipoRelatorio: RELATORIO_99FOOD, situacao: SITUACAO_REGISTRO_FONTE.ATIVO } });
const lancamentosDoRelatorio = async (tx, cx) => (await tx.listar(cx, TIPO.LANCAMENTO, { onde: { canal: CANAL } })).filter((l) => l.relatorio99Food);

/** Comparação possível com um relatório diário: quantidade e valor de itens. Nunca concilia pedido a pedido. */
async function conferenciaComSaipos(tx, cx, dias) {
  const datas = new Set(dias.map((d) => d.data));
  const pedidos = (await tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { fonte: "SAIPOS", tipoRegistro: "PEDIDO" } }))
    .filter((r) => r.situacao === SITUACAO_REGISTRO_FONTE.ATIVO && r.dados?.canal === CANAL && !r.dados.cancelado && datas.has(r.dataReferencia));
  const porDia = new Map();
  for (const d of dias) {
    const lista = pedidos.filter((r) => r.dataReferencia === d.data);
    if (!lista.length) { porDia.set(d.data, null); continue; }
    const itensCentavos = soma(lista, (r) => r.dados.itensCentavos ?? r.valorCentavos);
    porDia.set(d.data, { pedidos: lista.length, itensCentavos, diferencaPedidos: lista.length - d.quantidade, diferencaItensCentavos: itensCentavos - d.itensCentavos });
  }
  const comparados = dias.filter((d) => porDia.get(d.data));
  return { porDia, resumo: { diasComparados: comparados.length, diasSemSaipos: dias.filter((d) => !porDia.get(d.data)).map((d) => d.data), diasDivergentes: comparados.filter((d) => porDia.get(d.data).diferencaPedidos || porDia.get(d.data).diferencaItensCentavos).map((d) => d.data), diferencaPedidos: soma(comparados, (d) => porDia.get(d.data).diferencaPedidos), diferencaItensCentavos: soma(comparados, (d) => porDia.get(d.data).diferencaItensCentavos), situacao: "PENDENTE_DE_CONFERENCIA" } };
}

/** Leitura diária para o calendário e a área da 99Food. Só leitura. */
export async function leituraDoRelatorio99Food(tx, cx, { inicio, fim }) {
  const consolidado = consolidar99Food(await movimentosAtivos(tx, cx));
  const dias = consolidado.dias.filter((d) => d.data >= inicio && d.data <= fim);
  if (!dias.length) return null;
  const ativos = (await lancamentosDoRelatorio(tx, cx)).filter((l) => l.situacao === SITUACAO_LANCAMENTO.ATIVO);
  const saipos = await conferenciaComSaipos(tx, cx, dias);
  const porDia = new Map();
  for (const d of dias) {
    const doDia = new Map(ativos.filter((l) => l.relatorio99Food.dia === d.data).map((l) => [l.relatorio99Food.componente, l.valorCentavos]));
    const desejados = COMPONENTES.filter((c) => d[c.campo] > 0);
    const aplicado = doDia.size === desejados.length && desejados.every((c) => doDia.get(c.componente) === d[c.campo]);
    const conf = saipos.porDia.get(d.data);
    const diverge = conf && (conf.diferencaPedidos || conf.diferencaItensCentavos);
    porDia.set(d.data, { ...d, aplicado, saipos: conf, situacaoImportacao: aplicado ? "APLICADO" : "IMPORTADO", situacaoConferencia: !aplicado ? "IMPORTADO" : diverge ? "DIVERGENTE" : "AGUARDANDO_CONFERENCIA" });
  }
  const lista = [...porDia.values()];
  const situacao = lista.some((x) => !x.aplicado) ? "IMPORTADO" : lista.some((x) => x.situacaoConferencia === "DIVERGENTE") ? "DIVERGENTE" : "AGUARDANDO_CONFERENCIA";
  return { porDia, situacao, conferenciaSaipos: saipos.resumo, lojas: consolidado.lojas };
}

export function operacoesDoRelatorio99Food(b) {
  async function categoriaDe(tx, cx, c) {
    return c.sistema ? b.categoriaDoSistema(tx, cx, c.sistema) : b.categoriaLancavel(tx, cx, c.categoria);
  }

  async function exigirImportacao(tx, cx, importacaoId) {
    const imp = await b.obterOuFalhar(tx, cx, TIPO.IMPORTACAO, importacaoId, "Importação");
    if (imp.tipoRelatorio !== RELATORIO_99FOOD) falhar(CODIGO.OPERACAO_INVALIDA, "Esta importação não é um relatório oficial da 99Food.");
    if (!CONCLUIDAS.includes(imp.estado)) falhar(CODIGO.TRANSICAO_INVALIDA, "Confirme a importação antes de aplicar ao Financeiro.", { estado: imp.estado });
    return imp;
  }

  /** O que a aplicação faria agora. A prévia e a aplicação usam exatamente este plano. */
  async function planejar(tx, cx, imp) {
    const registros = await movimentosAtivos(tx, cx);
    const { total, dias, lojas } = consolidar99Food(registros);
    const bloqueios = [];
    const avisos = [];
    if (!registros.length) bloqueios.push({ codigo: "SEM_MOVIMENTOS", mensagem: "Não há dias confirmados do relatório da 99Food." });
    const config = await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade");
    const vinculada = config?.identidade99Food ?? null;
    if (lojas.length > 1) bloqueios.push({ codigo: "MAIS_DE_UMA_LOJA", mensagem: "Os relatórios importados têm mais de uma loja da 99Food." });
    if (vinculada && lojas.some((l) => l.id !== vinculada.id)) bloqueios.push({ codigo: "LOJA_DIFERENTE", mensagem: `O relatório é de outra loja da 99Food: esta unidade está vinculada a ${vinculada.nome}.` });
    if (!vinculada && lojas.length === 1) avisos.push({ codigo: "VINCULAR_LOJA", mensagem: `Ao aplicar, esta unidade fica vinculada à loja ${lojas[0].nome} da 99Food.` });
    if (imp.relatorio?.conflitosNaoGravados) bloqueios.push({ codigo: "DADOS_CORRIGIDOS_SEM_SUBSTITUICAO", quantidade: imp.relatorio.conflitosNaoGravados, mensagem: `${imp.relatorio.conflitosNaoGravados} dia(s) vieram com valores diferentes dos já importados: envie o arquivo como versão corrigida.` });
    const importacoes = (await tx.listar(cx, TIPO.IMPORTACAO, { onde: { fonte: "OUTRO", tipoRelatorio: RELATORIO_99FOOD } })).filter((i) => CONCLUIDAS.includes(i.estado));
    const coberto = (data) => importacoes.some((i) => i.periodoInicio <= data && data <= i.periodoFim);
    const descobertos = (await tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { fonte: "OUTRO", tipoRelatorio: RELATORIO_99FOOD, situacao: SITUACAO_REGISTRO_FONTE.SUBSTITUIDO } })).filter((r) => !coberto(r.dataReferencia));
    if (descobertos.length) bloqueios.push({ codigo: "SUBSTITUICAO_PARCIAL", quantidade: descobertos.length, mensagem: `A versão corrigida não cobre ${descobertos.length} dia(s) da versão anterior: envie o relatório completo do período.` });

    const datas = new Set(dias.map((d) => d.data));
    const vendas = (await tx.listar(cx, TIPO.VENDA, { onde: { canal: CANAL, situacao: SITUACAO_VENDA.ATIVA } })).filter((v) => datas.has(v.dataVenda));
    if (vendas.length) bloqueios.push({ codigo: "VENDAS_99FOOD_APLICADAS", quantidade: vendas.length, mensagem: `${vendas.length} venda(s) 99Food já registrada(s) nestes dias: o faturamento seria somado duas vezes.` });
    const canal = await tx.listar(cx, TIPO.LANCAMENTO, { onde: { canal: CANAL } });
    if (canal.some((l) => l.situacao === SITUACAO_LANCAMENTO.ATIVO && l.categoria === "VENDA_NOVENTA_E_NOVE_FOOD" && !l.relatorio99Food && datas.has(l.dataOperacao))) bloqueios.push({ codigo: "RECEITA_99FOOD_DE_OUTRA_ORIGEM", mensagem: "Há receita 99Food de outra origem nestes dias: reverta antes de aplicar o relatório oficial." });

    const propria = canal.filter((l) => l.relatorio99Food);
    const atual = new Map(propria.filter((l) => l.situacao === SITUACAO_LANCAMENTO.ATIVO).map((l) => [`${l.relatorio99Food.dia}|${l.relatorio99Food.componente}`, l]));
    const versao = new Map();
    for (const l of propria) { const k = `${l.relatorio99Food.dia}|${l.relatorio99Food.componente}`; versao.set(k, Math.max(versao.get(k) ?? 0, l.relatorio99Food.versao)); }
    const criar = []; const manter = []; const cancelar = []; const desejados = new Set();
    for (const dia of dias) {
      for (const c of COMPONENTES) {
        const valorCentavos = dia[c.campo];
        if (valorCentavos <= 0) continue;
        const k = `${dia.data}|${c.componente}`;
        desejados.add(k);
        const existente = atual.get(k);
        if (existente?.valorCentavos === valorCentavos) { manter.push(existente); continue; }
        if (existente) cancelar.push(existente);
        criar.push({ c, dia: dia.data, valorCentavos, versao: (versao.get(k) ?? 0) + 1 });
      }
    }
    for (const [k, l] of atual) if (!desejados.has(k)) cancelar.push(l);
    const competenciasAlteradas = [...new Set([...criar.map((x) => x.dia.slice(0, 7)), ...cancelar.map((l) => l.competencia)])].sort();
    for (const competencia of competenciasAlteradas) {
      const estado = (await b.competenciaAtual(tx, cx, competencia))?.estado;
      if (estado && !aceitaEscrita(estado)) bloqueios.push({ codigo: "COMPETENCIA_FECHADA_COM_ALTERACAO", competencia, mensagem: `Este relatório altera a competência ${competencia}, que está homologada: abra a revisão formal antes de aplicar.` });
      else if (estado && exigeCorrecaoAuditada(estado)) avisos.push({ codigo: "CORRECAO_EM_FECHAMENTO", competencia, mensagem: `A competência ${competencia} está em fechamento: aplicar exige a permissão de correção e fica registrado no histórico.` });
    }
    const conferencia = await conferenciaComSaipos(tx, cx, dias);
    return { registros, total, dias, lojas, bloqueios, avisos, criar, manter, cancelar, competenciasAlteradas, vinculada, config, conferencia: conferencia.resumo, conferenciaPorDia: conferencia.porDia };
  }

  const resumoDoPlano = (p) => ({
    loja: p.lojas[0] ?? null, periodo: { inicio: p.dias[0]?.data ?? null, fim: p.dias.at(-1)?.data ?? null }, dias: p.dias.length, quantidade: p.total.quantidade,
    valores: {
      vendasCentavos: p.total.itensCentavos, processamentoCentavos: p.total.processamentoCentavos, comissoesCentavos: p.total.comissaoCentavos, marketingCentavos: p.total.marketingCentavos, resultadoCentavos: p.total.composicaoCentavos,
      recompensasCentavos: p.total.recompensasCentavos, receitaOfertaCentavos: p.total.receitaOfertaCentavos, repasseInformadoCentavos: p.total.repasseCentavos, diferencaRepasseCentavos: p.total.diferencaRepasseCentavos,
    },
    valoresDiarios: p.dias.map((d) => ({ ...d, saipos: p.conferenciaPorDia.get(d.data) })), lancamentos: { criar: p.criar.length, manter: p.manter.length, cancelar: p.cancelar.length },
    conferenciaSaipos: p.conferencia, bloqueios: p.bloqueios, avisos: p.avisos, exigeAceiteDaDiferenca: p.total.diferencaRepasseCentavos !== 0, podeAplicar: p.bloqueios.length === 0,
  });

  return {
    /** Prévia dos efeitos financeiros: nada é gravado. */
    previaDoRelatorio99Food(ctx, entrada) {
      semCamposDesconhecidos(entrada, ["importacaoId"], "previaRelatorio99Food");
      const importacaoId = exigirUuid(entrada.importacaoId, "importacaoId");
      return b.consultar(ctx, async (cx, tx) => {
        const imp = await exigirImportacao(tx, cx, importacaoId);
        return { importacaoId, ...resumoDoPlano(await planejar(tx, cx, imp)) };
      });
    },

    /** Grava vendas, taxas, comissões e marketing numa transação. Não cria recebível, crédito nem baixa. */
    aplicarRelatorio99Food(ctx, entrada) {
      semCamposDesconhecidos(entrada, ["importacaoId", "justificativa", "aceitarDiferencaDeRepasse"], "aplicarRelatorio99Food");
      const importacaoId = exigirUuid(entrada.importacaoId, "importacaoId");
      const justificativa = exigirTexto(entrada.justificativa, "justificativa", { max: 500 });
      return b.executar(ctx, ACAO.APLICAR, async (cx, tx) => {
        const imp = await exigirImportacao(tx, cx, importacaoId);
        const previos = consolidar99Food(await movimentosAtivos(tx, cx));
        for (const competencia of [...new Set(previos.dias.map((d) => d.data.slice(0, 7)))].sort()) await tx.travar(cx, `formacao-competencia:${competencia}`, "EXCLUSIVA");
        await tx.travar(cx, "configuracao-unidade", "EXCLUSIVA");
        const p = await planejar(tx, cx, imp);
        if (p.bloqueios.length) falhar(CODIGO.OPERACAO_INVALIDA, p.bloqueios[0].mensagem, { bloqueios: p.bloqueios });
        if (p.total.diferencaRepasseCentavos !== 0 && entrada.aceitarDiferencaDeRepasse !== true) falhar(CODIGO.CONFIRMACAO_EXIGIDA, "O repasse informado não fecha com os lançamentos: confirme que a diferença fica em conferência.", { diferencaCentavos: p.total.diferencaRepasseCentavos });
        for (const competencia of p.competenciasAlteradas) await b.exigirCompetenciaEditavel(tx, cx, competencia);
        for (const l of p.cancelar) await b.cancelarLancamento(tx, cx, l.id, `Nova versão do relatório oficial da 99Food. ${justificativa}`);
        for (const x of p.criar) {
          const categoria = await categoriaDe(tx, cx, x.c);
          const chave = `relatorio-99food:${x.dia}:${x.c.componente}:v${x.versao}`;
          await b.lancar(tx, cx, categoria, {
            valorCentavos: x.valorCentavos, moeda: "BRL", descricao: `${x.c.descricao} de ${dataBR(x.dia)}`, dataOperacao: x.dia, competencia: x.dia.slice(0, 7), canal: CANAL, retidoNoRepasse: x.c.retido,
            fonte: { sistema: "OUTRO", idExterno: chave }, origem: { tipo: TIPO.IMPORTACAO, id: imp.id, documentoId: imp.documentoId }, chaveIdempotencia: chave, impressao: null,
            relatorio99Food: { dia: x.dia, componente: x.c.componente, versao: x.versao, justificativa },
          }, { documentado: true });
        }
        if (p.config && !p.vinculada && p.lojas.length === 1) await b.alterar(tx, cx, TIPO.CONFIGURACAO_UNIDADE, p.config, { identidade99Food: { ...p.lojas[0], em: b.agora(), por: cx.usuarioId } }, EVENTO_HISTORICO.CONFIGURACAO, justificativa);
        return { importacaoId, ...resumoDoPlano(p), repetido: !p.criar.length && !p.cancelar.length };
      });
    },
  };
}
