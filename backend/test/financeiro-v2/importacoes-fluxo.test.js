// Fluxo de importação ponta a ponta no núcleo (roda em memória e, com FV2_REPOSITORIO=postgres, no PostgreSQL isolado):
// receber → prévia → confirmação autorizada → gravação atômica → relatório; repetição, versão corrigida, rollback,
// concorrência, isolamento, cofre e a regra "importar não cria venda nem despesa".
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACAO, CODIGO } from "../../src/modules/financeiro-v2/index.js";
import { ORG_B, UNI_A2, UNI_B, USUARIO, ctx, montar, prepararHomologacao, rejeita } from "./helpers/cenario.js";
import { PERIODO_SETEMBRO, saiposFormas, saiposVendas, saiposDiarias, stoneVendas } from "./helpers/arquivos.js";

const PEDIDOS = [
  { pedido: "P-1", data: "02/09/2026 12:00", canal: "Balcão", itens: 3000, forma: "Dinheiro" },
  { pedido: "P-2", data: "02/09/2026 12:05", canal: "Balcão", itens: 2500, forma: "Crédito", autorizacao: "AUT-1" },
];
const arquivo = (conteudo, extra = {}) => ({ fonte: "SAIPOS", tipoRelatorio: "SAIPOS_VENDAS", tipoMime: "text/csv", conteudo, ...PERIODO_SETEMBRO, ...extra });
const confirmar = (n, r, extra = {}) => n.confirmarImportacao(ctx(), { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia, ...extra });
const registros = (n, r, c = ctx()) => n.listarRegistrosImportados(c, { importacaoId: r.importacao.id });

test("receber NÃO grava operação: só documento + importação com prévia; confirmar grava os registros de fonte", async () => {
  const { nucleo } = montar();
  const r = await nucleo.receberArquivoParaImportacao(ctx(), arquivo(saiposVendas(PEDIDOS, { total: 5500 })));
  assert.equal(r.importacao.estado, "PRONTO_PARA_IMPORTAR");
  assert.equal(r.importacao.compatibilidade, "SINTETICA");
  assert.equal(r.previa.contagens.novos, 2);
  assert.deepEqual(await registros(nucleo, r), []); // nada gravado antes da confirmação
  const hist = await nucleo.consultarHistorico(ctx(), { registroTipo: "IMPORTACAO", registroId: r.importacao.id });
  assert.deepEqual(hist.map((h) => h.depois?.estado), ["RECEBIDO", "EM_VALIDACAO", "PRONTO_PARA_IMPORTAR"]);

  const c = await confirmar(nucleo, r);
  assert.equal(c.importacao.estado, "IMPORTADO");
  assert.equal(c.importacao.confirmadoPor, USUARIO);
  assert.equal(c.relatorio.inseridos, 2);
  const gravados = await registros(nucleo, r);
  assert.equal(gravados.length, 2);
  assert.ok(gravados.every((g) => g.conferencia === "NAO_CONFERIDO" && g.situacao === "ATIVO" && g.documentoId === r.importacao.documentoId));
  assert.equal(gravados.find((g) => g.idExterno === "P-1").original.Pedido, "P-1");
  // Importar não é confirmar valores: nenhuma venda, receita ou despesa nasceu.
  const comp = await nucleo.consultarComposicao(ctx(), { competencia: "2026-09", indicador: "RECEITA_BRUTA" });
  assert.equal(comp.totalCentavos, 0);
  assert.deepEqual(comp.itens, []);
  // Confirmar de novo é idempotente.
  assert.equal((await confirmar(nucleo, r)).repetido, true);
  assert.equal((await registros(nucleo, r)).length, 2);
});

test("confirmação exige permissão de importar e a impressão da prévia revisada; pendências exigem aceite + justificativa", async () => {
  const { nucleo } = montar();
  const semImportar = ctx(undefined, undefined, Object.values(ACAO).filter((a) => a !== ACAO.IMPORTAR));
  await rejeita(nucleo.receberArquivoParaImportacao(semImportar, arquivo(saiposVendas(PEDIDOS))), CODIGO.PERMISSAO_INSUFICIENTE);
  const r = await nucleo.receberArquivoParaImportacao(ctx(), arquivo(saiposVendas(PEDIDOS, { total: 9999 })));
  assert.equal(r.previa.totalDivergencias, 1);
  const semConfirmar = ctx(undefined, undefined, Object.values(ACAO).filter((a) => a !== ACAO.CONFIRMAR_IMPORTACAO));
  await rejeita(nucleo.confirmarImportacao(semConfirmar, { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia }), CODIGO.PERMISSAO_INSUFICIENTE);
  // 08B: importar NÃO confirma — confirmar exige a ação própria.
  await rejeita(nucleo.confirmarImportacao(ctx(undefined, undefined, [ACAO.VER, ACAO.IMPORTAR]), { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia }), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(nucleo.confirmarImportacao(ctx(), { importacaoId: r.importacao.id, impressaoPrevia: "0".repeat(64) }), CODIGO.IMPORTACAO_INVALIDA);
  await rejeita(confirmar(nucleo, r), CODIGO.IMPORTACAO_INVALIDA); // divergência sem aceite
  await rejeita(confirmar(nucleo, r, { aceitarPendencias: true }), CODIGO.IMPORTACAO_INVALIDA); // aceite sem justificativa
  const c = await confirmar(nucleo, r, { aceitarPendencias: true, justificativa: "Total do rodapé diverge; investigar com o suporte." });
  assert.equal(c.importacao.estado, "IMPORTADO_COM_PENDENCIAS");
  assert.equal(c.relatorio.divergencias, 1);
});

test("arquivo inválido é REJEITADO e nunca grava; arquivo repetido devolve a mesma importação", async () => {
  const { nucleo } = montar();
  const ruim = await nucleo.receberArquivoParaImportacao(ctx(), arquivo(saiposVendas(PEDIDOS, { semColuna: "Total" })));
  assert.equal(ruim.importacao.estado, "REJEITADO");
  await rejeita(confirmar(nucleo, ruim), CODIGO.TRANSICAO_INVALIDA);
  const errado = await nucleo.receberArquivoParaImportacao(ctx(), arquivo(saiposVendas([{ ...PEDIDOS[0], data: "02/10/2026 10:00" }])));
  assert.equal(errado.importacao.estado, "REJEITADO");
  assert.equal(errado.previa.erros[0].codigo, "PERIODO_INCORRETO");

  const r1 = await nucleo.receberArquivoParaImportacao(ctx(), arquivo(saiposVendas(PEDIDOS)));
  const r2 = await nucleo.receberArquivoParaImportacao(ctx(), arquivo(saiposVendas(PEDIDOS)));
  assert.equal(r2.repetido, true);
  assert.equal(r2.importacao.id, r1.importacao.id);
});

test("registro já importado por OUTRO arquivo não duplica; mesma origem com conteúdo diferente vira pendência sem gravar", async () => {
  const { nucleo } = montar();
  const a = await nucleo.receberArquivoParaImportacao(ctx(), arquivo(saiposVendas(PEDIDOS)));
  await confirmar(nucleo, a);
  const b = await nucleo.receberArquivoParaImportacao(ctx(), arquivo(saiposVendas([...PEDIDOS, { pedido: "P-3", data: "03/09/2026 10:00", itens: 1000 }])));
  assert.deepEqual(b.previa.contagens.novos, 1);
  assert.deepEqual(b.previa.contagens.jaImportados, 2);
  const cb = await confirmar(nucleo, b);
  assert.equal(cb.relatorio.inseridos, 1);
  assert.equal(cb.relatorio.jaImportados, 2);
  const c = await nucleo.receberArquivoParaImportacao(ctx(), arquivo(saiposVendas([{ ...PEDIDOS[0], itens: 3333 }])));
  assert.equal(c.previa.contagens.conflitos, 1);
  assert.equal(c.previa.divergencias[0].codigo, "CONFLITO_COM_IMPORTADO");
  const cc = await confirmar(nucleo, c, { aceitarPendencias: true, justificativa: "Conflito registrado para análise." });
  assert.equal(cc.relatorio.inseridos, 0);
  assert.equal(cc.relatorio.conflitosNaoGravados, 1);
});

test("versão corrigida substitui a anterior: registros antigos ficam marcados (não apagados) e documento ganha nova versão", async () => {
  const { nucleo } = montar();
  const v1 = await nucleo.receberArquivoParaImportacao(ctx(), arquivo(saiposVendas(PEDIDOS)));
  await confirmar(nucleo, v1);
  const corrigido = saiposVendas([{ ...PEDIDOS[0], itens: 3100 }, PEDIDOS[1]]);
  await rejeita(nucleo.receberArquivoParaImportacao(ctx(), arquivo(corrigido, { tipoRelatorio: "SAIPOS_FORMAS_PAGAMENTO", substituiImportacaoId: v1.importacao.id })), CODIGO.IMPORTACAO_INVALIDA);
  const v2 = await nucleo.receberArquivoParaImportacao(ctx(), arquivo(corrigido, { substituiImportacaoId: v1.importacao.id }));
  assert.equal(v2.previa.contagens.conflitos, 0); // os da versão anterior serão substituídos
  const c2 = await confirmar(nucleo, v2);
  assert.equal(c2.relatorio.registrosSubstituidos, 2);
  assert.equal(c2.relatorio.inseridos, 2);
  const antigos = await registros(nucleo, v1);
  assert.ok(antigos.every((r) => r.situacao === "SUBSTITUIDO" && r.substituidoPorImportacaoId === v2.importacao.id));
  assert.equal((await nucleo.consultarImportacao(ctx(), { importacaoId: v1.importacao.id })).estado, "SUBSTITUIDO");
  assert.equal((await registros(nucleo, v2)).find((r) => r.idExterno === "P-1").valorCentavos, 3100);
  const doc = await nucleo.lerArquivoDoDocumento(ctx(), { documentoId: v1.importacao.documentoId });
  assert.ok(doc.conteudo.byteLength > 0); // a versão anterior continua preservada no cofre
  // A anterior não pode ser substituída duas vezes.
  await rejeita(nucleo.receberArquivoParaImportacao(ctx(), arquivo(saiposVendas([{ ...PEDIDOS[0], itens: 3200 }]), { substituiImportacaoId: v1.importacao.id })), CODIGO.IMPORTACAO_INVALIDA);
});

test("falha no meio da gravação desfaz TUDO; reimportar o mesmo arquivo depois conclui sem duplicar", async () => {
  const base = montar();
  let falharNo = 2;
  const real = base.repositorio;
  const comFalha = {
    leitura: (fn, o) => real.leitura(fn, o),
    transacao: (fn, o) => real.transacao((tx) => fn(new Proxy(tx, {
      get(alvo, k) {
        // Gravação em lote: grava PARTE do lote (o 1º registro) e cai — o rollback precisa desfazer essa parte também.
        if (k === "inserirVarios") {
          return async (tipo, registros) => {
            if (tipo !== "REGISTRO_FONTE" || falharNo <= 0) return alvo.inserirVarios(tipo, registros);
            falharNo = 0;
            await alvo.inserirVarios(tipo, registros.slice(0, 1));
            throw new Error("queda simulada no meio da gravação");
          };
        }
        if (k !== "inserir") return alvo[k];
        return async (tipo, registro) => {
          if (tipo === "REGISTRO_FONTE" && falharNo > 0 && --falharNo === 0) throw new Error("queda simulada no meio da gravação");
          return alvo.inserir(tipo, registro);
        };
      },
    })), o),
  };
  const { nucleo } = montar({ repositorio: comFalha });
  const r = await nucleo.receberArquivoParaImportacao(ctx(), arquivo(saiposVendas(PEDIDOS)));
  await assert.rejects(confirmar(nucleo, r), /queda simulada/);
  assert.deepEqual(await registros(nucleo, r), []); // rollback: nem o primeiro registro ficou
  assert.equal((await nucleo.consultarImportacao(ctx(), { importacaoId: r.importacao.id })).estado, "PRONTO_PARA_IMPORTAR");
  const again = await nucleo.receberArquivoParaImportacao(ctx(), arquivo(saiposVendas(PEDIDOS)));
  assert.equal(again.importacao.id, r.importacao.id); // reimportação do arquivo parcialmente processado retoma a mesma
  const c = await confirmar(nucleo, again);
  assert.equal(c.relatorio.inseridos, 2);
  assert.equal((await registros(nucleo, r)).length, 2);
});

test("importações concorrentes: o mesmo arquivo e a mesma confirmação em paralelo resultam em UMA gravação", async () => {
  const { nucleo } = montar();
  const bytes = saiposVendas(PEDIDOS);
  const recebidos = await Promise.all([1, 2, 3].map(() => nucleo.receberArquivoParaImportacao(ctx(), arquivo(bytes))));
  assert.equal(new Set(recebidos.map((x) => x.importacao.id)).size, 1);
  const r = recebidos[0];
  const confirmados = await Promise.all([1, 2, 3].map(() => confirmar(nucleo, r)));
  assert.equal(confirmados.filter((x) => !x.repetido).length, 1);
  assert.equal((await registros(nucleo, r)).length, 2);
  // Dois arquivos diferentes com registros em comum, confirmados ao mesmo tempo: nenhum registro em dobro.
  const x = await nucleo.receberArquivoParaImportacao(ctx(), arquivo(saiposVendas([{ pedido: "P-9", data: "05/09/2026 10:00", itens: 900 }, { pedido: "P-8", data: "05/09/2026 10:01", itens: 800 }])));
  const y = await nucleo.receberArquivoParaImportacao(ctx(), arquivo(saiposVendas([{ pedido: "P-8", data: "05/09/2026 10:01", itens: 800 }])));
  const [cx, cy] = await Promise.allSettled([confirmar(nucleo, x), confirmar(nucleo, y)]);
  // Quem perder a corrida é recusado por "prévia mudou" (o outro já gravou P-8) — nunca grava em dobro.
  for (const p of [cx, cy].filter((x) => x.status === "rejected")) assert.equal(p.reason.codigo, CODIGO.IMPORTACAO_INVALIDA);
  assert.ok([cx, cy].some((x) => x.status === "fulfilled"));
  const todos = [...await registros(nucleo, x), ...await registros(nucleo, y)];
  assert.equal(todos.filter((t) => t.idExterno === "P-8").length, 1);
});

test("SAIPOS × Stone: a transação Stone não cria venda nem receita — e a mesma transação em dois arquivos entra uma vez", async () => {
  const { nucleo } = montar();
  const s = await nucleo.receberArquivoParaImportacao(ctx(), arquivo(saiposVendas(PEDIDOS)));
  await confirmar(nucleo, s);
  const t = [{ id: "T-1", quando: "02/09/2026 12:05", bruto: 2500, mdr: 60, autorizacao: "AUT-1" }];
  const st1 = await nucleo.receberArquivoParaImportacao(ctx(), { ...arquivo(stoneVendas(t)), fonte: "STONE", tipoRelatorio: "STONE_VENDAS" });
  await confirmar(nucleo, st1, { aceitarPendencias: true, justificativa: "Estabelecimento sem cadastro nos testes." });
  const st2 = await nucleo.receberArquivoParaImportacao(ctx(), { ...arquivo(stoneVendas([...t, { id: "T-2", quando: "03/09/2026 10:00", bruto: 1000, mdr: 20 }])), fonte: "STONE", tipoRelatorio: "STONE_VENDAS" });
  assert.equal(st2.previa.contagens.jaImportados, 1);
  await confirmar(nucleo, st2, { aceitarPendencias: true, justificativa: "Estabelecimento sem cadastro nos testes." });
  for (const ind of ["RECEITA_BRUTA", "DESPESAS", "DEDUCOES"]) {
    assert.equal((await nucleo.consultarComposicao(ctx(), { competencia: "2026-09", indicador: ind })).totalCentavos, 0, ind);
  }
  const g = await nucleo.gerarCandidatasDeConciliacao(ctx(), { relacao: "SAIPOS_X_STONE", ...PERIODO_SETEMBRO });
  assert.equal(g.criadas, 1); // P-2 (crédito, AUT-1) ↔ T-1; dinheiro (P-1) não tem par na Stone
});

test("cofre: documento preservado e íntegro; leitura exige permissão e escopo; toda negativa fica registrada sem conteúdo", async () => {
  const m = montar();
  const { nucleo, cofre, acessosNegados } = m;
  const bytes = saiposVendas(PEDIDOS);
  const r = await nucleo.receberArquivoParaImportacao(ctx(), arquivo(bytes));
  const lido = await nucleo.lerArquivoDoDocumento(ctx(), { documentoId: r.importacao.documentoId });
  assert.deepEqual(Buffer.from(lido.conteudo), Buffer.from(bytes));
  assert.equal(lido.tipoMime, "text/csv");
  await rejeita(nucleo.lerArquivoDoDocumento(ctx(undefined, undefined, [ACAO.REGISTRAR]), { documentoId: r.importacao.documentoId }), CODIGO.PERMISSAO_INSUFICIENTE);
  await rejeita(nucleo.lerArquivoDoDocumento(ctx(ORG_B, UNI_B), { documentoId: r.importacao.documentoId }), CODIGO.NAO_ENCONTRADO);
  await rejeita(nucleo.lerArquivoDoDocumento(ctx(undefined, "aaaaaaaa-0000-4000-8000-0000000000ff"), { documentoId: r.importacao.documentoId }), CODIGO.ESCOPO_NAO_AUTORIZADO);
  const negados = await acessosNegados.listar();
  assert.equal(negados.length, 3);
  assert.deepEqual(negados.map((n) => n.codigo), [CODIGO.PERMISSAO_INSUFICIENTE, CODIGO.NAO_ENCONTRADO, CODIGO.ESCOPO_NAO_AUTORIZADO]);
  assert.ok(negados.every((n) => !("conteudo" in n) && n.documentoId === r.importacao.documentoId));
  // Adulteração no cofre é detectada antes de entregar o arquivo.
  cofre.__adulterarParaTeste(ctx(), `cofre:${lido.hashSha256}`);
  await rejeita(nucleo.lerArquivoDoDocumento(ctx(), { documentoId: r.importacao.documentoId }), CODIGO.DOCUMENTO_INVALIDO);
  await rejeita(confirmar(nucleo, r), CODIGO.DOCUMENTO_INVALIDO);
});

test("isolamento: o que uma unidade importa não aparece, não conflita e não é confirmável por outra", async () => {
  const { nucleo } = montar();
  const r = await nucleo.receberArquivoParaImportacao(ctx(), arquivo(saiposVendas(PEDIDOS)));
  await confirmar(nucleo, r);
  await rejeita(nucleo.consultarImportacao(ctx(undefined, UNI_A2), { importacaoId: r.importacao.id }), CODIGO.NAO_ENCONTRADO);
  await rejeita(nucleo.confirmarImportacao(ctx(ORG_B, UNI_B), { importacaoId: r.importacao.id, impressaoPrevia: r.importacao.impressaoPrevia }), CODIGO.NAO_ENCONTRADO);
  // O mesmo arquivo em outra unidade é OUTRA importação, com registros próprios (sem "já importado").
  const outra = await nucleo.receberArquivoParaImportacao(ctx(undefined, UNI_A2), arquivo(saiposVendas(PEDIDOS)));
  assert.notEqual(outra.importacao.id, r.importacao.id);
  assert.equal(outra.previa.contagens.novos, 2);
  // Unidade fora do escopo autorizado do núcleo nem chega a receber.
  await rejeita(nucleo.receberArquivoParaImportacao(ctx(undefined, "aaaaaaaa-0000-4000-8000-0000000000ff"), arquivo(saiposVendas(PEDIDOS))), CODIGO.ESCOPO_NAO_AUTORIZADO);
});

test("SAIPOS: faturamento × formas de pagamento — a diferença é detectada e NENHUM ajuste é criado", async () => {
  const { nucleo } = montar();
  // Sintético, com a mesma natureza da diferença conhecida de setembro (formas de pagamento abaixo do faturamento).
  const dias = [["01/09/2026", 40, 612345], ["02/09/2026", 38, 622222]];
  const r1 = await nucleo.receberArquivoParaImportacao(ctx(), arquivo(saiposDiarias(dias, 1234567), { tipoRelatorio: "SAIPOS_VENDAS_DIARIAS" }));
  await confirmar(nucleo, r1);
  const r2 = await nucleo.receberArquivoParaImportacao(ctx(), arquivo(saiposFormas([["Dinheiro", 20, 300000], ["Crédito", 30, 500000], ["Pix", 28, 423456]], 1223456), { tipoRelatorio: "SAIPOS_FORMAS_PAGAMENTO" }));
  await confirmar(nucleo, r2);
  const cmp = await nucleo.compararRelatoriosSaipos(ctx(), PERIODO_SETEMBRO);
  assert.equal(cmp.comparavel, true);
  assert.equal(cmp.faturamentoCentavos, 1234567);
  assert.equal(cmp.formasDePagamentoCentavos, 1223456);
  assert.equal(cmp.diferencaCentavos, 11111);
  assert.equal(cmp.divergente, true);
  assert.equal((await nucleo.consultarComposicao(ctx(), { competencia: "2026-09", indicador: "RECEITA_BRUTA" })).totalCentavos, 0);
  const sem = await nucleo.compararRelatoriosSaipos(ctx(undefined, UNI_A2), PERIODO_SETEMBRO);
  assert.equal(sem.comparavel, false);
});

test("competência homologada não recebe importação confirmada", async () => {
  const { nucleo } = montar();
  await nucleo.alterarEstadoDaCompetencia(ctx(), { competencia: "2026-09", novoEstado: "FECHAMENTO_PRELIMINAR" });
  // 08E (F-1): pendências que exigem documentação são documentadas como ressalva sintética antes de homologar.
  await prepararHomologacao(nucleo, ctx(), "2026-09");
  await nucleo.alterarEstadoDaCompetencia(ctx(), { competencia: "2026-09", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Homologação sintética de teste.", confirmar: true });
  // Arquivo do período recebido DEPOIS da homologação (06D: importação em validação impediria homologar antes).
  const r = await nucleo.receberArquivoParaImportacao(ctx(), arquivo(saiposVendas(PEDIDOS)));
  await rejeita(confirmar(nucleo, r), CODIGO.COMPETENCIA_HOMOLOGADA);
  assert.deepEqual(await registros(nucleo, r), []);
});
