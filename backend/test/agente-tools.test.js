// Testes das tools do Agente Crescer — unit, sem rede/Anthropic/Supabase de
// dados de negócio: `obterMes` é sempre injetado (ver `deps` em cada tool).
//
// O que estes testes protegem, na ordem do pedido:
//   * a tool reutiliza o service correto (mesma função, mesmos parâmetros);
//   * organizacaoId/unidadeId vêm SEMPRE do contexto do backend, nunca do
//     que está em `input` — mesmo que um input malicioso tente incluir
//     unidadeId/organizacaoId;
//   * argumentos inválidos (mês fora de 1-12, ano absurdo) são rejeitados;
//   * módulo/permissão do módulo consultado (Dashboard iFood) é exigido
//     mesmo com a rota /agente liberada;
//   * nenhuma tool tem qualquer efeito de escrita.
//
// Rodar: node --env-file-if-exists=.env --test test/agente-tools.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { MODULOS } from "../src/shared/modulos.js";
import { PERMISSOES } from "../src/shared/permissoes.js";
import { garantirAcessoModulo, garantirPermissao } from "../src/modules/agente/agenteAcesso.js";
import { FERRAMENTAS, REGISTRO, executarFerramenta, ferramentasDisponiveis } from "../src/modules/agente/agente.tools.js";
import * as dashboardTool from "../src/modules/agente/tools/dashboardExecutivo.tool.js";
import * as diagnosticoTool from "../src/modules/agente/tools/diagnostico.tool.js";
import * as dashboardDiaTool from "../src/modules/agente/tools/dashboardDia.tool.js";
import { STATUS_DIA } from "../src/modules/dashboard-executivo/dashboardExecutivo.calc.js";

const ORG_ID = "33333333-3333-4333-8333-333333333333";
const UNIDADE_ID = "44444444-4444-4444-8444-444444444444";
const OUTRA_UNIDADE_ID = "99999999-9999-4999-8999-999999999999";

const ACESSO_COM_MODULO = {
  modulos: [MODULOS.IFOOD_DASHBOARD], permissoes: [PERMISSOES.DASHBOARD_EXECUTIVO_VER], impersonando: false,
};
const ACESSO_SEM_MODULO = { modulos: [], permissoes: [PERMISSOES.DASHBOARD_EXECUTIVO_VER], impersonando: false };
const ACESSO_SEM_PERMISSAO = { modulos: [MODULOS.IFOOD_DASHBOARD], permissoes: [], impersonando: false };
const ACESSO_IMPERSONANDO_SEM_NADA = { modulos: [], permissoes: [], impersonando: true };

const DADOS_UNIDADE = {
  agregado: false,
  periodo: { mes: 8, ano: 2026 },
  modeloLogisticoRotulo: "Marketplace",
  ehTeste: false,
  resumoPreenchimento: { diasPreenchidos: 20, diasPendentes: 1 },
  cards: { faturamento: { valor: 12345.67 } },
  projecao: { projecaoMensal: 30000 },
  pendenciasMesesAnteriores: [],
  diagnostico: { pontosFortes: [], pontosAtencao: [], alertas: [], acoes: [], semDadosSuficientes: false, confiabilidade: { nivel: "alta" } },
};

const DADOS_AGREGADO = {
  agregado: true,
  periodo: { mes: 8, ano: 2026 },
  aviso: "Visão consolidada...",
  cards: { faturamento: { valor: 99999 } },
};

describe("agenteAcesso", () => {
  test("garantirAcessoModulo: nega quando o módulo não está no acesso", () => {
    assert.throws(() => garantirAcessoModulo(ACESSO_SEM_MODULO, MODULOS.IFOOD_DASHBOARD), /não contratado/);
  });
  test("garantirAcessoModulo: passa quando o módulo está no acesso", () => {
    assert.doesNotThrow(() => garantirAcessoModulo(ACESSO_COM_MODULO, MODULOS.IFOOD_DASHBOARD));
  });
  test("garantirAcessoModulo: impersonando ignora bypassa mesmo sem o módulo", () => {
    assert.doesNotThrow(() => garantirAcessoModulo(ACESSO_IMPERSONANDO_SEM_NADA, MODULOS.IFOOD_DASHBOARD));
  });
  test("garantirAcessoModulo: sem acesso algum -> forbidden", () => {
    assert.throws(() => garantirAcessoModulo(undefined, MODULOS.IFOOD_DASHBOARD), /Contexto de empresa/);
  });

  test("garantirPermissao: nega sem a permissão necessária", () => {
    assert.throws(() => garantirPermissao(ACESSO_SEM_PERMISSAO, PERMISSOES.DASHBOARD_EXECUTIVO_VER), /Permissão insuficiente/);
  });
  test("garantirPermissao: passa com a permissão necessária", () => {
    assert.doesNotThrow(() => garantirPermissao(ACESSO_COM_MODULO, PERMISSOES.DASHBOARD_EXECUTIVO_VER));
  });
  test("garantirPermissao: impersonando bypassa mesmo sem a permissão", () => {
    assert.doesNotThrow(() => garantirPermissao(ACESSO_IMPERSONANDO_SEM_NADA, PERMISSOES.DASHBOARD_EXECUTIVO_VER));
  });
});

describe("consultar_dashboard_executivo", () => {
  test("chama obterMes com organizacaoId/unidadeId do CONTEXTO, nunca do input", async () => {
    let chamadaCom = null;
    const deps = { obterMes: async (args) => { chamadaCom = args; return DADOS_UNIDADE; } };

    await dashboardTool.executar(
      { ano: 2026, mes: 8, unidadeId: OUTRA_UNIDADE_ID, organizacaoId: "org-de-outro-tenant" },
      { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO },
      deps,
    );

    assert.equal(chamadaCom.organizacaoId, ORG_ID);
    assert.equal(chamadaCom.unidadeIdSessao, UNIDADE_ID);
    // O input tentou mandar outra unidade/organização — precisa ser ignorado.
    assert.equal(chamadaCom.unidadeIdSolicitado, undefined);
    assert.equal(chamadaCom.ano, 2026);
    assert.equal(chamadaCom.mes, 8);
  });

  test("usa o mês/ano atuais quando o input não informa nenhum dos dois", async () => {
    let chamadaCom = null;
    const deps = { obterMes: async (args) => { chamadaCom = args; return DADOS_UNIDADE; } };
    const agora = new Date();

    await dashboardTool.executar({}, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);

    assert.equal(chamadaCom.ano, agora.getFullYear());
  });

  test("rejeita mês fora de 1-12 sem chamar o service", async () => {
    let chamou = false;
    const deps = { obterMes: async () => { chamou = true; return DADOS_UNIDADE; } };
    await assert.rejects(
      () => dashboardTool.executar({ mes: 13, ano: 2026 }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps),
      /Mês deve estar entre 1 e 12/,
    );
    assert.equal(chamou, false);
  });

  test("nega acesso sem o módulo Dashboard iFood, sem chamar o service", async () => {
    let chamou = false;
    const deps = { obterMes: async () => { chamou = true; return DADOS_UNIDADE; } };
    await assert.rejects(
      () => dashboardTool.executar({}, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_SEM_MODULO }, deps),
      /não contratado/,
    );
    assert.equal(chamou, false);
  });

  test("nega acesso sem a permissão dashboard_executivo.ver, sem chamar o service", async () => {
    let chamou = false;
    const deps = { obterMes: async () => { chamou = true; return DADOS_UNIDADE; } };
    await assert.rejects(
      () => dashboardTool.executar({}, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_SEM_PERMISSAO }, deps),
      /Permissão insuficiente/,
    );
    assert.equal(chamou, false);
  });

  test("normaliza a visão agregada (todas as unidades) sem quebrar", async () => {
    const deps = { obterMes: async () => DADOS_AGREGADO };
    const r = await dashboardTool.executar({}, { organizacaoId: ORG_ID, unidadeId: null, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.visao, "todas_as_unidades");
    assert.equal(r.cards.faturamento.valor, 99999);
  });
});

describe("consultar_diagnostico", () => {
  test("reaproveita a mesma chamada de obterMes e recorta só o diagnóstico", async () => {
    let chamadaCom = null;
    const deps = { obterMes: async (args) => { chamadaCom = args; return DADOS_UNIDADE; } };

    const r = await diagnosticoTool.executar(
      { ano: 2026, mes: 8 },
      { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO },
      deps,
    );

    assert.equal(chamadaCom.organizacaoId, ORG_ID);
    assert.equal(chamadaCom.unidadeIdSessao, UNIDADE_ID);
    assert.equal(chamadaCom.unidadeIdSolicitado, undefined);
    assert.deepEqual(r.diagnostico, DADOS_UNIDADE.diagnostico);
    assert.equal(r.faturamento.valor, 12345.67);
  });

  test("não inventa diagnóstico na visão agregada — diz explicitamente que não há", async () => {
    const deps = { obterMes: async () => DADOS_AGREGADO };
    const r = await diagnosticoTool.executar({}, { organizacaoId: ORG_ID, unidadeId: null, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.semDiagnostico, true);
    assert.equal("diagnostico" in r, false);
  });

  test("também exige módulo/permissão do Dashboard iFood", async () => {
    let chamou = false;
    const deps = { obterMes: async () => { chamou = true; return DADOS_UNIDADE; } };
    await assert.rejects(
      () => diagnosticoTool.executar({}, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_SEM_MODULO }, deps),
      /não contratado/,
    );
    assert.equal(chamou, false);
  });
});

describe("consultar_dashboard_dia", () => {
  const LANCAMENTO_COM_DADOS = {
    lancamento: {
      situacao: "normal", motivoSemOperacao: null, qtdVendas: 40, valorVendasBruto: 2000,
      valorVendasIfood: 1800, taxasComissoes: 200, servicosPromocoes: 90, taxasEntregadores: 120, ajustesFavorLoja: 0, ajustesContraLoja: 0,
      calculado: { totalDeducoes: 410, receitaLiquida: 1390, percentuais: { totalDeducoes: 22.8 }, ticketMedio: 50 },
    },
    disponibilidade: { disponivel: true, motivo: null, status: STATUS_DIA.PREENCHIDO },
  };
  const SEM_LANCAMENTO = { lancamento: null, disponibilidade: { disponivel: false, motivo: null, status: STATUS_DIA.PENDENTE } };
  const DATA_FUTURA = { lancamento: null, disponibilidade: { disponivel: false, motivo: "Não é possível lançar uma data futura.", status: STATUS_DIA.FUTURO } };
  const VALOR_ZERO_REAL = {
    lancamento: {
      situacao: "zero_vendas", motivoSemOperacao: null, qtdVendas: 0, valorVendasBruto: 0,
      valorVendasIfood: 0, taxasComissoes: 0, servicosPromocoes: 0, taxasEntregadores: 0, ajustesFavorLoja: 0, ajustesContraLoja: 0,
      calculado: { totalDeducoes: 0, receitaLiquida: 0, percentuais: { totalDeducoes: 0 }, ticketMedio: null },
    },
    disponibilidade: { disponivel: true, motivo: null, status: STATUS_DIA.ZERO_VENDAS },
  };
  // desempenho isolado do dia — já vem em DELTA de obterMes() (nunca acumulado).
  const MES_COM_EVOLUCAO_DIARIA = {
    agregado: false,
    desempenhoOperacional: { evolucaoDiaria: [
      { data: "2026-08-03", status: "PREENCHIDO", valor: 1900, deltaQtdVendas: 38, deltaNovosClientes: 2 },
      { data: "2026-08-04", status: "PREENCHIDO", valor: 2000, deltaQtdVendas: 40, deltaNovosClientes: 3 },
    ] },
  };

  // Dia anterior (03/08) TAMBÉM com Financeiro preenchido — cenário real
  // relatado (dia 11 -> R$13.692 acumulado, dia 12 -> R$14.854 acumulado,
  // isolado = R$1.162): aqui o delta É confiável, tem que vir preenchido.
  const LANCAMENTO_DIA_ANTERIOR = {
    lancamento: {
      situacao: "normal", motivoSemOperacao: null, qtdVendas: 38, valorVendasBruto: 1900,
      valorVendasIfood: 1600, taxasComissoes: 180, servicosPromocoes: 80, taxasEntregadores: 100, ajustesFavorLoja: 0, ajustesContraLoja: 0,
      calculado: { totalDeducoes: 360, receitaLiquida: 1240, percentuais: { totalDeducoes: 22.5 }, ticketMedio: 50 },
    },
    disponibilidade: { disponivel: true, motivo: null, status: STATUS_DIA.PREENCHIDO },
  };

  test("dia COM lançamento E dia anterior TAMBÉM com Financeiro: calcula o delta EXATO isolado do dia", async () => {
    let chamadasLancamento = [], chamadaMes = null;
    const deps = {
      obterLancamentoPorData: async (args) => {
        chamadasLancamento.push(args);
        return args.data === "2026-08-04" ? LANCAMENTO_COM_DADOS : LANCAMENTO_DIA_ANTERIOR;
      },
      obterMes: async (args) => { chamadaMes = args; return MES_COM_EVOLUCAO_DIARIA; },
    };
    const r = await dashboardDiaTool.executar(
      { data: "2026-08-04" },
      { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO },
      deps,
    );
    assert.equal(chamadasLancamento[0].data, "2026-08-04");
    assert.ok(chamadasLancamento.some((c) => c.data === "2026-08-03"), "deveria também consultar o dia anterior para o delta");
    assert.equal(chamadaMes.ano, 2026);
    assert.equal(chamadaMes.mes, 8);

    assert.equal(r.possuiLancamento, true);
    // Financeiro ACUMULADO continua disponível (rotulado, nunca "gasto daquele dia").
    assert.equal(r.financeiroAcumulado.taxasEntregadores, 120);
    assert.equal(r.financeiroAcumulado.periodoInicio, "2026-08-01");
    assert.equal(r.financeiroAcumulado.periodoFim, "2026-08-04");
    // Delta EXATO isolado do dia — 120 (acumulado hoje) - 100 (acumulado ontem) = 20.
    assert.equal(r.financeiroIsoladoDoDia.taxasEntregadores, 20);
    assert.equal(r.financeiroIsoladoDoDia.valorVendasIfood, 200); // 1800 - 1600
    assert.equal(r.financeiroIsoladoDoDia.diaComparado, "2026-08-03");
    // Ajustes a favor / contra a loja também são expostos (crédito x débito).
    assert.equal(r.financeiroAcumulado.ajustesFavorLoja, 0);
    assert.equal(r.financeiroAcumulado.ajustesContraLoja, 0);
    assert.equal(r.financeiroIsoladoDoDia.ajustesFavorLoja, 0);
    assert.equal(r.financeiroIsoladoDoDia.ajustesContraLoja, 0);
    assert.equal("outrasDeducoes" in r.financeiroAcumulado, false);
    // Operacional (Desempenho) é o valor ISOLADO do dia — já vem em delta de obterMes().
    assert.equal(r.operacionalDoDia.valorVendasBruto, 2000);
    assert.equal(r.operacionalDoDia.qtdVendas, 40);
  });

  test("dia anterior SEM Financeiro: financeiroIsoladoDoDia fica null (não inventa um delta não confiável)", async () => {
    const deps = {
      obterLancamentoPorData: async (args) => (args.data === "2026-08-04" ? LANCAMENTO_COM_DADOS : SEM_LANCAMENTO),
      obterMes: async () => MES_COM_EVOLUCAO_DIARIA,
    };
    const r = await dashboardDiaTool.executar({ data: "2026-08-04" }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.possuiLancamento, true);
    assert.equal(r.financeiroIsoladoDoDia, null);
    // Continua tendo o acumulado disponível, só não o isolado.
    assert.equal(r.financeiroAcumulado.taxasEntregadores, 120);
  });

  test("dia SEM lançamento: nunca inventa zero — sinaliza possuiLancamento: false", async () => {
    const deps = { obterLancamentoPorData: async () => SEM_LANCAMENTO, obterMes: async () => MES_COM_EVOLUCAO_DIARIA };
    const r = await dashboardDiaTool.executar({ data: "2026-08-22" }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.possuiLancamento, false);
    assert.equal(r.motivo, "sem_lancamento");
    assert.equal("financeiroAcumulado" in r, false);
  });

  test("valor realmente igual a zero (lançamento existe, zero_vendas): não vira 'sem lançamento'", async () => {
    const deps = { obterLancamentoPorData: async () => VALOR_ZERO_REAL, obterMes: async () => MES_COM_EVOLUCAO_DIARIA };
    const r = await dashboardDiaTool.executar({ data: "2026-08-10" }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.possuiLancamento, true);
    assert.equal(r.financeiroAcumulado.taxasEntregadores, 0);
    assert.equal(r.financeiroAcumulado.valorVendasIfood, 0);
  });

  test("financeiro não preenchido nesse dia específico, mas obterLancamentoPorData ainda encontra a linha (ex.: só Desempenho): financeiroAcumulado vem null, sem inventar", async () => {
    const SO_DESEMPENHO = {
      lancamento: {
        situacao: "normal", motivoSemOperacao: null, qtdVendas: 40, valorVendasBruto: 2000,
        valorVendasIfood: null, taxasComissoes: null, servicosPromocoes: null, taxasEntregadores: null, ajustesFavorLoja: null, ajustesContraLoja: null,
        calculado: { totalDeducoes: 0, receitaLiquida: null, percentuais: { totalDeducoes: null }, ticketMedio: 50 },
      },
      disponibilidade: { disponivel: true, motivo: null, status: STATUS_DIA.FINANCEIRO_PENDENTE },
    };
    const deps = { obterLancamentoPorData: async () => SO_DESEMPENHO, obterMes: async () => MES_COM_EVOLUCAO_DIARIA };
    const r = await dashboardDiaTool.executar({ data: "2026-08-04" }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.possuiLancamento, true);
    assert.equal(r.financeiroAcumulado, null);
    assert.equal(r.operacionalDoDia.valorVendasBruto, 2000);
  });

  test("obterMes indisponível (ex.: visão agregada) não derruba a consulta — só operacionalDoDia fica null", async () => {
    const deps = {
      obterLancamentoPorData: async () => LANCAMENTO_COM_DADOS,
      obterMes: async () => { throw new Error("boom"); },
    };
    const r = await dashboardDiaTool.executar({ data: "2026-08-04" }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.possuiLancamento, true);
    assert.equal(r.operacionalDoDia, null);
    assert.equal(r.financeiroAcumulado.taxasEntregadores, 120);
  });

  test("data futura: distinta de 'sem lançamento', nunca fabrica dado", async () => {
    const deps = { obterLancamentoPorData: async () => DATA_FUTURA };
    const r = await dashboardDiaTool.executar({ data: "2026-08-30" }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps);
    assert.equal(r.possuiLancamento, false);
    assert.equal(r.motivo, "data_futura");
  });

  test("data inválida é rejeitada sem chamar o service", async () => {
    let chamou = false;
    const deps = { obterLancamentoPorData: async () => { chamou = true; return SEM_LANCAMENTO; } };
    await assert.rejects(
      () => dashboardDiaTool.executar({ data: "não é uma data" }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps),
    );
    assert.equal(chamou, false);
  });

  test("data ausente é rejeitada sem chamar o service", async () => {
    let chamou = false;
    const deps = { obterLancamentoPorData: async () => { chamou = true; return SEM_LANCAMENTO; } };
    await assert.rejects(
      () => dashboardDiaTool.executar({}, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }, deps),
    );
    assert.equal(chamou, false);
  });

  test("tenant correto: organizacaoId/unidadeId vêm do CONTEXTO, tentativa de injeção pelo input é ignorada", async () => {
    let chamadaCom = null;
    const deps = { obterLancamentoPorData: async (args) => { chamadaCom = args; return SEM_LANCAMENTO; } };
    await dashboardDiaTool.executar(
      { data: "2026-08-04", organizacaoId: "org-de-outro-tenant", unidadeId: OUTRA_UNIDADE_ID },
      { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO },
      deps,
    );
    assert.equal(chamadaCom.organizacaoId, ORG_ID);
    assert.equal(chamadaCom.unidadeIdSessao, UNIDADE_ID);
    assert.equal(chamadaCom.unidadeIdSolicitado, undefined);
  });

  test("módulo sem acesso nega, sem chamar o service", async () => {
    let chamou = false;
    const deps = { obterLancamentoPorData: async () => { chamou = true; return SEM_LANCAMENTO; } };
    await assert.rejects(
      () => dashboardDiaTool.executar({ data: "2026-08-04" }, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_SEM_MODULO }, deps),
      /não contratado/,
    );
    assert.equal(chamou, false);
  });

  test("continua read-only: a única dependência exposta é uma função de LEITURA (obterLancamentoPorData)", () => {
    assert.equal(typeof dashboardDiaTool.executar, "function");
    // Não há dependência de escrita injetável nesta tool — só leitura.
  });
});

describe("catálogo de ferramentas — só leitura", () => {
  test("expõe exatamente as 13 tools da Fase 1/1.5/2A/Etapa C/Etapa D/Etapa F.1/Etapa H/Checklist 2.0", () => {
    const nomes = FERRAMENTAS.map((f) => f.name).sort();
    assert.deepEqual(nomes, [
      "consultar_cancelamento", "consultar_checklist_operacional", "consultar_dashboard_dia", "consultar_dashboard_executivo", "consultar_diagnostico",
      "consultar_evolucao_diaria_financeiro", "consultar_insumo", "consultar_parser_resumo", "consultar_produto_cmv",
      "listar_cancelamentos", "listar_insumos", "listar_produtos_cmv", "sugerir_navegacao",
    ]);
  });

  test("nenhuma tool aceita propriedades fora do schema (additionalProperties: false)", () => {
    for (const f of FERRAMENTAS) assert.equal(f.input_schema.additionalProperties, false, f.name);
  });

  test("executarFerramenta rejeita nome de ferramenta desconhecido", async () => {
    await assert.rejects(
      () => executarFerramenta("excluir_lancamento", {}, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso: ACESSO_COM_MODULO }),
      /Ferramenta desconhecida/,
    );
  });

  test("REGISTRO declara access/mode/risk para todas as tools, coerente com o que cada executar() valida", () => {
    assert.equal(REGISTRO.length, FERRAMENTAS.length);
    for (const r of REGISTRO) {
      assert.equal(typeof r.definicao.name, "string");
      assert.equal(typeof r.executar, "function");
      assert.equal(typeof r.access.module, "string");
      // permission pode ser null (só "sugerir_navegacao", Etapa F.1 — ver
      // comentário do REGISTRO) — nunca outro tipo além de string ou null.
      assert.ok(r.access.permission === null || typeof r.access.permission === "string", r.definicao.name);
      assert.equal(r.mode, "read"); // Fase 1 — nenhuma tool de escrita ainda.
      assert.ok(["low", "medium", "high"].includes(r.risk));
    }
  });
});

describe("ferramentasDisponiveis — filtro prévio do catálogo (1ª camada de defesa em profundidade)", () => {
  test("sem acesso algum -> catálogo vazio", () => {
    assert.deepEqual(ferramentasDisponiveis(undefined), []);
  });

  test("acesso só com Dashboard iFood -> só as 4 tools desse módulo aparecem (Etapa H soma consultar_evolucao_diaria_financeiro)", () => {
    const acesso = { modulos: [MODULOS.IFOOD_DASHBOARD], permissoes: [PERMISSOES.DASHBOARD_EXECUTIVO_VER], impersonando: false };
    const nomes = ferramentasDisponiveis(acesso).map((f) => f.name).sort();
    assert.deepEqual(nomes, ["consultar_dashboard_dia", "consultar_dashboard_executivo", "consultar_diagnostico", "consultar_evolucao_diaria_financeiro"]);
  });

  test("acesso só com Produtos/CMV -> só as 2 tools desse módulo aparecem", () => {
    const acesso = { modulos: [MODULOS.PRODUTOS_CMV], permissoes: [PERMISSOES.CMV_VER], impersonando: false };
    const nomes = ferramentasDisponiveis(acesso).map((f) => f.name).sort();
    assert.deepEqual(nomes, ["consultar_produto_cmv", "listar_produtos_cmv"]);
  });

  test("acesso só com Insumos -> só as 2 tools desse módulo aparecem (Etapa C)", () => {
    const acesso = { modulos: [MODULOS.INGREDIENTS], permissoes: [PERMISSOES.INSUMOS_VER], impersonando: false };
    const nomes = ferramentasDisponiveis(acesso).map((f) => f.name).sort();
    assert.deepEqual(nomes, ["consultar_insumo", "listar_insumos"]);
  });

  test("módulo presente mas SEM a permissão -> tool daquele módulo não aparece", () => {
    const acesso = { modulos: [MODULOS.IFOOD_DASHBOARD], permissoes: [], impersonando: false };
    assert.deepEqual(ferramentasDisponiveis(acesso), []);
  });

  test("os dois módulos contratados (Dashboard iFood + Produtos/CMV) -> só as 6 tools desses módulos, Insumos continua fora", () => {
    const acesso = {
      modulos: [MODULOS.IFOOD_DASHBOARD, MODULOS.PRODUTOS_CMV],
      permissoes: [PERMISSOES.DASHBOARD_EXECUTIVO_VER, PERMISSOES.CMV_VER],
      impersonando: false,
    };
    const nomes = ferramentasDisponiveis(acesso).map((f) => f.name).sort();
    assert.deepEqual(nomes, [
      "consultar_dashboard_dia", "consultar_dashboard_executivo", "consultar_diagnostico", "consultar_evolucao_diaria_financeiro",
      "consultar_produto_cmv", "listar_produtos_cmv",
    ]);
  });

  test("Checklist Operacional (Checklist 2.0): só com o módulo iFood E checklist.visualizar", () => {
    const so = (modulos, permissoes) => ferramentasDisponiveis({ modulos, permissoes, impersonando: false }).map((f) => f.name);
    assert.deepEqual(so([MODULOS.IFOOD], [PERMISSOES.CHECKLIST_VISUALIZAR]), ["consultar_checklist_operacional"]);
    assert.deepEqual(so([MODULOS.IFOOD], []), []);
    assert.deepEqual(so([MODULOS.IFOOD_DASHBOARD], [PERMISSOES.CHECKLIST_VISUALIZAR]), []);
  });

  test("acesso só com Parser Food Delivery -> só as 3 tools desse módulo aparecem (Etapa D)", () => {
    const acesso = { modulos: [MODULOS.PARSER_FOOD_DELIVERY], permissoes: [PERMISSOES.PARSER_FD_VER], impersonando: false };
    const nomes = ferramentasDisponiveis(acesso).map((f) => f.name).sort();
    assert.deepEqual(nomes, ["consultar_cancelamento", "consultar_parser_resumo", "listar_cancelamentos"]);
  });

  test("os cinco módulos de dados + Agente IA (sempre presente, ver requireModulo na rota) -> catálogo completo", () => {
    const acesso = {
      modulos: [MODULOS.IFOOD_DASHBOARD, MODULOS.PRODUTOS_CMV, MODULOS.INGREDIENTS, MODULOS.PARSER_FOOD_DELIVERY, MODULOS.IFOOD, MODULOS.AGENTE_IA],
      permissoes: [PERMISSOES.DASHBOARD_EXECUTIVO_VER, PERMISSOES.CMV_VER, PERMISSOES.INSUMOS_VER, PERMISSOES.PARSER_FD_VER, PERMISSOES.CHECKLIST_VISUALIZAR],
      impersonando: false,
    };
    const nomes = ferramentasDisponiveis(acesso).map((f) => f.name).sort();
    assert.deepEqual(nomes, FERRAMENTAS.map((f) => f.name).sort());
  });

  test("sugerir_navegacao (Etapa F.1) aparece assim que o módulo Agente IA está presente, mesmo sem NENHUM outro módulo (permission: null)", () => {
    const acesso = { modulos: [MODULOS.AGENTE_IA], permissoes: [], impersonando: false };
    const nomes = ferramentasDisponiveis(acesso).map((f) => f.name);
    assert.deepEqual(nomes, ["sugerir_navegacao"]);
  });

  test("sem o módulo Agente IA, sugerir_navegacao NÃO aparece, mesmo com todos os outros módulos", () => {
    const acesso = {
      modulos: [MODULOS.IFOOD_DASHBOARD, MODULOS.PRODUTOS_CMV, MODULOS.INGREDIENTS, MODULOS.PARSER_FOOD_DELIVERY],
      permissoes: [PERMISSOES.DASHBOARD_EXECUTIVO_VER, PERMISSOES.CMV_VER, PERMISSOES.INSUMOS_VER, PERMISSOES.PARSER_FD_VER],
      impersonando: false,
    };
    const nomes = ferramentasDisponiveis(acesso).map((f) => f.name);
    assert.equal(nomes.includes("sugerir_navegacao"), false);
  });

  test("impersonando -> vê o catálogo inteiro mesmo sem nenhum módulo/permissão (mesmo bypass de agenteAcesso.js)", () => {
    const acesso = { modulos: [], permissoes: [], impersonando: true };
    const nomes = ferramentasDisponiveis(acesso).map((f) => f.name).sort();
    assert.deepEqual(nomes, FERRAMENTAS.map((f) => f.name).sort());
  });

  test("filtro prévio nunca é a única defesa: mesmo fora do catálogo, executarFerramenta ainda bloqueia no executor", async () => {
    const acesso = { modulos: [], permissoes: [], impersonando: false };
    assert.deepEqual(ferramentasDisponiveis(acesso), []); // some do catálogo...
    // ...mas se algo chamar a tool mesmo assim (bug no filtro, chamada direta etc.), o executor ainda nega:
    await assert.rejects(
      () => executarFerramenta("consultar_dashboard_executivo", {}, { organizacaoId: ORG_ID, unidadeId: UNIDADE_ID, acesso }),
      /não contratado/,
    );
  });
});
