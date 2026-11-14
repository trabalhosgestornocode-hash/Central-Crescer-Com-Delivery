// Execução 06D — interface de Configurações, Documentos e Fechamento do Financeiro v2, sobre a demonstração local
// (núcleo REAL, concessões gravadas, CSRF e confirmação). Dados 100% SINTÉTICOS. Data-base da demonstração: 12/11/2026.
// Rodar: node --test frontend/test/financeiroV2Administracao.test.js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as adm from "../financeiro-v2/telasAdministracao.js";
import * as conf from "../financeiro-v2/telasConferencias.js";
import * as telas from "../financeiro-v2/telas.js";
import { criarConsultor } from "../financeiro-v2/consulta.js";
import { criarDemo, UNIDADES } from "../../backend/scripts/fv2/demoInterface.mjs";

let demo;
const U1 = UNIDADES[0].id;
const U2 = UNIDADES[1].id;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const arquivo = (nome) => readFileSync(fileURLToPath(new URL(`../financeiro-v2/${nome}`, import.meta.url)), "utf8");
const get = (caminho, params = {}, perfil = "administrador") => demo.responder(caminho, { unidade: U1, ...params }, perfil);
const ok = async (caminho, params, perfil) => { const r = await get(caminho, params, perfil); assert.equal(r.status, 200, JSON.stringify(r.corpo)); return r.corpo; };
const csrf = async (perfil) => (await demo.responder("/api/fv2/sessao", {}, perfil)).corpo.csrf;
const agir = async (caminho, corpo, perfil = "administrador", token) => demo.agir(caminho, { unidade: U1, confirmar: true, ...corpo }, perfil, { csrf: token ?? await csrf(perfil) });
before(async () => { demo = await criarDemo(); });

test("31, 32 — ação de fechamento exige CSRF e confirmação; repetir não duplica", async () => {
  const sem = await demo.agir("/api/fv2/acoes/fechamento/alterar", { unidade: U1, confirmar: true, competencia: "2026-10", novoEstado: "FECHAMENTO_PRELIMINAR" }, "administrador", { csrf: "" });
  assert.equal(sem.status, 403);
  const outroPerfil = await agir("/api/fv2/acoes/fechamento/alterar", { competencia: "2026-10", novoEstado: "FECHAMENTO_PRELIMINAR" }, "administrador", await csrf("gestor"));
  assert.equal(outroPerfil.status, 403, "token de outro perfil não serve");
  const semConfirmar = await demo.agir("/api/fv2/acoes/fechamento/alterar", { unidade: U1, competencia: "2026-10", novoEstado: "FECHAMENTO_PRELIMINAR" }, "administrador", { csrf: await csrf("administrador") });
  assert.equal(semConfirmar.status, 400);
  const r1 = await agir("/api/fv2/acoes/fechamento/alterar", { competencia: "2026-10", novoEstado: "FECHAMENTO_PRELIMINAR" });
  assert.deepEqual([r1.status, r1.corpo.estado, r1.corpo.versao.tipo], [200, "FECHAMENTO_PRELIMINAR", "PRELIMINAR"]);
  const r2 = await agir("/api/fv2/acoes/fechamento/alterar", { competencia: "2026-10", novoEstado: "FECHAMENTO_PRELIMINAR" });
  assert.equal(r2.corpo.repetido, true);
  assert.match(conf.resultadoDaAcao({ ok: true, dados: r2.corpo }), /repetição segura/);
  const versoes = (await ok("/api/fv2/conferencias/fechamento", { competencia: "2026-10" })).versoes;
  assert.equal(versoes.length, 1);
  // O gestor (só leitura) não muda o estado.
  const gestor = await agir("/api/fv2/acoes/fechamento/alterar", { competencia: "2026-10", novoEstado: "ABERTA", justificativa: "x" }, "gestor");
  assert.equal(gestor.status, 403);
});

test("33–36 — fechamento na Central: prévia do núcleo, botão desabilitado quando bloqueado, pendências documentadas, reabertura", async () => {
  const f = await ok("/api/fv2/conferencias/fechamento", { competencia: "2026-09" });
  const html = conf.central({ ...f, dataBase: f.dataBase }, { secao: "fechamento" }, { competencia: "2026-09", unidadeNome: "U", permissoes: [] });
  const homol = f.acoes.find((a) => a.estadoProposto === "FECHAMENTO_HOMOLOGADO");
  assert.equal(homol.permitida, false);
  assert.ok(homol.bloqueios.length > 0);
  assert.match(html, /Homologar a competência<\/h3>/);
  assert.match(html, /<button type="button" class="botao" disabled aria-describedby="bloq-FECHAMENTO_HOMOLOGADO">/, "botão desabilitado quando o núcleo não permite");
  assert.match(html, /Estado atual<\/dt>/);
  assert.match(html, /Permissão exigida<\/dt><dd>homologar · você tem/);
  assert.match(html, /Pendências diante da homologação/);
  assert.match(html, /Versões do fechamento/);
  // Outubro: preliminar → com pendências documentadas → reabrir com justificativa.
  // 08E (F-1): nada é documentado em nome da pessoa (antes a demonstração documentava TODAS com o mesmo texto: contorno).
  await agir("/api/fv2/acoes/fechamento/alterar", { competencia: "2026-10", novoEstado: "FECHAMENTO_PRELIMINAR" });
  const antigo = await agir("/api/fv2/acoes/fechamento/alterar", { competencia: "2026-10", novoEstado: "FECHAMENTO_COM_PENDENCIAS", justificativa: "Documentando.", documentacaoFaltante: "Extrato de outubro", decisao: "Aguardar extrato" });
  assert.equal(antigo.status, 400, "a documentação em lote pela transição não existe mais");
  const semDoc = await agir("/api/fv2/acoes/fechamento/alterar", { competencia: "2026-10", novoEstado: "FECHAMENTO_COM_PENDENCIAS", justificativa: "Documentando." });
  assert.equal(semDoc.status, 409, "sem nenhuma pendência documentada, não há fechamento com pendências");
  const lista = await ok("/api/fv2/conferencias/pendencias", { competencia: "2026-10", tamanho: "100" });
  const alvo = lista.itens.find((p) => p.codigo === "FONTE_SEM_DOCUMENTO");
  const docum = await agir("/api/fv2/acoes/pendencias/documentar", { competencia: "2026-10", chave: alvo.chave, descricao: alvo.titulo, impacto: "Conferência cruzada incompleta (sintético).", decisao: "Aguardar extrato", documentacaoFaltante: "Extrato de outubro" });
  assert.equal(docum.status, 200, JSON.stringify(docum.corpo));
  assert.equal(docum.corpo.avaliacao.situacao, "DOCUMENTADA_ADMISSIVEL");
  assert.match(conf.resultadoDaAcao({ ok: true, dados: docum.corpo }), /Documentar não resolve/);
  // A documentação fica na competência e aparece na tela (com impacto, decisão e o que falta).
  const fOut = await ok("/api/fv2/conferencias/fechamento", { competencia: "2026-10" });
  assert.ok(fOut.pendenciasDocumentadas.some((p) => p.descricao && p.impacto && p.documentacaoFaltante === "Extrato de outubro" && p.decisao === "Aguardar extrato"));
  const htmlOut = conf.central({ ...fOut, dataBase: fOut.dataBase }, { secao: "fechamento" }, { competencia: "2026-10", unidadeNome: "U", permissoes: [] });
  assert.match(htmlOut, /Impacto: /, "pendências documentadas com impacto");
  assert.match(htmlOut, /Documentar não resolve/);
  // 08E (achado da jornada): outubro ainda tem bloqueantes e pendências não documentadas — "com pendências documentadas"
  // não serve para estacioná-las: recusado, com os motivos; a tela também não oferece.
  const cp = await agir("/api/fv2/acoes/fechamento/alterar", { competencia: "2026-10", novoEstado: "FECHAMENTO_COM_PENDENCIAS", justificativa: "Documentando." });
  assert.equal(cp.status, 409, JSON.stringify(cp.corpo));
  assert.match(cp.corpo.mensagem, /bloqueante|não documentada/);
  assert.equal(fOut.acoes.find((a) => a.estadoProposto === "FECHAMENTO_COM_PENDENCIAS").permitida, false);
  const semJust = await agir("/api/fv2/acoes/fechamento/alterar", { competencia: "2026-10", novoEstado: "ABERTA" });
  assert.equal(semJust.status, 409);
  const reaberta = await agir("/api/fv2/acoes/fechamento/alterar", { competencia: "2026-10", novoEstado: "ABERTA", justificativa: "Extrato chegou." });
  assert.deepEqual([reaberta.status, reaberta.corpo.estado, reaberta.corpo.revisoes], [200, "ABERTA", 1]);
  // Agosto homologado na demonstração: reabrir exige "revisar" (administrador tem) — e a homologada anterior fica registrada.
  const ago = await agir("/api/fv2/acoes/fechamento/alterar", { competencia: "2026-08", novoEstado: "ABERTA", justificativa: "Revisão sintética." });
  assert.equal(ago.status, 200);
  assert.match(ago.corpo.versaoHomologadaAnteriorId, /^ref-/);
  const vAgo = (await ok("/api/fv2/conferencias/fechamento", { competencia: "2026-08" })).versoes;
  assert.ok(vAgo.some((v) => v.tipo === "HOMOLOGADA" && !v.vigente));
  // Homologar de novo agosto: as ressalvas documentadas continuam; do preliminar o botão fica desabilitado (passar por
  // "com pendências documentadas"); depois dele, habilitado — ação real.
  await agir("/api/fv2/acoes/fechamento/alterar", { competencia: "2026-08", novoEstado: "FECHAMENTO_PRELIMINAR" });
  const doPreliminar = (await ok("/api/fv2/conferencias/fechamento", { competencia: "2026-08" })).acoes.find((a) => a.estadoProposto === "FECHAMENTO_HOMOLOGADO");
  assert.equal(doPreliminar.permitida, false);
  assert.ok(doPreliminar.bloqueios.some((b) => /com pendências documentadas/.test(b)), JSON.stringify(doPreliminar.bloqueios));
  assert.equal((await agir("/api/fv2/acoes/fechamento/alterar", { competencia: "2026-08", novoEstado: "FECHAMENTO_COM_PENDENCIAS", justificativa: "Ressalvas mantidas." })).status, 200);
  const prev = (await ok("/api/fv2/conferencias/fechamento", { competencia: "2026-08" })).acoes.find((a) => a.estadoProposto === "FECHAMENTO_HOMOLOGADO");
  assert.equal(prev.permitida, true, JSON.stringify(prev.bloqueios));
  const h = await agir("/api/fv2/acoes/fechamento/alterar", { competencia: "2026-08", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Conferência sintética de agosto." });
  assert.deepEqual([h.status, h.corpo.estado, h.corpo.versao.tipo, h.corpo.versao.comRessalvas], [200, "FECHAMENTO_HOMOLOGADO", "HOMOLOGADA", true]);
  const telaAgo = conf.central({ ...(await ok("/api/fv2/conferencias/fechamento", { competencia: "2026-08" })), dataBase: "2026-10-15" }, { secao: "fechamento" }, { competencia: "2026-08", unidadeNome: "U", permissoes: [] });
  assert.match(telaAgo, /Pendências diante da homologação/);
  assert.match(telaAgo, /Com \d+ ressalva\(s\) aprovada\(s\)/);
});

test("41 — DRE e Visão Geral da competência homologada: versão homologada reproduzível e situação visível", async () => {
  const dre = await ok("/api/fv2/dre", { competencia: "2026-08" });
  assert.equal(dre.versaoHomologada.reproduz, true);
  const html = telas.dre(dre, { unidadeNome: "U" });
  assert.match(html, /Versão homologada nº \d+/);
  assert.match(html, /reproduz exatamente esta versão/);
  // Se não reproduzisse, a DRE mostraria os valores do retrato homologado (simulado aqui só na apresentação).
  const divergente = telas.dre({ ...dre, versaoHomologada: { ...dre.versaoHomologada, reproduz: false } }, { unidadeNome: "U" });
  assert.match(divergente, /valores abaixo são os da VERSÃO HOMOLOGADA/);
  const vg = await ok("/api/fv2/visao-geral", { competencia: "2026-08" });
  assert.equal(vg.fechamento.estado, "FECHAMENTO_HOMOLOGADO");
  assert.match(telas.visaoGeral(vg, { unidadeNome: "U" }), /data-estado-competencia="FECHAMENTO_HOMOLOGADO">Competência homologada/);
  assert.equal(vg.faturamentoBruto.valorCentavos, dre.versaoHomologada.apuracao.indicadores.FATURAMENTO_BRUTO_PROPRIO.valorCentavos);
});

test("13–15, 18–21 — Configurações e permissões pela interface; revogação vale na ação seguinte", async () => {
  const cfg = await ok("/api/fv2/configuracoes");
  const html = adm.configuracoes(cfg, { secao: "canais" }, { unidadeNome: "U" });
  assert.match(html, /taxas desconhecidas não são presumidas/);
  assert.ok(!/taxa(Contratual)?"? *name/i.test(html), "não há campo de taxa contratual");
  const canal = await agir("/api/fv2/acoes/configuracoes/canal", { papel: "CANAL", codigo: "DELIVERY_PROPRIO", codigoBase: "OUTRO", nome: "Entrega própria (sintético)", situacao: "ATIVO", justificativa: "Pedidos por telefone." });
  assert.equal(canal.status, 200, JSON.stringify(canal.corpo));
  const proc = await agir("/api/fv2/acoes/configuracoes/canal", { papel: "PROCESSADOR", codigo: "VALE_SINTETICO", codigoBase: "OPERADORA_BENEFICIOS", nome: "Vale sintético", justificativa: "Operadora de vale." });
  assert.equal(proc.status, 200);
  const conta = cfg.contas.find((c) => c.tipo === "BANCARIA");
  assert.equal((await agir("/api/fv2/acoes/configuracoes/conta", { conta: conta.id, nome: "Unicred (sintética)", justificativa: "Nome." })).status, 200);
  assert.equal((await agir("/api/fv2/acoes/configuracoes/conta", { conta: conta.id, nome: "x", justificativa: "x" }, "operador")).status, 403);
  // Permissões: concessão e escalada pela interface.
  const perm = await ok("/api/fv2/permissoes");
  assert.ok(perm.itens.every((x) => !UUID.test(x.usuarioId)), "pessoas aparecem pelo nome sintético, nunca pelo id");
  assert.ok(perm.itens.some((x) => x.usuarioId === "Operador (demonstração)"));
  const htmlPerm = adm.configuracoes({ permissoes: perm }, { secao: "permissoes" }, { unidadeNome: "U", pessoasDemo: (await demo.responder("/api/fv2/sessao", {}, "administrador")).corpo.pessoasDemo });
  assert.match(htmlPerm, /Ninguém concede nem revoga o próprio acesso/);
  assert.equal((await agir("/api/fv2/acoes/permissoes/conceder", { usuario: "administrador", acao_ver: "on", justificativa: "x" })).status, 403, "autoconcessão");
  assert.equal((await agir("/api/fv2/acoes/permissoes/conceder", { usuario: "gestor", acao_homologar: "on", justificativa: "x" }, "operador")).status, 403, "operador não concede");
  // Revogação: o operador concilia → revoga-se → a próxima ação dele é recusada (mesmo token e sessão).
  const antes = await agir("/api/fv2/acoes/conciliacoes/gerar", { competencia: "2026-10" }, "operador");
  assert.equal(antes.status, 200, JSON.stringify(antes.corpo));
  assert.equal((await agir("/api/fv2/acoes/permissoes/revogar", { usuario: "operador", acao_conciliar: "on", justificativa: "Mudou de função." })).status, 200);
  const depois = await agir("/api/fv2/acoes/conciliacoes/gerar", { competencia: "2026-10" }, "operador");
  assert.equal(depois.status, 403);
  const sessao = (await demo.responder("/api/fv2/sessao", {}, "operador")).corpo.unidades.find((u) => u.id === U1);
  assert.ok(!sessao.permissoes.includes("financeiro_v2.conciliar"), "a sessão seguinte já vem sem a ação");
  assert.equal((await agir("/api/fv2/acoes/permissoes/conceder", { usuario: "operador", acao_conciliar: "on", justificativa: "Voltou à função." })).status, 200);
});

test("23, 24 — responsável por pendência pela interface: só pessoas com acesso; histórico", async () => {
  const lista = await ok("/api/fv2/conferencias/pendencias", { competencia: "2026-09", situacao: "A_RESOLVER" });
  const p = lista.itens[0];
  const pessoas = (await ok("/api/fv2/pessoas")).pessoas;
  assert.deepEqual(pessoas.map((x) => x.perfil).sort(), ["administrador", "gestor", "operador"]);
  const det = await ok("/api/fv2/conferencias/pendencia", { competencia: "2026-09", chave: p.chave });
  const html = conf.detalhePendencia(det, { pessoas, competencia: "2026-09" });
  assert.match(html, /Atribuir responsável/);
  assert.ok(!/sem-acesso/.test(html), "quem não tem acesso não aparece como responsável possível");
  assert.equal((await agir("/api/fv2/acoes/pendencias/atribuir", { competencia: "2026-09", chave: p.chave, responsavel: "sem-acesso" })).status, 400);
  const a = await agir("/api/fv2/acoes/pendencias/atribuir", { competencia: "2026-09", chave: p.chave, responsavel: "operador", dataRevisao: "2026-11-20", comentario: "Conferir o extrato." });
  assert.equal(a.status, 200, JSON.stringify(a.corpo));
  assert.equal((await agir("/api/fv2/acoes/pendencias/atribuir", { competencia: "2026-09", chave: p.chave, responsavel: "gestor" })).status, 400, "reatribuir sem justificativa");
  assert.equal((await agir("/api/fv2/acoes/pendencias/atribuir", { competencia: "2026-09", chave: p.chave, responsavel: "gestor", justificativa: "Redistribuição." })).status, 200);
  const det2 = await ok("/api/fv2/conferencias/pendencia", { competencia: "2026-09", chave: p.chave });
  assert.equal(det2.atribuicao.responsavelId, "Gestor (demonstração)");
  assert.equal(det2.historicoDaAtribuicao.length, 2);
  assert.match(conf.detalhePendencia(det2, { pessoas, competencia: "2026-09" }), /de Operador \(demonstração\) para Gestor \(demonstração\)/);
});

test("25–30 — documentos pela interface: ficha para quem vê, arquivo só com permissão, outra unidade negada, cabeçalhos seguros", async () => {
  const lista = await ok("/api/fv2/documentos");
  const html = adm.documentos(lista, {});
  assert.match(html, /Você tem esta permissão/);
  const pdf = lista.itens.find((x) => x.tipo === "COMPROVANTE" && x.vigente && x.arquivoNoCofre);
  const ativo = lista.itens.find((x) => x.tipo === "NOTA_FISCAL" && x.arquivoNoCofre);
  const semArquivo = lista.itens.find((x) => !x.arquivoNoCofre);
  assert.ok(pdf && ativo && semArquivo);
  const det = await ok("/api/fv2/documento", { id: pdf.id });
  const dh = adm.detalheDocumentoCofre(det);
  assert.match(dh, /data-documento-ver=/);
  assert.ok(!/<a\s[^>]*href=/.test(dh), "nenhum link direto para arquivo");
  assert.deepEqual(det.versoes.map((v) => v.versao), [2, 1]);
  const vis = await get("/api/fv2/documentos/arquivo", { id: pdf.id, finalidade: "visualizar" });
  assert.equal(vis.status, 200);
  assert.equal(vis.cabecalhos["content-type"], "application/pdf");
  assert.match(vis.cabecalhos["content-security-policy"], /sandbox/);
  assert.equal(vis.cabecalhos["x-content-type-options"], "nosniff");
  assert.equal(vis.binario.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.equal((await get("/api/fv2/documentos/arquivo", { id: ativo.id, finalidade: "visualizar" })).status, 409, "PDF com conteúdo ativo não é exibido");
  assert.equal((await get("/api/fv2/documentos/arquivo", { id: ativo.id, finalidade: "baixar" })).cabecalhos["content-type"], "application/octet-stream");
  assert.equal((await get("/api/fv2/documentos/arquivo", { id: semArquivo.id, finalidade: "baixar" })).status, 409);
  // Sem a ação de documentos: só a ficha.
  assert.equal((await get("/api/fv2/documentos/arquivo", { id: pdf.id, finalidade: "baixar" }, "gestor")).status, 403);
  const dg = adm.detalheDocumentoCofre(await ok("/api/fv2/documento", { id: pdf.id }, "gestor"));
  assert.ok(!/data-documento-ver=/.test(dg) && /exige a permissão/.test(dg));
  // Outra unidade e caminho arbitrário.
  assert.equal((await demo.responder("/api/fv2/documentos/arquivo", { unidade: U2, id: pdf.id, finalidade: "baixar" }, "administrador")).status, 404);
  assert.equal((await get("/api/fv2/documentos/arquivo", { id: "../../etc/passwd", finalidade: "baixar" })).status, 404);
  assert.equal((await get("/api/fv2/documentos/arquivo", { id: pdf.id, finalidade: "executar" })).status, 400);
  // Verificação de integridade pela ação (grava o resultado no histórico).
  const v = await agir("/api/fv2/acoes/documentos/verificar", { documento: pdf.id });
  assert.equal(v.corpo.conferido, true);
  assert.match(conf.resultadoDaAcao({ ok: true, dados: v.corpo }), /Integridade conferida/);
  for (const c of ["/api/fv2/documentos", "/api/fv2/documento"]) assert.ok(!UUID.test(JSON.stringify((await get(c, { id: pdf.id })).corpo)), `${c} sem identificadores internos`);
});

test("37, 38 — troca rápida de unidade só aplica a última resposta; sessão expirada é recusada com mensagem clara", async () => {
  const resolucoes = [];
  const fetchFalso = (url) => new Promise((resolve) => { resolucoes.push(() => resolve({ ok: true, status: 200, json: async () => ({ url }) })); });
  const c = criarConsultor(fetchFalso);
  const a = c.consultar(`/api/fv2/configuracoes?unidade=${U1}`, {});
  const b = c.consultar(`/api/fv2/configuracoes?unidade=${U2}`, {});
  resolucoes[1]();
  resolucoes[0]();
  assert.equal(await a, null, "a resposta da unidade anterior é descartada");
  assert.equal((await b).dados.url, `/api/fv2/configuracoes?unidade=${U2}`);
  const exp = await demo.responder("/api/fv2/configuracoes", { unidade: U1 }, "expirada");
  assert.equal(exp.status, 401);
  assert.match(exp.corpo.mensagem, /expirada/i);
  assert.equal((await demo.agir("/api/fv2/acoes/fechamento/alterar", { unidade: U1, confirmar: true, competencia: "2026-10", novoEstado: "FECHAMENTO_PRELIMINAR" }, "expirada", { csrf: await csrf("expirada") })).status, 401);
  const appJs = arquivo("app.js");
  assert.match(appJs, /Sua sessão expirou/);
  assert.match(appJs, /estado\.pessoas = null; estado\.configuracoes = null;/, "troca de unidade limpa dados da unidade anterior");
});

test("39, 40 — responsivo e acessível: abas por botão, quadro de PDF sem rolagem lateral, Esc e foco", () => {
  const css = arquivo("fv2.css");
  assert.match(css, /\.acoes-fechamento \{ display: grid; grid-template-columns: repeat\(auto-fit, minmax\(280px, 1fr\)\)/);
  assert.match(css, /\.quadro-pdf \{ width: 100%/);
  assert.match(css, /\.acao input, \.acao select, \.acao textarea \{[^}]*width: 100%; min-width: 0;/);
  const html = adm.configuracoes({ unidade: null, contas: [], canais: [], processadores: [], observacaoComercial: "", planoDeContas: { regras: [] }, metodologias: [], competencias: [], voce: {} }, { secao: "unidade" }, {});
  assert.match(html, /<nav class="abas abas--botoes" aria-label="Seções de configurações"><button type="button" data-secao-config="unidade" aria-current="page">/);
  const appJs = arquivo("app.js");
  assert.match(appJs, /if \(e\.key === "Escape"\) fecharPainel\(\)/);
  assert.match(appJs, /focoAntesDoPainel\?\.focus\(\)/);
  assert.match(appJs, /data-secao-config="\$\{secaoConfig\.dataset\.secaoConfig\}"\]`\)\?\.focus\(\)/);
  const index = arquivo("index.html");
  assert.match(index, /href="#\/configuracoes" data-rota="configuracoes"/);
  assert.match(index, /href="#\/documentos" data-rota="documentos"/);
  assert.ok(!/Configurações <small>em construção/.test(index));
});
