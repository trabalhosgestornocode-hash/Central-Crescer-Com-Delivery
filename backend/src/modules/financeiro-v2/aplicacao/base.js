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

export function criarBase({ repositorio, politica, relogio, gerarId, fuso, exigirConcessaoPersistida = false }) {
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

  /**
   * Execução 06D — com `exigirConcessaoPersistida`, a permissão do contexto é CONFERIDA de novo contra a concessão gravada,
   * dentro da MESMA transação da operação. Um contexto montado antes de uma revogação não opera mais: a revogação vale
   * para a próxima ação, sem esperar a sessão expirar.
   */
  async function exigirConcessaoVigente(tx, ctx, acao) {
    if (!exigirConcessaoPersistida) return;
    const c = await tx.buscarPorChave(ctx, TIPO.CONCESSAO, `concessao:${ctx.usuarioId}`);
    if (!c || c.situacao !== "ATIVA" || !c.acoes.includes(acao)) {
      falhar(CODIGO.PERMISSAO_INSUFICIENTE, "Permissão financeira revogada ou inexistente para esta operação.", { acao });
    }
  }

  /** Operação de escrita: valida contexto, escopo e permissão ANTES de abrir a transação. */
  function executar(ctxBruto, acao, fn) {
    const ctx = autorizarContexto(ctxBruto, acao);
    return repositorio.transacao(async (tx) => {
      await exigirConcessaoVigente(tx, ctx, acao);
      return fn(ctx, tx);
    }, { escopo: ctx });
  }

  /**
   * 26/11 — escrita em DOIS escopos numa única transação (operação entre empresas). Cada contexto é validado e autorizado (ação,
   * escopo da política) ANTES; cada trecho confere a concessão gravada NO SEU escopo e roda com a sessão desse escopo.
   * `fn(emEscopo)`; `emEscopo(ctx, (cx, tx) => ...)`. Repositório sem suporte ⇒ recusa (nunca grava um lado só).
   */
  function executarEntreEscopos(ctxsBrutos, acao, fn) {
    const ctxs = ctxsBrutos.map((c) => autorizarContexto(c, acao));
    if (ctxs.length < 2 || new Set(ctxs.map((c) => `${c.organizacaoId}|${c.unidadeId}`)).size !== ctxs.length) falhar(CODIGO.ENTRADA_INVALIDA, "A operação entre empresas envolve dois escopos diferentes.");
    if (typeof repositorio.transacaoEntreEscopos !== "function") falhar(CODIGO.REPOSITORIO_INVALIDO, "O repositório não oferece transação entre escopos.");
    return repositorio.transacaoEntreEscopos((emEscopo) => fn((ctx, trecho) => {
      const cx = ctxs.find((c) => c.organizacaoId === ctx.organizacaoId && c.unidadeId === ctx.unidadeId);
      if (!cx) falhar(CODIGO.ESCOPO_NAO_AUTORIZADO, "Trecho fora dos escopos autorizados.");
      return emEscopo(cx, async (tx) => { await exigirConcessaoVigente(tx, cx, acao); return trecho(cx, tx); });
    }), { escopos: ctxs });
  }

  /**
   * 06D — transação do PROVISIONAMENTO do administrador inicial. Usada SOMENTE por provisionarAdministradorInicial, depois
   * que a autoridade externa atestou o ato e o escopo foi conferido. Não aceita contexto vindo do cliente.
   */
  function provisionar(ctxAutoridade, fn, ato = null) {
    const ctx = exigirContexto(ctxAutoridade);
    politica.exigir(ctx);
    // 07B: o ato atestado segue para a persistência — no PostgreSQL vira a sessão especial de provisionamento.
    return repositorio.transacao((tx) => fn(ctx, tx), { escopo: ctx, provisionamento: ato });
  }

  function consultar(ctxBruto, fn) {
    const ctx = exigirContexto(ctxBruto);
    politica.exigir(ctx);
    autorizar(ctx, ACAO.VER);
    return repositorio.leitura(async (tx) => {
      await exigirConcessaoVigente(tx, ctx, ACAO.VER);
      return fn(ctx, tx);
    }, { escopo: ctx });
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

  /**
   * Vários registros do MESMO tipo de uma vez: cada um idêntico ao de `criar` (escopo, versão 1, autoria) e com o mesmo evento
   * de CRIAÇÃO no histórico, gravados em lote na transação corrente (tudo ou nada). Ordem de gravação = ordem da lista.
   */
  async function criarVarios(tx, ctx, tipo, lista, justificativa = null) {
    const em = agora();
    const registros = lista.map((dados) => ({
      id: dados.id ?? gerarId(), organizacaoId: ctx.organizacaoId, unidadeId: ctx.unidadeId, ...dados,
      versao: 1, criadoEm: em, criadoPor: ctx.usuarioId, atualizadoEm: em, atualizadoPor: ctx.usuarioId,
    }));
    await tx.inserirVarios(tipo, registros);
    await tx.anexarHistoricos(registros.map((registro) => ({
      id: gerarId(), organizacaoId: ctx.organizacaoId, unidadeId: ctx.unidadeId,
      registroTipo: tipo, registroId: registro.id, evento: EVENTO_HISTORICO.CRIACAO, antes: null, depois: registro, justificativa, usuarioId: ctx.usuarioId, em,
    })));
    return registros;
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

  /**
   * Execução 06D — política de atualizações que envolvem competências diferentes (ex.: venda de setembro recebida em outubro).
   *   gravadas      → competências cujos registros ESTA operação altera ou cria: precisam aceitar escrita (homologada recusa);
   *   referenciadas → competências de registros apenas CITADOS (título liquidado, lado de uma conciliação): se homologadas,
   *                   a operação segue SÓ se não muda o resultado econômico delas, e deixa a marca
   *                   ATUALIZACAO_POSTERIOR_AO_FECHAMENTO no histórico da competência (auditável; a versão homologada fica intacta).
   * Todas as travas (compartilhadas) são tomadas em ORDEM, dentro da MESMA transação da gravação: uma homologação
   * concorrente (trava exclusiva) espera esta terminar ou acontece antes e é vista aqui — nunca é contornada.
   * @returns {Promise<string[]>} competências homologadas referenciadas (atualização posterior registrada)
   */
  async function exigirCompetenciasDoVinculo(tx, ctx, { gravadas = [], referenciadas = [], motivo }) {
    const g = [...new Set(gravadas.filter(Boolean))];
    const r = [...new Set(referenciadas.filter(Boolean))].filter((x) => !g.includes(x));
    for (const comp of [...g, ...r].sort()) {
      if (g.includes(comp)) {
        await exigirCompetenciaEditavel(tx, ctx, comp);
        continue;
      }
      await tx.travar(ctx, `competencia:${comp}`, "COMPARTILHADA");
    }
    const posteriores = [];
    for (const comp of r.sort()) {
      const c = await competenciaAtual(tx, ctx, comp);
      if (c && !aceitaEscrita(c.estado)) {
        posteriores.push(comp);
        const jaMarcadas = marcadas.get(tx) ?? marcadas.set(tx, new Set()).get(tx);
        if (!jaMarcadas.has(`posterior:${comp}`)) {
          jaMarcadas.add(`posterior:${comp}`);
          await historico(tx, ctx, TIPO.COMPETENCIA, c.id, EVENTO_HISTORICO.ATUALIZACAO_POSTERIOR_AO_FECHAMENTO, null, { competencia: comp, estado: c.estado, revisoes: c.revisoes, motivo }, `Atualização posterior ao fechamento: ${motivo}`);
        }
      }
    }
    return posteriores;
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
    gerarId, agora, hoje, executar, executarEntreEscopos, consultar, provisionar, autorizarContexto, exigirConcessaoVigente, historico, criar, criarVarios, alterar, obterOuFalhar, competenciaAtual, exigirCompetenciaEditavel, exigirCompetenciasDoVinculo,
    chaveDe, jaRegistrado, exigirNaoFutura, categoriaPorCodigo, categoriaLancavel, categoriaDoSistema, lancar, cancelarLancamento, exigirDocumentos,
  };
}
