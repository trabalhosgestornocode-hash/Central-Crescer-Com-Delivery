// Fluxo do TITULAR em simulação: convite → OTP → consentimento separado; gestão anti-enumeração; revogação; palavra de saída.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.NOTIFICACOES_SEGREDO_MESTRE = "segredo-de-teste-da-central-0123456789abcdef";
const titular = await import("../src/modules/notificacoes/notificacoes.titular.service.js");
const seg = await import("../src/modules/notificacoes/notificacoes.segredos.js");
const envio = await import("../src/modules/notificacoes/notificacoes.envio.js");
const basico = await import("../src/modules/notificacoes/notificacoes.basico.js");

const ENV_SIM = { NOTIFICACOES_OTP_TRANSPORTE: "simulacao", NOTIFICACOES_AMBIENTE_ISOLADO: "true", NODE_ENV: "test" };
const ORG = "00000000-0000-4000-8000-00000000a001";
const NUM = "+5511987654321";

function montar() {
  const token = basico.gerarToken();
  const st = {
    convite: { id: randomUUID(), organizacao_id: ORG, nome: "Carla", telefone_cifrado: seg.cifrarTelefone(NUM), telefone_hmac: seg.hmacTelefone(NUM),
      unidades_pretendidas: ["u1"], categorias_pretendidas: ["fechamento_operacional_diario", "pendencia_d1"], status: "PENDENTE",
      expira_em: new Date(Date.now() + 3_600_000).toISOString(), token_hash: basico.hashToken(token) },
    desafios: [], consentidos: [], revogacoes: [], ultimoEnvio: 0,
    destinatarios: [{ id: "ce-1", organizacao_id: ORG, nome: "Carla", ativo: true }],
  };
  const repo = {
    obterConvitePorToken: async (h) => (h === st.convite.token_hash ? st.convite : null),
    obterNomes: async () => ({ empresa: "Rede Sabor", unidades: [{ id: "u1", nome: "Centro" }] }),
    listarCategorias: async () => [{ codigo: "fechamento_operacional_diario", rotulo: "Fechamento", estado: "SIMULACAO" }, { codigo: "pendencia_d1", rotulo: "Pendência D-1", estado: "ATIVA" }],
    termoVigente: async () => ({ versao: 1, texto: "Autorizo {empresa} a enviar…", rascunho: true }),
    criarDesafio: async (p) => {
      if (Date.now() - st.ultimoEnvio < 60_000) return { resultado: "AGUARDE", segundos: 60 };
      st.ultimoEnvio = Date.now();
      st.desafios.forEach((d) => { d.invalidado = true; });
      const d = { ...p, id: p.id ?? randomUUID(), tentativas: 0, consumido: false, invalidado: false };
      st.desafios.push(d);
      return { resultado: "CRIADO", desafio_id: d.id };
    },
    verificarDesafio: async ({ desafioId, codigoHmac }) => {
      const d = st.desafios.find((x) => x.id === desafioId);
      if (!d || d.consumido || d.invalidado) return { resultado: "INVALIDO" };
      if (d.tentativas >= 5) return { resultado: "BLOQUEADO" };
      d.tentativas += 1;
      if (d.codigoHmac === codigoHmac) { d.consumido = true; d.consumido_em = new Date().toISOString(); st.convite.status = "VERIFICADO"; return { resultado: "VERIFICADO", simulado: d.simulado }; }
      if (d.tentativas >= 5) { d.invalidado = true; return { resultado: "BLOQUEADO" }; }
      return { resultado: "INCORRETO", restantes: 5 - d.tentativas };
    },
    consentir: async (p) => { st.consentidos.push(p); return { resultado: p.categorias.length ? "CONSENTIDO" : "RECUSADO_PELO_TITULAR", contato_empresa_id: "ce-novo", simulado: true }; },
    destinatariosDoNumero: async (e164) => (e164 === NUM ? st.destinatarios : []),
    obterDesafio: async (id) => { const d = st.desafios.find((x) => x.id === id); return d ? { id: d.id, tipo: d.tipo, telefone_hmac: d.telefoneHmac, consumido_em: d.consumido_em ?? null } : null; },
    listarDestinatarios: async () => ({ destinatarios: st.destinatarios, categoriasLegadas: [{ contato_empresa_id: "ce-1", categoria: "pendencia_d1", habilitado: true }], escopos: [], contatos: [] }),
    revogar: async (p) => { st.revogacoes.push(p); return { resultado: "REVOGADO", mensagens_canceladas: 2 }; },
  };
  return { st, repo, token };
}

describe("convite → OTP → consentimento", () => {
  beforeEach(() => envio._limparCaixaSimulada());
  test("transporte desligado (produção): verificação indisponível (503) — nada é verificado", async () => {
    const { repo, token } = montar();
    await assert.rejects(titular.pedirCodigoConvite({ token, deps: { repo, auditar: async () => {}, env: {} } }), (e) => e.statusCode === 503);
  });
  test("abrir: empresa, unidades, categorias e termo com o nome da empresa — sem número, sem dado operacional", async () => {
    const { repo, token } = montar();
    const r = await titular.abrirConvite({ token, deps: { repo, auditar: async () => {}, env: ENV_SIM } });
    assert.equal(r.empresa, "Rede Sabor");
    assert.match(r.termo.texto, /Rede Sabor/);
    assert.ok(!JSON.stringify(r).includes("98765"));
    await assert.rejects(titular.abrirConvite({ token: basico.gerarToken(), deps: { repo, auditar: async () => {}, env: ENV_SIM } }), (e) => e.statusCode === 404);
  });
  test("código: entregue só à caixa simulada; reenvio antes de 60 s → AGUARDE; erro conta tentativa; certo → VERIFICADO", async () => {
    const { repo, token, st } = montar();
    const d = await titular.pedirCodigoConvite({ token, ip: "1.2.3.4", deps: { repo, auditar: async () => {}, env: ENV_SIM } });
    assert.equal(d.ok, true);
    assert.ok(!("codigo" in d), "a API nunca devolve o código");
    assert.match(st.desafios[0].codigoHmac, /^[0-9a-f]{64}$/, "só o HMAC do código vai ao banco");
    const again = await titular.pedirCodigoConvite({ token, deps: { repo, auditar: async () => {}, env: ENV_SIM } });
    assert.deepEqual([again.ok, again.motivo], [false, "AGUARDE"]);
    const codigo = envio._ultimoCodigoSimulado({ desafioId: d.desafio });
    const errado = codigo === "000000" ? "111111" : "000000";
    assert.equal((await titular.verificarCodigoConvite({ token, desafio: d.desafio, provisorio: d.provisorio, codigo: errado, deps: { repo, auditar: async () => {}, env: ENV_SIM } })).resultado, "INCORRETO");
    assert.equal((await titular.verificarCodigoConvite({ token, desafio: d.desafio, provisorio: d.provisorio, codigo, deps: { repo, auditar: async () => {}, env: ENV_SIM } })).resultado, "VERIFICADO");
    await assert.rejects(titular.verificarCodigoConvite({ token, desafio: d.desafio, provisorio: d.provisorio, codigo: "12ab56", deps: { repo, auditar: async () => {}, env: ENV_SIM } }), /6 números/);
  });
  test("consentimento é ATO SEPARADO: só as categorias que o titular marcou; vazio = recusa; o número vai decifrado só ao banco", async () => {
    const { repo, token, st } = montar();
    st.convite.status = "VERIFICADO";
    await titular.consentirConvite({ token, desafio: "d-1", categorias: ["fechamento_operacional_diario"], termoVersao: 1, ip: "1.2.3.4", userAgent: "Mozilla/5.0 <script>", deps: { repo, auditar: async () => {}, env: ENV_SIM } });
    assert.deepEqual(st.consentidos[0].categorias, ["fechamento_operacional_diario"]);
    assert.equal(st.consentidos[0].telefoneE164, NUM);
    assert.match(st.consentidos[0].ipHmac, /^[0-9a-f]{64}$/, "IP só como HMAC");
    assert.ok(!st.consentidos[0].userAgent.includes("<"), "user-agent saneado");
    const r = await titular.consentirConvite({ token, desafio: "d-1", categorias: [], termoVersao: 1, deps: { repo, auditar: async () => {}, env: ENV_SIM } });
    assert.equal(r.resultado, "RECUSADO_PELO_TITULAR");
  });
});

describe("gestão pelo titular (sem conta): anti-enumeração e revogação", () => {
  beforeEach(() => envio._limparCaixaSimulada());
  test("número cadastrado e não cadastrado recebem a MESMA resposta (mesmos campos, mesma mensagem)", async () => {
    const { repo } = montar();
    const a = await titular.pedirCodigoGestao({ telefone: NUM, deps: { repo, auditar: async () => {}, env: ENV_SIM } });
    const b = await titular.pedirCodigoGestao({ telefone: "+5511911112222", deps: { repo, auditar: async () => {}, env: ENV_SIM } });
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
    assert.equal(a.mensagem, b.mensagem);
    assert.match(b.desafio, /^[0-9a-f-]{36}$/, "desafio fictício com o mesmo formato");
  });
  test("tempo NÃO revela o número: a resposta não espera o banco (banco lento de 300 ms) e o processamento roda depois", async () => {
    const { repo } = montar();
    const lento = { ...repo, destinatariosDoNumero: async (e) => { await new Promise((r) => setTimeout(r, 300)); return repo.destinatariosDoNumero(e); } };
    const medir = async (telefone) => { const t0 = performance.now(); const r = await titular.pedirCodigoGestao({ telefone, deps: { repo: lento, auditar: async () => {}, env: ENV_SIM } }); return [performance.now() - t0, r]; };
    const [tA, a] = await medir(NUM);
    const [tB, b] = await medir("+5511911112222");
    assert.ok(tA < 100 && tB < 100, `respostas imediatas (${tA.toFixed(1)} ms / ${tB.toFixed(1)} ms) — não dependem do banco`);
    assert.ok(!JSON.stringify(a).includes("_processamento"), "o gancho interno nunca vai na resposta");
    assert.equal(envio._ultimoCodigoSimulado({ desafioId: a.desafio }), null, "o código ainda não saiu quando a resposta voltou");
    await a._processamento; await b._processamento;
    assert.match(envio._ultimoCodigoSimulado({ desafioId: a.desafio }), /^\d{6}$/, "número cadastrado: código entregue depois, no MESMO desafio informado");
    assert.equal(envio._ultimoCodigoSimulado({ desafioId: b.desafio }), null, "número não cadastrado: nada é entregue");
  });
  test("verificação: código errado e desafio fictício dão a MESMA resposta (NAO_CONFERE)", async () => {
    const { repo } = montar();
    const a = await titular.pedirCodigoGestao({ telefone: NUM, deps: { repo, auditar: async () => {}, env: ENV_SIM } });
    const b = await titular.pedirCodigoGestao({ telefone: "+5511911112222", deps: { repo, auditar: async () => {}, env: ENV_SIM } });
    await a._processamento; await b._processamento;
    const ra = await titular.verificarCodigoGestao({ desafio: a.desafio, provisorio: a.provisorio, codigo: "000001", deps: { repo, auditar: async () => {}, env: ENV_SIM } });
    const rb = await titular.verificarCodigoGestao({ desafio: b.desafio, provisorio: b.provisorio, codigo: "000001", deps: { repo, auditar: async () => {}, env: ENV_SIM } });
    assert.deepEqual(ra, rb);
  });
  test("sessão de gestão: código certo → sessão; adulterar a assinatura → 401; outro número → 401", async () => {
    const { repo, st } = montar();
    const a = await titular.pedirCodigoGestao({ telefone: NUM, deps: { repo, auditar: async () => {}, env: ENV_SIM } });
    await a._processamento;
    const codigo = envio._ultimoCodigoSimulado({ desafioId: a.desafio });
    const v = await titular.verificarCodigoGestao({ desafio: a.desafio, provisorio: a.provisorio, codigo, deps: { repo, auditar: async () => {}, env: ENV_SIM } });
    assert.equal(v.resultado, "VERIFICADO");
    const lista = await titular.minhasInscricoes({ sessao: v.sessao, e164: NUM, deps: { repo, auditar: async () => {}, env: ENV_SIM } });
    assert.equal(lista[0].empresa, "Rede Sabor");
    const adulterada = v.sessao.slice(0, -2) + (v.sessao.endsWith("00") ? "11" : "00");
    await assert.rejects(titular.minhasInscricoes({ sessao: adulterada, e164: NUM, deps: { repo, auditar: async () => {}, env: ENV_SIM } }), (e) => e.statusCode === 401);
    await assert.rejects(titular.minhasInscricoes({ sessao: v.sessao, e164: "+5511911112222", deps: { repo, auditar: async () => {}, env: ENV_SIM } }), (e) => e.statusCode === 401);
    const r = await titular.revogarComoTitular({ sessao: v.sessao, e164: NUM, sairDeTudo: true, deps: { repo, auditar: async () => {}, env: ENV_SIM } });
    assert.equal(r.resultado, "REVOGADO");
    assert.deepEqual([st.revogacoes[0].origem, st.revogacoes[0].sairDeTudo, st.revogacoes[0].categorias], ["pagina_gestao_otp", true, null]);
  });
});

describe("palavra de saída no WhatsApp", () => {
  test("reconhece SAIR/PARAR/STOP (com acento, pontuação, minúsculas); ignora frases", () => {
    for (const t of ["SAIR", "sair", "Sair.", "PARAR!", "stop", "Descadastrar"]) assert.equal(titular.ehPalavraDeSaida(t), true, t);
    for (const t of ["vou sair mais cedo", "ok", "", null]) assert.equal(titular.ehPalavraDeSaida(t), false, String(t));
  });
  test("desligada por padrão; ligada, revoga tudo do número (origem palavra_chave_inbound)", async () => {
    const { repo, st } = montar();
    assert.equal((await titular.processarPalavraDeSaida({ telefoneE164: NUM, texto: "SAIR", env: {}, deps: { repo } })).aplicado, false);
    const r = await titular.processarPalavraDeSaida({ telefoneE164: NUM, texto: "SAIR", env: { NOTIFICACOES_PALAVRA_CHAVE_SAIR: "true" }, deps: { repo } });
    assert.equal(r.aplicado, true);
    assert.deepEqual([st.revogacoes[0].origem, st.revogacoes[0].sairDeTudo], ["palavra_chave_inbound", true]);
  });
});
