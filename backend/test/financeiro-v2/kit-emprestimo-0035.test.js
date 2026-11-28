// 27–28/11 — ENSAIO do kit de produção da 0035 num PostgreSQL REAL isolado (identificadores SINTÉTICOS):
//   backup verificado → reversão (volta à 0034) → atualizar.sql de produção (aplica SÓ a 0035; confere nome+hash) → conferência do hash →
//   concessão PROTEGIDA (só acrescenta a ação; isolamento: outras identidades/unidades intactas) → repetir a concessão é recusado
//   (sem duplicidade) → alterações LEGÍTIMAS posteriores (ação retirada, concessão revogada) → reversão protegida NÃO as desfaz.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { motivoParaPular, repositorioPostgresDeTeste } from "./helpers/postgres.js";
import { ESCOPOS_PADRAO } from "./helpers/cenario.js";
import { atualizarAte0035, gerarKit, hashDa0035, PRODUCAO } from "../../scripts/fv2/kitEmprestimo0035.mjs";
import { gerarKit as gerarKit0036, PRODUCAO as PRODUCAO_0036 } from "../../scripts/fv2/kitCorrecao0036.mjs";
import { atualizar } from "../../scripts/fv2/pacoteProducao.mjs";
import { gerarKit as gerarKit0037, PRODUCAO as PRODUCAO_0037 } from "../../scripts/fv2/kitOperacoes0037.mjs";
import { sqlConcessaoOperacionalDoMova, sqlRevogarConcessaoOperacionalDoMova } from "../../scripts/fv2/pacoteProducao.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ler = (n) => fs.readFileSync(path.join(RAIZ, "database/financeiro-v2/producao", n), "utf8");
const parte = (sql, letra) => { const i = sql.indexOf(`-- ===================== ${letra})`); const j = letra === "A" ? sql.indexOf("-- ===================== B)") : sql.length; return sql.slice(i, j); };
const ACAO = "financeiro_v2.registrar_emprestimo";

const MOVA = "eeeeeeee-0000-4000-8000-0000000003a5"; // identidade operacional SINTÉTICA
const DONO = "eeeeeeee-0000-4000-8000-0000000003d0";
const OUTRA = "eeeeeeee-0000-4000-8000-0000000003b1"; // outra identidade (isolamento)
const [U1, U2, U3] = ESCOPOS_PADRAO;

test("KIT-0035 o kit de produção é o gerado agora (nada editado à mão) e usa as concessões vigentes conferidas", () => {
  const gerado = gerarKit(PRODUCAO);
  for (const [n, c] of Object.entries(gerado)) assert.equal(ler(`emprestimo-0035/${n}`), c, `${n} difere do gerador`);
  assert.match(gerado["04-concessao.sql"], /Açaí no Grau Saci/);
  assert.match(gerado["04-concessao.sql"], /Subway Saci/);
  const nova = JSON.parse(/set acoes = '(\[[^']*\])'::jsonb/.exec(gerado["04-concessao.sql"])[1]);
  assert.deepEqual(nova, [...PRODUCAO.vigentes, ACAO].sort(), "as vigentes + só a nova");
  assert.ok(!nova.includes("financeiro_v2.prestar_sangria"), "sangria fora");
  assert.throws(() => gerarKit({ ...PRODUCAO, vigentes: [...PRODUCAO.vigentes, "financeiro_v2.prestar_sangria"] }));
  assert.throws(() => gerarKit({ ...PRODUCAO, vigentes: [...PRODUCAO.vigentes, "financeiro_v2.registrar"] }), /fora da lista estreita/, "nenhuma ação ampla");
});

test("KIT-0035 ensaio completo: backup verificado, reversão, atualizar.sql, hash, concessão protegida, isolamento, duplicidade e reversão que não desfaz alterações legítimas",
  { skip: motivoParaPular(), timeout: 300000 }, async () => {
    const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO, { concessoesDeTeste: false });
    const dono = await (await repositorio.interno()).dono();
    const q = (sql) => dono.query(sql);
    const comoMigrador = async (sql) => { const c = await dono.connect(); try { await c.query("set role fv2_teste_migrador"); return await c.query(sql); } finally { try { await c.query("rollback"); await c.query("reset role"); } catch { /* descartada */ } c.release(); } }; // erro no meio: a conexão volta limpa ao pool
    const emTx = (sql) => `begin;\n${sql}\ncommit;`;
    const estado = async () => (await q(`select (select count(*)::int from financeiro_v2.fv2_migracao) n,
      (select pg_get_constraintdef(oid) like '%registrar_emprestimo%' from pg_constraint where conname = 'fv2_concessao_acoes_lista') acao,
      (select count(*)::int from pg_proc where proname = 'fv2_principal_de_emprestimo') funcao`)).rows[0];
    const concessao = async (u, usuario = MOVA) => (await q(`select versao, situacao, acoes from financeiro_v2.fv2_concessao where organizacao_id = '${u.organizacaoId}' and unidade_id = '${u.unidadeId}' and usuario_id = '${usuario}'`)).rows[0];
    const conferir = async (kit) => (await q(kit["03-conferencia.sql"])).rows[0];

    // 28/11: o banco de teste já tem a 0036 (aplicada por cima da 0035); o ensaio da 0035 começa revertendo a 0036 pelo PRÓPRIO kit dela
    await comoMigrador(parte(gerarKit0037({ ...PRODUCAO_0037, identidade: MOVA, proprietario: DONO, unidades: [], data: "20990102" })["05-reversao.sql"], "B"));
    const kit36 = gerarKit0036({ ...PRODUCAO_0036, identidade: MOVA, proprietario: DONO, unidades: [], data: "20990101" });
    await comoMigrador(parte(kit36["05-reversao.sql"], "B"));
    assert.deepEqual(await estado(), { n: 35, acao: true, funcao: 1 }, "banco de teste com a 0035 (sem a 0036)");
    const kit = gerarKit({ identidade: MOVA, proprietario: DONO, unidades: [{ nome: "Unidade Um", ...U1, versao: 1 }, { nome: "Unidade Dois", ...U2, versao: 1 }], vigentes: PRODUCAO.vigentes, data: "20990101" });

    // 01 backup VERIFICADO (cópia conferida por hash; pelo dono, como o postgres em produção)
    const b = await q(kit["01-backup.sql"]);
    assert.equal(Number(b.at(-2).rows[0].objetos), 2, "backup da função e da restrição");
    // 05-B: volta à 0034 (sem concessão com a ação)
    await comoMigrador(parte(kit["05-reversao.sql"], "B"));
    assert.deepEqual(await estado(), { n: 34, acao: false, funcao: 0 }, "reversão: volta exatamente à 0034");
    // 02: atualizar.sql de produção (confere as 34 por nome+hash; aplica SÓ a 0035)
    await comoMigrador(atualizarAte0035());
    assert.deepEqual(await estado(), { n: 35, acao: true, funcao: 1 });
    let c = await conferir(kit);
    assert.deepEqual([Number(c.migracoes), c.tem_0035, c.hash_confere, c.acao_na_lista, Number(c.funcao_nova), Number(c.concessoes_com_a_acao)], [35, true, true, true, 1, 0]);
    assert.equal((await q(`select sha256 from financeiro_v2.fv2_migracao where nome = '0035_registrar_emprestimo.sql'`)).rows[0].sha256, hashDa0035());

    // concessões vigentes (como produção): MOVA em U1 e U2 com as ações atuais; OUTRA identidade em U1; MOVA em U3 (fora do kit)
    const conceder = (u, usuario, acoes) => comoMigrador(emTx(sqlConcessaoOperacionalDoMova({ identidade: usuario, organizacaoId: u.organizacaoId, unidadeId: u.unidadeId, acoes, concedidoPor: DONO, justificativa: "Ensaio sintético" })));
    await conceder(U1, MOVA, PRODUCAO.vigentes); await conceder(U2, MOVA, PRODUCAO.vigentes);
    await conceder(U1, OUTRA, ["financeiro_v2.ver", "financeiro_v2.registrar_obrigacao"]);
    await conceder(U3, MOVA, ["financeiro_v2.ver", "financeiro_v2.registrar_obrigacao"]);
    const antesOutra = await concessao(U1, OUTRA); const antesU3 = await concessao(U3);

    // 04: concessão protegida
    await comoMigrador(kit["04-concessao.sql"]);
    for (const u of [U1, U2]) assert.deepEqual(await concessao(u), { versao: 2, situacao: "ATIVA", acoes: [...PRODUCAO.vigentes, ACAO].sort() }, "mantém as vigentes e só acrescenta a nova");
    assert.deepEqual(await concessao(U1, OUTRA), antesOutra, "isolamento: outra identidade intacta");
    assert.deepEqual(await concessao(U3), antesU3, "isolamento: unidade fora do kit intacta");
    c = await conferir(kit);
    assert.deepEqual([Number(c.concessoes_com_a_acao), Number(c.fora_do_alcance), Number(c.com_sangria)], [2, 0, 0]);
    const hist = Number((await q(`select count(*) n from financeiro_v2.fv2_historico where registro_tipo = 'CONCESSAO' and depois->'acoes' ? '${ACAO}'`)).rows[0].n);
    assert.equal(hist, 2, "auditoria: uma alteração por unidade no histórico");

    // duplicidade: rodar o 04 de novo é RECUSADO e nada muda
    await assert.rejects(comoMigrador(kit["04-concessao.sql"]), /mudou desde a revisão/);
    for (const u of [U1, U2]) assert.equal((await concessao(u)).versao, 2, "sem nova versão");

    // alterações LEGÍTIMAS depois da concessão: em U1 retiram registrar_juros; U2 é revogada
    await conceder(U1, MOVA, [...PRODUCAO.vigentes, ACAO].filter((a) => a !== "financeiro_v2.registrar_juros"));
    await comoMigrador(emTx(sqlRevogarConcessaoOperacionalDoMova({ identidade: MOVA, organizacaoId: U2.organizacaoId, unidadeId: U2.unidadeId, revogadoPor: DONO, justificativa: "Ensaio: revogação legítima" })));
    const u2Revogada = await concessao(U2);
    assert.equal(u2Revogada.situacao, "REVOGADA");

    // 05-A: tira SÓ registrar_emprestimo; não devolve registrar_juros; não reativa U2; não toca a outra identidade
    await comoMigrador(parte(kit["05-reversao.sql"], "A"));
    assert.deepEqual((await concessao(U1)).acoes, PRODUCAO.vigentes.filter((a) => a !== "financeiro_v2.registrar_juros").sort(), "ação retirada depois continua retirada");
    assert.deepEqual(await concessao(U2), u2Revogada, "concessão revogada continua revogada");
    assert.deepEqual(await concessao(U1, OUTRA), antesOutra);
    const v = (await concessao(U1)).versao;
    await comoMigrador(parte(kit["05-reversao.sql"], "A"));
    assert.equal((await concessao(U1)).versao, v, "rodar a reversão de novo não faz nada");
    // 05-B volta o banco à 0034; o atualizar.sql reaplica (banco de teste fica como estava)
    await comoMigrador(parte(kit["05-reversao.sql"], "B"));
    assert.deepEqual(await estado(), { n: 34, acao: false, funcao: 0 });
    await comoMigrador(atualizarAte0035());
    assert.deepEqual(await estado(), { n: 35, acao: true, funcao: 1 });
    await comoMigrador(atualizar("0035")); // devolve a 0036 e a 0037 (banco de teste fica como estava)
    assert.equal(Number((await q("select count(*) n from financeiro_v2.fv2_migracao")).rows[0].n), 37);
  });
