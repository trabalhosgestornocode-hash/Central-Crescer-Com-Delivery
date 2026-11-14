// Fase A da Execução 02: testes DETERMINÍSTICOS que denunciam a retirada do bloqueio de linha (FOR UPDATE) ou da
// estratégia de repetição de transações — nos cenários em que esses mecanismos são de fato necessários.
// Barreiras explícitas forçam a corrida (nada de "torcer" pelo escalonador). Também cobre as proteções da migração 0002.
// Só rodam no PostgreSQL local isolado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ESCOPOS_PADRAO, ORG_B, UNI_B, ctx, montar, sha } from "./helpers/cenario.js";
import { PERIODO_SETEMBRO, saiposVendas } from "./helpers/arquivos.js";
import { motivoParaPular, repositorioPostgresDeTeste, tokenDeTeste } from "./helpers/postgres.js";

const pular = { skip: motivoParaPular() };
const esperar = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Portão que só abre quando `n` participantes chegaram. */
function portao(n) {
  let chegaram = 0;
  let abrir;
  const aberto = new Promise((r) => { abrir = r; });
  return { async chegar() { chegaram += 1; if (chegaram >= n) abrir(); await aberto; } };
}

/** Repositório que intercepta métodos da transação (o núcleo não percebe). */
function interceptado(real, ganchos) {
  return {
    leitura: (fn, o) => real.leitura(fn, o),
    transacao: (fn, o) => real.transacao((tx) => fn(new Proxy(tx, { get: (alvo, k) => (ganchos[k] ? (...a) => ganchos[k](alvo, ...a) : alvo[k]) })), o),
  };
}

test("FOR UPDATE: com a linha reservada por uma transação, a segunda ESPERA (sem o bloqueio, leria por baixo)", pular, async () => {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO);
  const { nucleo } = montar({ repositorio, plano: false });
  const c = ctx();
  const conta = await nucleo.configurarContaFinanceira(c, { tipo: "BANCARIA", nome: "Banco" });
  let liberar;
  const segura = new Promise((r) => { liberar = r; });
  let reservou;
  const reservada = new Promise((r) => { reservou = r; });
  const a = repositorio.transacao(async (tx) => { await tx.obter(c, "CONTA", conta.id); reservou(); await segura; }, { escopo: c });
  try {
    await reservada;
    let bLeu = false;
    const b = repositorio.transacao(async (tx) => { await tx.obter(c, "CONTA", conta.id); bLeu = true; }, { escopo: c });
    await esperar(500);
    assert.equal(bLeu, false, "a segunda transação deveria aguardar a reserva da primeira");
    liberar();
    await Promise.all([a, b]);
    assert.equal(bLeu, true);
  } finally {
    liberar();
    await a.catch(() => {});
  }
});

test("repetição: duas gravações da MESMA origem em corrida — a perdedora é refeita e devolve o registro já gravado", pular, async () => {
  const real = repositorioPostgresDeTeste(ESCOPOS_PADRAO);
  const p = portao(2);
  let buscas = 0;
  const repositorio = interceptado(real, {
    async buscarPorChave(tx, escopo, tipo, chave) {
      const r = await tx.buscarPorChave(escopo, tipo, chave);
      if (tipo === "DOCUMENTO") {
        buscas += 1;
        if (buscas <= 2) await p.chegar(); // as duas olham "não existe" antes de qualquer uma gravar
      }
      return r;
    },
  });
  const { nucleo } = montar({ repositorio, plano: false });
  const doc = { origem: "MANUAL", arquivoId: "cofre:sintetico", hashSha256: sha("d"), tipo: "OUTRO", recebidoEm: "2026-10-01" };
  const [x, y] = await Promise.all([nucleo.registrarDocumento(ctx(), doc), nucleo.registrarDocumento(ctx(), doc)]);
  assert.deepEqual([x.repetido, y.repetido].sort(), [false, true]);
  assert.equal(x.documento.id, y.documento.id);
  assert.equal(buscas, 3, "a perdedora precisa ter sido REEXECUTADA (3ª busca), não apenas falhado");
});

test("repetição: impasse (deadlock) entre duas transações — o banco aborta uma, ela é refeita e as duas concluem", pular, async () => {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO);
  const { nucleo } = montar({ repositorio, plano: false });
  const c = ctx();
  const x = await nucleo.configurarContaFinanceira(c, { tipo: "BANCARIA", nome: "Banco X" });
  const y = await nucleo.configurarContaFinanceira(c, { tipo: "BANCARIA", nome: "Banco Y" });
  const p = portao(2);
  let tentativas = 0;
  const cruzada = (primeira, segunda) => {
    let vez = 0;
    return repositorio.transacao(async (tx) => {
      tentativas += 1;
      vez += 1;
      await tx.obter(c, "CONTA", primeira);
      if (vez === 1) await p.chegar(); // cada uma segura uma linha e vai buscar a da outra
      await tx.obter(c, "CONTA", segunda);
      return vez;
    }, { escopo: c });
  };
  const resultados = await Promise.allSettled([cruzada(x.id, y.id), cruzada(y.id, x.id)]);
  assert.deepEqual(resultados.map((r) => r.status), ["fulfilled", "fulfilled"], resultados.map((r) => r.reason?.message).join(" | "));
  assert.equal(tentativas, 3, "uma das duas deve ter sido refeita após o impasse");
  assert.deepEqual(resultados.map((r) => r.value).sort(), [1, 2]);
});

test("0002 no banco: conteúdo importado é imutável, importação não volta de estado, nada se apaga e o escopo isola", pular, async () => {
  const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO);
  const { nucleo } = montar({ repositorio, plano: false });
  const c = ctx();
  const r = await nucleo.receberArquivoParaImportacao(c, { fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "text/csv", ...PERIODO_SETEMBRO,
    conteudo: saiposVendas([{ pedido: "P-1", data: "02/09/2026 12:00", itens: 1000 }]) });
  await nucleo.confirmarImportacao(c, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia });
  const { pool, dono } = await repositorio.interno();
  const adm = await dono();
  const noEscopo = async (cliente, escopo, sql, valores = []) => {
    const cl = await cliente.connect();
    try {
      await cl.query("begin");
      await cl.query("select fv2_assumir_sessao($1)", [await tokenDeTeste(cliente, escopo)]);
      const res = await cl.query(sql, valores);
      await cl.query("commit");
      return res;
    } catch (e) {
      await cl.query("rollback").catch(() => {});
      throw e;
    } finally {
      cl.release();
    }
  };
  const recusa = (promessa, ...codigos) => assert.rejects(promessa, (e) => { assert.ok(codigos.includes(e.code), `${e.code}: ${e.message}`); return true; });
  await recusa(noEscopo(adm, c, "update fv2_registro_fonte set valor_centavos = valor_centavos + 1"), "FV011");
  await recusa(noEscopo(adm, c, "update fv2_registro_fonte set dados = '{}'::jsonb"), "FV011");
  await recusa(noEscopo(adm, c, "update fv2_importacao set estado = 'PRONTO_PARA_IMPORTAR'"), "FV012");
  await recusa(noEscopo(adm, c, "update fv2_importacao set relatorio = '{}'::jsonb"), "FV012");
  await recusa(noEscopo(pool, c, "delete from fv2_registro_fonte"), "42501");
  await recusa(noEscopo(adm, c, "delete from fv2_importacao"), "FV002");
  assert.equal((await noEscopo(pool, c, "select count(*)::int as n from fv2_registro_fonte")).rows[0].n, 1);
  assert.equal((await noEscopo(pool, { organizacaoId: ORG_B, unidadeId: UNI_B }, "select count(*)::int as n from fv2_registro_fonte")).rows[0].n, 0);
  // A chave de origem é única por escopo no banco, mesmo que o núcleo fosse contornado.
  await recusa(noEscopo(adm, c, `insert into fv2_registro_fonte (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por,
      chave_idempotencia, importacao_id, documento_id, fonte, tipo_relatorio, tipo_registro, id_externo, identificacao, linha, data_referencia, competencia,
      valor_centavos, dados, original, conferencia, situacao)
    select gen_random_uuid(), organizacao_id, unidade_id, 1, now(), criado_por, now(), criado_por, chave_idempotencia, importacao_id, documento_id, fonte,
      tipo_relatorio, tipo_registro, id_externo, identificacao, linha, data_referencia, competencia, valor_centavos, dados, original, conferencia, situacao
    from fv2_registro_fonte`), "23505");
});
