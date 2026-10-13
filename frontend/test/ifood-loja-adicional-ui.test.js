// Painel iFood — autorização OAuth de uma LOJA ADICIONAL (Saladas) pela interface.
//
// Sem DOM e sem rede: funções puras + o HTML real do painel (montarHtmlPainel) + leitura do código do assistente.
// O comportamento no navegador (desktop e celular, cliques, payload enviado) está em ifood-loja-adicional.browser.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { derivarLojasAdicionais, mensagemErroAutorizacao, AVISO_LOJA_ADICIONAL } from "../src/ifoodEstado.js";
import { montarHtmlPainel } from "../src/ifood.js";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const ler = (f) => readFileSync(path.join(SRC, f), "utf8");

const LOJA = "22222222-2222-4222-8222-2222222222a1";
const SALADAS_INTEIRO = "04a17bf5-b9e6-4693-a862-a5715e9f9374";
const AGORA = "2026-10-13T15:00:00.000Z";
const appsVazio = { analytics: { conectado: false, status: null }, financial: { conectado: false, status: null } };
const orderOk = { configurado: true, conectado: true, status: "ativa", tokenValido: true, ultimaAutenticacao: AGORA, ultimoEvento: null, ultimoPedido: null, erroAtual: null, lojaValidada: true, lojaInformada: null, validacaoFinalHabilitada: false };
const saladas = (extra = {}) => ({ id: LOJA, rotulo: "Saladas", idMascarado: "04a1****9374", estado: "pendente", credencial: null, ...extra });
const status = (lojas, order = orderOk) => ({
  conectado: false, status: "ativa", merchant: { idMascarado: "a6e5****39b9", nome: "Subway Sanduíches", razaoSocial: "X" }, apps: appsVazio, order,
  ...(lojas ? { lojasAdicionais: lojas } : {}), eventosRecebimento: { estado: "active" }, conectadaEm: AGORA, atencao: { total: 0, apps: [] },
});

// ---------------------------------------------------------------------------
test("derivarLojasAdicionais: Saladas pendente e não autorizada -> pode autorizar (gerente, Order conectado)", () => {
  const [l] = derivarLojasAdicionais(status([saladas()]));
  assert.deepEqual([l.id, l.nome, l.polling.rotulo, l.credencial.rotulo, l.podeAutorizar, l.acaoRotulo, l.dica], [LOJA, "Saladas", "Aguardando liberação", "Não autorizada", true, "Autorizar Saladas", null]);
});

test("derivarLojasAdicionais: situações da credencial própria e do polling", () => {
  const f = (extra) => derivarLojasAdicionais(status([saladas(extra)]))[0];
  assert.deepEqual([f({ credencial: "ativa" }).credencial.rotulo, f({ credencial: "ativa" }).acaoRotulo], ["Autorizada", "Reautorizar Saladas"]);
  assert.deepEqual([f({ credencial: "reauth_required" }).credencial.classe, f({ credencial: "reauth_required" }).credencial.rotulo], ["bad", "Precisa reautorizar"]);
  assert.equal(f({ estado: "ativa" }).polling.rotulo, "Recebendo pedidos");
  assert.equal(f({ estado: "liberada" }).polling.rotulo, "Em verificação");
  assert.deepEqual([f({ estado: "bloqueada" }).polling.rotulo, f({ estado: "bloqueada" }).polling.classe], ["Bloqueada pelo iFood", "bad"]);
});

test("derivarLojasAdicionais: sem permissão ou sem o app de pedidos conectado NÃO oferece a ação (e explica)", () => {
  const sem = derivarLojasAdicionais(status([saladas()]), { podeGerenciar: false })[0];
  assert.deepEqual([sem.podeAutorizar, sem.dica], [false, "Sem permissão para gerenciar integrações."]);
  const semOrder = derivarLojasAdicionais(status([saladas()], { ...orderOk, conectado: false }))[0];
  assert.deepEqual([semOrder.podeAutorizar, semOrder.dica], [false, "Conecte primeiro o app de pedidos desta unidade."]);
});

test("derivarLojasAdicionais: sem lista, lista inválida, loja desativada e rótulo vazio", () => {
  assert.deepEqual(derivarLojasAdicionais(status(null)), []);
  assert.deepEqual(derivarLojasAdicionais(null), []);
  assert.deepEqual(derivarLojasAdicionais({ lojasAdicionais: "x" }), []);
  assert.deepEqual(derivarLojasAdicionais(status([saladas({ estado: "desativada" })])), []);
  assert.equal(derivarLojasAdicionais(status([saladas({ rotulo: "  " })]))[0].nome, "Loja adicional");
  assert.deepEqual(derivarLojasAdicionais(status([{ rotulo: "sem id" }, null])), []);
});

// ---------------------------------------------------------------------------
test("painel: mostra a loja pelo NOME e ID mascarado, o botão de autorizar e o aviso de que NÃO ativa o polling", () => {
  const html = montarHtmlPainel(status([saladas()]));
  assert.match(html, /id="ifood-lojas-adicionais"/);
  assert.match(html, /Saladas/);
  assert.match(html, /04a1\*\*\*\*9374/);
  assert.match(html, new RegExp(`data-autorizar-loja="${LOJA}"`));
  assert.match(html, />Autorizar Saladas</);
  assert.ok(html.includes("não ativa o recebimento de pedidos"), "o aviso do polling está no painel");
  assert.ok(html.includes(AVISO_LOJA_ADICIONAL));
});

test("painel: sem permissão não há botão de autorizar", () => {
  const html = montarHtmlPainel(status([saladas()]), { podeGerenciar: false });
  assert.doesNotMatch(html, /data-autorizar-loja/);
  assert.match(html, /Sem permissão para gerenciar integrações/);
});

test("painel: SEM lojas adicionais o HTML é idêntico ao de antes (a Sanduíches não muda)", () => {
  assert.equal(montarHtmlPainel(status(null)), montarHtmlPainel(status([])));
  assert.doesNotMatch(montarHtmlPainel(status(null)), /ifood-lojas-adicionais|Lojas adicionais/);
});

test("painel: nunca mostra token, verifier nem o merchant inteiro; o ID usado na ação é o da linha, não o merchant", () => {
  const html = montarHtmlPainel(status([saladas({ credencial: "ativa" })]));
  assert.ok(!html.includes(SALADAS_INTEIRO));
  assert.doesNotMatch(html, /access_token|refresh_token|verifier|authorization_code|secret/i);
  assert.match(html, new RegExp(`data-autorizar-loja="${LOJA}"`));
});

test("painel: rótulo malicioso da loja é escapado (sem HTML injetado)", () => {
  const html = montarHtmlPainel(status([saladas({ rotulo: '<img src=x onerror=alert(1)>' })]));
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img/);
});

// ---------------------------------------------------------------------------
test("mensagens de erro da autorização por loja", () => {
  assert.match(mensagemErroAutorizacao({ codigo: "IFOOD_CREDENCIAL_SEM_COBERTURA" }), /conta DA LOJA.*Nada foi alterado/);
  assert.match(mensagemErroAutorizacao({ codigo: "IFOOD_LOJA_NAO_ENCONTRADA" }), /não está cadastrada/);
  assert.match(mensagemErroAutorizacao({ codigo: "IFOOD_LOJA_OAUTH_INVALIDO" }), /Atualize a página/);
  assert.match(mensagemErroAutorizacao({ codigo: "IFOOD_OAUTH_SESSAO_EXPIRADA" }), /expirou/);
});

// ---------------------------------------------------------------------------
// Código do assistente (leitura): o fluxo da Sanduíches não muda e a loja nunca é digitada
// ---------------------------------------------------------------------------
test("api: `ifoodOauthStart(appType)` sem alvo envia exatamente { appType }; com alvo, só `lojaId`/`merchantId` informados", () => {
  const api = ler("api.js");
  assert.match(api, /ifoodOauthStart = \(appType, \{ lojaId, merchantId \} = \{\}\) =>/);
  assert.match(api, /\{ appType, \.\.\.\(lojaId \? \{ lojaId \} : \{\}\), \.\.\.\(merchantId \? \{ merchantId \} : \{\}\) \}/);
});

test("assistente: o botão atual da Sanduíches (`conectar_order`) continua abrindo o fluxo de sempre, sem loja", () => {
  const fonte = ler("ifood.js");
  assert.match(fonte, /conectar_order: \(\) => abrirWizard\("order"\)/);
  assert.match(fonte, /abrirWizard\(modo\) \{\s*estado\.wizard = \{ etapa: primeiraEtapaPendente\(modo\), appType: null, sessionId: null, feito: \{\}, selecao: null \};/, "o assistente comum não tem `loja`");
  assert.match(fonte, /ifoodOauthStart\(appType, estado\.wizard\?\.loja \? \{ lojaId: estado\.wizard\.loja\.id \} : undefined\)/, "sem loja no assistente, a chamada é a de antes");
});

test("assistente da loja: só abre para uma loja DA LISTA do status e para quem tem integracoes.gerenciar; nunca há campo de merchant", () => {
  const fonte = ler("ifood.js");
  const bloco = fonte.slice(fonte.indexOf("function abrirWizardLoja"), fonte.indexOf("function abrirWizard(modo)"));
  assert.match(bloco, /if \(!pode\("integracoes\.gerenciar"\)\) return;/);
  assert.match(bloco, /derivarLojasAdicionais\(estado\.status, \{ podeGerenciar: true \}\)\.find\(\(l\) => l\.id === lojaId && l\.podeAutorizar\)/);
  assert.match(bloco, /if \(!loja\) return;/);
  assert.doesNotMatch(fonte.slice(fonte.indexOf("function pintarEtapaOAuth"), fonte.indexOf("async function gerarCodigo")), /name="merchant|id="ifood-merchant-id|input[^>]*merchant/i);
});

test("concluir a autorização da loja volta ao painel com o aviso de que o polling segue desligado (nada ativa a loja)", () => {
  const fonte = ler("ifood.js");
  assert.match(fonte, /if \(estado\.wizard\.loja\) \{[\s\S]*?continua desligado até a ativação pela equipe da plataforma[\s\S]*?return sairDoWizard\(\);/);
  assert.doesNotMatch(fonte, /ifoodLiberar|liberarLoja|marcarLojaAtiva/);
});

test("nenhum token é guardado: sem localStorage/sessionStorage/console nas mudanças da tela de lojas", () => {
  const fonte = ler("ifood.js");
  const bloco = fonte.slice(fonte.indexOf("function blocoLojasAdicionais"), fonte.indexOf("export function montarHtmlPainel"));
  assert.doesNotMatch(bloco, /localStorage|sessionStorage|console\./);
});
