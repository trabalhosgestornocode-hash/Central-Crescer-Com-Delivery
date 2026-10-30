// Gera o PACOTE CONSOLIDADO da homologação de 132–135 no Supabase de TESTE (uma confirmação por etapa, em vez de uma por arquivo).
//
//   node backend/testes-seguros/supabase-teste/gerar_pacote.mjs <pasta-de-saída>
//
// Saída: pacote_aplicar.sql (132→135) e pacote_reverter.sql (135_rollback→132_rollback), montados a partir dos PRÓPRIOS arquivos de
// database/migrations (sem cópia que possa divergir), sem as linhas `begin;`/`commit;` — a ferramenta de aplicação já abre uma
// transação única: ou tudo entra, ou nada entra. Imprime o SHA-256 de cada pacote para registrar no relatório da homologação.
// Este script só LÊ arquivos e escreve na pasta indicada; não fala com nenhum banco.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const migrations = resolve(raiz, "database/migrations");
const saida = resolve(process.argv[2] ?? "pacote-homologacao");
mkdirSync(saida, { recursive: true });

const APLICAR = ["132_configuracoes2_fuso_unidade_convites_usuario.sql", "133_notificacoes_escopos_snapshot_m3.sql",
  "134_notificacoes_otp_consentimento.sql", "135_notificacoes_cotas_categoria.sql", "136_unidades_fuso_somente_backend.sql"];
const REVERTER = ["136_rollback.sql", "135_rollback.sql", "134_rollback.sql", "133_rollback.sql", "132_rollback.sql"];

function semTransacao(nome) {
  const linhas = readFileSync(resolve(migrations, nome), "utf8").split(/\r?\n/);
  const removidas = linhas.filter((l) => /^\s*(begin|commit)\s*;\s*$/i.test(l)).length;
  if (removidas !== 2) throw new Error(`${nome}: esperava exatamente 1 begin; e 1 commit; (achei ${removidas})`);
  return `-- ===== ${nome} =====\n` + linhas.filter((l) => !/^\s*(begin|commit)\s*;\s*$/i.test(l)).join("\n");
}

for (const [arquivo, lista, titulo] of [["pacote_aplicar.sql", APLICAR, "APLICAR 132→135"], ["pacote_reverter.sql", REVERTER, "REVERTER 135→132"]]) {
  const corpo = `-- Pacote ${titulo} — gerado de database/migrations em ${new Date().toISOString()}. SOMENTE projeto de TESTE.\n\n`
    + lista.map(semTransacao).join("\n\n") + "\n";
  writeFileSync(resolve(saida, arquivo), corpo);
  console.log(`${arquivo}  ${Buffer.byteLength(corpo)} bytes  sha256=${createHash("sha256").update(corpo).digest("hex")}`);
}
