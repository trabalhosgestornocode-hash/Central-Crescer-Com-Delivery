// Execução 05 — interface do Financeiro v2 (Visão Geral, DRE, composição). Dados 100% SINTÉTICOS do ambiente
// demonstrativo; o motor REAL calcula tudo. Rodar: node --test frontend/test/financeiroV2Interface.test.js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as telas from "../financeiro-v2/telas.js";
import { criarConsultor } from "../financeiro-v2/consulta.js";
import { moeda, percentual } from "../financeiro-v2/formatar.js";
import { criarDemo, UNIDADES } from "../../backend/scripts/fv2/demoInterface.mjs";
import { apurar } from "../../backend/src/modules/financeiro-v2/index.js";

let demo;
const U1 = UNIDADES[0].id;
const U2 = UNIDADES[1].id;
const get = async (caminho, params, perfil = "gestor") => demo.responder(caminho, params, perfil);
before(async () => { demo = await criarDemo(); });
const arquivo = (nome) => readFileSync(fileURLToPath(new URL(`../financeiro-v2/${nome}`, import.meta.url)), "utf8");
/** Visão geral montada a partir do motor puro (para situações que o cenário demo não tem). */
function vgDe(dados, competencia = "2026-09") {
  const ap = apurar({ categorias: [], vendas: [], propostas: [], obrigacoes: [], movimentacoes: [], recebiveis: [], ajustes: [], competencias: [], ...dados }, { competencia, escopo: { organizacaoId: "o", unidadeId: "u" }, apuradoEm: "2026-10-01T00:00:00.000Z" });
  return { competencia, faturamentoBruto: ap.indicadores.FATURAMENTO_BRUTO_PROPRIO, faturamentoLiquidoGerencial: ap.indicadores.FATURAMENTO_LIQUIDO_GERENCIAL, resultadoGerencial: ap.indicadores.RESULTADO_GERENCIAL, cadaCem: ap.cadaCem, dre: ap.dre, impressao: "x" };
}
let n = 0;
const l = (natureza, classificacao, valorCentavos, extra = {}) => ({ id: `l${(n += 1)}`, versao: 1, situacao: "ATIVO", competencia: "2026-09", natureza, classificacao, categoria: "X", valorCentavos, dataOperacao: "2026-09-02", ...extra });

test("1, 2, 3, 4 — bruto é o 1º card, líquido o 2º; canais separados; sem canal NUNCA vira Balcão", async () => {
  const r = await get("/api/fv2/visao-geral", { competencia: "2026-09", unidade: U1 });
  const html = telas.visaoGeral(r.corpo, { unidadeNome: "U" });
  const iBruto = html.indexOf('id="card-faturamento-bruto"');
  const iLiq = html.indexOf('id="card-faturamento-liquido"');
  assert.ok(iBruto > 0 && iBruto < iLiq && iLiq < html.indexOf('class="grade-secundaria"'));
  const canais = Object.fromEntries(r.corpo.faturamentoBruto.porCanal.map((c) => [c.canal, c]));
  for (const nome of ["Balcão", "iFood", "Anota AI", "Sem canal identificado"]) assert.ok(html.includes(nome), nome);
  assert.ok(html.includes(moeda(canais.BALCAO.valorCentavos)));
  assert.ok(html.includes(moeda(canais.NAO_IDENTIFICADO.valorCentavos)));
  assert.match(html, /nunca é atribuída a Balcão/);
  assert.match(html, /não é o valor depositado/);
});

test("5, 6, 7, 8 — desconhecido ≠ zero; zero confirmado; parcial; confirmado", async () => {
  const out = await get("/api/fv2/visao-geral", { competencia: "2026-10", unidade: U1 });
  const htmlOut = telas.visaoGeral(out.corpo);
  assert.equal(out.corpo.faturamentoBruto.valorCentavos, null);
  assert.ok(htmlOut.includes("Valor desconhecido") && htmlOut.includes("Sem evidência suficiente"));
  assert.ok(!htmlOut.slice(0, htmlOut.indexOf('id="card-faturamento-liquido"')).includes("R$ 0,00"));
  const zero = telas.visaoGeral((await get("/api/fv2/visao-geral", { competencia: "2026-09", unidade: U2 })).corpo);
  assert.match(zero, /zero confirmado/);
  assert.match(zero, />Confirmado</);
  const parcial = vgDe({ lancamentos: [l("RECEITA", "RECEITA_OPERACIONAL", 1000, { canal: "BALCAO" })], propostas: [{ id: "p", competencia: "2026-09", estado: "PROPOSTA", operacao: "VENDA", valorCentavos: 500, efeitos: [] }] });
  assert.match(telas.visaoGeral(parcial), />Parcial</);
  assert.match(telas.dre({ ...(await get("/api/fv2/dre", { competencia: "2026-08", unidade: U1 })).corpo }), />Confirmado</);
});

test("9, 13, 14, 16, 27 — DRE e Visão Geral idênticas; subtotais e percentuais do backend; reconciliação por canal", async () => {
  const vg = (await get("/api/fv2/visao-geral", { competencia: "2026-09", unidade: U1 })).corpo;
  const d = (await get("/api/fv2/dre", { competencia: "2026-09", unidade: U1 })).corpo;
  assert.equal(vg.faturamentoBruto.valorCentavos, d.dre.linhas[0].valorCentavos);
  assert.equal(vg.resultadoGerencial.valorCentavos, d.dre.linhas.at(-1).valorCentavos);
  assert.equal(vg.impressao, d.impressao);
  const html = telas.dre(d);
  for (const linha of d.dre.linhas) {
    assert.ok(html.includes(moeda(linha.valorCentavos)), linha.codigo);
    assert.ok(html.includes(percentual(linha.percentualDoBruto)), `${linha.codigo} %`);
  }
  const rec = vg.faturamentoLiquidoGerencial.reconciliacaoComDre;
  assert.equal(rec.reconcilia, true);
  assert.ok(Object.keys(rec.naoAtribuidos).includes("CUSTOS_OPERACIONAIS")); // insumos sem canal não entram em canal algum
  assert.match(telas.visaoGeral(vg), /✓ reconciliado/);
});

test("10, 11, 12, 26 — composição completa; expansões nunca vazias; motoboys; documentos sem link falso nem id interno", async () => {
  const d = (await get("/api/fv2/dre", { competencia: "2026-09", unidade: U1 })).corpo;
  const html = telas.dre(d);
  const ids = [...html.matchAll(/aria-controls="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 5);
  for (const id of ids) assert.match(html, new RegExp(`id="${id}"[^>]*>\\s*(<ul[^>]*>\\s*)?<li`), `expansão ${id} não pode ser vazia`);
  assert.ok(html.includes("Entregadores Próprios (Motoboys)"));
  assert.ok(html.includes("Reconhecido R$ 14,50 · Pago R$ 10,00 · Saldo R$ 4,50"));
  assert.ok(html.includes("Pedidos: DEMO-F1, DEMO-F2") && html.includes("Taxas rejeitadas: DEMO-F3"));
  const comp = await get("/api/fv2/composicao", { competencia: "2026-09", unidade: U1, codigo: "FATURAMENTO_BRUTO_PROPRIO" });
  const painel = telas.composicao(comp.corpo, { unidadeNome: "U" });
  for (const t of ["Fórmula", "Metodologia", "Competência", "Composição"]) assert.ok(painel.includes(t), t);
  assert.match(painel, /registrado, não acessível nesta versão/);
  assert.match(painel, /não há detalhe por pedido/);
  const bruto = JSON.stringify(comp.corpo) + painel;
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(bruto), "nenhum UUID interno exposto");
  assert.ok(!/cofre:|[A-Z]:\\\\|\/Users\//.test(bruto), "nenhum caminho de arquivo exposto");
  assert.ok(!/<a [^>]*href/.test(painel), "nenhum link de documento");
});

test("15, 28 — prejuízo e arredondamento na barra de cada R$ 100", () => {
  const vg = vgDe({ lancamentos: [l("RECEITA", "RECEITA_OPERACIONAL", 3000, { canal: "BALCAO" }), l("DESPESA", "CUSTOS_OPERACIONAIS", 4501), l("DEDUCAO", "DEDUCOES_COMERCIAIS", 1, { canal: "BALCAO" })] });
  assert.equal(vg.cadaCem.grupos.reduce((s, g) => s + g.centesimosDePonto, 0), 10000);
  const barra = telas.barraCadaCem(vg.cadaCem);
  assert.match(barra, /Prejuízo/);
  assert.ok(barra.includes(percentual(vg.cadaCem.grupos.find((g) => g.codigo === "RESULTADO_GERENCIAL").centesimosDePonto)));
  assert.match(barra, /−50,0\d%/);
  assert.match(barra, /acima de 100%/);
  assert.match(barra, /ajuste de arredondamento/);
  assert.match(telas.barraCadaCem({ limitacao: "Faturamento bruto zero: percentuais não se aplicam.", grupos: [] }), /não se aplicam/);
});

test("17, 18, 19 — troca rápida de competência/unidade: só a última resposta vale; antigas são descartadas", async () => {
  const pendentes = [];
  const fetchFalso = (url) => new Promise((resolver) => pendentes.push({ url, resolver }));
  const cons = criarConsultor(fetchFalso);
  const r1 = cons.consultar("/api/fv2/visao-geral?competencia=2026-08&unidade=a");
  const r2 = cons.consultar("/api/fv2/visao-geral?competencia=2026-09&unidade=b");
  pendentes[1].resolver({ ok: true, json: async () => ({ de: "nova" }) });
  pendentes[0].resolver({ ok: true, json: async () => ({ de: "antiga" }) }); // chega DEPOIS
  assert.deepEqual(await r2, { ok: true, dados: { de: "nova" } });
  assert.equal(await r1, null);
  assert.match(readFileSync(fileURLToPath(new URL("../financeiro-v2/app.js", import.meta.url)), "utf8"), /conteudo\.innerHTML = telas\.estado\("carregando"\)/); // sem flash
});

test("20, 21, 22 — acesso negado, sessão ausente e falha de consulta têm estados próprios", async () => {
  const negado = await get("/api/fv2/visao-geral", { competencia: "2026-09", unidade: U1 }, "sem-acesso");
  assert.equal(negado.status, 403);
  const semSessao = await get("/api/fv2/visao-geral", { competencia: "2026-09", unidade: U1 }, "ausente");
  assert.equal(semSessao.status, 401);
  const outraOrg = await get("/api/fv2/visao-geral", { competencia: "2026-09", unidade: "bbbbbbbb-0000-4000-8000-0000000000b1" });
  assert.equal(outraOrg.status, 403);
  assert.match(telas.estado("negado"), /Acesso negado/);
  assert.match(telas.estado("sem-sessao"), /Sessão ausente/);
  const falha = await criarConsultor(async () => { throw new Error("rede"); }).consultar("/x");
  assert.equal(falha.erro, "SEM_CONEXAO");
  assert.match(telas.estado("erro", falha.mensagem), /Não foi possível/);
});

test("23, 24 — layout móvel e navegação por teclado", () => {
  const css = arquivo("fv2.css");
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /minmax\(0, 1fr\)/);
  assert.match(css, /\.tabela-rolavel \{ overflow-x: auto; \}/);
  assert.match(css, /\[hidden\] \{ display: none !important; \}/);
  assert.match(css, /focus-visible/);
  const html = arquivo("index.html");
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.match(html, /class="pular" href="#conteudo"/);
  const app = arquivo("app.js");
  assert.match(app, /e\.key === "Escape"/);
  assert.match(app, /focoAntesDoPainel\?\.focus\(\)/);
  const d = telas.arvore([{ id: "a", nome: "A", valorCentavos: 10, filhos: [{ id: "b", nome: "B", valorCentavos: 10, filhos: [] }] }]);
  assert.match(d, /<button type="button" class="no-alternar" aria-expanded="false" aria-controls=/);
});

test("25 — nenhuma fórmula financeira no frontend (só apresentação)", () => {
  for (const nome of ["telas.js", "app.js", "consulta.js", "formatar.js"]) {
    const codigo = arquivo(nome).replace(/\/\/.*$/gm, "");
    assert.ok(!/\.reduce\(/.test(codigo), `${nome}: soma de valores`);
    assert.ok(!/[Cc]entavos\s*[-+*/]\s*\w|\w\s*[-+*/]\s*\w*[Cc]entavos\b/.test(codigo), `${nome}: aritmética com centavos`);
    assert.ok(!/parseFloat|toFixed/.test(codigo), `${nome}: ponto flutuante`);
  }
});
