// 28/11 — FASE 2 (0037): a identidade operacional com as NOVE ações de PRODUÇÃO (Açaí v6 / Subway v4) + as QUATRO novas, num PostgreSQL
// REAL. (1) Nenhuma regressão: as operações já autorizadas continuam iguais com a concessão ampliada (a lição da 0036). (2) As quatro
// operações novas gravam pela forma estreita. (3) SQL cru indevido — como a aplicação grava (versão + histórico) — é recusado pela REGRA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ACAO, criarNucleoFinanceiro } from "../../src/modules/financeiro-v2/index.js";
import { sqlConcessaoOperacionalDoMova } from "../../scripts/fv2/pacoteProducao.mjs";
import { PRODUCAO as PRODUCAO_0036 } from "../../scripts/fv2/kitCorrecao0036.mjs";
import { AGORA, ESCOPOS_PADRAO, ORG_A, ORG_B, TODAS, UNI_A, UNI_B, ctx, montar, obrigacao, provisionarAdministrador } from "./helpers/cenario.js";
import { comoAplicacao, motivoParaPular, repositorioPostgresDeTeste } from "./helpers/postgres.js";

const OPERADOR = "eeeeeeee-0000-4000-8000-0000000013a1";
const NOVAS = [ACAO.RECLASSIFICAR_CONTA_A_PAGAR, ACAO.AJUSTAR_CONTA_A_PAGAR, ACAO.MOVER_COMPETENCIA_CONTA_A_PAGAR, ACAO.CANCELAR_CONTA_A_PAGAR];
const TREZE = [...PRODUCAO_0036.vigentes, ACAO.CORRIGIR_CONTA_A_PAGAR, ...NOVAS];
const pdf = (m = randomUUID()) => new TextEncoder().encode(`%PDF-1.4\n% comprovante sintetico ${m}\n%%EOF\n`);
const tx = () => `E${randomUUID().replace(/-/g, "").slice(0, 26)}`;
const semArquivo = () => ({ hashSha256: randomUUID().replace(/-/g, "").padEnd(64, "0"), tipoMime: "application/pdf", tamanhoBytes: 1234 });
const versoesDe = (rs) => Object.fromEntries(rs.map((r) => [r.id, r.versao]));
const just = "Confirmado no WhatsApp (sintético).";

test("P13 (banco) 9 ações de produção + 4 novas: nada do que já funcionava regride; as 4 operações novas gravam; SQL cru indevido é recusado pela regra",
  { skip: motivoParaPular(), timeout: 300000 }, async () => {
    assert.equal(TREZE.length, 13);
    assert.ok(!TREZE.some((a) => [ACAO.PRESTAR_SANGRIA, ACAO.CORRIGIR, ACAO.CANCELAR, ACAO.RECLASSIFICAR, ACAO.REGISTRAR].includes(a)), "sem sangria e sem ação ampla");
    const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO, { concessoesDeTeste: false });
    await provisionarAdministrador(repositorio, { organizacaoId: ORG_A, unidadeId: UNI_A });
    await provisionarAdministrador(repositorio, { organizacaoId: ORG_B, unidadeId: UNI_B });
    const m = montar({ repositorio, concessoesDeTeste: false });
    const adm = ctx(ORG_A, UNI_A, TODAS);
    const interno = await repositorio.interno();
    const dono = await interno.dono();
    for (const [organizacaoId, unidadeId] of [[ORG_A, UNI_A], [ORG_B, UNI_B]]) {
      const cl = await dono.connect();
      try { await cl.query("begin"); await cl.query(sqlConcessaoOperacionalDoMova({ identidade: OPERADOR, organizacaoId, unidadeId, acoes: TREZE, concedidoPor: "eeeeeeee-0000-4000-8000-0000000000d1", justificativa: "Concessão de produção + fase 2 (sintético)" })); await cl.query("commit"); } finally { cl.release(); }
    }
    const n = criarNucleoFinanceiro({ repositorio, escoposAutorizados: ESCOPOS_PADRAO, relogio: () => AGORA, exigirConcessaoPersistida: true, cofre: m.cofre });
    const op = (acoes, org = ORG_A, uni = UNI_A) => ctx(org, uni, [ACAO.VER, ...acoes], OPERADOR);
    const f = await m.nucleo.registrarContraparte(adm, { tipo: "FORNECEDOR", nome: "Fornecedor Sintético P13" });
    const linhas = async (lancamentoId) => (await dono.query("select id, (parcela->>'numero')::int n, situacao, competencia, valor_base_centavos vb, ajustes_centavos aj, saldo_centavos sd, versao from fv2_obrigacao where lancamento_id = $1 order by 2", [lancamentoId])).rows;
    const lanc = async (id) => (await dono.query("select situacao, categoria_codigo cat, natureza, competencia, valor_centavos v, versao from fv2_lancamento where id = $1", [id])).rows[0];
    const compraNova = (nome, x = {}) => n.registrarContaParcelada(op([ACAO.REGISTRAR_CONTA_PARCELADA]), { contraparteNova: { tipo: "FORNECEDOR", nome }, categoria: "IMOBILIZADO", descricao: nome,
      competencia: "2026-10", dataEmissao: "2026-10-15", formaPagamento: "CARTAO", parcelas: [{ vencimento: "2026-11-15", valorCentavos: 30000 }, { vencimento: "2026-12-15", valorCentavos: 30000 }, { vencimento: "2027-01-15", valorCentavos: 30000 }],
      fonte: { sistema: "MANUAL", idExterno: `MOVA:p13-${randomUUID()}` }, ...x });
    const doBanco = async (lancamentoId) => { const os = (await m.nucleo.consultarRegistros(adm, { tipo: "OBRIGACAO" })).filter((o) => o.lancamentoId === lancamentoId).sort((a, b) => a.parcela.numero - b.parcela.numero); const l = (await m.nucleo.consultarRegistros(adm, { tipo: "LANCAMENTO" })).find((x) => x.id === lancamentoId); return { os, l }; };

    // (1) NÃO REGRESSÃO com a concessão de 13 ações: baixa, juros, despesa paga, empréstimo, intercompany e correção da fase 1
    const beb = await compraNova("Bebedouro P13");
    await n.registrarPagamentoPorComprovante(op([ACAO.BAIXAR_POR_COMPROVANTE, ACAO.ENVIAR_DOCUMENTO]), { obrigacaoId: beb.obrigacoes[0].id, valorCentavos: 30000, dataPagamento: "2026-10-15", idTransacao: tx(), justificativa: "Pago (sintético).", confirmar: true, comprovanteSemArquivo: semArquivo() });
    assert.equal((await dono.query("select extras->>'formaPagamento' f, situacao from fv2_obrigacao where id = $1", [beb.obrigacoes[0].id])).rows[0].situacao, "QUITADA");
    const contaJ = (await m.nucleo.registrarObrigacao(adm, obrigacao(f.id, { valorOriginalCentavos: 23000, competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-30" }))).obrigacoes[0];
    const g = await m.cofre.guardar(adm, { conteudo: pdf(), tipoMime: "application/pdf" });
    const doc = (await m.nucleo.registrarDocumento(adm, { origem: "MANUAL", arquivoId: g.arquivoId, hashSha256: g.hashSha256, tipo: "COMPROVANTE", recebidoEm: "2026-10-10", descricao: "Comprovante (sintético)" })).documento;
    await n.registrarPagamentoComEncargo(op([ACAO.BAIXAR_POR_COMPROVANTE, ACAO.REGISTRAR_JUROS, ACAO.ENVIAR_DOCUMENTO]), { obrigacaoId: contaJ.id, valorCentavos: 25000, encargoCentavos: 2000, tipoEncargo: "JUROS", dataPagamento: "2026-10-10", documentoId: doc.id, idTransacao: tx(), justificativa: "Juros confirmados (sintético).", confirmar: true });
    assert.equal((await dono.query("select situacao, ajustes_centavos aj from fv2_obrigacao where id = $1", [contaJ.id])).rows[0].situacao, "QUITADA", "juros da 0031 continuam com a concessão ampliada");
    const dp = await n.registrarDespesaPagaPorComprovante(op([ACAO.REGISTRAR_OBRIGACAO, ACAO.BAIXAR_POR_COMPROVANTE, ACAO.ENVIAR_DOCUMENTO]), {
      obrigacao: { ...obrigacao(f.id, { valorOriginalCentavos: 25900, competencia: "2026-10", dataEmissao: "2026-10-09", vencimento: "2026-10-09", descricao: "Compra paga P13" }), fonte: { sistema: "MANUAL", idExterno: "MOVA:p13-dp" } },
      comprovante: { arquivo: { conteudo: pdf("dp"), nome: "c.pdf", tipoMime: "application/pdf" }, descricao: "Comprovante (sintético)", competencia: "2026-10" },
      pagamento: { dataPagamento: "2026-10-09", idTransacao: tx(), justificativa: "Pago (sintético).", confirmar: true } });
    assert.equal(dp.obrigacao.situacao, "QUITADA");
    const emp = await n.registrarContaParceladaDeEmprestimo(op([ACAO.REGISTRAR_CONTA_PARCELADA, ACAO.REGISTRAR_EMPRESTIMO]), { contraparteNova: { tipo: "FORNECEDOR", nome: "Banco Sintético P13" }, categoria: "EMPRESTIMOS_E_FINANCIAMENTOS",
      descricao: "Empréstimo P13", competencia: "2026-10", dataEmissao: "2026-10-15", parcelas: [{ vencimento: "2026-11-15", valorCentavos: 50000 }, { vencimento: "2026-12-15", valorCentavos: 50000 }], fonte: { sistema: "MANUAL", idExterno: "MOVA:p13-emp" } });
    const contaIc = (await m.nucleo.registrarObrigacao(adm, obrigacao(f.id, { valorOriginalCentavos: 45000, competencia: "2026-10", dataEmissao: "2026-10-01", vencimento: "2026-10-20" }))).obrigacoes[0];
    const ic = await n.registrarPagamentoPorOutraEmpresa(op([ACAO.REGISTRAR_INTERCOMPANY]), op([ACAO.REGISTRAR_INTERCOMPANY], ORG_B, UNI_B), { obrigacaoId: contaIc.id, valorCentavos: 45000, dataPagamento: "2026-10-10",
      descricao: "Paga pela outra empresa (sintético)", nomeDevedora: "A Sintética", nomeCredora: "B Sintética", chave: "MOVA:p13-ic" });
    assert.equal(ic.titulo.situacao, "QUITADA");
    const b2 = (await doBanco(beb.lancamento.id)).os[1];
    await n.corrigirContaAPagar(op([ACAO.CORRIGIR_CONTA_A_PAGAR]), { obrigacaoId: b2.id, versaoEsperada: b2.versao, mudancas: { observacao: "Correção da fase 1 (sintético)" }, justificativa: just });

    // (2) AS QUATRO NOVAS
    // reclassificar: a compra inteira
    const fr = await compraNova("Freezer P13");
    let x = await doBanco(fr.lancamento.id);
    await n.reclassificarContaAPagar(op([ACAO.RECLASSIFICAR_CONTA_A_PAGAR]), { obrigacaoId: x.os[0].id, categoria: "MANUTENCAO", versoes: versoesDe([...x.os, x.l]), justificativa: just });
    assert.deepEqual([(await lanc(fr.lancamento.id)).cat, (await lanc(fr.lancamento.id)).natureza], ["MANUTENCAO", "DESPESA"]);
    // ajustar valor (aumento e redução) da 2ª parcela
    x = await doBanco(fr.lancamento.id);
    await n.ajustarValorDeContaAPagar(op([ACAO.AJUSTAR_CONTA_A_PAGAR]), { obrigacaoId: x.os[1].id, valorCorretoCentavos: 32500, versaoEsperada: x.os[1].versao, justificativa: just });
    x = await doBanco(fr.lancamento.id);
    await n.ajustarValorDeContaAPagar(op([ACAO.AJUSTAR_CONTA_A_PAGAR]), { obrigacaoId: x.os[1].id, valorCorretoCentavos: 28000, versaoEsperada: x.os[1].versao, justificativa: just });
    assert.deepEqual((await linhas(fr.lancamento.id)).map((o) => [o.n, Number(o.vb), Number(o.aj), Number(o.sd)]), [[1, 30000, 0, 30000], [2, 30000, -2000, 28000], [3, 30000, 0, 30000]], "o valor original fica; a diferença é ajuste");
    // cancelar a 3ª parcela (ajuste negativo) e depois a compra inteira
    x = await doBanco(fr.lancamento.id);
    await n.cancelarContaAPagar(op([ACAO.CANCELAR_CONTA_A_PAGAR]), { obrigacaoId: x.os[2].id, abrangencia: "PARCELA", versoes: versoesDe([x.os[2]]), justificativa: just });
    x = await doBanco(fr.lancamento.id);
    await n.cancelarContaAPagar(op([ACAO.CANCELAR_CONTA_A_PAGAR]), { obrigacaoId: x.os[0].id, abrangencia: "GRUPO", versoes: versoesDe([x.os[0], x.os[1], x.l]), justificativa: just });
    assert.ok((await linhas(fr.lancamento.id)).every((o) => o.situacao === "CANCELADA"));
    assert.equal((await dono.query("select count(*)::int n from fv2_lancamento where (id = $1 or origem->>'tipo' = 'AJUSTE') and situacao = 'ATIVO' and categoria_codigo = 'MANUTENCAO'", [fr.lancamento.id])).rows[0].n, 0, "compra e ajustes cancelados (nada apagado)");
    // mover competência de outra compra
    const ar = await compraNova("Ar-condicionado P13");
    x = await doBanco(ar.lancamento.id);
    await n.moverCompetenciaDeContaAPagar(op([ACAO.MOVER_COMPETENCIA_CONTA_A_PAGAR]), { obrigacaoId: x.os[0].id, competencia: "2026-11", versoes: versoesDe([...x.os, x.l]), justificativa: just });
    assert.ok((await linhas(ar.lancamento.id)).every((o) => o.competencia === "2026-11") && (await lanc(ar.lancamento.id)).competencia === "2026-11");

    // (3) SQL CRU INDEVIDO, como a aplicação grava (versão + histórico): a REGRA recusa
    const alterarCru = async (tabela, tipo, id, set) => comoAplicacao(interno, null, async (cl) => {
      const antes = (await cl.query(`select to_jsonb(x) j from financeiro_v2.${tabela} x where id = $1`, [id])).rows[0]?.j;
      const r = await cl.query(`update financeiro_v2.${tabela} x set ${set}, versao = x.versao + 1, atualizado_em = now(), atualizado_por = $2 where id = $1 returning to_jsonb(x) j`, [id, OPERADOR]);
      if (!r.rowCount) return 0;
      await cl.query("insert into financeiro_v2.fv2_historico (id, organizacao_id, unidade_id, registro_tipo, registro_id, evento, antes, depois, justificativa, usuario_id, em) values (gen_random_uuid(), $1, $2, $3, $4, 'CORRECAO', $5, $6, 'Teste sintético', $7, now())",
        [r.rows[0].j.organizacao_id, r.rows[0].j.unidade_id, tipo, id, antes, r.rows[0].j, OPERADOR]);
      return r.rowCount;
    }, { token: await interno.sessoes.emitir({ organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: OPERADOR }) });
    const recusa = (p, msg) => assert.rejects(p, (e) => { assert.match(e.message, /Financeiro v2:|conserva|42501|row-level|permission/, `${msg}: ${e.message}`); return true; }, msg);
    const alvo = await compraNova("Mesa P13");
    const [p1, p2] = await linhas(alvo.lancamento.id);
    await recusa(alterarCru("fv2_obrigacao", "OBRIGACAO", p1.id, "competencia = '2026-11'"), "competência de UMA parcela sem o lançamento");
    await recusa(alterarCru("fv2_obrigacao", "OBRIGACAO", p1.id, "situacao = 'CANCELADA'"), "parcela cancelada sem o ajuste");
    await recusa(alterarCru("fv2_obrigacao", "OBRIGACAO", p1.id, "ajustes_centavos = -1000, saldo_centavos = 29000"), "ajuste sem registro de ajuste");
    await recusa(alterarCru("fv2_obrigacao", "OBRIGACAO", p1.id, "valor_base_centavos = 1000, saldo_centavos = 1000"), "valor original");
    await recusa(alterarCru("fv2_lancamento", "LANCAMENTO", alvo.lancamento.id, "valor_centavos = 1"), "valor do lançamento");
    await recusa(alterarCru("fv2_lancamento", "LANCAMENTO", alvo.lancamento.id, "situacao = 'CANCELADO'"), "lançamento cancelado com parcelas vivas");
    await recusa(alterarCru("fv2_lancamento", "LANCAMENTO", alvo.lancamento.id, "competencia = '2026-11'"), "competência do lançamento sem as parcelas");
    // proteção própria: empréstimo não é reclassificado, ajustado, movido nem cancelado pelas estreitas
    const e1 = (await linhas(emp.lancamento.id))[0];
    await recusa(alterarCru("fv2_obrigacao", "OBRIGACAO", e1.id, "situacao = 'CANCELADA'"), "empréstimo");
    await recusa(alterarCru("fv2_lancamento", "LANCAMENTO", emp.lancamento.id, "competencia = '2026-11'"), "empréstimo (competência)");
    const pelaOperacao = (p) => assert.rejects(p);
    let y = await doBanco(emp.lancamento.id);
    await pelaOperacao(n.cancelarContaAPagar(op([ACAO.CANCELAR_CONTA_A_PAGAR]), { obrigacaoId: y.os[0].id, abrangencia: "PARCELA", versoes: versoesDe([y.os[0]]), justificativa: just }));
    await pelaOperacao(n.ajustarValorDeContaAPagar(op([ACAO.AJUSTAR_CONTA_A_PAGAR]), { obrigacaoId: y.os[0].id, valorCorretoCentavos: 40000, versaoEsperada: y.os[0].versao, justificativa: just }));
    // ajuste sem lançamento, ou em OUTRA categoria: recusado na inclusão
    const ajCru = async (valor, categoria) => comoAplicacao(interno, null, async (cl) => {
      const aj = randomUUID();
      const cat = (await cl.query("select id, classificacao, natureza from financeiro_v2.fv2_categoria where codigo = $1 and organizacao_id = $2 and unidade_id = $3", [categoria, ORG_A, UNI_A])).rows[0];
      const lid = randomUUID();
      await cl.query(`insert into financeiro_v2.fv2_lancamento (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por, situacao, natureza, valor_centavos, moeda, categoria_id, categoria_codigo, classificacao, competencia, retido_no_repasse, origem, extras)
        values ($1, $2, $3, 1, now(), $4, now(), $4, 'ATIVO', $5, $6, 'BRL', $7, $8, $9, '2026-10', false, jsonb_build_object('tipo', 'AJUSTE', 'id', $10::text), '{}')`, [lid, ORG_A, UNI_A, OPERADOR, cat.natureza, valor, cat.id, categoria, cat.classificacao, aj]);
      await cl.query(`insert into financeiro_v2.fv2_ajuste (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por, alvo_tipo, alvo_id, valor_centavos, motivo, competencia, lancamento_id, extras)
        values ($1, $2, $3, 1, now(), $4, now(), $4, 'OBRIGACAO', $5, $6, 'abuso', '2026-10', $7, '{}')`, [aj, ORG_A, UNI_A, OPERADOR, p2.id, valor, lid]);
    }, { token: await interno.sessoes.emitir({ organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: OPERADOR }) });
    await recusa(ajCru(-5000, "INSUMOS"), "ajuste em outra categoria");
    assert.deepEqual((await linhas(alvo.lancamento.id)).map((o) => [o.situacao, o.competencia, Number(o.aj)]), [["ABERTA", "2026-10", 0], ["ABERTA", "2026-10", 0], ["ABERTA", "2026-10", 0]], "nada mudou na compra atacada");
  });
