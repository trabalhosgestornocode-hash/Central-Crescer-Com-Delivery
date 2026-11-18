// Relatório de Conciliação Financeira do iFood → efeitos financeiros, por dia do pedido e por ciclo de repasse.
//
// Regras:
//   - os movimentos importados (registros de fonte) são a base e continuam intactos: cada lançamento aponta para a importação;
//   - faturamento = produtos + entregas da loja, em categorias separadas; descontos e despesas ficam nas próprias categorias;
//   - o valor pago direto à loja já está nesse faturamento: não é receita adicional, não vira recebível nem movimentação;
//   - repasse é só PREVISÃO: o recebimento depende da conciliação com o extrato;
//   - a SAIPOS só confere: nenhuma venda é criada e a diferença fica pendente, sem ajuste;
//   - aplicar de novo não duplica. Se um relatório complementar mudar um dia, a versão anterior é cancelada (nunca apagada).
import { CODIGO, falhar } from "../dominio/erros.js";
import { ESTADO_IMPORTACAO as E, SITUACAO_LANCAMENTO, SITUACAO_REGISTRO_FONTE, SITUACAO_TITULO, SITUACAO_VENDA, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { exigirData } from "../dominio/tempo.js";
import { exigirTexto, exigirUuid, semCamposDesconhecidos } from "../dominio/validacao.js";
import { consolidarConciliacaoIfood } from "../importacao/fontes/ifoodConciliacao.js";
import { baseNaTransacao } from "./base.js";
import { operacoesEconomicas } from "./economico.js";

export const RELATORIO_CONCILIACAO_IFOOD = "IFOOD_CONCILIACAO";
const CONCLUIDAS = [E.IMPORTADO, E.IMPORTADO_COM_PENDENCIAS];
const PREFIXO_REPASSE = "ifood-repasse:";

/** componente → campo consolidado, sinal e categorias aceitas (a primeira existente no plano da unidade). */
const COMPONENTES = Object.freeze([
  { componente: "PRODUTOS", campo: "itensCentavos", sinal: 1, sistema: "VENDA_IFOOD", descricao: "Produtos vendidos no iFood" },
  { componente: "ENTREGAS", campo: "entregaLojaCentavos", sinal: 1, sistema: "ENTREGAS_IFOOD", descricao: "Entregas da loja no iFood" },
  { componente: "PROMOCOES_LOJA", campo: "promocaoLojaCentavos", sinal: -1, categorias: ["PROMOCOES_SUBSIDIADAS", "DESCONTOS_COMERCIAIS"], descricao: "Promoções custeadas pela loja no iFood" },
  { componente: "COMISSOES", campo: "comissaoCentavos", sinal: -1, categorias: ["COMISSOES_IFOOD", "COMISSOES_DE_PLATAFORMA"], descricao: "Comissões do iFood" },
  { componente: "TAXA_TRANSACAO", campo: "transacaoCentavos", sinal: -1, categorias: ["TAXAS_DE_PROCESSAMENTO"], descricao: "Taxa de transação do iFood" },
  { componente: "ENTREGA_SOB_DEMANDA", campo: "sobDemandaCentavos", sinal: -1, categorias: ["COMISSOES_DE_PLATAFORMA"], descricao: "Entrega sob demanda contratada no iFood" },
  { componente: "ANUNCIOS", campo: "anunciosCentavos", sinal: -1, categorias: ["ANUNCIOS_IFOOD", "ANUNCIOS_E_DIVULGACAO"], descricao: "Anúncios no iFood" },
]);

const chaveDoRepasse = (r) => `${r.apuracaoInicio}|${r.apuracaoFim}|${r.dataPrevista}`;
const idDoRepasse = (r, versao) => `${PREFIXO_REPASSE}${r.apuracaoInicio}:${r.apuracaoFim}:${r.dataPrevista}:v${versao}`;
const repasseDoId = (id) => { const [ini, fim, prev, v] = id.slice(PREFIXO_REPASSE.length).split(":"); return { chave: `${ini}|${fim}|${prev}`, versao: Number(v.slice(1)) }; };
const eRepasseConciliado = (r) => String(r.fonte?.idExterno ?? "").startsWith(PREFIXO_REPASSE);
const dataDoMovimento = (r) => (r.dados.pedido ? r.dados.dataPedido : r.dataReferencia);
const soma = (lista, f) => lista.reduce((s, x) => s + (f(x) ?? 0), 0);

function situacaoDoRepasse(r, hoje) {
  if (!r) return "SEM_RECEBIVEL";
  if (r.saldoCentavos === 0) return "RECEBIDO";
  if (r.liquidadoCentavos > 0) return "PARCIAL";
  return r.dataPrevista && r.dataPrevista < hoje ? "ATRASADO" : "PREVISTO";
}

/** Movimentos ativos da conciliação no escopo. O escopo vem do contexto: outra unidade nunca entra. */
const movimentosAtivos = (tx, cx) => tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { fonte: "IFOOD", tipoRelatorio: RELATORIO_CONCILIACAO_IFOOD, situacao: SITUACAO_REGISTRO_FONTE.ATIVO } });
const lancamentosDaConciliacao = async (tx, cx) => (await tx.listar(cx, TIPO.LANCAMENTO, { onde: { canal: "IFOOD" } })).filter((l) => l.conciliacaoIfood);
const repassesDaConciliacao = async (tx, cx) => (await tx.listar(cx, TIPO.RECEBIVEL, { onde: { processador: "IFOOD" } })).filter(eRepasseConciliado);

/** Conferência com a SAIPOS, por dia: só compara e aponta; nada aqui altera valor. */
async function conferenciaComSaipos(tx, cx, dias, pedidosOficiais) {
  const datas = new Set(dias.map((d) => d.data));
  const saipos = (await tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { fonte: "SAIPOS", tipoRegistro: "PEDIDO" } }))
    .filter((r) => r.situacao === SITUACAO_REGISTRO_FONTE.ATIVO && r.dados?.canal === "IFOOD" && datas.has(r.dataReferencia));
  const porDia = new Map();
  for (const d of dias) {
    const lista = saipos.filter((r) => r.dataReferencia === d.data);
    if (!lista.length) { porDia.set(d.data, null); continue; }
    const validos = lista.filter((r) => !r.dados.cancelado);
    const ids = new Set(lista.map((r) => String(r.dados.idParceiro ?? "").toLowerCase()).filter(Boolean));
    const oficiais = pedidosOficiais.filter((p) => p.data === d.data).map((p) => p.pedido);
    const valorCentavos = soma(validos, (r) => r.valorCentavos);
    porDia.set(d.data, {
      pedidos: validos.length, cancelados: lista.length - validos.length, valorCentavos, diferencaCentavos: valorCentavos - d.itensCentavos,
      soNoIfood: ids.size ? oficiais.filter((p) => !ids.has(p)).length : 0, soNaSaipos: [...ids].filter((p) => !oficiais.includes(p)).length,
    });
  }
  const comparados = [...porDia.values()].filter(Boolean);
  const itensComparados = soma(dias.filter((d) => porDia.get(d.data)), (d) => d.itensCentavos);
  return {
    porDia,
    resumo: {
      diasComparados: comparados.length, diasSemSaipos: dias.filter((d) => !porDia.get(d.data)).map((d) => d.data), saiposCentavos: soma(comparados, (x) => x.valorCentavos),
      ifoodProdutosCentavos: itensComparados, diferencaCentavos: soma(comparados, (x) => x.valorCentavos) - itensComparados,
      pedidosSoNoIfood: soma(comparados, (x) => x.soNoIfood), pedidosSoNaSaipos: soma(comparados, (x) => x.soNaSaipos), situacao: "PENDENTE_DE_CONFERENCIA",
    },
  };
}

/** Leitura diária para o calendário e a área do iFood. Só leitura. */
export async function leituraDaConciliacaoIfood(tx, cx, { inicio, fim, hoje }) {
  const todos = await movimentosAtivos(tx, cx);
  const registros = todos.filter((r) => dataDoMovimento(r) >= inicio && dataDoMovimento(r) <= fim);
  if (!registros.length) return null;
  const { resumo, pedidos } = consolidarConciliacaoIfood(registros, { conferirSaldos: false });
  const lancamentos = (await lancamentosDaConciliacao(tx, cx)).filter((l) => l.situacao === SITUACAO_LANCAMENTO.ATIVO);
  const recebiveis = new Map((await repassesDaConciliacao(tx, cx)).filter((r) => r.situacao !== SITUACAO_TITULO.CANCELADA).map((r) => [repasseDoId(r.fonte.idExterno).chave, r]));
  const saipos = await conferenciaComSaipos(tx, cx, resumo.dias, pedidos);
  const porDia = new Map();
  for (const d of resumo.dias) {
    const doDia = lancamentos.filter((l) => l.conciliacaoIfood.dia === d.data);
    const aplicado = COMPONENTES.every((c) => (doDia.find((l) => l.conciliacaoIfood.componente === c.componente)?.valorCentavos ?? 0) === c.sinal * d[c.campo]);
    const conf = saipos.porDia.get(d.data);
    const movimentos = registros.filter((r) => dataDoMovimento(r) === d.data);
    const ciclos = [...new Map(movimentos.map((r) => [`${r.dados.apuracaoInicio}|${r.dados.apuracaoFim}|${r.dados.repasseEsperado}`, r.dados])).entries()];
    porDia.set(d.data, {
      pedidos: d.pedidos, pedidosCancelados: d.pedidosCancelados, movimentos: movimentos.length, faturamentoCentavos: d.itensCentavos + d.entregaLojaCentavos, produtosCentavos: d.itensCentavos, entregasCentavos: d.entregaLojaCentavos,
      descontosCentavos: -d.promocaoLojaCentavos, comissoesCentavos: -d.comissaoCentavos, taxasCentavos: -d.transacaoCentavos, ajustesCentavos: -(d.sobDemandaCentavos + d.anunciosCentavos), liquidoCentavos: d.liquidoCentavos, aplicado,
      situacaoConferencia: !aplicado ? "NAO_APLICADO" : !conf ? "SEM_SAIPOS" : conf.diferencaCentavos || conf.soNoIfood || conf.soNaSaipos ? "DIVERGENTE" : "CONFERIDO", saipos: conf,
      repasses: ciclos.map(([k, x]) => ({ apuracaoInicio: x.apuracaoInicio, apuracaoFim: x.apuracaoFim, dataPrevista: x.repasseEsperado, situacao: situacaoDoRepasse(recebiveis.get(k), hoje) })),
    });
  }
  return { porDia, resumo, conferenciaSaipos: saipos.resumo, recebiveis };
}

export function operacoesDaConciliacaoIfood(b) {
  async function categoriaDe(tx, cx, c) {
    if (c.sistema) return b.categoriaDoSistema(tx, cx, c.sistema);
    for (const codigo of c.categorias) if (await b.categoriaPorCodigo(tx, cx, codigo)) return b.categoriaLancavel(tx, cx, codigo);
    return falhar(CODIGO.CATEGORIA_INVALIDA, "O plano de contas da unidade não tem categoria para este lançamento do iFood.", { componente: c.componente });
  }

  /** O que a aplicação faria agora. Não grava: a prévia e a aplicação usam exatamente este plano. */
  async function planejar(tx, cx) {
    const registros = await movimentosAtivos(tx, cx);
    const { resumo, pedidos } = consolidarConciliacaoIfood(registros, { conferirSaldos: false });
    const bloqueios = [];
    if (!registros.length) bloqueios.push({ codigo: "SEM_MOVIMENTOS", mensagem: "Não há movimentos confirmados da conciliação do iFood." });
    const datas = new Set(resumo.dias.map((d) => d.data));
    const competencias = [...new Set(resumo.dias.map((d) => d.data.slice(0, 7)))].sort();
    for (const competencia of competencias) {
      try { await b.exigirCompetenciaEditavel(tx, cx, competencia); } catch (e) { bloqueios.push({ codigo: "COMPETENCIA_NAO_EDITAVEL", mensagem: e?.message ?? `A competência ${competencia} não aceita lançamentos.` }); }
    }
    const lancsCanal = await tx.listar(cx, TIPO.LANCAMENTO, { onde: { canal: "IFOOD" } });
    const ativos = lancsCanal.filter((l) => l.situacao === SITUACAO_LANCAMENTO.ATIVO);
    if (ativos.some((l) => l.demonstrativoIfood && [...datas].some((d) => l.demonstrativoIfood.periodoInicio <= d && d <= l.demonstrativoIfood.periodoFim))) bloqueios.push({ codigo: "DEMONSTRATIVO_NO_PERIODO", mensagem: "Já existe demonstrativo oficial do iFood nestes dias: o faturamento seria somado duas vezes." });
    if (ativos.some((l) => l.categoria === "VENDA_IFOOD" && !l.demonstrativoIfood && !l.conciliacaoIfood && datas.has(l.dataOperacao))) bloqueios.push({ codigo: "RECEITA_IFOOD_DE_OUTRA_ORIGEM", mensagem: "Há receita iFood de outra origem nestes dias: reverta antes de aplicar o relatório oficial." });
    const vendas = (await tx.listar(cx, TIPO.VENDA, { onde: { canal: "IFOOD", situacao: SITUACAO_VENDA.ATIVA } })).filter((v) => datas.has(v.dataVenda));
    if (vendas.length) bloqueios.push({ codigo: "VENDAS_IFOOD_APLICADAS", mensagem: `${vendas.length} venda(s) iFood já aplicada(s) nestes dias: a SAIPOS não é a fonte do iFood.`, quantidade: vendas.length });

    const propria = lancsCanal.filter((l) => l.conciliacaoIfood);
    const atual = new Map(propria.filter((l) => l.situacao === SITUACAO_LANCAMENTO.ATIVO).map((l) => [`${l.conciliacaoIfood.dia}|${l.conciliacaoIfood.componente}`, l]));
    const versao = new Map();
    for (const l of propria) { const k = `${l.conciliacaoIfood.dia}|${l.conciliacaoIfood.componente}`; versao.set(k, Math.max(versao.get(k) ?? 0, l.conciliacaoIfood.versao)); }
    const criar = [];
    const manter = [];
    const cancelar = [];
    const desejados = new Set();
    for (const dia of resumo.dias) {
      for (const c of COMPONENTES) {
        const valorCentavos = c.sinal * dia[c.campo];
        if (valorCentavos < 0) bloqueios.push({ codigo: "VALOR_COM_SINAL_INVERTIDO", mensagem: `${c.descricao} de ${dia.data} tem sinal inesperado: conferir antes de lançar.` });
        if (valorCentavos <= 0) continue;
        const k = `${dia.data}|${c.componente}`;
        desejados.add(k);
        const existente = atual.get(k);
        if (existente?.valorCentavos === valorCentavos) { manter.push(existente); continue; }
        if (existente) cancelar.push(existente);
        criar.push({ c, dia: dia.data, valorCentavos, versao: (versao.get(k) ?? 0) + 1, movimentosDoDia: registros.filter((r) => dataDoMovimento(r) === dia.data).length });
      }
    }
    for (const [k, l] of atual) if (!desejados.has(k)) cancelar.push(l);

    const recebiveis = await repassesDaConciliacao(tx, cx);
    const recebivelAtivo = new Map(recebiveis.filter((r) => r.situacao !== SITUACAO_TITULO.CANCELADA).map((r) => [repasseDoId(r.fonte.idExterno).chave, r]));
    const versaoRepasse = new Map();
    for (const r of recebiveis) { const { chave, versao: v } = repasseDoId(r.fonte.idExterno); versaoRepasse.set(chave, Math.max(versaoRepasse.get(chave) ?? 0, v)); }
    const repasses = { criar: [], manter: [], cancelar: [] };
    const avisos = [];
    for (const r of resumo.repasses) {
      const k = chaveDoRepasse(r);
      const existente = recebivelAtivo.get(k);
      if (existente?.valorBaseCentavos === r.previstoCentavos) { repasses.manter.push(existente); continue; }
      if (existente?.liquidadoCentavos > 0) { bloqueios.push({ codigo: "REPASSE_JA_RECEBIDO_MUDOU", mensagem: `O repasse previsto para ${r.dataPrevista} mudou depois de ter recebimento vinculado: estorne o recebimento antes.` }); continue; }
      if (existente) repasses.cancelar.push(existente);
      if (r.previstoCentavos > 0) repasses.criar.push({ ...r, versao: (versaoRepasse.get(k) ?? 0) + 1 });
      else avisos.push({ codigo: "REPASSE_SEM_SALDO", mensagem: `O ciclo com repasse previsto para ${r.dataPrevista} não tem saldo positivo: nenhum recebível foi previsto.` });
    }
    const conferencia = await conferenciaComSaipos(tx, cx, resumo.dias, pedidos);
    return { registros, resumo, bloqueios, avisos, criar, manter, cancelar, repasses, competencias, conferencia: conferencia.resumo };
  }

  const resumoDoPlano = (p) => ({
    movimentos: p.registros.length, pedidos: p.resumo.total.pedidos, pedidosCancelados: p.resumo.total.pedidosCancelados, periodo: { inicio: p.resumo.dias[0]?.data ?? null, fim: p.resumo.dias.at(-1)?.data ?? null },
    dias: p.resumo.dias.length,
    valores: {
      produtosCentavos: p.resumo.total.itensCentavos, entregasCentavos: p.resumo.total.entregaLojaCentavos, faturamentoCentavos: p.resumo.total.itensCentavos + p.resumo.total.entregaLojaCentavos,
      promocoesLojaCentavos: -p.resumo.total.promocaoLojaCentavos, comissoesCentavos: -p.resumo.total.comissaoCentavos, taxaTransacaoCentavos: -p.resumo.total.transacaoCentavos,
      entregaSobDemandaCentavos: -p.resumo.total.sobDemandaCentavos, anunciosCentavos: -p.resumo.total.anunciosCentavos, liquidoCentavos: p.resumo.total.liquidoCentavos,
      repassePrevistoCentavos: p.resumo.repassePrevistoCentavos, recebidoDiretoCentavos: p.resumo.recebidoDiretoCentavos,
    },
    lancamentos: { criar: p.criar.length, manter: p.manter.length, cancelar: p.cancelar.length },
    repasses: { criar: p.repasses.criar.length, manter: p.repasses.manter.length, cancelar: p.repasses.cancelar.length, itens: p.resumo.repasses.map((r) => ({ apuracaoInicio: r.apuracaoInicio, apuracaoFim: r.apuracaoFim, dataPrevista: r.dataPrevista, previstoCentavos: r.previstoCentavos, situacao: r.situacao })) },
    conferenciaSaipos: p.conferencia, bloqueios: p.bloqueios, avisos: p.avisos, podeAplicar: p.bloqueios.length === 0,
  });

  async function exigirImportacao(tx, cx, importacaoId) {
    const imp = await b.obterOuFalhar(tx, cx, TIPO.IMPORTACAO, importacaoId, "Importação");
    if (imp.tipoRelatorio !== RELATORIO_CONCILIACAO_IFOOD) falhar(CODIGO.OPERACAO_INVALIDA, "Esta importação não é um relatório de conciliação do iFood.");
    if (!CONCLUIDAS.includes(imp.estado)) falhar(CODIGO.TRANSICAO_INVALIDA, "Confirme a importação antes de aplicar ao Financeiro.", { estado: imp.estado });
    return imp;
  }

  return {
    /** Prévia dos efeitos financeiros: nada é gravado. */
    previaDaConciliacaoIfood(ctx, entrada) {
      semCamposDesconhecidos(entrada, ["importacaoId"], "previaConciliacaoIfood");
      const importacaoId = exigirUuid(entrada.importacaoId, "importacaoId");
      return b.consultar(ctx, async (cx, tx) => {
        await exigirImportacao(tx, cx, importacaoId);
        return { importacaoId, ...resumoDoPlano(await planejar(tx, cx)) };
      });
    },

    /** Grava receita, deduções, despesas e previsões de repasse numa transação. Repetir não duplica. */
    aplicarConciliacaoIfood(ctx, entrada) {
      semCamposDesconhecidos(entrada, ["importacaoId", "justificativa"], "aplicarConciliacaoIfood");
      const importacaoId = exigirUuid(entrada.importacaoId, "importacaoId");
      const justificativa = exigirTexto(entrada.justificativa, "justificativa", { max: 500 });
      return b.executar(ctx, ACAO.APLICAR, async (cx, tx) => {
        const imp = await exigirImportacao(tx, cx, importacaoId);
        const inicial = await movimentosAtivos(tx, cx);
        const meses = [...new Set(inicial.map((r) => dataDoMovimento(r).slice(0, 7)))].sort();
        for (const competencia of meses) await tx.travar(cx, `formacao-competencia:${competencia}`, "EXCLUSIVA");
        const p = await planejar(tx, cx);
        if (p.bloqueios.length) falhar(CODIGO.OPERACAO_INVALIDA, p.bloqueios[0].mensagem, { bloqueios: p.bloqueios });
        const n = operacoesEconomicas(baseNaTransacao(b, tx, cx));
        for (const l of p.cancelar) await b.cancelarLancamento(tx, cx, l.id, `Nova versão do relatório oficial do iFood. ${justificativa}`);
        for (const r of p.repasses.cancelar) await n.cancelarRecebivel(cx, { recebivelId: r.id, justificativa: `Nova versão do repasse previsto pelo iFood. ${justificativa}` });
        for (const x of p.criar) {
          const categoria = await categoriaDe(tx, cx, x.c);
          const chave = `ifood-conciliacao:${x.dia}:${x.c.componente}:v${x.versao}`;
          await b.lancar(tx, cx, categoria, {
            valorCentavos: x.valorCentavos, moeda: "BRL", descricao: `${x.c.descricao} de ${x.dia}`, dataOperacao: x.dia, competencia: x.dia.slice(0, 7), canal: "IFOOD", retidoNoRepasse: x.c.sinal < 0,
            fonte: { sistema: "IFOOD", idExterno: chave }, origem: { tipo: TIPO.IMPORTACAO, id: imp.id, documentoId: imp.documentoId }, chaveIdempotencia: chave, impressao: null,
            conciliacaoIfood: { dia: x.dia, componente: x.c.componente, versao: x.versao, movimentosDoDia: x.movimentosDoDia, justificativa },
          }, { documentado: true });
        }
        for (const r of p.repasses.criar) {
          await n.registrarRecebivel(cx, {
            processador: "IFOOD", canal: "IFOOD", brutoCentavos: r.previstoCentavos, retencoes: [], dataPrevista: r.dataPrevista, competencia: r.apuracaoInicio.slice(0, 7), documentoIds: [imp.documentoId],
            descricao: `Repasse previsto iFood — apuração de ${r.apuracaoInicio} a ${r.apuracaoFim}`, fonte: { sistema: "IFOOD", idExterno: idDoRepasse(r, r.versao) },
          });
        }
        return { importacaoId, ...resumoDoPlano(p), repetido: !p.criar.length && !p.cancelar.length && !p.repasses.criar.length && !p.repasses.cancelar.length };
      });
    },

    /** Rastreabilidade: as linhas do relatório que compõem um dia. */
    listarMovimentosDaConciliacaoIfood(ctx, entrada) {
      semCamposDesconhecidos(entrada, ["data"], "movimentosConciliacaoIfood");
      const data = exigirData(entrada.data, "data");
      return b.consultar(ctx, async (cx, tx) => (await movimentosAtivos(tx, cx)).filter((r) => dataDoMovimento(r) === data).sort((a, x) => a.linha - x.linha)
        .map((r) => ({ id: r.id, importacaoId: r.importacaoId, documentoId: r.documentoId, linha: r.linha, pedido: r.dados.pedido, componente: r.dados.componente, descricao: r.dados.descricaoOriginal, fatoGerador: r.dados.fatoGerador, valorCentavos: r.valorCentavos, impactaRepasse: r.dados.impactaRepasse })));
    },
  };
}
