// Execução 06A — regras da tesouraria protegidas também pelo BANCO (PostgreSQL local isolado). Dados sintéticos.
// SQL escrito "na mão", como faria alguém contornando o núcleo: o banco recusa duas sessões abertas no mesmo caixa,
// sessão fechada alterada, saldo informado reescrito e exclusão física.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ESCOPOS_PADRAO, ORG_A, UNI_A, ctx, montar } from "./helpers/cenario.js";
import { motivoParaPular, repositorioPostgresDeTeste, tokenDeTeste } from "./helpers/postgres.js";

const pular = { skip: motivoParaPular() };
const A = { organizacaoId: ORG_A, unidadeId: UNI_A };

async function comoAplicacao(pool, fn) {
  const cliente = await pool.connect();
  try {
    await cliente.query("begin");
    await cliente.query("select fv2_assumir_sessao($1)", [await tokenDeTeste(pool, A)]);
    const r = await fn(cliente);
    await cliente.query("commit");
    return r;
  } catch (e) {
    await cliente.query("rollback").catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}
const recusa = (promessa, ...codigos) => assert.rejects(promessa, (e) => {
  assert.ok(codigos.includes(e.code), `esperava SQLSTATE ${codigos.join("/")}, veio ${e.code}: ${e.message}`);
  return true;
});

test("banco: uma sessão aberta por caixa; sessão fechada e saldo informado não se reescrevem; nada se apaga", pular, async () => {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO);
  const { nucleo } = montar({ repositorio });
  const { pool } = await repositorio.interno();
  const c = ctx();
  const caixa = await nucleo.configurarContaFinanceira(c, { tipo: "CAIXA_FISICO", nome: "Caixa" });
  const banco = await nucleo.configurarContaFinanceira(c, { tipo: "BANCARIA", nome: "Banco" });
  const { sessao } = await nucleo.abrirCaixa(c, { contaId: caixa.id, dataAbertura: "2026-10-14", saldoContadoCentavos: 1000 });
  await nucleo.registrarSaldoDeConta(c, { contaId: banco.id, data: "2026-10-01", valorCentavos: 5000 });

  // Segunda sessão ABERTA no mesmo caixa (por cópia direta da primeira): índice único parcial recusa.
  await recusa(comoAplicacao(pool, (cl) => cl.query(
    "insert into fv2_sessao_caixa (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por, conta_id, situacao, data_abertura, saldo_abertura_centavos, operacoes) select gen_random_uuid(), organizacao_id, unidade_id, 1, criado_em, criado_por, atualizado_em, atualizado_por, conta_id, 'ABERTA', '2026-10-15', 0, '[]'::jsonb from fv2_sessao_caixa where id = $1",
    [sessao.id])), "23505");
  // Fechamento com diferença fora da conta (contado − teórico) é recusado pela restrição da tabela.
  await recusa(comoAplicacao(pool, (cl) => cl.query(
    "update fv2_sessao_caixa set situacao = 'FECHADA', data_fechamento = '2026-10-15', entradas_centavos = 0, saidas_centavos = 0, teorico_centavos = 1000, contado_centavos = 900, diferenca_centavos = 0, fechado_por = criado_por, fechado_em = now(), versao = versao + 1 where id = $1",
    [sessao.id])), "23514", "FV001", "FV002", "FV003");
  await nucleo.fecharCaixa(c, { sessaoId: sessao.id, dataFechamento: "2026-10-15", contadoCentavos: 900, justificativa: "Sintético.", confirmar: true });
  // Sessão fechada não muda; saldo informado não é reescrito.
  await recusa(comoAplicacao(pool, (cl) => cl.query("update fv2_sessao_caixa set contado_centavos = 1000, diferenca_centavos = 0, versao = versao + 1 where id = $1", [sessao.id])), "FV014");
  await recusa(comoAplicacao(pool, (cl) => cl.query("update fv2_saldo_conta set valor_centavos = 1, versao = versao + 1 where conta_id = $1", [banco.id])), "FV014");
  // Exclusão física proibida.
  await assert.rejects(comoAplicacao(pool, (cl) => cl.query("delete from fv2_saldo_conta where conta_id = $1", [banco.id])));
  await assert.rejects(comoAplicacao(pool, (cl) => cl.query("delete from fv2_sessao_caixa where id = $1", [sessao.id])));
  const s = (await nucleo.consultarCaixaEBancos(c, { inicio: "2026-10-14", fim: "2026-10-15", contaId: caixa.id })).contas[0].sessoesDeCaixa[0];
  assert.deepEqual([s.situacao, s.contadoCentavos, s.diferencaCentavos], ["FECHADA", 900, -100]);
});
