// Guardas estáticas da fundação: o Financeiro v2 não depende do financeiro antigo nem de infraestrutura,
// não usa ponto flutuante em dinheiro e não está exposto em nenhuma rota.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const aqui = fileURLToPath(new URL(".", import.meta.url));
const src = resolve(aqui, "..", "..", "src");
const raiz = join(src, "modules", "financeiro-v2");
const arquivos = [];
const varrer = (d, saida = arquivos) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) { if (f.name !== "node_modules") varrer(p, saida); } else if (p.endsWith(".js")) saida.push(p); } return saida; };
varrer(raiz);
const semComentarios = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const ler = (p) => semComentarios(readFileSync(p, "utf8"));
const nome = (p) => relative(raiz, p).replaceAll("\\", "/");
const importsDe = (codigo) => [...codigo.matchAll(/(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] ?? m[2]);

test("o módulo existe e tem as camadas previstas", () => {
  const nomes = arquivos.map(nome);
  for (const esperado of ["index.js", "dominio/dinheiro.js", "dominio/contexto.js", "dominio/indicadores.js", "dominio/planoDeContas.js", "contratos/comandos.js", "contratos/repositorio.js", "contratos/cofre.js", "aplicacao/nucleo.js", "infra/repositorioMemoria.js", "infra/cofreMemoria.js", "infra/postgres/repositorioPostgres.js", "infra/postgres/destinoSeguro.js", "infra/cofreDisco.js", "aplicacao/sessao.js", "aplicacao/importacoes.js", "importacao/motor.js", "importacao/leitor.js", "importacao/correspondencias.js", "contratos/importacao.js"]) {
    assert.ok(nomes.includes(esperado), esperado);
  }
});

// Exceção única e explícita: o cofre LOCAL em disco precisa do sistema de arquivos (Execução 02).
const PERMITIDOS_POR_ARQUIVO = Object.freeze({ "infra/cofreDisco.js": ["node:fs", "node:path"] });

test("nenhum arquivo importa algo de fora da pasta do módulo (só node:crypto; node:fs/node:path só no cofre em disco)", () => {
  const ruins = [];
  for (const p of arquivos) {
    for (const alvo of importsDe(ler(p))) {
      if (alvo === "node:crypto" || (PERMITIDOS_POR_ARQUIVO[nome(p)] ?? []).includes(alvo)) continue;
      const interno = alvo.startsWith(".") && resolve(dirname(p), alvo).startsWith(join(raiz, "/"));
      if (!interno) ruins.push(`${nome(p)} → ${alvo}`);
    }
  }
  assert.deepEqual(ruins, []);
});

test("o domínio não depende da aplicação nem da infraestrutura", () => {
  const ruins = [];
  for (const p of arquivos.filter((a) => nome(a).startsWith("dominio/"))) {
    for (const alvo of importsDe(ler(p))) if (!resolve(dirname(p), alvo).startsWith(join(raiz, "dominio"))) ruins.push(`${nome(p)} → ${alvo}`);
  }
  assert.deepEqual(ruins, []);
});

test("sem acesso a ambiente, rede, banco, HTTP ou ao financeiro antigo", () => {
  const proibido = /process\.env|supabase|fetch\s*\(|\bexpress\b|\breq\.|\bres\.|gestao[-_]financeira|gestaoFinanceira|fin2_|\bfin_[a-z]|ApiError|console\./;
  const ruins = arquivos.filter((p) => proibido.test(ler(p))).map(nome);
  assert.deepEqual(ruins, []);
});

test("nenhum cálculo monetário usa ponto flutuante", () => {
  const proibido = /parseFloat|toFixed|Math\.(round|floor|ceil|trunc)\s*\([^)]*Centavos|Number\s*\(\s*["'`\w.]*valor|\/\s*100\b|\*\s*100\b|\*\s*0\.\d|\b0\.\d+\b/;
  // Endereço IPv4 literal (a guarda de destino cita o loopback) não é número com casas decimais.
  const semEnderecos = (s) => s.replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "ENDERECO");
  const ruins = arquivos.filter((p) => proibido.test(semEnderecos(ler(p)))).map(nome);
  assert.deepEqual(ruins, []);
});

test("não existe exclusão física em lugar nenhum do módulo", () => {
  const proibido = /\bdelete\s|\.delete\(|\.splice\(|\bremover\w*\s*\(|\bexcluir\w*\s*\(|\bapagar\w*\s*\(/;
  const ruins = arquivos.filter((p) => proibido.test(ler(p))).map(nome);
  assert.deepEqual(ruins, []);
});

test("o módulo não está montado em rotas nem é importado pelo restante do backend", () => {
  const fora = varrer(src, []).filter((p) => !p.startsWith(raiz));
  const usam = fora.filter((p) => /financeiro-v2/.test(readFileSync(p, "utf8"))).map((p) => relative(src, p).replaceAll("\\", "/"));
  assert.deepEqual(usam, []);
});

test("o financeiro antigo não foi alterado para conhecer o novo", () => {
  const antigo = varrer(join(src, "modules", "gestao-financeira"), []);
  assert.ok(antigo.length > 0);
  assert.deepEqual(antigo.filter((p) => /financeiro-v2|financeiro_v2/.test(readFileSync(p, "utf8"))), []);
});
