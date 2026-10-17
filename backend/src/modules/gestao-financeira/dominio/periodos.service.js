// Períodos financeiros (B8): abrir, pré-fechar, fechar (snapshot), reabrir e política. Autorização por ação (fechar/reabrir/configurar) vem
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
  const [ps, cfg] = await Promise.all([deps.repo.listarPeriodos(c, deps.db), deps.repo.obterConfig(c, deps.db)]);
  return { periodos: ps.map(resumoPeriodo), politica: politicaDe(cfg) };
}
const politicaDe = (cfg) => ({ permiteFecharComPendencias: cfg?.permite_fechar_com_pendencias === true, aprovadoEm: cfg?.aprovado_em ?? null, aprovadoPor: cfg?.aprovado_por ?? null, notaAprovacao: cfg?.nota_aprovacao ?? null });

export async function abrir(ctx, b, deps = padrao) {
  const c = exigirContexto(ctx);
  return resumoPeriodo(await deps.repo.abrirPeriodoRpc(c, mesAno(b?.mes), deps.db));
}

/** Lê o mês e monta tudo o que o fechamento usaria. A impressão é obtida ANTES da leitura (qualquer escrita depois será detectada). */
async function prepararMes(c, mes, deps) {
  const periodo = await deps.repo.abrirPeriodoRpc(c, mes, deps.db);               // garante a linha (idempotente) e traz status/versão
  const fingerprint = await deps.repo.fingerprintPeriodoRpc(c, mes, deps.db);
  const p = { de: primeiroDia(mes), ate: ultimoDia(mes) };
  const base = await carregarBase(c, p, deps);
  const mov = paraEntradaMotor(base.lancs, base.categoriasPorId);
  const comAb = [...mov, ...aberturasComoLancamentos(base.aberturas, p.de, p.ate)];
  const apuracao = apurar(comAb);
  const dre = montarDre(comAb, base.categoriasPorId);
  const saldos = saldosPorConta(base.contas.filter((x) => x.ativo), new Map(base.aberturas.map((a) => [a.conta_id, Number(a.valor_centavos)])), aposAbertura(mov, base.aberturas));
  const conc = await calcularMes(c, mes, deps);
  const pendLanc = base.lancs.filter((l) => l.status !== "cancelado" && (l.classificacao_pendente || !l.categoria_id)).length;
  const cfg = await deps.repo.obterConfig(c, deps.db);
  const politica = politicaDe(cfg);
  const avaliacao = avaliarFechamento({ status: periodo.status, pendenciasLancamentos: pendLanc, pendenciasConciliacao: conc.resultado.resumo.pendenciasAbertas, politicaPermitePendencias: politica.permiteFecharComPendencias });
  const pendencias = { lancamentos: pendLanc, conciliacao: conc.resultado.resumo.pendenciasAbertas, total: pendLanc + conc.resultado.resumo.pendenciasAbertas };
  return { periodo, fingerprint, apuracao, dre, saldos, conciliacao: conc.resultado, pendencias, politica, avaliacao, vazio: base.lancs.length === 0 };
}

export async function preFechamento(ctx, mes, deps = padrao) {
  const c = exigirContexto(ctx);
  const m = mesAno(mes);
  const x = await prepararMes(c, m, deps);
  return {
    mes: m, periodo: resumoPeriodo(x.periodo), fingerprint: x.fingerprint, vazio: x.vazio, politica: x.politica, avaliacao: x.avaliacao, pendencias: x.pendencias,
    resumo: { indicadores: { receitaOperacional: x.apuracao.receitaOperacional, resultadoGerencial: x.apuracao.resultadoGerencial, margemLiquidaBps: x.apuracao.margemLiquidaBps, variacaoCaixa: x.apuracao.variacaoCaixa, saldoFinal: x.apuracao.saldoFinal, parcial: x.apuracao.parcial },
      saldoFinalParcial: x.saldos.parcial, conciliacao: x.conciliacao.resumo },
  };
}

/**
 * Fecha o mês. Exige `fingerprint` e `versao` da pré-visualização que a pessoa revisou. Recusa: confirmação ausente, conteúdo alterado desde então
 * (409), período já fechado, pendências sem política aprovada ou sem reconhecimento explícito. Tudo ou nada no banco.
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

/**
 * Política "permitir fechar com pendências". Padrão: NÃO. Ligar exige aprovação explícita (nota ≥ 10 caracteres + quem aprovou/quando).
 * Desligar é sempre permitido. O banco também recusa ligar sem aprovação registrada.
 */
export async function definirPolitica(ctx, b, deps = padrao) {
  const c = exigirContexto(ctx);
  if (typeof b?.permiteFecharComPendencias !== "boolean") throw bad("permiteFecharComPendencias deve ser verdadeiro ou falso.", "ENTRADA_INVALIDA");
  if (!b.permiteFecharComPendencias) return politicaDe(await deps.repo.gravarConfig(c, { permite_fechar_com_pendencias: false, aprovado_por: null, aprovado_em: null, nota_aprovacao: null }, deps.db));
  const nota = texto(b?.notaAprovacao, "notaAprovacao", { max: 1000 });
  if (nota.length < 10) throw bad("A aprovação exige uma nota explícita (mínimo 10 caracteres).", "APROVACAO_SEM_NOTA");
  if (b?.confirmoAprovacao !== true) throw bad("Confirmação explícita da aprovação ausente.", "CONFIRMACAO_AUSENTE");
  return politicaDe(await deps.repo.gravarConfig(c, { permite_fechar_com_pendencias: true, aprovado_por: c.usuarioId, aprovado_em: (deps.agora ?? padrao.agora)(), nota_aprovacao: nota }, deps.db));
}
export async function obterPolitica(ctx, deps = padrao) { return politicaDe(await deps.repo.obterConfig(exigirContexto(ctx), deps.db)); }
