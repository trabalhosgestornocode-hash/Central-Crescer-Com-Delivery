// Infraestrutura comum das operações: contexto → escopo → permissão → transação, criação/alteração com histórico,
// guarda de competência homologada e idempotência por origem externa.
import { CODIGO, falhar } from "../dominio/erros.js";
import { ESTADO_COMPETENCIA, EVENTO_HISTORICO, TIPO } from "../dominio/catalogos.js";
import { ACAO, autorizar, exigirContexto } from "../dominio/contexto.js";
import { aceitaEscrita } from "../dominio/fechamento.js";
import { hojeEm } from "../dominio/tempo.js";

export function criarBase({ repositorio, politica, relogio, gerarId, fuso }) {
  const agora = () => relogio().toISOString();
  const hoje = () => hojeEm(relogio(), fuso);

  /** Operação de escrita: valida contexto, escopo e permissão ANTES de abrir a transação. */
  function executar(ctxBruto, acao, fn) {
    const ctx = exigirContexto(ctxBruto);
    politica.exigir(ctx);
    autorizar(ctx, acao);
    return repositorio.transacao((tx) => fn(ctx, tx));
  }

  function consultar(ctxBruto, fn) {
    const ctx = exigirContexto(ctxBruto);
    politica.exigir(ctx);
    autorizar(ctx, ACAO.VER);
    return repositorio.leitura((tx) => fn(ctx, tx));
  }

  async function historico(tx, ctx, registroTipo, registroId, evento, antes, depois, justificativa = null) {
    await tx.anexarHistorico({
      id: gerarId(), organizacaoId: ctx.organizacaoId, unidadeId: ctx.unidadeId,
      registroTipo, registroId, evento, antes, depois, justificativa, usuarioId: ctx.usuarioId, em: agora(),
    });
  }

  async function criar(tx, ctx, tipo, dados, justificativa = null) {
    const em = agora();
    const registro = {
      id: dados.id ?? gerarId(), organizacaoId: ctx.organizacaoId, unidadeId: ctx.unidadeId, ...dados,
      versao: 1, criadoEm: em, criadoPor: ctx.usuarioId, atualizadoEm: em, atualizadoPor: ctx.usuarioId,
    };
    await tx.inserir(tipo, registro);
    await historico(tx, ctx, tipo, registro.id, EVENTO_HISTORICO.CRIACAO, null, registro, justificativa);
    return registro;
  }

  /** Alteração SEMPRE versionada e com antes/depois no histórico. Nunca muda id, escopo nem autoria de criação. */
  async function alterar(tx, ctx, tipo, atual, mudancas, evento, justificativa = null) {
    const novo = { ...atual, ...mudancas, id: atual.id, organizacaoId: atual.organizacaoId, unidadeId: atual.unidadeId, criadoEm: atual.criadoEm, criadoPor: atual.criadoPor, versao: atual.versao + 1, atualizadoEm: agora(), atualizadoPor: ctx.usuarioId };
    await tx.atualizar(tipo, novo, atual.versao);
    await historico(tx, ctx, tipo, atual.id, evento, atual, novo, justificativa);
    return novo;
  }

  async function obterOuFalhar(tx, ctx, tipo, id, nome = "Registro") {
    const r = await tx.obter(ctx, tipo, id);
    if (!r) falhar(CODIGO.NAO_ENCONTRADO, `${nome} não encontrado.`, { tipo });
    return r;
  }

  async function competenciaAtual(tx, ctx, competencia) {
    const [c] = await tx.listar(ctx, TIPO.COMPETENCIA, (x) => x.competencia === competencia);
    return c ?? null;
  }

  /** Competência homologada não aceita NENHUMA escrita: é preciso revisão explícita (reabertura com justificativa). */
  async function exigirCompetenciaEditavel(tx, ctx, competencia) {
    const c = await competenciaAtual(tx, ctx, competencia);
    if (c && !aceitaEscrita(c.estado)) {
      falhar(CODIGO.COMPETENCIA_HOMOLOGADA, "A competência está homologada. Alterações exigem revisão formal com justificativa.", { competencia });
    }
    return c?.estado ?? ESTADO_COMPETENCIA.ABERTA;
  }

  const chaveDe = (fonte, prefixo = "") => (fonte?.idExterno ? `${prefixo}${fonte.sistema}:${fonte.idExterno}` : null);

  /**
   * Idempotência: a mesma origem externa com o MESMO conteúdo devolve o registro já gravado (sem efeito novo);
   * com conteúdo DIFERENTE é conflito — nunca sobrescreve em silêncio.
   */
  async function jaRegistrado(tx, ctx, tipo, chave, impressao) {
    if (!chave) return null;
    const existente = await tx.buscarPorChave(ctx, tipo, chave);
    if (existente && existente.impressao !== impressao) {
      falhar(CODIGO.CONFLITO_IDEMPOTENCIA, "Esta origem externa já foi registrada com conteúdo diferente.", { tipo });
    }
    return existente;
  }

  function exigirNaoFutura(data, campo) {
    if (data > hoje()) falhar(CODIGO.DATA_INVALIDA, `${campo} não pode estar no futuro.`, { campo });
  }

  return { gerarId, agora, hoje, executar, consultar, historico, criar, alterar, obterOuFalhar, competenciaAtual, exigirCompetenciaEditavel, chaveDe, jaRegistrado, exigirNaoFutura };
}
