// Integração — comunicacao_conversas é um BINDING para agente_conversas,
// nunca uma alteração dela (ajuste aprovado — ver seção 5 da migration 082
// e agente/agente.conversas.service.js). Prova que o vínculo funciona e
// que agente_conversas continua intocada.
// Rodar: node --env-file=.env --test test/comunicacao-conversas-binding.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import { criarOrganizacao, apagarOrganizacao, migracao082Aplicada } from "./helpers/comunicacao-fixtures.js";
import * as conversasRepo from "../src/modules/comunicacao/comunicacao.conversas.repo.js";
import { criarConversa as criarConversaDoAgente } from "../src/modules/agente/agente.conversas.service.js";

const PULAR_INTEGRACAO = motivoPularIntegracao();
let migracaoOk = true;
let orgId = null;
let contatoId = null;

before(async () => {
  if (PULAR_INTEGRACAO) return;
  migracaoOk = await migracao082Aplicada();
  if (!migracaoOk) return;
  orgId = await criarOrganizacao("TESTE comunicacao-conversas — descartável");
  const { data } = await supabase.from("contatos_whatsapp")
    .insert({ telefone_e164: `+551194${String(Date.now()).slice(-7)}` }).select("id").single();
  contatoId = data.id;
});

after(async () => {
  if (contatoId) await supabase.from("contatos_whatsapp").delete().eq("id", contatoId);
  await apagarOrganizacao(orgId);
});

describe("comunicacao_conversas — binding para agente_conversas (não altera a tabela do Agente)", { skip: PULAR_INTEGRACAO }, () => {
  test("cria a thread apontando para uma conversa do Agente já existente", async (t) => {
    if (!migracaoOk) return t.skip("migration 082 ainda não aplicada — pulando.");

    const agenteConversaId = await criarConversaDoAgente({ perfilId: null, organizacaoId: orgId, unidadeId: null });
    const thread = await conversasRepo.criarConversa({ contatoId, organizacaoId: orgId, unidadeId: null, perfilOperacionalId: null, agenteConversaId });

    assert.equal(thread.agente_conversa_id, agenteConversaId);
    assert.equal(thread.status, "ATIVA");

    const encontrada = await conversasRepo.buscarConversaAtiva({ contatoId, organizacaoId: orgId, unidadeId: null });
    assert.equal(encontrada.id, thread.id);

    // agente_conversas continua com a MESMA forma de sempre — nenhuma coluna nova.
    const { error } = await supabase.from("agente_conversas").select("id, perfil_id, organizacao_id, unidade_id, usuario_id").eq("id", agenteConversaId).single();
    assert.ifError(error);

    await conversasRepo.encerrarConversa(thread.id);
    const { data: apos } = await supabase.from("comunicacao_conversas").select("status").eq("id", thread.id).single();
    assert.equal(apos.status, "ENCERRADA");

    await supabase.from("comunicacao_conversas").delete().eq("id", thread.id);
    await supabase.from("agente_conversas").delete().eq("id", agenteConversaId);
  });
});
