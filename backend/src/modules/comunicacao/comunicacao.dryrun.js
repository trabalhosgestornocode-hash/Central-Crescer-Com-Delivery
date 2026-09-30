// SIMULAÇÃO ADMINISTRATIVA (DRY-RUN) do motor de alertas — 100% SOMENTE LEITURA.
//
// Percorre o MESMO caminho de decisão do envio real (alerta detectado → empresa elegível → destinatário elegível → horário → cooldown → limites →
// idempotência → mensagem gerada) e mostra o que SERIA enviado — mas:
//   * NÃO cria alerta, NÃO cria mensagem, NÃO consome idempotência, NÃO incrementa limite, NÃO altera cooldown, NÃO cria retry;
//   * NÃO toca em `ultimo envio` e NÃO chama o provider (nem importa o whatsapp.service): a fronteira do provider é inalcançável daqui;
//   * NÃO escreve NADA no banco (só SELECT/RPC de leitura). Registrar que alguém rodou o dry-run é do chamador (auditoria administrativa genérica).
//
// Vale mesmo com `modo = DISABLED` (DISABLED + dry-run = permitido; DISABLED + envio real = proibido). O resultado informa `envioRealPermitido`.
//
// Reaproveita as funções PURAS do pipeline (horário, disponibilidade, template, habilitação) — nenhuma regra é reescrita aqui. Os limites são avaliados
// com os mesmos critérios de comunicacao_reservar_envio, sobre o estado ATUAL (instante `agora`).

import { pendencias as lerPendenciasReal } from "../administrativo/administrativo.service.js";
import * as alertasRepo from "./comunicacao.alertas.repo.js";
import * as filaRepo from "./comunicacao.fila.repo.js";
import * as dryRunRepo from "./comunicacao.dryrun.repo.js";
import { obterConfig, modoAtual as lerModoAtual, obterTtlHoras, obterJitterMaxMs, obterDisponibilidadeIfood } from "./comunicacao.config.js";
import { resolverHabilitacaoEmpresa, janelasEfetivas } from "./comunicacao.habilitacao.js";
import { avaliarDisponibilidadeD1, calcularInstanteDeEnvio } from "./comunicacao.disponibilidade.js";
import { dentroDaJanelaLocal, inicioDoDiaLocal, ConfiguracaoHorarioInvalida } from "./comunicacao.horario.js";
import { chaveDeJitter } from "./comunicacao.adiamento.js";
import { formatarMensagemPendencia } from "./comunicacao.template.js";
import { chaveIdempotenciaDestinatario, prazoD1VenceHoje, PROPOSITO, propositoDaMensagem } from "./comunicacao.reforco.js";
import { mascararTelefone } from "./comunicacao.contatos.repo.js";
import { TIPOS_ALERTA, SEVERIDADE, modoPermiteEnvioReal } from "./comunicacao.constants.js";

const HORA = 3_600_000;
const numeroOuPadrao = (v, p) => (v !== null && v !== "" && v !== undefined && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : p);

export const ETAPAS = Object.freeze([
  "ALERTA_DETECTADO", "EMPRESA_ELEGIVEL", "DESTINATARIO_ELEGIVEL", "HORARIO", "COOLDOWN", "LIMITE_DESTINATARIO_DIA", "LIMITE_ORGANIZACAO_DIA", "IDEMPOTENCIA",
  "MENSAGEM_GERADA", "ENVIO_BLOQUEADO_PELO_DRY_RUN",
]);
const etapa = (nome, ok, detalhe = null) => ({ etapa: nome, ok, detalhe });

/**
 * @param {{organizacaoId?: string|null, agora?: Date, lerPendencias?: Function, resolverHabilitacao?: Function, resolverDestinatarios?: Function, modo?: string}} [params]
 */
export async function simularCiclo({
  organizacaoId = null, agora = new Date(), lerPendencias = lerPendenciasReal, resolverHabilitacao = resolverHabilitacaoEmpresa,
  resolverDestinatarios = filaRepo.resolverDestinatarios, lerModo = lerModoAtual,
} = {}, deps = {}) {
  const tipoAlerta = TIPOS_ALERTA.DASHBOARD_IFOOD_D1;
  const [modo, snapshot, janelasGlobais, cooldowns, limites, ttlHoras, jitterMaxMs, disponibilidade, ativos] = await Promise.all([
    lerModo(deps), lerPendencias({}, deps), obterConfig("janelas", deps), obterConfig("cooldowns_horas", deps), obterConfig("limites", deps),
    obterTtlHoras(deps), obterJitterMaxMs(deps), obterDisponibilidadeIfood(deps),
    alertasRepo.listarAlertasAtivos({ organizacaoId, tipoAlerta }, deps),
  ]);
  const alertaPorUnidade = new Map(ativos.map((a) => [`${a.organizacao_id}|${a.unidade_id}`, a]));

  const habCache = new Map();
  const destCache = new Map();
  const identidadeCache = new Map();
  const consumoContatoCache = new Map();
  const consumoEmpresaCache = new Map();
  const habDe = async (org) => { if (!habCache.has(org)) habCache.set(org, await resolverHabilitacao({ organizacaoId: org, tipoAlerta, agora }, deps)); return habCache.get(org); };
  const destDe = async (org) => { if (!destCache.has(org)) destCache.set(org, await resolverDestinatarios({ organizacaoId: org, tipoAlerta }, deps)); return destCache.get(org); };
  const identidadesDe = async (org, alertaId) => {
    if (!alertaId) return [];
    const chave = `${org}|${alertaId}`;
    if (!identidadeCache.has(chave)) identidadeCache.set(chave, await dryRunRepo.listarIdentidadesDoAlerta({ organizacaoId: org, alertaId }, deps));
    return identidadeCache.get(chave);
  };
  const consumoContato = async (contatoId, inicioDia) => {
    const chave = `${contatoId}|${inicioDia.toISOString()}`;
    if (!consumoContatoCache.has(chave)) consumoContatoCache.set(chave, await dryRunRepo.contarConsumoContato({ contatoId, inicioDia }, deps));
    return consumoContatoCache.get(chave);
  };
  const consumoEmpresa = async (org, inicioDia) => {
    const chave = `${org}|${inicioDia.toISOString()}`;
    if (!consumoEmpresaCache.has(chave)) consumoEmpresaCache.set(chave, await dryRunRepo.contarConsumoEmpresa({ organizacaoId: org, inicioDia }, deps));
    return consumoEmpresaCache.get(chave);
  };

  const unidades = (snapshot.unidades ?? [])
    .filter((u) => (u.criticidade === SEVERIDADE.ATENCAO || u.criticidade === SEVERIDADE.CRITICO) && (!organizacaoId || u.organizacaoId === organizacaoId));

  const alertas = [];
  for (const u of unidades) {
    const dataReferencia = u.pendenciaMaisAntiga ?? snapshot.d1 ?? null;
    const existente = alertaPorUnidade.get(`${u.organizacaoId}|${u.unidadeId}`) ?? null;
    const item = {
      alerta_detectado: {
        organizacaoId: u.organizacaoId, unidadeId: u.unidadeId, unidade: u.unidadeNome ?? null, empresa: u.empresaNome ?? null,
        severidade: u.criticidade, dataReferencia, alertaJaPersistido: !!existente, statusAlertaPersistido: existente?.status ?? null,
      },
      empresa_elegivel: false, motivos_empresa: [],
      destinatarios_avaliados: 0, destinatarios_elegiveis: 0, destinatarios_bloqueados: [],
      destinatarios: [], mensagens_que_seriam_geradas: [], horarios_estimados: [],
    };
    alertas.push(item);
    if (!dataReferencia) { item.motivos_empresa.push("SEM_DATA_DE_REFERENCIA"); continue; }

    // ---- EMPRESA ----
    const hab = await habDe(u.organizacaoId);
    if (hab.empresaHabilitada !== true) item.motivos_empresa.push("EMPRESA_DESABILITADA");
    else {
      if (hab.tipoPermitido !== true) item.motivos_empresa.push("TIPO_NAO_PERMITIDO");
      if (hab.envioAutomatico !== true) item.motivos_empresa.push("ENVIO_AUTOMATICO_DESLIGADO");
      if (hab.configHorarioValida !== true) item.motivos_empresa.push("CONFIG_HORARIO_INVALIDA");
      if (hab.empresaPausada === true) item.motivos_empresa.push("EMPRESA_PAUSADA");
    }
    item.empresa_elegivel = item.motivos_empresa.length === 0;

    // ---- DESTINATÁRIOS (todos, com o motivo do bloqueio) ----
    const todos = hab.empresaHabilitada === true ? await destDe(u.organizacaoId) : [];
    item.destinatarios_avaliados = todos.length;
    const elegiveis = todos.filter((d) => d.elegivel === true);
    item.destinatarios_elegiveis = elegiveis.length;
    item.destinatarios_bloqueados = todos.filter((d) => d.elegivel !== true)
      .map((d) => ({ destinatarioId: d.contato_empresa_id, nome: d.nome, telefone: mascararTelefone(d.telefone), motivo: d.motivo }));
    if (hab.empresaHabilitada === true && todos.length === 0) item.motivos_empresa.push("SEM_DESTINATARIOS");
    else if (hab.empresaHabilitada === true && elegiveis.length === 0) item.motivos_empresa.push("SEM_DESTINATARIOS_ELEGIVEIS");
    item.empresa_elegivel = item.motivos_empresa.length === 0;

    const janelas = hab.empresaHabilitada === true ? janelasEfetivas(hab, janelasGlobais) : null;
    if (item.empresa_elegivel && !janelas) item.motivos_empresa.push("CONFIG_HORARIO_INVALIDA");
    item.empresa_elegivel = item.motivos_empresa.length === 0;
    let disp = null;
    if (item.empresa_elegivel && janelas) {
      try { disp = avaliarDisponibilidadeD1({ dataReferencia, agora, timezone: hab.timezone, config: disponibilidade }); }
      catch (e) { if (!(e instanceof ConfiguracaoHorarioInvalida)) throw e; item.motivos_empresa.push("CONFIG_HORARIO_INVALIDA"); }
    }
    item.empresa_elegivel = item.motivos_empresa.length === 0;

    const conteudo = formatarMensagemPendencia({ unidadeNome: u.unidadeNome ?? null, pendenciaMaisAntiga: dataReferencia });
    const mensagens = item.empresa_elegivel ? await identidadesDe(u.organizacaoId, existente?.id) : [];
    const inicioDia = hab.timezone && item.empresa_elegivel ? inicioDoDiaLocal(agora, hab.timezone) : null;

    for (const d of todos) {
      const passos = [
        etapa("ALERTA_DETECTADO", true, `${u.criticidade} · ${dataReferencia}`),
        etapa("EMPRESA_ELEGIVEL", item.empresa_elegivel, item.empresa_elegivel ? null : item.motivos_empresa.join(",")),
        etapa("DESTINATARIO_ELEGIVEL", d.elegivel === true, d.elegivel === true ? null : d.motivo),
      ];
      const saida = { destinatarioId: d.contato_empresa_id, nome: d.nome, telefone: mascararTelefone(d.telefone), elegivel: d.elegivel === true, passos };
      item.destinatarios.push(saida);
      if (!item.empresa_elegivel || d.elegivel !== true || !janelas) continue;

      // HORÁRIO — mesma função do agendamento real (disponibilidade do D-1 + janela da empresa + jitter determinístico DESTE destinatário)
      const chave = chaveIdempotenciaDestinatario({ alertaId: existente?.id ?? `simulado:${u.organizacaoId}:${u.unidadeId}:${dataReferencia}`, contatoEmpresaId: d.contato_empresa_id });
      let instante = null;
      if (disp && !disp.disponivel) passos.push(etapa("HORARIO", false, "AGUARDANDO_DISPONIBILIDADE_IFOOD"));
      else {
        try {
          instante = calcularInstanteDeEnvio({
            base: hab.empresaPausada === true && hab.pausadoAte ? hab.pausadoAte : agora, timezone: hab.timezone, janelas, dataReferencia, disponibilidade,
            chave: chaveDeJitter({ idempotencyKey: chave, dataLogica: dataReferencia, organizacaoId: u.organizacaoId }), spreadMaxMs: jitterMaxMs,
          });
          const foraDoExpediente = prazoD1VenceHoje(dataReferencia, agora, hab.timezone) && instante.getTime() - agora.getTime() > 12 * HORA;
          passos.push(etapa("HORARIO", !foraDoExpediente, foraDoExpediente ? "AGUARDA_JANELA_TARDIA_20H_22H" : `${dentroDaJanelaLocal(instante, hab.timezone, janelas) ? "dentro da janela" : "fora da janela"} · ${instante.toISOString()}`));
          if (foraDoExpediente) instante = null;
        } catch (e) {
          if (!(e instanceof ConfiguracaoHorarioInvalida)) throw e;
          passos.push(etapa("HORARIO", false, "CONFIG_HORARIO_INVALIDA"));
        }
      }
      if (!instante) continue;

      // COOLDOWN e LIMITES — mesmos critérios de comunicacao_reservar_envio, sobre o estado ATUAL, SEM reservar nada
      const cooldownH = hab.cooldownMinutos ? hab.cooldownMinutos / 60 : numeroOuPadrao(cooldowns?.[u.criticidade] ?? cooldowns?.atencao, 8);
      const [emCooldown, usadasDest, usadasOrg] = await Promise.all([dryRunRepo.contatoEmCooldown({
        organizacaoId: u.organizacaoId, unidadeId: u.unidadeId, tipoAlerta, contatoId: d.contato_id,
        desde: new Date(agora.getTime() - cooldownH * HORA),
      }, deps), consumoContato(d.contato_id, inicioDia), consumoEmpresa(u.organizacaoId, inicioDia)]);
      passos.push(etapa("COOLDOWN", !emCooldown, emCooldown ? `dentro de ${cooldownH}h do último envio a este destinatário` : null));
      const maxDest = numeroOuPadrao(limites?.max_por_contato_por_dia, 3);
      passos.push(etapa("LIMITE_DESTINATARIO_DIA", usadasDest < maxDest, `${usadasDest}/${maxDest} hoje`));
      const maxOrg = hab.limiteDiarioOrg ?? numeroOuPadrao(limites?.max_por_organizacao_por_dia, 20);
      passos.push(etapa("LIMITE_ORGANIZACAO_DIA", usadasOrg < maxOrg, `${usadasOrg}/${maxOrg} hoje`));

      // IDEMPOTÊNCIA — já existe mensagem deste destinatário para este alerta (nunca consumida aqui)
      const jaExiste = existente ? mensagens.some((m) => m.alerta_id === existente.id && propositoDaMensagem(m) === PROPOSITO.INICIAL
        && (m.contato_empresa_id === d.contato_empresa_id || (!m.contato_empresa_id && m.contato_id === d.contato_id))) : false;
      passos.push(etapa("IDEMPOTENCIA", !jaExiste, jaExiste ? "já existe mensagem inicial deste destinatário para este alerta" : null));

      const bloqueadoAntes = passos.some((p) => p.ok === false);
      passos.push(etapa("MENSAGEM_GERADA", !bloqueadoAntes, bloqueadoAntes ? null : conteudo));
      passos.push(etapa("ENVIO_BLOQUEADO_PELO_DRY_RUN", true, "nenhuma mensagem criada e nenhuma chamada ao provider"));
      if (!bloqueadoAntes) {
        item.mensagens_que_seriam_geradas.push({ destinatarioId: d.contato_empresa_id, nome: d.nome, telefone: mascararTelefone(d.telefone), texto: conteudo, horarioEstimado: instante.toISOString(), expiraEm: new Date(instante.getTime() + ttlHoras * HORA).toISOString() });
        item.horarios_estimados.push({ destinatarioId: d.contato_empresa_id, horarioEstimado: instante.toISOString() });
      }
    }
  }

  const resumo = {
    alertasDetectados: alertas.length,
    empresasElegiveis: new Set(alertas.filter((a) => a.empresa_elegivel).map((a) => a.alerta_detectado.organizacaoId)).size,
    destinatariosAvaliados: alertas.reduce((n, a) => n + a.destinatarios_avaliados, 0),
    destinatariosElegiveis: alertas.reduce((n, a) => n + a.destinatarios_elegiveis, 0),
    mensagensQueSeriamGeradas: alertas.reduce((n, a) => n + a.mensagens_que_seriam_geradas.length, 0),
  };
  return {
    dryRun: true, geradoEm: agora.toISOString(), modoGlobal: modo, envioRealPermitido: modoPermiteEnvioReal(modo),
    providerChamado: false, mensagensCriadas: 0, alertasCriados: 0,
    resumo, alertas,
  };
}
