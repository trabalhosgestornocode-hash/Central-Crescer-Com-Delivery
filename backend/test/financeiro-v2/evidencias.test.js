// Execução 08D — ENVIO DE EVIDÊNCIAS pela interface: formato comprovado pelo conteúdo, nome não confiável, permissão
// própria, escopo, idempotência, protocolo cofre → banco (falha no meio), conferência do cofre e uso na reclassificação.
// Memória e PostgreSQL (FV2_REPOSITORIO=postgres). Arquivos e valores sintéticos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACAO, CODIGO, criarCofreDisco, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { AGORA, ESCOPOS_PADRAO, ORG_A, TODAS, UNI_A, UNI_A2, ctx, montar, montarComCadastros, obrigacao, provisionarAdministrador, rejeita } from "./helpers/cenario.js";
import { motivoParaPular, repositorioPostgresDeTeste } from "./helpers/postgres.js";

const bytes = (t) => new TextEncoder().encode(t);
const pdf = (texto) => bytes(`%PDF-1.4\n% ${texto}\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n`);
const png = () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const envio = (registroId, extra = {}) => ({
  arquivo: { conteudo: pdf("Nota fiscal sintetica: servico de contabilidade outubro"), nome: "nota-contabilidade.pdf", tipoMime: "application/pdf" },
  tipo: "NOTA_FISCAL", descricao: "Nota que identifica o boleto (sintética)", competencia: "2026-09", vinculo: { registroTipo: "LANCAMENTO", registroId }, ...extra,
});

async function cenario(opcoes) {
  const m = await montarComCadastros(opcoes);
  const { nucleo: n, c, fornecedor } = m;
  const pendente = await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 18990, categoria: "DESPESAS_A_CLASSIFICAR", descricao: "Boleto sem identificação (sintético)" }));
  return { ...m, n, pendente, l: pendente.lancamento };
}

test("08D — envio válido: cofre íntegro, ficha + vínculo, histórico; anexar NÃO resolve a classificação", async () => {
  const { n, c, l, cofre } = await cenario();
  const r = await n.enviarEvidencia(c, envio(l.id));
  assert.deepEqual([r.repetido, r.validacao.formato, r.validacao.hashConferido, r.validacao.conteudoAtivo, r.validacao.nome], [false, "PDF", true, false, "nota-contabilidade.pdf"]);
  const [doc] = (await n.consultarRegistros(c, { tipo: "DOCUMENTO" })).filter((d) => d.id === r.documento.id);
  assert.ok(doc.enviadoPelaInterface && doc.arquivoId.startsWith("cofre:") && !/nota|contab/i.test(doc.arquivoId), "identificador opaco, sem nome");
  assert.ok(await cofre.existe(c, doc.arquivoId));
  const vinculos = (await n.consultarRegistros(c, { tipo: "VINCULO_DOCUMENTAL" })).filter((v) => v.registroId === l.id);
  assert.equal(vinculos.length, 1);
  // A pendência de classificação continua: anexar não é decisão.
  const pend = await n.consultarPendencias(c, { competencia: "2026-09", grupo: "CLASSIFICACOES", tamanho: 100 });
  assert.ok(pend.itens.some((p) => p.codigo === "DESPESA_A_CLASSIFICAR"));
  assert.ok((await n.consultarFechamento(c, { competencia: "2026-09" })).impedimentos.some((i) => i.codigo === "CLASSIFICACAO_PROVISORIA"));
  // A reclassificação reconhece a evidência ENVIADA (sem precisar escolher outro documento) e só então resolve.
  const consulta = await n.consultarReclassificacao(c, { lancamentoId: l.id, categoria: "DESPESAS_ADMINISTRATIVAS_GERAIS" });
  assert.equal(consulta.impacto.evidenciaDisponivel, true);
  assert.ok(consulta.evidencias.some((e) => e.referencia === r.documento.id));
  await n.reclassificarLancamento(c, { lancamentoId: l.id, categoria: "DESPESAS_ADMINISTRATIVAS_GERAIS", justificativa: "Nota fiscal enviada identifica o serviço (sintético).", versaoEsperada: l.versao });
  assert.ok(!(await n.consultarFechamento(c, { competencia: "2026-09" })).impedimentos.some((i) => i.codigo === "CLASSIFICACAO_PROVISORIA"));
});

test("08D — nada no arquivo é confiável: tipo, extensão e conteúdo precisam bater; nome hostil vira só rótulo", async () => {
  const { n, c, l, cofre } = await cenario();
  const tentar = (arquivo) => rejeita(n.enviarEvidencia(c, envio(l.id, { arquivo })), CODIGO.DOCUMENTO_INVALIDO);
  await tentar({ conteudo: bytes("apenas texto"), nome: "falso.pdf", tipoMime: "application/pdf" }); // sem assinatura de PDF
  await tentar({ conteudo: Uint8Array.from([0x4d, 0x5a, 0x90, 0]), nome: "programa.pdf", tipoMime: "application/pdf" }); // executável
  await tentar({ conteudo: pdf("x"), nome: "nota.png", tipoMime: "application/pdf" }); // extensão ≠ tipo
  await tentar({ conteudo: bytes("<html><script>alert(1)</script></html>"), nome: "pagina.html", tipoMime: "text/html" }); // formato não aceito
  await tentar({ conteudo: bytes("<svg onload=alert(1)></svg>"), nome: "x.svg", tipoMime: "image/svg+xml" });
  await tentar({ conteudo: new Uint8Array(0), nome: "vazio.pdf", tipoMime: "application/pdf" });
  const grande = new Uint8Array(10 * 1024 * 1024 + 1); grande.set(pdf("x"));
  await tentar({ conteudo: grande, nome: "grande.pdf", tipoMime: "application/pdf" });
  assert.deepEqual(await cofre.inventario(c), [], "nada recusado chegou ao cofre");
  // Nome com caminho e caracteres de controle: só o último trecho, higienizado, como rótulo — nunca caminho.
  const r = await n.enviarEvidencia(c, envio(l.id, { arquivo: { conteudo: png(), nome: "..\\..\\windows\\system32\\a\u0000b<c>.png", tipoMime: "image/png" }, tipo: "COMPROVANTE" }));
  assert.equal(r.validacao.nome, "ab_c_.png");
  // PDF com conteúdo ativo é aceito (pode ser um comprovante real), mas marcado: só download (política de visualização).
  const ativo = await n.enviarEvidencia(c, envio(l.id, { arquivo: { conteudo: bytes("%PDF-1.4\n<< /OpenAction << /S /JavaScript /JS (x) >> >>\n%%EOF"), nome: "ativo.pdf", tipoMime: "application/pdf" } }));
  assert.equal(ativo.validacao.conteudoAtivo, true);
});

test("08D — permissão própria, escopo da unidade e separação enviar ≠ abrir ≠ decidir", async () => {
  const { n, c, l, cofre } = await cenario();
  const semEnviar = ctx(ORG_A, UNI_A, TODAS.filter((a) => a !== ACAO.ENVIAR_DOCUMENTO));
  await rejeita(n.enviarEvidencia(semEnviar, envio(l.id)), CODIGO.PERMISSAO_INSUFICIENTE);
  // Lançamento de OUTRA unidade: não encontrado — e nenhum arquivo guardado.
  await rejeita(n.enviarEvidencia(ctx(ORG_A, UNI_A2), envio(l.id)), CODIGO.NAO_ENCONTRADO);
  assert.deepEqual(await cofre.inventario(c), []);
  assert.deepEqual(await cofre.inventario(ctx(ORG_A, UNI_A2)), []);
  // Quem só envia: guarda e vincula, mas não abre o arquivo nem reclassifica.
  const soEnvia = ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.ENVIAR_DOCUMENTO]);
  const r = await n.enviarEvidencia(soEnvia, envio(l.id));
  await rejeita(n.obterArquivoDoDocumento(soEnvia, { id: r.documento.id, finalidade: "BAIXAR" }), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(n.reclassificarLancamento(soEnvia, { lancamentoId: l.id, categoria: "EMBALAGENS", justificativa: "x", versaoEsperada: l.versao }), CODIGO.PERMISSAO_INSUFICIENTE);
});

test("08D — repetição não duplica; o mesmo arquivo em outro registro reaproveita a ficha", async () => {
  const { n, c, l, fornecedor } = await cenario();
  const a = await n.enviarEvidencia(c, envio(l.id));
  const b2 = await n.enviarEvidencia(c, envio(l.id));
  assert.deepEqual([b2.repetido, b2.documento.id], [true, a.documento.id]);
  const outra = await n.registrarObrigacao(c, obrigacao(fornecedor.id, { fonte: { sistema: "MANUAL", idExterno: "OUTRA" } }));
  const c3 = await n.enviarEvidencia(c, envio(outra.obrigacoes[0].id, { vinculo: { registroTipo: "OBRIGACAO", registroId: outra.obrigacoes[0].id } }));
  assert.deepEqual([c3.repetido, c3.documentoReaproveitado, c3.documento.id], [false, true, a.documento.id]);
  assert.equal((await n.consultarRegistros(c, { tipo: "DOCUMENTO" })).length, 1);
  assert.equal((await n.consultarRegistros(c, { tipo: "VINCULO_DOCUMENTAL" })).length, 2);
});

test("08D — falha ENTRE o cofre e o banco: nada fica registrado, o arquivo fica sem ficha e a repetição completa", async () => {
  const base = await cenario();
  const { c, l, cofre } = base;
  let falhar = true;
  const instavel = {
    leitura: base.repositorio.leitura,
    transacao: (fn, op) => (falhar ? Promise.reject(Object.assign(new Error("conexão perdida (simulada)"), { codigo: "SIMULADO" })) : base.repositorio.transacao(fn, op)),
  };
  const n = criarNucleoFinanceiro({ repositorio: instavel, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, cofre });
  await assert.rejects(n.enviarEvidencia(c, envio(l.id)), /conexão perdida/);
  assert.equal((await base.nucleo.consultarRegistros(c, { tipo: "DOCUMENTO" })).length, 0, "banco não registrou documento");
  const conf = await base.nucleo.conferirCofreDocumental(c);
  assert.deepEqual([conf.arquivosSemFicha, conf.fichas, conf.fichasSemArquivo.length], [1, 0, 0]);
  falhar = false;
  const r = await n.enviarEvidencia(c, envio(l.id));
  assert.equal(r.repetido, false);
  const depois = await base.nucleo.conferirCofreDocumental(c);
  assert.deepEqual([depois.arquivosSemFicha, depois.fichas, depois.arquivosNoCofre], [0, 1, 1]);
});

test("08D — cofre em disco: gravação em duas fases, temporário abandonado é limpo, publicado nunca é tocado", async () => {
  const raiz = mkdtempSync(join(tmpdir(), "fv2-cofre-08d-"));
  let agora = Date.now();
  const cofre = criarCofreDisco({ raiz, agora: () => agora });
  const escopo = { organizacaoId: ORG_A, unidadeId: UNI_A };
  const g = await cofre.guardar(escopo, { conteudo: pdf("a"), tipoMime: "application/pdf" });
  assert.deepEqual(readdirSync(join(raiz, "temporarios")), [], "a área temporária fica vazia depois da publicação");
  // Simula escrita interrompida: um temporário pela metade.
  const resto = join(raiz, "temporarios", `g-${"a".repeat(32)}`);
  writeFileSync(resto, "%PDF-1.4 pela met");
  assert.deepEqual(await cofre.inventario(escopo), [g.arquivoId], "o temporário nunca aparece como arquivo do cofre");
  assert.equal(await cofre.limparTemporarios(), 0, "recente: ainda pode ser uma gravação em andamento");
  utimesSync(resto, new Date(agora - 20 * 60 * 1000), new Date(agora - 20 * 60 * 1000));
  agora += 1;
  assert.equal(await cofre.limparTemporarios(), 1);
  assert.equal((await cofre.ler(escopo, g.arquivoId)).hashSha256, g.hashSha256, "o arquivo publicado continua íntegro");
  assert.equal((await cofre.guardar(escopo, { conteudo: pdf("a"), tipoMime: "application/pdf" })).repetido, true);
});

// ------------------------------------------------------------------------------------------------- PostgreSQL
test("08D banco — a ficha enviada exige `enviar_documento` no banco; quem só envia não reclassifica nem registra", { skip: motivoParaPular(), timeout: 300000 }, async () => {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO, { concessoesDeTeste: false });
  await provisionarAdministrador(repositorio, { organizacaoId: ORG_A, unidadeId: UNI_A });
  const m = montar({ repositorio, concessoesDeTeste: false });
  const adm = ctx(ORG_A, UNI_A, TODAS);
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, cofre: m.cofre, exigirConcessaoPersistida: true });
  const ingenuo = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, cofre: m.cofre });
  const U = (k) => `dddddddd-0000-4000-8000-0000000005${String(k).padStart(2, "0")}`;
  await n.concederAcesso(adm, { usuarioId: U(1), acoes: [ACAO.VER, ACAO.DOCUMENTOS], justificativa: "Só abre documentos (sintético)." });
  await n.concederAcesso(adm, { usuarioId: U(2), acoes: [ACAO.VER, ACAO.ENVIAR_DOCUMENTO], justificativa: "Só envia (sintético)." });
  const forn = await m.nucleo.registrarContraparte(adm, { tipo: "FORNECEDOR", nome: "Fornecedor sintético" });
  const { lancamento: l } = await m.nucleo.registrarObrigacao(adm, obrigacao(forn.id, { categoria: "DESPESAS_A_CLASSIFICAR" }));
  const recusado = (p) => assert.rejects(p, (e) => [CODIGO.PERMISSAO_INSUFICIENTE, CODIGO.INTEGRIDADE_VIOLADA, CODIGO.NAO_ENCONTRADO].includes(e.codigo));
  await recusado(ingenuo.enviarEvidencia(ctx(ORG_A, UNI_A, TODAS, U(1)), envio(l.id))); // banco recusa a ficha sem enviar_documento
  assert.equal((await n.consultarRegistros(adm, { tipo: "DOCUMENTO" })).length, 0);
  const r = await n.enviarEvidencia(ctx(ORG_A, UNI_A, [ACAO.VER, ACAO.ENVIAR_DOCUMENTO], U(2)), envio(l.id));
  assert.ok(r.documento.id);
  await recusado(ingenuo.reclassificarLancamento(ctx(ORG_A, UNI_A, TODAS, U(2)), { lancamentoId: l.id, categoria: "EMBALAGENS", justificativa: "x", versaoEsperada: l.versao }));
  await recusado(ingenuo.registrarObrigacao(ctx(ORG_A, UNI_A, TODAS, U(2)), obrigacao(forn.id, { fonte: { sistema: "MANUAL", idExterno: "X" } })));
});
