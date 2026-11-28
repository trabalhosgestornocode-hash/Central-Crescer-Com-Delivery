// 28/11 — ENSAIO do kit de produção da 0036 (`corrigir_conta_a_pagar`) num PostgreSQL REAL isolado (identificadores SINTÉTICOS):
//   backup verificado → reversão (volta EXATAMENTE à 0035: funções do Git, políticas sem o termo, sem referência à ação) →
//   atualizar.sql de produção (base 0035; aplica SÓ a 0036) devolve políticas/funções/restrição IDÊNTICAS às de antes (ida e volta) →
//   conferência → concessão PROTEGIDA (só acrescenta; isolamento) → repetir é recusado → alterações legítimas posteriores →
//   reversão que não as desfaz.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { motivoParaPular, repositorioPostgresDeTeste } from "./helpers/postgres.js";
import { ESCOPOS_PADRAO } from "./helpers/cenario.js";
import { ACAO_0036, gerarKit, hashDa0036, PRODUCAO } from "../../scripts/fv2/kitCorrecao0036.mjs";
import { sqlConcessaoOperacionalDoMova, sqlRevogarConcessaoOperacionalDoMova } from "../../scripts/fv2/pacoteProducao.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ler = (n) => fs.readFileSync(path.join(RAIZ, "database/financeiro-v2/producao", n), "utf8");
const parte = (sql, letra) => { const i = sql.indexOf(`-- ===================== ${letra})`); const j = letra === "A" ? sql.indexOf("-- ===================== B)") : sql.length; return sql.slice(i, j); };
const ACAO = ACAO_0036;
const MOVA = "eeeeeeee-0000-4000-8000-0000000004a5";
const DONO = "eeeeeeee-0000-4000-8000-0000000004d0";
const OUTRA = "eeeeeeee-0000-4000-8000-0000000004b1";
const [U1, U2, U3] = ESCOPOS_PADRAO;

test("KIT-0036 o kit de produção é o gerado agora (nada editado à mão); só acrescenta a ação às vigentes; nenhuma ampla nem sangria", () => {
  const gerado = gerarKit(PRODUCAO);
  for (const [n, c] of Object.entries(gerado)) assert.equal(ler(`correcao-0036/${n}`), c, `${n} difere do gerador`);
  assert.match(gerado["04-concessao.sql"], /Açaí no Grau Saci/);
  assert.match(gerado["04-concessao.sql"], /Subway Saci/);
  const nova = JSON.parse(/set acoes = '(\[[^']*\])'::jsonb/.exec(gerado["04-concessao.sql"])[1]);
  assert.deepEqual(nova, [...PRODUCAO.vigentes, ACAO].sort());
  assert.ok(!nova.includes("financeiro_v2.prestar_sangria") && !nova.includes("financeiro_v2.corrigir"), "sem sangria e sem a ação AMPLA de corrigir");
  assert.throws(() => gerarKit({ ...PRODUCAO, vigentes: [...PRODUCAO.vigentes, "financeiro_v2.prestar_sangria"] }));
  assert.throws(() => gerarKit({ ...PRODUCAO, vigentes: [...PRODUCAO.vigentes, "financeiro_v2.corrigir"] }), /fora da lista estreita/);
  assert.equal(hashDa0036(), gerado["LEIA-ME.txt"].match(/Hash da 0036: ([0-9a-f]{64})/)[1]);
});

test("KIT-0036 ensaio completo: backup, reversão exata para a 0035, ida e volta idêntica, concessão protegida, isolamento, duplicidade e reversão que preserva alterações legítimas",
  { skip: motivoParaPular(), timeout: 300000 }, async () => {
    const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO, { concessoesDeTeste: false });
    const dono = await (await repositorio.interno()).dono();
    const q = (sql) => dono.query(sql);
    const comoMigrador = async (sql) => { const c = await dono.connect(); try { await c.query("set role fv2_teste_migrador"); return await c.query(sql); } finally { try { await c.query("rollback"); await c.query("reset role"); } catch { /* descartada */ } c.release(); } };
    const emTx = (sql) => `begin;\n${sql}\ncommit;`;
    const retrato = async () => (await q(`select
      (select count(*)::int from financeiro_v2.fv2_migracao) n,
      (select json_agg(json_build_object('p', p.polname, 'u', pg_get_expr(p.polqual, p.polrelid), 'c', pg_get_expr(p.polwithcheck, p.polrelid)) order by c.relname, p.polname)
         from pg_policy p join pg_class c on c.oid = p.polrelid where c.relnamespace = 'financeiro_v2'::regnamespace) politicas,
      (select json_object_agg(proname, md5(prosrc)) from pg_proc where pronamespace = 'financeiro_v2'::regnamespace) funcoes,
      (select json_agg(tgname order by tgname) from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relnamespace = 'financeiro_v2'::regnamespace and not t.tgisinternal) gatilhos,
      (select pg_get_constraintdef(oid) from pg_constraint where conname = 'fv2_concessao_acoes_lista') restricao`)).rows[0];
    const concessao = async (u, usuario = MOVA) => (await q(`select versao, situacao, acoes from financeiro_v2.fv2_concessao where organizacao_id = '${u.organizacaoId}' and unidade_id = '${u.unidadeId}' and usuario_id = '${usuario}'`)).rows[0];
    const conferir = async (kit) => (await q(kit["03-conferencia.sql"])).rows[0];

    const comA0036 = await retrato();
    assert.equal(comA0036.n, 36, "banco de teste com a 0036");
    const kit = gerarKit({ identidade: MOVA, proprietario: DONO, unidades: [{ nome: "Unidade Um", ...U1, versao: 1 }, { nome: "Unidade Dois", ...U2, versao: 1 }], vigentes: PRODUCAO.vigentes, data: "20990101" });

    // 01 backup VERIFICADO (2 funções + restrição + 4 políticas)
    const b = await q(kit["01-backup.sql"]);
    assert.equal(Number(b.at(-2).rows[0].objetos), 7);
    // 05-B: volta EXATAMENTE à 0035 — nenhuma referência à ação; funções da 0031/0014 idênticas ao Git
    await comoMigrador(parte(kit["05-reversao.sql"], "B"));
    const sem = await retrato();
    assert.equal(sem.n, 35);
    assert.ok(!JSON.stringify(sem.politicas).includes("corrigir_conta_a_pagar") && !sem.restricao.includes("corrigir_conta_a_pagar"), "nada da 0036 nas políticas e na restrição");
    for (const f of ["fv2_so_corrige_conta", "fv2_conta_corrigivel", "fv2_correcao_de_conta", "fv2_correcao_de_lancamento"]) assert.equal(sem.funcoes[f], undefined, `${f} removida`);
    assert.ok(!sem.gatilhos.includes("fv2_obrigacao_correcao_estreita") && !sem.gatilhos.includes("fv2_lancamento_correcao_estreita"));
    // 02: atualizar.sql de produção (base 0035) → ida e volta IDÊNTICA (políticas, funções, gatilhos, restrição)
    await comoMigrador(ler("atualizar.sql"));
    assert.deepEqual(await retrato(), comA0036, "reaplicar a 0036 depois da reversão devolve exatamente o mesmo banco");
    let c = await conferir(kit);
    assert.deepEqual([Number(c.migracoes), c.tem_0036, c.hash_confere, c.acao_na_lista, Number(c.funcoes_novas), Number(c.gatilhos_novos), Number(c.concessoes_com_a_acao)], [36, true, true, true, 4, 2, 0]);

    // concessões vigentes (como produção) + OUTRA identidade em U1 + MOVA em U3 (fora do kit)
    const conceder = (u, usuario, acoes) => comoMigrador(emTx(sqlConcessaoOperacionalDoMova({ identidade: usuario, organizacaoId: u.organizacaoId, unidadeId: u.unidadeId, acoes, concedidoPor: DONO, justificativa: "Ensaio sintético" })));
    await conceder(U1, MOVA, PRODUCAO.vigentes); await conceder(U2, MOVA, PRODUCAO.vigentes);
    await conceder(U1, OUTRA, ["financeiro_v2.ver", "financeiro_v2.registrar_obrigacao"]);
    await conceder(U3, MOVA, ["financeiro_v2.ver", "financeiro_v2.registrar_obrigacao"]);
    const antesOutra = await concessao(U1, OUTRA); const antesU3 = await concessao(U3);

    // 04: concessão protegida
    await comoMigrador(kit["04-concessao.sql"]);
    for (const u of [U1, U2]) assert.deepEqual(await concessao(u), { versao: 2, situacao: "ATIVA", acoes: [...PRODUCAO.vigentes, ACAO].sort() });
    assert.deepEqual(await concessao(U1, OUTRA), antesOutra, "isolamento: outra identidade intacta");
    assert.deepEqual(await concessao(U3), antesU3, "isolamento: unidade fora do kit intacta");
    c = await conferir(kit);
    assert.deepEqual([Number(c.concessoes_com_a_acao), Number(c.fora_do_alcance), Number(c.com_sangria)], [2, 0, 0]);
    assert.equal(Number((await q(`select count(*) n from financeiro_v2.fv2_historico where registro_tipo = 'CONCESSAO' and depois->'acoes' ? '${ACAO}'`)).rows[0].n), 2);
    // duplicidade: rodar o 04 de novo é RECUSADO e nada muda
    await assert.rejects(comoMigrador(kit["04-concessao.sql"]), /mudou desde a revisão/);
    for (const u of [U1, U2]) assert.equal((await concessao(u)).versao, 2);

    // alterações LEGÍTIMAS depois: U1 perde registrar_juros; U2 é revogada
    await conceder(U1, MOVA, [...PRODUCAO.vigentes, ACAO].filter((a) => a !== "financeiro_v2.registrar_juros"));
    await comoMigrador(emTx(sqlRevogarConcessaoOperacionalDoMova({ identidade: MOVA, organizacaoId: U2.organizacaoId, unidadeId: U2.unidadeId, revogadoPor: DONO, justificativa: "Ensaio: revogação legítima" })));
    const u2Revogada = await concessao(U2);
    assert.equal(u2Revogada.situacao, "REVOGADA");
    // 05-A: tira SÓ a ação; não devolve registrar_juros; não reativa U2; não toca a outra identidade; idempotente
    await comoMigrador(parte(kit["05-reversao.sql"], "A"));
    assert.deepEqual((await concessao(U1)).acoes, PRODUCAO.vigentes.filter((a) => a !== "financeiro_v2.registrar_juros").sort());
    assert.deepEqual(await concessao(U2), u2Revogada);
    assert.deepEqual(await concessao(U1, OUTRA), antesOutra);
    const v = (await concessao(U1)).versao;
    await comoMigrador(parte(kit["05-reversao.sql"], "A"));
    assert.equal((await concessao(U1)).versao, v, "rodar a reversão de novo não faz nada");
    // 05-B e reaplicação: o banco de teste termina como começou
    await comoMigrador(parte(kit["05-reversao.sql"], "B"));
    assert.equal((await retrato()).n, 35);
    await comoMigrador(ler("atualizar.sql"));
    assert.deepEqual(await retrato(), comA0036);
  });
