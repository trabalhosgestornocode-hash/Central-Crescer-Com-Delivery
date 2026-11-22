// MOVA — fila de saída pelo relé (Execução 15B): módulo do Gateway isolado, com relé e sessão SIMULADOS (sem rede, sem WhatsApp).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CAMINHO_SAIDA_MOVA, criarSaidaMova, lerSaidaMova } from "../src/movaSaida.js";

const ID = "11111111-1111-4111-8111-111111111111";
const CONTATO = "5500000000777@s.whatsapp.net";
function montar({ itens = [], falharAcao = null, sessaoErro = null } = {}) {
  const chamadas = []; const envios = [];
  const fetchFn = async (url, o) => {
    const b = JSON.parse(o.body); chamadas.push({ url, acao: b.acao, b, h: o.headers });
    if (falharAcao === b.acao) throw new Error("rede");
    const json = b.acao === "reservar" ? { resultado: "OK", itens: itens.splice(0) } : { resultado: "OK" };
    return { status: 200, json: async () => json };
  };
  const sessao = { async enviarGrupoMova(x) { if (sessaoErro) throw sessaoErro; envios.push(x); return { providerMessageId: "PROV1" }; } };
  const s = criarSaidaMova({ url: "https://rele.exemplo", segredo: "s".repeat(40), sessao, gatewayId: "gw-teste", fetchFn, agendar: () => 0, cancelar: () => {} });
  return { s, chamadas, envios };
}

test("inerte por padrão: sem canal, sem envio habilitado ou sem contato verificado ⇒ não existe", () => {
  assert.equal(lerSaidaMova({ canalAtivo: false, envioHabilitado: true, contatoHomologacao: {} }).ativo, false);
  assert.equal(lerSaidaMova({ canalAtivo: true, envioHabilitado: false, contatoHomologacao: {} }).ativo, false);
  assert.equal(lerSaidaMova({ canalAtivo: true, envioHabilitado: true, contatoHomologacao: null }).ativo, false);
  assert.equal(lerSaidaMova({ canalAtivo: true, envioHabilitado: true, contatoHomologacao: {} }).ativo, true);
});

test("envio: reserva assinada no caminho da saída, envia ao contato e confirma com o id do provedor", async () => {
  const m = montar({ itens: [{ id: ID, destino: CONTATO, texto: "oi" }] });
  assert.equal((await m.s.rodada()).enviadas, 1);
  assert.deepEqual(m.chamadas.map((c) => c.acao), ["reservar", "confirmar"]);
  assert.ok(m.chamadas[0].url.endsWith(CAMINHO_SAIDA_MOVA));
  assert.ok(m.chamadas[0].h["X-Gateway-Signature"] || m.chamadas[0].h["x-gateway-signature"]);
  assert.equal(m.chamadas[1].b.providerMessageId, "PROV1");
  assert.deepEqual(m.envios.map((e) => [e.grupoJid, e.correlationId]), [[CONTATO, `mova-saida:${ID}`]]);
});

test("confirmação perdida: tenta CONFIRMAR de novo (nunca reenviar); o id fica bloqueado neste processo", async () => {
  const m = montar({ itens: [{ id: ID, destino: CONTATO, texto: "oi" }], falharAcao: "confirmar" });
  await m.s.rodada();
  assert.equal(m.envios.length, 1);
  assert.equal(m.chamadas.filter((c) => c.acao === "confirmar").length, 3);
  // o relé devolveria o mesmo id de novo (defeito hipotético): barreira em memória não envia
  const m2 = montar({ itens: [{ id: ID, destino: CONTATO, texto: "oi" }, { id: ID, destino: CONTATO, texto: "oi" }] });
  await m2.s.rodada();
  assert.equal(m2.envios.length, 1);
  assert.deepEqual(m2.chamadas.filter((c) => c.acao === "falhar").map((c) => [c.b.codigo, c.b.antesDoEnvio]), [["JA_ENVIADA_NESTE_PROCESSO", false]]);
});

test("erro da sessão: pré-envio ⇒ falhar antesDoEnvio=true; depois de tentar ⇒ antesDoEnvio=false (INCERTA no relé)", async () => {
  const pre = montar({ itens: [{ id: ID, destino: CONTATO, texto: "oi" }], sessaoErro: Object.assign(new Error("x"), { codigo: "WHATSAPP_GATEWAY_NOT_CONNECTED", preEnvio: true }) });
  await pre.s.rodada();
  assert.deepEqual([pre.chamadas.at(-1).b.antesDoEnvio, pre.chamadas.at(-1).b.codigo], [true, "WHATSAPP_GATEWAY_NOT_CONNECTED"]);
  const pos = montar({ itens: [{ id: ID, destino: CONTATO, texto: "oi" }], sessaoErro: new Error("timeout") });
  await pos.s.rodada();
  assert.equal(pos.chamadas.at(-1).b.antesDoEnvio, false);
});

test("item inválido (grupo, texto vazio, id fora do formato) nunca chega à sessão", async () => {
  const m = montar({ itens: [{ id: ID, destino: "120363000000000001@g.us", texto: "x" }, { id: "nao-uuid", destino: CONTATO, texto: "x" }, { id: ID.replace("1", "2"), destino: CONTATO, texto: " " }] });
  await m.s.rodada();
  assert.equal(m.envios.length, 0);
});

test("fora da liderança do lease: não reserva nada", async () => {
  const chamadas = [];
  const s = criarSaidaMova({ url: "https://r", segredo: "s".repeat(40), sessao: { enviarGrupoMova: async () => ({}) }, gatewayId: "gw", souLider: () => false,
    fetchFn: async (...a) => { chamadas.push(a); return { status: 200, json: async () => ({}) }; }, agendar: () => 0, cancelar: () => {} });
  assert.deepEqual(await s.rodada(), { enviadas: 0, pulada: true });
  assert.equal(chamadas.length, 0);
});

test("Agente 2: WHATSAPP_MOVA_SAIDA_MODO=DIRETO ⇒ a fila do relé NÃO sobe (produção entrega por /internal/mova/messages); RELE segue igual", () => {
  const base = { canalAtivo: true, envioHabilitado: true, contatoHomologacao: {} };
  assert.deepEqual(lerSaidaMova({ ...base, modo: "DIRETO" }), { ativo: false, motivo: "TRANSPORTE_DIRETO" });
  assert.deepEqual(lerSaidaMova({ ...base, modo: "RELE" }), { ativo: true });
  assert.deepEqual(lerSaidaMova(base), { ativo: true }, "ausente = RELE (homologação inalterada)");
  assert.deepEqual(lerSaidaMova({ ...base, envioHabilitado: false, modo: "DIRETO" }), { ativo: false, motivo: "ENVIO_DESLIGADO" });
});
