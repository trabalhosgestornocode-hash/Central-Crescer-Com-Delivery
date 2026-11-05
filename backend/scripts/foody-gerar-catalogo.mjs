// Gera o catálogo versionado de linhas por operação (backend/src/modules/foody/foody.catalogo-operacao.js) a partir de um
// ARQUIVO LOCAL com o histórico do Parser de UMA unidade (sem banco, sem rede, sem service_role). O arquivo de entrada é
// extraído à parte por uma sessão SOMENTE LEITURA (só importações concluídas da unidade titular) e NUNCA entra no repositório:
// o catálogo registra o hash e a contagem da entrada em `origem`, o que torna a geração reprodutível e auditável.
// O arquivo gerado entra por PR, com nova versão e o hash registrado no teste de regressão (foody-compartilhada-catalogo.test.js).
//
//   node scripts/foody-gerar-catalogo.mjs --entrada=historico.json --versao=AAAA-MM-DD.N [--ate=AAAA-MM-DD] [--saida=arquivo]
//
// Entrada: JSON [{ id, dia: "AAAA-MM-DD", det: "<Detalhes do pedido>" }, ...]. --ate=D usa só pedidos com dia < D (holdout).
// Não imprime o texto bruto dos pedidos — só estatísticas. As linhas do catálogo são nomes de produto/complemento do cardápio.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { gerarCatalogo, hashEntrada, renderizarCatalogo } from "../src/modules/foody/foody.catalogo.gerador.js";
import { LINHAS_VALIDADAS } from "../src/modules/foody/foody.catalogo-validadas.js";
import { TERMOS_VALIDADOS } from "../src/modules/foody/foody.classificacao.js";

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const entrada = arg("entrada"), versao = arg("versao"), ate = arg("ate");
if (!entrada || !/^\d{4}-\d{2}-\d{2}\.\d+$/.test(versao ?? "") || (ate && !/^\d{4}-\d{2}-\d{2}$/.test(ate))) {
  console.error("uso: --entrada=historico.json --versao=AAAA-MM-DD.N [--ate=AAAA-MM-DD] [--saida=arquivo]"); process.exit(2);
}
const saida = arg("saida") ?? join(dirname(fileURLToPath(import.meta.url)), "..", "src", "modules", "foody", "foody.catalogo-operacao.js");

const bruto = JSON.parse(readFileSync(entrada, "utf8"));
const pedidos = bruto
  .filter((r) => r.det && /^\d{4}-\d{2}-\d{2}$/.test(String(r.dia ?? "")) && (!ate || r.dia < ate))
  .map((r) => ({ id: r.id, dia: r.dia, detalhes: r.det }));
const dias = pedidos.map((p) => p.dia).sort();
const cat = gerarCatalogo(pedidos, { validadas: LINHAS_VALIDADAS }); // as validadas à mão entram sempre (com erro se conflitarem)
const corpo = {
  versao, hash: cat.hash,
  origem: { fonte: "parser_fd_pedidos (histórico da unidade titular; importações concluídas)", periodo: [dias[0], dias.at(-1)],
    pedidos: cat.estatisticas.pedidos, sha256Entrada: hashEntrada(pedidos), pedidosDeTreino: cat.estatisticas.treino,
    parametros: cat.parametros, linhasCamada1: cat.camada1, linhasCoocorrencia: { subway: cat.estatisticas.coocorrencia.subway,
      acai_no_grau: cat.estatisticas.coocorrencia.acai_no_grau }, linhasVistasNasDuasOperacoes: cat.estatisticas.linhasVistasNasDuas,
    validadasManualmente: LINHAS_VALIDADAS.length },
  termosValidados: Object.fromEntries(Object.entries(TERMOS_VALIDADOS).map(([op, l]) => [op, l.map((x) => x.termo)])),
  linhas: cat.linhas,
};
writeFileSync(saida, renderizarCatalogo(corpo), "utf8");
console.log(JSON.stringify({ versao, hash: cat.hash, sha256Entrada: corpo.origem.sha256Entrada, ...cat.estatisticas, camada1: cat.camada1,
  periodo: corpo.origem.periodo }));
