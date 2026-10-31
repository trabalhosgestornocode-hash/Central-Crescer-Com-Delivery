// Relatórios operacionais: enfileiramento (fuso/janela), despacho (portões, falhas, concorrência) e agendador — com repositório em memória
// que espelha a semântica das RPCs da migration 141 (provada no PostgreSQL em testes-seguros/pg/relatorios_141_142.sh e no banco de teste em
// notificacoes-relatorios-integracao.test.js) e o gateway simulado (fake.provider).
import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "ficticio_service_role_key_0123456789abcdef";
process.env.SUPABASE_ANON_KEY ??= "ficticio_anon_key_0123456789abcdef0123";

const { janelaDeEnvio, enfileirarRelatoriosDaUnidade } = await import("../src/modules/notificacoes/notificacoes.relatorios.servico.js");
const { processarFilaRelatorios, relatoriosEnvioHabilitado } = await import("../src/modules/notificacoes/notificacoes.relatorios.envio.js");
const { criarAgendadorRelatorios, executarCicloRelatorios, agendadorRelatoriosPermitido } = await import("../src/modules/notificacoes/notificacoes.relatorios.agendador.js");
const { classificarIntegracao, elegibilidadeDiaria, MOTIVO } = await import("../src/modules/notificacoes/notificacoes.relatorios.js");
const { criarWhatsAppService } = await import("../src/modules/comunicacao/whatsapp.service.js");
const { criarFakeProvider } = await import("../src/modules/comunicacao/providers/fake.provider.js");

const TEL = "+5511977770001";
const ENV_ON = { NOTIFICACOES_RELATORIOS_ENVIO_HABILITADO: "true", NOTIFICACOES_RELATORIOS_ALLOWLIST_E164: TEL };
const VIVA = { estado: "ao_vivo", motivo: null };
const AGORA = () => new Date("2026-10-28T12:00:00.000Z");          // 09:00 em São Paulo
const fech = (competencia, over = {}) => ({ id: `f-${competencia}`, competencia, versao: 1, status: "CONSOLIDADO", hash_conteudo: "h", cobertura: {}, diagnostico: { principal: { fato: "x", acao: "y" } },
  indicadores: { pedidos: { recebidos: 40, concluidosNoDia: 38, canceladosNoDia: 2 }, preparo: { estado: "calculado", nome: "Preparo", media: 12, amostras: 30, meta: 15 }, entrega: { estado: "indisponivel", nome: "Entrega" }, vida: { estado: "indisponivel", nome: "Vida" },
    atrasos: { pedidosAvaliados: 30, pedidosAtrasados: 3, pct: 10 }, movimento: { picos: [{ hora: 19, pedidos: 9 }] }, cancelamentos: { total: 2, motivos: [] }, disputas: { abertasNoDia: 0, expiradasNoDia: 0, pendentesAgora: 0 },
    descontos: { pedidosNaBase: 0 }, clientes: { base: 0, novos: 0, recorrentes: 0 } }, ...over });

/** Repositório em memória com a semântica das RPCs (CAS de posse, cota diária, expiração, INCERTO em posse vencida). */
function repoMemoria({ fechamentos = [], autorizacao = { autorizado: true, telefoneE164: TEL, contatoWhatsappId: "cw1" } } = {}) {
  const itens = new Map(); let resumos = 0; const aut = { ...autorizacao };
  const r = {
    itens, aut,
    fechamentosEntre: async ({ de, ate }) => fechamentos.filter((f) => f.competencia >= de && f.competencia <= ate),
    registrarResumoSemanal: async () => `resumo-${++resumos}`,
    enfileirar: async (linhas) => { let n = 0; for (const l of linhas) if (![...itens.values()].some((i) => i.chave_idempotencia === l.chave_idempotencia)) { itens.set(`i${itens.size + 1}`, { id: `i${itens.size + 1}`, status: "PENDENTE", tentativas: 0, max_tentativas: 3, ...l }); n++; } return n; },
    proximosPendentes: async ({ agoraIso }) => [...itens.values()].filter((i) => ["PENDENTE", "ENVIANDO"].includes(i.status) && i.disponivel_em <= agoraIso),
    autorizacaoAtual: async () => aut,
    reservar: async ({ id, worker, maxPorDestinatarioDia }) => {
      const m = itens.get(id); if (!m || m.status !== "PENDENTE") return { resultado: "POSSE_PERDIDA" };
      if (maxPorDestinatarioDia != null && [...itens.values()].filter((x) => x.id !== id && x.contato_empresa_id === m.contato_empresa_id && x.categoria === m.categoria && ["ENVIANDO", "ENVIADO", "INCERTO"].includes(x.status)).length >= maxPorDestinatarioDia) return { resultado: "COTA_DIA" };
      m.status = "ENVIANDO"; m.claimed_by = worker; m.tentativas += 1; return { resultado: "INICIADO", tentativa: m.tentativas };
    },
    finalizar: async ({ id, worker, resultado, providerMessageId, motivo }) => {
      const m = itens.get(id); if (!m || m.status !== "ENVIANDO" || m.claimed_by !== worker) return { resultado: "POSSE_PERDIDA" };
      m.status = resultado === "RETRY" ? "PENDENTE" : resultado; m.motivo = motivo ?? null; m.provider_message_id = providerMessageId ?? m.provider_message_id; m.claimed_by = null; return { resultado: "GRAVADO", status: m.status };
    },
  };
  return r;
}
const notifFake = (extra = {}) => ({
  listarDestinatarios: async () => ({ destinatarios: [{ id: "d1", ativo: true }], escopos: [
    { contato_empresa_id: "d1", unidade_escopo_id: "u1", categoria: "fechamento_operacional_diario", origem_autorizacao: "CONVITE_OTP", habilitado: true, suspenso_em: null, notificar_correcao: true },
    { contato_empresa_id: "d1", unidade_escopo_id: "u1", categoria: "resumo_semanal", origem_autorizacao: "CONVITE_OTP", habilitado: true, suspenso_em: null }] }),
  listarConsentimentos: async () => [{ contato_empresa_id: "d1", categoria: "fechamento_operacional_diario", acao: "CONCEDIDO" }, { contato_empresa_id: "d1", categoria: "resumo_semanal", acao: "CONCEDIDO" }], ...extra,
});
const unidade = (over = {}) => ({ organizacaoId: "o1", unidadeId: "u1", unidadeNome: "Unidade X", fusoUnidade: null, integracao: VIVA, modulosEfetivos: ["checklist_operacional"], ...over });
const servicoFake = () => { const provider = criarFakeProvider(); return { provider, servico: criarWhatsAppService({ provider, semGateIdentidade: true, semGateModo: true }) }; };
const lerViva = (i = VIVA) => async () => i;

describe("janela de envio (fuso da unidade)", () => {
  test("dentro de 08–20h local: disponível já; antes: aguarda 08:00; depois: aguarda o 08:00 do dia seguinte; nunca expira antes de começar", () => {
    const sp = "America/Sao_Paulo";
    const w1 = janelaDeEnvio(Date.parse("2026-10-28T12:00:00Z"), sp); assert.equal(w1.disponivelEm.toISOString(), "2026-10-28T12:00:00.000Z"); assert.equal(w1.expiraEm.toISOString(), "2026-10-28T23:00:00.000Z");
    const w2 = janelaDeEnvio(Date.parse("2026-10-28T08:00:00Z"), sp); assert.equal(w2.disponivelEm.toISOString(), "2026-10-28T11:00:00.000Z");
    const w3 = janelaDeEnvio(Date.parse("2026-10-29T01:00:00Z"), sp); assert.equal(w3.disponivelEm.toISOString(), "2026-10-29T11:00:00.000Z"); assert.ok(w3.expiraEm > w3.disponivelEm);
    const w4 = janelaDeEnvio(Date.parse("2026-10-28T12:00:00Z"), "America/Manaus"); assert.equal(w4.disponivelEm.toISOString(), "2026-10-28T12:00:00.000Z");   // 08:00 em Manaus
    const w5 = janelaDeEnvio(Date.parse("2026-10-28T11:00:00Z"), "America/Manaus"); assert.equal(w5.disponivelEm.toISOString(), "2026-10-28T12:00:00.000Z");   // 07:00 local → 08:00
  });
});

describe("integração momentaneamente fora × desconexão real × ausência legítima de pedidos", () => {
  test("coletor parado AGORA adia (não descarta); autorização do iFood expirada, não ativada e não verificada bloqueiam", () => {
    assert.deepEqual(classificarIntegracao({ estado: "desatualizado", motivo: "recebimento_parado" }), { bloqueia: false, adiavel: true, motivo: MOTIVO.INTEGRACAO_INDISPONIVEL_NO_MOMENTO });
    assert.equal(classificarIntegracao({ estado: "desatualizado", motivo: "reautorizacao_necessaria" }).bloqueia, true);
    assert.equal(classificarIntegracao({ estado: "nao_ativada", motivo: "recebimento_desligado" }).motivo, MOTIVO.INTEGRACAO_NAO_ATIVADA);
    assert.equal(classificarIntegracao(null).motivo, MOTIVO.INTEGRACAO_NAO_VERIFICADA);
  });
  test("dia FECHADO com cobertura é elegível mesmo com o coletor parado agora (adiar); dia sem pedidos com integração viva = SEM_PEDIDOS; falha histórica = DADOS_INSUFICIENTES", () => {
    const M = ["checklist_operacional"]; const parado = { estado: "desatualizado", motivo: "recebimento_parado" };
    assert.deepEqual(elegibilidadeDiaria({ modulosEfetivos: M, integracao: parado, fechamento: fech("2026-10-27") }), { elegivel: true, motivo: MOTIVO.INTEGRACAO_INDISPONIVEL_NO_MOMENTO, adiar: true });
    const zero = fech("2026-10-27"); zero.indicadores.pedidos.recebidos = 0;
    assert.equal(elegibilidadeDiaria({ modulosEfetivos: M, integracao: VIVA, fechamento: zero }).motivo, MOTIVO.SEM_PEDIDOS);
    assert.equal(elegibilidadeDiaria({ modulosEfetivos: M, integracao: parado, fechamento: zero }).motivo, MOTIVO.SEM_PEDIDOS);
    assert.equal(elegibilidadeDiaria({ modulosEfetivos: M, integracao: VIVA, fechamento: { ...zero, status: "INCOMPLETO", cobertura: { semSinalDeRecebimento: true } } }).motivo, MOTIVO.DADOS_INSUFICIENTES);
  });
});

describe("enfileiramento diário e semanal", () => {
  test("DIÁRIO: um item por destinatário autorizado, com chave por fechamento; repetir o ciclo não duplica", async () => {
    const R = repoMemoria({ fechamentos: [fech("2026-10-27")] });
    const a = await enfileirarRelatoriosDaUnidade(unidade(), { agora: AGORA, deps: { relatorios: R, notificacoes: notifFake() } });
    assert.equal(a.diario.enfileirados, 1); assert.equal(a.semanal.motivo, "NAO_E_SEGUNDA");
    const it = [...R.itens.values()][0]; assert.equal(it.chave_idempotencia, "wa:rel:diario:f-2026-10-27:d1:inicial"); assert.equal(it.referencia, "2026-10-27");
    const b = await enfileirarRelatoriosDaUnidade(unidade(), { agora: AGORA, deps: { relatorios: R, notificacoes: notifFake() } });
    assert.equal(b.diario.enfileirados, 0); assert.equal(R.itens.size, 1);
  });
  test("REVISADO gera 'correção' só para quem marcou avisar correções; a versão nova tem chave própria", async () => {
    const R = repoMemoria({ fechamentos: [fech("2026-10-27", { versao: 2, status: "REVISADO", id: "f-rev" })] });
    const sem = notifFake({ listarDestinatarios: async () => ({ destinatarios: [{ id: "d1", ativo: true }], escopos: [{ contato_empresa_id: "d1", unidade_escopo_id: "u1", categoria: "fechamento_operacional_diario", origem_autorizacao: "CONVITE_OTP", habilitado: true, suspenso_em: null, notificar_correcao: false }] }) });
    assert.equal((await enfileirarRelatoriosDaUnidade(unidade(), { agora: AGORA, deps: { relatorios: R, notificacoes: sem } })).diario.motivo, MOTIVO.SEM_DESTINATARIO);
    const com = await enfileirarRelatoriosDaUnidade(unidade(), { agora: AGORA, deps: { relatorios: R, notificacoes: notifFake() } });
    assert.equal(com.diario.enfileirados, 1); assert.match([...R.itens.values()][0].chave_idempotencia, /f-rev:d1:correcao$/);
  });
  test("não enfileira: integração desconectada, módulo ausente, fechamento PRELIMINAR/INCOMPLETO, sem pedidos", async () => {
    const d = (over, f) => enfileirarRelatoriosDaUnidade(unidade(over), { agora: AGORA, deps: { relatorios: repoMemoria({ fechamentos: f }), notificacoes: notifFake() } });
    assert.equal((await d({ integracao: { estado: "nao_ativada", motivo: "sem_loja_vinculada" } }, [fech("2026-10-27")])).diario.motivo, MOTIVO.INTEGRACAO_NAO_ATIVADA);
    assert.equal((await d({ modulosEfetivos: ["ifood"] }, [fech("2026-10-27")])).diario.motivo, MOTIVO.SEM_MODULO);
    assert.equal((await d({}, [fech("2026-10-27", { status: "PRELIMINAR" })])).diario.motivo, MOTIVO.DADOS_INSUFICIENTES);
    const zero = fech("2026-10-27"); zero.indicadores.pedidos.recebidos = 0;
    assert.equal((await d({}, [zero])).diario.motivo, MOTIVO.SEM_PEDIDOS);
  });
  test("SEMANAL: só na segunda-feira LOCAL; usa a semana encerrada; idempotente", async () => {
    const dias = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"].map((c) => fech(c));
    const seg = () => new Date("2026-11-02T13:00:00.000Z");                         // segunda 10:00 em SP
    const R = repoMemoria({ fechamentos: dias });
    const a = await enfileirarRelatoriosDaUnidade(unidade(), { agora: seg, deps: { relatorios: R, notificacoes: notifFake() } });
    assert.equal(a.semanal.enfileirados, 1); const it = [...R.itens.values()].find((i) => i.tipo === "semanal");
    assert.equal(it.referencia, "2026-10-26"); assert.match(it.chave_idempotencia, /^wa:sem:u1:2026-10-26:d1:/);
    assert.equal((await enfileirarRelatoriosDaUnidade(unidade(), { agora: seg, deps: { relatorios: R, notificacoes: notifFake() } })).semanal.enfileirados, 0);
    // domingo à noite em SP ainda é domingo (UTC já é segunda): NÃO gera
    const domingoNoite = () => new Date("2026-11-02T01:30:00.000Z");
    assert.equal((await enfileirarRelatoriosDaUnidade(unidade(), { agora: domingoNoite, deps: { relatorios: repoMemoria({ fechamentos: dias }), notificacoes: notifFake() } })).semanal.motivo, "NAO_E_SEGUNDA");
    // semana com poucos dias válidos: dados insuficientes, nada enfileirado
    const poucos = await enfileirarRelatoriosDaUnidade(unidade(), { agora: seg, deps: { relatorios: repoMemoria({ fechamentos: dias.slice(0, 3) }), notificacoes: notifFake() } });
    assert.deepEqual([poucos.semanal.enfileirados, poucos.semanal.motivo], [0, MOTIVO.DADOS_INSUFICIENTES]);
  });
});

describe("despacho pelo gateway simulado", () => {
  async function comItem(over = {}) {
    const R = repoMemoria({ fechamentos: [fech("2026-10-27")], ...over });
    await enfileirarRelatoriosDaUnidade(unidade(), { agora: AGORA, deps: { relatorios: R, notificacoes: notifFake() } });
    return R;
  }
  const rodar = (R, { env = ENV_ON, servico, integracao = VIVA, aud = [] } = {}) => processarFilaRelatorios({ agora: AGORA, env, worker: "w1", deps: { relatorios: R, servico, lerIntegracao: lerViva(integracao), auditar: async (e) => { aud.push(e); } } });

  test("DESLIGADO por padrão: nada é lido nem enviado", async () => {
    const R = await comItem(); const { provider, servico } = servicoFake();
    assert.equal(relatoriosEnvioHabilitado({}), false);
    assert.equal((await rodar(R, { env: {}, servico })).desligado, true); assert.equal(provider.mensagensEnviadas.length, 0);
    assert.equal((await rodar(R, { env: { NOTIFICACOES_RELATORIOS_ENVIO_HABILITADO: "true" }, servico })).motivo, "ALLOWLIST_OBRIGATORIA");
    assert.equal((await processarFilaRelatorios({ agora: AGORA, env: ENV_ON, deps: { relatorios: R } })).motivo, "GATEWAY_NAO_CONFIGURADO");
  });
  test("fluxo feliz: UMA mensagem com o relatório, ENVIADO com provider id e auditoria sem telefone nem texto; repetir o despacho não reenvia", async () => {
    const R = await comItem(); const { provider, servico } = servicoFake(); const aud = [];
    const r = await rodar(R, { servico, aud });
    assert.deepEqual(r.resultados.map((x) => x.resultado), ["ENVIADO"]);
    assert.equal(provider.mensagensEnviadas.length, 1); assert.equal(provider.mensagensEnviadas[0].telefoneE164, TEL);
    assert.match(provider.mensagensEnviadas[0].texto, /Fechamento operacional/); assert.equal(provider.mensagensEnviadas[0].idempotencyKey, "wa:rel:diario:f-2026-10-27:d1:inicial");
    assert.ok([...R.itens.values()][0].provider_message_id);
    assert.equal(aud.length, 1); assert.doesNotMatch(JSON.stringify(aud), /\+55|Fechamento operacional/);
    await rodar(R, { servico }); assert.equal(provider.mensagensEnviadas.length, 1);
  });
  test("autorização revogada entre o enfileiramento e o envio: BLOQUEADO, nada sai", async () => {
    const R = await comItem(); const { provider, servico } = servicoFake(); R.aut.autorizado = false; R.aut.motivo = "SEM_CONSENTIMENTO_VIGENTE";
    assert.deepEqual((await rodar(R, { servico })).resultados.map((x) => [x.resultado, x.motivo]), [["BLOQUEADO", "SEM_CONSENTIMENTO_VIGENTE"]]); assert.equal(provider.mensagensEnviadas.length, 0);
  });
  test("número fora da lista autorizada: o item AGUARDA (não é descartado nem enviado)", async () => {
    const R = await comItem(); const { provider, servico } = servicoFake();
    const r = await rodar(R, { servico, env: { ...ENV_ON, NOTIFICACOES_RELATORIOS_ALLOWLIST_E164: "+5511900000000" } });
    assert.deepEqual(r.resultados.map((x) => [x.resultado, x.motivo]), [["AGUARDANDO", "FORA_DA_LISTA_AUTORIZADA"]]); assert.equal([...R.itens.values()][0].status, "PENDENTE"); assert.equal(provider.mensagensEnviadas.length, 0);
  });
  test("coletor parado AGORA: o relatório do dia fechado AGUARDA e sai quando a integração volta; autorização do iFood expirada BLOQUEIA", async () => {
    const R = await comItem(); const { provider, servico } = servicoFake();
    const parado = { estado: "desatualizado", motivo: "recebimento_parado" };
    assert.equal((await rodar(R, { servico, integracao: parado })).resultados[0].resultado, "AGUARDANDO"); assert.equal(provider.mensagensEnviadas.length, 0);
    assert.equal((await rodar(R, { servico, integracao: VIVA })).resultados[0].resultado, "ENVIADO"); assert.equal(provider.mensagensEnviadas.length, 1);
    const R2 = await comItem(); const r2 = await rodar(R2, { servico, integracao: { estado: "desatualizado", motivo: "reautorizacao_necessaria" } });
    assert.deepEqual([r2.resultados[0].resultado, r2.resultados[0].motivo], ["BLOQUEADO", MOTIVO.INTEGRACAO_DESCONECTADA]);
  });
  test("falha PRÉ-envio: RETRY (volta a PENDENTE); falha AMBÍGUA: INCERTO e nunca reenvia; permanente: FALHOU", async () => {
    const R1 = await comItem(); const a = servicoFake(); a.provider.falharProximoEnvio({ mensagem: "recusou", preEnvio: true });
    assert.equal((await rodar(R1, { servico: a.servico })).resultados[0].resultado, "RETRY"); assert.equal([...R1.itens.values()][0].status, "PENDENTE");
    const R2 = await comItem(); const b = servicoFake(); b.provider.falharProximoEnvio({ mensagem: "timeout" });
    assert.equal((await rodar(R2, { servico: b.servico })).resultados[0].resultado, "INCERTO"); assert.equal([...R2.itens.values()][0].status, "INCERTO");
    await rodar(R2, { servico: b.servico }); assert.equal(b.provider.mensagensEnviadas.length, 0, "INCERTO nunca é reenviado");
    const R3 = await comItem(); const c = servicoFake(); c.provider.falharProximoEnvio({ mensagem: "número inválido", permanente: true });
    assert.equal((await rodar(R3, { servico: c.servico })).resultados[0].resultado, "FALHOU");
  });
  test("cota diária por destinatário e categoria (NOTIFICACOES_RELATORIOS_MAX_DIA)", async () => {
    const R = repoMemoria({ fechamentos: [fech("2026-10-27"), fech("2026-10-26")] });
    await enfileirarRelatoriosDaUnidade(unidade(), { agora: AGORA, deps: { relatorios: R, notificacoes: notifFake() } });
    [...R.itens.values()].forEach((i) => { i.id = i.id; }); const extra = { ...[...R.itens.values()][0], id: "x2", chave_idempotencia: "outra", status: "PENDENTE" }; R.itens.set("x2", extra);
    const { provider, servico } = servicoFake();
    const r = await rodar(R, { servico, env: { ...ENV_ON, NOTIFICACOES_RELATORIOS_MAX_DIA: "1" } });
    assert.deepEqual(r.resultados.map((x) => x.resultado), ["ENVIADO", "COTA_DIA"]); assert.equal(provider.mensagensEnviadas.length, 1);
  });
  test("dois despachantes simultâneos: o relatório sai UMA vez só", async () => {
    const R = await comItem(); const { provider, servico } = servicoFake();
    const um = (w) => processarFilaRelatorios({ agora: AGORA, env: ENV_ON, worker: w, deps: { relatorios: R, servico, lerIntegracao: lerViva(), auditar: async () => {} } });
    await Promise.all([um("wA"), um("wB")]); assert.equal(provider.mensagensEnviadas.length, 1);
  });
});

describe("agendador", () => {
  test("não inicia sem NOTIFICACOES_RELATORIOS_AGENDADOR_HABILITADO; com a flag, usa o temporizador injetado; nunca sobrepõe ciclos", async () => {
    assert.equal(agendadorRelatoriosPermitido({}), false);
    assert.throws(() => criarAgendadorRelatorios({ env: {} }).iniciar(), /recusado/);
    let tick = null; const t = { set: (fn) => { tick = fn; return { unref() {} }; }, clear: () => { tick = null; } };
    let chamadas = 0; let libera;
    const ag = criarAgendadorRelatorios({ env: { NOTIFICACOES_RELATORIOS_AGENDADOR_HABILITADO: "true" }, temporizador: t, deps: { candidatas: async () => { chamadas++; await new Promise((r) => { libera = r; }); return []; }, funil: async () => ({ elegiveis: [], recusadas: [] }), gerar: async () => [], despachar: async () => ({ desligado: true }) } });
    ag.iniciar(); assert.ok(tick);
    const c1 = tick(); const c2 = await tick(); assert.equal(c2, null, "ciclo sobreposto é ignorado"); libera(); await c1; assert.equal(chamadas, 1);
    ag.parar(); assert.equal(tick, null);
  });
  test("ciclo: só gera fechamento e enfileira para unidades elegíveis; as recusadas voltam com o motivo; envio desligado por padrão", async () => {
    const visto = { gerar: null, enfileirar: [] };
    const r = await executarCicloRelatorios({ agora: AGORA, env: {}, deps: {
      candidatas: async () => [{ organizacaoId: "o1", unidadeId: "uOK" }, { organizacaoId: "o1", unidadeId: "uSem" }],
      funil: async () => ({ elegiveis: [{ organizacaoId: "o1", unidadeId: "uOK", integracao: VIVA }], recusadas: [{ organizacaoId: "o1", unidadeId: "uSem", motivo: MOTIVO.INTEGRACAO_NAO_ATIVADA }] }),
      gerar: async (p) => { visto.gerar = p.unidades.map((u) => u.unidadeId); return []; },
      enfileirar: async (u) => { visto.enfileirar.push(u.unidadeId); if (u.unidadeId === "boom") throw new Error("x"); return { unidadeId: u.unidadeId }; },
    } });
    assert.deepEqual(visto.gerar, ["uOK"]); assert.deepEqual(visto.enfileirar, ["uOK"]);
    assert.deepEqual(r.recusadas, [{ unidadeId: "uSem", motivo: MOTIVO.INTEGRACAO_NAO_ATIVADA }]); assert.equal(r.envio.desligado, true);
  });
});
