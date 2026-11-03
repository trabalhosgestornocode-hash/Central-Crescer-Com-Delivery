// Agendador da camada central Foody — PILOTO EM SOMBRA.
//
// NÃO É LIGADO NO server.js (há teste de arquitetura). Só roda quando alguém chama criarAgendadorFoody(...).iniciar() e, mesmo
// assim, exige FOODY_CENTRAL_ENABLED=true, FOODY_CENTRAL_AGENDADOR_ENABLED=true e allowlist FOODY_CENTRAL_UNIDADES não vazia.
// Sem isso, iniciar() recusa (fail-closed).
//
// Cada ciclo: para cada unidade da allowlist, sincroniza e fecha D-1, D-2 e D-3 (reprocessamento das janelas recentes; dias
// mais antigos ficam congelados). Idempotente: conteúdo igual não cria versão. Erro de uma unidade/dia nunca impede os outros.
// NUNCA envia mensagem (nem simulada) e não alimenta nenhum indicador real.
import { agendamentoPermitido, lerFlagsFoody } from "./foody.flags.js";
import { competenciasParaSincronizar } from "./foody.periodo.js";
import { sincronizarEFechar } from "./foody.fechamento.service.js";
import { ORIGEM } from "./foody.constants.js";

export const INTERVALO_PADRAO_MS = 6 * 60 * 60_000; // 4x por dia: suficiente para D-1..D-3

/** @returns {Promise<Array<{unidadeId, competencia, resultado?, status?, versao?, erro?}>>} */
export async function executarCicloFoody({ unidades, env = process.env, agora = () => new Date(), executar = sincronizarEFechar, deps = {} }) {
  const allow = lerFlagsFoody(env).unidades;
  const out = [];
  for (const u of unidades ?? []) {
    if (!allow.has(String(u?.unidadeId ?? "").toLowerCase())) { out.push({ unidadeId: u?.unidadeId ?? null, erro: "FORA_DA_ALLOWLIST" }); continue; }
    for (const competencia of competenciasParaSincronizar(agora())) {
      try {
        const r = await executar({ organizacaoId: u.organizacaoId, unidadeId: u.unidadeId, competencia, origem: ORIGEM.AGENDADO, geradoPor: "agendador" }, { ...deps, env, agora });
        out.push({ unidadeId: u.unidadeId, competencia, resultado: r.fechamento?.resultado, status: r.fechamento?.status, versao: r.fechamento?.versao });
      } catch (e) {
        out.push({ unidadeId: u.unidadeId, competencia, erro: String(e?.codigo ?? "ERRO_INTERNO") });
        // Sem autenticação não adianta tentar os outros dias desta unidade.
        if (e?.codigo === "AUTENTICACAO" || e?.codigo === "SEM_CONEXAO" || e?.codigo === "CONEXAO_INATIVA" || e?.codigo === "TOKEN_INVALIDO" || e?.codigo === "TOKEN_DIVERGENTE") break;
      }
    }
  }
  return out;
}

/**
 * @param {{unidades: () => Promise<Array<{organizacaoId, unidadeId}>>|Array, intervaloMs?, env?, agora?, executar?, deps?,
 *          aoTerminarCiclo?, temporizador?: {set, clear}}} p
 */
export function criarAgendadorFoody({ unidades, intervaloMs = INTERVALO_PADRAO_MS, env = process.env, agora = () => new Date(), executar, deps,
  aoTerminarCiclo = () => {}, temporizador = { set: setTimeout, clear: clearTimeout } }) {
  let ativo = false, pendente = null, rodando = false;
  async function tique() {
    if (!ativo || rodando) return;
    rodando = true;
    try {
      if (!agendamentoPermitido(env)) { ativo = false; return; } // flag desligada em execução: para sozinho
      const lista = typeof unidades === "function" ? await unidades() : unidades;
      aoTerminarCiclo(await executarCicloFoody({ unidades: lista, env, agora, executar, deps }));
    } finally {
      rodando = false;
      if (ativo) pendente = temporizador.set(tique, intervaloMs);
    }
  }
  return {
    iniciar() {
      if (!agendamentoPermitido(env)) {
        const e = new Error("Agendamento Foody recusado: exige FOODY_CENTRAL_ENABLED=true, FOODY_CENTRAL_AGENDADOR_ENABLED=true e FOODY_CENTRAL_UNIDADES.");
        e.codigo = "AGENDAMENTO_NAO_PERMITIDO";
        throw e;
      }
      if (ativo) return;
      ativo = true;
      pendente = temporizador.set(tique, 0);
    },
    parar() { ativo = false; if (pendente) temporizador.clear(pendente); pendente = null; },
    get ativo() { return ativo; },
    tique,
  };
}
