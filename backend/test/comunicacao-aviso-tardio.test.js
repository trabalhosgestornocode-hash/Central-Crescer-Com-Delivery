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
      select() { return b; }, limit() { return b; },
      eq(k, v) { filtros.push((r) => r[k] === v); return b; },
      neq(k, v) { filtros.push((r) => r[k] !== v); return b; },
      in(k, vs) { filtros.push((r) => vs.includes(r[k])); return b; },
      maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
      then: (ok, ko) => Promise.resolve({ data: linhas(), error: null }).then(ok, ko),
    };
    return b;
  };
  const rpc = async (nome, args) => { chamadas.push({ nome, args }); return rpcs[nome](args); };
  return { supabase: { from, rpc }, chamadas };
}
const HAB_OK = async () => ({
  empresaHabilitada: true, tipoPermitido: true, empresaPausada: false, pausadoAte: null,
  destinatarioContatoId: "c1", destinatarioPerfilId: "p1", timezone: TZ, janelas: null, configHorarioValida: true,
});
const alerta = (extra = {}) => ({
  id: "a1", organizacao_id: "o1", tipo_alerta: "dashboard_ifood_d1", status: "DETECTED", severidade: "atencao",
  data_referencia: "2026-09-15", metadados: { unidade_nome: "Loja X" }, ...extra,
});
const rpcCriaUmaVez = (nome = "comunicacao_agendar_aviso_tardio_d1") => {
  const vistas = new Set();
  return { [nome]: async (a) => {
    if (vistas.has(a.p_idempotency_key)) return { data: { acao: "JA_EXISTIA" }, error: null };
    vistas.add(a.p_idempotency_key);
    return { data: { acao: "CRIADA", mensagem_id: "m1" }, error: null };
  } };
};
const tardio = (db, agora, extra = {}) => agendarAvisosTardiosD1({ agora, resolverHabilitacao: HAB_OK, ...extra }, { supabase: db.supabase });

describe("agendarAvisosTardiosD1 — scheduler", () => {
  test("D-1 real às 20:30 (depois do expediente), DETECTED sem inicial -> cria a 1ª mensagem: chave …:v1, expira 22:30, texto tardio", async () => {
    const db = fakeDb({ alertas: [alerta()], rpcs: rpcCriaUmaVez() });
    const agora = QUA("20:30");
    const r = await tardio(db, agora);
    assert.equal(r.agendados, 1, JSON.stringify(r));
    const { nome, args } = db.chamadas[0];
    assert.equal(nome, "comunicacao_agendar_aviso_tardio_d1");
    assert.equal(args.p_idempotency_key, "wa:alerta:a1:v1", "MESMA identidade da 1ª mensagem — nunca …:tardio:v1");
    assert.equal(args.p_idempotency_key, chaveIdempotenciaInicial("a1"));
    assert.ok(new Date(args.p_disponivel_em) >= agora && new Date(args.p_disponivel_em) < QUA("22:00"));
    assert.equal(args.p_expira_em, QUA("22:30").toISOString());
    assert.match(args.p_conteudo, /^Olá! Atenção: o lançamento da unidade Loja X referente ao dia 15\/09\/2026 ainda consta pendente/);
  });

  test("janela: 19:59 não; 20:00 e 21:59 sim; 22:00, 22:30 e 18:30 não (nunca chama a RPC fora dela)", async () => {
    for (const [hhmm, esperado] of [["19:59", 0], ["20:00", 1], ["21:59", 1], ["22:00", 0], ["22:29", 0], ["22:30", 0], ["18:30", 0], ["10:00", 0]]) {
      const db = fakeDb({ alertas: [alerta()], rpcs: rpcCriaUmaVez() });
      const r = await tardio(db, QUA(hhmm));
      assert.equal(r.agendados, esperado, hhmm);
      if (!esperado) { assert.equal(r.foraDaJanelaTardia, 1); assert.equal(db.chamadas.length, 0); }
    }
  });

  test("domingo não; sábado sim (D-1 = sexta)", async () => {
    const dom = fakeDb({ alertas: [alerta({ data_referencia: "2026-09-19" })], rpcs: rpcCriaUmaVez() });
    assert.equal((await tardio(dom, DOM("20:30"))).agendados, 0);
    assert.equal(dom.chamadas.length, 0);
    const sab = fakeDb({ alertas: [alerta({ data_referencia: "2026-09-18" })], rpcs: rpcCriaUmaVez() });
    assert.equal((await tardio(sab, SAB("20:30"))).agendados, 1);
  });

  test("backlog antigo, o próprio dia e outro tipo -> não cria", async () => {
    for (const data of ["2026-09-14", "2026-09-01", "2026-09-16"]) {
      const db = fakeDb({ alertas: [alerta({ data_referencia: data })], rpcs: rpcCriaUmaVez() });
      const r = await tardio(db, QUA("20:30"));
      assert.equal(r.agendados, 0, data);
      assert.equal(r.foraDoPrazoD1, 1);
      assert.equal(db.chamadas.length, 0);
    }
    const outro = fakeDb({ alertas: [alerta({ tipo_alerta: "outro_tipo" })], rpcs: rpcCriaUmaVez() });
    assert.equal((await tardio(outro, QUA("20:30"), { tipoAlerta: "outro_tipo" })).agendados, 0);
    assert.equal(outro.chamadas.length, 0);
  });

  test("só alertas DETECTED (sem mensagem inicial ainda) são candidatos", async () => {
    for (const status of ["SCHEDULED", "PROCESSING", "SENT", "DELIVERED", "READ", "BLOCKED", "FAILED", "RESPONDED"]) {
      const db = fakeDb({ alertas: [alerta({ status })], rpcs: rpcCriaUmaVez() });
      assert.equal((await tardio(db, QUA("20:30"))).agendados, 0, status);
      assert.equal(db.chamadas.length, 0);
    }
  });

  test("empresa desabilitada / tipo / pausada / sem destinatário / config inválida -> não cria", async () => {
    const base = await HAB_OK();
    for (const [hab, campo] of [
      [{ empresaHabilitada: false }, "semHabilitacao"], [{ tipoPermitido: false }, "semHabilitacao"], [{ empresaPausada: true }, "empresaPausada"],
      [{ destinatarioContatoId: null }, "semDestinatario"], [{ destinatarioPerfilId: null }, "semDestinatario"], [{ configHorarioValida: false }, "configInvalida"],
    ]) {
      const db = fakeDb({ alertas: [alerta()], rpcs: rpcCriaUmaVez() });
      const r = await tardio(db, QUA("20:30"), { resolverHabilitacao: async () => ({ ...base, ...hab }) });
      assert.equal(r.agendados, 0);
      assert.equal(r[campo], 1, campo);
      assert.equal(db.chamadas.length, 0);
    }
  });

  test("5 schedulers concorrentes + restart às 20:45 -> 1 CRIADA, o resto JA_EXISTIA, mesmo horário", async () => {
    const rpcs = rpcCriaUmaVez();
    const agora = QUA("20:30");
    const dbs = Array.from({ length: 5 }, () => fakeDb({ alertas: [alerta()], rpcs }));
    const rs = await Promise.all(dbs.map((d) => tardio(d, agora)));
    assert.equal(rs.reduce((n, r) => n + r.agendados, 0), 1);
    assert.equal(rs.reduce((n, r) => n + r.jaExistiam, 0), 4);
    assert.equal(new Set(dbs.map((d) => d.chamadas[0].args.p_disponivel_em)).size, 1);
    const restart = await tardio(fakeDb({ alertas: [alerta()], rpcs }), QUA("20:45"));
    assert.equal(restart.agendados, 0);
    assert.equal(restart.jaExistiam, 1);
  });

  test("recusas do banco viram contadores, nunca exceção; MENSAGEM_EXPIRADA nunca recria", async () => {
    for (const [acao, campo] of [["MENSAGEM_EXPIRADA", "mensagensExpiradas"], ["INICIAL_JA_EXISTE", "inicialJaExiste"], ["ENTREGA_EM_CURSO", "entregaEmCurso"],
      ["NAO_HABILITADA", "semHabilitacao"], ["SEM_DESTINATARIO", "semDestinatario"], ["DESTINATARIO_INELEGIVEL", "destinatarioInelegivel"], ["CHAVE_INVALIDA", "ignorados"], ["ALERTA_NAO_DETECTED", "ignorados"]]) {
      const db = fakeDb({ alertas: [alerta()], rpcs: { comunicacao_agendar_aviso_tardio_d1: async () => ({ data: { acao }, error: null }) } });
      assert.equal((await tardio(db, QUA("20:30")))[campo], 1, acao);
    }
  });
});

describe("scheduler NORMAL — D-1 que vence hoje não é agendado para AMANHÃ", () => {
  const normal = (db, agora, extra = {}) => agendarEnviosPendentes({ agora, resolverHabilitacao: HAB_OK, ...extra }, { supabase: db.supabase });
  const rpcNormal = () => rpcCriaUmaVez("comunicacao_agendar_mensagem_alerta");

  test("D-1 de hoje às 19:00 (expediente encerrado) -> aguarda a janela tardia; a RPC normal NÃO é chamada", async () => {
    const db = fakeDb({ alertas: [alerta()], rpcs: rpcNormal() });
    const r = await normal(db, QUA("19:00"));
    assert.equal(r.aguardaJanelaTardia, 1, JSON.stringify(r));
    assert.equal(r.agendados, 0);
    assert.equal(db.chamadas.length, 0);
  });
  test("D-1 de hoje às 10:00 (dentro do expediente) -> o fluxo NORMAL continua sendo a autoridade", async () => {
    const db = fakeDb({ alertas: [alerta()], rpcs: rpcNormal() });
    const r = await normal(db, QUA("10:00"));
    assert.equal(r.agendados, 1, JSON.stringify(r));
    assert.equal(db.chamadas[0].args.p_idempotency_key, "wa:alerta:a1:v1");
  });
  test("D-1 de hoje antes da abertura (06:00) -> normal agenda para HOJE 08:00 (nada a esperar pela janela tardia)", async () => {
    const db = fakeDb({ alertas: [alerta()], rpcs: rpcNormal() });
    const r = await normal(db, QUA("06:00"));
    assert.equal(r.agendados, 1);
    assert.equal(r.aguardaJanelaTardia, 0);
    assert.ok(new Date(db.chamadas[0].args.p_disponivel_em) >= QUA("08:00") && new Date(db.chamadas[0].args.p_disponivel_em) < QUA("18:00"));
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
    assert.equal(db.chamadas.length, 0);
  });
});
