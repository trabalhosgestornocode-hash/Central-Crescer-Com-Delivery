// 23/11/2026 — Merge, deploy e migração NÃO disparam mensagens: sem automação configurada a rotina não envia nada, em nenhum
// dia; ligar uma automação depois não manda mensagens antigas (semanal = só a semana anterior; lembrete = só o ciclo atual).
// Financeiro simulado, armazenamento em memória. Nada sai para o WhatsApp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { criarEntregadoresMova, AUTOMACAO } from "../../src/modules/mova-financeiro/aplicacao/entregadoresMova.js";
import { criarArmazenamentoMemoria } from "../../src/modules/mova-financeiro/infra/memoria.js";

const ORG = "eeeeeeee-0000-4000-8000-0000000000f1";
const ALFA = "eeeeeeee-0000-4000-8000-0000000000a1";
const GRUPO = "120363000000000001@g.us";
const PRIV = "5585999990011@s.whatsapp.net";
const ENT = { organizacaoId: ORG, unidadeId: ALFA, chave: "ent-1", telefoneE164: "+5585999990011", privado: PRIV, nome: "Entregador Sintético", ativo: true, ids: [] };
const CFG = Object.freeze({
  identidadeServico: { usuarioId: "eeeeeeee-0000-4000-8000-0000000000aa" },
  unidades: [{ organizacaoId: ORG, unidadeId: ALFA, nome: "Loja Sintética", empresa: "Empresa Sintética", documentos: [] }],
  gruposAutorizados: [
    { grupoId: GRUPO, unidades: [ALFA], privada: false, politicaResposta: "GRUPO_FINANCEIRO", participantes: [{ telefones: ["+5585999990001"] }] },
    { grupoId: PRIV, unidades: [ALFA], privada: true, entregador: { chave: ENT.chave, unidadeId: ALFA, nome: ENT.nome }, participantes: [] },
  ],
  entregadores: [ENT],
});
const F = (inicio, x = {}) => {
  const d = new Date(`${inicio}T12:00:00Z`);
  const mais = (n) => new Date(d.getTime() + n * 86400000).toISOString().slice(0, 10);
  return { semanaInicio: inicio, semanaFim: mais(6), prazoDaNota: mais(8), vencimento: mais(9), entregas: 10, valorCentavos: 15000, ajustesCentavos: 0,
    situacaoDocumental: "AGUARDANDO_NF", situacaoPagamento: "A_VENCER", duplicidade: null, entregador: { chave: ENT.chave, nome: ENT.nome }, ...x };
};
// três semanas antigas SEM nota (26/10, 02/11, 09/11), uma já liberada, e a do ciclo atual (16/11)
const FECHAMENTOS = [F("2026-10-26"), F("2026-11-02"), F("2026-11-09"), F("2026-10-19", { situacaoDocumental: "LIBERADO_PAGAMENTO" }), F("2026-11-16")];

function montar(agora) {
  const relogio = { t: new Date(agora) };
  const a = criarArmazenamentoMemoria({ relogio: () => relogio.t });
  const enviados = [];
  const armazenamento = { ...a, saida: { ...a.saida, async enfileirar(r) { enviados.push(r); return a.saida.enfileirar(r); } } };
  const porta = { async ler(nome, escopo, args) {
    if (nome === "detalharFechamentoDoEntregador") { const f = FECHAMENTOS.find((x) => x.semanaInicio === args.inicio && x.entregador.chave === args.entregador); if (!f) throw Object.assign(new Error("x"), { codigo: "FV2_NAO_ENCONTRADO" }); return f; }
    if (nome === "consultarEntregador") return { fechamentos: FECHAMENTOS.filter((x) => x.entregador.chave === args.entregador) };
    if (nome === "consultarEntregadoresProprios") return { fechamentos: FECHAMENTOS };
    throw new Error(`leitura inesperada ${nome}`);
  } };
  const e = criarEntregadoresMova({ cfg: CFG, porta, armazenamento, extrator: null, obterEvidencia: async () => new Uint8Array(), relogio: () => relogio.t });
  const ligar = (nome, horario = "00:00") => a.automacoes.definir({ nome, organizacaoId: ORG, unidadeId: ALFA, ativa: true, horario });
  return { e, a, enviados, relogio, ligar };
}

test("D1 deploy sem automação configurada: a rotina roda a semana inteira, a qualquer hora, e NADA é enfileirado", async () => {
  const m = montar("2026-11-23T13:00:00Z");
  for (let dia = 23; dia <= 29; dia += 1) for (const hora of ["03", "11", "13", "20"]) {
    m.relogio.t = new Date(`2026-11-${dia}T${hora}:00:00Z`);
    const r = await m.e.rotina();
    assert.equal(r.semanais + r.cobrancas + r.avisos + r.relatorios, 0);
  }
  assert.equal(m.enviados.length, 0);
  for (const n of Object.values(AUTOMACAO)) assert.equal(await m.a.automacoes.obter(n, ALFA), null, `${n} começa sem configuração (desligada)`);
});

test("D2 lembrete ligado DEPOIS: só a semana do ciclo atual; as três semanas antigas sem nota NÃO recebem lembrete retroativo", async () => {
  const m = montar("2026-11-24T13:00:00Z"); // terça
  await m.ligar(AUTOMACAO.COBRANCA);
  const r = await m.e.rotina();
  assert.equal(r.cobrancas, 1);
  assert.equal(m.enviados.length, 1);
  assert.match(m.enviados[0].texto, /16\/11/);
  assert.equal(r.pulados.filter((x) => x === "COBRANCA_DE_SEMANA_ANTIGA").length, 3);
  assert.equal((await m.e.rotina()).cobrancas, 0, "idempotente no mesmo dia");
});

test("D3 semanal ligado DEPOIS: só a semana anterior (16–22/11), nunca semanas antigas; fora da segunda nada", async () => {
  const m = montar("2026-11-25T13:00:00Z"); // quarta
  await m.ligar(AUTOMACAO.SEMANAL);
  assert.equal((await m.e.rotina()).semanais, 0, "ligar na quarta não envia demonstrativo");
  m.relogio.t = new Date("2026-11-23T13:00:00Z"); // segunda
  const r = await m.e.rotina();
  assert.equal(r.semanais, 1);
  assert.equal(m.enviados.filter((x) => /26\/10|02\/11|09\/11/.test(x.texto)).length, 0);
});

test("D4 aviso de liberação ligado DEPOIS: a 1ª passada só registra o que já estava liberado (nada retroativo no grupo)", async () => {
  const m = montar("2026-11-24T13:00:00Z");
  await m.ligar(AUTOMACAO.AVISO_GRUPO);
  const r = await m.e.rotina();
  assert.equal(r.avisos, 0);
  assert.equal(m.enviados.filter((x) => x.texto).length, 0);
});
