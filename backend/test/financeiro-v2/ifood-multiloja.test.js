// Conciliação iFood com DUAS lojas na mesma unidade (ex.: Subway + Subway Saladas) e pedido em andamento no último dia.
// Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { consolidarConciliacaoIfood, lojaPrincipal } from "../../src/modules/financeiro-v2/importacao/fontes/ifoodConciliacao.js";

const A = "aaaaaaaa-1111-4000-8000-000000000001"; // loja principal (mais movimentos)
const B = "bbbbbbbb-2222-4000-8000-000000000002"; // segunda loja da unidade
let seq = 0;
const mov = (loja, pedido, componente, valor, { data = "2026-11-03", fato = "Venda", cesta = 3000, impacta = true } = {}) => ({
  data, competencia: data.slice(0, 7), valorCentavos: valor, linha: (seq += 1),
  dados: { estabelecimento: loja, pedido, pedidoCurto: pedido.slice(-4), dataPedido: data, componente, fatoGerador: fato, cestaCentavos: cesta, descricaoOriginal: componente,
    apuracaoInicio: "2026-11-02", apuracaoFim: "2026-11-08", repasseEsperado: "2026-12-02", impactaRepasse: impacta, idSaldo: `s-${loja}`, competenciaInformada: data.slice(0, 7) },
});
const venda = (loja, pedido, o = {}) => [mov(loja, pedido, "ENTRADA", 3000, o), mov(loja, pedido, "COMISSAO", -300, o), mov(loja, pedido, "TRANSACAO", -90, o)];

test("repasse previsto separado por loja; a loja principal mantém a chave antiga (sem loja)", () => {
  const regs = [...venda(A, "p-a1"), ...venda(A, "p-a2"), ...venda(B, "p-b1")];
  assert.equal(lojaPrincipal(regs), A);
  const { resumo } = consolidarConciliacaoIfood(regs, { conferirSaldos: false });
  const porLoja = Object.fromEntries(resumo.repasses.map((r) => [r.loja ?? "PRINCIPAL", r.previstoCentavos]));
  assert.deepEqual(porLoja, { PRINCIPAL: 2 * 2610, [B]: 2610 });
  assert.equal(resumo.lojaPrincipal, A);
  // Os dias continuam com o faturamento das duas lojas juntas (mesma unidade).
  assert.equal(resumo.dias[0].itensCentavos, 3 * 3000);
});

test("pedido do último dia ainda sem entrada: fica fora dos lançamentos (aviso), sem bloquear e sem perder o líquido", () => {
  const regs = [...venda(A, "p-1", { data: "2026-11-23" }), mov(A, "p-hoje", "TAXA_DO_CLIENTE", -99, { data: "2026-11-24", cesta: 2550 }), mov(A, "p-hoje", "TRANSACAO", -73, { data: "2026-11-24", cesta: 2550 })];
  const { resumo, divergencias } = consolidarConciliacaoIfood(regs, { conferirSaldos: false });
  assert.deepEqual(resumo.pedidosEmAndamento.map((p) => [p.pedido, p.data, p.liquidoCentavos]), [["hoje", "2026-11-24", -172]]);
  assert.ok(!divergencias.some((d) => d.codigo === "LINHA_NAO_FECHA"), "não bloqueia");
  const hoje = resumo.dias.find((d) => d.data === "2026-11-24");
  assert.deepEqual([hoje.itensCentavos, hoje.entregaLojaCentavos, hoje.liquidoCentavos], [0, 0, -172]);
  assert.ok(!divergencias.some((d) => d.codigo === "TOTAL_NAO_CONFERE"), "líquido continua fechando com o repasse");
});

test("pedido sem entrada em dia ANTERIOR ao último continua sendo divergência (nada é escondido)", () => {
  const regs = [mov(A, "p-velho", "TAXA_DO_CLIENTE", -99, { data: "2026-11-20", cesta: 2550 }), ...venda(A, "p-2", { data: "2026-11-24" })];
  const { divergencias, resumo } = consolidarConciliacaoIfood(regs, { conferirSaldos: false });
  assert.equal(resumo.pedidosEmAndamento.length, 0);
  assert.ok(divergencias.some((d) => d.codigo === "LINHA_NAO_FECHA"));
});
