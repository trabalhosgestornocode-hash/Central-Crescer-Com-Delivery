// PORTA FINANCEIRA do MOVA — o ÚNICO caminho do agente até o Financeiro v2.
//
// MENOR PRIVILÉGIO, em três camadas:
//   1. lista FECHADA de operações do núcleo que a porta pode chamar (todas somente leitura) — qualquer outra é recusada
//      antes de chegar ao núcleo (`OPERACOES_PERMITIDAS`);
//   2. o contexto enviado ao núcleo carrega SÓ `financeiro_v2.ver`, mesmo que o usuário tenha mais permissões: o MOVA
//      não herda o poder de quem fala com ele;
//   3. as permissões do usuário são lidas da CONCESSÃO gravada (porta `concessoes`, mesmo contrato das concessões do
//      Financeiro v2, aplicacao/sessao.js) — participar do grupo não concede nada.
// Escrita: NENHUMA nesta execução. Propostas ficam no armazenamento próprio do MOVA (simulado) e levam o comando no formato
// EXATO do contrato do Financeiro v2 (validado por `comandos.validarObrigacao` e pelo formato de `pagarContaAPagar`), para
// que a aplicação futura — por uma pessoa com `financeiro_v2.aprovar` + `financeiro_v2.aplicar` — use o serviço real.
//
// ACOPLAMENTO: este módulo NÃO importa o Financeiro v2 (a regra de isolamento do projeto só permite isso à camada de
// integração). Quem monta injeta `financeiro` = { ACAO, ErroFinanceiro, validarObrigacao, categoriaProvisoria }, vindos da
// superfície pública do núcleo. Os testes fazem o mesmo.
import { ErroTransitorio } from "../gateway/fila.js";

/** Peças do contrato do Financeiro v2 que o MOVA usa (injetadas). */
export function exigirContratoFinanceiro(f) {
  const ok = f && f.ACAO && typeof f.ACAO.VER === "string" && typeof f.ACAO.ENVIAR_DOCUMENTO === "string" && typeof f.ErroFinanceiro === "function"
    && typeof f.validarObrigacao === "function" && typeof f.categoriaProvisoria === "string";
  if (!ok) throw new TypeError("MOVA exige o contrato do Financeiro v2 injetado (ACAO, ErroFinanceiro, validarObrigacao, categoriaProvisoria)");
  return Object.freeze({ ACAO: f.ACAO, ErroFinanceiro: f.ErroFinanceiro, validarObrigacao: f.validarObrigacao, categoriaProvisoria: f.categoriaProvisoria });
}

export const OPERACOES_PERMITIDAS = Object.freeze([
  "consultarContasAPagar", "consultarCompetencia", "consultarResumoFinanceiro",
  // Execução 03 — leituras das ferramentas financeiras (aplicacao/ferramentas.js). Todas passam por b.consultar no núcleo.
  "consultarVendas", "apurarCompetencia", "consultarFluxoDeCaixa", "consultarContasAReceber", "consultarPendencias", "consultarPlanoDeContas",
  "consultarDocumentos", "detalharContaAPagar",
  // MOVA CORE F4: prestação de contas das sangrias (pendente, prazo, estado) — só leitura (b.consultar).
  "consultarPrestacaoDeSangrias",
  // 25/11: retiradas importadas do PDV e a conta PAGA de cada uma (categoria, provisória ou não) — só leitura (b.consultar).
  "consultarSangriasComoDespesa", "consultarSangriasSwf",
  // 16A — cobertura por canal (dias com dado, pendências, até quando há registro) para o faturamento por canal.
  "consultarCalendarioDeFaturamento",
  // Agente 2 — fechamento semanal dos entregadores próprios (painel agregado; só leitura, b.consultar no núcleo).
  "consultarEntregadoresProprios",
  // Agente 2 — Frente C: prévia OFICIAL da baixa pelo extrato (saídas elegíveis, bloqueios, efeito) — só leitura (b.consultar).
  "previaDoVinculoDoExtrato",
  // Agente 2 — Frente D: o fechamento do PRÓPRIO entregador (histórico e detalhe da semana) — só leitura.
  "consultarEntregador", "detalharFechamentoDoEntregador",
  // MOVA CORE F1 (24/11) — caixa físico e bancos para o catálogo de ferramentas: leituras (tesouraria.consulta / b.consultar).
  "consultarCaixaEBancos", "consultarMovimentosDeCaixa",
  // Execução 17: pagamentos por comprovante ainda sem conciliação e as saídas candidatas do extrato — só leitura.
  "consultarPagamentosPorComprovanteAConciliar",
]);
const SITUACOES_ABERTAS = Object.freeze(["EM_ABERTO", "PARCIALMENTE_PAGO", "VENCIDO", "AGUARDANDO_CLASSIFICACAO_OU_EVIDENCIA"]);
const MAX_PAGINAS = 20;

/**
 * @param {{nucleo:object, concessoes:{listar:Function}, financeiro:object}} deps
 */
export function criarPortaFinanceira({ nucleo, concessoes, financeiro }) {
  if (!nucleo || !concessoes?.listar) throw new TypeError("porta financeira exige núcleo e concessões");
  const { ACAO, ErroFinanceiro, validarObrigacao, categoriaProvisoria } = exigirContratoFinanceiro(financeiro);
  /** Erro do Financeiro que NÃO é de regra (rede, banco, indisponibilidade) vira transitório: a fila tenta de novo. */
  const traduzir = (e) => {
    if (e instanceof ErroFinanceiro) throw e;
    // 25/11: a CAUSA técnica (só o código: SQLSTATE do PostgreSQL ou o nome do erro, nunca mensagem ou dado) segue junto para o
    // diagnóstico — na homologação real, "Financeiro indisponível" escondia a recusa de conexão do papel de leitura (53300).
    throw Object.assign(new ErroTransitorio("FINANCEIRO_INDISPONIVEL"), { causa: String(e?.code ?? e?.codigo ?? e?.name ?? "ERRO").slice(0, 40) });
  };
  const chamar = async (op, escopo, entrada) => {
    if (!OPERACOES_PERMITIDAS.includes(op) || typeof nucleo[op] !== "function") throw new Error(`Operação não permitida ao MOVA: ${op}`);
    const ctx = { organizacaoId: escopo.organizacaoId, unidadeId: escopo.unidadeId, usuarioId: escopo.usuarioId, permissoes: [ACAO.VER] };
    try { return await nucleo[op](ctx, entrada); } catch (e) { return traduzir(e); }
  };
  return Object.freeze({
    /** Permissões financeiras do usuário NA unidade (concessão gravada). Sem concessão = []. */
    async permissoesDoUsuario({ organizacaoId, unidadeId, usuarioId }) {
      let lista;
      try { lista = await concessoes.listar({ organizacaoId, usuarioId }); } catch (e) { return traduzir(e); }
      return (lista ?? []).find((c) => c.unidadeId === unidadeId)?.acoes ?? [];
    },
    /** Contas a pagar em aberto (todas as páginas, com teto). */
    async contasAPagarAbertas(escopo) {
      const itens = [];
      for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
        const r = await chamar("consultarContasAPagar", escopo, { pagina, tamanho: 100 });
        itens.push(...(r.itens ?? []).filter((t) => SITUACOES_ABERTAS.includes(t.situacao)));
        if (!r.itens || r.itens.length < 100) break;
      }
      return itens;
    },
    /** Todas as obrigações (abertas e pagas) — para detectar duplicidade de boleto/nota já registrados. */
    async contasAPagarTodas(escopo) {
      const itens = [];
      for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
        const r = await chamar("consultarContasAPagar", escopo, { pagina, tamanho: 100 });
        itens.push(...(r.itens ?? []));
        if (!r.itens || r.itens.length < 100) break;
      }
      return itens;
    },
    async estadoDaCompetencia(escopo, competencia) {
      return (await chamar("consultarCompetencia", escopo, { competencia })).estado;
    },
    async resumo(escopo, competencia) {
      return chamar("consultarResumoFinanceiro", escopo, { competencia });
    },
    /** Leitura genérica, SÓ das operações da lista fechada (as ferramentas financeiras usam esta). */
    ler: (op, escopo, entrada) => chamar(op, escopo, entrada),
    /** Confere o comando da obrigação com o contrato REAL do Financeiro v2 (lança ErroFinanceiro se inválido). */
    validarComandoDeObrigacao: (cmd) => validarObrigacao(cmd),
    /** Erro de REGRA do Financeiro (entrada inválida etc.), em oposição a indisponibilidade. */
    ehErroDeRegra: (e) => e instanceof ErroFinanceiro,
    acoes: ACAO,
    categoriaProvisoria,
  });
}
