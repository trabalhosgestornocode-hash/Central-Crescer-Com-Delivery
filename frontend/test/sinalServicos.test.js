// Seletor de sinal (+)/(−) de "Serviços e promoções" no Dashboard iFood.
// Convenção (migration 119): o valor GRAVADO continua sendo custo —
// (−) grava +valor, (+) crédito grava −valor. Cobre o helper puro e os
// formulários reais (diário e Sanduíches + Saladas) sobre o DOM mínimo.
//
// Rodar: node --test frontend/test/sinalServicos.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

const s = await import("../src/sinalServicos.js");
const p = await import("./helpers/pilotoFormularioDex.js");

describe("helper — conversão tela <-> valor gravado", () => {
  test("(−) custo grava positivo; (+) crédito grava negativo", () => {
    assert.equal(s.paraArmazenado("R$ 1.334,12", s.SINAL_CUSTO), 1334.12);
    assert.equal(s.paraArmazenado("R$ 1.334,12", s.SINAL_CREDITO), -1334.12);
  });

  test("sem inversão dupla: reaplicar o sinal sobre um valor já gravado não troca o sinal", () => {
    const credito = s.paraArmazenado("R$ 50,00", s.SINAL_CREDITO);
    assert.equal(s.paraArmazenado(credito, s.SINAL_CREDITO), -50);
    assert.equal(s.paraArmazenado(s.paraArmazenado(credito, s.SINAL_CREDITO), s.SINAL_CREDITO), -50);
    const custo = s.paraArmazenado("R$ 50,00", s.SINAL_CUSTO);
    assert.equal(s.paraArmazenado(custo, s.SINAL_CUSTO), 50);
    // Ida e volta: gravado -> (abs, sinal) -> gravado devolve o mesmo número.
    for (const v of [-50, 50, -0.01, 1234.56]) {
      assert.equal(s.paraArmazenado(s.absDoArmazenado(v), s.sinalDoArmazenado(v)), v);
    }
  });

  test("vazio continua não informado; zero nunca vira -0; inválido vira NaN", () => {
    assert.equal(s.paraArmazenado("", s.SINAL_CREDITO), "");
    assert.equal(s.paraArmazenado(null, s.SINAL_CUSTO), "");
    assert.ok(Object.is(s.paraArmazenado("R$ 0,00", s.SINAL_CREDITO), 0));
    assert.ok(Number.isNaN(s.paraArmazenado("abc", s.SINAL_CUSTO)));
  });

  test("lançamento salvo recupera o sinal: negativo = (+), positivo/zero/vazio = (−)", () => {
    assert.equal(s.sinalDoArmazenado(-80), s.SINAL_CREDITO);
    assert.equal(s.sinalDoArmazenado(80), s.SINAL_CUSTO);
    assert.equal(s.sinalDoArmazenado(0), s.SINAL_CUSTO);
    assert.equal(s.sinalDoArmazenado(null), s.SINAL_CUSTO);
    assert.equal(s.absDoArmazenado(-80), 80);
    assert.equal(s.absDoArmazenado(null), "");
  });

  test("leitura: crédito aparece como +R$ (crédito); custo no formato de sempre", () => {
    assert.match(s.fmtServicosPromocoes(-50), /^\+R\$\s?50,00 \(crédito\)$/);
    assert.doesNotMatch(s.fmtServicosPromocoes(50), /crédito|\+/);
  });

  test("markup: botões + e − lado a lado, o ativo com aria-pressed, cor no data-sinal", () => {
    const h = s.campoServicosHtml({ rotulo: "Serviços e promoções (R$) *", valorArmazenado: -120, atributosInput: 'id="x"' });
    assert.match(h, /data-sinal="\+"/);
    assert.match(h, /data-sinal-btn="\+" aria-pressed="true"/);
    assert.match(h, /data-sinal-btn="-" aria-pressed="false"/);
    assert.match(h, /value="R\$\s?120,00"/, "o input mostra só o absoluto");
  });
});

// ---------------------------------------------------------------------------
const DISP = { disponivel: true, status: "PENDENTE" };
const novo = () => ({ lancamento: null, disponibilidade: DISP, mostrarFinanceiro: true, financeiroPorDesbloqueio: false, periodoFinanceiroInicio: "2026-09-01", periodoFinanceiroFim: "2026-09-02" });
const sinalAtivo = () => p.sel(".dex-sinal-campo")?.getAttribute("data-sinal");
const botao = (sinal) => p.sel(`[data-sinal-btn="${sinal}"]`);

async function ateFinanceiro(get = novo()) {
  await p.abrir({ get });
  p.marcar('input[value="normal"]'); p.avancar(); p.avancar();
  assert.equal(p.etapa(), "3 4 Financeiro");
}
function preencher(servicos) {
  p.digitar("#dex-vifood", "1.000,00"); p.digitar("#dex-taxas", "100,00"); p.digitar("#dex-servicos", servicos);
  p.digitar("#dex-entregadores", "0,00");
}
const prevReceita = () => p.sel('[data-prev="receita"]').textContent.replace(/\s+/g, " ");

describe("formulário diário", () => {
  test("padrão é (−): mesmo payload de sempre (custo positivo) e receita = vendas − deduções", async () => {
    await ateFinanceiro();
    assert.equal(sinalAtivo(), "-");
    assert.equal(botao("-").getAttribute("aria-pressed"), "true");
    preencher("50,00");
    assert.match(prevReceita(), /850,00/);                     // 1000 − 100 − 50
    p.avancar();
    const { body } = await p.finalizar();
    assert.equal(body.servicosPromocoes, 50);
  });

  test("(+) crédito: grava negativo, reduz as deduções e AUMENTA a receita líquida", async () => {
    await ateFinanceiro();
    preencher("50,00");
    botao("+").click();
    assert.equal(sinalAtivo(), "+", "aparência muda na hora");
    assert.equal(botao("+").getAttribute("aria-pressed"), "true");
    assert.equal(botao("-").getAttribute("aria-pressed"), "false");
    assert.equal(p.sel(".dex-sinal-prefixo").textContent, "+");
    assert.match(prevReceita(), /950,00/);                     // 1000 − 100 − (−50)
    assert.match(p.sel('[data-prev="total"]').textContent, /50,00/); // 100 + (−50)
    p.avancar();
    assert.equal(p.etapa(), "4 4 Conferência", `não avançou: ${p.toast()}`);
    assert.match(p.corpo(), /\+R\$\s?50,00 \(crédito\)/);
    const { body } = await p.finalizar();
    assert.equal(body.servicosPromocoes, -50);
  });

  test("trocar o sinal depois de digitar não acumula inversões (+ → − → + = negativo)", async () => {
    await ateFinanceiro();
    preencher("75,10");
    botao("+").click(); botao("-").click(); botao("+").click();
    p.avancar();
    assert.equal((await p.finalizar()).body.servicosPromocoes, -75.1);
  });

  test("voltar e avançar mantém o sinal e o valor absoluto no input", async () => {
    await ateFinanceiro();
    preencher("30,00");
    botao("+").click();
    p.voltar(); p.avancar();
    assert.equal(sinalAtivo(), "+");
    assert.match(p.sel("#dex-servicos").value, /30,00/);
    assert.doesNotMatch(p.sel("#dex-servicos").value, /-/);
  });

  test("edição: lançamento salvo com crédito abre em (+) com o absoluto e reenvia o mesmo número", async () => {
    await p.abrir({ get: { ...novo(), lancamento: {
      id: "l1", status: "rascunho", updatedAt: "2026-09-02T10:00:00.000Z", situacao: "normal",
      qtdVendas: 5, valorVendasBruto: 100, novosClientes: null,
      valorVendasIfood: 1000, taxasComissoes: 100, servicosPromocoes: -40, taxasEntregadores: 0, ajustesFavorLoja: null, ajustesContraLoja: null,
    } } });
    while (!p.etapa().includes("Financeiro")) p.voltar();
    assert.equal(sinalAtivo(), "+");
    assert.match(p.sel("#dex-servicos").value, /40,00/);
    assert.doesNotMatch(p.sel("#dex-servicos").value, /-/);
    assert.equal((await p.salvarRascunho()).body.servicosPromocoes, -40);
  });

  test("edição: lançamento histórico (custo positivo) abre em (−) e não muda", async () => {
    await p.abrir({ get: { ...novo(), lancamento: {
      id: "l1", status: "rascunho", updatedAt: "2026-09-02T10:00:00.000Z", situacao: "normal",
      qtdVendas: 5, valorVendasBruto: 100, novosClientes: null,
      valorVendasIfood: 1000, taxasComissoes: 100, servicosPromocoes: 40, taxasEntregadores: 0, ajustesFavorLoja: null, ajustesContraLoja: null,
    } } });
    while (!p.etapa().includes("Financeiro")) p.voltar();
    assert.equal(sinalAtivo(), "-");
    assert.equal((await p.salvarRascunho()).body.servicosPromocoes, 40);
  });

  test("os outros campos financeiros continuam sem sinal e não aceitam negativo", async () => {
    await ateFinanceiro();
    assert.equal(p.todos(".dex-sinal-campo").length, 1, "só Serviços e promoções ganha o seletor");
    preencher("10,00");
    p.digitar("#dex-taxas", "-5,00");                           // a máscara descarta o "-"
    assert.doesNotMatch(p.sel("#dex-taxas").value, /-/);
  });
});

// ---------------------------------------------------------------------------
const N = "11111111-aaaa-4aaa-8aaa-000000000001";
const S = "22222222-bbbb-4bbb-8bbb-000000000002";
const blocoMc = (extra = {}) => ({
  estruturaDia: "multicanal", estruturaUnidade: "multicanal", taxasEntregadoresEscopo: "unidade", entregadoresAplicavel: true,
  canais: [{ canalId: N, nome: "Loja Norte", ordem: 0, ativo: true }, { canalId: S, nome: "Loja Sul", ordem: 1, ativo: true }],
  valores: [], anteriores: [], consolidado: null, resumo: null, etapaIncompleta: "situacao", ...extra,
});
const aba = (id) => p.sel(`#dex-mc-aba-${id}`);

describe("formulário Sanduíches + Saladas (por canal)", () => {
  test("cada canal tem o próprio sinal; consolidado soma custo e crédito", async () => {
    await p.abrir({ get: { ...novo(), multicanal: blocoMc() } });
    p.avancar(); p.avancar();
    assert.match(p.etapa(), /Financeiro/);
    aba(N).click();
    p.digitar("#dex-mc-vifood", "1.000,00"); p.digitar("#dex-mc-taxas", "100,00"); p.digitar("#dex-mc-servicos", "60,00");
    botao("+").click();
    aba(S).click();
    assert.equal(sinalAtivo(), "-", "o outro canal continua em (−)");
    p.digitar("#dex-mc-vifood", "500,00"); p.digitar("#dex-mc-taxas", "50,00"); p.digitar("#dex-mc-servicos", "20,00");
    p.digitar("#dex-mc-entregadores-unidade", "0,00");
    aba(N).click();
    assert.equal(sinalAtivo(), "+", "voltar à aba recupera o sinal do canal");
    p.avancar();
    assert.match(p.etapa(), /Conferência/, `não avançou: ${p.toast()}`);
    const { body } = await p.finalizar();
    const porCanal = Object.fromEntries(body.canais.map((c) => [c.canalId, c.servicosPromocoes]));
    assert.deepEqual(porCanal, { [N]: -60, [S]: 20 });
  });

  test("dia salvo com crédito num canal abre esse canal em (+)", async () => {
    const valores = [
      { canalId: N, situacaoCanal: "com_vendas", valorVendasIfood: 1000, taxasComissoes: 100, servicosPromocoes: -60, taxasEntregadores: null, ajustesFavorLoja: null, ajustesContraLoja: null, qtdVendas: 1, valorVendasBruto: 10, novosClientes: 0 },
      { canalId: S, situacaoCanal: "com_vendas", valorVendasIfood: 500, taxasComissoes: 50, servicosPromocoes: 20, taxasEntregadores: null, ajustesFavorLoja: null, ajustesContraLoja: null, qtdVendas: 1, valorVendasBruto: 10, novosClientes: 0 },
    ];
    await p.abrir({ get: { ...novo(), lancamento: { id: "l1", status: "rascunho", updatedAt: "2026-09-02T10:00:00.000Z", situacao: "normal" }, multicanal: blocoMc({ valores, etapaIncompleta: "financeiro" }) } });
    while (!p.etapa().includes("Financeiro")) p.etapa().includes("Conferência") ? p.voltar() : p.avancar();
    aba(N).click(); assert.equal(sinalAtivo(), "+"); assert.match(p.sel("#dex-mc-servicos").value, /60,00/);
    aba(S).click(); assert.equal(sinalAtivo(), "-");
  });
});
