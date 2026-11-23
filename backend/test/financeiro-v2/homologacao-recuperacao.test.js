// Execução 08 — RECUPERAÇÃO no ambiente isolado (PostgreSQL local + cofre em disco). Dados sintéticos; backups em pasta
// temporária FORA do repositório, apagados pelo sistema operacional (nunca backup de produção).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODIGO, criarCofreDisco, criarNucleoFinanceiro, criarRepositorioPostgres } from "../../src/modules/financeiro-v2/index.js";
import { fixarSearchPathDoBanco, urlDoBanco } from "../../scripts/fv2/ambiente.mjs";
import { AGORA, ESCOPOS_PADRAO, ctx, montarComCadastros, obrigacao, prepararHomologacao, rejeita, saida } from "./helpers/cenario.js";
import { abrirPool, ambiente, criarAutoridadeDeTeste, motivoParaPular, registrarBancoParaApagar, repositorioPostgresDeTeste } from "./helpers/postgres.js";

const pular = { skip: motivoParaPular(), timeout: 300000 };
function binario(nome) {
  const raiz = join(process.env.ProgramFiles || "C:\\Program Files", "PostgreSQL");
  const exe = process.platform === "win32" ? ".exe" : "";
  const dirs = [process.env.FV2_PG_BIN, ...(existsSync(raiz) ? readdirSync(raiz).sort().reverse().map((v) => join(raiz, v, "bin")) : [])].filter(Boolean);
  const achado = dirs.find((d) => existsSync(join(d, nome + exe)));
  return achado ? join(achado, nome + exe) : null;
}
const rodar = (bin, args, url, entrada = null) => {
  const u = new URL(url);
  const r = spawnSync(bin, [...args, "-h", u.hostname, "-p", u.port, "-U", decodeURIComponent(u.username), "-d", u.pathname.slice(1), ...(entrada ? [entrada] : [])], { env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password) }, encoding: "utf8" });
  assert.equal(r.status, 0, `${bin}: ${r.stderr}`);
};

async function homologarSetembro(n, c, banco) {
  // 08E: a saída paga uma conta registrada (saída sem vínculo bloqueia a homologação — pode ser despesa não reconhecida).
  const fornecedor = await n.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Fornecedor sintético 08E" });
  const conta = (await n.registrarObrigacao(c, obrigacao(fornecedor.id, { valorOriginalCentavos: 1234 }))).obrigacoes[0];
  const pago = (await n.registrarMovimentacao(c, saida(banco.id, 1234, { dataEfetiva: "2026-09-12" }))).movimentacao;
  await n.registrarLiquidacao(c, { movimentacaoId: pago.id, alocacoes: [{ alvoTipo: "OBRIGACAO", alvoId: conta.id, valorCentavos: 1234 }] });
  await n.registrarVenda(c, { canal: "BALCAO", dataVenda: "2026-09-10", brutoCentavos: 9900, fonte: { sistema: "MANUAL", idExterno: "R-1" }, pagamentos: [{ forma: "PIX", valorCentavos: 9900, contaId: banco.id }] });
  await prepararHomologacao(n, c, "2026-09");
  return n.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Sintética.", confirmar: true });
}

test("08 — backup e restauração do banco sintético: tudo volta, inclusive a versão homologada reproduzível e o histórico", pular, async (t) => {
  const pgDump = binario("pg_dump");
  const pgRestore = binario("pg_restore");
  if (!pgDump || !pgRestore) return t.skip("pg_dump/pg_restore indisponíveis nesta máquina");
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO);
  const { nucleo: n, c, banco } = await montarComCadastros({ repositorio });
  await homologarSetembro(n, c, banco);
  const antes = await n.apurarCompetencia(c, { competencia: "2026-09" });
  const { urlAdmin, banco: nome } = await repositorio.interno();
  const contarHistorico = async (url) => { const p = await abrirPool(url, { max: 1 }); return (await p.query("select count(*)::int as n from fv2_historico")).rows[0].n; };
  const histAntes = await contarHistorico(urlAdmin);
  const pasta = mkdtempSync(join(tmpdir(), "fv2-backup-"));
  const arquivo = join(pasta, `${nome}.dump`);
  rodar(pgDump, ["-Fc", "-f", arquivo], urlAdmin);
  // Restaura num banco NOVO do ambiente isolado (com o marcador) e opera com outra autoridade/credenciais do mesmo papel.
  const a = ambiente();
  const destino = `fv2_teste_restaurado_${randomBytes(4).toString("hex")}`;
  const adm = await abrirPool(a.urlAdmin, { max: 1 });
  await adm.query(`create database ${destino} template template0`);
  registrarBancoParaApagar(destino);
  await adm.query(`comment on database ${destino} is 'FV2_ISOLADO_TESTE:${a.marcador}'`);
  // 10: o módulo vive no schema dedicado; o banco restaurado precisa do mesmo search_path (em produção ele está nos
  // papéis de login do módulo, que não fazem parte do dump)
  await fixarSearchPathDoBanco(adm, destino);
  rodar(pgRestore, ["--no-owner", "--exit-on-error"], urlDoBanco(a.urlAdmin, destino), arquivo);
  const repoRest = criarRepositorioPostgres({ pool: await abrirPool(urlDoBanco(a.urlApp, destino)), sessoes: criarAutoridadeDeTeste({ urlAutoridade: urlDoBanco(a.urlAutoridade, destino), urlAdmin: urlDoBanco(a.urlAdmin, destino) }) });
  const nRest = criarNucleoFinanceiro({ repositorio: repoRest, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA });
  const depois = await nRest.apurarCompetencia(c, { competencia: "2026-09" });
  assert.equal(depois.impressao, antes.impressao, "mesma apuração (impressão) após restaurar");
  assert.equal(depois.fonteDaApresentacao, "VERSAO_HOMOLOGADA");
  assert.equal(await contarHistorico(urlDoBanco(a.urlAdmin, destino)), histAntes, "histórico preservado");
  // A proteção da competência homologada continua valendo no banco restaurado.
  await rejeita(nRest.registrarMovimentacao(c, saida(banco.id, 10, { dataEfetiva: "2026-09-20" })), CODIGO.COMPETENCIA_HOMOLOGADA);
});

test("08 — conexão derrubada no meio da transação: nada aplicado pela metade; repetir não duplica", pular, async () => {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO);
  const { nucleo: n, c, banco } = await montarComCadastros({ repositorio });
  const { urlAdmin, repo } = await repositorio.interno();
  const adm = await abrirPool(urlAdmin, { max: 1 });
  // Uma transação do adaptador grava e, antes do commit, a conexão é encerrada pelo servidor.
  await assert.rejects(repo.transacao(async (tx) => {
    await tx.inserir("CONTRAPARTE", { id: "11111111-0000-4000-8000-000000000001", organizacaoId: c.organizacaoId, unidadeId: c.unidadeId, versao: 1, criadoEm: AGORA.toISOString(), criadoPor: c.usuarioId, atualizadoEm: AGORA.toISOString(), atualizadoPor: c.usuarioId, tipo: "FORNECEDOR", nome: "Meio caminho" });
    await adm.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and usename = 'fv2_teste_app' and state = 'idle in transaction'");
    await new Promise((ok) => { setTimeout(ok, 200); });
  }, { escopo: c }));
  assert.equal((await n.consultarRegistros(c, { tipo: "CONTRAPARTE" })).filter((x) => x.nome === "Meio caminho").length, 0, "nada pela metade");
  // Requisição repetida depois do erro (mesma origem externa): uma única venda.
  const v = { canal: "BALCAO", dataVenda: "2026-10-02", brutoCentavos: 1500, fonte: { sistema: "MANUAL", idExterno: "REP-1" }, pagamentos: [{ forma: "PIX", valorCentavos: 1500, contaId: banco.id }] };
  await Promise.all([n.registrarVenda(c, v), n.registrarVenda(c, v), n.registrarVenda(c, v)]);
  assert.equal((await n.consultarRegistros(c, { tipo: "VENDA" })).filter((x) => x.fonte?.idExterno === "REP-1").length, 1);
});

test("08 — reinício do backend e do cofre: outra instância lê o mesmo estado; arquivo íntegro por hash; adulteração detectada", pular, async () => {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO);
  const pasta = mkdtempSync(join(tmpdir(), "fv2-cofre-"));
  const cofre1 = criarCofreDisco({ raiz: pasta });
  const { nucleo: n, c } = await montarComCadastros({ repositorio, cofre: cofre1 });
  const g = await cofre1.guardar(c, { conteudo: new TextEncoder().encode("%PDF-1.4\n% comprovante sintético\n%%EOF\n"), tipoMime: "application/pdf" });
  const doc = (await n.registrarDocumento(c, { origem: "MANUAL", arquivoId: g.arquivoId, hashSha256: g.hashSha256, tipo: "COMPROVANTE", recebidoEm: "2026-09-15", descricao: "Comprovante" })).documento;
  // "Reinício": nova instância do cofre (mesma pasta) e novo núcleo sobre o MESMO banco.
  const cofre2 = criarCofreDisco({ raiz: pasta });
  const n2 = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, cofre: cofre2 });
  const aberto = await n2.obterArquivoDoDocumento(c, { id: doc.id, finalidade: "BAIXAR" });
  assert.equal(aberto.hashSha256 ?? aberto.documento?.hashSha256, g.hashSha256);
  // Adulteração do arquivo no disco: detectada na próxima abertura.
  const caminhos = [];
  const varrer = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) varrer(p); else caminhos.push(p); } };
  varrer(pasta);
  const alvo = caminhos.find((p) => readFileSync(p).includes(Buffer.from("comprovante sintético")));
  assert.ok(alvo, "arquivo do documento está no cofre");
  writeFileSync(alvo, "%PDF-1.4\n% adulterado\n%%EOF\n");
  await assert.rejects(n2.obterArquivoDoDocumento(c, { id: doc.id, finalidade: "BAIXAR" }));
});
