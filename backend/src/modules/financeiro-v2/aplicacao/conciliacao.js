// Conciliação: vínculo EXPLICADO entre registros que descrevem o mesmo dinheiro em fontes diferentes
// (ex.: um repasse no extrato ↔ vários recebíveis; uma venda ↔ a transação do processador).
// Nesta execução NÃO há conciliação automática: candidatas são criadas e decididas por uma pessoa responsável.
import { CODIGO, falhar } from "../dominio/erros.js";
import { EVENTO_HISTORICO, SITUACAO_CONCILIACAO, SITUACAO_CORRESPONDENCIA as S, SITUACAO_MOVIMENTACAO, SITUACAO_TITULO, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { somar, somarLista, subtrair } from "../dominio/dinheiro.js";
import { validarCorrespondencia, validarDecisaoConciliacao } from "../contratos/comandos.js";

/** Valor máximo que um registro pode ter conciliado. */
function valorConciliavel(tipo, r) {
  if (tipo === TIPO.MOVIMENTACAO) return r.valorCentavos;
  if (tipo === TIPO.VENDA) return r.brutoCentavos;
  return r.valorBaseCentavos; // OBRIGACAO, RECEBIVEL
}

export function operacoesDeConciliacao(b) {
  const refs = (c) => [...c.ladoA, ...c.ladoB];

  async function carregar(tx, ctx, ref) {
    const r = await b.obterOuFalhar(tx, ctx, ref.tipo, ref.id, "Registro da correspondência");
    // "CANCELADA" vale para título e venda; movimentação anulada fica "ESTORNADA".
    if (r.situacao === SITUACAO_TITULO.CANCELADA || r.situacao === SITUACAO_MOVIMENTACAO.ESTORNADA) {
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

  async function decidir(ctx, entrada, fn) {
    const c = validarDecisaoConciliacao(entrada);
    return b.executar(ctx, ACAO.CONCILIAR, async (cx, tx) => {
      const corr = await b.obterOuFalhar(tx, cx, TIPO.CORRESPONDENCIA, c.correspondenciaId, "Correspondência");
      if (corr.situacao !== S.CANDIDATA) falhar(CODIGO.CONCILIACAO_INVALIDA, "Esta correspondência já foi decidida.", { situacao: corr.situacao });
      const mudancas = await fn(cx, tx, corr, c);
      return b.alterar(tx, cx, TIPO.CORRESPONDENCIA, corr, { ...mudancas, responsavelId: cx.usuarioId, decididoEm: b.agora(), justificativaDecisao: c.justificativa }, EVENTO_HISTORICO.CONCILIACAO, c.justificativa);
    });
  }

  return {
    /** Suporta 1:1, 1:N e N:M (este último exige justificativa). A diferença entre os lados fica explícita. */
    criarCorrespondenciaCandidata(ctx, entrada) {
      const c = validarCorrespondencia(entrada);
      return b.executar(ctx, ACAO.CONCILIAR, async (cx, tx) => {
        for (const ref of refs(c)) await carregar(tx, cx, ref);
        for (const id of c.evidenciaDocumentoIds) await b.obterOuFalhar(tx, cx, TIPO.DOCUMENTO, id, "Documento de evidência");
        const diferencaCentavos = subtrair(somarLista(c.ladoA, (r) => r.valorCentavos), somarLista(c.ladoB, (r) => r.valorCentavos));
        return b.criar(tx, cx, TIPO.CORRESPONDENCIA, { ...c, diferencaCentavos, situacao: S.CANDIDATA, responsavelId: null, decididoEm: null, justificativaDecisao: null });
      });
    },

    /** Só confirma quando os lados FECHAM e nenhum registro fica conciliado acima do próprio valor. */
    confirmarConciliacao(ctx, entrada) {
      return decidir(ctx, entrada, async (cx, tx, corr) => {
        if (corr.diferencaCentavos !== 0) {
          falhar(CODIGO.CONCILIACAO_INVALIDA, "Os lados não fecham. Registre a divergência em vez de confirmar.", { diferencaCentavos: corr.diferencaCentavos });
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
        return { situacao: S.CONFIRMADA };
      });
    },

    /** Diferença conhecida e NÃO resolvida: fica registrada como divergência, com justificativa obrigatória. */
    registrarDivergencia(ctx, entrada) {
      return decidir(ctx, entrada, async (_cx, _tx, corr, c) => {
        if (corr.diferencaCentavos === 0) falhar(CODIGO.CONCILIACAO_INVALIDA, "Não há diferença entre os lados.");
        if (!c.justificativa) falhar(CODIGO.CONCILIACAO_INVALIDA, "Divergência exige justificativa.");
        return { situacao: S.DIVERGENTE };
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
