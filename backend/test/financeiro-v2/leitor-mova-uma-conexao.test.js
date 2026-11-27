// 27/11 — LEITOR DO MOVA COM UMA SÓ CONEXÃO (produção desde 25/11: 1 conexão de leitura por instância).
// Achado real: os relatórios dos entregadores falhavam com FINANCEIRO_INDISPONIVEL a cada ciclo. O token era reaproveitado em
// memória pelos mesmos 5 min que a sessão vale no banco (sem margem); o banco recusava o token no limite e a RENOVAÇÃO era
// pedida SEGURANDO a única conexão — emitir precisa de outra conexão ⇒ espera até o tempo-limite ⇒ falha.
// Aqui: pool de 1 conexão com tempo-limite curto; sem a correção, a leitura após a expiração trava e falha.
import { after, test } from "node:test";
import pg from "pg";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ACAO, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { criarRepositorioPostgres } from "../../src/modules/financeiro-v2/infra/postgres/repositorioPostgres.js";
import { IDENTIDADE_MOVA, criarLeitorFinanceiroMova } from "../../src/modules/fv2-integracao/leitorMova.js";
import { AGORA, ESCOPOS_PADRAO, ORG_A, TODAS, UNI_A, ctx, montar, obrigacao, provisionarAdministrador } from "./helpers/cenario.js";
import { motivoParaPular, repositorioPostgresDeTeste } from "./helpers/postgres.js";

const abertos = [];
after(async () => { await Promise.all(abertos.map((p) => p.end().catch(() => {}))); });

const pular = { skip: motivoParaPular(), timeout: 300000 };
const A = { organizacaoId: ORG_A, unidadeId: UNI_A };
const mova = { ...A, usuarioId: IDENTIDADE_MOVA, permissoes: [ACAO.VER] };
const TEMPO_LIMITE_MS = 2000;

async function cenario() {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO, { concessoesDeTeste: false });
  await provisionarAdministrador(repositorio, { ...A });
  const m = montar({ repositorio, concessoesDeTeste: false });
  const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, exigirConcessaoPersistida: true, cofre: m.cofre });
  const admA = ctx(ORG_A, UNI_A, TODAS);
  const f = await m.nucleo.registrarContraparte(admA, { tipo: "FORNECEDOR", nome: "Fornecedor Sintético" });
  await n.registrarObrigacao(admA, obrigacao(f.id, { valorOriginalCentavos: 35000 }));
  await n.concederAcesso(admA, { usuarioId: IDENTIDADE_MOVA, acoes: [ACAO.VER], justificativa: "Piloto MOVA (sintético)." });
  const interno = await repositorio.interno();
  const dono = await interno.dono();
  const papel = `fv2_teste_leitor_mova_${randomBytes(4).toString("hex")}`; const senha = randomBytes(18).toString("hex");
  await dono.query(`create role ${papel} login password '${senha}' in role fv2_leitor_mova`);
  const u = new URL(interno.urlApp); u.username = papel; u.password = senha;
  // Como em produção: UMA conexão, espera por vaga com tempo-limite (pg.Pool direto, no banco LOCAL de teste do cenário).
  assert.match(u.hostname, /^(127\.0\.0\.1|localhost)$/, "só banco local de teste");
  const pool = new pg.Pool({ connectionString: u.toString(), max: 1, connectionTimeoutMillis: TEMPO_LIMITE_MS, idleTimeoutMillis: 1000 });
  pool.on("error", () => {});
  abertos.push(pool);
  const emissoes = async () => Number((await dono.query("select count(*)::int n from fv2_sessao_banco where usuario_id = $1", [IDENTIDADE_MOVA])).rows[0].n);
  const expirarTudo = () => dono.query("update fv2_sessao_banco set emitida_em = now() - interval '6 minutes', expira_em = now() - interval '1 second' where usuario_id = $1 and expira_em > now()", [IDENTIDADE_MOVA]);
  return { n, admA, dono, pool, emissoes, expirarTudo };
}
const nucleoSobre = (repositorio) => criarNucleoFinanceiro({ repositorio, escoposAutorizados: [A], relogio: () => AGORA, exigirConcessaoPersistida: true });
const contas = (nucleo) => nucleo.consultarRegistros(mova, { tipo: "OBRIGACAO" });

test("27/11 leitor com UMA conexão: token reaproveitado e já expirado no banco ⇒ renova FORA da conexão e lê (sem esperar o tempo-limite)", pular, async () => {
  const { pool, emissoes, expirarTudo } = await cenario();
  const nucleo = nucleoSobre(criarLeitorFinanceiroMova({ pool }).repositorio);
  assert.equal((await contas(nucleo)).length, 1);
  assert.equal(await emissoes(), 1);
  await expirarTudo(); // o cenário de produção: a memória ainda reaproveita, o banco já recusa
  const t0 = Date.now();
  assert.equal((await contas(nucleo)).length, 1, "a leitura continua funcionando");
  assert.ok(Date.now() - t0 < TEMPO_LIMITE_MS, `não esperou o tempo-limite (${Date.now() - t0} ms)`);
  assert.equal(await emissoes(), 2, "exatamente uma renovação");
  assert.deepEqual([pool.totalCount <= 1, pool.waitingCount], [true, 0]);
});

test("27/11 leitor com UMA conexão: leituras CONCORRENTES não travam (a emissão nunca segura a conexão de outra)", pular, async () => {
  const { pool, expirarTudo } = await cenario();
  const nucleo = nucleoSobre(criarLeitorFinanceiroMova({ pool }).repositorio);
  await contas(nucleo);
  await expirarTudo();
  const r = await Promise.all(Array.from({ length: 6 }, () => contas(nucleo)));
  assert.ok(r.every((x) => x.length === 1));
  assert.equal(pool.waitingCount, 0);
});

test("27/11 renovação PREVENTIVA: o token deixa de ser reaproveitado 1 min antes do fim (a sessão do banco vale 5 min)", pular, async () => {
  const { pool, emissoes } = await cenario();
  let agora = 0;
  const sessoes = { emitir: async (e) => (await pool.query("select financeiro_v2.fv2_abrir_sessao_mova($1::uuid, $2::uuid) as t", [e.organizacaoId, e.unidadeId])).rows[0].t };
  const nucleo = nucleoSobre(criarRepositorioPostgres({ pool, sessoes, relogio: () => agora }));
  await contas(nucleo); agora += 3 * 60 * 1000; await contas(nucleo);
  assert.equal(await emissoes(), 1, "dentro da janela: reaproveita");
  agora += 61 * 1000; // 4 min 01 s depois da emissão: dentro da margem de 1 min
  await contas(nucleo);
  assert.equal(await emissoes(), 2, "renovou antes de o banco recusar");
});

test("27/11 REINÍCIO: instância nova (sem memória de token) lê na hora, com uma conexão", pular, async () => {
  const { pool, emissoes } = await cenario();
  await contas(nucleoSobre(criarLeitorFinanceiroMova({ pool }).repositorio));
  await contas(nucleoSobre(criarLeitorFinanceiroMova({ pool }).repositorio)); // "reinício": repositório novo, mesmo banco
  assert.equal(await emissoes(), 2);
  assert.equal(pool.waitingCount, 0);
});

test("27/11 INDISPONIBILIDADE: sessão revogada e emissão recusada ⇒ erro claro e rápido; a conexão volta ao pool; nenhuma repetição infinita", pular, async () => {
  const { n, admA, pool, emissoes } = await cenario();
  const nucleo = nucleoSobre(criarLeitorFinanceiroMova({ pool }).repositorio);
  await contas(nucleo);
  await n.revogarAcesso(admA, { usuarioId: IDENTIDADE_MOVA, justificativa: "Teste de indisponibilidade (sintético)." });
  const t0 = Date.now();
  await assert.rejects(contas(nucleo));
  assert.ok(Date.now() - t0 < TEMPO_LIMITE_MS, `falhou sem esperar o tempo-limite (${Date.now() - t0} ms)`);
  assert.equal(await emissoes(), 1, "a emissão recusada não cria sessão; uma única tentativa de renovação");
  assert.deepEqual([pool.waitingCount, pool.totalCount - pool.idleCount], [0, 0], "nenhuma conexão presa");
  // volta: nova concessão ⇒ a próxima leitura funciona sem reiniciar
  await n.concederAcesso(admA, { usuarioId: IDENTIDADE_MOVA, acoes: [ACAO.VER], justificativa: "Volta (sintético)." });
  assert.equal((await contas(nucleo)).length, 1);
});
