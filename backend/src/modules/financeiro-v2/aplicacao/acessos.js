// Concessão e revogação de acesso ao Financeiro v2 (ações financeiro_v2.*), por organização + unidade.
//
// Regras contra escalada de privilégio:
//   - só quem tem financeiro_v2.conceder NA UNIDADE concede ou revoga ali (o escopo é o do contexto, nunca do comando);
//   - ninguém concede nem revoga a si mesmo;
//   - ninguém concede ação que não tem (inclusive a própria permissão de conceder);
//   - toda mudança exige justificativa e fica no histórico (antes/depois, quem, quando, por quê);
//   - nada é concedido por papel, superadmin ou permissão do sistema antigo — só por esta operação.
// O administrador INICIAL de cada unidade é provisionado fora da aplicação (como o cadastro de escopos).
import { CODIGO, falhar } from "../dominio/erros.js";
import { EVENTO_HISTORICO, SITUACAO_CONCESSAO, TIPO } from "../dominio/catalogos.js";
import { ACAO } from "../dominio/contexto.js";
import { exigirLista, exigirTexto, exigirUuid, semCamposDesconhecidos } from "../dominio/validacao.js";

const ACOES = Object.freeze(Object.values(ACAO));

function validar(e, { acoesObrigatorias }) {
  semCamposDesconhecidos(e, ["usuarioId", "acoes", "justificativa"], "concessao");
  const acoes = e.acoes === undefined && !acoesObrigatorias ? null
    : [...new Set(exigirLista(e.acoes, "acoes", { min: 1, max: ACOES.length }).map((a) => {
      if (!ACOES.includes(a)) falhar(CODIGO.ENTRADA_INVALIDA, "Ação desconhecida: só existem ações financeiro_v2.*.", { acao: typeof a === "string" ? a.slice(0, 60) : null });
      return a;
    }))].sort();
  return { usuarioId: exigirUuid(e.usuarioId, "usuarioId"), acoes, justificativa: exigirTexto(e.justificativa, "justificativa", { max: 500 }) };
}

export function operacoesDeAcesso(b) {
  const chave = (usuarioId) => `concessao:${usuarioId}`;
  const exigirNaoProprio = (cx, usuarioId) => {
    if (usuarioId === cx.usuarioId) falhar(CODIGO.PERMISSAO_INSUFICIENTE, "Ninguém concede nem revoga o próprio acesso.");
  };

  return {
    concederAcesso(ctx, entrada) {
      const c = validar(entrada, { acoesObrigatorias: true });
      return b.executar(ctx, ACAO.CONCEDER, async (cx, tx) => {
        exigirNaoProprio(cx, c.usuarioId);
        const alheias = c.acoes.filter((a) => !cx.permissoes.includes(a));
        if (alheias.length) falhar(CODIGO.PERMISSAO_INSUFICIENTE, "Não é possível conceder uma ação que você não possui.", { acoes: alheias });
        const atual = await tx.buscarPorChave(cx, TIPO.CONCESSAO, chave(c.usuarioId));
        if (!atual) {
          return b.criar(tx, cx, TIPO.CONCESSAO, {
            usuarioId: c.usuarioId, acoes: c.acoes, situacao: SITUACAO_CONCESSAO.ATIVA, concedidoPor: cx.usuarioId, justificativa: c.justificativa,
            chaveIdempotencia: chave(c.usuarioId), impressao: null,
          }, c.justificativa);
        }
        const acoes = [...new Set([...atual.acoes, ...c.acoes])].sort();
        if (atual.situacao === SITUACAO_CONCESSAO.ATIVA && acoes.length === atual.acoes.length) return atual;
        return b.alterar(tx, cx, TIPO.CONCESSAO, atual, { acoes, situacao: SITUACAO_CONCESSAO.ATIVA, concedidoPor: cx.usuarioId, justificativa: c.justificativa }, EVENTO_HISTORICO.CORRECAO, c.justificativa);
      });
    },

    /** Sem `acoes`, revoga tudo. Revogar não exige possuir a ação (retirar acesso nunca é escalada). */
    revogarAcesso(ctx, entrada) {
      const c = validar(entrada, { acoesObrigatorias: false });
      return b.executar(ctx, ACAO.CONCEDER, async (cx, tx) => {
        exigirNaoProprio(cx, c.usuarioId);
        const atual = await tx.buscarPorChave(cx, TIPO.CONCESSAO, chave(c.usuarioId));
        if (!atual || atual.situacao === SITUACAO_CONCESSAO.REVOGADA) return atual;
        const acoes = c.acoes ? atual.acoes.filter((a) => !c.acoes.includes(a)) : [];
        if (acoes.length === atual.acoes.length) return atual;
        return b.alterar(tx, cx, TIPO.CONCESSAO, atual, {
          acoes, situacao: acoes.length ? SITUACAO_CONCESSAO.ATIVA : SITUACAO_CONCESSAO.REVOGADA, concedidoPor: cx.usuarioId, justificativa: c.justificativa,
        }, EVENTO_HISTORICO.CANCELAMENTO, c.justificativa);
      });
    },

    listarConcessoes(ctx) {
      return b.executar(ctx, ACAO.CONCEDER, async (cx, tx) => tx.listar(cx, TIPO.CONCESSAO));
    },
  };
}
