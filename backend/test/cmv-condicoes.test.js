// Condições comerciais por EMPRESA (Simulador): só o que a organização configurou, nunca padrão embutido.
import test from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "x".repeat(40);
process.env.SUPABASE_ANON_KEY ??= "y".repeat(40);
const { moldarCondicoes } = await import("../src/modules/cmv/cmv.condicoes.js");

test("moldarCondicoes: devolve só canais ativos, válidos e ordenados", () => {
  const r = moldarCondicoes([
    { canal: "uber", comissao_pct: "0.1500", ativo: true },
    { canal: "ifood", comissao_pct: "0.2700", ativo: true },
    { canal: "app", comissao_pct: "0.0500", ativo: false },
    { canal: "outro", comissao_pct: "1.5000", ativo: true }, // inválido (>= 100%)
  ]);
  assert.equal(r.configurado, true);
  assert.deepEqual(r.canais, [{ canal: "ifood", comissao: 0.27 }, { canal: "uber", comissao: 0.15 }]);
});
test("moldarCondicoes: empresa sem configuração => configurado=false e lista vazia (sem padrão)", () => {
  assert.deepEqual(moldarCondicoes([]), { configurado: false, canais: [] });
  assert.deepEqual(moldarCondicoes(null), { configurado: false, canais: [] });
});
