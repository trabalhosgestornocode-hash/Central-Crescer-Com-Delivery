// D-15 (fuso por unidade com data de corte) e Central × fechamento diário (simulação).
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

const fuso = await import("../src/modules/checklist-operacional/checklistOperacional.fuso.js");
const svc = await import("../src/modules/checklist-operacional/checklistOperacional.operacional.service.js");
const dash = await import("../src/modules/checklist-operacional/checklistOperacional.service.js");
const ag = await import("../src/modules/checklist-operacional/checklistOperacional.agendador.js");
const { janelaDaCompetencia } = await import("../src/modules/checklist-operacional/checklistOperacional.fechamento.js");
const { simularNotificacaoFechamento } = await import("../src/modules/notificacoes/notificacoes.fechamento.js");
const { validarHorario } = await import("../src/modules/unidade/unidade.service.js");
const { bancoSintetico, repoFake, opFake, TENANT_A1 } = await import("./helpers/operacional-sintetico.js");

const SP = "America/Sao_Paulo"; const PV = "America/Porto_Velho";
const AGORA = () => new Date("2026-10-28T12:00:00.000Z");
const ambiente = ({ tz = null, notificacoes = undefined } = {}) => {
  const b = bancoSintetico();
  const repo = { ...repoFake(b.db), obterFusoDaUnidade: async () => tz };
  return { ...b, deps: { repo, op: opFake(b.db), ia: {}, ...(notificacoes ? { notificacoes } : {}) } };
};
afterEach(() => { delete process.env.OPERACIONAL_FUSO_UNIDADE_CORTE; });

describe("regra única de fuso (D-15)", () => {
  test("corte desligado por padrão: sempre o fuso da plataforma (comportamento anterior)", () => {
    assert.equal(fuso.lerCorteFuso({}), null);
    assert.deepEqual(fuso.resolverFuso({ fusoUnidade: PV, data: "2026-12-01" }), { fuso: SP, origem: "padrao_plataforma" });
  });
  test("com corte: data ≥ corte e unidade com fuso → fuso da unidade; antes do corte → plataforma; fuso inválido → plataforma", () => {
    const c = "2026-11-01";
    assert.deepEqual(fuso.resolverFuso({ fusoUnidade: PV, data: "2026-11-01", corte: c }), { fuso: PV, origem: "unidade" });
    assert.deepEqual(fuso.resolverFuso({ fusoUnidade: PV, data: "2026-10-31", corte: c }).origem, "padrao_plataforma");
    assert.deepEqual(fuso.resolverFuso({ fusoUnidade: "Lua/Base", data: "2026-11-02", corte: c }).origem, "padrao_plataforma");
    assert.deepEqual(fuso.resolverFuso({ fusoUnidade: "-04:00", data: "2026-11-02", corte: c }).origem, "padrao_plataforma");
    assert.equal(fuso.lerCorteFuso({ OPERACIONAL_FUSO_UNIDADE_CORTE: "2026-13-40" }), null);
  });
  test("virada de dia: 03:30Z é dia 03 em São Paulo e ainda dia 02 em Porto Velho", () => {
    const t = Date.parse("2026-11-03T03:30:00Z");
    assert.equal(fuso.hojeDaUnidade({ agoraMs: t, fusoUnidade: null, corte: "2026-11-01" }).hoje, "2026-11-03");
    assert.equal(fuso.hojeDaUnidade({ agoraMs: t, fusoUnidade: PV, corte: "2026-11-01" }).hoje, "2026-11-02");
    assert.equal(fuso.hojeDaUnidade({ agoraMs: t, fusoUnidade: PV, corte: null }).hoje, "2026-11-03", "sem corte, igual ao anterior");
  });
  test("Dashboard 'C a C' e fechamento de C decidem SEMPRE o mesmo fuso e a mesma janela (em volta do corte)", () => {
    const corte = "2026-11-01";
    for (const C of ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]) {
      const p = fuso.resolverPeriodoDaUnidade({ filtro: { periodo: "personalizado", inicio: C, fim: C }, agoraMs: Date.parse("2026-11-05T12:00:00Z"), fusoUnidade: PV, corte });
      const f = fuso.resolverFuso({ fusoUnidade: PV, data: C, corte });
      assert.equal(p.fuso, f.fuso, C);
      assert.equal(p.periodo.atual.inicioMs, janelaDaCompetencia(C, f.fuso).inicioMs, C);
      assert.equal(p.periodo.atual.fimMs, janelaDaCompetencia(C, f.fuso).fimMs, C);
    }
  });
  test("Porto Velho: a competência começa 04:00Z (1 h depois de São Paulo)", () => {
    assert.equal(new Date(janelaDaCompetencia("2026-11-02", PV).inicioMs).toISOString(), "2026-11-02T04:00:00.000Z");
    assert.equal(new Date(janelaDaCompetencia("2026-11-02", SP).inicioMs).toISOString(), "2026-11-02T03:00:00.000Z");
  });
  test("horário de funcionamento: valida dias, HH:MM e até 3 faixas", () => {
    assert.deepEqual(validarHorario({ seg: [{ inicio: "10:00", fim: "23:30" }], dom: [] }), { seg: [{ inicio: "10:00", fim: "23:30" }], dom: [] });
    assert.throws(() => validarHorario({ feriado: [] }), /Dia inválido/);
    assert.throws(() => validarHorario({ seg: [{ inicio: "25:00", fim: "10:00" }] }), /HH:MM/);
    assert.throws(() => validarHorario({ seg: [1, 2, 3, 4].map(() => ({ inicio: "10:00", fim: "11:00" })) }), /0 a 3/);
  });
});

describe("fechamento e Dashboard com o fuso da unidade", () => {
  test("sem corte: fechamento idêntico ao anterior (fuso da plataforma) mesmo com fuso cadastrado na unidade", async () => {
    const a = ambiente({ tz: null }); const b = ambiente({ tz: PV });
    const ra = await svc.gerarFechamento({ ...TENANT_A1, competencia: a.competencia, agora: AGORA, deps: a.deps });
    const rb = await svc.gerarFechamento({ ...TENANT_A1, competencia: b.competencia, agora: AGORA, deps: b.deps });
    assert.deepEqual([rb.fechamento.fuso, rb.fechamento.fuso_origem], [SP, "padrao_plataforma"]);
    assert.equal(rb.fechamento.hash_conteudo, ra.fechamento.hash_conteudo);
  });
  test("com corte ≤ competência: fechamento no fuso da unidade, com a origem gravada; Dashboard 'C a C' com os MESMOS números", async () => {
    process.env.OPERACIONAL_FUSO_UNIDADE_CORTE = "2026-10-01";
    const a = ambiente({ tz: PV });
    const r = await svc.gerarFechamento({ ...TENANT_A1, competencia: a.competencia, agora: AGORA, deps: a.deps });
    assert.deepEqual([r.fechamento.fuso, r.fechamento.fuso_origem], [PV, "unidade"]);
    const d = await dash.obterDashboard({ ...TENANT_A1, filtro: { periodo: "personalizado", inicio: a.competencia, fim: a.competencia }, agora: AGORA, deps: { repo: a.deps.repo } });
    assert.equal(d.periodo.fuso, PV);
    assert.equal(d.periodo.fusoOrigem, "unidade");
    // mesmos números (mesma régua do teste "mesmos números do Dashboard" da homologação 2.0), agora no fuso da unidade
    assert.equal(d.resumo.pedidos, r.fechamento.indicadores.pedidos.recebidos);
    assert.equal(d.resumo.pedidosAtrasados, r.fechamento.indicadores.atrasos.pedidosAtrasados);
    for (const e of ["preparo", "entrega", "vida"]) {
      assert.equal(d.resumo.porEtapa[e].media, r.fechamento.indicadores[e].media, e);
      assert.equal(d.resumo.porEtapa[e].amostras, r.fechamento.indicadores[e].amostras, e);
    }
    // e o fuso realmente muda o recorte: em SP o mesmo dia tem outra janela
    const sp = await dash.obterDashboard({ organizacaoId: TENANT_A1.organizacaoId, unidadeId: TENANT_A1.unidadeId, filtro: { periodo: "personalizado", inicio: a.competencia, fim: a.competencia }, agora: AGORA, deps: { repo: { ...a.deps.repo, obterFusoDaUnidade: async () => null } } });
    assert.equal(sp.periodo.fuso, SP);
  });
  test("histórico preservado: competência anterior ao corte continua no fuso da plataforma", async () => {
    process.env.OPERACIONAL_FUSO_UNIDADE_CORTE = "2026-12-01";
    const a = ambiente({ tz: PV });
    const r = await svc.gerarFechamento({ ...TENANT_A1, competencia: a.competencia, agora: AGORA, deps: a.deps });
    assert.equal(r.fechamento.fuso_origem, "padrao_plataforma");
  });
  test("lista de pedidos e Ficha 360° exibem no fuso da regra", async () => {
    process.env.OPERACIONAL_FUSO_UNIDADE_CORTE = "2026-10-01";
    const a = ambiente({ tz: PV });
    const l = await svc.listarPedidos({ ...TENANT_A1, filtro: { periodo: "ontem" }, agora: AGORA, deps: a.deps });
    assert.deepEqual([l.periodo.fuso, l.periodo.fusoOrigem], [PV, "unidade"]);
    const f = await svc.obterFicha({ ...TENANT_A1, chave: l.itens[0].chave, agora: AGORA, deps: a.deps });
    assert.equal(f.ficha.fuso, PV);
  });
  test("agendador: 'ontem' de CADA unidade no fuso dela (03:30Z: SP=02/11, PV=01/11)", async () => {
    process.env.OPERACIONAL_FUSO_UNIDADE_CORTE = "2026-10-01";
    const chamadas = [];
    const deps = { repo: { obterFusoDaUnidade: async ({ unidadeId }) => (unidadeId === "u-pv" ? PV : null) } };
    await ag.executarCiclo({ unidades: [{ organizacaoId: "o", unidadeId: "u-sp" }, { organizacaoId: "o", unidadeId: "u-pv" }], agora: () => new Date("2026-11-03T03:30:00Z"),
      gerar: async (p) => { chamadas.push([p.unidadeId, p.competencia]); return { resultado: "SEM_MUDANCA" }; }, deps });
    assert.deepEqual(chamadas, [["u-sp", "2026-11-02"], ["u-pv", "2026-11-01"]]);
  });
});

describe("Central × fechamento (SIMULAÇÃO)", () => {
  const destinatarios = (extra = {}) => ({
    listarDestinatarios: async () => ({ destinatarios: [{ id: "ce-ativo", ativo: true }, { id: "ce-legado", ativo: true }, { id: "ce-suspenso", ativo: true }, { id: "ce-revogado", ativo: true }],
      escopos: [
        { contato_empresa_id: "ce-ativo", unidade_escopo_id: TENANT_A1.unidadeId, categoria: "fechamento_operacional_diario", origem_autorizacao: "CONVITE_OTP", habilitado: true, suspenso_em: null, notificar_correcao: false },
        { contato_empresa_id: "ce-legado", unidade_escopo_id: TENANT_A1.unidadeId, categoria: "pendencia_d1", origem_autorizacao: "LEGACY_ACTIVE", habilitado: true, suspenso_em: null },
        { contato_empresa_id: "ce-suspenso", unidade_escopo_id: TENANT_A1.unidadeId, categoria: "fechamento_operacional_diario", origem_autorizacao: "CONVITE_OTP", habilitado: true, suspenso_em: "2026-10-27", notificar_correcao: true },
        { contato_empresa_id: "ce-revogado", unidade_escopo_id: TENANT_A1.unidadeId, categoria: "fechamento_operacional_diario", origem_autorizacao: "CONVITE_OTP", habilitado: true, suspenso_em: null, notificar_correcao: true },
      ], categoriasLegadas: [], contatos: [] }),
    listarConsentimentos: async () => [
      { contato_empresa_id: "ce-ativo", categoria: "fechamento_operacional_diario", acao: "CONCEDIDO" },
      { contato_empresa_id: "ce-suspenso", categoria: "fechamento_operacional_diario", acao: "CONCEDIDO" },
      { contato_empresa_id: "ce-revogado", categoria: "fechamento_operacional_diario", acao: "REVOGADO" },
      { contato_empresa_id: "ce-revogado", categoria: "fechamento_operacional_diario", acao: "CONCEDIDO" },
    ],
    cotaCategoria: async () => ({ disponivel: true, motivo: null }), ...extra,
  });
  test("fechamento CONSOLIDADO gera o aviso SIMULADO só ao destinatário ATIVO (nunca legado, suspenso ou revogado), com o texto da prévia", async () => {
    const a = ambiente({ notificacoes: destinatarios() });
    const r = await svc.gerarFechamento({ ...TENANT_A1, competencia: a.competencia, agora: AGORA, deps: a.deps });
    assert.equal(r.fechamento.status, "CONSOLIDADO");
    const sims = a.db.simulacoes.filter((s) => s.validacao?.origem === "central_notificacoes");
    assert.deepEqual(sims.map((s) => [s.validacao.destinatario, s.status, s.transporte]), [["ce-ativo", "SIMULATED", "noop"]]);
    assert.equal(sims[0].chave_idempotencia, `wa:fech:${r.fechamento.id}:ce-ativo:inicial`);
    const previa = await svc.previaWhatsapp({ ...TENANT_A1, id: r.fechamento.id, deps: a.deps });
    assert.equal(sims[0].mensagem, previa.mensagem, "mesmo texto da prévia (mesmos números da tela/PDF/Excel)");
  });
  test("gerar de novo sem mudança: nenhuma notificação nova (mesma versão nunca vai duas vezes)", async () => {
    const a = ambiente({ notificacoes: destinatarios() });
    await svc.gerarFechamento({ ...TENANT_A1, competencia: a.competencia, agora: AGORA, deps: a.deps });
    const r2 = await svc.gerarFechamento({ ...TENANT_A1, competencia: a.competencia, agora: AGORA, deps: a.deps });
    assert.equal(r2.resultado, "SEM_MUDANCA");
    assert.equal(a.db.simulacoes.filter((s) => s.validacao?.origem === "central_notificacoes").length, 1);
  });
  test("REVISADO: só correção a quem pediu; PRELIMINAR/INCOMPLETO: nada; cota esgotada = BLOCKED (sem consumir cota real)", async () => {
    const registradas = []; const op = { registrarSimulacao: async (l) => { registradas.push(l); return { duplicada: false }; } };
    const repo = destinatarios();
    const corr = await simularNotificacaoFechamento({ organizacaoId: TENANT_A1.organizacaoId, unidadeId: TENANT_A1.unidadeId, fechamento: { id: "f2", versao: 2, status: "REVISADO" }, mensagem: "x", inicioDiaIso: "2026-10-28T03:00:00Z", deps: { repo, op } });
    assert.equal(corr.simuladas, 0, "o ativo não pediu correção; o suspenso pediu mas está suspenso");
    for (const st of ["PRELIMINAR", "INCOMPLETO"]) assert.equal((await simularNotificacaoFechamento({ organizacaoId: "o", unidadeId: TENANT_A1.unidadeId, fechamento: { id: "f", versao: 1, status: st }, mensagem: "x", inicioDiaIso: "x", deps: { repo, op } })).motivo, "STATUS_SEM_AVISO");
    const semCota = destinatarios({ cotaCategoria: async () => ({ disponivel: false, motivo: "COTA_DESTINATARIO" }) });
    await simularNotificacaoFechamento({ organizacaoId: TENANT_A1.organizacaoId, unidadeId: TENANT_A1.unidadeId, fechamento: { id: "f3", versao: 1, status: "CONSOLIDADO" }, mensagem: "x", inicioDiaIso: "x", deps: { repo: semCota, op } });
    assert.deepEqual([registradas.at(-1).status, registradas.at(-1).erro], ["BLOCKED", "COTA_DESTINATARIO"]);
  });
  test("testes antigos (deps falsos sem Central) não disparam a Central nem a rede", async () => {
    const a = ambiente();
    const r = await svc.gerarFechamento({ ...TENANT_A1, competencia: a.competencia, agora: AGORA, deps: a.deps });
    assert.equal(r.notificacoes, null);
  });
});
