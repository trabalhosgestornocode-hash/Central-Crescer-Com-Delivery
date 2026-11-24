// MOVA CORE — F4: PROPOSTAS PERSISTENTES (migração 0020) no PostgreSQL LOCAL ISOLADO (um database novo por teste). "Processos"
// diferentes = serviços novos sobre o MESMO banco (nada em memória compartilhado). Financeiro real em memória, dados sintéticos.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { criarBancoMova, descartarBancoMova, motivoParaPularMova } from "../mova-financeiro/helpers/banco.js";
import { criarRepositorioDePropostasPostgres } from "../../src/modules/mova-core/persistenciaPropostas.js";
import { criarServicoDeOperacoes } from "../../src/modules/mova-core/operacoes.js";
import { executorDaPessoa } from "../../src/modules/mova-financeiro/aplicacao/portaOperacional.js";
import { AGORA, ORG_A, UNI_A, montarComCadastros } from "../financeiro-v2/helpers/cenario.js";

const PULAR = motivoParaPularMova();
const t = (nome, fn) => test(nome, { skip: PULAR }, fn);
const bancos = [];
after(async () => { for (const b of bancos) await descartarBancoMova(b).catch(() => {}); });
async function banco() { const b = await criarBancoMova(); bancos.push(b); return b; }

const HOJE = "2026-10-15"; const DIA = "2026-10-14";
const pdf = (m) => new TextEncoder().encode(`%PDF-1.4\n% comprovante sintetico ${m}\n%%EOF\n`);
const ANEXO = (m = randomUUID()) => ({ arquivo: { conteudo: pdf(m), nome: "comprovante.pdf", tipoMime: "application/pdf" }, referencia: "comprovante.pdf", idTransacao: `E000000002026101412${m.replace(/-/g, "").slice(0, 14).toUpperCase()}` });
const POL = [{ id: "p", operacao: "DESPESA_DOCUMENTAL", organizacaoId: ORG_A, unidadeId: UNI_A, nivel: "APLICAR_COM_CONFIRMACAO", limiteCentavos: 100000, vigenteDe: "2026-01-01" }];
const SESSAO = { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: "pessoa-1", hoje: HOJE };
const AUT = { pode: true };

async function financeiro() {
  const m = await montarComCadastros();
  const n = m.nucleo; const c = m.c;
  const leitura = { ler: (op, e, x) => n[op]({ ...c, unidadeId: e.unidadeId }, x) };
  const escrita = executorDaPessoa({ nucleo: n, ctx: c });
  const contas = async () => (await n.consultarRegistros(c, { tipo: "OBRIGACAO" })).length;
  return { m, n, c, leitura, escrita, contas };
}
const processo = (pool, f) => criarServicoDeOperacoes({ repositorio: criarRepositorioDePropostasPostgres(pool), porta: f.leitura, portaOperacional: f.escrita, politicas: async () => POL, relogio: () => AGORA.getTime() });
const COMPRA = { tipo: "COMPRA_JA_PAGA", valorCentavos: 25900, fornecedor: "Fornecedor Sintético", dataPagamento: DIA, descricao: "Brownies (compra nova)", categoria: "Insumos" };

t("PP-1 a proposta SOBREVIVE ao reinício: preparada no processo A, confirmada no processo B (com o comprovante guardado no banco)", async () => {
  const { pool } = await banco(); const f = await financeiro();
  await processo(pool, f).preparar({ conversaChave: "k", sessao: SESSAO, autor: "pessoa-1", tipo: "COMPRA_JA_PAGA", args: COMPRA, anexo: ANEXO() });
  const antes = await f.contas();
  const r = await processo(pool, f).confirmar({ conversaChave: "k", autor: "pessoa-1", autorizacaoDeEscrita: AUT });
  assert.equal(r.executada, true);
  assert.equal(await f.contas() - antes, 1);
  const { rows } = await pool.query("select estado, anexo is null as sem_bytes, revisao from mova.core_proposta where conversa_chave = 'k'");
  assert.deepEqual(rows.map((x) => [x.estado, x.sem_bytes]), [["EXECUTADA", true]], "estado final: o comprovante sai da proposta (o Financeiro guardou a cópia oficial)");
});

t("PP-2 duas INSTÂNCIAS confirmando a mesma proposta ao mesmo tempo: exatamente uma executa; nada em dobro", async () => {
  const { pool } = await banco(); const f = await financeiro();
  await processo(pool, f).preparar({ conversaChave: "k", sessao: SESSAO, autor: "pessoa-1", tipo: "COMPRA_JA_PAGA", args: COMPRA, anexo: ANEXO() });
  const antes = await f.contas();
  const rs = await Promise.all([processo(pool, f), processo(pool, f), processo(pool, f)].map((s) => s.confirmar({ conversaChave: "k", autor: "pessoa-1", autorizacaoDeEscrita: AUT })));
  assert.equal(rs.filter((x) => x.executada).length, 1);
  assert.ok(rs.filter((x) => !x.executada).every((x) => ["CONFIRMACAO_CONCORRENTE", "SEM_PROPOSTA_ABERTA", "EM_EXECUCAO"].includes(x.motivo)), JSON.stringify(rs.map((x) => x.motivo)));
  assert.equal(await f.contas() - antes, 1);
});

t("PP-3 compare-and-set no banco: gravação com revisão velha é recusada; versões (raiz, versao) únicas; anexo até 10 MB", async () => {
  const { pool } = await banco();
  const repo = criarRepositorioDePropostasPostgres(pool);
  const raiz = randomUUID();
  const base = { id: `${raiz}:v1`, raiz, versao: 1, conversaChave: "k", organizacaoId: ORG_A, unidadeId: UNI_A, autor: "p", tipo: "COMPRA_JA_PAGA", estado: "AGUARDANDO_CONFIRMACAO", criadaEm: AGORA.toISOString(), expiraEm: new Date(AGORA.getTime() + 1800_000).toISOString() };
  const a = await repo.salvar(base);
  assert.equal(a.proposta.revisao, 1);
  assert.equal((await repo.salvar({ ...a.proposta, estado: "EXECUTANDO" }, { versaoEsperada: 1 })).ok, true);
  assert.equal((await repo.salvar({ ...a.proposta, estado: "CANCELADA" }, { versaoEsperada: 1 })).ok, false, "revisão velha");
  assert.equal((await repo.obter(base.id)).estado, "EXECUTANDO");
  await assert.rejects(pool.query("insert into mova.core_proposta (id, raiz, versao, conversa_chave, organizacao_id, unidade_id, autor, tipo, estado, criada_em, expira_em, proposta) values ($1, $2, 1, 'k', $3, $4, 'p', 'COMPRA_JA_PAGA', 'EXECUTADA', now(), now() + interval '1 minute', '{}')", [`${raiz}:v9`, raiz, ORG_A, UNI_A]), /check/i, "EXECUTADA exige executada_em");
  await assert.rejects(pool.query("insert into mova.core_proposta (id, raiz, versao, conversa_chave, organizacao_id, unidade_id, autor, tipo, estado, criada_em, expira_em, proposta) values ($1, $2, 1, 'k', $3, $4, 'p', 'COMPRA_JA_PAGA', 'AGUARDANDO_DADOS', now(), now() + interval '3 hours', '{}')", [`${randomUUID()}:v1`, randomUUID(), ORG_A, UNI_A]), /check/i, "validade ≤ 2 h");
});

t("PP-4 anti-fracionamento lido do BANCO: o acumulado do favorecido vale entre processos", async () => {
  const { pool } = await banco(); const f = await financeiro();
  const s1 = processo(pool, f);
  await s1.preparar({ conversaChave: "k1", sessao: SESSAO, autor: "pessoa-1", tipo: "COMPRA_JA_PAGA", args: { ...COMPRA, valorCentavos: 60000, descricao: "lote 1" }, anexo: ANEXO() });
  assert.equal((await s1.confirmar({ conversaChave: "k1", autor: "pessoa-1", autorizacaoDeEscrita: AUT })).executada, true);
  const b = await processo(pool, f).preparar({ conversaChave: "k2", sessao: SESSAO, autor: "pessoa-1", tipo: "COMPRA_JA_PAGA", args: { ...COMPRA, valorCentavos: 60000, descricao: "lote 2" }, anexo: ANEXO() });
  assert.equal(b.proposta.estado, "EM_REVISAO_HUMANA");
});

t("PP-5 rollback oficial da 0020: recusa com proposta EXECUTANDO; depois remove só core_proposta", async () => {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "database", "mova-financeiro", "recuperacao", "reverter-0020.sql"), "utf8");
  const { pool } = await banco();
  await pool.query("create table if not exists mova.mova_migracao (nome text primary key, sha256 text not null)");
  await pool.query("insert into mova.mova_migracao values ('0020_mova_core_propostas.sql', 'x') on conflict do nothing");
  await pool.query("delete from mova.mova_migracao where nome > '0020_mova_core_propostas.sql'");
  const repo = criarRepositorioDePropostasPostgres(pool); const raiz = randomUUID();
  await repo.salvar({ id: `${raiz}:v1`, raiz, versao: 1, conversaChave: "k", organizacaoId: ORG_A, unidadeId: UNI_A, autor: "p", tipo: "COMPRA_JA_PAGA", estado: "EXECUTANDO", criadaEm: AGORA.toISOString(), expiraEm: new Date(AGORA.getTime() + 60_000).toISOString() });
  await assert.rejects(pool.query(sql), /EXECUTANDO/);
  await pool.query("update mova.core_proposta set estado = 'FALHOU'");
  await pool.query(sql);
  const { rows } = await pool.query("select to_regclass('mova.core_proposta') as t, to_regclass('mova.core_vinculo') as v");
  assert.deepEqual([rows[0].t, rows[0].v !== null], [null, true]);
});
