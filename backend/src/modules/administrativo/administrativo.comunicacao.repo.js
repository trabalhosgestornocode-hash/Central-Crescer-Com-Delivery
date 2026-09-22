// PAINEL ADMINISTRATIVO — camada de I/O da área de Comunicação/WhatsApp
// (Checkpoint H.3-A). SÓ LEITURA, exceto `atualizarConfiguracaoOrganizacao` —
// a ÚNICA escrita, e ela é hard-coded para NUNCA habilitar envio (ver seção
// própria abaixo). Usa `supabase` (service_role) igual ao resto do painel:
// cross-tenant por AUTORIZAÇÃO explícita (`requirePainelAdministrativo`), não
// por bypass dos middlewares multi-tenant.
//
// NÃO duplica nenhuma regra de negócio do módulo `comunicacao/`: reaproveita
// `criarOuObterContato`/`vincularPerfil`/`perfilTemVinculo`/`mascararTelefone`
// de `comunicacao.contatos.repo.js` tal como estão. Este arquivo só sabe
// LISTAR/PROJETAR para o painel — nunca decide política, claim, rate-limit,
// cooldown, horário ou envio.

import { supabase } from "../../config/supabase.js";
import { ApiError } from "../../shared/ApiError.js";
import {
  criarOuObterContato, vincularPerfil, perfilTemVinculo, mascararTelefone, obterContato, obterPerfilOperacional,
  confirmarConsentimentoEVerificacao,
} from "../comunicacao/comunicacao.contatos.repo.js";
import { auditar, ACOES } from "../../shared/auditoria.js";

const COLUNAS_HABILITACAO = "organizacao_id, habilitado, tipos_permitidos, timezone, janelas, pausado_ate, pausado_motivo, destinatario_contato_id, destinatario_perfil_id, atualizado_por, created_at, updated_at";

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
    .select("status, last_seen_at, updated_at")
    .order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw ApiError.internal(error.message);
  if (!data) return { estado: "desconhecido", ultimoContatoEm: null };

  const heartbeat = data.last_seen_at ? new Date(data.last_seen_at) : null;
  const stale = !heartbeat || Number.isNaN(heartbeat.getTime()) || (Date.now() - heartbeat.getTime()) > JANELA_INSTAVEL_MS;
  const estado = GATEWAY_CONECTADO.has(data.status) ? (stale ? "instavel" : "conectado") : "desconectado";
  return { estado, ultimoContatoEm: data.last_seen_at ?? null };
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

/**
 * Perfis ELEGÍVEIS desta organização para virar destinatário — Checkpoint
 * H.3-A.1, itens 3-6. "Elegível" = mesmo critério que o banco já exige em
 * `comunicacao_agendar_mensagem_alerta`/`perfilTemVinculo`: vínculo ATIVO em
 * `usuarios_organizacoes` para ESTA organização. Não existia endpoint/consulta
 * pronta com esse recorte (auditado: `administrativo.mentorados.js` carrega
 * TODOS os mentorados da plataforma inteira, sem filtro por organização — uso
 * pesado demais para um combobox de uma tela); três consultas em LOTE (nunca
 * `for perfil: SELECT`), mesmo espírito do resto do módulo.
 * @returns {Promise<Array<{perfilOperacionalId: string, nome: string, email: string|null}>>}
 */
export async function listarPerfisElegiveis(organizacaoId, deps = {}) {
  const db = deps.supabase ?? supabase;

  const { data: vinc, error: e1 } = await db.from("usuarios_organizacoes")
    .select("perfil_id").eq("organizacao_id", organizacaoId).eq("ativo", true);
  if (e1) throw ApiError.internal(e1.message);
  const perfilIds = [...new Set((vinc ?? []).map((v) => v.perfil_id).filter(Boolean))];
  if (!perfilIds.length) return [];

  const { data: perfis, error: e2 } = await db.from("perfis_operacionais")
    .select("id, conta_id, nome, ativo").in("id", perfilIds).eq("ativo", true);
  if (e2) throw ApiError.internal(e2.message);
  if (!perfis?.length) return [];

  const contaIds = [...new Set(perfis.map((p) => p.conta_id).filter(Boolean))];
  const { data: contas, error: e3 } = contaIds.length
    ? await db.from("perfis").select("id, email").in("id", contaIds)
    : { data: [], error: null };
  if (e3) throw ApiError.internal(e3.message);
  const emailPorConta = new Map((contas ?? []).map((c) => [c.id, c.email]));

  return perfis
    .map((p) => ({ perfilOperacionalId: p.id, nome: p.nome, email: emailPorConta.get(p.conta_id) ?? null }))
    .sort((a, b) => String(a.nome ?? "").localeCompare(String(b.nome ?? ""), "pt-BR"));
}

/** @returns {Promise<number>} organizações com `comunicacao_habilitacoes.habilitado = true`. Hoje deve ser sempre 0. */
export async function contarOrganizacoesHabilitadas(deps = {}) {
  const db = deps.supabase ?? supabase;
  const { count, error } = await db.from("comunicacao_habilitacoes").select("organizacao_id", { count: "exact", head: true }).eq("habilitado", true);
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
 * ÚNICA escrita deste módulo. `habilitado` é SEMPRE `false` — HARD-CODED, não
 * é um parâmetro aceito por esta função (defesa em profundidade #1; a #2 é a
 * checagem explícita no service antes de chegar aqui — ver
 * administrativo.comunicacao.service.js#atualizarConfiguracao). Nenhum
 * caminho deste arquivo pode gravar `habilitado: true`.
 *
 * @param {{organizacaoId: string, telefoneE164?: string, perfilOperacionalId?: string,
 *   timezone?: string, tiposPermitidos?: string[], pausadoAte?: string|null, pausadoMotivo?: string|null}} params
 * @param {{contaId?: string, perfilId?: string, nome?: string}} autor
 */
export async function atualizarConfiguracaoOrganizacao({
  organizacaoId, telefoneE164, perfilOperacionalId, timezone, tiposPermitidos, pausadoAte, pausadoMotivo,
}, autor, deps = {}) {
  const db = deps.supabase ?? supabase;

  const atual = await obterOrganizacaoComConfiguracao(organizacaoId, deps);
  if (!atual) throw ApiError.notFound("Empresa não encontrada.");
  const habAtual = atual.comunicacao_habilitacoes ?? null;

  let destinatarioContatoId = habAtual?.destinatario_contato_id ?? null;
  let destinatarioPerfilId = habAtual?.destinatario_perfil_id ?? null;
  let telefoneMascaradoParaAuditoria = null;

  if (telefoneE164) {
    const contato = await criarOuObterContato({ telefoneE164 }, deps);
    destinatarioContatoId = contato.id;
    telefoneMascaradoParaAuditoria = mascararTelefone(contato.telefone_e164);
    if (perfilOperacionalId) {
      const vinculo = await perfilTemVinculo({ perfilId: perfilOperacionalId, organizacaoId }, deps);
      if (!vinculo) throw ApiError.badRequest("Este perfil não tem vínculo ativo com esta organização.", { codigo: "PERFIL_SEM_VINCULO" });
      await vincularPerfil({ contatoId: contato.id, perfilOperacionalId }, deps);
      destinatarioPerfilId = perfilOperacionalId;
    }
  } else if (perfilOperacionalId) {
    // trocar só o perfil, mantendo o contato já configurado.
    if (!destinatarioContatoId) throw ApiError.badRequest("Defina um telefone antes de associar um perfil.", { codigo: "SEM_CONTATO" });
    const vinculo = await perfilTemVinculo({ perfilId: perfilOperacionalId, organizacaoId }, deps);
    if (!vinculo) throw ApiError.badRequest("Este perfil não tem vínculo ativo com esta organização.", { codigo: "PERFIL_SEM_VINCULO" });
    await vincularPerfil({ contatoId: destinatarioContatoId, perfilOperacionalId }, deps);
    destinatarioPerfilId = perfilOperacionalId;
  }

  const linha = {
    organizacao_id: organizacaoId,
    habilitado: false, // NUNCA outro valor — ver comentário da função.
    timezone: timezone ?? habAtual?.timezone ?? null,
    tipos_permitidos: tiposPermitidos ?? habAtual?.tipos_permitidos ?? [],
    destinatario_contato_id: destinatarioContatoId,
    destinatario_perfil_id: destinatarioPerfilId,
    pausado_ate: pausadoAte !== undefined ? pausadoAte : (habAtual?.pausado_ate ?? null),
    pausado_motivo: pausadoMotivo !== undefined ? pausadoMotivo : (habAtual?.pausado_motivo ?? null),
    atualizado_por: autor?.perfilId ?? null,
  };
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
    detalhes: {
      timezone: linha.timezone,
      tipos_permitidos: linha.tipos_permitidos,
      pausado_ate: linha.pausado_ate,
      telefone_mascarado: telefoneMascaradoParaAuditoria, // null quando o telefone não mudou nesta chamada
      destinatario_alterado: destinatarioContatoId !== (habAtual?.destinatario_contato_id ?? null) || destinatarioPerfilId !== (habAtual?.destinatario_perfil_id ?? null),
      habilitado: false,
    },
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
  const contatoId = atual.comunicacao_habilitacoes?.destinatario_contato_id ?? null;
  if (!contatoId) throw ApiError.badRequest("Configure um telefone para esta organização antes de confirmar consentimento.", { codigo: "SEM_CONTATO" });

  await confirmarConsentimentoEVerificacao({
    contatoId, organizacaoId,
    atorId: autor?.contaId ?? null, perfilId: autor?.perfilId ?? null, perfilNome: autor?.nome ?? null, atorEmail: autor?.email ?? null,
    origem: "confirmacao_explicita_operador_painel_admin",
  }, deps);

  const contato = await obterContato(contatoId, deps);
  return { organizacaoId, consentimento: true, verificado: true, telefoneMascarado: mascararTelefone(contato?.telefone_e164) };
}

export { obterContato, obterPerfilOperacional, mascararTelefone };
