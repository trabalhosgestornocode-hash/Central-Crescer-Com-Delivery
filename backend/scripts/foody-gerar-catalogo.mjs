// Gera o catálogo versionado de linhas por operação (backend/src/modules/foody/foody.catalogo-operacao.js) a partir do
// histórico do Parser de UMA unidade. SOMENTE LEITURA no banco (select em parser_fd_pedidos); escreve só o arquivo local.
// O arquivo gerado entra por PR, com nova versão e o hash registrado no teste de regressão (foody-compartilhada-catalogo.test.js).
//
//   node --env-file=.env scripts/foody-gerar-catalogo.mjs --unidade=<uuid> --versao=AAAA-MM-DD.N [--ate=AAAA-MM-DD] [--saida=arquivo]
//
// Não imprime o texto bruto dos pedidos — só estatísticas. As linhas do catálogo são nomes de produto/complemento do cardápio.
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { gerarCatalogo, incluirValidadas, renderizarCatalogo } from "../src/modules/foody/foody.catalogo.gerador.js";
import { LINHAS_VALIDADAS } from "../src/modules/foody/foody.catalogo-validadas.js";
import { TERMOS_VALIDADOS } from "../src/modules/foody/foody.classificacao.js";

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unidade = arg("unidade"), versao = arg("versao"), ate = arg("ate");
if (!UUID.test(unidade ?? "") || !/^\d{4}-\d{2}-\d{2}\.\d+$/.test(versao ?? "")) {
  console.error("uso: --unidade=<uuid> --versao=AAAA-MM-DD.N [--ate=AAAA-MM-DD] [--saida=arquivo]"); process.exit(2);
}
const saida = arg("saida") ?? join(dirname(fileURLToPath(import.meta.url)), "..", "src", "modules", "foody", "foody.catalogo-operacao.js");

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false }, realtime: { transport: ws } });
const pedidos = [];
let primeiro = null, ultimo = null;
for (let de = 0; ; de += 1000) {
  let q = sb.from("parser_fd_pedidos").select("id, detalhes_pedido, data_hora").eq("unidade_id", unidade).order("id").range(de, de + 999);
  if (ate) q = q.lt("data_hora", ate);
  const { data, error } = await q;
  if (error) { console.error("leitura falhou:", error.code); process.exit(1); }
  for (const r of data) {
    if (!r.detalhes_pedido) continue;
    const dia = String(r.data_hora ?? "").slice(0, 10);
    pedidos.push({ detalhes: r.detalhes_pedido, dia });
    if (dia && (!primeiro || dia < primeiro)) primeiro = dia;
    if (dia && (!ultimo || dia > ultimo)) ultimo = dia;
  }
  if (data.length < 1000) break;
}
const gerado = gerarCatalogo(pedidos);
const comValidadas = incluirValidadas(gerado.linhas, LINHAS_VALIDADAS); // as validadas à mão entram sempre (com erro se conflitarem)
const cat = { ...gerado, linhas: comValidadas.linhas, hash: comValidadas.hash };
const corpo = {
  versao, hash: cat.hash,
  origem: { fonte: "parser_fd_pedidos (histórico da unidade titular)", periodo: [primeiro, ultimo], pedidos: cat.estatisticas.pedidos,
    pedidosDeTreino: cat.estatisticas.treino, parametros: cat.parametros, linhasVistasNasDuasOperacoes: cat.estatisticas.linhasVistasNasDuas,
    validadasManualmente: LINHAS_VALIDADAS.length },
  termosValidados: Object.fromEntries(Object.entries(TERMOS_VALIDADOS).map(([op, l]) => [op, l.map((x) => x.termo)])),
  linhas: cat.linhas,
};
const js = renderizarCatalogo(corpo);
writeFileSync(saida, js, "utf8");
console.log(JSON.stringify({ versao, hash: cat.hash, ...cat.estatisticas, periodo: [primeiro, ultimo] }));
process.exit(0);
