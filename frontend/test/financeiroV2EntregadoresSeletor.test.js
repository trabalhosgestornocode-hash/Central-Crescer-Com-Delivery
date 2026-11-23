// 23/11/2026 — Seletor de semanas de Entregadores Próprios: texto COMPLETO (período + situação), também no title da opção e na
// linha "Semana escolhida". Dados sintéticos gerados pelo núcleo real (memória). Rodar: node --test frontend/test/financeiroV2EntregadoresSeletor.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as ent from "../financeiro-v2/telasEntregadores.js";
import { criarCofreMemoria, criarNucleoFinanceiro, criarRepositorioMemoria } from "../../backend/src/modules/financeiro-v2/index.js";
import { somarDias } from "../../backend/src/modules/financeiro-v2/dominio/tempo.js";
import { ESCOPOS_PADRAO, ORG_A, TODAS, UNI_A, ctx } from "../../backend/test/financeiro-v2/helpers/cenario.js";

async function nucleo() {
  const fonte = { apurar: async (p) => ({ disponivel: true, dias: Array.from({ length: 7 }, (_, i) => ({ data: somarDias(p.inicio, i), fonte: "foody", provisorio: false, aberto: false, triagem: 0 })),
    entregas: [{ id: `pedido:${p.inicio}`, tipo: "ENTREGA", entregadorChave: "ana", entregadorNome: "Ana Sintética", data: p.inicio, numeroPedido: "1", situacao: "Entregue", valorCentavos: 700, elegivel: true, emRevisao: false }] }) };
  const cofre = criarCofreMemoria();
  const n = criarNucleoFinanceiro({ repositorio: criarRepositorioMemoria(), escoposAutorizados: ESCOPOS_PADRAO, relogio: () => new Date("2026-11-23T12:00:00.000Z"), cofre, entregadores: { fonte, inicioDaOperacao: "2026-11-02", cofreDeNotas: cofre } });
  const c = ctx(ORG_A, UNI_A, TODAS);
  await n.implantarPlanoDeContas(c, { modelo: "ACAITERIA" });
  for (const s of ["2026-11-02", "2026-11-09"]) await n.fecharSemanaDeEntregadores(c, { inicio: s });
  return { n, c };
}
const opcoes = (h) => [...h.matchAll(/<option value="(2026-[^"]+)" title="([^"]+)"( selected)?>([^<]+)<\/option>/g)].map((m) => ({ v: m[1], title: m[2], sel: Boolean(m[3]), texto: m[4] }));
const tela = (r) => ent.entregadoresProprios(r, { aba: "resumo" }, { permissoes: ["financeiro_v2.ver", "financeiro_v2.registrar"] });

test("seletor: 16–22/11 'Aguardando fechamento' antes do fechamento; texto completo no title e na linha da semana escolhida", async () => {
  const { n, c } = await nucleo();
  const h = tela(await n.consultarEntregadoresProprios(c, { selecao: "ULTIMA_FECHADA" }));
  const o = opcoes(h);
  assert.deepEqual(o.map((x) => x.texto), ["23 a 29/11/2026 — Em andamento", "16 a 22/11/2026 — Aguardando fechamento", "09 a 15/11/2026 — Fechada", "02 a 08/11/2026 — Fechada"]);
  assert.ok(o.every((x) => x.title === x.texto), "title com o texto completo");
  assert.equal(o.find((x) => x.sel).v, "2026-11-09", "abre na última semana oficialmente fechada");
  assert.match(h, /Semana escolhida: <strong>09 a 15\/11\/2026 — Fechada<\/strong>/);
  assert.match(h, /class="ent-filtro-semana"/);
});

test("seletor: depois do fechamento OFICIAL, 16–22/11 vira 'Fechada' sem sumir; escolha do usuário preservada", async () => {
  const { n, c } = await nucleo();
  await n.fecharSemanaDeEntregadores(c, { inicio: "2026-11-16" });
  const o = opcoes(tela(await n.consultarEntregadoresProprios(c, { selecao: "ULTIMA_FECHADA" })));
  assert.equal(o.find((x) => x.v === "2026-11-16")?.texto, "16 a 22/11/2026 — Fechada");
  assert.equal(o.find((x) => x.sel).v, "2026-11-16");
  const escolhida = opcoes(tela(await n.consultarEntregadoresProprios(c, { semana: "2026-11-02" })));
  assert.equal(escolhida.find((x) => x.sel).v, "2026-11-02", "semana escolhida pelo usuário continua selecionada");
});

test("seletor: CSS dá largura ao campo e mostra a linha completa no desktop e no celular", () => {
  const css = readFileSync(new URL("../financeiro-v2/fv2.css", import.meta.url), "utf8");
  assert.match(css, /\.filtros-locais \.ent-filtro-semana \{ grid-column: span 2; \}/);
  assert.match(css, /\.ent-semana-escolhida \{ grid-column: 1 \/ -1;[^}]*overflow-wrap: anywhere/);
  assert.match(css, /\.filtros-locais \.caixa-marcar, \.filtros-locais \.ent-filtro-semana \{ grid-column: 1 \/ -1; \}/);
});
