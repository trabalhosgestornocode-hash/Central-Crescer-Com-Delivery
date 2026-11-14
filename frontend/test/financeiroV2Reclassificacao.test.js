// Execução 08C — reclassificação pela Central de Conferências (demonstração local; dados 100% SINTÉTICOS; motor REAL).
// Rodar: node --test frontend/test/financeiroV2Reclassificacao.test.js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import * as conf from "../financeiro-v2/telasConferencias.js";
import { criarDemo, UNIDADES } from "../../backend/scripts/fv2/demoInterface.mjs";

let demo;
const U1 = UNIDADES[0].id;
const SET = { competencia: "2026-09" };
const get = (caminho, params, perfil = "administrador") => demo.responder(caminho, { unidade: U1, ...params }, perfil);
const ok = async (caminho, params, perfil) => { const r = await get(caminho, params, perfil); assert.equal(r.status, 200, JSON.stringify(r.corpo)); return r.corpo; };
const tokens = {};
const agir = (caminho, corpo, perfil = "administrador") => demo.agir(caminho, { unidade: U1, confirmar: true, ...corpo }, perfil, { csrf: tokens[perfil] });
before(async () => {
  demo = await criarDemo();
  for (const p of ["administrador", "operador", "gestor"]) tokens[p] = (await ok("/api/fv2/sessao", {}, p)).csrf;
});

async function pendenciaDeDesconto() {
  const lista = await ok("/api/fv2/conferencias/pendencias", { ...SET, grupo: "CLASSIFICACOES", tamanho: "100" });
  const p = lista.itens.find((x) => x.codigo === "DESCONTO_A_CLASSIFICAR");
  assert.ok(p, "o desconto sem financiador da demonstração aparece como classificação pendente");
  const d = await ok("/api/fv2/conferencias/pendencia", { ...SET, chave: p.chave });
  return d;
}

test("08C — pendência de classificação abre a reclassificação; a prévia vem do núcleo e não grava", async () => {
  const d = await pendenciaDeDesconto();
  const html = conf.detalhePendencia(d, { competencia: "2026-09" });
  assert.match(html, /data-detalhe="reclassificacao:ref-[0-9a-f]{10}"/);
  const ref = d.pendencia.tecnico.lancamentoId;
  const r = await ok("/api/fv2/reclassificacao", { ...SET, id: ref });
  assert.equal(r.caso, "DESCONTO_SEM_FINANCIADOR");
  assert.ok(r.categoriasPermitidas.length > 0 && r.categoriasPermitidas.every((c) => c.natureza === "DEDUCAO"));
  const p = await ok("/api/fv2/reclassificacao", { ...SET, id: ref, categoria: "DESCONTOS_COMERCIAIS" });
  assert.equal(p.impacto.gravado, false);
  assert.equal(p.impacto.caixa.efeito, "NENHUM");
  const tela = conf.detalheReclassificacao(p);
  for (const t of ["Prévia do impacto (nada foi gravado)", "Valor original", "Categoria anterior", "Categoria nova", "Efeito na DRE", "Caixa e bancos", "Composição por canal", "Contas a pagar", "Pendências que permanecem", "Confirmar reclassificação"]) assert.ok(tela.includes(t), t);
  assert.match(tela, /name="versaoEsperada" value="\d+"/);
  assert.match(tela, /<select name="documento" required>/, "sem evidência vinculada, o documento é obrigatório");
  // A prévia não mudou nada: a consulta seguinte mostra a mesma versão e a mesma categoria.
  const de = await ok("/api/fv2/reclassificacao", { ...SET, id: ref });
  assert.deepEqual([de.lancamento.versao, de.categoriaAtual.codigo], [r.lancamento.versao, r.categoriaAtual.codigo]);
});

test("08C — confirmar: sem evidência é recusado; operador sem permissão recebe 403; com documento grava e não repete", async () => {
  const d = await pendenciaDeDesconto();
  const ref = d.pendencia.tecnico.lancamentoId;
  const p = await ok("/api/fv2/reclassificacao", { ...SET, id: ref, categoria: "DESCONTOS_COMERCIAIS" });
  const corpo = { lancamento: ref, categoria: "DESCONTOS_COMERCIAIS", versaoEsperada: String(p.lancamento.versao), justificativa: "Relatório do canal: desconto da loja (sintético)." };
  const semDoc = await agir("/api/fv2/acoes/reclassificar", corpo);
  assert.equal(semDoc.status, 409);
  assert.equal(semDoc.corpo.erro, "FV2_EVIDENCIA_EXIGIDA");
  const operador = await agir("/api/fv2/acoes/reclassificar", { ...corpo, documento: p.documentosDisponiveis[0].referencia }, "operador");
  assert.equal(operador.status, 403);
  const velha = await agir("/api/fv2/acoes/reclassificar", { ...corpo, versaoEsperada: "999", documento: p.documentosDisponiveis[0].referencia });
  assert.equal(velha.status, 409, "prévia antiga não autoriza");
  const feito = await agir("/api/fv2/acoes/reclassificar", { ...corpo, documento: p.documentosDisponiveis[0].referencia });
  assert.equal(feito.status, 200, JSON.stringify(feito.corpo));
  assert.match(conf.resultadoDaAcao({ ok: true, dados: feito.corpo }), /Reclassificado: DESCONTOS_A_CLASSIFICAR → DESCONTOS_COMERCIAIS/);
  const repetido = await agir("/api/fv2/acoes/reclassificar", { ...corpo, documento: p.documentosDisponiveis[0].referencia });
  assert.equal(repetido.corpo.repetido, true);
  const depois = await ok("/api/fv2/reclassificacao", { ...SET, id: ref });
  assert.deepEqual([depois.categoriaAtual.codigo, depois.historico.length], ["DESCONTOS_COMERCIAIS", 1]);
  // A pendência de classificação deixou de existir; o resto da competência segue como estava.
  const lista = await ok("/api/fv2/conferencias/pendencias", { ...SET, grupo: "CLASSIFICACOES", tamanho: "100" });
  assert.ok(!lista.itens.some((x) => x.chave === d.pendencia.chave), "esta pendência foi resolvida pela decisão com evidência");
});

test("08C — leitor vê a explicação e o motivo do bloqueio, sem formulário de confirmação", async () => {
  const lista = await ok("/api/fv2/conferencias/pendencias", { ...SET, tamanho: "100" }, "gestor");
  const saida = lista.itens.find((x) => x.codigo === "SAIDA_SEM_CLASSIFICACAO");
  if (saida) {
    const d = await ok("/api/fv2/conferencias/pendencia", { ...SET, chave: saida.chave }, "gestor");
    assert.match(conf.detalhePendencia(d, {}), /data-detalhe="reclassificacao-mov:/);
    const m = await ok("/api/fv2/reclassificacao", { ...SET, movimentacao: d.pendencia.referencia.id }, "gestor");
    assert.equal(m.caso, "MOVIMENTACAO_SEM_NATUREZA");
    assert.match(conf.detalheReclassificacao(m), /não é reclassificada/);
  }
  const lanc = (await ok("/api/fv2/conferencias/pendencias", { ...SET, grupo: "CLASSIFICACOES", tamanho: "100" }, "gestor")).itens.find((x) => x.tecnico?.lancamentoId || x.referencia?.tipo === "LANCAMENTO");
  if (lanc) {
    const id = lanc.tecnico?.lancamentoId ?? lanc.referencia.id;
    const r = await ok("/api/fv2/reclassificacao", { ...SET, id }, "gestor");
    assert.equal(r.podeReclassificar, false);
    const html = conf.detalheReclassificacao(r);
    assert.ok(!html.includes("Ver prévia do impacto") && !html.includes("Confirmar reclassificação"));
  }
});

test("08C — conciliação: candidata aberta oferece RECUSAR com motivo; só valor e data avisa que proximidade não é prova", () => {
  const lado = { itens: [], total: 1, valorCentavos: 1000 };
  const base = { id: "ref-abcdef0123", nome: "Venda SAIPOS × transação Stone", situacao: "CANDIDATA", ambigua: true, concorrentes: 1, ladoA: lado, ladoB: lado, criterio: "Valor igual e horário até 10 min", confiabilidade: "FRACA", confiabilidadeTexto: "Só valor e data coincidem: é candidata, nunca prova.", diferencaCentavos: 0, evidencias: [], podeConfirmar: false, motivoDeNaoConfirmar: "Correspondência ambígua: outras candidatas disputam os mesmos registros.", voceTemPermissao: true, relacao: "SAIPOS_X_STONE" };
  const html = conf.detalheCorrespondencia({ correspondencia: base, historico: [] });
  assert.match(html, /data-acao="\/api\/fv2\/acoes\/conciliacoes\/rejeitar"/);
  assert.match(html, /name="justificativa" maxlength="300" required/);
  assert.match(html, /proximidade não é prova/);
  assert.ok(!html.includes("Confirmar conciliação"), "ambígua não oferece confirmar");
  const semPermissao = conf.detalheCorrespondencia({ correspondencia: { ...base, voceTemPermissao: false }, historico: [] });
  assert.ok(!semPermissao.includes("conciliacoes/rejeitar"));
  const decidida = conf.detalheCorrespondencia({ correspondencia: { ...base, situacao: "REJEITADA" }, historico: [] });
  assert.ok(!decidida.includes("conciliacoes/rejeitar"));
});
