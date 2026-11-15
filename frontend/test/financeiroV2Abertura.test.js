// Abertura financeira (doc 29) na interface: formulários puros + CONTRATO com as ações do servidor + jornada na demonstração.
// Dados SINTÉTICOS; nenhum valor real.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import * as ab from "../financeiro-v2/telasAbertura.js";
import * as adm from "../financeiro-v2/telasAdministracao.js";
import * as tes from "../financeiro-v2/telasTesouraria.js";
import { ESCRITAS } from "../../backend/src/modules/fv2-integracao/escritas.js";
import { criarDemo, UNIDADES } from "../../backend/scripts/fv2/demoInterface.mjs";

const TODAS = ["financeiro_v2.configurar", "financeiro_v2.registrar", "financeiro_v2.consultar"];
/** Cada formulário `data-acao` do HTML → { caminho do servidor, nomes dos campos (sem a caixa "confirmar"), campos com valor }. */
function formularios(html) {
  return [...html.matchAll(/<form class="acao" data-acao="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)].map(([, url, corpo]) => ({
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

test("seção Abertura financeira: roteiro, competência proposta 11/2026 e véspera 31/10, formulários com o contrato do servidor", () => {
  assert.equal(ab.vespera("2026-11"), "2026-10-31");
  assert.equal(ab.vespera("2026-03"), "2026-02-28");
  const cfg = { contas: [{ id: "c1", nome: "Unicred", tipo: "BANCARIA", ativa: true }, { id: "c2", nome: "Caixa físico", tipo: "CAIXA_FISICO", ativa: true }], planoDeContas: { categorias: 0 }, competencias: [], voce: { podeConfigurar: true } };
  const html = adm.configuracoes(cfg, { secao: "abertura" }, { unidadeNome: "Unidade sintética", permissoes: TODAS });
  assert.match(html, /aria-current="page">Abertura financeira/);
  assert.match(html, /novembro de 2026/i);
  assert.match(html, /31\/10\/2026/);
  assert.match(html, /sujeita à confirmação do proprietário/);
  assert.match(html, /ainda não implantado/);
  assert.match(html, /não afirma que conferiu um anexo/);
  const fs = formularios(html);
  assert.deepEqual(fs.map((f) => f.caminho), ["/configuracoes/implantar-plano", "/configuracoes/conta/criar", "/abertura/saldo", "/abertura/obrigacao-anterior", "/abertura/recebivel-anterior"]);
  exigirContrato(fs);
  for (const f of fs) assert.deepEqual(f.preenchidos, [], `${f.caminho}: nenhum valor preenchido automaticamente`);
  assert.ok(!fs.find((f) => f.caminho === "/configuracoes/conta/criar").campos.some((c) => /saldo|valor/.test(c)), "cadastro de conta sem saldo");
  assert.ok(fs.find((f) => f.caminho === "/abertura/obrigacao-anterior").campos.includes("chave"), "reenvio idempotente");
  assert.ok(fs.find((f) => f.caminho === "/abertura/saldo").campos.includes("origem"));
  // Sem permissão: só o roteiro e a explicação.
  const leitor = adm.configuracoes(cfg, { secao: "abertura" }, { permissoes: ["financeiro_v2.consultar"] });
  assert.equal(formularios(leitor).length, 0);
  assert.match(leitor, /exige a permissão "configurar"/);
});

test("caixa físico e contas a receber: formulários só para quem registra, conforme a sessão aberta, com o contrato do servidor", () => {
  const ctx = { permissoes: TODAS, competencia: "2026-11" };
  const semSessao = ab.formulariosDeCaixa([{ id: "cx", nome: "Caixa físico", tipo: "CAIXA_FISICO", sessoesDeCaixa: [] }, { id: "b", nome: "Unicred", tipo: "BANCARIA" }], ctx);
  assert.deepEqual(formularios(semSessao).map((f) => f.caminho), ["/caixa/abrir"]);
  const aberta = ab.formulariosDeCaixa([{ id: "cx", nome: "Caixa físico", tipo: "CAIXA_FISICO", sessoesDeCaixa: [{ id: "s1", situacao: "ABERTA", dataAbertura: "2026-11-01" }] }, { id: "b", nome: "Unicred", tipo: "BANCARIA" }], ctx);
  const fs = formularios(aberta);
  assert.deepEqual(fs.map((f) => f.caminho), ["/caixa/operacao", "/caixa/fechar"]);
  exigirContrato([...formularios(semSessao), ...fs]);
  assert.match(aberta, /não é faturamento|NÃO gera ajuste automático/);
  assert.equal(ab.formulariosDeCaixa([{ id: "cx", tipo: "CAIXA_FISICO", sessoesDeCaixa: [] }], { permissoes: ["financeiro_v2.consultar"] }), "");
  const receber = ab.formRecebivelDoPeriodo(ctx);
  exigirContrato(formularios(receber));
  assert.ok(!formularios(receber)[0].campos.includes("processador"), "repasse de processador não entra à mão");
  const tela = tes.contasAReceber({ dataBase: "2026-11-12", totais: { registros: 0 }, itens: [], porDevedor: [], paginacao: null }, {}, ctx);
  assert.match(tela, /acoes\/recebiveis\/registrar/);
  assert.ok(!tes.contasAReceber({ dataBase: "2026-11-12", totais: { registros: 0 }, itens: [], porDevedor: [], paginacao: null }, {}, {}).includes("recebiveis/registrar"));
});

let demo;
const U1 = UNIDADES[0].id;
const csrf = async (perfil) => (await demo.responder("/api/fv2/sessao", {}, perfil)).corpo.csrf;
const agir = async (caminho, corpo, perfil = "administrador") => demo.agir(caminho, { unidade: U1, confirmar: true, ...corpo }, perfil, { csrf: await csrf(perfil) });
const ler = async (caminho, params = {}) => { const r = await demo.responder(caminho, { unidade: U1, ...params }, "administrador"); assert.equal(r.status, 200, JSON.stringify(r.corpo)); return r.corpo; };
before(async () => { demo = await criarDemo(); });

test("jornada de abertura na demonstração: conta nova, saldo da véspera, títulos anteriores fora da DRE, caixa; reenvio não duplica", async () => {
  const dreAntes = await ler("/api/fv2/dre", { competencia: "2026-11" });
  const conta = await agir("/api/fv2/acoes/configuracoes/conta/criar", { tipo: "BANCARIA", nome: "Conta de abertura sintética", instituicao: "Banco Sintético" });
  assert.equal(conta.status, 200, JSON.stringify(conta.corpo));
  assert.equal((await agir("/api/fv2/acoes/configuracoes/conta/criar", { tipo: "BANCARIA", nome: "Conta de abertura sintética", instituicao: "Banco Sintético" })).corpo.id, conta.corpo.id);
  assert.equal((await agir("/api/fv2/acoes/configuracoes/conta/criar", { tipo: "BANCARIA", nome: "Outra" }, "operador")).status, 403, "operador não configura");
  const saldo = await agir("/api/fv2/acoes/abertura/saldo", { conta: conta.corpo.id, competencia: "2026-11", valor: "1.500,00", origem: "Extrato sintético de 31/10" });
  assert.equal(saldo.status, 200, JSON.stringify(saldo.corpo));
  assert.deepEqual([saldo.corpo.saldo.data, saldo.corpo.saldo.referencia], ["2026-10-31", "FIM_DO_DIA"]);
  const chave = globalThis.crypto.randomUUID();
  const titulo = { fornecedorNovo: "Fornecedor de abertura sintético", descricao: "NF sintética 9", valor: "200,00", competencia: "2026-11", dataEmissao: "2026-10-10", vencimento: "2026-11-15", origem: "Lista sintética de 31/10", chave };
  const t1 = await agir("/api/fv2/acoes/abertura/obrigacao-anterior", titulo);
  assert.equal(t1.status, 200, JSON.stringify(t1.corpo));
  const t2 = await agir("/api/fv2/acoes/abertura/obrigacao-anterior", titulo);
  assert.equal(t2.corpo.repetido, true, "o mesmo formulário reenviado devolve o registro já gravado");
  const rec = await agir("/api/fv2/acoes/abertura/recebivel-anterior", { processador: "IFOOD", descricao: "Repasse sintético", valor: "300,00", competencia: "2026-11", dataOrigem: "2026-10-29", origem: "Demonstrativo sintético", chave: globalThis.crypto.randomUUID() });
  assert.equal(rec.status, 200, JSON.stringify(rec.corpo));
  assert.equal((await agir("/api/fv2/acoes/recebiveis/registrar", { processador: "STONE", valor: "10,00", competencia: "2026-11" })).status, 400);
  const plano = await agir("/api/fv2/acoes/configuracoes/implantar-plano", { modelo: "ACAITERIA" });
  assert.equal(plano.status, 400, "sem o modelo redigitado, nada é implantado");
  assert.deepEqual((await agir("/api/fv2/acoes/configuracoes/implantar-plano", { modelo: "ACAITERIA", modeloConfirmado: "ACAITERIA" })).corpo.criadas, []);
  // DRE de novembro: a abertura não muda faturamento nem resultado.
  const dre = await ler("/api/fv2/dre", { competencia: "2026-11" });
  for (const k of ["faturamentoBruto", "resultadoGerencial"]) assert.equal(dre[k].valorCentavos, dreAntes[k].valorCentavos, `${k} sem efeito da abertura`);
  assert.ok(dre.dre.foraDoResultado.patrimoniais.some((x) => x.valorCentavos === 20000), "o título anterior aparece fora do resultado");
  // A tela de Configurações → Abertura mostra a conta nova no roteiro.
  const cfg = await ler("/api/fv2/configuracoes");
  assert.match(adm.configuracoes(cfg, { secao: "abertura" }, { permissoes: TODAS }), /Conta de abertura sintética/);
});
