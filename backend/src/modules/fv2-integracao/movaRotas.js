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
//   GET  /api/mova/entregadores-oficiais entregadores CONHECIDOS da unidade: fechamentos oficiais + Foody das semanas em aberto (ver)
//   POST /acoes/mova/entregador          cadastrar entregador OFICIAL + número WhatsApp (configurar; a chave é conferida no Financeiro)
//   POST /acoes/mova/entregador-revogar  revogar o cadastro (configurar; o histórico fica)
//   Agente 2 — Central de pendências e documentos recebidos SEM IA (nada escreve no Financeiro):
//   GET  /api/mova/conferencia           indicadores, pendências e saídas do extrato classificadas (ver; leitura com a sessão)
//   GET  /api/mova/documentos-recebidos  fila de revisão dos documentos do WhatsApp (ver)
//   GET  /api/mova/documento-relacionadas?sha=&busca=  contas que podem se relacionar (pela legenda/busca; o arquivo não é lido) (ver)
//   POST /acoes/mova/documento-conferir  marcar revisado/encaminhado (documentos); NÃO é baixa nem vínculo financeiro
//   Execução 17 — pagamento por comprovante × conciliação:
//   GET  /api/mova/pagamentos-a-conciliar  pagos por comprovante com a conciliação pendente e as saídas candidatas (ver)
//   GET  /api/mova/linha-do-tempo?proposta=  etapas do documento: recebimento → … → pagamento → extrato → conciliação (ver)
//   POST /acoes/mova/conciliar-comprovante  responsável liga a saída do extrato à MESMA baixa (vincular_pagamento; nunca 2ª baixa)
import { ACAO, ErroFinanceiro } from "../financeiro-v2/index.js";
import { AUTOMACAO, ErroDeAprovacao, ESTADO_CONFERENCIA, TIPOS_INFORMADOS, contasRelacionadas, linhaDoTempo, montarConferencia } from "../mova-financeiro/index.js";
import { normalizarTelefoneBr } from "../mova-financeiro/dominio/entregadores.js";

const recusa = (status, codigo, mensagem) => Object.assign(new Error(mensagem), { codigoHttp: status, codigo });
// ------------------------------------------------------------------ cadastro dos entregadores (23/11)
const textoCurto = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
function chaveDoEntregador(b) {
  const chave = typeof b.entregador === "string" ? b.entregador.trim() : "";
  if (!chave || chave.length > 200) throw recusa(400, "PARAMETRO_INVALIDO", "Informe o entregador do Financeiro.");
  return chave;
}
/** Só quem pode configurar, só em unidade ATENDIDA pelo MOVA (unidade fora dele derrubaria a montagem) e com o cadastro disponível. */
function exigirCadastroDeEntregador(ctx, mova) {
  exigirConfigurar(ctx);
  if (!mova.cfg.unidades.some((u) => u.unidadeId === ctx.unidadeId && u.organizacaoId === ctx.organizacaoId)) throw recusa(409, "UNIDADE_FORA_DO_MOVA", "Esta unidade ainda não é atendida pelo MOVA: o cadastro de WhatsApp dos entregadores fica disponível quando ela for configurada.");
  if (typeof mova.armazenamento.entregadores?.cadastrar !== "function") throw recusa(503, "CADASTRO_INDISPONIVEL", "Cadastro de entregadores indisponível.");
}
/**
 * 23/11 — ENTREGADORES CONHECIDOS da unidade (nunca cadastrados à mão): os dos fechamentos oficiais + os que o Foody já
 * identificou na semana atual e nas semanas encerradas ainda sem fechamento (mesma chave que o fechamento vai usar — o
 * fechamento posterior cai no MESMO entregador, sem duplicar). Só leitura; nenhuma obrigação é criada.
 */
const normalizarNome = (t) => String(t ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export async function entregadoresConhecidos({ ctx, nucleo, semanasAbertas = 2 }) {
  if (typeof nucleo?.consultarEntregadoresProprios !== "function") throw recusa(503, "FINANCEIRO_INDISPONIVEL", "Financeiro indisponível.");
  const r = await nucleo.consultarEntregadoresProprios(ctx, {});
  const porChave = new Map();
  const somar = (chave, nome, semana, fechado) => {
    if (!chave) return;
    const x = porChave.get(chave) ?? { chave, nome: nome ?? chave, semanas: new Set(), semanasFechadas: new Set() };
    if (semana) x.semanas.add(semana);
    if (fechado && semana) { x.semanasFechadas.add(semana); x.nome = nome ?? x.nome; }
    porChave.set(chave, x);
  };
  for (const f of r.fechamentos ?? []) somar(f.entregador?.chave, f.entregador?.nome, f.semanaInicio, true);
  const abertas = [r];
  for (const s of (r.semanas ?? []).filter((x) => x.semRegistro).slice(0, semanasAbertas)) abertas.push(await nucleo.consultarEntregadoresProprios(ctx, { semana: s.inicio }));
  for (const a of abertas) if (a.semana?.situacao !== "CONSOLIDADA") for (const e of a.entregadores ?? []) if ((e.entregasSemana ?? 0) > 0 || e.valorSemanaCentavos > 0) somar(e.chave, e.nome, a.semana.inicio, false);
  const itens = [...porChave.values()].map((x) => {
    const semanas = [...x.semanas].sort().reverse();
    const fechadas = [...x.semanasFechadas].sort().reverse();
    return { chave: x.chave, nome: x.nome, ultimaSemana: fechadas[0] ?? null, ultimaAtividade: semanas[0] ?? null, semanas: semanas.slice(0, 12), semanasFechadas: fechadas.length, listaFechadas: fechadas.slice(0, 12),
      origem: fechadas.length ? "FECHAMENTO" : "FOODY_SEM_FECHAMENTO" };
  });
  // Nomes iguais com chaves diferentes: nunca juntar; sinalizar para conferência humana.
  const porNome = new Map();
  for (const i of itens) porNome.set(normalizarNome(i.nome), [...(porNome.get(normalizarNome(i.nome)) ?? []), i.chave]);
  for (const i of itens) i.nomeRepetido = (porNome.get(normalizarNome(i.nome))?.length ?? 0) > 1;
  return itens.sort((a, b2) => a.nome.localeCompare(b2.nome, "pt-BR") || a.chave.localeCompare(b2.chave));
}
async function entregadorOficial({ ctx, nucleo, chave }) {
  let oficial;
  try { oficial = await nucleo.consultarEntregador(ctx, { entregador: chave }); } catch (e) {
    if (e?.codigo === "FV2_NAO_ENCONTRADO") oficial = null; else throw e;
  }
  const f = (oficial?.fechamentos ?? []).find((x) => x.entregador?.chave === chave);
  if (f) return f;
  // Antes do fechamento: entregador já identificado pelo Foody nesta unidade (mesma chave do fechamento futuro).
  const conhecido = typeof nucleo?.consultarEntregadoresProprios === "function" ? (await entregadoresConhecidos({ ctx, nucleo })).find((x) => x.chave === chave) : null;
  if (conhecido) return { entregador: { chave: conhecido.chave, nome: conhecido.nome }, semanaInicio: conhecido.ultimaAtividade, origem: conhecido.origem };
  throw recusa(404, "ENTREGADOR_NAO_ENCONTRADO", "Entregador não encontrado no Financeiro desta unidade (nem nos fechamentos, nem no Foody das semanas em aberto).");
}
function exigirNumeroForaDaEquipe(mova, tel) {
  const daEquipe = mova.cfg.gruposAutorizados.some((g) => !g.entregador && (g.participantes ?? []).some((p) => (p.telefones ?? []).includes(tel.telefoneE164)));
  if (daEquipe) throw recusa(409, "NUMERO_DA_EQUIPE", "Esse número já é de alguém da equipe financeira; não pode ser cadastrado como entregador.");
}
/** Aplica o cadastro na configuração viva do MOVA na hora (sem reinício). Sem configuração viva: vale no próximo reinício. */
async function vigenciaApos(mova) {
  if (typeof mova.cfg.recarregarEntregadores !== "function") return "APOS_REINICIO_DO_MOVA";
  try { const r = await mova.cfg.recarregarEntregadores({ forcar: true }); return r.motivo === "OUTRAS_MUDANCAS_EXIGEM_REINICIO" ? "APOS_REINICIO_DO_MOVA" : "IMEDIATA"; }
  catch { return "NO_PROXIMO_MINUTO"; } // a recarga periódica tenta de novo
}

const STATUS = { BAIXA_CONFERIDA_COM_EXTRATO: 409, EXTRATO_NAO_CONFERIDO: 409, OPERACAO_NAO_REVERSIVEL: 409, OPERACAO_NAO_ENCONTRADA: 404, POLITICA_NAO_ENCONTRADA: 404, POLITICA_INVALIDA: 400, JUSTIFICATIVA_OBRIGATORIA: 400, EXECUCAO_DESLIGADA: 404, PERMISSAO_INSUFICIENTE: 403, PROPOSTA_NAO_ENCONTRADA: 404, PROPOSTA_JA_DECIDIDA_OU_INEXISTENTE: 409, CATEGORIA_INVALIDA: 400, VERSAO_OBRIGATORIA: 400, CONTA_OBRIGATORIA: 400 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const escopo = (ctx) => ({ organizacaoId: ctx.organizacaoId, unidadeId: ctx.unidadeId });
const SHA = /^[0-9a-f]{64}$/;
const mascararJid = (j) => { const d = String(j ?? "").split("@")[0].replace(/\D/g, ""); return d ? `…${d.slice(-4)}` : "—"; };
/** Data de hoje em São Paulo (posição da Central). */
const hojeSp = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const MAX_PAGINAS = 20;
/** Todas as contas a pagar da unidade da SESSÃO, pelo serviço oficial e com as permissões da sessão (só leitura). */
async function contasDaSessao(nucleo, ctx) {
  if (typeof nucleo?.consultarContasAPagar !== "function") throw recusa(503, "FINANCEIRO_INDISPONIVEL", "Financeiro indisponível.");
  const itens = [];
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const r = await nucleo.consultarContasAPagar(ctx, { pagina, tamanho: 100 });
    itens.push(...(r.itens ?? []));
    if (!r.itens || r.itens.length < 100) break;
  }
  return itens;
}
/** Saídas do extrato sem vínculo (prévia oficial; só leitura). Erro de regra ⇒ null (extrato indisponível, dito na tela). */
async function saidasDaSessao(nucleo, ctx, todas) {
  const alguma = todas.find((t) => t.id);
  if (!alguma) return [];
  if (typeof nucleo?.previaDoVinculoDoExtrato !== "function") return null;
  try { const p = await nucleo.previaDoVinculoDoExtrato(ctx, { obrigacaoId: alguma.id }); return Array.isArray(p?.saidasElegiveis) ? p.saidasElegiveis : null; }
  catch (e) { if (e instanceof ErroFinanceiro) return null; throw e; }
}
/** Remetente para a revisão: identificador MASCARADO e o nome do cadastro do grupo (nunca o número inteiro). */
function remetente(mova, participanteId) {
  for (const g of mova.cfg.gruposAutorizados) for (const p of g.participantes ?? []) if (p.ids.includes(participanteId)) return { id: mascararJid(participanteId), nome: p.nome ?? null, perfil: p.perfil ?? null };
  return { id: mascararJid(participanteId), nome: null, perfil: null };
}
const documentoParaTela = (mova, d) => { const { participanteId, ...resto } = d; return { ...resto, remetente: remetente(mova, participanteId) }; };

const exigirConfigurar = (ctx) => { if (!ctx?.permissoes?.includes(ACAO.CONFIGURAR)) throw recusa(403, "PERMISSAO_INSUFICIENTE", "Alterar automações exige permissão de configuração."); };
function exigirVer(ctx) {
  if (!ctx?.permissoes?.includes(ACAO.VER)) throw recusa(403, "PERMISSAO_INSUFICIENTE", "Permissão financeira insuficiente.");
}
const traduzir = (e) => {
  if (e instanceof ErroDeAprovacao) return recusa(STATUS[e.codigo] ?? 409, e.codigo, "A proposta não pôde ser processada.");
  return e;
};

export const CONSULTAS_MOVA = Object.freeze({
  "/mova/conferencia": async ({ ctx, mova, nucleo, nomes }) => {
    exigirVer(ctx);
    const todas = await contasDaSessao(nucleo, ctx);
    const saidas = await saidasDaSessao(nucleo, ctx, todas);
    const unidade = nomes?.unidade ?? mova.cfg.unidades.find((u) => u.unidadeId === ctx.unidadeId)?.nome ?? null;
    const documentos = mova.armazenamento.documentosRecebidos ? await mova.armazenamento.documentosRecebidos.listar(escopo(ctx)) : [];
    return { ...montarConferencia({ todas, saidas, hoje: hojeSp(), empresa: nomes?.empresa ?? null, unidade, documentos }), geradoEm: new Date().toISOString(), recebimentoDocumental: Boolean(mova.recebimentoDocumental) };
  },
  "/mova/documentos-recebidos": async ({ ctx, mova }) => {
    exigirVer(ctx);
    const itens = mova.armazenamento.documentosRecebidos ? await mova.armazenamento.documentosRecebidos.listar(escopo(ctx)) : [];
    return { recebimentoDocumental: Boolean(mova.recebimentoDocumental), podeConferir: Boolean(ctx.permissoes?.includes(ACAO.DOCUMENTOS)), itens: itens.map((d) => documentoParaTela(mova, d)) };
  },
  "/mova/documento-relacionadas": async ({ ctx, mova, nucleo, params }) => {
    exigirVer(ctx);
    if (!SHA.test(params.sha ?? "")) throw recusa(400, "PARAMETRO_INVALIDO", "Documento inválido.");
    const d = mova.armazenamento.documentosRecebidos ? await mova.armazenamento.documentosRecebidos.obter({ ...escopo(ctx), sha256: params.sha }) : null;
    if (!d) throw recusa(404, "DOCUMENTO_NAO_ENCONTRADO", "Documento não encontrado nesta unidade.");
    const busca = typeof params.busca === "string" && params.busca.trim() ? params.busca.slice(0, 120) : d.legenda ?? "";
    return { busca, itens: contasRelacionadas(await contasDaSessao(nucleo, ctx), busca) };
  },
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
  "/mova/pagamentos-a-conciliar": async ({ ctx, nucleo }) => {
    exigirVer(ctx);
    if (typeof nucleo?.consultarPagamentosPorComprovanteAConciliar !== "function") return { disponivel: false, itens: [] };
    const r = await nucleo.consultarPagamentosPorComprovanteAConciliar(ctx);
    return { disponivel: true, podeConciliar: Boolean(ctx.permissoes?.includes(ACAO.VINCULAR_PAGAMENTO)), itens: r.itens };
  },
  "/mova/linha-do-tempo": async ({ ctx, mova, nucleo, params }) => {
    exigirVer(ctx);
    if (!UUID.test(params.proposta ?? "")) throw recusa(400, "PARAMETRO_INVALIDO", "Proposta inválida.");
    const p = await mova.armazenamento.propostas.obter(escopo(ctx), params.proposta.toLowerCase());
    if (!p) throw recusa(404, "PROPOSTA_NAO_ENCONTRADA", "Proposta não encontrada nesta unidade.");
    const ops = mova.armazenamento.operacoes ? (await mova.armazenamento.operacoes.listar(escopo(ctx))).filter((o) => o.propostaId === p.id) : [];
    const obrigacaoId = p.resultado?.obrigacaoId ?? p.comando?.entrada?.obrigacaoId ?? null;
    let titulo = null;
    if (obrigacaoId) { try { titulo = (await nucleo.detalharContaAPagar(ctx, { id: obrigacaoId })).titulo; } catch (e) { if (!(e instanceof ErroFinanceiro)) throw e; } }
    return { propostaId: p.id, etapas: linhaDoTempo({ proposta: p, operacao: ops.at(-1) ?? null, titulo }) };
  },
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
      // 23/11: unidade atendida pelo MOVA? (sem isso o cadastro de WhatsApp fica indisponível) e, por cadastro, se está APTO a
      // receber: ativo, já na configuração viva do MOVA e com conversa própria (número que é da equipe nunca recebe).
      unidadeAtendida: mova.cfg.unidades.some((u) => u.unidadeId === ctx.unidadeId && u.organizacaoId === ctx.organizacaoId),
      cadastros: a.entregadores ? (await a.entregadores.listar(escopo(ctx))).map((c) => {
        const vigente = c.ativo ? lista.find((e) => e.chave === c.chave && `…${e.telefoneE164.slice(-4)}` === c.telefone) : null;
        return { ...c, envio: !c.ativo ? "INATIVO" : !vigente ? "AGUARDANDO_ATUALIZACAO" : comConversa.has(vigente.privado) ? "APTO" : "NUMERO_DA_EQUIPE" };
      }) : [],
      notas: a.notasEntregador ? (await a.notasEntregador.listar(escopo(ctx))).map(({ leitura, ...n }) => n) : [],
      envios: a.enviosEntregador ? await a.enviosEntregador.listar(escopo(ctx)) : [],
    };
  },
  "/mova/entregadores-oficiais": async ({ ctx, nucleo }) => {
    exigirVer(ctx);
    return { itens: await entregadoresConhecidos({ ctx, nucleo }) };
  },
  // Agente 2 — Frente E: Central de Operações (contagens reais; IA = consumo registrado no orçamento).
  "/mova/visao-geral": async ({ ctx, mova, orcamento, controle, params }) => {
    exigirVer(ctx);
    if (!mova.consultas) throw recusa(404, "MOVA_SEM_CONSULTAS", "Visão geral indisponível.");
    const dias = /^[0-9]{1,2}$/.test(String(params?.dias ?? "")) ? Number(params.dias) : 7;
    return { ...(await mova.consultas.visaoGeral({ ...escopo(ctx), dias })), modo: mova.cfg.modo, autonomiaLigada: Boolean(mova.execucao), identidadeOperacional: Boolean(mova.execucao?.operacional),
      entregadoresLigado: Boolean(mova.entregadores), controle: controle ? await controle.estado() : null, orcamentoIa: orcamento ? await orcamento.resumo().catch(() => null) : null };
  },
  // Grupos e participantes da unidade: identificadores MASCARADOS; retrato dos membros com quem NÃO está autorizado.
  "/mova/grupos": async ({ ctx, mova }) => {
    exigirVer(ctx);
    const mascarar = (j) => { const d = String(j ?? "").split("@")[0].replace(/\D/g, ""); return d ? `…${d.slice(-4)}` : "—"; };
    const grupos = mova.cfg.gruposAutorizados.filter((g) => g.unidades.includes(ctx.unidadeId));
    const itens = [];
    for (const g of grupos) {
      const retrato = !g.privada && mova.armazenamento.membros ? await mova.armazenamento.membros.obter(g.grupoId) : null;
      const autorizados = new Set(g.participantes?.flatMap((p) => p.ids) ?? []);
      const fora = retrato ? retrato.membros.filter((m) => !autorizados.has(m)) : [];
      itens.push({ grupo: mascarar(g.grupoId), tipo: g.entregador ? "ENTREGADOR" : g.privada ? (g.derivada ? "PRIVADO_DERIVADO" : "PRIVADO") : "GRUPO", acesso: g.acesso ?? "ABERTO",
        politicaResposta: g.politicaResposta ?? (g.privada ? null : "PRIVADO_RESTRITO"), unidades: g.unidades.length,
        participantes: (g.participantes ?? []).map((p) => ({ id: mascarar(p.ids[0]), perfil: p.perfil ?? (p.perfilPorUnidade?.[ctx.unidadeId] ?? null), nome: p.nome ?? null, privado: Boolean(p.privado) })),
        membros: retrato ? { total: retrato.membros.length, verificadoEm: retrato.verificadoEm instanceof Date ? retrato.verificadoEm.toISOString() : retrato.verificadoEm, naoAutorizados: fora.map(mascarar) } : null });
    }
    return { itens };
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
    // Agente 2: toda abertura do original fica na trilha (quem, unidade, quando). Sem trilha, o arquivo não sai.
    await mova.armazenamento.auditoria.registrar({ acao: "DOCUMENTO_ORIGINAL_ABERTO", atorTipo: "USUARIO", alvo: params.sha, dados: { usuarioId: ctx.usuarioId ?? null, ...escopo(ctx) } });
    return { mime: d.mime, nomeArquivo: d.nomeArquivo, base64: Buffer.from(d.bytes).toString("base64") };
  },
});

export const ACOES_MOVA = Object.freeze({
  // Conferência humana de um documento recebido sem IA: trilha só de inclusão no banco do MOVA. Revisado ≠ pago ≠ conciliado.
  "/mova/documento-conferir": { campos: ["sha256", "versao", "estado", "tipo", "obrigacaoId", "observacao"], escreveNoFinanceiro: false,
    fazer: async ({ ctx, mova, nucleo, b }) => {
      if (!ctx?.permissoes?.includes(ACAO.DOCUMENTOS)) throw recusa(403, "PERMISSAO_INSUFICIENTE", "Conferir documentos exige permissão de documentos.");
      if (!SHA.test(b.sha256 ?? "") || !Number.isSafeInteger(b.versao) || b.versao < 0) throw recusa(400, "PARAMETRO_INVALIDO", "Documento ou versão inválidos.");
      if (![ESTADO_CONFERENCIA.REVISADO, ESTADO_CONFERENCIA.ENCAMINHADO].includes(b.estado)) throw recusa(400, "PARAMETRO_INVALIDO", "Situação inválida (revisado ou encaminhado).");
      if (b.tipo !== undefined && b.tipo !== null && !TIPOS_INFORMADOS.includes(b.tipo)) throw recusa(400, "PARAMETRO_INVALIDO", "Tipo de documento inválido.");
      if (b.observacao !== undefined && b.observacao !== null && (typeof b.observacao !== "string" || b.observacao.length > 500)) throw recusa(400, "PARAMETRO_INVALIDO", "Observação de até 500 caracteres.");
      let obrigacaoId = null;
      if (b.obrigacaoId !== undefined && b.obrigacaoId !== null) {
        if (!UUID.test(b.obrigacaoId)) throw recusa(400, "PARAMETRO_INVALIDO", "Conta inválida.");
        // A conta citada precisa ser DESTA unidade (lida com a sessão). É só uma anotação: nada é vinculado no Financeiro.
        if (!(await contasDaSessao(nucleo, ctx)).some((t) => t.id === b.obrigacaoId.toLowerCase())) throw recusa(404, "CONTA_NAO_ENCONTRADA", "Conta não encontrada nesta unidade.");
        obrigacaoId = b.obrigacaoId.toLowerCase();
      }
      let r;
      try {
        r = await mova.armazenamento.documentosRecebidos.conferir({ ...escopo(ctx), sha256: b.sha256, versao: b.versao, por: ctx.usuarioId,
          estado: b.estado, tipo: b.tipo ?? null, obrigacaoId, observacao: b.observacao?.trim() || null });
      } catch (e) { if (e?.codigo === "CONFLITO_VERSAO") throw recusa(409, "CONFLITO_VERSAO", "Outra pessoa conferiu este documento agora. Recarregue e confira de novo."); throw e; }
      if (!r) throw recusa(404, "DOCUMENTO_NAO_ENCONTRADO", "Documento não encontrado nesta unidade.");
      return documentoParaTela(mova, r);
    } },
  // 15A: competência informada na revisão humana (nunca presumida pelo MOVA); não escreve no Financeiro.
  "/mova/competencia": { campos: ["propostaId", "versao", "competencia"], escreveNoFinanceiro: false,
    fazer: ({ ctx, mova, b }) => mova.aprovador.revisarCompetencia(ctx, { propostaId: b.propostaId, versao: b.versao, competencia: b.competencia }) },
  "/mova/classificar": { campos: ["propostaId", "versao", "categoria"], escreveNoFinanceiro: false,
    fazer: ({ ctx, mova, b }) => mova.aprovador.revisarClassificacao(ctx, { propostaId: b.propostaId, versao: b.versao, categoria: b.categoria }) },
  // 26/11: `obrigacaoId` = a conta escolhida na revisão de uma operação entre empresas com várias candidatas. A aplicação de
  // INTERCOMPANY também exige o contexto VERIFICADO da outra empresa (mesma pessoa) — a sessão atual é de uma unidade só, então
  // por esta rota ela é recusada com CONTRAPARTE_SEM_SESSAO até o desenho da sessão nas duas unidades ser aprovado.
  "/mova/aplicar": { campos: ["propostaId", "contaId", "categoria", "obrigacaoId"], escreveNoFinanceiro: true,
    fazer: ({ ctx, mova, nucleo, b }) => mova.aprovador.aplicar(ctx, { propostaId: b.propostaId, contaId: b.contaId ?? null, categoria: b.categoria ?? null, obrigacaoId: b.obrigacaoId ?? null }, { nucleo }) },
  // Execução 17: a pessoa (vincular_pagamento) liga a saída do extrato ao pagamento JÁ registrado por comprovante. O núcleo
  // confere valor, data (tolerância), saída livre e idempotência; nada de segunda baixa, saída ou despesa.
  "/mova/conciliar-comprovante": { campos: ["liquidacaoId", "movimentacaoId", "versaoMovimentacao"], escreveNoFinanceiro: true,
    fazer: async ({ ctx, mova, nucleo, b }) => {
      if (!mova.pagamentoPorComprovante) throw recusa(403, "PAGAMENTO_POR_COMPROVANTE_DESLIGADO", "Pagamento por comprovante ainda não foi ativado.");
      return nucleo.conciliarPagamentoPorComprovante(ctx, { liquidacaoId: b.liquidacaoId, movimentacaoId: b.movimentacaoId, versaoMovimentacao: b.versaoMovimentacao,
      justificativa: "Conciliação conferida na Central de Operações MOVA (saída do extrato × pagamento por comprovante).", confirmar: true });
    } },
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
  // 23/11: CADASTRO DOS ENTREGADORES — fonte ÚNICA de contatos (mova.entregador_autorizado), usada pelo Financeiro (Entregadores
  // Próprios → Cadastro) e pelo MOVA. O gestor escolhe o entregador OFICIAL (chave dos fechamentos desta unidade) e informa o
  // WhatsApp; sem aceite (mensagem administrativa). Conferências: unidade atendida pelo MOVA; chave no Financeiro da unidade da
  // sessão; número brasileiro válido, não é da equipe e não está com outro entregador ativo. Nada é apagado: trocar/editar/
  // desativar encerra a linha vigente (quem, quando, por quê). Passa a valer NA HORA (configuração viva); antes do 1º envio o
  // Gateway ainda confere o número no próprio WhatsApp. O número completo só entra: toda saída é mascarada (…1234).
  "/mova/entregador": { campos: ["entregador", "telefone", "nome", "observacoes"], escreveNoFinanceiro: false,
    fazer: async ({ ctx, mova, nucleo, b }) => {
      exigirCadastroDeEntregador(ctx, mova);
      const chave = chaveDoEntregador(b);
      const tel = normalizarTelefoneBr(b.telefone);
      if (!tel) throw recusa(400, "PARAMETRO_INVALIDO", "Informe um número WhatsApp brasileiro válido (DDD + número).");
      const f = await entregadorOficial({ ctx, nucleo, chave });
      exigirNumeroForaDaEquipe(mova, tel);
      const nome = textoCurto(b.nome, 60) ?? (f.entregador.nome ?? "").slice(0, 60) ?? null;
      const r = await mova.armazenamento.entregadores.cadastrar({ ...escopo(ctx), chave, telefoneE164: tel.telefoneE164, privado: tel.privado, nome: nome || null, observacoes: textoCurto(b.observacoes, 500), cadastradoPor: ctx.usuarioId });
      if (r.conflito) throw recusa(409, "ENTREGADOR_OU_NUMERO_JA_CADASTRADO", "Esse entregador ou esse número já está cadastrado (ativo) nesta unidade. Para trocar, edite o cadastro.");
      await mova.armazenamento.auditoria.registrar({ acao: "ENTREGADOR_CADASTRADO", atorTipo: "USUARIO", atorRef: ctx.usuarioId, alvo: chave, dados: { unidadeId: ctx.unidadeId, telefone: `…${tel.telefoneE164.slice(-4)}` } });
      return { entregador: chave, nome, telefone: `…${tel.telefoneE164.slice(-4)}`, vigencia: await vigenciaApos(mova) };
    } },
  "/mova/entregador-alterar": { campos: ["entregador", "telefone", "nome", "observacoes"], escreveNoFinanceiro: false,
    fazer: async ({ ctx, mova, b }) => {
      exigirCadastroDeEntregador(ctx, mova);
      const chave = chaveDoEntregador(b);
      const mudancas = {};
      if (b.telefone !== undefined && b.telefone !== "") {
        const tel = normalizarTelefoneBr(b.telefone);
        if (!tel) throw recusa(400, "PARAMETRO_INVALIDO", "Informe um número WhatsApp brasileiro válido (DDD + número).");
        exigirNumeroForaDaEquipe(mova, tel);
        Object.assign(mudancas, { telefoneE164: tel.telefoneE164, privado: tel.privado });
      }
      if (b.nome !== undefined) mudancas.nome = textoCurto(b.nome, 60);
      if (b.observacoes !== undefined) mudancas.observacoes = textoCurto(b.observacoes, 500);
      if (!Object.keys(mudancas).length) throw recusa(400, "PARAMETRO_INVALIDO", "Nada para alterar.");
      const r = await mova.armazenamento.entregadores.alterar({ ...escopo(ctx), chave, por: ctx.usuarioId, mudancas });
      if (r.naoEncontrado) throw recusa(404, "ENTREGADOR_NAO_CADASTRADO", "Entregador sem cadastro ativo nesta unidade.");
      if (r.conflito) throw recusa(409, "NUMERO_JA_CADASTRADO", "Esse número já está com outro entregador ativo nesta unidade.");
      if (r.semMudanca) return { entregador: chave, alterado: false };
      await mova.armazenamento.auditoria.registrar({ acao: r.motivo === "TROCA_DE_NUMERO" ? "ENTREGADOR_NUMERO_TROCADO" : "ENTREGADOR_EDITADO", atorTipo: "USUARIO", atorRef: ctx.usuarioId, alvo: chave,
        dados: { unidadeId: ctx.unidadeId, anterior: r.anterior, atual: r.atual, campos: Object.keys(mudancas).filter((k) => k !== "privado") } });
      return { entregador: chave, alterado: true, motivo: r.motivo, telefone: r.atual, vigencia: await vigenciaApos(mova) };
    } },
  "/mova/entregador-revogar": { campos: ["entregador"], escreveNoFinanceiro: false,
    fazer: async ({ ctx, mova, b }) => {
      exigirCadastroDeEntregador(ctx, mova);
      const chave = chaveDoEntregador(b);
      const n = await mova.armazenamento.entregadores.revogar({ ...escopo(ctx), chave, por: ctx.usuarioId, motivo: "DESATIVADO" });
      if (!n) throw recusa(404, "ENTREGADOR_NAO_CADASTRADO", "Entregador não cadastrado (ativo) nesta unidade.");
      await mova.armazenamento.auditoria.registrar({ acao: "ENTREGADOR_REVOGADO", atorTipo: "USUARIO", atorRef: ctx.usuarioId, alvo: chave, dados: { unidadeId: ctx.unidadeId } });
      return { entregador: chave, revogado: true, vigencia: await vigenciaApos(mova) };
    } },
  "/mova/entregador-reativar": { campos: ["entregador"], escreveNoFinanceiro: false,
    fazer: async ({ ctx, mova, nucleo, b }) => {
      exigirCadastroDeEntregador(ctx, mova);
      const chave = chaveDoEntregador(b);
      await entregadorOficial({ ctx, nucleo, chave }); // continua sendo entregador desta unidade?
      const r = await mova.armazenamento.entregadores.reativar({ ...escopo(ctx), chave, por: ctx.usuarioId });
      if (r.naoEncontrado) throw recusa(404, "ENTREGADOR_NAO_CADASTRADO", "Este entregador nunca foi cadastrado nesta unidade.");
      if (r.conflito) throw recusa(409, "ENTREGADOR_OU_NUMERO_JA_CADASTRADO", "O entregador já está ativo, ou o número dele agora é de outro entregador ativo.");
      await mova.armazenamento.auditoria.registrar({ acao: "ENTREGADOR_REATIVADO", atorTipo: "USUARIO", atorRef: ctx.usuarioId, alvo: chave, dados: { unidadeId: ctx.unidadeId, telefone: r.telefone } });
      return { entregador: chave, reativado: true, telefone: r.telefone, vigencia: await vigenciaApos(mova) };
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
