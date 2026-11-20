// Relatório de Conciliação Financeira do iFood → efeitos financeiros, por dia do pedido e por ciclo de repasse.
//
// Regras:
//   - os movimentos importados (registros de fonte) são a base e continuam intactos: cada lançamento aponta para a importação;
//   - faturamento = produtos + entregas da loja, em categorias separadas; descontos e despesas ficam nas próprias categorias;
//   - o valor pago direto à loja já está nesse faturamento: não é receita adicional, não vira recebível nem movimentação;
//   - repasse é só PREVISÃO: o recebimento depende de conciliação autorizada com um crédito que já existe no extrato;
//   - a SAIPOS só confere: nenhuma venda é criada e a diferença fica pendente, sem ajuste;
//   - valor sem regra conhecida bloqueia a aplicação até uma decisão autorizada: nada some da DRE e nenhuma categoria é presumida;
//   - aplicar de novo não duplica. Se um relatório complementar mudar um dia, a versão anterior é cancelada (nunca apagada);
//   - competência fechada não muda sem aviso: a aplicação é recusada até a competência ser reaberta pelo fluxo próprio.
import { CODIGO, falhar } from "../dominio/erros.js";
import {
  ESTADO_IMPORTACAO as E, EVENTO_HISTORICO, NATUREZA_LANCAMENTO as N, RELACAO_CORRESPONDENCIA, SITUACAO_CORRESPONDENCIA, SITUACAO_LANCAMENTO, SITUACAO_MOVIMENTACAO,
  SITUACAO_REGISTRO_FONTE, SITUACAO_TITULO, SITUACAO_VENDA, TIPO,
} from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { unidadeUsaSwf } from "./fontesDeFaturamento.js";
import { aceitaEscrita, exigeCorrecaoAuditada } from "../dominio/fechamento.js";
import { competenciaDe, exigirData, somarDias } from "../dominio/tempo.js";
import { exigirTexto, exigirUuid, semCamposDesconhecidos } from "../dominio/validacao.js";
import { consolidarConciliacaoIfood } from "../importacao/fontes/ifoodConciliacao.js";
import { rotulo } from "../importacao/leitor.js";
import { DIVERGENCIA, sha256 } from "../importacao/motor.js";
import { baseNaTransacao } from "./base.js";
import { operacoesEconomicas } from "./economico.js";
import { competenciaHomologada } from "./importacoes.js";

export const RELATORIO_CONCILIACAO_IFOOD = "IFOOD_CONCILIACAO";
const CONCLUIDAS = [E.IMPORTADO, E.IMPORTADO_COM_PENDENCIAS];
const PREFIXO_REPASSE = "ifood-repasse:";
const PREFIXO_CLASSIFICADO = "CLASSIFICADO:";
const NAO_CLASSIFICAVEIS = Object.freeze(["DESPESAS_A_CLASSIFICAR", "DESCONTOS_A_CLASSIFICAR"]);
/** Janela do crédito no extrato em torno da data prevista (o repasse pode cair em dia útil seguinte). */
const DIAS_ANTES_DO_PREVISTO = 3;
const DIAS_DEPOIS_DO_PREVISTO = 7;

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
const repasseDoId = (id) => { const [ini, fim, prev, v] = id.slice(PREFIXO_REPASSE.length).split(":"); return { chave: `${ini}|${fim}|${prev}`, apuracaoInicio: ini, apuracaoFim: fim, dataPrevista: prev, versao: Number(v.slice(1)) }; };
const eRepasseConciliado = (r) => String(r.fonte?.idExterno ?? "").startsWith(PREFIXO_REPASSE);
const dataBR = (d) => d.split("-").reverse().join("/");
const soma = (lista, f) => lista.reduce((s, x) => s + (f(x) ?? 0), 0);

function situacaoDoRepasse(r, hoje) {
  if (r.saldoCentavos === 0) return "RECEBIDO";
  if (r.liquidadoCentavos > 0) return "PARCIAL";
  return r.dataPrevista && r.dataPrevista < hoje ? "ATRASADO" : "PREVISTO";
}

/** Movimentos ativos da conciliação no escopo. O escopo vem do contexto: outra unidade nunca entra. */
const movimentosAtivos = (tx, cx) => tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { fonte: "IFOOD", tipoRelatorio: RELATORIO_CONCILIACAO_IFOOD, situacao: SITUACAO_REGISTRO_FONTE.ATIVO } });
const repassesDaConciliacao = async (tx, cx) => (await tx.listar(cx, TIPO.RECEBIVEL, { onde: { processador: "IFOOD" } })).filter(eRepasseConciliado);
const classificacoesDa = (config) => new Map((config?.classificacoesIfood ?? []).map((x) => [x.chave, x.categoria]));

/** Tudo o que vale agora, em todas as importações ativas: versões substituídas ficam de fora. */
async function estadoConsolidado(tx, cx) {
  const registros = await movimentosAtivos(tx, cx);
  const classificacoes = classificacoesDa(await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade"));
  return { registros, classificacoes, ...consolidarConciliacaoIfood(registros, { conferirSaldos: false, classificacoes }) };
}

/** Lançamentos que um dia deve ter. Valor sempre positivo; `bruto` guarda o sinal do relatório nos valores classificados. */
function desejadosDoDia(dia) {
  const fixos = COMPONENTES.map((c) => ({ componente: c.componente, c, valorCentavos: c.sinal * dia[c.campo] }));
  const classificados = Object.entries(dia.classificados ?? {}).map(([categoria, bruto]) => ({ componente: `${PREFIXO_CLASSIFICADO}${categoria}`, categoria, bruto, valorCentavos: Math.abs(bruto) }));
  return [...fixos, ...classificados];
}

/** Conferência com a SAIPOS, por dia: só compara e aponta; nada aqui altera valor. */
async function conferenciaComSaipos(tx, cx, dias, pedidosOficiais) {
  // Unidade que usa o SWF (Subway) não tem SAIPOS: a conferência não se aplica (nunca "dias sem SAIPOS" pendentes). O iFood/99Food
  // aparece no SWF 76 só como conferência, na área SWF. Nenhum valor muda.
  if (unidadeUsaSwf(await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade"))) {
    return { porDia: new Map(), soNaSaipos: new Map(), resumo: { diasComparados: 0, diasSemSaipos: [], diasSoNaSaipos: [], diasDivergentes: [], saiposCentavos: 0, ifoodProdutosCentavos: 0, diferencaCentavos: 0, diferencaPedidos: 0, diferencaItensCentavos: 0, pedidosSoNoIfood: 0, pedidosSoNaSaipos: 0, situacao: "NAO_APLICAVEL", motivo: "A unidade usa o SWF: não há relatório SAIPOS para conferir." } };
  }
  const datas = new Set(dias.map((d) => d.data));
  const saipos = (await tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { fonte: "SAIPOS", tipoRegistro: "PEDIDO" } }))
    .filter((r) => r.situacao === SITUACAO_REGISTRO_FONTE.ATIVO && r.dados?.canal === "IFOOD" && datas.has(r.dataReferencia));
  const oficiaisDoDia = new Map();
  for (const p of pedidosOficiais.filter((x) => !x.semVenda)) oficiaisDoDia.set(p.data, [...(oficiaisDoDia.get(p.data) ?? []), p.pedido]);
  const porDia = new Map();
  for (const d of dias) {
    const lista = saipos.filter((r) => r.dataReferencia === d.data);
    if (!lista.length) { porDia.set(d.data, null); continue; }
    const validos = lista.filter((r) => !r.dados.cancelado);
    const ids = new Set(lista.map((r) => String(r.dados.idParceiro ?? "").toLowerCase()).filter(Boolean));
    const oficiais = new Set(oficiaisDoDia.get(d.data) ?? []);
    const valorCentavos = soma(validos, (r) => r.valorCentavos);
    porDia.set(d.data, {
      pedidos: validos.length, cancelados: lista.length - validos.length, valorCentavos, diferencaCentavos: valorCentavos - d.itensCentavos,
      soNoIfood: ids.size ? [...oficiais].filter((p) => !ids.has(p)).length : 0, soNaSaipos: [...ids].filter((p) => !oficiais.has(p)).length,
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

/** Importado → aguardando conferência → divergente ou conciliado. Aplicar o arquivo, sozinho, nunca concilia. */
function situacaoDoDia({ aplicado, conf, repasses }) {
  if (!aplicado) return "IMPORTADO";
  if ((conf && (conf.diferencaCentavos || conf.soNoIfood || conf.soNaSaipos)) || repasses.some((r) => r.situacao === "DIVERGENTE")) return "DIVERGENTE";
  return conf && repasses.every((r) => ["RECEBIDO", "SEM_SALDO"].includes(r.situacao)) ? "CONCILIADO" : "AGUARDANDO_CONFERENCIA";
}
function situacaoGeral(lista) {
  if (lista.some((d) => d.situacaoConferencia === "IMPORTADO")) return "IMPORTADO";
  if (lista.some((d) => d.situacaoConferencia === "DIVERGENTE")) return "DIVERGENTE";
  return lista.every((d) => d.situacaoConferencia === "CONCILIADO") ? "CONCILIADO" : "AGUARDANDO_CONFERENCIA";
}

/** Leitura diária para o calendário e a área do iFood. Só leitura. */
export async function leituraDaConciliacaoIfood(tx, cx, { inicio, fim, hoje }) {
  const { resumo, pedidos } = await estadoConsolidado(tx, cx);
  const dias = resumo.dias.filter((d) => d.data >= inicio && d.data <= fim);
  if (!dias.length) return null;
  const lancamentos = (await tx.listar(cx, TIPO.LANCAMENTO, { onde: { canal: "IFOOD" } })).filter((l) => l.conciliacaoIfood && l.situacao === SITUACAO_LANCAMENTO.ATIVO);
  const recebiveis = new Map((await repassesDaConciliacao(tx, cx)).filter((r) => r.situacao !== SITUACAO_TITULO.CANCELADA).map((r) => [repasseDoId(r.fonte.idExterno).chave, r]));
  const emDivergencia = new Set((await tx.listar(cx, TIPO.CORRESPONDENCIA, { onde: { relacao: RELACAO_CORRESPONDENCIA.IFOOD_X_UNICRED, situacao: SITUACAO_CORRESPONDENCIA.DIVERGENTE } }))
    .filter((c) => !c.resolucao).flatMap((c) => [...c.ladoA, ...c.ladoB]).filter((r) => r.tipo === TIPO.RECEBIVEL).map((r) => r.id));
  const previstoDoCiclo = new Map(resumo.repasses.map((r) => [chaveDoRepasse(r), r.previstoCentavos]));
  const situacaoDoCiclo = (k) => {
    const r = recebiveis.get(k);
    if (!r) return (previstoDoCiclo.get(k) ?? 0) <= 0 ? "SEM_SALDO" : "SEM_RECEBIVEL";
    return emDivergencia.has(r.id) ? "DIVERGENTE" : situacaoDoRepasse(r, hoje);
  };
  const saipos = await conferenciaComSaipos(tx, cx, dias, pedidos);
  const porDia = new Map();
  for (const d of dias) {
    const doDia = new Map(lancamentos.filter((l) => l.conciliacaoIfood.dia === d.data).map((l) => [l.conciliacaoIfood.componente, l.valorCentavos]));
    const desejados = desejadosDoDia(d).filter((x) => x.valorCentavos !== 0);
    const aplicado = doDia.size === desejados.length && desejados.every((x) => doDia.get(x.componente) === x.valorCentavos);
    const conf = saipos.porDia.get(d.data);
    const repasses = d.ciclos.map((k) => { const [apuracaoInicio, apuracaoFim, dataPrevista] = k.split("|"); return { apuracaoInicio, apuracaoFim, dataPrevista, situacao: situacaoDoCiclo(k) }; });
    const classificados = soma(Object.values(d.classificados ?? {}), (v) => v) + d.semClassificacaoCentavos;
    porDia.set(d.data, {
      pedidos: d.pedidos, pedidosCancelados: d.pedidosCancelados, movimentos: d.movimentos, faturamentoCentavos: d.itensCentavos + d.entregaLojaCentavos, produtosCentavos: d.itensCentavos, entregasCentavos: d.entregaLojaCentavos,
      descontosCentavos: -d.promocaoLojaCentavos, comissoesCentavos: -d.comissaoCentavos, taxasCentavos: -d.transacaoCentavos, ajustesCentavos: -(d.sobDemandaCentavos + d.anunciosCentavos + classificados), liquidoCentavos: d.liquidoCentavos, aplicado,
      situacaoConferencia: situacaoDoDia({ aplicado, conf, repasses }), saipos: conf, repasses,
    });
  }
  return { porDia, resumo, conferenciaSaipos: saipos.resumo, recebiveis, situacao: situacaoGeral([...porDia.values()]) };
}

export function operacoesDaConciliacaoIfood(b) {
  async function categoriaDe(tx, cx, x) {
    if (x.categoria) return b.categoriaLancavel(tx, cx, x.categoria);
    if (x.c.sistema) return b.categoriaDoSistema(tx, cx, x.c.sistema);
    for (const codigo of x.c.categorias) if (await b.categoriaPorCodigo(tx, cx, codigo)) return b.categoriaLancavel(tx, cx, codigo);
    return falhar(CODIGO.CATEGORIA_INVALIDA, "O plano de contas da unidade não tem categoria para este lançamento do iFood.", { componente: x.componente });
  }
  // Unidade que usa o SWF (Subway) não vende pelo Anota AI: a categoria não é oferecida (o plano de contas não muda).
  const categoriasClassificaveis = async (tx, cx) => {
    const swf = unidadeUsaSwf(await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade"));
    return (await tx.listar(cx, TIPO.CATEGORIA))
      .filter((c) => c.ativa && c.aceitaLancamento && [N.RECEITA, N.DEDUCAO, N.DESPESA].includes(c.natureza) && !NAO_CLASSIFICAVEIS.includes(c.codigo) && !(swf && c.codigo === "VENDA_ANOTA_AI"));
  };

  /** O que a aplicação faria agora. Não grava: a prévia e a aplicação usam exatamente este plano. */
  async function planejar(tx, cx) {
    const { registros, resumo, pedidos, divergencias } = await estadoConsolidado(tx, cx);
    const bloqueios = [];
    if (!registros.length) bloqueios.push({ codigo: "SEM_MOVIMENTOS", mensagem: "Não há movimentos confirmados da conciliação do iFood." });
    for (const p of resumo.pendenciasDeClassificacao) {
      bloqueios.push({ codigo: p.tipo, chave: p.chave, valorCentavos: p.valorCentavos, mensagem: p.tipo === "PEDIDO_SEM_VENDA_ORIGINAL" ? `${p.descricao}: importe o relatório da venda original ou classifique o valor.` : `Lançamento "${p.descricao}" sem classificação: classifique antes de aplicar.` });
    }
    const avisosDeLeitura = new Set([DIVERGENCIA.PERIODO_DO_DOCUMENTO, DIVERGENCIA.VALOR_A_CLASSIFICAR]);
    for (const d of divergencias.filter((x) => !avisosDeLeitura.has(x.codigo))) bloqueios.push({ codigo: d.codigo, mensagem: d.mensagem });

    // Correção parcial: a versão nova substituiu movimentos de dias que ela não cobre. Ausência aqui não significa cancelamento.
    const importacoes = (await tx.listar(cx, TIPO.IMPORTACAO, { onde: { fonte: "IFOOD", tipoRelatorio: RELATORIO_CONCILIACAO_IFOOD } })).filter((i) => CONCLUIDAS.includes(i.estado));
    const coberto = (data) => importacoes.some((i) => i.periodoInicio <= data && data <= i.periodoFim);
    const descobertos = (await tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { fonte: "IFOOD", tipoRelatorio: RELATORIO_CONCILIACAO_IFOOD, situacao: SITUACAO_REGISTRO_FONTE.SUBSTITUIDO } })).filter((r) => !coberto(r.dataReferencia));
    if (descobertos.length) {
      const datas = descobertos.map((r) => r.dataReferencia).sort();
      bloqueios.push({ codigo: "SUBSTITUICAO_PARCIAL", quantidade: descobertos.length, mensagem: `A versão corrigida não cobre ${descobertos.length} movimento(s) de ${dataBR(datas[0])} a ${dataBR(datas.at(-1))} da versão anterior: envie o relatório completo do período.` });
    }

    const datas = new Set(resumo.dias.map((d) => d.data));
    const lancsCanal = await tx.listar(cx, TIPO.LANCAMENTO, { onde: { canal: "IFOOD" } });
    const ativos = lancsCanal.filter((l) => l.situacao === SITUACAO_LANCAMENTO.ATIVO);
    if (ativos.some((l) => l.demonstrativoIfood && [...datas].some((d) => l.demonstrativoIfood.periodoInicio <= d && d <= l.demonstrativoIfood.periodoFim))) bloqueios.push({ codigo: "DEMONSTRATIVO_NO_PERIODO", mensagem: "Já existe demonstrativo oficial do iFood nestes dias: o faturamento seria somado duas vezes." });
    if (ativos.some((l) => l.categoria === "VENDA_IFOOD" && !l.demonstrativoIfood && !l.conciliacaoIfood && datas.has(l.dataOperacao))) bloqueios.push({ codigo: "RECEITA_IFOOD_DE_OUTRA_ORIGEM", mensagem: "Há receita iFood de outra origem nestes dias: reverta antes de aplicar o relatório oficial." });
    const vendas = (await tx.listar(cx, TIPO.VENDA, { onde: { canal: "IFOOD", situacao: SITUACAO_VENDA.ATIVA } })).filter((v) => datas.has(v.dataVenda));
    if (vendas.length) bloqueios.push({ codigo: "VENDAS_IFOOD_APLICADAS", mensagem: `${vendas.length} venda(s) iFood já aplicada(s) nestes dias: a SAIPOS não é a fonte do iFood.`, quantidade: vendas.length });

    const categorias = new Map((await categoriasClassificaveis(tx, cx)).map((c) => [c.codigo, c]));
    const propria = lancsCanal.filter((l) => l.conciliacaoIfood);
    const atual = new Map(propria.filter((l) => l.situacao === SITUACAO_LANCAMENTO.ATIVO).map((l) => [`${l.conciliacaoIfood.dia}|${l.conciliacaoIfood.componente}`, l]));
    const versao = new Map();
    for (const l of propria) { const k = `${l.conciliacaoIfood.dia}|${l.conciliacaoIfood.componente}`; versao.set(k, Math.max(versao.get(k) ?? 0, l.conciliacaoIfood.versao)); }
    const criar = [];
    const manter = [];
    const cancelar = [];
    const desejados = new Set();
    for (const dia of resumo.dias) {
      for (const x of desejadosDoDia(dia)) {
        if (x.valorCentavos < 0) bloqueios.push({ codigo: "VALOR_COM_SINAL_INVERTIDO", mensagem: `${x.c.descricao} de ${dataBR(dia.data)} tem sinal inesperado: conferir antes de lançar.` });
        if (x.categoria) {
          const natureza = categorias.get(x.categoria)?.natureza;
          if (!natureza) bloqueios.push({ codigo: "CATEGORIA_INDISPONIVEL", mensagem: `A categoria ${x.categoria} escolhida não aceita mais lançamentos.` });
          else if ((natureza === N.RECEITA) !== (x.bruto > 0)) bloqueios.push({ codigo: "CATEGORIA_INCOMPATIVEL", mensagem: `O valor de ${dataBR(dia.data)} não combina com a natureza da categoria ${x.categoria}.` });
        }
        if (x.valorCentavos <= 0) continue;
        const k = `${dia.data}|${x.componente}`;
        desejados.add(k);
        const existente = atual.get(k);
        if (existente?.valorCentavos === x.valorCentavos) { manter.push(existente); continue; }
        if (existente) cancelar.push(existente);
        criar.push({ ...x, dia: dia.data, versao: (versao.get(k) ?? 0) + 1, movimentosDoDia: dia.movimentos });
      }
    }
    for (const [k, l] of atual) if (!desejados.has(k)) cancelar.push(l);

    const recebiveis = await repassesDaConciliacao(tx, cx);
    const recebivelAtivo = new Map(recebiveis.filter((r) => r.situacao !== SITUACAO_TITULO.CANCELADA).map((r) => [repasseDoId(r.fonte.idExterno).chave, r]));
    const versaoRepasse = new Map();
    for (const r of recebiveis) { const { chave, versao: v } = repasseDoId(r.fonte.idExterno); versaoRepasse.set(chave, Math.max(versaoRepasse.get(chave) ?? 0, v)); }
    const repasses = { criar: [], manter: [], cancelar: [] };
    const avisos = [];
    const ciclosAtuais = new Set(resumo.repasses.map(chaveDoRepasse));
    for (const r of resumo.repasses) {
      const k = chaveDoRepasse(r);
      const existente = recebivelAtivo.get(k);
      if (existente?.valorBaseCentavos === r.previstoCentavos) { repasses.manter.push(existente); continue; }
      if (existente?.liquidadoCentavos > 0) { bloqueios.push({ codigo: "REPASSE_JA_RECEBIDO_MUDOU", mensagem: `O repasse previsto para ${dataBR(r.dataPrevista)} mudou depois de ter recebimento vinculado: revise a conciliação antes de aplicar.` }); continue; }
      if (existente) repasses.cancelar.push(existente);
      if (r.previstoCentavos > 0) repasses.criar.push({ ...r, versao: (versaoRepasse.get(k) ?? 0) + 1 });
      else avisos.push({ codigo: "REPASSE_SEM_SALDO", mensagem: `O ciclo com repasse previsto para ${dataBR(r.dataPrevista)} não tem saldo positivo: nenhum recebível será previsto.` });
    }
    // Ciclo que sumiu de uma substituição completa: sem recebimento, a previsão é cancelada; com recebimento, nada é tocado e a revisão fica pendente.
    for (const [k, r] of recebivelAtivo) {
      if (ciclosAtuais.has(k)) continue;
      if (r.liquidadoCentavos > 0) bloqueios.push({ codigo: "CICLO_RETIRADO_COM_RECEBIMENTO", mensagem: `O ciclo com repasse previsto para ${dataBR(r.dataPrevista)} saiu do relatório corrigido, mas já tem recebimento vinculado: revise antes de aplicar.` });
      else repasses.cancelar.push(r);
    }

    // Só bloqueia a competência fechada que este plano realmente alteraria.
    const alteradas = new Set([...criar.map((x) => x.dia.slice(0, 7)), ...cancelar.map((l) => l.competencia), ...repasses.criar.map((r) => r.apuracaoInicio.slice(0, 7)), ...repasses.cancelar.map((r) => r.competencia)]);
    const competenciasAlteradas = [...alteradas].sort();
    for (const competencia of competenciasAlteradas) {
      const estado = (await b.competenciaAtual(tx, cx, competencia))?.estado;
      if (estado && !aceitaEscrita(estado)) bloqueios.push({ codigo: "COMPETENCIA_FECHADA_COM_ALTERACAO", competencia, mensagem: `Este relatório altera a competência ${competencia}, que está homologada: abra a revisão formal antes de aplicar.` });
      else if (estado && exigeCorrecaoAuditada(estado)) avisos.push({ codigo: "CORRECAO_EM_FECHAMENTO", competencia, mensagem: `A competência ${competencia} está em fechamento: aplicar exige a permissão de correção e fica registrado no histórico.` });
    }
    const conferencia = await conferenciaComSaipos(tx, cx, resumo.dias, pedidos);
    return { registros, resumo, bloqueios, avisos, criar, manter, cancelar, repasses, competenciasAlteradas, conferencia: conferencia.resumo };
  }

  const resumoDoPlano = (p) => ({
    movimentos: p.registros.length, pedidos: p.resumo.total.pedidos, pedidosCancelados: p.resumo.total.pedidosCancelados, periodo: { inicio: p.resumo.dias[0]?.data ?? null, fim: p.resumo.dias.at(-1)?.data ?? null },
    dias: p.resumo.dias.length,
    valores: {
      produtosCentavos: p.resumo.total.itensCentavos, entregasCentavos: p.resumo.total.entregaLojaCentavos, faturamentoCentavos: p.resumo.total.itensCentavos + p.resumo.total.entregaLojaCentavos,
      promocoesIfoodCentavos: p.resumo.total.promocaoIfoodCentavos, promocoesRedeCentavos: p.resumo.total.promocaoRedeCentavos,
      promocoesLojaCentavos: -p.resumo.total.promocaoLojaCentavos, comissoesCentavos: -p.resumo.total.comissaoCentavos, taxaTransacaoCentavos: -p.resumo.total.transacaoCentavos,
      entregaSobDemandaCentavos: -p.resumo.total.sobDemandaCentavos, anunciosCentavos: -p.resumo.total.anunciosCentavos, classificadosCentavos: p.resumo.total.classificadosCentavos, semClassificacaoCentavos: p.resumo.total.semClassificacaoCentavos,
      liquidoCentavos: p.resumo.total.liquidoCentavos, repassePrevistoCentavos: p.resumo.repassePrevistoCentavos, recebidoDiretoCentavos: p.resumo.recebidoDiretoCentavos,
    },
    // Competência = data do fato (venda/lançamento); a data de repasse só diz QUANDO o valor é descontado ou pago.
    porCompetencia: Object.values(p.resumo.dias.reduce((acc, d) => {
      const m = (acc[d.data.slice(0, 7)] ??= { competencia: d.data.slice(0, 7), brutoCentavos: 0, anunciosCentavos: 0, classificadosCentavos: 0, semClassificacaoCentavos: 0, liquidoCentavos: 0, repassesDeDesconto: new Set() });
      m.brutoCentavos += d.itensCentavos + d.entregaLojaCentavos; m.anunciosCentavos += d.anunciosCentavos; m.classificadosCentavos += d.classificadosCentavos;
      m.semClassificacaoCentavos += d.semClassificacaoCentavos; m.liquidoCentavos += d.liquidoCentavos;
      for (const c of d.ciclos) m.repassesDeDesconto.add(c.split("|")[2]);
      return acc;
    }, {})).map((m) => ({ ...m, repassesDeDesconto: [...m.repassesDeDesconto].sort() })).sort((a, b) => a.competencia.localeCompare(b.competencia)),
    lancamentos: { criar: p.criar.length, manter: p.manter.length, cancelar: p.cancelar.length },
    repasses: { criar: p.repasses.criar.length, manter: p.repasses.manter.length, cancelar: p.repasses.cancelar.length, itens: p.resumo.repasses.map((r) => ({ apuracaoInicio: r.apuracaoInicio, apuracaoFim: r.apuracaoFim, dataPrevista: r.dataPrevista, previstoCentavos: r.previstoCentavos, situacao: r.situacao })) },
    pendenciasDeClassificacao: p.resumo.pendenciasDeClassificacao,
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
        const plano = resumoDoPlano(await planejar(tx, cx));
        const categorias = plano.pendenciasDeClassificacao.length ? (await categoriasClassificaveis(tx, cx)).map((c) => ({ codigo: c.codigo, nome: c.nome, natureza: c.natureza })) : [];
        return { importacaoId, ...plano, categoriasPermitidas: categorias };
      });
    },

    /**
     * Decisão autorizada sobre um valor sem regra conhecida: a pessoa escolhe a categoria e justifica. A decisão fica no
     * histórico da configuração da unidade; a linha original do relatório não muda. Só vale depois de aplicar.
     */
    classificarLancamentoIfood(ctx, entrada) {
      semCamposDesconhecidos(entrada, ["chave", "categoria", "justificativa"], "classificacaoIfood");
      const chave = exigirTexto(entrada.chave, "chave", { max: 300 });
      const codigo = exigirTexto(entrada.categoria, "categoria", { max: 120 });
      const justificativa = exigirTexto(entrada.justificativa, "justificativa", { max: 500 });
      return b.executar(ctx, ACAO.CONFIGURAR, async (cx, tx) => {
        await tx.travar(cx, "configuracao-unidade", "EXCLUSIVA");
        const atual = await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade");
        if (!atual) falhar(CODIGO.OPERACAO_INVALIDA, "Configure a unidade antes de classificar lançamentos.");
        const lista = Array.isArray(atual.classificacoesIfood) ? atual.classificacoesIfood : [];
        const { resumo } = await estadoConsolidado(tx, cx);
        const pendencia = resumo.pendenciasDeClassificacao.find((p) => p.chave === chave);
        const anterior = lista.find((x) => x.chave === chave);
        if (!pendencia && !anterior) falhar(CODIGO.NAO_ENCONTRADO, "Não há pendência de classificação com esta chave.");
        const categoria = (await categoriasClassificaveis(tx, cx)).find((c) => c.codigo === codigo);
        if (!categoria) falhar(CODIGO.CATEGORIA_INVALIDA, "Escolha uma categoria de receita, dedução ou despesa que aceite lançamentos.", { categoria: codigo });
        if (pendencia && (categoria.natureza === N.RECEITA) !== (pendencia.valorCentavos > 0)) falhar(CODIGO.CATEGORIA_INVALIDA, "A natureza da categoria não combina com o sinal do valor.", { categoria: codigo });
        const decisao = { chave, categoria: codigo, descricao: pendencia?.descricao ?? anterior.descricao, justificativa, em: b.agora(), por: cx.usuarioId, anteriores: anterior ? [...(anterior.anteriores ?? []), { categoria: anterior.categoria, em: anterior.em, por: anterior.por, justificativa: anterior.justificativa }] : [] };
        await b.alterar(tx, cx, TIPO.CONFIGURACAO_UNIDADE, atual, { classificacoesIfood: [...lista.filter((x) => x.chave !== chave), decisao] }, EVENTO_HISTORICO.CONFIGURACAO, justificativa);
        return { classificacao: decisao };
      });
    },

    /** Grava receita, deduções, despesas e previsões de repasse numa transação. Repetir não duplica. */
    aplicarConciliacaoIfood(ctx, entrada) {
      semCamposDesconhecidos(entrada, ["importacaoId", "justificativa"], "aplicarConciliacaoIfood");
      const importacaoId = exigirUuid(entrada.importacaoId, "importacaoId");
      const justificativa = exigirTexto(entrada.justificativa, "justificativa", { max: 500 });
      return b.executar(ctx, ACAO.APLICAR, async (cx, tx) => {
        const imp = await exigirImportacao(tx, cx, importacaoId);
        const previo = await estadoConsolidado(tx, cx);
        const meses = [...new Set(previo.resumo.dias.map((d) => d.data.slice(0, 7)))].sort();
        for (const competencia of meses) await tx.travar(cx, `formacao-competencia:${competencia}`, "EXCLUSIVA");
        const p = await planejar(tx, cx);
        if (p.bloqueios.length) falhar(CODIGO.OPERACAO_INVALIDA, p.bloqueios[0].mensagem, { bloqueios: p.bloqueios });
        for (const competencia of p.competenciasAlteradas) await b.exigirCompetenciaEditavel(tx, cx, competencia);
        const n = operacoesEconomicas(baseNaTransacao(b, tx, cx));
        for (const l of p.cancelar) await b.cancelarLancamento(tx, cx, l.id, `Nova versão do relatório oficial do iFood. ${justificativa}`);
        for (const r of p.repasses.cancelar) await n.cancelarRecebivel(cx, { recebivelId: r.id, justificativa: `Nova versão do repasse previsto pelo iFood. ${justificativa}` });
        for (const x of p.criar) {
          const categoria = await categoriaDe(tx, cx, x);
          const chave = `ifood-conciliacao:${x.dia}:${x.componente}:v${x.versao}`;
          await b.lancar(tx, cx, categoria, {
            valorCentavos: x.valorCentavos, moeda: "BRL", descricao: `${x.c?.descricao ?? `Lançamento iFood classificado (${categoria.nome})`} de ${x.dia}`, dataOperacao: x.dia, competencia: x.dia.slice(0, 7), canal: "IFOOD", retidoNoRepasse: categoria.natureza !== N.RECEITA,
            fonte: { sistema: "IFOOD", idExterno: chave }, origem: { tipo: TIPO.IMPORTACAO, id: imp.id, documentoId: imp.documentoId }, chaveIdempotencia: chave, impressao: null,
            conciliacaoIfood: { dia: x.dia, componente: x.componente, versao: x.versao, movimentosDoDia: x.movimentosDoDia, justificativa },
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

    /**
     * Propõe, para cada repasse em aberto, os créditos que JÁ existem na conta e podem corresponder a ele. Só cria candidatas:
     * nada é baixado, nenhuma movimentação é criada e a decisão continua com uma pessoa na conciliação.
     */
    gerarCandidatasDeRepasseIfood(ctx, entrada = {}) {
      semCamposDesconhecidos(entrada, [], "candidatasRepasseIfood");
      return b.executar(ctx, ACAO.CONCILIAR, async (cx, tx) => {
        const abertos = (await repassesDaConciliacao(tx, cx)).filter((r) => r.situacao !== SITUACAO_TITULO.CANCELADA && r.saldoCentavos > 0);
        const disponivel = (m) => m.valorCentavos - m.alocadoCentavos;
        const creditos = (await tx.listar(cx, TIPO.MOVIMENTACAO, { onde: { situacao: SITUACAO_MOVIMENTACAO.VALIDA } }))
          .filter((m) => m.sentido === "ENTRADA" && !m.pagamentoId && !m.transferenciaId && disponivel(m) > 0);
        const contas = new Map((await tx.listar(cx, TIPO.CONTA)).map((c) => [c.id, c]));
        const citaIfood = (m) => rotulo(m.descricao).includes("ifood");
        const pares = abertos.map((r) => {
          const inicio = somarDias(r.dataPrevista, -DIAS_ANTES_DO_PREVISTO);
          const fim = somarDias(r.dataPrevista, DIAS_DEPOIS_DO_PREVISTO);
          const naJanela = creditos.filter((m) => m.dataEfetiva >= inicio && m.dataEfetiva <= fim);
          return { r, lista: naJanela.filter((m) => disponivel(m) === r.saldoCentavos || citaIfood(m)) };
        });
        const usos = new Map();
        for (const { lista } of pares) for (const m of lista) usos.set(m.id, (usos.get(m.id) ?? 0) + 1);
        let criadas = 0; let existentes = 0; let bloqueadasPorHomologacao = 0;
        for (const { r, lista } of pares) {
          for (const m of lista) {
            const igual = disponivel(m) === r.saldoCentavos;
            const ladoA = [{ tipo: TIPO.RECEBIVEL, id: r.id, valorCentavos: r.saldoCentavos }];
            const ladoB = [{ tipo: TIPO.MOVIMENTACAO, id: m.id, valorCentavos: disponivel(m) }];
            const chave = `${RELACAO_CORRESPONDENCIA.IFOOD_X_UNICRED}|${sha256([r.id, m.id].sort().join(","))}`;
            if (await tx.buscarPorChave(cx, TIPO.CORRESPONDENCIA, chave)) { existentes += 1; continue; }
            const comps = [r.competencia, competenciaDe(m.dataEfetiva)].sort();
            if (await competenciaHomologada(tx, cx, comps.at(-1))) { bloqueadasPorHomologacao += 1; continue; }
            const ciclo = repasseDoId(r.fonte.idExterno);
            await b.criar(tx, cx, TIPO.CORRESPONDENCIA, {
              ladoA, ladoB, evidenciaDocumentoIds: [...new Set([...(r.documentoIds ?? []), ...(m.documentoId ? [m.documentoId] : [])])], diferencaCentavos: r.saldoCentavos - disponivel(m),
              justificativa: `Repasse iFood da apuração de ${dataBR(ciclo.apuracaoInicio)} a ${dataBR(ciclo.apuracaoFim)}, previsto para ${dataBR(ciclo.dataPrevista)}: crédito de ${dataBR(m.dataEfetiva)}${igual ? " com o mesmo valor" : " com valor diferente"}.`,
              situacao: SITUACAO_CORRESPONDENCIA.CANDIDATA, responsavelId: null, decididoEm: null, justificativaDecisao: null, relacao: RELACAO_CORRESPONDENCIA.IFOOD_X_UNICRED, regra: igual ? "REPASSE_IFOOD_VALOR_E_JANELA" : "REPASSE_IFOOD_CREDITO_COM_DIFERENCA",
              forca: igual && citaIfood(m) && lista.length === 1 && usos.get(m.id) === 1 ? "FORTE" : "FRACA", chaveIdempotencia: chave, impressao: null, competencia: comps[0], competenciaDaConciliacao: comps.at(-1),
              repasseIfood: { ...ciclo, chave: undefined, versao: undefined, valorEsperadoCentavos: r.saldoCentavos, instituicao: contas.get(m.contaId)?.nome ?? null },
            });
            criadas += 1;
          }
        }
        return { repassesEmAberto: abertos.length, criadas, existentes, bloqueadasPorHomologacao, semCredito: pares.filter((p) => !p.lista.length).map((p) => ({ dataPrevista: p.r.dataPrevista, valorCentavos: p.r.saldoCentavos })) };
      });
    },

    /** Rastreabilidade: as linhas do relatório que compõem um dia. */
    listarMovimentosDaConciliacaoIfood(ctx, entrada) {
      semCamposDesconhecidos(entrada, ["data"], "movimentosConciliacaoIfood");
      const data = exigirData(entrada.data, "data");
      return b.consultar(ctx, async (cx, tx) => {
        const { registros, pedidos } = await estadoConsolidado(tx, cx);
        const diaDoPedido = new Map(pedidos.map((p) => [p.pedido, p.data]));
        return registros.filter((r) => (r.dados.pedido ? diaDoPedido.get(r.dados.pedido) : r.dataReferencia) === data).sort((a, x) => a.linha - x.linha)
          .map((r) => ({ id: r.id, importacaoId: r.importacaoId, documentoId: r.documentoId, linha: r.linha, pedido: r.dados.pedido, componente: r.dados.componente, descricao: r.dados.descricaoOriginal, fatoGerador: r.dados.fatoGerador, valorCentavos: r.valorCentavos, impactaRepasse: r.dados.impactaRepasse }));
      });
    },
  };
}
