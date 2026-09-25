// Central de Comunicação — ENVIO MANUAL: mesmo pipeline do teste (gates → outbox → RPCs fenced → WhatsAppService → recibos), nunca um segundo.
// FAIL-CLOSED: consentimento=false, opt-out, não verificado, fora da allowlist do piloto, Gateway fora, WhatsApp não configurado ⇒ 409 e o provider NUNCA é chamado.
// Idempotente: duplo clique (mesmo envioId) ⇒ UMA mensagem e UM provider call. Sem retry. Ator humano auditado. Sem banco, sem rede.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { enviarMensagem } from "../src/modules/administrativo/administrativo.comunicacao.conversas.js";
import { criarFakeDb, linhaRoster } from "./helpers/central-fake-db.js";

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const C1 = uuid(101);
const AUTOR = { contaId: uuid(7), perfilId: uuid(8), nome: "Camila Operadora", email: "camila@crescer.com" };
const TEL = "+5511999990001";

function montar({ roster, env = {}, estadoGateway = { estado: "conectado" }, envia, semServico = false, identidade = true } = {}) {
  const db = criarFakeDb({
    comunicacao_roster_autorizado: roster ?? [
      linhaRoster({ contato_id: C1, telefone_e164: TEL, organizacao_id: "o1", organizacao_nome: "Rede Sabor", unidade_id: "u1", unidade_nome: "Centro" }),
      linhaRoster({ contato_id: C1, telefone_e164: TEL, organizacao_id: "o1", organizacao_nome: "Rede Sabor", unidade_id: "u2", unidade_nome: "Praia" }),
    ],
    comunicacao_mensagens: [], comunicacao_tentativas: [],
  });
  const chamadas = []; const auditorias = [];
  const whatsAppService = semServico ? null : {
    enviarTexto: async (p) => {
      chamadas.push({ ...p, linhaNoMomento: { ...db.tabelas.comunicacao_mensagens[0] } });
      if (envia) return envia(p);
      return { providerMessageId: "WA-1", enviadoEm: new Date().toISOString() };
    },
  };
  const deps = { supabase: db, env, estadoGateway, whatsAppService, identidadeConfirmada: identidade, auditar: async (e) => auditorias.push(e) };
  return { db, deps, chamadas, auditorias };
}
const enviar = (deps, extra = {}) => enviarMensagem({ contatoId: C1, envioId: uuid(500), texto: "Bom dia! Conseguem lançar o dashboard?", ...extra }, AUTOR, deps);
const linhas = (db) => db.tabelas.comunicacao_mensagens;
const rejeitaCom = async (fn, status, codigo) => {
  await assert.rejects(fn, (e) => e.statusCode === status && (codigo === undefined || e.details?.codigo === codigo), `esperava ${status} ${codigo ?? ""}`);
};

describe("envio manual — caminho feliz", () => {
  test("cria UMA mensagem no outbox e chama o provider UMA vez com o telefone real, o texto e a chave de idempotência", async () => {
    const { db, deps, chamadas } = montar();
    const r = await enviar(deps);
    assert.deepEqual([r.resultado, r.jaExistia], ["ENVIADO", false]);
    assert.equal(linhas(db).length, 1);
    assert.equal(chamadas.length, 1);
    assert.deepEqual([chamadas[0].telefoneE164, chamadas[0].texto, chamadas[0].idempotencyKey], [TEL, "Bom dia! Conseguem lançar o dashboard?", `wa:manual:${uuid(500)}:v1`]);
  });

  test("o status final é SENT — NUNCA 'entregue' — e a resposta traz a bolha pronta para a tela", async () => {
    const { deps } = montar();
    const r = await enviar(deps);
    assert.equal(r.status, "SENT");
    assert.deepEqual([r.mensagem.direcao, r.mensagem.categoria, r.mensagem.origem, r.mensagem.status, r.mensagem.entregueEm, r.mensagem.lidoEm, r.mensagem.operador],
      ["saida", "manual", "manual_painel", "SENT", null, null, "Camila Operadora"]);
  });

  test("a linha nasce como MENSAGEM MANUAL, sem alerta, do ator humano, 1 tentativa, e o worker NUNCA consegue reivindicá-la", async () => {
    const { db, deps, chamadas } = montar();
    await enviar(deps);
    const antes = chamadas[0].linhaNoMomento;                                   // no instante do provider call
    assert.equal(antes.status, "SENDING");
    const l = linhas(db)[0];
    assert.deepEqual([l.tipo, l.direcao, l.alerta_id, l.max_tentativas, l.canal], ["mensagem_manual", "saida", null, 1, "whatsapp"]);
    assert.deepEqual([l.metadados.proposito, l.metadados.origem, l.metadados.ator_perfil_id, l.metadados.ator_nome], ["manual", "manual_painel", AUTOR.perfilId, AUTOR.nome]);
    assert.equal(l.claimed_by, `manual_painel:${uuid(500)}`);
    // claim (088): (SCHEDULED e disponível) OU (PROCESSING com lease vencido), E (expira_em nulo OU no futuro). expira_em <= fim do lease ⇒ nunca ambos.
    assert.ok(Date.parse(l.expira_em) <= Date.parse(l.claim_expira_em) + 1, "expira_em nunca depois do fim do lease");
    assert.notEqual(l.status, "SCHEDULED");
  });

  test("registra a tentativa e audita INICIADO + ENVIADO com o ator humano, telefone mascarado e SEM o texto", async () => {
    const { db, deps, auditorias } = montar();
    await enviar(deps);
    assert.equal(db.tabelas.comunicacao_tentativas.length, 1);
    assert.deepEqual(auditorias.map((a) => a.acao), ["COMUNICACAO_MANUAL_INICIADO", "COMUNICACAO_MANUAL_ENVIADO"]);
    for (const a of auditorias) assert.deepEqual([a.atorId, a.perfilId, a.perfilNome, a.atorEmail], [AUTOR.contaId, AUTOR.perfilId, AUTOR.nome, AUTOR.email]);
    const s = JSON.stringify(auditorias);
    assert.ok(!s.includes("Bom dia") && !s.includes("5511999990001") && s.includes("********01"));
  });

  test("empresa/unidade: padrão = empresa do responsável; unidade só quando não há ambiguidade (aqui há duas ⇒ null)", async () => {
    const { db, deps } = montar();
    await enviar(deps);
    assert.deepEqual([linhas(db)[0].organizacao_id, linhas(db)[0].unidade_id], ["o1", null]);
  });

  test("com UMA unidade no vínculo, ela é usada; uma unidade informada é validada contra o roster", async () => {
    const { db, deps } = montar({ roster: [linhaRoster({ contato_id: C1, telefone_e164: TEL, organizacao_id: "o1", unidade_id: "u9", unidade_nome: "Única" })] });
    await enviar(deps);
    assert.equal(linhas(db)[0].unidade_id, "u9");
    const dois = montar();
    await enviar(dois.deps, { envioId: uuid(501), unidadeId: "u2" });
    assert.equal(linhas(dois.db)[0].unidade_id, "u2");
    await rejeitaCom(() => enviar(dois.deps, { envioId: uuid(502), unidadeId: "u-de-outro-cliente" }), 400, "UNIDADE_INVALIDA");
    await rejeitaCom(() => enviar(dois.deps, { envioId: uuid(503), organizacaoId: "o-de-outro-cliente" }), 400, "EMPRESA_INVALIDA");
    assert.equal(linhas(dois.db).length, 1, "nada é criado quando empresa/unidade são inválidas");
  });
});

describe("idempotência — duplo clique não duplica", () => {
  test("MESMO envioId em sequência ⇒ 1 mensagem, 1 provider call; a repetição devolve JA_EXISTIA", async () => {
    const { db, deps, chamadas } = montar();
    const a = await enviar(deps);
    const b = await enviar(deps);
    assert.equal(a.resultado, "ENVIADO");
    assert.deepEqual([b.resultado, b.jaExistia, b.mensagemId], ["JA_EXISTIA", true, a.mensagemId]);
    assert.equal(linhas(db).length, 1);
    assert.equal(chamadas.length, 1);
  });

  test("MESMO envioId em PARALELO (duplo clique de verdade) ⇒ 1 mensagem e 1 provider call", async () => {
    const { db, deps, chamadas } = montar();
    const rs = await Promise.all([enviar(deps), enviar(deps), enviar(deps)]);
    assert.equal(linhas(db).length, 1);
    assert.equal(chamadas.length, 1);
    assert.equal(rs.filter((r) => r.resultado === "ENVIADO").length, 1);
    assert.equal(rs.filter((r) => r.resultado === "JA_EXISTIA").length, 2);
  });

  test("envioIds DIFERENTES são mensagens diferentes (dois envios legítimos)", async () => {
    const { db, deps, chamadas } = montar();
    await enviar(deps, { envioId: uuid(600) }); await enviar(deps, { envioId: uuid(601) });
    assert.equal(linhas(db).length, 2); assert.equal(chamadas.length, 2);
  });

  test("a repetição não passa nem pelos gates (o Gateway pode cair depois do 1º envio e o reenvio continua sendo só uma consulta)", async () => {
    const { deps } = montar();
    const a = await enviar(deps);
    deps.estadoGateway = { estado: "desconectado" };
    assert.equal((await enviar(deps)).mensagemId, a.mensagemId);
  });
});

describe("gates — FAIL-CLOSED (o provider nunca é chamado e nada é criado)", () => {
  const casos = [
    ["consentimento=false", { roster: [linhaRoster({ contato_id: C1, telefone_e164: TEL, consentimento: false })] }, "SEM_CONSENTIMENTO"],
    ["não verificado", { roster: [linhaRoster({ contato_id: C1, telefone_e164: TEL, verificado: false })] }, "NAO_VERIFICADO"],
    ["opt-out", { roster: [linhaRoster({ contato_id: C1, telefone_e164: TEL, opt_out: true })] }, "OPT_OUT"],
    ["piloto ligado e telefone FORA da allowlist", { env: { COMUNICACAO_PILOTO_ENABLED: "true", COMUNICACAO_PILOTO_TELEFONES_E164: "+5511888880000" } }, "FORA_DA_ALLOWLIST"],
    ["piloto ligado com allowlist VAZIA", { env: { COMUNICACAO_PILOTO_ENABLED: "true" } }, "FORA_DA_ALLOWLIST"],
    ["piloto ligado com allowlist MALFORMADA", { env: { COMUNICACAO_PILOTO_ENABLED: "true", COMUNICACAO_PILOTO_TELEFONES_E164: "abc" } }, "FORA_DA_ALLOWLIST"],
    ["Gateway desconectado", { estadoGateway: { estado: "desconectado" } }, "GATEWAY_INDISPONIVEL"],
    ["Gateway instável", { estadoGateway: { estado: "instavel" } }, "GATEWAY_INDISPONIVEL"],
    ["Gateway desconhecido", { estadoGateway: { estado: "desconhecido" } }, "GATEWAY_INDISPONIVEL"],
    ["conta do WhatsApp NÃO confirmada na aba Conexão", { identidade: false }, "CONEXAO_NAO_CONFIRMADA"],
    ["WhatsApp não configurado no backend", { semServico: true }, "WHATSAPP_NAO_CONFIGURADO"],
  ];
  for (const [rotulo, opcoes, codigo] of casos) {
    test(`${rotulo} ⇒ 409 ${codigo}`, async () => {
      const { db, deps, chamadas, auditorias } = montar(opcoes);
      await rejeitaCom(() => enviar(deps), 409, codigo);
      assert.equal(chamadas.length, 0);
      assert.equal(linhas(db).length, 0);
      assert.equal(db.tabelas.comunicacao_tentativas.length, 0);
      assert.equal(auditorias.length, 0);
    });
  }

  test("piloto ligado e telefone NA allowlist ⇒ envia; piloto desligado ⇒ a allowlist não se aplica", async () => {
    const a = montar({ env: { COMUNICACAO_PILOTO_ENABLED: "true", COMUNICACAO_PILOTO_TELEFONES_E164: `+5511888880000,${TEL}` } });
    assert.equal((await enviar(a.deps)).resultado, "ENVIADO");
    const b = montar({ env: {} });
    assert.equal((await enviar(b.deps)).resultado, "ENVIADO");
  });

  test("contato FORA do roster ⇒ 404 (não revela se o número existe) e nada é criado", async () => {
    const { db, deps, chamadas } = montar();
    await rejeitaCom(() => enviarMensagem({ contatoId: uuid(999), envioId: uuid(500), texto: "oi" }, AUTOR, deps), 404);
    assert.equal(chamadas.length, 0); assert.equal(linhas(db).length, 0);
  });

  test("sem ator humano ⇒ 401; sem envioId válido ⇒ 400; nada é criado", async () => {
    const { db, deps, chamadas } = montar();
    await rejeitaCom(() => enviarMensagem({ contatoId: C1, envioId: uuid(500), texto: "oi" }, null, deps), 401);
    await rejeitaCom(() => enviarMensagem({ contatoId: C1, envioId: uuid(500), texto: "oi" }, {}, deps), 401);
    for (const envioId of [undefined, "", "abc", 5, "00000000-0000-0000-0000-000000000000x"]) await rejeitaCom(() => enviarMensagem({ contatoId: C1, envioId, texto: "oi" }, AUTOR, deps), 400);
    assert.equal(chamadas.length, 0); assert.equal(linhas(db).length, 0);
  });
});

describe("texto", () => {
  test("vazio, só espaços, não-string e maior que 4096 ⇒ 400 TEXTO_INVALIDO, sem efeito", async () => {
    const { db, deps, chamadas } = montar();
    for (const texto of ["", "   \n\t ", undefined, null, 5, {}, "x".repeat(4097), "\u0000"]) await rejeitaCom(() => enviar(deps, { texto }), 400, "TEXTO_INVALIDO");
    assert.equal(chamadas.length, 0); assert.equal(linhas(db).length, 0);
  });

  test("4096 caracteres é aceito; o texto é aparado e o NUL removido antes de sair", async () => {
    const { deps, chamadas } = montar();
    await enviar(deps, { texto: "  a\u0000b  " });
    assert.equal(chamadas[0].texto, "ab");
    const grande = montar();
    assert.equal((await enviar(grande.deps, { texto: "y".repeat(4096) })).resultado, "ENVIADO");
  });
});

describe("falha do provider — sem retry, sem reenvio", () => {
  test("falha comprovadamente ANTES do envio (destinatário fora do WhatsApp) ⇒ FAILED, 1 chamada, auditada", async () => {
    const { db, deps, chamadas, auditorias } = montar({ envia: async () => { throw Object.assign(new Error("RECIPIENT_NOT_ON_WHATSAPP"), { preEnvio: true, permanente: true }); } });
    const r = await enviar(deps);
    assert.deepEqual([r.resultado, r.mensagem.status], ["FALHOU", "FAILED"]);
    assert.equal(chamadas.length, 1);
    assert.equal(linhas(db)[0].status, "FAILED");
    assert.equal(auditorias.at(-1).acao, "COMUNICACAO_MANUAL_FALHOU");
  });

  test("falha INCERTA (timeout) ⇒ DELIVERY_UNKNOWN (nunca 'falhou' nem 'enviada'), 1 chamada, e repetir não reenvia", async () => {
    const { db, deps, chamadas } = montar({ envia: async () => { throw new Error("BAILEYS_GATEWAY_TIMEOUT"); } });
    const r = await enviar(deps);
    assert.deepEqual([r.resultado, r.mensagem.status], ["ENTREGA_INCERTA", "DELIVERY_UNKNOWN"]);
    const de_novo = await enviar(deps);
    assert.equal(de_novo.resultado, "JA_EXISTIA");
    assert.equal(chamadas.length, 1, "nenhum reenvio automático");
    assert.equal(linhas(db).length, 1);
  });

  test("a mensagem de erro exposta é curta (sem stack) e nunca traz o texto enviado", async () => {
    const { deps } = montar({ envia: async () => { throw Object.assign(new Error("x".repeat(1000)), { preEnvio: true }); } });
    const r = await enviar(deps);
    assert.ok((r.mensagem.erro ?? "").length <= 200);
  });
});

describe("arquitetura — nenhum caminho paralelo", () => {
  test("o envio manual usa as RPCs fenced e o WhatsAppService (nada de provider direto)", async () => {
    const { db, deps } = montar();
    await enviar(deps);
    const nomes = db.chamadasRpc.map((c) => c.nome);
    assert.deepEqual(nomes, ["comunicacao_iniciar_envio", "comunicacao_finalizar_envio"]);
  });
});
