// D.3-D — ADIAMENTO com HORÁRIO REAL no PIPELINE (processarJobReivindicado/processarProximoLote), banco de TESTE.
// Prova, ponta a ponta, que um bloqueio TRANSITÓRIO grava em `disponivel_em` o PRÓXIMO instante permitido
// (timezone da organização, janela, pausa) — não "+15 minutos" — e que reavaliar nunca muda o horário.
// Datas FIXAS em 2035 (sexta 14/09/2035 ...): o banco nunca aceita um adiamento no passado, então usar datas
// futuras deixa o teste independente do dia em que roda.
// Rodar: node --env-file=.env.test-integracao --test --test-concurrency=1 test/comunicacao-adiamento-pipeline.test.js
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { supabase } from "../src/config/supabase.js";
import { motivoPularIntegracao } from "./helpers/preflight-integracao.js";
import {
  criarOrganizacao, apagarOrganizacao, criarUnidade, criarContaComPerfil, apagarConta, vincularUsuarioUnidade,
  migracao082Aplicada, migracao088Aplicada,
} from "./helpers/comunicacao-fixtures.js";
import * as contatosRepo from "../src/modules/comunicacao/comunicacao.contatos.repo.js";
import { processarProximoLote } from "../src/modules/comunicacao/comunicacao.alertas.service.js";
import { definirModo, modoAtual } from "../src/modules/comunicacao/comunicacao.config.js";
import { criarWhatsAppService } from "../src/modules/comunicacao/whatsapp.service.js";
import { criarFakeProvider } from "../src/modules/comunicacao/providers/fake.provider.js";
import { MODOS, STATUS_MENSAGEM as SM } from "../src/modules/comunicacao/comunicacao.constants.js";

const PULAR_INTEGRACAO = motivoPularIntegracao();
const tag = `comadp${Date.now()}`;
const MIN = 60_000;
const SEXTA_1830 = new Date("2035-09-14T21:30:00Z"); // sexta 18:30 em Fortaleza (fora da janela)
const QUARTA_10H_FIXA = new Date("2035-09-19T13:00:00Z"); // quarta 10:00 em Fortaleza (dentro)
const SEG_SEX = { seg_sex: { inicio: "08:00", fim: "18:00" }, sab: null, dom: null };

let migracaoOk = true;
let modoOriginal = null;
let orgA = null, unidadeA = null, contaId = null, perfilId = null, contatoId = null;

const hab = (extra = {}) => async () => ({
  empresaHabilitada: true, tipoPermitido: true, empresaPausada: false, pausadoAte: null, pausadoMotivo: null,
  timezone: "America/Fortaleza", janelas: null, configHorarioValida: true, fonte: "TESTE", ...extra,
});

before(async () => {
  if (PULAR_INTEGRACAO) return;
  migracaoOk = (await migracao082Aplicada()) && (await migracao088Aplicada());
  if (!migracaoOk) return;
  modoOriginal = await modoAtual();
  orgA = await criarOrganizacao("TESTE adiamento-pipeline — descartável");
  unidadeA = await criarUnidade(orgA, "Unidade Adiamento A1");
  const conta = await criarContaComPerfil(tag, "dest");
  contaId = conta.contaId; perfilId = conta.perfilId;
  await vincularUsuarioUnidade({ perfilId, organizacaoId: orgA, unidadeId: unidadeA });
  const c = await contatosRepo.criarOuObterContato({ telefoneE164: `+551194${String(Date.now()).slice(-7)}` });
  contatoId = c.id;
  await supabase.from("contatos_whatsapp").update({ verificado: true, consentimento: true, opt_out: false }).eq("id", contatoId);
  await contatosRepo.vincularPerfil({ contatoId, perfilOperacionalId: perfilId, principal: true });
});

after(async () => {
  if (modoOriginal) await definirModo(modoOriginal, {}).catch(() => {});
  if (contatoId) {
    await supabase.from("comunicacao_mensagens").delete().eq("contato_id", contatoId);
    await supabase.from("contatos_whatsapp").delete().eq("id", contatoId);
  }
  if (contaId) await apagarConta(contaId);
  await apagarOrganizacao(orgA);
});

beforeEach(async () => {
  if (PULAR_INTEGRACAO || !migracaoOk) return;
  await supabase.from("comunicacao_mensagens").delete().eq("organizacao_id", orgA);
  await definirModo(MODOS.NORMAL, {});
});

let seq = 0;
async function mensagemDevida() {
  const { data, error } = await supabase.from("comunicacao_mensagens").insert({
    organizacao_id: orgA, unidade_id: unidadeA, contato_id: contatoId, destinatario_perfil_id: perfilId, canal: "whatsapp", direcao: "saida",
    tipo: `tipo_${tag}_${++seq}`, conteudo: "aviso", idempotency_key: `adp-${tag}-${++seq}`, status: SM.SCHEDULED,
    disponivel_em: new Date(Date.now() - 60_000).toISOString(),
  }).select("*").single();
  if (error) throw new Error(`fixture: ${error.message}`);
  return data;
}
const linha = async (id) => (await supabase.from("comunicacao_mensagens").select("*").eq("id", id).single()).data;
function provider() {
  const p = criarFakeProvider();
  const chamadas = [];
  const original = p.sendText.bind(p);
  p.sendText = async (a) => { chamadas.push(a); return original(a); };
  return { p, chamadas, whatsAppService: criarWhatsAppService({ provider: p, semGateIdentidade: true }) };
}
const rodar = (whatsAppService, agora, resolverHabilitacao, extra = {}) => processarProximoLote({
  limite: 20, worker: `adp-${tag}`, whatsAppService, agora, adiamentoMs: 15 * MIN,
  verificarPendenciaAindaExiste: async () => true, resolverHabilitacao, ...extra,
});
const naFaixa = (iso, inicioIso, spread = 30 * MIN) => { const t = new Date(iso).getTime(), i = new Date(inicioIso).getTime(); return t >= i && t < i + spread; };
const liberar = (id) => supabase.from("comunicacao_mensagens").update({ disponivel_em: new Date(Date.now() - 1000).toISOString() }).eq("id", id);

describe("adiamento com HORÁRIO REAL no pipeline", { skip: PULAR_INTEGRACAO }, () => {
  test("gate tardio preserva tentativa reservada, não chama provider e não duplica retry", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const m = await mensagemDevida();
    const { p, chamadas } = provider();
    let consultas = 0;
    const svc = criarWhatsAppService({ provider: p, identidadeConfirmada: async () => ++consultas === 1 });
    const r = (await rodar(svc, QUARTA_10H_FIXA, hab())).find((x) => x.id === m.id);
    assert.equal(r?.resultado, "FALHOU_RETRY");
    const l = await linha(m.id);
    assert.equal(l.status, SM.SCHEDULED);
    assert.equal(l.tentativas, 1, "reserva é um fato persistido; não decrementar sob concorrência");
    assert.equal(chamadas.length, 0);
    const repetido = await rodar(svc, QUARTA_10H_FIXA, hab());
    assert.ok(!repetido.some((x) => x.id === m.id), "retry não é reivindicado antes de ficar devido");
    assert.equal((await linha(m.id)).tentativas, 1);
  });
  test("identidade pendente adia SCHEDULED sem tentativa; confirmação permite um único envio", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const m = await mensagemDevida();
    const { p, chamadas } = provider();
    let confirmada = false;
    const svc = criarWhatsAppService({ provider: p, identidadeConfirmada: async () => confirmada });
    const r = (await rodar(svc, QUARTA_10H_FIXA, hab())).find((x) => x.id === m.id);
    assert.equal(r?.motivo, "IDENTIDADE_NAO_CONFIRMADA");
    const adiada = await linha(m.id);
    assert.equal(adiada.status, SM.SCHEDULED);
    assert.equal(adiada.tentativas, 0);
    assert.equal(new Date(adiada.disponivel_em).toISOString(), "2035-09-19T13:15:00.000Z");
    assert.equal(chamadas.length, 0);
    confirmada = true;
    await liberar(m.id);
    await rodar(svc, QUARTA_10H_FIXA, hab());
    assert.equal((await linha(m.id)).status, SM.SENT);
    await rodar(svc, QUARTA_10H_FIXA, hab());
    assert.equal(chamadas.length, 1);
  });
  test("sexta 18:30 locais, janela GLOBAL (sáb 08–13): ADIADO OUTSIDE_ALLOWED_WINDOW para sábado 08:00 LOCAL + jitter — não +15 minutos", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const m = await mensagemDevida();
    const { chamadas, whatsAppService } = provider();
    const r = (await rodar(whatsAppService, SEXTA_1830, hab())).find((x) => x.id === m.id);
    assert.equal(r?.resultado, "ADIADO");
    assert.equal(r?.motivo, "OUTSIDE_ALLOWED_WINDOW");
    const l = await linha(m.id);
    assert.equal(l.status, SM.SCHEDULED);
    assert.ok(naFaixa(l.disponivel_em, "2035-09-15T11:00:00Z"), `disponivel_em=${l.disponivel_em}`);
    assert.equal(l.tentativas, 0, "adiar não consome attempt");
    assert.equal(chamadas.length, 0);
  });

  test("janela PRÓPRIA da organização seg–sex 08–18 (exemplo do pedido): sexta 18:30 -> SEGUNDA 08:00 local + jitter", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const m = await mensagemDevida();
    const { chamadas, whatsAppService } = provider();
    const r = (await rodar(whatsAppService, SEXTA_1830, hab({ janelas: SEG_SEX }))).find((x) => x.id === m.id);
    assert.equal(r?.resultado, "ADIADO");
    const l = await linha(m.id);
    assert.ok(naFaixa(l.disponivel_em, "2035-09-17T11:00:00Z"), `disponivel_em=${l.disponivel_em}`);
    assert.equal(chamadas.length, 0);
  });

  test("o horário é ESTÁVEL: reavaliar a mesma mensagem N vezes (mesmo dia) grava SEMPRE o mesmo instante (jitter determinístico, sem Math.random)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const m = await mensagemDevida();
    const { whatsAppService } = provider();
    const vistos = new Set();
    for (let i = 0; i < 6; i++) {
      await rodar(whatsAppService, SEXTA_1830, hab({ janelas: SEG_SEX }));
      vistos.add((await linha(m.id)).disponivel_em);
      await liberar(m.id);
    }
    assert.equal(vistos.size, 1, `o horário mudou entre reavaliações: ${[...vistos].join(" | ")}`);
  });

  test("mensagens DIFERENTES espalham na abertura (não todas às 08:00 em ponto)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const ms = [];
    for (let i = 0; i < 6; i++) ms.push(await mensagemDevida());
    // um contato por mensagem evitaria cota/cooldown, mas aqui todas são adiadas por JANELA (antes da reserva)
    const { whatsAppService } = provider();
    await rodar(whatsAppService, SEXTA_1830, hab({ janelas: SEG_SEX }));
    const quando = new Set();
    for (const m of ms) {
      const l = await linha(m.id);
      assert.ok(naFaixa(l.disponivel_em, "2035-09-17T11:00:00Z"), l.disponivel_em);
      quando.add(l.disponivel_em);
    }
    assert.ok(quando.size >= 4, `só ${quando.size} horários distintos em 6 mensagens`);
  });

  test("DENTRO da janela, um bloqueio transitório (provider offline) adia por `adiamentoMs` exatos — dentro da janela, sem jitter", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const m = await mensagemDevida();
    const { p, chamadas, whatsAppService } = provider();
    p.definirConectado(false);
    const r = (await rodar(whatsAppService, QUARTA_10H_FIXA, hab())).find((x) => x.id === m.id);
    assert.equal(r?.resultado, "ADIADO");
    assert.equal(r?.motivo, "PROVIDER_OFFLINE");
    assert.equal(new Date((await linha(m.id)).disponivel_em).toISOString(), "2035-09-19T13:15:00.000Z");
    assert.equal(chamadas.length, 0);
  });

  test("EMPRESA PAUSADA: ADIADO EMPRESA_PAUSADA (transitório, NÃO BLOCKED) até `pausado_ate`; ao vencer, volta à elegibilidade", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const m = await mensagemDevida();
    const { chamadas, whatsAppService } = provider();
    const fimPausa = new Date("2035-09-20T15:00:00Z"); // quinta 12:00 local, dentro da janela
    const pausada = hab({ empresaPausada: true, pausadoAte: fimPausa, pausadoMotivo: "manutenção programada" });
    const r = (await rodar(whatsAppService, QUARTA_10H_FIXA, pausada)).find((x) => x.id === m.id);
    assert.equal(r?.resultado, "ADIADO", JSON.stringify(r));
    assert.equal(r?.motivo, "EMPRESA_PAUSADA");
    const l = await linha(m.id);
    assert.equal(l.status, SM.SCHEDULED, "pausa não pode virar BLOCKED permanente");
    assert.equal(new Date(l.disponivel_em).toISOString(), fimPausa.toISOString());
    assert.equal(chamadas.length, 0);

    // depois do fim da pausa (resolvedor passa a devolver não-pausada) a mensagem segue o fluxo normal
    await liberar(m.id);
    const r2 = (await rodar(whatsAppService, new Date("2035-09-20T15:05:00Z"), hab())).find((x) => x.id === m.id);
    assert.equal(r2?.resultado, "ENVIADO", JSON.stringify(r2));
    assert.equal(chamadas.length, 1);
  });

  test("timezone/janela INVÁLIDOS: ADIADO CONFIG_INVALIDA (transitório; ~1h; nunca UTC assumido e nunca envia)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    for (const config of [
      { timezone: "Mars/Olympus", configHorarioValida: false },
      { timezone: "-03:00", configHorarioValida: false },
      { timezone: "America/Fortaleza", janelas: SEG_SEX, configHorarioValida: false }, // janela própria inválida no banco
    ]) {
      const m = await mensagemDevida();
      const { chamadas, whatsAppService } = provider();
      const r = (await rodar(whatsAppService, QUARTA_10H_FIXA, hab(config))).find((x) => x.id === m.id);
      assert.equal(r?.resultado, "ADIADO", JSON.stringify([config, r]));
      assert.equal(r?.motivo, "CONFIG_INVALIDA");
      const l = await linha(m.id);
      assert.equal(l.status, SM.SCHEDULED);
      assert.equal(new Date(l.disponivel_em).getTime() - QUARTA_10H_FIXA.getTime(), 60 * MIN, JSON.stringify(config));
      assert.equal(l.tentativas, 0);
      assert.equal(chamadas.length, 0);
      await supabase.from("comunicacao_mensagens").delete().eq("id", m.id);
    }
  });

  test("falha de LEITURA da habilitação não vira BLOCKED terminal: o job dá ERRO_INTERNO, nada é enviado e a mensagem continua reprocessável", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    const m = await mensagemDevida();
    const { chamadas, whatsAppService } = provider();
    const r = (await rodar(whatsAppService, QUARTA_10H_FIXA, async () => { throw new Error("fetch failed (simulado)"); })).find((x) => x.id === m.id);
    assert.equal(r?.resultado, "ERRO_INTERNO");
    assert.equal(chamadas.length, 0);
    const l = await linha(m.id);
    assert.equal(l.status, SM.PROCESSING, "fica PROCESSING: o lease expira e o job é reivindicado de novo");
    assert.notEqual(l.status, SM.BLOCKED);
    assert.equal(l.tentativas, 0);
    await supabase.from("comunicacao_mensagens").update({ claim_expira_em: new Date(Date.now() - 1000).toISOString() }).eq("id", m.id);
    const r2 = (await rodar(whatsAppService, QUARTA_10H_FIXA, hab())).find((x) => x.id === m.id);
    assert.equal(r2?.resultado, "ENVIADO", JSON.stringify(r2));
  });

  test("veredicto PERMANENTE continua terminal: empresa desabilitada / tipo não permitido -> BLOCKED (não adia)", async (t) => {
    if (!migracaoOk) return t.skip("migration 088 ainda não aplicada — pulando.");
    for (const [config, motivo] of [[{ empresaHabilitada: false }, "EMPRESA_DESABILITADA"], [{ tipoPermitido: false }, "TIPO_NAO_PERMITIDO"]]) {
      const m = await mensagemDevida();
      const { chamadas, whatsAppService } = provider();
      const r = (await rodar(whatsAppService, QUARTA_10H_FIXA, hab(config))).find((x) => x.id === m.id);
      assert.equal(r?.resultado, "BLOQUEADO");
      assert.equal(r?.motivo, motivo);
      assert.equal((await linha(m.id)).status, SM.BLOCKED);
      assert.equal(chamadas.length, 0);
    }
  });
});
