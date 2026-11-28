// 28/11 — ENSAIO de compatibilidade (PostgreSQL local isolado; nada em produção) entre a MOVA 0027 (correção de conta, esta frente)
// e a MOVA 0026 da frente dos ENTREGADORES (arquivo passado por argumento; outra branch). Ordem real prevista: produção recebe a 0027
// primeiro (instalar até a 0025 + 0027) e a 0026 depois. Confere: as duas aplicam e convivem; as listas da 0027 continuam valendo;
// reverter nas DUAS ordens funciona; o banco termina sem as duas.
//   node scripts/mova/ensaioCompatibilidade0026e0027.mjs <0026.sql> <reverter-0026.sql>
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { abrirPool, ambiente } from "../../test/financeiro-v2/helpers/postgres.js";
import { urlDoBanco } from "../fv2/ambiente.mjs";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "../../../database/mova-financeiro");
const [arq0026, rev0026] = process.argv.slice(2).map((p) => readFileSync(p, "utf8"));
const a = ambiente();
const admin = await abrirPool(a.urlAdmin, { max: 2 });
const ler = (...p) => readFileSync(join(RAIZ, ...p), "utf8");
const resultado = [];
for (const ordem of [["0026", "0027"], ["0027", "0026"]]) {
  const banco = `fv2_teste_mova_${randomBytes(6).toString("hex")}`;
  await admin.query(`create database ${banco} template template0`);
  await admin.query(`comment on database ${banco} is 'FV2_ISOLADO_TESTE:${a.marcador}'`);
  const pool = await abrirPool(urlDoBanco(a.urlAdmin, banco), { max: 1 });
  try {
    await pool.query(`begin;\n${ler("producao", "instalar.sql")}\ncommit;`); // até a 0025 + 0027 (esta frente)
    await pool.query(`begin;\n${arq0026}\ninsert into mova.mova_migracao (nome, sha256) values ('0026_mova_entregador_notificacoes_pagamento.sql', '${createHash("sha256").update(arq0026).digest("hex")}');\ncommit;`);
    const lista = async () => (await pool.query("select string_agg(nome, ',' order by nome) n from mova.mova_migracao where nome >= '0025'")).rows[0].n;
    const aceita = async () => (await pool.query(`select pg_get_constraintdef(oid) d from pg_constraint where conname in ('proposta_tipo_check', 'operacao_executada_operacao_check') order by conname`)).rows.map((r) => r.d.includes("CORRECAO_DE_CONTA"));
    const tabelas = async () => Number((await pool.query("select count(*) n from pg_tables where schemaname = 'mova' and tablename in ('notificacao_pagamento', 'pagamento_marco', 'atendimento_metrica')")).rows[0].n);
    const juntas = { migracoes: await lista(), correcaoNasListas: await aceita(), tabelasDos_entregadores: await tabelas() };
    for (const n of ordem) await pool.query(n === "0026" ? rev0026 : ler("recuperacao", "reverter-0027.sql"));
    resultado.push({ ordemDaReversao: ordem.join(" → "), juntas, depois: { migracoes: await lista(), correcaoNasListas: await aceita(), tabelasDos_entregadores: await tabelas() } });
  } finally { await pool.end(); await admin.query(`drop database ${banco}`); }
}
await admin.end();
console.log(JSON.stringify(resultado, null, 1));
