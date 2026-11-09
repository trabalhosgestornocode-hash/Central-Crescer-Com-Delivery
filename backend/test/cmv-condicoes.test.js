// Condições comerciais por EMPRESA: só o que a organização configurou, nunca padrão embutido; validação estrita.
import test from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);
const { moldarCondicoes, validarCondicao, deducoesConfiguradas, CANAIS } = await import("../src/modules/cmv/cmv.condicoes.js");
const { escolherDeducoes } = await import("../src/modules/dashboard-executivo/dashboardExecutivo.deducoes.js");

test("moldarCondicoes: só canais ativos e válidos, ordenados; informa os AUSENTES", () => {
  const r = moldarCondicoes([
    { canal: "uber", comissao_pct: "0.1500", ativo: true },
    { canal: "ifood", comissao_pct: "0.2700", ativo: true, taxas_pct: "0.0150", promocao_pct: "0.0500", entrega_responsavel: "loja", entrega_custo: "6.50", outras_deducoes: [{ nome: "X", pct: 0.01 }] },
    { canal: "app", comissao_pct: "0.0500", ativo: false },
    { canal: "outro", comissao_pct: "1.5000", ativo: true },
  ]);
  assert.equal(r.configurado, true);
  assert.deepEqual(r.canais.map((c) => c.canal), ["ifood", "uber"]);
  const ifood = r.canais[0];
  assert.equal(ifood.comissao, 0.27); assert.equal(ifood.taxas, 0.015); assert.equal(ifood.promocao, 0.05); assert.equal(ifood.tributos, null);
  assert.equal(ifood.entrega_custo, 6.5); assert.equal(ifood.entrega_responsavel, "loja");
  assert.deepEqual(r.ausentes.sort(), ["app", "balcao", "outro"]);
});
test("moldarCondicoes: campos NULL ficam null (não configurado), nunca viram 0", () => {
  const c = moldarCondicoes([{ canal: "ifood", comissao_pct: 0.2, ativo: true }]).canais[0];
  assert.equal(c.taxas, null); assert.equal(c.promocao, null); assert.equal(c.tributos, null); assert.equal(c.entrega_custo, null);
});
test("moldarCondicoes: empresa sem configuração => configurado=false, tudo ausente (sem padrão)", () => {
  assert.deepEqual(moldarCondicoes([]), { configurado: false, canais: [], ausentes: CANAIS });
  assert.equal(moldarCondicoes(null).configurado, false);
});
test("validarCondicao: aceita configuração completa e normaliza", () => {
  const r = validarCondicao({ canal: "ifood", comissao: 0.23, taxas: "0.015", promocao: 0.05, tributos: 0.04, entrega_responsavel: "loja", entrega_custo: 6.5, outras_deducoes: [{ nome: " Embalagem ", pct: 0.01 }], observacao: " ok " });
  assert.deepEqual(r, { canal: "ifood", comissao_pct: 0.23, taxas_pct: 0.015, promocao_pct: 0.05, tributos_pct: 0.04, entrega_responsavel: "loja", entrega_custo: 6.5, outras_deducoes: [{ nome: "Embalagem", pct: 0.01 }], observacao: "ok" });
});
test("validarCondicao: comissão é OBRIGATÓRIA (0 explícito vale; vazio não) e opcionais ausentes ficam null", () => {
  assert.equal(validarCondicao({ canal: "balcao", comissao: 0 }).comissao_pct, 0);
  assert.throws(() => validarCondicao({ canal: "ifood" }), /comissão/i);
  assert.throws(() => validarCondicao({ canal: "ifood", comissao: "" }), /comissão/i);
  const r = validarCondicao({ canal: "ifood", comissao: 0.2 });
  assert.equal(r.taxas_pct, null); assert.equal(r.promocao_pct, null); assert.equal(r.entrega_custo, null);
});
test("validarCondicao: recusa canal inválido, percentuais fora de 0–<100%, entrega inconsistente e deduções malformadas", () => {
  assert.throws(() => validarCondicao({ canal: "ifud", comissao: 0.1 }), /Canal inválido/);
  assert.throws(() => validarCondicao({ canal: "ifood", comissao: 1 }), /comissão/i);
  assert.throws(() => validarCondicao({ canal: "ifood", comissao: -0.1 }), /comissão/i);
  assert.throws(() => validarCondicao({ canal: "ifood", comissao: 0.1, taxas: 1.2 }), /Taxas/);
  assert.throws(() => validarCondicao({ canal: "ifood", comissao: 0.1, entrega_responsavel: "ninguem" }), /entrega/i);
  assert.throws(() => validarCondicao({ canal: "ifood", comissao: 0.1, entrega_responsavel: "plataforma", entrega_custo: 5 }), /loja/);
  assert.throws(() => validarCondicao({ canal: "ifood", comissao: 0.1, entrega_custo: -2 }), /entrega/i);
  assert.throws(() => validarCondicao({ canal: "ifood", comissao: 0.1, outras_deducoes: [{ nome: "", pct: 0.1 }] }), /nome/);
  assert.throws(() => validarCondicao({ canal: "ifood", comissao: 0.1, outras_deducoes: [{ nome: "a", pct: 2 }] }), /dedução/);
  assert.throws(() => validarCondicao({ canal: "ifood", comissao: 0.1, outras_deducoes: Array.from({ length: 11 }, (_, i) => ({ nome: `d${i}`, pct: 0.01 })) }), /No máximo/);
  assert.throws(() => validarCondicao(null), /Canal inválido/);
});
test("deducoesConfiguradas: exige comissão E taxas E promoções explícitas; nunca assume", () => {
  assert.deepEqual(deducoesConfiguradas(null), { taxasComissoesPct: null, servicosPromocoesPct: null, motivo: "canal_sem_condicoes" });
  assert.equal(deducoesConfiguradas({ comissao: 0.2, taxas: null, promocao: 0.05 }).motivo, "informe_taxas_e_promocoes");
  assert.equal(deducoesConfiguradas({ comissao: 0.2, taxas: 0, promocao: null }).motivo, "informe_taxas_e_promocoes");
  const ok = deducoesConfiguradas({ comissao: 0.2, taxas: 0, promocao: 0 }); // 0 explícito vale
  assert.equal(ok.motivo, null); assert.ok(Math.abs(ok.taxasComissoesPct - 20) < 1e-9); assert.equal(ok.servicosPromocoesPct, 0);
});
test("escolherDeducoes: APURADAS mandam; configuradas só na falta delas; senão indisponível com motivo", () => {
  const cfg = { taxasComissoesPct: 24, servicosPromocoesPct: 5, motivo: null };
  assert.deepEqual(escolherDeducoes({ taxas_comissoes: 18, servicos_promocoes: 3 }, cfg), { origem: "apuradas", motivo: null, taxasComissoesPct: 18, servicosPromocoesPct: 3 });
  assert.equal(escolherDeducoes({ taxas_comissoes: null, servicos_promocoes: null }, cfg).origem, "configuradas");
  assert.equal(escolherDeducoes({ taxas_comissoes: 18, servicos_promocoes: null }, cfg).origem, "configuradas"); // nunca mistura fontes
  const sem = escolherDeducoes({ taxas_comissoes: null, servicos_promocoes: null }, { taxasComissoesPct: null, servicosPromocoesPct: null, motivo: "canal_sem_condicoes" });
  assert.equal(sem.origem, "indisponivel"); assert.equal(sem.motivo, "canal_sem_condicoes");
});
test("LEGADO Subway: sem cfg (produto não escolhido) o resultado é o de sempre — apuradas, ou parcial como antes", () => {
  assert.equal(escolherDeducoes({ taxas_comissoes: 10, servicos_promocoes: 2 }, undefined).origem, "apuradas");
  const parcial = escolherDeducoes({ taxas_comissoes: 10, servicos_promocoes: null }, undefined);
  assert.equal(parcial.origem, "indisponivel"); assert.equal(parcial.taxasComissoesPct, 10); assert.equal(parcial.servicosPromocoesPct, null);
});
