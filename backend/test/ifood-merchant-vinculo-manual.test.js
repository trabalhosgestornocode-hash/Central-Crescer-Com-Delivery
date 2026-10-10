// iFood — conexão Order SEM Financial e vínculo MANUAL do merchant (Checkpoint 6E.4).
//
// O app distribuído de pedidos (Order + Events) não tem Merchant API nem Financial. A unidade piloto:
//   1. autoriza o app Order (OAuth) sem loja vinculada;
//   2. informa o ID da loja (Portal do Parceiro)            -> `informado`
//   3. confere o ID                                          -> `aguardando_validacao`
//   4. [flag] verificação de autorização no iFood            -> evidência, ou `rejeitado`
//   5. [flag] validação final com declarações explícitas     -> `validado` (merchant vai para ifood_conexoes)
//
// Enquanto não for `validado`, a conexão segue `pendente` e sem merchant: o poller não enxerga a unidade.
//
// Sem rede e sem banco: repositórios em memória, token e cliente de Events falsos. Nenhuma chamada real ao
// iFood, nenhum OAuth real, nenhum polling real, nenhum ACK.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SACI, NORTH, ORG, OUTRA_ORG, UN_OUTRA_ORG, GESTOR } from "./helpers/ifood-vinculo-fakes.js";   // só constantes e ifood.errors (sem config)
process.env.IFOOD_ORDER_PILOT_UNITS = `${SACI},${UN_OUTRA_ORG}`;
process.env.IFOOD_ORDER_CLIENT_ID = "order-client-id-de-teste";
process.env.IFOOD_ORDER_CLIENT_SECRET = "order-client-secret-de-teste";
process.env.IFOOD_TOKEN_SECRET = "segredo-de-teste-com-mais-de-16-caracteres";   // só para cifrar o verifier falso
delete process.env.IFOOD_ORDER_MERCHANT_VALIDACAO_ENABLED;   // padrão: validação final DESLIGADA

const express = (await import("express")).default;
const { criarAmbiente } = await import("./helpers/ifood-vinculo-fakes.js");
const svc = await import("../src/modules/ifood/ifoodMerchantVinculo.service.js");
const vinculoRepoReal = await import("../src/modules/ifood/ifoodMerchantVinculo.repository.js");
const conexaoSvc = await import("../src/modules/ifood/ifoodConnection.service.js");
const authSvc = await import("../src/modules/ifood/ifoodAuth.service.js");
const tokenReal = await import("../src/modules/ifood/ifoodToken.service.js");
const { ifoodErro, IFOOD_ERROS } = await import("../src/modules/ifood/ifood.errors.js");
const { ifoodRouter } = await import("../src/modules/ifood/ifood.routes.js");
const { requireModulo } = await import("../src/middlewares/auth.js");
const { errorHandler } = await import("../src/middlewares/errorHandler.js");
const { MODULOS } = await import("../src/shared/modulos.js");
const { permissoesDoPapel } = await import("../src/shared/permissoes.js");
const { config } = await import("../src/config/env.js");

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(path.join(AQUI, "..", p), "utf8");

const M_SACI = "aaaaaaaa-1111-4111-8111-00000000000a";
const M_NORTH = "bbbbbbbb-2222-4222-8222-00000000000b";
const M_OUTRO = "cccccccc-3333-4333-8333-00000000000c";

const erro = (codigo) => (e) => e?.codigo === codigo;
const sem403 = (ids) => ifoodErro(IFOOD_ERROS.IFOOD_MERCHANT_SEM_PERMISSAO, { detalhes: { unauthorizedMerchants: ids } });
/** Leva o vínculo da Saci até `aguardando_validacao`. */
async function ateAguardando(a, merchantId = M_SACI) {
  await svc.informarMerchant(a.p({ merchantId }));
  return svc.confirmarMerchant(a.p({ merchantId }));
}

// ===========================================================================
// 1. OAUTH ORDER SEM MERCHANT E SEM FINANCIAL
// ===========================================================================
describe("OAuth Order sem loja vinculada", () => {
  function depsOAuth({ unidadeId = SACI } = {}) {
    const estado = { sessao: null, conexao: null, tokensSalvos: [], posts: [] };
    const repo = {
      async expirarSessoesVencidas() {},
      async criarSessaoOAuth(d) { estado.sessao = { id: "sess-1", status: "pending", unidade_id: d.unidadeId, organizacao_id: d.organizacaoId, app_type: d.appType, authorization_code_verifier_cifrado: d.verifierCifrado, expira_em: d.expiraEm, verification_url: d.verificationUrl, verification_url_complete: d.verificationUrlComplete }; return estado.sessao; },
      async obterSessaoOAuth({ organizacaoId, unidadeId: u, sessaoId, appType }) {
        const s = estado.sessao;
        if (!s || s.id !== sessaoId || s.organizacao_id !== organizacaoId || s.unidade_id !== u || s.app_type !== appType) throw ifoodErro(IFOOD_ERROS.IFOOD_OAUTH_SESSAO_NAO_ENCONTRADA);
        return s;
      },
      async reivindicarSessaoOAuth() { return true; },
      async fecharSessaoOAuth({ status }) { estado.sessao.status = status; },
      async obterOuCriarConexao({ organizacaoId, unidadeId: u }) { estado.conexao ??= { id: "con-nova", organizacao_id: organizacaoId, unidade_id: u, status: "pendente", merchant_id: null }; return estado.conexao; },
    };
    const http = { async postForm(rota, corpo) { estado.posts.push({ rota, corpo }); return { userCode: "ABCD-EFGH", authorizationCodeVerifier: "verifier-de-teste", verificationUrl: "https://portal.exemplo/codigo", verificationUrlComplete: "https://portal.exemplo/codigo?c=ABCD-EFGH", expiresIn: 600 }; } };
    const token = {
      ...tokenReal,
      async trocarAuthorizationCodePorToken(a) { estado.troca = a; return { accessToken: "a", refreshToken: "r", expiresIn: 10_800 }; },
      async salvarTokens(a) { estado.tokensSalvos.push({ conexaoId: a.conexaoId, appType: a.appType }); },
    };
    return { estado, deps: { repo, http, token }, unidadeId };
  }

  test("Saci na allowlist, SEM Financial e SEM merchant: inicia e conclui o OAuth Order; a conexão nasce `pendente`", async () => {
    const { estado, deps } = depsOAuth();
    const inicio = await authSvc.iniciarConexao({ organizacaoId: ORG, unidadeId: SACI, appType: "order", usuarioId: GESTOR, deps });
    assert.equal(inicio.appType, "order");
    assert.equal(estado.posts.length, 1, "uma chamada de userCode (falsa)");
    assert.equal(estado.posts[0].corpo.clientId, "order-client-id-de-teste", "usa o app Order — nunca o Financial");
    const fim = await authSvc.concluirAutorizacao({ organizacaoId: ORG, unidadeId: SACI, appType: "order", sessaoId: inicio.sessionId, authorizationCode: "codigo-do-portal", usuarioId: GESTOR, deps });
    assert.deepEqual(fim, { appType: "order", status: "authorized", conexaoStatus: "pendente" });
    assert.deepEqual(estado.tokensSalvos, [{ conexaoId: "con-nova", appType: "order" }]);
    assert.equal(estado.conexao.merchant_id, null, "o OAuth não vincula loja nenhuma");
    assert.equal(estado.troca.unidadeId, SACI);
  });

  test("unidade FORA da allowlist: recusada no início e na conclusão, sem chamada ao iFood", async () => {
    const { estado, deps } = depsOAuth();
    await assert.rejects(authSvc.iniciarConexao({ organizacaoId: ORG, unidadeId: NORTH, appType: "order", usuarioId: GESTOR, deps }), erro("IFOOD_ORDER_PILOTO_NAO_HABILITADO"));
    await assert.rejects(authSvc.concluirAutorizacao({ organizacaoId: ORG, unidadeId: NORTH, appType: "order", sessaoId: "sess-1", authorizationCode: "x", usuarioId: GESTOR, deps }), erro("IFOOD_ORDER_PILOTO_NAO_HABILITADO"));
    assert.equal(estado.posts.length, 0);
    assert.equal(estado.sessao, null);
  });

  test("sessão OAuth de uma unidade não conclui em outra (estado do OAuth preso ao tenant)", async () => {
    const { deps } = depsOAuth();
    const inicio = await authSvc.iniciarConexao({ organizacaoId: ORG, unidadeId: SACI, appType: "order", usuarioId: GESTOR, deps });
    await assert.rejects(
      authSvc.concluirAutorizacao({ organizacaoId: OUTRA_ORG, unidadeId: UN_OUTRA_ORG, appType: "order", sessaoId: inicio.sessionId, authorizationCode: "x", usuarioId: "intruso", deps }),
      erro("IFOOD_OAUTH_SESSAO_NAO_ENCONTRADA"));
  });

  test("o serviço de OAuth não foi alterado por este checkpoint (nenhuma exigência de merchant ou Financial nele)", () => {
    const fonte = ler("src/modules/ifood/ifoodAuth.service.js");
    assert.ok(!/merchant_id|FINANCIAL|vinculo/i.test(fonte.replace(/\/\/.*$/gm, "")), "o OAuth não depende de loja nem de Financial");
  });
});

// ===========================================================================
// 2. INFORMAR O MERCHANT
// ===========================================================================
describe("informar o ID da loja", () => {
  test("OAuth concluído sem merchant: informar cria `informado`, sem chamar o iFood e sem tocar na conexão", async () => {
    const a = criarAmbiente();
    const con = a.conectar();
    const r = await svc.informarMerchant(a.p({ merchantId: `  ${M_SACI.toUpperCase()} ` }));
    assert.equal(r.vinculo.estado, "informado");
    assert.equal(a.linhas.length, 1);
    assert.deepEqual([a.linhas[0].merchant_id, a.linhas[0].informado_por, a.linhas[0].conexao_id], [M_SACI, GESTOR, con.id], "ID normalizado, com autor");
    assert.deepEqual([a.conexoes[0].merchant_id, a.conexoes[0].status], [null, "pendente"], "a conexão NÃO recebe o merchant");
    assert.equal(a.chamadas.token.length + a.chamadas.polling.length + a.chamadas.ack.length, 0);
  });

  test("resposta e log nunca trazem o merchant inteiro, token ou id de usuário", async () => {
    const a = criarAmbiente();
    a.conectar();
    const r = await svc.informarMerchant(a.p({ merchantId: M_SACI }));
    const publico = JSON.stringify(r) + JSON.stringify(a.logs.map((l) => l.dados.merchantId));
    assert.ok(!publico.includes(M_SACI));
    assert.match(r.vinculo.idMascarado, /…|\*|\.\.\./);
    assert.ok(!("informado_por" in r.vinculo) && !("merchant_id" in r.vinculo));
  });

  test("unidade fora da allowlist: recusada antes de qualquer leitura", async () => {
    const a = criarAmbiente();
    a.conectar({ unidadeId: NORTH });
    await assert.rejects(svc.informarMerchant(a.p({ unidadeId: NORTH, merchantId: M_NORTH })), erro("IFOOD_ORDER_PILOTO_NAO_HABILITADO"));
    assert.equal(a.linhas.length, 0);
  });

  test("unidade removida da allowlist depois: informar e conferir passam a ser recusados", async () => {
    const a = criarAmbiente();
    a.conectar();
    await svc.informarMerchant(a.p({ merchantId: M_SACI }));
    a.cfg.piloto.delete(SACI);
    await assert.rejects(svc.confirmarMerchant(a.p({ merchantId: M_SACI })), erro("IFOOD_ORDER_PILOTO_NAO_HABILITADO"));
    assert.equal(a.linhas[0].estado, "informado");
  });

  test("sem conexão, só com Financial/Analytics, ou com Order em reauth: exige o Order conectado", async () => {
    const semConexao = criarAmbiente();
    await assert.rejects(svc.informarMerchant(semConexao.p({ merchantId: M_SACI })), erro("IFOOD_ORDER_NAO_CONECTADO"));

    const soFinancial = criarAmbiente();
    soFinancial.conectar({ apps: ["financial", "analytics"] });
    await assert.rejects(svc.informarMerchant(soFinancial.p({ merchantId: M_SACI })), erro("IFOOD_ORDER_NAO_CONECTADO"));

    const reauth = criarAmbiente();
    reauth.conectar();
    reauth.credenciais[0].status = "reauth_required";
    await assert.rejects(svc.informarMerchant(reauth.p({ merchantId: M_SACI })), erro("IFOOD_ORDER_NAO_CONECTADO"));
    assert.equal(soFinancial.linhas.length + reauth.linhas.length, 0);
  });

  test("ID fora do formato do iFood é recusado (nada é gravado)", async () => {
    const a = criarAmbiente();
    a.conectar();
    for (const ruim of ["", "   ", "123", "loja-do-saci", "aaaaaaaa-1111-4111-8111-00000000000", `${M_SACI}'; drop table x;--`, null, undefined, 42, { id: M_SACI }, [M_SACI]]) {
      await assert.rejects(svc.informarMerchant(a.p({ merchantId: ruim })), erro("IFOOD_MERCHANT_ID_INVALIDO"));
    }
    assert.equal(a.linhas.length, 0);
  });

  test("merchant já VALIDADO em outra unidade (ex.: North Shopping pelo Financial): duplicidade", async () => {
    const a = criarAmbiente();
    a.conectar();
    a.conectar({ unidadeId: NORTH, apps: ["financial"], merchantId: M_NORTH });
    await assert.rejects(svc.informarMerchant(a.p({ merchantId: M_NORTH })), erro("IFOOD_VINCULO_DUPLICADO"));
    assert.equal(a.linhas.length, 0);
  });

  test("merchant já informado (em aberto) por unidade de OUTRA organização: duplicidade — e ninguém vê o vínculo do outro", async () => {
    const a = criarAmbiente();
    a.conectar();
    a.conectar({ organizacaoId: OUTRA_ORG, unidadeId: UN_OUTRA_ORG });
    await svc.informarMerchant(a.p({ organizacaoId: OUTRA_ORG, unidadeId: UN_OUTRA_ORG, merchantId: M_SACI }));
    await assert.rejects(svc.informarMerchant(a.p({ merchantId: M_SACI })), erro("IFOOD_VINCULO_DUPLICADO"));
    await assert.rejects(svc.confirmarMerchant(a.p({ merchantId: M_SACI })), erro("IFOOD_VINCULO_NAO_ENCONTRADO"), "a Saci não confirma o vínculo da outra organização");
    assert.equal(a.linhas.length, 1);
    assert.equal(a.linhas[0].organizacao_id, OUTRA_ORG);
  });

  test("tenant trocado por parâmetro não alcança a conexão de outra unidade/organização", async () => {
    const a = criarAmbiente();
    a.conectar();
    // unidade da Saci com a organização errada; e organização certa com unidade sem conexão
    await assert.rejects(svc.informarMerchant(a.p({ organizacaoId: OUTRA_ORG, merchantId: M_SACI })), erro("IFOOD_ORDER_NAO_CONECTADO"));
    await assert.rejects(svc.informarMerchant(a.p({ unidadeId: UN_OUTRA_ORG, merchantId: M_SACI })), erro("IFOOD_ORDER_NAO_CONECTADO"));
    assert.equal(a.linhas.length, 0);
  });

  test("repetição segura: mesmo ID devolve o vínculo como está; ID diferente cancela o anterior e recomeça em `informado`", async () => {
    const a = criarAmbiente();
    a.conectar();
    await ateAguardando(a);
    const de_novo = await svc.informarMerchant(a.p({ merchantId: M_SACI }));
    assert.equal(de_novo.vinculo.estado, "aguardando_validacao", "repetir não rebaixa nem duplica");
    assert.equal(a.linhas.length, 1);

    const trocado = await svc.informarMerchant(a.p({ merchantId: M_OUTRO }));
    assert.equal(trocado.vinculo.estado, "informado");
    assert.deepEqual(a.linhas.map((l) => [l.merchant_id, l.estado, l.encerrado_motivo]), [[M_SACI, "cancelado", "SUBSTITUIDO_PELO_GESTOR"], [M_OUTRO, "informado", null]]);
  });

  test("unidade que já tem loja validada: mesmo ID é no-op; outro ID exige desconectar antes", async () => {
    const a = criarAmbiente();
    a.conectar({ merchantId: M_SACI });
    assert.deepEqual(await svc.informarMerchant(a.p({ merchantId: M_SACI })), { vinculo: null, jaVinculada: true });
    await assert.rejects(svc.informarMerchant(a.p({ merchantId: M_OUTRO })), erro("IFOOD_MERCHANT_JA_VINCULADO"));
    assert.equal(a.linhas.length, 0);
  });
});

// ===========================================================================
// 3. CONFERIR / CANCELAR
// ===========================================================================
describe("conferência do responsável e cancelamento", () => {
  test("conferir com o MESMO ID: `informado` -> `aguardando_validacao` (registra quem e quando); repetir é seguro", async () => {
    const a = criarAmbiente();
    a.conectar();
    await svc.informarMerchant(a.p({ merchantId: M_SACI }));
    const r = await svc.confirmarMerchant(a.p({ merchantId: M_SACI, usuarioId: "user-dono" }));
    assert.equal(r.vinculo.estado, "aguardando_validacao");
    assert.equal(a.linhas[0].confirmado_por, "user-dono");
    assert.ok(a.linhas[0].confirmado_em);
    assert.equal((await svc.confirmarMerchant(a.p({ merchantId: M_SACI }))).vinculo.estado, "aguardando_validacao");
    assert.deepEqual([a.conexoes[0].merchant_id, a.conexoes[0].status], [null, "pendente"], "conferir NÃO torna o vínculo definitivo");
    assert.equal(a.chamadas.token.length + a.chamadas.polling.length, 0);
  });

  test("conferir com ID diferente do informado é recusado; sem vínculo em aberto, 404", async () => {
    const a = criarAmbiente();
    a.conectar();
    await assert.rejects(svc.confirmarMerchant(a.p({ merchantId: M_SACI })), erro("IFOOD_VINCULO_NAO_ENCONTRADO"));
    await svc.informarMerchant(a.p({ merchantId: M_SACI }));
    await assert.rejects(svc.confirmarMerchant(a.p({ merchantId: M_OUTRO })), erro("IFOOD_VINCULO_CONFIRMACAO_DIVERGENTE"));
    assert.equal(a.linhas[0].estado, "informado");
  });

  test("cancelar encerra o vínculo em aberto (histórico preservado) e libera o merchant; é idempotente", async () => {
    const a = criarAmbiente();
    a.conectar();
    a.conectar({ organizacaoId: OUTRA_ORG, unidadeId: UN_OUTRA_ORG });
    await ateAguardando(a);
    assert.deepEqual(await svc.cancelarMerchantInformado(a.p()), { cancelados: 1 });
    assert.deepEqual(await svc.cancelarMerchantInformado(a.p()), { cancelados: 0 });
    assert.deepEqual([a.linhas.length, a.linhas[0].estado, a.linhas[0].encerrado_motivo], [1, "cancelado", "CANCELADO_PELO_GESTOR"]);
    const outro = await svc.informarMerchant(a.p({ organizacaoId: OUTRA_ORG, unidadeId: UN_OUTRA_ORG, merchantId: M_SACI }));
    assert.equal(outro.vinculo.estado, "informado");
  });
});

// ===========================================================================
// 4. VERIFICAÇÃO DE AUTORIZAÇÃO E VALIDAÇÃO FINAL (só com a flag; iFood sempre falso aqui)
// ===========================================================================
describe("validação final — desligada por padrão", () => {
  test("flag desligada (padrão): verificar e validar são recusados antes de ler o banco ou chamar o iFood", async () => {
    const a = criarAmbiente();
    a.conectar();
    await ateAguardando(a);
    await assert.rejects(svc.verificarAutorizacao(a.p()), erro("IFOOD_VALIDACAO_NAO_HABILITADA"));
    await assert.rejects(svc.concluirValidacao(a.p({ merchantId: M_SACI, evidenciaPortalParceiro: true, confirmacaoOperacional: true })), erro("IFOOD_VALIDACAO_NAO_HABILITADA"));
    assert.equal(a.chamadas.token.length + a.chamadas.polling.length + a.chamadas.definirMerchant, 0);
    assert.equal(a.linhas[0].estado, "aguardando_validacao");
    assert.equal(config.ifood.orderMerchantValidacao, false, "config real: desligada sem a variável");
    assert.equal(tokenReal.validacaoMerchantManualHabilitada(), false);
  });
});

describe("verificação de autorização no iFood (mock)", () => {
  test("resposta positiva: registra a evidência, mas o estado CONTINUA `aguardando_validacao` e a conexão `pendente`", async () => {
    const a = criarAmbiente({ validacao: true });
    const con = a.conectar();
    await ateAguardando(a);
    a.respostasPolling.push([{ id: "evento-real-simulado", code: "PLC", merchantId: M_SACI }]);
    const r = await svc.verificarAutorizacao(a.p());
    assert.equal(r.autorizacaoVerificada, true);
    assert.equal(r.vinculo.estado, "aguardando_validacao", "200 não prova a identidade da loja");
    assert.ok(a.linhas[0].autorizacao_verificada_em);
    assert.deepEqual(a.chamadas.polling, [[M_SACI]], "uma consulta, só o merchant informado");
    assert.deepEqual(a.chamadas.token, [{ conexaoId: con.id, appType: "order" }], "token Order da PRÓPRIA conexão");
    assert.equal(a.chamadas.ack.length, 0, "nunca reconhece eventos");
    assert.deepEqual([a.conexoes[0].merchant_id, a.conexoes[0].status], [null, "pendente"]);
  });

  test("sem autorização (403 com o merchant em unauthorizedMerchants): `rejeitado`, sem promover nada", async () => {
    const a = criarAmbiente({ validacao: true });
    a.conectar();
    await ateAguardando(a);
    a.respostasPolling.push(sem403([M_SACI.toUpperCase()]));
    const r = await svc.verificarAutorizacao(a.p());
    assert.deepEqual([r.autorizacaoVerificada, r.vinculo.estado, r.vinculo.motivo], [false, "rejeitado", "SEM_AUTORIZACAO"]);
    assert.ok(a.linhas[0].rejeitado_em);
    assert.equal(a.conexoes[0].merchant_id, null);
    await assert.rejects(svc.verificarAutorizacao(a.p()), erro("IFOOD_VINCULO_NAO_ENCONTRADO"), "rejeitado não é consultado de novo");
    assert.equal(a.chamadas.polling.length, 1);
  });

  test("403 que NÃO cita o merchant e falhas transitórias não rejeitam: o erro sobe e o estado fica", async () => {
    const a = criarAmbiente({ validacao: true });
    a.conectar();
    await ateAguardando(a);
    a.respostasPolling.push(sem403([M_OUTRO]));
    await assert.rejects(svc.verificarAutorizacao(a.p()), erro("IFOOD_MERCHANT_SEM_PERMISSAO"));
    assert.equal(a.linhas[0].estado, "aguardando_validacao");
    a.relogio.ms += 11 * 60_000;
    a.respostasPolling.push(ifoodErro(IFOOD_ERROS.IFOOD_INDISPONIVEL));
    await assert.rejects(svc.verificarAutorizacao(a.p()), erro("IFOOD_INDISPONIVEL"));
    assert.deepEqual([a.linhas[0].estado, a.linhas[0].autorizacao_verificada_em, a.linhas[0].autorizacao_tentativas], ["aguardando_validacao", null, 2]);
  });

  test("freio de tentativas: intervalo mínimo e no máximo 3 consultas por vínculo", async () => {
    const a = criarAmbiente({ validacao: true });
    a.conectar();
    await ateAguardando(a);
    a.respostasPolling.push(ifoodErro(IFOOD_ERROS.IFOOD_INDISPONIVEL), ifoodErro(IFOOD_ERROS.IFOOD_INDISPONIVEL), ifoodErro(IFOOD_ERROS.IFOOD_INDISPONIVEL));
    await assert.rejects(svc.verificarAutorizacao(a.p()), erro("IFOOD_INDISPONIVEL"));
    await assert.rejects(svc.verificarAutorizacao(a.p()), erro("IFOOD_VINCULO_TENTATIVAS_ESGOTADAS"), "logo em seguida: recusado sem consultar");
    assert.equal(a.chamadas.polling.length, 1);
    for (let i = 0; i < 2; i += 1) { a.relogio.ms += svc.VINCULO_MANUAL.intervaloVerificacaoMs + 1; await assert.rejects(svc.verificarAutorizacao(a.p()), erro("IFOOD_INDISPONIVEL")); }
    a.relogio.ms += svc.VINCULO_MANUAL.intervaloVerificacaoMs + 1;
    await assert.rejects(svc.verificarAutorizacao(a.p()), erro("IFOOD_VINCULO_TENTATIVAS_ESGOTADAS"));
    assert.equal(a.chamadas.polling.length, svc.VINCULO_MANUAL.maxVerificacoes);
  });

  test("duas verificações simultâneas: só UMA consulta sai", async () => {
    const a = criarAmbiente({ validacao: true });
    a.conectar();
    await ateAguardando(a);
    const r = await Promise.allSettled([svc.verificarAutorizacao(a.p()), svc.verificarAutorizacao(a.p())]);
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(a.chamadas.polling.length, 1);
  });

  test("três rejeições por falta de autorização em 24 h: novas tentativas de informar são barradas", async () => {
    const a = criarAmbiente({ validacao: true });
    a.conectar();
    for (const m of [M_SACI, M_OUTRO, M_NORTH]) {
      await ateAguardando(a, m);
      a.respostasPolling.push(sem403([m]));
      await svc.verificarAutorizacao(a.p());
    }
    await assert.rejects(svc.informarMerchant(a.p({ merchantId: "dddddddd-4444-4444-8444-00000000000d" })), erro("IFOOD_VINCULO_TENTATIVAS_ESGOTADAS"));
    a.relogio.ms += 25 * 3_600_000;
    assert.equal((await svc.informarMerchant(a.p({ merchantId: M_SACI }))).vinculo.estado, "informado", "depois de 24 h, pode corrigir e tentar de novo");
  });

  test("precisa estar `aguardando_validacao` (só `informado` não é consultado no iFood)", async () => {
    const a = criarAmbiente({ validacao: true });
    a.conectar();
    await svc.informarMerchant(a.p({ merchantId: M_SACI }));
    await assert.rejects(svc.verificarAutorizacao(a.p()), erro("IFOOD_VINCULO_ESTADO_INVALIDO"));
    assert.equal(a.chamadas.polling.length, 0);
  });

  test("credencial Order revogada (reauth) ou desconectada no meio: verificação e validação recusadas", async () => {
    const a = criarAmbiente({ validacao: true });
    a.conectar();
    await ateAguardando(a);
    a.credenciais[0].status = "reauth_required";
    await assert.rejects(svc.verificarAutorizacao(a.p()), erro("IFOOD_ORDER_NAO_CONECTADO"));
    await assert.rejects(svc.concluirValidacao(a.p({ merchantId: M_SACI, evidenciaPortalParceiro: true, confirmacaoOperacional: true })), erro("IFOOD_ORDER_NAO_CONECTADO"));
    assert.equal(a.chamadas.polling.length + a.chamadas.definirMerchant, 0);
  });
});

describe("validação final (mock)", () => {
  const validar = (a, extra = {}) => svc.concluirValidacao(a.p({ merchantId: M_SACI, evidenciaPortalParceiro: true, confirmacaoOperacional: true, ...extra }));

  test("caminho completo: só aqui o merchant vai para a conexão, que passa a `ativa`", async () => {
    const a = criarAmbiente({ validacao: true });
    a.conectar();
    await ateAguardando(a);
    await svc.verificarAutorizacao(a.p());
    const r = await validar(a, { usuarioId: "user-suporte" });
    assert.equal(r.vinculo.estado, "validado");
    assert.deepEqual([a.conexoes[0].merchant_id, a.conexoes[0].status], [M_SACI, "ativa"]);
    assert.deepEqual([a.linhas[0].estado, a.linhas[0].validado_por], ["validado", "user-suporte"]);
    assert.equal(a.chamadas.polling.length, 1, "a validação final não chama o iFood");
    assert.equal(a.chamadas.ack.length, 0);
  });

  test("sem a verificação de autorização, ou com ela vencida (> 24 h): recusada", async () => {
    const a = criarAmbiente({ validacao: true });
    a.conectar();
    await ateAguardando(a);
    await assert.rejects(validar(a), erro("IFOOD_VINCULO_ESTADO_INVALIDO"));
    await svc.verificarAutorizacao(a.p());
    a.relogio.ms += svc.VINCULO_MANUAL.validadeVerificacaoMs + 1;
    await assert.rejects(validar(a), erro("IFOOD_VINCULO_ESTADO_INVALIDO"));
    assert.equal(a.conexoes[0].merchant_id, null);
  });

  test("sem as DUAS declarações explícitas (true literal), ou com ID divergente: recusada", async () => {
    const a = criarAmbiente({ validacao: true });
    a.conectar();
    await ateAguardando(a);
    await svc.verificarAutorizacao(a.p());
    for (const extra of [{ evidenciaPortalParceiro: false }, { confirmacaoOperacional: false }, { evidenciaPortalParceiro: "true" }, { confirmacaoOperacional: 1 }, { evidenciaPortalParceiro: undefined }]) {
      await assert.rejects(validar(a, extra), erro("IFOOD_VALIDACAO_SEM_EVIDENCIA"));
    }
    await assert.rejects(validar(a, { merchantId: M_OUTRO }), erro("IFOOD_VINCULO_CONFIRMACAO_DIVERGENTE"));
    assert.deepEqual([a.conexoes[0].merchant_id, a.chamadas.definirMerchant], [null, 0]);
  });

  test("merchant validado por OUTRA unidade no meio do caminho: vínculo `rejeitado`, conexão intacta", async () => {
    const a = criarAmbiente({ validacao: true });
    a.conectar();
    await ateAguardando(a);
    await svc.verificarAutorizacao(a.p());
    a.conectar({ unidadeId: NORTH, apps: ["financial"], merchantId: M_SACI });   // o fluxo Financial vinculou primeiro
    await assert.rejects(validar(a), erro("IFOOD_VINCULO_DUPLICADO"));
    assert.deepEqual([a.linhas[0].estado, a.linhas[0].encerrado_motivo], ["rejeitado", "MERCHANT_JA_VINCULADO"]);
    assert.deepEqual([a.conexoes[0].merchant_id, a.conexoes[0].status], [null, "pendente"]);
  });

  test("corrida no índice único do banco (duplicidade na gravação): rejeitado, sem deixar meio vínculo", async () => {
    const a = criarAmbiente({ validacao: true });
    a.conectar();
    await ateAguardando(a);
    await svc.verificarAutorizacao(a.p());
    a.repo.conexaoVivaDoMerchant = async () => null;                              // a checagem prévia não viu
    a.conectar({ unidadeId: NORTH, apps: ["financial"], merchantId: M_SACI });
    await assert.rejects(validar(a), erro("IFOOD_VINCULO_DUPLICADO"));
    assert.equal(a.linhas[0].estado, "rejeitado");
    assert.equal(a.conexoes[0].merchant_id, null);
  });
});

// ===========================================================================
// 5. STATUS — nunca "conectado e operando" enquanto a loja não estiver validada
// ===========================================================================
describe("status da unidade", () => {
  const status = (a, extra = {}) => conexaoSvc.obterStatus({ organizacaoId: ORG, unidadeId: SACI, deps: { repo: a.repo, vinculos: a.vinculos, agora: a.deps.agora }, ...extra });

  test("Order autorizado sem loja: conectado ao app, mas `lojaValidada` false e nada de merchant", async () => {
    const a = criarAmbiente();
    a.conectar();
    const s = await status(a);
    assert.equal(s.conectado, false, "status geral não vira conectado");
    assert.equal(s.merchant, null);
    assert.deepEqual([s.order.configurado, s.order.conectado, s.order.lojaValidada, s.order.lojaInformada], [true, true, false, null]);
  });

  test("acompanha os estados do vínculo, sempre com o merchant mascarado", async () => {
    const a = criarAmbiente({ validacao: true });
    a.conectar();
    await svc.informarMerchant(a.p({ merchantId: M_SACI }));
    assert.equal((await status(a)).order.lojaInformada.estado, "informado");
    await svc.confirmarMerchant(a.p({ merchantId: M_SACI }));
    const s = await status(a);
    assert.deepEqual([s.order.lojaInformada.estado, s.order.lojaValidada, s.conectado, s.merchant], ["aguardando_validacao", false, false, null]);
    assert.ok(!JSON.stringify(s).includes(M_SACI));
    a.respostasPolling.push(sem403([M_SACI]));
    await svc.verificarAutorizacao(a.p());
    const r = await status(a);
    assert.deepEqual([r.order.lojaInformada.estado, r.order.lojaInformada.motivo, r.order.lojaValidada], ["rejeitado", "SEM_AUTORIZACAO", false]);
  });

  test("depois da validação final: loja validada, e o vínculo manual some do status", async () => {
    const a = criarAmbiente({ validacao: true });
    a.conectar();
    await ateAguardando(a);
    await svc.verificarAutorizacao(a.p());
    await svc.concluirValidacao(a.p({ merchantId: M_SACI, evidenciaPortalParceiro: true, confirmacaoOperacional: true }));
    const s = await status(a);
    assert.deepEqual([s.order.lojaValidada, s.order.lojaInformada], [true, null]);
    assert.ok(s.merchant?.idMascarado);
  });

  test("tabela do vínculo ausente (migration 116 não aplicada): o status continua respondendo", async () => {
    const a = criarAmbiente();
    a.conectar();
    const vinculos = { async obterUltimoVinculo() { throw ifoodErro(IFOOD_ERROS.IFOOD_VINCULO_MANUAL_INDISPONIVEL); } };
    const s = await conexaoSvc.obterStatus({ organizacaoId: ORG, unidadeId: SACI, deps: { repo: a.repo, vinculos, agora: a.deps.agora } });
    assert.deepEqual([s.order.conectado, s.order.lojaInformada, s.order.lojaValidada], [true, null, false]);
  });

  test("desconectar encerra o vínculo em aberto e libera o merchant — mesmo se a tabela do vínculo falhar", async () => {
    const a = criarAmbiente();
    a.conectar();
    await ateAguardando(a);
    const r = await conexaoSvc.desconectar({ organizacaoId: ORG, unidadeId: SACI, usuarioId: GESTOR, deps: { repo: a.repo, vinculos: a.vinculos } });
    assert.equal(r.jaDesconectado, false);
    assert.deepEqual([a.linhas[0].estado, a.linhas[0].encerrado_motivo, a.conexoes[0].status, a.credenciais.length], ["cancelado", "CONEXAO_DESFEITA", "revogada", 0]);

    const b = criarAmbiente();
    b.conectar();
    const quebrado = { async cancelarVinculosAbertos() { throw new Error("relation does not exist"); } };
    await conexaoSvc.desconectar({ organizacaoId: ORG, unidadeId: SACI, usuarioId: GESTOR, deps: { repo: b.repo, vinculos: quebrado } });
    assert.equal(b.conexoes[0].status, "revogada");
  });
});

// ===========================================================================
// 6. FLUXO FINANCIAL ANTIGO PRESERVADO / PEÇAS HOMOLOGADAS INTACTAS
// ===========================================================================
describe("compatibilidade", () => {
  test("vínculo antigo (Merchant API com o token Financial) continua igual e não passa pelo vínculo manual", async () => {
    const a = criarAmbiente();
    a.conectar({ unidadeId: NORTH, apps: ["financial"] });
    const validacoes = [];
    const token = { escopoDoToken: () => "conexao", async comAccessTokenValido({ conexaoId, appType, fn }) { validacoes.push({ conexaoId, appType }); return fn("token-financial"); } };
    const httpFake = { async getJson() { return { id: M_NORTH, name: "Subway North Shopping", corporateName: "Razão Social LTDA" }; } };
    const s = await conexaoSvc.vincularMerchant({ organizacaoId: ORG, unidadeId: NORTH, merchantId: M_NORTH, usuarioId: GESTOR, deps: { repo: a.repo, vinculos: a.vinculos, token, http: httpFake, agora: a.deps.agora } });
    assert.deepEqual(validacoes.map((v) => v.appType), ["financial"], "validado pela Merchant API com o Financial, como antes");
    assert.deepEqual([a.conexoes[0].merchant_id, a.conexoes[0].status], [M_NORTH, "ativa"]);
    assert.equal(s.conectado, true);
    assert.equal(a.linhas.length, 0, "nenhuma linha de vínculo manual");
  });

  test("unidade fora do piloto com Financial: status sem bloco Order e sem leitura do vínculo manual", async () => {
    const a = criarAmbiente();
    a.conectar({ unidadeId: NORTH, apps: ["financial"], merchantId: M_NORTH });
    let leituras = 0;
    const vinculos = { async obterUltimoVinculo() { leituras += 1; return null; } };
    const s = await conexaoSvc.obterStatus({ organizacaoId: ORG, unidadeId: NORTH, deps: { repo: a.repo, vinculos, agora: a.deps.agora } });
    assert.deepEqual([s.conectado, s.order, leituras], [true, null, 0]);
  });

  test("arquivos homologados não foram tocados: poller, serviço/cliente de Events, Merchant API e Financial", () => {
    for (const f of ["ifoodEvents.poller.js", "ifoodEvents.service.js", "ifoodEvents.client.js", "ifoodEvents.repository.js", "ifoodMerchant.service.js", "ifoodAuth.service.js", "ifoodOrder.service.js", "ifoodOrderActions.service.js", "ifoodFinancial.service.js"]) {
      const fonte = ler(`src/modules/ifood/${f}`);
      assert.ok(!/ifoodMerchantVinculo|ifood_merchant_vinculos|lojaInformada/.test(fonte), `${f} não conhece o vínculo manual`);
    }
    const repo = ler("src/modules/ifood/ifood.repository.js");
    assert.ok(!/ifood_merchant_vinculos/.test(repo), "o repositório antigo não lê nem grava a tabela nova");
    assert.match(ler("src/modules/ifood/ifoodEvents.repository.js"), /\.eq\("status", "ativa"\)\s*\n\s*\.not\("merchant_id", "is", null\)/, "o poller só enxerga conexão ativa com merchant");
  });

  test("o serviço do vínculo manual nunca reconhece eventos nem grava pedidos", () => {
    const fonte = ler("src/modules/ifood/ifoodMerchantVinculo.service.js").replace(/\/\/.*$/gm, "");
    assert.ok(!/confirmarEventos|processarLote|inserirEventos|garantirPedido|marcarAck/.test(fonte));
    assert.equal((fonte.match(/buscarEventos/g) ?? []).length, 1, "uma única chamada de consulta, dentro de verificarAutorizacao");
    assert.equal((fonte.match(/validacaoMerchantManualHabilitada\(\)/g) ?? []).length, 2, "as duas etapas finais checam a flag");
  });

  test("repositório real: tenant em toda consulta da unidade, nada de delete, tabela ausente vira erro tratado", () => {
    const fonte = ler("src/modules/ifood/ifoodMerchantVinculo.repository.js");
    assert.ok(!/\.delete\(/.test(fonte));
    for (const fn of ["obterVinculoAberto", "obterUltimoVinculo", "contarRejeicoesRecentes", "atualizarVinculo", "cancelarVinculosAbertos"]) {
      const corpo = fonte.slice(fonte.indexOf(`export async function ${fn}`), fonte.indexOf("export async function", fonte.indexOf(`export async function ${fn}`) + 10) >>> 0 || undefined);
      assert.match(corpo, /exigirTenant\(organizacaoId, unidadeId\)/, fn);
      assert.match(corpo, /\.eq\("organizacao_id", organizacaoId\)\.eq\("unidade_id", unidadeId\)/, fn);
    }
    assert.equal(vinculoRepoReal.tabelaAusente({ code: "PGRST205" }), true);
    assert.equal(vinculoRepoReal.tabelaAusente({ code: "42P01" }), true);
    assert.equal(vinculoRepoReal.tabelaAusente({ code: "23505" }), false);
  });

  test("migration 116: só aditiva, backend-only, com rollback que protege vínculos validados", () => {
    const sql = ler("../database/migrations/116_ifood_merchant_vinculo_manual.sql");
    const semComentario = sql.replace(/--.*$/gm, "");
    assert.match(semComentario, /create table if not exists ifood_merchant_vinculos/);
    assert.ok(!/alter table (?!ifood_merchant_vinculos)/.test(semComentario), "não altera nenhuma tabela existente");
    assert.ok(!/drop table|delete from|update ifood_/.test(semComentario));
    assert.match(semComentario, /check \(estado in \('informado', 'aguardando_validacao', 'validado', 'rejeitado', 'cancelado'\)\)/);
    assert.match(semComentario, /unique index if not exists uq_ifood_merchant_vinculo_aberto_merchant[\s\S]*where estado in \('informado', 'aguardando_validacao'\)/);
    assert.match(semComentario, /enable row level security/);
    assert.match(semComentario, /revoke all on table ifood_merchant_vinculos from anon/);
    assert.ok(!/create policy/.test(semComentario), "nenhuma policy: deny-all para anon/authenticated");
    const rollback = ler("../database/migrations/116_rollback.sql").replace(/--.*$/gm, "");
    assert.match(rollback, /estado = ''validado''[\s\S]*raise exception[\s\S]*drop table public\.ifood_merchant_vinculos/, "checa e remove no MESMO bloco");
    assert.equal((rollback.match(/\bdo \$\$/g) ?? []).length, 1);
    assert.ok(!/ifood_conexoes|ifood_credenciais/.test(rollback), "o rollback não toca em mais nada");
  });
});

// ===========================================================================
// 7. HTTP — permissão, tenant do contexto e flag (router REAL)
// ===========================================================================
describe("rotas do vínculo manual", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", (req, _res, next) => {
    req.user = { id: String(req.headers["x-teste-user"] ?? "u") };
    const papel = req.headers["x-teste-papel"];
    if (papel) {
      req.acesso = { papel, permissoes: permissoesDoPapel(papel), modulos: [MODULOS.IFOOD], impersonando: false };
      req.tenant = { organizacaoId: String(req.headers["x-teste-org"] ?? ORG), unidadeId: req.headers["x-teste-unidade"] ? String(req.headers["x-teste-unidade"]) : null };
    }
    next();
  }, requireModulo(MODULOS.IFOOD), ifoodRouter);
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());

  const chamar = (method, url, { papel = "unit_manager", unidade = SACI, corpo } = {}) => new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json", "x-teste-user": `u-${Math.random()}`, "x-teste-papel": papel };
    if (unidade) headers["x-teste-unidade"] = unidade;
    const dados = corpo === undefined ? null : JSON.stringify(corpo);
    if (dados) headers["content-length"] = Buffer.byteLength(dados);
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method, path: `/api/v1${url}`, headers, agent: false }, (res) => {
      let t = "";
      res.on("data", (c) => { t += c; });
      res.on("end", () => { let json = null; try { json = JSON.parse(t); } catch { /* vazio */ } resolve({ status: res.statusCode, json, texto: t }); });
    });
    req.on("error", reject);
    req.end(dados ?? undefined);
  });
  const ROTAS = [
    ["POST", "/merchants/manual"], ["POST", "/merchants/manual/conferir"], ["DELETE", "/merchants/manual"],
    ["POST", "/merchants/manual/verificar-autorizacao"], ["POST", "/merchants/manual/validar"],
  ];

  test("as cinco rotas existem e exigem integracoes.gerenciar (Consulta, Operação e Financeiro: 403)", async () => {
    for (const [m, u] of ROTAS) {
      for (const papel of ["viewer", "operations", "finance"]) {
        const r = await chamar(m, u, { papel, corpo: { merchantId: M_SACI } });
        assert.equal(r.status, 403, `${papel} ${m} ${u}`);
      }
    }
  });

  test("sem unidade selecionada: 400 antes de qualquer serviço", async () => {
    for (const [m, u] of ROTAS) assert.equal((await chamar(m, u, { unidade: null, corpo: { merchantId: M_SACI } })).status, 400, `${m} ${u}`);
  });

  test("gestor de unidade fora da allowlist: 403 do piloto, mesmo mandando outra unidade/organização no corpo", async () => {
    const r = await chamar("POST", "/merchants/manual", { unidade: NORTH, corpo: { merchantId: M_SACI, unidadeId: SACI, organizacaoId: ORG, unidade_id: SACI } });
    assert.equal(r.status, 403);
    assert.equal(r.json.codigo ?? r.json.code ?? r.json.error?.codigo, "IFOOD_ORDER_PILOTO_NAO_HABILITADO", r.texto);
  });

  test("ID fora do formato: 400, sem ecoar o valor enviado", async () => {
    const r = await chamar("POST", "/merchants/manual", { corpo: { merchantId: "<script>alert(1)</script>" } });
    assert.equal(r.status, 400);
    assert.ok(!r.texto.includes("script"));
  });

  test("flag desligada: verificar e validar respondem 403 sem tocar em banco nem no iFood", async () => {
    for (const u of ["/merchants/manual/verificar-autorizacao", "/merchants/manual/validar"]) {
      const r = await chamar("POST", u, { papel: "organization_admin", corpo: { merchantId: M_SACI, evidenciaPortalParceiro: true, confirmacaoOperacional: true } });
      assert.equal(r.status, 403, u);
      assert.match(r.texto, /IFOOD_VALIDACAO_NAO_HABILITADA/);
    }
  });

  test("as rotas novas não colidem com as antigas nem parecem rota de pedido", () => {
    const rotas = ifoodRouter.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route.path}`));
    for (const antiga of ["GET /merchants", "POST /merchants/link", "GET /merchants/:merchantId", "POST /oauth/start", "POST /oauth/complete", "DELETE /"]) assert.ok(rotas.includes(antiga), antiga);
    const novas = rotas.filter((r) => r.includes("/merchants/manual"));
    assert.equal(novas.length, 5);
    assert.ok(novas.every((r) => !/order|events?|ack|confirm|dispatch|ready|cancel|polling/i.test(r)), novas.join(", "));
  });
});
