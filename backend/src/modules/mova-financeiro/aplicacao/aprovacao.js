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
//   7. comprovante NÃO concilia extrato: a baixa cria a saída na conta escolhida pelo administrador; a conciliação com o extrato
//      continua sendo feita na Conciliação;
//   8. nunca executa pagamento bancário; falha devolve a proposta para revisão e fica registrada (aprovacao FALHOU + auditoria).
import { requisitosCompletos, unidadePorId } from "../dominio/configuracao.js";
import { exigirContratoFinanceiro } from "./portaFinanceira.js";

export class ErroDeAprovacao extends Error {
  constructor(codigo, detalhes = {}) { super(codigo); this.name = "ErroDeAprovacao"; this.codigo = codigo; this.detalhes = detalhes; }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mes = (d) => d.slice(0, 7);

/**
 * @param {{cfg:object, armazenamento:object, nucleo:object, financeiro:object}} deps  `nucleo` = núcleo do Financeiro v2 (injetado)
 */
export function criarAprovador({ cfg, armazenamento: a, nucleo, financeiro }) {
  const { ACAO, ErroFinanceiro } = exigirContratoFinanceiro(financeiro);
  const escopo = (ctx) => ({ organizacaoId: String(ctx?.organizacaoId ?? "").toLowerCase(), unidadeId: String(ctx?.unidadeId ?? "").toLowerCase() });

  async function exigir(ctx, acoes) {
    const ok = ctx && UUID.test(ctx.usuarioId ?? "") && UUID.test(ctx.organizacaoId ?? "") && UUID.test(ctx.unidadeId ?? "") && Array.isArray(ctx.permissoes) && acoes.every((x) => ctx.permissoes.includes(x));
    if (!ok) {
      await a.auditoria.registrar({ acao: "APROVACAO_RECUSADA", atorTipo: "USUARIO", atorRef: UUID.test(ctx?.usuarioId ?? "") ? ctx.usuarioId : null, dados: { motivo: "PERMISSAO_INSUFICIENTE" } });
      throw new ErroDeAprovacao("PERMISSAO_INSUFICIENTE");
    }
  }

  async function competenciaAberta(ctx, competencia) {
    const c = await nucleo.consultarCompetencia(ctx, { competencia });
    if (c.estado !== "ABERTA") throw new ErroDeAprovacao("COMPETENCIA_FECHADA", { competencia, estado: c.estado });
  }

  async function semDuplicata(ctx, p) {
    const e = p.comando.entrada;
    for (let pagina = 1; pagina <= 20; pagina++) {
      const r = await nucleo.consultarContasAPagar(ctx, { competencia: e.competencia, pagina, tamanho: 100 });
      const igual = (r.itens ?? []).find((t) => t.situacao !== "CANCELADO" && t.valorOriginalCentavos === e.valorOriginalCentavos && t.vencimento === e.vencimento && t.descricao !== undefined
        && (t.fornecedor?.nome ?? "").toLowerCase() === (e.contraparteNova?.nome ?? "").toLowerCase());
      if (igual) throw new ErroDeAprovacao("OBRIGACAO_JA_EXISTE", { obrigacaoId: igual.id });
      if (!r.itens || r.itens.length < 100) break;
    }
  }

  async function executar(ctx, p, { contaId, categoria }) {
    const fonte = { sistema: "MANUAL", idExterno: `MOVA:${p.id}` };
    if (p.tipo === "BAIXA_DE_OBRIGACAO") {
      const e = p.comando.entrada;
      await competenciaAberta(ctx, mes(e.dataEfetiva));
      const { titulo } = await nucleo.detalharContaAPagar(ctx, { id: e.obrigacaoId });
      if (titulo.situacao === "CANCELADO") throw new ErroDeAprovacao("OBRIGACAO_CANCELADA");
      if (e.valorCentavos > titulo.saldoCentavos) throw new ErroDeAprovacao("VALOR_MAIOR_QUE_SALDO", { saldoCentavos: titulo.saldoCentavos });
      const r = await nucleo.pagarContaAPagar(ctx, { obrigacaoId: e.obrigacaoId, contaId, dataEfetiva: e.dataEfetiva, valorCentavos: e.valorCentavos });
      return { obrigacaoId: e.obrigacaoId, movimentacaoId: r.movimentacao?.id ?? null };
    }
    const entrada = { ...p.comando.entrada, ...(categoria ? { categoria } : {}), fonte };
    await competenciaAberta(ctx, entrada.competencia);
    await semDuplicata(ctx, p);
    const ob = await nucleo.registrarObrigacao(ctx, entrada);
    const obrigacaoId = ob.obrigacoes[0].id;
    if (p.tipo === "NOVA_OBRIGACAO") return { obrigacaoId, movimentacaoId: null };
    // DESPESA_PAGA: a mesma proposta registra a obrigação e a baixa (o mês do caixa também precisa estar aberto).
    await competenciaAberta(ctx, mes(p.comando.pagamento.dataEfetiva));
    const pg = await nucleo.pagarContaAPagar(ctx, { obrigacaoId, contaId, dataEfetiva: p.comando.pagamento.dataEfetiva, valorCentavos: p.comando.pagamento.valorCentavos });
    return { obrigacaoId, movimentacaoId: pg.movimentacao?.id ?? null };
  }

  return Object.freeze({
    /**
     * @param {object} ctx contexto VERIFICADO do Financeiro v2 (sessão da plataforma)
     * @param {{propostaId:string, contaId?:string, categoria?:string}} e  contaId obrigatório para baixa/despesa paga
     */
    async aplicar(ctx, { propostaId, contaId = null, categoria = null } = {}) {
      await exigir(ctx, [ACAO.APROVAR, ACAO.APLICAR, ACAO.REGISTRAR]);
      const esc = escopo(ctx);
      const p = UUID.test(propostaId ?? "") ? await a.propostas.obter(esc, propostaId) : null;
      if (!p) throw new ErroDeAprovacao("PROPOSTA_NAO_ENCONTRADA");
      if (p.estado !== "AGUARDANDO_REVISAO") throw new ErroDeAprovacao("PROPOSTA_JA_DECIDIDA", { estado: p.estado });
      if (p.tipo === "SOLICITACAO_DE_REVISAO" || !p.comando) throw new ErroDeAprovacao("PROPOSTA_SEM_COMANDO");
      if (!requisitosCompletos(unidadePorId(cfg, p.unidadeId))) {
        await a.aprovacoes.registrar({ propostaId: p.id, acao: "RECUSADA", usuarioId: ctx.usuarioId, motivo: "REQUISITOS_FINANCEIROS_INCOMPLETOS" });
        throw new ErroDeAprovacao("REQUISITOS_FINANCEIROS_INCOMPLETOS");
      }
      if (p.tipo !== "NOVA_OBRIGACAO" && !UUID.test(contaId ?? "")) throw new ErroDeAprovacao("CONTA_OBRIGATORIA");
      const tomada = await a.propostas.transicionar(esc, p.id, "AGUARDANDO_REVISAO", "APLICANDO");
      if (!tomada) throw new ErroDeAprovacao("PROPOSTA_JA_DECIDIDA");
      try {
        const resultado = await executar(ctx, p, { contaId, categoria });
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
