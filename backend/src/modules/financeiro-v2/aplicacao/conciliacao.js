// Conciliação: vínculo EXPLICADO entre registros que descrevem o mesmo dinheiro em fontes diferentes
// (ex.: um repasse no extrato ↔ vários recebíveis; uma venda ↔ a transação do processador).
// Nesta execução NÃO há conciliação automática: candidatas são criadas e decididas por uma pessoa responsável.
import { CODIGO, falhar } from "../dominio/erros.js";
import { EVENTO_HISTORICO, RELACAO_CORRESPONDENCIA, SITUACAO_CONCILIACAO, SITUACAO_CORRESPONDENCIA as S, SITUACAO_MOVIMENTACAO, SITUACAO_REGISTRO_FONTE, SITUACAO_TITULO, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { somar, somarLista, subtrair } from "../dominio/dinheiro.js";
import { validarCorrespondencia, validarDecisaoConciliacao } from "../contratos/comandos.js";
import { competenciaDe } from "../dominio/tempo.js";
import { baixarSaidaNaTransacao } from "./baixaPorExtrato.js";
import { exigirLista, exigirTexto, exigirUuid, semCamposDesconhecidos } from "../dominio/validacao.js";

/** Competência de um registro conciliável (movimentação pela data efetiva; os demais pela própria competência). */
export function competenciaDoRegistro(tipo, r) {
  if (tipo === TIPO.MOVIMENTACAO) return r.dataEfetiva ? competenciaDe(r.dataEfetiva) : null;
  return r.competencia ?? (r.dataReferencia ? competenciaDe(r.dataReferencia) : null);
}

/** Valor máximo que um registro pode ter conciliado. */
function valorConciliavel(tipo, r) {
  if (tipo === TIPO.MOVIMENTACAO) return r.valorCentavos;
  if (tipo === TIPO.VENDA) return r.brutoCentavos;
  if (tipo === TIPO.REGISTRO_FONTE) return Math.abs(r.valorCentavos);
  return r.valorBaseCentavos; // OBRIGACAO, RECEBIVEL
}

export function operacoesDeConciliacao(b) {
  const refs = (c) => [...c.ladoA, ...c.ladoB];

  async function carregar(tx, ctx, ref) {
    const r = await b.obterOuFalhar(tx, ctx, ref.tipo, ref.id, "Registro da correspondência");
    // "CANCELADA" vale para título e venda; movimentação anulada fica "ESTORNADA".
    if (r.situacao === SITUACAO_TITULO.CANCELADA || r.situacao === SITUACAO_MOVIMENTACAO.ESTORNADA || r.situacao === SITUACAO_REGISTRO_FONTE.SUBSTITUIDO) {
      falhar(CODIGO.CONCILIACAO_INVALIDA, "Registro cancelado ou estornado não pode ser conciliado.");
    }
    if (ref.valorCentavos > valorConciliavel(ref.tipo, r)) {
      falhar(CODIGO.CONCILIACAO_INVALIDA, "O valor informado supera o valor do registro.", { tipo: ref.tipo });
    }
    return r;
  }

  async function jaConfirmado(tx, ctx, ref, ignorarId) {
    const confirmadas = await tx.listar(ctx, TIPO.CORRESPONDENCIA, { onde: { situacao: S.CONFIRMADA }, predicado: (c) => c.id !== ignorarId });
    return somarLista(confirmadas.flatMap(refs).filter((r) => r.tipo === ref.tipo && r.id === ref.id), (r) => r.valorCentavos);
  }

  /**
   * Execução 06D — competências de uma conciliação. Cada registro tem a SUA competência (venda e despesa pela competência
   * econômica; movimentação pela data efetiva; título pela competência do fato). A conciliação "acontece" quando o fato
   * mais recente existe: a competência DA CONCILIAÇÃO é a mais recente entre os registros, e ela precisa aceitar escrita.
   * Registros de competências anteriores homologadas só são CITADOS (não mudam o resultado delas): a atualização é
   * permitida e registrada como posterior ao fechamento. Registro que a decisão ALTERA (movimentação conciliada) precisa
   * estar em competência editável.
   */
  async function competenciasDe(tx, cx, lista) {
    const saida = [];
    for (const ref of lista) {
      const r = await tx.obter(cx, ref.tipo, ref.id);
      saida.push({ tipo: ref.tipo, competencia: r ? competenciaDoRegistro(ref.tipo, r) : null });
    }
    return saida;
  }
  const maisRecente = (lista) => lista.map((x) => x.competencia).filter(Boolean).sort().at(-1) ?? null;

  async function decidir(ctx, entrada, fn, { alteraMovimentacoes = false } = {}) {
    const c = validarDecisaoConciliacao(entrada);
    return b.executar(ctx, ACAO.CONCILIAR, async (cx, tx) => {
      const corr = await b.obterOuFalhar(tx, cx, TIPO.CORRESPONDENCIA, c.correspondenciaId, "Correspondência");
      const comps = await competenciasDe(tx, cx, refs(corr));
      const competenciaDaConciliacao = maisRecente(comps);
      // Guarda ANTES de qualquer gravação e dentro desta transação (travas tomadas em ordem; homologação concorrente espera).
      const posteriores = await b.exigirCompetenciasDoVinculo(tx, cx, {
        gravadas: [competenciaDaConciliacao, ...(alteraMovimentacoes ? comps.filter((x) => x.tipo === TIPO.MOVIMENTACAO).map((x) => x.competencia) : [])],
        referenciadas: comps.map((x) => x.competencia),
        motivo: "decisão de conciliação",
      });
      // Relido DEPOIS das travas: uma decisão concorrente já confirmada aparece aqui (e a versão do registro também protege).
      const atual = await b.obterOuFalhar(tx, cx, TIPO.CORRESPONDENCIA, c.correspondenciaId, "Correspondência");
      if (atual.situacao !== S.CANDIDATA && atual.situacao !== S.AGUARDANDO_DOCUMENTO) falhar(CODIGO.CONCILIACAO_INVALIDA, "Esta correspondência já foi decidida.", { situacao: atual.situacao });
      const mudancas = await fn(cx, tx, atual, c);
      return b.alterar(tx, cx, TIPO.CORRESPONDENCIA, atual, {
        ...mudancas, responsavelId: cx.usuarioId, decididoEm: b.agora(), justificativaDecisao: c.justificativa,
        competenciaDaConciliacao, posteriorAoFechamento: posteriores,
      }, EVENTO_HISTORICO.CONCILIACAO, c.justificativa);
    });
  }

  /**
   * Candidata proposta por regra automática que disputa um registro com outra candidata em aberto DA MESMA RELAÇÃO é
   * AMBÍGUA (relações diferentes formam uma cadeia — transação → recebimento → crédito — e não competem entre si):
   * não se confirma por "escolha da máquina" — as concorrentes precisam ser rejeitadas antes, com justificativa.
   */
  async function exigirSemAmbiguidade(tx, ctx, corr) {
    if (!corr.relacao || corr.relacao === RELACAO_CORRESPONDENCIA.MANUAL) return;
    const meus = new Set(refs(corr).map((r) => `${r.tipo}:${r.id}`));
    const abertas = await tx.listar(ctx, TIPO.CORRESPONDENCIA, { onde: { relacao: corr.relacao }, predicado: (x) => x.id !== corr.id && (x.situacao === S.CANDIDATA || x.situacao === S.AGUARDANDO_DOCUMENTO) });
    const concorrentes = abertas.filter((x) => refs(x).some((r) => meus.has(`${r.tipo}:${r.id}`)));
    if (concorrentes.length) {
      falhar(CODIGO.CONCILIACAO_INVALIDA, "Correspondência ambígua: outras candidatas disputam os mesmos registros. Rejeite-as com justificativa antes de confirmar.", { concorrentes: concorrentes.length });
    }
  }

  return {
    /** Suporta 1:1, 1:N e N:M (este último exige justificativa). A diferença entre os lados fica explícita. */
    criarCorrespondenciaCandidata(ctx, entrada) {
      const c = validarCorrespondencia(entrada);
      return b.executar(ctx, ACAO.CONCILIAR, async (cx, tx) => {
        const registros = [];
        for (const ref of refs(c)) registros.push([ref.tipo, await carregar(tx, cx, ref)]);
        // 06D: criar um vínculo de conciliação é escrita na competência da conciliação (a mais recente dos registros).
        const compsDosRegistros = registros.map(([tipo, r]) => competenciaDoRegistro(tipo, r)).filter(Boolean);
        const competenciaDaConciliacao = [...compsDosRegistros].sort().at(-1) ?? null;
        const posteriorAoFechamento = await b.exigirCompetenciasDoVinculo(tx, cx, { gravadas: [competenciaDaConciliacao], referenciadas: compsDosRegistros, motivo: "candidata de conciliação" });
        for (const id of c.evidenciaDocumentoIds) await b.obterOuFalhar(tx, cx, TIPO.DOCUMENTO, id, "Documento de evidência");
        const diferencaCentavos = subtrair(somarLista(c.ladoA, (r) => r.valorCentavos), somarLista(c.ladoB, (r) => r.valorCentavos));
        // Competência da correspondência = a mais antiga dos registros (filtro da Central de Conferências no banco).
        const competencia = registros.map(([tipo, r]) => competenciaDoRegistro(tipo, r)).filter(Boolean).sort()[0] ?? null;
        return b.criar(tx, cx, TIPO.CORRESPONDENCIA, { ...c, diferencaCentavos, situacao: S.CANDIDATA, responsavelId: null, decididoEm: null, justificativaDecisao: null, relacao: RELACAO_CORRESPONDENCIA.MANUAL, regra: null, forca: null, competencia, competenciaDaConciliacao, posteriorAoFechamento });
      });
    },

    /** Só confirma quando os lados FECHAM e nenhum registro fica conciliado acima do próprio valor. */
    confirmarConciliacao(ctx, entrada) {
      let baixa = null;
      return decidir(ctx, entrada, async (cx, tx, corr, c) => {
        // doc 33: confirmar conta × saída COM baixa — exige a permissão própria da baixa e roda na MESMA transação.
        if (c.baixar) {
          if (corr.relacao !== RELACAO_CORRESPONDENCIA.OBRIGACAO_X_MOVIMENTACAO) falhar(CODIGO.OPERACAO_INVALIDA, "Só a conciliação de conta a pagar com saída bancária dá baixa na conta.", { relacao: corr.relacao ?? null });
          if (!cx.permissoes.includes(ACAO.VINCULAR_PAGAMENTO)) falhar(CODIGO.PERMISSAO_INSUFICIENTE, "Dar baixa pela conciliação exige a permissão de vincular pagamento do extrato.", { acao: ACAO.VINCULAR_PAGAMENTO });
        }
        await exigirSemAmbiguidade(tx, cx, corr);
        if (corr.diferencaCentavos !== 0) {
          falhar(CODIGO.CONCILIACAO_INVALIDA, "Os lados não fecham. Registre a divergência em vez de confirmar.", { diferencaCentavos: corr.diferencaCentavos });
        }
        // 08C/08D: candidata FRACA (só valor e data coincidem) nunca é confirmada por proximidade. Os relatórios de ORIGEM
        // (já citados na candidata) são justamente o que gerou a suspeita: não provam o vínculo. Exige evidência PRÓPRIA do
        // vínculo — informada na decisão ou vinculada à correspondência (ex.: enviada pela tela) — e justificativa.
        for (const id of c.evidenciaDocumentoIds) await b.obterOuFalhar(tx, cx, TIPO.DOCUMENTO, id, "Documento de evidência");
        const vinculadas = (await tx.listar(cx, TIPO.VINCULO_DOCUMENTAL, { onde: { registroTipo: TIPO.CORRESPONDENCIA, registroId: corr.id } })).map((v) => v.documentoId);
        const doVinculo = [...new Set([...c.evidenciaDocumentoIds, ...vinculadas])];
        const evidencias = [...new Set([...(corr.evidenciaDocumentoIds ?? []), ...doVinculo])];
        if (corr.forca === "FRACA" && (!doVinculo.length || !c.justificativa)) {
          falhar(CODIGO.CONCILIACAO_INVALIDA, "Correspondência só por valor e data: confirmar exige justificativa e um documento que prove o vínculo (os relatórios de origem não bastam).", { forca: corr.forca });
        }
        for (const ref of refs(corr)) {
          const registro = await carregar(tx, cx, ref);
          const total = somar(await jaConfirmado(tx, cx, ref, corr.id), ref.valorCentavos);
          const limite = valorConciliavel(ref.tipo, registro);
          if (total > limite) falhar(CODIGO.CONCILIACAO_INVALIDA, "Registro já conciliado: confirmar duplicaria o mesmo valor.", { tipo: ref.tipo });
          if (ref.tipo === TIPO.MOVIMENTACAO) {
            await b.alterar(tx, cx, TIPO.MOVIMENTACAO, registro, { situacaoConciliacao: total === limite ? SITUACAO_CONCILIACAO.CONCILIADA : SITUACAO_CONCILIACAO.PARCIAL }, EVENTO_HISTORICO.CONCILIACAO);
          }
        }
        if (c.baixar) {
          const todos = [...(corr.ladoA ?? []), ...(corr.ladoB ?? [])];
          const saida = todos.find((r) => r.tipo === TIPO.MOVIMENTACAO);
          const mov = await b.obterOuFalhar(tx, cx, TIPO.MOVIMENTACAO, saida.id, "Saída bancária"); // relida: a confirmação acima mudou a versão
          baixa = await baixarSaidaNaTransacao(b, tx, cx, {
            movimentacaoId: mov.id, versaoMovimentacao: mov.versao,
            alocacoes: todos.filter((r) => r.tipo === TIPO.OBRIGACAO).map((r) => ({ obrigacaoId: r.id, valorCentavos: r.valorCentavos })),
            documentoId: null, confirmar: true, pagamentoAntecipado: false,
            justificativa: c.justificativa ?? `Baixa pela conciliação confirmada (${corr.regra ?? "manual"}).`,
          }, { conciliacaoConfirmadaId: corr.id });
        }
        return { situacao: S.CONFIRMADA, ...(doVinculo.length ? { evidenciaDocumentoIds: evidencias } : {}) };
      }, { alteraMovimentacoes: true }).then((r) => (baixa ? { ...r, baixa } : r));
    },

    /** Diferença conhecida e NÃO resolvida: fica registrada como divergência, com justificativa obrigatória. */
    registrarDivergencia(ctx, entrada) {
      return decidir(ctx, entrada, async (_cx, _tx, corr, c) => {
        if (corr.diferencaCentavos === 0) falhar(CODIGO.CONCILIACAO_INVALIDA, "Não há diferença entre os lados.");
        if (!c.justificativa) falhar(CODIGO.CONCILIACAO_INVALIDA, "Divergência exige justificativa.");
        return { situacao: S.DIVERGENTE };
      });
    },

    /** Hipótese plausível, mas falta o documento que a comprove: fica parada, com justificativa, até ele chegar. */
    marcarAguardandoDocumento(ctx, entrada) {
      return decidir(ctx, entrada, async (_cx, _tx, corr, c) => {
        if (corr.situacao !== S.CANDIDATA) falhar(CODIGO.CONCILIACAO_INVALIDA, "Só uma candidata pode passar a aguardar documento.");
        if (!c.justificativa) falhar(CODIGO.CONCILIACAO_INVALIDA, "Informe qual documento falta.");
        return { situacao: S.AGUARDANDO_DOCUMENTO };
      });
    },

    /**
     * Execução 06D — RESOLUÇÃO COMPROVADA de uma divergência de conciliação: a diferença continua registrada (nada é apagado
     * nem "zerado"), mas fica explicada por documento(s) e justificativa. Só assim a divergência deixa de bloquear a
     * homologação. Documentar sem evidência NÃO resolve.
     */
    resolverDivergenciaDeConciliacao(ctx, entrada) {
      semCamposDesconhecidos(entrada, ["correspondenciaId", "justificativa", "evidenciaDocumentoIds"], "resolucao");
      const correspondenciaId = exigirUuid(entrada?.correspondenciaId, "correspondenciaId");
      const justificativa = exigirTexto(entrada?.justificativa, "justificativa", { max: 500 });
      const evidencias = [...new Set(exigirLista(entrada?.evidenciaDocumentoIds, "evidenciaDocumentoIds", { min: 1, max: 20 }).map((x, i) => exigirUuid(x, `evidenciaDocumentoIds[${i}]`)))];
      return b.executar(ctx, ACAO.CONCILIAR, async (cx, tx) => {
        const corr = await b.obterOuFalhar(tx, cx, TIPO.CORRESPONDENCIA, correspondenciaId, "Correspondência");
        const comps = await competenciasDe(tx, cx, refs(corr));
        await b.exigirCompetenciasDoVinculo(tx, cx, { gravadas: [maisRecente(comps)], referenciadas: comps.map((x) => x.competencia), motivo: "resolução de divergência de conciliação" });
        const atual = await b.obterOuFalhar(tx, cx, TIPO.CORRESPONDENCIA, correspondenciaId, "Correspondência");
        if (atual.situacao !== S.DIVERGENTE) falhar(CODIGO.CONCILIACAO_INVALIDA, "Só uma divergência registrada pode receber resolução comprovada.");
        if (atual.resolucao) falhar(CODIGO.CONCILIACAO_INVALIDA, "Esta divergência já tem resolução registrada.");
        for (const id of evidencias) await b.obterOuFalhar(tx, cx, TIPO.DOCUMENTO, id, "Documento de evidência");
        return b.alterar(tx, cx, TIPO.CORRESPONDENCIA, atual, { resolucao: { justificativa, evidenciaDocumentoIds: evidencias, por: cx.usuarioId, em: b.agora() } }, EVENTO_HISTORICO.CONCILIACAO, justificativa);
      });
    },

    rejeitarCorrespondencia(ctx, entrada) {
      return decidir(ctx, entrada, async (_cx, _tx, _corr, c) => {
        if (!c.justificativa) falhar(CODIGO.CONCILIACAO_INVALIDA, "Rejeição exige justificativa.");
        return { situacao: S.REJEITADA };
      });
    },
  };
}
