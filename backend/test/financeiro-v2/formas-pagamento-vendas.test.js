// Relatório SAIPOS de FORMAS DE PAGAMENTO por dia → uma venda por dia × forma, com canal/forma/processador do de-para
// da loja (dados 100% SINTÉTICOS). Roda em memória.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deParaFormaSaipos } from "../../src/modules/financeiro-v2/importacao/fontes/saipos.js";
import { ESCRITAS } from "../../src/modules/fv2-integracao/escritas.js";
import { ctx, montar } from "./helpers/cenario.js";
import { saiposVendas } from "./helpers/arquivos.js";
import { xlsx } from "./helpers/formatos.js";

const c = ctx();
const PERIODO = { periodoInicio: "2026-09-01", periodoFim: "2026-09-02" };
const ACEITE = { aceitarPendencias: true, justificativa: "Pendências sintéticas aceitas no teste." };

// [forma, dia 01, dia 02] em reais (texto como no relatório real; vazio = sem pagamento no dia)
const LINHAS = [
  ["Online iFood", "100.5", "50"],
  ["Pago Online via Pix", "30", ""],
  ["Débito Master", "20", "10"],
  ["Crédito Visa", "", "40"],
  ["Dinheiro", "15", "5"],
  ["Vale", "12", ""],
  ["Online Anotaai", "", "25"],
  ["Pago Online", "18", ""],
  ["Pix na Entrega", "", "7"],
  ["Voucher Parceiro Desconto", "3", "4"],
  ["Pagamento não cadastrado", "9", ""],
];
const centavos = (t) => (t ? Math.round(Number(t) * 100) : 0);
const formas = (linhas = LINHAS) => xlsx([{ nome: "Vendas por forma de pagamento", linhas: [
  ["Forma de pagamento", "Valor total dos pagamentos (R$)", "Quantidade de pagamentos", "%", "Dia - 01/09/2026", "Dia - 02/09/2026"],
  ...linhas.map(([f, a, b]) => [f, String((centavos(a) + centavos(b)) / 100), "1", "1,00 %", a, b]),
] }]);

async function importar(n, tipoRelatorio, conteudo, periodo = PERIODO) {
  const r = await n.receberArquivoParaImportacao(c, { fonte: "SAIPOS", tipoRelatorio, tipoMime: "application/octet-stream", conteudo, ...periodo });
  assert.equal(r.importacao.estado, "PRONTO_PARA_IMPORTAR", JSON.stringify(r.previa.erros));
  return (await n.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, ...(r.previa.totalDivergencias ? ACEITE : {}) })).importacao;
}
async function cenario() {
  const m = montar();
  const n = m.nucleo;
  const caixa = await n.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa" });
  const imp = await importar(n, "SAIPOS_FORMAS_PAGAMENTO", formas());
  const g = await n.gerarPropostas(c, { importacaoId: imp.id, contaCaixaId: caixa.id });
  return { n, caixa, imp, g };
}
const receita = async (n) => (await n.consultarComposicao(c, { competencia: "2026-09", indicador: "RECEITA_BRUTA" })).totalCentavos;
const lote = (n, imp) => ESCRITAS["/propostas/aprovar-e-aplicar-prontas"].fazer(n, c, { importacao: imp.id });

test("de-para das formas do SAIPOS: cartões na Stone, iFood, Anota AI, 99 Food, Pix na entrega; voucher e desconhecidas sem venda", () => {
  assert.deepEqual(deParaFormaSaipos("Débito Master"), { canal: "BALCAO", forma: "DEBITO", processador: "STONE" });
  assert.deepEqual(deParaFormaSaipos("Crédito Elo"), { canal: "BALCAO", forma: "CREDITO", processador: "STONE" });
  assert.equal(deParaFormaSaipos("Online iFood").canal, "IFOOD");
  assert.equal(deParaFormaSaipos("Pago Online via Pix").processador, "IFOOD");
  assert.equal(deParaFormaSaipos("Pago Online").descricao, "99 Food");
  assert.equal(deParaFormaSaipos("Online Anotaai").processador, "ANOTA_AI");
  assert.equal(deParaFormaSaipos("Pix na Entrega").processador, "STONE");
  assert.equal(deParaFormaSaipos("Dinheiro").caixa, true);
  assert.equal(deParaFormaSaipos("Pagamento não cadastrado").revisar, true);
  assert.equal(deParaFormaSaipos("Voucher Parceiro Desconto"), null);
  assert.equal(deParaFormaSaipos("Débito máquina outra marca"), null);
  assert.equal(deParaFormaSaipos("Forma inventada"), null);
});

test("uma proposta por dia × forma; voucher fica de fora; 'não cadastrado' vai para revisão; nada tem efeito antes de aplicar", async () => {
  const { n, imp, g } = await cenario();
  const celulas = LINHAS.filter(([f]) => f !== "Voucher Parceiro Desconto").reduce((s, [, a, b]) => s + (a ? 1 : 0) + (b ? 1 : 0), 0);
  assert.equal(g.criadas, celulas);
  assert.equal(g.semProposta, 1); // só o voucher
  const ps = await n.listarPropostas(c, { importacaoId: imp.id });
  assert.equal(ps.filter((p) => p.estado === "AGUARDANDO_REVISAO").length, 1);
  const debito = ps.find((p) => p.dataOperacao === "2026-09-01" && p.formaOriginal === "Débito Master");
  assert.equal(debito.comando.canal, "BALCAO");
  assert.deepEqual(debito.comando.pagamentos, [{ forma: "DEBITO", valorCentavos: 2000, processador: "STONE" }]);
  assert.equal(debito.granularidade, "DIA_POR_FORMA");
  assert.match(debito.comando.descricao, /01\/09\/2026: Débito Master/);
  assert.equal(await receita(n), 0);
});

test("aprovar e aplicar em lote: receita = soma das formas mapeadas; dinheiro entra no caixa; repetir não duplica", async () => {
  const { n, imp } = await cenario();
  const r = await lote(n, imp);
  const esperado = LINHAS.filter(([f]) => !["Voucher Parceiro Desconto", "Pagamento não cadastrado"].includes(f)).reduce((s, [, a, b]) => s + centavos(a) + centavos(b), 0);
  assert.equal(r.falhas.length, 0, JSON.stringify(r.falhas));
  assert.equal(r.valorCentavos, esperado);
  assert.equal(await receita(n), esperado);
  const dinheiro = (await n.listarPropostas(c, { importacaoId: imp.id })).find((p) => p.formaOriginal === "Dinheiro" && p.dataOperacao === "2026-09-01");
  assert.ok(dinheiro.efeitos.some((e) => e.tipo === "MOVIMENTACAO"));
  const deNovo = await lote(n, imp);
  assert.equal(deNovo.aplicadas, 0);
  assert.equal(await receita(n), esperado);
});

test("reimportar o mesmo relatório (ou um período maior com os mesmos dias) não cria vendas repetidas", async () => {
  const { n, caixa, imp } = await cenario();
  await lote(n, imp);
  const antes = await receita(n);
  const outro = await importar(n, "SAIPOS_FORMAS_PAGAMENTO", formas([...LINHAS, ["Crédito Elo", "1", ""]]));
  const g = await n.gerarPropostas(c, { importacaoId: outro.id, contaCaixaId: caixa.id });
  assert.equal(g.criadas, 1); // só a forma nova
  await lote(n, outro);
  assert.equal(await receita(n), antes + 100);
});

test("mesmo dia não recebe venda por forma e venda por pedido: a segunda é recusada", async () => {
  const { n, caixa, imp } = await cenario();
  await lote(n, imp);
  const ped = await importar(n, "SAIPOS_VENDAS", saiposVendas([{ pedido: "P-9", data: "01/09/2026 12:00", canal: "Balcão", itens: 3000, forma: "Dinheiro" }]), { periodoInicio: "2026-09-01", periodoFim: "2026-09-01" });
  await n.gerarPropostas(c, { importacaoId: ped.id, contaCaixaId: caixa.id });
  const r = await lote(n, ped);
  assert.equal(r.aplicadas, 0);
  assert.equal(r.falhas.length, 1);
});

test("o dia de hoje (ainda aberto) não vira venda; entra quando o relatório for reimportado depois", async () => {
  const n = montar({ relogio: () => new Date("2026-09-02T18:00:00Z") }).nucleo;
  const caixa = await n.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa" });
  const imp = await importar(n, "SAIPOS_FORMAS_PAGAMENTO", formas());
  await n.gerarPropostas(c, { importacaoId: imp.id, contaCaixaId: caixa.id });
  const ps = await n.listarPropostas(c, { importacaoId: imp.id });
  assert.ok(ps.length > 0);
  assert.ok(ps.every((p) => p.dataOperacao === "2026-09-01"));
});
