// Parser — calendário de fontes e "Preencher mês": funções puras (o HTML só mostra o que o backend devolveu).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estadoDoDia, calendarioCoberturaHtml, mesParaRecuperar, bannerRecuperacaoHtml, lotesDeRecuperacao, previaRecuperacaoHtml, rotuloMes,
} from "../src/parserFoodDeliveryCobertura.js";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const f = { escapeHtml: esc, fmtDataHora: (x) => `DH(${x})`, fmtMoeda: (v) => `R$ ${v.toFixed(2)}`, icon: () => "" };
const dia = (data, fonte, extra = {}) => ({ data, fonte, aberto: false, provisorio: false, triagem: 0, pedidosFoody: 0, ultimaAtualizacao: null, ...extra });
const cob = (dias, extra = {}) => ({ habilitado: true, papel: "titular", dias, totais: { planilha: 0, foody: 0, provisorios: 0, semDados: 0, abertos: 0, comTriagem: 0 }, ...extra });

test("flag desligada (habilitado=false): nada aparece e nada é oferecido", () => {
  assert.equal(calendarioCoberturaHtml({ habilitado: false }, f), "");
  assert.equal(mesParaRecuperar({ habilitado: false }), null);
  assert.equal(bannerRecuperacaoHtml(null, f), "");
});

test("estado do dia: planilha, Foody, provisório, em andamento e sem dados são distintos", () => {
  assert.equal(estadoDoDia(dia("2026-09-01", "planilha")).classe, "planilha");
  assert.equal(estadoDoDia(dia("2026-09-01", "foody")).classe, "foody");
  assert.equal(estadoDoDia(dia("2026-09-01", "foody", { provisorio: true })).classe, "provisorio");
  assert.equal(estadoDoDia(dia("2026-09-01", "sem_dados", { aberto: true })).classe, "aberto");
  assert.equal(estadoDoDia(dia("2026-09-01", "sem_dados")).rotulo, "Sem dados");
});

test("calendário: uma célula por dia, triagem marcada, aviso de que 'sem dados' não é dia zerado", () => {
  const html = calendarioCoberturaHtml(cob([dia("2026-09-01", "planilha", { ultimaAtualizacao: "2026-09-02T10:00:00Z" }), dia("2026-09-02", "foody", { triagem: 2 }), dia("2026-09-03", "sem_dados")]), f);
  assert.equal((html.match(/class="pfd-cob-dia pfd-cob-(planilha|foody|provisorio|vazio|aberto)[^"]*" title=/g) ?? []).length, 3, "uma célula por dia (legenda não conta)");
  assert.match(html, /pfd-cob-triagem/);
  assert.match(html, /2 em triagem/);
  assert.match(html, /não é um dia sem vendas/);
  assert.match(html, /DH\(2026-09-02T10:00:00Z\)/);
  assert.match(html, /setembro de 2026/);
});

test("oferta de recuperação: mês do primeiro dia sem dados; nada quando tudo tem dados ou só falta o dia em curso", () => {
  const o = mesParaRecuperar(cob([dia("2026-09-29", "planilha"), dia("2026-09-30", "sem_dados"), dia("2026-10-01", "sem_dados")]));
  assert.deepEqual(o, { mes: "2026-09", rotulo: "setembro de 2026", semDados: 1, semFoody: 2, comDados: 1, papel: "titular" });
  assert.equal(mesParaRecuperar(cob([dia("2026-09-29", "planilha", { pedidosFoody: 5 }), dia("2026-09-30", "foody", { pedidosFoody: 3 })])), null);
  // destino: planilha sem Foody não é oferecida (quem recupera é a titular)
  assert.equal(mesParaRecuperar(cob([dia("2026-09-29", "planilha")], { papel: "destino" })), null);
  assert.equal(mesParaRecuperar(cob([dia("2026-11-10", "sem_dados", { aberto: true })])), null);
  const b = bannerRecuperacaoHtml(o, f);
  assert.match(b, /Setembro de 2026<\/b> — dados incompletos/);
  assert.match(b, /Preencher mês de setembro/);
  assert.match(b, /data-mes="2026-09"/);
});

test("titular com planilha completa mas sem Foody: oferece recuperar, explicando que a planilha continua sendo a fonte", () => {
  const o = mesParaRecuperar(cob([dia("2026-09-01", "planilha"), dia("2026-09-02", "planilha"), dia("2026-09-03", "planilha", { pedidosFoody: 80 })]));
  assert.deepEqual(o, { mes: "2026-09", rotulo: "setembro de 2026", semDados: 0, semFoody: 2, comDados: 3, papel: "titular" });
  assert.match(bannerRecuperacaoHtml(o, f), /Foody sem pedidos em 2 dias. A planilha continua sendo a fonte desta unidade/);
});

test("lotes de no máximo 7 dias, ordenados e sem repetição (repetir não duplica)", () => {
  const dias = Array.from({ length: 16 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
  const lotes = lotesDeRecuperacao([...dias, "2026-09-01"].reverse());
  assert.deepEqual(lotes.map((l) => l.length), [7, 7, 2]);
  assert.equal(lotes[0][0], "2026-09-01");
});

test("prévia: só números do backend; recuperáveis = recuperáveis + parciais; zero pedidos explicado (não é loja fechada)", () => {
  const html = previaRecuperacaoHtml({ totais: { completos: 3, provisorios: 1, recuperaveis: 20, parciais: 2, semPedidosNaOrigem: 4, indisponiveis: 0,
    pedidosNaOrigem: 3100, porOperacao: { subway: 2600, acai_no_grau: 480, triagem: 20 }, comEntregador: { subway: 1800, acai_no_grau: 450 },
    taxasPrevistasCentavos: { subway: 1890000, acai_no_grau: 405000 } } }, f);
  assert.match(html, /Dias com dados<\/span><b>4/);
  assert.match(html, /Dias recuperáveis<\/span><b>22/);
  assert.match(html, /Dias indisponíveis<\/span><b>4/);
  assert.match(html, /Pedidos identificados na origem<\/span><b>3100/);
  assert.match(html, /Açaí no Grau: 480 pedidos \(450 com entregador, taxas previstas R\$ 4050\.00\)/);
  assert.match(html, /não confirma que a loja ficou fechada/);
  assert.match(html, /Taxas <b>previstas<\/b>/);
});

test("rótulo do mês", () => { assert.equal(rotuloMes("2026-09"), "setembro de 2026"); assert.equal(rotuloMes("2027-01"), "janeiro de 2027"); });
