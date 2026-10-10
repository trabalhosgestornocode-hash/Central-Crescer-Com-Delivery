// Painel iFood — unidade conectada SÓ com o app de pedidos (sem Financial, sem Merchant API).
//
// Fluxo do gestor: conectar pedidos -> autorizar o aplicativo -> informar o ID da loja -> conferir -> aguardar
// a validação final. O painel NUNCA mostra "Conectado" (nem Eventos "Ativo") enquanto a loja não é validada.
// Sem DOM e sem rede: funções puras + o HTML real do painel (montarHtmlPainel) + leitura do código do assistente.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { derivarEstadoOrder, derivarEstadoEvents, derivarEstadoIntegracao, acoesDoPainel, validarIdLojaDigitado, MOTIVO_LOJA_REJEITADA } from "../src/ifoodEstado.js";
import { montarHtmlPainel } from "../src/ifood.js";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const ler = (f) => readFileSync(path.join(SRC, f), "utf8");

const AGORA = "2026-10-10T15:00:00.000Z";
const ID = "aaaaaaaa-1111-4111-8111-00000000000a";
const MASCARADO = "aaaa****000a";
const appsVazio = { analytics: { conectado: false, status: null }, financial: { conectado: false, status: null } };
const orderBase = {
  configurado: true, conectado: true, status: "ativa", tokenValido: true, ultimaAutenticacao: AGORA,
  ultimoEvento: null, ultimoPedido: null, erroAtual: null, lojaValidada: false, lojaInformada: null, validacaoFinalHabilitada: false,
};
const vinculo = (estado, extra = {}) => ({ estado, idMascarado: MASCARADO, informadoEm: AGORA, confirmadoEm: estado === "informado" ? null : AGORA, motivo: null, ...extra });
/** Status de uma unidade piloto só com o Order (sem Financial, sem loja validada). */
const status = (order, eventos = { estado: "disabled" }) => ({
  conectado: false, status: "pendente", merchant: null, apps: appsVazio, order, eventosRecebimento: eventos, conectadaEm: null, atencao: { total: 0, apps: [] },
});

// ---------------------------------------------------------------------------
// Estados do card Pedidos
// ---------------------------------------------------------------------------
test("Order autorizado sem loja informada: 'Aguardando ID da loja' — nunca 'Conectado'", () => {
  const o = derivarEstadoOrder(orderBase);
  assert.deepEqual([o.chave, o.rotulo, o.classe, o.acaoLoja, o.lojaPendente, o.podeConectar], ["aguardando_loja", "Aguardando ID da loja", "warn", "informar", true, false]);
  assert.match(o.instrucao, /Portal do Parceiro/);
});

test("loja informada: 'Aguardando conferência' com o ID mascarado e a ação de conferir", () => {
  const o = derivarEstadoOrder({ ...orderBase, lojaInformada: vinculo("informado") });
  assert.deepEqual([o.chave, o.rotulo, o.acaoLoja], ["loja_informada", "Aguardando conferência", "conferir"]);
  assert.deepEqual(o.linhas.find((l) => l[0] === "Loja informada"), ["Loja informada", MASCARADO, "texto"]);
});

test("loja conferida: 'Aguardando validação final', sem ação para o gestor e avisando que os pedidos não chegam", () => {
  const o = derivarEstadoOrder({ ...orderBase, lojaInformada: vinculo("aguardando_validacao") });
  assert.deepEqual([o.chave, o.rotulo, o.classe, o.acaoLoja], ["aguardando_validacao", "Aguardando validação final", "info", null]);
  assert.match(o.instrucao, /os pedidos ainda não chegam à Central/);
});

test("loja rejeitada: 'Loja não confirmada', motivo em linguagem de gestor e ação de informar de novo", () => {
  const o = derivarEstadoOrder({ ...orderBase, lojaInformada: vinculo("rejeitado", { motivo: "SEM_AUTORIZACAO" }) });
  assert.deepEqual([o.chave, o.rotulo, o.classe, o.acaoLoja], ["loja_rejeitada", "Loja não confirmada", "bad", "informar"]);
  assert.equal(o.erro.mensagem, MOTIVO_LOJA_REJEITADA.SEM_AUTORIZACAO);
  const outro = derivarEstadoOrder({ ...orderBase, lojaInformada: vinculo("rejeitado", { motivo: "MERCHANT_JA_VINCULADO" }) });
  assert.match(outro.erro.mensagem, /já está vinculada a outra unidade/);
  const desconhecido = derivarEstadoOrder({ ...orderBase, lojaInformada: vinculo("rejeitado", { motivo: "CODIGO_NOVO" }) });
  assert.ok(desconhecido.erro.mensagem && !desconhecido.erro.mensagem.includes("CODIGO_NOVO"), "código técnico nunca vai para a tela");
});

test("nenhum estado com a loja pendente usa a palavra 'Conectado' ou a classe 'ok'", () => {
  for (const v of [null, vinculo("informado"), vinculo("aguardando_validacao"), vinculo("rejeitado", { motivo: "SEM_AUTORIZACAO" })]) {
    const o = derivarEstadoOrder({ ...orderBase, lojaInformada: v });
    assert.notEqual(o.chave, "conectado");
    assert.notEqual(o.classe, "ok");
    assert.doesNotMatch(o.rotulo, /Conectado|operando/i);
  }
});

test("loja validada (ou servidor antigo, sem o campo): comportamento de antes — 'Conectado'", () => {
  for (const order of [{ ...orderBase, lojaValidada: true }, { ...orderBase, lojaValidada: undefined }]) {
    const o = derivarEstadoOrder(order);
    assert.deepEqual([o.chave, o.rotulo, o.classe], ["conectado", "Conectado", "ok"]);
    assert.equal(o.lojaPendente, undefined);
    assert.equal(o.acaoLoja, undefined);
  }
});

test("reautenticação tem prioridade sobre a loja pendente (primeiro reconectar o aplicativo)", () => {
  const o = derivarEstadoOrder({ ...orderBase, conectado: false, status: "reauth_required", lojaInformada: vinculo("aguardando_validacao") });
  assert.deepEqual([o.chave, o.podeConectar], ["reauth", true]);
});

// ---------------------------------------------------------------------------
// Card Eventos
// ---------------------------------------------------------------------------
test("Eventos: com a loja pendente nunca aparece 'Ativo' — 'Aguardando validação da loja' (ou 'Desativado')", () => {
  const order = { ...orderBase, lojaInformada: vinculo("aguardando_validacao") };
  for (const tecnico of ["active", "starting", "waiting_lease", "degraded"]) {
    const ev = derivarEstadoEvents({ estado: tecnico, ultimoCicloOkEm: AGORA }, order);
    assert.deepEqual([ev.chave, ev.rotulo, ev.linhas.length, ev.aviso], ["aguardando_loja", "Aguardando validação da loja", 0, null], tecnico);
  }
  const off = derivarEstadoEvents({ estado: "disabled" }, order);
  assert.deepEqual([off.rotulo, off.linhas.length], ["Desativado", 0]);
  assert.equal(derivarEstadoEvents({ estado: "active", ultimoCicloOkEm: AGORA }, { ...orderBase, lojaValidada: true }).rotulo, "Ativo", "com a loja validada, como antes");
});

// ---------------------------------------------------------------------------
// HTML real do painel
// ---------------------------------------------------------------------------
test("painel: piloto sem conexão nenhuma mostra 'Conectar pedidos' (sem exigir loja nem Financial)", () => {
  const html = montarHtmlPainel(status({ ...orderBase, conectado: false, status: null, ultimaAutenticacao: null }));
  assert.match(html, /id="ifood-order-pill">Não conectado/);
  assert.match(html, /data-acao="conectar_order">Conectar pedidos</);
  assert.doesNotMatch(html, /Vincule a loja iFood desta unidade/);
});

test("painel: depois de autorizar, pede o ID da loja", () => {
  const html = montarHtmlPainel(status(orderBase));
  assert.match(html, /id="ifood-order-pill">Aguardando ID da loja/);
  assert.match(html, /data-acao="informar_loja">Informar o ID da loja</);
  assert.doesNotMatch(html, /conectar_order|conferir_loja/);
});

test("painel: loja informada oferece conferir e corrigir; o ID aparece só mascarado", () => {
  const html = montarHtmlPainel(status({ ...orderBase, lojaInformada: vinculo("informado") }));
  assert.match(html, /id="ifood-order-pill">Aguardando conferência/);
  assert.match(html, /data-acao="conferir_loja">Conferir o ID da loja</);
  assert.match(html, /id="ifood-acao-corrigir_loja" data-acao="informar_loja">Corrigir o ID</);
  assert.ok(html.includes(MASCARADO) && !html.includes(ID));
});

test("painel: aguardando validação final — sem 'Conectado', sem 'Integração conectada', sem lista de pedidos, sem ação de loja", () => {
  const html = montarHtmlPainel(status({ ...orderBase, lojaInformada: vinculo("aguardando_validacao") }, { estado: "active", ultimoCicloOkEm: AGORA }));
  assert.match(html, /id="ifood-order-pill">Aguardando validação final/);
  assert.match(html, /id="ifood-events-pill">Aguardando validação da loja/);
  assert.match(html, /os pedidos ainda não chegam à Central/);
  assert.doesNotMatch(html, /id="ifood-order-pill">Conectado/);
  assert.doesNotMatch(html, /id="ifood-events-pill">Ativo/);
  assert.doesNotMatch(html, /operando/i);
  assert.doesNotMatch(html, /ifood-abrir-pedidos/, "sem loja validada não há lista de pedidos");
  assert.doesNotMatch(html, /informar_loja|conferir_loja|ifood-order-loja-acoes/);
  assert.match(html, /Nenhuma loja iFood vinculada/, "a loja só aparece como vinculada depois de validada");
});

test("painel: loja rejeitada mostra o motivo e permite informar novamente", () => {
  const html = montarHtmlPainel(status({ ...orderBase, lojaInformada: vinculo("rejeitado", { motivo: "SEM_AUTORIZACAO" }) }));
  assert.match(html, /id="ifood-order-pill">Loja não confirmada/);
  assert.match(html, /id="ifood-order-erro">O iFood não reconheceu esta loja/);
  assert.match(html, /data-acao="informar_loja">Informar o ID da loja novamente</);
});

test("painel: unidade com Financial e loja vinculada (fluxo antigo) não ganha nenhuma etapa de loja manual", () => {
  const html = montarHtmlPainel({
    conectado: true, status: "ativa", merchant: { idMascarado: "55c8****7040", nome: "Loja X", razaoSocial: "Loja X LTDA" },
    apps: { analytics: { conectado: true, status: "ativa" }, financial: { conectado: true, status: "ativa" } },
    order: null, eventosRecebimento: { estado: "disabled" }, conectadaEm: AGORA, atencao: { total: 0 },
  });
  assert.doesNotMatch(html, /informar_loja|conferir_loja|ifood-order-loja|Aguardando ID da loja/);
  assert.match(html, /Ainda não disponível para esta unidade/);
});

// ---------------------------------------------------------------------------
// Status geral da integração (topo do painel)
// ---------------------------------------------------------------------------
test("status geral: só pedidos e loja pendente = 'Em configuração' — nunca 'Parcialmente conectado' nem 'Continuar conexão'", () => {
  for (const v of [null, vinculo("informado"), vinculo("aguardando_validacao"), vinculo("rejeitado", { motivo: "SEM_AUTORIZACAO" })]) {
    const e = derivarEstadoIntegracao(status({ ...orderBase, lojaInformada: v }));
    assert.deepEqual([e.chave, e.rotulo, e.classe, e.podeDesconectar], ["pedidos_em_configuracao", "Em configuração", "warn", true]);
    assert.match(e.aviso, /Nada está sendo recebido ainda/);
    assert.deepEqual(acoesDoPainel(e).map((a) => a.id), ["desconectar"], "o próximo passo fica no card Pedidos");
  }
  const html = montarHtmlPainel(status({ ...orderBase, lojaInformada: vinculo("aguardando_validacao") }));
  assert.match(html, /id="ifood-status-pill">Em configuração</);
  assert.doesNotMatch(html, /Parcialmente conectado|Continuar conexão|data-acao="continuar"|data-acao="vincular"/);
  assert.match(html, /data-acao="desconectar"/);
});

test("status geral: os estados que já existiam não mudam", () => {
  const semNada = derivarEstadoIntegracao({ ...status({ ...orderBase, conectado: false, status: null }), status: "nao_conectado" });
  assert.equal(semNada.chave, "nao_conectado");
  const pilotoNovo = derivarEstadoIntegracao({ ...status(null), status: "nao_conectado" });
  assert.equal(pilotoNovo.chave, "nao_conectado");
  const comFinancial = derivarEstadoIntegracao({ ...status(orderBase), apps: { analytics: { conectado: false, status: null }, financial: { conectado: true, status: "ativa" } } });
  assert.equal(comFinancial.chave, "merchant_pendente", "com Financial autorizado, o caminho é escolher a loja pela conta Financial, como antes");
  const validada = derivarEstadoIntegracao({ ...status({ ...orderBase, lojaValidada: true }), status: "ativa", merchant: { idMascarado: MASCARADO, nome: null, razaoSocial: null } });
  assert.equal(validada.chave, "parcial", "loja validada e dados não conectados = parcial, como antes");
  const antigo = derivarEstadoIntegracao(status({ ...orderBase, lojaValidada: undefined }));
  assert.equal(antigo.chave, "parcial", "servidor antigo (sem o campo): comportamento de antes");
});

// ---------------------------------------------------------------------------
// Validação do ID digitado
// ---------------------------------------------------------------------------
test("ID da loja digitado: aceita só o formato do iFood, normalizado; o resto volta com orientação", () => {
  assert.deepEqual(validarIdLojaDigitado(`  ${ID.toUpperCase()}  `), { ok: true, id: ID, erro: null });
  for (const ruim of ["", "   ", null, undefined, "123", "loja do saci", ID.slice(0, 35), `${ID}0`, ID.replace(/-/g, "")]) {
    const r = validarIdLojaDigitado(ruim);
    assert.equal(r.ok, false, String(ruim));
    assert.ok(r.erro);
  }
  assert.match(validarIdLojaDigitado("").erro, /Informe o ID da loja/);
  assert.match(validarIdLojaDigitado("abc").erro, /36 caracteres/);
});

// ---------------------------------------------------------------------------
// Assistente (leitura do código — as etapas e as salvaguardas existem)
// ---------------------------------------------------------------------------
test("assistente: as cinco etapas, na ordem, e as três telas da loja", () => {
  const src = ler("ifood.js");
  assert.match(src, /const TRILHA_LOJA = \["Conectar pedidos", "Autorizar o aplicativo", "Informar o ID da loja", "Conferir os dados", "Validação final"\];/);
  for (const fn of ["pintarEtapaLojaManual", "pintarEtapaLojaConferir", "pintarEtapaLojaAguardando"]) assert.match(src, new RegExp(`function ${fn}\\(`));
  assert.match(src, /informar_loja: \(\) => abrirWizard\("loja_manual"\)/);
  assert.match(src, /conferir_loja: \(\) => abrirWizard\("loja_conferir"\)/);
});

test("assistente: depois de autorizar o aplicativo de pedidos segue para a loja só quando ela ainda não está validada", () => {
  const src = ler("ifood.js");
  const trecho = src.slice(src.indexOf('if (appType === "order") {'), src.indexOf('} else if (appType === "analytics" && derivarEstadoIntegracao'));
  assert.match(trecho, /await carregarStatusSilencioso\(\)/);
  assert.match(trecho, /o\.acaoLoja === "informar"\) \{ estado\.wizard\.etapa = "loja_manual"/);
  assert.match(trecho, /else sairDoWizard\(\)/);
});

test("assistente: confirmar exige a caixa de conferência marcada e reenvia o MESMO ID; reabrindo a tela, o ID é digitado de novo", () => {
  const src = ler("ifood.js");
  const conferir = src.slice(src.indexOf("async function conferirLoja()"), src.indexOf("function pintarEtapaLojaAguardando()"));
  assert.match(conferir, /if \(!el\("#ifood-loja-ciente"\)\?\.checked\) return mostrarMsg/);
  assert.ok(conferir.indexOf("#ifood-loja-ciente") < conferir.indexOf("api.ifoodConferirLoja"), "a caixa é checada antes da chamada");
  assert.match(conferir, /validarIdLojaDigitado\(w\.lojaId \|\| el\("#ifood-loja-id-conf"\)\?\.value\)/);
  const tela = src.slice(src.indexOf("function pintarEtapaLojaConferir()"), src.indexOf("async function conferirLoja()"));
  assert.match(tela, /const precisaDigitar = !w\.lojaId;/);
  assert.match(tela, /<span>Conferi no Portal do Parceiro que este é o ID da loja <strong>desta unidade<\/strong>\.<\/span>/);
});

test("assistente: a última tela diz 'Aguardando validação final' e nunca 'conectado'/'operando'", () => {
  const src = ler("ifood.js");
  const tela = src.slice(src.indexOf("function pintarEtapaLojaAguardando()"), src.indexOf("function pintarEtapaOAuth("));
  assert.match(tela, /Aguardando validação final/);
  assert.match(tela, /os pedidos ainda não chegam à Central/);
  assert.doesNotMatch(tela, /conectad[oa]|operando|ativo/i);
});

test("o ID da loja nunca é guardado no navegador, e a tela não chama a validação final nem o iFood", () => {
  const codigo = ler("ifood.js").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.doesNotMatch(codigo, /localStorage|sessionStorage/);
  assert.doesNotMatch(codigo, /verificar-autorizacao|merchants\/manual\/validar/);
  const api = ler("api.js");
  assert.match(api, /export const ifoodInformarLoja = \(merchantId\) => postJson\(`\$\{IFOOD\}\/merchants\/manual`, \{ merchantId \}\);/);
  assert.match(api, /export const ifoodConferirLoja = \(merchantId\) => postJson\(`\$\{IFOOD\}\/merchants\/manual\/conferir`, \{ merchantId \}\);/);
  assert.doesNotMatch(api, /verificar-autorizacao|merchants\/manual\/validar/, "a validação final não é acionável pela interface");
  assert.doesNotMatch(api, /merchants\/manual[^\n]*(unidadeId|organizacaoId)/, "a tela não envia unidade/organização");
});
