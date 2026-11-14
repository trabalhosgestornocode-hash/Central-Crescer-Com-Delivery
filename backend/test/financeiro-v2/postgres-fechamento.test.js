// Execução 06D — proteções do fechamento NO BANCO (PostgreSQL local isolado). Dados sintéticos.
//   - conciliação × homologação simultâneas, com a trava segurada de verdade (determinístico);
//   - SQL "à mão" (como alguém contornando o núcleo): vínculo, título, ajuste e venda de competência homologada;
//   - versão homologada imutável e coerente; nova ação financeiro_v2.documentos aceita na concessão.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ESCOPOS_PADRAO, ORG_A, UNI_A, ctx, entrada, montar, montarComCadastros, prepararHomologacao } from "./helpers/cenario.js";
import { motivoParaPular, repositorioPostgresDeTeste, tokenDeTeste } from "./helpers/postgres.js";

const pular = { skip: motivoParaPular() };
const A = { organizacaoId: ORG_A, unidadeId: UNI_A };
const vendaStone = (id, valor) => ({ canal: "BALCAO", dataVenda: "2026-09-10", brutoCentavos: valor, fonte: { sistema: "MANUAL", idExterno: id }, pagamentos: [{ forma: "CREDITO", processador: "STONE", valorCentavos: valor }] });

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

async function cenario() {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO);
  const m = await montarComCadastros({ repositorio });
  const { pool } = await repositorio.interno();
  return { ...m, pool };
}

test("4 (determinístico) — decisão de conciliação iniciada antes não contorna a homologação: espera e então é recusada", pular, async () => {
  const { nucleo: n, c, banco, pool } = await cenario();
  const r = (await n.registrarVenda(c, vendaStone("V-1", 5000))).recebiveis[0];
  const credito = (await n.registrarMovimentacao(c, entrada(banco.id, 5000, { dataEfetiva: "2026-09-21" }))).movimentacao;
  const cand = await n.criarCorrespondenciaCandidata(c, { ladoA: [{ tipo: "RECEBIVEL", id: r.id, valorCentavos: 5000 }], ladoB: [{ tipo: "MOVIMENTACAO", id: credito.id, valorCentavos: 5000 }] });
  await n.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "FECHAMENTO_PRELIMINAR" });
  // Segura a trava EXCLUSIVA da competência (como uma homologação em andamento) ...
  const chave = `fv2|${c.organizacaoId}|${c.unidadeId}|competencia:2026-09`;
  const cliente = await pool.connect();
  await cliente.query("begin");
  await cliente.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [chave]);
  // ... e uma decisão de conciliação iniciada agora precisa esperar a trava para conferir o estado.
  const decisao = n.confirmarConciliacao(c, { correspondenciaId: cand.id });
  decisao.catch(() => {});
  const esperando = await Promise.race([decisao.then(() => false, () => false), new Promise((ok) => { setTimeout(() => ok(true), 400); })]);
  await cliente.query("rollback");
  cliente.release();
  assert.equal(esperando, true, "a decisão espera a trava da competência");
  await decisao; // trava solta sem homologar: a decisão segue
  // Agora o caminho inverso, com homologação real concorrendo: quem chega depois da homologação é recusado.
  const r2 = (await n.registrarVenda(c, vendaStone("V-2", 700))).recebiveis[0];
  const credito2 = (await n.registrarMovimentacao(c, entrada(banco.id, 700, { dataEfetiva: "2026-09-22" }))).movimentacao;
  const cand2 = await n.criarCorrespondenciaCandidata(c, { ladoA: [{ tipo: "RECEBIVEL", id: r2.id, valorCentavos: 700 }], ladoB: [{ tipo: "MOVIMENTACAO", id: credito2.id, valorCentavos: 700 }] });
  // 08E (F-1): pendências que exigem documentação são documentadas (ressalva sintética) antes de homologar.
  await prepararHomologacao(n, c, "2026-09");
  await n.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Sintética.", confirmar: true });
  await assert.rejects(n.confirmarConciliacao(c, { correspondenciaId: cand2.id }), (e) => e.codigo === "FV2_COMPETENCIA_HOMOLOGADA");
});

test("persistência protege a competência homologada mesmo com SQL escrito à mão", pular, async () => {
  const { nucleo: n, c, banco, pool } = await cenario();
  const r = (await n.registrarVenda(c, vendaStone("V-1", 9000))).recebiveis[0];
  const credito = (await n.registrarMovimentacao(c, entrada(banco.id, 9000, { dataEfetiva: "2026-09-21" }))).movimentacao;
  const cand = await n.criarCorrespondenciaCandidata(c, { ladoA: [{ tipo: "RECEBIVEL", id: r.id, valorCentavos: 9000 }], ladoB: [{ tipo: "MOVIMENTACAO", id: credito.id, valorCentavos: 9000 }] });
  // 08E (F-1): pendências que exigem documentação são documentadas (ressalva sintética) antes de homologar.
  await prepararHomologacao(n, c, "2026-09");
  const h = await n.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Sintética.", confirmar: true });
  // Vínculo de conciliação de setembro: decidir "por fora" é recusado.
  await recusa(comoAplicacao(pool, (cl) => cl.query("update fv2_correspondencia set situacao = 'CONFIRMADA', versao = versao + 1 where id = $1", [cand.id])), "FV001");
  // Título de setembro: mudança econômica (ajuste, valor, cancelamento) recusada; posição financeira permitida.
  await recusa(comoAplicacao(pool, (cl) => cl.query("update fv2_recebivel set ajustes_centavos = -100, saldo_centavos = saldo_centavos - 100, versao = versao + 1 where id = $1", [r.id])), "FV001");
  await recusa(comoAplicacao(pool, (cl) => cl.query("update fv2_recebivel set situacao = 'CANCELADA', versao = versao + 1 where id = $1", [r.id])), "FV001");
  await recusa(comoAplicacao(pool, (cl) => cl.query("update fv2_venda set bruto_centavos = 1, versao = versao + 1 where id = (select venda_id from fv2_recebivel where id = $1)", [r.id])), "FV001");
  // Versão homologada: nunca reescrita; e só nasce junto com a competência homologada.
  await recusa(comoAplicacao(pool, (cl) => cl.query("update fv2_versao_fechamento set impressao = repeat('0', 64), versao = versao + 1 where id = $1", [h.versao.id])), "FV015");
  await recusa(comoAplicacao(pool, (cl) => cl.query("delete from fv2_versao_fechamento where id = $1", [h.versao.id])), "FV004", "FV002", "FV003", "42501", "P0001");
  // Pelo núcleo, o recebimento de outubro do título de setembro passa (posição financeira) — e a versão homologada fica.
  const out = (await n.registrarMovimentacao(c, entrada(banco.id, 9000, { dataEfetiva: "2026-10-02" }))).movimentacao;
  await n.registrarLiquidacao(c, { movimentacaoId: out.id, alocacoes: [{ alvoTipo: "RECEBIVEL", alvoId: r.id, valorCentavos: 9000 }] });
  const recebido = (await n.consultarRegistros(c, { tipo: "RECEBIVEL" })).find((x) => x.id === r.id);
  assert.deepEqual([recebido.situacao, recebido.saldoCentavos], ["QUITADA", 0]);
  const dre = await n.apurarCompetencia(c, { competencia: "2026-09" });
  assert.deepEqual([dre.versaoHomologada.numero, dre.versaoHomologada.reproduz], [h.versao.numero, true]);
  // Venda nova datada em setembro homologado não entra (núcleo e banco).
  await assert.rejects(n.registrarVenda(c, vendaStone("V-SET", 1000)), (e) => e.codigo === "FV2_COMPETENCIA_HOMOLOGADA");
});

test("concessão aceita a nova ação financeiro_v2.documentos e continua recusando ação desconhecida", pular, async () => {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO);
  const { nucleo: n } = montar({ repositorio });
  const { pool } = await repositorio.interno();
  const c = await n.concederAcesso(ctx(), { usuarioId: "cccccccc-0000-4000-8000-000000000002", acoes: ["financeiro_v2.ver", "financeiro_v2.documentos"], justificativa: "Acesso a documentos." });
  assert.deepEqual(c.acoes, ["financeiro_v2.documentos", "financeiro_v2.ver"]);
  await recusa(comoAplicacao(pool, (cl) => cl.query(`update fv2_concessao set acoes = '["financeiro_v2.superadmin"]'::jsonb, versao = versao + 1 where id = $1`, [c.id])), "42501"); // 07B: sem UPDATE para a aplicação
});
