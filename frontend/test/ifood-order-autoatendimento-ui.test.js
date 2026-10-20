// Painel iFood — AUTOATENDIMENTO do app Order: "Conectar pedidos iFood" -> autorizar -> a Central valida a loja sozinha.
//
// Estados do card Pedidos com `order.autoatendimento` (vem do servidor só com IFOOD_ORDER_SELF_SERVICE_ENABLED=true):
//   Não conectado | Validando loja | Ação necessária | Conectado — recebendo pedidos.
// Sem `autoatendimento` (flag desligada) a tela é EXATAMENTE a do piloto (ID manual). O merchant inteiro nunca aparece.
// Sem DOM e sem rede: funções puras + o HTML real do painel (montarHtmlPainel) + leitura do código do assistente.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { derivarEstadoOrder } from "../src/ifoodEstado.js";
import { montarHtmlPainel } from "../src/ifood.js";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const ler = (f) => readFileSync(path.join(SRC, f), "utf8");

const AGORA = "2026-10-20T15:00:00.000Z";
const MASCARADO = "f1f1****00f1";
const appsVazio = { analytics: { conectado: false, status: null }, financial: { conectado: false, status: null } };
const auto = (estado, extra = {}) => ({ habilitado: true, estado, motivo: null, mensagem: null, ...extra });
const orderBase = {
  configurado: true, conectado: true, status: "ativa", tokenValido: true, ultimaAutenticacao: AGORA,
  ultimoEvento: null, ultimoPedido: null, erroAtual: null, lojaValidada: false, lojaInformada: null, validacaoFinalHabilitada: false,
};
const status = (order, eventos = { estado: "disabled" }) => ({
  conectado: false, status: "pendente", merchant: null, apps: appsVazio, order, eventosRecebimento: eventos, conectadaEm: null, atencao: { total: 0, apps: [] },
});

test("Não conectado: botão principal \"Conectar pedidos iFood\"", () => {
  const order = { ...orderBase, conectado: false, status: null, autoatendimento: auto("nao_conectado") };
  const o = derivarEstadoOrder(order);
  assert.deepEqual([o.chave, o.rotulo, o.podeConectar, o.rotuloConectar], ["nao_conectado", "Não conectado", true, "Conectar pedidos iFood"]);
  const html = montarHtmlPainel(status(order));
  assert.match(html, /id="ifood-acao-conectar_order"[^>]*>Conectar pedidos iFood</);
  assert.ok(!html.includes("Informar o ID da loja"), "o fluxo automático nunca pede o ID digitado");
});

test("Validando loja: \"Verificar novamente\", loja mascarada, nunca \"Conectado\"", () => {
  const order = { ...orderBase, autoatendimento: auto("validando_loja", { lojaMascarada: MASCARADO, podeVerificar: true }) };
  const o = derivarEstadoOrder(order);
  assert.deepEqual([o.chave, o.rotulo, o.acaoAuto, o.podeConectar], ["validando_loja", "Validando loja", "verificar", false]);
  assert.deepEqual(o.linhas.find((l) => l[0] === "Loja"), ["Loja", MASCARADO, "texto"]);
  const html = montarHtmlPainel(status(order));
  assert.match(html, /data-acao="verificar_pedidos"/);
  assert.ok(!/Conectado — recebendo pedidos/.test(html));
});

test("Ação necessária — várias lojas: um botão por loja com ref opaco e id mascarado", () => {
  const opcoes = [{ ref: "0123456789abcdef", idMascarado: "f1f1****00f1" }, { ref: "fedcba9876543210", idMascarado: "f2f2****00f2" }];
  const order = { ...orderBase, autoatendimento: auto("acao_necessaria", { motivo: "VARIAS_LOJAS", mensagem: "Escolha qual delas é a desta unidade.", opcoes }) };
  const o = derivarEstadoOrder(order);
  assert.deepEqual([o.chave, o.rotulo, o.acaoAuto, o.classe], ["acao_necessaria", "Ação necessária", "escolher", "bad"]);
  const html = montarHtmlPainel(status(order));
  assert.match(html, /data-acao="escolher_loja" data-ref="0123456789abcdef">Usar a loja f1f1\*\*\*\*00f1</);
  assert.match(html, /data-ref="fedcba9876543210"/);
});

test("Ação necessária — reautorizar / loja de outra unidade: \"Reconectar pedidos iFood\" e mensagem do servidor", () => {
  for (const motivo of ["REAUTORIZAR", "SEM_LOJA_NO_TOKEN", "LOJA_DE_OUTRA_UNIDADE", "SEM_AUTORIZACAO"]) {
    const order = { ...orderBase, autoatendimento: auto("acao_necessaria", { motivo, mensagem: `mensagem ${motivo}` }) };
    const o = derivarEstadoOrder(order);
    assert.equal(o.rotulo, "Ação necessária", motivo);
    assert.equal(o.podeConectar, true, motivo);
    assert.equal(o.rotuloConectar, "Reconectar pedidos iFood", motivo);
    assert.equal(o.erro.mensagem, `mensagem ${motivo}`);
  }
  const tentativas = derivarEstadoOrder({ ...orderBase, autoatendimento: auto("acao_necessaria", { motivo: "TENTATIVAS_ESGOTADAS" }) });
  assert.deepEqual([tentativas.acaoAuto, tentativas.podeConectar], ["verificar", false], "limite de verificações: reconectar não resolve");
});

test("credencial reauth_required: Ação necessária com reconectar, mesmo sem motivo no bloco", () => {
  const o = derivarEstadoOrder({ ...orderBase, status: "reauth_required", autoatendimento: auto("conectado") });
  assert.deepEqual([o.chave, o.rotulo, o.podeConectar, o.rotuloConectar], ["reauth", "Ação necessária", true, "Reconectar pedidos iFood"]);
});

test("Conectado: \"Conectado — recebendo pedidos\" só com o recebimento ao vivo; senão só \"Conectado\"", () => {
  const conectado = { ...orderBase, lojaValidada: true, autoatendimento: auto("conectado", { lojaMascarada: MASCARADO }) };
  assert.equal(derivarEstadoOrder({ ...conectado, worker: { ativo: true } }).rotulo, "Conectado — recebendo pedidos");
  const parado = derivarEstadoOrder({ ...conectado, worker: { ativo: false } });
  assert.deepEqual([parado.rotulo, parado.classe, parado.podeConectar, parado.acaoAuto], ["Conectado", "ok", false, null]);
});

test("flag desligada (sem `autoatendimento`): a tela continua a do piloto (ID manual)", () => {
  const o = derivarEstadoOrder(orderBase);
  assert.deepEqual([o.chave, o.acaoLoja], ["aguardando_loja", "informar"]);
  assert.ok(!o.autoatendimento);
  const nulo = derivarEstadoOrder({ ...orderBase, autoatendimento: null });
  assert.equal(nulo.chave, "aguardando_loja");
});

test("o merchant inteiro nunca é renderizado", () => {
  const inteiro = "f1f1f1f1-0000-4000-8000-0000000000f1";
  const order = { ...orderBase, autoatendimento: auto("validando_loja", { lojaMascarada: MASCARADO }) };
  assert.ok(!montarHtmlPainel(status(order)).includes(inteiro));
});

test("assistente e cliques: duplo clique desabilita os botões; OAuth Order com autoatendimento volta ao painel", () => {
  const fonte = ler("ifood.js");
  const corpo = fonte.slice(fonte.indexOf("async function ativarPedidos"), fonte.indexOf("async function ativarPedidos") + 900);
  assert.match(corpo, /b\.disabled = true/);
  assert.match(corpo, /api\.ifoodAtivarPedidos\(ref\)/);
  assert.match(fonte, /appType === "order" && estado\.status\?\.order\?\.autoatendimento\?\.habilitado === true[\s\S]{0,200}sairDoWizard\(\)/);
  assert.match(ler("api.js"), /ifoodAtivarPedidos = \(ref = null\) => postJson\(`\$\{IFOOD\}\/pedidos\/ativacao`/);
});
