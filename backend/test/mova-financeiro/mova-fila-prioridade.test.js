// MOVA (28/11/2026): fila de saída com prioridade, categorias, capacidade reservada, adiamento (nunca descarte), expiração,
// alertas de uso, circuit breaker e limites configuráveis com auditoria. Banco real (mesma migração 0027 da produção).
import assert from "node:assert/strict";
import { GRUPO, cenario, t } from "./helpers/operacao.js";
import { criarEnviadorDeRespostas } from "../../src/modules/mova-financeiro/index.js";
import { CATEGORIA, PRIORIDADE, LIMITES_PADRAO, resolverLimites, fracaoPermitida, faixaDeUso, decidirEnvio, validarRegra, classificarPadrao, esperaDaTentativa, criarCircuito } from "../../src/modules/mova-financeiro/dominio/politicaEnvio.js";

// Relógio real: as contagens do banco usam now(); só a janela do dia é fixada pelo relogio do enviador.
const AGORA = new Date();
const DIA_LOCAL = new Date(AGORA.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
const ritmoLivre = [{ escopo: "GLOBAL", chave: "*", campo: "porMinutoTotal", valor: 600 }, { escopo: "GLOBAL", chave: "*", campo: "porMinutoPorConversa", valor: 60 }];
const enviadorDe = (s, regras, enviar, extra = {}) => {
  const avisos = [];
  const e = criarEnviadorDeRespostas({ armazenamento: s.mova.armazenamento, habilitado: true, naoAntesDe: "2000-01-01T00:00:00Z", destinosPermitidos: [GRUPO],
    limitePorRodada: 100, relogio: () => new Date(AGORA), enviar, politica: { regras: async () => [...ritmoLivre, ...regras], avisarAdministracao: async (a) => { avisos.push(a); } }, ...extra });
  return { enviarPendentes: (o) => e.enviarPendentes(o), avisos };
};
const enfileirar = async (s, n, prefixo, { categoria, prioridade, eventoId = null, validaAte = null } = {}) => {
  for (let i = 1; i <= n; i++) await s.mova.armazenamento.saida.enfileirar({ grupoId: GRUPO, respostaA: null, eventoId, texto: `${prefixo}${i}`, categoria, prioridade, validaAte });
};
const estados = async (s) => (await s.banco.pool.query("select texto, estado, ultimo_erro, motivo_adiamento, prioridade, categoria from mova.resposta order by seq")).rows;
const ok = (saida) => async (r) => { saida.push(r.texto); return { providerMessageId: `P${saida.length}` }; };

t("FP-1 política pura: limites iniciais, reserva crítica, faixas 70/85/95, precedência por escopo, validação e retentativa progressiva", () => {
  assert.equal(LIMITES_PADRAO.proativasDia, 2000); assert.equal(LIMITES_PADRAO.proativasPorPrivadoDia, 100); assert.equal(LIMITES_PADRAO.proativasPorGrupoDia, 500);
  assert.equal(fracaoPermitida(PRIORIDADE.CRITICA, LIMITES_PADRAO), 1); assert.equal(fracaoPermitida(PRIORIDADE.ALTA, LIMITES_PADRAO), 0.9); assert.equal(fracaoPermitida(PRIORIDADE.NORMAL, LIMITES_PADRAO), 0.8);
  assert.deepEqual(faixaDeUso(1400, 2000), { pct: 70, faixa: 70 }); assert.equal(faixaDeUso(1699, 2000).faixa, 70); assert.equal(faixaDeUso(1700, 2000).faixa, 85); assert.equal(faixaDeUso(1900, 2000).faixa, 95); assert.equal(faixaDeUso(100, 2000).faixa, null);
  const regras = [{ escopo: "GLOBAL", chave: "*", campo: "proativasDia", valor: 500 }, { escopo: "EMPRESA", chave: "e1", campo: "proativasDia", valor: 300 }, { escopo: "UNIDADE", chave: "u1", campo: "proativasDia", valor: 200 },
    { escopo: "GRUPO", chave: "g1", campo: "proativasDia", valor: 50 }, { escopo: "UNIDADE", chave: "u2", campo: "proativasDia", valor: 999 }];
  assert.equal(resolverLimites({ regras, empresaId: "e1", unidadeId: "u1", destino: "g1" }).proativasDia, 50, "grupo vence unidade, que vence empresa, que vence global");
  assert.equal(resolverLimites({ regras, empresaId: "e1", unidadeId: "u1", destino: "outro" }).proativasDia, 200);
  assert.equal(resolverLimites({ regras, empresaId: "e9", unidadeId: "u9", destino: "x" }).proativasDia, 500, "regra de outra empresa/unidade nunca se aplica");
  assert.equal(validarRegra({ escopo: "GLOBAL", chave: "*", campo: "proativasDia", valor: 10 }).ok, true);
  assert.equal(validarRegra({ escopo: "GLOBAL", chave: "x", campo: "proativasDia", valor: 10 }).ok, false);
  assert.equal(validarRegra({ escopo: "GLOBAL", chave: "*", campo: "proativasDia", valor: -1 }).ok, false);
  assert.equal(validarRegra({ escopo: "GLOBAL", chave: "*", campo: "inventado", valor: 1 }).ok, false);
  assert.equal(validarRegra({ escopo: "FINALIDADE", chave: "ACOMPANHAMENTO", campo: "proativasDia", valor: 5 }).ok, true);
  assert.equal(validarRegra({ escopo: "FINALIDADE", chave: "QUALQUER", campo: "proativasDia", valor: 5 }).ok, false);
  assert.deepEqual([1, 2, 3, 4, 20].map(esperaDaTentativa), [15_000, 30_000, 60_000, 120_000, 1_800_000]);
  assert.deepEqual(classificarPadrao({ eventoId: "e1" }), { categoria: CATEGORIA.RESPOSTA, prioridade: PRIORIDADE.CRITICA });
  assert.deepEqual(classificarPadrao({}), { categoria: CATEGORIA.PROATIVA, prioridade: PRIORIDADE.ALTA });
  const c = criarCircuito({ falhasSeguidas: 2, pausaSegundos: 10 }); c.falha(AGORA); assert.equal(c.abertoAte, 0); c.falha(AGORA); assert.ok(c.abertoAte > AGORA.getTime()); c.sucesso(); assert.equal(c.abertoAte, 0);
  // resposta e erro não consomem o teto proativo; o ritmo vale para todos
  const limites = { ...LIMITES_PADRAO, proativasDia: 1 };
  assert.equal(decidirEnvio({ item: { categoria: CATEGORIA.RESPOSTA, prioridade: 0, destinoTipo: "PRIVADO" }, uso: { dia: 5 }, limites, agora: AGORA }).acao, "ENVIAR");
  assert.equal(decidirEnvio({ item: { categoria: CATEGORIA.PROATIVA, prioridade: 0, destinoTipo: "PRIVADO" }, uso: { dia: 1 }, limites, agora: AGORA }).motivo, "LIMITE_DIARIO");
  assert.equal(decidirEnvio({ item: { categoria: CATEGORIA.RESPOSTA, prioridade: 0, destinoTipo: "PRIVADO" }, uso: { ultimoMinutoDestino: 6 }, limites: LIMITES_PADRAO, agora: AGORA }).motivo, "RITMO_DA_CONVERSA");
});

t("FP-2 capacidade reservada: com o teto cheio de avisos normais, as mensagens críticas ainda saem; nada é descartado", async () => {
  const s = await cenario();
  await enfileirar(s, 12, "n", { categoria: CATEGORIA.ACOMPANHAMENTO, prioridade: PRIORIDADE.NORMAL });
  await enfileirar(s, 2, "c", { categoria: CATEGORIA.TRANSACIONAL, prioridade: PRIORIDADE.CRITICA });
  const saida = [];
  const e = enviadorDe(s, [{ escopo: "GLOBAL", chave: "*", campo: "proativasDia", valor: 10 }, { escopo: "GLOBAL", chave: "*", campo: "proativasPorGrupoDia", valor: 500 }], ok(saida));
  await e.enviarPendentes({ limite: 100 });
  assert.deepEqual(saida.slice(0, 2), ["c1", "c2"], "a crítica sai primeiro");
  assert.equal(saida.length, 8, "normais só até 80% do teto TOTAL (os 20% restantes ficam reservados à alta e à crítica)");
  assert.equal(saida.filter((x) => x.startsWith("n")).length, 6);
  const r = await estados(s);
  assert.equal(r.filter((x) => x.estado === "FALHOU" || x.estado === "SUPRIMIDA").length, 0, "nada foi descartado");
  assert.deepEqual([...new Set(r.filter((x) => x.estado === "PENDENTE").map((x) => x.motivo_adiamento))], ["LIMITE_DIARIO"]);
  assert.equal(r.filter((x) => x.estado === "PENDENTE").length, 6);
  assert.ok(e.avisos.some((a) => a.tipo === "REPRESAMENTO"), "represamento alertado");
  // duas críticas chegam com as normais já bloqueadas (80%): saem pela reserva; a terceira encontra o teto cheio e ESPERA (sem perder)
  await enfileirar(s, 3, "z", { categoria: CATEGORIA.TRANSACIONAL, prioridade: PRIORIDADE.CRITICA });
  await enviadorDe(s, [{ escopo: "GLOBAL", chave: "*", campo: "proativasDia", valor: 10 }], ok(saida)).enviarPendentes({ limite: 100 });
  assert.deepEqual(saida.slice(8), ["z1", "z2"], "a reserva crítica garante as duas últimas vagas do dia");
  assert.equal((await estados(s)).filter((x) => x.texto === "z3")[0].estado, "PENDENTE");
});

t("FP-3 respostas pedidas por pessoas não têm teto diário de quantidade (e mensagem de erro também); ritmo por conversa continua valendo", async () => {
  const s = await cenario();
  await enfileirar(s, 30, "r", { eventoId: "evt-1" }); // RESPOSTA / CRÍTICA por padrão
  await enfileirar(s, 3, "e", { categoria: CATEGORIA.ERRO, prioridade: PRIORIDADE.CRITICA });
  const saida = [];
  await enviadorDe(s, [{ escopo: "GLOBAL", chave: "*", campo: "proativasDia", valor: 1 }], ok(saida)).enviarPendentes({ limite: 100 });
  assert.equal(saida.length, 33, "todas saíram apesar de proativasDia=1");
  const livre = (await estados(s)).filter((x) => x.estado === "ENVIADA").length;
  assert.equal(livre, 33);
  // ritmo: com 5 por minuto por conversa, o excedente é ADIADO (não falha) mesmo para resposta
  await enfileirar(s, 8, "q", { eventoId: "evt-2" });
  const saida2 = [];
  await enviadorDe(s, [{ escopo: "GLOBAL", chave: "*", campo: "porMinutoPorConversa", valor: 5 }], ok(saida2)).enviarPendentes({ limite: 100 });
  assert.equal(saida2.length <= 5, true, "ritmo por conversa respeitado");
  assert.equal((await estados(s)).filter((x) => x.estado === "FALHOU").length, 0);
});

t("FP-4 recuperação: reiniciar o enviador não perde a fila; adiadas saem quando a janela passa (dia seguinte)", async () => {
  const s = await cenario();
  await enfileirar(s, 5, "p", { categoria: CATEGORIA.PROATIVA, prioridade: PRIORIDADE.ALTA });
  const saida = [];
  const regras = [{ escopo: "GLOBAL", chave: "*", campo: "proativasDia", valor: 3 }, { escopo: "GLOBAL", chave: "*", campo: "reservaCriticaPct", valor: 0 }, { escopo: "GLOBAL", chave: "*", campo: "reservaAltaPct", valor: 0 }];
  await enviadorDe(s, regras, ok(saida)).enviarPendentes({ limite: 100 });
  assert.deepEqual(saida, ["p1", "p2", "p3"]);
  const ainda = await estados(s);
  assert.equal(ainda.filter((x) => x.estado === "PENDENTE").length, 2);
  // "reinício": enviador novo, mesmo banco; ainda no mesmo dia e antes de liberar_em ⇒ nada sai
  await enviadorDe(s, regras, ok(saida)).enviarPendentes({ limite: 100 });
  assert.equal(saida.length, 3, "antes da liberação não sai (e não conta tentativa)");
  // dia seguinte, 10:00 Fortaleza
  const amanha = () => new Date(AGORA.getTime() + 24 * 3600_000);
  await enviadorDe(s, regras, ok(saida), { relogio: amanha }).enviarPendentes({ limite: 100 });
  assert.deepEqual(saida, ["p1", "p2", "p3", "p4", "p5"], "recuperou no dia seguinte, na ordem");
  assert.equal((await s.banco.pool.query("select max(tentativas)::int n from mova.resposta")).rows[0].n, 1, "adiar não consome tentativa de envio");
});

t("FP-5 validade: mensagem vencida vira EXPIRADA (visível, com alerta) e nunca sai velha; as válidas seguem", async () => {
  const s = await cenario();
  await enfileirar(s, 1, "v", { categoria: CATEGORIA.ACOMPANHAMENTO, prioridade: PRIORIDADE.NORMAL, validaAte: new Date(AGORA.getTime() - 60_000).toISOString() });
  await enfileirar(s, 1, "w", { categoria: CATEGORIA.ACOMPANHAMENTO, prioridade: PRIORIDADE.NORMAL, validaAte: new Date(AGORA.getTime() + 3600_000).toISOString() });
  const saida = [];
  const e = enviadorDe(s, [], ok(saida));
  await e.enviarPendentes({ limite: 100 });
  assert.deepEqual(saida, ["w1"]);
  assert.deepEqual((await estados(s)).map((x) => [x.texto, x.estado]), [["v1", "EXPIRADA"], ["w1", "ENVIADA"]]);
  assert.ok(e.avisos.some((a) => a.tipo === "EXPIRADA"));
});

t("FP-6 alertas de uso em 70/85/95%: um por faixa e por dia (idempotente)", async () => {
  const s = await cenario();
  await enfileirar(s, 8, "u", { categoria: CATEGORIA.PROATIVA, prioridade: PRIORIDADE.CRITICA });
  const saida = [];
  const regras = [{ escopo: "GLOBAL", chave: "*", campo: "proativasDia", valor: 10 }];
  const e = enviadorDe(s, regras, ok(saida));
  await e.enviarPendentes({ limite: 100 });
  const f = e.avisos.filter((a) => a.tipo === "USO_DIARIO").map((a) => a.faixa);
  assert.deepEqual(f, [70], "80% usado ⇒ faixa 70");
  await enfileirar(s, 1, "u9", { categoria: CATEGORIA.PROATIVA, prioridade: PRIORIDADE.CRITICA });
  await e.enviarPendentes({ limite: 100 });
  await enviadorDe(s, regras, ok(saida)).enviarPendentes({ limite: 100 });
  const dia = await s.mova.armazenamento.alertasDeEnvio.listar(DIA_LOCAL);
  assert.deepEqual(dia.filter((a) => a.tipo === "USO_DIARIO").map((a) => a.faixa).sort(), [70, 85], "90% ⇒ 85; nenhuma faixa repete");
});

t("FP-7 circuit breaker: falhas seguidas do Gateway pausam o envio; as mensagens ficam na fila (sem FALHOU) e saem depois", async () => {
  const s = await cenario();
  await enfileirar(s, 8, "k", { categoria: CATEGORIA.PROATIVA, prioridade: PRIORIDADE.ALTA });
  let chamadas = 0;
  const falha = async () => { chamadas += 1; throw Object.assign(new Error("fora"), { codigo: "GATEWAY_INALCANCAVEL" }); };
  const e = enviadorDe(s, [], falha);
  await e.enviarPendentes({ limite: 100 });
  assert.equal(chamadas, LIMITES_PADRAO.circuitoFalhasSeguidas, "para de martelar o Gateway ao abrir o circuito");
  const r = await estados(s);
  assert.equal(r.filter((x) => x.estado === "FALHOU").length, 0);
  assert.ok(e.avisos.some((a) => a.tipo === "CIRCUITO"));
  // espera progressiva (backoff) gravada em liberar_em
  const { rows } = await s.banco.pool.query("select count(*)::int n from mova.resposta where liberar_em > $1::timestamptz", [AGORA.toISOString()]);
  assert.equal(rows[0].n, 8);
});

t("FP-8 limites configuráveis sem deploy: gravação com justificativa, histórico, auditoria; regra de outra empresa não vaza; inválida recusada", async () => {
  const s = await cenario();
  const L = s.mova.armazenamento.limitesDeEnvio;
  await assert.rejects(() => L.definir({ escopo: "GLOBAL", chave: "*", campo: "proativasDia", valor: 5, ator: "admin", justificativa: "curta" }), /justificativa/);
  await L.definir({ escopo: "GRUPO", chave: GRUPO, campo: "proativasPorGrupoDia", valor: 7, ator: "admin-1", justificativa: "Grupo financeiro: teto menor na homologação." });
  await L.definir({ escopo: "GRUPO", chave: GRUPO, campo: "proativasPorGrupoDia", valor: 9, ator: "admin-1", justificativa: "Ajuste após a primeira semana de uso." });
  const ativas = await L.regrasAtivas();
  assert.deepEqual(ativas.map((r) => [r.escopo, r.campo, r.valor]), [["GRUPO", "proativasPorGrupoDia", 9]]);
  const h = await L.historico();
  assert.deepEqual(h.map((x) => [x.valorAntes, x.valorDepois]), [["7", "9"], [null, "7"]]);
  assert.equal((await s.banco.pool.query("select count(*)::int n from mova.auditoria where acao = 'LIMITE_DE_ENVIO_ALTERADO'")).rows[0].n, 2);
  // efeito real: o grupo passa a ter teto 9 mesmo com o padrão 500
  await enfileirar(s, 12, "g", { categoria: CATEGORIA.PROATIVA, prioridade: PRIORIDADE.CRITICA });
  const saida = [];
  await enviadorDe(s, ativas, ok(saida)).enviarPendentes({ limite: 100 });
  assert.equal(saida.length, 9);
});

t("FP-9 compatibilidade: sem a política, o enviador legado continua igual (teto diário FALHOU, como antes)", async () => {
  const s = await cenario();
  await enfileirar(s, 3, "l", { categoria: CATEGORIA.PROATIVA });
  const saida = [];
  await criarEnviadorDeRespostas({ armazenamento: s.mova.armazenamento, habilitado: true, naoAntesDe: "2000-01-01T00:00:00Z", destinosPermitidos: [GRUPO], maximoPorDia: 2, limitePorRodada: 10, enviar: ok(saida) }).enviarPendentes();
  assert.equal(saida.length, 2);
  assert.equal((await estados(s)).filter((x) => x.estado === "FALHOU").length, 1);
});
