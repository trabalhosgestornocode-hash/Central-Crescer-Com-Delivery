// NÍVEL 2 — APROVAÇÃO E APLICAÇÃO das propostas do MOVA, por um ADMINISTRADOR FINANCEIRO no Centro Financeiro autenticado.
//
// O contexto (`ctx`) é o contexto VERIFICADO do Financeiro v2 montado pela sessão da plataforma (organização, unidade, usuário,
// permissões da concessão gravada) — nunca algo vindo do WhatsApp. Participar do grupo não dá nenhum poder aqui.
//
// Regras (todas testadas):
//   1. exige financeiro_v2.aprovar + financeiro_v2.aplicar + financeiro_v2.registrar no contexto (e o núcleo confere de novo);
//   2. a proposta precisa ser da MESMA unidade do contexto (outra unidade = não encontrada);
//   3. só AGUARDANDO_REVISAO; a passagem para APLICANDO é CONDICIONAL (duas aprovações simultâneas: só uma aplica);
//   4. unidade com requisitos financeiros incompletos (fontes a confirmar): aplicação bloqueada;
//   5. REVALIDA no momento da aplicação: competência aberta, saldo da obrigação, duplicidade de conta a pagar;
//   6. aplica SÓ pelos serviços reais (`registrarObrigacao`, `pagarContaAPagar`), com a fonte `MANUAL/MOVA:<proposta>` —
//      reaplicar devolve o mesmo registro no Financeiro (idempotência de segunda camada);
//   7. comprovante NÃO concilia extrato. Execução 17: proposta COM comprovante é aplicada como PAGAMENTO POR COMPROVANTE
//      (registrarPagamentoPorComprovante: nenhuma saída bancária criada, conciliação pendente; o extrato concilia depois a
//      MESMA baixa). Só o relato por texto, sem arquivo, cria a saída na conta escolhida pelo administrador;
//   8. nunca executa pagamento bancário; falha devolve a proposta para revisão e fica registrada (aprovacao FALHOU + auditoria).
import { requisitosCompletos, unidadePorId } from "../dominio/configuracao.js";
import { exigirContratoFinanceiro } from "./portaFinanceira.js";
import { executorDaPessoa } from "./portaOperacional.js";
import { NIVEL, validarPolitica } from "../dominio/autonomia.js";

export class ErroDeAprovacao extends Error {
  constructor(codigo, detalhes = {}) { super(codigo); this.name = "ErroDeAprovacao"; this.codigo = codigo; this.detalhes = detalhes; }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mes = (d) => d.slice(0, 7);

/**
 * @param {{cfg:object, armazenamento:object, nucleo:object, financeiro:object}} deps  `nucleo` = núcleo do Financeiro v2 (injetado)
 */
export function criarAprovador({ cfg, armazenamento: a, nucleo: nucleoPadrao, financeiro, fila = null, execucao = null }) {
  const { ACAO, ErroFinanceiro } = exigirContratoFinanceiro(financeiro);
  const escopo = (ctx) => ({ organizacaoId: String(ctx?.organizacaoId ?? "").toLowerCase(), unidadeId: String(ctx?.unidadeId ?? "").toLowerCase() });

  async function exigir(ctx, acoes) {
    const ok = ctx && UUID.test(ctx.usuarioId ?? "") && UUID.test(ctx.organizacaoId ?? "") && UUID.test(ctx.unidadeId ?? "") && Array.isArray(ctx.permissoes) && acoes.every((x) => ctx.permissoes.includes(x));
    if (!ok) {
      await a.auditoria.registrar({ acao: "APROVACAO_RECUSADA", atorTipo: "USUARIO", atorRef: UUID.test(ctx?.usuarioId ?? "") ? ctx.usuarioId : null, dados: { motivo: "PERMISSAO_INSUFICIENTE" } });
      throw new ErroDeAprovacao("PERMISSAO_INSUFICIENTE");
    }
  }

  async function competenciaAberta(nucleo, ctx, competencia) {
    const c = await nucleo.consultarCompetencia(ctx, { competencia });
    if (c.estado !== "ABERTA") throw new ErroDeAprovacao("COMPETENCIA_FECHADA", { competencia, estado: c.estado });
  }

  async function semDuplicata(nucleo, ctx, p, e = p.comando.entrada) {
    for (let pagina = 1; pagina <= 20; pagina++) {
      const r = await nucleo.consultarContasAPagar(ctx, { competencia: e.competencia, pagina, tamanho: 100 });
      const igual = (r.itens ?? []).find((t) => t.situacao !== "CANCELADO" && t.valorOriginalCentavos === e.valorOriginalCentavos && t.vencimento === e.vencimento && t.descricao !== undefined
        && (t.fornecedor?.nome ?? "").toLowerCase() === (e.contraparteNova?.nome ?? "").toLowerCase());
      if (igual) throw new ErroDeAprovacao("OBRIGACAO_JA_EXISTE", { obrigacaoId: igual.id });
      if (!r.itens || r.itens.length < 100) break;
    }
  }

  async function executar(nucleo, ctx, p, { contaId, categoria, porComprovante = false }) {
    const fonte = { sistema: "MANUAL", idExterno: `MOVA:${p.id}` };
    if (p.tipo === "BAIXA_DE_OBRIGACAO") {
      const e = p.comando.entrada;
      await competenciaAberta(nucleo, ctx, mes(e.dataEfetiva));
      const { titulo } = await nucleo.detalharContaAPagar(ctx, { id: e.obrigacaoId });
      if (titulo.situacao === "CANCELADO") throw new ErroDeAprovacao("OBRIGACAO_CANCELADA");
      if (e.valorCentavos > titulo.saldoCentavos) throw new ErroDeAprovacao("VALOR_MAIOR_QUE_SALDO", { saldoCentavos: titulo.saldoCentavos });
      const r = await nucleo.pagarContaAPagar(ctx, { obrigacaoId: e.obrigacaoId, contaId, dataEfetiva: e.dataEfetiva, valorCentavos: e.valorCentavos });
      return { obrigacaoId: e.obrigacaoId, movimentacaoId: r.movimentacao?.id ?? null };
    }
    // 15A: competência confirmada na revisão prevalece (e é obrigatória quando a proposta nasceu sem ela).
    const entrada = { ...p.comando.entrada, ...(p.competenciaRevisada ? { competencia: p.competenciaRevisada } : {}), ...(categoria ? { categoria } : {}), fonte };
    await competenciaAberta(nucleo, ctx, entrada.competencia);
    await semDuplicata(nucleo, ctx, p, entrada);
    const ob = await nucleo.registrarObrigacao(ctx, entrada);
    const obrigacaoId = ob.obrigacoes[0].id;
    if (p.tipo === "NOVA_OBRIGACAO") return { obrigacaoId, movimentacaoId: null };
    // DESPESA_PAGA: a mesma proposta registra a obrigação e a baixa (o mês do caixa também precisa estar aberto).
    await competenciaAberta(nucleo, ctx, mes(p.comando.pagamento.dataEfetiva));
    if (porComprovante) {
      // Execução 17: pago POR COMPROVANTE (sem saída bancária); o extrato concilia depois a mesma baixa.
      return execucao.anexarEPagar({ proposta: p, escopo: escopo(ctx), obrigacaoId, dataPagamento: p.comando.pagamento.dataEfetiva, nivel: NIVEL.APLICAR_COM_CONFIRMACAO, executor: executorDaPessoa({ nucleo, ctx }) });
    }
    const pg = await nucleo.pagarContaAPagar(ctx, { obrigacaoId, contaId, dataEfetiva: p.comando.pagamento.dataEfetiva, valorCentavos: p.comando.pagamento.valorCentavos });
    return { obrigacaoId, movimentacaoId: pg.movimentacao?.id ?? null };
  }

  return Object.freeze({
    /**
     * @param {object} ctx contexto VERIFICADO do Financeiro v2 (sessão da plataforma)
     * @param {{propostaId:string, contaId?:string, categoria?:string}} e  contaId obrigatório para baixa/despesa paga
     */
    async aplicar(ctx, { propostaId, contaId = null, categoria = null } = {}, { nucleo = nucleoPadrao } = {}) {
      await exigir(ctx, [ACAO.APROVAR, ACAO.APLICAR, ACAO.REGISTRAR]);
      const esc = escopo(ctx);
      const p = UUID.test(propostaId ?? "") ? await a.propostas.obter(esc, propostaId) : null;
      if (!p) throw new ErroDeAprovacao("PROPOSTA_NAO_ENCONTRADA");
      if (p.estado !== "AGUARDANDO_REVISAO") throw new ErroDeAprovacao("PROPOSTA_JA_DECIDIDA", { estado: p.estado });
      if (p.tipo === "SOLICITACAO_DE_REVISAO" || !p.comando) throw new ErroDeAprovacao("PROPOSTA_SEM_COMANDO");
      if (p.competenciaPendente && !p.competenciaRevisada) throw new ErroDeAprovacao("COMPETENCIA_PENDENTE");
      // Agente 2 — Frente C: baixa JÁ conferida com uma saída do extrato só por confirmarBaixaPorExtrato (vincula a saída que
      // existe). Aplicar pelo caminho antigo criaria uma SEGUNDA saída (pagarContaAPagar) para o mesmo pagamento.
      if (p.tipo === "BAIXA_DE_OBRIGACAO" && p.conciliacao?.situacao === "CONFERIDA") throw new ErroDeAprovacao("BAIXA_CONFERIDA_COM_EXTRATO");
      if (!requisitosCompletos(unidadePorId(cfg, p.unidadeId))) {
        await a.aprovacoes.registrar({ propostaId: p.id, acao: "RECUSADA", usuarioId: ctx.usuarioId, motivo: "REQUISITOS_FINANCEIROS_INCOMPLETOS" });
        throw new ErroDeAprovacao("REQUISITOS_FINANCEIROS_INCOMPLETOS");
      }
      // Execução 17: com comprovante (arquivo da proposta), pagamento POR COMPROVANTE — nenhuma saída bancária nova.
      const porComprovante = ["BAIXA_DE_OBRIGACAO", "DESPESA_PAGA"].includes(p.tipo) && Boolean(p.evidencia?.referencia) && execucao?.pagamentoPorComprovante === true;
      if (porComprovante) await exigir(ctx, [ACAO.BAIXAR_POR_COMPROVANTE, ACAO.ENVIAR_DOCUMENTO]);
      if (porComprovante && p.tipo === "BAIXA_DE_OBRIGACAO") {
        const r = await execucao.pagarPorComprovante({ proposta: p, escopo: esc, nivel: NIVEL.APLICAR_COM_CONFIRMACAO, politicaId: p.autonomiaDocumental?.politicaId ?? null, executor: executorDaPessoa({ nucleo, ctx }) });
        await a.aprovacoes.registrar({ propostaId: p.id, acao: r.ok ? "APLICADA" : "FALHOU", usuarioId: ctx.usuarioId, motivo: r.ok ? null : r.motivo, resultado: r.resultado ?? null });
        if (!r.ok) throw new ErroDeAprovacao(r.motivo ?? "FALHA_NA_EXECUCAO", r.detalhes ?? {});
        await a.auditoria.registrar({ acao: "PROPOSTA_APLICADA", atorTipo: "USUARIO", atorRef: ctx.usuarioId, alvo: p.id, dados: { tipo: p.tipo, ...r.resultado } });
        return a.propostas.obter(esc, p.id);
      }
      if (p.tipo !== "NOVA_OBRIGACAO" && !porComprovante && !UUID.test(contaId ?? "")) throw new ErroDeAprovacao("CONTA_OBRIGATORIA");
      const tomada = await a.propostas.transicionar(esc, p.id, "AGUARDANDO_REVISAO", "APLICANDO");
      if (!tomada) throw new ErroDeAprovacao("PROPOSTA_JA_DECIDIDA");
      try {
        const resultado = await executar(nucleo, ctx, p, { contaId, categoria: categoria ?? p.categoriaRevisada ?? null, porComprovante });
        const aplicada = await a.propostas.transicionar(esc, p.id, "APLICANDO", "APLICADA", resultado);
        await a.aprovacoes.registrar({ propostaId: p.id, acao: "APLICADA", usuarioId: ctx.usuarioId, resultado });
        await a.auditoria.registrar({ acao: "PROPOSTA_APLICADA", atorTipo: "USUARIO", atorRef: ctx.usuarioId, alvo: p.id, dados: { tipo: p.tipo, ...resultado } });
        return aplicada;
      } catch (e) {
        const codigo = e instanceof ErroDeAprovacao ? e.codigo : e instanceof ErroFinanceiro ? e.codigo : "FALHA_NA_APLICACAO";
        await a.propostas.transicionar(esc, p.id, "APLICANDO", "AGUARDANDO_REVISAO");
        await a.aprovacoes.registrar({ propostaId: p.id, acao: "FALHOU", usuarioId: ctx.usuarioId, motivo: codigo });
        throw e instanceof ErroDeAprovacao ? e : new ErroDeAprovacao(codigo);
      }
    },
    /** 15A: revisão da COMPETÊNCIA (Nível 2) — informada por quem revisa; nunca presumida. A aplicação revalida se está aberta. */
    async revisarCompetencia(ctx, { propostaId, versao, competencia }) {
      await exigir(ctx, [ACAO.APROVAR]);
      if (typeof competencia !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(competencia)) throw new ErroDeAprovacao("COMPETENCIA_INVALIDA");
      if (!Number.isInteger(versao)) throw new ErroDeAprovacao("VERSAO_OBRIGATORIA");
      if (typeof a.propostas.revisar !== "function") throw new ErroDeAprovacao("REVISAO_INDISPONIVEL");
      const r = UUID.test(propostaId ?? "") ? await a.propostas.revisar(escopo(ctx), propostaId, versao, { competenciaRevisada: competencia, competenciaRevisadaPor: ctx.usuarioId }) : null;
      if (!r) throw new ErroDeAprovacao("PROPOSTA_ALTERADA_OU_INEXISTENTE");
      await a.auditoria.registrar({ acao: "COMPETENCIA_REVISADA", atorTipo: "USUARIO", atorRef: ctx.usuarioId, alvo: propostaId, dados: { competencia } });
      return r;
    },
    /** Revisão de classificação (Nível 2): grava a categoria escolhida na proposta; a aplicação valida no Financeiro. */
    async revisarClassificacao(ctx, { propostaId, versao, categoria }) {
      await exigir(ctx, [ACAO.APROVAR]);
      if (typeof categoria !== "string" || !/^[A-Z][A-Z0-9_]{1,79}$/.test(categoria)) throw new ErroDeAprovacao("CATEGORIA_INVALIDA");
      if (!Number.isInteger(versao)) throw new ErroDeAprovacao("VERSAO_OBRIGATORIA");
      if (typeof a.propostas.revisar !== "function") throw new ErroDeAprovacao("REVISAO_INDISPONIVEL");
      const r = UUID.test(propostaId ?? "") ? await a.propostas.revisar(escopo(ctx), propostaId, versao, { categoriaRevisada: categoria, revisadaPor: ctx.usuarioId }) : null;
      if (!r) throw new ErroDeAprovacao("PROPOSTA_ALTERADA_OU_INEXISTENTE");
      await a.auditoria.registrar({ acao: "CLASSIFICACAO_REVISADA", atorTipo: "USUARIO", atorRef: ctx.usuarioId, alvo: propostaId, dados: { categoria } });
      return r;
    },
    /** Reprocessar um evento que falhou (Nível 2). O evento precisa ser da unidade do contexto ou ainda sem unidade. */
    async reprocessar(ctx, { eventoId }) {
      await exigir(ctx, [ACAO.APROVAR]);
      if (!fila?.reprocessar) throw new ErroDeAprovacao("REPROCESSAMENTO_INDISPONIVEL");
      const ok = await fila.reprocessar(String(eventoId ?? ""));
      if (!ok) throw new ErroDeAprovacao("EVENTO_NAO_ESTA_EM_FALHA");
      await a.auditoria.registrar({ acao: "EVENTO_REPROCESSADO", atorTipo: "USUARIO", atorRef: ctx.usuarioId, alvo: String(eventoId) });
      return { ok: true };
    },
    /**
     * Agente 2 — Frente C: um RESPONSÁVEL confirma a baixa pelo extrato já conferida (nível APLICAR_COM_CONFIRMACAO, ou revisão).
     * Usa o contexto VERIFICADO da pessoa (as permissões dela) e o mesmo caminho da execução automática (idempotente, auditado).
     */
    async confirmarBaixaPorExtrato(ctx, { propostaId } = {}, { nucleo = nucleoPadrao } = {}) {
      await exigir(ctx, [ACAO.APROVAR, ACAO.VINCULAR_PAGAMENTO, ACAO.ENVIAR_DOCUMENTO]);
      if (!execucao) throw new ErroDeAprovacao("EXECUCAO_DESLIGADA");
      const esc = escopo(ctx);
      const p = UUID.test(propostaId ?? "") ? await a.propostas.obter(esc, propostaId) : null;
      if (!p) throw new ErroDeAprovacao("PROPOSTA_NAO_ENCONTRADA");
      if (p.estado !== "AGUARDANDO_REVISAO") throw new ErroDeAprovacao("PROPOSTA_JA_DECIDIDA", { estado: p.estado });
      if (p.conciliacao?.situacao !== "CONFERIDA" || !p.conciliacao.movimentacaoId) throw new ErroDeAprovacao("EXTRATO_NAO_CONFERIDO");
      if (!requisitosCompletos(unidadePorId(cfg, p.unidadeId))) throw new ErroDeAprovacao("REQUISITOS_FINANCEIROS_INCOMPLETOS");
      const r = await execucao.liquidar({ proposta: p, escopo: esc, movimentacaoId: p.conciliacao.movimentacaoId, nivel: NIVEL.APLICAR_COM_CONFIRMACAO,
        politicaId: p.autonomia?.politicaId ?? null, executor: executorDaPessoa({ nucleo, ctx }) });
      await a.aprovacoes.registrar({ propostaId: p.id, acao: r.ok ? "APLICADA" : "FALHOU", usuarioId: ctx.usuarioId, motivo: r.ok ? null : r.motivo, resultado: r.resultado ?? null });
      if (!r.ok) throw new ErroDeAprovacao(r.motivo ?? "FALHA_NA_EXECUCAO", r.detalhes ?? {});
      return r;
    },
    /**
     * Agente 2 — Frente C: REVERSÃO de uma operação executada, pelo ESTORNO oficial de cada liquidação, por responsável com
     * financeiro_v2.cancelar (as permissões dessa pessoa). Fica registrada (operação REVERTIDA + auditoria); nada é apagado.
     */
    async reverterOperacao(ctx, { operacaoId, justificativa } = {}, { nucleo = nucleoPadrao } = {}) {
      await exigir(ctx, [ACAO.CANCELAR]);
      if (typeof justificativa !== "string" || justificativa.trim().length < 10) throw new ErroDeAprovacao("JUSTIFICATIVA_OBRIGATORIA");
      const esc = escopo(ctx);
      const op = UUID.test(operacaoId ?? "") ? await a.operacoes.obter(operacaoId, esc) : null;
      if (!op) throw new ErroDeAprovacao("OPERACAO_NAO_ENCONTRADA");
      if (op.estado !== "EXECUTADA") throw new ErroDeAprovacao("OPERACAO_NAO_REVERSIVEL", { estado: op.estado });
      const estornos = [];
      for (const liquidacaoId of op.resultado?.liquidacaoIds ?? []) {
        const e = await nucleo.estornarLiquidacao(ctx, { liquidacaoId, justificativa: `Reversão de operação do MOVA: ${justificativa.trim()}`.slice(0, 500) });
        estornos.push(e.estorno?.id ?? null);
      }
      const revertida = await a.operacoes.reverter(op.id, esc, { por: ctx.usuarioId, justificativa: justificativa.trim().slice(0, 500), resultado: { estornos } });
      if (!revertida) throw new ErroDeAprovacao("OPERACAO_NAO_REVERSIVEL");
      await a.auditoria.registrar({ acao: "OPERACAO_REVERTIDA", atorTipo: "USUARIO", atorRef: ctx.usuarioId, alvo: op.propostaId, dados: { operacaoId: op.id, estornos: estornos.length } });
      return revertida;
    },
    /** Agente 2 — Frente C: cadastro de POLÍTICA DE AUTONOMIA (financeiro_v2.configurar). Só na empresa da sessão. */
    async criarPolitica(ctx, entrada = {}) {
      await exigir(ctx, [ACAO.CONFIGURAR]);
      let p;
      try { p = validarPolitica({ ...entrada, organizacaoId: escopo(ctx).organizacaoId }); } catch (e) { throw new ErroDeAprovacao("POLITICA_INVALIDA", { campo: e.campo ?? null }); }
      if (p.unidadeId && !cfg.unidades.some((u) => u.unidadeId === p.unidadeId && u.organizacaoId === p.organizacaoId)) throw new ErroDeAprovacao("UNIDADE_FORA_DO_MOVA");
      let id;
      try { id = await a.politicas.criar(p, { criadaPor: ctx.usuarioId }); } catch (e) { throw new ErroDeAprovacao(e?.codigo === "POLITICA_ATIVA_EXISTE" || e?.code === "23505" ? "POLITICA_ATIVA_EXISTE" : "POLITICA_NAO_GRAVADA"); }
      await a.auditoria.registrar({ acao: "POLITICA_CRIADA", atorTipo: "USUARIO", atorRef: ctx.usuarioId, alvo: id, dados: { operacao: p.operacao, nivel: p.nivel, unidadeId: p.unidadeId, limiteCentavos: p.limiteCentavos } });
      return { id };
    },
    async revogarPolitica(ctx, { politicaId } = {}) {
      await exigir(ctx, [ACAO.CONFIGURAR]);
      const ok = UUID.test(politicaId ?? "") && await a.politicas.revogar({ id: politicaId, organizacaoId: escopo(ctx).organizacaoId, por: ctx.usuarioId });
      if (!ok) throw new ErroDeAprovacao("POLITICA_NAO_ENCONTRADA");
      await a.auditoria.registrar({ acao: "POLITICA_REVOGADA", atorTipo: "USUARIO", atorRef: ctx.usuarioId, alvo: politicaId });
      return { ok: true };
    },
    async rejeitar(ctx, { propostaId, motivo }) {
      await exigir(ctx, [ACAO.APROVAR]);
      const esc = escopo(ctx);
      const r = UUID.test(propostaId ?? "") ? await a.propostas.transicionar(esc, propostaId, "AGUARDANDO_REVISAO", "REJEITADA") : null;
      if (!r) throw new ErroDeAprovacao("PROPOSTA_JA_DECIDIDA_OU_INEXISTENTE");
      await a.aprovacoes.registrar({ propostaId, acao: "REJEITADA", usuarioId: ctx.usuarioId, motivo: String(motivo ?? "").slice(0, 300) || null });
      await a.auditoria.registrar({ acao: "PROPOSTA_REJEITADA", atorTipo: "USUARIO", atorRef: ctx.usuarioId, alvo: propostaId });
      return r;
    },
  });
}
