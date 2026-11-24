// Executor da suíte do backend: passa ao `node --test` SÓ os arquivos de teste (*.test.js|mjs|cjs) de test/.
//
// Por quê: `node --test test/` (Node 20) trata QUALQUER .js dentro de uma pasta chamada test como arquivo de teste — inclusive
// test/helpers/*, que são processos auxiliares (ex.: ifood-worker-fixture.mjs roda para sempre até receber SIGTERM) e módulos
// de apoio. Eles eram executados soltos, falhavam por tempo esgotado e entravam na contagem de falhas sem serem testes.
// Os helpers continuam sendo usados pelos testes que dependem deles (importados ou iniciados como processo por caminho).
// Nada é ocultado: todo *.test.* de test/ é executado; a lista é conferida por test/descoberta-testes.test.js.
//
// Uso (mesmas opções do node --test):  node scripts/rodarTestes.mjs [--test-timeout=…] [--test-concurrency=…] [arquivos…]
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PADRAO_DE_TESTE = /\.test\.(c|m)?js$/;

/** Todos os arquivos de teste sob `pasta` (recursivo), em ordem estável; ignora node_modules. */
export function arquivosDeTeste(pasta = join(RAIZ, "test")) {
  const saida = [];
  const visitar = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === "node_modules") continue;
      const c = join(p, e.name);
      if (e.isDirectory()) visitar(c);
      else if (PADRAO_DE_TESTE.test(e.name)) saida.push(relative(RAIZ, c).split("\\").join("/"));
    }
  };
  visitar(pasta);
  return saida;
}

function principal() {
  const args = process.argv.slice(2);
  const opcoes = args.filter((a) => a.startsWith("--"));
  const pedidos = args.filter((a) => !a.startsWith("--"));
  const arquivos = pedidos.length ? pedidos : arquivosDeTeste();
  const r = spawnSync(process.execPath, ["--experimental-vm-modules", "--env-file-if-exists=.env", "--test", ...opcoes, ...arquivos], { cwd: RAIZ, stdio: "inherit" });
  process.exit(r.status ?? 1);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])) principal();
