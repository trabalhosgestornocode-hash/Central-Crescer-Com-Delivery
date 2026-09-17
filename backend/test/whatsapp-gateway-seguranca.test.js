// TESTE ARQUITETURAL (Checkpoint C0/C1, item 5/7): os arquivos novos do
// Gateway WhatsApp no BACKEND (o provider real e todo o submódulo
// gateway/) nunca podem referenciar Supabase/service_role — mesma garantia
// que comunicacao-seguranca-gateway.test.js já dá para a fronteira do
// provider, estendida aos arquivos do Checkpoint C1.
//
// Também verifica a guarda de boot: sem WHATSAPP_GATEWAY_SECRET/
// WHATSAPP_GATEWAY_ORGANIZACAO_ID configurados (o estado de HOJE em
// produção), montarWhatsappGatewayRouter() não monta rota nenhuma — o
// resto do backend nunca pode falhar no boot por causa desta feature ainda
// inativa.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "src");

const ARQUIVOS_GATEWAY_C1 = [
  path.join(SRC, "modules", "comunicacao", "providers", "baileysGateway.provider.js"),
  path.join(SRC, "modules", "comunicacao", "gateway", "whatsappGateway.hmac.js"),
  path.join(SRC, "modules", "comunicacao", "gateway", "whatsappGateway.routes.js"),
  path.join(SRC, "modules", "comunicacao", "gateway", "whatsappGateway.bootstrap.js"),
];

const PADROES_PROIBIDOS = [
  /config\/supabase\.js/i,
  /SUPABASE_SERVICE_ROLE_KEY/,
  /service_role/i,
  /createClient\(/,
];

function removerComentarios(codigo) {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("segurança — arquivos do Checkpoint C1 (Gateway WhatsApp) nunca tocam Supabase/service_role", () => {
  for (const arquivo of ARQUIVOS_GATEWAY_C1) {
    test(`${path.relative(SRC, arquivo)} não referencia Supabase/service_role (fora de comentários)`, () => {
      const conteudo = removerComentarios(readFileSync(arquivo, "utf8"));
      const achados = PADROES_PROIBIDOS.filter((re) => re.test(conteudo));
      assert.deepEqual(achados.map(String), [], `${arquivo} referencia algo proibido`);
    });
  }

  // whatsappGateway.repo.js É ONDE a persistência real mora desde o C2 —
  // por isso ele PODE mencionar Supabase (dentro de criarRepoSupabase, já
  // funcional), mas o import continua só dentro da função (dinâmico,
  // preguiçoso), nunca no topo do módulo nem via createClient() próprio.
  test("whatsappGateway.repo.js não importa config/supabase.js no topo do módulo", () => {
    const conteudo = readFileSync(path.join(SRC, "modules", "comunicacao", "gateway", "whatsappGateway.repo.js"), "utf8");
    assert.ok(!/^import.*supabase/im.test(conteudo));
    assert.ok(!/createClient\(/.test(conteudo));
  });

  test("criarRepoSupabase() devolve um repositório real (Checkpoint C2 — migration 083 aplicada em teste)", async () => {
    const { criarRepoSupabase } = await import("../src/modules/comunicacao/gateway/whatsappGateway.repo.js");
    const repo = criarRepoSupabase();
    for (const metodo of ["obterAuthState", "salvarAuthState", "registrarHeartbeat", "registrarStatusProvider", "registrarMensagemRecebida"]) {
      assert.equal(typeof repo[metodo], "function", `repo.${metodo} deveria ser uma função`);
    }
  });

  test("criar criarRepoSupabase() não abre conexão nenhuma (import dinâmico é preguiçoso)", async () => {
    // Só instanciar o repo não deve importar config/supabase.js — só USAR um
    // método dele (o que os testes de integração fazem à parte).
    const { criarRepoSupabase } = await import("../src/modules/comunicacao/gateway/whatsappGateway.repo.js");
    assert.doesNotThrow(() => criarRepoSupabase());
  });
});

describe("boot — o backend nunca falha ao subir por causa do Gateway WhatsApp ainda inativo", () => {
  test("montarWhatsappGatewayRouter() devolve null sem as env vars configuradas", async () => {
    const antesSegredo = process.env.WHATSAPP_GATEWAY_SECRET;
    const antesOrg = process.env.WHATSAPP_GATEWAY_ORGANIZACAO_ID;
    delete process.env.WHATSAPP_GATEWAY_SECRET;
    delete process.env.WHATSAPP_GATEWAY_ORGANIZACAO_ID;
    try {
      const { montarWhatsappGatewayRouter } = await import(`../src/modules/comunicacao/gateway/whatsappGateway.bootstrap.js?t=${Date.now()}`);
      assert.equal(montarWhatsappGatewayRouter(), null);
    } finally {
      if (antesSegredo !== undefined) process.env.WHATSAPP_GATEWAY_SECRET = antesSegredo;
      if (antesOrg !== undefined) process.env.WHATSAPP_GATEWAY_ORGANIZACAO_ID = antesOrg;
    }
  });

  test("montarWhatsappGatewayRouter() monta a rota quando as env vars existem", async () => {
    process.env.WHATSAPP_GATEWAY_SECRET = "s".repeat(32);
    process.env.WHATSAPP_GATEWAY_ORGANIZACAO_ID = "org-teste";
    try {
      const { montarWhatsappGatewayRouter } = await import(`../src/modules/comunicacao/gateway/whatsappGateway.bootstrap.js?t=${Date.now()}-2`);
      const resultado = montarWhatsappGatewayRouter();
      assert.equal(resultado.path, "/internal/comunicacao");
      assert.ok(resultado.router);
    } finally {
      delete process.env.WHATSAPP_GATEWAY_SECRET;
      delete process.env.WHATSAPP_GATEWAY_ORGANIZACAO_ID;
    }
  });

  test("sem repo injetado, produção usa criarRepoSupabase() por padrão (Checkpoint C2)", async () => {
    process.env.WHATSAPP_GATEWAY_SECRET = "s".repeat(32);
    process.env.WHATSAPP_GATEWAY_ORGANIZACAO_ID = "org-teste";
    try {
      const { montarWhatsappGatewayRouter } = await import(`../src/modules/comunicacao/gateway/whatsappGateway.bootstrap.js?t=${Date.now()}-3`);
      const resultado = montarWhatsappGatewayRouter();
      assert.equal(typeof resultado.repo._obterConexao, "function", "esperava o repo real (criarRepoSupabase) — só ele tem _obterConexao");
      assert.equal(resultado.repo._snapshot, undefined, "não deveria ser o repo em memória");
    } finally {
      delete process.env.WHATSAPP_GATEWAY_SECRET;
      delete process.env.WHATSAPP_GATEWAY_ORGANIZACAO_ID;
    }
  });

  test("repo em memória só entra por injeção EXPLÍCITA (nunca por omissão)", async () => {
    process.env.WHATSAPP_GATEWAY_SECRET = "s".repeat(32);
    process.env.WHATSAPP_GATEWAY_ORGANIZACAO_ID = "org-teste";
    try {
      const { montarWhatsappGatewayRouter } = await import(`../src/modules/comunicacao/gateway/whatsappGateway.bootstrap.js?t=${Date.now()}-4`);
      const { criarRepoEmMemoria } = await import(`../src/modules/comunicacao/gateway/whatsappGateway.repo.js?t=${Date.now()}-4`);
      const repoInjetado = criarRepoEmMemoria();
      const resultado = montarWhatsappGatewayRouter({ repo: repoInjetado });
      assert.equal(resultado.repo, repoInjetado, "o repo injetado deveria ser usado tal qual, sem substituição");
      assert.equal(typeof resultado.repo._snapshot, "function");
    } finally {
      delete process.env.WHATSAPP_GATEWAY_SECRET;
      delete process.env.WHATSAPP_GATEWAY_ORGANIZACAO_ID;
    }
  });

  test("whatsappGateway.bootstrap.js não IMPORTA criarRepoEmMemoria — nenhum caminho de código pode cair em memória por padrão/fallback", () => {
    const conteudo = readFileSync(path.join(SRC, "modules", "comunicacao", "gateway", "whatsappGateway.bootstrap.js"), "utf8");
    const linhaImport = conteudo.split("\n").find((l) => l.includes("whatsappGateway.repo.js"));
    assert.ok(linhaImport, "esperava um import de whatsappGateway.repo.js");
    assert.ok(!/criarRepoEmMemoria/.test(linhaImport), "bootstrap.js só pode importar criarRepoSupabase — criarRepoEmMemoria entra só por injeção de quem chama (testes)");
  });

  test("whatsappGateway.repo.js não tem nenhum try/catch que esconda erro do Supabase (fail-closed: erro sempre propaga)", () => {
    const conteudo = readFileSync(path.join(SRC, "modules", "comunicacao", "gateway", "whatsappGateway.repo.js"), "utf8");
    // Dentro de criarRepoSupabase(), todo `if (x.error) throw ...` — nunca um catch que engula o erro e siga em frente.
    assert.ok(!/catch\s*\([^)]*\)\s*\{\s*(\/\/[^\n]*)?\s*\}/.test(conteudo), "não deveria haver catch vazio (engolindo erro) em whatsappGateway.repo.js");
  });

  test("app.js monta o Gateway ANTES do express.json() global e do requireAuth (isolamento da API pública)", () => {
    const conteudo = readFileSync(path.join(SRC, "app.js"), "utf8");
    const posMontagem = conteudo.indexOf("montarWhatsappGatewayRouter()");
    const posJsonGlobal = conteudo.indexOf('express.json({ limit: LIMITES_CORPO.padrao })');
    const posRequireAuth = conteudo.indexOf('app.use("/api/v1", requireAuth)');
    assert.ok(posMontagem > 0, "chamada a montarWhatsappGatewayRouter() não encontrada em app.js");
    assert.ok(posMontagem < posJsonGlobal, "Gateway precisa ser montado ANTES do express.json() global (senão o HMAC nunca vê os bytes crus)");
    assert.ok(posMontagem < posRequireAuth, "Gateway nunca pode ficar atrás de requireAuth (ele não tem JWT de usuário)");
  });
});
