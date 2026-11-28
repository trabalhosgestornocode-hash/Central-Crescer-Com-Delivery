// 28/11 — NÃO REGRESSÃO da 0036 com a concessão EXATA de produção: a identidade operacional do MOVA com as OITO ações vigentes
// (Açaí v5 / Subway v3) + corrigir_conta_a_pagar, num PostgreSQL REAL, executando cada operação já autorizada com as ações dela
// (como a porta operacional monta: [ver, …exigidas]): conta relatada parcelada (IMOBILIZADO), baixa por comprovante, pagamento com
// juros, despesa paga por comprovante, empréstimo (conta e pagamento), intercompany e a correção nova. A correção do `extras` não
// impede nenhuma delas e a baixa preserva a forma de pagamento/observação da conta. Dados SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ACAO, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { sqlConcessaoOperacionalDoMova } from "../../scripts/fv2/pacoteProducao.mjs";
import { PRODUCAO as PRODUCAO_0036 } from "../../scripts/fv2/kitCorrecao0036.mjs";
import { AGORA, ESCOPOS_PADRAO, ORG_A, ORG_B, TODAS, UNI_A, UNI_B, ctx, montar, obrigacao, provisionarAdministrador } from "./helpers/cenario.js";
import { motivoParaPular, repositorioPostgresDeTeste } from "./helpers/postgres.js";

const OPERADOR = "eeeeeeee-0000-4000-8000-0000000009a1";
const NOVE = [...PRODUCAO_0036.vigentes, ACAO.CORRIGIR_CONTA_A_PAGAR];
const pdf = (m = randomUUID()) => new TextEncoder().encode(`%PDF-1.4\n% comprovante sintetico ${m}\n%%EOF\n`);
const tx = () => `E${randomUUID().replace(/-/g, "").slice(0, 26)}`;
const semArquivo = () => ({ hashSha256: randomUUID().replace(/-/g, "").padEnd(64, "0"), tipoMime: "application/pdf", tamanhoBytes: 1234 });

test("P9 (banco) concessão EXATA de produção (8 ações + corrigir_conta_a_pagar): todas as operações já autorizadas continuam funcionando; a correção funciona; a baixa preserva forma/observação",
  { skip: motivoParaPular(), timeout: 300000 }, async () => {
    assert.equal(NOVE.length, 9);
    assert.ok(!NOVE.includes(ACAO.PRESTAR_SANGRIA) && !NOVE.includes(ACAO.CORRIGIR) && !NOVE.includes(ACAO.REGISTRAR), "sem sangria e sem ação ampla");
    const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO, { concessoesDeTeste: false });
    await provisionarAdministrador(repositorio, { organizacaoId: ORG_A, unidadeId: UNI_A });
    await provisionarAdministrador(repositorio, { organizacaoId: ORG_B, unidadeId: UNI_B });
    const m = montar({ repositorio, concessoesDeTeste: false });
    const admA = ctx(ORG_A, UNI_A, TODAS);
    const dono = await (await repositorio.interno()).dono();
    for (const [organizacaoId, unidadeId] of [[ORG_A, UNI_A], [ORG_B, UNI_B]]) {
      const cl = await dono.connect();
      try { await cl.query("begin"); await cl.query(sqlConcessaoOperacionalDoMova({ identidade: OPERADOR, organizacaoId, unidadeId, acoes: NOVE, concedidoPor: "eeeeeeee-0000-4000-8000-0000000000d1", justificativa: "Concessão igual à de produção (sintético)" })); await cl.query("commit"); } finally { cl.release(); }
    }
    const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, exigirConcessaoPersistida: true, cofre: m.cofre });
    const op = (acoes, org = ORG_A, uni = UNI_A) => ctx(org, uni, [ACAO.VER, ...acoes], OPERADOR);
    const f = await m.nucleo.registrarContraparte(admA, { tipo: "FORNECEDOR", nome: "Fornecedor Sintético P9" });

    // 1) conta relatada parcelada (IMOBILIZADO, cartão) — registrar_conta_parcelada
    const beb = await n.registrarContaParcelada(op([ACAO.REGISTRAR_CONTA_PARCELADA]), { contraparteNova: { tipo: "FORNECEDOR", nome: "Loja Sintética P9" }, categoria: "IMOBILIZADO", descricao: "Bebedouro P9",
      competencia: "2026-10", dataEmissao: "2026-10-15", formaPagamento: "CARTAO", observacao: "Compra no cartão (sintético)", parcelas: [{ vencimento: "2026-11-19", valorCentavos: 19450 }, { vencimento: "2026-12-19", valorCentavos: 19450 }], fonte: { sistema: "MANUAL", idExterno: "MOVA:p9-beb" } });
    assert.equal(beb.obrigacoes.length, 2);
    // 2) baixa por comprovante da 1ª parcela — baixar_por_comprovante + enviar_documento; forma/observação PRESERVADAS
    await n.registrarPagamentoPorComprovante(op([ACAO.BAIXAR_POR_COMPROVANTE, ACAO.ENVIAR_DOCUMENTO]), { obrigacaoId: beb.obrigacoes[0].id, valorCentavos: 19450, dataPagamento: "2026-10-15", idTransacao: tx(),
      justificativa: "Pago conforme comprovante (sintético).", confirmar: true, comprovanteSemArquivo: semArquivo() });
    const paga = (await dono.query("select situacao, extras->>'formaPagamento' forma, extras->>'observacao' obs from fv2_obrigacao where id = $1", [beb.obrigacoes[0].id])).rows[0];
    assert.deepEqual([paga.situacao, paga.forma, paga.obs], ["QUITADA", "CARTAO", "Compra no cartão (sintético)"], "a baixa não mexe na forma nem na observação");
    // 3) pagamento com JUROS — baixar_por_comprovante + registrar_juros + enviar_documento
    const contaJ = (await m.nucleo.registrarObrigacao(admA, obrigacao(f.id, { valorOriginalCentavos: 23000, competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-30" }))).obrigacoes[0];
    const g = await m.cofre.guardar(admA, { conteudo: pdf(), tipoMime: "application/pdf" });
    const doc = (await m.nucleo.registrarDocumento(admA, { origem: "MANUAL", arquivoId: g.arquivoId, hashSha256: g.hashSha256, tipo: "COMPROVANTE", recebidoEm: "2026-10-10", descricao: "Comprovante (sintético)" })).documento;
    const j = await n.registrarPagamentoComEncargo(op([ACAO.BAIXAR_POR_COMPROVANTE, ACAO.REGISTRAR_JUROS, ACAO.ENVIAR_DOCUMENTO]), { obrigacaoId: contaJ.id, valorCentavos: 25000, encargoCentavos: 2000, tipoEncargo: "JUROS",
      dataPagamento: "2026-10-10", documentoId: doc.id, idTransacao: tx(), justificativa: "Pix com juros confirmados (sintético).", confirmar: true });
    assert.ok(j);
    assert.equal((await dono.query("select situacao from fv2_obrigacao where id = $1", [contaJ.id])).rows[0].situacao, "QUITADA");
    // 4) despesa NOVA já paga — registrar_obrigacao + baixar_por_comprovante + enviar_documento
    const dp = await n.registrarDespesaPagaPorComprovante(op([ACAO.REGISTRAR_OBRIGACAO, ACAO.BAIXAR_POR_COMPROVANTE, ACAO.ENVIAR_DOCUMENTO]), {
      obrigacao: { ...obrigacao(f.id, { valorOriginalCentavos: 25900, competencia: "2026-10", dataEmissao: "2026-10-09", vencimento: "2026-10-09", descricao: "Compra paga P9" }), fonte: { sistema: "MANUAL", idExterno: "MOVA:p9-dp" } },
      comprovante: { arquivo: { conteudo: pdf("dp"), nome: "comprovante.pdf", tipoMime: "application/pdf" }, descricao: "Comprovante (sintético)", competencia: "2026-10" },
      pagamento: { dataPagamento: "2026-10-09", idTransacao: tx(), justificativa: "Pago por Pix (sintético).", confirmar: true } });
    assert.equal(dp.obrigacao.situacao, "QUITADA");
    // 5) EMPRÉSTIMO: conta a pagar e pagamento comprovado — + registrar_emprestimo
    const emp = await n.registrarContaParceladaDeEmprestimo(op([ACAO.REGISTRAR_CONTA_PARCELADA, ACAO.REGISTRAR_EMPRESTIMO]), { contraparteNova: { tipo: "FORNECEDOR", nome: "Banco Sintético P9" }, categoria: "EMPRESTIMOS_E_FINANCIAMENTOS",
      descricao: "Empréstimo P9", competencia: "2026-10", dataEmissao: "2026-10-15", parcelas: [{ vencimento: "2026-11-15", valorCentavos: 50000 }], fonte: { sistema: "MANUAL", idExterno: "MOVA:p9-emp" } });
    assert.equal(emp.lancamento.natureza, "PATRIMONIAL");
    const empPago = await n.registrarPagamentoDeEmprestimoPorComprovante(op([ACAO.REGISTRAR_OBRIGACAO, ACAO.BAIXAR_POR_COMPROVANTE, ACAO.ENVIAR_DOCUMENTO, ACAO.REGISTRAR_EMPRESTIMO]), {
      obrigacao: { ...obrigacao(f.id, { valorOriginalCentavos: 291108, competencia: "2026-10", dataEmissao: "2026-10-15", vencimento: "2026-10-15", descricao: "Parcela de empréstimo P9" }), categoria: "EMPRESTIMOS_E_FINANCIAMENTOS", fonte: { sistema: "MANUAL", idExterno: "MOVA:p9-emp-pago" } },
      comprovante: { arquivo: { conteudo: pdf("emp"), nome: "boleto.pdf", tipoMime: "application/pdf" }, descricao: "Comprovante do empréstimo (sintético)", competencia: "2026-10" },
      pagamento: { dataPagamento: "2026-10-15", idTransacao: tx(), justificativa: "Pago conforme comprovante (sintético).", confirmar: true } });
    assert.equal(empPago.obrigacao.situacao, "QUITADA");
    // 6) INTERCOMPANY — registrar_intercompany nas duas empresas
    const contaIc = (await m.nucleo.registrarObrigacao(admA, obrigacao(f.id, { valorOriginalCentavos: 45000, competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-20" }))).obrigacoes[0];
    const ic = await n.registrarPagamentoPorOutraEmpresa(op([ACAO.REGISTRAR_INTERCOMPANY]), op([ACAO.REGISTRAR_INTERCOMPANY], ORG_B, UNI_B), { obrigacaoId: contaIc.id, valorCentavos: 45000, dataPagamento: "2026-10-10",
      descricao: "Conta paga pela outra empresa (sintético)", nomeDevedora: "Empresa A Sintética", nomeCredora: "Empresa B Sintética", chave: "MOVA:p9-ic" });
    assert.equal(ic.titulo.situacao, "QUITADA");
    // 7) a CORREÇÃO nova na 2ª parcela (aberta): só ela muda; a 1ª (paga) é recusada
    const p2 = (await m.nucleo.consultarRegistros(admA, { tipo: "OBRIGACAO" })).find((o) => o.id === beb.obrigacoes[1].id);
    const c = await n.corrigirContaAPagar(op([ACAO.CORRIGIR_CONTA_A_PAGAR]), { obrigacaoId: p2.id, versaoEsperada: p2.versao, mudancas: { contraparteNova: { tipo: "FORNECEDOR", nome: "Fornecedor Correto P9" } }, justificativa: "Correção confirmada (sintético)." });
    assert.equal(c.obrigacoes.length, 1);
    const p1 = (await m.nucleo.consultarRegistros(admA, { tipo: "OBRIGACAO" })).find((o) => o.id === beb.obrigacoes[0].id);
    await assert.rejects(n.corrigirContaAPagar(op([ACAO.CORRIGIR_CONTA_A_PAGAR]), { obrigacaoId: p1.id, versaoEsperada: p1.versao, mudancas: { observacao: "x" }, justificativa: "Tentativa em conta paga (sintético)." }));
    const nomes = (await dono.query("select (o.parcela->>'numero')::int n, c.nome from fv2_obrigacao o join fv2_contraparte c on c.id = o.contraparte_id where o.lancamento_id = $1 order by 1", [beb.lancamento.id])).rows;
    assert.deepEqual(nomes.map((x) => x.nome), ["Loja Sintética P9", "Fornecedor Correto P9"], "só a parcela escolhida mudou");
  });
