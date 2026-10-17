// Períodos financeiros (B8): abrir, pré-fechar, fechar (snapshot), reabrir (desabilitada) e exceção de fechamento (desabilitada). Autorização por ação (fechar/reabrir/configurar) vem
// do gate do Agente 1 nas rotas — aqui não há permissões próprias. A decisão final e a proteção de mês fechado são do banco (trava + impressão).
import * as repositorio from "./repositorio.js";
import { exigirContexto } from "./contexto.js";
import { texto, mesAno, inteiro, bad } from "./validacao.js";
import { ApiError } from "../../../shared/ApiError.js";
import { MENSAGENS } from "./repositorio.util.js";
import { apurar, saldosPorConta } from "../../../financeiro-calculos/motor.js";
import { paraEntradaMotor, aberturasComoLancamentos, montarDre } from "../../../financeiro-calculos/relatorios.js";
import { montarSnapshot, avaliarFechamento, primeiroDia, ultimoDia } from "../../../financeiro-calculos/periodos.js";
import { carregarBase, aposAbertura } from "./relatorios.service.js";
import { calcularMes } from "./conciliacao.service.js";

const padrao = { repo: repositorio, db: undefined, agora: () => new Date().toISOString() };

const resumoPeriodo = (p) => ({
  id: p.id, mes: String(p.mes).slice(0, 7), status: p.status, versao: p.versao, fechadoEm: p.fechado_em ?? null, fechadoPor: p.fechado_por ?? null,
  reabertoEm: p.reaberto_em ?? null, reabertoPor: p.reaberto_por ?? null, motivoReabertura: p.motivo_reabertura ?? null,
  snapshot: p.snapshot ? { resultadoGerencial: p.snapshot.indicadores?.resultadoGerencial, receitaOperacional: p.snapshot.indicadores?.receitaOperacional, variacaoCaixa: p.snapshot.indicadores?.variacaoCaixa, pendenciasNoFechamento: p.snapshot.pendenciasNoFechamento, geradoEm: p.snapshot.geradoEm } : null,
});

export async function listar(ctx, deps = padrao) {
  const c = exigirContexto(ctx);
  const [ps, ex] = await Promise.all([deps.repo.listarPeriodos(c, deps.db), deps.repo.listarExcecoesFechamento(c, {}, deps.db)]);
  return { periodos: ps.map(resumoPeriodo), excecoes: ex.map(resumoExcecao), excecaoFechamentoHabilitada: deps.excecaoFechamentoHabilitada === true };
}
/** Exceção para exibição: o gestor vê por que existe (justificativa) e QUAIS pendências cobre (ids e motivos, sem valores). */
export const resumoExcecao = (e) => ({
  id: e.id, mes: String(e.mes).slice(0, 7), status: e.status, quantidade: e.quantidade, pendenciasConciliacao: e.pendencias_conciliacao ?? 0,
  justificativa: e.justificativa, aprovadaPor: e.aprovada_por, aprovadaEm: e.aprovada_em, expiraEm: e.expira_em,
  consumidaEm: e.consumida_em ?? null, revogadaEm: e.revogada_em ?? null, motivoRevogacao: e.motivo_revogacao ?? null,
  pendencias: (e.pendencias ?? []).map((p) => ({ id: p.id, motivos: p.motivos ?? [] })),
});

export async function abrir(ctx, b, deps = padrao) {
  const c = exigirContexto(ctx);
  return resumoPeriodo(await deps.repo.abrirPeriodoRpc(c, mesAno(b?.mes), deps.db));
}

/** Lê o mês e monta tudo o que o fechamento usaria. A impressão é obtida ANTES da leitura (qualquer escrita depois será detectada). */
async function prepararMes(c, mes, deps) {
  // SOMENTE LEITURA: não cria linha de período (o banco cria sob trava ao fechar; mês sem linha = aberto, versão 1).
  const periodo = (await deps.repo.obterPeriodo(c, mes, deps.db)) ?? { id: null, mes: `${mes}-01`, status: "aberto", versao: 1, snapshot: null };
  const fingerprint = await deps.repo.fingerprintPeriodoRpc(c, mes, deps.db);
  const p = { de: primeiroDia(mes), ate: ultimoDia(mes) };
  const base = await carregarBase(c, p, deps);
  const mov = paraEntradaMotor(base.lancs, base.categoriasPorId);
  const comAb = [...mov, ...aberturasComoLancamentos(base.aberturas, p.de, p.ate)];
  const apuracao = apurar(comAb);
  const dre = montarDre(comAb, base.categoriasPorId);
  const saldos = saldosPorConta(base.contas.filter((x) => x.ativo), new Map(base.aberturas.map((a) => [a.conta_id, Number(a.valor_centavos)])), aposAbertura(mov, base.aberturas));
  const conc = await calcularMes(c, mes, deps);
  const pendentes = base.lancs.filter((l) => l.status !== "cancelado" && (l.classificacao_pendente || !l.categoria_id));
  const pendLanc = pendentes.length;
  const agora = Date.parse((deps.agora ?? padrao.agora)());
  const ativa = (await deps.repo.listarExcecoesFechamento(c, { mes, apenasAtivas: true }, deps.db)).find((e) => Date.parse(e.expira_em) > agora) ?? null;
  const excecao = ativa ? { id: ativa.id, expiraEm: ativa.expira_em, pendenciasIds: (ativa.pendencias ?? []).map((p) => p.id), pendenciasConciliacao: ativa.pendencias_conciliacao ?? 0 } : null;
  const avaliacao = avaliarFechamento({ status: periodo.status, pendenciasLancamentos: pendLanc, pendenciasLancamentosIds: pendentes.map((l) => l.id), pendenciasConciliacao: conc.resultado.resumo.pendenciasAbertas, excecao });
  const pendencias = { lancamentos: pendLanc, conciliacao: conc.resultado.resumo.pendenciasAbertas, total: pendLanc + conc.resultado.resumo.pendenciasAbertas };
  return { periodo, fingerprint, apuracao, dre, saldos, conciliacao: conc.resultado, pendencias, excecao: ativa ? resumoExcecao(ativa) : null, avaliacao, vazio: base.lancs.length === 0 };
}

export async function preFechamento(ctx, mes, deps = padrao) {
  const c = exigirContexto(ctx);
  const m = mesAno(mes);
  const x = await prepararMes(c, m, deps);
  return {
    mes: m, periodo: resumoPeriodo(x.periodo), fingerprint: x.fingerprint, vazio: x.vazio, excecao: x.excecao, avaliacao: x.avaliacao, pendencias: x.pendencias,
    resumo: { indicadores: { receitaOperacional: x.apuracao.receitaOperacional, resultadoGerencial: x.apuracao.resultadoGerencial, margemLiquidaBps: x.apuracao.margemLiquidaBps, variacaoCaixa: x.apuracao.variacaoCaixa, saldoFinal: x.apuracao.saldoFinal, parcial: x.apuracao.parcial },
      saldoFinalParcial: x.saldos.parcial, conciliacao: x.conciliacao.resumo },
  };
}

/**
 * Fecha o mês. Exige `fingerprint` e `versao` da pré-visualização que a pessoa revisou. Recusa: confirmação ausente, conteúdo alterado desde então
 * (409), período já fechado, pendências sem exceção que cubra todas elas (ou sem reconhecimento explícito). Tudo ou nada no banco.
 */
export async function fechar(ctx, mes, b, deps = padrao) {
  const c = exigirContexto(ctx);
  const m = mesAno(mes);
  if (b?.confirmo !== true) throw bad("Confirmação explícita do fechamento ausente.", "CONFIRMACAO_AUSENTE");
  const versao = inteiro(b?.versao, "versao", { min: 1 });
  if (typeof b?.fingerprint !== "string" || !b.fingerprint) throw bad("A impressão da pré-visualização é obrigatória (recarregue o pré-fechamento).", "FINGERPRINT_AUSENTE");
  const x = await prepararMes(c, m, deps);
  if (x.periodo.status === "fechado") throw bad("O período já está fechado.", "FIN_PERIODO_JA_FECHADO");
  if (x.periodo.versao !== versao) throw new ApiError(409, MENSAGENS.FIN_PERIODO_CONFLITO_VERSAO, { codigo: "FIN_PERIODO_CONFLITO_VERSAO" });
  if (x.fingerprint !== b.fingerprint) throw new ApiError(409, MENSAGENS.FIN_PERIODO_CONFLITO_DADOS, { codigo: "FIN_PERIODO_CONFLITO_DADOS" });
  const snapshot = montarSnapshot({ mes: m, apuracao: x.apuracao, dre: x.dre, saldos: x.saldos, conciliacao: x.conciliacao, pendencias: x.pendencias, geradoEm: (deps.agora ?? padrao.agora)() });
  const r = await deps.repo.fecharPeriodoRpc(c, { mes: m, versao, fingerprint: x.fingerprint, snapshot, pendenciasConciliacao: x.pendencias.conciliacao, reconhecoPendencias: b?.reconhecoPendencias === true }, deps.db);
  return resumoPeriodo(r);
}

export async function reabrir(ctx, mes, b, deps = padrao) {
  const c = exigirContexto(ctx);
  // FAIL-CLOSED: a política de autorização da reabertura ainda não foi aprovada. Mesmo que um nível passe a conceder `reabrir`, o serviço
  // continua recusando até alguém habilitar explicitamente (deps.reaberturaHabilitada === true).
  if (deps.reaberturaHabilitada !== true) throw ApiError.forbidden("A reabertura de período ainda não foi habilitada. Aguarde a aprovação da política de autorização.", { codigo: "REABERTURA_NAO_HABILITADA" });
  const motivo = texto(b?.motivo, "motivo", { max: 1000 });
  if (motivo.length < 10) throw bad("Informe o motivo da reabertura (mínimo 10 caracteres).", "MOTIVO_OBRIGATORIO");
  return resumoPeriodo(await deps.repo.reabrirPeriodoRpc(c, { mes: mesAno(mes), versao: inteiro(b?.versao, "versao", { min: 1 }), motivo }, deps.db));
}

export const JANELA_MFA_MS = 10 * 60 * 1000;      // decisão do usuário (LD-009): MFA recente = 10 minutos
const TOLERANCIA_FUTURO_MS = 60 * 1000;
const CHAVES_MFA = new Set(["aal", "em", "metodo", "sessao_ref"]);
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
/**
 * Evidência de MFA fornecida pela plataforma (Agente 1). Lista FECHADA de chaves: aal (= "aal2"), em (ISO-8601 UTC do 2º fator efetivo), metodo
 * (totp|webauthn|phone, opcional), sessao_ref (sha256 hex do session_id, opcional). NUNCA JWT/segredo/session_id cru. O banco revalida tudo.
 */
export function validarEvidenciaMfa(m, agora = Date.now()) {
  const falhar = () => bad("A exceção exige verificação MFA (AAL2) recente, com a evidência no formato permitido.", "MFA_OBRIGATORIO");
  if (!m || typeof m !== "object" || Array.isArray(m)) throw falhar();
  if (Object.keys(m).some((k) => !CHAVES_MFA.has(k)) || m.aal !== "aal2" || typeof m.em !== "string" || !ISO_UTC.test(m.em)) throw falhar();
  if ("metodo" in m && !["totp", "webauthn", "phone"].includes(m.metodo)) throw falhar();
  if ("sessao_ref" in m && !(typeof m.sessao_ref === "string" && /^[0-9a-f]{64}$/.test(m.sessao_ref))) throw falhar();
  const idade = agora - Date.parse(m.em);
  if (!(idade <= JANELA_MFA_MS && idade >= -TOLERANCIA_FUTURO_MS)) throw falhar();
  return { ...m };
}

/**
 * Compatibilidade de contrato (pedido do Agente 1): NÃO existe política geral. `GET` devolve sempre "bloqueado"; `PUT` NUNCA liga
 * (403 `POLITICA_EXCEPCIONAL_DESABILITADA`); "desligar" é no-op idempotente. Nada é gravado.
 */
export async function obterPolitica(ctx) {
  exigirContexto(ctx);
  return { modo: "excecao_por_competencia", permiteFecharComPendencias: false, excecaoFechamentoHabilitada: false };
}
export async function definirPolitica(ctx, b) {
  exigirContexto(ctx);
  if (b?.permiteFecharComPendencias === false) return obterPolitica(ctx);
  throw ApiError.forbidden("O gestor não pode permitir o fechamento com pendências. A única via é uma exceção por unidade e competência, aprovada por SuperAdmin, indisponível até a validação do MFA.", { codigo: "POLITICA_EXCEPCIONAL_DESABILITADA" });
}

/**
 * Concessão da exceção de fechamento (LD-007). FAIL-CLOSED: desabilitada por padrão e SEM rota — depende da validação do MFA e da ligação do
 * SuperAdmin pela fundação de segurança (Agente 1). Mesmo habilitada aqui, o banco só deixa executar quem tiver EXECUTE na função DEFINER
 * (o service_role não tem). Não altera, apaga nem reclassifica nenhuma pendência.
 */
export async function concederExcecaoFechamento(ctx, mes, b, deps = padrao) {
  const c = exigirContexto(ctx);
  if (deps.excecaoFechamentoHabilitada !== true) throw ApiError.forbidden("A exceção de fechamento ainda não foi habilitada. Aguarde a validação do MFA e a aprovação da política.", { codigo: "EXCECAO_FECHAMENTO_NAO_HABILITADA" });
  const justificativa = texto(b?.justificativa, "justificativa", { max: 2000 });
  if (justificativa.length < 20) throw bad("Informe a justificativa da exceção (mínimo 20 caracteres).", "JUSTIFICATIVA_OBRIGATORIA");
  const validadeDias = inteiro(b?.validadeDias, "validadeDias", { min: 1, max: 30 });
  const mfaEvidencia = validarEvidenciaMfa(b?.mfaEvidencia);
  const x = await prepararMes(c, mesAno(mes), deps);
  return resumoExcecao(await deps.repo.concederExcecaoFechamentoRpc(c, { mes: mesAno(mes), justificativa, validadeDias, pendenciasConciliacao: x.pendencias.conciliacao, mfaEvidencia }, deps.db));
}
