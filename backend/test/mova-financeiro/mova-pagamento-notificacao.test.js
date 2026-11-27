// MOVA — 27/11/2026: NOTIFICAÇÃO AUTOMÁTICA DE PAGAMENTO ao entregador (+ aviso consolidado no grupo financeiro).
// Financeiro v2 REAL em memória (fechamento, nota, liberação, baixa, extrato, estorno) + banco do MOVA no PostgreSQL local isolado.
// Gateway SIMULADO: nada sai para o WhatsApp; o "retorno do Gateway" é marcado à mão na fila de saída. Dados 100% sintéticos.
import assert from "node:assert/strict";
import { AUTOMACAO_PAGAMENTO } from "../../src/modules/mova-financeiro/index.js";
import { ALFA, BETA, t } from "./helpers/operacao.js";
import { ADM, GRUPO_ALFA, GRUPO_BETA, MAURICIO, RAFAEL, S2, SEG, SEM_FONE, ativar, cenario } from "./helpers/cenarioEntregadores.js";
import { ORG } from "./helpers/operacao.js";

t("PG1 sem automação ligada nada é criado nem enviado; pagamento ANTERIOR ao marco nunca vira mensagem (sem disparo retroativo)", async () => {
  const s = await cenario();
  const o = await s.liberar(ALFA, SEG, "mauricio", "Mauricio Sintetico", 1500);
  await s.pagar(ALFA, o, 1500); // pago ANTES de ligar a automação
  assert.equal(await s.passada(), null, "nenhuma unidade ligada: a passada não faz nada");
  assert.equal((await s.eventos()).length, 0);
  await s.ligar();
  s.estado.agora = "2026-11-18T15:00:30.000Z";
  const r1 = await s.passada();
  assert.ok(r1.pulados.includes("MARCO_FIXADO") && r1.criadas === 0);
  s.estado.agora = "2026-11-18T15:05:00.000Z";
  const r2 = await s.passada();
  assert.equal(r2.criadas, 0, "o pagamento histórico não é avisado");
  assert.ok(r2.historicas >= 1);
  assert.deepEqual(await s.saida(), []);
});

t("PG2 pagamento registrado no sistema: mensagem individual no modelo, sem IA; o grupo só é avisado DEPOIS do desfecho; nada repete", async () => {
  const s = await cenario();
  await ativar(s);
  const o = await s.liberar(ALFA, SEG, "mauricio", "Mauricio Sintetico", 1500);
  await s.pagar(ALFA, o, 1500);
  const r = await s.passada();
  assert.equal(r.criadas, 1);
  assert.equal(r.enfileiradas, 1);
  const privado = await s.saida(MAURICIO);
  assert.equal(privado.length, 1, "só a empresa Açaí: o entregador também é da Beta, que não pagou nada");
  assert.equal(privado[0].texto, [
    "Olá, Mauricio! 👋", "✅ Seu pagamento foi realizado com sucesso!", "🏢 Empresa: Acai Alfa Sintetico", "📅 Período: 02/11/2026 a 08/11/2026", "🛵 Quantidade de entregas: 2",
    "💰 Valor pago: R$ 15,00", "🗓️ Data do pagamento: 18/11/2026", "Agradecemos pela parceria e pelo trabalho realizado durante a semana!", "MOVA | Crescer com Delivery"].join("\n"));
  assert.deepEqual(await s.saida(GRUPO_ALFA), [], "o grupo só é avisado depois do retorno do WhatsApp");
  // ainda na fila: passadas seguintes não duplicam nem avisam o grupo
  assert.equal((await s.passada()).enfileiradas, 0);
  assert.equal((await s.saida()).length, 1);
  await s.marcar(MAURICIO, "ENVIADA");
  const r2 = await s.passada();
  assert.equal(r2.enviadas, 1);
  assert.equal(r2.avisos, 1);
  const grupo = await s.saida(GRUPO_ALFA);
  assert.equal(grupo.length, 1);
  assert.match(grupo[0].texto, /Pagamento efetivado — Acai Alfa Sintetico/);
  assert.match(grupo[0].texto, /Entregador: Mauricio Sintetico/);
  assert.match(grupo[0].texto, /Valor pago: R\$ 15,00/);
  assert.match(grupo[0].texto, /Entregador notificado \(mensagem aceita pelo WhatsApp\)/);
  assert.match(grupo[0].texto, /baixa registrada no sistema/);
  for (let i = 0; i < 3; i += 1) await s.passada();
  assert.equal((await s.saida()).length, 2, "idempotente: nenhuma mensagem a mais");
  assert.deepEqual((await s.eventos()).map((e) => [e.destino, e.estado]), [["ENTREGADOR", "ENVIADO"], ["GRUPO", "ENFILEIRADO"]], "o aviso do grupo só vira ENVIADO com o retorno do WhatsApp");
  await s.marcar(GRUPO_ALFA, "ENVIADA");
  await s.passada();
  assert.deepEqual((await s.eventos()).map((e) => [e.destino, e.estado]), [["ENTREGADOR", "ENVIADO"], ["GRUPO", "ENVIADO"]]);
});

t("PG3 transação revertida / pagamento recusado não gera aviso; a mesma baixa repetida não gera segundo aviso (manual + comprovante do mesmo pagamento)", async () => {
  const s = await cenario();
  await ativar(s);
  const o = await s.liberar(ALFA, SEG, "mauricio", "Mauricio Sintetico", 1500);
  await assert.rejects(s.pagar(ALFA, o, 99_999), "valor acima do saldo é recusado e nada fica gravado");
  assert.equal((await s.passada()).criadas, 0);
  await s.pagar(ALFA, o, 1500);
  const repetido = await s.pagar(ALFA, o, 1500); // o mesmo pagamento enviado de novo (ex.: depois como comprovante)
  assert.equal(repetido.repetido, true);
  assert.equal((await s.passada()).criadas, 1);
  assert.equal((await s.passada()).criadas, 0);
  assert.equal((await s.saida(MAURICIO)).length, 1);
});

t("PG4 pagamento PARCIAL: mensagem específica com valor pago e saldo; o pagamento do restante gera a mensagem de quitação", async () => {
  const s = await cenario();
  await ativar(s);
  const o = await s.liberar(ALFA, SEG, "mauricio", "Mauricio Sintetico", 1500);
  await s.pagar(ALFA, o, 1000);
  await s.passada();
  const [parcial] = await s.saida(MAURICIO);
  assert.match(parcial.texto, /pagamento PARCIAL/);
  assert.match(parcial.texto, /Valor pago agora: R\$ 10,00/);
  assert.match(parcial.texto, /Saldo restante: R\$ 5,00/);
  await s.marcar(MAURICIO, "ENVIADA");
  await s.passada();
  assert.match((await s.saida(GRUPO_ALFA))[0].texto, /Pagamento PARCIAL efetivado.*Saldo restante: R\$ 5,00/s);
  s.estado.agora = "2026-11-18T15:10:00.000Z";
  await s.pagar(ALFA, o, 500);
  await s.passada();
  const msgs = await s.saida(MAURICIO);
  assert.equal(msgs.length, 2);
  assert.match(msgs[1].texto, /Seu pagamento foi realizado com sucesso/);
  assert.match(msgs[1].texto, /Valor pago: R\$ 5,00/);
  assert.doesNotMatch(msgs[1].texto, /PARCIAL/);
});

t("PG5 baixa AGRUPADA pelo extrato: várias semanas do mesmo entregador numa só mensagem, cada período discriminado; dois entregadores = duas mensagens", async () => {
  const s = await cenario();
  await ativar(s);
  const o1 = await s.liberar(ALFA, SEG, "mauricio", "Mauricio Sintetico", 1500);
  const o2 = await s.liberar(ALFA, S2, "mauricio", "Mauricio Sintetico", 600);
  const o3 = await s.liberar(ALFA, SEG, "rafael", "Rafael Sintetico", 900);
  const { movimentacao: mov } = await s.real.registrarMovimentacao(s.adm(ALFA), { contaId: s.contas[ALFA], dataEfetiva: "2026-11-18", sentido: "SAIDA", valorCentavos: 3000, natureza: "PAGAMENTO", descricao: "PIX agrupado sintetico" });
  const doc = (await s.real.detalharFechamentoDoEntregador(s.adm(ALFA), { inicio: SEG, entregador: "mauricio" })).documentos[0].id;
  await s.real.vincularPagamentoDoExtrato(s.adm(ALFA), { movimentacaoId: mov.id, versaoMovimentacao: mov.versao, alocacoes: [{ obrigacaoId: o1, valorCentavos: 1500 }, { obrigacaoId: o2, valorCentavos: 600 }, { obrigacaoId: o3, valorCentavos: 900 }], documentoId: doc, justificativa: "Baixa agrupada de teste.", confirmar: true });
  const r = await s.passada();
  assert.equal(r.criadas, 2, "um evento por entregador");
  const m = (await s.saida(MAURICIO))[0].texto;
  assert.match(m, /📅 Períodos:/);
  assert.match(m, /• 02\/11\/2026 a 08\/11\/2026 — 2 entrega\(s\) — R\$ 15,00/);
  assert.match(m, /• 09\/11\/2026 a 15\/11\/2026 — 1 entrega\(s\) — R\$ 6,00/);
  assert.match(m, /Quantidade de entregas: 3/);
  assert.match(m, /Valor pago: R\$ 21,00/);
  const rf = (await s.saida(RAFAEL))[0].texto;
  assert.match(rf, /Valor pago: R\$ 9,00/);
  assert.doesNotMatch(rf, /21,00|Mauricio/);
  assert.doesNotMatch(m, /9,00|Rafael/, "nunca mistura entregadores");
  await s.marcar(undefined, "ENVIADA");
  await s.passada();
  assert.match((await s.saida(GRUPO_ALFA)).map((x) => x.texto).join("\n"), /conciliação bancária/);
});

t("PG6 estorno: aviso só à gerência (uma vez); o entregador não recebe mensagem de estorno; estorno parcial seguido de outro é outro aviso", async () => {
  const s = await cenario();
  await ativar(s);
  const o = await s.liberar(ALFA, SEG, "mauricio", "Mauricio Sintetico", 1500);
  await s.pagar(ALFA, o, 1500);
  await s.passada();
  await s.marcar(MAURICIO, "ENVIADA");
  await s.passada();
  const baixas = await s.real.consultarBaixasDeEntregadores(s.adm(ALFA), {});
  assert.equal(baixas.itens.length, 1);
  s.estado.agora = "2026-11-18T15:20:00.000Z";
  await s.real.estornarLiquidacao(s.adm(ALFA), { liquidacaoId: baixas.itens[0].liquidacaoId, valorCentavos: 500, justificativa: "Estorno parcial de teste." });
  await s.passada();
  await s.passada();
  const grupo = (await s.saida(GRUPO_ALFA)).map((x) => x.texto);
  assert.equal(grupo.filter((x) => /Estorno PARCIAL/.test(x)).length, 1, "um aviso de estorno, mesmo com várias passadas");
  assert.match(grupo.find((x) => /Estorno/.test(x)), /Valor estornado: R\$ 5,00/);
  assert.equal((await s.saida(MAURICIO)).length, 1, "o entregador não recebe aviso de estorno");
});

t("PG7 falha temporária do Gateway: evento FALHOU, o grupo é avisado da falha; reenvio manual controlado entrega e o grupo recebe a confirmação; limite de reenvios", async () => {
  const s = await cenario();
  await ativar(s);
  const o = await s.liberar(ALFA, SEG, "mauricio", "Mauricio Sintetico", 1500);
  await s.pagar(ALFA, o, 1500);
  await s.passada();
  await s.marcar(MAURICIO, "FALHOU");
  const r = await s.passada();
  assert.equal(r.falhas, 1);
  assert.equal(r.avisos, 1);
  assert.match((await s.saida(GRUPO_ALFA))[0].texto, /Não foi possível notificar o entregador/);
  const [ev] = (await s.eventos()).filter((e) => e.destino === "ENTREGADOR");
  assert.equal(ev.estado, "FALHOU");
  const re = await s.mova.pagamentos.reenviar({ organizacaoId: ORG, unidadeId: ALFA, eventoId: ev.id, por: ADM });
  assert.equal(re.ok, true);
  assert.equal((await s.saida(MAURICIO)).length, 2);
  assert.equal((await s.saida(MAURICIO))[0].texto, (await s.saida(MAURICIO))[1].texto, "reenvio repete exatamente o mesmo conteúdo persistido");
  assert.equal((await s.mova.pagamentos.reenviar({ organizacaoId: ORG, unidadeId: ALFA, eventoId: ev.id, por: ADM })).motivo, "NAO_ELEGIVEL", "já está na fila: não duplica");
  await s.marcar(MAURICIO, "ENVIADA");
  await s.passada();
  assert.match((await s.saida(GRUPO_ALFA)).map((x) => x.texto).join("\n"), /Reenvio concluído/);
  assert.equal((await s.mova.pagamentos.reenviar({ organizacaoId: ORG, unidadeId: ALFA, eventoId: ev.id, por: ADM })).motivo, "JA_ENVIADA");
  // outra unidade/organização não alcança o evento
  assert.equal((await s.mova.pagamentos.reenviar({ organizacaoId: ORG, unidadeId: BETA, eventoId: ev.id, por: ADM })).motivo, "NAO_ENCONTRADA");
  // no máximo 3 reenvios forçados
  const ids = [];
  for (let i = 0; i < 3; i += 1) { const x = await s.mova.pagamentos.reenviar({ organizacaoId: ORG, unidadeId: ALFA, eventoId: ev.id, por: ADM, forcar: true }); ids.push(x.ok ? "ok" : x.motivo); await s.marcar(MAURICIO, "ENVIADA"); await s.passada(); }
  assert.deepEqual(ids, ["ok", "ok", "LIMITE_DE_REENVIOS"]);
});

t("PG8 reinicialização durante o processamento: nova instância sobre o mesmo banco continua sem duplicar; mensagem enfileirada antes da queda não é reenfileirada", async () => {
  const s = await cenario();
  await ativar(s);
  const o = await s.liberar(ALFA, SEG, "mauricio", "Mauricio Sintetico", 1500);
  await s.pagar(ALFA, o, 1500);
  await s.passada();
  assert.equal((await s.saida(MAURICIO)).length, 1);
  s.reiniciar(); // processo novo, mesmo banco
  await s.passada();
  await s.marcar(MAURICIO, "ENVIADA");
  s.reiniciar();
  await s.passada();
  s.reiniciar();
  await s.passada();
  assert.equal((await s.saida(MAURICIO)).length, 1);
  assert.equal((await s.saida(GRUPO_ALFA)).length, 1);
  // queda entre criar o evento do entregador e criar o aviso do grupo: a passada seguinte completa, sem duplicar
  const o2 = await s.liberar(ALFA, SEG, "rafael", "Rafael Sintetico", 900);
  await s.pagar(ALFA, o2, 900);
  const evento = (await s.mova.pagamentos.passada(), (await s.eventos()).find((e) => e.entregador === "rafael" && e.destino === "ENTREGADOR"));
  await s.banco.pool.query("delete from mova.notificacao_pagamento where evento_pai_id = $1", [evento.id]);
  s.reiniciar();
  await s.passada();
  await s.marcar(RAFAEL, "ENVIADA");
  await s.passada();
  assert.equal((await s.saida(RAFAEL)).length, 1);
  assert.equal((await s.saida(GRUPO_ALFA)).filter((x) => /Rafael/.test(x.texto)).length, 1);
});

t("PG9 entregador sem telefone cadastrado: nada é enviado a ele e o grupo é avisado para tratar por outro canal; cadastrado depois, o reenvio funciona", async () => {
  const s = await cenario();
  await ativar(s);
  const o = await s.liberar(ALFA, SEG, "zeca", "Zeca Sintetico", 400);
  await s.pagar(ALFA, o, 400);
  const r = await s.passada();
  assert.equal(r.criadas, 1);
  assert.deepEqual(await s.saida(SEM_FONE), []);
  const grupo = await s.saida(GRUPO_ALFA);
  assert.equal(grupo.length, 1);
  assert.match(grupo[0].texto, /Entregador sem telefone cadastrado/);
  assert.match(grupo[0].texto, /Zeca Sintetico/);
  const [ev] = (await s.eventos()).filter((e) => e.destino === "ENTREGADOR");
  assert.equal(ev.estado, "SEM_TELEFONE");
  assert.equal((await s.mova.pagamentos.reenviar({ organizacaoId: ORG, unidadeId: ALFA, eventoId: ev.id, por: ADM })).motivo, "SEM_TELEFONE");
});

t("PG10 entregador nas DUAS empresas: comunicações distintas, cada uma com a sua empresa, o seu valor e o seu grupo; Açaí nunca vê a Subway", async () => {
  const s = await cenario();
  await ativar(s, ALFA);
  await ativar(s, BETA);
  const oa = await s.liberar(ALFA, SEG, "mauricio", "Mauricio Sintetico", 1500);
  const ob = await s.liberar(BETA, SEG, "mauricio", "Mauricio Sintetico", 500);
  await s.pagar(ALFA, oa, 1500);
  await s.pagar(BETA, ob, 500);
  await s.passada();
  const msgs = (await s.saida(MAURICIO)).map((x) => x.texto);
  assert.equal(msgs.length, 2);
  const alfa = msgs.find((x) => /Acai Alfa/.test(x)), beta = msgs.find((x) => /Subway Beta/.test(x));
  assert.match(alfa, /Valor pago: R\$ 15,00/);
  assert.doesNotMatch(alfa, /Subway|Valor pago: R\$ 5,00/);
  assert.match(beta, /Valor pago: R\$ 5,00/);
  assert.doesNotMatch(beta, /Acai|15,00/);
  await s.marcar(MAURICIO, "ENVIADA");
  await s.passada();
  const ga = (await s.saida(GRUPO_ALFA)).map((x) => x.texto).join("\n"), gb = (await s.saida(GRUPO_BETA)).map((x) => x.texto).join("\n");
  assert.match(ga, /Acai Alfa/);
  assert.doesNotMatch(ga, /Subway|Beta/);
  assert.match(gb, /Subway Beta Sintetico/);
  assert.doesNotMatch(gb, /Acai|Alfa/);
  assert.equal((await s.eventos(ALFA)).length, 2);
  assert.equal((await s.eventos(BETA)).length, 2);
});

t("PG11 automação pausada não envia; religar NÃO dispara o que foi pago durante a pausa (o marco acompanha o tempo)", async () => {
  const s = await cenario();
  await ativar(s);
  await s.mova.armazenamento.automacoes.pausar({ nome: AUTOMACAO_PAGAMENTO, unidadeId: ALFA, por: ADM, motivo: "conferência" });
  const o = await s.liberar(ALFA, SEG, "mauricio", "Mauricio Sintetico", 1500);
  await s.pagar(ALFA, o, 1500);
  s.estado.agora = "2026-11-18T15:03:00.000Z";
  assert.equal(await s.passada(), null);
  s.estado.agora = "2026-11-18T15:04:00.000Z";
  await s.mova.armazenamento.automacoes.retomar({ nome: AUTOMACAO_PAGAMENTO, unidadeId: ALFA });
  s.estado.agora = "2026-11-18T15:05:00.000Z";
  const r = await s.passada();
  assert.equal(r.criadas, 0);
  assert.deepEqual(await s.saida(), []);
});
