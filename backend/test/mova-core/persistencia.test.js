// MOVA CORE — F2.1: PERSISTÊNCIA REAL (migração 0019) no PostgreSQL LOCAL ISOLADO de homologação (porta 54329, um database novo
// por teste, descartado no fim). Vínculo, desafio, tentativas e memória gravados de verdade; "processos" diferentes = instâncias
// diferentes dos serviços sobre o MESMO banco. Sem o ambiente local, os testes são PULADOS (MOVA_EXIGIR_BANCO=1 = falha).
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { criarBancoMova, descartarBancoMova, motivoParaPularMova } from "../mova-financeiro/helpers/banco.js";
import { criarRepositorioDeIdentidadePostgres, criarRepositorioDeMemoriaPostgres } from "../../src/modules/mova-core/persistencia.js";
import { criarServicoDeIdentidade, criarMemoriaEmCamadas } from "../../src/modules/mova-core/index.js";
import { perguntaSobrePosicaoAtual } from "../../src/modules/mova-core/memoria.js";

const PULAR = motivoParaPularMova();
const t = (nome, fn) => test(nome, { skip: PULAR }, fn);
const bancos = [];
after(async () => { for (const b of bancos) await descartarBancoMova(b).catch(() => {}); });
async function banco() { const b = await criarBancoMova(); bancos.push(b); return b; }

const MIN = 60_000;
const relogioManual = (t0 = Date.parse("2026-11-24T09:00:00Z")) => { let x = t0; const r = () => x; r.avancar = (ms) => { x += ms; }; return r; };
const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000001";
const UNI = "aaaaaaaa-0000-4000-8000-0000000000u1".replace("u1", "11");
const PERFIL = "cccccccc-0000-4000-8000-000000000001";
const PERFIL_2 = "cccccccc-0000-4000-8000-000000000002";
const CONTA = "dddddddd-0000-4000-8000-000000000001";
const ADMIN = { impersonando: false, empresa: { id: ORG }, permissoes: ["usuarios.gerenciar"] };

const ENTRADA = { ids: ["5500000000201@s.whatsapp.net", "880000201@lid"] };
const LISTA = { "g1@g.us": { organizacaoId: ORG, privado: false }, "5500000000201@s.whatsapp.net": { organizacaoId: ORG, privado: true } };
const identificar = ({ grupoId, participanteId }) => (LISTA[grupoId] && ENTRADA.ids.includes(participanteId) ? { entrada: ENTRADA, organizacaoId: LISTA[grupoId].organizacaoId, privado: LISTA[grupoId].privado, unidades: [UNI] } : null);
const PRIV = { grupoId: "5500000000201@s.whatsapp.net", participanteId: "5500000000201@s.whatsapp.net" };
function plataforma() {
  const perfis = new Map([[PERFIL, { contaId: CONTA, papel: "gerente", permissoes: ["dashboard_executivo.ver"], modulos: ["ifood_dashboard"], unidades: [UNI], ativo: true }],
    [PERFIL_2, { contaId: CONTA, papel: "gerente", permissoes: [], modulos: [], unidades: [UNI], ativo: true }]]);
  return { perfis, async acessoDoPerfil({ perfilId, organizacaoId }) { const p = perfis.get(perfilId); return p && organizacaoId === ORG ? { ...p, perfilId } : null; } };
}
/** um "processo": serviço novo sobre o MESMO banco (nada compartilhado em memória) */
function processo(pool, { relogio = relogioManual(), plat = plataforma(), aoRevogar = null, auditoria = [] } = {}) {
  return criarServicoDeIdentidade({ identificarParticipante: identificar, plataforma: plat, repositorio: criarRepositorioDeIdentidadePostgres(pool), auditoria: { registrar: (x) => auditoria.push(x) }, relogio, aoRevogar });
}

t("PS-01 vínculo por código PERSISTE: outro processo (reinício) resolve a mesma pessoa pelo LID do grupo; o código não fica em claro em lugar nenhum", async () => {
  const { pool } = await banco();
  const auditoria = []; const relogio = relogioManual();
  const g = await processo(pool, { relogio, auditoria }).solicitarCodigo({ contaId: CONTA, perfilId: PERFIL, organizacaoId: ORG });
  assert.equal((await processo(pool, { relogio, auditoria }).confirmarCodigo({ ...PRIV, texto: `vincular ${g.codigo}` })).ok, true);
  const r = await processo(pool, { relogio }).resolver({ grupoId: "g1@g.us", participanteId: "880000201@lid" });
  assert.equal(r.vinculado, true); assert.equal(r.usuario.papel, "gerente");
  const linhas = JSON.stringify((await pool.query("select * from mova.core_desafio_vinculo")).rows) + JSON.stringify((await pool.query("select * from mova.core_vinculo")).rows);
  assert.doesNotMatch(linhas + JSON.stringify(auditoria), new RegExp(`\\b${g.codigo}\\b`), "só o hash com sal");
});

t("PS-02 código de USO ÚNICO entre processos: 6 confirmações simultâneas do mesmo código ⇒ exatamente UM vínculo", async () => {
  const { pool } = await banco();
  const relogio = relogioManual();
  const g = await processo(pool, { relogio }).solicitarCodigo({ contaId: CONTA, perfilId: PERFIL, organizacaoId: ORG });
  const rs = await Promise.all(Array.from({ length: 6 }, () => processo(pool, { relogio }).confirmarCodigo({ ...PRIV, texto: `vincular ${g.codigo}` })));
  assert.equal(rs.filter((r) => r.ok).length, 1, JSON.stringify(rs));
  assert.equal((await pool.query("select count(*)::int n from mova.core_vinculo where estado = 'ATIVO'")).rows[0].n, 1);
});

t("PS-03 limite de tentativas ATÔMICO: 12 códigos errados SIMULTÂNEOS ⇒ no máximo 5 conferidos, o resto TENTATIVAS_EXCEDIDAS", async () => {
  const { pool } = await banco();
  const relogio = relogioManual();
  await processo(pool, { relogio }).solicitarCodigo({ contaId: CONTA, perfilId: PERFIL, organizacaoId: ORG });
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => processo(pool, { relogio }).confirmarCodigo({ ...PRIV, texto: `vincular ${String(100000 + i)}` })));
  const conferidos = rs.filter((r) => r.motivo === "CODIGO_INVALIDO" || r.ok).length;
  assert.ok(conferidos <= 5, `conferidos=${conferidos}`);
  assert.equal(rs.filter((r) => r.motivo === "TENTATIVAS_EXCEDIDAS").length, 12 - conferidos);
  relogio.avancar(61 * MIN); // janela de 1 h passou: volta a conferir
  assert.equal((await processo(pool, { relogio }).confirmarCodigo({ ...PRIV, texto: "vincular 999999" })).motivo, "CODIGO_INVALIDO");
});

t("PS-04 EXPIRAÇÃO: depois de 10 min o código não vincula (e o banco recusa desafio com validade maior que 10 min)", async () => {
  const { pool } = await banco();
  const relogio = relogioManual();
  const g = await processo(pool, { relogio }).solicitarCodigo({ contaId: CONTA, perfilId: PERFIL, organizacaoId: ORG });
  relogio.avancar(10 * MIN + 1000);
  assert.equal((await processo(pool, { relogio }).confirmarCodigo({ ...PRIV, texto: `vincular ${g.codigo}` })).motivo, "CODIGO_EXPIRADO");
  await assert.rejects(pool.query(`insert into mova.core_desafio_vinculo (organizacao_id, perfil_id, codigo_hash, sal, criado_em, expira_em)
    values ($1, $2, repeat('a', 64), repeat('s', 20), now(), now() + interval '11 minutes')`, [ORG, PERFIL]), /check/i);
});

t("PS-05 vínculo ÚNICO sob concorrência: duas aprovações de admin simultâneas para a mesma pessoa ⇒ uma vence, a outra JA_VINCULADO", async () => {
  const { pool } = await banco();
  const [a, b] = await Promise.all([
    processo(pool).aprovarPorAdmin({ acessoDoAdmin: ADMIN, adminContaId: CONTA, organizacaoId: ORG, entrada: ENTRADA, perfilId: PERFIL }),
    processo(pool).aprovarPorAdmin({ acessoDoAdmin: ADMIN, adminContaId: CONTA, organizacaoId: ORG, entrada: ENTRADA, perfilId: PERFIL_2 }),
  ]);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
  assert.equal([a, b].find((x) => !x.ok).motivo, "JA_VINCULADO");
});

t("PS-06 REVOGAÇÃO IMEDIATA entre processos: revogado no processo A, o processo B já não resolve na mensagem seguinte; memória da pessoa é apagada", async () => {
  const { pool } = await banco();
  const memRepo = criarRepositorioDeMemoriaPostgres(pool);
  const mem = criarMemoriaEmCamadas({ repositorio: memRepo });
  const ids = { organizacaoId: ORG, conversaId: "g1@g.us", participanteId: "880000201@lid" };
  await mem.registrarTurno(await mem.obter(ids), { pergunta: "como está o dashboard?", resposta: "Ok.", ferramentas: ["dashboard_executivo"], fatos: [] });
  const apagadas = [];
  const a = processo(pool, { aoRevogar: async () => { for (const p of ENTRADA.ids) apagadas.push(await memRepo.apagarDoParticipante({ organizacaoId: ORG, participanteId: p })); } });
  const v = await a.aprovarPorAdmin({ acessoDoAdmin: ADMIN, adminContaId: CONTA, organizacaoId: ORG, entrada: ENTRADA, perfilId: PERFIL });
  const b = processo(pool);
  assert.equal((await b.resolver({ grupoId: "g1@g.us", participanteId: "880000201@lid" })).vinculado, true);
  assert.equal((await a.revogar({ vinculoId: v.vinculoId, por: CONTA, motivo: "SAIU_DA_EMPRESA" })).ok, true);
  assert.equal((await b.resolver({ grupoId: "g1@g.us", participanteId: "880000201@lid" })).motivo, "SEM_VINCULO");
  assert.equal(apagadas.reduce((s, n) => s + n, 0), 1);
  assert.equal((await criarMemoriaEmCamadas({ repositorio: criarRepositorioDeMemoriaPostgres(pool) }).obter(ids)).fio.turnos.length, 0);
  const row = (await pool.query("select estado, revogado_em, motivo_revogacao from mova.core_vinculo where id = $1", [v.vinculoId])).rows[0];
  assert.equal(row.motivo_revogacao, "SAIU_DA_EMPRESA"); assert.ok(row.revogado_em, "revogação é registro, não DELETE");
  assert.equal((await a.revogar({ vinculoId: v.vinculoId, por: CONTA })).ok, false, "revogar duas vezes não muda nada");
});

t("PS-07 memória SOBREVIVE ao reinício: outro processo lê o fio (assuntos, entidades e referências) do banco", async () => {
  const { pool } = await banco();
  const ids = { organizacaoId: ORG, conversaId: "g1@g.us", participanteId: "p1" };
  const relogio = relogioManual();
  const m1 = criarMemoriaEmCamadas({ repositorio: criarRepositorioDeMemoriaPostgres(pool, { relogio }), relogio });
  const c1 = await m1.obter(ids);
  const ref = c1.referencias.opacar("eeeeeeee-0000-4000-8000-000000000001", UNI);
  await m1.registrarTurno(c1, { pergunta: "quanto devo ao Matheus Rocha?", resposta: "Devo [valor].", ferramentas: ["entregadores_da_semana"], fatos: [{ entidade: "Matheus Rocha", ferramenta: "entregadores_da_semana", unidadeId: UNI, valorCentavos: 12000, natureza: "OBRIGACAO" }] });
  const m2 = criarMemoriaEmCamadas({ repositorio: criarRepositorioDeMemoriaPostgres(pool, { relogio }), relogio }); // "reinício"
  const c2 = await m2.obter(ids);
  assert.equal(c2.fio.turnos.length, 1);
  assert.deepEqual(c2.fio.entidades.map((e) => e.nome), ["Matheus Rocha"]);
  assert.equal(c2.referencias.resolver(ref, UNI), "eeeeeeee-0000-4000-8000-000000000001");
  assert.throws(() => c2.referencias.resolver(ref, "ffffffff-0000-4000-8000-000000000009"), /referência desconhecida/, "ref de outra unidade continua recusada");
});

t("PS-08 escrita CONCORRENTE da memória: duas mensagens simultâneas da mesma pessoa em processos diferentes ⇒ os dois turnos ficam (compare-and-set)", async () => {
  const { pool } = await banco();
  const ids = { organizacaoId: ORG, conversaId: "g1@g.us", participanteId: "p1" };
  const m = () => criarMemoriaEmCamadas({ repositorio: criarRepositorioDeMemoriaPostgres(pool) });
  const [a, b] = [m(), m()];
  const [ca, cb] = await Promise.all([a.obter(ids), b.obter(ids)]);
  await Promise.all([a.registrarTurno(ca, { pergunta: "contas a pagar?", resposta: "A.", ferramentas: ["contas_a_pagar"] }), b.registrarTurno(cb, { pergunta: "e as vendas?", resposta: "B.", ferramentas: ["vendas"] })]);
  const fim = await m().obter(ids);
  assert.deepEqual(fim.fio.turnos.map((x) => x.pergunta).sort(), ["contas a pagar?", "e as vendas?"]);
  assert.equal(Number((await pool.query("select versao from mova.core_memoria_conversa")).rows[0].versao), 2);
});

t("PS-09 ISOLAMENTO: organização, conversa (grupo × privado) e participante são linhas diferentes; chave incoerente é recusada pelo banco", async () => {
  const { pool } = await banco();
  const m = criarMemoriaEmCamadas({ repositorio: criarRepositorioDeMemoriaPostgres(pool) });
  const base = { organizacaoId: ORG, conversaId: "g1@g.us", participanteId: "p1" };
  await m.registrarTurno(await m.obter(base), { pergunta: "segredo do grupo", resposta: "ok" });
  for (const outro of [{ ...base, organizacaoId: ORG_B }, { ...base, conversaId: "5500000000201@s.whatsapp.net" }, { ...base, participanteId: "p2" }]) {
    const c = await criarMemoriaEmCamadas({ repositorio: criarRepositorioDeMemoriaPostgres(pool) }).obter(outro);
    assert.equal(c.fio.turnos.length, 0, JSON.stringify(outro));
  }
  await assert.rejects(pool.query(`insert into mova.core_memoria_conversa (chave, organizacao_id, conversa_id, participante_id, estado, expira_em) values ($1, $2, 'g', 'p', '{}', now() + interval '1 day')`, [`${ORG_B}|g|p`, ORG]), /check/i);
});

t("PS-10 EXCLUSÃO e RETENÇÃO: esquecer apaga o conteúdo (linha fica vazia, com motivo); fio vencido pela retenção é apagado e não volta", async () => {
  const { pool } = await banco();
  const relogio = relogioManual();
  const repo = criarRepositorioDeMemoriaPostgres(pool, { relogio });
  const m = criarMemoriaEmCamadas({ repositorio: repo, relogio, opcoes: { retencaoMs: 2 * 86_400_000 } });
  const a = { organizacaoId: ORG, conversaId: "g1@g.us", participanteId: "p1" };
  const b = { ...a, participanteId: "p2" };
  await m.registrarTurno(await m.obter(a), { pergunta: "fornecedor Atacadão", resposta: "ok" });
  await m.registrarTurno(await m.obter(b), { pergunta: "vendas", resposta: "ok" });
  assert.equal(await m.esquecer(a), true);
  const r = (await pool.query("select estado, apagada_em, motivo_apagamento from mova.core_memoria_conversa where participante_id = 'p1'")).rows[0];
  assert.deepEqual([r.estado, r.motivo_apagamento, Boolean(r.apagada_em)], [{}, "PEDIDO", true]);
  assert.equal((await m.obter(a)).fio.turnos.length, 0);
  relogio.avancar(3 * 86_400_000);
  assert.equal(await repo.expurgarVencidas(), 1, "só o fio de p2 ainda tinha conteúdo");
  assert.equal((await m.obter(b)).fio.turnos.length, 0);
  assert.equal((await pool.query("select count(*)::int n from mova.core_memoria_conversa where estado <> '{}'::jsonb")).rows[0].n, 0);
});

t("PS-11 papel mova_app: lê e grava vínculo e memória, mas NÃO apaga linha de nenhuma tabela core_ (revogação e exclusão são registro)", async () => {
  const { pool } = await banco();
  const c = await pool.connect();
  try {
    await c.query("set role mova_app");
    await c.query("select count(*) from mova.core_vinculo");
    for (const tab of ["core_vinculo", "core_desafio_vinculo", "core_memoria_conversa", "core_tentativa_vinculo"]) {
      await assert.rejects(c.query(`delete from mova.${tab}`), /permission denied|permissão negada/i, tab);
    }
    await assert.rejects(c.query("update mova.core_tentativa_vinculo set em = now()"), /permission denied|permissão negada/i, "tentativa é só inserção");
  } finally { await c.query("reset role").catch(() => {}); c.release(); }
});

t("PS-12 FONTE OFICIAL: pergunta sobre a POSIÇÃO ATUAL não reaproveita fato de posição (nem dentro dos 10 min); outra unidade e ferramenta perdida também não", async () => {
  const relogio = relogioManual();
  const m = criarMemoriaEmCamadas({ relogio });
  const ids = { organizacaoId: ORG, conversaId: "g1@g.us", participanteId: "p1" };
  const c = await m.obter(ids);
  await m.registrarTurno(c, { pergunta: "contas do Atacadão", resposta: "ok", ferramentas: ["contas_a_pagar"], fatos: [
    { entidade: "Atacadão", ferramenta: "contas_a_pagar", unidadeId: UNI, valorCentavos: 50000, natureza: "OBRIGACAO" },
    { entidade: "Dashboard", ferramenta: "dashboard_executivo", unidadeId: UNI, valorCentavos: 900000, natureza: "FATURAMENTO" },
    { entidade: "Vendas Norte", ferramenta: "vendas", unidadeId: "ffffffff-0000-4000-8000-000000000009", valorCentavos: 1000, natureza: "FATURAMENTO" }] });
  relogio.avancar(2 * MIN);
  const nomes = (x) => x.map((f) => f.entidade).sort();
  assert.deepEqual(nomes(m.fatosValidos(c, { pergunta: "e a do Atacadão, quanto era mesmo?", unidadeId: UNI })), ["Atacadão", "Dashboard"]);
  assert.deepEqual(nomes(m.fatosValidos(c, { pergunta: "o Atacadão já foi pago?", unidadeId: UNI })), ["Dashboard"], "posição atual ⇒ consulta nova");
  assert.deepEqual(nomes(m.fatosValidos(c, { pergunta: "quanto vendemos?", unidadeId: UNI, ferramentasPermitidas: new Set(["contas_a_pagar", "vendas"]) })), ["Atacadão"], "sem dashboard agora ⇒ fato do dashboard não vale");
  for (const p of ["qual o saldo do caixa", "ainda está em aberto?", "foi quitado?", "como ficou a conta da Coca?", "quanto falta pagar"]) assert.equal(perguntaSobrePosicaoAtual(p), true, p);
  for (const p of ["quanto gastei com embalagem em outubro", "explica o que é CMV", "qual fornecedor mais cresceu"]) assert.equal(perguntaSobrePosicaoAtual(p), false, p);
});

t("PS-13 rollback oficial da 0019: recusa com vínculo ATIVO; revogado, remove só as tabelas core_ (o resto do schema mova fica)", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "database", "mova-financeiro", "recuperacao", "reverter-0019.sql"), "utf8");
  const { pool } = await banco();
  await pool.query("create table mova.mova_migracao (nome text primary key, sha256 text not null)");
  await pool.query("insert into mova.mova_migracao values ('0019_mova_core_identidade_memoria.sql', 'x')");
  const s = processo(pool);
  const v = await s.aprovarPorAdmin({ acessoDoAdmin: ADMIN, adminContaId: CONTA, organizacaoId: ORG, entrada: ENTRADA, perfilId: PERFIL });
  await assert.rejects(pool.query(sql), /vínculo ATIVO/);
  await s.revogar({ vinculoId: v.vinculoId, por: CONTA });
  await pool.query(sql);
  const r = await pool.query("select to_regclass('mova.core_vinculo') v, to_regclass('mova.core_memoria_conversa') m, to_regclass('mova.orcamento_ia_politica') o");
  assert.deepEqual(r.rows[0], { v: null, m: null, o: "mova.orcamento_ia_politica" });
});
