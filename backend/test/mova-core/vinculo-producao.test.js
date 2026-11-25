// §5 — montagem de produção do vínculo: entradas da LISTA autorizada, reconhecimento na conversa privada e o acesso da plataforma
// calculado pelas MESMAS regras do seletor de contexto (sem sessão, sem token).
import { test } from "node:test";
import assert from "node:assert/strict";
import { entradasDaConfiguracao, criarIdentificadorPelaLista, montarVinculoDeProducao } from "../../src/modules/fv2-integracao/movaVinculo.js";
import { acessoDoPerfilParaMova } from "../../src/modules/sessao/sessao.service.js";

const O1 = "aaaaaaaa-0000-4000-8000-000000000001", O2 = "aaaaaaaa-0000-4000-8000-000000000002";
const U1 = "bbbbbbbb-0000-4000-8000-000000000001", U2 = "bbbbbbbb-0000-4000-8000-000000000002", U3 = "bbbbbbbb-0000-4000-8000-000000000003";
const ANA = "5585999990001@s.whatsapp.net", BIA = "5585999990002@s.whatsapp.net";
const CFG = {
  unidades: [{ unidadeId: U1, organizacaoId: O1 }, { unidadeId: U2, organizacaoId: O1 }, { unidadeId: U3, organizacaoId: O2 }],
  gruposAutorizados: [
    { grupoId: "1@g.us", unidades: [U1], acesso: "LISTA", participantes: [{ ids: [ANA], nome: "Ana", unidades: [U1], privado: ANA }] },
    { grupoId: "2@g.us", unidades: [U2], acesso: "LISTA", participantes: [{ ids: [ANA], nome: "Ana", unidades: [U2], privado: ANA }, { ids: [BIA], nome: "Bia", unidades: [U2] }] },
    { grupoId: ANA, unidades: [U1, U2], acesso: "LISTA", privada: true, participantes: [{ ids: [ANA], nome: "Ana", privado: ANA }] },
    { grupoId: "3@g.us", unidades: [U3], acesso: "ABERTO", participantes: [] },
    { grupoId: "4@g.us", unidades: [U3], acesso: "LISTA", entregador: true, participantes: [{ ids: [BIA] }] },
    { grupoId: "5@g.us", unidades: [U1, U3], acesso: "LISTA", participantes: [{ ids: [BIA] }] },
  ],
};

test("VP-01 a mesma pessoa em vários grupos é UMA entrada; grupo aberto, de entregadores ou que mistura empresas não gera entrada; o id não expõe o número", () => {
  const m = entradasDaConfiguracao(CFG);
  assert.deepEqual([...m.keys()], [O1]);
  const e = m.get(O1);
  assert.equal(e.length, 2);
  const ana = e.find((x) => x.nome === "Ana");
  assert.deepEqual(ana.unidades.sort(), [U1, U2].sort());
  assert.ok(!ana.id.includes("5585"));
});

test("VP-02 reconhecimento: na conversa privada vale; no grupo não é privado; fora da lista ⇒ null", () => {
  const id = criarIdentificadorPelaLista(() => CFG);
  assert.equal(id({ grupoId: ANA, participanteId: ANA }).privado, true);
  assert.equal(id({ grupoId: ANA, participanteId: ANA }).organizacaoId, O1);
  assert.equal(id({ grupoId: "2@g.us", participanteId: BIA }).privado, false);
  assert.equal(id({ grupoId: "1@g.us", participanteId: "5585000000000@s.whatsapp.net" }), null);
});

test("VP-03 acessoDoPerfilParaMova segue o seletor: sem vínculo ⇒ null; unidade sem acesso ⇒ null; empresa bloqueada ⇒ null; perfil inativo ⇒ null", async () => {
  const base = { lerPerfil: async (id) => ({ id, conta_id: "conta-1", ativo: true }), unidadesDaOrg: async () => [{ id: U1 }, { id: U2 }], modulosDaEmpresa: async () => ["financeiro"], modulosDaUnidade: async () => ["financeiro"] };
  const comOrg = (papel, status = "ativa") => ({ ...base, buscarVinculoOrgDoPerfil: async () => ({ papel, organizacoes: { id: O1, status } }) });
  const a = await acessoDoPerfilParaMova({ perfilId: "p1", organizacaoId: O1 }, comOrg("gerente"));
  assert.deepEqual([a.papel, a.unidades, a.impersonando, a.contaId], ["gerente", [U1, U2], false, "conta-1"]);
  assert.ok(Array.isArray(a.permissoes) && a.permissoes.length > 0);
  assert.equal(await acessoDoPerfilParaMova({ perfilId: "p1", organizacaoId: O1 }, { ...base, buscarVinculoOrgDoPerfil: async () => null }), null);
  assert.equal(await acessoDoPerfilParaMova({ perfilId: "p1", organizacaoId: O1 }, comOrg("gerente", "bloqueada")), null);
  assert.equal(await acessoDoPerfilParaMova({ perfilId: "p1", organizacaoId: O1, unidadeId: U3 }, { ...comOrg("gerente"), acessoEfetivoDaUnidade: async () => ({ autorizado: false }) }), null);
  assert.equal(await acessoDoPerfilParaMova({ perfilId: "p1", organizacaoId: O1 }, { ...comOrg("gerente"), lerPerfil: async () => ({ ativo: false }) }), null);
  const u = await acessoDoPerfilParaMova({ perfilId: "p1", organizacaoId: O1, unidadeId: U1 }, { ...comOrg(null), acessoEfetivoDaUnidade: async () => ({ autorizado: true, papel: "operador", unidade: { id: U1 } }), statusDaEmpresa: async () => "ativa" });
  assert.deepEqual([u.papel, u.unidades], ["operador", [U1]]);
});

test("VP-04 a montagem é PREGUIÇOSA (nenhuma conexão até o 1º uso), usa pool de no máximo 2 e repete a tentativa se a 1ª falhar", async () => {
  const pools = []; let falhar = true; let fechados = 0;
  const pg = { Pool: class { constructor(o) { this.o = o; pools.push(o); } on() {} async end() { fechados += 1; } } };
  const m = montarVinculoDeProducao({ env: { MOVA_DATABASE_URL: "postgres://x", MOVA_VINCULO_POOL_MAX: "9" }, pg,
    carregarCfg: async () => { if (falhar) throw new Error("fora"); return CFG; }, acessoDoPerfil: async () => null, auditar: async () => {},
    criarServico: (d) => ({ d }), criarRepositorio: () => ({}) });
  assert.equal(pools.length, 0);
  await assert.rejects(m.servico());
  falhar = false;
  assert.ok(await m.servico());
  assert.equal((await m.entradasDaOrganizacao(O1)).length, 2);
  assert.deepEqual(pools.map((p) => p.max), [2, 2]);
  assert.equal(fechados, 1, "o pool da tentativa que falhou foi fechado");
});
