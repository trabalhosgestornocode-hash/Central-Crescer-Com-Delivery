// Gera o PACOTE CONSOLIDADO de 132–136 (homologação no Supabase de TESTE e, com autorização própria, produção).
//
//   node backend/testes-seguros/supabase-teste/gerar_pacote.mjs <pasta-de-saída> [--transacao]
//
// Saída: pacote_aplicar.sql (132→136) e pacote_reverter.sql (136_rollback→132_rollback), montados a partir dos PRÓPRIOS arquivos de
// database/migrations (sem cópia que possa divergir), sem as linhas `begin;`/`commit;` de cada arquivo. Imprime o SHA-256 de cada pacote
// (sem data no cabeçalho: o mesmo commit gera sempre os mesmos bytes).
//   * Sem --transacao: para uma ferramenta que já abre UMA transação (apply_migration).
//   * Com --transacao: o próprio pacote abre e fecha a transação (psql -v ON_ERROR_STOP=1 -f, SQL Editor). Ou tudo entra, ou nada entra.
// HISTÓRICO: o pacote registra cada migration em supabase_migrations.schema_migrations NA MESMA transação (version = carimbo UTC,
// name = arquivo sem .sql, statements = conteúdo ORIGINAL do arquivo — o mesmo formato das migrations já registradas) e começa
// recusando se alguma delas já estiver registrada. O pacote de reversão remove essas linhas.
// Este script só LÊ arquivos e escreve na pasta indicada; não fala com nenhum banco.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migrations = resolve(raiz, "database/migrations");
const args = process.argv.slice(2);
const comTransacao = args.includes("--transacao");
const saida = resolve(args.find((a) => !a.startsWith("--")) ?? "pacote-homologacao");
mkdirSync(saida, { recursive: true });

const APLICAR = ["132_configuracoes2_fuso_unidade_convites_usuario.sql", "133_notificacoes_escopos_snapshot_m3.sql",
  "134_notificacoes_otp_consentimento.sql", "135_notificacoes_cotas_categoria.sql", "136_unidades_fuso_somente_backend.sql"];
const REVERTER = ["136_rollback.sql", "135_rollback.sql", "134_rollback.sql", "133_rollback.sql", "132_rollback.sql"];
const NOMES = APLICAR.map((f) => f.replace(/\.sql$/, ""));
const TAG = "$pacote_registro$";

const ler = (nome) => readFileSync(resolve(migrations, nome), "utf8").replace(/\r\n/g, "\n");

function semTransacao(nome) {
  const linhas = ler(nome).split("\n");
  const removidas = linhas.filter((l) => /^\s*(begin|commit)\s*;\s*$/i.test(l)).length;
  if (removidas !== 2) throw new Error(`${nome}: esperava exatamente 1 begin; e 1 commit; (achei ${removidas})`);
  return `-- ===== ${nome} =====\n` + linhas.filter((l) => !/^\s*(begin|commit)\s*;\s*$/i.test(l)).join("\n");
}

const listaNomes = NOMES.map((n) => `'${n}'`).join(", ");

const trava = `-- ===== trava: nenhuma destas migrations pode já estar registrada =====
do $trava$ begin
  if exists (select 1 from supabase_migrations.schema_migrations where name in (${listaNomes})) then
    raise exception 'pacote 132–136: migration já registrada em supabase_migrations.schema_migrations — nada foi aplicado';
  end if;
end $trava$;`;

function registro() {
  const linhas = APLICAR.map((f, i) => {
    const sql = ler(f);
    if (sql.includes(TAG)) throw new Error(`${f}: contém ${TAG}`);
    return `  (to_char((now() at time zone 'utc') + make_interval(secs => ${i}), 'YYYYMMDDHH24MISS'), '${NOMES[i]}', array[${TAG}${sql}${TAG}], 'pacote-pr55')`;
  });
  return `-- ===== registro no histórico (mesma transação) =====
insert into supabase_migrations.schema_migrations (version, name, statements, created_by) values
${linhas.join(",\n")};`;
}

const desregistro = `-- ===== remove o registro no histórico (mesma transação) =====
delete from supabase_migrations.schema_migrations where name in (${listaNomes});`;

const embrulhar = (corpo) => (comTransacao ? `begin;\n\n${corpo}\ncommit;\n` : corpo);

for (const [arquivo, partes, titulo] of [
  ["pacote_aplicar.sql", [trava, ...APLICAR.map(semTransacao), registro()], "APLICAR 132→136"],
  ["pacote_reverter.sql", [...REVERTER.map(semTransacao), desregistro], "REVERTER 136→132"],
]) {
  const modo = comTransacao ? "com begin/commit" : "sem begin/commit: a ferramenta abre a transação";
  const corpo = `-- Pacote ${titulo} — gerado de database/migrations (${modo}).\n\n` + embrulhar(partes.join("\n\n") + "\n");
  writeFileSync(resolve(saida, arquivo), corpo);
  console.log(`${arquivo}  ${Buffer.byteLength(corpo)} bytes  sha256=${createHash("sha256").update(corpo).digest("hex")}`);
}
