// Fixtures descartáveis para as suítes de integração do módulo de
// Comunicação — mesmo espírito de agente-conversas-isolamento.test.js
// (cria e apaga suas próprias organizações/contas, nunca toca dado real).
import { createHash } from "node:crypto";
import { supabase } from "../../src/config/supabase.js";

export async function criarContaComPerfil(tag, sufixo) {
  const { data: user, error: eU } = await supabase.auth.admin.createUser({
    email: `${tag}_${sufixo}@example.com`, password: `Wa-${tag}-Xx1!`, email_confirm: true,
  });
  if (eU) throw new Error(`Falha ao criar usuário de teste: ${eU.message}`);
  const { error: ePerf } = await supabase.from("perfis")
    .insert({ id: user.user.id, nome: `Comunicacao ${sufixo}`, papel: "leitura", ativo: true });
  if (ePerf) throw new Error(`Falha ao criar perfis: ${ePerf.message}`);
  const { data: op, error: eOp } = await supabase.from("perfis_operacionais")
    .insert({ conta_id: user.user.id, nome: `Perfil ${sufixo}`, ativo: true }).select("id").single();
  if (eOp) throw new Error(`Falha ao criar perfis_operacionais: ${eOp.message}`);
  return { contaId: user.user.id, perfilId: op.id };
}

export async function apagarConta(contaId) {
  try { await supabase.auth.admin.deleteUser(contaId); } catch { /* ignora */ }
}

export async function criarOrganizacao(nome) {
  const { data, error } = await supabase.from("organizacoes").insert({ nome }).select("id").single();
  if (error) throw new Error(`Falha ao criar organização de teste: ${error.message}`);
  return data.id;
}

export async function apagarOrganizacao(organizacaoId) {
  if (organizacaoId) await supabase.from("organizacoes").delete().eq("id", organizacaoId);
}

export async function criarUnidade(organizacaoId, nome = "Unidade Teste") {
  const { data, error } = await supabase.from("unidades").insert({ organizacao_id: organizacaoId, nome, ativo: true }).select("id").single();
  if (error) throw new Error(`Falha ao criar unidade de teste: ${error.message}`);
  return data.id;
}

export async function vincularUsuarioUnidade({ perfilId, organizacaoId, unidadeId, papel = "viewer" }) {
  // `usuario_id` referencia auth.users (a CONTA); `perfil_id` referencia
  // perfis_operacionais. Os dois nunca são o mesmo id — a conta vem do perfil.
  const { data: perfil, error: ePerfil } = await supabase.from("perfis_operacionais")
    .select("conta_id").eq("id", perfilId).single();
  if (ePerfil) throw new Error(`Falha ao ler perfis_operacionais: ${ePerfil.message}`);
  const contaId = perfil.conta_id;

  const { error: eOrg } = await supabase.from("usuarios_organizacoes")
    .insert({ usuario_id: contaId, organizacao_id: organizacaoId, papel, perfil_id: perfilId, ativo: true });
  if (eOrg) throw new Error(`Falha ao vincular usuarios_organizacoes: ${eOrg.message}`);
  if (unidadeId) {
    const { error: eUni } = await supabase.from("usuarios_unidades")
      .insert({ usuario_id: contaId, unidade_id: unidadeId, perfil_id: perfilId, ativo: true });
    if (eUni) throw new Error(`Falha ao vincular usuarios_unidades: ${eUni.message}`);
  }
}

/** Migrations 082 (comunicacao_*) estão aplicadas neste Supabase? */
export async function migracao082Aplicada() {
  const probe = await supabase.from("comunicacao_alertas").select("id").limit(0);
  return !probe.error;
}

/** Migration 083 (whatsapp_conexoes) está aplicada neste Supabase? */
export async function migracao083Aplicada() {
  const probe = await supabase.from("whatsapp_conexoes").select("id").limit(0);
  return !probe.error;
}

/** Migration 084 (lease/fencing em whatsapp_conexoes) está aplicada neste Supabase? */
export async function migracao084Aplicada() {
  const probe = await supabase.from("whatsapp_conexoes").select("lease_epoch").limit(0);
  return !probe.error;
}

/** Migration 085 (desired_connection_state em whatsapp_conexoes, Checkpoint C3.5-B) está aplicada neste Supabase? */
export async function migracao085Aplicada() {
  const probe = await supabase.from("whatsapp_conexoes").select("desired_connection_state").limit(0);
  return !probe.error;
}

/** Migration 088 (habilitação por organização, TTL, RPCs de agendamento/reserva/reconciliação) está aplicada neste Supabase? */
export async function migracao088Aplicada() {
  const tabela = await supabase.from("comunicacao_habilitacoes").select("organizacao_id").limit(0);
  const coluna = await supabase.from("comunicacao_mensagens").select("expira_em").limit(0);
  if (tabela.error || coluna.error) return false;
  // sonda SEM efeito colateral: id inexistente -> POSSE_PERDIDA
  const sonda = await supabase.rpc("comunicacao_reservar_envio", {
    p_id: "00000000-0000-0000-0000-000000000000", p_worker: "probe", p_claim_geracao: 1, p_lease_segundos: 1,
    p_cooldown_horas: null, p_max_por_contato_dia: null, p_max_por_minuto: null, p_max_por_minuto_org: null, p_inicio_dia: new Date().toISOString(),
  });
  return !sonda.error;
}

/** Migration 092/104 (agendamento por destinatário: comunicacao_agendar_mensagens_alerta) está aplicada neste Supabase? */
export async function migracao092Aplicada() {
  // sonda SEM efeito colateral: alerta inexistente -> ALERTA_INEXISTENTE, nunca escreve nada
  const sonda = await supabase.rpc("comunicacao_agendar_mensagens_alerta", {
    p_alerta_id: "00000000-0000-0000-0000-000000000000", p_proposito: "inicial", p_origem: null,
    p_itens: [{ contato_empresa_id: "00000000-0000-0000-0000-000000000000", conteudo: "probe", disponivel_em: new Date().toISOString() }], p_max_tentativas: 1,
  });
  return !sonda.error;
}

/** Migration 104 (fim do piloto: envio_automatico, categorias, vários destinatários) está aplicada neste Supabase? */
export async function migracao104Aplicada() {
  const col = await supabase.from("comunicacao_habilitacoes").select("envio_automatico").limit(0);
  const cat = await supabase.from("comunicacao_categorias").select("codigo").limit(0);
  return !col.error && !cat.error;
}

// ---------------------------------------------------------------------------
// D.3-D-R — DESTINATÁRIO EXPLÍCITO. O banco lê o destinatário da habilitação da organização
// (nunca do chamador): estes helpers montam o par (contato, perfil) elegível e a habilitação.
// ---------------------------------------------------------------------------
let seqTelefone = 0;

/**
 * Destinatário operacional ELEGÍVEL: conta+perfil com vínculo ATIVO na organização (usuarios_organizacoes;
 * `unidadeId` opcional acrescenta o vínculo de unidade), contato verificado + consentido + sem opt-out, e
 * o par contato<->perfil ativo. `verificado`/`consentimento`/`optOut` permitem montar os casos INELEGÍVEIS.
 */
export async function criarDestinatario({ organizacaoId, unidadeId = null, tag, sufixo = "dest", verificado = true, consentimento = true, optOut = false }) {
  const { contaId, perfilId } = await criarContaComPerfil(tag, sufixo);
  await vincularUsuarioUnidade({ perfilId, organizacaoId, unidadeId });
  const telefone = `+551197${String(Date.now() * 13 + ++seqTelefone * 7919).slice(-7)}`;
  const { data: contato, error } = await supabase.from("contatos_whatsapp")
    .insert({ telefone_e164: telefone, verificado, consentimento, opt_out: optOut }).select("id").single();
  if (error) throw new Error(`Falha ao criar contato de teste: ${error.message}`);
  const { error: eLink } = await supabase.from("contatos_whatsapp_perfis")
    .insert({ contato_id: contato.id, perfil_operacional_id: perfilId, ativo: true, principal: true });
  if (eLink) throw new Error(`Falha ao vincular contato<->perfil: ${eLink.message}`);
  return { contaId, perfilId, contatoId: contato.id };
}

/** Remove o destinatário criado por `criarDestinatario` (mensagens do contato, contato, conta). */
export async function apagarDestinatario(d) {
  if (!d) return;
  await supabase.from("comunicacao_mensagens").delete().eq("contato_id", d.contatoId);
  await supabase.from("contatos_whatsapp").delete().eq("id", d.contatoId);
  await apagarConta(d.contaId);
}

/**
 * Habilita a organização com o destinatário EXPLÍCITO (upsert em comunicacao_habilitacoes). Lança se o
 * banco recusar (trigger/CHECK/FK) — os testes que esperam recusa usam o supabase direto.
 */
export async function habilitarOrganizacao(organizacaoId, dest, extra = {}) {
  const linha = {
    organizacao_id: organizacaoId, habilitado: true, envio_automatico: extra.habilitado !== false, tipos_permitidos: ["dashboard_ifood_d1"], timezone: "America/Fortaleza",
    destinatario_contato_id: dest.contatoId, destinatario_perfil_id: dest.perfilId, ...extra,
  };
  // Migration 091: o destinatário passa a ser o RESPONSÁVEL DE COMUNICAÇÃO da empresa. Se a tabela existe, cria o
  // responsável (WhatsApp VALIDADO, coerente com as flags do contato) e aponta a habilitação para ele; sem a
  // tabela (banco pré-091) mantém o comportamento antigo.
  if (!("destinatario_contato_empresa_id" in extra)) {
    const { data: c } = await supabase.from("contatos_whatsapp").select("telefone_e164, verificado, consentimento").eq("id", dest.contatoId).maybeSingle();
    if (c) {
      const validado = c.verificado === true && c.consentimento === true;
      const corpo = {
        organizacao_id: organizacaoId, nome: "Responsável de teste", telefone_e164: c.telefone_e164, tipo: "principal",
        contato_whatsapp_id: dest.contatoId, perfil_operacional_id: dest.perfilId ?? null,
        whatsapp_status: validado ? "VALIDADO" : "AGUARDANDO_VALIDACAO", whatsapp_validado_em: validado ? new Date().toISOString() : null, ativo: true,
      };
      let { data: ce, error: eCe } = await supabase.from("comunicacao_contatos_empresa").insert(corpo).select("id").single();
      if (eCe) { // já existe um principal ativo desta empresa (re-habilitação no mesmo teste): reaproveita e atualiza
        const { data: ex } = await supabase.from("comunicacao_contatos_empresa").select("id").eq("organizacao_id", organizacaoId).eq("tipo", "principal").eq("ativo", true).maybeSingle();
        if (ex) { await supabase.from("comunicacao_contatos_empresa").update(corpo).eq("id", ex.id); ce = ex; eCe = null; }
      }
      if (!eCe && ce) { linha.destinatario_contato_empresa_id = ce.id; dest.contatoEmpresaId = ce.id; await habilitarCategoriasT(organizacaoId, ce.id); }
    }
  }
  const { error } = await supabase.from("comunicacao_habilitacoes").upsert(linha, { onConflict: "organizacao_id" });
  if (error) throw new Error(`Falha ao habilitar a organização de teste: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Migration 100 — RESPONSÁVEL DE COMUNICAÇÃO nos testes legados. As suítes antigas montavam mensagens à mão
// (contato + perfil). Agora o envio exige o responsável DA EMPRESA: estes helpers o criam para o par
// (empresa, contato) — WhatsApp VALIDADO (os portões de consentimento/verificação continuam sendo os flags do contato).
// ---------------------------------------------------------------------------
import * as filaRepoT from "../../src/modules/comunicacao/comunicacao.fila.repo.js";

/** Garante um responsável ATIVO da empresa para este contato (reaproveita o existente). Devolve o id ou null. */
export async function responsavelDoContato({ organizacaoId, contatoId, perfilId = null }) {
  if (!organizacaoId || !contatoId) return null;
  const { data: existente } = await supabase.from("comunicacao_contatos_empresa").select("id, ativo")
    .eq("organizacao_id", organizacaoId).eq("contato_whatsapp_id", contatoId).eq("ativo", true).maybeSingle();
  if (existente) { await habilitarCategoriasT(organizacaoId, existente.id); return existente.id; }
  const { data: c } = await supabase.from("contatos_whatsapp").select("telefone_e164").eq("id", contatoId).maybeSingle();
  if (!c) return null;
  const { data: principal } = await supabase.from("comunicacao_contatos_empresa").select("id")
    .eq("organizacao_id", organizacaoId).eq("tipo", "principal").eq("ativo", true).maybeSingle();
  const { data: novo, error } = await supabase.from("comunicacao_contatos_empresa").insert({
    organizacao_id: organizacaoId, nome: "Responsável de teste", telefone_e164: c.telefone_e164, tipo: principal ? "operacional" : "principal",
    contato_whatsapp_id: contatoId, perfil_operacional_id: perfilId, whatsapp_status: "VALIDADO", whatsapp_validado_em: new Date().toISOString(), ativo: true,
  }).select("id").single();
  if (error) throw new Error(`Falha ao criar responsável de teste: ${error.message}`);
  await habilitarCategoriasT(organizacaoId, novo.id);
  return novo.id;
}

/** Habilita, para o destinatário, TODAS as categorias ativas do catálogo (hoje só `pendencia_d1`). Idempotente. */
export async function habilitarCategoriasT(organizacaoId, contatoEmpresaId, categorias = null) {
  const { data: cats } = await supabase.from("comunicacao_categorias").select("codigo").eq("ativo", true);
  const lista = categorias ?? (cats ?? []).map((c) => c.codigo);
  if (!lista.length) return;
  const { error } = await supabase.from("comunicacao_destinatario_categorias")
    .upsert(lista.map((categoria) => ({ contato_empresa_id: contatoEmpresaId, organizacao_id: organizacaoId, categoria, habilitado: true })), { onConflict: "contato_empresa_id,categoria" });
  if (error) throw new Error(`Falha ao habilitar categorias do responsável de teste: ${error.message}`);
}

/** `filaRepo.agendarMensagem` + o responsável da empresa (quando a chamada não informa `contatoEmpresaId`). */
export async function agendarMensagemT(params, deps) {
  let p = params;
  if (p.contatoId && p.organizacaoId && p.contatoEmpresaId === undefined) {
    p = { ...p, contatoEmpresaId: await responsavelDoContato({ organizacaoId: p.organizacaoId, contatoId: p.contatoId, perfilId: p.destinatarioPerfilId ?? null }) };
  }
  if (p.contatoEmpresaId && p.tipo) await categoriaParaTipoT(p.organizacaoId, p.contatoEmpresaId, p.tipo);
  return filaRepoT.agendarMensagem(p, deps);
}

const categoriasDeTipoT = new Set();
/**
 * Migration 104 — o destinatário só recebe um TIPO de alerta se tiver habilitada uma categoria ATIVA que o mapeie. As suítes legadas usam `tipo`s
 * arbitrários (para isolar cooldown por tipo): este helper registra, no catálogo de teste, uma categoria `t_<hash>` que mapeia o tipo e a habilita
 * para o destinatário. Idempotente. Limpeza: `limparCategoriasDeTesteT()`.
 */
export async function categoriaParaTipoT(organizacaoId, contatoEmpresaId, tipo) {
  if (!organizacaoId || !contatoEmpresaId || !tipo) return;
  const codigo = `t_${createHash("sha1").update(String(tipo)).digest("hex").slice(0, 24)}`;
  const chave = `${contatoEmpresaId}|${codigo}`;
  if (categoriasDeTipoT.has(chave)) return;
  const c = await supabase.from("comunicacao_categorias").upsert({ codigo, rotulo: `teste ${String(tipo).slice(0, 40)}`, tipo_alerta: tipo, ativo: true }, { onConflict: "codigo" });
  if (c.error) throw new Error(`Falha ao registrar categoria de teste: ${c.error.message}`);
  await habilitarCategoriasT(organizacaoId, contatoEmpresaId, [codigo]);
  categoriasDeTipoT.add(chave);
}

/** Remove as categorias `t_*` criadas por `categoriaParaTipoT` (e suas habilitações). */
export async function limparCategoriasDeTesteT() {
  await supabase.from("comunicacao_destinatario_categorias").delete().like("categoria", String.raw`t\_%`);
  await supabase.from("comunicacao_categorias").delete().like("codigo", String.raw`t\_%`);
  categoriasDeTipoT.clear();
}

// ---------------------------------------------------------------------------
// Migration 104 — agendamento POR DESTINATÁRIO. As suítes antigas chamavam as RPCs de destinatário único
// (`agendarMensagemDoAlerta`/`agendarReforcoDoAlerta`/`agendarAvisoTardioD1`). Estes adaptadores mantêm a FORMA do retorno antigo
// ({acao, mensagem_id, status}) para o PRIMEIRO destinatário da resposta, sobre `agendarMensagensDoAlerta` (a única RPC vigente).
// ---------------------------------------------------------------------------
async function alvoDoAlerta(alertaId) {
  const { data: a } = await supabase.from("comunicacao_alertas").select("organizacao_id, tipo_alerta").eq("id", alertaId).maybeSingle();
  return a ?? null;
}

async function agendarPorDestinatarioT({ alertaId, proposito, origem = null, conteudo, disponivelEm, expiraEm = null, maxTentativas, contatoEmpresaId = null }, deps) {
  const a = await alvoDoAlerta(alertaId);
  let itens;
  if (a) {
    const todos = await filaRepoT.resolverDestinatarios({ organizacaoId: a.organizacao_id, tipoAlerta: a.tipo_alerta }, deps);
    const alvo = contatoEmpresaId ? todos.filter((d) => d.contato_empresa_id === contatoEmpresaId) : todos;
    itens = alvo.map((d) => ({ contatoEmpresaId: d.contato_empresa_id, conteudo, disponivelEm, expiraEm }));
  } else itens = [{ contatoEmpresaId: "00000000-0000-0000-0000-000000000000", conteudo, disponivelEm, expiraEm }];
  // sem destinatário: ainda assim chama a RPC (com um item fantasma) para que as recusas no nível da EMPRESA (NAO_HABILITADA...) continuem valendo
  const semDestinatario = !itens.length;
  if (semDestinatario) itens = [{ contatoEmpresaId: "00000000-0000-0000-0000-000000000000", conteudo, disponivelEm, expiraEm }];
  const r = await filaRepoT.agendarMensagensDoAlerta({ alertaId, proposito, origem, itens, ...(maxTentativas !== undefined ? { maxTentativas } : {}) }, deps);
  if (r.acao !== "OK") return r;
  if (semDestinatario) return { acao: "SEM_DESTINATARIO", itens: r.itens, criadas: r.criadas };
  const it = r.itens[0];
  return { ...it, acao: it.acao, itens: r.itens, criadas: r.criadas };
}

/** ≈ o antigo `filaRepo.agendarMensagemDoAlerta` (1ª mensagem do alerta). */
export function agendarMensagemDoAlertaT(params, deps) {
  return agendarPorDestinatarioT({ alertaId: params.alertaId, proposito: "inicial", conteudo: params.conteudo, disponivelEm: params.disponivelEm, expiraEm: params.expiraEm ?? null, maxTentativas: params.maxTentativas, contatoEmpresaId: params.contatoEmpresaId ?? null }, deps);
}
/** ≈ o antigo `filaRepo.agendarReforcoDoAlerta`. */
export function agendarReforcoDoAlertaT(params, deps) {
  return agendarPorDestinatarioT({ alertaId: params.alertaId, proposito: "reforco", conteudo: params.conteudo, disponivelEm: params.disponivelEm, expiraEm: params.expiraEm ?? null, maxTentativas: params.maxTentativas, contatoEmpresaId: params.contatoEmpresaId ?? null }, deps);
}
/** ≈ o antigo `filaRepo.agendarAvisoTardioD1`. */
export function agendarAvisoTardioD1T(params, deps) {
  return agendarPorDestinatarioT({ alertaId: params.alertaId, proposito: "inicial", origem: "prazo_final_d1", conteudo: params.conteudo, disponivelEm: params.disponivelEm, expiraEm: params.expiraEm ?? null, maxTentativas: params.maxTentativas, contatoEmpresaId: params.contatoEmpresaId ?? null }, deps);
}

// ---------------------------------------------------------------------------
// Migration 104 — VÁRIOS destinatários por empresa. Cada destinatário: contato (consentido/verificado) + responsável DA EMPRESA (WhatsApp VALIDADO)
// + categorias habilitadas. Sem ponteiro na habilitação: o banco resolve TODOS os elegíveis (comunicacao_resolver_destinatarios).
// ---------------------------------------------------------------------------
let seqDestEmpresa = 0;

/**
 * Cria um destinatário completo de uma empresa. `verificado`/`consentimento`/`optOut`/`ativo`/`validado`/`categorias` permitem montar os casos INELEGÍVEIS.
 * @returns {Promise<{contatoEmpresaId: string, contatoId: string, telefone: string}>}
 */
export async function criarDestinatarioEmpresa({
  organizacaoId, nome = "Destinatário de teste", tipo = "operacional", verificado = true, consentimento = true, optOut = false,
  ativo = true, validado = true, categorias = null,
}) {
  const telefone = `+551198${String(Date.now() * 17 + ++seqDestEmpresa * 104729).slice(-7)}`;
  const { data: contato, error: eC } = await supabase.from("contatos_whatsapp")
    .insert({ telefone_e164: telefone, verificado, consentimento, opt_out: optOut }).select("id").single();
  if (eC) throw new Error(`Falha ao criar contato de teste: ${eC.message}`);
  const { data: ce, error: eE } = await supabase.from("comunicacao_contatos_empresa").insert({
    organizacao_id: organizacaoId, nome, telefone_e164: telefone, tipo, contato_whatsapp_id: contato.id,
    whatsapp_status: validado ? "VALIDADO" : "AGUARDANDO_VALIDACAO", whatsapp_validado_em: validado ? new Date().toISOString() : null, ativo,
  }).select("id").single();
  if (eE) throw new Error(`Falha ao criar destinatário de teste: ${eE.message}`);
  await habilitarCategoriasT(organizacaoId, ce.id, categorias);
  return { contatoEmpresaId: ce.id, contatoId: contato.id, telefone };
}

/** Habilita a empresa SEM ponteiro de destinatário (o banco resolve todos). `extra` sobrescreve colunas (ex.: envio_automatico:false, limite_diario_org). */
export async function habilitarEmpresaMulti(organizacaoId, extra = {}) {
  const linha = { organizacao_id: organizacaoId, habilitado: true, envio_automatico: extra.habilitado !== false, tipos_permitidos: ["dashboard_ifood_d1"], timezone: "America/Fortaleza", ...extra };
  const { error } = await supabase.from("comunicacao_habilitacoes").upsert(linha, { onConflict: "organizacao_id" });
  if (error) throw new Error(`Falha ao habilitar a empresa de teste: ${error.message}`);
}

/** Remove destinatários (mensagens, categorias, responsável, contato) criados por `criarDestinatarioEmpresa`. */
export async function apagarDestinatarioEmpresa(d) {
  if (!d) return;
  await supabase.from("comunicacao_mensagens").delete().eq("contato_id", d.contatoId);
  await supabase.from("comunicacao_destinatario_categorias").delete().eq("contato_empresa_id", d.contatoEmpresaId);
  await supabase.from("comunicacao_contatos_empresa").delete().eq("id", d.contatoEmpresaId);
  await supabase.from("contatos_whatsapp").delete().eq("id", d.contatoId);
}

/**
 * Migration 104 — teto de destinatários ativos por empresa (comunicacao_configuracoes.destinatarios). As suítes legadas criam muitos "responsáveis" só para
 * isolar cooldown/cota por contato: elevam o teto durante a suíte e o restauram. Devolve o valor ANTERIOR (para `restaurarTetoDestinatariosT`).
 */
export async function definirTetoDestinatariosT(n) {
  const { data } = await supabase.from("comunicacao_configuracoes").select("valor").eq("chave", "destinatarios").maybeSingle();
  await supabase.from("comunicacao_configuracoes").upsert({ chave: "destinatarios", valor: { max_ativos_por_organizacao: n } }, { onConflict: "chave" });
  return data?.valor ?? null;
}
export async function restaurarTetoDestinatariosT(anterior) {
  if (anterior) await supabase.from("comunicacao_configuracoes").upsert({ chave: "destinatarios", valor: anterior }, { onConflict: "chave" });
  else await supabase.from("comunicacao_configuracoes").delete().eq("chave", "destinatarios");
}

/** Apaga os destinatários (responsáveis) das empresas — cascade nas categorias. Usar no `beforeEach` das suítes que criam responsáveis à vontade. */
export async function apagarDestinatariosDasEmpresasT(organizacaoIds) {
  await supabase.from("comunicacao_contatos_empresa").delete().in("organizacao_id", organizacaoIds.filter(Boolean));
}
