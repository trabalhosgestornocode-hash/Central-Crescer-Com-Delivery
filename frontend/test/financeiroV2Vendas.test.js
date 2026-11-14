// Execução 06B — interface de Vendas e Recebimentos do Financeiro v2 (demonstração local, dados 100% SINTÉTICOS).
// O motor REAL calcula tudo; as telas só apresentam. Data-base da demonstração: 12/11/2026.
// Rodar: node --test frontend/test/financeiroV2Vendas.test.js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as telas from "../financeiro-v2/telas.js";
import * as tes from "../financeiro-v2/telasTesouraria.js";
import * as ven from "../financeiro-v2/telasVendas.js";
import { criarConsultor } from "../financeiro-v2/consulta.js";
import { moeda } from "../financeiro-v2/formatar.js";
import { criarDemo, UNIDADES } from "../../backend/scripts/fv2/demoInterface.mjs";

let demo;
const U1 = UNIDADES[0].id;
const U2 = UNIDADES[1].id;
const SET = { competencia: "2026-09" };
const get = async (caminho, params, perfil = "gestor") => demo.responder(caminho, { unidade: U1, ...params }, perfil);
const ok = async (caminho, params, perfil) => { const r = await get(caminho, params, perfil); assert.equal(r.status, 200, JSON.stringify(r.corpo)); return r.corpo; };
const raiz = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const arquivo = (nome) => readFileSync(raiz(`../financeiro-v2/${nome}`), "utf8");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
before(async () => { demo = await criarDemo(); });

test("vendas: resumo igual à DRE, canais, agregado sem pedidos, título para o gestor e detalhe completo", async () => {
  const r = await ok("/api/fv2/vendas", { ...SET, tamanho: "100" });
  const dre = await ok("/api/fv2/dre", SET);
  assert.equal(r.resumo.brutoProprioCentavos, dre.faturamentoBruto.valorCentavos, "o bruto da tela é o da DRE");
  assert.equal(r.resumo.conferenciaComDre.confere, true);
  const html = ven.vendasERecebimentos(r, { aba: "vendas" });
  assert.match(html, /igual à DRE/);
  assert.ok(html.includes(moeda(r.resumo.brutoProprioCentavos)));
  for (const aba of ["Vendas", "Pagamentos", "Taxas e descontos", "Recebíveis e repasses", "Divergências"]) assert.ok(html.includes(`>${aba}</button>`), aba);
  assert.ok(!/Venda BALCAO|Venda IFOOD/.test(html), "nunca o código técnico");
  assert.match(html, /Venda no Balcão — pagamento misto \(dinheiro \+ cartão de débito\)/);
  assert.match(html, /Faturamento agregado do dia 02\/09\/2026 — sem pedidos individuais/);
  assert.match(html, /Agregada \(sem pedidos\)/);
  // Canal BALCAO filtrado = canal BALCAO da DRE (mesmo número em qualquer tela).
  const balcao = await ok("/api/fv2/vendas", { ...SET, canal: "BALCAO" });
  assert.equal(balcao.resumo.brutoProprioCentavos, dre.faturamentoBruto.porCanal.find((c) => c.canal === "BALCAO").valorCentavos);
  // Detalhe: identificação, valores, pagamentos, taxas (fração), recebíveis, linha do tempo, originais × interpretação.
  const p102 = r.itens.find((x) => x.identificador === "SAIPOS · DEMO-P102");
  const det = await ok("/api/fv2/venda", { id: p102.id });
  const dh = ven.detalheDaVenda(det);
  for (const trecho of ["Identificador", "SAIPOS · DEMO-P102", "Bruto próprio", "Cobrado do consumidor", "Pagamentos", "Taxas, recebíveis e liquidações", "Linha do tempo", "Dados originais × interpretação", "Evidências", "Histórico"]) assert.ok(dh.includes(trecho), trecho);
  assert.match(dh, /exato R\$ 1,057500 → registrado R\$ 1,06/);
  assert.match(dh, /Transação processada/);
  assert.match(dh, /Pendente/, "repasse e crédito ainda não ocorreram: aparecem pendentes");
  assert.ok(!/<a\s/i.test(dh) && !/href=/i.test(dh), "documentos e etapas sem links fictícios");
  // Agregado: explicação, sem formas inventadas.
  const ag = await ok("/api/fv2/venda", { id: r.itens.find((x) => x.tipo === "AGREGADO_DIARIO").id });
  const ah = ven.detalheDaVenda(ag);
  assert.match(ah, /nada disso é presumido/);
  assert.ok(!/cartão de crédito|dinheiro/i.test(ah.replace(/descontos?/gi, "")), "nenhuma forma presumida para o agregado");
});

test("pagamentos, processadores, iFood, taxas e recebíveis: pagamento ≠ recebível ≠ repasse ≠ crédito", async () => {
  const pg = await ok("/api/fv2/vendas/pagamentos", SET);
  const html = ven.vendasERecebimentos(pg, { aba: "pagamentos" });
  assert.match(html, /Transações sem venda correspondente/);
  assert.match(html, /Nenhuma venda é criada a partir do processador/);
  assert.match(html, /iFood — composição separada/);
  assert.match(html, /Comissões \(despesa\)/);
  const stone = pg.processadores.find((p) => p.processador === "STONE");
  assert.equal(stone.transacoesSemVenda, 1);
  const tx = await ok("/api/fv2/vendas/taxas", { ...SET, tamanho: "100" });
  const th = ven.vendasERecebimentos(tx, { aba: "taxas" });
  assert.match(th, /metade para cima/);
  assert.match(th, /Fora da DRE|Deduções comerciais/);
  const rc = await ok("/api/fv2/vendas/recebiveis", { ...SET, tamanho: "100" });
  const rh = ven.vendasERecebimentos(rc, { aba: "recebiveis" });
  assert.match(rh, /Venda → direito a receber → repasse → crédito/);
  assert.match(rh, /repasse agrupado/);
  assert.match(rh, /sem extrato/);
  assert.match(rh, /sem previsão \(não presumida\)/);
  // Recebível parcialmente liquidado e ciclo completo (Contas a Receber → Stone → Recebível → Repasse → Crédito).
  const cr = await ok("/api/fv2/contas-a-receber", { processador: "STONE" });
  const titulo = cr.itens.find((t) => t.recebidoCentavos > 0 && t.saldoCentavos > 0);
  const detCr = tes.detalheAReceber(await ok("/api/fv2/conta-a-receber", { id: titulo.id }));
  assert.match(detCr, /data-detalhe="recebimento:ref-/);
  assert.match(detCr, /Ver venda de origem/);
  const ciclo = await ok("/api/fv2/recebimento", { id: titulo.id });
  assert.equal(ciclo.recebivel.situacaoRecebimento, "PARCIALMENTE_RECEBIDO");
  assert.deepEqual([ciclo.recebivel.esperadoCentavos, ciclo.recebivel.liquidadoCentavos, ciclo.recebivel.saldoCentavos], [titulo.esperadoCentavos, titulo.recebidoCentavos, titulo.saldoCentavos], "mesmos valores que Contas a Receber");
  const ch = ven.detalheDoRecebimento(ciclo);
  assert.match(ch, /Sem comprovação/);
  assert.match(ch, /Saldo ainda não creditado/);
});

test("divergências: descrição, impacto, fonte, período, motivo, próxima ação; ligação para a venda", async () => {
  const d = await ok("/api/fv2/vendas/divergencias", { ...SET, tamanho: "100" });
  const codigos = new Set(d.itens.map((x) => x.codigo));
  for (const k of ["TRANSACAO_SEM_PEDIDO", "RECEBIVEL_SEM_REPASSE", "CREDITO_SEM_COMPROVACAO_BANCARIA", "DESCONTO_SEM_FINANCIADOR", "VENDA_SEM_CANAL", "TOTAIS_DE_RELATORIOS_DIFERENTES"]) assert.ok(codigos.has(k), k);
  const html = ven.vendasERecebimentos(d, { aba: "divergencias" });
  for (const t of ["Impacto", "Período", "Fonte", "Motivo", "Próxima ação"]) assert.ok(html.includes(`<dt>${t}</dt>`), t);
  assert.match(html, /Nada é resolvido por valores próximos/);
  assert.match(html, /data-detalhe="venda:ref-/);
});

test("integração: Visão Geral → canal → vendas; DRE → vendas; composição → venda; caixa mostra sugestão bancária separada", async () => {
  const vg = await ok("/api/fv2/visao-geral", SET);
  const vh = telas.visaoGeral(vg, {});
  assert.match(vh, /href="#\/vendas-e-recebimentos\?aba=vendas&amp;canal=BALCAO"/);
  assert.ok(!/canal=NAO_IDENTIFICADO[^"]*"[^>]*>Ver vendas<span class="sr"> — Balcão/.test(vh));
  const dre = telas.dre(await ok("/api/fv2/dre", SET), {});
  assert.match(dre, /Ver vendas da competência/);
  const comp = await ok("/api/fv2/composicao", { ...SET, codigo: "FATURAMENTO_BRUTO_PROPRIO" });
  const ch = telas.composicao(comp, {});
  assert.match(ch, /data-detalhe="venda:ref-/);
  // A referência emitida pela composição abre o detalhe (navegação real, não falsa).
  const ref = /data-detalhe="venda:(ref-[0-9a-f]+)"/.exec(ch)[1];
  assert.equal((await get("/api/fv2/venda", { id: ref })).status, 200);
  // A.2 na interface: despesa a classificar aparece fora da DRE; extrato mostra sugestão separada da classificação.
  const cp = await ok("/api/fv2/contas-a-pagar", {});
  assert.match(tes.contasAPagar(cp, {}), /fora da DRE até classificar/);
  const cb = await ok("/api/fv2/caixa-e-bancos", { inicio: "2026-10-01", fim: "2026-10-31" });
  const cbh = tes.caixaEBancos(cb, {});
  assert.match(cbh, /Ver recebimento/);
  assert.match(cbh, /Só movimentos posteriores à referência entram no saldo/);
});

test("23, 24, 22 — sessão ausente, acesso negado, outra organização, outra unidade e referência desconhecida", async () => {
  for (const c of ["/api/fv2/vendas", "/api/fv2/vendas/pagamentos", "/api/fv2/vendas/taxas", "/api/fv2/vendas/recebiveis", "/api/fv2/vendas/divergencias"]) {
    assert.equal((await get(c, SET, "ausente")).status, 401, `${c}: sem sessão`);
    assert.equal((await get(c, SET, "sem-acesso")).status, 403, `${c}: sem concessão`);
    assert.equal((await get(c, { ...SET, unidade: "bbbbbbbb-0000-4000-8000-0000000000b1" })).status, 403, `${c}: outra organização`);
    assert.equal((await get(c, {})).status, 400, `${c}: sem competência nem período`);
  }
  const outra = await ok("/api/fv2/vendas", { ...SET, unidade: U2 });
  assert.equal(outra.itens.length, 0, "unidade 2 não vê vendas da unidade 1");
  assert.equal((await get("/api/fv2/venda", { id: "ref-inexistente" })).status, 404);
  const id = (await ok("/api/fv2/vendas", SET)).itens[0].id;
  assert.equal((await get("/api/fv2/venda", { id, unidade: U2 })).status, 404, "a referência não abre o registro em outra unidade");
  // Sem identificadores internos nem caminhos de arquivo nas respostas.
  for (const c of ["/api/fv2/vendas", "/api/fv2/vendas/pagamentos", "/api/fv2/vendas/taxas", "/api/fv2/vendas/recebiveis", "/api/fv2/vendas/divergencias"]) {
    const corpo = JSON.stringify(await ok(c, { ...SET, tamanho: "100" }));
    assert.ok(!UUID.test(corpo), `${c}: identificador interno exposto`);
    assert.ok(!/arquivoId|demo-[a-z]"|[A-Z]:\\\\|\/home\/|AppData/.test(corpo), `${c}: caminho ou arquivo exposto`);
  }
});

test("25 — paginação e filtros pela URL; filtros desconhecidos recusados", async () => {
  const p1 = await ok("/api/fv2/vendas", { ...SET, tamanho: "4" });
  const p2 = await ok("/api/fv2/vendas", { ...SET, tamanho: "4", pagina: "2" });
  assert.equal(p1.paginacao.paginas, Math.ceil(p1.paginacao.total / 4));
  assert.ok(!p2.itens.some((x) => p1.itens.some((y) => y.id === x.id)), "páginas não se repetem");
  assert.match(ven.vendasERecebimentos(p2, { aba: "vendas" }), /Página 2 de/);
  assert.equal((await ok("/api/fv2/vendas", { ...SET, identificador: "P101" })).itens.length, 1);
  assert.equal((await ok("/api/fv2/vendas", { ...SET, valorMinimoCentavos: ven.reaisParaCentavos("1.000,00") })).itens.every((x) => x.valores.brutoProprioCentavos >= 100000), true);
  assert.equal(ven.reaisParaCentavos("12,5"), "1250");
  assert.equal(ven.reaisParaCentavos("abc"), "");
  assert.equal((await get("/api/fv2/vendas", { ...SET, organizacaoId: "x" })).status, 200, "campo fora da lista do tratador é descartado, não repassado");
  assert.equal((await get("/api/fv2/vendas", { ...SET, canal: "TELEPATIA" })).status, 400);
});

test("26, 27 — troca rápida de competência e resposta antiga: só a última consulta é aplicada", async () => {
  const pendentes = [];
  const fetchFalso = (url, { signal }) => new Promise((resolve, reject) => {
    pendentes.push({ url, resolve: () => resolve({ ok: true, status: 200, json: async () => ({ url }) }) });
    signal?.addEventListener("abort", () => reject(Object.assign(new Error("abortada"), { name: "AbortError" })));
  });
  const cons = criarConsultor(fetchFalso);
  const r1 = cons.consultar("/api/fv2/vendas?competencia=2026-08");
  const r2 = cons.consultar("/api/fv2/vendas?competencia=2026-09");
  const r3 = cons.consultar("/api/fv2/vendas/recebiveis?competencia=2026-10");
  pendentes[2].resolve();
  pendentes[0].resolve();
  assert.equal(await r1, null);
  assert.equal(await r2, null);
  assert.deepEqual(await r3, { ok: true, dados: { url: "/api/fv2/vendas/recebiveis?competencia=2026-10" } });
  // Sem flash: a tela é limpa antes de qualquer consulta, e a troca de aba recarrega (não reaproveita dados antigos).
  const app = arquivo("app.js");
  assert.match(app, /conteudo\.innerHTML = telas\.estado\("carregando"\)/);
  assert.match(app, /const aba = e\.target\.closest\("\[data-aba\]"\)/);
});

test("28, 29 — layout móvel, cartões, abas roláveis e teclado (foco restaurado, Escape, botões reais)", () => {
  const css = arquivo("fv2.css");
  const movel = css.slice(css.lastIndexOf("@media (max-width: 760px)"));
  assert.match(movel, /\.abas--botoes \{ flex-wrap: nowrap; overflow-x: auto;/);
  assert.match(movel, /\.ficha \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(movel, /\.tabela--cartoes td::before \{ content: attr\(data-rotulo\)/);
  assert.match(css, /\.painel \.ficha dd, \.painel \.lista-simples span \{ overflow-wrap: anywhere; min-width: 0; \}/);
  const src = arquivo("telasVendas.js");
  assert.ok(!/<td(?![^>]*data-rotulo)[^>]*>/.test(src.replace(/const td = [^\n]+/, "")), "td sem data-rotulo (modo cartão)");
  assert.ok(!/Centavos\s*[+-]\s*\w+Centavos|reduce\(|\.reduce\b/.test(src), "tela recalculando valores");
  assert.ok(!/<div[^>]+data-(detalhe|aba)/.test(src), "ações são botões reais (teclado)");
  const html = arquivo("index.html");
  assert.match(html, /href="#\/vendas-e-recebimentos" data-rota="vendas-e-recebimentos"/);
  assert.ok(!/Vendas e Recebimentos <small>em construção/.test(html));
  const app = arquivo("app.js");
  assert.match(app, /if \(!painel\.contains\(origem\) \|\| !focoAntesDoPainel\) focoAntesDoPainel = origem;/, "foco volta à tela de origem mesmo após navegar dentro do painel");
  assert.match(app, /focoAntesDoPainel\?\.isConnected/);
});

test("30 — nenhum dado financeiro real nos arquivos versionados da 06B", () => {
  const versionados = [
    "../../backend/test/financeiro-v2/vendas-recebimentos.test.js", "../../backend/test/financeiro-v2/auditoria-fundacao-06b.test.js",
    "../../backend/scripts/fv2/demoInterface.mjs", "./financeiroV2Vendas.test.js", "../financeiro-v2/telasVendas.js", "../../docs/financeiro-v2/12-vendas-recebimentos.md",
  ].map(raiz).filter(existsSync).map((p) => readFileSync(p, "utf8"));
  // Padrões que não podem aparecer: CNPJ/CPF, e-mail, chave Pix aleatória.
  for (const t of versionados) {
    assert.ok(!/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b|\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/.test(t), "documento de pessoa/empresa");
    assert.ok(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(t), "e-mail");
  }
  // Os totais REAIS de setembro ficam num documento PRIVADO, fora do Git. Quando ele existe nesta máquina, nenhum valor
  // dele (≥ R$ 100,00) pode aparecer nos arquivos versionados. A mensagem de falha não mostra o valor.
  const privado = raiz("../../docs/financeiro-v2/02-referencia-setembro.md");
  if (!existsSync(privado)) return;
  const reais = [...readFileSync(privado, "utf8").matchAll(/\b(\d{1,3}(?:\.\d{3})+|\d{3,}),(\d{2})\b/g)].map((m) => `${m[1].replace(/\./g, "")}${m[2]}`).filter((c) => Number(c) >= 10000);
  for (const t of versionados) {
    const texto = t.replace(/\./g, "");
    const achou = reais.filter((c) => new RegExp(`(^|[^\\d])${c}([^\\d]|$)`).test(texto) || texto.includes(`${c.slice(0, -2)},${c.slice(-2)}`));
    assert.equal(achou.length, 0, "valor do documento privado de setembro encontrado em arquivo versionado");
  }
});
