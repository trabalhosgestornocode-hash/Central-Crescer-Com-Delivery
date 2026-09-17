// TESTE ARQUITETURAL (Checkpoint C0 item 5 / C1 item 5): o Gateway NUNCA
// pode possuir SUPABASE_SERVICE_ROLE_KEY, um cliente Supabase, senha de
// banco ou qualquer credencial administrativa da aplicação. Ele só fala
// HTTP autenticado por HMAC com o backend.
//
// Escaneia TODO gateway-whatsapp/src (não só um arquivo) — vale para o
// código de hoje e para qualquer arquivo novo adicionado depois.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "src");

const PADROES_PROIBIDOS = [
  /supabase/i,
  /service_role/i,
  /SERVICE_ROLE_KEY/,
  /createClient\(/,
  /@supabase\/supabase-js/,
  /\bpg\b.*Client/, // cliente Postgres direto (ex.: node-postgres) também não deveria existir aqui
  /DATABASE_URL/,
  /POSTGRES_PASSWORD/,
];

function listarArquivosJs(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listarArquivosJs(full));
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}

// Remove comentários antes de escanear — o teste verifica CÓDIGO real, não
// documentação que MENCIONA a própria regra (mesmo cuidado já registrado em
// backend/test/comunicacao-arquitetura-provider.test.js: um comentário
// explicando por que "isto nunca deveria acontecer" já derrubou aquele
// teste por engano uma vez).
function removerComentarios(codigo) {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("segurança — o Gateway inteiro nunca referencia Supabase/service_role/Postgres direto", () => {
  test("nenhum arquivo em gateway-whatsapp/src menciona os padrões proibidos (fora de comentários)", () => {
    const violacoes = [];
    for (const arquivo of listarArquivosJs(SRC)) {
      const conteudo = removerComentarios(readFileSync(arquivo, "utf8"));
      for (const padrao of PADROES_PROIBIDOS) {
        if (padrao.test(conteudo)) violacoes.push(`${path.relative(SRC, arquivo)} casa ${padrao}`);
      }
    }
    assert.deepEqual(violacoes, [], `Gateway referencia algo que nunca deveria tocar:\n${violacoes.join("\n")}`);
  });

  test("config.js nunca declara uma variável de ambiente relacionada a Supabase/service_role (fora de comentários)", () => {
    const conteudo = removerComentarios(readFileSync(path.join(SRC, "config.js"), "utf8"));
    assert.ok(!/SUPABASE/i.test(conteudo));
  });

  test("package.json do Gateway nunca lista @supabase/supabase-js nem pg como dependência", () => {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    const todasDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    assert.ok(!("@supabase/supabase-js" in todasDeps));
    assert.ok(!("pg" in todasDeps));
  });
});
