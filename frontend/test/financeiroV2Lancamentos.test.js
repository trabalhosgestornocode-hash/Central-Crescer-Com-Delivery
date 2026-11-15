// Tela de receita manual e endereço do painel de ativação (Financeiro v2, migração 0023). Funções puras.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lancamentos } from "../financeiro-v2/telasTesouraria.js";
import { traduzirEndereco } from "../financeiro-v2/plataforma.js";

const dados = { contas: [{ id: "11111111-1111-4111-8111-111111111111", nome: "Unicred", tipo: "BANCARIA" }], dataBase: "2026-11-15" };

test("lançamentos: quem registra vê o formulário de receita com chave de envio própria; sem permissão não há formulário", () => {
  const html = lancamentos(dados, {}, { permissoes: ["financeiro_v2.ver", "financeiro_v2.registrar"] });
  assert.match(html, /\/api\/fv2\/acoes\/vendas\/registrar/);
  assert.match(html, /name="chave" value="[^"]+"/);
  assert.match(html, /Unicred/);
  assert.ok(!/<script|javascript:/i.test(html));
  const sem = lancamentos(dados, {}, { permissoes: ["financeiro_v2.ver"] });
  assert.doesNotMatch(sem, /<form/);
});

test("plataforma: o painel de ativação usa as rotas /corporativo do servidor", () => {
  assert.equal(traduzirEndereco("/api/fv2/corporativo/contexto"), "/api/v1/financeiro-v2/corporativo/contexto");
});
