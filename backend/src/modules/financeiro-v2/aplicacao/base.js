// Infraestrutura comum das operações: contexto → escopo → permissão → transação, criação/alteração com histórico,
// guarda de competência, idempotência por origem externa e classificação pelo plano de contas.
import { CODIGO, falhar } from "../dominio/erros.js";
import { ESTADO_COMPETENCIA, EVENTO_HISTORICO, SITUACAO_LANCAMENTO, SITUACAO_TITULO, TIPO } from "../dominio/catalogos.js";
import { ACAO, autorizar, exigirContexto } from "../dominio/contexto.js";
import { aceitaEscrita, exigeCorrecaoAuditada } from "../dominio/fechamento.js";
import { cadeiaDoSistema, exigirLancavel, naturezaDaCategoria } from "../dominio/planoDeContas.js";
import { hojeEm } from "../dominio/tempo.js";

export const chaveDaCategoria = (codigo) => `categoria:${codigo}`;
export const tituloNovo = (valorBaseCentavos) => ({ valorBaseCentavos, liquidadoCentavos: 0, ajustesCentavos: 0, saldoCentavos: valorBaseCentavos, situacao: SITUACAO_TITULO.ABERTA });

/**
 * Mesma base, mas cada operação roda DENTRO da transação `tx` já aberta (com as mesmas checagens de contexto, escopo e
 * permissão). Permite compor operações aprovadas (venda, pagamento, ajuste...) numa única transação atômica — usado pela
 * aplicação de propostas de formação, que precisa criar a operação e marcar a proposta como aplicada juntas.
 */
export function baseNaTransacao(b, tx, escopoDaTransacao) {
  const mesmoEscopo = (ctx) => {
    if (ctx.organizacaoId !== escopoDaTransacao.organizacaoId || ctx.unidadeId !== escopoDaTransacao.unidadeId) {
      falhar(CODIGO.ESCOPO_NAO_AUTORIZADO, "Operação composta fora do escopo da transação.");
    }
    return ctx;
  };
  return {
    ...b,
    executar: (ctxBruto, acao, fn) => fn(mesmoEscopo(b.autorizarContexto(ctxBruto, acao)), tx),
    consultar: (ctxBruto, fn) => fn(mesmoEscopo(b.autorizarContexto(ctxBruto, ACAO.VER)), tx),
  };
}

export function criarBase({ repositorio, politica, relogio, gerarId, fuso }) {
  const agora = () => relogio().toISOString();
  const hoje = () => hojeEm(relogio(), fuso);
  /** Competências em fechamento com pendências já marcadas nesta transação (uma marca por transação). */
  const marcadas = new WeakMap();

  /** Contexto validado + escopo autorizado + permissão da ação. */
  function autorizarContexto(ctxBruto, acao) {
    const ctx = exigirContexto(ctxBruto);
    politica.exigir(ctx);
    autorizar(ctx, acao);
    return ctx;
  }

  /** Operação de escrita: valida contexto, escopo e permissão ANTES de abrir a transação. */
  function executar(ctxBruto, acao, fn) {
    const ctx = autorizarContexto(ctxBruto, acao);
    return repositorio.transacao((tx) => fn(ctx, tx), { escopo: ctx });
  }

  function consultar(ctxBruto, fn) {
    const ctx = exigirContexto(ctxBruto);
    politica.exigir(ctx);
    autorizar(ctx, ACAO.VER);
    return repositorio.leitura((tx) => fn(ctx, tx), { escopo: ctx });
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
    const [c] = await tx.listar(ctx, TIPO.COMPETENCIA, { onde: { competencia } });
    return c ?? null;
  }

  /**
   * Guarda de escrita por estado de fechamento. Toma uma trava COMPARTILHADA da competência: a mudança de estado toma
   * a trava EXCLUSIVA, então uma escrita nunca "atravessa" uma homologação concorrente.
   *   homologada               → recusa (reabrir exige revisão formal);
   *   fechamento com pendências → só com permissão de corrigir, e a correção fica marcada no histórico da competência.
   */
  async function exigirCompetenciaEditavel(tx, ctx, competencia) {
    await tx.travar(ctx, `competencia:${competencia}`, "COMPARTILHADA");
    const c = await competenciaAtual(tx, ctx, competencia);
    if (c && !aceitaEscrita(c.estado)) {
      falhar(CODIGO.COMPETENCIA_HOMOLOGADA, "A competência está homologada. Alterações exigem revisão formal com justificativa.", { competencia });
    }
    if (c && exigeCorrecaoAuditada(c.estado)) {
      autorizar(ctx, ACAO.CORRIGIR);
      const jaMarcadas = marcadas.get(tx) ?? marcadas.set(tx, new Set()).get(tx);
      if (!jaMarcadas.has(competencia)) {
        jaMarcadas.add(competencia);
        await historico(tx, ctx, TIPO.COMPETENCIA, c.id, EVENTO_HISTORICO.CORRECAO_EM_FECHAMENTO, null, { competencia, estado: c.estado }, "Escrita durante fechamento com pendências documentadas.");
      }
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

  // ---------------------------------------------------------------- plano de contas

  const categoriaPorCodigo = (tx, ctx, codigo) => tx.buscarPorChave(ctx, TIPO.CATEGORIA, chaveDaCategoria(codigo));

  /** Categoria informada pelo usuário/importador: precisa EXISTIR no plano da unidade, estar ativa e aceitar lançamento. */
  async function categoriaLancavel(tx, ctx, codigo) {
    const categoria = await categoriaPorCodigo(tx, ctx, codigo);
    if (!categoria) falhar(CODIGO.CATEGORIA_INVALIDA, "Categoria inexistente no plano de contas desta unidade.", { categoria: codigo });
    return exigirLancavel(categoria);
  }

  /** Categoria usada pelo próprio núcleo (receita de venda, devolução): criada sob demanda, com suas ascendentes. */
  async function categoriaDoSistema(tx, ctx, codigo) {
    let pai = null;
    let categoria = null;
    for (const def of cadeiaDoSistema(codigo)) {
      categoria = await categoriaPorCodigo(tx, ctx, def.codigo);
      if (!categoria) {
        const classificacao = pai?.classificacao ?? def.classificacao;
        categoria = await criar(tx, ctx, TIPO.CATEGORIA, {
          codigo: def.codigo, nome: def.nome, classificacao, natureza: naturezaDaCategoria(classificacao, def.natureza), paiId: pai?.id ?? null,
          aceitaLancamento: def.aceitaLancamento, exigeDocumento: def.exigeDocumento === true, ativa: true, doSistema: true,
          chaveIdempotencia: chaveDaCategoria(def.codigo), impressao: null,
        });
      }
      pai = categoria;
    }
    return exigirLancavel(categoria);
  }

  /**
   * Cria UM lançamento econômico. Natureza e classificação vêm SEMPRE da categoria — nunca do chamador.
   * `documentado` informa se há documento junto; categorias que exigem documento (ex.: antecipação) recusam sem ele.
   */
  function lancar(tx, ctx, categoria, d, { documentado = false } = {}) {
    if (categoria.exigeDocumento && !documentado) {
      falhar(CODIGO.CATEGORIA_INVALIDA, "Esta categoria só aceita lançamento com documento que a comprove.", { categoria: categoria.codigo });
    }
    return criar(tx, ctx, TIPO.LANCAMENTO, {
      situacao: SITUACAO_LANCAMENTO.ATIVO, natureza: categoria.natureza, categoriaId: categoria.id, categoria: categoria.codigo,
      classificacao: categoria.classificacao, canal: null, retidoNoRepasse: false, fonte: null, ...d,
    });
  }

  async function cancelarLancamento(tx, ctx, id, justificativa) {
    const l = await obterOuFalhar(tx, ctx, TIPO.LANCAMENTO, id, "Lançamento");
    if (l.situacao !== SITUACAO_LANCAMENTO.ATIVO) return l;
    await exigirCompetenciaEditavel(tx, ctx, l.competencia);
    return alterar(tx, ctx, TIPO.LANCAMENTO, l, { situacao: SITUACAO_LANCAMENTO.CANCELADO }, EVENTO_HISTORICO.CANCELAMENTO, justificativa);
  }

  async function exigirDocumentos(tx, ctx, ids) {
    for (const id of ids) await obterOuFalhar(tx, ctx, TIPO.DOCUMENTO, id, "Documento");
  }

  return {
    gerarId, agora, hoje, executar, consultar, autorizarContexto, historico, criar, alterar, obterOuFalhar, competenciaAtual, exigirCompetenciaEditavel,
    chaveDe, jaRegistrado, exigirNaoFutura, categoriaPorCodigo, categoriaLancavel, categoriaDoSistema, lancar, cancelarLancamento, exigirDocumentos,
  };
}
