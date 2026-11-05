// OFFLINE (sem banco, sem rede): gera uma NOVA VERSÃO do catálogo de operação = catálogo atual + linhas validadas à mão
// (src/modules/foody/foody.catalogo-validadas.js). Usado quando só as validadas mudaram; mudança do histórico pede o gerador
// completo (foody-gerar-catalogo.mjs, que também aplica as validadas). Depois: atualizar versão/hash fixados no teste.
//   node scripts/foody-catalogo-incluir-validadas.mjs --versao=AAAA-MM-DD.N [--saida=arquivo]
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CATALOGO_OPERACAO } from "../src/modules/foody/foody.catalogo-operacao.js";
import { LINHAS_VALIDADAS } from "../src/modules/foody/foody.catalogo-validadas.js";
import { incluirValidadas, renderizarCatalogo } from "../src/modules/foody/foody.catalogo.gerador.js";

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const versao = arg("versao");
if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(versao ?? "") || versao <= CATALOGO_OPERACAO.versao) {
  console.error(`uso: --versao=AAAA-MM-DD.N (maior que a atual ${CATALOGO_OPERACAO.versao}) [--saida=arquivo]`); process.exit(2);
}
const saida = arg("saida") ?? join(dirname(fileURLToPath(import.meta.url)), "..", "src", "modules", "foody", "foody.catalogo-operacao.js");
const r = incluirValidadas(CATALOGO_OPERACAO.linhas, LINHAS_VALIDADAS);
if (r.incluidas === 0) { console.error("nenhuma linha nova: catálogo já contém todas as validadas (versão não muda)"); process.exit(3); }
const corpo = {
  versao, hash: r.hash,
  origem: { ...CATALOGO_OPERACAO.origem, base: CATALOGO_OPERACAO.versao, validadasManualmente: LINHAS_VALIDADAS.length },
  termosValidados: Object.fromEntries(Object.entries(CATALOGO_OPERACAO.termosValidados).map(([op, l]) => [op, [...l]])),
  linhas: r.linhas,
};
writeFileSync(saida, renderizarCatalogo(corpo), "utf8");
console.log(JSON.stringify({ versao, base: CATALOGO_OPERACAO.versao, hash: r.hash, incluidas: r.incluidas, jaPresentes: r.jaPresentes,
  subway: r.linhas.subway.length, acai_no_grau: r.linhas.acai_no_grau.length }));
