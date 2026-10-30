// Ativação M3 (D-16) — Painel Administrativo. A RPC é atômica, idempotente e verifica a equivalência do D-1 ANTES do commit.
//
// TRAVADA por padrão: só funciona com NOTIFICACOES_M3_ATIVACAO_HABILITADA=true (env que só é criada com autorização específica)
// e com a frase de confirmação. O universo é montado pela MESMA função do monitor D-1 (listarUnidadesElegiveis com o módulo do
// monitor dashboard_ifood) — sem critério paralelo; o banco ainda confere cada unidade.
import { ApiError } from "../../shared/ApiError.js";
import { auditar, ACOES } from "../../shared/auditoria.js";
import * as v from "../../shared/validar.js";
import { listarUnidadesElegiveis } from "../administrativo/administrativo.repo.js";
import { MONITORES } from "../administrativo/administrativo.monitores.js";
import * as repo from "./notificacoes.repository.js";

export const FRASE_CONFIRMACAO = "ATIVAR SELECAO POR UNIDADE";

const travada = (env) => env.NOTIFICACOES_M3_ATIVACAO_HABILITADA !== "true";

export async function estado({ env = process.env, deps = {} } = {}) {
  const s = await (deps.repo ?? repo).estadoSelecao(deps);
  return { ligada: s?.ligada === true, migracaoId: s?.migracao_id ?? null, ativadaEm: s?.ativada_em ?? null, desligadaEm: s?.desligada_em ?? null,
    ativacaoPermitidaNesteAmbiente: !travada(env) };
}

export async function ativar({ req, corpo, env = process.env, deps = {} }) {
  if (travada(env)) throw ApiError.forbidden("Ativação M3 bloqueada neste ambiente: exige autorização específica.");
  if (corpo?.confirmacao !== FRASE_CONFIRMACAO) throw ApiError.badRequest(`Digite exatamente: ${FRASE_CONFIRMACAO}`);
  const migracaoId = v.uuid(corpo?.migracaoId, "Identificador da migração");
  const elegiveis = await (deps.listarUnidadesElegiveis ?? listarUnidadesElegiveis)({ moduloId: MONITORES.dashboard_ifood.modulo }, deps);
  const universo = elegiveis.map((u) => ({ unidade_id: u.unidadeId, organizacao_id: u.organizacaoId }));
  const r = await (deps.repo ?? repo).ativarSelecao({ migracaoId, universo, moduloId: MONITORES.dashboard_ifood.modulo, ator: req?.perfil?.id ?? null }, deps);
  await (deps.auditar ?? auditar)({ acao: ACOES.NOTIFICACAO_SELECAO_ATIVADA, atorTipo: "usuario", atorId: req?.user?.id ?? null, perfilId: req?.perfil?.id ?? null,
    entidade: "notificacoes", entidadeId: migracaoId, detalhes: { resultado: r?.resultado, snapshot: r?.snapshot, escopos: r?.escopos, unidades: r?.unidades, hash_snapshot: r?.hash_snapshot } });
  return r;
}

export async function desativar({ req, corpo, env = process.env, deps = {} }) {
  if (travada(env)) throw ApiError.forbidden("Operação M3 bloqueada neste ambiente: exige autorização específica.");
  if (corpo?.confirmacao !== "DESATIVAR SELECAO POR UNIDADE") throw ApiError.badRequest("Digite exatamente: DESATIVAR SELECAO POR UNIDADE");
  const r = await (deps.repo ?? repo).desativarSelecao({ ator: req?.perfil?.id ?? null }, deps);
  await (deps.auditar ?? auditar)({ acao: ACOES.NOTIFICACAO_SELECAO_DESATIVADA, atorTipo: "usuario", atorId: req?.user?.id ?? null, entidade: "notificacoes", detalhes: { resultado: r?.resultado } });
  return r;
}
