// Formulário de lançamento MULTICANAL do Dashboard iFood (Checkpoint E).
// Dirige o formulário REAL (dashboardExecutivoForm.js) sobre um DOM mínimo
// (test/helpers/domMinimo.js): o GET por data devolve o contrato do Checkpoint
// D e cada POST/PUT é capturado para conferir o payload. Sem rede.
//
// Os nomes dos canais são propositalmente genéricos ("Loja Norte", "Loja Sul
// & Cia") — nada no código pode depender deles.
//
// Rodar: node --test frontend/test/dashboardExecutivoCanais.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const p = await import("./helpers/pilotoFormularioDex.js");
const mc = await import("../src/dashboardExecutivoCanais.js");

const N = "11111111-aaaa-4aaa-8aaa-000000000001";
const S = "22222222-bbbb-4bbb-8bbb-000000000002";
const DISP = { disponivel: true, status: "PENDENTE" };

function bloco(extra = {}) {
  return {
    estruturaDia: "multicanal", estruturaUnidade: "multicanal", taxasEntregadoresEscopo: "unidade", entregadoresAplicavel: true,
    canais: [{ canalId: N, nome: "Loja Norte", ordem: 0, ativo: true }, { canalId: S, nome: "Loja Sul & Cia", ordem: 1, ativo: true }],
    valores: [],
    anteriores: [
      { canalId: N, desempenho: { conhecido: true, qtdVendas: 480, valorVendasBruto: 21000, novosClientes: 38 },
        financeiro: { dataReferencia: "2026-09-01", valorVendasIfood: 22000, taxasComissoes: 2860, servicosPromocoes: 1100, taxasEntregadores: null, ajustesFavorLoja: null, ajustesContraLoja: null } },
      { canalId: S, desempenho: { conhecido: true, qtdVendas: 50, valorVendasBruto: 4000, novosClientes: 8 },
        financeiro: { dataReferencia: "2026-09-01", valorVendasIfood: 3700, taxasComissoes: 481, servicosPromocoes: 185, taxasEntregadores: null, ajustesFavorLoja: null, ajustesContraLoja: null } },
    ],
    consolidado: null, resumo: null, etapaIncompleta: "situacao",
    ...extra,
  };
}
const getNovo = (b = bloco(), mostrarFinanceiro = true) => ({
  lancamento: null, disponibilidade: DISP, mostrarFinanceiro, financeiroPorDesbloqueio: false,
  periodoFinanceiroInicio: "2026-09-01", periodoFinanceiroFim: "2026-09-02", multicanal: b,
});
const aba = (id) => p.sel(`#dex-mc-aba-${id}`);
const abaAtiva = () => p.sel('.dex-mc-aba[aria-selected="true"]')?.dataset.canal;
const irPara = (alvo) => {
  for (let i = 0; i < 6 && !p.etapa().includes(alvo); i++) p.avancar();
  if (!p.etapa().includes(alvo)) throw new Error(`não chegou em ${alvo} (parou em ${p.etapa()}; toast: ${p.toast()})`);
};

async function preencherDiaCompleto() {
  await p.abrir({ get: getNovo() });
  p.avancar();                                       // -> Desempenho
  aba(N).click(); p.digitar("#dex-mc-qtd", "500"); p.digitar("#dex-mc-valorbruto", "22.000,00"); p.digitar("#dex-mc-novos", "40");
  aba(S).click(); p.digitar("#dex-mc-qtd", "50"); p.digitar("#dex-mc-valorbruto", "4.000,00"); p.digitar("#dex-mc-novos", "8");
  p.avancar();                                       // -> Financeiro
  aba(N).click(); p.digitar("#dex-mc-vifood", "22.914,53"); p.digitar("#dex-mc-taxas", "2.978,89"); p.digitar("#dex-mc-servicos", "1.145,73"); p.digitar("#dex-mc-aj-favor", "10,00");
  aba(S).click(); p.digitar("#dex-mc-vifood", "3.767,76"); p.digitar("#dex-mc-taxas", "489,81"); p.digitar("#dex-mc-servicos", "188,39");
  p.digitar("#dex-mc-entregadores-unidade", "120,00");
}

// ---------------------------------------------------------------------------
describe("estrutura: padrão x multicanal", () => {
  test("1/32: dia padrão — nenhuma aba, nenhum texto multicanal, payload sem `canais`", async () => {
    await p.abrir({ get: { ...getNovo(), multicanal: undefined } });
    assert.doesNotMatch(p.html(), /dex-mc-|Situação por canal|Consolidado da unidade|Operação logística/);
    p.avancar(); assert.doesNotMatch(p.html(), /dex-mc-aba|role="tab"/);
    p.digitar("#dex-qtd", "10");
    const { body } = await p.salvarRascunho();
    assert.equal("canais" in body, false);
    assert.equal(body.qtdVendas, 10);
  });

  test("2/3: dia multicanal — abas com os nomes que vieram do backend (escapados)", async () => {
    await p.abrir({ get: getNovo() });
    p.avancar();
    const nomes = p.todos(".dex-mc-aba-nome").map((e) => e.textContent);
    assert.deepEqual(nomes, ["Loja Norte", "Loja Sul & Cia"]);
    assert.match(p.html(), /Loja Sul &amp; Cia/);
  });

  test("dia histórico padrão numa unidade hoje multicanal abre no modo padrão (bloco ausente = padrão)", async () => {
    await p.abrir({ get: { ...getNovo(), multicanal: undefined, lancamento: { id: "l9", status: "finalizado", situacao: "normal", qtdVendas: 1, valorVendasBruto: 10, novosClientes: 0, valorVendasIfood: 9, taxasComissoes: 1, servicosPromocoes: 0, taxasEntregadores: 0, ajustesFavorLoja: null, ajustesContraLoja: null, updatedAt: "2026-09-02T10:00:00Z" } } });
    assert.doesNotMatch(p.html(), /dex-mc-/);
  });
});

// ---------------------------------------------------------------------------
describe("Etapa 1 — Situação", () => {
  test("9/10: normal e parcial mostram a situação por canal; dia novo começa 'Com vendas'", async () => {
    await p.abrir({ get: getNovo() });
    assert.match(p.html(), /A unidade funcionou normalmente neste dia\?/);
    assert.equal(p.sel("#dex-mc-situacao").hidden, false);
    assert.equal(p.todos(".dex-mc-sit:checked").map((r) => r.value).join(), "com_vendas,com_vendas");
    p.marcar('input[name="situacao"][value="parcial"]');
    assert.equal(p.sel("#dex-mc-situacao").hidden, false);
  });

  test("11/12: sem operação e zero vendas escondem a situação por canal e não mandam `canais`", async () => {
    await p.abrir({ get: getNovo() });
    p.marcar('input[name="situacao"][value="zero_vendas"]');
    assert.equal(p.sel("#dex-mc-situacao").hidden, true);
    irPara("Conferência");
    let { body } = await p.finalizar();
    assert.equal(body.situacao, "zero_vendas");
    assert.equal("canais" in body, false);
    assert.equal("novosClientes" in body, false);
    await p.abrir({ get: getNovo() });
    p.marcar('input[name="situacao"][value="sem_operacao"]');
    assert.equal(p.sel("#dex-mc-situacao").hidden, true);
    irPara("Conferência");
    ({ body } = await p.finalizar());
    assert.deepEqual([body.situacao, body.motivoSemOperacao, "canais" in body], ["sem_operacao", "Folga", false]);
  });

  test("situação do canal sem escolha bloqueia o avanço com mensagem clara", async () => {
    await p.abrir({ get: getNovo(bloco({ valores: [{ canalId: N, situacaoCanal: "com_vendas" }] })) });
    p.avancar();
    assert.match(p.toast(), /Informe a situação do canal "Loja Sul & Cia"/);
    assert.match(p.etapa(), /^1 /);
  });
});

// ---------------------------------------------------------------------------
describe("abas — troca, estados, teclado", () => {
  test("4: troca de aba por clique mostra o painel daquele canal", async () => {
    await p.abrir({ get: getNovo() });
    p.avancar();
    assert.equal(abaAtiva(), N);
    p.digitar("#dex-mc-qtd", "500");
    aba(S).click();
    assert.equal(abaAtiva(), S);
    assert.equal(p.sel("#dex-mc-qtd").value, "");
    aba(N).click();
    assert.equal(p.sel("#dex-mc-qtd").value, "500", "valor do canal preservado ao voltar");
    assert.equal(p.sel("#dex-mc-painel").getAttribute("aria-labelledby"), `dex-mc-aba-${N}`);
  });

  test("5/6/7/8: estado visual discreto por aba — completo, incompleto, sem vendas, não informado", async () => {
    await p.abrir({ get: getNovo() });
    p.sel(`input[name="dex-mc-sit-${S}"][value="sem_vendas"]`).marcar();
    p.avancar();
    assert.ok(aba(N).classList.contains("dex-mc-aba--incompleto"));
    assert.ok(aba(S).classList.contains("dex-mc-aba--sem_vendas"));
    p.digitar("#dex-mc-qtd", "500"); p.digitar("#dex-mc-valorbruto", "1,00"); p.digitar("#dex-mc-novos", "1");
    assert.ok(aba(N).classList.contains("dex-mc-aba--completo"), "atualiza sem redesenhar");
    assert.equal(aba(N).querySelector(".sr-only").textContent, " — completo", "leitor de tela acompanha a marca");
    p.voltar();
    p.sel(`input[name="dex-mc-sit-${S}"][value="nao_informado"]`).marcar();
    p.avancar();
    assert.ok(aba(S).classList.contains("dex-mc-aba--nao_informado"));
  });

  test("31: teclado — setas, Home e End; roving tabindex; foco acompanha", async () => {
    await p.abrir({ get: getNovo() });
    p.avancar();
    assert.equal(aba(N).getAttribute("tabindex"), "0");
    assert.equal(aba(S).getAttribute("tabindex"), "-1");
    aba(N).dispatch("keydown", { key: "ArrowRight" });
    assert.equal(abaAtiva(), S);
    assert.equal(globalThis.document.activeElement?.dataset.canal, S);
    aba(S).dispatch("keydown", { key: "ArrowRight" });
    assert.equal(abaAtiva(), N, "volta ao início");
    aba(N).dispatch("keydown", { key: "End" });
    assert.equal(abaAtiva(), S);
    aba(S).dispatch("keydown", { key: "Home" });
    assert.equal(abaAtiva(), N);
    assert.equal(p.sel(".dex-mc-abas").getAttribute("role"), "tablist");
    assert.ok(p.todos(".dex-mc-aba").every((b) => b.tagName === "BUTTON" && b.getAttribute("role") === "tab" && b.getAttribute("type") === "button"));
  });

  test("30: responsividade básica — abas rolam na horizontal, nome longo trunca, layout em coluna no celular", () => {
    const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");
    assert.match(css, /\.dex-mc-abas \{[^}]*overflow-x: auto/);
    assert.match(css, /\.dex-mc-aba-nome \{[^}]*text-overflow: ellipsis/);
    assert.match(css, /@media \(max-width: 640px\) \{\s*\.dex-mc-sit-linha \{ flex-direction: column/);
    assert.match(css, /\.dex-mc-aba:focus-visible \{ outline/);
  });
});

// ---------------------------------------------------------------------------
describe("Etapa 2 — Desempenho", () => {
  test("13/14/15: campos por canal (acumulados do mês) + consolidado com ticket = Σbruto ÷ Σpedidos", async () => {
    await preencherDiaCompleto();
    p.voltar();
    assert.match(p.corpo(), /Quantidade de vendas acumulada no mês/);
    assert.equal(p.sel('[data-mc-cons="qtdVendas"]').textContent, "550");
    assert.match(p.sel('[data-mc-cons="valorVendasBruto"]').textContent, /26\.000,00/);
    assert.equal(p.sel('[data-mc-cons="novosClientes"]').textContent, "48");
    const ticketConsolidado = p.sel('[data-mc-cons="ticketMedio"]').textContent;
    assert.match(ticketConsolidado, /47,27/, "26000/550");
    assert.doesNotMatch(ticketConsolidado, /62,00/, "nunca a média dos tickets (44 e 80)");
  });

  test("16: campo vazio é 'Não informado' — nunca R$ 0,00 — e não vai no payload", async () => {
    await p.abrir({ get: getNovo() });
    p.avancar();
    p.digitar("#dex-mc-qtd", "500");
    assert.equal(p.sel('[data-mc-cons="qtdVendas"]').textContent, "Não informado");
    assert.equal(p.sel('[data-mc-cons="valorVendasBruto"]').textContent, "Não informado");
    const { body } = await p.salvarRascunho();
    assert.deepEqual(body.canais[0], { canalId: N, situacaoCanal: "com_vendas", qtdVendas: 500 });
    assert.deepEqual(body.canais[1], { canalId: S, situacaoCanal: "com_vendas" });
  });

  test("17: 'Sem vendas' mostra o acumulado anterior do canal, bloqueado, e não manda desempenho", async () => {
    await p.abrir({ get: getNovo() });
    p.sel(`input[name="dex-mc-sit-${S}"][value="sem_vendas"]`).marcar();
    p.avancar(); aba(S).click();
    assert.equal(p.sel("#dex-mc-qtd").value, "50");
    assert.equal(p.sel("#dex-mc-qtd").disabled, true);
    assert.match(p.sel("#dex-mc-valorbruto").value, /4\.000,00/);
    assert.match(p.corpo(), /sem vendas neste dia: o acumulado do mês se repete/);
    const { body } = await p.salvarRascunho();
    assert.equal("qtdVendas" in body.canais[1], false);
  });

  test("18: primeiro dia sem acumulado confiável — 'Sem vendas' fica não informado (nunca 0)", async () => {
    const b = bloco();
    b.anteriores[1].desempenho = { conhecido: false, qtdVendas: null, valorVendasBruto: null, novosClientes: null };
    await p.abrir({ get: getNovo(b) });
    p.sel(`input[name="dex-mc-sit-${S}"][value="sem_vendas"]`).marcar();
    p.avancar(); aba(S).click();
    assert.equal(p.sel("#dex-mc-qtd").value, "");
    assert.equal(p.sel("#dex-mc-qtd").getAttribute("placeholder"), "Não informado");
    assert.match(p.corpo(), /fica como não informado/);
    assert.equal(p.sel('[data-mc-cons="qtdVendas"]').textContent, "Não informado");
  });

  test("8: 'Não informado' no Desempenho mostra só o aviso, sem campos", async () => {
    await p.abrir({ get: getNovo() });
    p.sel(`input[name="dex-mc-sit-${S}"][value="nao_informado"]`).marcar();
    p.avancar(); aba(S).click();
    assert.equal(p.sel("#dex-mc-qtd"), null);
    assert.match(p.corpo(), /Loja Sul &amp; Cia está como "Não informado"/);
  });
});

// ---------------------------------------------------------------------------
describe("Etapa 3 — Financeiro", () => {
  test("19/20: por canal + 'Operação logística da unidade' com a taxa compartilhada fora das abas", async () => {
    await preencherDiaCompleto();
    assert.match(p.corpo(), /Valor das vendas no financeiro do iFood/);
    assert.equal(p.sel("#dex-mc-entregadores"), null, "nunca dentro do canal no escopo unidade");
    assert.match(p.corpo(), /Operação logística da unidade/);
    assert.match(p.corpo(), /compartilhado por Loja Norte e Loja Sul &amp; Cia e deve ser informado apenas uma vez, para a unidade/);
    assert.match(p.sel('[data-mc-cons="valorVendasIfood"]').textContent, /26\.682,29/);
    assert.match(p.sel('[data-mc-cons="receita"]').textContent, /21\.769,47/, "26682,29 − (3468,70+1334,12+120) + 10");
  });

  test("21: escopo 'canal' — taxa dentro de cada canal, sem bloco compartilhado", async () => {
    await p.abrir({ get: getNovo(bloco({ taxasEntregadoresEscopo: "canal" })) });
    p.avancar(); p.avancar();
    assert.ok(p.sel("#dex-mc-entregadores"));
    assert.doesNotMatch(p.corpo(), /Operação logística da unidade/);
    p.digitar("#dex-mc-entregadores", "60,00");
    const { body } = await p.salvarRascunho();
    assert.equal(body.canais[0].taxasEntregadores, 60);
    assert.equal("taxasEntregadores" in body, false);
  });

  test("22: Full Service (entregadoresAplicavel=false) não mostra entregadores em lugar nenhum", async () => {
    for (const escopo of ["unidade", "canal"]) {
      await p.abrir({ get: getNovo(bloco({ taxasEntregadoresEscopo: escopo, entregadoresAplicavel: false })) });
      p.avancar(); p.avancar();
      assert.doesNotMatch(p.corpo(), /dex-mc-entregadores|Operação logística|% Taxas de entregadores/);
    }
  });

  test("23/24: 'Sem vendas' mantém o Financeiro, pré-preenchido com o último extrato (só campos vazios)", async () => {
    await p.abrir({ get: getNovo() });
    p.sel(`input[name="dex-mc-sit-${S}"][value="sem_vendas"]`).marcar();
    p.avancar(); p.avancar(); aba(S).click();
    assert.match(p.sel("#dex-mc-vifood").value, /3\.700,00/);
    assert.match(p.sel("#dex-mc-taxas").value, /481,00/);
    assert.match(p.corpo(), /não zera o extrato/);
    assert.match(p.corpo(), /Último extrato de Loja Sul &amp; Cia \(01\/09\/2026\)/);
    p.digitar("#dex-mc-vifood", "3.750,00");
    const { body } = await p.salvarRascunho();
    assert.deepEqual([body.canais[1].situacaoCanal, body.canais[1].valorVendasIfood, body.canais[1].taxasComissoes], ["sem_vendas", 3750, 481]);
  });

  test("6/canal não informado impede seguir para a Conferência com Financeiro; rascunho continua possível", async () => {
    await p.abrir({ get: getNovo() });
    p.sel(`input[name="dex-mc-sit-${S}"][value="nao_informado"]`).marcar();
    p.avancar(); p.avancar();
    aba(S).click();
    assert.match(p.corpo(), /precisa ser informado/);
    p.avancar();
    assert.match(p.toast(), /"Loja Sul & Cia" está como "Não informado"/);
    const { body } = await p.salvarRascunho();
    assert.deepEqual(body.canais[1], { canalId: S, situacaoCanal: "nao_informado" });
    assert.equal(body.status, "rascunho");
  });

  test("dia sem Financeiro (não é D-1): sem etapa Financeiro e sem campos financeiros no payload", async () => {
    await p.abrir({ get: getNovo(bloco(), false) });
    p.avancar(); p.digitar("#dex-mc-qtd", "5");
    p.avancar();
    assert.match(p.etapa(), /Conferência/);
    const { body } = await p.finalizar();
    assert.equal("valorVendasIfood" in body.canais[0], false);
    assert.equal("taxasEntregadores" in body, false);
    assert.equal("confirmarAvisos" in body, false);
  });
});

// ---------------------------------------------------------------------------
describe("payload, rascunho, retomada, queda", () => {
  test("27: payload multicanal completo — canais no contrato do D, consolidado NUNCA enviado", async () => {
    await preencherDiaCompleto();
    p.avancar();
    assert.match(p.etapa(), /Conferência/);
    assert.match(p.corpo(), /26\.682,29/, "Conferência mostra o consolidado");
    const { body } = await p.finalizar();
    assert.deepEqual(Object.keys(body).sort(), ["canais", "confirmarAvisos", "data", "situacao", "status", "taxasEntregadores", "unidadeId"]);
    assert.equal(body.taxasEntregadores, 120);
    assert.deepEqual(body.canais, [
      { canalId: N, situacaoCanal: "com_vendas", qtdVendas: 500, valorVendasBruto: 22000, novosClientes: 40, valorVendasIfood: 22914.53, taxasComissoes: 2978.89, servicosPromocoes: 1145.73, ajustesFavorLoja: 10 },
      { canalId: S, situacaoCanal: "com_vendas", qtdVendas: 50, valorVendasBruto: 4000, novosClientes: 8, valorVendasIfood: 3767.76, taxasComissoes: 489.81, servicosPromocoes: 188.39 },
    ]);
  });

  test("28: payload padrão sem `canais` (regressão do contrato padrão)", async () => {
    await p.abrir({ get: { ...getNovo(), multicanal: undefined } });
    p.avancar();
    p.digitar("#dex-qtd", "3");
    const { body } = await p.salvarRascunho();
    // Mesmo contrato do baseline do modo padrão (confirmarAvisos vai junto quando há Financeiro).
    assert.deepEqual(Object.keys(body).sort(), ["confirmarAvisos", "data", "qtdVendas", "situacao", "status", "unidadeId"]);
  });

  test("25/26: retomar rascunho — situações e valores restaurados, etapa do backend, aba no 1º canal incompleto", async () => {
    const b = bloco({
      valores: [
        { canalId: N, situacaoCanal: "com_vendas", qtdVendas: 500, valorVendasBruto: 22000, novosClientes: 40, valorVendasIfood: 22914.53, taxasComissoes: 2978.89, servicosPromocoes: 1145.73, taxasEntregadores: null, ajustesFavorLoja: null, ajustesContraLoja: null },
        { canalId: S, situacaoCanal: "nao_informado", qtdVendas: null, valorVendasBruto: null, novosClientes: null, valorVendasIfood: null, taxasComissoes: null, servicosPromocoes: null, taxasEntregadores: null, ajustesFavorLoja: null, ajustesContraLoja: null },
      ],
      consolidado: { qtdVendas: null, valorVendasBruto: null, novosClientes: null, valorVendasIfood: null, taxasComissoes: null, servicosPromocoes: null, taxasEntregadores: null, ajustesFavorLoja: null, ajustesContraLoja: null },
      etapaIncompleta: "financeiro",
    });
    await p.abrir({ get: { ...getNovo(b), lancamento: { id: "l1", status: "rascunho", situacao: "normal", updatedAt: "2026-09-02T10:00:00.000Z", qtdVendas: null, valorVendasBruto: null, novosClientes: null, valorVendasIfood: null, taxasComissoes: null, servicosPromocoes: null, taxasEntregadores: null, ajustesFavorLoja: null, ajustesContraLoja: null } } });
    assert.match(p.etapa(), /Financeiro/, "abre na etapa que o backend indicou");
    assert.equal(abaAtiva(), S, "primeiro canal incompleto");
    aba(N).click();
    assert.match(p.sel("#dex-mc-vifood").value, /22\.914,53/);
    p.voltar(); p.voltar();
    assert.equal(p.sel(`input[name="dex-mc-sit-${S}"][value="nao_informado"]`).checked, true);
    const { metodo, url, body } = await p.salvarRascunho();
    assert.equal(metodo, "PUT");
    assert.match(url, /\/lancamentos\/l1$/);
    assert.equal(body.seVersao, "2026-09-02T10:00:00.000Z");
  });

  test("29: queda de acumulado de canal — mensagem com o NOME do canal, nunca o código interno", async () => {
    await preencherDiaCompleto();
    p.avancar();
    p.definirEscrita(() => ({ status: 400, body: { error: "queda", details: { confirmacaoReforcadaNecessaria: true, sinaisQuedaMaterial: [
      { campo: `canal:${S}:valorVendasIfood`, canal: "Loja Sul & Cia", canalId: S, nivel: "material", valorAnterior: 4000, dataAnterior: "2026-09-01", valorNovo: 3767.76, mensagem: "x" },
      { campo: "valorVendasIfood", nivel: "material", valorAnterior: 30000, dataAnterior: "2026-09-01", valorNovo: 26682.29, mensagem: "Valor menor que o acumulado anterior em Valor das vendas (iFood)." },
    ] } } }));
    await p.finalizar();
    p.definirEscrita(() => ({ status: 200, body: { data: {} } }));
    const html = p.html();
    assert.match(html, /O acumulado de Financeiro Oficial do canal Loja Sul &amp; Cia é menor que o último valor informado/);
    assert.match(html, /Valor menor que o acumulado anterior em Valor das vendas \(iFood\)/, "sinal do consolidado inalterado");
    assert.doesNotMatch(html, new RegExp(`canal:${S}`));
    assert.ok(p.sel("#dex-confirmar-queda-material"), "fluxo de confirmação reforçada preservado");
  });
});

// ---------------------------------------------------------------------------
describe("funções puras", () => {
  test("consolidado usa o do servidor enquanto nada mudou; depois, prévia com a mesma regra", () => {
    const e = mc.criarEstadoMulticanal(bloco({
      valores: [{ canalId: N, situacaoCanal: "com_vendas", qtdVendas: 1 }, { canalId: S, situacaoCanal: "com_vendas", qtdVendas: 2 }],
      consolidado: { qtdVendas: 999, valorVendasBruto: 10, novosClientes: 1, valorVendasIfood: null },
      resumo: { ticketMedio: 0.01 },
    }));
    assert.equal(mc.consolidadoDesempenho(e).qtdVendas, 999);
    mc.definirCampoCanal(e, N, "qtdVendas", "5");
    const d = mc.consolidadoDesempenho(e);
    assert.equal(d.qtdVendas, 7, "agora a prévia: 5 + 2");
    assert.equal(d.valorVendasBruto, null, "bruto vazio nos dois -> não informado, nunca 0");
    assert.equal(d.ticketMedio, null);
  });

  test("mensagemSinalQueda mantém sinal padrão intacto", () => {
    assert.equal(mc.mensagemSinalQueda({ campo: "valorVendasIfood", mensagem: "texto do servidor" }), "texto do servidor");
  });
});

// ---------------------------------------------------------------------------
// Checkpoint F — Sanduíches + Saladas: textos e Etapa 4 (Conferência)
// ---------------------------------------------------------------------------
const SAND = "33333333-cccc-4ccc-8ccc-000000000003";
const SAL = "44444444-dddd-4ddd-8ddd-000000000004";
function blocoSS(extra = {}) {
  return bloco({
    canais: [{ canalId: SAND, nome: "Sanduíches", ordem: 0, ativo: true }, { canalId: SAL, nome: "Saladas", ordem: 1, ativo: true }],
    anteriores: [{ canalId: SAND, desempenho: { conhecido: true, qtdVendas: 0, valorVendasBruto: 0, novosClientes: 0 }, financeiro: null },
      { canalId: SAL, desempenho: { conhecido: true, qtdVendas: 0, valorVendasBruto: 0, novosClientes: 0 }, financeiro: null }],
    ...extra,
  });
}
/** Cenário de aceite: Sanduíches 20.000 + Saladas 5.000 + entregadores 3.000 da unidade. */
async function lancarCenario20k5k(b = blocoSS()) {
  await p.abrir({ get: getNovo(b) });
  p.avancar();
  aba(SAND).click(); p.digitar("#dex-mc-qtd", "400"); p.digitar("#dex-mc-valorbruto", "20.000,00"); p.digitar("#dex-mc-novos", "50");
  aba(SAL).click(); p.digitar("#dex-mc-qtd", "100"); p.digitar("#dex-mc-valorbruto", "5.000,00"); p.digitar("#dex-mc-novos", "10");
  p.avancar();
  aba(SAND).click(); p.digitar("#dex-mc-vifood", "20.000,00"); p.digitar("#dex-mc-taxas", "2.200,00"); p.digitar("#dex-mc-servicos", "2.000,00"); p.digitar("#dex-mc-aj-favor", "100,00"); p.digitar("#dex-mc-aj-contra", "50,00");
  aba(SAL).click(); p.digitar("#dex-mc-vifood", "5.000,00"); p.digitar("#dex-mc-taxas", "550,00"); p.digitar("#dex-mc-servicos", "500,00"); p.digitar("#dex-mc-aj-favor", "0,00"); p.digitar("#dex-mc-aj-contra", "0,00");
  if (b.entregadoresAplicavel !== false) p.digitar("#dex-mc-entregadores-unidade", "3.000,00");
  p.avancar();
}
const blocoConf = (rotulo) => p.todos(".dex-mc-conf-bloco").find((sec) => sec.getAttribute("aria-label") === rotulo);
const valorConf = (rotulo, item) => {
  const linha = blocoConf(rotulo)?.querySelectorAll(".dex-conf-item").find((i) => i.querySelector("span").textContent === item);
  return linha ? linha.querySelector("b").textContent.replace(/\s+/g, " ").trim() : undefined;
};

describe("Checkpoint F — Sanduíches + Saladas", () => {
  test("textos falam explicitamente em Sanduíches e Saladas (nomes vindos do backend)", async () => {
    await p.abrir({ get: getNovo(blocoSS()) });
    assert.match(p.html(), /<legend>Sanduíches e Saladas<\/legend>/);
    p.avancar();
    assert.match(p.corpo(), /informe o TOTAL de Sanduíches e Saladas, cada um na sua aba/);
    assert.match(p.corpo(), /Consolidado da unidade/);
    assert.equal(p.sel(".dex-mc-abas").getAttribute("aria-label"), "Sanduíches e Saladas");
    p.avancar();
    assert.match(p.corpo(), /Operação logística da unidade/);
    assert.match(p.corpo(), /compartilhado por Sanduíches e Saladas e deve ser informado apenas uma vez, para a unidade/);
    assert.equal(p.sel("#dex-mc-entregadores"), null, "entregadores nunca dentro de Sanduíches/Saladas");
  });

  test("8/9/10/11: Etapa 4 mostra Sanduíches, Saladas, Operação da unidade e Consolidado", async () => {
    await lancarCenario20k5k();
    assert.match(p.etapa(), /Conferência/);
    assert.deepEqual(p.todos(".dex-mc-conf-bloco").map((sec) => sec.getAttribute("aria-label")), ["Sanduíches", "Saladas", "Operação da unidade", "Consolidado da unidade"]);
    assert.equal(valorConf("Sanduíches", "Quantidade de vendas"), "400");
    assert.match(valorConf("Sanduíches", "Financeiro Oficial"), /20\.000,00/);
    assert.match(valorConf("Sanduíches", "Ajustes contra"), /50,00/);
    assert.equal(valorConf("Saladas", "Quantidade de vendas"), "100");
    assert.match(valorConf("Saladas", "Taxas e Comissões"), /550,00/);
    assert.match(valorConf("Operação da unidade", "Taxa de entregadores"), /3\.000,00/);
  });

  test("13: consolidado da Etapa 4 = critério de aceite (R$ 25.000, 11%, 10%, 12%, ticket R$ 50,00)", async () => {
    await lancarCenario20k5k();
    const c = (item) => valorConf("Consolidado da unidade", item);
    assert.equal(c("Quantidade total"), "500");
    assert.match(c("Valor bruto total"), /25\.000,00/);
    assert.equal(c("Novos clientes"), "60");
    assert.match(c("Ticket médio"), /50,00/);
    assert.match(c("Financeiro Oficial"), /25\.000,00/);
    assert.match(c("Taxas e Comissões"), /2\.750,00 \(11[,.]0+%\)/);
    assert.match(c("Serviços e Promoções"), /2\.500,00 \(10[,.]0+%\)/);
    assert.match(c("Taxa de entregadores"), /3\.000,00 \(12[,.]0+%\)/);
    assert.match(c("Ajustes a favor"), /100,00/);
    assert.match(c("Ajustes contra"), /50,00/);
    // Regra atual do formulário/servidor: total financeiro inclui ajustes contra; receita soma os a favor.
    assert.match(c("Total de deduções"), /8\.300,00 \(33[,.]2/);
    assert.match(c("Receita líquida"), /16\.800,00/);
  });

  test("12: consolidado é somente leitura — nenhum campo editável na Conferência", async () => {
    await lancarCenario20k5k();
    const editaveis = p.todos(".dex-form-corpo input, .dex-form-corpo textarea, .dex-form-corpo select")
      .filter((i) => !["checkbox"].includes(i.getAttribute("type")));
    assert.deepEqual(editaveis, []);
    assert.match(p.corpo(), /Somente leitura — o resultado da unidade é sempre a soma de Sanduíches e Saladas mais a taxa de entregadores da unidade/);
  });

  test("payload do cenário: Sanduíches e Saladas separados + entregadores UMA vez, nunca o total", async () => {
    await lancarCenario20k5k();
    const { body } = await p.finalizar();
    assert.equal(body.taxasEntregadores, 3000);
    assert.equal("valorVendasIfood" in body, false);
    assert.deepEqual(body.canais.map((c) => [c.valorVendasIfood, c.taxasComissoes, "taxasEntregadores" in c]), [[20000, 2200, false], [5000, 550, false]]);
  });

  test("Full Service: Etapa 4 diz que entregadores não se aplica e não soma nada", async () => {
    await lancarCenario20k5k(blocoSS({ entregadoresAplicavel: false }));
    assert.equal(valorConf("Operação da unidade", "Taxa de entregadores"), "Não se aplica (Full Service)");
    assert.equal(valorConf("Consolidado da unidade", "Taxa de entregadores"), undefined);
  });

  test("dia sem Financeiro: Etapa 4 com Desempenho por fonte e consolidado, sem blocos financeiros", async () => {
    await p.abrir({ get: getNovo(blocoSS(), false) });
    p.avancar();
    aba(SAND).click(); p.digitar("#dex-mc-qtd", "400"); p.digitar("#dex-mc-valorbruto", "20.000,00");
    aba(SAL).click(); p.digitar("#dex-mc-qtd", "100"); p.digitar("#dex-mc-valorbruto", "5.000,00");
    p.avancar();
    assert.deepEqual(p.todos(".dex-mc-conf-bloco").map((sec) => sec.getAttribute("aria-label")), ["Sanduíches", "Saladas", "Consolidado da unidade"]);
    assert.equal(valorConf("Consolidado da unidade", "Quantidade total"), "500");
    assert.match(valorConf("Consolidado da unidade", "Ticket médio"), /50,00/);
    assert.equal(valorConf("Consolidado da unidade", "Financeiro Oficial"), undefined);
    assert.match(p.corpo(), /Financeiro ainda não disponível para esta data/);
  });
});
