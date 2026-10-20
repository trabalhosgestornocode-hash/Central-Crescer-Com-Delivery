// iFood — AUTOATENDIMENTO do app Order (pedidos + eventos): a unidade conecta os pedidos sem allowlist, SQL ou variável por unidade.
//
// As duas salvaguardas manuais do piloto são SUBSTITUÍDAS (não removidas) por validação automática:
//   * IFOOD_ORDER_PILOT_UNITS por unidade  ->  uma flag do ambiente + módulo `ifood` + `integracoes.gerenciar` (gates da rota);
//   * ID digitado + conferência + validação acompanhada  ->  a loja PROVADA pelo token Order (claim merchant_scope com order+events),
//     escolhida só entre as lojas LIVRES desse token, confirmada por UMA consulta isolada de eventos (sem gravar, sem ACK).
// O poller passa a enxergar a unidade pelo vínculo `validado` de uma conexão `ativa` com o mesmo merchant (lido a cada ciclo).
//
// Sem rede e sem banco: repositórios em memória, token e cliente de Events falsos. Nenhuma chamada real ao iFood, nenhum OAuth real,
// nenhum ACK real. Nada aqui é evidência de homologação no iFood.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SACI, NORTH, ORG, OUTRA_ORG, UN_OUTRA_ORG, GESTOR } from "./helpers/ifood-vinculo-fakes.js";   // só constantes e ifood.errors
process.env.IFOOD_ORDER_PILOT_UNITS = SACI;   // o piloto continua valendo (Saci) — o autoatendimento SOMA, nunca substitui a lista
process.env.IFOOD_ORDER_CLIENT_ID = "order-client-id-de-teste";
process.env.IFOOD_ORDER_CLIENT_SECRET = "order-client-secret-de-teste";
process.env.IFOOD_TOKEN_SECRET = "segredo-de-teste-com-mais-de-16-caracteres";
delete process.env.IFOOD_ORDER_SELF_SERVICE_ENABLED;              // padrão: DESLIGADO (fail-closed)
delete process.env.IFOOD_ORDER_MERCHANT_VALIDACAO_ENABLED;

const express = (await import("express")).default;
const { criarAmbiente } = await import("./helpers/ifood-vinculo-fakes.js");
const { config } = await import("../src/config/env.js");
const { cifrar } = await import("../src/shared/cripto.js");
const auto = await import("../src/modules/ifood/ifoodOrderAutoatendimento.service.js");
const conexaoSvc = await import("../src/modules/ifood/ifoodConnection.service.js");
const tokenReal = await import("../src/modules/ifood/ifoodToken.service.js");
const vinculoRepoReal = await import("../src/modules/ifood/ifoodMerchantVinculo.repository.js");
const clienteReal = await import("../src/modules/ifood/ifoodEvents.client.js");
const { criarPoller } = await import("../src/modules/ifood/ifoodEvents.poller.js");
const { criarRepoEmMemoria, criarRelogio, criarClienteFake, criarTokenFake, ev } = await import("./helpers/ifood-events-fakes.js");
const { ifoodErro, IFOOD_ERROS } = await import("../src/modules/ifood/ifood.errors.js");
const { ifoodRouter } = await import("../src/modules/ifood/ifood.routes.js");
const { requireModulo } = await import("../src/middlewares/auth.js");
const { errorHandler } = await import("../src/middlewares/errorHandler.js");
const { MODULOS } = await import("../src/shared/modulos.js");
const { permissoesDoPapel } = await import("../src/shared/permissoes.js");
const { ACOES } = await import("../src/shared/auditoria.js");

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(path.join(AQUI, "..", p), "utf8");

const FEIRA = "00000000-0000-0000-0000-0000000000f1";   // empresa nova, sem iFood (id fictício)
const ORG_FEIRA = "00000000-0000-0000-0000-0000000000f0";
const M_FEIRA = "f1f1f1f1-0000-4000-8000-0000000000f1";
const M_FEIRA_2 = "f2f2f2f2-0000-4000-8000-0000000000f2";
const M_SACI = "5ac15ac1-0000-4000-8000-0000000000a1";
const M_NORTH = "40a740a7-0000-4000-8000-0000000000b2";
const M_SALADAS = "5a1ad055-0000-4000-8000-0000000000a2";   // loja ADICIONAL da Saci (migration 117)
const M_OUTRA_ORG = "0e0e0e0e-0000-4000-8000-0000000000c3";

/** Access token JWT falso com o claim `merchant_scope` (o formato que o iFood emite). Nunca é enviado a lugar nenhum. */
const jwt = (lojas, modulos = ["order", "events"]) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ merchant_scope: lojas.flatMap((m) => modulos.map((x) => `${m}:${x}`)), exp: 4_102_444_800 })}.assinatura`;
};
const sem403 = (ids) => ifoodErro(IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO, { detalhes: { unauthorizedMerchants: ids } });

/** Ambiente com o autoatendimento LIGADO no token fake + auditoria em memória. */
function ambiente({ ligado = true } = {}) {
  const a = criarAmbiente({ piloto: [SACI], autoatendimento: ligado });
  const auditoria = [];
  const auditar = async (x) => { auditoria.push(x); };
  /** OAuth Order concluído na unidade: conexão `pendente` sem merchant + credencial com o token emitido. */
  const autorizar = ({ unidadeId = FEIRA, organizacaoId = ORG_FEIRA, lojas = [M_FEIRA], modulos, status = "ativa", token } = {}) => {
    const c = a.conectar({ unidadeId, organizacaoId, apps: ["order"], finalidade: "pedidos_producao" });
    const k = a.credenciais.find((x) => x.conexao_id === c.id && x.app_type === "order");
    k.access_token_cifrado = cifrar(token ?? jwt(lojas, modulos));
    k.status = status;
    return c;
  };
  const deps = { repo: a.repo, vinculos: a.vinculos, token: a.token, auditar, log: a.deps.log, vinculoDeps: a.deps };
  const ativar = (extra = {}) => auto.ativar({ organizacaoId: ORG_FEIRA, unidadeId: FEIRA, usuarioId: GESTOR, deps, ...extra });
  const resumo = async (unidadeId = FEIRA, organizacaoId = ORG_FEIRA) => {
    const conexao = await a.repo.obterConexaoViva({ organizacaoId, unidadeId, finalidade: "pedidos_producao" });
    const cred = conexao ? await a.repo.obterCredencial({ conexaoId: conexao.id, appType: "order" }) : null;
    return auto.resumoParaStatus({ organizacaoId, unidadeId, conexao, cred, deps });
  };
  return { ...a, auditoria, autorizar, deps, ativar, resumo };
}
const conexaoDe = (a, unidadeId) => a.conexoes.find((c) => c.unidade_id === unidadeId && c.status !== "revogada");
/** Foto do que existe hoje na Saci/North (produção): comparada antes/depois de cada cenário. */
const foto = (a) => JSON.stringify(a.conexoes.filter((c) => [SACI, NORTH].includes(c.unidade_id)));

// ===========================================================================
// 1. EMPRESA NOVA SEM IFOOD
// ===========================================================================
describe("1. empresa nova sem iFood", () => {
  test("sem conexão: `nao_conectado`, nenhuma chamada ao iFood, nada gravado", async () => {
    const a = ambiente();
    const r = await a.ativar();
    assert.equal(r.estado, auto.ESTADOS.NAO_CONECTADO);
    assert.deepEqual([a.chamadas.polling.length, a.chamadas.token.length, a.chamadas.ack.length, a.linhas.length], [0, 0, 0, 0]);
    assert.equal((await a.resumo()).estado, auto.ESTADOS.NAO_CONECTADO);
  });

  test("status sem credencial: com a flag a tela oferece \"Conectar pedidos iFood\"; sem a flag fica igual a antes (null)", async () => {
    const a = criarAmbiente({ piloto: [] });
    config.ifood.orderAutoatendimento = true;
    try {
      const s = await conexaoSvc.obterStatus({ organizacaoId: ORG_FEIRA, unidadeId: FEIRA, deps: { repo: a.repo, vinculos: a.vinculos, agora: a.deps.agora } });
      assert.equal(s.order.configurado, true, "a unidade fora da lista do piloto pode conectar");
      assert.deepEqual(s.order.autoatendimento, { habilitado: true, estado: "nao_conectado", motivo: null, mensagem: null });
    } finally { config.ifood.orderAutoatendimento = false; }
    const s2 = await conexaoSvc.obterStatus({ organizacaoId: ORG_FEIRA, unidadeId: FEIRA, deps: { repo: a.repo, vinculos: a.vinculos, agora: a.deps.agora } });
    assert.equal(s2.order, null, "flag desligada: fora do piloto = sem bloco de pedidos (comportamento anterior)");
  });

  test("flag desligada: ativar recusa (403) antes de ler qualquer coisa", async () => {
    const a = ambiente({ ligado: false });
    a.autorizar();
    await assert.rejects(a.ativar(), (e) => e.codigo === IFOOD_ERROS.IFOOD_AUTOATENDIMENTO_DESLIGADO && e.statusCode === 403);
    assert.deepEqual([a.chamadas.polling.length, a.linhas.length], [0, 0]);
    assert.equal(await a.resumo(), null, "sem a flag o status não ganha bloco novo");
  });
});

// ===========================================================================
// 2. CONEXÃO VÁLIDA
// ===========================================================================
describe("2. conexão válida", () => {
  test("token com UMA loja order+events: identifica, verifica uma vez (sem ACK), ativa e audita", async () => {
    const a = ambiente();
    const c = a.autorizar();
    const r = await a.ativar();
    assert.equal(r.estado, auto.ESTADOS.CONECTADO);
    assert.equal(r.lojaMascarada, "f1f1****00f1");
    const atual = conexaoDe(a, FEIRA);
    assert.deepEqual([atual.id, atual.merchant_id, atual.status], [c.id, M_FEIRA, "ativa"]);
    assert.deepEqual(a.linhas.map((v) => [v.estado, v.merchant_id, v.conexao_id]), [["validado", M_FEIRA, c.id]]);
    assert.deepEqual(a.chamadas.polling, [[M_FEIRA]], "uma consulta, só desta loja");
    assert.equal(a.chamadas.ack.length, 0, "a verificação nunca reconhece eventos");
    assert.deepEqual(a.auditoria.map((x) => x.acao), [ACOES.IFOOD_PEDIDOS_CONECTADOS]);
    assert.equal(a.auditoria[0].organizacaoId, ORG_FEIRA);
    assert.ok(!JSON.stringify(a.auditoria).includes(M_FEIRA), "auditoria só com a loja mascarada");
    assert.ok(a.logs.some((l) => l.evento === "order_autoatendimento.validado"));
    assert.ok(!JSON.stringify(a.logs).includes(M_FEIRA), "log nunca tem o merchant inteiro");
  });

  test("idempotente: chamar de novo depois de conectado não consulta o iFood nem grava", async () => {
    const a = ambiente();
    a.autorizar();
    await a.ativar();
    const antes = [a.chamadas.polling.length, a.chamadas.definirMerchant, a.linhas.length];
    const r = await a.ativar();
    assert.deepEqual([r.estado, r.jaAtiva], [auto.ESTADOS.CONECTADO, true]);
    assert.deepEqual([a.chamadas.polling.length, a.chamadas.definirMerchant, a.linhas.length], antes);
    assert.equal((await a.resumo()).estado, auto.ESTADOS.CONECTADO);
  });

  test("token com VÁRIAS lojas livres: o gestor escolhe por ref opaco; ref fora do token = 400", async () => {
    const a = ambiente();
    a.autorizar({ lojas: [M_FEIRA, M_FEIRA_2] });
    const r = await a.ativar();
    assert.deepEqual([r.estado, r.motivo], [auto.ESTADOS.ACAO_NECESSARIA, auto.MOTIVOS.VARIAS_LOJAS]);
    assert.equal(r.opcoes.length, 2);
    assert.ok(!JSON.stringify(r).includes(M_FEIRA) && !JSON.stringify(r).includes(M_FEIRA_2), "a tela nunca recebe o merchant inteiro");
    assert.equal(a.chamadas.polling.length, 0, "nada é verificado antes da escolha");
    await assert.rejects(a.ativar({ ref: auto.refDaLoja(M_SACI) }), (e) => e.codigo === IFOOD_ERROS.IFOOD_AUTOATENDIMENTO_LOJA_INVALIDA);
    const ok = await a.ativar({ ref: auto.refDaLoja(M_FEIRA_2) });
    assert.equal(ok.estado, auto.ESTADOS.CONECTADO);
    assert.equal(conexaoDe(a, FEIRA).merchant_id, M_FEIRA_2);
  });
});

// ===========================================================================
// 3. MERCHANT INCORRETO / 4. MERCHANT JÁ VINCULADO
// ===========================================================================
describe("3. merchant incorreto", () => {
  test("token sem `events` (ou opaco, sem escopo): SEM_LOJA_NO_TOKEN, sem chamada ao iFood", async () => {
    for (const token of [jwt([M_FEIRA], ["order"]), "token-opaco-sem-escopo"]) {
      const a = ambiente();
      a.autorizar({ token });
      const r = await a.ativar();
      assert.deepEqual([r.estado, r.motivo], [auto.ESTADOS.ACAO_NECESSARIA, auto.MOTIVOS.SEM_LOJA_NO_TOKEN]);
      assert.equal(a.chamadas.polling.length, 0);
      assert.equal(conexaoDe(a, FEIRA).status, "pendente");
      assert.deepEqual(a.auditoria.map((x) => [x.acao, x.detalhes.motivo]), [[ACOES.IFOOD_PEDIDOS_ATIVACAO_PENDENTE, "SEM_LOJA_NO_TOKEN"]]);
    }
  });

  test("o iFood recusa a loja (403 unauthorizedMerchants): `rejeitado`, conexão segue pendente, nada promovido", async () => {
    const a = ambiente();
    a.autorizar();
    a.respostasPolling.push(sem403([M_FEIRA]));
    const r = await a.ativar();
    assert.deepEqual([r.estado, r.motivo], [auto.ESTADOS.ACAO_NECESSARIA, auto.MOTIVOS.SEM_AUTORIZACAO]);
    assert.deepEqual([conexaoDe(a, FEIRA).merchant_id, conexaoDe(a, FEIRA).status, a.chamadas.definirMerchant], [null, "pendente", 0]);
    assert.equal(a.linhas[0].estado, "rejeitado");
    assert.equal((await a.resumo()).motivo, auto.MOTIVOS.SEM_AUTORIZACAO);
  });
});

describe("4. merchant já vinculado", () => {
  test("a loja do token é a principal de OUTRA conexão (outra empresa): LOJA_DE_OUTRA_UNIDADE, a dona fica intacta", async () => {
    const a = ambiente();
    a.conectar({ unidadeId: SACI, organizacaoId: ORG, merchantId: M_SACI });
    const antes = foto(a);
    a.autorizar({ lojas: [M_SACI] });
    const r = await a.ativar();
    assert.deepEqual([r.estado, r.motivo], [auto.ESTADOS.ACAO_NECESSARIA, auto.MOTIVOS.LOJA_DE_OUTRA_UNIDADE]);
    assert.equal(foto(a), antes, "Saci intacta");
    assert.deepEqual([a.chamadas.polling.length, a.linhas.length, a.chamadas.definirMerchant], [0, 0, 0]);
  });

  test("a loja do token é loja ADICIONAL de outra unidade (migration 117): também fica de fora", async () => {
    const a = ambiente();
    const saci = a.conectar({ unidadeId: SACI, organizacaoId: ORG, merchantId: M_SACI });
    a.lojasExtras.push({ conexao_id: saci.id, merchant_id: M_SALADAS, estado: "ativa" });
    a.autorizar({ lojas: [M_SALADAS] });
    const r = await a.ativar();
    assert.equal(r.motivo, auto.MOTIVOS.LOJA_DE_OUTRA_UNIDADE);
    assert.equal(a.chamadas.polling.length, 0);
  });

  test("token com a loja de outra unidade + a desta: escolhe sozinho a livre", async () => {
    const a = ambiente();
    a.conectar({ unidadeId: SACI, organizacaoId: ORG, merchantId: M_SACI });
    a.autorizar({ lojas: [M_SACI, M_FEIRA] });
    const r = await a.ativar();
    assert.equal(r.estado, auto.ESTADOS.CONECTADO);
    assert.equal(conexaoDe(a, FEIRA).merchant_id, M_FEIRA);
    assert.equal(conexaoDe(a, SACI).merchant_id, M_SACI);
  });

  test("loja em vínculo ABERTO de outra conexão (outra unidade validando): fica de fora", async () => {
    const a = ambiente();
    a.autorizar({ unidadeId: UN_OUTRA_ORG, organizacaoId: OUTRA_ORG, lojas: [M_FEIRA] });
    a.respostasPolling.push(new Error("timeout"));   // a outra unidade fica `validando_loja` com o vínculo aberto
    const outra = await auto.ativar({ organizacaoId: OUTRA_ORG, unidadeId: UN_OUTRA_ORG, usuarioId: "u2", deps: a.deps });
    assert.equal(outra.estado, auto.ESTADOS.VALIDANDO_LOJA);
    a.autorizar({ lojas: [M_FEIRA] });
    const r = await a.ativar();
    assert.equal(r.motivo, auto.MOTIVOS.LOJA_DE_OUTRA_UNIDADE);
  });
});

// ===========================================================================
// 5. OAUTH EXPIRADO/NEGADO  e  6. CREDENCIAL INVÁLIDA/REVOGADA
// ===========================================================================
describe("5/6. OAuth não concluído, credencial inválida ou revogada", () => {
  test("OAuth expirado/negado: não há credencial gravada -> `nao_conectado` (a ativação só roda depois do OAuth gravado)", async () => {
    const a = ambiente();
    a.conectar({ unidadeId: FEIRA, organizacaoId: ORG_FEIRA, apps: [], finalidade: "pedidos_producao" });   // sessão sem token
    assert.equal((await a.ativar()).estado, auto.ESTADOS.NAO_CONECTADO);
    assert.equal(a.chamadas.polling.length, 0);
    const fonte = ler("src/modules/ifood/ifoodAuth.service.js");
    const iGravacao = fonte.indexOf("gravarCredencialComProtecao(");
    const iAtivacao = fonte.indexOf("ativarPedidos({ organizacaoId");
    assert.ok(iGravacao > 0 && iAtivacao > iGravacao, "a ativação vem depois da gravação da credencial (sessão expirada/negada lança antes)");
  });

  test("credencial reauth_required: Ação necessária (REAUTORIZAR), nada consultado", async () => {
    const a = ambiente();
    a.autorizar({ status: "reauth_required" });
    const r = await a.ativar();
    assert.deepEqual([r.estado, r.motivo], [auto.ESTADOS.ACAO_NECESSARIA, auto.MOTIVOS.REAUTORIZAR]);
    assert.equal((await a.resumo()).motivo, auto.MOTIVOS.REAUTORIZAR);
    assert.equal(a.chamadas.polling.length, 0);
  });

  test("credencial em qualquer outro estado (revogada/inválida): `nao_conectado`", async () => {
    const a = ambiente();
    a.autorizar({ status: "revogada" });
    assert.equal((await a.ativar()).estado, auto.ESTADOS.NAO_CONECTADO);
    assert.equal(a.chamadas.polling.length, 0);
  });

  test("token que não decifra: tratado como sem prova (SEM_LOJA_NO_TOKEN), nunca erro 500", async () => {
    const a = ambiente();
    a.autorizar();
    a.credenciais.at(-1).access_token_cifrado = "lixo";
    assert.equal((await a.ativar()).motivo, auto.MOTIVOS.SEM_LOJA_NO_TOKEN);
  });
});

// ===========================================================================
// 7. FALHA NO PRIMEIRO POLLING  e  8. RECONEXÃO
// ===========================================================================
describe("7. falha na primeira verificação", () => {
  test("falha transitória: `validando_loja` recuperável; o freio de 10 min vale; depois verifica e ativa", async () => {
    const a = ambiente();
    a.autorizar();
    a.respostasPolling.push(new Error("ECONNRESET"));
    const r1 = await a.ativar();
    assert.deepEqual([r1.estado, r1.motivo], [auto.ESTADOS.VALIDANDO_LOJA, auto.MOTIVOS.VERIFICACAO_FALHOU]);
    assert.deepEqual([conexaoDe(a, FEIRA).status, a.linhas[0].estado], ["pendente", "aguardando_validacao"]);
    const s = await a.resumo();
    assert.deepEqual([s.estado, s.podeVerificar], [auto.ESTADOS.VALIDANDO_LOJA, true]);
    const r2 = await a.ativar();   // clique imediato: o freio do vínculo segura a 2ª consulta
    assert.equal(r2.motivo, auto.MOTIVOS.TENTATIVAS_ESGOTADAS);
    assert.equal(a.chamadas.polling.length, 1);
    a.relogio.ms += 11 * 60_000;
    const r3 = await a.ativar();
    assert.equal(r3.estado, auto.ESTADOS.CONECTADO);
    assert.equal(a.chamadas.polling.length, 2);
    assert.equal(a.chamadas.ack.length, 0);
  });

  test("falha DEPOIS do OAuth nunca derruba a autorização gravada (concluirAutorizacao captura)", () => {
    const fonte = ler("src/modules/ifood/ifoodAuth.service.js");
    assert.match(fonte, /await ativarPedidos\([^\n]*\n\s*\.catch\(/, "a ativação pós-OAuth tem catch");
    assert.match(fonte, /appType === IFOOD_APP_ORDER && !loja && token\.autoatendimentoOrderHabilitado\?\.\(\) === true/, "só Order, só sem loja-alvo, só com a flag");
  });
});

describe("8. reconexão", () => {
  test("desconectar e conectar de novo: a conexão antiga fica revogada (não reusada) e a nova é ativada com a mesma loja", async () => {
    const a = ambiente();
    const antiga = a.autorizar();
    await a.ativar();
    antiga.status = "revogada";                         // o que desconectar() faz (credenciais apagadas, vínculos cancelados)
    const nova = a.autorizar();
    a.relogio.ms += 60_000;
    const r = await a.ativar();
    assert.equal(r.estado, auto.ESTADOS.CONECTADO);
    assert.notEqual(nova.id, antiga.id);
    assert.deepEqual([conexaoDe(a, FEIRA).id, conexaoDe(a, FEIRA).merchant_id], [nova.id, M_FEIRA]);
  });

  test("reautorização que trocou as lojas do token: o vínculo aberto da loja antiga não é aproveitado", async () => {
    const a = ambiente();
    a.autorizar({ lojas: [M_FEIRA] });
    a.respostasPolling.push(new Error("timeout"));
    await a.ativar();                                   // vínculo aberto com M_FEIRA
    a.credenciais.at(-1).access_token_cifrado = cifrar(jwt([M_FEIRA_2]));
    a.relogio.ms += 11 * 60_000;
    const r = await a.ativar();
    assert.equal(r.estado, auto.ESTADOS.CONECTADO);
    assert.equal(conexaoDe(a, FEIRA).merchant_id, M_FEIRA_2);
    assert.ok(a.linhas.some((v) => v.merchant_id === M_FEIRA && v.estado === "cancelado"), "o vínculo antigo fica no histórico, cancelado");
  });
});

// ===========================================================================
// 9. CONEXÕES SIMULTÂNEAS  e  10. DUPLO CLIQUE
// ===========================================================================
describe("9/10. concorrência", () => {
  test("duas empresas ao mesmo tempo, cada uma com a sua loja: as duas ativam, cada uma com o próprio merchant", async () => {
    const a = ambiente();
    a.autorizar({ unidadeId: FEIRA, organizacaoId: ORG_FEIRA, lojas: [M_FEIRA] });
    a.autorizar({ unidadeId: UN_OUTRA_ORG, organizacaoId: OUTRA_ORG, lojas: [M_OUTRA_ORG] });
    const [r1, r2] = await Promise.all([
      a.ativar(),
      auto.ativar({ organizacaoId: OUTRA_ORG, unidadeId: UN_OUTRA_ORG, usuarioId: "u2", deps: a.deps }),
    ]);
    assert.deepEqual([r1.estado, r2.estado], [auto.ESTADOS.CONECTADO, auto.ESTADOS.CONECTADO]);
    assert.equal(conexaoDe(a, FEIRA).merchant_id, M_FEIRA);
    assert.equal(conexaoDe(a, UN_OUTRA_ORG).merchant_id, M_OUTRA_ORG);
    assert.deepEqual(a.chamadas.polling.map((m) => m[0]).sort(), [M_FEIRA, M_OUTRA_ORG].sort(), "cada verificação só da própria loja");
  });

  test("duas unidades disputando a MESMA loja ao mesmo tempo: no máximo uma ativa; a outra recebe LOJA_DE_OUTRA_UNIDADE", async () => {
    const a = ambiente();
    a.autorizar({ unidadeId: FEIRA, organizacaoId: ORG_FEIRA, lojas: [M_FEIRA] });
    a.autorizar({ unidadeId: UN_OUTRA_ORG, organizacaoId: OUTRA_ORG, lojas: [M_FEIRA] });
    const rs = await Promise.all([
      a.ativar(),
      auto.ativar({ organizacaoId: OUTRA_ORG, unidadeId: UN_OUTRA_ORG, usuarioId: "u2", deps: a.deps }),
    ]);
    const donas = a.conexoes.filter((c) => c.merchant_id === M_FEIRA);
    assert.equal(donas.length, 1, "o merchant fica em UMA conexão só");
    assert.equal(rs.filter((r) => r.estado === auto.ESTADOS.CONECTADO).length, 1);
    assert.equal(rs.filter((r) => r.motivo === auto.MOTIVOS.LOJA_DE_OUTRA_UNIDADE).length, 1);
  });

  test("duplo clique na mesma unidade: uma consulta, uma promoção, nenhuma mensagem falsa de \"outra unidade\"", async () => {
    const a = ambiente();
    a.autorizar();
    const rs = await Promise.all([a.ativar(), a.ativar(), a.ativar()]);
    assert.ok(rs.every((r) => r.motivo !== auto.MOTIVOS.LOJA_DE_OUTRA_UNIDADE), JSON.stringify(rs));
    assert.ok(rs.some((r) => r.estado === auto.ESTADOS.CONECTADO));
    assert.equal(a.chamadas.polling.length, 1, "o compare-and-set do vínculo deixa passar uma consulta só");
    assert.equal(a.chamadas.definirMerchant, 1);
    assert.equal(a.linhas.filter((v) => v.estado === "validado").length, 1);
    assert.equal((await a.ativar()).estado, auto.ESTADOS.CONECTADO);
  });
});

// ===========================================================================
// 11. PERMISSÃO / 12. ISOLAMENTO  (router REAL)
// ===========================================================================
describe("11/12. rota POST /pedidos/ativacao — permissão, módulo, tenant e flag", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", (req, _res, next) => {
    req.user = { id: String(req.headers["x-teste-user"] ?? "u") };
    const papel = req.headers["x-teste-papel"];
    if (papel) {
      const modulos = req.headers["x-teste-sem-modulo"] ? [] : [MODULOS.IFOOD];
      req.acesso = { papel, permissoes: permissoesDoPapel(papel), modulos, impersonando: false };
      req.tenant = { organizacaoId: ORG_FEIRA, unidadeId: req.headers["x-teste-unidade"] ? String(req.headers["x-teste-unidade"]) : null };
    }
    next();
  }, requireModulo(MODULOS.IFOOD), ifoodRouter);
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());

  const chamar = ({ papel = "unit_manager", unidade = FEIRA, corpo, semModulo = false } = {}) => new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json", "x-teste-user": `u-${Math.random()}`, "x-teste-papel": papel };
    if (unidade) headers["x-teste-unidade"] = unidade;
    if (semModulo) headers["x-teste-sem-modulo"] = "1";
    const dados = corpo === undefined ? null : JSON.stringify(corpo);
    if (dados) headers["content-length"] = Buffer.byteLength(dados);
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method: "POST", path: "/api/v1/pedidos/ativacao", headers, agent: false }, (res) => {
      let t = "";
      res.on("data", (c) => { t += c; });
      res.on("end", () => { let json = null; try { json = JSON.parse(t); } catch { /* vazio */ } resolve({ status: res.statusCode, json, texto: t }); });
    });
    req.on("error", reject);
    req.end(dados ?? undefined);
  });

  test("papéis sem integracoes.gerenciar (Consulta, Operação, Financeiro): 403", async () => {
    for (const papel of ["viewer", "operations", "finance"]) {
      const r = await chamar({ papel });
      if (permissoesDoPapel(papel).includes("integracoes.gerenciar")) continue;   // o papel tem a permissão neste catálogo
      assert.equal(r.status, 403, papel);
    }
    assert.equal((await chamar({ papel: "viewer" })).status, 403);
  });

  test("unidade sem o módulo iFood: 403 antes da rota", async () => {
    assert.equal((await chamar({ semModulo: true })).status, 403);
  });

  test("sem unidade selecionada: 400; ref fora do formato: 400 sem ecoar o valor", async () => {
    assert.equal((await chamar({ unidade: null })).status, 400);
    const r = await chamar({ corpo: { ref: "<script>x</script>" } });
    assert.equal(r.status, 400);
    assert.ok(!r.texto.includes("<script>"));
  });

  test("flag desligada: 403 IFOOD_AUTOATENDIMENTO_DESLIGADO", async () => {
    assert.equal(config.ifood.orderAutoatendimento, false);
    const r = await chamar({ corpo: {} });
    assert.equal(r.status, 403);
    assert.equal(r.json?.error?.code ?? r.json?.code ?? r.json?.error?.codigo ?? r.json?.codigo, "IFOOD_AUTOATENDIMENTO_DESLIGADO", r.texto);
  });

  test("o corpo nunca escolhe organização/unidade/merchant: o controller só lê `ref`", () => {
    const fonte = ler("src/modules/ifood/ifood.controller.js");
    const corpo = fonte.slice(fonte.indexOf("export const ativarPedidos"), fonte.indexOf("export const status"));
    assert.match(corpo, /tenant\(req\)/);
    assert.ok(!/req\.body\?\.(organizacaoId|unidadeId|merchantId|conexaoId)/.test(corpo));
  });
});

describe("12. isolamento entre empresas (serviço)", () => {
  test("a conexão de uma empresa nunca é lida/ativada com o tenant de outra", async () => {
    const a = ambiente();
    a.autorizar({ unidadeId: FEIRA, organizacaoId: ORG_FEIRA });
    const r = await auto.ativar({ organizacaoId: OUTRA_ORG, unidadeId: FEIRA, usuarioId: "intruso", deps: a.deps });
    assert.equal(r.estado, auto.ESTADOS.NAO_CONECTADO);
    assert.deepEqual([a.chamadas.polling.length, a.linhas.length, conexaoDe(a, FEIRA).status], [0, 0, "pendente"]);
  });

  test("defesa em profundidade: repositório que devolve conexão de outro tenant é ignorado", async () => {
    const a = ambiente();
    a.autorizar();
    const repo = { ...a.repo, obterConexaoViva: async () => ({ ...a.conexoes[0], organizacao_id: OUTRA_ORG }) };
    const r = await auto.ativar({ organizacaoId: ORG_FEIRA, unidadeId: FEIRA, deps: { ...a.deps, repo } });
    assert.equal(r.estado, auto.ESTADOS.NAO_CONECTADO);
  });
});

// ===========================================================================
// 13. ORDER + FINANCIAL  /  14. LOJAS ADICIONAIS  /  15. SACI E NORTH PRESERVADAS
// ===========================================================================
describe("13/14/15. coexistência e conexões em produção", () => {
  test("unidade com conexão do Financial de homologação: a ativação usa SÓ a conexão de pedidos; a financeira fica intacta", async () => {
    const a = ambiente();
    const fin = a.conectar({ unidadeId: FEIRA, organizacaoId: ORG_FEIRA, apps: ["financial"], merchantId: M_FEIRA_2, finalidade: "financeiro_homologacao" });
    const antes = JSON.stringify(fin);
    const ped = a.autorizar({ lojas: [M_FEIRA] });
    const r = await a.ativar();
    assert.equal(r.estado, auto.ESTADOS.CONECTADO);
    assert.equal(a.conexoes.find((c) => c.id === ped.id).merchant_id, M_FEIRA);
    assert.equal(JSON.stringify(a.conexoes.find((c) => c.id === fin.id)), antes);
  });

  test("OAuth de loja ADICIONAL nunca dispara a ativação (fluxo próprio, supervisionado)", () => {
    const fonte = ler("src/modules/ifood/ifoodAuth.service.js");
    assert.match(fonte, /IFOOD_APP_ORDER && !loja && /);
  });

  test("Saci/North (conexão ativa com loja): ativar devolve `conectado` sem consultar, sem gravar, sem vínculo novo", async () => {
    const a = ambiente();
    a.conectar({ unidadeId: SACI, organizacaoId: ORG, merchantId: M_SACI, finalidade: "pedidos_producao" });
    a.conectar({ unidadeId: NORTH, organizacaoId: ORG, merchantId: M_NORTH, finalidade: "pedidos_producao" });
    for (const c of a.credenciais) c.access_token_cifrado = cifrar(jwt([M_SACI, M_NORTH, M_FEIRA]));
    const antes = foto(a);
    for (const unidadeId of [SACI, NORTH]) {
      const r = await auto.ativar({ organizacaoId: ORG, unidadeId, usuarioId: GESTOR, deps: a.deps });
      assert.deepEqual([r.estado, r.jaAtiva], [auto.ESTADOS.CONECTADO, true]);
    }
    assert.equal(foto(a), antes);
    assert.deepEqual([a.chamadas.polling.length, a.chamadas.definirMerchant, a.linhas.length, a.auditoria.length], [0, 0, 0, 0]);
  });

  test("flag desligada: o bloco de pedidos do status da Saci não ganha nada (autoatendimento: null)", async () => {
    const a = criarAmbiente({ piloto: [SACI] });
    a.conectar({ unidadeId: SACI, organizacaoId: ORG, merchantId: M_SACI });
    const s = await conexaoSvc.obterStatus({ organizacaoId: ORG, unidadeId: SACI, deps: { repo: a.repo, vinculos: a.vinculos, agora: a.deps.agora } });
    assert.equal(s.order.autoatendimento, null);
  });
});

// ===========================================================================
// 16. ESCOPO DO POLLER, EVENTOS E ACK  /  17. CHECKLIST RECEBE OS PEDIDOS DA LOJA CERTA
// ===========================================================================
describe("16/17. poller: escopo, eventos/ACK e a loja certa", () => {
  test("unidadesOrderNoEscopo: flag off = só o piloto; on = piloto ∪ ativadas; falha de leitura = só o piloto", async () => {
    const listar = async () => [FEIRA.toUpperCase()];
    assert.deepEqual(await tokenReal.unidadesOrderNoEscopo({ listarAtivadas: listar }), [SACI]);
    config.ifood.orderAutoatendimento = true;
    try {
      assert.deepEqual((await tokenReal.unidadesOrderNoEscopo({ listarAtivadas: listar })).sort(), [FEIRA, SACI].sort());
      const logs = [];
      const r = await tokenReal.unidadesOrderNoEscopo({ listarAtivadas: async () => { throw new Error("tabela fora"); }, log: (...x) => logs.push(x) });
      assert.deepEqual(r, [SACI], "o recebimento da Saci nunca depende desta consulta");
      assert.equal(logs[0][1], "events.escopo_autoatendimento_indisponivel");
      assert.deepEqual(await tokenReal.unidadesOrderNoEscopo({}), [SACI], "sem fonte = só o piloto");
    } finally { config.ifood.orderAutoatendimento = false; }
  });

  test("listarUnidadesComOrderAtivado: só vínculo `validado` de conexão `ativa` com o MESMO merchant e unidade", async () => {
    const tabelas = {
      ifood_merchant_vinculos: [
        { conexao_id: "c-ok", unidade_id: FEIRA, merchant_id: M_FEIRA, estado: "validado" },
        { conexao_id: "c-revogada", unidade_id: "u-rev", merchant_id: M_FEIRA_2, estado: "validado" },
        { conexao_id: "c-trocou", unidade_id: "u-troca", merchant_id: M_OUTRA_ORG, estado: "validado" },
        { conexao_id: "c-aberta", unidade_id: "u-aberta", merchant_id: M_NORTH, estado: "aguardando_validacao" },
      ],
      ifood_conexoes: [
        { id: "c-ok", unidade_id: FEIRA, merchant_id: M_FEIRA, status: "ativa" },
        { id: "c-revogada", unidade_id: "u-rev", merchant_id: M_FEIRA_2, status: "revogada" },
        { id: "c-trocou", unidade_id: "u-troca", merchant_id: M_SALADAS, status: "ativa" },
        { id: "c-aberta", unidade_id: "u-aberta", merchant_id: null, status: "pendente" },
      ],
    };
    const db = { from(t) {
      let linhas = [...tabelas[t]];
      const q = {
        select: () => q,
        eq: (c, v) => { linhas = linhas.filter((l) => l[c] === v); return q; },
        in: (c, vs) => { linhas = linhas.filter((l) => vs.includes(l[c])); return q; },
        then: (ok, erro) => Promise.resolve({ data: linhas, error: null }).then(ok, erro),
      };
      return q;
    } };
    assert.deepEqual(await vinculoRepoReal.listarUnidadesComOrderAtivado({ db }), [FEIRA]);
  });

  test("ciclo do poller: a unidade ativada entra no escopo sem restart; a conectada sem ativação fica fora; eventos vão para a conexão da loja certa e só eles recebem ACK", async () => {
    const ORG_A = "org-saci", ORG_B = "org-feira", ORG_C = "org-pendente";
    const C_SACI = { id: "con-saci", organizacao_id: ORG_A, unidade_id: SACI, merchant_id: M_SACI };
    const C_FEIRA = { id: "con-feira", organizacao_id: ORG_B, unidade_id: FEIRA, merchant_id: M_FEIRA };
    const C_PEND = { id: "con-pend", organizacao_id: ORG_C, unidade_id: "00000000-0000-0000-0000-0000000000e9", merchant_id: M_FEIRA_2 };
    const relogio = criarRelogio();
    const repo = criarRepoEmMemoria({ relogio, conexoes: [C_SACI, C_FEIRA, C_PEND] });
    let ativadas = [];
    repo.listarUnidadesComOrderAtivado = async () => ativadas;
    const porMerchant = { [M_SACI]: [ev("e-saci", "PLC", { merchantId: M_SACI, orderId: "o-saci" })], [M_FEIRA]: [ev("e-feira", "PLC", { merchantId: M_FEIRA, orderId: "o-feira" })], [M_FEIRA_2]: [ev("e-pend", "PLC", { merchantId: M_FEIRA_2, orderId: "o-pend" })] };
    const client = criarClienteFake(clienteReal, { respostasPolling: Array.from({ length: 20 }, () => ({ merchantIds }) => merchantIds.flatMap((m) => porMerchant[m]?.splice(0) ?? [])) });
    const token = { ...criarTokenFake({ escopo: "conexao" }), unidadesOrderNoEscopo: tokenReal.unidadesOrderNoEscopo, unidadesPilotoOrder: tokenReal.unidadesPilotoOrder };
    const poller = criarPoller({ repo, token, client, holder: "w1", agora: relogio.agora, log: () => {}, leaseTtlS: 90 });   // escopo PADRÃO do poller
    const consultados = () => [...new Set(client.polls.flatMap((p) => p.merchantIds))].sort();

    config.ifood.orderAutoatendimento = true;
    try {
      await poller.executarCiclo();
      assert.deepEqual(consultados(), [M_SACI], "antes da ativação: só o piloto");
      ativadas = [FEIRA];                                   // a ativação gravou o vínculo `validado` (lido a cada ciclo)
      relogio.avancarS(31);
      await poller.executarCiclo();
      assert.deepEqual(consultados(), [M_FEIRA, M_SACI].sort(), "a Feira entra no ciclo seguinte; a conexão sem ativação continua fora");
      const feira = repo.eventos.get("e-feira");
      assert.deepEqual([feira.organizacao_id, feira.unidade_id, feira.conexao_id], [ORG_B, FEIRA, "con-feira"], "o pedido vai para a unidade dona da loja");
      assert.equal(repo.eventos.has("e-pend"), false);
      const reconhecidos = client.acks.flatMap((x) => x.eventIds).sort();
      assert.deepEqual(reconhecidos, ["e-feira", "e-saci"], "ACK só do que foi gravado, nunca da loja fora do escopo");
    } finally { config.ifood.orderAutoatendimento = false; }
  });
});

// ===========================================================================
// SALVAGUARDAS DE CÓDIGO
// ===========================================================================
describe("salvaguardas", () => {
  test("o autoatendimento nunca reconhece eventos, nunca grava pedido e nunca toca loja adicional", () => {
    const fonte = ler("src/modules/ifood/ifoodOrderAutoatendimento.service.js").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!/confirmarEventos|processarLote|inserirEventos|garantirPedido|marcarAck|buscarEventos/.test(fonte));
    assert.ok(!/ifood_conexao_lojas|definirMerchantDaConexao|atualizarConexao|apagarCredenciais/.test(fonte), "a promoção passa SÓ por concluirValidacao");
  });

  test("o modo automático é um Symbol do servidor: nunca chega pela requisição", () => {
    const controller = ler("src/modules/ifood/ifood.controller.js");
    assert.ok(!/MODO_AUTOATENDIMENTO/.test(controller));
    const vinculoSvc = ler("src/modules/ifood/ifoodMerchantVinculo.service.js");
    assert.match(vinculoSvc, /export const MODO_AUTOATENDIMENTO = Symbol\(/);
  });

  test("a flag é fail-closed e documentada no .env.example", () => {
    assert.match(ler("src/config/env.js"), /orderAutoatendimento: process\.env\.IFOOD_ORDER_SELF_SERVICE_ENABLED === "true"/);
    assert.match(ler(".env.example"), /IFOOD_ORDER_SELF_SERVICE_ENABLED=false/);
  });
});
