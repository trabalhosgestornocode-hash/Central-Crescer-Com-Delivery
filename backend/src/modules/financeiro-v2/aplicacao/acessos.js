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
// (06D) consultarPermissoes e provisionarAdministradorInicial no fim do arquivo de operações.

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

/**
 * @param {object} b base
 * @param {object} deps
 * @param {{exigir:Function}} deps.politica escopos autorizados do núcleo
 * @param {{verificar:(ato:object)=>Promise<{ok:boolean, autoridadeId?:string, motivo?:string}>}|null} deps.autoridade
 *        AUTORIDADE externa, previamente autenticada, que atesta o administrador inicial de uma unidade. Sem ela, nenhum
 *        provisionamento acontece (falha fechada): não há administrador universal, credencial padrão nem conta oculta.
 */
export function operacoesDeAcesso(b, { politica = null, autoridade = null, acessosNegados = null } = {}) {
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

    /**
     * Execução 06D — concessões da unidade com o HISTÓRICO de cada uma (quem concedeu, quando, por quê, antes/depois).
     * Só quem pode conceder na unidade vê a lista completa; os demais veem apenas as próprias permissões.
     */
    consultarPermissoes(ctx) {
      return b.consultar(ctx, async (cx, tx) => {
        const podeConceder = cx.permissoes.includes(ACAO.CONCEDER);
        const todas = await tx.listar(cx, TIPO.CONCESSAO);
        const visiveis = podeConceder ? todas : todas.filter((c) => c.usuarioId === cx.usuarioId);
        const itens = [];
        for (const c of visiveis) {
          const historico = await tx.listarHistorico(cx, { onde: { registroTipo: TIPO.CONCESSAO, registroId: c.id } });
          itens.push({
            usuarioId: c.usuarioId, voce: c.usuarioId === cx.usuarioId, acoes: c.acoes, situacao: c.situacao, concedidoPor: c.concedidoPor, justificativa: c.justificativa ?? null,
            desde: c.criadoEm, atualizadoEm: c.atualizadoEm,
            historico: historico.map((h) => ({ evento: h.evento, em: h.em, por: h.usuarioId, justificativa: h.justificativa ?? null, acoesAntes: h.antes?.acoes ?? [], acoesDepois: h.depois?.acoes ?? [], situacaoDepois: h.depois?.situacao ?? null })),
          });
        }
        return {
          acoesExistentes: ACOES, suasPermissoes: cx.permissoes, podeConceder, itens,
          regras: [
            "Ninguém concede nem revoga o próprio acesso.",
            "Ninguém concede uma ação que não possui.",
            "Papel, superadministrador ou permissão do sistema antigo não concedem nada.",
            "A revogação vale para a próxima ação: a permissão é conferida de novo em cada operação.",
            "Toda mudança exige justificativa e fica no histórico.",
          ],
        };
      });
    },

    /**
     * Execução 06D — PROVISIONAMENTO do PRIMEIRO administrador financeiro de uma unidade.
     * Exige uma AUTORIDADE externa, já autenticada e comprovadamente autorizada, que ATESTE o ato (o núcleo não aceita um
     * identificador só porque o cliente o enviou). Regras:
     *   - só quando a unidade ainda NÃO tem ninguém que possa conceder (depois disso, vale o fluxo normal de concessão);
     *   - a autoridade não provisiona a si mesma; o escopo precisa estar entre os autorizados do núcleo;
     *   - as ações são explícitas (lista fechada financeiro_v2.*), com justificativa e evidência; tudo vai para o histórico.
     * @param {{organizacaoId:string, unidadeId:string, usuarioId:string, acoes:string[], justificativa:string, evidencia:string, atestado:unknown}} ato
     */
    async provisionarAdministradorInicial(ato) {
      if (!autoridade || typeof autoridade.verificar !== "function") {
        falhar(CODIGO.PROVISIONAMENTO_RECUSADO, "Não há autoridade de provisionamento confiável configurada neste ambiente: nenhum acesso é concedido.");
      }
      semCamposDesconhecidos(ato, ["organizacaoId", "unidadeId", "usuarioId", "acoes", "justificativa", "evidencia", "atestado"], "provisionamento");
      const organizacaoId = exigirUuid(ato.organizacaoId, "organizacaoId").toLowerCase();
      const unidadeId = exigirUuid(ato.unidadeId, "unidadeId").toLowerCase();
      const c = validar({ usuarioId: ato.usuarioId, acoes: ato.acoes, justificativa: ato.justificativa }, { acoesObrigatorias: true });
      const evidencia = exigirTexto(ato.evidencia, "evidencia", { max: 300 });
      // Escopo conferido ANTES de consultar a autoridade (falha fechada para unidade fora do núcleo).
      politica?.exigir({ organizacaoId, unidadeId });
      const verificado = await autoridade.verificar({ organizacaoId, unidadeId, usuarioId: c.usuarioId, acoes: c.acoes, justificativa: c.justificativa, evidencia, atestado: ato.atestado });
      if (!verificado?.ok || !verificado.autoridadeId) {
        await acessosNegados?.registrar?.({ evento: "PROVISIONAMENTO", codigo: "PROVISIONAMENTO_NAO_ATESTADO", usuarioId: c.usuarioId, organizacaoId, unidadeId, em: b.agora() });
        falhar(CODIGO.PROVISIONAMENTO_RECUSADO, "O ato de provisionamento não foi atestado pela autoridade.");
      }
      const autoridadeId = exigirUuid(verificado.autoridadeId, "autoridadeId").toLowerCase();
      if (autoridadeId === c.usuarioId) falhar(CODIGO.PROVISIONAMENTO_RECUSADO, "A autoridade não provisiona o próprio acesso.");
      // Contexto da AUTORIDADE (autoria do registro). Não carrega permissões financeiras: a operação é exclusiva desta função.
      const ctxAutoridade = { organizacaoId, unidadeId, usuarioId: autoridadeId, permissoes: [] };
      politica?.exigir(ctxAutoridade);
      return b.provisionar(ctxAutoridade, async (cx, tx) => {
        const todas = await tx.listar(cx, TIPO.CONCESSAO);
        if (todas.some((x) => x.situacao === SITUACAO_CONCESSAO.ATIVA && x.acoes.includes(ACAO.CONCEDER))) {
          falhar(CODIGO.PROVISIONAMENTO_RECUSADO, "A unidade já tem administrador: use a concessão normal, feita por quem já pode conceder.");
        }
        const atual = await tx.buscarPorChave(cx, TIPO.CONCESSAO, chave(c.usuarioId));
        const texto = `${c.justificativa} — evidência: ${evidencia}`;
        if (atual) return b.alterar(tx, cx, TIPO.CONCESSAO, atual, { acoes: c.acoes, situacao: SITUACAO_CONCESSAO.ATIVA, concedidoPor: autoridadeId, justificativa: texto }, EVENTO_HISTORICO.PROVISIONAMENTO, texto);
        return b.criar(tx, cx, TIPO.CONCESSAO, { usuarioId: c.usuarioId, acoes: c.acoes, situacao: SITUACAO_CONCESSAO.ATIVA, concedidoPor: autoridadeId, justificativa: texto, chaveIdempotencia: chave(c.usuarioId), impressao: null }, texto);
      });
    },
  };
}
