// Camada central Foody — garantias ESTRUTURAIS do piloto em sombra:
//   * o módulo só emite GET e só fala com a API Foody;
//   * nenhum código existente importa o módulo (Parser, Dashboard, Checklist, notificações, WhatsApp, Agente, server.js);
//   * o módulo não importa nada que envie mensagem ou escreva em tabelas existentes;
//   * a migration 144 é aditiva, com RLS sem policy, sem grant a anon/authenticated e com rollback correspondente.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULO = join(RAIZ, "src", "modules", "foody");
const MIGRATIONS = join(RAIZ, "..", "database", "migrations");
const semComentarios = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");

function arquivos(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? (f === "node_modules" ? [] : arquivos(p)) : (/\.(m?js)$/.test(f) ? [p] : []);
  });
}
const doModulo = arquivos(MODULO);

describe("módulo foody — só leitura na API", () => {
  test("existe e tem os arquivos esperados", () => {
    const nomes = doModulo.map((p) => relative(MODULO, p)).sort();
    for (const n of ["foody.adapter.js", "foody.agendador.js", "foody.client.js", "foody.constants.js", "foody.fechamento.calc.js",
      "foody.fechamento.service.js", "foody.flags.js", "foody.periodo.js", "foody.repository.js", "foody.seguranca.js", "foody.sync.service.js"]) {
      assert.ok(nomes.includes(n), n);
    }
  });
  test("nenhum método HTTP de escrita; o único method é GET", () => {
    for (const p of doModulo) {
      const s = semComentarios(readFileSync(p, "utf8"));
      assert.doesNotMatch(s, /method\s*:\s*["'`](POST|PUT|PATCH|DELETE)["'`]/i, relative(RAIZ, p));
      assert.doesNotMatch(s, /\b(axios|got|node-fetch|undici|http\.request|https\.request)\b/, relative(RAIZ, p));
      const metodos = [...s.matchAll(/method\s*:\s*["'`](\w+)["'`]/gi)].map((m) => m[1].toUpperCase());
      assert.ok(metodos.every((m) => m === "GET"), `${relative(RAIZ, p)}: ${metodos}`);
    }
    const cliente = semComentarios(readFileSync(join(MODULO, "foody.client.js"), "utf8"));
    assert.equal((cliente.match(/fetchImpl\(/g) ?? []).length, 1, "um único ponto de chamada HTTP");
    assert.match(cliente, /method:\s*"GET"/);
    assert.doesNotMatch(cliente, /body\s*:/);
  });
  test("o único host é app.foodydelivery.com e a única rota é /orders?", () => {
    for (const p of doModulo) {
      const s = semComentarios(readFileSync(p, "utf8"));
      for (const [url] of s.matchAll(/https?:\/\/[^\s"'`)]+/g)) assert.match(url, /^https:\/\/app\.foodydelivery\.com\/rest\/1\.2$/, `${relative(RAIZ, p)}: ${url}`);
    }
    const rotas = [...semComentarios(readFileSync(join(MODULO, "foody.client.js"), "utf8")).matchAll(/get\(`(\/[^`?]*)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(rotas)], ["/orders"]);
  });
  test("não importa supabase direto, WhatsApp, notificações, checklist, agente nem serviços que gravam", () => {
    for (const p of doModulo) {
      const imports = [...readFileSync(p, "utf8").matchAll(/(?:import|from)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
      for (const i of imports) {
        assert.doesNotMatch(i, /config\/supabase|whatsapp|notifica|comunicacao|checklist|agente|performance|financeiro|\.routes|\.controller/i,
          `${relative(RAIZ, p)} importa ${i}`);
        if (!i.startsWith("./")) assert.doesNotMatch(i, /\.service\.js$/, `${relative(RAIZ, p)} importa serviço externo ${i}`);
        if (i.startsWith("../")) assert.match(i, /^\.\.\/(parser-food-delivery\/parserFoodDelivery\.(operacao|calc|classificacao|dashboard)\.js|ifood\/ifood\.logsafe\.js|\.\.\/shared\/cripto\.js)$/, `${relative(RAIZ, p)} importa ${i}`);
      }
    }
  });
  test("não escreve em tabela que não seja foody_* e só chama a RPC foody_fechamento_registrar", () => {
    for (const p of doModulo) {
      const s = semComentarios(readFileSync(p, "utf8"));
      for (const [, t] of s.matchAll(/\.from\(\s*["'`]([\w.]+)["'`]/g)) assert.match(t, /^foody_/, `${relative(RAIZ, p)}: ${t}`);
      for (const [, r] of s.matchAll(/\.rpc\(\s*["'`]([\w.]+)["'`]/g)) assert.equal(r, "foody_fechamento_registrar");
    }
  });
  test("nenhum console.* direto (todo log passa por foodyLog)", () => {
    for (const p of doModulo.filter((x) => !x.endsWith("foody.seguranca.js"))) {
      assert.doesNotMatch(semComentarios(readFileSync(p, "utf8")), /console\.(log|error|warn|info)/, relative(RAIZ, p));
    }
  });
});

describe("nenhum consumidor nesta fase", () => {
  // Única exceção: o gerador OFFLINE do catálogo versionado (145), que só LÊ o histórico e escreve um arquivo local para PR.
  const GERADOR_CATALOGO = join(RAIZ, "scripts", "foody-gerar-catalogo.mjs");
  test("nenhum arquivo fora do módulo importa modules/foody (exceto o gerador offline do catálogo)", () => {
    const fora = [...arquivos(join(RAIZ, "src")), ...arquivos(join(RAIZ, "scripts")).filter(Boolean)].filter((p) => !p.startsWith(MODULO));
    const culpados = fora.filter((p) => p !== GERADOR_CATALOGO && /modules\/foody\/|\/foody\/foody\.|["']\.\.?\/foody\//.test(readFileSync(p, "utf8")));
    assert.deepEqual(culpados.map((p) => relative(RAIZ, p)), []);
  });
  test("o gerador do catálogo só faz SELECT e só importa gerador/classificação", () => {
    const s = semComentarios(readFileSync(GERADOR_CATALOGO, "utf8"));
    assert.doesNotMatch(s, /\.(insert|update|upsert|delete|rpc)\(/);
    assert.deepEqual([...s.matchAll(/\.from\(\s*["'`]([\w.]+)["'`]/g)].map((m) => m[1]), ["parser_fd_pedidos"]);
    const daCamada = [...s.matchAll(/from\s+["']([^"']*modules\/foody\/[^"']+)["']/g)].map((m) => m[1]).sort();
    assert.deepEqual(daCamada, ["../src/modules/foody/foody.catalogo.gerador.js", "../src/modules/foody/foody.classificacao.js"]);
  });
  test("server.js não menciona a camada Foody", () => {
    assert.doesNotMatch(readFileSync(join(RAIZ, "src", "server.js"), "utf8"), /foody/i);
  });
  test("nenhuma tabela existente é lida pelo módulo (parser_fd_*, operacional_*, checklist_*, comunicacao_*)", () => {
    for (const p of doModulo) assert.doesNotMatch(readFileSync(p, "utf8"), /["'`](parser_fd_|operacional_|checklist_|comunicacao_)\w+["'`]/, relative(RAIZ, p));
  });
});

describe("migration 144 — estático", () => {
  const sql = readFileSync(join(MIGRATIONS, "144_foody_camada_central.sql"), "utf8");
  const rb = readFileSync(join(MIGRATIONS, "144_rollback.sql"), "utf8");
  const corpo = sql.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join("\n");
  test("não há outra 144; posteriores só as conhecidas (145 = conexão compartilhada, aditiva)", () => {
    const arqs = readdirSync(MIGRATIONS).filter((f) => /^\d{3}_/.test(f) && !/rollback/i.test(f));
    assert.equal(arqs.filter((f) => f.startsWith("144")).length, 1);
    assert.deepEqual(arqs.filter((f) => f.slice(0, 3) > "144").sort(), ["145_foody_conexao_compartilhada.sql"]);
  });
  test("transação com lock_timeout; só CREATE de objetos foody_*; não altera nem apaga nada existente", () => {
    assert.match(corpo, /^\s*begin;\s*\nset local lock_timeout = '5s';/m); assert.match(corpo, /commit;\s*$/);
    for (const [, nome] of corpo.matchAll(/create (?:or replace )?(?:table|function|index|trigger)(?: if not exists)? (\w+)/gi)) {
      assert.match(nome, /^(foody_|idx_foody_|trg_foody_)/, nome);
    }
    for (const [, alvo] of corpo.matchAll(/alter table (\w+)/gi)) assert.match(alvo, /^foody_/, alvo);
    for (const [, alvo] of corpo.matchAll(/drop trigger if exists \w+ on (\w+)/gi)) assert.match(alvo, /^foody_/, alvo);
    assert.doesNotMatch(corpo, /^\s*(drop table|drop function|truncate|delete from|insert into (?!foody_)|update (?!foody_))/im, "DML/DDL destrutivo fora de foody_*");
  });
  test("RLS ligado nas 4 tabelas, nenhuma policy, nenhum grant a anon/authenticated", () => {
    for (const t of ["foody_conexoes", "foody_sync_execucoes", "foody_pedidos", "foody_fechamentos_logisticos"]) {
      assert.match(corpo, new RegExp(`alter table ${t} enable row level security`));
    }
    assert.doesNotMatch(corpo, /create policy/i);
    assert.doesNotMatch(corpo, /grant [^;]* to (anon|authenticated|public)\b/i);
    assert.match(corpo, /grant select on table foody_fechamentos_logisticos to service_role/);
    assert.doesNotMatch(corpo, /grant [^;]*(insert|delete)[^;]* on table foody_fechamentos_logisticos/i, "fechamento só pela função");
    assert.doesNotMatch(corpo, /grant [^;]*delete[^;]* on table foody_/i, "nenhum DELETE concedido");
  });
  test("nenhuma coluna de dado pessoal nem de token em claro", () => {
    assert.doesNotMatch(corpo, /\b(cliente|customer|telefone|phone|endereco|address|email|cpf|observac|notes|entregador_nome|courier_name|token text)\b/i);
    assert.match(corpo, /token_cifrado text not null check \(token_cifrado ~ '\^k\[0-9\]\+:'\)/);
  });
  test("rollback remove exatamente o que a 144 cria, em transação", () => {
    assert.match(rb, /begin;[\s\S]*commit;/);
    for (const t of ["foody_conexoes", "foody_sync_execucoes", "foody_pedidos", "foody_fechamentos_logisticos"]) assert.match(rb, new RegExp(`drop table if exists public\\.${t};`));
    for (const f of ["foody_validar_tenant", "foody_validar_vinculo_execucao", "foody_validar_conexao_execucao", "foody_registro_imutavel", "foody_fechamento_registrar"]) {
      assert.match(rb, new RegExp(`drop function if exists public\\.${f}\\(`));
    }
    assert.doesNotMatch(rb.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join("\n"), /drop table if exists public\.(?!foody_)/);
  });
});
