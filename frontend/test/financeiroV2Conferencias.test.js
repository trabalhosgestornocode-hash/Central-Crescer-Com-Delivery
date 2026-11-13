// Execução 06C — Central de Conferências na demonstração local (dados 100% SINTÉTICOS; motor REAL).
// Rodar: node --test frontend/test/financeiroV2Conferencias.test.js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as telas from "../financeiro-v2/telas.js";
import * as tes from "../financeiro-v2/telasTesouraria.js";
import * as ven from "../financeiro-v2/telasVendas.js";
import * as conf from "../financeiro-v2/telasConferencias.js";
import { criarConsultor, enviar } from "../financeiro-v2/consulta.js";
import { criarDemo, UNIDADES } from "../../backend/scripts/fv2/demoInterface.mjs";

let demo;
const U1 = UNIDADES[0].id;
const U2 = UNIDADES[1].id;
const SET = { competencia: "2026-09" };
const OUT = { competencia: "2026-10" };
const get = (caminho, params, perfil = "gestor") => demo.responder(caminho, { unidade: U1, ...params }, perfil);
const ok = async (caminho, params, perfil) => { const r = await get(caminho, params, perfil); assert.equal(r.status, 200, JSON.stringify(r.corpo)); return r.corpo; };
const arquivo = (nome) => readFileSync(fileURLToPath(new URL(`../financeiro-v2/${nome}`, import.meta.url)), "utf8");
const servidor = () => readFileSync(fileURLToPath(new URL("../../backend/scripts/fv2-demo-interface.mjs", import.meta.url)), "utf8");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
let csrf;
const agir = (caminho, corpo, { perfil = "operador", token = csrf } = {}) => demo.agir(caminho, { unidade: U1, confirmar: true, ...corpo }, perfil, { csrf: token });
before(async () => {
  demo = await criarDemo();
  csrf = (await ok("/api/fv2/sessao", {}, "operador")).csrf;
});

test("resumo: situação do fechamento, contagens (não somas), documentos faltantes e o que impede o fechamento", async () => {
  const r = await ok("/api/fv2/conferencias", SET);
  const html = conf.central(r, { secao: "resumo" }, { competencia: "2026-09", unidadeNome: "Unidade" });
  assert.equal(r.fechamento.estado, "FECHAMENTO_COM_PENDENCIAS");
  assert.match(html, /Fechamento com pendências documentadas/);
  assert.match(html, /impedem a homologação/);
  assert.match(html, /É uma contagem: valores de pendências diferentes não são somados/);
  assert.match(html, /Extrato da Unicred<\/span><span class="selo selo--alerta">falta o documento/);
  for (const t of ["O que está correto", "O que falta conferir", "O que impede o fechamento"]) assert.ok(html.includes(t), t);
  assert.ok(!/SAIDA_SEM_CLASSIFICACAO|FONTE_SEM_DOCUMENTO|TOTAIS_DE_RELATORIOS/.test(html), "códigos técnicos fora da tela principal");
  for (const [k, t] of conf.SECOES) assert.ok(html.includes(`data-secao="${k}"`) && html.includes(`>${t}</button>`), t);
});

test("1, 2, 3, 4 — documentos e prévia real; leitor homologado × não homologado; ações só para quem tem permissão", async () => {
  const r = await ok("/api/fv2/conferencias/documentos", SET);
  const gestor = conf.central(r, { secao: "documentos" }, { competencia: "2026-09", permissoes: ["financeiro_v2.ver"] });
  assert.match(gestor, /leitor homologado/);
  assert.match(gestor, /leitor não homologado/);
  assert.ok(!gestor.includes('data-detalhe="importar:catalogo"'));
  assert.match(gestor, /Importar exige a permissão/);
  const operador = conf.central(r, { secao: "documentos" }, { competencia: "2026-09", permissoes: ["financeiro_v2.ver", "financeiro_v2.importar"] });
  assert.ok(operador.includes('data-detalhe="importar:catalogo"'));
  const pdf = r.itens.find((x) => x.tipoRelatorio === "SAIPOS_FATURAMENTO_POR_DIA");
  const det = await ok("/api/fv2/conferencias/documento", { id: pdf.id });
  const dh = conf.detalheDocumento(det, { permissoes: ["financeiro_v2.ver"] });
  for (const t of ["Registros válidos (novos)", "Rejeitados (erros)", "Duplicados no próprio arquivo", "Já existentes", "Divergências", "Limitações", "Detalhes técnicos"]) assert.ok(dh.includes(t), t);
  assert.ok(!/hashSha256|arquivoId|demo-[a-z]/.test(JSON.stringify(det)), "sem hash, arquivo ou caminho na resposta");
  assert.ok(!/<a\s/i.test(dh), "sem link para arquivo");
});

test("fluxo local: receber → prévia → confirmar → gerar propostas → aprovar → aplicar (operações reais, idempotentes, com histórico)", async () => {
  const cat = await ok("/api/fv2/conferencias/catalogo", {}, "operador");
  assert.ok(cat.arquivos.every((a) => !("conteudo" in a)) && /SINTÉTICOS/.test(cat.observacao));
  assert.match(conf.escolherArquivo(cat), /Confirmo o envio deste arquivo sintético/);
  // 1) receber: a prévia é a do motor; nada entra no financeiro.
  const r1 = await agir("/api/fv2/acoes/importacao/receber", { arquivo: "pedidos-saipos-0110" });
  assert.equal(r1.status, 200, JSON.stringify(r1.corpo));
  assert.equal(r1.corpo.importacao.estado, "PRONTO_PARA_IMPORTAR");
  const imp = r1.corpo.importacao.id;
  assert.match(imp, /^ref-/);
  // 5) o mesmo arquivo (também pela cópia do catálogo) devolve a mesma importação.
  const r2 = await agir("/api/fv2/acoes/importacao/receber", { arquivo: "pedidos-saipos-0110-copia" });
  assert.deepEqual([r2.corpo.repetido, r2.corpo.importacao.id], [true, imp]);
  assert.match(conf.resultadoDaAcao({ ok: true, dados: r2.corpo }), /Nada novo foi gravado/);
  // Revalidação: confirmar com impressão de prévia diferente é recusado; com a certa, grava.
  const det = await ok("/api/fv2/conferencias/documento", { id: imp }, "operador");
  assert.match(conf.detalheDocumento(det, { permissoes: ["financeiro_v2.importar"] }), /Confirmar importação/);
  assert.equal((await agir("/api/fv2/acoes/importacao/confirmar", { importacao: imp, impressaoPrevia: "0".repeat(64) })).status, 422);
  const c1 = await agir("/api/fv2/acoes/importacao/confirmar", { importacao: imp, impressaoPrevia: det.impressaoPrevia });
  assert.equal(c1.status, 200, JSON.stringify(c1.corpo));
  assert.match(conf.resultadoDaAcao({ ok: true, dados: c1.corpo }), /sem efeito financeiro/);
  // 6/13) confirmação repetida não grava de novo.
  const c2 = await agir("/api/fv2/acoes/importacao/confirmar", { importacao: imp, impressaoPrevia: det.impressaoPrevia });
  assert.equal(c2.corpo.repetido, true);
  // 7) arquivo incompatível: rejeitado na validação.
  const ruim = await agir("/api/fv2/acoes/importacao/receber", { arquivo: "arquivo-incompativel" });
  assert.equal(ruim.corpo.importacao.estado, "REJEITADO");
  // Propostas: gerar, aprovar (sem efeito), aplicar (efeito único).
  const g = await agir("/api/fv2/acoes/propostas/gerar", { importacao: imp });
  assert.equal(g.status, 200, JSON.stringify(g.corpo));
  const lista = await ok("/api/fv2/conferencias/propostas", { ...OUT, estado: "PROPOSTA" }, "operador");
  const dinheiro = lista.itens.find((p) => p.operacao === "VENDA" && p.valorCentavos === 2800);
  const dp = await ok("/api/fv2/conferencias/proposta", { id: dinheiro.id }, "operador");
  const ph = conf.detalheProposta(dp);
  for (const t of ["1. O que será registrado", "2. Por que", "3. Documento", "4. Efeito na DRE", "5. Efeito em recebíveis", "6. Efeito no caixa", "7. Dados pendentes", "8. Possíveis conflitos", "9. Autorização", "10. Histórico", "Detalhes técnicos"]) assert.ok(ph.includes(t), t);
  assert.match(ph, /Aprovar \(não registra nada\)/);
  assert.ok(!ph.includes("Aplicar: registrar o efeito"), "aplicar só aparece depois de aprovar");
  const antes = (await ok("/api/fv2/dre", OUT)).faturamentoBruto.valorCentavos;
  // 11) aprovação negada para o gestor (só leitura).
  assert.equal((await agir("/api/fv2/acoes/propostas/aprovar", { proposta: dinheiro.id }, { perfil: "gestor", token: (await ok("/api/fv2/sessao", {}, "gestor")).csrf })).status, 403);
  const ap = await agir("/api/fv2/acoes/propostas/aprovar", { proposta: dinheiro.id });
  assert.equal(ap.corpo.estado, "APROVADA");
  assert.equal((await ok("/api/fv2/dre", OUT)).faturamentoBruto.valorCentavos, antes, "aprovar não muda a DRE");
  assert.match(conf.detalheProposta(await ok("/api/fv2/conferencias/proposta", { id: dinheiro.id }, "operador")), /Aplicar: registrar o efeito/);
  const a1 = await agir("/api/fv2/acoes/propostas/aplicar", { proposta: dinheiro.id });
  const a2 = await agir("/api/fv2/acoes/propostas/aplicar", { proposta: dinheiro.id });
  assert.deepEqual([a1.status, a1.corpo.repetido, a2.corpo.repetido], [200, false, true]);
  assert.equal((await ok("/api/fv2/dre", OUT)).faturamentoBruto.valorCentavos, (antes ?? 0) + 2800, "aplicar registra uma única vez");
  const hist = (await ok("/api/fv2/conferencias/proposta", { id: dinheiro.id }, "operador")).historico.map((h) => h.estado);
  assert.deepEqual(hist.slice(-2), ["APROVADA", "APLICADA"]);
});

test("29 — segurança das ações: CSRF, confirmação explícita, campos, catálogo sintético, unidade e servidor", async () => {
  const corpo = { arquivo: "faturamento-saipos-0310" };
  assert.equal((await agir("/api/fv2/acoes/importacao/receber", corpo, { token: "x" })).status, 403);
  assert.equal((await agir("/api/fv2/acoes/importacao/receber", corpo, { token: "" })).status, 403);
  assert.equal((await agir("/api/fv2/acoes/importacao/receber", { ...corpo, confirmar: false })).status, 400);
  assert.equal((await agir("/api/fv2/acoes/importacao/receber", { ...corpo, organizacaoId: "x" })).status, 400);
  assert.equal((await agir("/api/fv2/acoes/importacao/receber", { arquivo: "C:/qualquer/extrato.pdf" })).status, 400, "só arquivos do catálogo sintético");
  assert.equal((await demo.agir("/api/fv2/acoes/importacao/receber", { unidade: U2, confirmar: true, ...corpo }, "operador", { csrf })).status, 403, "na unidade 2 o operador só vê");
  assert.equal((await demo.agir("/api/fv2/acoes/importacao/receber", { unidade: U1, confirmar: true, ...corpo }, "ausente", { csrf })).status, 401);
  assert.equal((await agir("/api/fv2/acoes/qualquer", corpo)).status, 404);
  // O token de um perfil não serve para outro.
  assert.equal((await demo.agir("/api/fv2/acoes/importacao/receber", { unidade: U1, confirmar: true, ...corpo }, "gestor", { csrf })).status, 403);
  const srv = servidor();
  assert.match(srv, /req\.method !== "POST"/);
  assert.match(srv, /origem !== `http:\/\/127\.0\.0\.1:\$\{PORTA\}`/);
  assert.match(srv, /\^application\\\/json\(;\|\$\)/);
  assert.match(srv, /bruto\.length > 8192/);
  assert.match(srv, /\.listen\(PORTA, "127\.0\.0\.1"/);
  // Ação no navegador: sem 2xx nunca vira sucesso.
  const falso = await enviar("/x", {}, {}, async () => ({ ok: false, status: 403, json: async () => ({ erro: "CSRF", mensagem: "Token inválido" }) }));
  assert.deepEqual([falso.ok, falso.mensagem], [false, "Token inválido"]);
  assert.match(conf.resultadoDaAcao(falso), /Não foi feito/);
  assert.deepEqual(await enviar("/x", {}, {}, async () => { throw new Error("rede"); }), { ok: false, status: 0, erro: "SEM_CONEXAO", mensagem: "Sem conexão: nada foi confirmado." });
});

test("14, 16 — conciliações: lados, critério e confiabilidade; confirmação com evidência pela operação real; repetida recusada", async () => {
  const set = await ok("/api/fv2/conferencias/correspondencias", SET);
  const forte = set.itens.find((x) => x.relacao === "SAIPOS_X_STONE");
  assert.ok(forte && forte.confiabilidade === "FORTE");
  const out = await ok("/api/fv2/conferencias/correspondencias", OUT, "operador");
  const energia = out.itens.find((x) => x.relacao === "MANUAL" && x.situacao === "CANDIDATA");
  const det = await ok("/api/fv2/conferencias/correspondencia", { id: energia.id }, "operador");
  assert.deepEqual([det.correspondencia.podeConfirmar, det.correspondencia.evidencias.length], [true, 1]);
  const dh = conf.detalheCorrespondencia(det);
  assert.match(dh, /Confirmar conciliação/);
  assert.match(dh, /Lado A/);
  assert.ok(!dh.includes("PAG CONCESSIONARIA"), "descrição bancária livre não aparece");
  assert.match(conf.detalheCorrespondencia(await ok("/api/fv2/conferencias/correspondencia", { id: energia.id })), /Confirmar exige a permissão/);
  const c1 = await agir("/api/fv2/acoes/conciliacoes/confirmar", { correspondencia: energia.id, justificativa: "Comprovante confere." });
  assert.equal(c1.corpo.situacao, "CONFIRMADA");
  assert.equal((await agir("/api/fv2/acoes/conciliacoes/confirmar", { correspondencia: energia.id, justificativa: "de novo" })).status, 409);
  const depois = await ok("/api/fv2/conferencias/correspondencia", { id: energia.id });
  assert.equal(depois.historico.at(-1).justificativa, "Comprovante confere.");
  const html = conf.central(out, { secao: "conciliacoes" }, { competencia: "2026-10", permissoes: ["financeiro_v2.conciliar"] });
  assert.match(html, /Candidata não é conciliação|é só candidata/);
});

test("17–20 — pendências agrupadas, Revisar com o que aconteceu, documentos e opções; detalhes técnicos recolhidos", async () => {
  const r = await ok("/api/fv2/conferencias/pendencias", { ...SET, tamanho: "100" });
  const chaves = r.itens.map((x) => x.chave);
  assert.equal(new Set(chaves).size, chaves.length);
  assert.ok(r.itens.some((x) => x.codigo === "OBRIGACAO_SEM_COMPROVANTE" && x.grupo === "DOCUMENTAIS"));
  assert.ok(r.itens.some((x) => x.codigo === "SAIDA_SEM_CLASSIFICACAO" && x.grupo === "CLASSIFICACOES"));
  assert.ok(r.itens.some((x) => x.codigo === "TOTAIS_DE_RELATORIOS_DIFERENTES" && x.bloqueia));
  assert.ok(r.itens.some((x) => x.codigo === "CREDITO_SEM_COMPROVACAO_BANCARIA" && x.grupo === "RECEBIMENTOS_E_REPASSES"));
  const html = conf.central(r, { secao: "pendencias" }, {});
  assert.ok(!/SAIDA_SEM_CLASSIFICACAO|OBRIGACAO_SEM_COMPROVANTE/.test(html), "lista principal sem códigos");
  assert.match(html, /Revisar/);
  const alvo = r.itens.find((x) => x.codigo === "SAIDA_SEM_CLASSIFICACAO");
  const det = await ok("/api/fv2/conferencias/pendencia", { ...SET, chave: alvo.chave });
  const dh = conf.detalhePendencia(det);
  for (const t of ["O que aconteceu", "Origem da informação", "Impacto financeiro", "Motivo da pendência", "Documentos existentes", "Documentos necessários", "O que pode ser feito", "Histórico de decisões"]) assert.ok(dh.includes(t), t);
  assert.match(dh, /<details class="tecnico"><summary>Detalhes técnicos<\/summary>/);
  assert.match(dh, /nunca por hipótese/);
  assert.equal((await get("/api/fv2/conferencias/pendencia", { ...SET, chave: "MOVIMENTACAO:ref-inexistente" })).status, 404);
});

test("21–25 — fechamento: etapas, metodologia, impedimentos, materialidade não presumida, histórico de revisões", async () => {
  const f = await ok("/api/fv2/conferencias/fechamento", SET);
  const html = conf.central(f, { secao: "fechamento" }, { competencia: "2026-09" });
  assert.match(html, /aria-current="step">Fechamento com pendências documentadas/);
  assert.match(html, /Impedimentos de homologação/);
  assert.match(html, /Nenhuma tolerância é aplicada/);
  assert.match(html, /Nunca é automática/);
  assert.match(html, /Em aberto \(não bloqueia\)|Conferido/);
  assert.match(html, /Diferença entre faturamento diário e formas de pagamento/);
  assert.deepEqual(f.historico.map((h) => h.para), ["FECHAMENTO_PRELIMINAR", "FECHAMENTO_COM_PENDENCIAS"]);
  assert.ok(!/homologar"|data-acao="[^"]*competencia/.test(html), "a demonstração não oferece homologar");
  const ago = await ok("/api/fv2/conferencias/fechamento", { competencia: "2026-08" });
  assert.equal(ago.estado, "FECHAMENTO_HOMOLOGADO");
});

test("35 — integração: DRE, Vendas, Caixa e Bancos e Contas a Pagar levam à MESMA pendência na Central (sem link falso)", async () => {
  const dre = await ok("/api/fv2/dre", SET);
  const dh = telas.dre(dre, {});
  const revisar = [...dh.matchAll(/href="#\/conferencias\?revisar=([^"]+)"/g)].map((m) => m[1]);
  assert.ok(revisar.length > 0);
  for (const chave of revisar) assert.equal((await get("/api/fv2/conferencias/pendencia", { ...SET, chave })).status, 200, chave);
  const div = await ok("/api/fv2/vendas/divergencias", { ...SET, tamanho: "100" });
  const vh = ven.vendasERecebimentos(div, { aba: "divergencias" });
  assert.match(vh, /Correspondências candidatas/);
  const links = [...vh.matchAll(/href="#\/conferencias\?competencia=2026-09&amp;revisar=([^"]+)"/g)].map((m) => m[1]);
  assert.ok(links.length >= 3);
  for (const chave of links) assert.equal((await get("/api/fv2/conferencias/pendencia", { ...SET, chave })).status, 200, chave);
  const cb = await ok("/api/fv2/caixa-e-bancos", { inicio: "2026-09-01", fim: "2026-09-30" });
  const ch = tes.caixaEBancos(cb, {});
  const mov = /competencia=(\d{4}-\d{2})&amp;revisar=(MOVIMENTACAO:ref-[0-9a-f]+)/.exec(ch);
  assert.ok(mov, "movimento sem vínculo tem ligação");
  assert.equal((await get("/api/fv2/conferencias/pendencia", { competencia: mov[1], chave: mov[2] })).status, 200);
  const cp = await ok("/api/fv2/contas-a-pagar", { competencia: "2026-09" });
  const pend = /competencia=2026-09&amp;revisar=(OBRIGACAO:ref-[0-9a-f]+:DOCUMENTO)/.exec(tes.contasAPagar(cp, {}));
  assert.ok(pend);
  assert.equal((await get("/api/fv2/conferencias/pendencia", { ...SET, chave: pend[1] })).status, 200);
  assert.match(telas.visaoGeral(await ok("/api/fv2/visao-geral", SET), {}), /Abrir a Central de Conferências/);
});

test("22, 23 — isolamento e sessão: outra unidade e outra organização; sem sessão; sem concessão; sem dados internos", async () => {
  for (const c of ["/api/fv2/conferencias", "/api/fv2/conferencias/documentos", "/api/fv2/conferencias/propostas", "/api/fv2/conferencias/correspondencias", "/api/fv2/conferencias/pendencias", "/api/fv2/conferencias/fechamento"]) {
    assert.equal((await get(c, SET, "ausente")).status, 401, c);
    assert.equal((await get(c, SET, "sem-acesso")).status, 403, c);
    assert.equal((await get(c, { ...SET, unidade: "bbbbbbbb-0000-4000-8000-0000000000b1" })).status, 403, c);
    const corpo = JSON.stringify((await ok(c, { ...SET, tamanho: "100" })));
    assert.ok(!UUID.test(corpo), `${c}: identificador interno`);
  }
  assert.equal((await ok("/api/fv2/conferencias/propostas", { ...SET, unidade: U2 })).paginacao.total, 0);
  const id = (await ok("/api/fv2/conferencias/propostas", SET)).itens[0].id;
  assert.equal((await get("/api/fv2/conferencias/proposta", { id, unidade: U2 })).status, 404);
});

test("26, 27 (troca de competência e resposta atrasada) — só a última consulta da Central é aplicada", async () => {
  const pendentes = [];
  const cons = criarConsultor((url, { signal }) => new Promise((resolve, reject) => {
    pendentes.push(() => resolve({ ok: true, status: 200, json: async () => ({ url }) }));
    signal?.addEventListener("abort", () => reject(Object.assign(new Error("abortada"), { name: "AbortError" })));
  }));
  const a = cons.consultar("/api/fv2/conferencias?competencia=2026-08");
  const b = cons.consultar("/api/fv2/conferencias/pendencias?competencia=2026-09");
  pendentes[1]();
  pendentes[0]();
  assert.equal(await a, null);
  assert.deepEqual(await b, { ok: true, dados: { url: "/api/fv2/conferencias/pendencias?competencia=2026-09" } });
  const app = arquivo("app.js");
  assert.match(app, /conteudo\.innerHTML = telas\.estado\("carregando"\)/);
  assert.match(app, /estado\.filtros\.conferencias = \{ secao: secao\.dataset\.secao \}/);
});

test("28, 30, 31 — celular, cartões e teclado: abas reais, formulários de ação com botão, Esc e foco", () => {
  const css = arquivo("fv2.css");
  const movel = css.slice(css.lastIndexOf("@media (max-width: 760px)"));
  assert.match(movel, /\.lados \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(movel, /\.tabela--cartoes td > \.cel/);
  assert.match(css, /details\.tecnico pre \{[^}]*overflow-wrap: anywhere/);
  const src = arquivo("telasConferencias.js");
  assert.ok(!/<td(?![^>]*data-rotulo)[^>]*>/.test(src.replace(/const td = [^\n]+/, "")), "td sem rótulo");
  assert.ok(!/\.reduce\(|Centavos\s*[+-]\s*\w+Centavos/.test(src), "tela recalculando valores");
  assert.ok(!/<div[^>]+data-(detalhe|secao|acao)/.test(src), "ações são botões/formulários reais");
  assert.match(src, /<input type="checkbox" name="confirmar" required>/);
  const app = arquivo("app.js");
  assert.match(app, /e\.key === "Escape"/);
  assert.match(app, /botao\.disabled = true/, "sem envio duplicado por clique repetido");
  assert.match(app, /if \(!painel\.contains\(origem\) \|\| !focoAntesDoPainel\) focoAntesDoPainel = origem;/);
  const html = arquivo("index.html");
  assert.match(html, /href="#\/conferencias" data-rota="conferencias"/);
  assert.ok(!/Importações e Conferências <small>em construção/.test(html));
});

test("34 — nenhum dado privado em logs: consultas e ações da Central não escrevem nada no console", async () => {
  const capturado = [];
  const originais = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(originais)) console[k] = (...a) => capturado.push(a.join(" "));
  try {
    await get("/api/fv2/conferencias", SET);
    await get("/api/fv2/conferencias/pendencias", SET);
    await agir("/api/fv2/acoes/importacao/receber", { arquivo: "stone-0110" });
    await agir("/api/fv2/acoes/importacao/receber", { arquivo: "inexistente" });
    await demo.agir("/api/fv2/acoes/importacao/receber", { unidade: U1, confirmar: true, arquivo: "stone-0110" }, "operador", { csrf: "errado" });
  } finally {
    Object.assign(console, originais);
  }
  assert.deepEqual(capturado, []);
  // Falha inesperada nunca devolve pilha nem mensagem interna.
  const falha = await demo.agir("/api/fv2/acoes/importacao/confirmar", { unidade: U1, confirmar: true, importacao: "ref-x", impressaoPrevia: 123 }, "operador", { csrf });
  assert.ok(falha.status >= 400 && !/at |\.js:\d+/.test(JSON.stringify(falha.corpo)));
});

test("30 (06C) — arquivos versionados da Central sem dado real: sem documento de pessoa/empresa, e-mail ou total privado de setembro", async () => {
  const { existsSync } = await import("node:fs");
  const raiz = (rel) => fileURLToPath(new URL(rel, import.meta.url));
  const versionados = [
    "../../backend/test/financeiro-v2/conferencias.test.js", "../../backend/test/financeiro-v2/postgres-conferencias-volume.test.js", "../../backend/scripts/fv2/demoInterface.mjs",
    "./financeiroV2Conferencias.test.js", "../financeiro-v2/telasConferencias.js", "../../docs/financeiro-v2/13-importacoes-conferencias.md",
    "../../backend/src/modules/financeiro-v2/dominio/conferencias.js", "../../backend/src/modules/financeiro-v2/aplicacao/conferencias.js",
  ].map(raiz).filter(existsSync).map((p) => readFileSync(p, "utf8"));
  assert.equal(versionados.length, 8);
  for (const t of versionados) {
    assert.ok(!/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b|\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/.test(t), "documento de pessoa/empresa");
    assert.ok(!/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(t), "e-mail");
  }
  // Totais REAIS de setembro ficam no documento privado (fora do Git): quando ele existe aqui, nenhum valor dele aparece.
  const privado = raiz("../../docs/financeiro-v2/02-referencia-setembro.md");
  if (!existsSync(privado)) return;
  const reais = [...readFileSync(privado, "utf8").matchAll(/\b(\d{1,3}(?:\.\d{3})+|\d{3,}),(\d{2})\b/g)].map((m) => `${m[1].replace(/\./g, "")}${m[2]}`).filter((c) => Number(c) >= 10000);
  for (const t of versionados) {
    const texto = t.replace(/\./g, "");
    const achou = reais.filter((c) => new RegExp(`(^|[^\d])${c}([^\d]|$)`).test(texto) || texto.includes(`${c.slice(0, -2)},${c.slice(-2)}`));
    assert.equal(achou.length, 0, "valor do documento privado de setembro encontrado em arquivo versionado");
  }
});
