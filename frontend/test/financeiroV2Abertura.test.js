// Abertura financeira na interface (visual Crescer Com Delivery Financeiro): formulários puros + CONTRATO com as ações do
// servidor + estados da abertura persistida + jornada na demonstração. Dados SINTÉTICOS; nenhum valor real.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as ab from "../financeiro-v2/telasAbertura.js";
import * as adm from "../financeiro-v2/telasAdministracao.js";
import * as tes from "../financeiro-v2/telasTesouraria.js";
import { ESCRITAS } from "../../backend/src/modules/fv2-integracao/escritas.js";
import { criarDemo, UNIDADES } from "../../backend/scripts/fv2/demoInterface.mjs";

const TODAS = ["financeiro_v2.configurar", "financeiro_v2.registrar", "financeiro_v2.ver", "financeiro_v2.reabrir"];
/** Cada formulário `data-acao` → { caminho do servidor, nomes dos campos (sem "confirmar"), campos com valor pré-preenchido }. */
function formularios(html) {
  return [...html.matchAll(/<form class="acao[^"]*" data-acao="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)].map(([, url, corpo]) => ({
    caminho: url.replace("/api/fv2/acoes", ""),
    campos: [...corpo.matchAll(/<(?:input|select)[^>]*name="([^"]+)"/g)].map((m) => m[1]).filter((n) => n !== "confirmar"),
    preenchidos: [...corpo.matchAll(/<input(?![^>]*type="(?:hidden|month)")[^>]*name="([^"]+)"[^>]*value="([^"]+)"/g)].map((m) => m[1]),
  }));
}
const exigirContrato = (fs) => {
  for (const f of fs) {
    const e = ESCRITAS[f.caminho];
    assert.ok(e, `o servidor tem a ação ${f.caminho}`);
    for (const c of f.campos) assert.ok(e.campos.includes(c), `${f.caminho}: o servidor aceita o campo ${c}`);
  }
};
const contas = [{ id: "c1", nome: "Unicred", tipo: "BANCARIA", ativa: true }, { id: "c2", nome: "Caixa físico", tipo: "CAIXA_FISICO", ativa: true }];
const configuracoes = { contas, planoDeContas: { categorias: 0 }, competencias: [], voce: { podeConfigurar: true } };
const ABERTA = { id: "a1", competenciaInicio: "2026-11", dataDeCorte: "2026-10-31", situacao: "CONFIGURADA", versao: 1, atualizadoEm: "2026-11-15T12:00:00Z", observacao: null };
const VAZIAS = { saldos: [], obrigacoesAnteriores: { quantidade: 0, totalCentavos: 0 }, recebiveisAnteriores: { quantidade: 0, totalCentavos: 0, emAbertoCentavos: 0 } };

test("sem abertura: proposta 11/2026 (editável), só configurar, plano e conta; nenhum formulário de posição", () => {
  assert.equal(ab.vespera("2026-11"), "2026-10-31");
  const html = adm.configuracoes({ abertura: null, posicoes: null, configuracoes }, { secao: "abertura" }, { permissoes: TODAS });
  assert.match(html, /aria-current="page">Abertura financeira/);
  assert.match(html, /não configurada/);
  assert.match(html, /novembro de 2026/i);
  assert.match(html, /31\/10\/2026/);
  const fs = formularios(html);
  assert.deepEqual(fs.map((f) => f.caminho), ["/abertura/configurar", "/configuracoes/implantar-plano", "/configuracoes/conta/criar"]);
  exigirContrato(fs);
  assert.match(html, /name="competencia" value="2026-11"/, "proposta no campo, editável — não é abertura executada");
  for (const f of fs) assert.deepEqual(f.preenchidos, [], `${f.caminho}: nenhum valor preenchido`);
});

test("abertura em andamento: posições usam a abertura gravada (sem competência no formulário), com o contrato do servidor", () => {
  const html = adm.configuracoes({ abertura: ABERTA, posicoes: VAZIAS, configuracoes }, { secao: "abertura" }, { permissoes: TODAS });
  const fs = formularios(html);
  assert.deepEqual(fs.map((f) => f.caminho), ["/abertura/configurar", "/configuracoes/implantar-plano", "/configuracoes/conta/criar", "/abertura/saldo", "/abertura/obrigacao-anterior", "/abertura/recebivel-anterior"]);
  exigirContrato(fs);
  for (const c of ["/abertura/saldo", "/abertura/obrigacao-anterior", "/abertura/recebivel-anterior"]) assert.ok(!fs.find((f) => f.caminho === c).campos.includes("competencia"), `${c}: competência vem da abertura`);
  assert.ok(fs.find((f) => f.caminho === "/abertura/configurar").campos.includes("justificativa"), "mudar exige justificativa");
  assert.ok(fs.find((f) => f.caminho === "/abertura/recebivel-anterior").campos.includes("identificador"));
  assert.match(html, /max="2026-10-31"/, "datas de origem limitadas ao corte");
  assert.match(html, /não afirma que conferiu um anexo/);
  for (const f of fs) assert.deepEqual(f.preenchidos, [], `${f.caminho}: nenhum valor preenchido`);
  // Com posições: não muda mais a competência; aparece "concluir".
  const comPos = formularios(adm.configuracoes({ abertura: ABERTA, posicoes: { ...VAZIAS, saldos: [{ contaId: "c1", valorCentavos: 1 }] }, configuracoes }, { secao: "abertura" }, { permissoes: TODAS })).map((f) => f.caminho);
  assert.ok(!comPos.includes("/abertura/configurar") && comPos.includes("/abertura/concluir"));
  // Concluída: nenhuma posição nova; reabrir só para quem tem a ação (e, na plataforma, com 2º fator).
  const concluida = { abertura: { ...ABERTA, situacao: "CONCLUIDA" }, posicoes: VAZIAS, configuracoes };
  const cs = formularios(adm.configuracoes(concluida, { secao: "abertura" }, { permissoes: TODAS })).map((f) => f.caminho);
  assert.ok(!cs.includes("/abertura/saldo") && cs.includes("/abertura/reabrir"));
  assert.equal(ESCRITAS["/abertura/reabrir"].sensivel({}), "financeiro_v2.reabrir");
  assert.ok(!formularios(adm.configuracoes(concluida, { secao: "abertura" }, { permissoes: TODAS.filter((x) => x !== "financeiro_v2.reabrir") })).some((f) => f.caminho === "/abertura/reabrir"));
  // Sem permissão: só o roteiro.
  assert.equal(formularios(adm.configuracoes({ abertura: ABERTA, posicoes: VAZIAS, configuracoes }, { secao: "abertura" }, { permissoes: ["financeiro_v2.ver"] })).length, 0);
});

test("caixa físico e contas a receber: formulários só para quem registra, conforme a sessão aberta, com o contrato do servidor", () => {
  const ctx = { permissoes: TODAS, competencia: "2026-11" };
  const semSessao = ab.formulariosDeCaixa([{ id: "cx", nome: "Caixa físico", tipo: "CAIXA_FISICO", sessoesDeCaixa: [] }, { id: "b", nome: "Unicred", tipo: "BANCARIA" }], ctx);
  assert.deepEqual(formularios(semSessao).map((f) => f.caminho), ["/caixa/abrir"]);
  const aberta = ab.formulariosDeCaixa([{ id: "cx", nome: "Caixa físico", tipo: "CAIXA_FISICO", sessoesDeCaixa: [{ id: "s1", situacao: "ABERTA", dataAbertura: "2026-11-01" }] }, { id: "b", nome: "Unicred", tipo: "BANCARIA" }], ctx);
  const fs = formularios(aberta);
  assert.deepEqual(fs.map((f) => f.caminho), ["/caixa/operacao", "/caixa/fechar"]);
  exigirContrato([...formularios(semSessao), ...fs]);
  assert.equal(ab.formulariosDeCaixa([{ id: "cx", tipo: "CAIXA_FISICO", sessoesDeCaixa: [] }], { permissoes: ["financeiro_v2.ver"] }), "");
  // Sessão aberta FORA do período exibido: não oferece "abrir"; oferece operar e fechar.
  assert.deepEqual(formularios(ab.formulariosDeCaixa([{ id: "cx", nome: "Caixa", tipo: "CAIXA_FISICO", sessoesDeCaixa: [], sessaoAberta: { id: "s9", dataAbertura: "2026-11-10" } }], ctx)).map((f) => f.caminho), ["/caixa/operacao", "/caixa/fechar"]);
  const receber = formularios(ab.formRecebivelDoPeriodo(ctx));
  exigirContrato(receber);
  assert.ok(!receber[0].campos.includes("processador"), "repasse de processador não entra à mão");
  const vazio = { dataBase: "2026-11-12", totais: { registros: 0 }, itens: [], porDevedor: [], paginacao: null };
  assert.match(tes.contasAReceber(vazio, {}, ctx), /acoes\/recebiveis\/registrar/);
  assert.ok(!tes.contasAReceber(vazio, {}, {}).includes("recebiveis/registrar"));
});

test("visual: os formulários usam os componentes e tokens do sistema visual (claro/escuro e celular)", () => {
  const css = readFileSync(new URL("../financeiro-v2/fv2.css", import.meta.url), "utf8");
  for (const s of [".campos-form", ".acao input:not([type=\"checkbox\"])", ".roteiro-abertura .passo", ".acoes-form"]) assert.ok(css.includes(s), `estilo ${s}`);
  const bloco = css.slice(css.indexOf("/* Abertura financeira e formulários"), css.indexOf("@media (prefers-reduced-motion"));
  assert.ok(bloco.length > 100 && !/#[0-9a-f]{3,6}\b/i.test(bloco), "sem cores fixas: só variáveis (o tema escuro troca as variáveis)");
  const html = ab.abertura({ abertura: ABERTA, posicoes: VAZIAS, configuracoes }, { permissoes: TODAS });
  assert.ok(!/style="/.test(html), "sem estilo inline (CSP)");
  assert.ok(html.includes('class="card card--destaque"') && html.includes("selo selo--"));
});

let demo;
const U1 = UNIDADES[0].id;
const csrf = async (perfil) => (await demo.responder("/api/fv2/sessao", {}, perfil)).corpo.csrf;
const agir = async (caminho, corpo, perfil = "administrador") => demo.agir(caminho, { unidade: U1, confirmar: true, ...corpo }, perfil, { csrf: await csrf(perfil) });
const ler = async (caminho, params = {}) => { const r = await demo.responder(caminho, { unidade: U1, ...params }, "administrador"); assert.equal(r.status, 200, JSON.stringify(r.corpo)); return r.corpo; };
before(async () => { demo = await criarDemo(); });

test("jornada na demonstração: 11/2026 é INCOMPATÍVEL com o histórico sintético; um início anterior é gravado e usado pelos formulários", async () => {
  // A demonstração tem vendas e despesas de setembro a novembro: um início em 11/2026 contaria tudo isso de novo.
  const incompativel = await agir("/api/fv2/acoes/abertura/configurar", { competencia: "2026-11" });
  assert.equal(incompativel.status, 409, JSON.stringify(incompativel.corpo));
  assert.match(incompativel.corpo.mensagem, /seriam contados junto com as posições de abertura/);
  const semAbertura = await ler("/api/fv2/abertura");
  assert.equal(semAbertura.abertura, null);
  assert.match(adm.configuracoes(semAbertura, { secao: "abertura" }, { permissoes: TODAS }), /não configurada/);
  // Antes de todo o histórico (corte 31/12/2025): compatível.
  const cfg = await agir("/api/fv2/acoes/abertura/configurar", { competencia: "2026-01" });
  assert.equal(cfg.status, 200, JSON.stringify(cfg.corpo));
  assert.equal((await agir("/api/fv2/acoes/configuracoes/conta/criar", { tipo: "BANCARIA", nome: "Outra" }, "operador")).status, 403, "operador não configura");
  const conta = await agir("/api/fv2/acoes/configuracoes/conta/criar", { tipo: "BANCARIA", nome: "Conta de abertura sintética" });
  const saldo = await agir("/api/fv2/acoes/abertura/saldo", { conta: conta.corpo.id, valor: "1.500,00", origem: "Extrato sintético de 31/12" });
  assert.equal(saldo.status, 200, JSON.stringify(saldo.corpo));
  assert.deepEqual([saldo.corpo.saldo.data, saldo.corpo.abertura.competenciaInicio], ["2025-12-31", "2026-01"]);
  const titulo = { fornecedorNovo: "Fornecedor de abertura sintético", descricao: "NF sintética 9", valor: "200,00", dataEmissao: "2025-12-10", vencimento: "2026-01-15", origem: "Lista sintética de 31/12", identificador: "NF 9", chave: globalThis.crypto.randomUUID() };
  const t1 = await agir("/api/fv2/acoes/abertura/obrigacao-anterior", titulo);
  assert.equal(t1.status, 200, JSON.stringify(t1.corpo));
  assert.equal((await agir("/api/fv2/acoes/abertura/obrigacao-anterior", titulo)).corpo.repetido, true, "reenvio não duplica");
  const q = await ler("/api/fv2/abertura");
  assert.deepEqual([q.abertura.competenciaInicio, q.posicoes.saldos.length, q.posicoes.obrigacoesAnteriores.totalCentavos], ["2026-01", 1, 20000]);
  const html = adm.configuracoes(q, { secao: "abertura" }, { permissoes: TODAS });
  assert.match(html, /Conta de abertura sintética/);
  assert.match(html, /1 título\(s\)/);
  assert.ok(formularios(html).some((f) => f.caminho === "/abertura/concluir"));
});
