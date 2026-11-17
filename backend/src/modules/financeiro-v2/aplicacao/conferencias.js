// Central de Conferências (Execução 06C): consultas SOMENTE LEITURA que tornam operacionais os motores existentes —
// importações e prévias, propostas, correspondências, pendências agrupadas e fechamento. Nenhuma escrita nova aqui:
// receber/confirmar importação, aprovar/aplicar proposta e confirmar conciliação continuam sendo as operações próprias
// do núcleo (com suas permissões, transações, idempotência e histórico).
//
// Desempenho: LISTAS de registros (documentos, propostas, correspondências) são paginadas NO BANCO (tx.paginar) e seus
// TOTAIS vêm de agregações separadas (tx.agregar) — a página nunca muda um total. Pendências e fechamento são leituras
// DERIVADAS de vários motores (apuração, vendas, tesouraria) e, por isso, montadas a partir dos registros do escopo.
import { CODIGO, falhar } from "../dominio/erros.js";
import { ESTADO_COMPETENCIA, ESTADO_IMPORTACAO, ESTADO_PROPOSTA, EVENTO_HISTORICO, SITUACAO_ATRIBUICAO, SITUACAO_CORRESPONDENCIA, SITUACAO_REGISTRO_FONTE, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { apurar } from "../dominio/apuracao.js";
import { somarLista } from "../dominio/dinheiro.js";
import { competenciaDe, exigirData } from "../dominio/tempo.js";
import { exigirTexto, exigirUmDe, exigirUuid, semCamposDesconhecidos } from "../dominio/validacao.js";
import {
  EFEITO_NO_FECHAMENTO, FONTES_DA_COMPETENCIA, GRUPO, NOME_DA_OPERACAO, NOME_DO_GRUPO, POLITICA_DE_MATERIALIDADE, SITUACAO_PENDENCIA, contagemDePendencias,
  fontesDaCompetencia, impedimentosDeHomologacao, nomeDaRelacao, pendenciasDaCompetencia, periodoDa, situacaoDoFechamento,
} from "../dominio/conferencias.js";
import { divergenciasDeVendas, montarVisao } from "../dominio/vendasRecebimentos.js";
import { paginar } from "../dominio/tesouraria.js";
import { registrosDaCompetencia } from "./cargaDaCompetencia.js";
import {
  validarCompetenciaDaCentral, validarDetalhe, validarDetalheDePendencia, validarFiltroDeCorrespondencias, validarFiltroDeDocumentos, validarFiltroDePendencias,
  validarFiltroDePropostas,
} from "../contratos/conferencias.js";

const NOME_DO_RELATORIO = Object.freeze({
  SAIPOS_VENDAS: "Vendas por pedido do SAIPOS", SAIPOS_FATURAMENTO_POR_DIA: "Faturamento diário do SAIPOS", SAIPOS_FORMAS_PAGAMENTO: "Formas de pagamento do SAIPOS",
  SAIPOS_VENDAS_DIARIAS: "Vendas diárias do SAIPOS", SAIPOS_VENDAS_POR_CANAL: "Vendas por canal do SAIPOS", STONE_VENDAS: "Vendas da Stone", STONE_RECEBIMENTOS: "Recebimentos da Stone",
  UNICRED_EXTRATO: "Extrato da Unicred", FOODY_ENTREGAS: "Entregas do Foody", IFOOD_APURACAO: "Apuração do iFood",
});
export const nomeDoRelatorio = (t) => NOME_DO_RELATORIO[t] ?? FONTES_DA_COMPETENCIA.find((f) => f.tipoRelatorio === t)?.nome ?? "Relatório";
const NATUREZA_DA_OPERACAO = Object.freeze({ VENDA: "Receita de venda", VENDA_AGREGADA: "Receita agregada do dia", PAGAMENTO_STONE: "Recebível e taxas", OBRIGACAO_ENTREGADOR: "Despesa e obrigação", MOVIMENTACAO_BANCARIA: "Movimentação de conta" });
const ABERTAS = [ESTADO_PROPOSTA.PROPOSTA, ESTADO_PROPOSTA.AGUARDANDO_EVIDENCIA, ESTADO_PROPOSTA.AGUARDANDO_REVISAO, ESTADO_PROPOSTA.APROVADA];
const tamanho = (f) => ({ limite: f.tamanho, deslocamento: (f.pagina - 1) * f.tamanho });
const paginacao = (f, total) => ({ pagina: f.pagina, tamanho: f.tamanho, total, paginas: Math.max(1, Math.ceil(total / f.tamanho)) });
const docsDe = (ids, docs) => (ids ?? []).map((id) => ({ referencia: id, tipo: docs.get(id)?.tipo ?? null, descricao: docs.get(id)?.descricao ?? null }));

/** Carga completa (referência) — agora em cargaDaCompetencia.js; reexportada para quem já a usava. */
export { carregarRegistros } from "./cargaDaCompetencia.js";

/** Apuração central de uma competência sobre registros já carregados. */
export const apurarRegistros = (d, competencia, escopo, apuradoEm) => apurar({
  lancamentos: d.lancamentos, categorias: d.categorias, vendas: d.vendas, propostas: d.propostas, obrigacoes: d.obrigacoes, movimentacoes: d.movimentacoes,
  recebiveis: d.recebiveis, ajustes: d.ajustes, competencias: d.competencias,
}, { competencia, escopo, apuradoEm });

/**
 * 08E — pendências unificadas de uma competência sobre registros JÁ carregados (a mesma conta da Central). Usada também
 * pela mudança de estado do fechamento: a homologação avalia exatamente as pendências que a tela mostra.
 */
export function pendenciasDosRegistros(d, competencia, { escopo, hoje, agora }) {
  const v = montarVisao(d, hoje, { escopo, apuradoEm: agora, competencias: [competencia] });
  const apuracao = v.apuracoes.get(competencia);
  const divergenciasVendas = divergenciasDeVendas(v.ix, v.ops, v.avulsos, v.semVenda, [apuracao], hoje);
  return { v, apuracao, pendencias: pendenciasDaCompetencia({ d, competencia, hoje, apuracao, vendas: v, divergenciasVendas }) };
}

export function operacoesDeConferencias(b, { fontes, cargaCompleta = false, conferirCarga = false }) {
  const escopoDe = (cx) => ({ organizacaoId: cx.organizacaoId, unidadeId: cx.unidadeId });

  /**
   * Pendências unificadas + apuração + visão de vendas da competência. 08C: carga DIRIGIDA à competência e ao fecho dos
   * vínculos dela (cargaDaCompetencia.js); no modo de conferência, o derivado é comparado com o da carga completa.
   */
  async function analisar(cx, tx, competencia) {
    const agora = b.agora();
    const hoje = b.hoje();
    const montar = (d) => ({ d, ...pendenciasDosRegistros(d, competencia, { escopo: escopoDe(cx), hoje, agora }) });
    const derivar = (d) => {
      const a = montar(d);
      const atual = d.competencias.find((x) => x.competencia === competencia) ?? null;
      return {
        apuracao: a.apuracao, pendencias: a.pendencias, impedimentos: impedimentosDeHomologacao(d, competencia, hoje, a.apuracao), fontes: fontesDaCompetencia(d, competencia),
        fechamento: situacaoDoFechamento({ d, competencia, hoje, apuracao: a.apuracao, pendencias: a.pendencias, competenciaAtual: atual, historico: [] }), competencias: d.competencias,
      };
    };
    return montar(await registrosDaCompetencia(tx, cx, [competencia], { cargaCompleta, conferir: conferirCarga, derivar, tela: `conferências ${competencia}` }));
  }

  /** Filtro de período das importações (sobreposição com a competência) — resolvido no banco. */
  const periodoDasImportacoes = (competencia) => {
    if (!competencia) return {};
    const p = periodoDa(competencia);
    return { ate: { periodoInicio: p.fim }, desde: { periodoFim: p.inicio } };
  };

  const compatibilidadeDe = (imp) => {
    const def = fontes.compatibilidade().find((f) => f.tipoRelatorio === imp.tipoRelatorio);
    const homologado = imp.compatibilidade === "AMOSTRA_REAL";
    return {
      homologado, formatosHomologados: def?.formatosHomologados ?? [],
      texto: homologado ? "Leitor conferido com arquivo real neste formato." : def?.formatosHomologados?.length
        ? `Formato não homologado: o leitor só foi conferido com arquivo real em ${def.formatosHomologados.join(", ").toUpperCase()}. Os valores precisam de conferência manual.`
        : "Leitor sem amostra real conferida (contrato sintético). Os valores precisam de conferência manual.",
    };
  };

  /** Documento importado em linguagem de gestão (sem hash, caminho ou identificador de arquivo). */
  async function documentoLegivel(cx, tx, imp) {
    const doc = await tx.obter(cx, TIPO.DOCUMENTO, imp.documentoId);
    const [registros] = await tx.agregar(cx, TIPO.REGISTRO_FONTE, { onde: { importacaoId: imp.id, situacao: SITUACAO_REGISTRO_FONTE.ATIVO } });
    return {
      id: imp.id, nome: `${nomeDoRelatorio(imp.tipoRelatorio)} — ${imp.periodoInicio === imp.periodoFim ? imp.periodoInicio : `${imp.periodoInicio} a ${imp.periodoFim}`}`,
      descricao: doc?.descricao ?? null, fonte: imp.fonte, tipoRelatorio: imp.tipoRelatorio, relatorio: nomeDoRelatorio(imp.tipoRelatorio), tipoDeDocumento: doc?.tipo ?? null,
      periodo: { inicio: imp.periodoInicio, fim: imp.periodoFim }, recebidoEm: doc?.recebidoEm ?? imp.criadoEm?.slice(0, 10) ?? null, importadoEm: imp.confirmadoEm ?? null,
      responsavel: doc?.responsavelId ? (doc.responsavelId === cx.usuarioId ? "Você" : "Outro usuário autorizado") : "Não informado",
      registrosAtivos: registros?.quantidade ?? 0, contagens: imp.previa?.contagens ?? null, controles: imp.previa?.controles ?? null,
      estado: imp.estado, divergencias: imp.previa?.totalDivergencias ?? 0, erros: imp.previa?.totalErros ?? 0,
      versao: doc?.versaoDocumento ?? 1, substituiOutra: Boolean(imp.substituiImportacaoId), substituidaPorOutra: Boolean(imp.substituidaPorId),
      compatibilidade: compatibilidadeDe(imp),
    };
  }

  return {
    /** Abertura da Central: situação do fechamento, contagens (nunca somas de pendências) e o que falta. */
    consultarCentralDeConferencias(ctx, e) {
      const { competencia } = validarCompetenciaDaCentral(e);
      return b.consultar(ctx, async (cx, tx) => {
        const a = await analisar(cx, tx, competencia);
        const atual = a.d.competencias.find((x) => x.competencia === competencia) ?? null;
        const fontesDaComp = fontesDaCompetencia(a.d, competencia);
        const p = periodoDa(competencia);
        const contagemPorGrupo = (lista) => Object.fromEntries(lista.map((x) => [x.grupo ?? "SEM_GRUPO", x.quantidade]));
        const importacoes = contagemPorGrupo(await tx.agregar(cx, TIPO.IMPORTACAO, { ...periodoDasImportacoes(competencia), agruparPor: "estado" }));
        const propostas = contagemPorGrupo(await tx.agregar(cx, TIPO.PROPOSTA, { onde: { competencia }, agruparPor: "estado" }));
        const correspondencias = contagemPorGrupo(await tx.agregar(cx, TIPO.CORRESPONDENCIA, { onde: { competencia }, agruparPor: "situacao" }));
        const impedimentos = impedimentosDeHomologacao(a.d, competencia, b.hoje(), a.apuracao);
        const contagem = contagemDePendencias(a.pendencias);
        const fb = a.apuracao.indicadores.FATURAMENTO_BRUTO_PROPRIO;
        const corretos = [];
        if (fontesDaComp.filter((f) => f.esperada).every((f) => f.temDocumento)) corretos.push("Todos os relatórios esperados da competência foram importados.");
        if (!impedimentos.length) corretos.push("Nenhuma divergência relevante sem justificativa.");
        if (!contagem.porGrupo.CLASSIFICACOES.abertas) corretos.push("Nenhuma classificação financeira pendente.");
        if ((propostas.APLICADA ?? 0) > 0) corretos.push(`${propostas.APLICADA} proposta(s) já aplicada(s) com histórico.`);
        if ((correspondencias.CONFIRMADA ?? 0) > 0) corretos.push(`${correspondencias.CONFIRMADA} conciliação(ões) confirmada(s).`);
        return {
          dataBase: b.hoje(), competencia, periodo: p,
          fechamento: { estado: atual?.estado ?? ESTADO_COMPETENCIA.ABERTA, metodologia: atual?.metodologia ?? null, impedimentos: impedimentos.length, homologavelAgora: !impedimentos.length && [ESTADO_COMPETENCIA.FECHAMENTO_PRELIMINAR, ESTADO_COMPETENCIA.FECHAMENTO_COM_PENDENCIAS].includes(atual?.estado) },
          pendencias: contagem,
          fontes: { comDocumento: fontesDaComp.filter((f) => f.temDocumento), semDocumento: fontesDaComp.filter((f) => !f.temDocumento) },
          importacoes: { porEstado: importacoes, aguardandoRevisao: importacoes[ESTADO_IMPORTACAO.PRONTO_PARA_IMPORTAR] ?? 0 },
          propostas: { porEstado: propostas, pendentes: ABERTAS.reduce((s, k) => s + (propostas[k] ?? 0), 0) },
          conciliacoes: { porSituacao: correspondencias, candidatas: (correspondencias.CANDIDATA ?? 0) + (correspondencias.AGUARDANDO_DOCUMENTO ?? 0) },
          divergenciasRelevantes: impedimentos.map((x) => ({ codigo: x.codigo, mensagem: x.mensagem, valorCentavos: x.valorCentavos })),
          faturamento: { valorCentavos: fb.valorCentavos, situacao: fb.situacao },
          oQueEstaCorreto: corretos, materialidade: POLITICA_DE_MATERIALIDADE,
          observacao: "A quantidade de pendências é uma contagem: valores de pendências de naturezas diferentes não são somados.",
        };
      });
    },

    /** Documentos importados: lista paginada NO BANCO; totais por estado em agregação separada. */
    consultarDocumentosImportados(ctx, e) {
      const f = validarFiltroDeDocumentos(e);
      return b.consultar(ctx, async (cx, tx) => {
        const filtro = { ...periodoDasImportacoes(f.competencia), onde: f.fonte ? { fonte: f.fonte } : {}, em: f.estados ? { estado: f.estados } : {} };
        const pg = await tx.paginar(cx, TIPO.IMPORTACAO, { ...filtro, ordem: [{ campo: "criadoEm", desc: true }], ...tamanho(f) });
        const itens = [];
        for (const imp of pg.itens) itens.push(await documentoLegivel(cx, tx, imp));
        const porEstado = Object.fromEntries((await tx.agregar(cx, TIPO.IMPORTACAO, { ...filtro, agruparPor: "estado" })).map((x) => [x.grupo, x.quantidade]));
        return {
          dataBase: b.hoje(), filtro: f, itens, paginacao: paginacao(f, pg.total), porEstado,
          compatibilidade: fontes.compatibilidade().map((x) => ({ fonte: x.fonte, tipoRelatorio: x.tipoRelatorio, relatorio: nomeDoRelatorio(x.tipoRelatorio), formatosHomologados: x.formatosHomologados, homologado: x.formatosHomologados.length > 0 })),
        };
      });
    },

    /** Documento + prévia REAL produzida pelo motor (gravada na importação), relatório, registros e propostas geradas. */
    detalharImportacao(ctx, e) {
      const { id } = validarDetalhe(e);
      return b.consultar(ctx, async (cx, tx) => {
        const imp = await tx.obter(cx, TIPO.IMPORTACAO, id);
        if (!imp) falhar(CODIGO.NAO_ENCONTRADO, "Importação não encontrada.");
        const pv = imp.previa ?? null;
        return {
          dataBase: b.hoje(), documento: await documentoLegivel(cx, tx, imp),
          previa: pv ? {
            reconhecido: pv.reconhecido, validos: pv.contagens?.novos ?? null, registros: pv.contagens?.registros ?? null, linhasLidas: pv.contagens?.linhasLidas ?? null,
            rejeitados: pv.totalErros, erros: pv.erros ?? [], duplicadosNoArquivo: pv.contagens?.duplicadosNoArquivo ?? 0, jaExistentes: pv.contagens?.jaImportados ?? 0,
            conflitos: pv.contagens?.conflitos ?? 0, divergencias: pv.divergencias ?? [], totalDivergencias: pv.totalDivergencias, controles: pv.controles ?? null, amostra: pv.amostra ?? [],
          } : null,
          impressaoPrevia: imp.impressaoPrevia ?? null, relatorio: imp.relatorio ?? null,
          registrosPorTipo: (await tx.agregar(cx, TIPO.REGISTRO_FONTE, { onde: { importacaoId: id }, agruparPor: "tipoRegistro" })).map((x) => ({ tipo: x.grupo, quantidade: x.quantidade })),
          propostasGeradas: Object.fromEntries((await tx.agregar(cx, TIPO.PROPOSTA, { onde: { importacaoId: id }, agruparPor: "estado" })).map((x) => [x.grupo, x.quantidade])),
          limitacoes: [compatibilidadeDe(imp).texto, "Importar não confirma, não concilia e não homologa: os registros entram não conferidos e sem efeito financeiro."],
          acoes: { confirmar: imp.estado === ESTADO_IMPORTACAO.PRONTO_PARA_IMPORTAR, exigeAceiteDePendencias: (pv?.totalDivergencias ?? 0) > 0, gerarPropostas: [ESTADO_IMPORTACAO.IMPORTADO, ESTADO_IMPORTACAO.IMPORTADO_COM_PENDENCIAS].includes(imp.estado), permissaoExigida: ACAO.IMPORTAR },
          historico: (await tx.listarHistorico(cx, { onde: { registroTipo: TIPO.IMPORTACAO, registroId: id } })).map((h) => ({ evento: h.evento, em: h.em, estado: h.depois?.estado ?? null, justificativa: h.justificativa ?? null })),
        };
      });
    },

    /** Propostas para revisão: lista paginada NO BANCO; contagens por estado e por operação em agregação separada. */
    consultarPropostasParaRevisao(ctx, e) {
      const f = validarFiltroDePropostas(e);
      return b.consultar(ctx, async (cx, tx) => {
        const filtro = { onde: { competencia: f.competencia, ...(f.operacao ? { operacao: f.operacao } : {}) }, em: f.estados ? { estado: f.estados } : {} };
        const pg = await tx.paginar(cx, TIPO.PROPOSTA, { ...filtro, ordem: [{ campo: "dataOperacao", desc: true }], ...tamanho(f) });
        const categorias = new Map((await tx.listar(cx, TIPO.CATEGORIA)).map((c) => [c.codigo, c.nome]));
        const docs = new Map();
        for (const id of [...new Set(pg.itens.flatMap((p) => p.documentoIds ?? []))]) docs.set(id, await tx.obter(cx, TIPO.DOCUMENTO, id));
        const porEstado = Object.fromEntries((await tx.agregar(cx, TIPO.PROPOSTA, { onde: { competencia: f.competencia }, agruparPor: "estado" })).map((x) => [x.grupo, x.quantidade]));
        const porOperacao = Object.fromEntries((await tx.agregar(cx, TIPO.PROPOSTA, { onde: { competencia: f.competencia }, em: { estado: ABERTAS }, agruparPor: "operacao" })).map((x) => [x.grupo, x.quantidade]));
        return {
          dataBase: b.hoje(), filtro: f, paginacao: paginacao(f, pg.total), porEstado, abertasPorOperacao: porOperacao,
          itens: pg.itens.map((p) => ({
            id: p.id, nome: NOME_DA_OPERACAO[p.operacao] ?? "Proposta", operacao: p.operacao, origem: `${p.fonte ?? "Importação"} · ${nomeDoRelatorio(p.tipoRelatorio)}`,
            competencia: p.competencia, data: p.dataOperacao, valorCentavos: p.valorCentavos ?? null, natureza: NATUREZA_DA_OPERACAO[p.operacao] ?? p.natureza,
            categoriaSugerida: p.categoriaSugerida ? { codigo: p.categoriaSugerida, nome: categorias.get(p.categoriaSugerida) ?? p.categoriaSugerida } : null,
            estado: p.estado, confianca: p.confianca, documentos: docsDe(p.documentoIds, docs),
            pendencias: (p.divergencias ?? []).map((x) => x.mensagem), duplicidades: (p.duplicidades ?? []).length, justificativa: p.justificativa ?? null,
          })),
        };
      });
    },

    /** O que a proposta registra, por quê, com que documento, e o efeito em DRE, títulos e caixa — ANTES de aprovar. */
    detalharProposta(ctx, e) {
      const { id } = validarDetalhe(e);
      return b.consultar(ctx, async (cx, tx) => {
        const p = await tx.obter(cx, TIPO.PROPOSTA, id);
        if (!p) falhar(CODIGO.NAO_ENCONTRADO, "Proposta não encontrada.");
        const c = p.comando ?? {};
        const docs = new Map();
        for (const did of p.documentoIds ?? []) docs.set(did, await tx.obter(cx, TIPO.DOCUMENTO, did));
        const efeitos = efeitosDaProposta(p);
        const conflitos = (p.duplicidades ?? []).map((x) => ({ tipo: x.tipo, mensagem: x.mensagem ?? (x.criterio ? `Venda possível (${x.criterio === "AUTORIZACAO" ? "mesma autorização" : "mesmo valor pendente no dia"}).` : "Registro que pode representar o mesmo fato.") }));
        if (["VENDA", "VENDA_AGREGADA"].includes(p.operacao)) {
          const outra = p.operacao === "VENDA" ? "VENDA_AGREGADA" : "VENDA";
          const aplicadas = await tx.agregar(cx, TIPO.PROPOSTA, { onde: { operacao: outra, estado: ESTADO_PROPOSTA.APLICADA, dataOperacao: p.dataOperacao } });
          if (aplicadas[0]?.quantidade) conflitos.push({ tipo: "GRANULARIDADE", mensagem: "Já existe receita do mesmo dia pela outra granularidade (agregado × por pedido): aplicar esta contaria o faturamento duas vezes." });
        }
        const pode = (acao) => cx.permissoes.includes(acao);
        const estado = p.estado;
        const historico = (await tx.listarHistorico(cx, { onde: { registroTipo: TIPO.PROPOSTA, registroId: id } })).map((h) => ({ evento: h.evento, em: h.em, estado: h.depois?.estado ?? null, justificativa: h.justificativa ?? null }));
        return {
          dataBase: b.hoje(),
          proposta: {
            id: p.id, nome: NOME_DA_OPERACAO[p.operacao] ?? "Proposta", operacao: p.operacao, estado, confianca: p.confianca, competencia: p.competencia, data: p.dataOperacao,
            valorCentavos: p.valorCentavos ?? null, natureza: NATUREZA_DA_OPERACAO[p.operacao] ?? p.natureza, categoriaSugerida: p.categoriaSugerida ?? null,
            origem: `${p.fonte ?? "Importação"} · ${nomeDoRelatorio(p.tipoRelatorio)}`, registrosDeOrigem: (p.registroIds ?? []).length,
          },
          oQueSeraRegistrado: efeitos.registro, porQue: p.justificativa ?? null, documentos: docsDe(p.documentoIds, docs),
          efeitoNaDre: efeitos.dre, efeitoEmTitulos: efeitos.titulos, efeitoNoCaixa: efeitos.caixa,
          pendentes: [...(p.divergencias ?? []).map((x) => x.mensagem), ...(estado === ESTADO_PROPOSTA.AGUARDANDO_EVIDENCIA ? ["Falta evidência: a proposta não pode ser aprovada assim."] : [])],
          conflitos,
          autorizacao: {
            aprovar: { permissao: ACAO.APROVAR, disponivel: [ESTADO_PROPOSTA.PROPOSTA, ESTADO_PROPOSTA.AGUARDANDO_REVISAO].includes(estado) && !(p.operacao === "PAGAMENTO_STONE" && !c.vendaId), exigeJustificativa: estado === ESTADO_PROPOSTA.AGUARDANDO_REVISAO, voceTem: pode(ACAO.APROVAR) },
            aplicar: { permissao: ACAO.APLICAR, disponivel: estado === ESTADO_PROPOSTA.APROVADA, voceTem: pode(ACAO.APLICAR) },
            rejeitar: { permissao: ACAO.APROVAR, disponivel: ABERTAS.includes(estado), exigeJustificativa: true, voceTem: pode(ACAO.APROVAR) },
            observacao: "Aprovar NÃO registra nada: só a aplicação de uma proposta aprovada cria o efeito, numa única transação e uma única vez.",
          },
          historico,
          tecnico: { operacao: p.operacao, estado, confianca: p.confianca, regra: p.categoriaSugerida ?? null, divergencias: (p.divergencias ?? []).map((x) => x.codigo), efeitosGravados: (p.efeitos ?? []).map((x) => x.tipo) },
        };
      });
    },

    /** Correspondências: lista paginada NO BANCO (competência, situação, relação) com os dois lados; contagens separadas. */
    consultarCorrespondencias(ctx, e) {
      const f = validarFiltroDeCorrespondencias(e);
      return b.consultar(ctx, async (cx, tx) => {
        const filtro = { onde: { competencia: f.competencia, ...(f.relacao ? { relacao: f.relacao } : {}) }, em: f.situacoes ? { situacao: f.situacoes } : {} };
        const pg = await tx.paginar(cx, TIPO.CORRESPONDENCIA, { ...filtro, ...tamanho(f) });
        const itens = [];
        for (const c of pg.itens) itens.push(await correspondenciaLegivel(cx, tx, c, { resumida: true }));
        const porSituacao = Object.fromEntries((await tx.agregar(cx, TIPO.CORRESPONDENCIA, { onde: { competencia: f.competencia }, agruparPor: "situacao" })).map((x) => [x.grupo, x.quantidade]));
        return { dataBase: b.hoje(), filtro: f, itens, paginacao: paginacao(f, pg.total), porSituacao };
      });
    },

    detalharCorrespondencia(ctx, e) {
      const { id } = validarDetalhe(e);
      return b.consultar(ctx, async (cx, tx) => {
        const c = await tx.obter(cx, TIPO.CORRESPONDENCIA, id);
        if (!c) falhar(CODIGO.NAO_ENCONTRADO, "Correspondência não encontrada.");
        const historico = (await tx.listarHistorico(cx, { onde: { registroTipo: TIPO.CORRESPONDENCIA, registroId: id } })).map((h) => ({ evento: h.evento, em: h.em, situacao: h.depois?.situacao ?? null, justificativa: h.justificativa ?? null }));
        return { dataBase: b.hoje(), correspondencia: await correspondenciaLegivel(cx, tx, c, { resumida: false }), historico };
      });
    },

    /** Pendências agrupadas (contagem por grupo; cada fato em UM grupo) com paginação da lista. */
    consultarPendencias(ctx, e) {
      const f = validarFiltroDePendencias(e);
      return b.consultar(ctx, async (cx, tx) => {
        const { pendencias } = await analisar(cx, tx, f.competencia);
        const filtradas = pendencias.filter((x) => (!f.grupo || x.grupo === f.grupo)
          && (!f.situacao || (f.situacao === "A_RESOLVER" ? x.situacao !== SITUACAO_PENDENCIA.INFORMATIVA : x.situacao === f.situacao)));
        const atribuicoes = new Map((await tx.listar(cx, TIPO.ATRIBUICAO_PENDENCIA, { onde: { competencia: f.competencia } })).map((a) => [a.chave, a]));
        const pg = paginar(filtradas.map((x) => ({ ...pendenciaCompacta(x), atribuicao: atribuicaoLegivel(atribuicoes.get(x.chave), cx) })), f.pagina, f.tamanho);
        return {
          dataBase: b.hoje(), filtro: f, contagem: contagemDePendencias(pendencias), grupos: Object.values(GRUPO).map((g) => ({ grupo: g, nome: NOME_DO_GRUPO[g] })),
          itens: pg.itens, paginacao: pg.paginacao,
          semMotor: { CUSTOS_E_RATEIOS: "Rateios de custos ainda não existem no Financeiro v2: este grupo fica vazio até haver motor de rateio." },
        };
      });
    },

    /** Painel "Revisar": o que aconteceu, origem, impacto, motivo, documentos, opções permitidas e histórico. */
    detalharPendencia(ctx, e) {
      const f = validarDetalheDePendencia(e);
      return b.consultar(ctx, async (cx, tx) => {
        const { pendencias } = await analisar(cx, tx, f.competencia);
        const p = pendencias.find((x) => x.chave === f.chave);
        if (!p) falhar(CODIGO.NAO_ENCONTRADO, "Pendência não encontrada nesta competência (pode já ter sido resolvida).");
        const tipoDoHistorico = { PROPOSTA: TIPO.PROPOSTA, MOVIMENTACAO: TIPO.MOVIMENTACAO, OBRIGACAO: TIPO.OBRIGACAO, RECEBIVEL: TIPO.RECEBIVEL, CORRESPONDENCIA: TIPO.CORRESPONDENCIA, IMPORTACAO: TIPO.IMPORTACAO, VENDA: TIPO.VENDA, LANCAMENTO: TIPO.LANCAMENTO, DIVERGENCIA_FONTE: TIPO.DIVERGENCIA_FONTE }[p.referencia?.tipo];
        const historico = tipoDoHistorico && p.referencia.id ? (await tx.listarHistorico(cx, { onde: { registroTipo: tipoDoHistorico, registroId: p.referencia.id } })).map((h) => ({ evento: h.evento, em: h.em, justificativa: h.justificativa ?? null })) : [];
        const atrib = await tx.buscarPorChave(cx, TIPO.ATRIBUICAO_PENDENCIA, chaveDaAtribuicao(f.competencia, f.chave));
        const historicoDaAtribuicao = atrib ? (await tx.listarHistorico(cx, { onde: { registroTipo: TIPO.ATRIBUICAO_PENDENCIA, registroId: atrib.id } })).map((h) => ({
          evento: h.evento, em: h.em, por: h.usuarioId === cx.usuarioId ? "Você" : "Usuário registrado", justificativa: h.justificativa ?? null,
          responsavelAntes: h.antes?.responsavelId ?? null, responsavelDepois: h.depois?.responsavelId ?? null, situacaoDepois: h.depois?.situacao ?? null,
        })) : [];
        return {
          dataBase: b.hoje(), pendencia: { ...p, nomeDoGrupo: NOME_DO_GRUPO[p.grupo] }, historico, atribuicao: atribuicaoLegivel(atrib, cx), historicoDaAtribuicao,
          podeAtribuir: cx.permissoes.includes(ACAO.REVISAR), situacoesDaAtribuicao: Object.values(SITUACAO_ATRIBUICAO),
        };
      });
    },

    /**
     * Execução 06D — responsável por uma pendência. O responsável é um usuário com acesso ATIVO ao Financeiro v2 desta
     * unidade (nunca um nome livre nem fictício). Reatribuir exige justificativa. Tudo fica no histórico da atribuição.
     * Atribuir NÃO resolve a pendência: ela continua aberta até a causa ser tratada.
     */
    atribuirResponsavelDePendencia(ctx, e) {
      semCamposDesconhecidos(e, ["competencia", "chave", "responsavelId", "dataRevisao", "comentario", "justificativa"], "atribuicao");
      const f = validarDetalheDePendencia({ competencia: e?.competencia, chave: e?.chave });
      const responsavelId = exigirUuid(e?.responsavelId, "responsavelId").toLowerCase();
      const dataRevisao = e?.dataRevisao ? exigirData(e.dataRevisao, "dataRevisao") : null;
      const comentario = exigirTexto(e?.comentario, "comentario", { max: 500, opcional: true });
      const justificativa = exigirTexto(e?.justificativa, "justificativa", { max: 500, opcional: true });
      return b.executar(ctx, ACAO.REVISAR, async (cx, tx) => {
        const { pendencias } = await analisar(cx, tx, f.competencia);
        if (!pendencias.some((x) => x.chave === f.chave)) falhar(CODIGO.NAO_ENCONTRADO, "Pendência não encontrada nesta competência (pode já ter sido resolvida).");
        const concessao = await tx.buscarPorChave(cx, TIPO.CONCESSAO, `concessao:${responsavelId}`);
        if (!concessao || concessao.situacao !== "ATIVA") falhar(CODIGO.ENTRADA_INVALIDA, "O responsável indicado não tem acesso ativo ao Financeiro v2 desta unidade.", { campo: "responsavelId" });
        const chave = chaveDaAtribuicao(f.competencia, f.chave);
        const atual = await tx.buscarPorChave(cx, TIPO.ATRIBUICAO_PENDENCIA, chave);
        const nota = comentario ? [{ texto: comentario, por: cx.usuarioId, em: b.agora() }] : [];
        if (!atual) {
          return atribuicaoLegivel(await b.criar(tx, cx, TIPO.ATRIBUICAO_PENDENCIA, {
            competencia: f.competencia, chave: f.chave, responsavelId, situacao: SITUACAO_ATRIBUICAO.ATRIBUIDA, dataRevisao, comentarios: nota, atribuidoPor: cx.usuarioId,
            chaveIdempotencia: chave, impressao: null,
          }, justificativa ?? "Atribuição de responsável."), cx);
        }
        if (atual.responsavelId === responsavelId && !comentario && dataRevisao === atual.dataRevisao) return atribuicaoLegivel(atual, cx);
        if (atual.responsavelId !== responsavelId && !justificativa) falhar(CODIGO.ENTRADA_INVALIDA, "Reatribuir a outro responsável exige justificativa.", { campo: "justificativa" });
        return atribuicaoLegivel(await b.alterar(tx, cx, TIPO.ATRIBUICAO_PENDENCIA, atual, {
          responsavelId, dataRevisao: dataRevisao ?? atual.dataRevisao, comentarios: [...atual.comentarios, ...nota], atribuidoPor: cx.usuarioId,
          situacao: atual.responsavelId !== responsavelId ? SITUACAO_ATRIBUICAO.ATRIBUIDA : atual.situacao,
        }, EVENTO_HISTORICO.ATRIBUICAO, justificativa ?? "Atualização da atribuição."), cx);
      });
    },

    /** Situação do acompanhamento (em análise, aguardando terceiro, concluída) + comentário. Concluir exige comentário. */
    atualizarAcompanhamentoDePendencia(ctx, e) {
      semCamposDesconhecidos(e, ["competencia", "chave", "situacao", "comentario", "dataRevisao"], "acompanhamento");
      const f = validarDetalheDePendencia({ competencia: e?.competencia, chave: e?.chave });
      const situacao = exigirUmDe(e?.situacao, SITUACAO_ATRIBUICAO, "situacao");
      const comentario = exigirTexto(e?.comentario, "comentario", { max: 500, opcional: situacao !== SITUACAO_ATRIBUICAO.CONCLUIDA });
      const dataRevisao = e?.dataRevisao ? exigirData(e.dataRevisao, "dataRevisao") : null;
      return b.executar(ctx, ACAO.REVISAR, async (cx, tx) => {
        const atual = await tx.buscarPorChave(cx, TIPO.ATRIBUICAO_PENDENCIA, chaveDaAtribuicao(f.competencia, f.chave));
        if (!atual) falhar(CODIGO.NAO_ENCONTRADO, "A pendência ainda não tem responsável atribuído.");
        const nota = comentario ? [{ texto: comentario, por: cx.usuarioId, em: b.agora() }] : [];
        return atribuicaoLegivel(await b.alterar(tx, cx, TIPO.ATRIBUICAO_PENDENCIA, atual, { situacao, comentarios: [...atual.comentarios, ...nota], dataRevisao: dataRevisao ?? atual.dataRevisao }, EVENTO_HISTORICO.ATRIBUICAO, comentario ?? `Acompanhamento: ${situacao}`), cx);
      });
    },

    /** Situação REAL do fechamento da competência (somente leitura: nada é homologado por aqui). */
    consultarFechamento(ctx, e) {
      const { competencia } = validarCompetenciaDaCentral(e);
      return b.consultar(ctx, async (cx, tx) => {
        const a = await analisar(cx, tx, competencia);
        const atual = a.d.competencias.find((x) => x.competencia === competencia) ?? null;
        const historico = atual ? await tx.listarHistorico(cx, { onde: { registroTipo: TIPO.COMPETENCIA, registroId: atual.id } }) : [];
        return { dataBase: b.hoje(), ...situacaoDoFechamento({ d: a.d, competencia, hoje: b.hoje(), apuracao: a.apuracao, pendencias: a.pendencias, competenciaAtual: atual, historico }) };
      });
    },
  };

  /** Uma correspondência com os DOIS lados legíveis, critério, diferença, confiabilidade e se pode ser confirmada. */
  async function correspondenciaLegivel(cx, tx, c, { resumida }) {
    const lado = async (refs) => {
      const saida = [];
      for (const ref of refs.slice(0, resumida ? 5 : 50)) saida.push(await ladoLegivel(cx, tx, ref));
      return { itens: saida, total: refs.length, valorCentavos: somarLista(refs, (r) => r.valorCentavos) };
    };
    const abertas = [SITUACAO_CORRESPONDENCIA.CANDIDATA, SITUACAO_CORRESPONDENCIA.AGUARDANDO_DOCUMENTO];
    let concorrentes = 0;
    if (abertas.includes(c.situacao) && c.relacao && c.relacao !== "MANUAL") {
      const meus = new Set([...c.ladoA, ...c.ladoB].map((r) => `${r.tipo}:${r.id}`));
      const outras = await tx.listar(cx, TIPO.CORRESPONDENCIA, { onde: { relacao: c.relacao }, predicado: (x) => x.id !== c.id && abertas.includes(x.situacao) });
      concorrentes = outras.filter((x) => [...x.ladoA, ...x.ladoB].some((r) => meus.has(`${r.tipo}:${r.id}`))).length;
    }
    const docs = new Map();
    for (const did of c.evidenciaDocumentoIds ?? []) docs.set(did, await tx.obter(cx, TIPO.DOCUMENTO, did));
    // 08D: evidência PRÓPRIA do vínculo (enviada pela tela ou vinculada à correspondência) — distinta dos relatórios de origem.
    const doVinculo = resumida ? [] : (await tx.listar(cx, TIPO.VINCULO_DOCUMENTAL, { onde: { registroTipo: TIPO.CORRESPONDENCIA, registroId: c.id } })).map((v) => v.documentoId);
    for (const did of doVinculo) if (!docs.has(did)) docs.set(did, await tx.obter(cx, TIPO.DOCUMENTO, did));
    const fracaSemProva = c.forca === "FRACA" && !doVinculo.length;
    const podeConfirmar = abertas.includes(c.situacao) && c.diferencaCentavos === 0 && concorrentes === 0 && !fracaSemProva;
    return {
      id: c.id, relacao: c.relacao ?? "MANUAL", nome: nomeDaRelacao(c.relacao ?? "MANUAL"), situacao: c.situacao, competencia: c.competencia ?? null,
      ladoA: await lado(c.ladoA), ladoB: await lado(c.ladoB), diferencaCentavos: c.diferencaCentavos,
      criterio: c.regra ? textoDaRegra(c.regra) : "Montada por uma pessoa", confiabilidade: c.forca === "FORTE" ? "FORTE" : c.forca === "FRACA" ? "FRACA" : "MANUAL",
      confiabilidadeTexto: c.forca === "FORTE" ? "Identificador comum nos dois lados." : c.forca === "FRACA" ? "Só valor e data coincidem: é candidata, nunca prova." : "Montada por uma pessoa, com justificativa.",
      ambigua: concorrentes > 0, concorrentes, evidencias: docsDe(c.evidenciaDocumentoIds, docs), justificativa: c.justificativa ?? null, decisao: c.justificativaDecisao ?? null,
      decididaEm: c.decididoEm ?? null,
      evidenciasDoVinculo: docsDe(doVinculo, docs),
      podeConfirmar, motivoDeNaoConfirmar: podeConfirmar ? null : !abertas.includes(c.situacao) ? "Já decidida." : c.diferencaCentavos !== 0 ? "Os lados não fecham: registre a divergência com justificativa."
        : concorrentes > 0 ? "Correspondência ambígua: outras candidatas disputam os mesmos registros. Recuse a indevida antes."
          : "Só valor e data coincidem: anexe um documento que prove o vínculo (os relatórios de origem não bastam).",
      permissaoExigida: ACAO.CONCILIAR, voceTemPermissao: cx.permissoes.includes(ACAO.CONCILIAR),
    };
  }

  /** Um registro de um lado da correspondência, sem descrição bancária livre (pode conter dados pessoais). */
  async function ladoLegivel(cx, tx, ref) {
    const r = await tx.obter(cx, ref.tipo, ref.id);
    const base = { tipo: ref.tipo, id: ref.id, valorCentavos: ref.valorCentavos, encontrado: Boolean(r) };
    if (!r) return { ...base, fonte: null, data: null, natureza: "Registro não encontrado", identificador: null };
    switch (ref.tipo) {
      case TIPO.REGISTRO_FONTE: return { ...base, fonte: r.fonte, data: r.dataReferencia, natureza: ({ TRANSACAO: "Transação do processador", PEDIDO: "Pedido", LANCAMENTO_BANCARIO: "Lançamento do extrato", RECEBIMENTO: "Recebimento do processador", ENTREGA: "Entrega", TOTAL_DIA: "Total do dia" })[r.tipoRegistro] ?? "Registro importado", identificador: r.idExterno ? `${r.fonte} · ${String(r.idExterno).slice(0, 24)}` : `${r.fonte} · linha ${r.linha}`, valorDoRegistroCentavos: r.valorCentavos };
      case TIPO.MOVIMENTACAO: {
        const conta = await tx.obter(cx, TIPO.CONTA, r.contaId);
        return { ...base, fonte: r.fonte?.sistema ?? "Registro", data: r.dataEfetiva, natureza: r.sentido === "ENTRADA" ? "Entrada na conta" : "Saída da conta", identificador: `${conta?.nome ?? "Conta"} · ${r.dataEfetiva}`, valorDoRegistroCentavos: r.valorCentavos };
      }
      case TIPO.RECEBIVEL: return { ...base, fonte: r.processador ?? "Contraparte", data: r.dataPrevista ?? null, natureza: "Direito a receber", identificador: `Recebível ${r.processador ?? ""} · ${r.competencia}`.trim(), valorDoRegistroCentavos: r.valorBaseCentavos };
      case TIPO.OBRIGACAO: {
        const parte = r.contraparteId ? await tx.obter(cx, TIPO.CONTRAPARTE, r.contraparteId) : null;
        return { ...base, fonte: "Contas a pagar", data: r.vencimento, natureza: "Conta a pagar", identificador: `${parte?.nome ?? "Fornecedor"} · vence ${r.vencimento}`, valorDoRegistroCentavos: r.valorBaseCentavos };
      }
      case TIPO.VENDA: return { ...base, fonte: r.fonte?.sistema ?? "Registro", data: r.dataVenda, natureza: "Venda", identificador: `${r.fonte?.sistema ?? ""} · ${r.fonte?.idExterno ?? ""}`, valorDoRegistroCentavos: r.brutoCentavos };
      default: return { ...base, fonte: null, data: null, natureza: ref.tipo, identificador: null };
    }
  }
}

const REGRAS = Object.freeze({
  AUTORIZACAO_EM_COMUM: "Mesmo código de autorização nos dois lados", VALOR_IGUAL_E_HORARIO_ATE_10_MIN: "Mesmo valor e horário com até 10 minutos de diferença",
  TRANSACAO_EM_COMUM: "Mesma transação nos dois relatórios", SOMA_DO_DIA_IGUAL_AO_CREDITO_ATE_1_DIA: "Soma do dia igual ao crédito, com até 1 dia de diferença",
  VALOR_IGUAL_ATE_3_DIAS: "Mesmo valor, com até 3 dias de diferença", TOTAL_DO_ENTREGADOR_IGUAL_AO_DEBITO_ATE_10_DIAS: "Total do entregador igual ao débito, com até 10 dias de diferença",
  SALDO_IGUAL_A_SAIDA: "Saldo da conta a pagar igual à saída bancária, depois da emissão",
});
const textoDaRegra = (r) => REGRAS[r] ?? "Regra automática de semelhança (valor e data)";
const CANAL_TXT = Object.freeze({ BALCAO: "no Balcão", IFOOD: "no iFood", ANOTA_AI: "pelo Anota AI", NOVENTA_E_NOVE_FOOD: "pela 99Food", OUTRO: "em outro canal" });
const exato = (m) => `${Math.trunc(m / 1000000)},${String(m % 1000000).padStart(6, "0")}`;

/**
 * Efeito econômico de uma proposta, explicado ANTES da aprovação, a partir do comando que o motor aplicaria.
 * Valores sempre em campos próprios (centavos), nunca embutidos no texto.
 */
export function efeitosDaProposta(p) {
  const c = p.comando ?? {};
  switch (p.operacao) {
    case "VENDA": {
      const descontos = c.composicao?.descontos ?? [];
      return {
        registro: { texto: `Uma venda ${CANAL_TXT[c.canal] ?? "sem canal reconhecido"}, com UMA receita bruta própria.`, valorCentavos: c.brutoCentavos ?? null, data: c.dataVenda ?? null },
        dre: [{ linha: "FATURAMENTO_BRUTO_PROPRIO", valorCentavos: c.brutoCentavos ?? null, texto: "Receita bruta própria do pedido." }, ...descontos.map((x) => ({ linha: "DEDUCOES_COMERCIAIS", valorCentavos: -x.valorCentavos, texto: x.financiador === "PENDENTE" ? "Desconto com financiador não comprovado (dedução provisória)." : "Desconto comercial." }))],
        titulos: (c.pagamentos ?? []).filter((x) => x.processador).map((x) => ({ tipo: "RECEBIVEL", valorCentavos: x.valorCentavos, texto: `Direito a receber de ${x.processador === "IFOOD" ? "iFood" : x.processador === "ANOTA_AI" ? "Anota AI" : x.processador === "STONE" ? "Stone" : "processador"}.` })),
        caixa: (c.pagamentos ?? []).filter((x) => !x.processador && x.contaId).map((x) => ({ valorCentavos: x.valorCentavos, texto: "Entrada direta no caixa." })),
      };
    }
    case "VENDA_AGREGADA":
      return {
        registro: { texto: "Receita AGREGADA do dia (sem pedidos, canal ou forma de pagamento).", valorCentavos: c.receitaBrutaCentavos ?? null, data: c.data ?? null },
        dre: c.metodologia === "VALOR_LIQUIDO_COMPOSICAO_COMPROVADA"
          ? [{ linha: "FATURAMENTO_BRUTO_PROPRIO", valorCentavos: c.receitaBrutaCentavos, texto: "Receita bruta recuperada da composição comprovada (sem canal)." }, ...(c.descontosCentavos ? [{ linha: "DEDUCOES_COMERCIAIS", valorCentavos: -c.descontosCentavos, texto: "Descontos do dia a classificar." }] : [])]
          : [{ linha: null, valorCentavos: null, texto: "Metodologia não comprovada: nenhum efeito econômico." }],
        titulos: [], caixa: [],
      };
    case "PAGAMENTO_STONE":
      return {
        registro: c.vendaId ? { texto: "Pagamento pela Stone vinculado a uma venda já registrada (não cria venda nem receita).", valorCentavos: c.valorCentavos ?? null, data: c.dataPagamento ?? null } : { texto: "Nada pode ser registrado: a transação não indica uma venda.", valorCentavos: null, data: c.dataPagamento ?? null },
        dre: (c.taxas ?? []).map((t) => ({ linha: "DESPESAS_OPERACIONAIS", valorCentavos: -t.valorCentavos, texto: "Taxa informada pela Stone (despesa de recebimento).", fracao: Number.isSafeInteger(t.micros) ? { exatoReais: exato(t.micros), registradoCentavos: t.valorCentavos, arredondamento: "METADE_PARA_CIMA" } : null })),
        titulos: c.vendaId ? [{ tipo: "RECEBIVEL", valorCentavos: c.valorCentavos, texto: "Recebível da Stone pelo valor bruto, abatido pelas taxas." }] : [],
        caixa: [{ valorCentavos: null, texto: "Nenhum: o depósito só entra quando aparecer no extrato." }],
      };
    case "OBRIGACAO_ENTREGADOR":
      return {
        registro: { texto: "Uma obrigação com o entregador pelo valor devido das entregas válidas do período.", valorCentavos: c.valorOriginalCentavos ?? null, data: c.vencimento ?? null },
        dre: [{ linha: "DESPESAS_OPERACIONAIS", valorCentavos: -(c.valorOriginalCentavos ?? 0), texto: "Despesa com entregadores próprios." }],
        titulos: [{ tipo: "OBRIGACAO", valorCentavos: c.valorOriginalCentavos ?? null, texto: "Conta a pagar ao entregador." }],
        caixa: [{ valorCentavos: null, texto: "Nenhum até o pagamento ser registrado." }],
      };
    case "MOVIMENTACAO_BANCARIA":
      return {
        registro: { texto: `Uma ${c.sentido === "ENTRADA" ? "entrada" : "saída"} na conta, conforme o extrato.`, valorCentavos: c.valorCentavos ?? null, data: c.dataEfetiva ?? null },
        dre: [{ linha: null, valorCentavos: null, texto: "Nenhum: movimentação não é receita nem despesa; a classificação é posterior." }],
        titulos: [], caixa: [{ valorCentavos: c.sentido === "SAIDA" ? -c.valorCentavos : c.valorCentavos, texto: "Movimento na conta bancária." }],
      };
    default:
      return { registro: { texto: "Operação não reconhecida.", valorCentavos: null, data: null }, dre: [], titulos: [], caixa: [] };
  }
}

/** Pendência compacta da lista principal (sem dados técnicos). */
function pendenciaCompacta(p) {
  return {
    chave: p.chave, grupo: p.grupo, nomeDoGrupo: NOME_DO_GRUPO[p.grupo], codigo: p.codigo, titulo: p.titulo, valorCentavos: p.valorCentavos, situacao: p.situacao,
    responsavel: p.responsavel, motivo: p.motivo, efeitoNoFechamento: p.efeitoNoFechamento, bloqueia: p.efeitoNoFechamento === EFEITO_NO_FECHAMENTO.BLOQUEIA,
    competencia: p.competencia ?? (p.data ? competenciaDe(p.data) : null), outrosMotivos: p.outrosMotivos.length, apontadoPor: p.apontadoPor.length,
  };
}

/** Chave da atribuição: competência + chave da pendência (o mesmo fato tem um único responsável por competência). */
const chaveDaAtribuicao = (competencia, chave) => `atribuicao:${competencia}:${chave}`;
/** Atribuição para a tela, sem expor identificadores de outras pessoas além do necessário. */
function atribuicaoLegivel(a, cx) {
  if (!a) return null;
  return {
    responsavelId: a.responsavelId, responsavelEhVoce: a.responsavelId === cx.usuarioId, situacao: a.situacao, dataRevisao: a.dataRevisao ?? null,
    comentarios: (a.comentarios ?? []).map((c) => ({ texto: c.texto, em: c.em, porVoce: c.por === cx.usuarioId })), atualizadoEm: a.atualizadoEm, versao: a.versao,
  };
}
