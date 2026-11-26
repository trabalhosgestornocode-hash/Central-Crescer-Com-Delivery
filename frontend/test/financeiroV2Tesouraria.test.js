// Execução 06A — interface de tesouraria do Financeiro v2 (contas a pagar/receber, caixa e bancos, calendário, fluxo).
// Dados 100% SINTÉTICOS do ambiente demonstrativo; o motor REAL calcula tudo. Data-base da demonstração: 12/11/2026.
// Rodar: node --test frontend/test/financeiroV2Tesouraria.test.js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as telas from "../financeiro-v2/telas.js";
import * as tes from "../financeiro-v2/telasTesouraria.js";
import { criarConsultor } from "../financeiro-v2/consulta.js";
import { descricaoLegivel, moeda } from "../financeiro-v2/formatar.js";
import { criarDemo, UNIDADES } from "../../backend/scripts/fv2/demoInterface.mjs";

let demo;
const U1 = UNIDADES[0].id;
const U2 = UNIDADES[1].id;
const get = async (caminho, params, perfil = "gestor") => demo.responder(caminho, { unidade: U1, ...params }, perfil);
const ok = async (caminho, params, perfil) => { const r = await get(caminho, params, perfil); assert.equal(r.status, 200, JSON.stringify(r.corpo)); return r.corpo; };
const arquivo = (nome) => readFileSync(fileURLToPath(new URL(`../financeiro-v2/${nome}`, import.meta.url)), "utf8");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
before(async () => { demo = await criarDemo(); });

test("contas a pagar: situações, vencida não vira paga, filtros, paginação e detalhe até o documento", async () => {
  const r = await ok("/api/fv2/contas-a-pagar", {});
  const html = tes.contasAPagar(r, {});
  for (const s of ["Vencido", "Pago", "Em aberto"]) assert.ok(html.includes(`>${s}<`), s);
  assert.ok(r.itens.filter((t) => t.situacao === "VENCIDO").every((t) => t.saldoCentavos > 0 && t.vencimento < r.dataBase));
  assert.equal(r.totais.vencidoCentavos, r.itens.filter((t) => t.vencido).reduce((s, t) => s + t.saldoCentavos, 0));
  assert.ok(html.includes(moeda(r.totais.saldoCentavos)));
  assert.ok(html.includes("parcela 2/3"));
  // Filtros por fornecedor (referência opaca volta a ser id no tratador) e situação.
  const imob = r.filtros.fornecedores.find((f) => f.nome.startsWith("Imobiliária"));
  const soImob = await ok("/api/fv2/contas-a-pagar", { contraparteId: imob.id });
  assert.ok(soImob.itens.length === 3 && soImob.itens.every((t) => t.fornecedor.nome === imob.nome));
  assert.equal((await ok("/api/fv2/contas-a-pagar", { situacao: "VENCIDO" })).itens.length, r.totais.porSituacao.VENCIDO.quantidade);
  const p2 = await ok("/api/fv2/contas-a-pagar", { pagina: "2", tamanho: "5" });
  assert.equal(p2.paginacao.pagina, 2);
  assert.match(tes.contasAPagar(p2, {}), /Página 2 de 3/);
  // Detalhe: parcelas, pagamentos, documento (sem link), histórico.
  const freezer = r.itens.find((t) => t.descricao === "Freezer" && t.parcela.numero === 2);
  const det = await ok("/api/fv2/conta-a-pagar", { id: freezer.id });
  const dh = tes.detalheAPagar(det);
  assert.equal(det.parcelas.length, 3);
  assert.match(dh, /um<\/strong> lançamento/);
  assert.match(dh, /patrimonial: fora da DRE/);
  assert.match(dh, /Nota fiscal — Nota do freezer/);
  assert.match(dh, /registrado, não acessível nesta versão/);
  assert.ok(!/<a\s/i.test(dh) && !/href=/i.test(dh), "documento sem link fictício");
  const semDoc = tes.detalheAPagar(await ok("/api/fv2/conta-a-pagar", { id: r.itens.find((t) => t.pendencias.includes("SEM_DOCUMENTO")).id }));
  assert.match(semDoc, /Nenhum documento vinculado/);
  assert.equal((await get("/api/fv2/conta-a-pagar", { id: "ref-inexistente" })).status, 404);
});

test("contas a receber: operadora não é conta; sem previsão confiável; repasse documentado; composição", async () => {
  const r = await ok("/api/fv2/contas-a-receber", {});
  const html = tes.contasAReceber(r, {});
  assert.match(html, /não contas bancárias/);
  const stone = r.itens.find((t) => t.devedor.nome === "STONE");
  assert.deepEqual([stone.situacao, stone.vencimentoPrevisto, stone.recebidoCentavos > 0], ["SEM_PREVISAO_CONFIAVEL", null, true]);
  assert.match(html, /sem data/);
  const vr = r.itens.find((t) => t.tipo === "REPASSE");
  assert.equal(vr.situacao, "A_RECEBER");
  assert.equal(r.totais.comPrevisaoCentavos, vr.saldoCentavos);
  const det = tes.detalheAReceber(await ok("/api/fv2/conta-a-receber", { id: vr.id }));
  assert.match(det, /Valor original/);
  assert.match(det, /Taxas de processamento de pagamentos \(retenção\)/);
  assert.match(det, /Demonstrativo de repasse/);
  const ifood = await ok("/api/fv2/conta-a-receber", { id: r.itens.find((t) => t.devedor.nome === "IFOOD").id });
  assert.equal(ifood.titulo.situacao, "RECEBIDO");
  assert.ok(ifood.titulo.composicao.ajustes.length >= 4, "taxas do iFood aparecem na composição do recebível");
});

test("caixa e bancos: saldo informado + movimentos; transferência se anula; sem vínculo pendente; sessões de caixa", async () => {
  const r = await ok("/api/fv2/caixa-e-bancos", { inicio: "2026-11-01", fim: "2026-11-12" });
  const html = tes.caixaEBancos(r, {});
  const caixa = r.contas.find((c) => c.tipo === "CAIXA_FISICO");
  const banco = r.contas.find((c) => c.tipo === "BANCARIA");
  assert.equal(r.consolidado.saldoFinalCentavos, caixa.saldoFinalCentavos + banco.saldoFinalCentavos);
  assert.equal(r.consolidado.saldoInicialCentavos + r.consolidado.entradasCentavos - r.consolidado.saidasCentavos, r.consolidado.saldoFinalCentavos, "transferências se anulam no consolidado");
  assert.ok(r.consolidado.transferenciasInternasCentavos > 0);
  assert.match(html, /Saldo bancário não é faturamento/);
  assert.match(html, /Transferência para Unicred/);
  assert.match(html, /Original: PIX RECEBIDO 99887 SINT/);
  assert.match(html, /sem vínculo/);
  assert.equal(caixa.sessoesDeCaixa.length, 2);
  const fechada = caixa.sessoesDeCaixa.find((s) => s.situacao === "FECHADA");
  assert.deepEqual([fechada.teoricoCentavos, fechada.contadoCentavos, fechada.diferencaCentavos], [29500, 29000, -500]);
  assert.equal(caixa.diferencasDeCaixaNaoAjustadasCentavos, -500);
  assert.match(html, /não é ajustado automaticamente/);
  assert.match(html, /exigem a permissão "registrar"/);
  // Sem escrita na demonstração: o tratador só conhece consultas.
  assert.equal((await get("/api/fv2/fechar-caixa", {})).status, 404);
});

test("19 — calendário navegável: dias clicáveis por toque/teclado com títulos do dia", async () => {
  const cal = await ok("/api/fv2/calendario", { mes: "2026-11" });
  const html = tes.calendario(cal, { selecionado: "2026-11-10" });
  assert.equal((html.match(/data-dia="/g) ?? []).length, 30);
  assert.match(html, /class="cal-dia cal-dia--hoje/);
  assert.match(html, /aria-label="10\/11\/2026: 0 vencendo, 1 vencida\(s\)/);
  assert.match(html, /data-mes="-1"/);
  const dia = tes.diaDoCalendario(cal.dias.find((d) => d.data === "2026-11-10"));
  assert.match(dia, /Aluguel da loja/);
  assert.match(dia, /data-detalhe="pagar:ref-/);
  const dez = await ok("/api/fv2/calendario", { mes: "2026-12" });
  assert.equal(dez.dias.find((d) => d.data === "2026-12-10").recorrentesPrevistas.quantidade, 1, "aluguel de dezembro só como previsão");
  assert.match(tes.diaDoCalendario(dez.dias.find((d) => d.data === "2026-12-10")), /Recorrências previstas \(estimadas\)/);
});

test("16–18 — fluxo de caixa: realizado separado do previsto, projeção parcial explicada", async () => {
  const fl = await ok("/api/fv2/fluxo-de-caixa", { inicio: "2026-11-01", fim: "2026-12-12", granularidade: "SEMANA" });
  const html = tes.fluxoDeCaixa(fl, { preset: "personalizado" });
  assert.equal(fl.saldoAtualCentavos + fl.previsto.entradasCentavos - fl.previsto.saidasCentavos, fl.projecao.saldoProjetadoCentavos);
  assert.match(html, /projeção parcial/);
  assert.match(html, /sem data documentada: ficaram fora da projeção/);
  assert.match(html, /Fora da projeção: sem previsão confiável/);
  assert.match(html, /Conta vencida em aberto/);
  assert.match(html, /Recorrência prevista \(estimada\)/);
  assert.ok(fl.serie.filter((s) => s.tipo === "PREVISTO").every((s) => s.saldoRealizadoCentavos === null), "o futuro só tem saldo projetado");
  await assert.doesNotReject(ok("/api/fv2/fluxo-de-caixa", { inicio: "2026-11-01", fim: "2026-11-30", granularidade: "DIA" }));
  assert.equal((await get("/api/fv2/fluxo-de-caixa", { inicio: "2026-11-30", fim: "2026-11-01" })).status, 400);
});

test("28, 30 — Visão Geral usa as consultas centrais; desconhecido não aparece como zero", async () => {
  const vg = await ok("/api/fv2/visao-geral", { competencia: "2026-11" });
  const cb = await ok("/api/fv2/caixa-e-bancos", { inicio: "2026-11-12", fim: "2026-11-12" });
  const ap = await ok("/api/fv2/contas-a-pagar", {});
  const ar = await ok("/api/fv2/contas-a-receber", {});
  assert.equal(vg.financeiro.saldoBancario.valorCentavos, cb.consolidado.saldoBancarioCentavos);
  assert.equal(vg.financeiro.saldoCaixaFisico.valorCentavos, cb.consolidado.saldoCaixaFisicoCentavos);
  assert.equal(vg.financeiro.contasAPagar.saldoCentavos, ap.totais.saldoCentavos);
  assert.equal(vg.financeiro.contasAReceber.saldoCentavos, ar.totais.saldoCentavos);
  const html = telas.visaoGeral(vg);
  assert.ok(!html.includes("Indisponível"));
  for (const k of ["saldo-bancario", "caixa-fisico", "contas-a-pagar", "contas-a-receber", "fluxo-de-caixa"]) assert.ok(html.includes(`data-financeiro="${k}"`), k);
  assert.ok(html.includes(moeda(vg.financeiro.saldoBancario.valorCentavos)));
  // A ordem obrigatória da Execução 05 continua: bruto, líquido e só depois os secundários.
  assert.ok(html.indexOf('id="card-faturamento-bruto"') < html.indexOf('id="card-faturamento-liquido"') && html.indexOf('id="card-faturamento-liquido"') < html.indexOf('data-financeiro="saldo-bancario"'));
  // Unidade 2: nenhuma conta, nenhum saldo → "Valor desconhecido"/"Sem ..." e nunca R$ 0,00 nos cards financeiros.
  const vg2 = await ok("/api/fv2/visao-geral", { competencia: "2026-09", unidade: U2 });
  const fin2 = tes.cardsFinanceirosDaVisaoGeral(vg2.financeiro);
  assert.equal(vg2.financeiro.saldoBancario.valorCentavos, null);
  assert.ok(!fin2.includes("R$ 0,00"), fin2);
  assert.match(fin2, /Valor desconhecido/);
  assert.match(fin2, /Nenhuma conta deste tipo cadastrada/);
  assert.match(fin2, /Sem títulos registrados/);
  const cb2 = await ok("/api/fv2/caixa-e-bancos", { inicio: "2026-09-01", fim: "2026-09-30", unidade: U2 });
  assert.equal(cb2.consolidado.saldoFinalCentavos, null);
});

test("23, 24 — isolamento e permissões nas consultas novas; respostas sem identificadores internos", async () => {
  for (const c of ["/api/fv2/contas-a-pagar", "/api/fv2/contas-a-receber", "/api/fv2/calendario", "/api/fv2/caixa-e-bancos", "/api/fv2/fluxo-de-caixa"]) {
    const p = { mes: "2026-11", inicio: "2026-11-01", fim: "2026-11-12" };
    assert.equal((await get(c, p, "sem-acesso")).status, 403, c);
    assert.equal((await get(c, p, "ausente")).status, 401, c);
    assert.equal((await get(c, { ...p, unidade: "bbbbbbbb-0000-4000-8000-0000000000b1" })).status, 403, `${c}: unidade de outra organização`);
    const corpo = JSON.stringify((await get(c, p)).corpo);
    assert.ok(!UUID.test(corpo), `${c} vaza identificador interno`);
    assert.ok(!/arquivoId|demo-[ebnv]\b|hashSha256/.test(corpo), `${c} expõe arquivo do documento`);
  }
  // Título de uma unidade não abre na outra (a referência é resolvida, mas o escopo da sessão manda).
  const id = (await ok("/api/fv2/contas-a-pagar", {})).itens[0].id;
  assert.equal((await get("/api/fv2/conta-a-pagar", { id, unidade: U2 })).status, 404);
});

test("26 — mudança rápida de filtros: só a última resposta é aplicada", async () => {
  const lentas = [];
  const fetchFalso = (url, { signal }) => new Promise((resolve, reject) => {
    lentas.push({ url, resolve: () => resolve({ ok: true, status: 200, json: async () => ({ url }) }) });
    signal.addEventListener("abort", () => reject(Object.assign(new Error("abortado"), { name: "AbortError" })));
  });
  const c = criarConsultor(fetchFalso);
  const p1 = c.consultar("/api/fv2/contas-a-pagar?situacao=VENCIDO", {});
  const p2 = c.consultar("/api/fv2/contas-a-pagar?situacao=PAGO", {});
  lentas[1].resolve();
  lentas[0].resolve();
  assert.equal(await p1, null);
  assert.equal((await p2).dados.url, "/api/fv2/contas-a-pagar?situacao=PAGO");
});

test("27 — responsivo e acessível: tabelas viram cartões, calendário por toque, navegação nova", () => {
  const css = arquivo("fv2.css");
  const movel = css.slice(css.indexOf("@media (max-width: 760px)"));
  assert.match(movel, /\.tabela--cartoes td::before \{ content: attr\(data-rotulo\)/);
  assert.match(movel, /\.calendario \{ gap: 3px; \}/);
  assert.match(css, /\.cal-dia \{[^}]*min-height: 84px/);
  assert.match(css, /grid-template-columns: repeat\(7, minmax\(0, 1fr\)\)/);
  const html = arquivo("index.html");
  for (const r of ["contas-a-pagar", "calendario", "contas-a-receber", "caixa-e-bancos", "fluxo-de-caixa"]) assert.match(html, new RegExp(`href="#/${r}" data-rota="${r}"`));
  assert.ok(!/Contas a Pagar e Receber <small>em construção/.test(html));
  const app = arquivo("app.js");
  assert.match(app, /conteudo\.innerHTML = telas\.estado\("carregando"\)/, "limpa a tela antes de consultar (sem flash)");
  // Toda célula de tabela das telas novas tem rótulo para o modo cartão.
  const src = arquivo("telasTesouraria.js");
  assert.ok(!/<td(?![^>]*data-rotulo)[^>]*>/.test(src.replace(/const td = [^\n]+/, "")), "td sem data-rotulo");
  // Nenhuma fórmula financeira no frontend: sem somas de centavos nas telas.
  assert.ok(!/Centavos\s*[+-]\s*\w+Centavos|reduce\(/.test(src), "tela recalculando valores");
});

test("descrições técnicas viram texto para o gestor, com a original preservada", () => {
  assert.equal(descricaoLegivel("Venda BALCAO"), "Venda — Balcão");
  assert.equal(descricaoLegivel("Recebimento direto de venda (PIX)"), "Venda recebida por Pix");
  assert.equal(descricaoLegivel("Entregas de 2026-09-01 a 2026-09-30"), "Entregas de 01/09/2026 a 30/09/2026");
  const no = telas.arvore([{ nome: "Venda IFOOD", valorCentavos: 100, filhos: [] }]);
  assert.match(no, /title="Original: Venda IFOOD">Venda — iFood</);
});

test("calendário — vencendo (até 2 dias) amarelo piscando, vencida vermelha piscando, longe azul parado", () => {
  const dia = (data, { aVencer = 0, vencidas = 0 } = {}) => ({
    data, diaDaSemana: 1, hoje: data === "2026-11-20",
    titulos: Array.from({ length: aVencer + vencidas }, () => ({})), pagamentos: [], recorrentes: [],
    aVencer: { quantidade: aVencer }, vencidas: { quantidade: vencidas }, pagas: { quantidade: 0 }, recorrentesPrevistas: { quantidade: 0 }, emAbertoCentavos: 0,
  });
  const cal = { mes: "2026-11", dataBase: "2026-11-20", totais: {}, dias: [dia("2026-11-19", { vencidas: 1 }), dia("2026-11-20", { aVencer: 1 }), dia("2026-11-22", { aVencer: 2 }), dia("2026-11-23", { aVencer: 1 })] };
  const html = tes.calendario(cal);
  const botao = (d) => html.match(new RegExp(`<button[^>]*data-dia="${d}"[^]*?</button>`))[0];
  assert.match(botao("2026-11-19"), /cal-dia--erro/);
  assert.match(botao("2026-11-20"), /cal-dia--breve/);
  assert.match(botao("2026-11-20"), /atenção: vence hoje/);
  assert.match(botao("2026-11-22"), /cal-dia--breve/);
  assert.match(botao("2026-11-22"), /cal-chip--breve" title="2 vencendo · vence em 2 dia\(s\)"/);
  assert.doesNotMatch(botao("2026-11-23"), /cal-dia--breve|cal-dia--erro/);
  assert.match(botao("2026-11-23"), /cal-dia--info/);
  assert.match(botao("2026-11-23"), /cal-chip--info" title="1 a vencer"/);
  const css = readFileSync(fileURLToPath(new URL("../financeiro-v2/fv2.css", import.meta.url)), "utf8");
  assert.match(css, /\.cal-bloco \.cal-dia--breve \{[^}]*animation: cal-pulso/);
  assert.match(css, /\.cal-bloco \.cal-dia--erro \{[^}]*animation: cal-pulso/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \* \{[^}]*animation: none !important/, "reduzir movimento desliga o piscar");
});
