// FIM DO PILOTO (migration 104) — regras PURAS (sem banco): telefone, status operacional da empresa, chave de idempotência por destinatário,
// casamento de destinatário (legado × novo), teto configurável e KILL SWITCH na fronteira do provider.
// Rodar: node --env-file=.env.test-integracao --test test/comunicacao-destinatarios-unit.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validarTelefoneOperacional, telefoneOuErro } from "../src/modules/comunicacao/comunicacao.destinatarios.repo.js";
import { normalizarTelefone } from "../src/modules/comunicacao/comunicacao.contatos.repo.js";
import { chaveIdempotenciaDestinatario, PROPOSITO } from "../src/modules/comunicacao/comunicacao.reforco.js";
import { mesmoDestinatario } from "../src/modules/comunicacao/comunicacao.fila.repo.js";
import { modoPermiteEnvioReal, MODOS, MOTIVOS_BLOQUEIO, RESULTADO_RESERVA, CATEGORIAS, LIMITE_PADRAO_DESTINATARIOS_ATIVOS } from "../src/modules/comunicacao/comunicacao.constants.js";
import { MOTIVO_DA_RESERVA } from "../src/modules/comunicacao/comunicacao.adiamento.js";
import { obterLimiteDestinatariosAtivos } from "../src/modules/comunicacao/comunicacao.config.js";
import { statusOperacionalEmpresa, STATUS_OPERACIONAL } from "../src/modules/administrativo/administrativo.comunicacao.empresa.js";
import { criarWhatsAppService, ModoDesabilitadoError } from "../src/modules/comunicacao/whatsapp.service.js";
import { criarFakeProvider } from "../src/modules/comunicacao/providers/fake.provider.js";
import { classificarErroEnvio } from "../src/modules/comunicacao/comunicacao.entrega.js";
import { CLASSIFICACAO_ERRO } from "../src/modules/comunicacao/comunicacao.constants.js";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(aqui, "..", "src");

describe("telefone do destinatário — normalização, DDI e números obviamente inválidos", () => {
  const validos = ["11987654321", "(11) 98765-4321", "+55 11 98765-4321", "5511987654321", "1133334444", "+14155552671"];
  for (const bruto of validos) {
    test(`aceita e normaliza ${JSON.stringify(bruto)}`, () => {
      const e164 = telefoneOuErro(bruto);
      assert.match(e164, /^\+[1-9][0-9]{7,14}$/);
    });
  }
  test("normaliza para E.164 com DDI (+55 quando nacional)", () => {
    assert.equal(telefoneOuErro("(62) 99123-4567"), "+5562991234567");
    assert.equal(telefoneOuErro("+55 62 99123-4567"), "+5562991234567");
    assert.equal(normalizarTelefone("62991234567"), "+5562991234567");
  });
  const invalidos = [
    ["", "vazio"], [null, "nulo"], ["abc", "sem dígitos"], ["123", "curto demais"], ["0000000000", "só zeros"], ["11111111111", "dígitos repetidos"],
    ["+551111111111", "dígitos repetidos com DDI"], ["5511887654321", "celular sem o 9 (+55)"], ["0611987654321", "DDD inválido"], ["+5501987654321", "DDD 01"],
    ["+55119876543", "tamanho brasileiro inválido"], ["+9999999999999999", "longo demais"],
  ];
  for (const [bruto, por] of invalidos) {
    test(`rejeita ${JSON.stringify(bruto)} (${por})`, () => {
      assert.throws(() => telefoneOuErro(bruto), (e) => e.statusCode === 400 && e.details?.codigo === "TELEFONE_INVALIDO");
    });
  }
  test("validarTelefoneOperacional é pura e nunca lança", () => {
    assert.deepEqual(validarTelefoneOperacional(null).ok, false);
    assert.equal(validarTelefoneOperacional("+5562991234567").ok, true);
  });
});

describe("idempotência POR DESTINATÁRIO — chave determinística (alerta + destinatário + propósito)", () => {
  const alerta = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const joao = "11111111-1111-4111-8111-111111111111";
  const maria = "22222222-2222-4222-8222-222222222222";
  test("João e Maria têm chaves DIFERENTES para o mesmo alerta (uma não impede a outra)", () => {
    assert.notEqual(chaveIdempotenciaDestinatario({ alertaId: alerta, contatoEmpresaId: joao }), chaveIdempotenciaDestinatario({ alertaId: alerta, contatoEmpresaId: maria }));
  });
  test("a mesma tupla gera SEMPRE a mesma chave (o João não recebe duas vezes)", () => {
    const a = chaveIdempotenciaDestinatario({ alertaId: alerta, contatoEmpresaId: joao });
    assert.equal(a, chaveIdempotenciaDestinatario({ alertaId: alerta, contatoEmpresaId: joao }));
    assert.equal(a, `wa:alerta:${alerta}:dest:${joao}:v1`);
  });
  test("reforço tem chave própria (inicial e reforço do mesmo destinatário não colidem)", () => {
    const i = chaveIdempotenciaDestinatario({ alertaId: alerta, contatoEmpresaId: joao, proposito: PROPOSITO.INICIAL });
    const r = chaveIdempotenciaDestinatario({ alertaId: alerta, contatoEmpresaId: joao, proposito: PROPOSITO.REFORCO });
    assert.notEqual(i, r);
    assert.match(r, /:reforco:v1$/);
  });
  test("alertas diferentes -> chaves diferentes para o mesmo destinatário", () => {
    assert.notEqual(chaveIdempotenciaDestinatario({ alertaId: alerta, contatoEmpresaId: joao }), chaveIdempotenciaDestinatario({ alertaId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", contatoEmpresaId: joao }));
  });
});

describe("casamento de destinatário (duplicidade POR DESTINATÁRIO, mensagens legadas incluídas)", () => {
  test("mesma mensagem: por contato_empresa_id", () => {
    assert.equal(mesmoDestinatario({ contato_empresa_id: "ce1", contato_id: "c1" }, { contatoEmpresaId: "ce1", contatoId: "c1" }), true);
  });
  test("mensagem de OUTRO destinatário não é duplicata", () => {
    assert.equal(mesmoDestinatario({ contato_empresa_id: "ce2", contato_id: "c2" }, { contatoEmpresaId: "ce1", contatoId: "c1" }), false);
  });
  test("mensagem LEGADA (sem contato_empresa_id) é casada pelo contato", () => {
    assert.equal(mesmoDestinatario({ contato_empresa_id: null, contato_id: "c1" }, { contatoEmpresaId: "ce1", contatoId: "c1" }), true);
    assert.equal(mesmoDestinatario({ contato_empresa_id: null, contato_id: "c9" }, { contatoEmpresaId: "ce1", contatoId: "c1" }), false);
  });
  test("sem identificação = comportamento histórico (qualquer)", () => {
    assert.equal(mesmoDestinatario({ contato_empresa_id: "x", contato_id: "y" }, {}), true);
  });
});

describe("categorias e limites (constantes de domínio, sem número mágico espalhado)", () => {
  test("só a categoria que já existe funcionalmente (Pendência D-1)", () => {
    assert.deepEqual(Object.values(CATEGORIAS), ["pendencia_d1"]);
  });
  test("o teto de destinatários ativos é UMA constante de domínio (5) e é lido da configuração", async () => {
    assert.equal(LIMITE_PADRAO_DESTINATARIOS_ATIVOS, 5);
    const fake = (valor) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: valor === undefined ? null : { valor }, error: null }) }) }) }) });
    assert.equal(await obterLimiteDestinatariosAtivos({ supabase: fake(undefined) }), 5);
    assert.equal(await obterLimiteDestinatariosAtivos({ supabase: fake({ max_ativos_por_organizacao: 8 }) }), 8);
    for (const ruim of [0, -1, "3", 2.5, null]) assert.equal(await obterLimiteDestinatariosAtivos({ supabase: fake({ max_ativos_por_organizacao: ruim }) }), 5, `valor corrompido ${ruim} nunca vira "sem limite"`);
  });
  test("o limite diário POR ORGANIZAÇÃO é distinto do limite por destinatário e adia para o dia seguinte", () => {
    assert.equal(RESULTADO_RESERVA.RATE_LIMIT_DIA_ORGANIZACAO, "RATE_LIMIT_DIA_ORGANIZACAO");
    assert.notEqual(RESULTADO_RESERVA.RATE_LIMIT_DIA_ORGANIZACAO, RESULTADO_RESERVA.RATE_LIMIT_DIA);
    assert.equal(MOTIVO_DA_RESERVA.RATE_LIMIT_DIA_ORGANIZACAO, MOTIVOS_BLOQUEIO.RATE_LIMIT);
  });
});

describe("status operacional da empresa (Painel) — precedência", () => {
  const habOk = { habilitado: true, envio_automatico: true, timezone: "America/Sao_Paulo", tipos_permitidos: ["dashboard_ifood_d1"], pausado_ate: null };
  const dest = (extra = {}) => ({ ativo: true, whatsapp_status: "VALIDADO", ...extra });
  const s = (hab, lista, modo = MODOS.NORMAL) => statusOperacionalEmpresa({ hab, destinatarios: lista, modo, agora: new Date("2026-09-16T13:00:00Z") });
  test("sem habilitação -> WhatsApp desativado para esta empresa", () => {
    assert.equal(s(null, [dest()]).codigo, STATUS_OPERACIONAL.DESATIVADO_PARA_EMPRESA);
    assert.equal(s({ ...habOk, habilitado: false }, [dest()]).rotulo, "WhatsApp desativado para esta empresa");
  });
  test("habilitada com 0 destinatários -> Configuração incompleta (e NÃO envia)", () => {
    const r = s(habOk, []);
    assert.equal(r.codigo, STATUS_OPERACIONAL.CONFIGURACAO_INCOMPLETA);
    assert.equal(r.rotulo, "Configuração incompleta");
  });
  test("destinatários cadastrados mas nenhum ativo -> Sem destinatários ativos", () => {
    assert.equal(s(habOk, [dest({ ativo: false })]).rotulo, "Sem destinatários ativos");
  });
  test("ativos mas nenhum com WhatsApp validado -> Configuração incompleta", () => {
    assert.equal(s(habOk, [dest({ whatsapp_status: "AGUARDANDO_VALIDACAO" })]).codigo, STATUS_OPERACIONAL.CONFIGURACAO_INCOMPLETA);
  });
  test("sem timezone ou sem tipo -> Configuração incompleta", () => {
    assert.equal(s({ ...habOk, timezone: null }, [dest()]).codigo, STATUS_OPERACIONAL.CONFIGURACAO_INCOMPLETA);
    assert.equal(s({ ...habOk, tipos_permitidos: [] }, [dest()]).codigo, STATUS_OPERACIONAL.CONFIGURACAO_INCOMPLETA);
  });
  test("envio automático desligado", () => {
    assert.equal(s({ ...habOk, envio_automatico: false }, [dest()]).codigo, STATUS_OPERACIONAL.ENVIO_AUTOMATICO_DESLIGADO);
  });
  test("pausa vigente", () => {
    assert.equal(s({ ...habOk, pausado_ate: "2026-09-20T00:00:00Z" }, [dest()]).codigo, STATUS_OPERACIONAL.EMPRESA_PAUSADA);
    assert.equal(s({ ...habOk, pausado_ate: "2026-09-01T00:00:00Z" }, [dest()]).codigo, STATUS_OPERACIONAL.ATIVO, "pausa vencida não vale");
  });
  test("KILL SWITCH: modo DISABLED -> envio global desativado, mesmo com tudo configurado", () => {
    assert.equal(s(habOk, [dest()], MODOS.DISABLED).codigo, STATUS_OPERACIONAL.ENVIO_GLOBAL_DESATIVADO);
  });
  test("tudo certo -> Ativo", () => {
    assert.equal(s(habOk, [dest(), dest({ ativo: false })]).rotulo, "Ativo");
  });
});

// ---------------------------------------------------------------------------
// KILL SWITCH na FRONTEIRA DO PROVIDER
// ---------------------------------------------------------------------------
function servicoComSpy(opcoes) {
  const provider = criarFakeProvider();
  const chamadas = [];
  for (const m of ["sendText", "sendImage", "sendDocument"]) {
    const original = provider[m].bind(provider);
    provider[m] = async (args) => { chamadas.push({ m, ...args }); return original(args); };
  }
  return { provider, chamadas, servico: criarWhatsAppService({ provider, semGateIdentidade: true, ...opcoes }) };
}
const ENVIOS = [
  ["enviarTexto", { telefoneE164: "+5562991234567", texto: "oi", idempotencyKey: "k1" }],
  ["enviarImagem", { telefoneE164: "+5562991234567", urlImagem: "https://x/y.png", legenda: "l", idempotencyKey: "k2" }],
  ["enviarDocumento", { telefoneE164: "+5562991234567", urlDocumento: "https://x/y.pdf", nomeArquivo: "y.pdf", idempotencyKey: "k3" }],
];

describe("KILL SWITCH — modoPermiteEnvioReal", () => {
  test("só NORMAL e REACTIVE_ONLY permitem envio real", () => {
    assert.equal(modoPermiteEnvioReal(MODOS.NORMAL), true);
    assert.equal(modoPermiteEnvioReal(MODOS.REACTIVE_ONLY), true);
    assert.equal(modoPermiteEnvioReal(MODOS.DISABLED), false);
  });
  for (const ruim of [undefined, null, "", "normal", "\"NORMAL\"", "ACTIVE", 1, {}, ["NORMAL"]]) {
    test(`valor desconhecido/corrompido (${JSON.stringify(ruim)}) NUNCA permite`, () => assert.equal(modoPermiteEnvioReal(ruim), false));
  }
});

describe("KILL SWITCH — modo=DISABLED: nenhuma chamada chega ao provider (serviço = fronteira final)", () => {
  for (const [metodo, args] of ENVIOS) {
    test(`${metodo} com DISABLED lança ModoDesabilitadoError e o provider NÃO é chamado`, async () => {
      const { servico, chamadas } = servicoComSpy({ modoAtual: async () => MODOS.DISABLED });
      await assert.rejects(() => servico[metodo](args), (e) => e instanceof ModoDesabilitadoError && e.code === "MODO_DISABLED" && e.preEnvio === true);
      assert.equal(chamadas.length, 0);
    });
  }
  test("a mensagem de erro é clara para o operador", async () => {
    const { servico } = servicoComSpy({ modoAtual: async () => MODOS.DISABLED });
    await assert.rejects(() => servico.enviarTexto(ENVIOS[0][1]), /Envio bloqueado: o módulo WhatsApp está em modo DISABLED\. Altere o modo operacional antes de realizar um envio real\./);
  });
  test("o erro é PRÉ-ENVIO (nada saiu): classificado como RETRYAVEL, nunca INCERTO", async () => {
    const { servico } = servicoComSpy({ modoAtual: async () => MODOS.DISABLED });
    const e = await servico.enviarTexto(ENVIOS[0][1]).catch((x) => x);
    assert.equal(classificarErroEnvio(e), CLASSIFICACAO_ERRO.RETRYAVEL);
  });
  test("DISABLED prevalece sobre a conta confirmada (identidade OK não reabre o envio)", async () => {
    const { servico, chamadas } = servicoComSpy({ modoAtual: async () => MODOS.DISABLED, identidadeConfirmada: async () => true, semGateIdentidade: false });
    await assert.rejects(() => servico.enviarTexto(ENVIOS[0][1]), ModoDesabilitadoError);
    assert.equal(chamadas.length, 0);
  });
  test("FAIL-CLOSED: sem leitor de modo -> nada sai (a menos que seja um teste com semGateModo)", async () => {
    const { servico, chamadas } = servicoComSpy({});
    await assert.rejects(() => servico.enviarTexto(ENVIOS[0][1]), ModoDesabilitadoError);
    assert.equal(chamadas.length, 0);
  });
  test("FAIL-CLOSED: leitura do modo que LANÇA -> nada sai", async () => {
    const { servico, chamadas } = servicoComSpy({ modoAtual: async () => { throw new Error("banco fora"); } });
    await assert.rejects(() => servico.enviarTexto(ENVIOS[0][1]), ModoDesabilitadoError);
    assert.equal(chamadas.length, 0);
  });
  test("FAIL-CLOSED: modo desconhecido -> nada sai", async () => {
    const { servico, chamadas } = servicoComSpy({ modoAtual: async () => "TALVEZ" });
    await assert.rejects(() => servico.enviarTexto(ENVIOS[0][1]), ModoDesabilitadoError);
    assert.equal(chamadas.length, 0);
  });
  test("o modo é lido a CADA envio: DISABLED -> NORMAL -> DISABLED reflete imediatamente (sem cache)", async () => {
    let modo = MODOS.NORMAL;
    const { servico, chamadas } = servicoComSpy({ modoAtual: async () => modo });
    await servico.enviarTexto({ ...ENVIOS[0][1], idempotencyKey: "a" });
    modo = MODOS.DISABLED;
    await assert.rejects(() => servico.enviarTexto({ ...ENVIOS[0][1], idempotencyKey: "b" }), ModoDesabilitadoError);
    modo = MODOS.NORMAL;
    await servico.enviarTexto({ ...ENVIOS[0][1], idempotencyKey: "c" });
    assert.deepEqual(chamadas.map((c) => c.idempotencyKey), ["a", "c"]);
  });
  test("NORMAL e REACTIVE_ONLY deixam a chamada chegar ao provider", async () => {
    for (const modo of [MODOS.NORMAL, MODOS.REACTIVE_ONLY]) {
      const { servico, chamadas } = servicoComSpy({ modoAtual: async () => modo });
      for (const [metodo, args] of ENVIOS) await servico[metodo](args);
      assert.equal(chamadas.length, 3, `modo ${modo}`);
    }
  });
  test("leituras (getStatus/identidade) NÃO são envio: continuam funcionando em DISABLED", async () => {
    const { servico } = servicoComSpy({ modoAtual: async () => MODOS.DISABLED });
    assert.equal((await servico.getStatus()).conectado, true);
    assert.equal(await servico.modoPermiteEnvio(), false);
  });
});

describe("KILL SWITCH — estático: nenhum caminho de produção contorna a fronteira", () => {
  const arquivos = [];
  const varrer = (dir) => { for (const e of readdirSync(dir)) { const f = path.join(dir, e); if (statSync(f).isDirectory()) varrer(f); else if (f.endsWith(".js")) arquivos.push(f); } };
  varrer(SRC);
  const semComentarios = (c) => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  test("`semGateModo: true` só existe em TESTES (nenhum arquivo de produção o usa)", () => {
    const usos = arquivos.filter((a) => /semGateModo\s*:\s*true/.test(semComentarios(readFileSync(a, "utf8"))));
    assert.deepEqual(usos, []);
  });
  test("todo criador de serviço de PRODUÇÃO passa o leitor de modo (worker, lifecycle, ambiente)", () => {
    for (const rel of ["worker-comunicacao/index.js", "worker-comunicacao/lifecycle.js", "modules/comunicacao/comunicacao.teste.js"]) {
      const codigo = semComentarios(readFileSync(path.join(SRC, rel), "utf8"));
      const chamada = codigo.slice(codigo.indexOf("criarWhatsAppService({"));
      assert.match(chamada.slice(0, 700), /modoAtual/, `${rel}: criarWhatsAppService sem modoAtual`);
    }
  });
});
