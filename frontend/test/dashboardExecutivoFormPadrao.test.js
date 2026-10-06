// Regressão do formulário de lançamento PADRÃO do Dashboard iFood depois do
// multicanal (Checkpoint E). Mesmos roteiros usados no baseline capturado
// ANTES da mudança: os payloads abaixo são os que o formulário antigo enviava,
// literalmente — e nenhuma etapa pode exibir nada do multicanal.
//
// Rodar: node --test frontend/test/dashboardExecutivoFormPadrao.test.js
import { test } from "node:test";
import assert from "node:assert/strict";

const p = await import("./helpers/pilotoFormularioDex.js");

const DISP = { disponivel: true, status: "PENDENTE" };
const novo = (mostrarFinanceiro) => ({ lancamento: null, disponibilidade: DISP, mostrarFinanceiro, financeiroPorDesbloqueio: false, periodoFinanceiroInicio: "2026-09-01", periodoFinanceiroFim: "2026-09-02" });
const semMulticanal = () => assert.doesNotMatch(p.html(), /dex-mc-|Situação por canal|Consolidado da unidade|Operação logística|role="tab"/);

test("32: dia normal com Financeiro — 4 etapas, mesmos campos e o MESMO payload de antes", async () => {
  await p.abrir({ get: novo(true) });
  assert.equal(p.etapa(), "1 4 Situação da operação"); semMulticanal();
  p.marcar('input[value="normal"]'); p.avancar();
  assert.equal(p.etapa(), "2 4 Desempenho (opcional)"); semMulticanal();
  p.digitar("#dex-qtd", "550"); p.digitar("#dex-valorbruto", "26.000,00"); p.digitar("#dex-novos", "48");
  p.avancar();
  assert.equal(p.etapa(), "3 4 Financeiro"); semMulticanal();
  assert.ok(p.sel("#dex-entregadores"), "campo de entregadores do modo padrão continua");
  p.digitar("#dex-vifood", "26.682,29"); p.digitar("#dex-taxas", "3.468,70"); p.digitar("#dex-servicos", "1.334,12");
  p.digitar("#dex-entregadores", "120,00"); p.digitar("#dex-aj-favor", "10,00");
  p.avancar();
  assert.equal(p.etapa(), "4 4 Conferência"); semMulticanal();
  const { body } = await p.finalizar();
  assert.deepEqual(body, {
    unidadeId: "u1", data: "2026-09-02", situacao: "normal", status: "finalizado", qtdVendas: 550, valorVendasBruto: 26000, novosClientes: 48,
    valorVendasIfood: 26682.29, taxasComissoes: 3468.7, servicosPromocoes: 1334.12, taxasEntregadores: 120, ajustesFavorLoja: 10, confirmarAvisos: false,
  });
});

test("32: rascunho reaberto vai para a etapa pendente e salva o mesmo payload de antes", async () => {
  await p.abrir({ get: { ...novo(true), lancamento: { id: "l1", status: "rascunho", updatedAt: "2026-09-02T10:00:00.000Z", situacao: "normal", qtdVendas: 5, valorVendasBruto: 100, novosClientes: null, valorVendasIfood: null, taxasComissoes: null, servicosPromocoes: null, taxasEntregadores: null, ajustesFavorLoja: null, ajustesContraLoja: null } } });
  assert.equal(p.etapa(), "3 4 Financeiro"); semMulticanal();
  const { body } = await p.salvarRascunho();
  assert.deepEqual(body, { unidadeId: "u1", data: "2026-09-02", situacao: "normal", status: "rascunho", seVersao: "2026-09-02T10:00:00.000Z", qtdVendas: 5, valorVendasBruto: 100, confirmarAvisos: false });
});

test("32: sem operação e dia sem Financeiro — payloads de antes", async () => {
  await p.abrir({ get: novo(true) });
  p.marcar('input[value="sem_operacao"]'); p.avancar(); p.avancar(); p.avancar();
  semMulticanal();
  assert.deepEqual((await p.finalizar()).body, { unidadeId: "u1", data: "2026-09-02", situacao: "sem_operacao", status: "finalizado", motivoSemOperacao: "Folga" });

  await p.abrir({ get: novo(false) });
  p.avancar(); p.digitar("#dex-qtd", "10"); semMulticanal();
  assert.deepEqual((await p.salvarRascunho()).body, { unidadeId: "u1", data: "2026-09-02", situacao: "normal", status: "rascunho", qtdVendas: 10 });
});

test("32: Full Service no modo padrão continua escondendo entregadores pela regra de sempre", async () => {
  await p.abrir({ get: novo(true), modeloLogistico: "full_service" });
  p.avancar(); p.avancar();
  assert.equal(p.sel("#dex-entregadores"), null);
  assert.match(p.corpo(), /Este modelo \(Full Service\) não usa entregador próprio/);
});
