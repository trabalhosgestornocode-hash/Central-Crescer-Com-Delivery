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
  const { error: eOrg } = await supabase.from("usuarios_organizacoes")
    .insert({ usuario_id: perfilId, organizacao_id: organizacaoId, papel, perfil_id: perfilId, ativo: true });
  if (eOrg) throw new Error(`Falha ao vincular usuarios_organizacoes: ${eOrg.message}`);
  if (unidadeId) {
    const { error: eUni } = await supabase.from("usuarios_unidades")
      .insert({ usuario_id: perfilId, unidade_id: unidadeId, perfil_id: perfilId, ativo: true });
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
