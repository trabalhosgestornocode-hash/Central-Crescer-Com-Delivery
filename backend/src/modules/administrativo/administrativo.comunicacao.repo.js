// PAINEL ADMINISTRATIVO — camada de I/O da área de Comunicação/WhatsApp
// (Checkpoint H.3-A). SÓ LEITURA, exceto `atualizarConfiguracaoOrganizacao` —
// a ÚNICA escrita, e ela é hard-coded para NUNCA habilitar envio (ver seção
// própria abaixo). Usa `supabase` (service_role) igual ao resto do painel:
// cross-tenant por AUTORIZAÇÃO explícita (`requirePainelAdministrativo`), não
// por bypass dos middlewares multi-tenant.
//
// NÃO duplica nenhuma regra de negócio do módulo `comunicacao/`: reaproveita
// `mascararTelefone`/`obterContato` de `comunicacao.contatos.repo.js` e o cadastro de responsável por EMPRESA de
// `comunicacao.contatosEmpresa.repo.js` tal como estão. Este arquivo só sabe
// LISTAR/PROJETAR para o painel — nunca decide política, claim, rate-limit,
// cooldown, horário ou envio.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import { mascararTelefone, obterContato, obterPerfilOperacional } from "../comunicacao/comunicacao.contatos.repo.js";
import { listarDaEmpresa as listarContatosDaEmpresa, escolherPrincipal, validarWhatsApp } from "../comunicacao/comunicacao.contatosEmpresa.repo.js";
import { auditar, ACOES } from "../../shared/auditoria.js";

const COLUNAS_HABILITACAO = "organizacao_id, habilitado, envio_automatico, envio_automatico_atualizado_em, limite_diario_org, cooldown_minutos, tipos_permitidos, timezone, janelas, pausado_ate, pausado_motivo, destinatario_contato_id, destinatario_contato_empresa_id, destinatario_perfil_id, atualizado_por, created_at, updated_at";

// Estados possíveis de `whatsapp_conexoes.status` (migration 083) — vocabulário fechado, nunca inventado aqui.
const GATEWAY_CONECTADO = new Set(["CONNECTED"]);
const JANELA_INSTAVEL_MS = 2 * 60_000; // sem heartbeat há mais de 2min com status CONNECTED = não confiar mais no valor

/**
 * Estado do Gateway, SANITIZADO — nunca detalhe interno (auth-state, lease,
 * socketGeneration, marker...). Lê a conexão mais recente conhecida; hoje só
 * existe uma sessão Baileys ativa na plataforma inteira (não é per-tenant na
 * prática, mesmo a tabela sendo `organizacao_id`-scoped).
 * @returns {Promise<{estado: "conectado"|"desconectado"|"instavel"|"desconhecido", ultimoContatoEm: string|null}>}
 */
export async function obterEstadoGateway(deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("whatsapp_conexoes")
    .select("status, last_seen_at, updated_at, lease_expires_at")
    .order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!data) return { estado: "desconhecido", ultimoContatoEm: null, leaseValida: null };

  const heartbeat = data.last_seen_at ? new Date(data.last_seen_at) : null;
  const stale = !heartbeat || Number.isNaN(heartbeat.getTime()) || (Date.now() - heartbeat.getTime()) > JANELA_INSTAVEL_MS;
  const estado = GATEWAY_CONECTADO.has(data.status) ? (stale ? "instavel" : "conectado") : "desconectado";
  // H.4-B.5 — só um booleano derivado (nunca owner/epoch/auth-state): a lease vigente no relógio do backend.
  const expira = data.lease_expires_at ? new Date(data.lease_expires_at).getTime() : null;
  return { estado, ultimoContatoEm: data.last_seen_at ?? null, leaseValida: expira != null && Number.isFinite(expira) ? expira > Date.now() : null };
}

/** @returns {Promise<number>} total de organizações (universo do painel, não só as monitoradas por um alerta). */
export async function contarOrganizacoesTotal(deps = {}) {
  const db = deps.supabase ?? supabase;
  const { count, error } = await db.from("organizacoes").select("id", { count: "exact", head: true });
  if (error) throw ApiError.internal(error.message);
  return count ?? 0;
}

/**
 * Todas as organizações + sua linha de `comunicacao_habilitacoes` (se
 * existir) — DUAS queries em lote + merge em JS (nunca `for organizacao:
 * SELECT`), mesmo espírito de administrativo.repo.js. Evita depender de
 * embed do PostgREST (mais simples de testar com um fake determinístico).
 * @param {{busca?: string}} [filtro]
 */
export async function listarOrganizacoesComConfiguracao({ busca } = {}, deps = {}) {
  const db = deps.supabase ?? supabase;
  let q = db.from("organizacoes").select("id, nome, status").order("nome", { ascending: true });
  if (busca) q = q.ilike("nome", `%${busca}%`);
  const { data: orgs, error: e1 } = await q;
  if (e1) throw ApiError.internal(e1.message);
  if (!orgs?.length) return [];

  const { data: habs, error: e2 } = await db.from("comunicacao_habilitacoes")
    .select(COLUNAS_HABILITACAO).in("organizacao_id", orgs.map((o) => o.id));
  if (e2) throw ApiError.internal(e2.message);
  const habPorOrg = new Map((habs ?? []).map((h) => [h.organizacao_id, h]));
  return orgs.map((o) => ({ ...o, comunicacao_habilitacoes: habPorOrg.get(o.id) ?? null }));
}

/** Uma organização + sua habilitação (se existir). `null` se a organização não existe. */
export async function obterOrganizacaoComConfiguracao(organizacaoId, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data: org, error: e1 } = await db.from("organizacoes").select("id, nome, status").eq("id", organizacaoId).maybeSingle();
  if (e1) throw ApiError.internal(e1.message);
  if (!org) return null;
  const { data: hab, error: e2 } = await db.from("comunicacao_habilitacoes").select(COLUNAS_HABILITACAO).eq("organizacao_id", organizacaoId).maybeSingle();
  if (e2) throw ApiError.internal(e2.message);
  return { ...org, comunicacao_habilitacoes: hab ?? null };
}

/** Último envio (SENT) e próximo agendado (SCHEDULED) por organização — dados agregados, nunca o corpo da mensagem. */
export async function obterAtividadeRecentePorOrganizacao(deps = {}) {
  const db = deps.supabase ?? supabase;
  const [ultimos, proximos] = await Promise.all([
    db.from("comunicacao_mensagens").select("organizacao_id, enviado_em").eq("status", "SENT").order("enviado_em", { ascending: false }),
    db.from("comunicacao_mensagens").select("organizacao_id, disponivel_em").eq("status", "SCHEDULED").order("disponivel_em", { ascending: true }),
  ]);
  if (ultimos.error) throw ApiError.internal(ultimos.error.message);
  if (proximos.error) throw ApiError.internal(proximos.error.message);

  const ultimoPorOrg = new Map();
  for (const m of ultimos.data ?? []) if (!ultimoPorOrg.has(m.organizacao_id)) ultimoPorOrg.set(m.organizacao_id, m.enviado_em);
  const proximoPorOrg = new Map();
  for (const m of proximos.data ?? []) if (!proximoPorOrg.has(m.organizacao_id)) proximoPorOrg.set(m.organizacao_id, m.disponivel_em);
  return { ultimoPorOrg, proximoPorOrg };
}

/** Contagens agregadas de `comunicacao_mensagens` por status — para os cards do resumo (fila/hoje). Nunca lê `conteudo`. */
export async function contarMensagensPorStatus(deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_mensagens").select("status");
  if (error) throw ApiError.internal(error.message);
  const porStatus = {};
  for (const { status } of data ?? []) porStatus[status] = (porStatus[status] ?? 0) + 1;
  return porStatus;
}

/**
 * Janela MÓVEL real (agora-24h .. agora) — nunca meia-noite UTC, nunca fuso
 * de organização (Checkpoint H.3-A.1, itens 7/8: o card do resumo é global e
 * determinístico). `enviado_em`/`falhou_em` são os timestamps do EVENTO real,
 * não `created_at` (quando a mensagem foi só agendada).
 * @returns {Promise<{enviadas: number, falhas: number}>}
 */
export async function contarUltimas24h(deps = {}) {
  const db = deps.supabase ?? supabase;
  const desde = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [enviadasQ, falhasQ] = await Promise.all([
    db.from("comunicacao_mensagens").select("id", { count: "exact", head: true })
      .in("status", ["SENT", "DELIVERED", "READ"]).gte("enviado_em", desde),
    db.from("comunicacao_mensagens").select("id", { count: "exact", head: true })
      .eq("status", "FAILED").gte("falhou_em", desde),
  ]);
  if (enviadasQ.error) throw ApiError.internal(enviadasQ.error.message);
  if (falhasQ.error) throw ApiError.internal(falhasQ.error.message);
  return { enviadas: enviadasQ.count ?? 0, falhas: falhasQ.count ?? 0 };
}

// (Removido na migration 100: `listarPerfisElegiveis` listava perfis com ACESSO ativo à empresa (usuarios_organizacoes) como candidatos a
// destinatário. Acesso NÃO é responsável de comunicação — um perfil administrador com acesso a 47 empresas aparecia em todas. O responsável agora é
// cadastrado EXPLICITAMENTE por empresa (comunicacao.contatosEmpresa.repo.js).)

/** @returns {Promise<number>} organizações com `comunicacao_habilitacoes.habilitado = true`. Hoje deve ser sempre 0. */
export async function contarOrganizacoesHabilitadas(deps = {}) {
  const db = deps.supabase ?? supabase;
  const { count, error } = await db.from("comunicacao_habilitacoes").select("organizacao_id", { count: "exact", head: true }).eq("habilitado", true);
  if (error) throw ApiError.internal(error.message);
  return count ?? 0;
}

/** @returns {Promise<number>} empresas com envio automático LIGADO (habilitado E envio_automatico). */
export async function contarOrganizacoesComEnvioAutomatico(deps = {}) {
  const db = deps.supabase ?? supabase;
  const { count, error } = await db.from("comunicacao_habilitacoes").select("organizacao_id", { count: "exact", head: true }).eq("habilitado", true).eq("envio_automatico", true);
  if (error) throw ApiError.internal(error.message);
  return count ?? 0;
}

const COLUNAS_MENSAGEM_PAINEL = "id, organizacao_id, unidade_id, tipo, status, disponivel_em, enviado_em, entregue_em, lido_em, falhou_em, tentativas, max_tentativas, erro, erro_permanente, created_at";

function paginacao({ pagina = 1, porPagina = 20 } = {}) {
  const p = Math.max(1, Number(pagina) || 1);
  const porPag = Math.min(100, Math.max(1, Number(porPagina) || 20));
  return { p, porPag, inicio: (p - 1) * porPag, fim: (p - 1) * porPag + porPag - 1 };
}

const STATUS_FILA = ["SCHEDULED", "PROCESSING", "SENDING", "DELIVERY_UNKNOWN", "FAILED"];
const STATUS_HISTORICO = ["SENT", "DELIVERED", "READ", "CANCELLED", "BLOCKED", "FAILED"];

/** Fila (mensagens ainda "em jogo"). Nunca inclui `conteudo`. */
export async function listarFila({ organizacaoId, status, pagina, porPagina } = {}, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { p, porPag, inicio, fim } = paginacao({ pagina, porPagina });
  let q = db.from("comunicacao_mensagens").select(COLUNAS_MENSAGEM_PAINEL, { count: "exact" })
    .in("status", status ? [status] : STATUS_FILA);
  if (organizacaoId) q = q.eq("organizacao_id", organizacaoId);
  const { data, count, error } = await q.order("disponivel_em", { ascending: true }).range(inicio, fim);
  if (error) throw ApiError.internal(error.message);
  return { itens: data ?? [], total: count ?? 0, pagina: p, porPagina: porPag };
}

/** Histórico (mensagens em estado terminal). Nunca inclui `conteudo`. */
export async function listarHistorico({ organizacaoId, status, tipoAlerta, desde, ate, pagina, porPagina } = {}, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { p, porPag, inicio, fim } = paginacao({ pagina, porPagina });
  let q = db.from("comunicacao_mensagens").select(COLUNAS_MENSAGEM_PAINEL, { count: "exact" })
    .in("status", status ? [status] : STATUS_HISTORICO);
  if (organizacaoId) q = q.eq("organizacao_id", organizacaoId);
  if (tipoAlerta) q = q.eq("tipo", tipoAlerta);
  if (desde) q = q.gte("created_at", desde);
  if (ate) q = q.lte("created_at", ate);
  const { data, count, error } = await q.order("created_at", { ascending: false }).range(inicio, fim);
  if (error) throw ApiError.internal(error.message);
  return { itens: data ?? [], total: count ?? 0, pagina: p, porPagina: porPag };
}

/**
 * Salva a CONFIGURAÇÃO operacional da organização (timezone, tipos, pausa). NUNCA toca `habilitado`: a coluna nem entra no payload do upsert (o UPDATE
 * do PostgREST só altera as colunas enviadas; num INSERT novo vale o DEFAULT false da 088). A habilitação só muda por
 * `habilitarOrganizacaoPiloto`/`desabilitarOrganizacao` (botões próprios, com confirmação e auditoria).
 *
 * O RESPONSÁVEL (nome/telefone) NÃO é gravado aqui: vive em comunicacao_contatos_empresa (comunicacao.contatosEmpresa.repo.js). Esta função só
 * PRESERVA o ponteiro atual da habilitação para ele — nunca o infere de perfil/usuário/unidade.
 *
 * @param {{organizacaoId: string, timezone?: string, tiposPermitidos?: string[], pausadoAte?: string|null, pausadoMotivo?: string|null}} params
 * @param {{contaId?: string, perfilId?: string, nome?: string}} autor
 */
export async function atualizarConfiguracaoOrganizacao({
  organizacaoId, timezone, tiposPermitidos, pausadoAte, pausadoMotivo,
}, autor, deps = {}) {
  const db = deps.supabase ?? supabase;

  const atual = await obterOrganizacaoComConfiguracao(organizacaoId, deps);
  if (!atual) throw ApiError.notFound("Empresa não encontrada.");
  const habAtual = atual.comunicacao_habilitacoes ?? null;

  const linha = {
    organizacao_id: organizacaoId,
    // `habilitado` DELIBERADAMENTE AUSENTE — ver o comentário da função.
    timezone: timezone ?? habAtual?.timezone ?? null,
    tipos_permitidos: tiposPermitidos ?? habAtual?.tipos_permitidos ?? [],
    destinatario_contato_id: habAtual?.destinatario_contato_id ?? null,
    destinatario_contato_empresa_id: habAtual?.destinatario_contato_empresa_id ?? null,
    destinatario_perfil_id: habAtual?.destinatario_perfil_id ?? null,
    pausado_ate: pausadoAte !== undefined ? pausadoAte : (habAtual?.pausado_ate ?? null),
    pausado_motivo: pausadoMotivo !== undefined ? pausadoMotivo : (habAtual?.pausado_motivo ?? null),
    atualizado_por: autor?.perfilId ?? null,
  };
  // Uma empresa HABILITADA não pode ficar com a configuração incompleta (a 088 recusa no banco; aqui vira um 400 claro, sem tocar em nada).
  if (habAtual?.habilitado === true && (!linha.timezone || !linha.tipos_permitidos?.length)) {
    throw ApiError.badRequest("Esta empresa está com a comunicação habilitada: a configuração precisa continuar completa (timezone e tipo de alerta). Desabilite a comunicação antes de esvaziar estes campos.", { codigo: "CONFIG_INCOMPLETA_HABILITADA" });
  }
  const { data, error } = await db.from("comunicacao_habilitacoes")
    .upsert(linha, { onConflict: "organizacao_id" }).select(COLUNAS_HABILITACAO).single();
  if (error) throw ApiError.internal(error.message);

  await auditar({
    acao: ACOES.COMUNICACAO_HABILITACAO_ALTERADA,
    atorId: autor?.contaId ?? null,
    perfilId: autor?.perfilId ?? null,
    perfilNome: autor?.nome ?? null,
    atorTipo: "usuario",
    entidade: "comunicacao_habilitacoes",
    entidadeId: organizacaoId,
    organizacaoId,
    detalhes: { timezone: linha.timezone, tipos_permitidos: linha.tipos_permitidos, pausado_ate: linha.pausado_ate, habilitado_inalterado: true },
  });

  return data;
}

/**
 * Confirma consentimento + verificação do contato JÁ configurado para esta
 * organização — Checkpoint H.4-A.2. Exige que um telefone já esteja
 * associado (`destinatario_contato_id`); a decisão de que a confirmação do
 * operador é real e explícita é do CHAMADOR (service), nunca inferida aqui.
 * @param {{organizacaoId: string}} params
 */
export async function confirmarConsentimentoOrganizacao({ organizacaoId }, autor, deps = {}) {
  const atual = await obterOrganizacaoComConfiguracao(organizacaoId, deps);
  if (!atual) throw ApiError.notFound("Empresa não encontrada.");
  const principal = escolherPrincipal(await listarContatosDaEmpresa(organizacaoId, deps));
  if (!principal) throw ApiError.badRequest("Cadastre o responsável pelas comunicações desta empresa antes de confirmar o WhatsApp.", { codigo: "SEM_CONTATO" });

  const validado = await validarWhatsApp({ organizacaoId, contatoEmpresaId: principal.id }, autor, deps);
  return { organizacaoId, contatoEmpresaId: validado.id, consentimento: true, verificado: true, telefoneMascarado: mascararTelefone(validado.telefone_e164) };
}

/**
 * Habilita ATOMICAMENTE a empresa (RPC da migration 104: exige timezone, tipo permitido e ao menos um destinatário ELEGÍVEL). NÃO liga o envio
 * automático (decisão separada). Só o Painel Administrativo chama isto (ator humano no service).
 * @returns {Promise<{acao: string}>}
 */
export async function habilitarOrganizacao({ organizacaoId, atorPerfilId = null }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.rpc("comunicacao_habilitar_organizacao", {
    p_organizacao_id: organizacaoId, p_ator_perfil_id: atorPerfilId,
  });
  if (error) throw ApiError.internal(error.message);
  if (!data || typeof data.acao !== "string") throw ApiError.internal("comunicacao_habilitar_organizacao: resposta inválida");
  return data;
}

/**
 * Liga/desliga o ENVIO AUTOMÁTICO da empresa (RPC 104). Desligar é sempre permitido; ligar exige empresa habilitada e destinatário elegível.
 * @returns {Promise<{acao: 'LIGADO'|'DESLIGADO'|'JA_LIGADO'|'JA_DESLIGADO'|'SEM_CONFIGURACAO'|'EMPRESA_NAO_HABILITADA'|'SEM_DESTINATARIO_ELEGIVEL'}>}
 */
export async function definirEnvioAutomatico({ organizacaoId, ligar, atorPerfilId = null }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.rpc("comunicacao_definir_envio_automatico", {
    p_organizacao_id: organizacaoId, p_ligar: ligar === true, p_ator_perfil_id: atorPerfilId,
  });
  if (error) throw ApiError.internal(error.message);
  if (!data || typeof data.acao !== "string") throw ApiError.internal("comunicacao_definir_envio_automatico: resposta inválida");
  return data;
}

/** Limites POR EMPRESA (null = padrão global). Não toca em habilitado/envio_automatico. */
export async function atualizarLimitesOrganizacao({ organizacaoId, limiteDiarioOrg, cooldownMinutos, atorPerfilId = null }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const campos = { atualizado_por: atorPerfilId };
  if (limiteDiarioOrg !== undefined) campos.limite_diario_org = limiteDiarioOrg;
  if (cooldownMinutos !== undefined) campos.cooldown_minutos = cooldownMinutos;
  const { data, error } = await db.from("comunicacao_habilitacoes").update(campos).eq("organizacao_id", organizacaoId)
    .select("limite_diario_org, cooldown_minutos").maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!data) throw ApiError.notFound("A empresa ainda não tem configuração de WhatsApp. Salve a configuração antes de definir limites.");
  return data;
}

/** Desabilita (habilitado=false) E desliga o envio automático junto (a constraint do banco exige). SEMPRE permitido (kill switch da empresa). */
export async function desabilitarOrganizacao({ organizacaoId, atorPerfilId = null }, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data: antes, error: e1 } = await db.from("comunicacao_habilitacoes").select("habilitado, envio_automatico").eq("organizacao_id", organizacaoId).maybeSingle();
  if (e1) throw ApiError.internal(e1.message);
  if (!antes) return { estavaHabilitada: false, alterou: false, tinhaEnvioAutomatico: false };
  const { error } = await db.from("comunicacao_habilitacoes")
    .update({ habilitado: false, envio_automatico: false, atualizado_por: atorPerfilId, updated_at: new Date().toISOString() }).eq("organizacao_id", organizacaoId);
  if (error) throw ApiError.internal(error.message);
  return { estavaHabilitada: antes.habilitado === true, alterou: antes.habilitado === true, tinhaEnvioAutomatico: antes.envio_automatico === true };
}

/** Organizações habilitadas hoje: id + se o envio automático está ligado. */
export async function listarOrganizacoesHabilitadas(deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_habilitacoes").select("organizacao_id, envio_automatico").eq("habilitado", true);
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}

export { obterContato, obterPerfilOperacional, mascararTelefone };

/**
 * Atividade de UMA empresa: último envio (SENT/DELIVERED/READ), próxima mensagem agendada e o último envio por destinatário (chave = contato_whatsapp_id).
 * Só agregados — nunca o corpo da mensagem.
 * @returns {Promise<{ultimoEm: string|null, proximoEm: string|null, ultimoPorContato: Map<string, string>}>}
 */
export async function obterAtividadeDaEmpresa(organizacaoId, deps = {}) {
  const db = deps.supabase ?? supabase;
  const [ultimos, proximo] = await Promise.all([
    db.from("comunicacao_mensagens").select("contato_id, enviado_em").eq("organizacao_id", organizacaoId).eq("direcao", "saida")
      .in("status", ["SENT", "DELIVERED", "READ"]).not("enviado_em", "is", null).order("enviado_em", { ascending: false }).limit(200),
    db.from("comunicacao_mensagens").select("disponivel_em").eq("organizacao_id", organizacaoId).eq("direcao", "saida").eq("status", "SCHEDULED")
      .order("disponivel_em", { ascending: true }).limit(1),
  ]);
  if (ultimos.error) throw ApiError.internal(ultimos.error.message);
  if (proximo.error) throw ApiError.internal(proximo.error.message);
  const ultimoPorContato = new Map();
  for (const m of ultimos.data ?? []) if (m.contato_id && !ultimoPorContato.has(m.contato_id)) ultimoPorContato.set(m.contato_id, m.enviado_em);
  return { ultimoEm: ultimos.data?.[0]?.enviado_em ?? null, proximoEm: proximo.data?.[0]?.disponivel_em ?? null, ultimoPorContato };
}

/**
 * Alertas recentes de UMA empresa com as mensagens INICIAIS de cada um (status/erro/metadados — nunca `conteudo` nem telefone). Base do resumo de entrega
 * por destinatário (comunicacao.entrega.js). Somente leitura; sempre filtrado pela organização.
 * @returns {Promise<Array<{alerta: object, mensagens: object[]}>>}
 */
export async function listarAlertasRecentesComMensagens({ organizacaoId, limite = 10 } = {}, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data: alertas, error } = await db.from("comunicacao_alertas")
    .select("id, unidade_id, tipo_alerta, data_referencia, severidade, status, updated_at")
    .eq("organizacao_id", organizacaoId).order("updated_at", { ascending: false }).limit(limite);
  if (error) throw ApiError.internal(error.message);
  if (!alertas?.length) return [];
  const { data: msgs, error: e2 } = await db.from("comunicacao_mensagens")
    .select("alerta_id, status, erro, metadados, direcao, contato_empresa_id")
    .eq("organizacao_id", organizacaoId).eq("direcao", "saida").in("alerta_id", alertas.map((a) => a.id));
  if (e2) throw ApiError.internal(e2.message);
  return alertas.map((alerta) => ({ alerta, mensagens: (msgs ?? []).filter((m) => m.alerta_id === alerta.id) }));
}

// ---------------------------------------------------------------------------
// CENTRAL DE COMUNICAÇÃO (H.4-B.5) — leituras adicionais (nunca `conteudo`, nunca telefone completo).
// ---------------------------------------------------------------------------

/** Unidades (todas, ou de uma organização) — id, organização, nome, ativo. */
export async function listarUnidades({ organizacaoId } = {}, deps = {}) {
  const db = deps.supabase ?? supabase;
  let q = db.from("unidades").select("id, organizacao_id, nome, ativo").order("nome", { ascending: true });
  if (organizacaoId) q = q.eq("organizacao_id", organizacaoId);
  const { data, error } = await q;
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}

export async function obterUnidade(unidadeId, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("unidades").select("id, organizacao_id, nome, ativo").eq("id", unidadeId).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  return data ?? null;
}

/** Contatos por id (em LOTE) — o service só devolve o telefone MASCARADO. */
export async function listarContatosPorIds(ids, deps = {}) {
  const db = deps.supabase ?? supabase;
  const lista = [...new Set((ids ?? []).filter(Boolean))];
  if (!lista.length) return [];
  const { data, error } = await db.from("contatos_whatsapp").select("id, telefone_e164, verificado, consentimento, opt_out").in("id", lista);
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}

const COLUNAS_MENSAGEM_CENTRAL = "id, alerta_id, organizacao_id, unidade_id, contato_id, tipo, status, tentativas, max_tentativas, disponivel_em, enviado_em, entregue_em, lido_em, falhou_em, entrega_incerta_em, erro, erro_permanente, provider_message_id, metadados, created_at, expira_em";

/**
 * Mensagens (TODOS os status) mais recentes, com filtros exatos no banco. `organizacaoIdsBusca`/`unidadeIdsBusca` vêm da busca por nome (resolvida no
 * service); basta casar UM dos dois. Limite duro de 500 linhas (a origem é derivada no service, sobre este recorte). Nunca inclui `conteudo`.
 */
export async function listarMensagensCentral({ organizacaoId, unidadeId, status, desde, ate, organizacaoIdsBusca, unidadeIdsBusca, limite = 500 } = {}, deps = {}) {
  const db = deps.supabase ?? supabase;
  let q = db.from("comunicacao_mensagens").select(COLUNAS_MENSAGEM_CENTRAL).eq("direcao", "saida");
  if (organizacaoId) q = q.eq("organizacao_id", organizacaoId);
  if (unidadeId) q = q.eq("unidade_id", unidadeId);
  if (status) q = q.eq("status", status);
  if (desde) q = q.gte("created_at", desde);
  if (ate) q = q.lte("created_at", ate);
  if (organizacaoIdsBusca || unidadeIdsBusca) {
    const oi = (organizacaoIdsBusca ?? []).filter(Boolean);
    const ui = (unidadeIdsBusca ?? []).filter(Boolean);
    const partes = [];
    if (oi.length) partes.push(`organizacao_id.in.(${oi.join(",")})`);
    if (ui.length) partes.push(`unidade_id.in.(${ui.join(",")})`);
    if (!partes.length) return [];
    q = q.or(partes.join(","));
  }
  const { data, error } = await q.order("created_at", { ascending: false }).limit(Math.min(500, Math.max(1, Number(limite) || 500)));
  if (error) throw ApiError.internal(error.message);
  return data ?? [];
}

export async function obterMensagemCentral(id, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_mensagens").select(COLUNAS_MENSAGEM_CENTRAL).eq("id", id).eq("direcao", "saida").maybeSingle();
  if (error) throw ApiError.internal(error.message);
  return data ?? null;
}

/** Última mensagem (status + instante) por organização — para a coluna "Último status" das empresas. */
export async function obterUltimaMensagemPorOrganizacao(deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_mensagens").select("organizacao_id, status, created_at, enviado_em, metadados")
    .eq("direcao", "saida").order("created_at", { ascending: false }).limit(500);
  if (error) throw ApiError.internal(error.message);
  const porOrg = new Map();
  for (const m of data ?? []) if (!porOrg.has(m.organizacao_id)) porOrg.set(m.organizacao_id, { status: m.status, em: m.enviado_em ?? m.created_at, proposito: m.metadados?.proposito ?? null });
  return porOrg;
}

/** Mensagem (sem conteúdo) pela chave de idempotência — usada para reconhecer o MESMO teste repetido. */
export async function obterMensagemPorChave(chave, deps = {}) {
  const db = deps.supabase ?? supabase;
  const { data, error } = await db.from("comunicacao_mensagens").select("id, status, metadados").eq("idempotency_key", chave).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  return data ?? null;
}
