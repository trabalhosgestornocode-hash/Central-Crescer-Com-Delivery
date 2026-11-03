// Agendador da camada central Foody — PILOTO EM SOMBRA.
//
// NÃO É LIGADO NO server.js (há teste de arquitetura). Só roda quando alguém chama criarAgendadorFoody(...).iniciar() e, mesmo
// assim, exige FOODY_CENTRAL_ENABLED=true, FOODY_CENTRAL_AGENDADOR_ENABLED=true e allowlist FOODY_CENTRAL_UNIDADES não vazia.
// Sem isso, iniciar() recusa (fail-closed).
//
// Cada ciclo: para cada unidade da allowlist, sincroniza e fecha D-1, D-2 e D-3 (reprocessamento das janelas recentes; dias
// mais antigos ficam congelados). Idempotente: conteúdo igual não cria versão. Erro de uma unidade/dia nunca impede os outros.
// NUNCA envia mensagem (nem simulada) e não alimenta nenhum indicador real.
import { agendamentoPermitido, lerFlagsFoody, compartilhamentoPermitido } from "./foody.flags.js";
import { competenciasParaSincronizar, situacaoCompetencia } from "./foody.periodo.js";
import { sincronizarEFechar } from "./foody.fechamento.service.js";
import { ORIGEM } from "./foody.constants.js";

export const INTERVALO_PADRAO_MS = 6 * 60 * 60_000; // 4x por dia: suficiente para D-1..D-3
/** Reconciliação da conexão compartilhada: dias com fechamento pendente/decisão não aplicada são retomados até este limite. */
export const DIAS_RECONCILIACAO = 35;
const MOTIVO_RECONCILIACAO = {
  FECHAMENTO_PENDENTE: "Reconciliação automática: fechamento de organização pendente na conexão compartilhada.",
  DECISAO_DE_TRIAGEM: "Reconciliação automática: decisão de triagem registrada ainda não aplicada.",
};

/** Competências extras (fora de D-1..D-3) cujo ciclo compartilhado não terminou. Fail-safe: erro de leitura = nenhuma extra. */
async function competenciasParaReconciliar(u, { env, agora, deps }) {
  if (!compartilhamentoPermitido(env) || typeof deps?.repo?.listarCompetenciasParaReconciliar !== "function") return [];
  const desde = new Date(agora().getTime() - DIAS_RECONCILIACAO * 86_400_000).toISOString().slice(0, 10);
  try {
    return (await deps.repo.listarCompetenciasParaReconciliar({ organizacaoId: u.organizacaoId, unidadeId: u.unidadeId }, desde))
      .filter((x) => situacaoCompetencia(x.competencia, agora()) === "CONGELADA");
  } catch { return []; }
}

/** @returns {Promise<Array<{unidadeId, competencia, resultado?, status?, versao?, erro?}>>} */
export async function executarCicloFoody({ unidades, env = process.env, agora = () => new Date(), executar = sincronizarEFechar, deps = {} }) {
  const allow = lerFlagsFoody(env).unidades;
  const out = [];
  for (const u of unidades ?? []) {
    if (!allow.has(String(u?.unidadeId ?? "").toLowerCase())) { out.push({ unidadeId: u?.unidadeId ?? null, erro: "FORA_DA_ALLOWLIST" }); continue; }
    const fila = [
      ...competenciasParaSincronizar(agora()).map((competencia) => ({ competencia, origem: ORIGEM.AGENDADO, motivo: null })),
      ...(await competenciasParaReconciliar(u, { env, agora, deps }))
        .map((x) => ({ competencia: x.competencia, origem: ORIGEM.REPROCESSAMENTO, motivo: MOTIVO_RECONCILIACAO[x.motivo] ?? MOTIVO_RECONCILIACAO.FECHAMENTO_PENDENTE })),
    ];
    for (const { competencia, origem, motivo } of fila) {
      try {
        const r = await executar({ organizacaoId: u.organizacaoId, unidadeId: u.unidadeId, competencia, origem, motivo, geradoPor: "agendador" }, { ...deps, env, agora });
        const item = { unidadeId: u.unidadeId, competencia, resultado: r.fechamento?.resultado, status: r.fechamento?.status, versao: r.fechamento?.versao };
        if (origem === ORIGEM.REPROCESSAMENTO) item.reconciliacao = true;
        // Ciclo compartilhado com fechamento de organização pendente NÃO é sucesso.
        if (r.concluido === false) Object.assign(item, { erro: "FECHAMENTO_PENDENTE", pendentes: r.pendentes.map((p) => ({ unidadeId: p.unidadeId, erro: p.erro })) });
        out.push(item);
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
