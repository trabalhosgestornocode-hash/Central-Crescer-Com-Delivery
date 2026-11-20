// Importação em LOTES (desempenho): mesmas regras de antes — tudo ou nada, sem duplicidade, histórico por registro e
// isolamento entre unidades. Volume acima de um lote de chaves e de inserção. Dados 100% SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { UNI_A2, ctx, montar } from "./helpers/cenario.js";
import { texto } from "./helpers/arquivos.js";
import { EM_POSTGRES, repositorioPostgresDeTeste } from "./helpers/postgres.js";
import { ESCOPOS_PADRAO } from "./helpers/cenario.js";
import { criarRepositorioMemoria } from "../../src/modules/financeiro-v2/index.js";

const c = ctx();
const AGORA = new Date("2026-11-20T15:00:00.000Z");
const JUST = "Ensaio sintético da importação em lotes.";
const COLUNAS = ["competencia", "fato_gerador", "tipo_lancamento", "descricao_lancamento", "valor", "base_calculo", "percentual_taxa", "pedido_associado_ifood", "pedido_associado_ifood_curto", "motivo_cancelamento", "data_criacao_pedido_associado", "data_repasse_esperada", "valor_transacao", "loja_id", "cnpj", "data_faturamento", "data_apuracao_inicio", "data_apuracao_fim", "valor_cesta_final", "responsavel_transacao", "impacto_no_repasse", "id_saldo", "metodo_pagamento"];
const PEDIDOS = 260; // 1.560 movimentos: mais de um lote de chaves (1.000) e de inserção

function relatorio(pedidos, deslocamento = 0) {
  const linhas = [COLUNAS.join(";")];
  for (let i = deslocamento; i < deslocamento + pedidos; i += 1) {
    const pedido = `${i.toString(16).padStart(8, "0")}-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
    for (const [tipo, desc, valor] of [["Entrada Financeira", "Entrada Financeira", 49], ["Subsídio", "Promoção custeada pelo iFood", 4], ["Retenção", "Taxa de serviço iFood cobrada do cliente", -1], ["Cobrança", "Comissão do iFood (entrega própria da loja)", -8], ["Cobrança", "Taxa de transação", -2.5], ["Subsídio", "Promoção custeada pela loja", -5]]) {
      const v = { competencia: "2026-11", fato_gerador: "Venda", tipo_lancamento: tipo, descricao_lancamento: desc, valor, base_calculo: 0, percentual_taxa: 0, pedido_associado_ifood: pedido, pedido_associado_ifood_curto: pedido.slice(0, 4), motivo_cancelamento: "", data_criacao_pedido_associado: "2026-11-03T12:00:00.000Z", data_repasse_esperada: "2026-12-02", valor_transacao: 41.5, loja_id: "LOJA-SINTETICA", cnpj: "00000000000000", data_faturamento: "2026-11-03T12:30:00.000Z", data_apuracao_inicio: "2026-11-02", data_apuracao_fim: "2026-11-08", valor_cesta_final: 50, responsavel_transacao: "IFOOD", impacto_no_repasse: desc.includes("loja") ? "NÃO" : "SIM", id_saldo: `S${i}`, metodo_pagamento: "Pix" };
      linhas.push(COLUNAS.map((k) => v[k]).join(";"));
    }
  }
  return texto(linhas.join("\n"));
}

const receber = (n, conteudo, contexto = c) => n.receberArquivoParaImportacao(contexto, { fonte: "IFOOD", tipoRelatorio: "IFOOD_CONCILIACAO", tipoMime: "text/csv", conteudo, periodoInicio: "2026-11-01", periodoFim: "2026-11-17" });
const confirmar = (n, imp, contexto = c) => n.confirmarImportacao(contexto, { importacaoId: imp.id, impressaoPrevia: imp.impressaoPrevia, aceitarPendencias: true, justificativa: JUST });
const registros = (repo, escopo = c) => repo.leitura((tx) => tx.listar(escopo, "REGISTRO_FONTE"), { escopo });
const criacoes = (repo, escopo = c) => repo.leitura((tx) => tx.listarHistorico(escopo, { onde: { registroTipo: "REGISTRO_FONTE" } }), { escopo });

/** Repositório que falha UMA vez no histórico em lote, depois de os registros já terem sido inseridos na transação. */
function comFalhaNoHistorico(base) {
  let falhar = true;
  const embrulhar = (tx) => new Proxy(tx, {
    get(alvo, nome) {
      if (nome === "anexarHistoricos" && falhar) return async () => { falhar = false; throw new Error("falha simulada no meio da gravação"); };
      const v = alvo[nome];
      return typeof v === "function" ? v.bind(alvo) : v;
    },
  });
  return { transacao: (fn, o) => base.transacao((tx) => fn(embrulhar(tx)), o), leitura: (fn, o) => base.leitura(fn, o) };
}

test("lote acima do tamanho do lote: grava cada linha uma vez, com um evento de criação por registro", async () => {
  const { nucleo: n, repositorio: repo } = montar({ relogio: () => AGORA });
  const rec = await receber(n, relatorio(PEDIDOS));
  assert.equal(rec.previa.contagens.novos, PEDIDOS * 6);
  const conf = await confirmar(n, rec.importacao);
  assert.equal(conf.relatorio.inseridos, PEDIDOS * 6);
  const regs = await registros(repo);
  assert.equal(regs.length, PEDIDOS * 6);
  assert.equal(new Set(regs.map((r) => r.chaveIdempotencia)).size, regs.length, "sem chave repetida");
  assert.ok(regs.every((r) => r.importacaoId === rec.importacao.id && r.versao === 1 && r.criadoPor === c.usuarioId));
  const ev = await criacoes(repo);
  assert.equal(ev.filter((e) => e.evento === "CRIACAO").length, regs.length, "um evento de criação por registro");
  assert.deepEqual(new Set(ev.map((e) => e.registroId)), new Set(regs.map((r) => r.id)));
  assert.deepEqual(regs.map((r) => r.linha), [...regs.map((r) => r.linha)].sort((a, b) => a - b), "ordem de gravação = ordem do arquivo");

  // Repetir: a confirmação repetida não grava de novo; o mesmo arquivo devolve a importação existente.
  assert.equal((await confirmar(n, conf.importacao)).repetido, true);
  assert.equal((await receber(n, relatorio(PEDIDOS))).repetido, true);
  // Arquivo com as mesmas linhas + novas: só as novas entram (a busca em lote enxerga as já gravadas).
  const maior = await receber(n, relatorio(PEDIDOS + 20));
  assert.deepEqual([maior.previa.contagens.novos, maior.previa.contagens.jaImportados], [120, PEDIDOS * 6]);
  await confirmar(n, maior.importacao);
  assert.equal((await registros(repo)).length, (PEDIDOS + 20) * 6);
});

test("falha no meio da gravação desfaz tudo; a nova tentativa grava uma única vez", async () => {
  const base = EM_POSTGRES ? repositorioPostgresDeTeste(ESCOPOS_PADRAO) : criarRepositorioMemoria();
  const { nucleo: n } = montar({ relogio: () => AGORA, repositorio: comFalhaNoHistorico(base) });
  const rec = await receber(n, relatorio(PEDIDOS));
  await assert.rejects(confirmar(n, rec.importacao), /falha simulada/);
  assert.equal((await registros(base)).length, 0, "nenhum registro ficou gravado");
  assert.equal((await n.consultarImportacao(c, { importacaoId: rec.importacao.id })).estado, "PRONTO_PARA_IMPORTAR");
  const conf = await confirmar(n, rec.importacao);
  assert.equal(conf.relatorio.inseridos, PEDIDOS * 6);
  assert.equal((await registros(base)).length, PEDIDOS * 6);
  assert.equal((await confirmar(n, rec.importacao)).repetido, true);
  assert.equal((await registros(base)).length, PEDIDOS * 6, "sem duplicidade ao tentar de novo");
});

test("isolamento: a busca em lote só enxerga a própria unidade", async () => {
  const { nucleo: n, repositorio: repo } = montar({ relogio: () => AGORA });
  const outra = ctx(c.organizacaoId, UNI_A2);
  await confirmar(n, (await receber(n, relatorio(PEDIDOS))).importacao);
  const rec2 = await receber(n, relatorio(PEDIDOS), outra);
  assert.equal(rec2.previa.contagens.novos, PEDIDOS * 6, "as linhas da outra unidade não contam como já importadas");
  await confirmar(n, rec2.importacao, outra);
  assert.equal((await registros(repo, outra)).length, PEDIDOS * 6);
  assert.equal((await registros(repo)).length, PEDIDOS * 6);
});

test("repositório: chave já gravada recusa o lote inteiro", async () => {
  const repo = EM_POSTGRES ? repositorioPostgresDeTeste(ESCOPOS_PADRAO) : criarRepositorioMemoria();
  const { nucleo: n } = montar({ relogio: () => AGORA, repositorio: repo });
  await confirmar(n, (await receber(n, relatorio(10))).importacao);
  const [existente] = await registros(repo);
  const copia = (i, chave) => ({ ...existente, id: `dddddddd-0000-4000-8000-${String(i).padStart(12, "0")}`, chaveIdempotencia: chave });
  await assert.rejects(repo.transacao((tx) => tx.inserirVarios("REGISTRO_FONTE", [copia(1, "nova:1"), copia(2, existente.chaveIdempotencia)]), { escopo: c }));
  assert.equal((await registros(repo)).filter((r) => r.chaveIdempotencia === "nova:1").length, 0, "nada do lote ficou gravado");
  const achados = await repo.leitura((tx) => tx.buscarPorChaves(c, "REGISTRO_FONTE", [existente.chaveIdempotencia, "inexistente"]), { escopo: c });
  assert.deepEqual([...achados.keys()], [existente.chaveIdempotencia]);
});
