// iFood — "pedidos sem Financial" em NAVEGADOR REAL (Chromium/Chrome via Playwright).
//
// Servidor local (backend/test/helpers/ifood-order-only-servidor.js): serve o frontend e responde a API com os
// SERVIÇOS REAIS do backend (OAuth, status, vínculo manual) sobre repositórios em memória; o iFood é simulado.
// Nunca fala com produção, Supabase ou iFood: sem OAuth real, sem polling real, sem ACK.
//
// Rodar (o repositório já tem o Playwright em worker-martinbrower):
//   IFOOD_PLAYWRIGHT_PATH=<...>/worker-martinbrower/node_modules/playwright IFOOD_BROWSER_CHANNEL=chrome \
//   node --test frontend/test/ifoodOrderOnly.browser.test.js
// IFOOD_SCREENSHOTS=<pasta> grava capturas das telas (desktop e celular).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)(process.env.IFOOD_PLAYWRIGHT_PATH || process.env.CHECKLIST_PLAYWRIGHT_PATH || "playwright"));
} catch { /* sem Playwright: pulado */ }
const PULAR = !chromium && "Configure IFOOD_PLAYWRIGHT_PATH (Playwright) para rodar no navegador";
const CANAL = process.env.IFOOD_BROWSER_CHANNEL || process.env.CHECKLIST_BROWSER_CHANNEL;
const CAPTURAS = process.env.IFOOD_SCREENSHOTS;
const RAIZ = resolve(fileURLToPath(new URL("..", import.meta.url)));

const SACI = "00000000-0000-0000-0000-0000000000a1";
const NORTH = "00000000-0000-0000-0000-0000000000b2";          // fora do piloto
const OUTRA = "00000000-0000-0000-0000-0000000000c3";          // outra organização, no piloto
const M_SACI = "aaaaaaaa-1111-4111-8111-00000000000a";
const M_OUTRA = "cccccccc-3333-4333-8333-00000000000c";

const PAGINA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/src/styles.css">
<script>window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}})}})};</script>
</head><body>
<div id="app" class="app"><div class="main"><header class="topbar"><h1 id="page-title">Integração iFood</h1></header><main id="view" class="content"></main></div></div>
</body></html>`;

let srv; let navegador;

before(async () => {
  if (PULAR) return;
  // O config do backend é lido no import: piloto = Saci + a unidade da outra organização; validação final DESLIGADA.
  Object.assign(process.env, {
    SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "x", SUPABASE_ANON_KEY: "x",
    IFOOD_ORDER_PILOT_UNITS: `${SACI},${OUTRA}`, IFOOD_ORDER_CLIENT_ID: "order-client-id-de-teste", IFOOD_ORDER_CLIENT_SECRET: "order-client-secret-de-teste",
    IFOOD_TOKEN_SECRET: "segredo-de-teste-com-mais-de-16-caracteres",
  });
  delete process.env.IFOOD_ORDER_MERCHANT_VALIDACAO_ENABLED;
  const { subirServidorOrderOnly } = await import("../../backend/test/helpers/ifood-order-only-servidor.js");
  srv = await subirServidorOrderOnly({ raizFrontend: RAIZ, pagina: PAGINA });
  navegador = await chromium.launch({ ...(CANAL ? { channel: CANAL } : {}) });
  if (CAPTURAS) mkdirSync(CAPTURAS, { recursive: true });
});
after(async () => { await navegador?.close(); await srv?.fechar(); });

const DESKTOP = { width: 1366, height: 768 };
const CELULAR = { width: 390, height: 844 };

/** Abre a tela de Integração iFood como o gestor da unidade (a unidade vem do contexto, nunca da tela). */
async function abrir(unidade, viewport = DESKTOP) {
  const contexto = await navegador.newContext({ viewport, extraHTTPHeaders: { "x-teste-unidade": unidade }, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
  const pagina = await contexto.newPage();
  const erros = [];
  pagina.on("pageerror", (e) => erros.push(e.message));
  // "Failed to load resource" é o navegador registrando um 4xx/5xx provocado de propósito pelo teste.
  pagina.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) erros.push(m.text()); });
  await pagina.goto(srv.base + "/");
  await pagina.evaluate(async (un) => {
    const { state } = await import("/src/state.js");
    Object.assign(state.sessao, { empresa: { id: "org", nome: "Empresa de teste" }, unidade: un, permissoes: ["integracoes.ver", "integracoes.gerenciar"], modulos: ["ifood"] });
    state.rota = "ifood";
    (await import("/src/ifood.js")).renderIfood();
  }, unidade);
  await pagina.locator("#ifood-operacao").waitFor();
  return { pagina, erros, fechar: () => contexto.close() };
}
const texto = (pagina, sel) => pagina.locator(sel).innerText();
const captura = async (pagina, nome) => { if (CAPTURAS) await pagina.screenshot({ path: resolve(CAPTURAS, `${nome}.png`), fullPage: true }); };
/** A página não rola na horizontal e nenhum botão/campo visível sai da tela. */
async function semEstouro(pagina, rotulo) {
  const r = await pagina.evaluate(() => {
    const largura = document.documentElement.clientWidth;
    const fora = [...document.querySelectorAll("#view button, #view input, #view a.btn, #view .ifood-codigo-box")]
      .filter((n) => n.offsetParent !== null)
      .map((n) => ({ id: n.id || n.textContent.trim().slice(0, 30), d: Math.round(n.getBoundingClientRect().right) }))
      .filter((x) => x.d > largura + 1);
    return { largura, rolagem: document.documentElement.scrollWidth, fora };
  });
  assert.ok(r.rolagem <= r.largura + 1, `${rotulo}: rolagem horizontal (${r.rolagem} > ${r.largura})`);
  assert.deepEqual(r.fora, [], `${rotulo}: elementos fora da tela`);
}
/** Espera a mensagem da etapa (#ifood-msg) casar com o esperado — nunca lê uma mensagem antiga. */
async function aguardarMsg(pagina, padrao) {
  await pagina.waitForFunction((fonte) => new RegExp(fonte, "i").test(document.querySelector("#ifood-msg")?.textContent ?? ""), padrao.source);
  return pagina.locator("#ifood-msg").innerText();
}
const chamadasDe = (caminho) => srv.controle.chamadas.filter((c) => c.caminho === caminho);
const vinculoDe = (unidade) => srv.ambiente.linhas.filter((l) => l.unidade_id === unidade).at(-1) ?? null;
const conexaoDe = (unidade) => srv.ambiente.conexoes.find((c) => c.unidade_id === unidade && c.status !== "revogada") ?? null;
/** Nada na tela afirma que a unidade está conectada/operando nos pedidos. */
async function semConexaoFalsa(pagina, rotulo) {
  assert.doesNotMatch(await texto(pagina, "#ifood-order-pill"), /^Conectado$|operando/i, `${rotulo}: card Pedidos`);
  assert.doesNotMatch(await texto(pagina, "#ifood-events-pill"), /^Ativo$/i, `${rotulo}: card Eventos`);
  assert.equal(await texto(pagina, "#ifood-status-pill"), "Em configuração", `${rotulo}: status geral`);
  assert.equal(await pagina.locator('[data-acao="continuar"], [data-acao="vincular"], [data-acao="conectar"]').count(), 0, `${rotulo}: nenhum atalho para o assistente de Analytics/Financial`);
  assert.equal(await pagina.locator('[data-acao="desconectar"]').count(), 1, `${rotulo}: dá para desfazer a conexão`);
  assert.equal(await pagina.locator("#ifood-abrir-pedidos").count(), 0, `${rotulo}: sem lista de pedidos`);
  assert.doesNotMatch(await texto(pagina, "#view"), /Integração conectada|operando/i, rotulo);
  assert.match(await texto(pagina, "#ifood-loja"), /Nenhuma loja iFood vinculada/, `${rotulo}: loja não aparece como vinculada`);
}

describe("iFood — pedidos sem Financial, no navegador", { skip: PULAR }, () => {
  test("Saci (desktop): do painel vazio até 'Aguardando validação final', com erros e recuperação no caminho", async () => {
    const { pagina, erros, fechar } = await abrir(SACI);
    try {
      // 1. Sem Financial e sem loja: o botão de conectar pedidos existe.
      assert.equal(await texto(pagina, "#ifood-order-pill"), "Não conectado");
      await pagina.locator('[data-acao="conectar_order"]').waitFor();
      assert.equal(await pagina.getByText("Vincule a loja iFood desta unidade").count(), 0);
      assert.equal(await pagina.locator('[data-acao="informar_loja"]').count(), 0, "o ID da loja só é pedido depois de autorizar");
      await captura(pagina, "01-desktop-painel-sem-conexao");
      await semEstouro(pagina, "painel");

      // 2. OAuth simulado.
      await pagina.locator('[data-acao="conectar_order"]').click();
      await pagina.locator("#ifood-gerar").click();
      assert.equal(await texto(pagina, ".ifood-codigo"), "SIMU-LADO");
      assert.equal(srv.controle.iFood.userCode, 1);
      assert.deepEqual(chamadasDe("/oauth/start").at(-1).corpo, { appType: "order" }, "aplicativo de pedidos — nunca o Financial");

      // 3. Código de autorização errado: erro na tela, continua na etapa; o certo avança.
      await pagina.locator("#ifood-authcode").fill("codigo-errado");
      await pagina.locator("#ifood-concluir").click();
      await aguardarMsg(pagina, /Não foi possível concluir a autorização|autorização/i);
      assert.equal(conexaoDe(SACI), null, "código errado não cria conexão");

      // A sessão do código errado foi consumida: gera outro código e conclui.
      await pagina.locator("#ifood-wizard-sair").click();
      await pagina.locator('[data-acao="conectar_order"]').click();
      await pagina.locator("#ifood-gerar").click();
      await pagina.locator("#ifood-authcode").fill("CODIGO-DE-AUTORIZACAO-SIMULADO");
      await pagina.locator("#ifood-concluir").click();

      // 4. Formulário do ID da loja, com a trilha das cinco etapas.
      await pagina.locator("#ifood-loja-id").waitFor();
      assert.deepEqual(await pagina.locator("#ifood-trilha-loja li").allInnerTexts(),
        ["✓ Conectar pedidos", "✓ Autorizar o aplicativo", "Informar o ID da loja", "Conferir os dados", "Validação final"]);
      assert.deepEqual([conexaoDe(SACI).status, conexaoDe(SACI).merchant_id], ["pendente", null]);
      await captura(pagina, "02-desktop-informar-id");
      await semEstouro(pagina, "informar ID");

      // 5. ID fora do formato: barrado na tela, sem chamada à API.
      await pagina.locator("#ifood-loja-id").fill("123");
      await pagina.locator("#ifood-loja-continuar").click();
      await aguardarMsg(pagina, /36 caracteres/);
      assert.equal(chamadasDe("/merchants/manual").length, 0);

      // 6. Falha da API (503): mensagem, botão liberado de novo, e a nova tentativa funciona.
      srv.controle.falharProxima = { caminho: "/merchants/manual", status: 503, corpo: { error: "Serviço temporariamente indisponível. Tente novamente." } };
      await pagina.locator("#ifood-loja-id").fill(`  ${M_SACI.toUpperCase()} `);
      await pagina.locator("#ifood-loja-continuar").click();
      await aguardarMsg(pagina, /temporariamente indisponível/);
      assert.equal(await pagina.locator("#ifood-loja-continuar").isDisabled(), false);
      assert.equal(vinculoDe(SACI), null, "a falha não gravou nada");
      await pagina.locator("#ifood-loja-continuar").click();

      // 7. Conferência: o ID digitado aparece inteiro; sem marcar a caixa, não confirma.
      await pagina.locator("#ifood-loja-id-exibido").waitFor();
      assert.equal(await texto(pagina, "#ifood-loja-id-exibido"), M_SACI);
      assert.equal(vinculoDe(SACI).estado, "informado");
      await captura(pagina, "03-desktop-conferir");
      await pagina.locator("#ifood-loja-confirmar").click();
      await aguardarMsg(pagina, /Marque a confirmação/);
      assert.equal(chamadasDe("/merchants/manual/conferir").length, 0, "sem a conferência do responsável, nenhuma chamada");
      assert.equal(vinculoDe(SACI).estado, "informado");
      await pagina.locator("#ifood-loja-ciente").check();
      await pagina.locator("#ifood-loja-confirmar").click();

      // 8. Aguardando validação final.
      await pagina.locator("#ifood-loja-aguardando").waitFor();
      assert.match(await texto(pagina, "#view"), /Aguardando validação final/);
      assert.match(await texto(pagina, "#view"), /os pedidos ainda não chegam à Central/);
      assert.equal(vinculoDe(SACI).estado, "aguardando_validacao");
      await captura(pagina, "04-desktop-aguardando");
      await pagina.locator("#ifood-loja-concluir").click();

      // 9. Painel coerente com o backend — e nada de "conectado", mesmo com o recebimento de eventos ligado no ambiente.
      await pagina.locator("#ifood-order-pill").waitFor();
      assert.equal(await texto(pagina, "#ifood-order-pill"), "Aguardando validação final");
      assert.equal(await pagina.locator("#ifood-order-loja-acoes").count(), 0, "nenhuma ação de loja para o gestor nesta etapa");
      await semConexaoFalsa(pagina, "aguardando (eventos desligados)");
      srv.controle.eventos = "active";
      await pagina.reload();
      await pagina.evaluate(async () => { (await import("/src/ifood.js")).renderIfood(); });
      await pagina.locator("#ifood-order-pill").waitFor();
      assert.equal(await texto(pagina, "#ifood-events-pill"), "Aguardando validação da loja");
      await semConexaoFalsa(pagina, "aguardando (eventos ligados no ambiente)");
      await captura(pagina, "05-desktop-painel-aguardando");
      await semEstouro(pagina, "painel aguardando");
      srv.controle.eventos = "disabled";

      // 10. Backend: conexão pendente, sem merchant; nenhuma consulta de eventos, nenhum ACK, nenhuma validação.
      assert.deepEqual([conexaoDe(SACI).status, conexaoDe(SACI).merchant_id], ["pendente", null]);
      assert.equal(srv.ambiente.chamadas.polling.length + srv.ambiente.chamadas.ack.length + srv.ambiente.chamadas.definirMerchant, 0);
      const usadas = [...new Set(srv.controle.chamadas.map((c) => `${c.metodo} ${c.caminho}`))];
      assert.deepEqual(usadas.filter((c) => /verificar-autorizacao|validar|\/merchants$|\/merchants\/link|financial|pedidos/.test(c)), [], "a tela não chama validação final, Merchant API, Financial nem pedidos");
      assert.ok(!JSON.stringify(await pagina.content()).includes(M_SACI), "o ID inteiro não fica na página depois de conferido");
      assert.deepEqual(erros, []);
    } finally { await fechar(); }
  });

  test("validação final bloqueada pela flag: chamadas diretas respondem 403 e não consultam o iFood", async () => {
    const { pagina, fechar } = await abrir(SACI);
    try {
      const r = await pagina.evaluate(async (id) => {
        const post = async (rota, corpo) => { const x = await fetch(`/api/v1/integracoes/ifood${rota}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) }); return { status: x.status, json: await x.json() }; };
        return [await post("/merchants/manual/verificar-autorizacao", {}), await post("/merchants/manual/validar", { merchantId: id, evidenciaPortalParceiro: true, confirmacaoOperacional: true })];
      }, M_SACI);
      assert.deepEqual(r.map((x) => [x.status, x.json.codigo]), [[403, "IFOOD_VALIDACAO_NAO_HABILITADA"], [403, "IFOOD_VALIDACAO_NAO_HABILITADA"]]);
      assert.equal(srv.ambiente.chamadas.polling.length + srv.ambiente.chamadas.definirMerchant, 0);
      assert.equal(vinculoDe(SACI).estado, "aguardando_validacao");
    } finally { await fechar(); }
  });

  test("outra unidade (celular): não vê nada da Saci, não consegue usar a loja dela, e retoma a conferência depois de sair", async () => {
    const { pagina, erros, fechar } = await abrir(OUTRA, CELULAR);
    try {
      // Isolamento: painel limpo, sem o ID (nem mascarado) da Saci.
      assert.equal(await texto(pagina, "#ifood-order-pill"), "Não conectado");
      assert.doesNotMatch(await texto(pagina, "#view"), /aaaa|000a|Aguardando validação/);
      await semEstouro(pagina, "celular: painel");
      await captura(pagina, "06-celular-painel");

      await pagina.locator('[data-acao="conectar_order"]').tap();
      await pagina.locator("#ifood-gerar").tap();
      await semEstouro(pagina, "celular: código de vínculo");
      await pagina.locator("#ifood-authcode").fill("CODIGO-DE-AUTORIZACAO-SIMULADO");
      await pagina.locator("#ifood-concluir").tap();
      await pagina.locator("#ifood-loja-id").waitFor();
      await semEstouro(pagina, "celular: informar ID");
      await captura(pagina, "07-celular-informar-id");

      // A loja da Saci (em aberto lá) não pode ser informada aqui.
      await pagina.locator("#ifood-loja-id").fill(M_SACI);
      await pagina.locator("#ifood-loja-continuar").tap();
      await aguardarMsg(pagina, /já está vinculada a outra unidade/);
      assert.equal(vinculoDe(OUTRA), null);
      assert.equal(vinculoDe(SACI).unidade_id, SACI, "o vínculo da Saci continua dela");

      // Com a loja certa: conferência.
      await pagina.locator("#ifood-loja-id").fill(M_OUTRA);
      await pagina.locator("#ifood-loja-continuar").tap();
      await pagina.locator("#ifood-loja-id-exibido").waitFor();
      await semEstouro(pagina, "celular: conferir");
      // A frase da conferência é um bloco só (não se quebra em colunas no celular).
      const frase = await pagina.locator("label.ifood-check > span").innerText();
      assert.equal(frase.replace(/\s+/g, " "), "Conferi no Portal do Parceiro que este é o ID da loja desta unidade.");
      assert.equal(await pagina.locator("label.ifood-check > *").count(), 2, "caixa + texto");
      await captura(pagina, "08-celular-conferir");

      // Sai sem confirmar: o painel mostra "Aguardando conferência" e oferece conferir/corrigir.
      await pagina.locator("#ifood-wizard-sair").tap();
      await pagina.locator('[data-acao="conferir_loja"]').waitFor();
      assert.equal(await texto(pagina, "#ifood-order-pill"), "Aguardando conferência");
      assert.equal(vinculoDe(OUTRA).estado, "informado");
      await semConexaoFalsa(pagina, "informado");
      await semEstouro(pagina, "celular: painel informado");
      await captura(pagina, "09-celular-painel-informado");

      // Retoma: sem o ID em memória, precisa digitar de novo. ID diferente é recusado; o certo confirma.
      await pagina.locator('[data-acao="conferir_loja"]').tap();
      await pagina.locator("#ifood-loja-id-conf").waitFor();
      assert.equal(await pagina.locator("#ifood-loja-id-exibido").count(), 0);
      await pagina.locator("#ifood-loja-id-conf").fill("dddddddd-4444-4444-8444-00000000000d");
      await pagina.locator("#ifood-loja-ciente").check();
      await pagina.locator("#ifood-loja-confirmar").tap();
      await aguardarMsg(pagina, /diferente do ID informado/);
      assert.equal(vinculoDe(OUTRA).estado, "informado");
      await pagina.locator("#ifood-loja-id-conf").fill(M_OUTRA);
      await pagina.locator("#ifood-loja-confirmar").tap();
      await pagina.locator("#ifood-loja-aguardando").waitFor();
      await semEstouro(pagina, "celular: aguardando");
      await captura(pagina, "10-celular-aguardando");
      assert.equal(vinculoDe(OUTRA).estado, "aguardando_validacao");

      // Cada unidade só mexeu no que é dela.
      assert.ok(srv.ambiente.linhas.every((l) => (l.unidade_id === SACI) === (l.merchant_id === M_SACI)));
      assert.deepEqual(erros, []);
    } finally { await fechar(); }
  });

  test("loja rejeitada: o painel explica e deixa informar de novo (corrigir o ID)", async () => {
    // Resultado que só a validação final (desligada) produziria: simulado direto no estado do "banco".
    const v = vinculoDe(SACI);
    Object.assign(v, { estado: "rejeitado", rejeitado_em: new Date(srv.ambiente.relogio.ms).toISOString(), encerrado_motivo: "SEM_AUTORIZACAO" });
    const { pagina, erros, fechar } = await abrir(SACI);
    try {
      assert.equal(await texto(pagina, "#ifood-order-pill"), "Loja não confirmada");
      assert.match(await texto(pagina, "#ifood-order-erro"), /O iFood não reconheceu esta loja/);
      await semConexaoFalsa(pagina, "rejeitado");
      await captura(pagina, "11-desktop-rejeitado");
      await pagina.locator('[data-acao="informar_loja"]').click();
      await pagina.locator("#ifood-loja-id").fill("eeeeeeee-5555-4555-8555-00000000000e");
      await pagina.locator("#ifood-loja-continuar").click();
      await pagina.locator("#ifood-loja-id-exibido").waitFor();
      assert.deepEqual(srv.ambiente.linhas.filter((l) => l.unidade_id === SACI).map((l) => l.estado), ["rejeitado", "informado"], "a rejeição fica no histórico");
      assert.deepEqual(erros, []);
    } finally { await fechar(); }
  });

  test("unidade fora da allowlist: 'Ainda não disponível', sem botão; chamadas diretas são recusadas", async () => {
    const { pagina, erros, fechar } = await abrir(NORTH);
    try {
      assert.equal(await texto(pagina, "#ifood-order-pill"), "Ainda não disponível para esta unidade");
      assert.equal(await pagina.locator('[data-acao="conectar_order"], [data-acao="informar_loja"], [data-acao="conferir_loja"]').count(), 0);
      const r = await pagina.evaluate(async ({ id, saci }) => {
        const post = async (rota, corpo) => { const x = await fetch(`/api/v1/integracoes/ifood${rota}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) }); return { status: x.status, codigo: (await x.json()).codigo }; };
        return [
          await post("/oauth/start", { appType: "order" }),
          // tentando "escolher" a unidade pelo corpo: o tenant é o do contexto
          await post("/merchants/manual", { merchantId: id, unidadeId: saci, unidade_id: saci }),
        ];
      }, { id: "ffffffff-6666-4666-8666-00000000000f", saci: SACI });
      assert.deepEqual(r, [{ status: 403, codigo: "IFOOD_ORDER_PILOTO_NAO_HABILITADO" }, { status: 403, codigo: "IFOOD_ORDER_PILOTO_NAO_HABILITADO" }]);
      assert.equal(srv.ambiente.linhas.filter((l) => l.unidade_id === NORTH).length, 0);
      assert.deepEqual(erros, []);
    } finally { await fechar(); }
  });

  test("em todo o teste: o iFood simulado só recebeu geração de código e troca de token — nenhuma consulta de eventos", () => {
    assert.ok(srv.controle.iFood.userCode >= 3 && srv.controle.iFood.troca >= 3);
    assert.equal(srv.ambiente.chamadas.polling.length, 0);
    assert.equal(srv.ambiente.chamadas.ack.length, 0);
    assert.equal(srv.ambiente.chamadas.token.length, 0, "nenhum token Order foi usado para chamar o iFood");
    assert.ok(srv.ambiente.conexoes.every((c) => c.merchant_id === null && c.status === "pendente"), "nenhuma conexão virou ativa nem recebeu merchant");
  });
});
