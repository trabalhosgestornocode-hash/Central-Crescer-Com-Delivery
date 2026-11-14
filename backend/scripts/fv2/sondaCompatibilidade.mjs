#!/usr/bin/env node
// SONDA DE COMPATIBILIDADE do PostgreSQL com as migrações 0001–0021 do Financeiro v2 (Execução 09C).
//
// Tudo acontece dentro de UMA transação que é DESFEITA no fim (ROLLBACK): nenhum papel, função ou tabela fica criado.
// Nesta execução roda SÓ contra o PostgreSQL local isolado (barreiras de destino de scripts/fv2/ambiente.mjs). Num
// alvo de homologação futuro, a mesma lista de verificações produz a evidência que hoje falta (doc 24, § 11).
//
//   node scripts/fv2/sondaCompatibilidade.mjs
//
// Verificações (cada uma: OK / FALHA / ATENÇÃO, com o motivo):
//   R1 versão ≥ 13 (pg_current_xact_id, usado pela 0018)            R2 papel de migração: superusuário? CREATEROLE?
//   R3 criar papéis com e sem login (0001/0011)                      R4 FORCE ROW LEVEL SECURITY + políticas
//   R5 função SECURITY DEFINER com search_path fixo                  R6 transferir a posse de função para um papel SEM
//      membros (padrão do guardião, 0011) sendo um migrador NÃO superusuário com CREATEROLE (simulado com SET ROLE)
//   R7 bloqueio consultivo de transação (0009/0011)                  R8 estatísticas: track_counts e autovacuum ligados
import { abrirPoolSeguro, lerAmbiente } from "./ambiente.mjs";

const a = lerAmbiente();
if (!a) { process.stdout.write("Ambiente isolado ausente: rode `node scripts/fv2-banco-teste.mjs iniciar`.\n"); process.exit(1); }
const pool = await abrirPoolSeguro(a.urlAdmin, a.marcador, { max: 1 });
const cl = await pool.connect();
const r = [];
const ok = (id, texto, situacao = "OK", detalhe = "") => r.push({ id, situacao, texto, detalhe });
const tentar = async (sql) => { await cl.query("savepoint s"); try { const x = await cl.query(sql); await cl.query("release savepoint s"); return { ok: true, x }; } catch (e) { await cl.query("rollback to savepoint s"); return { ok: false, erro: `${e.code}: ${e.message}` }; } };
try {
  await cl.query("begin");
  const v = Number((await cl.query("show server_version_num")).rows[0].server_version_num);
  ok("R1", `versão do servidor ${v}`, v >= 130000 ? "OK" : "FALHA", "pg_current_xact_id exige 13+");
  const eu = (await cl.query("select rolsuper, rolcreaterole from pg_roles where rolname = current_user")).rows[0];
  ok("R2", `papel de migração: superusuário=${eu.rolsuper}, createrole=${eu.rolcreaterole}`, eu.rolsuper ? "ATENÇÃO" : eu.rolcreaterole ? "OK" : "FALHA",
    eu.rolsuper ? "ambiente local usa superusuário; serviços gerenciados normalmente NÃO" : "");
  const r3 = await tentar("create role sonda_fv2_app login password 'nao-usada'; create role sonda_fv2_guardiao nologin");
  ok("R3", "criar papéis com e sem login", r3.ok ? "OK" : "FALHA", r3.erro ?? "");
  const r4 = await tentar("create table sonda_fv2_t (id int, unidade int); alter table sonda_fv2_t enable row level security; alter table sonda_fv2_t force row level security; create policy sonda_p on sonda_fv2_t using (unidade = 1)");
  ok("R4", "FORCE ROW LEVEL SECURITY e políticas", r4.ok ? "OK" : "FALHA", r4.erro ?? "");
  const r5 = await tentar("create function sonda_fv2_f() returns int language sql security definer set search_path = pg_catalog, public, pg_temp as 'select 1'");
  ok("R5", "função SECURITY DEFINER com search_path fixo", r5.ok ? "OK" : "FALHA", r5.erro ?? "");
  const r7 = await tentar("select pg_advisory_xact_lock(424242)");
  ok("R7", "bloqueio consultivo de transação", r7.ok ? "OK" : "FALHA", r7.erro ?? "");
  const st = (await cl.query("select current_setting('track_counts') as tc, current_setting('autovacuum') as av")).rows[0];
  ok("R8", `track_counts=${st.tc}, autovacuum=${st.av}`, st.tc === "on" && st.av === "on" ? "OK" : "ATENÇÃO", "sem estatísticas os planos pioram (08C/08D)");
  // R6 — simula o migrador de um serviço gerenciado: NÃO superusuário, com CREATEROLE, sem ser membro do guardião.
  const prep = await tentar("create role sonda_fv2_migrador nologin createrole; grant create on schema public to sonda_fv2_migrador; grant create on schema public to sonda_fv2_guardiao; alter function sonda_fv2_f() owner to sonda_fv2_migrador");
  if (!prep.ok) ok("R6", "simulação do migrador não superusuário", "ATENÇÃO", prep.erro);
  else {
    const semMembro = await tentar("set local role sonda_fv2_migrador; alter function sonda_fv2_f() owner to sonda_fv2_guardiao");
    await tentar("reset role");
    const comMembroTemporario = await tentar("grant sonda_fv2_guardiao to sonda_fv2_migrador; set local role sonda_fv2_migrador; alter function sonda_fv2_f() owner to sonda_fv2_guardiao; reset role; revoke sonda_fv2_guardiao from sonda_fv2_migrador");
    await tentar("reset role");
    const membros = (await cl.query("select count(*)::int as n from pg_auth_members m join pg_roles g on g.oid = m.roleid where g.rolname = 'sonda_fv2_guardiao'")).rows[0].n;
    ok("R6", "transferir posse para o guardião SEM ser membro (migrador não superusuário)", semMembro.ok ? "OK" : "FALHA", semMembro.erro ?? "");
    ok("R6b", `com participação TEMPORÁRIA (grant → alter owner → revoke): ${comMembroTemporario.ok ? "funciona" : "falha"}; membros do guardião ao fim: ${membros}`,
      comMembroTemporario.ok && membros === 0 ? "OK" : "FALHA", comMembroTemporario.erro ?? "procedimento exigido em serviço gerenciado: CREATE no schema para o guardião + conceder, transferir e revogar a participação na mesma migração");
  }
} finally {
  await cl.query("rollback").catch(() => {});
  cl.release();
  await pool.end();
}
for (const x of r) process.stdout.write(`${x.situacao.padEnd(8)} ${x.id.padEnd(4)} ${x.texto}${x.detalhe ? ` — ${x.detalhe}` : ""}\n`);
process.stdout.write("Transação desfeita: nada foi criado.\n");
