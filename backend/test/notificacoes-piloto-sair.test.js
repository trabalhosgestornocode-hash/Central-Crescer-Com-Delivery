// Piloto da Central: trava de convites por unidade, SAIR endurecido (+ confirmação) e o fluxo completo em ambiente ISOLADO.
// Tudo sintético: provider falso, reservas e banco em memória, nenhum envio real, nenhum dado pessoal. As regras do banco (gatilho da 139,
// revogação) estão provadas em testes-seguros/pg/piloto_139.sh.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.NOTIFICACOES_SEGREDO_MESTRE = "segredo-de-teste-da-central-0123456789abcdef";
const svc = await import("../src/modules/notificacoes/notificacoes.service.js");
const titular = await import("../src/modules/notificacoes/notificacoes.titular.service.js");
const envio = await import("../src/modules/notificacoes/notificacoes.envio.js");
const repoReal = await import("../src/modules/notificacoes/notificacoes.repository.js");
const seg = await import("../src/modules/notificacoes/notificacoes.segredos.js");
const basico = await import("../src/modules/notificacoes/notificacoes.basico.js");
const otp = await import("../src/modules/comunicacao/comunicacao.otp.js");
const { criarWhatsAppService } = await import("../src/modules/comunicacao/whatsapp.service.js");
const { criarFakeProvider } = await import("../src/modules/comunicacao/providers/fake.provider.js");
const { cenario, escopoGerente, escopoAdmin, reqFalso, ORG_A, ORG_B, UN } = await import("./helpers/notificacoes-fake.js");

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NUM = "+5511912345678";
const OUTRO = "+5511977776666";
const GW = { WHATSAPP_GATEWAY_URL: "http://127.0.0.1:9", WHATSAPP_GATEWAY_SECRET: "segredo-gateway-ficticio" };
const BAILEYS = { NOTIFICACOES_OTP_TRANSPORTE: "baileys", NOTIFICACOES_OTP_BAILEYS_AUTORIZADO: "true", NODE_ENV: "production", NOTIFICACOES_OTP_BAILEYS_ALLOWLIST_E164: NUM, ...GW };

// ---------------------------------------------------------------------------------------------------------------------------
describe("convites: trava por UNIDADE do piloto (backend; o banco repete a regra na 139)", () => {
  const corpo = (un) => ({ nome: "Carla", telefone: "(11) 98888-7777", unidades: un, categorias: ["fechamento_operacional_diario"] });
  const dps = (repo, extra = {}) => ({ repo, auditar: async () => {}, env: { NOTIFICACOES_CONVITES_HABILITADOS: "true", ...extra } });
  const criar = (repo, un, extra, escopo = escopoAdmin()) => svc.criarConvite({ req: reqFalso, escopo, corpo: corpo(un), baseUrl: "https://app", deps: dps(repo, extra) });
  const recusa = (codigo) => (e) => e.statusCode === 403 && JSON.stringify(e).includes(codigo);

  test("fail-closed por padrão: sem piloto configurado NINGUÉM convida e nada é gravado", async () => {
    const { repo, db } = cenario();
    await assert.rejects(criar(repo, [UN.A1]), recusa("PILOTO_NAO_CONFIGURADO"));
    assert.equal(db.convites.length, 0);
  });
  test("com o piloto [A1]: A1 passa; A2 e a mistura A1+A2 são recusadas ANTES de gravar", async () => {
    const { repo, db } = cenario(); db.piloto = [UN.A1];
    assert.ok((await criar(repo, [UN.A1])).link.includes("#t="));
    await assert.rejects(criar(repo, [UN.A2]), recusa("UNIDADE_FORA_DO_PILOTO"));
    await assert.rejects(criar(repo, [UN.A1, UN.A2]), recusa("UNIDADE_FORA_DO_PILOTO"));
    assert.equal(db.convites.length, 1);
  });
  test("piloto vazio = ninguém (fail-closed); ids em maiúsculas são aceitos", async () => {
    const { repo, db } = cenario(); db.piloto = [];
    await assert.rejects(criar(repo, [UN.A1]), recusa("UNIDADE_FORA_DO_PILOTO"));
    db.piloto = [UN.A1.toUpperCase()];
    assert.ok((await criar(repo, [UN.A1])).id);
  });
  test("EXIGE_PILOTO=false (disponibilidade geral, decisão própria): sem chave libera; com chave AINDA restringe", async () => {
    const { repo, db } = cenario();
    assert.ok((await criar(repo, [UN.A2], { NOTIFICACOES_CONVITES_EXIGE_PILOTO: "false" })).id);
    db.piloto = [UN.A1];
    await assert.rejects(criar(repo, [UN.A2], { NOTIFICACOES_CONVITES_EXIGE_PILOTO: "false" }), recusa("UNIDADE_FORA_DO_PILOTO"));
  });
  test("o gerente de outra unidade continua barrado pelo alcance (D-3) antes mesmo do piloto; gerente do piloto convida só a própria", async () => {
    const { repo, db } = cenario(); db.piloto = [UN.A1];
    await assert.rejects(criar(repo, [UN.A1], {}, escopoGerente(UN.A2)), (e) => e.statusCode === 403 && /sua unidade/.test(e.message));
    assert.ok((await criar(repo, [UN.A1], {}, escopoGerente(UN.A1))).id);
  });
  test("repositório: chave ausente = null; array válido = ids; formato inválido/elemento não-uuid = [] (fail-closed); erro do banco propaga", async () => {
    const cliente = (resp) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => resp }) }) }) });
    const ler = (resp) => repoReal.unidadesDoPiloto({ supabase: cliente(resp) });
    assert.equal(await ler({ data: null, error: null }), null);
    assert.deepEqual(await ler({ data: { valor: [UN.A1.toUpperCase()] }, error: null }), [UN.A1]);
    for (const v of ["texto", { a: 1 }, 7, [UN.A1, "nao-e-uuid"], [1]]) assert.deepEqual(await ler({ data: { valor: v }, error: null }), [], JSON.stringify(v));
    await assert.rejects(ler({ data: null, error: { message: "x", code: "XX" } }));
  });
  test("migration 139: gatilho no INSERT, fail-closed, não liga o piloto e não toca na fila do D-1", () => {
    const sql = readFileSync(path.join(RAIZ, "../database/migrations/139_notificacoes_convites_piloto.sql"), "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    assert.match(sql, /before insert on comunicacao_convites/i);
    assert.match(sql, /errcode = '42501'/);
    assert.doesNotMatch(sql, /insert\s+into\s+comunicacao_configuracoes/i, "ligar o piloto é um ato de dados com autorização própria");
    assert.doesNotMatch(sql, /comunicacao_mensagens|update\s+comunicacao_convites|delete\s+from/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("allowlist OBRIGATÓRIA no OTP e na confirmação (padrão fail-closed)", () => {
  const sv = () => { const provider = criarFakeProvider(); return { provider, servico: criarWhatsAppService({ provider, semGateIdentidade: true, modoAtual: async () => "NORMAL" }) }; };
  const repo = () => ({ reservarEnvioOtp: async () => "RESERVADO", registrarResultadoOtp: async () => true });
  test("sem lista (ou lista inválida) nenhum OTP sai; só EXIGE_ALLOWLIST=false dispensa", async () => {
    for (const lista of [undefined, "", "abc,123"]) {
      const { provider, servico } = sv(); const env = { ...BAILEYS, NOTIFICACOES_OTP_BAILEYS_ALLOWLIST_E164: lista };
      const r = await otp.enviarOtpBaileys({ desafioId: "d1", telefoneE164: NUM, codigo: "123456" }, { env, repo: repo(), obterServico: async () => servico });
      assert.deepEqual([r.entregue, r.motivo, provider.mensagensEnviadas.length], [false, "ALLOWLIST_OBRIGATORIA", 0], String(lista));
    }
    const { provider, servico } = sv();
    const livre = await otp.enviarOtpBaileys({ desafioId: "d2", telefoneE164: NUM, codigo: "123456" }, { env: { ...BAILEYS, NOTIFICACOES_OTP_BAILEYS_ALLOWLIST_E164: undefined, NOTIFICACOES_OTP_BAILEYS_EXIGE_ALLOWLIST: "false" }, repo: repo(), obterServico: async () => servico });
    assert.deepEqual([livre.entregue, provider.mensagensEnviadas.length], [true, 1]);
  });
  test("a confirmação do SAIR respeita a mesma lista", async () => {
    const { provider, servico } = sv();
    const f = (tel, env) => otp.enviarConfirmacaoSaidaBaileys({ telefoneE164: tel, chave: "abcdef012345:2026-10-31" }, { env, obterServico: async () => servico });
    assert.equal((await f(OUTRO, BAILEYS)).motivo, "FORA_DA_LISTA_AUTORIZADA");
    assert.equal((await f(NUM, { ...BAILEYS, NOTIFICACOES_OTP_BAILEYS_ALLOWLIST_E164: undefined })).motivo, "ALLOWLIST_OBRIGATORIA");
    assert.equal(provider.mensagensEnviadas.length, 0);
    assert.deepEqual([(await f(NUM, BAILEYS)).enviada, provider.mensagensEnviadas[0].idempotencyKey], [true, "saida:abcdef012345:2026-10-31"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("SAIR: revogação pelo WhatsApp (isolamento, idempotência, confirmação e auditoria)", () => {
  const ON = { NOTIFICACOES_PALAVRA_CHAVE_SAIR: "true" };
  function montar() {
    titular._limparSaidas();
    const st = { out: new Set(), revogacoes: [], audit: [] };
    const D = [
      { id: "ce-a1", organizacao_id: ORG_A, nome: "x", ativo: true, tel: NUM }, { id: "ce-b1", organizacao_id: ORG_B, nome: "y", ativo: true, tel: NUM },
      { id: "ce-a2", organizacao_id: ORG_A, nome: "z", ativo: true, tel: OUTRO },
    ];
    const repo = {
      destinatariosDoNumero: async (e164) => D.filter((d) => d.tel === e164).map(({ tel, ...d }) => d),
      jaSaiuDeTudo: async (ids) => ids.every((i) => st.out.has(i)),
      revogar: async (p) => { st.revogacoes.push(p); p.contatosEmpresa.forEach((i) => st.out.add(i)); return { resultado: "REVOGADO", mensagens_canceladas: 3 }; },
    };
    const deps = { repo, auditar: async (e) => st.audit.push(e) };
    return { st, repo, deps };
  }
  const agora = Date.now();
  const recente = new Date(agora - 1_000).toISOString();
  const roda = (m, extra = {}) => titular.processarPalavraDeSaida({ telefoneE164: NUM, texto: "SAIR", recebidoEm: recente, env: ON, agora: () => agora, deps: m.deps, ...extra });

  test("desligada por padrão; só palavra exata ('cancelar' e frases não revogam)", async () => {
    const m = montar();
    assert.equal((await titular.processarPalavraDeSaida({ telefoneE164: NUM, texto: "SAIR", env: {}, deps: m.deps })).aplicado, false);
    for (const t of ["cancelar", "quero sair do grupo", "não sair", "ok", "SAIR da loja"]) assert.equal((await roda(m, { texto: t })).aplicado, false, t);
    assert.equal(m.st.revogacoes.length, 0);
  });
  test("mensagem antiga (>48 h), futura ou sem data válida não revoga; recente revoga", async () => {
    const m = montar();
    for (const quando of [new Date(agora - 49 * 3_600_000).toISOString(), new Date(agora + 3_600_000).toISOString(), "ontem", NaN, null, undefined, 0]) {
      assert.deepEqual([(await roda(m, { recebidoEm: quando })).aplicado, (await roda(m, { recebidoEm: quando })).motivo], [false, "MENSAGEM_FORA_DA_JANELA"], String(quando));
    }
    assert.equal(m.st.revogacoes.length, 0);
    assert.equal((await roda(m, { recebidoEm: new Date(agora - 3_600_000).toISOString() })).aplicado, true);
  });
  test("número não cadastrado, ou inválido, não revoga nada", async () => {
    const m = montar();
    assert.equal((await roda(m, { telefoneE164: "+5511900000009" })).aplicado, false);
    assert.equal((await roda(m, { telefoneE164: "123" })).aplicado, false);
    assert.equal(m.st.revogacoes.length, 0);
  });
  test("ISOLAMENTO: revoga só os registros DESTE número (as duas empresas que o cadastraram) e nunca o de outro número", async () => {
    const m = montar();
    const r = await roda(m);
    assert.equal(r.aplicado, true);
    assert.deepEqual([...m.st.revogacoes[0].contatosEmpresa].sort(), ["ce-a1", "ce-b1"]);
    assert.ok(!m.st.out.has("ce-a2"), "outro número intacto");
    assert.deepEqual([m.st.revogacoes[0].origem, m.st.revogacoes[0].sairDeTudo, m.st.revogacoes[0].categorias], ["palavra_chave_inbound", true, null]);
  });
  test("AUDITORIA: 1 evento por empresa, sem número, sem dado de outra empresa", async () => {
    const m = montar(); await roda(m);
    assert.deepEqual(m.st.audit.map((e) => e.organizacaoId).sort(), [ORG_A, ORG_B].sort());
    for (const e of m.st.audit) {
      const j = JSON.stringify(e);
      assert.ok(!j.includes("9123") && !j.includes(NUM) && !j.includes(OUTRO), "sem telefone");
      assert.ok(!j.includes(e.organizacaoId === ORG_A ? ORG_B : ORG_A), "sem dado de outra empresa");
      assert.deepEqual([e.detalhes.origem, e.detalhes.sair_de_tudo], ["palavra_chave", true]);
    }
  });
  test("IDEMPOTENTE: repetir SAIR não grava de novo nem confirma de novo (aguarde 10 min; depois, já saiu)", async () => {
    const m = montar(); const conf = [];
    const dps = { ...m.deps, enviarConfirmacaoSaida: async (a) => { conf.push(a); return { enviada: true }; } };
    assert.equal((await roda({ deps: dps })).aplicado, true);
    assert.deepEqual([(await roda({ deps: dps })).motivo], ["AGUARDE"]);
    const depois = await roda({ deps: dps }, { agora: () => agora + titular.INTERVALO_SAIDA_MS + 1 });
    assert.deepEqual([depois.aplicado, depois.motivo], [false, "JA_SAIU"]);
    assert.deepEqual([m.st.revogacoes.length, conf.length], [1, 1]);
  });
  test("CONFIRMAÇÃO: desligada por padrão; ligada envia UMA mensagem curta; falha nunca derruba a revogação", async () => {
    const m1 = montar();
    assert.equal((await roda(m1)).confirmacao, "CONFIRMACAO_DESLIGADA");
    const { provider, servico } = (() => { const p = criarFakeProvider(); return { provider: p, servico: criarWhatsAppService({ provider: p, semGateIdentidade: true, modoAtual: async () => "NORMAL" }) }; })();
    const env = { ...ON, ...BAILEYS, NOTIFICACOES_SAIR_CONFIRMACAO: "true" };
    const via = (e) => (a, b) => envio.enviarConfirmacaoSaida(a, { env: b.env, enviar: (x, o) => otp.enviarConfirmacaoSaidaBaileys(x, { ...o, obterServico: async () => e }) });
    const m2 = montar(); m2.deps.enviarConfirmacaoSaida = via(servico);
    const r2 = await titular.processarPalavraDeSaida({ telefoneE164: NUM, texto: "Sair.", recebidoEm: recente, env, agora: () => agora, deps: m2.deps });
    assert.deepEqual([r2.aplicado, r2.confirmacao, provider.mensagensEnviadas.length], [true, "ENVIADA", 1]);
    assert.match(provider.mensagensEnviadas[0].texto, /não receberá mais avisos/);
    const m3 = montar(); const quebrado = { enviarTexto: async () => { throw new Error("socket hang up"); } }; m3.deps.enviarConfirmacaoSaida = via(quebrado);
    const r3 = await titular.processarPalavraDeSaida({ telefoneE164: NUM, texto: "SAIR", recebidoEm: recente, env, agora: () => agora, deps: m3.deps });
    assert.deepEqual([r3.aplicado, r3.confirmacao], [true, "ENTREGA_INCERTA"]);
    assert.equal(m3.st.revogacoes.length, 1);
    const m4 = montar(); m4.deps.enviarConfirmacaoSaida = async () => { throw new Error("falha inesperada"); };
    assert.deepEqual([(await titular.processarPalavraDeSaida({ telefoneE164: NUM, texto: "SAIR", recebidoEm: recente, env, agora: () => agora, deps: m4.deps })).confirmacao], ["ERRO_INESPERADO"]);
  });
  test("confirmação exige o transporte baileys autorizado (sem ele, nada sai mesmo com a flag)", async () => {
    let n = 0;
    const r = await envio.enviarConfirmacaoSaida({ telefoneE164: NUM, chave: "abcdef012345:2026-10-31" }, { env: { NOTIFICACOES_SAIR_CONFIRMACAO: "true" }, enviar: async () => { n++; return { enviada: true }; } });
    assert.deepEqual([r.enviada, r.motivo, n], [false, "TRANSPORTE_DESLIGADO", 0]);
  });
  test("falha transitória na revogação NÃO trava a próxima tentativa (o carimbo de aguarde só vale depois do sucesso)", async () => {
    const m = montar(); const original = m.repo.revogar; let primeira = true;
    m.repo.revogar = async (p) => { if (primeira) { primeira = false; throw new Error("banco indisponível"); } return original(p); };
    await assert.rejects(roda(m));                                    // o inbox engole a exceção; aqui ela aparece
    const de_novo = await roda(m);                                    // mesma hora: NÃO pode ser AGUARDE
    assert.deepEqual([de_novo.aplicado, m.st.revogacoes.length], [true, 1]);
  });
  test("sem o instante da mensagem (ausente/nulo) o SAIR não revoga (fail-closed)", async () => {
    const m = montar();
    for (const recebidoEm of [undefined, null]) assert.equal((await roda(m, { recebidoEm })).motivo, "MENSAGEM_FORA_DA_JANELA");
    assert.equal(m.st.revogacoes.length, 0);
  });
  test("a chave da confirmação é POR MENSAGEM (sair, voltar e sair de novo no mesmo dia gera confirmações distintas) e é válida", async () => {
    const chaves = [];
    for (const id of ["wamid.A", "wamid.B", "wamid.A"]) {
      const m = montar(); m.deps.enviarConfirmacaoSaida = async (a) => { chaves.push(a.chave); return { enviada: true }; };
      await roda(m, { mensagemId: id });
    }
    assert.ok(chaves[0] !== chaves[1] && chaves[0] === chaves[2], "mesma mensagem = mesma chave; mensagens diferentes = chaves diferentes");
    for (const c of chaves) assert.match(c, /^[0-9a-f]{24}:[0-9a-f]{16}$/);
  });
  test("o inbox repassa o instante e o id da mensagem ao tratamento do SAIR", () => {
    const s = readFileSync(path.join(RAIZ, "src/modules/comunicacao/comunicacao.inbox.service.js"), "utf8");
    assert.match(s, /processarPalavraDeSaida\)\(\{[^}]*recebidoEm: evento\.recebidoEm[^}]*mensagemId: evento\.providerMessageId/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("FLUXO COMPLETO em ambiente isolado: convite → OTP (Baileys simulado) → verificação → termo → categorias → SAIR → auditoria", () => {
  test("de ponta a ponta, sem dado pessoal na auditoria e sem envio real", async () => {
    const { repo: base, db } = cenario(); db.piloto = [UN.A1];
    const audit = []; const desafios = []; const consent = []; const out = new Set(); let revogou = null;
    const provider = criarFakeProvider();
    const servico = criarWhatsAppService({ provider, semGateIdentidade: true, modoAtual: async () => "NORMAL" });
    const reservas = new Map();
    const reservaRepo = { reservarEnvioOtp: async ({ desafioId }) => (reservas.has(desafioId) ? "JA_RESERVADO" : (reservas.set(desafioId, "ENVIANDO"), "RESERVADO")), registrarResultadoOtp: async ({ desafioId, status }) => { reservas.set(desafioId, status); return true; } };
    const entregar = (p, o) => envio.entregarCodigoOtp(p, { ...o, enviarBaileys: (x, op) => otp.enviarOtpBaileys(x, { ...op, repo: reservaRepo, obterServico: async () => servico }) });
    const repo = {
      ...base,
      obterConvitePorToken: async (h) => db.convites.find((c) => c.token_hash === h) ?? null,
      obterNomes: async () => ({ empresa: "Rede Teste", unidades: [{ id: UN.A1, nome: "Centro" }] }),
      termoVigente: async () => ({ versao: 2, texto: "Autorizo {empresa}…", rascunho: false }),
      criarDesafio: async (p) => { const d = { ...p, id: p.id ?? randomUUID(), tentativas: 0, consumido: false }; desafios.push(d); return { resultado: "CRIADO", desafio_id: d.id }; },
      verificarDesafio: async ({ desafioId, codigoHmac }) => { const d = desafios.find((x) => x.id === desafioId); if (!d || d.consumido) return { resultado: "INVALIDO" };
        if (d.codigoHmac !== codigoHmac) return { resultado: "INCORRETO", restantes: 4 }; d.consumido = true; db.convites[0].status = "VERIFICADO"; return { resultado: "VERIFICADO", simulado: false }; },
      consentir: async (p) => { consent.push(p); return { resultado: "CONSENTIDO", contato_empresa_id: "ce-novo", simulado: false }; },
      destinatariosDoNumero: async (e164) => (e164 === NUM && consent.length ? [{ id: "ce-novo", organizacao_id: ORG_A, nome: "Carla", ativo: true }] : []),
      jaSaiuDeTudo: async (ids) => ids.every((i) => out.has(i)),
      revogar: async (p) => { revogou = p; p.contatosEmpresa.forEach((i) => out.add(i)); return { resultado: "REVOGADO", mensagens_canceladas: 0 }; },
    };
    const dps = { repo, auditar: async (e) => audit.push(e), env: { ...BAILEYS, NOTIFICACOES_CONVITES_HABILITADOS: "true", NOTIFICACOES_PALAVRA_CHAVE_SAIR: "true", NOTIFICACOES_SAIR_CONFIRMACAO: "true" }, entregarCodigoOtp: entregar };

    // 1) o gestor do piloto convida (unidade do piloto; número é apenas máscara no resultado)
    const conv = await svc.criarConvite({ req: reqFalso, escopo: escopoGerente(UN.A1), corpo: { nome: "Carla", telefone: "(11) 91234-5678", unidades: [UN.A1], categorias: ["fechamento_operacional_diario"] }, baseUrl: "https://app", deps: dps });
    const token = conv.link.split("#t=")[1];
    assert.ok(basico.tokenValido(token));
    // 2) o titular abre e pede o código (Baileys simulado: o texto sai pelo whatsapp.service falso, UMA vez)
    const aberto = await titular.abrirConvite({ token, deps: dps });
    assert.equal(aberto.verificacaoDisponivel, true);
    const pedido = await titular.pedirCodigoConvite({ token, ip: "1.2.3.4", deps: dps });
    assert.equal(pedido.ok, true); assert.ok(!("codigo" in pedido));
    assert.equal(provider.mensagensEnviadas.length, 1);
    const codigo = provider.mensagensEnviadas[0].texto.match(/\b(\d{6})\b/)[1];
    // 3) verifica o telefone (posse) — sem consentimento ainda
    assert.equal((await titular.verificarCodigoConvite({ token, desafio: pedido.desafio, provisorio: pedido.provisorio, codigo, deps: dps })).resultado, "VERIFICADO");
    assert.equal(consent.length, 0, "verificar ≠ consentir");
    // 4) aceita o termo APROVADO e escolhe categorias → consentimento real (livro-razão)
    const c = await titular.consentirConvite({ token, desafio: pedido.desafio, categorias: ["fechamento_operacional_diario"], termoVersao: 2, ip: "1.2.3.4", userAgent: "teste", deps: dps });
    assert.equal(c.resultado, "CONSENTIDO");
    assert.equal(consent.length, 1);
    // 5) SAIR pelo WhatsApp: revoga, confirma uma vez e audita
    titular._limparSaidas();
    dps.enviarConfirmacaoSaida = (a, b) => envio.enviarConfirmacaoSaida(a, { env: b.env, enviar: (x, o) => otp.enviarConfirmacaoSaidaBaileys(x, { ...o, obterServico: async () => servico }) });
    const s = await titular.processarPalavraDeSaida({ telefoneE164: NUM, texto: "sair", recebidoEm: new Date().toISOString(), mensagemId: "wamid.FLUXO", env: dps.env, deps: dps });
    assert.deepEqual([s.aplicado, s.confirmacao, revogou.origem], [true, "ENVIADA", "palavra_chave_inbound"]);
    assert.equal(provider.mensagensEnviadas.length, 2, "1 OTP + 1 confirmação; nada mais saiu");
    // 6) auditoria da jornada: sem número, sem código
    const acoes = audit.map((e) => e.acao);
    for (const a of ["notificacao.convite_criado", "notificacao.titular_verificou_numero", "notificacao.titular_consentiu", "notificacao.titular_revogou"]) assert.ok(acoes.includes(a), a);
    const tudo = JSON.stringify(audit);
    assert.ok(!tudo.includes(codigo) && !tudo.includes("91234") && !tudo.includes(NUM), "auditoria sem código nem número");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("PADRÃO DE PRODUÇÃO (nenhuma variável nova definida): nada muda", () => {
  const PROD = { NODE_ENV: "production" };
  test("convites: desligados (503) — e, se ligados sem piloto, ninguém convida (403): nenhuma gravação nos dois casos", async () => {
    const { repo, db } = cenario();
    const base = { req: reqFalso, escopo: escopoAdmin(), corpo: { nome: "C", telefone: "(11) 98888-7777", unidades: [UN.A1], categorias: ["fechamento_operacional_diario"] }, baseUrl: "https://app" };
    await assert.rejects(svc.criarConvite({ ...base, deps: { repo, auditar: async () => {}, env: PROD } }), (e) => e.statusCode === 503 && JSON.stringify(e).includes("CONVITES_DESLIGADOS"));
    await assert.rejects(svc.criarConvite({ ...base, deps: { repo, auditar: async () => {}, env: { ...PROD, NOTIFICACOES_CONVITES_HABILITADOS: "true" } } }), (e) => e.statusCode === 403 && JSON.stringify(e).includes("PILOTO_NAO_CONFIGURADO"));
    assert.equal(db.convites.length, 0);
  });
  test("OTP desligado: nada é pedido nem enviado; baileys só com as duas chaves e, mesmo assim, sem lista nada sai", async () => {
    assert.equal(envio.modoTransporte(PROD), "desligado");
    assert.equal(envio.modoTransporte({ ...PROD, ...GW }), "desligado");
    const antes = envio.capacidades(PROD);
    assert.deepEqual(antes, { modo: "desligado", otp: false, simulado: false, envioReal: false });
    const r = await otp.enviarOtpBaileys({ desafioId: "d", telefoneE164: NUM, codigo: "123456" }, { env: { ...BAILEYS, NOTIFICACOES_OTP_BAILEYS_ALLOWLIST_E164: undefined }, repo: { reservarEnvioOtp: async () => { throw new Error("não pode chegar ao banco"); } }, obterServico: async () => { throw new Error("não pode chamar o gateway"); } });
    assert.deepEqual([r.entregue, r.motivo], [false, "ALLOWLIST_OBRIGATORIA"]);
  });
  test("SAIR: sem a flag nada é lido, revogado nem confirmado — mesmo com texto exato e número cadastrado", async () => {
    titular._limparSaidas();
    const chamadas = [];
    const repo = new Proxy({}, { get: (_, nome) => async () => { chamadas.push(String(nome)); return []; } });
    const r = await titular.processarPalavraDeSaida({ telefoneE164: NUM, texto: "SAIR", env: PROD, deps: { repo, auditar: async () => chamadas.push("auditar"), enviarConfirmacaoSaida: async () => chamadas.push("confirmar") } });
    assert.deepEqual([r.aplicado, chamadas.length], [false, 0]);
    const c = await envio.enviarConfirmacaoSaida({ telefoneE164: NUM, chave: "abcdef012345:2026-10-31" }, { env: PROD, enviar: async () => { chamadas.push("enviar"); return { enviada: true }; } });
    assert.deepEqual([c.enviada, c.motivo, chamadas.length], [false, "CONFIRMACAO_DESLIGADA", 0]);
  });
  test("a lista de palavras só diminuiu (nada novo passa a revogar): SAIR, PARAR, STOP, DESCADASTRAR", () => {
    for (const t of ["SAIR", "PARAR", "STOP", "DESCADASTRAR"]) assert.equal(titular.ehPalavraDeSaida(t), true, t);
    for (const t of ["CANCELAR", "cancelar pedido", "sair da fila", "não"]) assert.equal(titular.ehPalavraDeSaida(t), false, t);
  });
});
