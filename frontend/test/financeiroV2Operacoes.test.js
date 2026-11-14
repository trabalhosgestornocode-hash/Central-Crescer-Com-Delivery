// Execução 08D — operações do dia a dia pela tela (jornada completa): registrar conta a pagar, pagar (saída + baixa numa
// transação), informar saldo. Demonstração local (núcleo REAL; dados sintéticos). Rodar: node --test frontend/test/financeiroV2Operacoes.test.js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import * as tes from "../financeiro-v2/telasTesouraria.js";
import * as conf from "../financeiro-v2/telasConferencias.js";
import { criarDemo, UNIDADES } from "../../backend/scripts/fv2/demoInterface.mjs";
import { auditarHtml } from "./acessibilidade/auditoria.js";

let demo;
const U1 = UNIDADES[0].id;
const OUT = { competencia: "2026-10" };
const tokens = {};
const ok = async (caminho, params, perfil = "administrador") => { const r = await demo.responder(caminho, { unidade: U1, ...params }, perfil); assert.equal(r.status, 200, JSON.stringify(r.corpo)); return r.corpo; };
const agir = (caminho, corpo, perfil = "administrador") => demo.agir(caminho, { unidade: U1, confirmar: true, ...corpo }, perfil, { csrf: tokens[perfil] });
const PERM = ["financeiro_v2.ver", "financeiro_v2.registrar"];
before(async () => {
  demo = await criarDemo();
  for (const p of ["administrador", "gestor"]) tokens[p] = (await ok("/api/fv2/sessao", {}, p)).csrf;
});

test("08D — registrar conta, pagar (saída + baixa juntas, sem duplicar) e informar saldo pela tela", async () => {
  const lista = await ok("/api/fv2/contas-a-pagar", OUT);
  const html = tes.contasAPagar(lista, OUT, { permissoes: PERM });
  assert.match(html, /data-acao="\/api\/fv2\/acoes\/obrigacoes\/registrar"/);
  assert.deepEqual(auditarHtml(html), []);
  assert.ok(!tes.contasAPagar(lista, OUT, { permissoes: ["financeiro_v2.ver"] }).includes("obrigacoes/registrar"), "só quem registra vê o formulário");
  assert.ok(lista.opcoesDeRegistro.categorias.some((c) => c.codigo === "DESPESAS_A_CLASSIFICAR") && !lista.opcoesDeRegistro.categorias.some((c) => /^VENDA_/.test(c.codigo)));
  const reg = await agir("/api/fv2/acoes/obrigacoes/registrar", { fornecedorNovo: "Gráfica Sintética", descricao: "Cardápios impressos (sintético)", valor: "350,00", categoria: "DESPESAS_ADMINISTRATIVAS_GERAIS", competencia: "2026-10", dataEmissao: "2026-10-06", vencimento: "2026-10-20" });
  assert.equal(reg.status, 200, JSON.stringify(reg.corpo));
  assert.match(conf.resultadoDaAcao({ ok: true, dados: reg.corpo }), /Conta registrada: 1 parcela/);
  assert.equal((await agir("/api/fv2/acoes/obrigacoes/registrar", { fornecedorNovo: "X", descricao: "Valor errado", valor: "12,345", categoria: "DESPESAS_ADMINISTRATIVAS_GERAIS", competencia: "2026-10", dataEmissao: "2026-10-06", vencimento: "2026-10-20" })).status, 400, "valor com 3 casas é recusado");
  assert.equal((await agir("/api/fv2/acoes/obrigacoes/registrar", { fornecedorNovo: "X", descricao: "y", valor: "1,00", categoria: "DESPESAS_ADMINISTRATIVAS_GERAIS", competencia: "2026-10", dataEmissao: "2026-10-06", vencimento: "2026-10-20" }, "gestor")).status, 403, "gestor só vê");
  const id = reg.corpo.obrigacoes[0].id;
  const det = await ok("/api/fv2/conta-a-pagar", { ...OUT, id });
  const htmlDet = tes.detalheAPagar(det, { permissoes: PERM });
  assert.match(htmlDet, /data-acao="\/api\/fv2\/acoes\/obrigacoes\/pagar"/);
  assert.deepEqual(auditarHtml(htmlDet), []);
  const corpoPag = { obrigacao: id, conta: det.contasParaPagar[0].id, dataEfetiva: "2026-10-10", valor: "350,00" };
  const pag = await agir("/api/fv2/acoes/obrigacoes/pagar", corpoPag);
  assert.equal(pag.status, 200, JSON.stringify(pag.corpo));
  assert.match(conf.resultadoDaAcao({ ok: true, dados: pag.corpo }), /saída e baixa da conta gravadas juntas/);
  const rep = await agir("/api/fv2/acoes/obrigacoes/pagar", corpoPag);
  assert.equal(rep.corpo.repetido, true, "repetir o mesmo pagamento não duplica");
  const depois = await ok("/api/fv2/conta-a-pagar", { ...OUT, id });
  assert.deepEqual([depois.titulo.saldoCentavos, depois.titulo.situacao, depois.titulo.pagamentos.length], [0, "PAGO", 1]);
  assert.equal((await agir("/api/fv2/acoes/obrigacoes/pagar", { ...corpoPag, dataEfetiva: "2026-10-11" })).status, 409, "não paga além do saldo");
  const movs = (await ok("/api/fv2/caixa-e-bancos", { ...OUT, inicio: "2026-10-01", fim: "2026-10-31" })).movimentos.filter((m) => m.data === "2026-10-11");
  assert.equal(movs.length, 0, "a saída recusada foi desfeita junto com a baixa (nada pela metade)");
  const caixa = await ok("/api/fv2/caixa-e-bancos", { ...OUT, inicio: "2026-10-01", fim: "2026-10-31" });
  const htmlCx = tes.caixaEBancos(caixa, { contas: caixa.contas.map((c) => ({ id: c.id, nome: c.nome })) }, { permissoes: PERM });
  assert.deepEqual(auditarHtml(htmlCx), []);
  const saldo = await agir("/api/fv2/acoes/saldos/registrar", { conta: caixa.contas[0].id, data: "2026-10-31", referencia: "FIM_DO_DIA", valor: "100,00" });
  assert.equal(saldo.status, 200, JSON.stringify(saldo.corpo));
  assert.match(conf.resultadoDaAcao({ ok: true, dados: saldo.corpo }), /Saldo informado registrado/);
});
