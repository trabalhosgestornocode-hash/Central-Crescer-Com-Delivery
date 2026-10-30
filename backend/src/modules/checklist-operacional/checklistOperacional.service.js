// Checklist Operacional — resumo operacional da unidade (somente leitura, somente banco local).
//
// Não chama a API do iFood, não liga polling, não muda estado. Junta:
//   1. o vínculo oficial unidade ↔ loja iFood (ifood_conexoes + credencial `order`);
//   2. o sinal de vida do recebimento (lease do poller + último evento DESTA loja);
//   3. os pedidos do tenant em `ifood_pedidos`, calculados por checklistOperacional.calc.js.
//
// O tenant vem SEMPRE do Context Token (req.tenant). Nenhum id de unidade ou merchant vem do navegador.
//
// ESTADO DA INTEGRAÇÃO — separa "não há pedidos" de "não há integração":
//   nao_ativada    sem loja vinculada, sem credencial Order, ou o recebimento nunca rodou para esta loja
//   desatualizado  havia recebimento, mas parou (lease vencido) ou a credencial pede nova autorização
//   ao_vivo        o poller renovou o lease há pouco
// Os pedidos já persistidos aparecem em QUALQUER estado — o selo diz se eles ainda refletem a operação.
//
// MODO (aditivo, para a tela): `sem_integracao` = a unidade não tem loja iFood vinculada (nem credencial de pedidos);
// o Checklist abre normalmente, sem pedidos e sem erro, com um aviso informativo. `integrado` = há vínculo (mesmo que o
// recebimento esteja parado ou desligado — isso é o `estado`). Nada aqui chama o iFood.

import * as repo from "./checklistOperacional.repository.js";
import * as ifoodRepo from "../ifood/ifood.repository.js";
import { orderLiberadoParaUnidade } from "../ifood/ifoodToken.service.js";
import { montarResumo, diaOperacional, LIMITE_ATIVO_MIN } from "./checklistOperacional.calc.js";
import { anotarOrigem } from "./checklistOperacional.lojas.js";
import { EVENTO_PEDIDOS_ATUALIZADOS, checklistRealtimeHabilitado } from "../ifood/ifoodPedidosAviso.js";
import {
  metasDaLinha, metasIndisponiveis, validarMetasEntrada, resultadoDoSalvar, linhaDoTempoDasMetas,
} from "./checklistOperacional.metas.js";
import { resolverPeriodo } from "./checklistOperacional.periodos.js";
import { resolverPeriodoDaUnidade } from "./checklistOperacional.fuso.js";
import { montarDashboard, paraResposta, ETAPAS } from "./checklistOperacional.indicadores.js";
import { gerarAnalises } from "./checklistOperacional.analises.js";
import { emitirEventoRealtime } from "../realtime/emitirEvento.js";
import { ApiError } from "../../shared/ApiError.js";

/** Evento de domínio das metas (espelhado em frontend/src/realtime/realtimeEvents.js). Payload: só ids + versão. */
export const EVENTO_METAS_ATUALIZADAS = "checklist_metas.atualizadas";

export const VERSAO_CONTRATO = 1;
/** Lease renovado a cada ciclo (30 s). Sem renovação por mais que isto, o recebimento é tratado como parado. */
export const LIMITE_SINCRONIZACAO_S = 120;
/** Intervalo que a tela usa para consultar de novo (polling de segurança; o Realtime só antecipa). */
export const INTERVALO_ATUALIZACAO_S = 30;

const MENSAGENS = {
  sem_loja_vinculada: "Esta unidade ainda não tem uma loja iFood vinculada à Central.",
  sem_credencial_order: "A loja não autorizou o aplicativo de pedidos da Central.",
  tabelas_ausentes: "O recebimento de pedidos ainda não foi instalado neste ambiente.",
  recebimento_desligado: "O recebimento de pedidos do iFood ainda não foi ativado para esta loja.",
  recebimento_parado: "O recebimento de pedidos do iFood parou. Os números podem não refletir a operação atual.",
  reautorizacao_necessaria: "A autorização do iFood expirou. Os números podem não refletir a operação atual.",
};

const est = (estado, motivo, extra = {}) => ({ estado, motivo, mensagem: motivo ? MENSAGENS[motivo] : null, ...extra });

/**
 * PURA: estado da integração da unidade.
 * `outraConexaoViva`: a unidade TEM conexão iFood, mas não a de pedidos (ex.: só o Financial de homologação) — a integração de pedidos
 * está "não ativada" (a loja não autorizou o app de pedidos), e NÃO "sem integração com o iFood".
 * @param {{conexao: object|null, credencialOrder: object|null, observabilidade: object|null, agoraMs: number, outraConexaoViva?: boolean}} p
 */
export function derivarEstadoIntegracao({ conexao, credencialOrder, observabilidade, agoraMs, outraConexaoViva = false }) {
  const ultimoEventoEm = observabilidade?.ultimoEvento ?? null;
  const base = { ultimaSincronizacao: null, ultimoEventoEm };
  if (!conexao && outraConexaoViva) return est("nao_ativada", "sem_credencial_order", base);
  if (!conexao || !conexao.merchant_id || !["ativa", "reauth_required"].includes(conexao.status)) return est("nao_ativada", "sem_loja_vinculada", base);
  if (!credencialOrder) return est("nao_ativada", "sem_credencial_order", base);
  if (conexao.status === "reauth_required" || credencialOrder.status === "reauth_required") {
    return est("desatualizado", "reautorizacao_necessaria", { ...base, ultimaSincronizacao: ultimoEventoEm });
  }
  if (!observabilidade?.disponivel) return est("nao_ativada", "tabelas_ausentes", base);

  const lease = observabilidade.lease;
  const renovado = lease ? Date.parse(lease.atualizadoEm) : NaN;
  const vigente = lease ? Date.parse(lease.leaseAte) > agoraMs : false;
  if (vigente && Number.isFinite(renovado) && agoraMs - renovado <= LIMITE_SINCRONIZACAO_S * 1000) {
    return est("ao_vivo", null, { ...base, ultimaSincronizacao: lease.atualizadoEm });
  }
  if (ultimoEventoEm) return est("desatualizado", "recebimento_parado", { ...base, ultimaSincronizacao: ultimoEventoEm });
  return est("nao_ativada", "recebimento_desligado", base);
}

/**
 * PURA: a unidade tem integração iFood? `sem_integracao` SÓ quando não há loja vinculada E não existe nenhum pedido persistido para mostrar.
 * Loja vinculada sem credencial de pedidos (ex.: autorização revogada) é `integrado` — a tela mostra o motivo específico ("a loja não autorizou…"),
 * não "vincule a loja". Unidade que já teve pedidos também segue `integrado`: os números existentes não podem ser chamados de "sem número".
 * @param {{estado?: string, motivo?: string}} integracao
 * @param {{temPedidos?: boolean}} [opc]
 */
export function derivarModo(integracao, { temPedidos = false } = {}) {
  return integracao?.estado === "nao_ativada" && integracao.motivo === "sem_loja_vinculada" && !temPedidos
    ? "sem_integracao" : "integrado";
}

/**
 * @param {{organizacaoId: string, unidadeId: string, agora?: () => Date,
 *          deps?: {repo?: object, ifoodRepo?: object, pilotoOrder?: (unidadeId: string) => boolean, env?: object}}} p
 */
export async function obterResumo({ organizacaoId, unidadeId, agora = () => new Date(), deps = {} }) {
  const r = deps.repo ?? repo;
  const ir = deps.ifoodRepo ?? ifoodRepo;
  const piloto = deps.pilotoOrder ?? orderLiberadoParaUnidade;
  const realtimeLigado = checklistRealtimeHabilitado(deps.env ?? process.env);
  const agoraMs = agora().getTime();

  // Metas da unidade: lidas em paralelo e NUNCA derrubam o resumo (sem a migration 127 ou com falha de leitura, a tela
  // segue com o exemplo e diz por quê).
  const metasP = carregarMetasParaTela({ repo: r, organizacaoId, unidadeId });

  // O Checklist consulta SÓ a conexão operacional (pedidos). Uma conexão financeira de homologação na unidade nunca a substitui nem a bloqueia.
  const conexao = await ir.obterConexaoViva({ organizacaoId, unidadeId, finalidade: "pedidos_producao" });
  let credencialOrder = null;
  let observabilidade = null;
  if (conexao?.id) {
    const credenciais = await ir.listarCredenciaisDaConexao({ conexaoId: conexao.id });
    credencialOrder = credenciais.find((c) => c.app_type === "order") ?? null;
    if (conexao.merchant_id) {
      observabilidade = await ir.obterObservabilidadeOrder({ organizacaoId, unidadeId, merchantId: conexao.merchant_id });
    }
  }
  const outraConexaoViva = !conexao && typeof ir.listarConexoesVivas === "function"
    ? ((await ir.listarConexoesVivas({ organizacaoId, unidadeId })) ?? []).length > 0 : false;
  const integracao = derivarEstadoIntegracao({ conexao, credencialOrder, observabilidade, agoraMs, outraConexaoViva });

  // Janela: o dia operacional inteiro + a folga do "sem conclusão" (pedido de ontem ainda aberto aparece como alerta).
  const dia = diaOperacional(agoraMs);
  const desdeMs = Math.min(dia.inicioMs, agoraMs - LIMITE_ATIVO_MIN * 60_000) - 24 * 3_600_000;
  const semTabelas = integracao.motivo === "tabelas_ausentes";
  const desdeIso = new Date(desdeMs).toISOString();
  const [pedidos, abertosAntigos] = semTabelas ? [[], 0] : await Promise.all([
    r.listarPedidosDaJanela({ organizacaoId, unidadeId, desdeIso }),
    r.contarAbertosAntesDe({ organizacaoId, unidadeId, antesIso: desdeIso }),
  ]);

  const resumo = montarResumo({ pedidos, agoraMs });
  if (abertosAntigos > 0) {
    // Abertos desde antes da janela: continuam ATIVOS pelo estado oficial — entram na contagem e no alerta crítico.
    resumo.contagemDia.abertosForaDaJanela = abertosAntigos;
    resumo.contagemDia.emAndamento += abertosAntigos;
    resumo.contagemDia.semConclusao += abertosAntigos;
    const total = resumo.contagemDia.semConclusao;
    const alerta = resumo.alertas.find((a) => a.codigo === "pedidos_sem_conclusao");
    const texto = `${total} ${total === 1 ? "pedido aberto" : "pedidos abertos"} há mais de ${LIMITE_ATIVO_MIN / 60} h sem conclusão`;
    if (alerta) Object.assign(alerta, { quantidade: total, texto });
    else resumo.alertas.unshift({ codigo: "pedidos_sem_conclusao", nivel: "critico", quantidade: total, texto });
  } else {
    resumo.contagemDia.abertosForaDaJanela = 0;
  }
  if (pedidos.length >= (r.LIMITE_LINHAS ?? repo.LIMITE_LINHAS)) {
    resumo.alertas.push({ codigo: "janela_truncada", nivel: "atencao", quantidade: pedidos.length, texto: "Pedidos demais na janela: o resumo considera só os mais recentes" });
  }
  if ((observabilidade?.eventosComFalha ?? 0) > 0) {
    const n = observabilidade.eventosComFalha;
    resumo.alertas.push({ codigo: "eventos_com_falha", nivel: "atencao", quantidade: n, texto: `${n} ${n === 1 ? "evento do iFood não processado" : "eventos do iFood não processados"}` });
  }

  // Várias lojas iFood na mesma unidade: acrescenta a ORIGEM (rótulo por pedido, contagem por loja, aviso de loja sem recebimento).
  // Com uma loja só devolve null e a resposta fica IDÊNTICA à de antes. Nunca lança.
  const origemLojas = await anotarOrigem({ resumo, pedidos, conexao, repo: r, organizacaoId, unidadeId, agoraMs }).catch(() => null);

  return {
    versao: VERSAO_CONTRATO,
    origem: "api",
    servidorEm: new Date(agoraMs).toISOString(),
    atualizarEmS: INTERVALO_ATUALIZACAO_S,
    modo: derivarModo(integracao, { temPedidos: resumo.contagemDia.recebidos > 0 || resumo.contagemDia.emAndamento > 0 }),
    integracao: { ...integracao, pilotoOrder: piloto(unidadeId) === true },
    semPedidosNoDia: resumo.contagemDia.recebidos === 0 && resumo.contagemDia.emAndamento === 0,
    ...resumo,
    ...(origemLojas ? { lojas: origemLojas.lojas } : {}),
    avaliacoes: { disponivel: false, motivo: "As avaliações do iFood ainda não estão conectadas à Central." },
    // Metas da unidade (fonte única: checklist_metas). A tela classifica por elas; `versao` vai no PUT seguinte.
    metas: await metasP,
    // Realtime: o Events emite este evento SÓ no tópico privado da unidade depois de gravar um pedido; a tela,
    // ao receber (ou ao resincronizar), consulta este endpoint de novo. Payload: só tipo + organização + unidade.
    // Três coisas DIFERENTES, nunca confundidas:
    //   habilitado    a emissão de avisos está ligada (IFOOD_CHECKLIST_REALTIME_ENABLED, lida neste processo);
    //   avisosAtivos  habilitado E o recebimento está ao vivo — só assim existem avisos para chegar;
    //   (conexão do canal) quem sabe é a tela: "tempo real" só com avisosAtivos E o canal da unidade assinado.
    tempoReal: {
      habilitado: realtimeLigado,
      avisosAtivos: realtimeLigado && integracao.estado === "ao_vivo",
      topico: `unidade:${unidadeId}`,
      evento: EVENTO_PEDIDOS_ATUALIZADOS,
    },
  };
}

// ---------------------------------------------------------------------------
// Metas da unidade
// ---------------------------------------------------------------------------

/** Para o resumo: nunca lança. Sem migration / falha de leitura = exemplo marcado `indisponivel`. */
export async function carregarMetasParaTela({ repo: r = repo, organizacaoId, unidadeId }) {
  try {
    if (typeof r.obterMetas !== "function") return metasIndisponiveis("leitura_indisponivel");
    return metasDaLinha(await r.obterMetas({ organizacaoId, unidadeId }));
  } catch (e) {
    return metasIndisponiveis(e?.codigo === "METAS_INDISPONIVEIS" ? "migration_pendente" : "falha_leitura");
  }
}

/** GET /metas: aqui a falha APARECE (503 sem a migration), diferente do resumo. */
export async function obterMetas({ organizacaoId, unidadeId, deps = {} }) {
  const r = deps.repo ?? repo;
  return metasDaLinha(await r.obterMetas({ organizacaoId, unidadeId }));
}

/**
 * PUT /metas. Corpo: `{ versao: number (a que a tela tinha), metas: {preparo, entrega, vida}, origem?: 'migracao_local' }`.
 * `versao: 0` = "a unidade ainda não tinha metas". Versão diferente da atual → 409 METAS_CONFLITO com o valor atual
 * (nada é gravado). Sucesso → aviso no tópico da UNIDADE (TV, tablet e Dashboard recarregam pelo resumo).
 * @param {{organizacaoId: string, unidadeId: string, corpo: object, autor: object, deps?: object}} p
 */
export async function salvarMetas({ organizacaoId, unidadeId, corpo, autor, deps = {} }) {
  const r = deps.repo ?? repo;
  const emitir = deps.emitir ?? emitirEventoRealtime;
  const versao = corpo?.versao;
  if (!Number.isInteger(versao) || versao < 0) throw ApiError.badRequest("Informe a versão das metas que a tela tinha (número inteiro ≥ 0).");
  const origem = corpo?.origem === "migracao_local" ? "migracao_local" : "interface";
  if (origem === "migracao_local" && versao !== 0) throw ApiError.badRequest("A migração de metas locais só grava quando a unidade ainda não tem metas salvas.");
  const v = validarMetasEntrada(corpo?.metas);
  if (!v.ok) throw ApiError.badRequest("Metas inválidas.", { erros: v.erros });

  const linha = await r.salvarMetas({ organizacaoId, unidadeId, versaoEsperada: versao, metas: v.metas, origem, autor });
  const res = resultadoDoSalvar(linha);
  if (res.resultado === "conflito") {
    const e = new ApiError(409, "As metas foram alteradas em outro aparelho. Confira os valores atuais antes de salvar de novo.", { metas: res.metas });
    e.codigo = "METAS_CONFLITO";
    throw e;
  }
  if (res.resultado !== "salvo" && res.resultado !== "sem_alteracao") throw ApiError.internal("Resposta inesperada ao salvar as metas.");
  if (res.resultado === "salvo") {
    // Depois do commit (a função já retornou). Nunca lança; o polling cobre se o aviso não chegar.
    Promise.resolve()
      .then(() => emitir({ tipo: EVENTO_METAS_ATUALIZADAS, organizacaoId, unidadeId, versao: res.metas.versao }, { somenteUnidade: true }))
      .catch(() => {});
  }
  return res;
}

/** GET /metas/historico — sem ids de pessoa: só o nome gravado na hora e se foi suporte (impersonação). */
export async function obterHistoricoMetas({ organizacaoId, unidadeId, deps = {} }) {
  const r = deps.repo ?? repo;
  const linhas = await r.listarHistoricoMetas({ organizacaoId, unidadeId, limite: 50 });
  return linhas.map((h) => ({
    versao: Number(h.versao), anterior: h.anterior ?? null, novo: h.novo, origem: h.origem,
    alteradoEm: h.alterado_em, alteradoPor: h.alterado_por_nome ?? null, suporte: h.impersonado_por != null,
  }));
}

// ---------------------------------------------------------------------------
// Dashboard Operacional (histórico)
// ---------------------------------------------------------------------------

export const ETAPAS_FILTRO = Object.freeze(["todas", ...ETAPAS]);
/** Folgas da janela de leitura por `criado_em` (o dia de cada pedido é decidido pelo recebimento oficial). */
const FOLGA_ANTES_MS = 3_600_000;        // relógio do banco × carimbo do iFood
const FOLGA_DEPOIS_MS = 48 * 3_600_000;  // pedido registrado tarde (recebimento parado e retomado)

/**
 * Indicadores + análises de um período. Sempre do tenant do contexto; nada vem do navegador além do filtro.
 * @param {{organizacaoId: string, unidadeId: string, filtro: {periodo?: string, inicio?: string, fim?: string, etapa?: string},
 *          agora?: () => Date, deps?: object}} p
 */
export async function obterDashboard({ organizacaoId, unidadeId, filtro = {}, agora = () => new Date(), deps = {} }) {
  const r = deps.repo ?? repo;
  const agoraMs = agora().getTime();
  // D-15: o fuso do período vem da regra única (corte desligado = fuso da plataforma, idêntico ao anterior)
  const fusoUnidade = await fusoDaUnidade(r, { organizacaoId, unidadeId });
  const { periodo, fuso, origem: fusoOrigem } = resolverPeriodoDaUnidade({ filtro, agoraMs, fusoUnidade });
  if (!periodo.ok) { const e = ApiError.badRequest(periodo.mensagem); e.codigo = periodo.codigo; throw e; }
  const etapa = filtro.etapa || "todas";
  if (!ETAPAS_FILTRO.includes(etapa)) throw ApiError.badRequest("Etapa inválida. Use todas, preparo, entrega ou vida.");

  const desdeMs = Math.min(periodo.atual.inicioMs, periodo.anterior.inicioMs) - FOLGA_ANTES_MS;
  const ateMs = Math.min(Math.max(periodo.atual.fimMs, periodo.anterior.fimMs) + FOLGA_DEPOIS_MS, agoraMs + 60_000);

  let versoes = [];
  let metasDisponiveis = true;
  try {
    versoes = await r.listarVersoesMetas({ organizacaoId, unidadeId, ateIso: new Date(periodo.atual.fimMs).toISOString() });
  } catch (e) {
    if (e?.codigo !== "METAS_INDISPONIVEIS") throw e;
    metasDisponiveis = false; // sem a migration: nenhum pedido tem meta vigente (dito na qualidade dos dados)
  }
  const [pedidos, primeiroPedidoEm] = await Promise.all([
    r.listarPedidosDoPeriodo({ organizacaoId, unidadeId, desdeIso: new Date(desdeMs).toISOString(), ateIso: new Date(ateMs).toISOString() }),
    r.obterPrimeiroPedidoEm({ organizacaoId, unidadeId }),
  ]);

  const d = montarDashboard({ pedidos, periodo, linhaDoTempo: linhaDoTempoDasMetas(versoes), etapa, primeiroPedidoEm, fuso });
  d.periodo.fusoOrigem = fusoOrigem;
  if (!metasDisponiveis) d.qualidade.avisos.unshift("As metas da unidade ainda não podem ser lidas neste ambiente (migration 127 pendente): nenhum pedido foi avaliado contra meta.");
  const analises = gerarAnalises(d);
  return {
    versao: VERSAO_CONTRATO,
    servidorEm: new Date(agoraMs).toISOString(),
    ...paraResposta(d),
    analises,
  };
}

/** Fuso IANA da unidade (D-15) — repositório sem a função (testes antigos) ou sem a coluna = null. Nunca lança. */
export async function fusoDaUnidade(r, { organizacaoId, unidadeId }) {
  if (typeof r?.obterFusoDaUnidade !== "function") return null;
  try { return (await r.obterFusoDaUnidade({ organizacaoId, unidadeId })) ?? null; } catch { return null; }
}

/** Nome da unidade do contexto (cabeçalho do relatório). Nunca lança. */
export async function nomeDaUnidade({ organizacaoId, unidadeId, deps = {} }) {
  const r = deps.repo ?? repo;
  try { return (await r.obterNomeUnidade?.({ organizacaoId, unidadeId })) ?? null; } catch { return null; }
}
