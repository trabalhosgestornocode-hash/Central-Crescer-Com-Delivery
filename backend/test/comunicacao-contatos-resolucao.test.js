// Integração — resolverPerfilDoContato contra o Supabase REAL: telefone
// nunca concede permissão sozinho (teste 19), e contato com múltiplos
// perfis válidos não escolhe silenciosamente um contexto sensível (teste 20).
// Rodar: node --env-file=.env --test test/comunicacao-contatos-resolucao.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import {
  criarOrganizacao, apagarOrganizacao, criarUnidade, criarContaComPerfil, apagarConta,
  vincularUsuarioUnidade, migracao082Aplicada,
} from "./helpers/comunicacao-fixtures.js";
import * as contatosRepo from "../src/modules/comunicacao/comunicacao.contatos.repo.js";

const PULAR_INTEGRACAO = motivoPularIntegracao();
let migracaoOk = true;
const tag = `comcontatos${Date.now()}`;

let orgId = null, unidadeId = null;
const contas = []; // {contaId, perfilId}

before(async () => {
  if (PULAR_INTEGRACAO) return;
  migracaoOk = await migracao082Aplicada();
  if (!migracaoOk) return;
  orgId = await criarOrganizacao("TESTE comunicacao-contatos — descartável");
  unidadeId = await criarUnidade(orgId, "Unidade Teste");
});

after(async () => {
  for (const c of contas) await apagarConta(c.contaId);
  await apagarOrganizacao(orgId);
});

async function novaContaVinculada(sufixo) {
  const c = await criarContaComPerfil(tag, sufixo);
  contas.push(c);
  await vincularUsuarioUnidade({ perfilId: c.perfilId, organizacaoId: orgId, unidadeId });
  return c;
}

describe("comunicacao.contatos — resolução (telefone nunca autoriza sozinho)", { skip: PULAR_INTEGRACAO }, () => {
  test("teste 19 — telefone vinculado a um perfil SEM vínculo real na organização não resolve (SEM_VINCULO)", async (t) => {
    if (!migracaoOk) return t.skip("migration 082 ainda não aplicada — pulando.");
    // perfil existe, mas NUNCA foi vinculado a usuarios_organizacoes/usuarios_unidades desta org.
    const conta = await criarContaComPerfil(tag, "sem-vinculo");
    contas.push(conta);

    const contato = await contatosRepo.criarOuObterContato({ telefoneE164: `+551198${String(Date.now()).slice(-7)}` });
    await contatosRepo.vincularPerfil({ contatoId: contato.id, perfilOperacionalId: conta.perfilId });

    const r = await contatosRepo.resolverPerfilDoContato({ contatoId: contato.id, organizacaoId: orgId, unidadeId });
    assert.equal(r, null, "telefone sem vínculo real deveria devolver null (nenhuma permissão concedida)");

    await supabase.from("contatos_whatsapp").delete().eq("id", contato.id);
  });

  test("teste 20 — contato com dois perfis válidos na MESMA organização/unidade não escolhe sozinho (ambíguo)", async (t) => {
    if (!migracaoOk) return t.skip("migration 082 ainda não aplicada — pulando.");
    const contaX = await novaContaVinculada("x");
    const contaY = await novaContaVinculada("y");

    const contato = await contatosRepo.criarOuObterContato({ telefoneE164: `+551197${String(Date.now()).slice(-7)}` });
    await contatosRepo.vincularPerfil({ contatoId: contato.id, perfilOperacionalId: contaX.perfilId });
    await contatosRepo.vincularPerfil({ contatoId: contato.id, perfilOperacionalId: contaY.perfilId });

    const r = await contatosRepo.resolverPerfilDoContato({ contatoId: contato.id, organizacaoId: orgId, unidadeId });
    assert.equal(r?.ambiguo, true, "esperava recusa explícita (ambíguo) em vez de escolher um perfil sozinho");
    assert.equal(r.perfis.length, 2);
    assert.ok(r.perfis.includes(contaX.perfilId));
    assert.ok(r.perfis.includes(contaY.perfilId));

    await supabase.from("contatos_whatsapp").delete().eq("id", contato.id);
  });

  test("um único perfil válido resolve normalmente (caso comum)", async (t) => {
    if (!migracaoOk) return t.skip("migration 082 ainda não aplicada — pulando.");
    const conta = await novaContaVinculada("unico");
    const contato = await contatosRepo.criarOuObterContato({ telefoneE164: `+551196${String(Date.now()).slice(-7)}` });
    await contatosRepo.vincularPerfil({ contatoId: contato.id, perfilOperacionalId: conta.perfilId });

    const r = await contatosRepo.resolverPerfilDoContato({ contatoId: contato.id, organizacaoId: orgId, unidadeId });
    assert.equal(r?.perfilId, conta.perfilId);

    await supabase.from("contatos_whatsapp").delete().eq("id", contato.id);
  });

  test("nenhum vínculo cadastrado -> null (sem lançar)", async (t) => {
    if (!migracaoOk) return t.skip("migration 082 ainda não aplicada — pulando.");
    const contato = await contatosRepo.criarOuObterContato({ telefoneE164: `+551195${String(Date.now()).slice(-7)}` });
    const r = await contatosRepo.resolverPerfilDoContato({ contatoId: contato.id, organizacaoId: orgId, unidadeId });
    assert.equal(r, null);
    await supabase.from("contatos_whatsapp").delete().eq("id", contato.id);
  });
});
