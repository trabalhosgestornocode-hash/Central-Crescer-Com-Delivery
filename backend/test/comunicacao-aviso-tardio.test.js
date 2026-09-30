// PRIMEIRO AVISO TARDIO D-1 (H.4-B.2) — testes SEM banco: template, scheduler `agendarAvisosTardiosD1`, a decisão do
// scheduler NORMAL de NÃO agendar para amanhã um D-1 que vence hoje, e `ehAvisoTardio`.
// O comportamento REAL do banco (RPC 094, trigger, concorrência, JIT, rate-limit) está em
// comunicacao-aviso-tardio-integracao.test.js (banco de TESTE; PULA sem credencial).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ehAvisoTardio, chaveIdempotenciaInicial, ORIGEM } from "../src/modules/comunicacao/comunicacao.reforco.js";
import { formatarMensagemAvisoTardioD1, formatarMensagemPendencia, formatarMensagemReforcoDia } from "../src/modules/comunicacao/comunicacao.template.js";
import { agendarAvisosTardiosD1, agendarEnviosPendentes } from "../src/modules/comunicacao/comunicacao.alertas.service.js";

const TZ = "America/Fortaleza"; // UTC-3, sem DST
const LOCAL = (dia, hhmm) => new Date(Date.UTC(2026, 8, dia, Number(hhmm.slice(0, 2)) + 3, Number(hhmm.slice(3))));
const QUA = (hhmm) => LOCAL(16, hhmm);   // quarta 16/09/2026 (D-1 = 15/09)
const SAB = (hhmm) => LOCAL(19, hhmm);   // sábado 19/09 (D-1 = 18/09)
const DOM = (hhmm) => LOCAL(20, hhmm);   // domingo 20/09

describe("template do primeiro aviso tardio", () => {
  test("texto aprovado, byte a byte", () => {
    assert.equal(
      formatarMensagemAvisoTardioD1({ unidadeNome: "Subway Saci — Matriz", pendenciaMaisAntiga: "2026-09-22" }),
      "Olá! Atenção: o lançamento da unidade Subway Saci — Matriz referente ao dia 22/09/2026 ainda consta pendente no Crescer com Delivery. É preciso regularizá-lo hoje para evitar a perda da possibilidade de preenchimento desse período. Caso já tenha realizado o preenchimento, desconsidere esta mensagem. — Crescer com Delivery",
    );
  });
  test("não diz 'último lembrete' (nenhuma mensagem anterior), 'última chance', 'quando possível' nem cita o Agente Crescer", () => {
    const t = formatarMensagemAvisoTardioD1({ unidadeNome: "Loja X", pendenciaMaisAntiga: "2026-09-15" });
    assert.doesNotMatch(t, /último lembrete|última chance|quando possível|agente crescer/i);
    assert.match(t, /desconsidere esta mensagem/);
  });
  test("nunca inventa data ausente", () => {
    assert.doesNotMatch(formatarMensagemAvisoTardioD1({ unidadeNome: "Loja X" }), /referente ao dia/);
  });
  test("os outros dois textos permanecem intactos", () => {
    assert.match(formatarMensagemPendencia({ unidadeNome: "X", pendenciaMaisAntiga: "2026-09-15" }), /^Olá! Identificamos que a unidade X possui/);
    assert.match(formatarMensagemReforcoDia({ unidadeNome: "X", pendenciaMaisAntiga: "2026-09-15" }), /^Último lembrete de hoje/);
  });
});

describe("ehAvisoTardio — inicial + origem exata", () => {
  test("só proposito inicial (ou ausente) COM origem=prazo_final_d1", () => {
    assert.equal(ehAvisoTardio({ metadados: { proposito: "inicial", origem: "prazo_final_d1" } }), true);
    assert.equal(ehAvisoTardio({ metadados: { origem: "prazo_final_d1" } }), true);
    assert.equal(ehAvisoTardio({ metadados: {} }), false);
    assert.equal(ehAvisoTardio({}), false);
    assert.equal(ehAvisoTardio({ metadados: { origem: "PRAZO_FINAL_D1" } }), false);
    assert.equal(ORIGEM.PRAZO_FINAL_D1, "prazo_final_d1");
  });
  test("NUNCA é reforço: proposito=reforco vence, mesmo com a origem presente", () => {
    assert.equal(ehAvisoTardio({ metadados: { proposito: "reforco", origem: "prazo_final_d1" } }), false);
  });
});

// ---------------------------------------------------------------------------
const DESTINATARIOS_PADRAO = [{ contato_empresa_id: "ce1", contato_id: "c1", perfil_id: null, nome: "João", telefone: "+5562991234567", elegivel: true, motivo: null }];
/** chamadas à RPC de AGENDAMENTO por destinatário (a resolução de destinatários também passa pelo fake e não conta aqui) */
const agend = (db) => db.chamadas.filter((c) => c.nome === "comunicacao_agendar_mensagens_alerta");
function fakeDb({ alertas = [], mensagens = [], configs = {}, rpcs = {} } = {}) {
  const tabelas = {
    comunicacao_alertas: alertas, comunicacao_mensagens: mensagens,
    comunicacao_configuracoes: Object.entries(configs).map(([chave, valor]) => ({ chave, valor })),
  };
  const chamadas = [];
  const from = (tabela) => {
    const filtros = [];
    const linhas = () => (tabelas[tabela] ?? []).filter((r) => filtros.every((f) => f(r)));
    const b = {
      select() { return b; }, limit() { return b; }, order() { return b; },
      eq(k, v) { filtros.push((r) => r[k] === v); return b; },
      neq(k, v) { filtros.push((r) => r[k] !== v); return b; },
      in(k, vs) { filtros.push((r) => vs.includes(r[k])); return b; },
      maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
      then: (ok, ko) => Promise.resolve({ data: linhas(), error: null }).then(ok, ko),
    };
    return b;
  };
  const rpc = async (nome, args) => {
    chamadas.push({ nome, args });
    if (!rpcs[nome] && nome === "comunicacao_resolver_destinatarios") return { data: DESTINATARIOS_PADRAO, error: null };
    return rpcs[nome](args);
  };
  return { supabase: { from, rpc }, chamadas };
}
const HAB_OK = async () => ({
  empresaHabilitada: true, tipoPermitido: true, envioAutomatico: true, empresaPausada: false, pausadoAte: null,
  destinatarioContatoId: "c1", destinatarioContatoEmpresaId: "ce-de-teste", destinatarioPerfilId: "p1", timezone: TZ, janelas: null, configHorarioValida: true,
});
const alerta = (extra = {}) => ({
  id: "a1", organizacao_id: "o1", tipo_alerta: "dashboard_ifood_d1", status: "DETECTED", severidade: "atencao",
  data_referencia: "2026-09-15", metadados: { unidade_nome: "Loja X" }, ...extra,
});
const rpcCriaUmaVez = () => {
  const vistas = new Set();
  return { comunicacao_agendar_mensagens_alerta: async (a) => {
    const itens = a.p_itens.map((it) => {
      const chave = `${a.p_alerta_id}|${it.contato_empresa_id}|${a.p_proposito}`;
      if (vistas.has(chave)) return { contato_empresa_id: it.contato_empresa_id, acao: "JA_EXISTIA" };
      vistas.add(chave);
      return { contato_empresa_id: it.contato_empresa_id, acao: "CRIADA", mensagem_id: `m-${it.contato_empresa_id}` };
    });
    return { data: { acao: "OK", criadas: itens.filter((x) => x.acao === "CRIADA").length, itens }, error: null };
  } };
};
const tardio = (db, agora, extra = {}) => agendarAvisosTardiosD1({ agora, resolverHabilitacao: HAB_OK, ...extra }, { supabase: db.supabase });

describe("agendarAvisosTardiosD1 — scheduler", () => {
  test("D-1 real às 20:30 (depois do expediente), DETECTED sem inicial -> cria a 1ª mensagem: chave …:v1, expira 22:30, texto tardio", async () => {
    const db = fakeDb({ alertas: [alerta()], rpcs: rpcCriaUmaVez() });
    const agora = QUA("20:30");
    const r = await tardio(db, agora);
    assert.equal(r.agendados, 1, JSON.stringify(r));
    const { nome, args } = agend(db)[0];
    assert.equal(nome, "comunicacao_agendar_mensagens_alerta");
    // 104: a MESMA identidade da 1ª mensagem POR DESTINATÁRIO (propósito inicial, origem do prazo final) — nunca um propósito "tardio" próprio
    assert.equal(args.p_proposito, "inicial");
    assert.equal(args.p_origem, "prazo_final_d1");
    const item = args.p_itens[0];
    assert.equal(item.contato_empresa_id, "ce1");
    assert.ok(new Date(item.disponivel_em) >= agora && new Date(item.disponivel_em) < QUA("22:00"));
    assert.equal(item.expira_em, QUA("22:30").toISOString());
    assert.match(item.conteudo, /^Olá! Atenção: o lançamento da unidade Loja X referente ao dia 15\/09\/2026 ainda consta pendente/);
  });

  test("janela: 19:59 não; 20:00 e 21:59 sim; 22:00, 22:30 e 18:30 não (nunca chama a RPC fora dela)", async () => {
    for (const [hhmm, esperado] of [["19:59", 0], ["20:00", 1], ["21:59", 1], ["22:00", 0], ["22:29", 0], ["22:30", 0], ["18:30", 0], ["10:00", 0]]) {
      const db = fakeDb({ alertas: [alerta()], rpcs: rpcCriaUmaVez() });
      const r = await tardio(db, QUA(hhmm));
      assert.equal(r.agendados, esperado, hhmm);
      if (!esperado) { assert.equal(r.foraDaJanelaTardia, 1); assert.equal(agend(db).length, 0); }
    }
  });

  test("domingo não; sábado sim (D-1 = sexta)", async () => {
    const dom = fakeDb({ alertas: [alerta({ data_referencia: "2026-09-19" })], rpcs: rpcCriaUmaVez() });
    assert.equal((await tardio(dom, DOM("20:30"))).agendados, 0);
    assert.equal(agend(dom).length, 0);
    const sab = fakeDb({ alertas: [alerta({ data_referencia: "2026-09-18" })], rpcs: rpcCriaUmaVez() });
    assert.equal((await tardio(sab, SAB("20:30"))).agendados, 1);
  });

  test("backlog antigo, o próprio dia e outro tipo -> não cria", async () => {
    for (const data of ["2026-09-14", "2026-09-01", "2026-09-16"]) {
      const db = fakeDb({ alertas: [alerta({ data_referencia: data })], rpcs: rpcCriaUmaVez() });
      const r = await tardio(db, QUA("20:30"));
      assert.equal(r.agendados, 0, data);
      assert.equal(r.foraDoPrazoD1, 1);
      assert.equal(agend(db).length, 0);
    }
    const outro = fakeDb({ alertas: [alerta({ tipo_alerta: "outro_tipo" })], rpcs: rpcCriaUmaVez() });
    assert.equal((await tardio(outro, QUA("20:30"), { tipoAlerta: "outro_tipo" })).agendados, 0);
    assert.equal(agend(outro).length, 0);
  });

  test("só alertas DETECTED (sem mensagem inicial ainda) são candidatos", async () => {
    for (const status of ["SCHEDULED", "PROCESSING", "SENT", "DELIVERED", "READ", "BLOCKED", "FAILED", "RESPONDED"]) {
      const db = fakeDb({ alertas: [alerta({ status })], rpcs: rpcCriaUmaVez() });
      assert.equal((await tardio(db, QUA("20:30"))).agendados, 0, status);
      assert.equal(agend(db).length, 0);
    }
  });

  test("empresa desabilitada / tipo / pausada / envio automático desligado / config inválida -> não cria", async () => {
    const base = await HAB_OK();
    for (const [hab, campo] of [
      [{ empresaHabilitada: false }, "semHabilitacao"], [{ tipoPermitido: false }, "semHabilitacao"], [{ empresaPausada: true }, "empresaPausada"],
      [{ envioAutomatico: false }, "envioAutomaticoDesligado"], [{ configHorarioValida: false }, "configInvalida"],
    ]) {
      const db = fakeDb({ alertas: [alerta()], rpcs: rpcCriaUmaVez() });
      const r = await tardio(db, QUA("20:30"), { resolverHabilitacao: async () => ({ ...base, ...hab }) });
      assert.equal(r.agendados, 0);
      assert.equal(r[campo], 1, campo);
      assert.equal(agend(db).length, 0);
    }
    for (const [lista, campo] of [[[], "semDestinatario"], [[{ ...DESTINATARIOS_PADRAO[0], elegivel: false, motivo: "SEM_CONSENTIMENTO" }], "destinatarioInelegivel"]]) {
      const db = fakeDb({ alertas: [alerta()], rpcs: rpcCriaUmaVez() });
      const r = await tardio(db, QUA("20:30"), { resolverDestinatarios: async () => lista });
      assert.equal(r.agendados, 0);
      assert.equal(r[campo], 1, campo);
      assert.equal(agend(db).length, 0);
    }
  });

  test("VÁRIOS destinatários: uma mensagem tardia POR destinatário elegível, numa só chamada transacional, com horários próprios", async () => {
    const lista = ["ce1", "ce2", "ce3"].map((id, n) => ({ contato_empresa_id: id, contato_id: `c${n + 1}`, nome: id, telefone: `+55629912345${n}0`, elegivel: true, motivo: null }));
    lista.push({ contato_empresa_id: "ce4", contato_id: "c4", nome: "opt-out", telefone: "+5562991234599", elegivel: false, motivo: "OPT_OUT" });
    const db = fakeDb({ alertas: [alerta()], rpcs: rpcCriaUmaVez() });
    const r = await tardio(db, QUA("20:30"), { resolverDestinatarios: async () => lista });
    assert.equal(r.agendados, 3);
    assert.equal(agend(db).length, 1);
    assert.deepEqual(agend(db)[0].args.p_itens.map((i) => i.contato_empresa_id), ["ce1", "ce2", "ce3"], "o destinatário inelegível nunca entra");
    assert.ok(new Set(agend(db)[0].args.p_itens.map((i) => i.disponivel_em)).size >= 2, "jitter por destinatário");
  });

  test("5 schedulers concorrentes + restart às 20:45 -> 1 CRIADA, o resto JA_EXISTIA, mesmo horário", async () => {
    const rpcs = rpcCriaUmaVez();
    const agora = QUA("20:30");
    const dbs = Array.from({ length: 5 }, () => fakeDb({ alertas: [alerta()], rpcs }));
    const rs = await Promise.all(dbs.map((d) => tardio(d, agora)));
    assert.equal(rs.reduce((n, r) => n + r.agendados, 0), 1);
    assert.equal(rs.reduce((n, r) => n + r.jaExistiam, 0), 4);
    assert.equal(new Set(dbs.map((d) => agend(d)[0].args.p_itens[0].disponivel_em)).size, 1);
    const restart = await tardio(fakeDb({ alertas: [alerta()], rpcs }), QUA("20:45"));
    assert.equal(restart.agendados, 0);
    assert.equal(restart.jaExistiam, 1);
  });

  test("recusas do banco viram contadores, nunca exceção; MENSAGEM_EXPIRADA nunca recria", async () => {
    for (const [acao, campo] of [["NAO_HABILITADA", "semHabilitacao"], ["TIPO_NAO_PERMITIDO", "semHabilitacao"], ["ENVIO_AUTOMATICO_DESLIGADO", "envioAutomaticoDesligado"],
      ["ALERTA_NAO_DETECTED", "ignorados"], ["TIPO_NAO_SUPORTADO", "ignorados"], ["ORIGEM_INVALIDA", "ignorados"]]) {
      const db = fakeDb({ alertas: [alerta()], rpcs: { comunicacao_agendar_mensagens_alerta: async () => ({ data: { acao }, error: null }) } });
      assert.equal((await tardio(db, QUA("20:30")))[campo], 1, acao);
    }
    for (const [acao, campo] of [["MENSAGEM_EXPIRADA", "mensagensExpiradas"], ["JA_EXISTIA", "jaExistiam"], ["DESTINATARIO_INELEGIVEL", "destinatarioInelegivel"], ["ITEM_INVALIDO", "ignorados"]]) {
      const db = fakeDb({ alertas: [alerta()], rpcs: { comunicacao_agendar_mensagens_alerta: async () => ({ data: { acao: "OK", criadas: 0, itens: [{ contato_empresa_id: "ce1", acao }] }, error: null }) } });
      assert.equal((await tardio(db, QUA("20:30")))[campo], 1, acao);
    }
  });
});

describe("scheduler NORMAL — D-1 que vence hoje não é agendado para AMANHÃ", () => {
  const normal = (db, agora, extra = {}) => agendarEnviosPendentes({ agora, resolverHabilitacao: HAB_OK, ...extra }, { supabase: db.supabase });
  const rpcNormal = () => rpcCriaUmaVez();

  test("D-1 de hoje às 19:00 (expediente encerrado) -> aguarda a janela tardia; a RPC normal NÃO é chamada", async () => {
    const db = fakeDb({ alertas: [alerta()], rpcs: rpcNormal() });
    const r = await normal(db, QUA("19:00"));
    assert.equal(r.aguardaJanelaTardia, 1, JSON.stringify(r));
    assert.equal(r.agendados, 0);
    assert.equal(agend(db).length, 0);
  });
  test("D-1 de hoje às 11:00 (dentro do expediente e depois da disponibilidade do iFood) -> o fluxo NORMAL continua sendo a autoridade", async () => {
    const db = fakeDb({ alertas: [alerta()], rpcs: rpcNormal() });
    const r = await normal(db, QUA("11:00"));
    assert.equal(r.agendados, 1, JSON.stringify(r));
    assert.equal(agend(db)[0].args.p_proposito, "inicial");
    assert.equal(agend(db)[0].args.p_origem, null, "o fluxo NORMAL não é o aviso tardio");
    assert.equal(agend(db)[0].args.p_itens[0].contato_empresa_id, "ce1");
  });
  test("D-1 de hoje ANTES da disponibilidade do iFood (06:00, 08:30, 10:15) -> NÃO agenda (a empresa não está atrasada); a janela tardia também não se aplica", async () => {
    for (const hhmm of ["06:00", "08:30", "10:15"]) {
      const db = fakeDb({ alertas: [alerta()], rpcs: rpcNormal() });
      const r = await normal(db, QUA(hhmm));
      assert.equal(r.agendados, 0, hhmm);
      assert.equal(r.aguardandoDisponibilidadeIfood, 1, hhmm);
      assert.equal(r.aguardaJanelaTardia, 0, hhmm);
      assert.equal(agend(db).length, 0, hhmm);
    }
  });
  test("D-1 de hoje às 10:30 -> normal agenda (dados do iFood disponíveis e horário mínimo de envio atingido)", async () => {
    const db = fakeDb({ alertas: [alerta()], rpcs: rpcNormal() });
    const r = await normal(db, QUA("10:30"));
    assert.equal(r.agendados, 1, JSON.stringify(r));
    assert.ok(new Date(agend(db)[0].args.p_itens[0].disponivel_em) >= QUA("10:30") && new Date(agend(db)[0].args.p_itens[0].disponivel_em) < QUA("18:00"));
  });
  test("BACKLOG antigo às 19:00 -> comportamento normal INALTERADO (agenda para o próximo expediente)", async () => {
    const db = fakeDb({ alertas: [alerta({ data_referencia: "2026-09-10" })], rpcs: rpcNormal() });
    const r = await normal(db, QUA("19:00"));
    assert.equal(r.agendados, 1);
    assert.equal(r.aguardaJanelaTardia, 0);
  });
  test("domingo (sem janela tardia) -> comportamento normal INALTERADO", async () => {
    const db = fakeDb({ alertas: [alerta({ data_referencia: "2026-09-19" })], rpcs: rpcNormal() });
    const r = await normal(db, DOM("19:00"));
    assert.equal(r.agendados, 1);
    assert.equal(r.aguardaJanelaTardia, 0);
  });
  test("sábado depois das 13:00 (expediente do sábado encerrado) com D-1 de hoje -> aguarda a janela tardia", async () => {
    const db = fakeDb({ alertas: [alerta({ data_referencia: "2026-09-18" })], rpcs: rpcNormal() });
    const r = await normal(db, SAB("15:00"));
    assert.equal(r.aguardaJanelaTardia, 1);
    assert.equal(agend(db).length, 0);
  });
});
