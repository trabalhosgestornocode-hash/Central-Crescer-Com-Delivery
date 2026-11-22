// ROTAS do Centro Financeiro para o MOVA (Execução 03). Montadas em rotas.js DEPOIS de `comIdentidade` + `preparar`, ou seja,
// com o CONTEXTO VERIFICADO da sessão da plataforma (organização, unidade e permissões da concessão gravada). Nada aqui confia em
// permissão vinda do navegador: cada handler confere `ctx.permissoes` e o escopo é SEMPRE a unidade da sessão.
//
//   GET  /api/mova/caixa                 Caixa de Entrada (financeiro_v2.ver)
//   GET  /api/mova/proposta?id=          detalhe da proposta + aprovações (ver)
//   GET  /api/mova/documento?evento=     item da mensagem/documento (metadados; o arquivo não é servido aqui) (ver)
//   GET  /api/mova/historico             decisões do agente na unidade (ver)
//   GET  /api/mova/estado                fila, respostas, worker e chaves (ver)
//   GET  /api/mova/erros                 eventos que falharam (só código e tentativas) (ver)
//   POST /acoes/mova/classificar         revisar categoria (aprovar)
//   POST /acoes/mova/competencia         informar a competência pendente (aprovar)
//   POST /acoes/mova/aplicar             aprovar e aplicar pelo Financeiro (aprovar + aplicar + registrar; unidade com escrita liberada)
//   POST /acoes/mova/rejeitar            rejeitar (aprovar)
//   POST /acoes/mova/reprocessar         devolver evento com falha à fila (aprovar)
//   Agente 2 — Frente C (operações com autonomia):
//   GET  /api/mova/operacoes             operações executadas pelo MOVA na unidade (ver)
//   GET  /api/mova/politicas             políticas de autonomia da empresa (ver)
//   POST /acoes/mova/confirmar-baixa-extrato  responsável confirma a baixa já conferida com o extrato (aprovar + vincular + documentos)
//   POST /acoes/mova/reverter-operacao   estorno oficial de uma operação executada (cancelar)
//   POST /acoes/mova/politica            cadastrar política de autonomia (configurar)
//   POST /acoes/mova/politica-revogar    revogar política (configurar)
//   Agente 2 — Frente D (entregadores) e automações:
//   GET  /api/mova/entregadores          entregadores autorizados, notas recebidas e envios da rotina (ver)
//   GET  /api/mova/automacoes            automações da unidade (ver)
//   POST /acoes/mova/automacao           ligar/desligar e horário (configurar)
//   POST /acoes/mova/automacao-pausa     pausar/retomar uma automação (configurar)
import { ACAO } from "../financeiro-v2/index.js";
import { AUTOMACAO, ErroDeAprovacao } from "../mova-financeiro/index.js";

const recusa = (status, codigo, mensagem) => Object.assign(new Error(mensagem), { codigoHttp: status, codigo });
const STATUS = { OPERACAO_NAO_ENCONTRADA: 404, POLITICA_NAO_ENCONTRADA: 404, POLITICA_INVALIDA: 400, JUSTIFICATIVA_OBRIGATORIA: 400, EXECUCAO_DESLIGADA: 404, PERMISSAO_INSUFICIENTE: 403, PROPOSTA_NAO_ENCONTRADA: 404, PROPOSTA_JA_DECIDIDA_OU_INEXISTENTE: 409, CATEGORIA_INVALIDA: 400, VERSAO_OBRIGATORIA: 400, CONTA_OBRIGATORIA: 400 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const escopo = (ctx) => ({ organizacaoId: ctx.organizacaoId, unidadeId: ctx.unidadeId });

const exigirConfigurar = (ctx) => { if (!ctx?.permissoes?.includes(ACAO.CONFIGURAR)) throw recusa(403, "PERMISSAO_INSUFICIENTE", "Alterar automações exige permissão de configuração."); };
function exigirVer(ctx) {
  if (!ctx?.permissoes?.includes(ACAO.VER)) throw recusa(403, "PERMISSAO_INSUFICIENTE", "Permissão financeira insuficiente.");
}
const traduzir = (e) => {
  if (e instanceof ErroDeAprovacao) return recusa(STATUS[e.codigo] ?? 409, e.codigo, "A proposta não pôde ser processada.");
  return e;
};

export const CONSULTAS_MOVA = Object.freeze({
  "/mova/caixa": async ({ ctx, mova }) => { exigirVer(ctx); return mova.consultas.caixaDeEntrada(escopo(ctx)); },
  "/mova/proposta": async ({ ctx, mova, params }) => {
    exigirVer(ctx);
    if (!UUID.test(params.id ?? "")) throw recusa(400, "PARAMETRO_INVALIDO", "Proposta inválida.");
    const p = await mova.consultas.proposta({ ...escopo(ctx), id: params.id.toLowerCase() });
    if (!p) throw recusa(404, "PROPOSTA_NAO_ENCONTRADA", "Proposta não encontrada nesta unidade.");
    return p;
  },
  "/mova/documento": async ({ ctx, mova, params }) => {
    exigirVer(ctx);
    const d = typeof params.evento === "string" && /^[A-Za-z0-9_.:@-]{1,160}$/.test(params.evento) ? await mova.consultas.documento({ ...escopo(ctx), eventoId: params.evento }) : null;
    if (!d) throw recusa(404, "DOCUMENTO_NAO_ENCONTRADO", "Mensagem não encontrada nesta unidade.");
    return d;
  },
  "/mova/operacoes": async ({ ctx, mova }) => { exigirVer(ctx); return { itens: mova.armazenamento.operacoes ? await mova.armazenamento.operacoes.listar(escopo(ctx)) : [] }; },
  "/mova/politicas": async ({ ctx, mova }) => {
    exigirVer(ctx);
    const todas = mova.armazenamento.politicas ? await mova.armazenamento.politicas.listar(ctx.organizacaoId) : [];
    return { autonomiaLigada: Boolean(mova.execucao), identidadeOperacional: Boolean(mova.execucao?.operacional), itens: todas.filter((p) => !p.unidadeId || p.unidadeId === ctx.unidadeId) };
  },
  "/mova/entregadores": async ({ ctx, mova }) => {
    exigirVer(ctx);
    const a = mova.armazenamento;
    const lista = (mova.cfg.entregadores ?? []).filter((e) => e.unidadeId === ctx.unidadeId && e.organizacaoId === ctx.organizacaoId);
    const comConversa = new Set(mova.cfg.gruposAutorizados.filter((g) => g.entregador).map((g) => g.grupoId));
    return {
      ligado: Boolean(mova.entregadores),
      itens: lista.map((e) => ({ chave: e.chave, nome: e.nome, telefone: `…${e.telefoneE164.slice(-4)}`, conversa: comConversa.has(e.privado) ? "ATIVA" : "NUMERO_DA_EQUIPE" })),
      notas: a.notasEntregador ? await a.notasEntregador.listar(escopo(ctx)) : [],
      envios: a.enviosEntregador ? await a.enviosEntregador.listar(escopo(ctx)) : [],
    };
  },
  "/mova/automacoes": async ({ ctx, mova }) => { exigirVer(ctx); return { itens: mova.armazenamento.automacoes ? await mova.armazenamento.automacoes.listar(escopo(ctx)) : [] }; },
  "/mova/historico": async ({ ctx, mova }) => { exigirVer(ctx); return { itens: await mova.consultas.historico(escopo(ctx)) }; },
  "/mova/estado": async ({ ctx, mova, worker, enviador, chaves, controle, orcamento }) => {
    exigirVer(ctx);
    return { fila: await mova.fila.estatisticas(), respostas: await mova.armazenamento.saida.contagem(), worker: worker?.estado() ?? null, envioHabilitado: Boolean(enviador?.habilitado), chaves,
      controle: controle ? await controle.estado() : null, orcamentoIa: orcamento ? await orcamento.resumo().catch(() => null) : null };
  },
  // Falhas da fila SÓ das conversas que atendem a unidade da sessão (H-1/isolamento).
  "/mova/erros": async ({ ctx, mova }) => { exigirVer(ctx); return { itens: mova.consultas ? await mova.consultas.falhasDaFila(escopo(ctx)) : [] }; },
  // H-1: falhas GERAIS (sem unidade identificada) — só metadados; exige configurar.
  "/mova/falhas-gerais": async ({ ctx, mova }) => {
    if (!ctx?.permissoes?.includes(ACAO.CONFIGURAR)) throw recusa(403, "PERMISSAO_INSUFICIENTE", "Falhas gerais do MOVA exigem permissão de configuração.");
    return mova.consultas.falhasGerais(escopo(ctx));
  },
  // Arquivo da evidência: só da unidade da sessão, com conferência de integridade; exige financeiro_v2.documentos.
  "/mova/arquivo": async ({ ctx, mova, params }) => {
    if (!ctx?.permissoes?.includes(ACAO.DOCUMENTOS)) throw recusa(403, "PERMISSAO_INSUFICIENTE", "Abrir documentos exige permissão de documentos.");
    if (!/^[0-9a-f]{64}$/.test(params.sha ?? "")) throw recusa(400, "PARAMETRO_INVALIDO", "Documento inválido.");
    let d;
    try { d = await mova.evidencias.obterDaUnidade(params.sha, escopo(ctx)); } catch (e) { if (e?.codigo === "EVIDENCIA_ADULTERADA") throw recusa(409, "EVIDENCIA_ADULTERADA", "O documento não confere com o registro."); throw e; }
    if (!d) throw recusa(404, "DOCUMENTO_NAO_ENCONTRADO", "Documento não encontrado nesta unidade.");
    return { mime: d.mime, nomeArquivo: d.nomeArquivo, base64: Buffer.from(d.bytes).toString("base64") };
  },
});

export const ACOES_MOVA = Object.freeze({
  // 15A: competência informada na revisão humana (nunca presumida pelo MOVA); não escreve no Financeiro.
  "/mova/competencia": { campos: ["propostaId", "versao", "competencia"], escreveNoFinanceiro: false,
    fazer: ({ ctx, mova, b }) => mova.aprovador.revisarCompetencia(ctx, { propostaId: b.propostaId, versao: b.versao, competencia: b.competencia }) },
  "/mova/classificar": { campos: ["propostaId", "versao", "categoria"], escreveNoFinanceiro: false,
    fazer: ({ ctx, mova, b }) => mova.aprovador.revisarClassificacao(ctx, { propostaId: b.propostaId, versao: b.versao, categoria: b.categoria }) },
  "/mova/aplicar": { campos: ["propostaId", "contaId", "categoria"], escreveNoFinanceiro: true,
    fazer: ({ ctx, mova, nucleo, b }) => mova.aprovador.aplicar(ctx, { propostaId: b.propostaId, contaId: b.contaId ?? null, categoria: b.categoria ?? null }, { nucleo }) },
  "/mova/confirmar-baixa-extrato": { campos: ["propostaId"], escreveNoFinanceiro: true,
    fazer: ({ ctx, mova, nucleo, b }) => mova.aprovador.confirmarBaixaPorExtrato(ctx, { propostaId: b.propostaId }, { nucleo }) },
  "/mova/reverter-operacao": { campos: ["operacaoId", "justificativa"], escreveNoFinanceiro: true,
    fazer: ({ ctx, mova, nucleo, b }) => mova.aprovador.reverterOperacao(ctx, { operacaoId: b.operacaoId, justificativa: b.justificativa }, { nucleo }) },
  "/mova/politica": { campos: ["operacao", "unidadeId", "nivel", "limiteCentavos", "responsavel", "motivo", "vigenteDe", "vigenteAte"], escreveNoFinanceiro: false,
    fazer: ({ ctx, mova, b }) => mova.aprovador.criarPolitica(ctx, b) },
  "/mova/politica-revogar": { campos: ["politicaId"], escreveNoFinanceiro: false,
    fazer: ({ ctx, mova, b }) => mova.aprovador.revogarPolitica(ctx, { politicaId: b.politicaId }) },
  "/mova/automacao": { campos: ["nome", "ativa", "horario"], escreveNoFinanceiro: false,
    fazer: async ({ ctx, mova, b }) => {
      exigirConfigurar(ctx);
      if (!Object.values(AUTOMACAO).includes(b.nome) || typeof b.ativa !== "boolean" || (b.horario !== undefined && !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(b.horario))) throw recusa(400, "PARAMETRO_INVALIDO", "Automação, liga/desliga ou horário inválidos.");
      const r = await mova.armazenamento.automacoes.definir({ nome: b.nome, ...escopo(ctx), ativa: b.ativa, horario: b.horario ?? "09:00" });
      if (!r) throw recusa(404, "AUTOMACAO_NAO_ENCONTRADA", "Automação de outra empresa.");
      await mova.armazenamento.auditoria.registrar({ acao: "AUTOMACAO_DEFINIDA", atorTipo: "USUARIO", atorRef: ctx.usuarioId, alvo: b.nome, dados: { unidadeId: ctx.unidadeId, ativa: b.ativa, horario: r.horario } });
      return r;
    } },
  "/mova/automacao-pausa": { campos: ["nome", "pausar", "motivo"], escreveNoFinanceiro: false,
    fazer: async ({ ctx, mova, b }) => {
      exigirConfigurar(ctx);
      if (!Object.values(AUTOMACAO).includes(b.nome) || typeof b.pausar !== "boolean") throw recusa(400, "PARAMETRO_INVALIDO", "Informe a automação e se é para pausar.");
      const a = mova.armazenamento.automacoes;
      const r = b.pausar ? await a.pausar({ nome: b.nome, unidadeId: ctx.unidadeId, por: ctx.usuarioId, motivo: typeof b.motivo === "string" ? b.motivo.slice(0, 300) : null }) : await a.retomar({ nome: b.nome, unidadeId: ctx.unidadeId });
      if (!r || r.organizacaoId !== ctx.organizacaoId) throw recusa(404, "AUTOMACAO_NAO_ENCONTRADA", "Automação não cadastrada nesta unidade.");
      await mova.armazenamento.auditoria.registrar({ acao: b.pausar ? "AUTOMACAO_PAUSADA" : "AUTOMACAO_RETOMADA", atorTipo: "USUARIO", atorRef: ctx.usuarioId, alvo: b.nome, dados: { unidadeId: ctx.unidadeId } });
      return r;
    } },
  "/mova/rejeitar": { campos: ["propostaId", "motivo"], escreveNoFinanceiro: false,
    fazer: ({ ctx, mova, b }) => mova.aprovador.rejeitar(ctx, { propostaId: b.propostaId, motivo: b.motivo }) },
  // Reversão funcional (ou religar) EM TEMPO REAL: sem deploy, sem reiniciar o Gateway, sem tocar no WhatsApp.
  "/mova/controle": { campos: ["suspenso", "recebimento", "processamento", "ia", "envio", "motivo"], escreveNoFinanceiro: false,
    fazer: async ({ ctx, controle, b }) => {
      if (!ctx?.permissoes?.includes(ACAO.CONFIGURAR)) throw recusa(403, "PERMISSAO_INSUFICIENTE", "Alterar o MOVA exige permissão de configuração.");
      if (!controle) throw recusa(404, "MOVA_SEM_CONTROLE", "Controle indisponível.");
      const { motivo, ...alteracoes } = b;
      if (Object.keys(alteracoes).length === 0 || Object.values(alteracoes).some((v) => typeof v !== "boolean")) throw recusa(400, "PARAMETRO_INVALIDO", "Informe ao menos um interruptor (verdadeiro/falso).");
      await controle.alterar(alteracoes, { autor: ctx.usuarioId, motivo: typeof motivo === "string" ? motivo.slice(0, 300) : null });
      return controle.estado();
    } },
  "/mova/reprocessar": { campos: ["eventoId"], escreveNoFinanceiro: false,
    fazer: async ({ ctx, mova, b }) => {
      const eventoId = typeof b.eventoId === "string" && /^[A-Za-z0-9_.:@-]{1,160}$/.test(b.eventoId) ? b.eventoId : null;
      if (!eventoId) throw recusa(400, "PARAMETRO_INVALIDO", "Evento inválido.");
      // 1) falha da fila de conversa da unidade ⇒ fluxo de sempre (aprovar)
      if (await mova.consultas.falhaDaFilaNoEscopo({ ...escopo(ctx), eventoId })) return mova.aprovador.reprocessar(ctx, { eventoId });
      // 2) falha de leitura SEM unidade (H-1) ⇒ exige configurar; condicional e auditado
      if (!ctx?.permissoes?.includes(ACAO.CONFIGURAR)) throw recusa(404, "EVENTO_NAO_ESTA_EM_FALHA", "Evento não encontrado em falha nesta unidade.");
      if (!(await mova.fila.reprocessarLeitura(eventoId, escopo(ctx)))) throw recusa(404, "EVENTO_NAO_ESTA_EM_FALHA", "Evento não encontrado em falha nesta unidade.");
      await mova.armazenamento.auditoria.registrar({ acao: "FALHA_GERAL_REPROCESSADA", atorTipo: "USUARIO", atorRef: ctx.usuarioId, alvo: eventoId });
      return { ok: true };
    } },
});

/** Executa uma ação já com contexto verificado; erros do aprovador viram HTTP fechados. */
export async function executarAcaoMova(acao, deps) {
  try { return await acao.fazer(deps); } catch (e) { throw traduzir(e); }
}
