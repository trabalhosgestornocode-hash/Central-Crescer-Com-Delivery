// Condições comerciais — modelo puro. Rodar: node --test frontend/test/condicoesComerciaisModelo.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { percParaFracao, fracaoParaPerc, condicaoParaForm, formParaPayload, situacaoCondicao, resumoCondicao, rotuloCanal } from "../src/condicoesComerciaisModelo.js";

test("percentual: vírgula, %, vazio = não configurado, faixa 0–<100", () => {
  assert.deepEqual(percParaFracao("23,5"), { valor: 0.235 });
  assert.deepEqual(percParaFracao(" 27% "), { valor: 0.27 });
  assert.deepEqual(percParaFracao(""), { valor: null });
  assert.deepEqual(percParaFracao("0"), { valor: 0 });
  assert.ok(percParaFracao("100").erro); assert.ok(percParaFracao("-1").erro); assert.ok(percParaFracao("abc").erro);
  assert.equal(percParaFracao("1,15").valor, 0.0115); // sem ruído de ponto flutuante
});
test("fração -> texto da tela e ida-e-volta", () => {
  assert.equal(fracaoParaPerc(0.235), "23,5"); assert.equal(fracaoParaPerc(null), ""); assert.equal(fracaoParaPerc(0), "0");
  for (const v of [0.27, 0.015, 0.0115, 0]) assert.equal(percParaFracao(fracaoParaPerc(v)).valor, v);
});
test("formulário completo vira o corpo da API", () => {
  const r = formParaPayload("ifood", { comissao: "23", taxas: "1,5", promocao: "5", tributos: "4", entrega_responsavel: "loja", entrega_custo: "6,5", outras: [{ nome: " Embalagem ", pct: "1" }, { nome: "", pct: "" }], observacao: " obs " });
  assert.deepEqual(r.payload, { canal: "ifood", comissao: 0.23, taxas: 0.015, promocao: 0.05, tributos: 0.04, entrega_responsavel: "loja", entrega_custo: 6.5, outras_deducoes: [{ nome: "Embalagem", pct: 0.01 }], observacao: "obs" });
});
test("comissão é obrigatória (0 explícito vale); opcionais vazios viram null, não 0", () => {
  assert.ok(formParaPayload("ifood", { comissao: "" , outras: [] }).erros.comissao);
  const p = formParaPayload("balcao", { comissao: "0", taxas: "", promocao: "", tributos: "", entrega_responsavel: "", entrega_custo: "", outras: [] }).payload;
  assert.equal(p.comissao, 0); assert.equal(p.taxas, null); assert.equal(p.promocao, null); assert.equal(p.entrega_responsavel, null); assert.equal(p.entrega_custo, null);
});
test("erros por campo: percentual inválido, entrega com responsável errado, dedução sem nome", () => {
  const e = formParaPayload("ifood", { comissao: "20", taxas: "150", entrega_responsavel: "plataforma", entrega_custo: "5", outras: [{ nome: "", pct: "2" }, { nome: "X", pct: "" }] }).erros;
  assert.ok(e.taxas); assert.ok(e.entrega_custo); assert.ok(e.outras_0); assert.ok(e.outras_1);
});
test("custo de entrega é descartado se a loja não é a responsável (sem lixo salvo)", () => {
  const p = formParaPayload("ifood", { comissao: "20", entrega_responsavel: "plataforma", entrega_custo: "0", outras: [] }).payload;
  assert.equal(p.entrega_custo, null);
});
test("condicaoParaForm preenche a edição a partir da API e é o inverso de formParaPayload", () => {
  const api = { canal: "ifood", comissao: 0.23, taxas: 0.015, promocao: 0.05, tributos: null, entrega_responsavel: "loja", entrega_custo: 6.5, outras_deducoes: [{ nome: "Emb", pct: 0.01 }], observacao: "x" };
  const f = condicaoParaForm(api);
  assert.equal(f.comissao, "23"); assert.equal(f.tributos, ""); assert.equal(f.entrega_custo, "6,5");
  const { payload } = formParaPayload("ifood", f);
  assert.deepEqual(payload, { ...api, tributos: null });
});
test("situação: ausente / parcial (faltam taxas ou promoções) / configurado", () => {
  assert.equal(situacaoCondicao(null).chave, "ausente");
  assert.equal(situacaoCondicao({ comissao: 0.2, taxas: null, promocao: 0 }).chave, "parcial");
  assert.match(situacaoCondicao({ comissao: 0.2, taxas: null, promocao: null }).ajuda, /taxas e promoções/);
  assert.equal(situacaoCondicao({ comissao: 0.2, taxas: 0, promocao: 0 }).chave, "completo");
});
test("resumo legível e rótulos de canal", () => {
  assert.equal(resumoCondicao({ comissao: 0.23, taxas: 0.015, promocao: null, entrega_responsavel: "loja", entrega_custo: 6.5, outras_deducoes: [{ nome: "Emb", pct: 0.01 }] }),
    "comissão 23% · taxas 1,5% · entrega pela loja · entrega R$ 6,5/pedido · Emb 1%");
  assert.equal(resumoCondicao(null), "—"); assert.equal(rotuloCanal("ifood"), "iFood"); assert.equal(rotuloCanal("zzz"), "zzz");
});
