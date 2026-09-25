// Central de Comunicação — VISÃO GERAL, AUTOMAÇÕES, DESTINATÁRIOS, HISTÓRICO e DIAGNÓSTICO. Só dados do roster; nenhum telefone completo; nada inventado.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { visaoGeral, automacoes, destinatarios, historicoGeral, diagnosticoTecnico } from "../src/modules/administrativo/administrativo.comunicacao.conversas.js";
import { criarFakeDb, linhaRoster } from "./helpers/central-fake-db.js";

const ORG_CONEXAO = "00000000-0000-4000-8000-0000000000a1";
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const C1 = uuid(101); const C2 = uuid(102); const DESCONHECIDO = uuid(999);
const O1 = uuid(11); const O2 = uuid(12); const U1 = uuid(21); const U2 = uuid(22);
const AGORA = new Date("2026-09-24T15:00:00.000Z");   // 12:00 em Brasília; o dia começa em 2026-09-24T03:00Z
const min = (n) => new Date(AGORA.getTime() - n * 60_000).toISOString();
const hora = (n) => new Date(AGORA.getTime() - n * 3_600_000).toISOString();

const ROSTER = [
  linhaRoster({ contato_id: C1, telefone_e164: "+5511999990001", perfil_nome: "Maria Souza", organizacao_id: O1, organizacao_nome: "Rede Sabor", unidade_id: U1, unidade_nome: "Centro" }),
  linhaRoster({ contato_id: C2, telefone_e164: "+5511999990002", perfil_id: "p2", perfil_nome: "João Lima", organizacao_id: O2, organizacao_nome: "Doce Vale", unidade_id: U2, unidade_nome: "Norte", papel: "unit_manager", consentimento: false, verificado: false }),
];
const saida = (o = {}) => ({
  id: uuid(Math.floor(Math.random() * 1e9)), organizacao_id: O1, unidade_id: U1, contato_id: C1, tipo: "dashboard_ifood_d1", conteudo: "Falta lançar o dashboard de ontem.", status: "DELIVERED",
  created_at: min(50), disponivel_em: min(50), enviado_em: min(50), entregue_em: min(49), lido_em: null, falhou_em: null, erro: null, metadados: {}, updated_at: min(49), direcao: "saida", ...o,
});
const entrada = (o = {}) => ({ id: uuid(Math.floor(Math.random() * 1e9)), organizacao_id: ORG_CONEXAO, contato_id: C1, provider_message_id: "P" + Math.random(), origem_tipo: "LIVE", tipo_conteudo: "texto", texto: "Ok, vou lançar agora", recebido_em: min(30), created_at: min(30), ...o });

const orgs = (extra = {}) => [
  { organizacaoId: O1, nome: "Rede Sabor", habilitada: true, pausada: false, pendenciasAtuais: 2, contato: { consentimento: true, verificado: true }, proximoEnvioEm: hora(-2), ultimoEnvioEm: hora(3), proximaAcao: "Monitorando pendências", ...extra },
  { organizacaoId: O2, nome: "Doce Vale", habilitada: false, pausada: false, pendenciasAtuais: 1, contato: { consentimento: false, verificado: false }, proximoEnvioEm: null, ultimoEnvioEm: null, proximaAcao: "Confirmar consentimento e verificação" },
];

function montar({ saidas = [], entradas = [], modo = "NORMAL", gateway = "conectado", roster = ROSTER, orgsLista = orgs(), config } = {}) {
  const db = criarFakeDb({ comunicacao_roster_autorizado: roster, comunicacao_mensagens: saidas, comunicacao_inbox_mensagens: entradas, comunicacao_inbox_leituras: [], contatos_whatsapp: [] });
  const deps = {
    supabase: db, env: {}, agora: () => AGORA, organizacaoConexaoId: ORG_CONEXAO, whatsAppService: null, estadoGateway: { estado: gateway },
    lerPendencias: async () => ({ unidades: [] }), auditar: async () => {}, identidadeConfirmada: true,
    resumoIdentidade: async () => ({ status: "CONFIRMADA", confirmada: true, ambiente: "TESTE", nomeOperacional: null }),
    resumo: async () => ({ gateway: { estado: gateway }, worker: { estado: "habilitado" }, comunicacao: { modo }, piloto: { ativo: false, quantidadeDestinos: 0 }, backend: { online: true, versao: "abc1234" }, entrega: { estado: "operacional" } }),
    organizacoes: async () => orgsLista, modoAtual: async () => modo,
    configuracaoOperacional: async () => config ?? { janelaComercial: { seg_sex: { inicio: "08:00", fim: "18:00" }, sab: null, dom: null } },
  };
  return { db, deps };
}

describe("visão geral", () => {
  test("enviadas hoje usa evento enviado_em, não criação nem agendamento", async () => {
    const { deps } = montar({ saidas: [
      saida({ status: "SENT", created_at: min(20), enviado_em: min(10) }),
      saida({ status: "SENT", created_at: hora(30), enviado_em: min(15) }),
      saida({ status: "SCHEDULED", enviado_em: null }),
      saida({ status: "FAILED", enviado_em: null }),
      saida({ status: "DELIVERY_UNKNOWN", enviado_em: null }),
      saida({ status: "SENT", created_at: hora(30), enviado_em: hora(30) }),
    ] });
    assert.equal((await visaoGeral(deps)).cards.mensagensHoje.enviadas, 2);
  });
  test("contrato real dos services renderiza o frontend aprovado com dados vazios e opcionais ausentes", async () => {
    const { htmlVisaoGeral } = await import("../../frontend/src/central/centralVisao.js");
    const ui = await import("../../frontend/src/central/centralUi.js");
    const { deps } = montar({ roster: [], orgsLista: [] });
    const visao = await visaoGeral(deps);
    assert.equal(visao.atividade, undefined, "atividade é opcional no contrato atual");
    const paginas = [
      htmlVisaoGeral(visao, { agora: AGORA }),
      ui.htmlAutomacoes(await automacoes(deps), { agora: AGORA }),
      ui.htmlDestinatarios(await destinatarios({}, deps)),
      ui.htmlHistorico(await historicoGeral({}, deps), {}, {}),
      ui.htmlDiagnostico(await diagnosticoTecnico(deps)),
    ];
    for (const html of paginas) {
      assert.ok(html.length > 0);
      assert.doesNotMatch(html, /\b(?:undefined|NaN)\b/);
    }
  });
  test("cards: WhatsApp, automação, não lidas, mensagens hoje, entregues % e falhas — só do roster", async () => {
    const { deps } = montar({
      entradas: [entrada({ recebido_em: min(20) }), entrada({ contato_id: DESCONHECIDO }), entrada({ recebido_em: hora(20) })],
      saidas: [
        saida({ status: "READ", lido_em: min(10), created_at: min(100), enviado_em: min(100) }), saida({ status: "DELIVERED", created_at: min(90), enviado_em: min(90) }),
        saida({ status: "SENT", entregue_em: null, created_at: min(80), enviado_em: min(80) }), saida({ status: "SENT", entregue_em: null, created_at: min(70), enviado_em: min(70) }),
        saida({ status: "FAILED", falhou_em: min(60), created_at: min(60), enviado_em: null }), saida({ contato_id: DESCONHECIDO, status: "FAILED", created_at: min(55) }),
        saida({ status: "DELIVERED", created_at: hora(30), enviado_em: hora(30) }),   // ontem: fora de "hoje"
      ],
    });
    const { cards } = await visaoGeral(deps);
    assert.deepEqual([cards.whatsapp.estado, cards.whatsapp.rotulo, cards.automacao.ativa, cards.automacao.rotulo], ["conectado", "Conectado", true, "Ativa"]);
    assert.equal(cards.conversasNaoLidas, 1);
    assert.deepEqual([cards.mensagensHoje.recebidas, cards.mensagensHoje.enviadas, cards.mensagensHoje.total], [1, 4, 6], "enviadas exclui FAILED; total preserva todos os registros do dia");
    assert.equal(cards.entreguesHojePct, 50, "2 entregues (DELIVERED+READ) de 4 enviadas (SENT+DELIVERED+READ)");
    assert.equal(cards.falhasHoje, 1, "a falha do DESCONHECIDO não conta");
  });

  test("entregues % é null (não 0%) quando nada foi enviado hoje", async () => {
    const { deps } = montar({});
    assert.equal((await visaoGeral(deps)).cards.entreguesHojePct, null);
  });

  test("alertas: gateway fora, falhas, entrega sem confirmação, sem resposta > 2h, empresa sem contato apto, automação desativada", async () => {
    const { deps } = montar({
      gateway: "desconectado", modo: "DISABLED",
      entradas: [entrada({ recebido_em: hora(3) })],
      saidas: [saida({ status: "FAILED", created_at: min(60) }), saida({ status: "DELIVERY_UNKNOWN", created_at: min(50) })],
    });
    const ids = (await visaoGeral(deps)).alertas.map((a) => a.id);
    assert.deepEqual(ids, ["gateway", "falhas", "incertas", "sem_resposta", "sem_contato_apto", "automacao_off"]);
    const gw = (await visaoGeral(deps)).alertas[0];
    assert.equal(gw.severidade, "critico");
  });

  test("tudo em ordem ⇒ sem alertas", async () => {
    const { deps } = montar({ orgsLista: [orgs()[0]] });
    assert.deepEqual((await visaoGeral(deps)).alertas, []);
  });

  test("conversas recentes: no máximo 5, mais recentes primeiro; próximos envios com o nome da empresa", async () => {
    const { deps } = montar({
      entradas: [entrada({ recebido_em: min(5) })],
      saidas: [saida({ contato_id: C2, organizacao_id: O2, unidade_id: U2, created_at: min(40), enviado_em: min(40) }),
        saida({ status: "SCHEDULED", created_at: min(1), disponivel_em: new Date(AGORA.getTime() + 3_600_000).toISOString(), enviado_em: null, entregue_em: null, contato_id: C1 })],
    });
    const r = await visaoGeral(deps);
    assert.ok(r.conversasRecentes.length <= 5);
    assert.equal(r.conversasRecentes[0].nome, "Maria Souza");
    assert.equal(r.proximosEnvios.length, 1);
    assert.equal(r.proximosEnvios[0].empresa, "Rede Sabor");
  });

  test("nenhum telefone completo em lugar nenhum", async () => {
    const { deps } = montar({ entradas: [entrada()], saidas: [saida()] });
    const s = JSON.stringify(await visaoGeral(deps));
    assert.ok(!s.includes("5511999990001") && !s.includes("5511999990002"));
  });
});

describe("automações", () => {
  test("a linha do tempo usa os valores REAIS (janela da configuração, reforço 20:00–22:00, limite 22:30)", async () => {
    const { deps } = montar({});
    const a = await automacoes(deps);
    const t = Object.fromEntries(a.dashboardIfoodD1.linhaDoTempo.map((e) => [e.id, e.horario]));
    assert.deepEqual([t.janela, t.reforco, t.limite], ["08:00", "20:00", "22:30"]);
    assert.equal(a.dashboardIfoodD1.horarioLimite, "22:30");
    assert.match(a.dashboardIfoodD1.quandoReforca, /20:00 e 22:00/);
    assert.match(a.dashboardIfoodD1.quandoEnvia, /08:00–18:00/);
    assert.deepEqual(a.dashboardIfoodD1.linhaDoTempo.map((e) => e.id), ["janela", "deteccao", "agendada", "enviada", "reforco", "limite"]);
  });

  test("só as empresas HABILITADAS aparecem; modo global refletido; sem janela configurada não inventa horário", async () => {
    const { deps } = montar({ modo: "DISABLED", config: { janelaComercial: null } });
    const a = await automacoes(deps);
    assert.deepEqual([a.ativa, a.rotuloModo, a.empresasHabilitadas.total, a.empresasHabilitadas.itens.map((o) => o.nome)], [false, "Desativada", 1, ["Rede Sabor"]]);
    assert.equal(a.dashboardIfoodD1.linhaDoTempo[0].horario, null);
  });
});

describe("destinatários", () => {
  test("uma linha por responsável, com consentimento/verificação/opt-out, comunicação da empresa e número MASCARADO", async () => {
    const { deps } = montar({ entradas: [entrada()] });
    const r = await destinatarios({}, deps);
    assert.equal(r.total, 2);
    const maria = r.itens.find((d) => d.nome === "Maria Souza"); const joao = r.itens.find((d) => d.nome === "João Lima");
    assert.deepEqual([maria.consentimento, maria.verificado, maria.optOut, maria.comunicacaoHabilitada, maria.whatsappConfirmado, maria.telefoneMascarado], [true, true, false, true, true, "********01"]);
    assert.deepEqual([joao.consentimento, joao.verificado, joao.comunicacaoHabilitada, joao.whatsappConfirmado, joao.cargo], [false, false, false, false, "Gestor de unidade"]);
    assert.ok(!JSON.stringify(r).includes("99999000"));
  });

  test("busca por nome/empresa/unidade; nunca por telefone", async () => {
    const { deps } = montar({});
    assert.deepEqual((await destinatarios({ busca: "doce" }, deps)).itens.map((d) => d.nome), ["João Lima"]);
    assert.deepEqual((await destinatarios({ busca: "999990002" }, deps)).itens, []);
  });
});

describe("histórico geral", () => {
  const cenario = () => montar({
    entradas: [entrada({ texto: "Recebido do responsável", recebido_em: hora(2) })],
    saidas: [
      saida({ conteudo: "Aviso automático D-1", status: "DELIVERED", created_at: hora(5), enviado_em: hora(5) }),
      saida({ conteudo: "Resposta do operador", tipo: "mensagem_manual", metadados: { proposito: "manual", ator_nome: "Camila" }, status: "SENT", entregue_em: null, created_at: hora(1), enviado_em: hora(1) }),
      saida({ contato_id: C2, organizacao_id: O2, unidade_id: U2, conteudo: "Lembrete Doce Vale", status: "FAILED", falhou_em: hora(3), created_at: hora(3), enviado_em: null, erro: "sem WhatsApp" }),
      saida({ contato_id: DESCONHECIDO, conteudo: "NUNCA DEVE APARECER", created_at: hora(4) }),
    ],
  });

  test("junta entradas e saídas, mais recente primeiro, sem contato fora do roster", async () => {
    const { deps } = cenario();
    const r = await historicoGeral({}, deps);
    assert.equal(r.total, 4);
    assert.deepEqual(r.itens.map((i) => i.previa), ["Resposta do operador", "Recebido do responsável", "Lembrete Doce Vale", "Aviso automático D-1"]);
    assert.ok(!JSON.stringify(r).includes("NUNCA DEVE APARECER"));
  });

  test("colunas: origem, status, entrega, leitura, operador, empresa e unidade", async () => {
    const { deps } = cenario();
    const it = (await historicoGeral({}, deps)).itens;
    const manual = it.find((i) => i.previa === "Resposta do operador");
    assert.deepEqual([manual.origem, manual.status, manual.entregueEm, manual.operador, manual.empresas, manual.unidades, manual.responsavel], ["manual_painel", "SENT", null, "Camila", ["Rede Sabor"], ["Centro"], "Maria Souza"]);
    const recebida = it.find((i) => i.direcao === "entrada");
    assert.deepEqual([recebida.origem, recebida.status], ["contato", null]);
    assert.equal(it.find((i) => i.previa === "Lembrete Doce Vale").erro, "sem WhatsApp");
  });

  test("filtros: origem, status, empresa, unidade, período, operador e busca por nome", async () => {
    const { deps } = cenario();
    assert.deepEqual((await historicoGeral({ origem: "contato" }, deps)).itens.map((i) => i.direcao), ["entrada"]);
    assert.deepEqual((await historicoGeral({ origem: "manual_painel" }, deps)).itens.length, 1);
    assert.deepEqual((await historicoGeral({ status: "FAILED" }, deps)).itens.map((i) => i.previa), ["Lembrete Doce Vale"]);
    assert.equal((await historicoGeral({ organizacaoId: O2 }, deps)).total, 1);
    assert.equal((await historicoGeral({ unidadeId: U1 }, deps)).total, 3);
    assert.equal((await historicoGeral({ desde: hora(2.5) }, deps)).total, 2);
    assert.equal((await historicoGeral({ ate: hora(4.5) }, deps)).total, 1);
    assert.equal((await historicoGeral({ operador: "camila" }, deps)).total, 1);
    assert.equal((await historicoGeral({ busca: "doce" }, deps)).total, 1);
    assert.equal((await historicoGeral({ busca: "5511999990001" }, deps)).total, 0, "nunca por telefone");
  });

  test("paginação e validação (status/origem/data/uuid inválidos ⇒ 400)", async () => {
    const { deps } = cenario();
    const p = await historicoGeral({ pagina: 2, porPagina: 3 }, deps);
    assert.deepEqual([p.itens.length, p.total, p.pagina, p.porPagina], [1, 4, 2, 3]);
    for (const q of [{ status: "X" }, { origem: "y" }, { desde: "lixo" }, { ate: "lixo" }, { organizacaoId: "nao-uuid" }, { unidadeId: "nao-uuid" }]) {
      await assert.rejects(() => historicoGeral(q, deps), (e) => e.statusCode === 400, JSON.stringify(q));
    }
  });

  test("prévia de uma linha (<= 120 caracteres) e mídia recebida vira um marcador", async () => {
    const { deps } = montar({ entradas: [entrada({ tipo_conteudo: "midia", texto: null })], saidas: [saida({ conteudo: "z".repeat(500) })] });
    const it = (await historicoGeral({}, deps)).itens;
    assert.ok(it.every((i) => Array.from(i.previa).length <= 120));
    assert.ok(it.some((i) => i.previa === "Mídia recebida"));
  });
});

describe("diagnóstico técnico", () => {
  test("estado da infraestrutura + métrica agregada do inbox; nunca segredo, HMAC, token nem telefone", async () => {
    const { deps } = montar({});
    const d = await diagnosticoTecnico(deps);
    assert.equal(d.gateway.estado, "conectado");
    assert.ok(d.inbox && typeof d.inbox.retencaoDias === "number" && d.inbox.ignorados && typeof d.inbox.aceitos === "number");
    assert.ok(!/secret|hmac|token|authstate|senha|password/i.test(JSON.stringify(d).replace(/"estado"/g, "")), "sem termos sensíveis");
  });
});
