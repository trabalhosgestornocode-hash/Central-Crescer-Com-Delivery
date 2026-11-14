// Adaptador de sessão (contexto autenticado do app → contexto do Financeiro v2) e cofre PRIVADO em disco local.
// Sessões e concessões são simulações locais (nenhuma consulta real de autenticação).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACAO, CODIGO, conferirCofre, criarAdaptadorDeSessao, criarCofreDisco, criarConcessoesMemoria, criarRegistroDeAcessosNegadosEmDisco,
} from "../../src/modules/financeiro-v2/index.js";
import { AGORA, ORG_A, ORG_B, UNI_A, UNI_A2, UNI_B, USUARIO, ctx, montar, rejeita } from "./helpers/cenario.js";
import { PERIODO_SETEMBRO, saiposVendas } from "./helpers/arquivos.js";

const OUTRO = "cccccccc-0000-4000-8000-0000000000ee";
const sessao = (extra = {}) => ({
  user: { id: USUARIO, superadmin: false, ativo: true, ...(extra.user ?? {}) },
  tenant: { organizacaoId: ORG_A, unidadeId: null, ...(extra.tenant ?? {}) },
  acesso: { sessionId: "sessao-sintetica", expiraEm: "2026-10-15T18:00:00.000Z", papel: "dono", permissoes: ["financeiro.ver", "*"], impersonando: false, ...(extra.acesso ?? {}) },
});
const concessoes = criarConcessoesMemoria([
  { organizacaoId: ORG_A, usuarioId: USUARIO, unidadeId: UNI_A, acoes: [ACAO.VER, ACAO.IMPORTAR, "financeiro.tudo", "admin"] },
  { organizacaoId: ORG_A, usuarioId: USUARIO, unidadeId: UNI_A2, acoes: [ACAO.VER] },
]);
const adaptador = criarAdaptadorDeSessao({ concessoes, relogio: () => AGORA });

test("sessão válida + concessão explícita → contexto só com ações financeiro_v2.* concedidas", async () => {
  const c = await adaptador.contextoPara(sessao(), { unidadeId: UNI_A });
  assert.deepEqual({ ...c, permissoes: [...c.permissoes] }, { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: USUARIO, permissoes: [ACAO.VER, ACAO.IMPORTAR] });
  assert.deepEqual((await adaptador.unidadesAutorizadas(sessao())).map((u) => u.unidadeId).sort(), [UNI_A, UNI_A2].sort());
  // Sessão presa a uma unidade só opera nela.
  const presa = sessao({ tenant: { unidadeId: UNI_A2 } });
  assert.equal((await adaptador.contextoPara(presa)).unidadeId, UNI_A2);
  await rejeita(adaptador.contextoPara(presa, { unidadeId: UNI_A }), CODIGO.ESCOPO_NAO_AUTORIZADO);
});

test("sem concessão não há acesso: papel, superadmin e permissões do sistema atual NÃO concedem nada", async () => {
  await rejeita(adaptador.contextoPara(sessao({ user: { id: OUTRO, superadmin: true } }), { unidadeId: UNI_A }), CODIGO.ESCOPO_NAO_AUTORIZADO);
  await rejeita(adaptador.contextoPara(sessao(), { unidadeId: "aaaaaaaa-0000-4000-8000-0000000000ff" }), CODIGO.ESCOPO_NAO_AUTORIZADO);
  // Organização vem da sessão: pedir unidade de outra empresa não funciona nem com concessão "parecida".
  await rejeita(adaptador.contextoPara(sessao({ tenant: { organizacaoId: ORG_B } }), { unidadeId: UNI_B }), CODIGO.ESCOPO_NAO_AUTORIZADO);
  await rejeita(adaptador.contextoPara(sessao(), {}), CODIGO.ESCOPO_NAO_AUTORIZADO); // unidade não informada
  const vazio = criarAdaptadorDeSessao({ concessoes: criarConcessoesMemoria([{ organizacaoId: ORG_A, usuarioId: USUARIO, unidadeId: UNI_A, acoes: ["financeiro.tudo"] }]), relogio: () => AGORA });
  await rejeita(vazio.contextoPara(sessao(), { unidadeId: UNI_A }), CODIGO.ESCOPO_NAO_AUTORIZADO);
});

test("sessão ausente, inválida, expirada, de conta inativa ou em impersonação é recusada", async () => {
  await rejeita(adaptador.contextoPara(undefined, { unidadeId: UNI_A }), CODIGO.SESSAO_AUSENTE);
  await rejeita(adaptador.contextoPara({}, { unidadeId: UNI_A }), CODIGO.SESSAO_AUSENTE);
  await rejeita(adaptador.contextoPara(sessao({ user: { id: "nao-e-uuid" } }), { unidadeId: UNI_A }), CODIGO.SESSAO_INVALIDA);
  await rejeita(adaptador.contextoPara(sessao({ acesso: { sessionId: "" } }), { unidadeId: UNI_A }), CODIGO.SESSAO_INVALIDA);
  await rejeita(adaptador.contextoPara(sessao({ tenant: { organizacaoId: null } }), { unidadeId: UNI_A }), CODIGO.SESSAO_INVALIDA);
  await rejeita(adaptador.contextoPara(sessao({ acesso: { expiraEm: "2026-10-15T14:59:59.000Z" } }), { unidadeId: UNI_A }), CODIGO.SESSAO_INVALIDA);
  await rejeita(adaptador.contextoPara(sessao({ acesso: { expiraEm: "amanhã" } }), { unidadeId: UNI_A }), CODIGO.SESSAO_INVALIDA);
  await rejeita(adaptador.contextoPara(sessao({ user: { ativo: false } }), { unidadeId: UNI_A }), CODIGO.SESSAO_INVALIDA);
  await rejeita(adaptador.contextoPara(sessao({ acesso: { impersonando: true, impersonadoPor: OUTRO } }), { unidadeId: UNI_A }), CODIGO.PERMISSAO_INSUFICIENTE);
});

test("ponta a ponta: o contexto do adaptador opera o núcleo; concessão só de VER não importa", async () => {
  const { nucleo } = montar();
  const cA = await adaptador.contextoPara(sessao(), { unidadeId: UNI_A });
  const r = await nucleo.receberArquivoParaImportacao(cA, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "text/csv", ...PERIODO_SETEMBRO,
    conteudo: saiposVendas([{ pedido: "P-1", data: "02/09/2026 12:00", itens: 1000 }]) });
  assert.equal(r.importacao.estado, "PRONTO_PARA_IMPORTAR");
  const cA2 = await adaptador.contextoPara(sessao(), { unidadeId: UNI_A2 });
  await rejeita(nucleo.receberArquivoParaImportacao(cA2, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "text/csv", ...PERIODO_SETEMBRO,
    conteudo: saiposVendas([{ pedido: "P-1", data: "02/09/2026 12:00", itens: 1000 }]) }), CODIGO.PERMISSAO_INSUFICIENTE);
});

const pastaTemporaria = () => mkdtempSync(join(tmpdir(), "fv2-cofre-teste-"));

test("cofre em disco: recusa pasta relativa, dentro do repositório Git ou sincronizada com nuvem", () => {
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  assert.throws(() => criarCofreDisco({ raiz: "cofre-relativo" }), (e) => e.codigo === CODIGO.COFRE_INDISPONIVEL);
  assert.throws(() => criarCofreDisco({ raiz: join(repo, "nao-usar-cofre") }), (e) => e.codigo === CODIGO.COFRE_INDISPONIVEL);
  assert.throws(() => criarCofreDisco({ raiz: join(tmpdir(), "OneDrive", "cofre") }), (e) => e.codigo === CODIGO.COFRE_INDISPONIVEL);
  assert.ok(conferirCofre(criarCofreDisco({ raiz: pastaTemporaria() })).ok);
});

test("cofre em disco: guarda fora do repositório, detecta arquivo idêntico, nunca sobrescreve e detecta adulteração", async () => {
  const raiz = pastaTemporaria();
  const cofre = criarCofreDisco({ raiz });
  const conteudo = new TextEncoder().encode("arquivo sintético;1,00\n");
  const g1 = await cofre.guardar(ctx(), { conteudo, tipoMime: "text/csv" });
  const g2 = await cofre.guardar(ctx(), { conteudo, tipoMime: "text/csv" });
  assert.equal(g1.repetido, false);
  assert.equal(g2.repetido, true);
  assert.equal(g2.arquivoId, g1.arquivoId);
  assert.ok(!g1.arquivoId.includes(UNI_A) && !g1.arquivoId.includes("sintético"));
  const lido = await cofre.ler(ctx(), g1.arquivoId);
  assert.deepEqual(Buffer.from(lido.conteudo), Buffer.from(conteudo));
  // Escopo alheio: "não existe".
  await rejeita(cofre.ler(ctx(ORG_B, UNI_B), g1.arquivoId), CODIGO.NAO_ENCONTRADO);
  assert.equal(await cofre.existe(ctx(ORG_B, UNI_B), g1.arquivoId), false);
  // Identificador malicioso não escapa da pasta.
  await rejeita(cofre.ler(ctx(), "cofre:../../etc/passwd"), CODIGO.NAO_ENCONTRADO);
  // Adulteração direta no disco: leitura recusa e guardar de novo NÃO sobrescreve em silêncio.
  const gaveta = join(raiz, "escopos");
  const [escopoHash] = readdirSync(gaveta);
  const arquivo = join(gaveta, escopoHash, g1.hashSha256.slice(0, 2), g1.hashSha256);
  writeFileSync(arquivo, "conteúdo trocado");
  await rejeita(cofre.ler(ctx(), g1.arquivoId), CODIGO.DOCUMENTO_INVALIDO);
  await rejeita(cofre.guardar(ctx(), { conteudo, tipoMime: "text/csv" }), CODIGO.DOCUMENTO_INVALIDO);
  assert.equal(readFileSync(arquivo, "utf8"), "conteúdo trocado"); // nada foi sobrescrito
  assert.ok(!("remover" in cofre) && !("urlPublica" in cofre));
});

test("cofre em disco + núcleo: leitura negada fica registrada no arquivo de auditoria SEM conteúdo do documento", async () => {
  const raiz = pastaTemporaria();
  const acessosNegados = criarRegistroDeAcessosNegadosEmDisco({ raiz });
  const { nucleo } = montar({ cofre: criarCofreDisco({ raiz }), acessosNegados });
  const conteudo = saiposVendas([{ pedido: "P-SEGREDO", data: "02/09/2026 12:00", itens: 4321 }]);
  const r = await nucleo.receberArquivoParaImportacao(ctx(), { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "text/csv", ...PERIODO_SETEMBRO, conteudo });
  await rejeita(nucleo.lerArquivoDoDocumento(ctx(ORG_A, UNI_A, [ACAO.IMPORTAR]), { documentoId: r.importacao.documentoId }), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(nucleo.lerArquivoDoDocumento(ctx(ORG_B, UNI_B), { documentoId: r.importacao.documentoId }), CODIGO.NAO_ENCONTRADO);
  const log = readFileSync(join(raiz, "auditoria", "acessos-negados.jsonl"), "utf8");
  assert.equal(log.trim().split("\n").length, 2);
  assert.ok(!log.includes("P-SEGREDO") && !log.includes("43,21"));
  assert.deepEqual(Object.keys(JSON.parse(log.split("\n")[0])).sort(), ["codigo", "documentoId", "em", "evento", "organizacaoId", "unidadeId", "usuarioId"]);
  const ok = await nucleo.lerArquivoDoDocumento(ctx(), { documentoId: r.importacao.documentoId });
  assert.deepEqual(Buffer.from(ok.conteudo), Buffer.from(conteudo));
});
