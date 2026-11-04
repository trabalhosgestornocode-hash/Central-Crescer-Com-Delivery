// Sincronização MANUAL de competências da conexão Foody (piloto em sombra). Orquestra sincronizarEFechar por dia, com:
//
//   * FLAGS: administração (FOODY_CENTRAL_ADMIN_ENABLED) E coleta (FOODY_CENTRAL_ENABLED + unidade na FOODY_CENTRAL_UNIDADES).
//     Faltou qualquer uma → DESLIGADO (a tela responde 404). Compartilhamento continua dependendo da própria flag.
//   * AUTORIZAÇÃO: organization_admin da organização TITULAR, sem impersonação. Destino (Açaí) não dispara coleta da conta
//     alheia — recebe os próprios fechamentos quando a titular sincroniza.
//   * LIMITES: até 7 dias por pedido; até 10 páginas (≈ 5.000 pedidos) por dia; teto de pedidos únicos por dia conferido ANTES de
//     gravar (LIMITE_PEDIDOS = execução FALHOU sem nenhuma linha gravada).
//   * CONCORRÊNCIA: uma sincronização por unidade no processo (trava em memória) E nenhuma execução EM_ANDAMENTO recente no
//     banco (cobre a sobreposição de instâncias no deploy). Execução EM_ANDAMENTO mais velha que a janela é encerrada como
//     FALHOU/ABANDONADA antes de abrir a nova — nunca fica travando para sempre.
//   * IDEMPOTÊNCIA: o conteúdo é idempotente por natureza (upsert por uid + fonte_hash; fechamento igual não cria versão). A mesma
//     chave de idempotência (cabeçalho) repetida em 15 min devolve a resposta anterior SEM chamar a API.
//   * DIAS: hoje/futuro recusados; dia CONGELADO (antes de D-3) só como reprocessamento com motivo.
// NUNCA envia mensagem e não alimenta indicador existente. Respostas só com códigos e contagens (sem valores nem pedidos).
import { administracaoPermitida, unidadePermitida } from "./foody.flags.js";
import { validarCompetencia, situacaoCompetencia } from "./foody.periodo.js";
import { sincronizarEFechar } from "./foody.fechamento.service.js";
import { ehAdminDaOrganizacao } from "./foody.compartilhamento.service.js";
import { foodyLog } from "./foody.seguranca.js";
import { ORIGEM } from "./foody.constants.js";
import { reservarUnidade, UNIDADES_EM_COLETA } from "./foody.trava.js";

export const LIMITES_SYNC_MANUAL = Object.freeze({
  maxDias: 7,
  maxPaginas: 10,
  maxPedidosPorDia: 4_000,
  janelaConcorrenciaMs: 60 * 60_000,
  idempotenciaMs: 15 * 60_000,
  motivoMin: 10,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAVE = /^[A-Za-z0-9_-]{8,80}$/;
/** Erros que tornam inútil tentar os demais dias (conta/credencial). */
const PARA_TUDO = new Set(["AUTENTICACAO", "SEM_CONEXAO", "CONEXAO_INATIVA", "TOKEN_INVALIDO", "TOKEN_DIVERGENTE", "TENANT_DIVERGENTE", "DESLIGADO"]);
const codigoSeguro = (c) => (/^[A-Z_]{2,40}$/.test(String(c ?? "")) ? String(c) : "ERRO_INTERNO");

export class FoodySyncManualErro extends Error {
  constructor(codigo, mensagem) { super(mensagem); this.name = "FoodySyncManualErro"; this.codigo = codigo; }
}
const erro = (codigo, mensagem) => new FoodySyncManualErro(codigo, mensagem);

/** Trava em memória por unidade + cache de idempotência. Por padrão a trava é a do PROCESSO (compartilhada com o agendador). */
export function criarEstadoSyncManual({ emCurso = UNIDADES_EM_COLETA } = {}) {
  return { emCurso, respostas: new Map() };
}

/** Valida e ordena os dias pedidos; decide a origem de cada um. Puro. */
export function planejarCompetencias(competencias, { motivo = null, agora = new Date(), limites = LIMITES_SYNC_MANUAL } = {}) {
  if (!Array.isArray(competencias) || competencias.length === 0) throw erro("COMPETENCIA_INVALIDA", "informe ao menos um dia.");
  const dias = [...new Set(competencias.map((c) => String(c ?? "").trim()))];
  if (dias.length > limites.maxDias) throw erro("LIMITE_DIAS", `no máximo ${limites.maxDias} dias por sincronização.`);
  if (!dias.every(validarCompetencia)) throw erro("COMPETENCIA_INVALIDA", "dia inválido (use AAAA-MM-DD).");
  const motivoLimpo = String(motivo ?? "").trim();
  if (motivoLimpo.length > 300) throw erro("MOTIVO_INVALIDO", "motivo com no máximo 300 caracteres.");
  return dias.sort().map((competencia) => {
    const s = situacaoCompetencia(competencia, agora);
    if (s === "FUTURA_OU_ABERTA") throw erro("COMPETENCIA_ABERTA", `o dia ${competencia} ainda não terminou.`);
    if (s === "CONGELADA") {
      if (motivoLimpo.length < limites.motivoMin) {
        throw erro("MOTIVO_INVALIDO", `o dia ${competencia} está congelado: reprocessar exige motivo (mínimo ${limites.motivoMin} caracteres).`);
      }
      return { competencia, origem: ORIGEM.REPROCESSAMENTO, motivo: motivoLimpo };
    }
    return { competencia, origem: ORIGEM.MANUAL, motivo: motivoLimpo || null };
  });
}

/** Resumo de UM dia para a resposta: só códigos e contagens. */
export function resumirDia(r) {
  const s = r.sync;
  return {
    competencia: s.competencia, origem: s.origem, execucaoId: s.execucaoId,
    cobertura: { completa: s.cobertura.completa, paginas: s.cobertura.paginas, pedidosUnicos: s.cobertura.pedidosUnicos,
      pendencias: s.cobertura.pendencias.map((p) => ({ codigo: p.codigo, quantidade: p.quantidade ?? null })) },
    contagens: s.contagens,
    distribuicao: s.compartilhamento?.distribuicao
      ? { titular: s.compartilhamento.distribuicao.titular, destinos: s.compartilhamento.distribuicao.destinos,
        triagem: s.compartilhamento.distribuicao.triagem, minimo: s.compartilhamento.distribuicao.minimo,
        reclassificados: s.compartilhamento.distribuicao.reclassificados }
      : null,
    fechamento: r.fechamento ? { resultado: r.fechamento.resultado, status: r.fechamento.status, versao: r.fechamento.versao, estadoValores: r.fechamento.estadoValores } : null,
    fechamentosDestino: (r.fechamentosDestino ?? []).map((f) => ({ operacao: f.operacao, resultado: f.resultado ?? null, status: f.status ?? null,
      versao: f.versao ?? null, estadoValores: f.estadoValores ?? null, erro: f.erro ?? null })),
    concluido: r.concluido,
  };
}

/**
 * @param {{ator:object, tenant:{organizacaoId:string, unidadeId:string}, competencias:string[], motivo?:string, chaveIdempotencia?:string}} pedido
 * @param {{env?:object, repo:object, seguranca:()=>object|object, agora?:()=>Date, estado?:object, executar?:Function,
 *   criarCliente?:Function, log?:Function, limites?:object}} deps
 */
export async function solicitarSyncManual(pedido, deps) {
  const { ator, tenant, competencias, motivo = null, chaveIdempotencia = null } = pedido ?? {};
  const { env = process.env, repo, agora = () => new Date(), estado = criarEstadoSyncManual(), executar = sincronizarEFechar,
    log = foodyLog, limites = LIMITES_SYNC_MANUAL } = deps ?? {};
  const t = { organizacaoId: tenant?.organizacaoId ?? null, unidadeId: tenant?.unidadeId ?? null };

  if (!administracaoPermitida(env) || !unidadePermitida(env, t.unidadeId)) throw erro("DESLIGADO", "sincronização Foody desligada para esta unidade.");
  if (!ehAdminDaOrganizacao(ator, t.organizacaoId)) throw erro("SEM_PERMISSAO", "só um Administrador da empresa titular (sem impersonação) sincroniza.");
  if (!UUID.test(String(t.unidadeId ?? ""))) throw erro("SEM_UNIDADE", "selecione a unidade dona da conta Foody.");
  if (chaveIdempotencia != null && !CHAVE.test(String(chaveIdempotencia))) throw erro("PARAMETRO_INVALIDO", "chave de idempotência inválida.");

  const agoraD = agora();
  const chaveCache = chaveIdempotencia ? `${t.unidadeId}|${chaveIdempotencia}` : null;
  if (chaveCache) {
    for (const [k, v] of estado.respostas) if (agoraD.getTime() - v.em > limites.idempotenciaMs) estado.respostas.delete(k);
    const anterior = estado.respostas.get(chaveCache);
    if (anterior) return { ...anterior.resposta, repetida: true };
  }
  const plano = planejarCompetencias(competencias, { motivo, agora: agoraD, limites });

  const conexao = await repo.obterConexao(t);
  if (!conexao) throw erro("SEM_CONEXAO", "unidade sem conexão Foody.");
  if (conexao.organizacao_id !== t.organizacaoId || conexao.unidade_id !== t.unidadeId) throw erro("TENANT_DIVERGENTE", "conexão de outra unidade.");
  if (conexao.status !== "ATIVA") throw erro("CONEXAO_INATIVA", `a conexão está ${conexao.status}: ative antes de sincronizar.`);

  let reserva;
  try {
    reserva = await reservarUnidade({ t, conexaoId: conexao.id, repo, agora: () => agoraD, emCurso: estado.emCurso, janelaMs: limites.janelaConcorrenciaMs });
  } catch (e) {
    if (e?.codigo === "CONCORRENCIA") throw erro("CONCORRENCIA", e.message);
    throw e;
  }
  try {
    log("info", "foody.sync.manual.inicio", { unidade: t.unidadeId, perfil: ator.perfilId, dias: plano.map((p) => p.competencia), abandonadas: reserva.abandonadas });
    const dias = [];
    let parouEm = null;
    for (const p of plano) {
      if (parouEm) { dias.push({ competencia: p.competencia, origem: p.origem, erro: "NAO_EXECUTADO" }); continue; }
      try {
        const r = await executar({ organizacaoId: t.organizacaoId, unidadeId: t.unidadeId, competencia: p.competencia, origem: p.origem,
          motivo: p.motivo, geradoPor: ator.perfilId }, { ...deps, env, repo, agora, limites: { maxPaginas: limites.maxPaginas, maxPedidos: limites.maxPedidosPorDia } });
        dias.push(resumirDia(r));
      } catch (e) {
        const codigo = codigoSeguro(e?.codigo);
        dias.push({ competencia: p.competencia, origem: p.origem, erro: codigo, execucaoId: e?.execucaoId ?? null,
          fechamentosPendentes: (e?.fechamentosPendentes ?? []).map((x) => ({ operacao: x.operacao, erro: codigoSeguro(x.erro) })) });
        if (PARA_TUDO.has(codigo)) parouEm = codigo;
      }
    }
    const resposta = {
      unidadeId: t.unidadeId, solicitadoEm: agoraD.toISOString(), dias,
      totais: {
        dias: dias.length, concluidos: dias.filter((d) => d.concluido === true).length,
        comPendencia: dias.filter((d) => d.concluido === false || (d.cobertura && !d.cobertura.completa)).length,
        falhas: dias.filter((d) => d.erro).length,
      },
      interrompidoPor: parouEm,
    };
    log("info", "foody.sync.manual.fim", { unidade: t.unidadeId, perfil: ator.perfilId, ...resposta.totais, interrompidoPor: parouEm });
    if (chaveCache) estado.respostas.set(chaveCache, { em: agoraD.getTime(), resposta });
    return resposta;
  } finally {
    reserva.liberar();
  }
}

/** Histórico de execuções da unidade TITULAR (admin da própria organização). */
export async function listarSincronizacoes({ ator, tenant }, { env = process.env, repo }) {
  const t = { organizacaoId: tenant?.organizacaoId ?? null, unidadeId: tenant?.unidadeId ?? null };
  if (!administracaoPermitida(env)) throw erro("DESLIGADO", "administração da integração Foody desligada.");
  if (!ehAdminDaOrganizacao(ator, t.organizacaoId)) throw erro("SEM_PERMISSAO", "só um Administrador da empresa consulta as sincronizações.");
  if (!UUID.test(String(t.unidadeId ?? ""))) throw erro("SEM_UNIDADE", "selecione a unidade dona da conta Foody.");
  const conexao = await repo.obterConexao(t);
  const linhas = conexao ? await repo.listarExecucoesRecentes(t, 30) : [];
  return {
    habilitada: unidadePermitida(env, t.unidadeId),
    conexaoStatus: conexao?.status ?? null,
    limites: { maxDias: LIMITES_SYNC_MANUAL.maxDias, maxPedidosPorDia: LIMITES_SYNC_MANUAL.maxPedidosPorDia },
    execucoes: linhas.map((e) => ({
      id: e.id, competencia: e.competencia, origem: e.origem, status: e.status, erroCodigo: e.erro_codigo ?? null,
      paginas: e.paginas, recebidos: e.pedidos_recebidos, unicos: e.pedidos_unicos, foraJanela: e.pedidos_fora_janela,
      pontoDivergente: e.pedidos_ponto_divergente, inseridos: e.inseridos, atualizados: e.atualizados, inalterados: e.inalterados,
      fechamentosPendentes: e.fechamentos_pendentes ?? 0, iniciadoEm: e.iniciado_em, concluidoEm: e.concluido_em ?? null,
    })),
  };
}
