// Central de Notificações — D-3 (permissões e recorte por unidade), estados, convite, escopo, revogação e auditoria.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.NOTIFICACOES_SEGREDO_MESTRE = "segredo-de-teste-da-central-0123456789abcdef";
const svc = await import("../src/modules/notificacoes/notificacoes.service.js");
const perm = await import("../src/modules/notificacoes/notificacoes.permissoes.js");
const { permissoesDoPapel, PERMISSOES } = await import("../src/shared/permissoes.js");
const { cenario, escopoAdmin, escopoGerente, reqFalso, ORG_A, ORG_B, UN, CE } = await import("./helpers/notificacoes-fake.js");

const auditados = [];
const deps = (repo, extra = {}) => ({ repo, auditar: async (e) => auditados.push(e), env: {}, ...extra });
const req = (papel, unidadeId = null, org = ORG_A) => ({ tenant: { organizacaoId: org, unidadeId }, acesso: { papel, permissoes: permissoesDoPapel(papel) } });

describe("D-3: matriz de permissões", () => {
  test("admin: empresa inteira; gerente: só a unidade do contexto; finance: só leitura; viewer/operations: nada", () => {
    const a = perm.escopoDeGestao(req("organization_admin", UN.A1));
    assert.deepEqual([a.unidadePermitida, a.podeVer, a.podeGerenciar], [null, true, true]);
    const g = perm.escopoDeGestao(req("unit_manager", UN.A1));
    assert.deepEqual([g.unidadePermitida, g.podeVer, g.podeGerenciar], [UN.A1, true, true]);
    const f = perm.escopoDeGestao(req("finance", UN.A1));
    assert.deepEqual([f.podeVer, f.podeGerenciar], [true, false]);
    for (const p of ["viewer", "operations", "display_operator"]) assert.deepEqual([perm.escopoDeGestao(req(p, UN.A1)).podeVer, perm.escopoDeGestao(req(p, UN.A1)).podeGerenciar], [false, false], p);
  });
  test("gerente na visão consolidada (sem unidade) não vê nem gerencia nada", () => {
    const g = perm.escopoDeGestao(req("unit_manager", null));
    assert.deepEqual([g.podeVer, g.podeGerenciar], [false, false]);
    assert.throws(() => perm.exigirGerenciar(req("unit_manager", null)), /Selecione uma unidade/);
  });
  test("gerenciar e ver são permissões próprias: unit_manager NÃO ganha configuracoes.gerenciar", () => {
    const um = permissoesDoPapel("unit_manager");
    assert.ok(um.includes(PERMISSOES.NOTIFICACOES_GERENCIAR) && !um.includes(PERMISSOES.CONFIG_GERENCIAR));
    assert.ok(permissoesDoPapel("organization_admin").includes(PERMISSOES.NOTIFICACOES_GERENCIAR));
    assert.ok(!permissoesDoPapel("finance").includes(PERMISSOES.NOTIFICACOES_GERENCIAR));
  });
  test("alcance: admin qualquer unidade (o banco confere a empresa); gerente só a dele", () => {
    assert.equal(perm.unidadeNoAlcance(escopoAdmin(), UN.A2), true);
    assert.equal(perm.unidadeNoAlcance(escopoGerente(UN.A1), UN.A2), false);
    assert.equal(perm.unidadeNoAlcance(escopoGerente(UN.A1), UN.A1), true);
  });
});

describe("leitura: estados, recorte e pendências", () => {
  test("antes da M3: legados aparecem como LEGACY_ACTIVE recebendo de todas as unidades; novo com consentimento = ATIVO (simulado)", async () => {
    const { repo } = cenario();
    const r = await svc.listarDestinatarios({ escopo: escopoAdmin(), deps: deps(repo) });
    const por = Object.fromEntries(r.destinatarios.map((d) => [d.nome, d]));
    assert.deepEqual([por.Ana.estado, por.Ana.origem, por.Ana.configuracaoAnteriorTodasUnidades], ["LEGACY_ACTIVE", "LEGACY_ACTIVE", true]);
    assert.equal(por.Bia.estado, "ATIVO");
    assert.equal(por.Bia.vinculos[0].simulado, true);
    assert.ok(r.destinatarios.every((d) => !/9000000/.test(d.telefoneMascarado)), "só máscara");
    assert.ok(!JSON.stringify(r).includes("+5511900000001"), "nenhum número completo na resposta");
  });
  test("outra empresa nunca aparece (mesmo número compartilhado)", async () => {
    const { repo } = cenario();
    const r = await svc.listarDestinatarios({ escopo: escopoAdmin(ORG_A), deps: deps(repo) });
    assert.ok(!r.destinatarios.some((d) => d.id === CE.outra));
  });
  test("gerente de A2 não vê a Bia (escopo só em A1) e vê os legados como compartilhados (sem editar cadastro)", async () => {
    const { repo } = cenario();
    const r = await svc.listarDestinatarios({ escopo: escopoGerente(UN.A2), deps: deps(repo) });
    assert.ok(!r.destinatarios.some((d) => d.nome === "Bia"));
    const ana = r.destinatarios.find((d) => d.nome === "Ana");
    assert.deepEqual([ana.compartilhadoComOutrasUnidades, ana.podeEditarCadastro], [true, false]);
  });
  test("legado revogado pelo titular = REVOGADO; opt-out = REVOGADO; destinatário desativado = SUSPENSO", () => {
    const ce = { id: "x", ativo: true, whatsapp_status: "VALIDADO" };
    const cat = [{ contato_empresa_id: "x", categoria: "pendencia_d1", habilitado: false }];
    const ledger = [{ contato_empresa_id: "x", categoria: "pendencia_d1", acao: "REVOGADO" }];
    assert.equal(svc.estadoDoDestinatario({ ce, escopos: [], categoriasLegadas: cat, optOut: false, ledger, selecaoLigada: false }), "REVOGADO");
    assert.equal(svc.estadoDoDestinatario({ ce, escopos: [], categoriasLegadas: [{ ...cat[0], habilitado: true }], optOut: true, ledger: [], selecaoLigada: false }), "REVOGADO");
    assert.equal(svc.estadoDoDestinatario({ ce: { ...ce, ativo: false }, escopos: [], categoriasLegadas: cat, optOut: false, ledger: [], selecaoLigada: false }), "SUSPENSO");
  });
  test("depois da M3: legado com escopo suspenso na unidade continua LEGACY se ativo em outra; sem nenhum ativo = SUSPENSO", () => {
    const ce = { id: "x", ativo: true, whatsapp_status: "VALIDADO" };
    const cat = [{ contato_empresa_id: "x", categoria: "pendencia_d1", habilitado: true }];
    const esc = (s) => ({ contato_empresa_id: "x", categoria: "pendencia_d1", habilitado: true, origem_autorizacao: "LEGACY_ACTIVE", suspenso_em: s });
    assert.equal(svc.estadoDoDestinatario({ ce, escopos: [esc(null), esc("2026-10-30")], categoriasLegadas: cat, optOut: false, ledger: [], selecaoLigada: true }), "LEGACY_ACTIVE");
    assert.equal(svc.estadoDoDestinatario({ ce, escopos: [esc("2026-10-30")], categoriasLegadas: cat, optOut: false, ledger: [], selecaoLigada: true }), "SUSPENSO");
  });
  test("pendência D-16: unidade sem destinatário D-1 aparece com o texto exato (após a M3)", async () => {
    const { db, repo } = cenario({ selecaoLigada: true });
    db.escopos.push({ id: "l1", contato_empresa_id: CE.ana, unidade_escopo_id: UN.A1, categoria: "pendencia_d1", habilitado: true, origem_autorizacao: "LEGACY_ACTIVE", suspenso_em: null });
    const r = await svc.resumo({ escopo: escopoAdmin(), deps: deps(repo, { segredosDisponiveis: () => true }) });
    assert.deepEqual(r.pendencias.map((p) => [p.unidadeNome, p.texto]), [["Norte", "Nenhum destinatário configurado para o Dashboard iFood D-1"]]);
    const g = await svc.resumo({ escopo: escopoGerente(UN.A1), deps: deps(repo, { segredosDisponiveis: () => true }) });
    assert.deepEqual([g.pendencias.length, g.unidades.map((u) => u.id)], [0, [UN.A1]], "gerente só enxerga a própria unidade");
  });
  test("antes da M3 nenhuma unidade fica pendente (os legados cobrem a empresa, como antes)", async () => {
    const { repo } = cenario();
    const r = await svc.resumo({ escopo: escopoAdmin(), deps: deps(repo, { segredosDisponiveis: () => true }) });
    assert.equal(r.pendencias.length, 0);
    assert.equal(r.transporte.otp, false, "sem transporte de OTP fora do ambiente isolado");
  });
});

describe("convite (o gestor convida; o titular verifica e consente)", () => {
  const corpo = (x = {}) => ({ nome: "Carla", telefone: "(11) 98888-7777", unidades: [UN.A1], categorias: ["fechamento_operacional_diario"], ...x });
  test("cria com link no FRAGMENTO (#), número cifrado + HMAC + máscara; auditoria sem número completo", async () => {
    const { db, repo } = cenario(); auditados.length = 0;
    const r = await svc.criarConvite({ req: reqFalso, escopo: escopoAdmin(), corpo: corpo(), baseUrl: "https://app", deps: deps(repo) });
    assert.match(r.link, /^https:\/\/app\/notificacoes\/convite\.html#t=[A-Za-z0-9_-]{43}$/);
    const c = db.convites[0];
    assert.match(c.token_hash, /^[0-9a-f]{64}$/);
    assert.ok(!r.link.includes(c.token_hash), "o banco guarda só o hash");
    assert.match(c.telefone_cifrado, /^k1:/);
    assert.match(c.telefone_hmac, /^[0-9a-f]{64}$/);
    assert.equal(c.telefone_mascarado, "+551********77");
    assert.ok(!JSON.stringify(c).includes("98888"), "nenhum número em claro no registro");
    assert.ok(!JSON.stringify(auditados).includes("98888"));
  });
  test("recusas: número inválido, unidade fora do alcance do gerente, categoria futura, número já destinatário, limite diário", async () => {
    const { db, repo } = cenario();
    await assert.rejects(svc.criarConvite({ req: reqFalso, escopo: escopoAdmin(), corpo: corpo({ telefone: "1234" }), deps: deps(repo) }), /WhatsApp válido/);
    await assert.rejects(svc.criarConvite({ req: reqFalso, escopo: escopoGerente(UN.A1), corpo: corpo({ unidades: [UN.A2] }), deps: deps(repo) }), /sua unidade/);
    await assert.rejects(svc.criarConvite({ req: reqFalso, escopo: escopoAdmin(), corpo: corpo({ categorias: ["disputas"] }), deps: deps(repo) }), /categorias disponíveis/);
    await assert.rejects(svc.criarConvite({ req: reqFalso, escopo: escopoAdmin(), corpo: corpo({ telefone: "+5511900000001" }), deps: deps(repo) }), (e) => e.statusCode === 409);
    db.contagemUsuario = 30;
    await assert.rejects(svc.criarConvite({ req: reqFalso, escopo: escopoAdmin(), corpo: corpo(), deps: deps(repo) }), (e) => e.statusCode === 429);
  });
  test("sem o segredo da Central: 503 (nada é guardado em claro)", async () => {
    const { repo } = cenario();
    await assert.rejects(svc.criarConvite({ req: reqFalso, escopo: escopoAdmin(), corpo: corpo(), deps: deps(repo, { segredosDisponiveis: () => false }) }), (e) => e.statusCode === 503);
  });
  test("adesão voluntária de um legado usa o número já cadastrado (o gestor não redigita)", async () => {
    const { db, repo } = cenario();
    await svc.criarConvite({ req: reqFalso, escopo: escopoAdmin(), corpo: { nome: "Ana", destinatarioId: CE.ana, unidades: [UN.A1], categorias: ["fechamento_operacional_diario"] }, deps: deps(repo) });
    assert.equal(db.convites[0].contato_empresa_id, CE.ana);
    assert.equal(db.convites[0].telefone_mascarado, "+551********01");
  });
});

describe("escopo: suspender, preferências, vínculo de legado, pedido de revogação", () => {
  test("gerente de A1 não suspende em A2 (backend recusa antes do banco)", async () => {
    const { repo } = cenario();
    await assert.rejects(svc.suspender({ req: reqFalso, escopo: escopoGerente(UN.A1), destinatarioId: CE.ana, corpo: { unidadeId: UN.A2 }, deps: deps(repo) }), /alcance/);
  });
  test("suspender passa a unidade permitida ao banco e audita com a unidade", async () => {
    const { db, repo } = cenario(); auditados.length = 0;
    await svc.suspender({ req: reqFalso, escopo: escopoGerente(UN.A1), destinatarioId: CE.ana, corpo: { unidadeId: UN.A1, motivo: "férias" }, deps: deps(repo) });
    assert.equal(db.chamadas[0][1].unidadePermitida, UN.A1);
    assert.equal(auditados.at(-1).detalhes.unidade_id, UN.A1);
    assert.equal(auditados.at(-1).acao, "notificacao.escopo_suspenso");
  });
  test("preferências só RESTRINGEM: nunca mandam habilitado=true; faixa inválida recusada", async () => {
    const { db, repo } = cenario();
    await svc.definirPreferencias({ req: reqFalso, escopo: escopoAdmin(), destinatarioId: CE.bia, corpo: { unidadeId: UN.A1, categoria: "fechamento_operacional_diario", habilitado: true, silencio: { inicio: "22:00", fim: "07:00" } }, deps: deps(repo) });
    assert.equal(db.chamadas[0][1].habilitado, null, "habilitado=true do navegador é descartado");
    await assert.rejects(svc.definirPreferencias({ req: reqFalso, escopo: escopoAdmin(), destinatarioId: CE.bia, corpo: { unidadeId: UN.A1, janela: { inicio: "25:00", fim: "x" } }, deps: deps(repo) }), /HH:MM/);
  });
  test("vincular legado antes da M3 → 409 explicando; depois → VINCULADO, com motivo obrigatório", async () => {
    const a = cenario();
    await assert.rejects(svc.vincularLegado({ req: reqFalso, escopo: escopoAdmin(), destinatarioId: CE.ana, corpo: { unidadeId: UN.A2, motivo: "unidade nova" }, deps: deps(a.repo) }), (e) => e.statusCode === 409);
    const b = cenario({ selecaoLigada: true });
    await assert.rejects(svc.vincularLegado({ req: reqFalso, escopo: escopoAdmin(), destinatarioId: CE.ana, corpo: { unidadeId: UN.A2 }, deps: deps(b.repo) }), /Motivo/);
    assert.equal((await svc.vincularLegado({ req: reqFalso, escopo: escopoAdmin(), destinatarioId: CE.ana, corpo: { unidadeId: UN.A2, motivo: "unidade nova" }, deps: deps(b.repo) })).resultado, "VINCULADO");
  });
  test("pedido de revogação pelo gerente vale SÓ para a unidade dele; pelo admin, para a empresa", async () => {
    const { db, repo } = cenario();
    await svc.registrarPedidoRevogacao({ req: reqFalso, escopo: escopoGerente(UN.A1), destinatarioId: CE.ana, corpo: { motivo: "pediu por telefone" }, deps: deps(repo) });
    await svc.registrarPedidoRevogacao({ req: reqFalso, escopo: escopoAdmin(), destinatarioId: CE.ana, corpo: { motivo: "pediu por e-mail" }, deps: deps(repo) });
    const [g, a] = db.chamadas.filter((c) => c[0] === "revogar").map((c) => c[1]);
    assert.deepEqual([g.unidadeEscopoId, a.unidadeEscopoId, g.origem], [UN.A1, null, "pedido_registrado_gestor"]);
    assert.match(g.telefoneHmac, /^[0-9a-f]{64}$/);
  });
  test("auditoria para o gestor: sem IP, user-agent ou número completo", async () => {
    const { repo } = cenario();
    const r = await svc.auditoria({ escopo: escopoGerente(UN.A1), deps: deps(repo) });
    const txt = JSON.stringify(r);
    for (const proibido of ["10.0.0.1", "user_agent", "+5511900000001"]) assert.ok(!txt.includes(proibido), proibido);
    assert.ok(txt.includes("+551********01"));
  });
});
