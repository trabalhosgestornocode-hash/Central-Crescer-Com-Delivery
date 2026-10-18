// Painel iFood — CONEXÕES SEPARADAS (Financial de homologação + Order de produção): HTML real do painel, sem DOM e sem rede.
// Garante: um cartão por conexão, cada um com a SUA ação; nenhum "desconectar tudo"; a unidade com uma conexão só segue idêntica.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { derivarEstadoIntegracao, acoesDoPainel, montarCartoesConexao, avisoDesconexaoConexao } from "../src/ifoodEstado.js";
import { montarHtmlPainel } from "../src/ifood.js";

const AGORA = "2026-10-17T12:00:00.000Z";
const mTeste = { idMascarado: "7e57****aaaa", nome: "Teste - Subway North", razaoSocial: null };
const mReal = { idMascarado: "ea10****bbbb", nome: "Subway North Shopping", razaoSocial: null };
const appsOk = { analytics: { conectado: true, status: "ativa" }, financial: { conectado: true, status: "ativa" } };
const orderConectado = { configurado: true, conectado: true, status: "ativa", ultimaAutenticacao: AGORA, ultimoEvento: AGORA, ultimoPedido: AGORA, erroAtual: null, merchant: mReal, lojaValidada: true };
const orderSemConexao = { configurado: true, conectado: false, status: null, erroAtual: null, merchant: null, lojaValidada: false };
const cFin = { id: "11111111-1111-4111-8111-1111111111a2", finalidade: "financeiro_homologacao", ambiente: "homologacao", status: "ativa", merchant: mTeste, credenciais: { financial: { status: "ativa" }, analytics: { status: "ativa" } } };
const cPed = { id: "11111111-1111-4111-8111-1111111111a3", finalidade: "pedidos_producao", ambiente: "producao", status: "ativa", merchant: mReal, credenciais: { order: { status: "ativa" } } };

const NORTH_DUAS = { status: "ativa", merchant: mTeste, apps: appsOk, order: orderConectado, eventosRecebimento: { estado: "active", ultimoCicloOkEm: AGORA }, conexoes: [cFin, cPed], atencao: { total: 0 }, conectadaEm: AGORA };
const SACI = { status: "ativa", merchant: mReal, apps: appsOk, order: orderConectado, eventosRecebimento: { estado: "active", ultimoCicloOkEm: AGORA }, atencao: { total: 0 }, conectadaEm: AGORA };

test("duas conexões: dois cartões, cada um com identidade, ambiente, loja e credenciais PRÓPRIAS", () => {
  const cartoes = montarCartoesConexao(NORTH_DUAS);
  assert.equal(cartoes.length, 2);
  const [fin, ped] = cartoes;
  assert.equal(fin.titulo, "Financial — Homologação"); assert.equal(fin.selo, "Ambiente de homologação"); assert.match(fin.merchant, /Teste - Subway North · 7e57\*\*\*\*aaaa/);
  assert.deepEqual(fin.credenciais.map((k) => k.app).sort(), ["Analytics", "Financial"]);
  assert.equal(ped.titulo, "Order/Events — Produção"); assert.equal(ped.selo, "Produção"); assert.match(ped.merchant, /Subway North Shopping · ea10\*\*\*\*bbbb/);
  assert.deepEqual(ped.credenciais.map((k) => k.app), ["Pedidos (Order)"]);
  assert.notEqual(fin.id, ped.id);
});

test("HTML: seção 'Conexões desta unidade' com um botão de desconectar POR conexão, nomeando qual; nenhum botão genérico 'Desconectar'", () => {
  const html = montarHtmlPainel(NORTH_DUAS, { podeGerenciar: true });
  assert.match(html, /id="ifood-conexoes"/);
  assert.match(html, new RegExp(`data-desconectar-conexao="${cFin.id}"[^>]*>Desconectar esta conexão \\(Financial — Homologação\\)`));
  assert.match(html, new RegExp(`data-desconectar-conexao="${cPed.id}"[^>]*>Desconectar esta conexão \\(Order/Events — Produção\\)`));
  assert.equal((html.match(/data-desconectar-conexao=/g) ?? []).length, 2);
  assert.ok(!html.includes('data-acao="desconectar"'), "sem 'desconectar tudo'");
  assert.match(html, /Loja do Financial \(homologação\)/, "o bloco da loja de teste diz de quem é");
  assert.match(html, /Cada conexão é independente/);
});

test("ações do painel: com conexões separadas o 'Desconectar' genérico NÃO existe (qualquer estado)", () => {
  for (const s of [NORTH_DUAS, { ...NORTH_DUAS, status: "reauth_required" }, { ...NORTH_DUAS, merchant: null }, { ...NORTH_DUAS, conexoes: [cFin], order: orderSemConexao }]) {
    const e = derivarEstadoIntegracao(s);
    assert.equal(e.podeDesconectar, false);
    assert.ok(!acoesDoPainel(e).some((a) => a.id === "desconectar"));
  }
});

test("sem permissão de gerenciar: os cartões aparecem, sem botão de desconectar", () => {
  const html = montarHtmlPainel(NORTH_DUAS, { podeGerenciar: false });
  assert.match(html, /id="ifood-conexoes"/);
  assert.equal((html.match(/data-desconectar-conexao=/g) ?? []).length, 0);
});

test("North só com o Financial de homologação: um cartão; o Order aparece como não conectado, com a ação de conectar pedidos (sem a loja de teste)", () => {
  const s = { ...NORTH_DUAS, conexoes: [cFin], order: orderSemConexao, eventosRecebimento: { estado: "active" } };
  const html = montarHtmlPainel(s, { podeGerenciar: true });
  assert.equal((html.match(/data-desconectar-conexao=/g) ?? []).length, 1);
  assert.match(html, /data-acao="conectar_order"/);
  assert.ok(!html.includes(mReal.idMascarado));
});

test("confirmação da desconexão: nomeia a conexão e diz que as outras NÃO são afetadas", () => {
  const [fin, ped] = montarCartoesConexao(NORTH_DUAS);
  assert.match(fin.confirmacaoDesconectar, /SOMENTE a conexão "Financial — Homologação"/);
  assert.match(fin.confirmacaoDesconectar, /As outras conexões desta unidade NÃO serão afetadas/);
  assert.match(ped.confirmacaoDesconectar, /SOMENTE a conexão "Order\/Events — Produção"/);
  assert.match(avisoDesconexaoConexao({ titulo: "X", escopo: "y", merchant: "z", outras: false }), /SOMENTE a conexão "X"/);
});

test("unidade com UMA conexão (legado, como a Saci): a tela é a de sempre — sem 'Conexões desta unidade' e com o 'Desconectar' de antes", () => {
  assert.deepEqual(montarCartoesConexao(SACI), []);
  const html = montarHtmlPainel(SACI, { podeGerenciar: true });
  assert.ok(!html.includes("ifood-conexoes"));
  assert.ok(!html.includes("data-desconectar-conexao"));
  assert.match(html, /data-acao="desconectar"/);
  assert.match(html, /Loja iFood vinculada/);
  assert.equal(derivarEstadoIntegracao(SACI).podeDesconectar, true);
});

test("a chamada da API leva o conexaoId e a tela só chama com o id de um cartão do status", () => {
  const api = readFileSync(new URL("../src/api.js", import.meta.url), "utf8");
  assert.match(api, /export const ifoodDesconectar = \(conexaoId = null\) => delJson\(`\$\{IFOOD\}\/\$\{conexaoId \? `\?conexaoId=\$\{encodeURIComponent\(conexaoId\)\}` : ""\}`\);/);
  const tela = readFileSync(new URL("../src/ifood.js", import.meta.url), "utf8");
  assert.match(tela, /const cartao = montarCartoesConexao\(estado\.status\)\.find\(\(c\) => c\.id === conexaoId\);\s+if \(!cartao\) return;/);
  assert.match(tela, /api\.ifoodDesconectar\(conexaoId\)/);
});

test("nenhum dado sensível nos cartões (merchant sempre mascarado, sem token)", () => {
  const html = montarHtmlPainel(NORTH_DUAS, { podeGerenciar: true });
  assert.doesNotMatch(html, /clientSecret|accessToken|refreshToken|verifier|7e570000-0000|ea100000-0000/i);
});
