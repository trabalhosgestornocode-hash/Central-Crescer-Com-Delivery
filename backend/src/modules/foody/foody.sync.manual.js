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
import { validarCompetencia, situacaoCompetencia, janelaDoDia, somarDias, hojeParede } from "./foody.periodo.js";
import { criarClienteFoody } from "./foody.client.js";
import { sanearPedidoApi } from "./foody.adapter.js";
import { impressaoToken } from "./foody.seguranca.js";
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


// ---------------------------------------------------------------------------
// PRÉVIA DE RECUPERAÇÃO DE UM MÊS (Parser › "Preencher mês"). SOMENTE LEITURA: consulta a API Foody (só GET) e o banco e NÃO grava
// nada (nem execução). A gravação continua sendo a sincronização manual acima, em lotes de até 7 dias, com motivo.
// ---------------------------------------------------------------------------
const MES = /^\d{4}-(0[1-9]|1[0-2])$/;
const STATUS_DEFINITIVO = new Set(["CONSOLIDADO", "CORRIGIDO"]);
/** Prévia em cache por unidade+mês: repetir em seguida não gasta chamadas da API. */
export const PREVIA_CACHE_MS = 10 * 60_000;
export const SITUACAO_DIA = Object.freeze({
  COMPLETO: "completo",                 // fechamento definitivo no banco: nada a recuperar
  PROVISORIO: "provisorio",             // fechamento existe com pendência (ex.: triagem): não recuperar; conferir
  PARCIAL: "parcial",                   // fechamento INCOMPLETO no banco e a origem tem pedidos: pode completar
  RECUPERAVEL: "recuperavel",           // sem fechamento e a origem devolveu pedidos
  SEM_PEDIDOS_NA_ORIGEM: "sem_pedidos_na_origem", // consulta válida com zero pedidos (NÃO é "dia zerado" confirmado)
  INDISPONIVEL: "indisponivel",         // a consulta falhou (código no dia)
  NAO_CONSULTADO: "nao_consultado",     // consulta interrompida por erro de conta/credencial em dia anterior
  ABERTO: "aberto",                     // hoje ou futuro: não se recupera
});

/** Contagens de um dia da API, sem dados pessoais: total, por operação e taxas PREVISTAS de pedidos com entregador. */
export function resumirDiaDaApi(pedidos, { competencia, hashEntregador, compartilhado, catalogo }) {
  const r = { pedidos: 0, foraDoDia: 0, malformados: 0, porOperacao: {}, comEntregador: {}, taxasPrevistasCentavos: {} };
  const vistos = new Set();
  for (const o of pedidos ?? []) {
    const s = sanearPedidoApi(o, { hashEntregador, compartilhado, catalogo });
    if (s.erro) { r.malformados++; continue; }
    const g = s.registro;
    if (g.competencia !== competencia) { r.foraDoDia++; continue; }
    if (vistos.has(g.foody_uid)) continue;
    vistos.add(g.foody_uid);
    r.pedidos++;
    r.porOperacao[g.operacao] = (r.porOperacao[g.operacao] ?? 0) + 1;
    if (g.entregador_presente) {
      r.comEntregador[g.operacao] = (r.comEntregador[g.operacao] ?? 0) + 1;
      if (g.taxa_entregador != null) r.taxasPrevistasCentavos[g.operacao] = (r.taxasPrevistasCentavos[g.operacao] ?? 0) + Math.round(Number(g.taxa_entregador) * 100);
    }
  }
  return r;
}

/**
 * @param {{ator, tenant:{organizacaoId, unidadeId}, mes:string}} pedido  mes = "AAAA-MM"
 * @param {{env?, repo, seguranca, agora?, criarCliente?, estado?, catalogo?}} deps
 */
export async function previaRecuperacaoMes(pedido, deps) {
  const { ator, tenant, mes } = pedido ?? {};
  const { env = process.env, repo, seguranca, agora = () => new Date(), criarCliente = criarClienteFoody, estado = criarEstadoSyncManual() } = deps ?? {};
  const t = { organizacaoId: tenant?.organizacaoId ?? null, unidadeId: tenant?.unidadeId ?? null };
  if (!administracaoPermitida(env) || !unidadePermitida(env, t.unidadeId)) throw erro("DESLIGADO", "sincronização Foody desligada para esta unidade.");
  if (!ehAdminDaOrganizacao(ator, t.organizacaoId)) throw erro("SEM_PERMISSAO", "só um Administrador da empresa titular (sem impersonação) consulta a recuperação.");
  if (!UUID.test(String(t.unidadeId ?? ""))) throw erro("SEM_UNIDADE", "selecione a unidade dona da conta Foody.");
  if (!MES.test(String(mes ?? ""))) throw erro("PARAMETRO_INVALIDO", "mês inválido (use AAAA-MM).");

  const agoraD = agora();
  const chave = `previa|${t.unidadeId}|${mes}`;
  for (const [k, v] of estado.respostas) if (agoraD.getTime() - v.em > PREVIA_CACHE_MS) estado.respostas.delete(k);
  const emCache = estado.respostas.get(chave);
  if (emCache) return { ...emCache.resposta, emCache: true };

  const conexao = await repo.obterConexao(t);
  if (!conexao) throw erro("SEM_CONEXAO", "unidade sem conexão Foody.");
  if (conexao.organizacao_id !== t.organizacaoId || conexao.unidade_id !== t.unidadeId) throw erro("TENANT_DIVERGENTE", "conexão de outra unidade.");
  if (conexao.status !== "ATIVA") throw erro("CONEXAO_INATIVA", `a conexão está ${conexao.status}.`);

  const inicio = `${mes}-01`;
  const fim = somarDias(`${somarDias(inicio, 31).slice(0, 7)}-01`, -1);
  const hoje = hojeParede(agoraD);
  const dias = [];
  for (let d = inicio; d <= fim; d = somarDias(d, 1)) dias.push(d);

  const fechamentos = await repo.fechamentosDoIntervalo(t, inicio, fim);
  const destinos = await repo.listarDestinosDaConexao(t, conexao.id);
  const compartilhado = destinos.some((x) => x.estado === "ATIVO");

  let cliente = null;
  const abrirCliente = () => {
    if (cliente) return cliente;
    let token;
    try { token = seguranca.decifrarToken(conexao.token_cifrado, t.unidadeId); } catch { throw erro("TOKEN_INVALIDO", "token não decifra para esta unidade."); }
    if (impressaoToken(token) !== conexao.token_impressao) throw erro("TOKEN_DIVERGENTE", "token não confere com a impressão gravada.");
    cliente = criarCliente({ token, maxPaginas: LIMITES_SYNC_MANUAL.maxPaginas });
    return cliente;
  };

  const out = [];
  let parouEm = null;
  for (const competencia of dias) {
    if (competencia >= hoje) { out.push({ competencia, situacao: SITUACAO_DIA.ABERTO }); continue; }
    const f = fechamentos.get(competencia);
    if (f && STATUS_DEFINITIVO.has(f.status) && f.estado_valores !== "PROVISORIO") { out.push({ competencia, situacao: SITUACAO_DIA.COMPLETO, fechamento: f.status }); continue; }
    if (f && f.status !== "INCOMPLETO") {
      out.push({ competencia, situacao: SITUACAO_DIA.PROVISORIO, fechamento: f.status,
        pendencias: (Array.isArray(f.pendencias) ? f.pendencias : []).map((p) => ({ codigo: p.codigo, quantidade: p.quantidade ?? null })) });
      continue;
    }
    if (parouEm) { out.push({ competencia, situacao: SITUACAO_DIA.NAO_CONSULTADO }); continue; }
    try {
      const { pedidos } = await abrirCliente().listarPedidos(janelaDoDia(competencia));
      const r = resumirDiaDaApi(pedidos, { competencia, hashEntregador: seguranca.hashEntregador, compartilhado, catalogo: deps?.catalogo });
      out.push({ competencia, situacao: r.pedidos === 0 ? SITUACAO_DIA.SEM_PEDIDOS_NA_ORIGEM : f ? SITUACAO_DIA.PARCIAL : SITUACAO_DIA.RECUPERAVEL,
        ...(f ? { fechamento: f.status } : {}), origem: r });
    } catch (e) {
      const codigo = codigoSeguro(e?.codigo);
      out.push({ competencia, situacao: SITUACAO_DIA.INDISPONIVEL, erro: codigo });
      if (PARA_TUDO.has(codigo)) parouEm = codigo;
    }
  }
  const conta = (s) => out.filter((x) => x.situacao === s).length;
  const soma = (campo) => out.reduce((acc, x) => {
    for (const [op, n] of Object.entries(x.origem?.[campo] ?? {})) acc[op] = (acc[op] ?? 0) + n;
    return acc;
  }, {});
  const resposta = {
    mes, unidadeId: t.unidadeId, consultadoEm: agoraD.toISOString(), interrompidoPor: parouEm,
    dias: out,
    totais: {
      dias: out.length, completos: conta(SITUACAO_DIA.COMPLETO), provisorios: conta(SITUACAO_DIA.PROVISORIO),
      parciais: conta(SITUACAO_DIA.PARCIAL), recuperaveis: conta(SITUACAO_DIA.RECUPERAVEL),
      semPedidosNaOrigem: conta(SITUACAO_DIA.SEM_PEDIDOS_NA_ORIGEM), indisponiveis: conta(SITUACAO_DIA.INDISPONIVEL) + conta(SITUACAO_DIA.NAO_CONSULTADO),
      abertos: conta(SITUACAO_DIA.ABERTO),
      pedidosNaOrigem: out.reduce((a, x) => a + (x.origem?.pedidos ?? 0), 0),
      porOperacao: soma("porOperacao"), comEntregador: soma("comEntregador"), taxasPrevistasCentavos: soma("taxasPrevistasCentavos"),
    },
    // Dias que a sincronização manual pode gravar: recuperáveis e parciais (os congelados exigem motivo).
    recuperar: out.filter((x) => x.situacao === SITUACAO_DIA.RECUPERAVEL || x.situacao === SITUACAO_DIA.PARCIAL).map((x) => x.competencia),
  };
  estado.respostas.set(chave, { em: agoraD.getTime(), resposta });
  return resposta;
}
