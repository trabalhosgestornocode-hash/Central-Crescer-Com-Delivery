// Execução 08E — interface da baixa por saída do extrato (F-2) e da documentação de pendências no fechamento (F-1).
// Demonstração local (núcleo REAL; dados sintéticos). Rodar: node --test frontend/test/financeiroV2BaixaFechamento.test.js
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
const TODAS = ["financeiro_v2.ver", "financeiro_v2.registrar", "financeiro_v2.vincular_pagamento", "financeiro_v2.fechar", "financeiro_v2.enviar_documento"];
before(async () => {
  demo = await criarDemo();
  for (const p of ["administrador", "gestor", "operador"]) tokens[p] = (await ok("/api/fv2/sessao", {}, p)).csrf;
});

test("08E — conta a pagar: explica registrar × vincular; vincular usa a saída do extrato sem criar outra; repetir não duplica", async () => {
  const energia = (await ok("/api/fv2/contas-a-pagar", { ...OUT, tamanho: "100" })).itens.find((t) => t.fornecedor?.nome?.startsWith("Energia"));
  const det = await ok("/api/fv2/conta-a-pagar", { ...OUT, id: energia.id });
  const html = tes.detalheAPagar(det, { permissoes: TODAS });
  assert.match(html, /Como dar baixa nesta conta/);
  assert.match(html, /não cria outra saída nem outra despesa/);
  assert.match(html, /data-previa-vinculo="/);
  assert.deepEqual(auditarHtml(html), []);
  assert.ok(!tes.detalheAPagar(det, { permissoes: ["financeiro_v2.ver", "financeiro_v2.registrar"] }).includes("data-previa-vinculo"), "só quem tem vincular_pagamento vê o vínculo");
  const saida = det.vinculoExtrato.saidasElegiveis.find((s) => s.valorCentavos === 61850 && s.data === "2026-10-28");
  assert.ok(saida, "a saída do extrato de 28/10 aparece como elegível");
  assert.equal(det.vinculoExtrato.escolhida, null, "nada pré-selecionado");
  const prev = await ok("/api/fv2/vinculo-extrato", { ...OUT, obrigacao: energia.id, movimentacao: saida.id });
  const htmlPrev = tes.detalheVinculoExtrato(prev, { permissoes: TODAS });
  assert.match(htmlPrev, /Prévia: nada foi gravado/);
  assert.match(htmlPrev, /NÃO muda/);
  assert.match(htmlPrev, /data-acao="\/api\/fv2\/acoes\/obrigacoes\/vincular-extrato"/);
  assert.deepEqual(auditarHtml(htmlPrev), []);
  assert.ok(prev.escolhida.documentosDisponiveis.some((d) => /energia/i.test(d.descricao)), "o comprovante da saída é oferecido como evidência");
  const antes = await ok("/api/fv2/caixa-e-bancos", { ...OUT, inicio: "2026-10-01", fim: "2026-10-31", tamanho: "100" });
  const corpo = { obrigacao: energia.id, movimentacao: saida.id, versao: String(prev.escolhida.versao), valor: "618,50", justificativa: "Comprovante da concessionária confere (sintético)." };
  assert.equal((await agir("/api/fv2/acoes/obrigacoes/vincular-extrato", corpo, "gestor")).status, 403, "gestor só vê");
  const comDoc = { ...corpo, documento: prev.escolhida.documentosDisponiveis[0].id };
  const r = await agir("/api/fv2/acoes/obrigacoes/vincular-extrato", comDoc);
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.match(conf.resultadoDaAcao({ ok: true, dados: r.corpo }), /Nenhuma saída nova, nenhuma despesa nova/);
  const rep = await agir("/api/fv2/acoes/obrigacoes/vincular-extrato", comDoc);
  assert.equal(rep.corpo.repetido, true, "repetir não duplica");
  const depois = await ok("/api/fv2/caixa-e-bancos", { ...OUT, inicio: "2026-10-01", fim: "2026-10-31", tamanho: "100" });
  assert.equal(depois.movimentos.length, antes.movimentos.length, "nenhuma saída nova no banco");
  assert.deepEqual(depois.contas.map((c) => c.saidasCentavos), antes.contas.map((c) => c.saidasCentavos));
  const paga = await ok("/api/fv2/conta-a-pagar", { ...OUT, id: energia.id });
  assert.deepEqual([paga.titulo.saldoCentavos, paga.titulo.situacao], [0, "PAGO"]);
  assert.match(tes.detalheAPagar(paga, { permissoes: TODAS }), /vinculado do extrato/);
});

test("08E — fechamento: pendência mostra como está no fechamento e se documenta no próprio painel; a tela separa bloqueantes, por documentar e ressalvas", async () => {
  await agir("/api/fv2/acoes/fechamento/alterar", { competencia: "2026-10", novoEstado: "FECHAMENTO_PRELIMINAR" });
  const lista = await ok("/api/fv2/conferencias/pendencias", { ...OUT, tamanho: "100" });
  const fonte = lista.itens.find((p) => p.codigo === "FONTE_SEM_DOCUMENTO");
  const det = await ok("/api/fv2/conferencias/pendencia", { ...OUT, chave: fonte.chave });
  assert.equal(det.fechamentoDaPendencia.item.situacao, "NAO_DOCUMENTADA");
  const html = conf.detalhePendencia(det, { permissoes: TODAS });
  assert.match(html, /Precisa ser documentada/);
  assert.match(html, /data-acao="\/api\/fv2\/acoes\/pendencias\/documentar"/);
  assert.deepEqual(auditarHtml(html), []);
  assert.ok(!conf.detalhePendencia(det, { permissoes: ["financeiro_v2.ver"] }).includes("pendencias/documentar"), "só quem fecha documenta");
  assert.equal((await agir("/api/fv2/acoes/pendencias/documentar", { competencia: "2026-10", chave: fonte.chave, descricao: fonte.titulo, impacto: "x", decisao: "y", documentacaoFaltante: "z" }, "operador")).status, 403);
  const r = await agir("/api/fv2/acoes/pendencias/documentar", { competencia: "2026-10", chave: fonte.chave, descricao: fonte.titulo, impacto: "Conferência cruzada incompleta (sintético).", decisao: "Aguardar o relatório (sintético).", documentacaoFaltante: "Relatório do período (sintético)." });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  const f = await ok("/api/fv2/conferencias/fechamento", OUT);
  const tela = conf.central({ ...f, dataBase: f.dataBase }, { secao: "fechamento" }, { competencia: "2026-10", unidadeNome: "U", permissoes: TODAS });
  for (const t of ["Pendências diante da homologação", "Bloqueantes", "Precisam ser documentadas", "Documentadas: ressalvas admissíveis", "Resolvidas", "O que impede homologar"]) assert.match(tela, new RegExp(t));
  assert.ok(f.avaliacaoDasPendencias.ressalvas.some((x) => x.chave === fonte.chave));
  assert.deepEqual(auditarHtml(tela), []);
  // A recusa da homologação diz por quê (outubro da demonstração tem divergência relevante e pendências por documentar):
  // a mensagem traz os motivos concretos, não só "não pode ser homologada".
  const h = await agir("/api/fv2/acoes/fechamento/alterar", { competencia: "2026-10", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Sintética." });
  assert.equal(h.status, 409);
  assert.equal(h.corpo.erro, "FV2_HOMOLOGACAO_BLOQUEADA");
  assert.match(h.corpo.mensagem, /não pode ser homologada\. \S/, "a recusa lista ao menos um motivo concreto");
  for (const m of f.avaliacaoDasPendencias.motivos ?? []) assert.ok(typeof m === "string" && m.length > 0);
});
