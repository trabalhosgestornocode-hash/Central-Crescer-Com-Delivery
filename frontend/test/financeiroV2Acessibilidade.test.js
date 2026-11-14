// Execução 08D — auditoria AUTOMATIZADA de acessibilidade (auditor próprio, sem dependências) sobre o HTML REAL das telas
// e painéis dos fluxos críticos, com dados da demonstração (núcleo real). Não substitui leitor de tela.
// Rodar: node --test frontend/test/financeiroV2Acessibilidade.test.js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as telas from "../financeiro-v2/telas.js";
import * as tes from "../financeiro-v2/telasTesouraria.js";
import * as ven from "../financeiro-v2/telasVendas.js";
import * as adm from "../financeiro-v2/telasAdministracao.js";
import * as conf from "../financeiro-v2/telasConferencias.js";
import { criarDemo, UNIDADES } from "../../backend/scripts/fv2/demoInterface.mjs";
import { auditarHtml } from "./acessibilidade/auditoria.js";

let demo;
const U1 = UNIDADES[0].id;
const TODAS = ["financeiro_v2.ver", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar", "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento", "financeiro_v2.importar", "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.conceder", "financeiro_v2.revogar"];
const ok = async (caminho, params = {}, perfil = "administrador") => { const r = await demo.responder(caminho, { unidade: U1, ...params }, perfil); assert.equal(r.status, 200, `${caminho} ${JSON.stringify(r.corpo).slice(0, 200)}`); return r.corpo; };
const semProblemas = (nome, html) => assert.deepEqual(auditarHtml(html), [], nome);
before(async () => { demo = await criarDemo(); });

test("08D a11y — o auditor detecta o que deve (prova de que não aprova tudo)", () => {
  const ruim = '<form data-acao="/x"><input name="a"><button></button><select name="s"></select></form><table><tr><td>1</td></tr></table><img src="x"><a href="#"></a><div tabindex="3" id="d"></div><div id="d" aria-labelledby="nada"></div><aside role="dialog"></aside>';
  const regras = auditarHtml(ruim).map((p) => p.regra);
  for (const r of ["campo sem rótulo", "botão sem nome", "tabela sem legenda", "tabela sem cabeçalho", "imagem sem alt", "link sem nome", "tabindex positivo", "id duplicado", "diálogo sem título", "formulário de ação sem região de anúncio do resultado"]) assert.ok(regras.includes(r), r);
  assert.ok(regras.some((r) => r.startsWith("aria-labelledby aponta")));
});

test("08D a11y — páginas principais (setembro, dados reais da demonstração)", async () => {
  const SET = { competencia: "2026-09" };
  semProblemas("index.html", readFileSync(fileURLToPath(new URL("../financeiro-v2/index.html", import.meta.url)), "utf8"));
  semProblemas("entrar.html", readFileSync(fileURLToPath(new URL("../financeiro-v2/entrar.html", import.meta.url)), "utf8"));
  semProblemas("DRE", telas.dre(await ok("/api/fv2/dre", SET)));
  semProblemas("contas a pagar", tes.contasAPagar(await ok("/api/fv2/contas-a-pagar", SET), {}));
  semProblemas("contas a receber", tes.contasAReceber(await ok("/api/fv2/contas-a-receber", SET), {}));
  const caixa = await ok("/api/fv2/caixa-e-bancos", { ...SET, inicio: "2026-09-01", fim: "2026-09-30" });
  semProblemas("caixa", tes.caixaEBancos(caixa, { contas: caixa.contas.map((c) => ({ id: c.id, nome: c.nome })) }));
  semProblemas("fluxo", tes.fluxoDeCaixa(await ok("/api/fv2/fluxo-de-caixa", { ...SET, inicio: "2026-09-01", fim: "2026-10-31", granularidade: "MES" }), {}));
  semProblemas("calendário", tes.calendario(await ok("/api/fv2/calendario", { ...SET, mes: "2026-09" })));
  semProblemas("vendas", ven.vendasERecebimentos(await ok("/api/fv2/vendas", SET), {}));
  semProblemas("documentos", adm.documentos(await ok("/api/fv2/documentos", SET), {}));
  for (const secao of ["resumo", "pendencias", "documentos", "propostas", "conciliacoes", "fechamento"]) {
    const rota = { resumo: "/api/fv2/conferencias", pendencias: "/api/fv2/conferencias/pendencias", documentos: "/api/fv2/conferencias/documentos", propostas: "/api/fv2/conferencias/propostas", conciliacoes: "/api/fv2/conferencias/correspondencias", fechamento: "/api/fv2/conferencias/fechamento" }[secao];
    semProblemas(`central: ${secao}`, conf.central(await ok(rota, SET), { secao }, { competencia: "2026-09", unidadeNome: "Unidade", permissoes: TODAS }));
  }
});

test("08D a11y — fluxos críticos: pendência + envio, reclassificação + prévia, correspondência + envio, propostas", async () => {
  const OUT = { competencia: "2026-10" };
  const lista = await ok("/api/fv2/conferencias/pendencias", { ...OUT, tamanho: "100" });
  for (const p of lista.itens) {
    const d = await ok("/api/fv2/conferencias/pendencia", { ...OUT, chave: p.chave });
    semProblemas(`pendência ${p.codigo}`, conf.detalhePendencia(d, { competencia: "2026-10", permissoes: TODAS, pessoas: [{ perfil: "gestor", nome: "Gestor" }] }));
  }
  const desp = lista.itens.find((x) => x.codigo === "DESPESA_A_CLASSIFICAR");
  const dd = await ok("/api/fv2/conferencias/pendencia", { ...OUT, chave: desp.chave });
  semProblemas("reclassificação", conf.detalheReclassificacao(await ok("/api/fv2/reclassificacao", { ...OUT, id: dd.pendencia.referencia.id })));
  semProblemas("reclassificação com prévia", conf.detalheReclassificacao(await ok("/api/fv2/reclassificacao", { ...OUT, id: dd.pendencia.referencia.id, categoria: "DESPESAS_ADMINISTRATIVAS_GERAIS" })));
  const corr = (await ok("/api/fv2/conferencias/correspondencias", { ...OUT, tamanho: "50" })).itens;
  for (const c of corr) semProblemas("correspondência", conf.detalheCorrespondencia(await ok("/api/fv2/conferencias/correspondencia", { ...OUT, id: c.id }), { permissoes: TODAS }));
  const props = (await ok("/api/fv2/conferencias/propostas", { competencia: "2026-09", tamanho: "50" })).itens;
  for (const p of props.slice(0, 3)) semProblemas("proposta", conf.detalheProposta(await ok("/api/fv2/conferencias/proposta", { competencia: "2026-09", id: p.id })));
  semProblemas("formulário de envio", conf.formularioDeEvidencia({ registroTipo: "LANCAMENTO", registro: "ref-x", competencia: "2026-10" }));
});
