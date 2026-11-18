// Relatório oficial da 99Food → lançamentos por dia. Só entra na DRE o que o relatório nomeia com natureza clara:
// vendas de itens, taxas de processamento, comissões e marketing. Recompensas e receita de ofertas ficam guardadas e visíveis.
// O repasse informado NÃO vira recebível nem crédito: o arquivo não traz data, ciclo nem comprovante de pagamento.
// Cada dia é conferido sozinho: diferenças de dias diferentes nunca se compensam. Nenhum lançamento cobre a diferença.
// A loja só é aceita depois de um vínculo administrativo. A SAIPOS só confere, por dia.
// Reaplicar não duplica; um dia corrigido exige decisão registrada e a versão anterior fica guardada.
import { CODIGO, falhar } from "../dominio/erros.js";
import { CONFERENCIA_REGISTRO, ESTADO_IMPORTACAO as E, EVENTO_HISTORICO, SITUACAO_LANCAMENTO, SITUACAO_REGISTRO_FONTE, SITUACAO_VENDA, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { aceitaEscrita, exigeCorrecaoAuditada } from "../dominio/fechamento.js";
import { exigirData } from "../dominio/tempo.js";
import { exigirTexto, exigirUmDe, exigirUuid, semCamposDesconhecidos } from "../dominio/validacao.js";
import { RELATORIO_99FOOD, consolidar99Food } from "../importacao/fontes/noventaENoveFood.js";

const CANAL = "NOVENTA_E_NOVE_FOOD";
const CONCLUIDAS = [E.IMPORTADO, E.IMPORTADO_COM_PENDENCIAS];
const COMPONENTES = Object.freeze([
  { componente: "VENDAS", campo: "itensCentavos", sistema: "VENDA_NOVENTA_E_NOVE_FOOD", descricao: "Vendas de itens na 99Food", retido: false },
  { componente: "PROCESSAMENTO", campo: "processamentoCentavos", categoria: "TAXAS_DE_PROCESSAMENTO", descricao: "Taxas de processamento da 99Food", retido: true },
  { componente: "COMISSOES", campo: "comissaoCentavos", categoria: "COMISSOES_DE_PLATAFORMA", descricao: "Comissões da 99Food", retido: true },
  { componente: "MARKETING", campo: "marketingCentavos", sistema: "ANUNCIOS_99FOOD", descricao: "Marketing na 99Food", retido: true },
]);
const dataBR = (d) => d.split("-").reverse().join("/");
const soma = (lista, f) => lista.reduce((s, x) => s + (f(x) ?? 0), 0);
const movimentosAtivos = (tx, cx) => tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { fonte: "OUTRO", tipoRelatorio: RELATORIO_99FOOD, situacao: SITUACAO_REGISTRO_FONTE.ATIVO } });
const lancamentosDoRelatorio = async (tx, cx) => (await tx.listar(cx, TIPO.LANCAMENTO, { onde: { canal: CANAL } })).filter((l) => l.relatorio99Food);
const importacoesConcluidas = async (tx, cx) => (await tx.listar(cx, TIPO.IMPORTACAO, { onde: { fonte: "OUTRO", tipoRelatorio: RELATORIO_99FOOD } })).filter((i) => CONCLUIDAS.includes(i.estado));
const CAMPOS_DO_DIA = ["quantidade", "itensCentavos", "processamentoCentavos", "comissaoCentavos", "marketingCentavos", "recompensasCentavos", "receitaOfertaCentavos", "repasseCentavos"];
const valoresDoDia = (dados) => Object.fromEntries(CAMPOS_DO_DIA.map((k) => [k, dados[k]]));

/** Comparação possível com um relatório diário: quantidade e valor de itens. Nunca concilia pedido a pedido. */
async function conferenciaComSaipos(tx, cx, dias) {
  const datas = new Set(dias.map((d) => d.data));
  const inicio = dias[0]?.data; const fim = dias.at(-1)?.data;
  const todos = (await tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { fonte: "SAIPOS", tipoRegistro: "PEDIDO" } }))
    .filter((r) => r.situacao === SITUACAO_REGISTRO_FONTE.ATIVO && r.dados?.canal === CANAL && !r.dados.cancelado && r.dataReferencia >= inicio && r.dataReferencia <= fim);
  const itensDe = (lista) => soma(lista, (r) => r.dados.itensCentavos ?? r.valorCentavos);
  const porDia = new Map();
  for (const d of dias) {
    const lista = todos.filter((r) => r.dataReferencia === d.data);
    if (!lista.length) { porDia.set(d.data, null); continue; }
    const itensCentavos = itensDe(lista);
    porDia.set(d.data, { pedidos: lista.length, itensCentavos, diferencaPedidos: lista.length - d.quantidade, diferencaItensCentavos: itensCentavos - d.itensCentavos });
  }
  const soNaSaipos = new Map();
  for (const data of new Set(todos.filter((r) => !datas.has(r.dataReferencia)).map((r) => r.dataReferencia))) {
    const lista = todos.filter((r) => r.dataReferencia === data);
    soNaSaipos.set(data, { pedidos: lista.length, itensCentavos: itensDe(lista) });
  }
  const comparados = dias.filter((d) => porDia.get(d.data));
  return {
    porDia, soNaSaipos,
    resumo: {
      diasComparados: comparados.length, diasSemSaipos: dias.filter((d) => !porDia.get(d.data)).map((d) => d.data), diasSoNaSaipos: [...soNaSaipos.keys()].sort(),
      diasDivergentes: comparados.filter((d) => porDia.get(d.data).diferencaPedidos || porDia.get(d.data).diferencaItensCentavos).map((d) => d.data),
      diferencaPedidos: soma(comparados, (d) => porDia.get(d.data).diferencaPedidos), diferencaItensCentavos: soma(comparados, (d) => porDia.get(d.data).diferencaItensCentavos), situacao: "PENDENTE_DE_CONFERENCIA",
    },
  };
}

/** Correções recebidas que ainda não foram adotadas nem descartadas, comparadas com a versão efetiva do dia. */
function correcoesPendentes({ importacoes, ativos, descartadas }) {
  const vigentePorChave = new Map(ativos.map((r) => [r.chaveIdempotencia, r]));
  const confirmadaEm = new Map(importacoes.map((i) => [i.id, i.confirmadoEm]));
  const saida = new Map();
  for (const imp of importacoes) {
    for (const x of imp.relatorio?.conflitos ?? []) {
      const vigente = vigentePorChave.get(x.chave);
      if (!vigente || vigente.impressao === x.impressao || descartadas.has(`${x.chave}|${x.impressao}`)) continue;
      if (String(confirmadaEm.get(vigente.importacaoId) ?? "") > String(imp.confirmadoEm ?? "")) continue; // já há versão efetiva mais nova
      saida.set(`${x.chave}|${x.impressao}`, { importacaoId: imp.id, data: x.data, vigente: valoresDoDia(vigente.dados), informado: valoresDoDia(x.dados) });
    }
  }
  return [...saida.values()].sort((a, x) => a.data.localeCompare(x.data));
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
    const diverge = d.diferencaRepasseCentavos !== 0 || (conf && (conf.diferencaPedidos || conf.diferencaItensCentavos));
    porDia.set(d.data, { ...d, aplicado, saipos: conf, situacaoImportacao: aplicado ? "APLICADO" : "IMPORTADO", situacaoConferencia: !aplicado ? "IMPORTADO" : diverge ? "DIVERGENTE" : "AGUARDANDO_CONFERENCIA" });
  }
  const lista = [...porDia.values()];
  const situacao = lista.some((x) => !x.aplicado) ? "IMPORTADO" : lista.some((x) => x.situacaoConferencia === "DIVERGENTE") ? "DIVERGENTE" : "AGUARDANDO_CONFERENCIA";
  return {
    porDia, situacao, conferenciaSaipos: saipos.resumo, soNaSaipos: saipos.soNaSaipos, lojas: consolidado.lojas,
    divergencias: { diasDivergentes: soma(lista, (x) => x.diasDivergentes), somaAlgebricaCentavos: soma(lista, (x) => x.diferencaRepasseCentavos), somaAbsolutaCentavos: soma(lista, (x) => x.somaAbsolutaDiferencasCentavos) },
  };
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
  const descartadasDa = (config) => new Set((config?.correcoes99FoodDescartadas ?? []).map((x) => `${x.chave}|${x.impressao}`));

  /** O que a aplicação faria agora. A prévia e a aplicação usam exatamente este plano. */
  async function planejar(tx, cx) {
    const registros = await movimentosAtivos(tx, cx);
    const { total, dias, lojas } = consolidar99Food(registros);
    const bloqueios = [];
    const avisos = [];
    if (!registros.length) bloqueios.push({ codigo: "SEM_MOVIMENTOS", mensagem: "Não há dias confirmados do relatório da 99Food." });
    const config = await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade");
    const vinculada = config?.identidade99Food ?? null;
    if (lojas.length > 1) bloqueios.push({ codigo: "MAIS_DE_UMA_LOJA", mensagem: "Os relatórios importados têm mais de uma loja da 99Food." });
    if (!vinculada) bloqueios.push({ codigo: "LOJA_NAO_VINCULADA", mensagem: "A loja da 99Food ainda não foi vinculada a esta unidade: um responsável precisa confirmar o ID oficial." });
    else if (lojas.some((l) => l.id !== vinculada.id)) bloqueios.push({ codigo: "LOJA_DIFERENTE", mensagem: `O relatório é de outra loja da 99Food: esta unidade está vinculada a ${vinculada.nome}.` });
    const importacoes = await importacoesConcluidas(tx, cx);
    const correcoes = correcoesPendentes({ importacoes, ativos: registros, descartadas: descartadasDa(config) });
    if (correcoes.length) bloqueios.push({ codigo: "DADOS_CORRIGIDOS_SEM_DECISAO", quantidade: correcoes.length, mensagem: `${correcoes.length} dia(s) vieram com valores diferentes da versão efetiva: decida qual versão vale antes de aplicar.` });

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
        const mesmaConferencia = c.componente !== "VENDAS" || (existente?.relatorio99Food.repasseInformadoCentavos === dia.repasseCentavos && existente?.relatorio99Food.resultadoPreliminarCentavos === dia.composicaoCentavos);
        if (existente?.valorCentavos === valorCentavos && mesmaConferencia) { manter.push(existente); continue; }
        if (existente) cancelar.push(existente);
        criar.push({ c, dia: dia.data, valorCentavos, versao: (versao.get(k) ?? 0) + 1, conferencia: c.componente === "VENDAS" ? { repasseInformadoCentavos: dia.repasseCentavos, resultadoPreliminarCentavos: dia.composicaoCentavos, diferencaRepasseCentavos: dia.diferencaRepasseCentavos } : {} });
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
    return { registros, total, dias, lojas, bloqueios, avisos, criar, manter, cancelar, competenciasAlteradas, vinculada, correcoes, conferencia: conferencia.resumo, conferenciaPorDia: conferencia.porDia };
  }

  const resumoDoPlano = (p) => ({
    loja: p.lojas[0] ?? null, lojaVinculada: p.vinculada ? { id: p.vinculada.id, nome: p.vinculada.nome, em: p.vinculada.em } : null, periodo: { inicio: p.dias[0]?.data ?? null, fim: p.dias.at(-1)?.data ?? null }, dias: p.dias.length, quantidade: p.total.quantidade,
    valores: {
      vendasCentavos: p.total.itensCentavos, processamentoCentavos: p.total.processamentoCentavos, comissoesCentavos: p.total.comissaoCentavos, marketingCentavos: p.total.marketingCentavos, resultadoPreliminarCentavos: p.total.composicaoCentavos,
      recompensasCentavos: p.total.recompensasCentavos, receitaOfertaCentavos: p.total.receitaOfertaCentavos, repasseInformadoCentavos: p.total.repasseCentavos, diferencaRepasseCentavos: p.total.diferencaRepasseCentavos,
    },
    divergencias: { diasDivergentes: p.total.diasDivergentes, somaAlgebricaCentavos: p.total.diferencaRepasseCentavos, somaAbsolutaCentavos: p.total.somaAbsolutaDiferencasCentavos, situacao: p.total.diasDivergentes ? "PENDENTE_DE_CONFERENCIA" : "SEM_DIFERENCA" },
    valoresDiarios: p.dias.map((d) => ({ ...d, saipos: p.conferenciaPorDia.get(d.data) })), correcoesPendentes: p.correcoes, lancamentos: { criar: p.criar.length, manter: p.manter.length, cancelar: p.cancelar.length },
    conferenciaSaipos: p.conferencia, bloqueios: p.bloqueios, avisos: p.avisos, exigeAceiteDaDiferenca: p.total.diasDivergentes > 0, podeAplicar: p.bloqueios.length === 0,
  });

  return {
    /** Prévia dos efeitos financeiros: nada é gravado. */
    previaDoRelatorio99Food(ctx, entrada) {
      semCamposDesconhecidos(entrada, ["importacaoId"], "previaRelatorio99Food");
      const importacaoId = exigirUuid(entrada.importacaoId, "importacaoId");
      return b.consultar(ctx, async (cx, tx) => {
        await exigirImportacao(tx, cx, importacaoId);
        return { importacaoId, ...resumoDoPlano(await planejar(tx, cx)) };
      });
    },

    /** Vínculo administrativo: quem pode configurar confirma, digitando o ID oficial, que a loja do relatório é desta unidade. */
    vincularLoja99Food(ctx, entrada) {
      semCamposDesconhecidos(entrada, ["importacaoId", "lojaId", "justificativa"], "vinculoLoja99Food");
      const importacaoId = exigirUuid(entrada.importacaoId, "importacaoId");
      const lojaId = exigirTexto(entrada.lojaId, "lojaId", { max: 40 });
      const justificativa = exigirTexto(entrada.justificativa, "justificativa", { max: 500 });
      return b.executar(ctx, ACAO.CONFIGURAR, async (cx, tx) => {
        const imp = await exigirImportacao(tx, cx, importacaoId);
        await tx.travar(cx, "configuracao-unidade", "EXCLUSIVA");
        const config = await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade");
        if (!config) falhar(CODIGO.OPERACAO_INVALIDA, "Configure a unidade antes de vincular a loja da 99Food.");
        const registros = (await movimentosAtivos(tx, cx)).filter((r) => r.importacaoId === imp.id);
        const { lojas } = consolidar99Food(registros);
        if (lojas.length !== 1 || lojas[0].id !== lojaId) falhar(CODIGO.ENTRADA_INVALIDA, "O ID informado não confere com a loja deste relatório.", { campo: "lojaId" });
        const anterior = config.identidade99Food ?? null;
        if (anterior?.id === lojaId) return { identidade: anterior, repetido: true };
        if (anterior && (await lancamentosDoRelatorio(tx, cx)).some((l) => l.situacao === SITUACAO_LANCAMENTO.ATIVO)) falhar(CODIGO.OPERACAO_INVALIDA, "Já há lançamentos da loja vinculada: o vínculo não pode ser trocado.");
        const identidade = { ...lojas[0], importacaoId: imp.id, documentoId: imp.documentoId, justificativa, em: b.agora(), por: cx.usuarioId, anteriores: anterior ? [...(anterior.anteriores ?? []), { id: anterior.id, nome: anterior.nome, em: anterior.em, por: anterior.por }] : [] };
        await b.alterar(tx, cx, TIPO.CONFIGURACAO_UNIDADE, config, { identidade99Food: identidade }, EVENTO_HISTORICO.CONFIGURACAO, justificativa);
        return { identidade, repetido: false };
      });
    },

    /** Decide qual versão de um dia vale. Adotar guarda a anterior como substituída; manter registra o descarte da correção. */
    decidirCorrecao99Food(ctx, entrada) {
      semCamposDesconhecidos(entrada, ["importacaoId", "data", "decisao", "justificativa"], "correcao99Food");
      const importacaoId = exigirUuid(entrada.importacaoId, "importacaoId");
      const data = exigirData(entrada.data, "data");
      const decisao = exigirUmDe(entrada.decisao, ["ADOTAR", "MANTER"], "decisao");
      const justificativa = exigirTexto(entrada.justificativa, "justificativa", { max: 500 });
      return b.executar(ctx, ACAO.CONFIRMAR_IMPORTACAO, async (cx, tx) => {
        const imp = await exigirImportacao(tx, cx, importacaoId);
        await tx.travar(cx, `importacao:OUTRO:${RELATORIO_99FOOD}`, "EXCLUSIVA");
        await tx.travar(cx, "configuracao-unidade", "EXCLUSIVA");
        const config = await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade");
        if (!config) falhar(CODIGO.OPERACAO_INVALIDA, "Configure a unidade antes de decidir a correção.");
        const ativos = await movimentosAtivos(tx, cx);
        const pendentes = correcoesPendentes({ importacoes: await importacoesConcluidas(tx, cx), ativos, descartadas: descartadasDa(config) });
        if (!pendentes.some((p) => p.importacaoId === imp.id && p.data === data)) falhar(CODIGO.NAO_ENCONTRADO, "Não há correção pendente deste dia nesta importação.");
        const x = imp.relatorio.conflitos.find((c) => c.data === data);
        await b.exigirCompetenciaEditavel(tx, cx, data.slice(0, 7));
        if (decisao === "MANTER") {
          const lista = [...(config.correcoes99FoodDescartadas ?? []), { chave: x.chave, impressao: x.impressao, data, importacaoId: imp.id, justificativa, em: b.agora(), por: cx.usuarioId }];
          await b.alterar(tx, cx, TIPO.CONFIGURACAO_UNIDADE, config, { correcoes99FoodDescartadas: lista }, EVENTO_HISTORICO.CONFIGURACAO, justificativa);
          return { data, decisao };
        }
        const vigente = ativos.find((r) => r.chaveIdempotencia === x.chave);
        await b.alterar(tx, cx, TIPO.REGISTRO_FONTE, vigente, { situacao: SITUACAO_REGISTRO_FONTE.SUBSTITUIDO, substituidoPorImportacaoId: imp.id, chaveIdempotencia: `substituido:${vigente.id}` }, EVENTO_HISTORICO.SUBSTITUICAO, justificativa);
        await b.criar(tx, cx, TIPO.REGISTRO_FONTE, {
          importacaoId: imp.id, documentoId: imp.documentoId, fonte: imp.fonte, tipoRelatorio: imp.tipoRelatorio, tipoRegistro: x.tipoRegistro, idExterno: x.idExterno, identificacao: x.identificacao, linha: x.linha,
          dataReferencia: x.data, competencia: x.data.slice(0, 7), valorCentavos: x.valorCentavos, dados: x.dados, original: x.original, conferencia: CONFERENCIA_REGISTRO.NAO_CONFERIDO, situacao: SITUACAO_REGISTRO_FONTE.ATIVO, substituidoPorImportacaoId: null, chaveIdempotencia: x.chave, impressao: x.impressao,
        });
        return { data, decisao };
      });
    },

    /** Histórico das versões de um dia: a efetiva, as substituídas e as correções ainda sem decisão. */
    listarVersoesDoDia99Food(ctx, entrada) {
      semCamposDesconhecidos(entrada, ["data"], "versoesDia99Food");
      const data = exigirData(entrada.data, "data");
      return b.consultar(ctx, async (cx, tx) => {
        const versoes = (await tx.listar(cx, TIPO.REGISTRO_FONTE, { onde: { fonte: "OUTRO", tipoRelatorio: RELATORIO_99FOOD } })).filter((r) => r.dataReferencia === data)
          .map((r) => ({ id: r.id, importacaoId: r.importacaoId, situacao: r.situacao, substituidoPorImportacaoId: r.substituidoPorImportacaoId ?? null, valores: valoresDoDia(r.dados) }));
        const config = await tx.buscarPorChave(cx, TIPO.CONFIGURACAO_UNIDADE, "unidade");
        const pendentes = correcoesPendentes({ importacoes: await importacoesConcluidas(tx, cx), ativos: await movimentosAtivos(tx, cx), descartadas: descartadasDa(config) }).filter((p) => p.data === data);
        return { data, versoes, correcoesPendentes: pendentes };
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
        const p = await planejar(tx, cx);
        if (p.bloqueios.length) falhar(CODIGO.OPERACAO_INVALIDA, p.bloqueios[0].mensagem, { bloqueios: p.bloqueios });
        if (p.total.diasDivergentes > 0 && entrada.aceitarDiferencaDeRepasse !== true) falhar(CODIGO.CONFIRMACAO_EXIGIDA, "Há dias em que o repasse informado não fecha com os lançamentos: confirme que as diferenças ficam em conferência.", { diasDivergentes: p.total.diasDivergentes });
        for (const competencia of p.competenciasAlteradas) await b.exigirCompetenciaEditavel(tx, cx, competencia);
        for (const l of p.cancelar) await b.cancelarLancamento(tx, cx, l.id, `Nova versão do relatório oficial da 99Food. ${justificativa}`);
        for (const x of p.criar) {
          const categoria = await categoriaDe(tx, cx, x.c);
          const chave = `relatorio-99food:${x.dia}:${x.c.componente}:v${x.versao}`;
          await b.lancar(tx, cx, categoria, {
            valorCentavos: x.valorCentavos, moeda: "BRL", descricao: `${x.c.descricao} de ${dataBR(x.dia)}`, dataOperacao: x.dia, competencia: x.dia.slice(0, 7), canal: CANAL, retidoNoRepasse: x.c.retido,
            fonte: { sistema: "OUTRO", idExterno: chave }, origem: { tipo: TIPO.IMPORTACAO, id: imp.id, documentoId: imp.documentoId }, chaveIdempotencia: chave, impressao: null,
            relatorio99Food: { dia: x.dia, componente: x.c.componente, versao: x.versao, justificativa, ...x.conferencia },
          }, { documentado: true });
        }
        return { importacaoId, ...resumoDoPlano(p), repetido: !p.criar.length && !p.cancelar.length };
      });
    },
  };
}
