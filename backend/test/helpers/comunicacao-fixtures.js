// Fixtures descartáveis para as suítes de integração do módulo de
// Comunicação — mesmo espírito de agente-conversas-isolamento.test.js
// (cria e apaga suas próprias organizações/contas, nunca toca dado real).
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

/** Migration 092 (reforço do dia: comunicacao_agendar_reforco_alerta) está aplicada neste Supabase? */
export async function migracao092Aplicada() {
  // sonda SEM efeito colateral: alerta inexistente -> ALERTA_INEXISTENTE, nunca escreve nada
  const sonda = await supabase.rpc("comunicacao_agendar_reforco_alerta", {
    p_alerta_id: "00000000-0000-0000-0000-000000000000", p_conteudo: "probe",
    p_idempotency_key: "probe", p_disponivel_em: new Date().toISOString(), p_expira_em: null, p_max_tentativas: 1,
  });
  return !sonda.error;
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
    organizacao_id: organizacaoId, habilitado: true, tipos_permitidos: ["dashboard_ifood_d1"], timezone: "America/Fortaleza",
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
      if (!eCe && ce) { linha.destinatario_contato_empresa_id = ce.id; dest.contatoEmpresaId = ce.id; }
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
  if (existente) return existente.id;
  const { data: c } = await supabase.from("contatos_whatsapp").select("telefone_e164").eq("id", contatoId).maybeSingle();
  if (!c) return null;
  const { data: principal } = await supabase.from("comunicacao_contatos_empresa").select("id")
    .eq("organizacao_id", organizacaoId).eq("tipo", "principal").eq("ativo", true).maybeSingle();
  const { data: novo, error } = await supabase.from("comunicacao_contatos_empresa").insert({
    organizacao_id: organizacaoId, nome: "Responsável de teste", telefone_e164: c.telefone_e164, tipo: principal ? "operacional" : "principal",
    contato_whatsapp_id: contatoId, perfil_operacional_id: perfilId, whatsapp_status: "VALIDADO", whatsapp_validado_em: new Date().toISOString(), ativo: true,
  }).select("id").single();
  if (error) throw new Error(`Falha ao criar responsável de teste: ${error.message}`);
  return novo.id;
}

/** `filaRepo.agendarMensagem` + o responsável da empresa (quando a chamada não informa `contatoEmpresaId`). */
export async function agendarMensagemT(params, deps) {
  let p = params;
  if (p.contatoId && p.organizacaoId && p.contatoEmpresaId === undefined) {
    p = { ...p, contatoEmpresaId: await responsavelDoContato({ organizacaoId: p.organizacaoId, contatoId: p.contatoId, perfilId: p.destinatarioPerfilId ?? null }) };
  }
  return filaRepoT.agendarMensagem(p, deps);
}
