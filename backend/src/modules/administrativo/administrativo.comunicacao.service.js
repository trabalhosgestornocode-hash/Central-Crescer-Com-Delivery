// PAINEL ADMINISTRATIVO — Comunicação/WhatsApp (Checkpoint H.3-A).
//
// Camada de regra/projeção para a UI. NÃO decide política de envio (isso é
// comunicacao.policy.js), NÃO cria mensagem (o pipeline de alertas do módulo
// comunicacao/), NÃO chama o provider — só lê e projeta para o gestor, com
// uma única exceção de escrita (atualizarConfiguracao), que é hard-fail-closed
// (ver abaixo).
//
// PENDÊNCIA vem de administrativo.service.js#pendencias() — a MESMA fonte do
// resto do Painel Administrativo e do próprio motor de alertas (o mesmo
// detectarESincronizarAlertas de comunicacao/). Nunca recalculada aqui.
//
// (Este arquivo NÃO importa o pipeline de orquestração de alertas — só a
// fonte de pendência já compartilhada, o template de texto puro (sem
// orquestração) e a allowlist do piloto (H.4-A). Ver o teste arquitetural
// em comunicacao-arquitetura-agendamento.test.js, que barra qualquer import
// desse pipeline fora do worker dedicado — nenhum import deste arquivo o viola.)

import { ApiError } from "../../shared/ApiError.js";
import * as v from "../../shared/validar.js";
import * as repo from "./administrativo.comunicacao.repo.js";
import { pendencias as lerPendencias } from "./administrativo.service.js";
import { modoAtual } from "../comunicacao/comunicacao.config.js";
import { TIPOS_ALERTA } from "../comunicacao/comunicacao.constants.js";
import { timezoneValido } from "../comunicacao/comunicacao.horario.js";
import { formatarMensagemPendencia } from "../comunicacao/comunicacao.template.js";
import { telefoneAutorizadoNoPiloto } from "../comunicacao/comunicacao.piloto.js";

const TIPOS_ALERTA_VALIDOS = Object.values(TIPOS_ALERTA);

/**
 * Estado do worker embutido — LIMITAÇÃO CONHECIDA E DOCUMENTADA: o worker
 * (backend/src/worker-comunicacao/lifecycle.js) mantém seu estado real
 * (IDLE/RUNNING/DISABLED/ERROR) só em memória DENTRO do próprio processo, e
 * este checkpoint não pode alterar nenhum arquivo de worker-comunicacao/**
 * para expor um getter. Por isso, o painel só consegue reportar a
 * CONFIGURAÇÃO (a flag `COMUNICACAO_WORKER_ENABLED`), não a confirmação de
 * que o laço está de fato rodando saudável nesta instância — e, em rolling
 * deploy, podem existir 2 instâncias com processos diferentes ao mesmo
 * tempo, cada uma com seu próprio estado local. Ver docs do checkpoint.
 */
function estadoWorkerLocal() {
  const habilitadoPorFlag = process.env.COMUNICACAO_WORKER_ENABLED === "true";
  // "habilitado", nunca "ativo": é uma leitura de CONFIGURAÇÃO (a env var),
  // não uma confirmação de que o laço está de fato rodando/saudável — ver
  // Checkpoint H.3-A.1, item 1. Health distribuído real fica como evolução
  // futura (exigiria tocar worker-comunicacao/**, fora de escopo aqui).
  return { estado: habilitadoPorFlag ? "habilitado" : "desabilitado", fonte: "configuracao_processo_local" };
}

const rotuloModo = (modo) => (modo === "NORMAL" ? "ATIVA" : modo === "REACTIVE_ONLY" ? "SOMENTE_REATIVA" : "PAUSADA");

/** GET /administrativo/comunicacao/resumo */
export async function resumo(deps = {}) {
  const [gateway, modo, totalOrgs, orgsHabilitadas, porStatus] = await Promise.all([
    repo.obterEstadoGateway(deps),
    modoAtual(deps),
    repo.contarOrganizacoesTotal(deps),
    repo.contarOrganizacoesHabilitadas(deps),
    repo.contarMensagensPorStatus(deps),
  ]);
  const linhas = await repo.listarOrganizacoesComConfiguracao({}, deps);
  const configuradas = linhas.filter((o) => !!o.comunicacao_habilitacoes).length;
  const pausadas = linhas.filter((o) => {
    const ate = o.comunicacao_habilitacoes?.pausado_ate;
    return ate && new Date(ate).getTime() > Date.now();
  }).length;

  // JANELA MÓVEL real (agora-24h .. agora), NUNCA truncada em meia-noite UTC
  // e NUNCA no fuso de uma organização específica — o card é global e
  // determinístico independente de quem está olhando (Checkpoint H.3-A.1,
  // itens 7/8). Antes disto, "falhas hoje" na verdade lia o total histórico
  // de FAILED (nunca esteve de fato recortado por tempo) — corrigido aqui.
  const ultimas24h = await repo.contarUltimas24h(deps);

  return {
    gateway,
    worker: estadoWorkerLocal(),
    comunicacao: { modo, rotulo: rotuloModo(modo) },
    empresas: { total: totalOrgs, configuradas, habilitadas: orgsHabilitadas, pausadas },
    fila: {
      scheduled: porStatus.SCHEDULED ?? 0, processing: porStatus.PROCESSING ?? 0, sending: porStatus.SENDING ?? 0,
      deliveryUnknown: porStatus.DELIVERY_UNKNOWN ?? 0, failed: porStatus.FAILED ?? 0,
    },
    ultimas24h: { enviadas: ultimas24h.enviadas, falhas: ultimas24h.falhas },
  };
}

function statusConfiguracao(hab) {
  if (!hab) return "NAO_CONFIGURADA";
  const pausada = hab.pausado_ate && new Date(hab.pausado_ate).getTime() > Date.now();
  const completo = !!(hab.timezone && hab.destinatario_contato_id && hab.destinatario_perfil_id && hab.tipos_permitidos?.length);
  if (pausada) return "PAUSADA";
  if (hab.habilitado === true) return "HABILITADA"; // nunca deve ocorrer nesta fase — mantido só como projeção honesta do dado real
  return completo ? "PRONTA_PARA_PILOTO" : "CONFIGURACAO_INCOMPLETA";
}

/** GET /administrativo/comunicacao/organizacoes?busca= */
export async function organizacoes({ busca } = {}, deps = {}) {
  const [linhas, snapshot, atividade] = await Promise.all([
    repo.listarOrganizacoesComConfiguracao({ busca }, deps),
    lerPendencias({}, deps),
    repo.obterAtividadeRecentePorOrganizacao(deps),
  ]);
  const pendenciasPorOrg = new Map();
  for (const u of snapshot.unidades ?? []) {
    if (u.criticidade !== "critico" && u.criticidade !== "atencao") continue;
    pendenciasPorOrg.set(u.organizacaoId, (pendenciasPorOrg.get(u.organizacaoId) ?? 0) + 1);
  }

  return linhas.map((o) => {
    const hab = o.comunicacao_habilitacoes ?? null;
    return {
      organizacaoId: o.id,
      nome: o.nome,
      status: statusConfiguracao(hab),
      destinatarioConfigurado: !!(hab?.destinatario_contato_id && hab?.destinatario_perfil_id),
      timezoneConfigurado: !!hab?.timezone,
      pausada: !!(hab?.pausado_ate && new Date(hab.pausado_ate).getTime() > Date.now()),
      pendenciasAtuais: pendenciasPorOrg.get(o.id) ?? 0,
      ultimoEnvioEm: atividade.ultimoPorOrg.get(o.id) ?? null,
      proximoEnvioEm: atividade.proximoPorOrg.get(o.id) ?? null,
    };
  });
}

/** GET /administrativo/comunicacao/organizacoes/:organizacaoId */
export async function detalheOrganizacao({ organizacaoId } = {}, deps = {}) {
  const orgId = v.uuid(organizacaoId, "Empresa");
  const [org, snapshot, modo] = await Promise.all([
    repo.obterOrganizacaoComConfiguracao(orgId, deps),
    lerPendencias({}, deps),
    modoAtual(deps),
  ]);
  if (!org) throw ApiError.notFound("Empresa não encontrada.");

  const hab = org.comunicacao_habilitacoes ?? null;
  const [contato, perfil] = await Promise.all([
    hab?.destinatario_contato_id ? repo.obterContato(hab.destinatario_contato_id, deps) : null,
    hab?.destinatario_perfil_id ? repo.obterPerfilOperacional(hab.destinatario_perfil_id, deps) : null,
  ]);

  const unidadesDaOrg = (snapshot.unidades ?? []).filter((u) => u.organizacaoId === orgId);

  return {
    organizacao: { organizacaoId: org.id, nome: org.nome, status: org.status },
    configuracao: {
      status: statusConfiguracao(hab),
      timezone: hab?.timezone ?? null,
      tiposPermitidos: hab?.tipos_permitidos ?? [],
      pausadoAte: hab?.pausado_ate ?? null,
      pausadoMotivo: hab?.pausado_motivo ?? null,
      destinatario: contato ? {
        telefoneMascarado: repo.mascararTelefone(contato.telefone_e164),
        verificado: contato.verificado, consentimento: contato.consentimento, optOut: contato.opt_out,
        perfilOperacionalId: hab?.destinatario_perfil_id ?? null, // para pré-selecionar no combobox do frontend
        perfilAtivo: perfil?.ativo ?? null,
      } : null,
      atualizadoEm: hab?.updated_at ?? null,
    },
    // Checklist de prontidão para piloto (H.4-A, itens 34-36) — 100% DERIVADO
    // dos dados reais acima, nenhuma coluna nova de banco. `allowlistPiloto`
    // é só o booleano (nunca a lista crua — comunicacao.piloto.js já não
    // expõe o valor bruto do telefone em nenhum log; aqui é a mesma
    // disciplina). `organizacaoHabilitada`/`comunicacaoGlobalAtiva` são
    // sempre `false` hoje (habilitado=false hard-coded, modo=DISABLED) —
    // nunca hardcoded no código, sempre lidos dos valores reais.
    checklistPiloto: {
      perfilAssociado: !!(hab?.destinatario_contato_id && hab?.destinatario_perfil_id),
      telefoneValido: !!contato?.telefone_e164,
      consentimento: contato?.consentimento === true,
      telefoneVerificado: contato?.verificado === true,
      timezone: !!hab?.timezone,
      tipoAlerta: !!(hab?.tipos_permitidos?.length),
      allowlistPiloto: telefoneAutorizadoNoPiloto(contato?.telefone_e164 ?? null),
      organizacaoHabilitada: hab?.habilitado === true,
      comunicacaoGlobalAtiva: modo === "NORMAL",
    },
    unidades: unidadesDaOrg.map((u) => ({
      unidadeId: u.unidadeId, unidadeNome: u.unidadeNome, criticidade: u.criticidade, diasPendentes: u.diasPendentes ?? 0,
    })),
    tiposAlertaDisponiveis: TIPOS_ALERTA_VALIDOS,
  };
}

/**
 * GET /administrativo/comunicacao/organizacoes/:organizacaoId/preview-mensagem
 *
 * Checkpoint H.4-A, itens 15-18: SOMENTE LEITURA — monta o texto EXATO que
 * seria enviado, usando a MESMA função de template do pipeline real
 * (comunicacao.template.js#formatarMensagemPendencia, nunca duplicada) sobre
 * uma pendência REAL de `pendencias()` (nunca inventada). Não cria
 * `comunicacao_mensagens`, não cria `comunicacao_tentativas`, não chama o
 * provider, não altera fila/status, não audita como envio — é leitura pura.
 * Sem pendência real disponível: `disponivel: false` (nunca inventa dado).
 */
export async function preverMensagem({ organizacaoId, unidadeId } = {}, deps = {}) {
  const orgId = v.uuid(organizacaoId, "Empresa");
  const [org, snapshot] = await Promise.all([
    repo.obterOrganizacaoComConfiguracao(orgId, deps),
    lerPendencias({}, deps),
  ]);
  if (!org) throw ApiError.notFound("Empresa não encontrada.");

  const pendentes = (snapshot.unidades ?? []).filter((u) => u.organizacaoId === orgId
    && (u.criticidade === "critico" || u.criticidade === "atencao")
    && (!unidadeId || u.unidadeId === unidadeId));
  if (!pendentes.length) return { disponivel: false, motivo: "Nenhuma pendência real disponível para esta empresa agora." };

  // Mais crítica primeiro, depois a mais antiga — mesma ordem de prioridade que um operador escolheria.
  const alvo = pendentes.sort((a, b) => (a.criticidade === b.criticidade ? 0 : a.criticidade === "critico" ? -1 : 1))[0];
  const texto = formatarMensagemPendencia({
    unidadeNome: alvo.unidadeNome ?? null,
    diasPendentes: alvo.diasPendentes ?? 1, pendenciaMaisAntiga: alvo.pendenciaMaisAntiga ?? null,
  });
  return {
    disponivel: true, texto,
    unidadeId: alvo.unidadeId, unidadeNome: alvo.unidadeNome ?? null,
    criticidade: alvo.criticidade, diasPendentes: alvo.diasPendentes ?? 0,
  };
}

/**
 * GET /administrativo/comunicacao/organizacoes/:organizacaoId/perfis-elegiveis
 *
 * Checkpoint H.3-A.1, itens 3-6: o drawer não pode mais pedir um UUID de
 * perfil em texto livre. Só perfis com vínculo ATIVO nesta organização
 * (mesmo critério de elegibilidade que `comunicacao_agendar_mensagem_alerta`
 * e `perfilTemVinculo` já exigem no banco) aparecem aqui — o frontend nunca
 * vê perfis de outra organização, e mesmo que um ID de outra organização
 * seja enviado manualmente na escrita, o backend/banco continuam recusando
 * (ver `atualizarConfiguracao`/constraint de vínculo — nenhuma mudança ali).
 */
export async function perfisElegiveis({ organizacaoId } = {}, deps = {}) {
  const orgId = v.uuid(organizacaoId, "Empresa");
  const org = await repo.obterOrganizacaoComConfiguracao(orgId, deps);
  if (!org) throw ApiError.notFound("Empresa não encontrada.");
  return repo.listarPerfisElegiveis(orgId, deps);
}

/**
 * PUT /administrativo/comunicacao/organizacoes/:organizacaoId/configuracao
 *
 * GATE DE SEGURANÇA (Checkpoint H.3-A, itens 20/21) — não confia na UI: se o
 * payload trouxer `habilitado` com qualquer valor diferente de `false`
 * (inclusive `true`, `"true"`, `1`), a requisição INTEIRA é recusada com 400
 * ANTES de tocar o banco. Isto é a defesa #2; a #1 é o repo nunca aceitar
 * esse parâmetro (ver administrativo.comunicacao.repo.js).
 */
export async function atualizarConfiguracao({
  organizacaoId, habilitado, telefoneE164, perfilOperacionalId, timezone, tiposPermitidos, pausadoAte, pausadoMotivo,
} = {}, autor, deps = {}) {
  const orgId = v.uuid(organizacaoId, "Empresa");
  if (habilitado !== undefined && habilitado !== false) {
    throw ApiError.badRequest("Habilitação de envio não é permitida neste checkpoint (H.3-A é somente configuração).", { codigo: "HABILITACAO_NAO_PERMITIDA" });
  }
  if (timezone !== undefined && timezone !== null && !timezoneValido(timezone)) {
    throw ApiError.badRequest("Timezone inválido (precisa ser um nome IANA reconhecido).", { codigo: "TIMEZONE_INVALIDO" });
  }
  if (tiposPermitidos !== undefined) {
    if (!Array.isArray(tiposPermitidos) || tiposPermitidos.some((t) => !TIPOS_ALERTA_VALIDOS.includes(t))) {
      throw ApiError.badRequest(`tiposPermitidos inválido. Aceito: ${TIPOS_ALERTA_VALIDOS.join(", ")}.`, { codigo: "TIPO_ALERTA_INVALIDO" });
    }
  }
  if (perfilOperacionalId !== undefined && perfilOperacionalId !== null) v.uuid(perfilOperacionalId, "Perfil");

  const atualizado = await repo.atualizarConfiguracaoOrganizacao({
    organizacaoId: orgId, telefoneE164, perfilOperacionalId: perfilOperacionalId ?? undefined,
    timezone, tiposPermitidos, pausadoAte, pausadoMotivo,
  }, autor, deps);

  return { organizacaoId: orgId, status: statusConfiguracao(atualizado), atualizadoEm: atualizado.updated_at };
}

/** GET /administrativo/comunicacao/fila */
export async function fila({ organizacaoId, status, pagina, porPagina } = {}, deps = {}) {
  if (organizacaoId) v.uuid(organizacaoId, "Empresa");
  return repo.listarFila({ organizacaoId, status, pagina, porPagina }, deps);
}

/** GET /administrativo/comunicacao/historico */
export async function historico({ organizacaoId, status, tipoAlerta, desde, ate, pagina, porPagina } = {}, deps = {}) {
  if (organizacaoId) v.uuid(organizacaoId, "Empresa");
  return repo.listarHistorico({ organizacaoId, status, tipoAlerta, desde, ate, pagina, porPagina }, deps);
}
