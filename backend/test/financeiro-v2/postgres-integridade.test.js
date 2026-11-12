// Integridade protegida NO BANCO (PostgreSQL local isolado): migrações, integridade referencial, unicidade por escopo,
// isolamento por RLS, proibição de exclusão e de alteração silenciosa. Aqui o SQL é escrito "na mão", como faria alguém
// tentando contornar o núcleo — o banco tem de recusar sozinho. Dados sintéticos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { PASTA_DE_MIGRACOES, aplicarMigracoes, listarMigracoes } from "../../scripts/fv2/ambiente.mjs";
import { ESCOPOS_PADRAO, ORG_A, ORG_B, UNI_A, UNI_B, USUARIO, ctx, montar, obrigacao, rejeita, saida, sha } from "./helpers/cenario.js";
import { abrirPool, criarBancoDeTeste, motivoParaPular, repositorioPostgresDeTeste } from "./helpers/postgres.js";

const pular = { skip: motivoParaPular() };
const A = { organizacaoId: ORG_A, unidadeId: UNI_A };
const B = { organizacaoId: ORG_B, unidadeId: UNI_B };
const AGORA = "2026-10-15T15:00:00.000Z";

/** Núcleo sobre um banco PostgreSQL novo, independentemente do adaptador da rodada. */
async function montarNoBanco() {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO);
  const m = montar({ repositorio });
  const interno = await repositorio.interno();
  return { ...m, pool: interno.pool, dono: await interno.dono() };
}

/** Executa SQL cru numa transação do papel de APLICAÇÃO, com (ou sem) escopo declarado. */
async function comoAplicacao(pool, escopo, fn) {
  const cliente = await pool.connect();
  try {
    await cliente.query("begin");
    if (escopo) await cliente.query("select set_config('fv2.organizacao_id', $1, true), set_config('fv2.unidade_id', $2, true)", [escopo.organizacaoId, escopo.unidadeId]);
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

const comuns = (escopo, id = randomUUID()) => [id, escopo.organizacaoId, escopo.unidadeId, 1, AGORA, USUARIO, AGORA, USUARIO];
const COLUNAS_COMUNS = "id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por";
const historicoDe = (cliente, escopo, tipo, id, versao = 1) => cliente.query(
  "insert into fv2_historico (id, organizacao_id, unidade_id, registro_tipo, registro_id, evento, depois, usuario_id, em) values ($1, $2, $3, $4, $5, 'CRIACAO', $6::jsonb, $7, $8)",
  [randomUUID(), escopo.organizacaoId, escopo.unidadeId, tipo, id, JSON.stringify({ versao }), USUARIO, AGORA],
);
const inserirConta = (cliente, escopo, id = randomUUID()) => cliente.query(
  `insert into fv2_conta (${COLUNAS_COMUNS}, tipo, nome, ativa) values ($1, $2, $3, $4, $5, $6, $7, $8, 'BANCARIA', 'Conta escrita à mão', true)`, comuns(escopo, id),
).then(() => id);

test("migrações: aplicam do zero num banco vazio, são idempotentes e não aceitam arquivo editado depois de aplicado", pular, async () => {
  const { urlAdmin } = await criarBancoDeTeste([], { vazio: true });
  const dono = await abrirPool(urlAdmin, { max: 1 });
  assert.equal((await dono.query("select count(*)::int as n from information_schema.tables where table_name like 'fv2\\_%'")).rows[0].n, 0);

  assert.deepEqual(await aplicarMigracoes(dono), listarMigracoes().map((m) => m.nome));
  assert.deepEqual(await aplicarMigracoes(dono), []); // segunda vez: nada a fazer
  const tabelas = (await dono.query("select table_name from information_schema.tables where table_schema = 'public' and table_name like 'fv2\\_%' order by 1")).rows.map((r) => r.table_name);
  assert.deepEqual(tabelas, [
    "fv2_ajuste", "fv2_categoria", "fv2_competencia", "fv2_concessao", "fv2_conta", "fv2_contraparte", "fv2_correspondencia", "fv2_divergencia_fonte", "fv2_documento", "fv2_escopo",
    "fv2_estorno", "fv2_historico", "fv2_importacao", "fv2_lancamento", "fv2_liquidacao", "fv2_migracao", "fv2_movimentacao", "fv2_obrigacao",
    "fv2_pagamento_venda", "fv2_proposta", "fv2_recebivel", "fv2_registro_fonte", "fv2_saldo_conta", "fv2_sessao_caixa", "fv2_transferencia", "fv2_venda", "fv2_vinculo_documental",
  ]);
  assert.deepEqual((await dono.query("select nome, sha256 from fv2_migracao order by 1")).rows, listarMigracoes().map((m) => ({ nome: m.nome, sha256: m.sha256 })));

  // Dinheiro só em BIGINT de centavos: nenhuma coluna de ponto flutuante ou decimal nas tabelas do módulo.
  const colunas = (await dono.query("select table_name, column_name, data_type from information_schema.columns where table_schema = 'public' and table_name like 'fv2\\_%'")).rows;
  assert.deepEqual(colunas.filter((x) => ["numeric", "real", "double precision", "money"].includes(x.data_type)), []);
  const monetarias = colunas.filter((x) => x.column_name.endsWith("_centavos"));
  assert.ok(monetarias.length >= 20);
  assert.deepEqual(monetarias.filter((x) => x.data_type !== "bigint"), []);

  // Toda tabela de dados tem RLS ligado E forçado, e nenhuma dá DELETE/TRUNCATE ao papel de aplicação.
  const rls = (await dono.query("select relname, relrowsecurity, relforcerowsecurity from pg_class where relkind = 'r' and relname like 'fv2\\_%' and relname <> 'fv2_migracao'")).rows;
  assert.equal(rls.length, 26); // 19 da 0001 + 2 da 0002 + fv2_concessao (0003) + fv2_proposta e fv2_divergencia_fonte (0004) + fv2_saldo_conta e fv2_sessao_caixa (0006)
  assert.deepEqual(rls.filter((x) => !x.relrowsecurity || !x.relforcerowsecurity), []);
  const privilegios = (await dono.query("select table_name, privilege_type from information_schema.role_table_grants where grantee = 'fv2_app'")).rows;
  assert.deepEqual(privilegios.filter((x) => ["DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"].includes(x.privilege_type)), []);
  assert.deepEqual(privilegios.filter((x) => x.table_name === "fv2_historico").map((x) => x.privilege_type).sort(), ["INSERT", "SELECT"]);
  assert.deepEqual(privilegios.filter((x) => x.table_name === "fv2_escopo").map((x) => x.privilege_type), ["SELECT"]);
  assert.deepEqual(privilegios.filter((x) => x.table_name === "fv2_migracao"), []);

  // Arquivo de migração alterado depois de aplicado: o aplicador para, em vez de seguir com esquema divergente.
  const copia = mkdtempSync(join(tmpdir(), "fv2-migracoes-"));
  cpSync(PASTA_DE_MIGRACOES, copia, { recursive: true });
  const [primeira] = listarMigracoes();
  writeFileSync(join(copia, primeira.nome), `${readFileSync(join(copia, primeira.nome), "utf8")}\n-- edição indevida\n`);
  await assert.rejects(aplicarMigracoes(dono, { pasta: copia }), /já foi aplicada com outro conteúdo/);
});

test("integridade referencial: referência a registro inexistente ou de outro escopo é recusada pelo banco", pular, async () => {
  const { nucleo, pool, dono } = await montarNoBanco();
  const docA = (await nucleo.registrarDocumento(ctx(), { origem: "MANUAL", arquivoId: "cofre:a", hashSha256: sha("a1"), tipo: "COMPROVANTE", recebidoEm: "2026-09-01" })).documento;
  const docB = (await nucleo.registrarDocumento(ctx(ORG_B, UNI_B), { origem: "MANUAL", arquivoId: "cofre:b", hashSha256: sha("b1"), tipo: "COMPROVANTE", recebidoEm: "2026-09-01" })).documento;
  const contaA = (await nucleo.configurarContaFinanceira(ctx(), { tipo: "BANCARIA", nome: "Banco" }));
  const vinculo = (cliente, escopo, documentoId, registroTipo, registroId) => {
    const id = randomUUID();
    return cliente.query(`insert into fv2_vinculo_documental (${COLUNAS_COMUNS}, documento_id, registro_tipo, registro_id) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [...comuns(escopo, id), documentoId, registroTipo, registroId])
      .then(() => historicoDe(cliente, escopo, "VINCULO_DOCUMENTAL", id));
  };

  // Caminho válido, escrito à mão com histórico: entra.
  await comoAplicacao(pool, A, (cl) => vinculo(cl, A, docA.id, "CONTA", contaA.id));
  // Documento de OUTRA organização: a chave estrangeira leva o escopo junto, então não fecha.
  await recusa(comoAplicacao(pool, A, (cl) => vinculo(cl, A, docB.id, "CONTA", contaA.id)), "23503");
  // Documento inexistente.
  await recusa(comoAplicacao(pool, A, (cl) => vinculo(cl, A, randomUUID(), "CONTA", contaA.id)), "23503");
  // Referência polimórfica (tipo + id) para registro que não existe neste escopo.
  await recusa(comoAplicacao(pool, A, (cl) => vinculo(cl, A, docA.id, "CONTA", randomUUID())), "FV006");
  await recusa(comoAplicacao(pool, A, (cl) => vinculo(cl, A, docA.id, "TIPO_INVENTADO", contaA.id)), "FV006");
  // Escopo não cadastrado: nem o dono do banco consegue gravar linha de organização desconhecida.
  await recusa(inserirConta(dono, { organizacaoId: randomUUID(), unidadeId: randomUUID() }), "23503");
  // Liquidação apontando para movimentação inexistente.
  await recusa(comoAplicacao(pool, A, async (cl) => {
    const id = randomUUID();
    await cl.query(`insert into fv2_liquidacao (${COLUNAS_COMUNS}, movimentacao_id, alvo_tipo, alvo_id, valor_centavos, estornado_centavos, data_efetiva, situacao) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'OBRIGACAO', $10, 100, 0, '2026-09-01', 'VALIDA')`, [...comuns(A, id), randomUUID(), randomUUID()]);
    await historicoDe(cl, A, "LIQUIDACAO", id);
  }), "23503", "FV006");
  assert.equal((await nucleo.consultarRegistros(ctx(), { tipo: "VINCULO_DOCUMENTAL" })).length, 1);
});

test("unicidade por fonte e contexto: a mesma origem não entra duas vezes no escopo, mas outro escopo e outra conta são livres", pular, async () => {
  const { nucleo, pool } = await montarNoBanco();
  const a = ctx();
  const b = ctx(ORG_B, UNI_B);
  const venda = { canal: "BALCAO", dataVenda: "2026-09-01", brutoCentavos: 5000, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 5000 }], fonte: { sistema: "SAIPOS", idExterno: "PED-1" } };
  const va = await nucleo.registrarVenda(a, venda);
  const vb = await nucleo.registrarVenda(b, venda); // outra organização: o identificador da fonte só vale dentro do escopo
  assert.deepEqual([va.repetido, vb.repetido], [false, false]);
  assert.equal((await nucleo.registrarVenda(a, venda)).repetido, true);
  await rejeita(nucleo.registrarVenda(a, { ...venda, brutoCentavos: 5001, pagamentos: [{ forma: "DINHEIRO", valorCentavos: 5001 }] }), CODIGO.CONFLITO_IDEMPOTENCIA);

  // Por baixo do núcleo, o banco também recusa a segunda linha com a mesma chave no mesmo escopo…
  const duplicar = (escopo, id) => comoAplicacao(pool, escopo, async (cl) => {
    await cl.query(`insert into fv2_conta (${COLUNAS_COMUNS}, tipo, nome, ativa, chave_idempotencia) values ($1, $2, $3, $4, $5, $6, $7, $8, 'BANCARIA', 'Conta', true, 'ORIGEM:1')`, comuns(escopo, id));
    await historicoDe(cl, escopo, "CONTA", id);
  });
  await duplicar(A, randomUUID());
  await recusa(duplicar(A, randomUUID()), "23505");
  await duplicar(B, randomUUID()); // …e aceita a mesma chave em outro escopo.

  // Extrato: o identificador da linha é único POR CONTA. Operações distintas com mesma data e valor não se bloqueiam.
  const banco1 = await nucleo.configurarContaFinanceira(a, { tipo: "BANCARIA", nome: "Banco 1" });
  const banco2 = await nucleo.configurarContaFinanceira(a, { tipo: "BANCARIA", nome: "Banco 2" });
  const linha = (contaId) => saida(contaId, 12345, { fonte: { sistema: "UNICRED", idExterno: "LINHA-7" } });
  assert.equal((await nucleo.registrarMovimentacao(a, linha(banco1.id))).repetido, false);
  assert.equal((await nucleo.registrarMovimentacao(a, linha(banco2.id))).repetido, false); // mesma identificação, outra conta
  assert.equal((await nucleo.registrarMovimentacao(a, linha(banco1.id))).repetido, true);
  assert.equal((await nucleo.registrarMovimentacao(a, saida(banco1.id, 12345))).repetido, false); // sem identificador externo:
  assert.equal((await nucleo.registrarMovimentacao(a, saida(banco1.id, 12345))).repetido, false); // dois pagamentos iguais são dois pagamentos
  assert.equal((await nucleo.consultarRegistros(a, { tipo: "MOVIMENTACAO" })).length, 4);
});

test("isolamento no banco (RLS): sem escopo nada aparece; com escopo, só o próprio — mesmo com SQL escrito à mão", pular, async () => {
  const { nucleo, pool } = await montarNoBanco();
  const contaA = await nucleo.configurarContaFinanceira(ctx(), { tipo: "BANCARIA", nome: "Banco de A" });
  const contaB = await nucleo.configurarContaFinanceira(ctx(ORG_B, UNI_B), { tipo: "BANCARIA", nome: "Banco de B" });
  const contar = (escopo, tabela = "fv2_conta") => comoAplicacao(pool, escopo, async (cl) => (await cl.query(`select count(*)::int as n from ${tabela}`)).rows[0].n);

  assert.equal(await contar(null), 0); // sessão sem escopo declarado não vê linha alguma
  assert.equal(await contar(null, "fv2_historico"), 0);
  assert.equal(await contar(null, "fv2_escopo"), 0);
  assert.equal(await contar(A), 1);
  assert.equal(await contar(B), 1);
  assert.equal(await contar(B, "fv2_escopo"), 1); // nem a lista de organizações é visível
  assert.equal(await contar({ organizacaoId: ORG_A, unidadeId: UNI_B }), 0); // par organização+unidade que não existe

  // Ler, alterar ou escrever dados de OUTRA organização pedindo pelo id exato:
  const ler = (escopo, id) => comoAplicacao(pool, escopo, async (cl) => (await cl.query("select nome from fv2_conta where id = $1", [id])).rows);
  assert.deepEqual(await ler(B, contaA.id), []);
  assert.deepEqual(await ler(A, contaA.id), [{ nome: "Banco de A" }]);
  const alterar = (escopo, id) => comoAplicacao(pool, escopo, async (cl) => (await cl.query("update fv2_conta set nome = 'invadida', versao = versao + 1 where id = $1", [id])).rowCount);
  assert.equal(await alterar(B, contaA.id), 0);
  await recusa(comoAplicacao(pool, B, (cl) => inserirConta(cl, A)), "42501"); // gravar linha carimbada com o escopo alheio
  await recusa(comoAplicacao(pool, null, (cl) => inserirConta(cl, A)), "42501");
  await recusa(comoAplicacao(pool, B, (cl) => cl.query("insert into fv2_escopo (organizacao_id, unidade_id, rotulo) values ($1, $2, 'x')", [randomUUID(), randomUUID()])), "42501"); // a aplicação não cria escopos
  assert.equal((await nucleo.consultarRegistros(ctx(), { tipo: "CONTA" }))[0].nome, "Banco de A");
  assert.equal((await nucleo.consultarRegistros(ctx(ORG_B, UNI_B), { tipo: "CONTA" }))[0].id, contaB.id);

  // Pelo núcleo, o mesmo pedido responde "não encontrado" — sem revelar que o registro existe.
  await rejeita(nucleo.registrarMovimentacao(ctx(ORG_B, UNI_B), saida(contaA.id, 100)), CODIGO.NAO_ENCONTRADO);
  await rejeita(nucleo.consultarRegistros(ctx(randomUUID(), randomUUID()), { tipo: "CONTA" }), CODIGO.ESCOPO_NAO_AUTORIZADO);
});

test("nada se apaga e nada muda em silêncio: exclusão, alteração sem versão e alteração sem histórico são recusadas", pular, async () => {
  const { nucleo, pool, dono } = await montarNoBanco();
  const c = ctx();
  const conta = await nucleo.configurarContaFinanceira(c, { tipo: "BANCARIA", nome: "Banco" });
  const fornecedor = await nucleo.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Fornecedor" });
  const ob = (await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id))).obrigacoes[0];

  // Exclusão: o papel de aplicação nem tem o privilégio; o dono do banco esbarra no gatilho.
  await recusa(comoAplicacao(pool, A, (cl) => cl.query("delete from fv2_conta where id = $1", [conta.id])), "42501");
  await recusa(comoAplicacao(pool, A, (cl) => cl.query("delete from fv2_historico")), "42501");
  await recusa(comoAplicacao(pool, A, (cl) => cl.query("update fv2_historico set justificativa = 'reescrita'")), "42501");
  await recusa(dono.query("delete from fv2_conta where id = $1", [conta.id]), "FV002");
  await recusa(dono.query("delete from fv2_historico"), "FV002");
  await recusa(dono.query("update fv2_historico set justificativa = 'reescrita'"), "FV002");
  await recusa(dono.query("truncate fv2_lancamento"), "FV002", "0A000"); // referenciada: a própria chave estrangeira já barra
  await recusa(dono.query("truncate fv2_lancamento cascade"), "FV002");
  await recusa(dono.query("truncate fv2_historico"), "FV002");

  // Alteração direta: sem subir a versão, sem histórico, mexendo em identidade ou quebrando a conta do saldo.
  const alterar = (sql, valores) => comoAplicacao(pool, A, (cl) => cl.query(sql, valores));
  await recusa(alterar("update fv2_conta set nome = 'outro nome' where id = $1", [conta.id]), "FV004");
  await recusa(alterar("update fv2_conta set nome = 'outro nome', versao = versao + 1 where id = $1", [conta.id]), "FV005");
  await recusa(alterar("update fv2_conta set criado_por = $2, versao = versao + 1 where id = $1", [conta.id, randomUUID()]), "FV003");
  await recusa(alterar("update fv2_obrigacao set saldo_centavos = 1, versao = versao + 1 where id = $1", [ob.id]), "23514");
  await recusa(alterar("update fv2_obrigacao set saldo_centavos = -1, liquidado_centavos = valor_base_centavos + 1, versao = versao + 1 where id = $1", [ob.id]), "23514");
  // "Quitar" na mão, com a conta do saldo fechando e até com histórico — mas sem liquidação que explique: recusado.
  await recusa(comoAplicacao(pool, A, async (cl) => {
    await cl.query("update fv2_obrigacao set liquidado_centavos = valor_base_centavos, saldo_centavos = 0, situacao = 'QUITADA', versao = versao + 1 where id = $1", [ob.id]);
    await historicoDe(cl, A, "OBRIGACAO", ob.id, 2);
  }), "FV007");
  // Receita escrita à mão para uma venda que não existe / lançamento nascido de movimentação de caixa.
  await recusa(alterar("update fv2_lancamento set origem = '{\"tipo\":\"MOVIMENTACAO\",\"id\":\"x\"}'::jsonb, versao = versao + 1"), "23514");

  // Depois de todas as tentativas, os dados são exatamente os que o núcleo gravou.
  const [contaAgora] = await nucleo.consultarRegistros(c, { tipo: "CONTA" });
  const [obAgora] = await nucleo.consultarRegistros(c, { tipo: "OBRIGACAO" });
  assert.deepEqual([contaAgora.nome, contaAgora.versao, obAgora.saldoCentavos, obAgora.situacao, obAgora.versao], ["Banco", 1, 100000, "ABERTA", 1]);
  assert.deepEqual(await nucleo.verificarConservacao(c), []);
});

test("competência homologada é protegida também no banco; reabrir sem justificativa não passa", pular, async () => {
  const { nucleo, pool } = await montarNoBanco();
  const c = ctx();
  const conta = await nucleo.configurarContaFinanceira(c, { tipo: "BANCARIA", nome: "Banco" });
  const fornecedor = await nucleo.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Fornecedor" });
  const { lancamento } = await nucleo.registrarObrigacao(c, obrigacao(fornecedor.id));
  await nucleo.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "FECHAMENTO_PRELIMINAR" });
  await nucleo.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Conferência sintética" });

  const movimentacao = (data) => comoAplicacao(pool, A, async (cl) => {
    const id = randomUUID();
    await cl.query(`insert into fv2_movimentacao (${COLUNAS_COMUNS}, conta_id, data_efetiva, sentido, valor_centavos, moeda, natureza, alocado_centavos, situacao, situacao_conciliacao) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'SAIDA', 100, 'BRL', 'PAGAMENTO', 0, 'VALIDA', 'NAO_CONCILIADA')`, [...comuns(A, id), conta.id, data]);
    await historicoDe(cl, A, "MOVIMENTACAO", id);
  });
  await recusa(movimentacao("2026-09-20"), "FV001"); // mês homologado
  await movimentacao("2026-10-01"); // mês aberto: a mesma escrita passa
  await recusa(comoAplicacao(pool, A, (cl) => cl.query("update fv2_lancamento set descricao = 'mexida', versao = versao + 1 where id = $1", [lancamento.id])), "FV001");

  // Tirar a competência de "homologada" por fora do fluxo de reabertura.
  const mexer = (sql) => comoAplicacao(pool, A, async (cl) => {
    const { rows: [comp] } = await cl.query(`${sql} returning id, versao`);
    await historicoDe(cl, A, "COMPETENCIA", comp.id, comp.versao); // histórico SEM justificativa
  });
  await recusa(mexer("update fv2_competencia set estado = 'FECHAMENTO_PRELIMINAR', versao = versao + 1 where competencia = '2026-09'"), "FV008");
  await recusa(mexer("update fv2_competencia set estado = 'ABERTA', versao = versao + 1 where competencia = '2026-09'"), "FV008"); // sem contar a revisão
  await recusa(mexer("update fv2_competencia set estado = 'ABERTA', revisoes = revisoes + 1, versao = versao + 1 where competencia = '2026-09'"), "FV008"); // sem justificativa
  assert.equal((await nucleo.consultarCompetencia(c, { competencia: "2026-09" })).estado, "FECHAMENTO_HOMOLOGADO");
  // Pelo fluxo correto, com justificativa, reabre.
  assert.equal((await nucleo.alterarEstadoDaCompetencia(c, { competencia: "2026-09", novoEstado: "ABERTA", justificativa: "Revisão formal sintética" })).estado, "ABERTA");
});
