// Fechamento de competência e consultas (composição, histórico, conservação).
import {
  ESTADO_COMPETENCIA, EVENTO_HISTORICO, NATUREZA_LANCAMENTO, NATUREZA_MOVIMENTACAO, SENTIDO, SITUACAO_LANCAMENTO,
  SITUACAO_CONCESSAO, SITUACAO_MOVIMENTACAO, SITUACAO_PAGAMENTO, SITUACAO_TITULO, SITUACAO_TRANSFERENCIA, SITUACAO_VENDA, TIPO, TIPO_VERSAO_FECHAMENTO,
} from "../dominio/catalogos.js";
import { ACAO, autorizar, exigirContexto } from "../dominio/contexto.js";
import { somarLista, subtrair } from "../dominio/dinheiro.js";
import { EFEITO_DO_ESTADO, acaoDaTransicao, avaliarTransicao, exigeConfirmacao } from "../dominio/fechamento.js";
import { exigirMetodologiaAplicavel, identificadorDa, metodologiaVigente } from "../dominio/metodologias.js";
import { impressaoDaApuracao } from "./apuracao.js";
import { compor } from "../dominio/indicadores.js";
import { saldoDe } from "../dominio/titulos.js";
import { exigirCompetencia } from "../dominio/tempo.js";
import { exigirUmDe, semCamposDesconhecidos } from "../dominio/validacao.js";
import { validarConsultaComposicao, validarConsultaHistorico, validarDocumentacaoDePendencia, validarMudancaDeEstado } from "../contratos/comandos.js";
import { CODIGO, falhar } from "../dominio/erros.js";
import { impedimentosDeHomologacao } from "../dominio/conferencias.js";
import { apurarRegistros, pendenciasDosRegistros } from "./conferencias.js";
import { avaliarPendenciasDoFechamento, efeitoNoResultado, ressalvaGuardada } from "../dominio/ressalvas.js";
import { registrosDaCompetencia } from "./cargaDaCompetencia.js";

/**
 * Retrato COMPLETO e imutável da apuração (07): indicadores com a composição inteira, DRE com a árvore e "cada R$ 100".
 * É o que a DRE, a Visão Geral e "Ver composição completa" apresentam de uma competência homologada — inclusive a posição
 * dos títulos NA DATA DA HOMOLOGAÇÃO. Pagamentos e recebimentos posteriores aparecem nas telas de tesouraria, nunca aqui.
 */
export function retratoDa(apuracao) {
  const copia = (v) => JSON.parse(JSON.stringify(v));
  return {
    completo: true, metodologia: apuracao.metodologia, indicadores: copia(apuracao.indicadores), dre: copia(apuracao.dre), cadaCem: copia(apuracao.cadaCem ?? null),
    pendencias: apuracao.pendencias.map((p) => ({ tipo: p.tipo, mensagem: p.mensagem, valorCentavos: p.valorCentavos ?? null })),
  };
}

const PASSAR_POR_COM_PENDENCIAS = "Há pendências documentadas como ressalva: passe por \"Fechamento com pendências documentadas\" antes de homologar.";

export function operacoesDeCompetencia(b, { repositorio, politica, cargaCompleta = false, conferirCarga = false }) {
  /** 08C — apuração + impedimentos da competência sobre a carga dirigida (conferida contra a completa nos testes). */
  const derivarFechamento = (competencia, escopo, agora, hoje) => (d) => {
    const ap = apurarRegistros(d, competencia, escopo, agora);
    const { pendencias } = pendenciasDosRegistros(d, competencia, { escopo, hoje, agora });
    return { apuracao: ap, impedimentos: impedimentosDeHomologacao(d, competencia, hoje, ap), pendencias };
  };
  /**
   * 08E — documentação de pendência como fica GUARDADA: o que o usuário informou + o retrato da pendência no momento
   * (origem, natureza, impacto conhecido ou indeterminado, documentos existentes e necessários). Sem chave = nota geral
   * do fechamento (compatibilidade): não documenta pendência nenhuma.
   */
  const documentacaoGuardada = (p, atuais, cx, competencia, agora) => {
    const quem = { documentadaEm: agora, documentadaPor: cx.usuarioId };
    if (!p.chave) return { ...p, geral: true, competencia, ...quem };
    const x = atuais.find((y) => y.chave === p.chave);
    if (!x) falhar(CODIGO.ENTRADA_INVALIDA, "A pendência indicada não existe nesta competência (pode já ter sido resolvida).", { campo: "pendencias.chave", chave: p.chave });
    return {
      ...p, competencia, codigo: x.codigo, titulo: x.titulo, grupo: x.grupo, origem: x.origem ?? null, natureza: x.codigo, efeitoNoFechamento: x.efeitoNoFechamento,
      efeitoNoResultado: efeitoNoResultado(x.codigo), valorCentavos: x.valorCentavos ?? null, impactoConhecido: x.valorCentavos != null,
      documentosExistentes: x.documentosExistentes ?? [], documentosNecessarios: x.documentosNecessarios ?? [], ...quem,
    };
  };
  /** Responsável de pendência: precisa ser um usuário com acesso ATIVO a esta unidade (nunca um nome livre). */
  async function exigirResponsavelValido(tx, ctx, usuarioId) {
    const c = await tx.buscarPorChave(ctx, TIPO.CONCESSAO, `concessao:${usuarioId}`);
    if (!c || c.situacao !== SITUACAO_CONCESSAO.ATIVA) falhar(CODIGO.ENTRADA_INVALIDA, "O responsável indicado não tem acesso ativo ao Financeiro v2 desta unidade.", { campo: "responsavelId" });
  }

  return {
    /**
     * Muda o estado de fechamento. A ação exigida depende da transição (fechar, homologar ou revisar).
     * Execução 06D:
     *   - repetir o MESMO estado não faz nada (sem novo histórico nem nova versão);
     *   - homologar e reabrir uma homologada exigem `confirmar: true`;
     *   - cada passagem por um estado de fechamento grava um RETRATO imutável (VERSAO_FECHAMENTO) com indicadores, DRE,
     *     impressão, metodologia versionada, pendências e verificações — a versão homologada é a referência oficial;
     *   - homologar confere a metodologia vigente, os impedimentos (sem tolerância) e o responsável (o usuário da sessão);
     *   - reabrir registra a versão homologada anterior no histórico; nada é sobrescrito.
     */
    async alterarEstadoDaCompetencia(ctxBruto, entrada) {
      const c = validarMudancaDeEstado(entrada);
      const ctx = exigirContexto(ctxBruto);
      politica.exigir(ctx);
      return repositorio.transacao(async (tx) => {
        // Trava EXCLUSIVA: espera as escritas em andamento nesta competência terminarem e barra as próximas até decidir.
        await tx.travar(ctx, `competencia:${c.competencia}`, "EXCLUSIVA");
        const atual = await b.competenciaAtual(tx, ctx, c.competencia);
        const estadoAtual = atual?.estado ?? ESTADO_COMPETENCIA.ABERTA;
        if (estadoAtual === c.novoEstado) {
          autorizar(ctx, ACAO.VER);
          return { ...(atual ?? { competencia: c.competencia, estado: estadoAtual }), repetido: true };
        }
        const documentadasAntes = atual?.pendencias ?? [];
        if (c.novoEstado === ESTADO_COMPETENCIA.FECHAMENTO_HOMOLOGADO && c.pendencias.length) {
          falhar(CODIGO.ENTRADA_INVALIDA, "Pendências se documentam ANTES de homologar (fechamento com pendências documentadas); a homologação não as reescreve.", { campo: "pendencias" });
        }
        const acaoExigida = acaoDaTransicao(estadoAtual, c.novoEstado, { ...c, pendencias: c.pendencias.length ? c.pendencias : documentadasAntes });
        autorizar(ctx, acaoExigida);
        await b.exigirConcessaoVigente(tx, ctx, acaoExigida);
        if (exigeConfirmacao(estadoAtual, c.novoEstado) && !c.confirmar) {
          falhar(CODIGO.CONFIRMACAO_EXIGIDA, "Esta mudança de estado exige confirmação explícita.", { de: estadoAtual, para: c.novoEstado });
        }
        for (const p of c.pendencias) {
          if (p.responsavelId) await exigirResponsavelValido(tx, ctx, p.responsavelId);
          for (const id of p.evidenciaDocumentoIds) await b.obterOuFalhar(tx, ctx, TIPO.DOCUMENTO, id, "Documento de evidência");
        }
        const escopo = { organizacaoId: ctx.organizacaoId, unidadeId: ctx.unidadeId };
        const d = await registrosDaCompetencia(tx, ctx, [c.competencia], { cargaCompleta, conferir: conferirCarga, derivar: derivarFechamento(c.competencia, escopo, b.agora(), b.hoje()), tela: `mudança de estado ${c.competencia}` });
        const apuracao = apurarRegistros(d, c.competencia, escopo, b.agora());
        const { pendencias: atuais } = pendenciasDosRegistros(d, c.competencia, { escopo, hoje: b.hoje(), agora: b.agora() });
        const documentadas = c.pendencias.length ? c.pendencias.map((p) => documentacaoGuardada(p, atuais, ctx, c.competencia, b.agora())) : documentadasAntes;
        let metodologiaVersao = null;
        let impedimentos = [];
        let homologacao = null;
        // Execução 06C/06D: homologar exige que NÃO haja divergência relevante sem resolução (sem política de materialidade,
        // nenhuma tolerância). Recebíveis em aberto não bloqueiam. A regra vale no núcleo, não só na tela.
        if (c.novoEstado === ESTADO_COMPETENCIA.FECHAMENTO_HOMOLOGADO) {
          metodologiaVersao = identificadorDa(exigirMetodologiaAplicavel(c.competencia, c.metodologiaVersao));
          impedimentos = impedimentosDeHomologacao(d, c.competencia, b.hoje(), apuracao);
          if (impedimentos.length) {
            falhar(CODIGO.HOMOLOGACAO_BLOQUEADA, "Há divergência relevante sem resolução comprovada: a competência não pode ser homologada.", { impedimentos: impedimentos.map((x) => x.codigo), motivos: impedimentos.map((x) => x.mensagem) });
          }
          // 08E (F-1): pendências que exigem documentação. Do PRELIMINAR só se homologa sem nada a ressalvar; ressalvas
          // passam por "com pendências documentadas" e precisam ser admissíveis (natureza + impacto, não o texto).
          const av = avaliarPendenciasDoFechamento({ pendencias: atuais, documentadas, impedimentos });
          const pode = estadoAtual === ESTADO_COMPETENCIA.FECHAMENTO_COM_PENDENCIAS ? av.comRessalvas : av.semRessalvas;
          if (!pode) {
            const motivos = [...av.motivos];
            if (estadoAtual !== ESTADO_COMPETENCIA.FECHAMENTO_COM_PENDENCIAS && av.ressalvas.length && av.comRessalvas) motivos.push(PASSAR_POR_COM_PENDENCIAS);
            falhar(CODIGO.HOMOLOGACAO_BLOQUEADA, "A competência tem pendências não tratadas: não pode ser homologada.", {
              motivos, impeditivas: av.impeditivas.map((x) => ({ chave: x.chave, codigo: x.codigo, situacao: x.situacao, motivo: x.motivo })), ressalvasPossiveis: av.ressalvas.map((x) => x.chave),
            });
          }
          homologacao = {
            comRessalvas: av.ressalvas.length > 0, ressalvas: av.ressalvas.map(ressalvaGuardada), de: estadoAtual, avaliadaEm: b.agora(),
            contagem: av.contagem, pendenciasNaoTratadas: av.impeditivas.length, resolvidas: av.resolvidas.map((x) => x.chave),
          };
        }
        // 08E: "com pendências documentadas" só quando o que resta são ressalvas admissíveis (sem contorno pelo estado).
        if (c.novoEstado === ESTADO_COMPETENCIA.FECHAMENTO_COM_PENDENCIAS) {
          const imp = impedimentosDeHomologacao(d, c.competencia, b.hoje(), apuracao);
          const av = avaliarPendenciasDoFechamento({ pendencias: atuais, documentadas, impedimentos: imp });
          if (!av.podeRegistrarComPendencias) {
            const motivos = av.motivos.length ? [...av.motivos] : ["Não há pendência documentada como ressalva admissível: se nada impede, homologue direto do preliminar."];
            falhar(CODIGO.TRANSICAO_INVALIDA, "O fechamento com pendências documentadas exige que todas as pendências restantes estejam documentadas e sejam admissíveis como ressalva.", {
              motivos, impedimentos: imp.map((x) => x.codigo), impeditivas: av.impeditivas.map((x) => ({ chave: x.chave, codigo: x.codigo, situacao: x.situacao, motivo: x.motivo })),
            });
          }
        }
        const reabertura = c.novoEstado === ESTADO_COMPETENCIA.ABERTA;
        const versoes = await tx.listar(ctx, TIPO.VERSAO_FECHAMENTO, { onde: { competencia: c.competencia } });
        const homologadaAnterior = versoes.filter((v) => v.tipo === TIPO_VERSAO_FECHAMENTO.HOMOLOGADA).sort((a, b2) => b2.numero - a.numero)[0] ?? null;
        const dados = {
          // 08E: as pendências documentadas NUNCA são apagadas pela homologação (nem pela reabertura): ficam com a competência.
          competencia: c.competencia, estado: c.novoEstado, metodologia: c.metodologia ?? atual?.metodologia ?? null, pendencias: documentadas, homologacao,
          revisoes: (atual?.revisoes ?? 0) + (reabertura ? 1 : 0), decididoPor: ctx.usuarioId, decididoEm: b.agora(),
          versaoHomologadaAnteriorId: reabertura && estadoAtual === ESTADO_COMPETENCIA.FECHAMENTO_HOMOLOGADO ? homologadaAnterior?.id ?? null : null,
        };
        const competencia = atual
          ? await b.alterar(tx, ctx, TIPO.COMPETENCIA, atual, dados, EVENTO_HISTORICO.MUDANCA_ESTADO, c.justificativa)
          : await b.criar(tx, ctx, TIPO.COMPETENCIA, dados, c.justificativa);
        const tipoVersao = { [ESTADO_COMPETENCIA.FECHAMENTO_PRELIMINAR]: TIPO_VERSAO_FECHAMENTO.PRELIMINAR, [ESTADO_COMPETENCIA.FECHAMENTO_COM_PENDENCIAS]: TIPO_VERSAO_FECHAMENTO.COM_PENDENCIAS, [ESTADO_COMPETENCIA.FECHAMENTO_HOMOLOGADO]: TIPO_VERSAO_FECHAMENTO.HOMOLOGADA }[c.novoEstado];
        let versao = null;
        if (tipoVersao) {
          // 07: o retrato reflete o estado NOVO (ex.: situação "Confirmado" na homologada). A impressão não depende do estado.
          const apuracaoDoRetrato = apurarRegistros({ ...d, competencias: [...d.competencias.filter((x) => x.competencia !== c.competencia), competencia] }, c.competencia, escopo, b.agora());
          versao = await b.criar(tx, ctx, TIPO.VERSAO_FECHAMENTO, {
            competencia: c.competencia, tipo: tipoVersao, numero: versoes.length + 1, revisao: competencia.revisoes,
            metodologia: competencia.metodologia, metodologiaVersao: metodologiaVersao ?? identificadorDa(metodologiaVigente(c.competencia)),
            impressao: impressaoDaApuracao(apuracaoDoRetrato, c.competencia), apuracao: retratoDa(apuracaoDoRetrato), pendencias: documentadas,
            verificacoes: {
              impedimentos: impedimentos.map((x) => x.codigo), pendenciasDaApuracao: apuracao.pendencias.length,
              ...(homologacao ? { comRessalvas: homologacao.comRessalvas, ressalvas: homologacao.ressalvas, contagem: homologacao.contagem, de: homologacao.de } : {}),
            },
            decididoPor: ctx.usuarioId, decididoEm: b.agora(), justificativa: c.justificativa,
            chaveIdempotencia: `versao:${c.competencia}:${versoes.length + 1}`,
          }, c.justificativa);
        }
        return { ...competencia, versao: versao ? { id: versao.id, numero: versao.numero, tipo: versao.tipo, impressao: versao.impressao, comRessalvas: homologacao?.comRessalvas ?? false } : null, repetido: false };
      }, { escopo: ctx });
    },

    /**
     * 08E — documenta UMA pendência no fechamento (preliminar ou com pendências documentadas). Documentar não resolve:
     * guarda decisão, o que falta, evidências, responsável e o retrato da pendência. Substituir a documentação de uma
     * mesma pendência fica no histórico da competência.
     */
    async documentarPendenciaDoFechamento(ctxBruto, entrada) {
      const c = validarDocumentacaoDePendencia(entrada);
      const ctx = exigirContexto(ctxBruto);
      politica.exigir(ctx);
      return repositorio.transacao(async (tx) => {
        await tx.travar(ctx, `competencia:${c.competencia}`, "EXCLUSIVA");
        autorizar(ctx, ACAO.FECHAR);
        await b.exigirConcessaoVigente(tx, ctx, ACAO.FECHAR);
        const atual = await b.competenciaAtual(tx, ctx, c.competencia);
        const estado = atual?.estado ?? ESTADO_COMPETENCIA.ABERTA;
        if (estado === ESTADO_COMPETENCIA.FECHAMENTO_HOMOLOGADO) falhar(CODIGO.COMPETENCIA_HOMOLOGADA, "Competência homologada: reabra antes de documentar pendências.");
        if (![ESTADO_COMPETENCIA.FECHAMENTO_PRELIMINAR, ESTADO_COMPETENCIA.FECHAMENTO_COM_PENDENCIAS].includes(estado)) {
          falhar(CODIGO.TRANSICAO_INVALIDA, "Documente pendências depois de iniciar o fechamento preliminar.");
        }
        if (c.pendencia.responsavelId) await exigirResponsavelValido(tx, ctx, c.pendencia.responsavelId);
        for (const id of c.pendencia.evidenciaDocumentoIds) await b.obterOuFalhar(tx, ctx, TIPO.DOCUMENTO, id, "Documento de evidência");
        const escopo = { organizacaoId: ctx.organizacaoId, unidadeId: ctx.unidadeId };
        const d = await registrosDaCompetencia(tx, ctx, [c.competencia], { cargaCompleta, conferir: conferirCarga, derivar: derivarFechamento(c.competencia, escopo, b.agora(), b.hoje()), tela: `documentar pendência ${c.competencia}` });
        const { pendencias: atuais } = pendenciasDosRegistros(d, c.competencia, { escopo, hoje: b.hoje(), agora: b.agora() });
        const doc = documentacaoGuardada(c.pendencia, atuais, ctx, c.competencia, b.agora());
        const lista = [...(atual.pendencias ?? []).filter((x) => x.chave !== doc.chave), doc];
        const competencia = await b.alterar(tx, ctx, TIPO.COMPETENCIA, atual, { pendencias: lista }, EVENTO_HISTORICO.DOCUMENTACAO_DE_PENDENCIA, c.justificativa ?? `Pendência documentada: ${doc.titulo ?? doc.chave}`);
        const impedimentos = impedimentosDeHomologacao(d, c.competencia, b.hoje(), apurarRegistros(d, c.competencia, escopo, b.agora()));
        const av = avaliarPendenciasDoFechamento({ pendencias: atuais, documentadas: lista, impedimentos });
        return {
          competencia: c.competencia, estado: competencia.estado, pendencia: doc, avaliacao: av.itens.find((x) => x.chave === doc.chave) ?? null,
          podeHomologar: estado === ESTADO_COMPETENCIA.FECHAMENTO_COM_PENDENCIAS ? av.comRessalvas : av.semRessalvas,
        };
      }, { escopo: ctx });
    },

    /**
     * PRÉVIA de uma mudança de estado: o que a tela mostra ANTES de qualquer ação (estado atual e proposto, o que será
     * bloqueado, pendências, impedimentos, permissão e justificativa exigidas). Usa as MESMAS regras do núcleo, sem gravar.
     */
    previaDaMudancaDeEstado(ctx, entrada) {
      semCamposDesconhecidos(entrada, ["competencia", "novoEstado"], "previa");
      const competencia = exigirCompetencia(entrada?.competencia);
      const novoEstado = exigirUmDe(entrada?.novoEstado, ESTADO_COMPETENCIA, "novoEstado");
      return b.consultar(ctx, async (cx, tx) => {
        const atual = await b.competenciaAtual(tx, cx, competencia);
        const estadoAtual = atual?.estado ?? ESTADO_COMPETENCIA.ABERTA;
        const { acao, motivos } = avaliarTransicao(estadoAtual, novoEstado, { pendencias: [1], metodologia: "x", justificativa: "x" });
        const d = await registrosDaCompetencia(tx, cx, [competencia], { cargaCompleta, conferir: conferirCarga, derivar: derivarFechamento(competencia, { organizacaoId: cx.organizacaoId, unidadeId: cx.unidadeId }, b.agora(), b.hoje()), tela: `prévia ${competencia}` });
        const escopoP = { organizacaoId: cx.organizacaoId, unidadeId: cx.unidadeId };
        const impedimentos = [ESTADO_COMPETENCIA.FECHAMENTO_HOMOLOGADO, ESTADO_COMPETENCIA.FECHAMENTO_COM_PENDENCIAS].includes(novoEstado) ? impedimentosDeHomologacao(d, competencia, b.hoje(), apurarRegistros(d, competencia, escopoP, b.agora())) : [];
        // 08E: a mesma avaliação de pendências da homologação.
        const av = avaliarPendenciasDoFechamento({ pendencias: pendenciasDosRegistros(d, competencia, { escopo: escopoP, hoje: b.hoje(), agora: b.agora() }).pendencias, documentadas: atual?.pendencias ?? [], impedimentos });
        const temPermissao = acao ? cx.permissoes.includes(acao) : false;
        const bloqueios = estadoAtual === novoEstado ? ["A competência já está neste estado: nada a fazer."] : [...motivos];
        if (acao && !temPermissao) bloqueios.push("Você não tem a permissão exigida para esta mudança.");
        if (impedimentos.length) bloqueios.push("Há divergência relevante sem resolução comprovada: o núcleo recusa a homologação.");
        if (novoEstado === ESTADO_COMPETENCIA.FECHAMENTO_COM_PENDENCIAS && !av.podeRegistrarComPendencias) {
          for (const m of av.motivos.filter((x) => !/impedimento/.test(x))) bloqueios.push(m);
        }
        if (novoEstado === ESTADO_COMPETENCIA.FECHAMENTO_HOMOLOGADO) {
          for (const m of av.motivos.filter((x) => !/impedimento/.test(x))) bloqueios.push(m);
          if (estadoAtual !== ESTADO_COMPETENCIA.FECHAMENTO_COM_PENDENCIAS && av.ressalvas.length) bloqueios.push(PASSAR_POR_COM_PENDENCIAS);
        }
        if (novoEstado === ESTADO_COMPETENCIA.FECHAMENTO_COM_PENDENCIAS && !(atual?.pendencias ?? []).some((x) => x.chave)) bloqueios.push("Documente ao menos uma pendência antes (no painel de cada pendência).");
        let metodologia = null;
        try { metodologia = identificadorDa(metodologiaVigente(competencia)); } catch { bloqueios.push("Não há metodologia vigente publicada para esta competência."); }
        return {
          competencia, estadoAtual, estadoProposto: novoEstado, permitida: bloqueios.length === 0, bloqueios,
          permissaoExigida: acao, voceTemPermissao: temPermissao,
          exigeJustificativa: novoEstado === ESTADO_COMPETENCIA.ABERTA, exigeConfirmacao: exigeConfirmacao(estadoAtual, novoEstado),
          exigePendencias: novoEstado === ESTADO_COMPETENCIA.FECHAMENTO_COM_PENDENCIAS, exigeMetodologia: novoEstado === ESTADO_COMPETENCIA.FECHAMENTO_HOMOLOGADO,
          metodologiaVigente: metodologia, impedimentos, efeito: EFEITO_DO_ESTADO[novoEstado], efeitoAtual: EFEITO_DO_ESTADO[estadoAtual],
          pendenciasDocumentadas: atual?.pendencias ?? [],
          avaliacaoDasPendencias: {
            contagem: av.contagem, motivos: av.motivos,
            ressalvas: av.ressalvas.map((x) => ({ chave: x.chave, titulo: x.titulo, efeitoNoResultado: x.efeitoNoResultado, valorCentavos: x.valorCentavos })),
            impeditivas: av.impeditivas.map((x) => ({ chave: x.chave, titulo: x.titulo, situacao: x.situacao, motivo: x.motivo })),
          },
          comRessalvas: novoEstado === ESTADO_COMPETENCIA.FECHAMENTO_HOMOLOGADO && av.ressalvas.length > 0,
        };
      });
    },

    /** Versões de fechamento da competência (retratos imutáveis), da mais recente para a mais antiga. */
    consultarVersoesDeFechamento(ctx, entrada) {
      semCamposDesconhecidos(entrada, ["competencia"], "versoes");
      const competencia = exigirCompetencia(entrada?.competencia);
      return b.consultar(ctx, async (cx, tx) => {
        const atual = await b.competenciaAtual(tx, cx, competencia);
        const versoes = (await tx.listar(cx, TIPO.VERSAO_FECHAMENTO, { onde: { competencia } })).sort((a, b2) => b2.numero - a.numero);
        const vigenteId = atual?.estado === ESTADO_COMPETENCIA.FECHAMENTO_HOMOLOGADO ? versoes.find((v) => v.tipo === TIPO_VERSAO_FECHAMENTO.HOMOLOGADA)?.id ?? null : null;
        return {
          competencia, estado: atual?.estado ?? ESTADO_COMPETENCIA.ABERTA, revisoes: atual?.revisoes ?? 0,
          versoes: versoes.map((v) => ({
            id: v.id, numero: v.numero, tipo: v.tipo, revisao: v.revisao, metodologia: v.metodologia, metodologiaVersao: v.metodologiaVersao, impressao: v.impressao,
            decididoEm: v.decididoEm, responsavel: v.decididoPor === cx.usuarioId ? "Você" : "Usuário registrado na decisão", justificativa: v.justificativa ?? null,
            pendencias: v.pendencias, verificacoes: v.verificacoes, vigente: v.id === vigenteId,
            resultadoGerencialCentavos: v.apuracao?.indicadores?.RESULTADO_GERENCIAL?.valorCentavos ?? null, faturamentoBrutoCentavos: v.apuracao?.indicadores?.FATURAMENTO_BRUTO_PROPRIO?.valorCentavos ?? null,
          })),
        };
      });
    },

    consultarCompetencia(ctx, entrada) {
      const competencia = exigirCompetencia(entrada?.competencia);
      return b.consultar(ctx, async (cx, tx) => {
        const c = await b.competenciaAtual(tx, cx, competencia);
        return c ?? { competencia, estado: ESTADO_COMPETENCIA.ABERTA, metodologia: null, pendencias: [], revisoes: 0 };
      });
    },

    /** Total de um indicador + TODOS os registros que o compõem (definição central em dominio/indicadores.js). */
    consultarComposicao(ctx, entrada) {
      const c = validarConsultaComposicao(entrada);
      return b.consultar(ctx, async (cx, tx) => compor(c.indicador, c.competencia, {
        lancamentos: await tx.listar(cx, TIPO.LANCAMENTO),
        movimentacoes: await tx.listar(cx, TIPO.MOVIMENTACAO),
        obrigacoes: await tx.listar(cx, TIPO.OBRIGACAO),
        recebiveis: await tx.listar(cx, TIPO.RECEBIVEL),
      }, { canal: c.canal, classificacao: c.classificacao }));
    },

    consultarHistorico(ctx, entrada) {
      const c = validarConsultaHistorico(entrada);
      return b.consultar(ctx, (cx, tx) => tx.listarHistorico(cx, { onde: { registroTipo: c.registroTipo, registroId: c.registroId } }));
    },

    consultarRegistros(ctx, entrada) {
      const tipo = exigirUmDe(entrada?.tipo, TIPO, "tipo");
      return b.consultar(ctx, (cx, tx) => tx.listar(cx, tipo));
    },

    /**
     * Auditoria das invariantes sobre os dados gravados. Lista vazia = tudo fecha.
     * As mesmas regras também são protegidas no banco (restrições e gatilhos da migração 0001).
     */
    verificarConservacao(ctx) {
      return b.consultar(ctx, async (cx, tx) => {
        const violacoes = [];
        const erro = (regra, tipo, id) => violacoes.push({ regra, registroTipo: tipo, registroId: id });
        const valido = (l) => subtrair(l.valorCentavos, l.estornadoCentavos ?? 0);
        const liquidacoes = await tx.listar(cx, TIPO.LIQUIDACAO);
        const ajustes = await tx.listar(cx, TIPO.AJUSTE);
        const movimentacoes = await tx.listar(cx, TIPO.MOVIMENTACAO);
        const lancamentos = await tx.listar(cx, TIPO.LANCAMENTO);

        for (const tipo of [TIPO.OBRIGACAO, TIPO.RECEBIVEL]) {
          for (const t of await tx.listar(cx, tipo)) {
            const liquidado = somarLista(liquidacoes.filter((l) => l.alvoTipo === tipo && l.alvoId === t.id), valido);
            const ajustado = somarLista(ajustes.filter((a) => a.alvoTipo === tipo && a.alvoId === t.id), (a) => a.valorCentavos);
            if (t.liquidadoCentavos !== liquidado) erro("LIQUIDADO_DIFERE_DAS_LIQUIDACOES", tipo, t.id);
            if (t.ajustesCentavos !== ajustado) erro("AJUSTES_DIFEREM_DOS_REGISTROS", tipo, t.id);
            if (t.saldoCentavos !== saldoDe(t) || t.saldoCentavos < 0) erro("SALDO_NAO_FECHA", tipo, t.id);
            if (t.situacao === SITUACAO_TITULO.QUITADA && t.saldoCentavos !== 0) erro("QUITADA_COM_SALDO", tipo, t.id);
          }
        }
        for (const m of movimentacoes) {
          const alocado = somarLista(liquidacoes.filter((l) => l.movimentacaoId === m.id), valido);
          if (m.situacao === SITUACAO_MOVIMENTACAO.ESTORNADA && alocado > 0) erro("MOVIMENTACAO_ESTORNADA_LIQUIDANDO", TIPO.MOVIMENTACAO, m.id);
          if (m.pagamentoId && alocado > 0) erro("PAGAMENTO_DIRETO_LIQUIDANDO_TITULO", TIPO.MOVIMENTACAO, m.id);
          if (m.alocadoCentavos !== alocado || alocado > m.valorCentavos) erro("ALOCACAO_DA_MOVIMENTACAO_NAO_FECHA", TIPO.MOVIMENTACAO, m.id);
          if (m.natureza === NATUREZA_MOVIMENTACAO.TRANSFERENCIA_INTERNA && (alocado > 0 || !m.transferenciaId)) erro("TRANSFERENCIA_LIQUIDANDO_TITULO", TIPO.MOVIMENTACAO, m.id);
        }
        for (const t of await tx.listar(cx, TIPO.TRANSFERENCIA)) {
          const s = movimentacoes.find((m) => m.id === t.saidaId);
          const e = movimentacoes.find((m) => m.id === t.entradaId);
          const estornadas = [s, e].filter((m) => m?.situacao === SITUACAO_MOVIMENTACAO.ESTORNADA).length;
          if (estornadas !== (t.situacao === SITUACAO_TRANSFERENCIA.ESTORNADA ? 2 : 0)) erro("TRANSFERENCIA_COM_PERNA_SOLTA", TIPO.TRANSFERENCIA, t.id);
          const ok = s && e && s.sentido === SENTIDO.SAIDA && e.sentido === SENTIDO.ENTRADA && s.valorCentavos === t.valorCentavos
            && e.valorCentavos === t.valorCentavos && s.contaId !== e.contaId && s.transferenciaId === t.id && e.transferenciaId === t.id;
          if (!ok) erro("TRANSFERENCIA_SEM_PAR", TIPO.TRANSFERENCIA, t.id);
        }
        const pagamentos = await tx.listar(cx, TIPO.PAGAMENTO_VENDA);
        for (const v of await tx.listar(cx, TIPO.VENDA)) {
          const receitas = lancamentos.filter((l) => l.origem?.tipo === TIPO.VENDA && l.origem.id === v.id && l.natureza === NATUREZA_LANCAMENTO.RECEITA && l.situacao === SITUACAO_LANCAMENTO.ATIVO);
          if (v.situacao === SITUACAO_VENDA.CANCELADA) {
            if (receitas.length !== 0) erro("VENDA_CANCELADA_COM_RECEITA", TIPO.VENDA, v.id);
            continue;
          }
          const daVenda = pagamentos.filter((p) => p.vendaId === v.id && p.situacao !== SITUACAO_PAGAMENTO.CANCELADO);
          const pago = somarLista(daVenda, (p) => subtrair(p.valorCentavos, p.estornadoCentavos));
          const devolucoes = lancamentos.filter((l) => l.origem?.tipo === TIPO.ESTORNO && l.origem.vendaId === v.id && l.situacao === SITUACAO_LANCAMENTO.ATIVO);
          if (pago !== v.pagoCentavos || pago + v.devolvidoCentavos > v.brutoCentavos) erro("PAGAMENTOS_NAO_FECHAM", TIPO.VENDA, v.id);
          // 07: o consumidor paga a receita MENOS os descontos (da loja, pendentes; subsídio comprovado vira pagamento do
          // terceiro). Antes da correção, toda venda com desconto aparecia como violação (falso positivo).
          const devido = subtrair(v.brutoCentavos, v.descontosCentavos ?? 0);
          if (!v.pagamentoParcial && v.devolvidoCentavos === 0 && pago !== devido && daVenda.every((p) => p.estornadoCentavos === 0)) erro("PAGAMENTOS_NAO_FECHAM", TIPO.VENDA, v.id);
          if (somarLista(devolucoes, (l) => l.valorCentavos) !== v.devolvidoCentavos) erro("DEVOLUCAO_DIFERE_DOS_LANCAMENTOS", TIPO.VENDA, v.id);
          if (receitas.length !== 1 || receitas[0].valorCentavos !== v.brutoCentavos) erro("VENDA_SEM_RECEITA_UNICA", TIPO.VENDA, v.id);
        }
        for (const p of pagamentos) {
          if (p.recebivelId && p.movimentacaoId) erro("PAGAMENTO_COM_DOIS_EFEITOS", TIPO.PAGAMENTO_VENDA, p.id);
          if (p.processador && !p.recebivelId) erro("PAGAMENTO_PROCESSADO_SEM_RECEBIVEL", TIPO.PAGAMENTO_VENDA, p.id);
          if (!p.processador && p.recebivelId) erro("PAGAMENTO_DIRETO_COM_RECEBIVEL", TIPO.PAGAMENTO_VENDA, p.id);
        }
        for (const l of lancamentos) if (!l.categoriaId || !l.classificacao) erro("LANCAMENTO_SEM_CLASSIFICACAO", TIPO.LANCAMENTO, l.id);
        const origensDeCaixa = [TIPO.MOVIMENTACAO, TIPO.LIQUIDACAO, TIPO.TRANSFERENCIA];
        for (const l of lancamentos) if (!l.origem || origensDeCaixa.includes(l.origem.tipo)) erro("LANCAMENTO_ORIGINADO_DE_CAIXA", TIPO.LANCAMENTO, l.id);
        return violacoes;
      });
    },
  };
}
