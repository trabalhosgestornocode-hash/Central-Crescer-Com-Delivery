// Guarda estática: o domínio financeiro NUNCA lê organização/unidade/usuário do cliente (corpo, query, params ou cabeçalhos).
// O tenant vem só de req.financeiro (gate do Agente 1) e o autor de req.user.id, via contextoDe(req).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "src", "modules", "gestao-financeira", "dominio");
const arquivos = [];
const varrer = (d) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) varrer(p); else if (p.endsWith(".js")) arquivos.push(p); } };
varrer(raiz);
const semComentarios = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("nenhum arquivo do domínio lê organizacao/unidade/usuario de body, query, params ou headers", () => {
  const proibido = /(body|query|params|headers)\??\.\s*(organizacao|unidade|usuario|org)[A-Za-z_]*/i;
  const ruins = arquivos.filter((p) => proibido.test(semComentarios(readFileSync(p, "utf8")))).map((p) => p.slice(raiz.length + 1));
  assert.deepEqual(ruins, []);
});

test("só contexto.js lê req.financeiro/req.user; as RPCs recebem p_org/p_unidade/p_usuario apenas do contexto validado", () => {
  const leem = arquivos.filter((p) => /req\??\.(financeiro|user)\b/.test(semComentarios(readFileSync(p, "utf8")))).map((p) => p.slice(raiz.length + 1).replaceAll("\\", "/"));
  assert.deepEqual(leem, ["contexto.js"]);
  for (const nome of ["repositorio.js", "repositorio.periodos.js", "repositorio.conciliacao.js"]) {
    const src = semComentarios(readFileSync(join(raiz, nome), "utf8"));
    for (const m of src.matchAll(/p_(org|unidade|usuario):\s*([^,}\n]+)/g)) assert.match(m[2].trim(), /^ctx\.(organizacaoId|unidadeId|usuarioId)$/, `${nome}: ${m[0]}`);
  }
});

test("nenhuma rota DELETE e nenhuma chamada de exclusão física no repositório", () => {
  const rotas = semComentarios(readFileSync(join(raiz, "rotas.js"), "utf8"));
  assert.doesNotMatch(rotas, /\br\.delete\(/);
  for (const nome of ["repositorio.js", "repositorio.periodos.js", "repositorio.conciliacao.js"]) assert.doesNotMatch(semComentarios(readFileSync(join(raiz, nome), "utf8")), /\.delete\(/);
});
