// Aba "Dashboard iFood" da página de unidade do SuperAdmin — produto
// simplificado (Checkpoint F): UMA opção, "Considerar Sanduíches + Saladas".
// Sem jsdom — DOM mínimo (test/helpers/domMinimo.js).
//
// Rodar: node --test frontend/test/adminUnidadeDashboardIfood.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { instalarDomMinimo } from "./helpers/domMinimo.js";

const doc = instalarDomMinimo();
const { adminApi } = await import("../src/adminApi.js");
const { corpoDashboardIfood, ligarDashboardIfood, corpoParaSalvar } = await import("../src/adminUnidadeDashboardIfood.js");
const { abrirPaginaUnidade } = await import("../src/adminUnidadeDetalhe.js");

const resposta = (extra = {}) => ({
  unidadeId: "u1", unidadeNome: "Unidade A", organizacaoId: "o1", versao: "v1",
  modulo: { id: "ifood_dashboard", disponivelNaEmpresa: true, habilitadoNaUnidade: true, ativo: true },
  modeloLogistico: "marketplace", entregadoresAplicavel: true, migracaoPendente: false,
  estrutura: "padrao", sanduichesSaladas: false, canais: [],
  ...extra,
});

async function montarAba(r) {
  adminApi.dashboardIfoodDaUnidade = async () => r;
  const raiz = doc.createElement("div");
  doc.body.filhos = [];
  doc.body.appendChild(raiz);
  raiz.innerHTML = await corpoDashboardIfood("u1");
  const salvos = [];
  ligarDashboardIfood({ unidadeId: "u1", irParaAcessos: () => salvos.push("acessos"), salvar: async (fn, msg) => { salvos.push(msg); await fn(); } });
  return { raiz, salvos };
}

describe("aba Dashboard iFood — opção única", () => {
  test("mostra só a opção 'Considerar Sanduíches + Saladas', com o texto auxiliar pedido", async () => {
    const { raiz } = await montarAba(resposta());
    const html = raiz.innerHTML;
    assert.match(html, /Considerar Sanduíches \+ Saladas no Dashboard iFood/);
    assert.match(html, /passa a considerar separadamente Sanduíches e Saladas e consolida os dois no resultado da unidade\. A taxa de entregadores continua sendo informada uma única vez\./);
    assert.equal(raiz.querySelectorAll('input[type="checkbox"]').length, 1);
    assert.equal(raiz.querySelector("#ud-dif-sanduiches-saladas").checked, false);
  });

  test("nada de gestão genérica: sem criar/renomear/ordenar/ativar canal e sem escolher escopo", async () => {
    const { raiz } = await montarAba(resposta({ sanduichesSaladas: true, estrutura: "multicanal" }));
    const html = raiz.innerHTML;
    assert.doesNotMatch(html, /Adicionar canal|Renomear|Desativar|Reativar|↑|↓|Separada por canal|Compartilhada pela unidade|type="radio"|type="text"/);
    assert.equal(raiz.querySelector("#ud-dif-sanduiches-saladas").checked, true);
  });

  test("salvar manda só { sanduichesSaladas, versao }", async () => {
    let enviado;
    adminApi.salvarDashboardIfoodDaUnidade = async (_id, corpo) => { enviado = corpo; return {}; };
    const { raiz, salvos } = await montarAba(resposta());
    raiz.querySelector("#ud-dif-sanduiches-saladas").checked = true;
    raiz.querySelector("#ud-dif-salvar").click();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(enviado, { sanduichesSaladas: true, versao: "v1" });
    assert.match(salvos.at(-1), /Sanduíches \+ Saladas ativado/);
    assert.deepEqual(corpoParaSalvar(0, "v9"), { sanduichesSaladas: false, versao: "v9" });
  });

  test("desligar manda false; sem mudança não chama a API", async () => {
    let chamadas = 0;
    adminApi.salvarDashboardIfoodDaUnidade = async () => { chamadas++; return {}; };
    const { raiz } = await montarAba(resposta({ sanduichesSaladas: true }));
    raiz.querySelector("#ud-dif-salvar").click();
    assert.equal(chamadas, 0, "marcado = já ligado -> nada a salvar");
    raiz.querySelector("#ud-dif-sanduiches-saladas").checked = false;
    raiz.querySelector("#ud-dif-salvar").click();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(chamadas, 1);
  });

  test("módulo inativo mostra o motivo e o atalho para Acessos; migration pendente mostra aviso sem opção", async () => {
    const r1 = await montarAba(resposta({ modulo: { id: "ifood_dashboard", disponivelNaEmpresa: true, habilitadoNaUnidade: false, ativo: false } }));
    assert.match(r1.raiz.innerHTML, /não está habilitado para esta unidade/);
    r1.raiz.querySelector("#ud-dif-acessos").click();
    assert.deepEqual(r1.salvos, ["acessos"]);
    const r2 = await montarAba(resposta({ migracaoPendente: true }));
    assert.match(r2.raiz.innerHTML, /ainda não está disponível neste ambiente/);
    assert.equal(r2.raiz.querySelector("#ud-dif-sanduiches-saladas"), null);
  });
});

describe("regressão — página de detalhe da unidade", () => {
  test("abas existentes continuam, na mesma ordem, com 'Dashboard iFood' entre Acessos e Usuários", async () => {
    const view = doc.createElement("div");
    view.setAttribute("id", "adm-view");
    doc.body.filhos = [];
    doc.body.appendChild(view);
    adminApi.unidade = async () => ({ id: "u1", nome: "Unidade A", ativo: true, empresa: { id: "o1", nome: "Empresa" }, metricas: {}, criadoEm: null, ultimaAtividade: null });
    adminApi.dashboardIfoodDaUnidade = async () => resposta();
    await abrirPaginaUnidade("u1");
    const abas = view.querySelectorAll(".adm-aba").map((b) => b.dataset.aba);
    assert.deepEqual(abas, ["informacoes", "acessos", "dashboard-ifood", "usuarios", "dados", "auditoria"]);
  });
});
