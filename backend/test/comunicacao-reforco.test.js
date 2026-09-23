// Reforço de PRAZO FINAL D-1 (2ª mensagem de um alerta) — testes SEM banco: funções puras, template,
// o scheduler `agendarReforcosPendentes` contra um supabase FALSO em memória (com uma RPC que
// emula a idempotência por chave única) e a checagem DUPLICATE por propósito.
// O comportamento REAL do banco (RPC 092, trigger, concorrência, JIT, rate-limit) está em
// comunicacao-reforco-integracao.test.js (banco de TESTE; PULA sem credencial).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  janelaDeReforcoAgora, instanteDoReforco, espacamentoCumprido, mesmoDiaLocal, propositoDaMensagem, prazoD1VenceHoje,
  chaveIdempotenciaInicial, chaveIdempotenciaReforco, PROPOSITO, JANELA_REFORCO, CUTOFF_REFORCO, ESPACAMENTO_MINIMO_HORAS,
} from "../src/modules/comunicacao/comunicacao.reforco.js";
import { formatarMensagemPendencia, formatarMensagemReforcoDia } from "../src/modules/comunicacao/comunicacao.template.js";
import { agendarReforcosPendentes } from "../src/modules/comunicacao/comunicacao.alertas.service.js";
import { existeOutraEntregaDoAlerta } from "../src/modules/comunicacao/comunicacao.fila.repo.js";

const TZ = "America/Fortaleza"; // UTC-3, sem DST
// Horário LOCAL de um dia de setembro/2026 -> instante UTC (+3h). Quarta 16, sábado 19, domingo 20.
const LOCAL = (dia, hhmm) => new Date(Date.UTC(2026, 8, dia, Number(hhmm.slice(0, 2)) + 3, Number(hhmm.slice(3))));
const QUA = (hhmm) => LOCAL(16, hhmm);
const SAB = (hhmm) => LOCAL(19, hhmm);
const DOM = (hhmm) => LOCAL(20, hhmm);

// ---------------------------------------------------------------------------
describe("janela de reforço 20:00–22:00 (pura)", () => {
  test("20:00 <= agora < 22:00 na quarta -> dentro; fim 22:00 e cutoff 22:30 locais", () => {
    const j = janelaDeReforcoAgora(QUA("20:00"), TZ);
    assert.ok(j);
    assert.equal(j.inicio.toISOString(), QUA("20:00").toISOString());
    assert.equal(j.fim.toISOString(), QUA("22:00").toISOString());
    assert.equal(j.cutoff.toISOString(), QUA("22:30").toISOString());
    assert.ok(janelaDeReforcoAgora(QUA("21:59"), TZ));
  });
  test("antes das 20:00 (incl. 16:00-18:00 e 19:59) e a partir das 22:00 / cutoff 22:30 -> fora", () => {
    for (const hhmm of ["08:00", "16:30", "17:59", "18:30", "19:59", "22:00", "22:29", "22:30", "23:00"]) {
      assert.equal(janelaDeReforcoAgora(QUA(hhmm), TZ), null, hhmm);
    }
  });
  test("segunda a sábado sim; domingo NÃO (mesmo às 20:30)", () => {
    assert.ok(janelaDeReforcoAgora(SAB("20:30"), TZ), "sábado");
    assert.equal(janelaDeReforcoAgora(DOM("20:30"), TZ), null, "domingo");
    assert.ok(janelaDeReforcoAgora(LOCAL(14, "20:30"), TZ), "segunda");
  });
  test("constantes: 20:00-22:00, cutoff 22:30, espaçamento 2h", () => {
    assert.deepEqual(JANELA_REFORCO.inicio, { hora: 20, minuto: 0 });
    assert.deepEqual(JANELA_REFORCO.fim, { hora: 22, minuto: 0 });
    assert.deepEqual(CUTOFF_REFORCO, { hora: 22, minuto: 30 });
    assert.equal(ESPACAMENTO_MINIMO_HORAS, 2);
  });
});

describe("prazo do D-1 (pura)", () => {
  test("dataReferencia === diaAnterior(hoje local) -> vence hoje", () => {
    assert.equal(prazoD1VenceHoje("2026-09-15", QUA("20:30"), TZ), true);
  });
  test("backlog antigo, o próprio dia, futuro e ausente -> NÃO", () => {
    for (const d of ["2026-09-14", "2026-09-01", "2026-09-16", "2026-09-17", null, undefined, ""]) {
      assert.equal(prazoD1VenceHoje(d, QUA("20:30"), TZ), false, String(d));
    }
  });
  test("usa o calendário LOCAL: 23:30 local do dia 16 (02:30Z do dia 17) ainda é 'hoje = 16'", () => {
    assert.equal(prazoD1VenceHoje("2026-09-15", new Date("2026-09-17T02:30:00Z"), TZ), true);
    assert.equal(prazoD1VenceHoje("2026-09-16", new Date("2026-09-17T02:30:00Z"), TZ), false);
  });
});

describe("instante do reforço (jitter determinístico)", () => {
  const janela = janelaDeReforcoAgora(QUA("20:00"), TZ);
  test("determinístico e dentro de [agora, fim - 1min]", () => {
    const a = instanteDoReforco(QUA("20:00"), janela, "k1"), b = instanteDoReforco(QUA("20:00"), janela, "k1");
    assert.equal(a.getTime(), b.getTime());
    assert.ok(a >= QUA("20:00") && a.getTime() <= janela.fim.getTime() - 60_000);
  });
  test("perto do fim nunca ultrapassa a janela nem o cutoff", () => {
    const j = janelaDeReforcoAgora(QUA("21:59"), TZ);
    for (const k of ["a", "b", "c", "d", "e"]) {
      const t = instanteDoReforco(QUA("21:59"), j, k).getTime();
      assert.ok(t < j.fim.getTime() && t < j.cutoff.getTime());
    }
  });
});

describe("espaçamento / dia / chaves / propósito", () => {
  test("espaçamento próprio de 2h desde o envio REAL da inicial; ausente = fail-closed", () => {
    assert.equal(espacamentoCumprido(QUA("17:45"), QUA("19:44")), false);
    assert.equal(espacamentoCumprido(QUA("17:45"), QUA("19:45")), true);
    assert.equal(espacamentoCumprido(QUA("18:00"), QUA("20:00")), true); // exemplo aprovado
    assert.equal(espacamentoCumprido(null, QUA("20:30")), false);
  });
  test("mesmoDiaLocal usa o calendário LOCAL", () => {
    assert.equal(mesmoDiaLocal(new Date("2026-09-17T02:30:00Z"), QUA("20:30"), TZ), true); // 23:30 x 20:30 do dia 16
    assert.equal(mesmoDiaLocal(new Date("2026-09-15T19:30:00Z"), QUA("20:30"), TZ), false);
  });
  test("chaves determinísticas e distintas", () => {
    assert.equal(chaveIdempotenciaInicial("A"), "wa:alerta:A:v1");
    assert.equal(chaveIdempotenciaReforco("A"), "wa:alerta:A:reforco:v1");
  });
  test("propósito canônico: sem metadados = inicial; só o valor exato 'reforco' é reforço (nenhuma variante)", () => {
    assert.equal(propositoDaMensagem({}), PROPOSITO.INICIAL);
    assert.equal(propositoDaMensagem({ metadados: {} }), PROPOSITO.INICIAL);
    for (const v of ["REFORCO", "reforço", "followup", "reminder", "outra-coisa"]) assert.equal(propositoDaMensagem({ metadados: { proposito: v } }), PROPOSITO.INICIAL, v);
    assert.equal(propositoDaMensagem({ metadados: { proposito: "reforco" } }), PROPOSITO.REFORCO);
  });
});

describe("templates", () => {
  test("primeira mensagem inalterada (byte a byte)", () => {
    assert.equal(
      formatarMensagemPendencia({ unidadeNome: "Loja X", pendenciaMaisAntiga: "2026-09-15" }),
      "Olá! Identificamos que a unidade Loja X possui um lançamento pendente no Crescer com Delivery referente ao dia 15/09/2026. Por favor, acesse o sistema para verificar e regularizar a pendência. — Crescer com Delivery",
    );
  });
  test("reforço de prazo final: texto aprovado, byte a byte", () => {
    assert.equal(
      formatarMensagemReforcoDia({ unidadeNome: "Loja X", pendenciaMaisAntiga: "2026-09-15" }),
      "Último lembrete de hoje — Crescer com Delivery. O lançamento da unidade Loja X referente ao dia 15/09/2026 ainda consta pendente. É preciso regularizá-lo hoje para evitar a perda da possibilidade de preenchimento desse período. Caso já tenha realizado o preenchimento, desconsidere esta mensagem. — Crescer com Delivery",
    );
  });
  test("reforço não usa 'última chance', 'quando possível' nem cita o Agente Crescer", () => {
    const t = formatarMensagemReforcoDia({ unidadeNome: "Loja X", pendenciaMaisAntiga: "2026-09-15" });
    assert.doesNotMatch(t, /última chance|quando possível|agente crescer|multa|penalidade|suspens/i);
    assert.match(t, /desconsidere esta mensagem/);
  });
  test("reforço nunca inventa data ausente", () => {
    assert.doesNotMatch(formatarMensagemReforcoDia({ unidadeNome: "Loja X" }), /referente ao dia/);
  });
});

// ---------------------------------------------------------------------------
// supabase FALSO em memória (só o que o scheduler/DUPLICATE usam)
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
  id: "a1", organizacao_id: "o1", tipo_alerta: "dashboard_ifood_d1", status: "SENT", severidade: "atencao",
  data_referencia: "2026-09-15", metadados: { unidade_nome: "Loja X" }, ...extra,
});
const inicial = (extra = {}) => ({
  id: "m1", alerta_id: "a1", idempotency_key: "wa:alerta:a1:v1", status: "SENT", enviado_em: QUA("17:00").toISOString(), metadados: {}, ...extra,
});
const rpcCriaUmaVez = () => {
  const vistas = new Set();
  return { comunicacao_agendar_reforco_alerta: async (a) => {
    if (vistas.has(a.p_idempotency_key)) return { data: { acao: "JA_EXISTIA" }, error: null };
    vistas.add(a.p_idempotency_key);
    return { data: { acao: "CRIADA", mensagem_id: "r1" }, error: null };
  } };
};
const rodar = (db, agora, extra = {}) => agendarReforcosPendentes({ agora, resolverHabilitacao: HAB_OK, ...extra }, { supabase: db.supabase });

describe("agendarReforcosPendentes — scheduler (Política B)", () => {
  test("20:30, D-1 de hoje, inicial enviada 17:00 -> cria UM reforço (chave, horário, expira_em 22:30 e texto corretos)", async () => {
    const db = fakeDb({ alertas: [alerta()], mensagens: [inicial()], rpcs: rpcCriaUmaVez() });
    const agora = QUA("20:30");
    const r = await rodar(db, agora);
    assert.equal(r.agendados, 1, JSON.stringify(r));
    const { args } = db.chamadas[0];
    assert.equal(args.p_idempotency_key, "wa:alerta:a1:reforco:v1");
    assert.ok(new Date(args.p_disponivel_em) >= agora && new Date(args.p_disponivel_em) < QUA("22:00"));
    assert.equal(args.p_expira_em, QUA("22:30").toISOString());
    assert.match(args.p_conteudo, /^Último lembrete de hoje/);
  });

  test("espaçamento próprio: 1ª às 15:00 e às 18:00 -> elegível; 1ª às 19:00 (1h30 antes de 20:30) -> aguarda", async () => {
    for (const [enviado, agora, esperado] of [["15:00", "20:00", 1], ["18:00", "20:00", 1], ["17:45", "20:00", 1], ["19:00", "20:30", 0], ["19:45", "21:30", 0]]) {
      const db = fakeDb({ alertas: [alerta()], mensagens: [inicial({ enviado_em: QUA(enviado).toISOString() })], rpcs: rpcCriaUmaVez() });
      const r = await rodar(db, QUA(agora));
      assert.equal(r.agendados, esperado, `${enviado} -> ${agora}`);
      if (!esperado) assert.equal(r.espacamentoPendente, 1);
    }
  });

  test("o cooldown NORMAL (8h/4h) NÃO controla o reforço: 1ª há 3h com severidade 'atencao' (8h) ainda cria", async () => {
    const db = fakeDb({
      alertas: [alerta({ severidade: "atencao" })], mensagens: [inicial({ enviado_em: QUA("17:30").toISOString() })],
      configs: { cooldowns_horas: { atencao: 8, critico: 4 } }, rpcs: rpcCriaUmaVez(),
    });
    assert.equal((await rodar(db, QUA("20:30"))).agendados, 1);
  });

  test("fora da janela (antes de 20:00, 22:00, 22:30, 16:30) -> não cria e nem chama a RPC", async () => {
    for (const hhmm of ["16:30", "19:59", "22:00", "22:30", "23:10"]) {
      const db = fakeDb({ alertas: [alerta()], mensagens: [inicial({ enviado_em: QUA("08:00").toISOString() })], rpcs: rpcCriaUmaVez() });
      const r = await rodar(db, QUA(hhmm));
      assert.equal(r.agendados, 0, hhmm);
      assert.equal(r.foraDaJanelaReforco, 1);
      assert.equal(db.chamadas.length, 0);
    }
  });

  test("domingo -> não cria; sábado -> cria (D-1 = sexta)", async () => {
    const dom = fakeDb({ alertas: [alerta({ data_referencia: "2026-09-19" })], mensagens: [inicial({ enviado_em: DOM("17:00").toISOString() })], rpcs: rpcCriaUmaVez() });
    assert.equal((await rodar(dom, DOM("20:30"))).agendados, 0);
    assert.equal(dom.chamadas.length, 0);
    const sab = fakeDb({ alertas: [alerta({ data_referencia: "2026-09-18" })], mensagens: [inicial({ enviado_em: SAB("17:00").toISOString() })], rpcs: rpcCriaUmaVez() });
    assert.equal((await rodar(sab, SAB("20:30"))).agendados, 1);
  });

  test("SÓ o D-1 que vence hoje: backlog antigo, dia corrente e outro tipo -> não cria", async () => {
    for (const data of ["2026-09-14", "2026-09-01", "2026-09-16"]) {
      const db = fakeDb({ alertas: [alerta({ data_referencia: data })], mensagens: [inicial()], rpcs: rpcCriaUmaVez() });
      const r = await rodar(db, QUA("20:30"));
      assert.equal(r.agendados, 0, data);
      assert.equal(r.foraDoPrazoD1, 1);
      assert.equal(db.chamadas.length, 0);
    }
    const outro = fakeDb({ alertas: [alerta({ tipo_alerta: "outro_tipo" })], mensagens: [inicial()], rpcs: rpcCriaUmaVez() });
    assert.equal((await rodar(outro, QUA("20:30"), { tipoAlerta: "outro_tipo" })).agendados, 0);
    assert.equal(outro.chamadas.length, 0);
  });

  test("1ª mensagem inexistente / não enviada / incerta / de outro dia -> não cria", async () => {
    const ontem = QUA("17:00").toISOString().replace("2026-09-16", "2026-09-15");
    for (const [msgs, campo] of [
      [[], "primeiraNaoEnviada"],
      [[inicial({ status: "SCHEDULED", enviado_em: null })], "primeiraNaoEnviada"],
      [[inicial({ status: "DELIVERY_UNKNOWN" })], "primeiraNaoEnviada"],
      [[inicial({ enviado_em: ontem })], "primeiraDeOutroDia"],
    ]) {
      const db = fakeDb({ alertas: [alerta()], mensagens: msgs, rpcs: rpcCriaUmaVez() });
      const r = await rodar(db, QUA("20:30"));
      assert.equal(r.agendados, 0);
      assert.equal(r[campo], 1, campo);
      assert.equal(db.chamadas.length, 0);
    }
  });

  test("só alertas SENT/DELIVERED/READ são candidatos", async () => {
    for (const status of ["DETECTED", "SCHEDULED", "PROCESSING", "BLOCKED", "FAILED", "RESPONDED"]) {
      const db = fakeDb({ alertas: [alerta({ status })], mensagens: [inicial()], rpcs: rpcCriaUmaVez() });
      assert.equal((await rodar(db, QUA("20:30"))).agendados, 0, status);
      assert.equal(db.chamadas.length, 0);
    }
    for (const status of ["DELIVERED", "READ"]) {
      const db = fakeDb({ alertas: [alerta({ status })], mensagens: [inicial()], rpcs: rpcCriaUmaVez() });
      assert.equal((await rodar(db, QUA("20:30"))).agendados, 1, status);
    }
  });

  test("organização desabilitada / tipo não permitido / pausada / sem destinatário -> não cria", async () => {
    const base = await HAB_OK();
    for (const [hab, campo] of [
      [{ empresaHabilitada: false }, "semHabilitacao"], [{ tipoPermitido: false }, "semHabilitacao"],
      [{ empresaPausada: true }, "empresaPausada"], [{ destinatarioContatoId: null }, "semDestinatario"],
      [{ destinatarioPerfilId: null }, "semDestinatario"],
    ]) {
      const db = fakeDb({ alertas: [alerta()], mensagens: [inicial()], rpcs: rpcCriaUmaVez() });
      const r = await rodar(db, QUA("20:30"), { resolverHabilitacao: async () => ({ ...base, ...hab }) });
      assert.equal(r.agendados, 0);
      assert.equal(r[campo], 1, campo);
      assert.equal(db.chamadas.length, 0);
    }
  });

  test("timezone/janelas inválidos -> configInvalida, nada é criado (fail-closed)", async () => {
    const db = fakeDb({ alertas: [alerta()], mensagens: [inicial()], rpcs: rpcCriaUmaVez() });
    const r = await rodar(db, QUA("20:30"), { resolverHabilitacao: async () => ({ ...(await HAB_OK()), configHorarioValida: false }) });
    assert.equal(r.configInvalida, 1);
    assert.equal(db.chamadas.length, 0);
  });

  test("restart e duas instâncias do scheduler -> 1 CRIADA, o resto JA_EXISTIA, mesma chave e mesmo horário", async () => {
    const rpcs = rpcCriaUmaVez(); // o "banco" compartilhado entre as execuções
    const agora = QUA("20:30");
    const dbs = Array.from({ length: 5 }, () => fakeDb({ alertas: [alerta()], mensagens: [inicial()], rpcs }));
    const rs = await Promise.all(dbs.map((d) => rodar(d, agora)));
    assert.equal(rs.reduce((n, r) => n + r.agendados, 0), 1);
    assert.equal(rs.reduce((n, r) => n + r.jaExistiam, 0), 4);
    assert.equal(new Set(dbs.map((d) => d.chamadas[0].args.p_disponivel_em)).size, 1, "jitter determinístico: mesmo alerta -> mesmo horário");
    // restart no meio da janela (20:30 -> 21:15): nenhum segundo reforço
    const restart = await rodar(fakeDb({ alertas: [alerta()], mensagens: [inicial()], rpcs }), QUA("21:15"));
    assert.equal(restart.agendados, 0);
    assert.equal(restart.jaExistiam, 1);
  });

  test("respostas de recusa do banco viram contadores, nunca exceção", async () => {
    for (const [acao, campo] of [["ENTREGA_EM_CURSO", "entregaEmCurso"], ["NAO_HABILITADA", "semHabilitacao"], ["SEM_DESTINATARIO", "semDestinatario"],
      ["DESTINATARIO_INELEGIVEL", "destinatarioInelegivel"], ["PRIMEIRA_MENSAGEM_NAO_ENVIADA", "primeiraNaoEnviada"], ["CHAVE_INVALIDA", "ignorados"]]) {
      const db = fakeDb({ alertas: [alerta()], mensagens: [inicial()], rpcs: { comunicacao_agendar_reforco_alerta: async () => ({ data: { acao }, error: null }) } });
      assert.equal((await rodar(db, QUA("20:30")))[campo], 1, acao);
    }
  });
});

describe("DUPLICATE por propósito (existeOutraEntregaDoAlerta)", () => {
  const msg = (id, status, proposito) => ({ id, alerta_id: "a1", status, metadados: proposito ? { proposito } : {} });
  const existe = (mensagens, exceptId, proposito) => existeOutraEntregaDoAlerta({ alertaId: "a1", exceptId, proposito }, { supabase: fakeDb({ mensagens }).supabase });

  test("reforço NÃO é duplicata da inicial já enviada", async () => {
    assert.equal(await existe([msg("i", "SENT"), msg("r", "PROCESSING", "reforco")], "r", PROPOSITO.REFORCO), false);
  });
  test("a inicial NÃO é duplicata de um reforço enviado", async () => {
    assert.equal(await existe([msg("i", "PROCESSING"), msg("r", "SENT", "reforco")], "i", PROPOSITO.INICIAL), false);
  });
  test("SEGUNDA inicial continua proibida (outra inicial SENT/DELIVERED/READ/SENDING/DELIVERY_UNKNOWN)", async () => {
    for (const s of ["SENT", "DELIVERED", "READ", "SENDING", "DELIVERY_UNKNOWN"]) {
      assert.equal(await existe([msg("i1", s), msg("i2", "PROCESSING")], "i2", PROPOSITO.INICIAL), true, s);
    }
  });
  test("SEGUNDO reforço continua proibido", async () => {
    assert.equal(await existe([msg("i", "SENT"), msg("r1", "SENT", "reforco"), msg("r2", "PROCESSING", "reforco")], "r2", PROPOSITO.REFORCO), true);
  });
  test("sem `proposito` = comportamento histórico (inicial)", async () => {
    const db = fakeDb({ mensagens: [msg("i1", "SENT"), msg("i2", "PROCESSING")] });
    assert.equal(await existeOutraEntregaDoAlerta({ alertaId: "a1", exceptId: "i2" }, { supabase: db.supabase }), true);
  });
  test("estados não-entregues (SCHEDULED/CANCELLED/BLOCKED/FAILED) não contam como duplicata", async () => {
    for (const s of ["SCHEDULED", "CANCELLED", "BLOCKED", "FAILED"]) {
      assert.equal(await existe([msg("i1", s), msg("i2", "PROCESSING")], "i2", PROPOSITO.INICIAL), false, s);
    }
  });
  test("único caller real: processarJobReivindicado (revisão estática)", async () => {
    const fs = await import("node:fs"), path = await import("node:path"), { fileURLToPath } = await import("node:url");
    const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
    const achados = [];
    const varrer = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) varrer(p);
      else if (e.name.endsWith(".js") && /existeOutraEntregaDoAlerta\(/.test(fs.readFileSync(p, "utf8")) && !e.name.endsWith("comunicacao.fila.repo.js")) achados.push(e.name);
    } };
    varrer(raiz);
    assert.deepEqual(achados, ["comunicacao.alertas.service.js"]);
  });
});
