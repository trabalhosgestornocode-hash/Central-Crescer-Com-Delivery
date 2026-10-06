// Testes das decisões puras da tela de integração iFood — unit, sem DOM.
// Rodar: node --test frontend/test/ifood.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  derivarEstadoIntegracao, prepararSelecaoMerchant, contadorExpiracao,
  precisaConfirmarTrocaMerchant, textoConfirmacaoTroca, mensagemErroAutorizacao, avisoDesconexao,
  derivarFontesConciliacao, derivarPendenciasHomologacao,
  sanitizarProfundo, montarEvidenciaHomologacao, montarExportacaoJson, montarExportacaoHtml,
  saudeSalesVsEvents, saudeEventsVsSettlements, saudeSettlementsVsReconciliation, saudeAnticipation,
} from "../src/ifoodEstado.js";

const app = (conectado, status = conectado ? "ativa" : null) => ({ conectado, status, expiraEm: null });
const status = ({ a = app(false), f = app(false), merchant = null, s = "nao_conectado" } = {}) => ({
  conectado: !!merchant && f.conectado,
  status: s,
  merchant,
  apps: { analytics: a, financial: f },
  conectadaEm: merchant ? "2026-08-28T12:00:00Z" : null,
});
const MERCHANT = { id: "550e8400-e29b-41d4-a716-446655440000", idMascarado: "550e****0000", nome: "Subway Saci", razaoSocial: "Saci LTDA" };

describe("derivarEstadoIntegracao — matriz de conexão dos apps", () => {
  test("nenhum app conectado -> Não conectado", () => {
    const e = derivarEstadoIntegracao(status());
    assert.equal(e.chave, "nao_conectado");
    assert.equal(e.rotulo, "Não conectado");
    assert.equal(e.apps.analytics.conectado, false);
    assert.equal(e.apps.financial.conectado, false);
    assert.equal(e.podeDesconectar, false);
    assert.equal(e.podeConectarAnalytics, true);
    assert.equal(e.podeConectarFinancial, true);
  });

  test("null / status ausente -> Não conectado (nunca lança)", () => {
    assert.equal(derivarEstadoIntegracao(null).chave, "nao_conectado");
    assert.equal(derivarEstadoIntegracao(undefined).chave, "nao_conectado");
    assert.equal(derivarEstadoIntegracao({}).chave, "nao_conectado");
  });

  test("só analytics conectado -> Parcialmente conectado", () => {
    const e = derivarEstadoIntegracao(status({ a: app(true), s: "pendente" }));
    assert.equal(e.chave, "parcial");
    assert.equal(e.rotulo, "Parcialmente conectado");
    assert.equal(e.apps.analytics.rotulo, "Conectado");
    assert.equal(e.apps.financial.rotulo, "Não conectado");
    assert.equal(e.podeConectarAnalytics, false);
    assert.equal(e.podeConectarFinancial, true);
    assert.equal(e.podeDesconectar, true);
  });

  test("só financial conectado, com merchant, SEM analytics -> Parcialmente conectado", () => {
    const e = derivarEstadoIntegracao(status({ f: app(true), merchant: MERCHANT, s: "ativa" }));
    assert.equal(e.chave, "parcial");
    assert.equal(e.apps.financial.conectado, true);
    assert.equal(e.merchant.idMascarado, "550e****0000");
  });

  test("só financial conectado SEM merchant -> Loja pendente (pode vincular; não é mais 'parcial' sem saída)", () => {
    const e = derivarEstadoIntegracao(status({ f: app(true), s: "pendente" }));
    assert.equal(e.chave, "merchant_pendente");
    assert.equal(e.podeVincularMerchant, true);
    assert.equal(e.merchant, null);
  });

  test("ambos conectados + merchant -> Conectado", () => {
    const e = derivarEstadoIntegracao(status({ a: app(true), f: app(true), merchant: MERCHANT, s: "ativa" }));
    assert.equal(e.chave, "conectado");
    assert.equal(e.rotulo, "Conectado");
    assert.equal(e.apps.analytics.conectado, true);
    assert.equal(e.apps.financial.conectado, true);
    assert.equal(e.podeConectarAnalytics, false);
    assert.equal(e.podeConectarFinancial, false);
    assert.equal(e.podeDesconectar, true);
  });

  test("reauth_required em qualquer app -> Reconexão necessária", () => {
    const e = derivarEstadoIntegracao(status({ a: app(true), f: { conectado: false, status: "reauth_required" }, merchant: MERCHANT, s: "reauth_required" }));
    assert.equal(e.chave, "reauth");
    assert.equal(e.rotulo, "Reconexão necessária");
    assert.equal(e.precisaReconectar, true);
    assert.equal(e.apps.financial.rotulo, "Reconexão necessária");
    assert.equal(e.podeConectarFinancial, true, "reauth reabre a possibilidade de reconectar");
  });
});

describe("prepararSelecaoMerchant", () => {
  test("0 merchants -> modo 'vazio' com mensagem amigável", () => {
    const r = prepararSelecaoMerchant([]);
    assert.equal(r.modo, "vazio");
    assert.equal(r.merchants.length, 0);
    assert.match(r.mensagem, /nenhuma loja/i);
  });
  test("lista nula/indefinida -> 'vazio' (nunca lança)", () => {
    assert.equal(prepararSelecaoMerchant(null).modo, "vazio");
    assert.equal(prepararSelecaoMerchant(undefined).modo, "vazio");
  });
  test("1 merchant -> modo 'unico', ainda pede confirmação", () => {
    const r = prepararSelecaoMerchant([MERCHANT]);
    assert.equal(r.modo, "unico");
    assert.equal(r.merchants.length, 1);
    assert.match(r.mensagem, /confirme/i);
  });
  test("múltiplos merchants -> modo 'lista'", () => {
    const r = prepararSelecaoMerchant([MERCHANT, { ...MERCHANT, id: "b", idMascarado: "b***b" }, { ...MERCHANT, id: "c", idMascarado: "c***c" }]);
    assert.equal(r.modo, "lista");
    assert.equal(r.merchants.length, 3);
  });
  test("itens sem id são descartados", () => {
    const r = prepararSelecaoMerchant([MERCHANT, { nome: "sem id" }, null]);
    assert.equal(r.modo, "unico");
  });
});

describe("contadorExpiracao (10 min)", () => {
  const base = Date.parse("2026-08-28T12:00:00Z");
  test("faltando ~9:43 -> não expirado, rótulo mm:ss", () => {
    const r = contadorExpiracao(new Date(base + 583_000).toISOString(), base);
    assert.equal(r.expirado, false);
    assert.equal(r.rotulo, "09:43");
  });
  test("prazo no passado -> expirado", () => {
    const r = contadorExpiracao(new Date(base - 1000).toISOString(), base);
    assert.equal(r.expirado, true);
    assert.equal(r.rotulo, "expirado");
    assert.equal(r.restanteMs, 0);
  });
  test("exatamente no limite -> expirado", () => {
    assert.equal(contadorExpiracao(new Date(base).toISOString(), base).expirado, true);
  });
  test("data inválida -> expirado, rótulo '—'", () => {
    const r = contadorExpiracao("não é data", base);
    assert.equal(r.expirado, true);
    assert.equal(r.rotulo, "—");
  });
});

describe("precisaConfirmarTrocaMerchant", () => {
  test("nenhum merchant vinculado -> sem confirmação", () => {
    assert.equal(precisaConfirmarTrocaMerchant(status(), MERCHANT), false);
    assert.equal(precisaConfirmarTrocaMerchant(null, MERCHANT), false);
  });
  test("mesmo merchant (idempotente) -> sem confirmação", () => {
    const st = status({ f: app(true), merchant: MERCHANT, s: "ativa" });
    assert.equal(precisaConfirmarTrocaMerchant(st, MERCHANT), false);
  });
  test("merchant diferente -> exige confirmação", () => {
    const st = status({ f: app(true), merchant: MERCHANT, s: "ativa" });
    const outro = { id: "999", idMascarado: "9999****9999", nome: "Subway Centro" };
    assert.equal(precisaConfirmarTrocaMerchant(st, outro), true);
    assert.match(textoConfirmacaoTroca(st, outro), /substituir/i);
    assert.match(textoConfirmacaoTroca(st, outro), /Subway Saci/);
    assert.match(textoConfirmacaoTroca(st, outro), /Subway Centro/);
  });
});

describe("mensagemErroAutorizacao", () => {
  test("código expirado -> orienta a gerar outro", () => {
    assert.match(mensagemErroAutorizacao({ codigo: "IFOOD_OAUTH_SESSAO_EXPIRADA" }), /expirou/i);
  });
  test("authorizationCode inválido -> orienta a conferir/gerar novo", () => {
    assert.match(mensagemErroAutorizacao({ codigo: "IFOOD_OAUTH_CODIGO_INVALIDO" }), /código de autorização/i);
  });
  test("erro genérico -> usa a mensagem do backend", () => {
    assert.equal(mensagemErroAutorizacao({ message: "Falha X" }), "Falha X");
  });
  test("sem nada -> mensagem padrão, nunca undefined", () => {
    assert.match(mensagemErroAutorizacao({}), /autoriza/i);
  });
});

describe("avisoDesconexao", () => {
  test("explica que a remoção local não revoga no iFood e orienta o Portal do Parceiro", () => {
    const t = avisoDesconexao();
    assert.match(t, /apenas aqui/i);
    assert.match(t, /não revoga/i);
    assert.match(t, /Portal do Parceiro/i);
  });
});

// Resultado mínimo de obterConciliacaoFinanceira() — só os campos que
// derivarFontesConciliacao/derivarPendenciasHomologacao leem.
const resultadoConciliacao = (over = {}) => ({
  fontesComErro: [],
  reconciliation: { disponivel: true },
  conciliacao: {
    statusGeral: "CONCILIADO",
    divergencias: [],
    settlementsVsReconciliation: { status: "CONCILIADO", motivo: null },
  },
  ...over,
});

describe("derivarFontesConciliacao — Visão Geral (Bloco H)", () => {
  test("resultado nulo -> todas indisponíveis, sem lançar", () => {
    const r = derivarFontesConciliacao(null);
    assert.equal(r.length, 5);
    assert.ok(r.every((f) => f.disponivel === false && f.motivo === null));
  });

  test("tudo certo -> todas as 5 fontes disponíveis", () => {
    const r = derivarFontesConciliacao(resultadoConciliacao());
    assert.equal(r.length, 5);
    assert.ok(r.every((f) => f.disponivel === true));
    assert.deepEqual(r.map((f) => f.fonte), ["sales", "events", "settlements", "reconciliation", "anticipations"]);
  });

  test("fonte em fontesComErro -> indisponível com o motivo do backend", () => {
    const r = derivarFontesConciliacao(resultadoConciliacao({ fontesComErro: [{ fonte: "settlements", mensagem: "Falha X" }] }));
    const settlements = r.find((f) => f.fonte === "settlements");
    assert.equal(settlements.disponivel, false);
    assert.equal(settlements.motivo, "Falha X");
    // as outras 4 continuam disponíveis
    assert.ok(r.filter((f) => f.fonte !== "settlements").every((f) => f.disponivel === true));
  });

  test("Reconciliation não disponível (sem erro de busca) -> indisponível com motivo próprio", () => {
    const r = derivarFontesConciliacao(resultadoConciliacao({ reconciliation: { disponivel: false } }));
    const rec = r.find((f) => f.fonte === "reconciliation");
    assert.equal(rec.disponivel, false);
    assert.match(rec.motivo, /ainda não disponível/i);
  });
});

describe("derivarPendenciasHomologacao — gerada só a partir do resultado", () => {
  test("resultado nulo -> nenhuma pendência, sem lançar", () => {
    assert.deepEqual(derivarPendenciasHomologacao(null), []);
  });

  test("tudo conciliado, com dados -> nenhuma pendência inventada", () => {
    assert.deepEqual(derivarPendenciasHomologacao(resultadoConciliacao()), []);
  });

  test("fonte com erro -> pendência FONTE_SEM_DADOS citando a fonte e a mensagem", () => {
    const r = derivarPendenciasHomologacao(resultadoConciliacao({ fontesComErro: [{ fonte: "sales", mensagem: "Timeout" }] }));
    assert.equal(r.length, 1);
    assert.equal(r[0].codigo, "FONTE_SEM_DADOS");
    assert.match(r[0].mensagem, /Sales/);
    assert.match(r[0].mensagem, /Timeout/);
  });

  test("Settlements × Reconciliation NAO_COMPARAVEL -> pendência com o motivo, não tratado como erro", () => {
    const r = derivarPendenciasHomologacao(resultadoConciliacao({
      conciliacao: { statusGeral: "NAO_COMPARAVEL", divergencias: [], settlementsVsReconciliation: { status: "NAO_COMPARAVEL", motivo: "Coluna de valor não identificada." } },
    }));
    assert.equal(r.length, 1);
    assert.equal(r[0].codigo, "RECONCILIATION_NAO_COMPARAVEL");
    assert.equal(r[0].mensagem, "Coluna de valor não identificada.");
  });

  test("Settlements × Reconciliation INCOMPLETO com motivo -> pendência dizendo qual fonte faltou", () => {
    const r = derivarPendenciasHomologacao(resultadoConciliacao({
      conciliacao: { statusGeral: "INCOMPLETO", divergencias: [], settlementsVsReconciliation: { status: "INCOMPLETO", motivo: "Reconciliation não disponível para o período." } },
    }));
    assert.equal(r.length, 1);
    assert.equal(r[0].codigo, "RECONCILIATION_INCOMPLETA");
    assert.match(r[0].mensagem, /Reconciliation não disponível/);
  });

  test("divergências encontradas -> pendência com a quantidade", () => {
    const r = derivarPendenciasHomologacao(resultadoConciliacao({
      conciliacao: { statusGeral: "DIVERGENTE", divergencias: [{}, {}], settlementsVsReconciliation: { status: "CONCILIADO", motivo: null } },
    }));
    assert.equal(r.length, 1);
    assert.equal(r[0].codigo, "DIVERGENCIA_ENCONTRADA");
    assert.match(r[0].mensagem, /^2 divergência/);
  });

  test("statusGeral SEM_DADOS -> pendência de primeira validação ainda não realizada", () => {
    const r = derivarPendenciasHomologacao(resultadoConciliacao({
      conciliacao: { statusGeral: "SEM_DADOS", divergencias: [], settlementsVsReconciliation: { status: "SEM_DADOS", motivo: null } },
    }));
    assert.equal(r.length, 1);
    assert.equal(r[0].codigo, "SEM_VALIDACAO_REAL");
  });

  test("vários sinais ao mesmo tempo -> várias pendências, cada uma isolada", () => {
    const r = derivarPendenciasHomologacao(resultadoConciliacao({
      fontesComErro: [{ fonte: "anticipations", mensagem: "Indisponível" }],
      conciliacao: {
        statusGeral: "DIVERGENTE", divergencias: [{}],
        settlementsVsReconciliation: { status: "NAO_COMPARAVEL", motivo: "Sem coluna." },
      },
    }));
    assert.deepEqual(r.map((p) => p.codigo), ["FONTE_SEM_DADOS", "RECONCILIATION_NAO_COMPARAVEL", "DIVERGENCIA_ENCONTRADA"]);
  });
});

// ===========================================================================
// Evidências de Homologação — sanitizarProfundo / montarEvidenciaHomologacao
// / montarExportacaoJson / montarExportacaoHtml / saude* (Bloco Q)
// ===========================================================================

describe("saude* — transformadores puros de Sales×Events/Events×Settlements/Settlements×Reconciliation/Anticipation", () => {
  test("saudeSalesVsEvents: contagens, nunca dinheiro", () => {
    const r = saudeSalesVsEvents({ status: "DIVERGENTE", quantidadeVendas: 10, quantidadeConciliadas: 8, quantidadeDivergentes: 1, quantidadeIncompletas: 1 });
    assert.equal(r.status, "DIVERGENTE");
    assert.match(r.esperado, /10 venda/);
    assert.match(r.encontrado, /8 conciliada/);
    assert.match(r.diferenca, /1 divergente/);
  });

  test("saudeEventsVsSettlements: divergencia null -> traço, não 'R$ null'", () => {
    const r = saudeEventsVsSettlements({ status: "INCOMPLETO", settlementBalance: null, somaEventosImpactantes: 900, divergencia: null });
    assert.equal(r.esperado, "—");
    assert.match(r.encontrado, /R\$/);
    assert.equal(r.diferenca, "—");
  });

  test("saudeSettlementsVsReconciliation: usa o motivo do backend quando existe", () => {
    const r = saudeSettlementsVsReconciliation({ status: "NAO_COMPARAVEL", settlementBalance: 900, totalReconciliationIdentificado: null, divergencia: null, motivo: "Sem coluna de valor." });
    assert.equal(r.status, "NAO_COMPARAVEL");
    assert.equal(r.explicacao, "Sem coluna de valor.");
  });

  test("saudeSettlementsVsReconciliation: sem motivo -> explicação padrão", () => {
    const r = saudeSettlementsVsReconciliation({ status: "CONCILIADO", settlementBalance: 900, totalReconciliationIdentificado: 900, divergencia: 0, motivo: null });
    assert.match(r.explicacao, /Total identificado/);
  });

  test("saudeAnticipation: 0 itens avaliados -> SEM_DADOS (não é divergência)", () => {
    const r = saudeAnticipation({ consistente: null, itensAvaliados: 0, itensInconsistentes: [] });
    assert.equal(r.status, "SEM_DADOS");
  });
  test("saudeAnticipation: consistente true -> CONCILIADO", () => {
    assert.equal(saudeAnticipation({ consistente: true, itensAvaliados: 3, itensInconsistentes: [] }).status, "CONCILIADO");
  });
  test("saudeAnticipation: consistente false -> DIVERGENTE, conta os inconsistentes", () => {
    const r = saudeAnticipation({ consistente: false, itensAvaliados: 3, itensInconsistentes: [{}, {}] });
    assert.equal(r.status, "DIVERGENTE");
    assert.match(r.encontrado, /^2 inconsistente/);
  });
});

describe("sanitizarProfundo — remoção recursiva de chave sensível", () => {
  test("chave sensível no topo -> [REDACTED]; valor comum passa direto", () => {
    const r = sanitizarProfundo({ accessToken: "seg-123", nome: "Loja X" });
    assert.equal(r.accessToken, "[REDACTED]");
    assert.equal(r.nome, "Loja X");
  });

  test("sanitização profunda: pega chave sensível em qualquer nível de aninhamento, dentro de array e de objeto", () => {
    const r = sanitizarProfundo({
      pedido: { id: "p1", pagamento: { metodo: "PIX", detalhe: { authorization: "Bearer xyz" } } },
      itens: [{ nome: "a" }, { nome: "b", refreshToken: "rt-999" }],
    });
    assert.equal(r.pedido.pagamento.detalhe.authorization, "[REDACTED]");
    assert.equal(r.itens[1].refreshToken, "[REDACTED]");
    assert.equal(r.itens[0].nome, "a"); // não sensível, intocado
  });

  test("remoção de URL assinada (downloadUrl/signedUrl/downloadPath)", () => {
    const r = sanitizarProfundo({
      downloadUrl: "https://s3.amazonaws.com/bucket/arquivo?X-Amz-Signature=abc",
      signedUrl: "https://outra.com/x?sig=def",
      downloadPath: "https://merchant-api.ifood.com.br/x",
    });
    assert.equal(r.downloadUrl, "[REDACTED]");
    assert.equal(r.signedUrl, "[REDACTED]");
    assert.equal(r.downloadPath, "[REDACTED]");
  });

  test("ausência de tokens: accessToken/refreshToken/clientSecret/verifier nunca sobrevivem, em nenhuma variação de nome", () => {
    const r = sanitizarProfundo({
      accessToken: "a", access_token: "b", ["Access-Token"]: "c",
      refreshToken: "d", clientSecret: "e", verifier: "f", Authorization: "g", token: "h",
    });
    const valores = JSON.stringify(r);
    for (const segredo of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      assert.ok(!valores.includes(`"${segredo}"`), `segredo "${segredo}" vazou pro JSON sanitizado`);
    }
  });

  test("valores monetários (number) atravessam sem virar string nem perder precisão", () => {
    const r = sanitizarProfundo({ valor: 1234.56, saldo: -7.5, zero: 0 });
    assert.equal(r.valor, 1234.56);
    assert.equal(typeof r.valor, "number");
    assert.equal(r.saldo, -7.5);
    assert.equal(r.zero, 0);
  });

  test("timestamps (string ISO) atravessam sem reformatar", () => {
    const r = sanitizarProfundo({ criadoEm: "2026-09-01T10:00:00Z" });
    assert.equal(r.criadoEm, "2026-09-01T10:00:00Z");
  });

  test("caracteres especiais no VALOR não são tocados (escapar é responsabilidade da renderização, não da sanitização)", () => {
    const r = sanitizarProfundo({ nome: "<script>alert(1)</script> — çãõ 日本語" });
    assert.equal(r.nome, "<script>alert(1)</script> — çãõ 日本語");
  });

  test("null/undefined/array vazio/objeto vazio -> sem lançar", () => {
    assert.equal(sanitizarProfundo(null), null);
    assert.equal(sanitizarProfundo(undefined), undefined);
    assert.deepEqual(sanitizarProfundo([]), []);
    assert.deepEqual(sanitizarProfundo({}), {});
  });

  test("referência circular -> '[circular]', nunca estoura pilha", () => {
    const obj = { nome: "x" };
    obj.self = obj;
    const r = sanitizarProfundo(obj);
    assert.equal(r.self, "[circular]");
  });
});

// --- Fixtures de evidência --------------------------------------------------

const STATUS_COMPLETO = { merchant: { idMascarado: "550e****0000", nome: "Subway Saci", razaoSocial: "Saci LTDA" }, homologacao: true };

function rcCompleto(over = {}) {
  return {
    periodo: { inicio: "2026-09-01", fim: "2026-09-07" },
    vendas: { quantidade: 10, bruto: 1000, saldoVendas: 900 },
    eventos: { quantidade: 20, creditos: 1000, debitos: 100, comImpactoTransferencia: 18, semImpactoTransferencia: 2, saldoImpactante: 900 },
    settlements: { quantidade: 5, balance: 900, closingItemsTotal: 900 },
    reconciliation: { disponivel: true, quantidadeRegistros: 3, totalIdentificado: 900, colunaIdDetectada: "pedido", colunaValorDetectada: "valor", competencia: "2026-08" },
    anticipation: { quantidade: 2, valorOriginal: 500, taxas: 15, valorAntecipado: 485, consistente: true, itensAvaliados: 2, itensInconsistentes: [] },
    conciliacao: {
      salesVsEvents: { status: "CONCILIADO", quantidadeVendas: 10, quantidadeConciliadas: 10, quantidadeDivergentes: 0, quantidadeIncompletas: 0 },
      eventsVsSettlements: { eventosComImpacto: 18, eventosSemImpacto: 2, somaEventosImpactantes: 900, settlementBalance: 900, closingItemsTotal: 900, status: "CONCILIADO", divergencia: 0 },
      settlementsVsReconciliation: { status: "CONCILIADO", settlementBalance: 900, totalReconciliationIdentificado: 900, divergencia: 0, motivo: null },
      statusGeral: "CONCILIADO",
      divergencias: [],
    },
    trilhaPorVenda: [],
    fontesComErro: [],
    ...over,
  };
}

function financeiroCompleto(rc = rcCompleto()) {
  return {
    sales: {
      inicio: "2026-09-01", fim: "2026-09-07", erro: null,
      resultado: { periodo: { inicio: "2026-09-01", fim: "2026-09-07" }, pagina: { atual: 1, tamanho: 10, total: 10, totalPaginas: 1 }, vendas: [{ id: "v1", shortId: "1234", accessTokenNuncaDeveriaEstarAqui: "seg-1" }] },
    },
    events: {
      erro: null,
      resultado: { pagina: { atual: 1, tamanho: 20, temProximaPagina: false }, periodo: { inicio: "2026-09-01", fim: "2026-09-07" }, eventos: [{ nome: "Comissão", valor: -10, temImpactoRepasse: true }] },
    },
    settlements: {
      erro: null,
      resultado: { periodo: { inicio: "2026-08-25", fim: "2026-08-31" }, saldo: 900, titulos: [{ id: "t1", tipo: "PIX", valor: 900, status: "PAID" }] },
    },
    reconciliation: {
      competencia: "2026-08", erro: null,
      resultado: {
        competencia: "2026-08", criadoEm: "2026-09-05T00:00:00Z",
        metadados: { sha256: "abc123", totalLinhas: 3, totalPedidosAssociadosIfood: 3, totalCodigoTransacao: 3 },
        arquivo: { colunas: ["pedido", "valor"], linhas: [{ pedido: "1234", valor: "90.00" }], totalLinhas: 3, truncado: false, integridadeVerificada: true, eraGzip: false, delimitador: "," },
      },
      onDemand: { competencia: "2026-08", requestId: null, resultado: null, erro: null },
    },
    anticipation: {
      erro: null,
      resultado: { periodo: { inicio: "2026-08-25", fim: "2026-08-31" }, saldo: 485, antecipacoes: [{ tipo: "REPASSE_ANTECIPADO_DIARIO", valorOriginal: 250, valorAntecipado: 242.5, taxa: { valor: 7.5, percentual: 3 }, status: "SUCCEED" }] },
    },
    conciliation: { inicio: "2026-09-01", fim: "2026-09-07", erro: null, resultado: rc },
  };
}

describe("montarEvidenciaHomologacao — evidência completa", () => {
  const evidencia = montarEvidenciaHomologacao({ geradoEm: "2026-09-08T12:00:00.000Z", status: STATUS_COMPLETO, financeiro: financeiroCompleto() });

  test("cabeçalho: ambiente, merchant, geradoEm", () => {
    assert.equal(evidencia.ambiente, "homologacao");
    assert.equal(evidencia.merchant.nome, "Subway Saci");
    assert.equal(evidencia.geradoEm, "2026-09-08T12:00:00.000Z");
  });

  test("resumo: período, competência, status geral, fontes", () => {
    assert.deepEqual(evidencia.resumo.periodoConsultado, { inicio: "2026-09-01", fim: "2026-09-07" });
    assert.equal(evidencia.resumo.competencia, "2026-08");
    assert.equal(evidencia.resumo.statusGeralConciliacao, "CONCILIADO");
    assert.deepEqual(evidencia.resumo.fontesConsultadas.sort(), ["anticipations", "events", "reconciliation", "sales", "settlements"]);
    assert.equal(evidencia.resumo.fontesDisponiveis.length, 5);
    assert.equal(evidencia.resumo.fontesComErro.length, 0);
  });

  test("apis: números vêm do Bloco H, período e exemplo vêm da aba bruta", () => {
    assert.equal(evidencia.apis.sales.quantidade, 10);
    assert.equal(evidencia.apis.sales.valorBruto, 1000);
    assert.equal(evidencia.apis.sales.saldo, 900);
    assert.deepEqual(evidencia.apis.sales.periodo, { inicio: "2026-09-01", fim: "2026-09-07" });
    assert.equal(evidencia.apis.sales.exemplo.id, "v1");
    assert.equal(evidencia.apis.events.comImpactoTransferencia, 18);
    assert.equal(evidencia.apis.settlements.balance, 900);
    assert.equal(evidencia.apis.anticipation.valorAntecipado, 485);
  });

  test("exemplo de venda sai SANITIZADO — chave sensível colada de propósito no fixture não sobrevive", () => {
    assert.equal(evidencia.apis.sales.exemplo.accessTokenNuncaDeveriaEstarAqui, "[REDACTED]");
  });

  test("reconciliation: hash/formato/delimitador vêm do arquivo bruto", () => {
    const rec = evidencia.apis.reconciliation;
    assert.equal(rec.quantidadeRegistros, 3);
    assert.equal(rec.hashVerificado, true);
    assert.equal(rec.formatoDetectado, "csv");
    assert.equal(rec.delimitadorDetectado, ",");
    assert.equal(rec.onDemand, undefined, "On Demand tem bloco próprio (reconciliationOnDemand)");
    assert.equal(evidencia.reconciliationOnDemand.solicitado, false);
  });

  test("validações: as 4 + nenhuma divergência", () => {
    assert.equal(evidencia.validacoes.disponivel, true);
    assert.equal(evidencia.validacoes.salesVsEvents.status, "CONCILIADO");
    assert.equal(evidencia.validacoes.anticipation.status, "CONCILIADO");
    assert.equal(evidencia.validacoes.divergencias.length, 0);
  });
});

describe("montarEvidenciaHomologacao — uma fonte ausente", () => {
  test("Settlements com erro -> indisponível, some da lista de disponíveis, aparece em fontesComErro", () => {
    const rc = rcCompleto({ settlements: null, fontesComErro: [{ fonte: "settlements", mensagem: "Timeout (504)." }] });
    const fin = financeiroCompleto(rc);
    fin.settlements = { erro: "Timeout (504).", resultado: null };
    const e = montarEvidenciaHomologacao({ geradoEm: "2026-09-08T12:00:00Z", status: STATUS_COMPLETO, financeiro: fin });

    assert.equal(e.apis.settlements.consultada, true); // tentou (tem erro)
    assert.equal(e.apis.settlements.disponivel, false);
    assert.equal(e.apis.settlements.erro, "Timeout (504).");
    assert.equal(e.resumo.fontesDisponiveis.includes("settlements"), false);
    assert.equal(e.resumo.fontesComErro.length, 1);
    assert.equal(e.resumo.fontesComErro[0].fonte, "settlements");
  });
});

describe("montarEvidenciaHomologacao — várias fontes ausentes", () => {
  test("Settlements E Anticipation com erro -> só 3 disponíveis, 2 com erro", () => {
    const rc = rcCompleto({
      settlements: null, anticipation: null,
      fontesComErro: [{ fonte: "settlements", mensagem: "Timeout." }, { fonte: "anticipations", mensagem: "Indisponível." }],
    });
    const fin = financeiroCompleto(rc);
    fin.settlements = { erro: "Timeout.", resultado: null };
    fin.anticipation = { erro: "Indisponível.", resultado: null };
    const e = montarEvidenciaHomologacao({ geradoEm: "2026-09-08T12:00:00Z", status: STATUS_COMPLETO, financeiro: fin });

    assert.equal(e.resumo.fontesDisponiveis.length, 3);
    assert.equal(e.resumo.fontesComErro.length, 2);
    assert.equal(e.apis.anticipation.quantidade, null);
  });
});

describe("montarEvidenciaHomologacao — dataset vazio (nada consultado ainda)", () => {
  test("sem status, sem financeiro -> tudo neutro, sem lançar", () => {
    const e = montarEvidenciaHomologacao({ geradoEm: "2026-09-08T12:00:00Z", status: null, financeiro: {} });
    assert.equal(e.ambiente, "producao");
    assert.equal(e.merchant, null);
    assert.equal(e.resumo.periodoConsultado, null);
    assert.deepEqual(e.resumo.fontesConsultadas, []);
    assert.equal(e.validacoes.disponivel, false);
    assert.equal(e.apis.sales.consultada, false);
    assert.equal(e.apis.sales.exemplo, null);
    assert.equal(e.apis.sales.quantidade, null);
  });
});

describe("montarEvidenciaHomologacao — divergência", () => {
  test("divergência em salesVsEvents aparece em validacoes.divergencias e no status", () => {
    const rc = rcCompleto({
      conciliacao: {
        salesVsEvents: { status: "DIVERGENTE", quantidadeVendas: 10, quantidadeConciliadas: 9, quantidadeDivergentes: 1, quantidadeIncompletas: 0 },
        eventsVsSettlements: { eventosComImpacto: 18, eventosSemImpacto: 2, somaEventosImpactantes: 900, settlementBalance: 900, closingItemsTotal: 900, status: "CONCILIADO", divergencia: 0 },
        settlementsVsReconciliation: { status: "CONCILIADO", settlementBalance: 900, totalReconciliationIdentificado: 900, divergencia: 0, motivo: null },
        statusGeral: "DIVERGENTE",
        divergencias: [{ codigo: "SALES_EVENTS_DIVERGENCIA", origem: "Venda 1234", esperado: 90, encontrado: 80, diferenca: -10, explicacao: "x" }],
      },
    });
    const e = montarEvidenciaHomologacao({ geradoEm: "2026-09-08T12:00:00Z", status: STATUS_COMPLETO, financeiro: financeiroCompleto(rc) });
    assert.equal(e.resumo.statusGeralConciliacao, "DIVERGENTE");
    assert.equal(e.validacoes.salesVsEvents.status, "DIVERGENTE");
    assert.equal(e.validacoes.divergencias.length, 1);
    assert.equal(e.validacoes.divergencias[0].codigo, "SALES_EVENTS_DIVERGENCIA");
  });
});

describe("montarEvidenciaHomologacao — NAO_COMPARAVEL", () => {
  test("Settlements×Reconciliation NAO_COMPARAVEL não vira 'DIVERGENTE' nem some", () => {
    const rc = rcCompleto({
      conciliacao: {
        salesVsEvents: { status: "CONCILIADO", quantidadeVendas: 10, quantidadeConciliadas: 10, quantidadeDivergentes: 0, quantidadeIncompletas: 0 },
        eventsVsSettlements: { eventosComImpacto: 18, eventosSemImpacto: 2, somaEventosImpactantes: 900, settlementBalance: 900, closingItemsTotal: 900, status: "CONCILIADO", divergencia: 0 },
        settlementsVsReconciliation: { status: "NAO_COMPARAVEL", settlementBalance: 900, totalReconciliationIdentificado: null, divergencia: null, motivo: "Coluna de valor não identificada." },
        statusGeral: "NAO_COMPARAVEL",
        divergencias: [],
      },
    });
    const e = montarEvidenciaHomologacao({ geradoEm: "2026-09-08T12:00:00Z", status: STATUS_COMPLETO, financeiro: financeiroCompleto(rc) });
    assert.equal(e.validacoes.settlementsVsReconciliation.status, "NAO_COMPARAVEL");
    assert.equal(e.validacoes.settlementsVsReconciliation.explicacao, "Coluna de valor não identificada.");
    assert.equal(e.resumo.statusGeralConciliacao, "NAO_COMPARAVEL");
  });
});

describe("montarExportacaoJson", () => {
  test("é JSON válido, contém os campos principais, sem segredo nenhum", () => {
    const fin = financeiroCompleto();
    fin.sales.resultado.vendas[0].authorization = "Bearer super-secreto";
    const evidencia = montarEvidenciaHomologacao({ geradoEm: "2026-09-08T12:00:00Z", status: STATUS_COMPLETO, financeiro: fin });
    const texto = montarExportacaoJson(evidencia);
    const obj = JSON.parse(texto); // não lança -> é JSON válido
    assert.equal(obj.merchant.nome, "Subway Saci");
    assert.equal(obj.resumo.statusGeralConciliacao, "CONCILIADO");
    assert.ok(!texto.includes("super-secreto"), "segredo vazou na exportação JSON");
  });
});

describe("montarExportacaoHtml", () => {
  test("documento HTML autocontido com as seções pedidas, sem segredo e com caracteres especiais escapados", () => {
    const fin = financeiroCompleto();
    fin.sales.resultado.vendas[0].clientSecret = "outro-segredo";
    fin.sales.resultado.vendas[0].canal = "<script>alert(1)</script>";
    const evidencia = montarEvidenciaHomologacao({ geradoEm: "2026-09-08T12:00:00Z", status: STATUS_COMPLETO, financeiro: fin });
    const html = montarExportacaoHtml(evidencia);

    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /Merchant/);
    assert.match(html, /Validações financeiras/);
    assert.match(html, /Subway Saci/);
    assert.ok(!html.includes("outro-segredo"), "segredo vazou na exportação HTML");
    assert.ok(!html.includes("<script>alert(1)</script>"), "HTML não escapado — risco de injeção no arquivo exportado");
    assert.match(html, /&lt;script&gt;/);
  });

  test("evidência sem Conciliação consultada -> HTML explica a ausência, não quebra", () => {
    const evidencia = montarEvidenciaHomologacao({ geradoEm: "2026-09-08T12:00:00Z", status: null, financeiro: {} });
    const html = montarExportacaoHtml(evidencia);
    assert.match(html, /ainda não foi consultada/);
  });
});
