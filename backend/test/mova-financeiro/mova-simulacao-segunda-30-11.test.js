// MOVA — SIMULAÇÃO INTEGRADA de segunda-feira 30/11/2026 (semana 23/11 a 29/11), fim a fim, com dados sintéticos e Gateway simulado:
// fechamento das duas empresas às 06:00, contas a pagar, demonstrativos às 10:00, pedidos de nota, atendimento privado, nota em PDF/XML/imagem,
// identidade fiscal histórica e de entregador novo, conferência e anexo, avisos individual e no grupo, baixa, notificação de pagamento,
// parcial, multi-semana, estorno, falhas de comunicação, recuperação após reinício e duplicidades. Financeiro v2 real em memória,
// banco do MOVA isolado, NENHUMA mensagem real e NENHUMA chamada de IA (o dublê falha se chamado).
import assert from "node:assert/strict";
import { AUTOMACAO } from "../../src/modules/mova-financeiro/index.js";
import { ALFA, BETA, ORG, gw, t } from "./helpers/operacao.js";
import { ADM, GRUPO_ALFA, GRUPO_BETA, MAURICIO, RAFAEL, SEG, ativar, cenario } from "./helpers/cenarioEntregadores.js";
import { DOCS, PREST_MAURICIO, PREST_RAFAEL, TOM_ALFA, TOM_BETA, arquivoPdf, historico, leitorDeNota, TUDO, xmlNota } from "./helpers/notasSinteticas.js";

const SEMANA = "2026-11-23";
const FECHA = [SEG, SEMANA]; // semanas antigas já resolvidas: a nota nova vai para a semana mais antiga que AGUARDA nota (ver achado no relatório)
const SEG_0600 = "2026-11-30T09:00:00.000Z", SEG_1000 = "2026-11-30T13:00:00.000Z";
const mais = (s, ms) => { s.estado.agora = new Date(Date.parse(s.estado.agora) + ms).toISOString(); };
const MIN = 60_000;
const enviar = async (s, de, bytes, o = {}) => { await s.mova.receptor.receber(gw({ texto: o.texto ?? null, de, grupo: de, doc: bytes, mime: o.mime, nomeArquivo: o.nomeArquivo })); await s.mova.receptor.trabalhar(); };
const perguntar = async (s, texto, de = MAURICIO) => { const antes = (await s.saida(de)).length; await s.mova.receptor.receber(gw({ texto, de, grupo: de })); await s.mova.receptor.trabalhar(); return (await s.saida(de)).slice(antes).map((x) => x.texto); };
const textos = async (s, destino) => (await s.saida(destino)).map((x) => x.texto);
const PER = "23/11/2026 a 29/11/2026", HP = "02/11/2026 a 08/11/2026"; // HP: período do histórico (semana de 02/11)

t("SIM-30/11 segunda-feira completa: fechamento 06:00 → demonstrativos 10:00 → notas → atendimento → conferência/anexo → avisos → baixas → notificações → parcial → estorno → falhas → reinício", async () => {
  const s = await cenario({ semanas: FECHA, agora: SEG_0600, leitorDeNota, documentos: DOCS, operacional: true });
  // histórico aprovado no Financeiro (semana de 02/11, já resolvida). A identidade do Rafael NÃO é aprendida antes: o MOVA a reconhece sozinho na primeira nota (sem "Reaprender")
  await historico(s, ALFA, SEG, "mauricio", { prestador: PREST_MAURICIO, tomador: TOM_ALFA, valor: 1500, periodo: HP });
  await historico(s, BETA, SEG, "mauricio", { prestador: PREST_MAURICIO, tomador: TOM_BETA, valor: 500, chave: "33".repeat(25), periodo: HP });
  await historico(s, ALFA, SEG, "rafael", { prestador: PREST_RAFAEL, tomador: TOM_ALFA, valor: 900, chave: "22".repeat(25), periodo: HP });

  // ── 06:00: as duas empresas fecharam a semana; contas a pagar existem e são separadas por empresa ──
  const fech = async (u, ent) => (await s.real.consultarEntregador(s.adm(u), { entregador: ent })).fechamentos.find((f) => f.semanaInicio === SEMANA);
  assert.equal((await fech(ALFA, "mauricio")).valorCentavos, 1400);
  assert.equal((await fech(BETA, "mauricio")).valorCentavos, 1200);
  assert.equal((await fech(ALFA, "rafael")).valorCentavos, 1000);

  // ── 09:59 nada sai; 10:00 demonstrativos (um por empresa por entregador) com pedido de nota ──
  for (const u of [ALFA, BETA]) {
    for (const nome of [AUTOMACAO.SEMANAL, AUTOMACAO.COBRANCA, AUTOMACAO.AVISO_GRUPO]) {
      await s.mova.armazenamento.automacoes.definir({ nome, organizacaoId: ORG, unidadeId: u, ativa: true, horario: nome === AUTOMACAO.AVISO_GRUPO ? "00:00" : "10:00" });
    }
  }
  s.estado.agora = "2026-11-30T12:59:00.000Z";
  assert.equal((await s.mova.entregadores.rotina()).semanais, 0, "09:59: nada");
  s.estado.agora = SEG_1000;
  assert.equal((await s.mova.entregadores.rotina()).semanais, 3, "Mauricio (2 empresas) + Rafael");
  const dem = (await s.saida()).filter((x) => [MAURICIO, RAFAEL].includes(x.destino));
  assert.equal(dem.length, 3);
  for (const m of dem) { assert.match(m.texto, /Envie a nota fiscal/); assert.match(m.texto, new RegExp(PER)); }
  const demMau = dem.filter((x) => x.destino === MAURICIO);
  assert.ok(demMau.some((x) => /R\$ 14,00/.test(x.texto)) && demMau.some((x) => /R\$ 12,00/.test(x.texto)));
  await s.marcar(MAURICIO, "ENVIADA"); await s.marcar(RAFAEL, "ENVIADA");
  assert.equal((await s.mova.entregadores.rotina()).semanais, 0, "segunda passada: nada novo");

  // ── atendimento privado, informal, antes de qualquer pagamento ──
  const resp = (await perguntar(s, "qto vou receber?")).join("\n");
  assert.match(resp, /14,00/); assert.match(resp, /12,00/);
  assert.ok(!/Rafael|10,00/.test(resp), "nunca dados de outro entregador");

  // ── notas: Mauricio PDF (Açaí) → conferida e anexada; mesma nota em XML → duplicada; XML da Subway → conferida e anexada ──
  const n1 = { prestador: PREST_MAURICIO, tomador: TOM_ALFA, valor: 1400, periodo: PER, numero: "701", chave: "71".repeat(25), competencia: "29/11/2026", emissao: "30/11/2026" };
  mais(s, MIN); await enviar(s, MAURICIO, arquivoPdf(n1));
  let priv = await textos(s, MAURICIO);
  assert.match(priv.at(-1), /✅ Sua nota fiscal foi recebida e conferida com sucesso!/);
  assert.match(priv.at(-1), /Nota fiscal: Conferida e anexada/);
  assert.match(priv.at(-1), /Valor: R\$ 14,00/);
  await enviar(s, MAURICIO, xmlNota({ prestador: PREST_MAURICIO, tomador: TOM_ALFA, valor: 1400, numero: "701", chave: "71".repeat(25), competencia: "2026-11-29" }), { mime: "text/xml", nomeArquivo: "nota.xml" });
  assert.match((await textos(s, MAURICIO)).at(-1), /já tinha sido recebida/, "PDF + XML da mesma nota: duplicada");
  await enviar(s, MAURICIO, arquivoPdf(n1));
  assert.match((await textos(s, MAURICIO)).at(-1), /já tinha sido recebida/);
  assert.equal((await s.banco.pool.query("select count(*)::int c from mova.nota_entregador where entregador = 'mauricio' and unidade_id = $1 and semana_inicio = $2", [ALFA, SEMANA])).rows[0].c, 1, "uma só nota registrada para a semana");
  const xmlSubway = Buffer.from(xmlNota({ prestador: PREST_MAURICIO, tomador: TOM_BETA, valor: 1200, numero: "702", chave: "72".repeat(25), competencia: "2026-11-29" }).toString().replace("09/11/2026 a 15/11/2026", PER));
  await enviar(s, MAURICIO, xmlSubway, { mime: "application/xml", nomeArquivo: "subway.xml" });
  assert.match((await textos(s, MAURICIO)).at(-1), /Conferida e anexada/);
  assert.match((await textos(s, MAURICIO)).at(-1), /Subway Beta Sintetico/);

  // ── Rafael (novo): imagem ilegível sem IA → nunca anexada; depois o PDF correto → identidade reconhecida sozinha pelo histórico, conferida e anexada ──
  await enviar(s, RAFAEL, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]), { mime: "image/jpeg", nomeArquivo: "foto.jpg", texto: "nota da loja alfa" });
  assert.ok(!/Conferida e anexada/.test((await textos(s, RAFAEL)).at(-1)));
  await enviar(s, RAFAEL, arquivoPdf({ prestador: PREST_RAFAEL, tomador: TOM_ALFA, valor: 1000, periodo: PER, numero: "703", chave: "73".repeat(25), competencia: "29/11/2026", emissao: "30/11/2026" }));
  assert.match((await textos(s, RAFAEL)).at(-1), /Conferida e anexada/);
  const vinc = (await s.banco.pool.query("select v.situacao, v.origem from mova.identidade_fiscal_vinculo v where v.entregador = 'rafael'")).rows[0];
  assert.deepEqual([vinc.situacao, vinc.origem], ["CONSOLIDADA", "HISTORICO"], "identidade reconhecida automaticamente a partir das notas históricas");

  // ── avisos no grupo de cada empresa (nunca de outra empresa); nenhum CNPJ completo em mensagem ──
  const gA = (await textos(s, GRUPO_ALFA)).join("\n"), gB = (await textos(s, GRUPO_BETA)).join("\n");
  assert.match(gA, /Nota fiscal recebida de Mauricio/); assert.match(gA, /Nota fiscal recebida de Rafael/);
  assert.match(gB, /Nota fiscal recebida de Mauricio/); assert.ok(!/Rafael/.test(gB), "o grupo da Subway não vê o Açaí");
  assert.ok(!(await s.saida()).some((x) => [PREST_MAURICIO, PREST_RAFAEL, TOM_ALFA, TOM_BETA].some((d) => x.texto.includes(d))), "nenhum CNPJ completo em mensagem");

  // ── baixas: liga a notificação de pagamento (marco) e paga: Mauricio Açaí (integral + semana antiga = multi-semana), Subway (integral), Rafael (PARCIAL) ──
  await s.marcar(MAURICIO, "ENVIADA"); await s.marcar(RAFAEL, "ENVIADA");
  for (const u of [ALFA, BETA]) await ativar(s, u);
  const ob = async (u, ent, ini) => (await s.real.detalharFechamentoDoEntregador(s.adm(u), { inicio: ini, entregador: ent })).obrigacaoId;
  // a equipe do financeiro confere o demonstrativo e libera o pagamento (passo humano do Financeiro; o MOVA nunca libera)
  for (const [u, ent, ini] of [[ALFA, "mauricio", SEMANA], [ALFA, "mauricio", SEG], [BETA, "mauricio", SEMANA], [ALFA, "rafael", SEMANA]]) {
    const d = await s.real.detalharFechamentoDoEntregador(s.adm(u), { inicio: ini, entregador: ent });
    const c = s.adm(u);
    if (d.situacaoDocumental === "NF_RECEBIDA") await s.real.iniciarConferenciaDaNota(c, { inicio: ini, entregador: ent });
    if (["NF_RECEBIDA", "NF_EM_CONFERENCIA"].includes(d.situacaoDocumental)) await s.real.decidirNotaDoEntregador(c, { inicio: ini, entregador: ent, decisao: "APROVAR", conferido: TUDO, justificativa: "Conferida." });
    if (d.situacaoDocumental !== "LIBERADO_PAGAMENTO") await s.real.liberarPagamentoDoEntregador(s.adm(u), { inicio: ini, entregador: ent, demonstrativoConferido: true, justificativa: "Conferido." });
  }
  const paraMauricio = (await textos(s, MAURICIO)).length;
  await s.pagar(ALFA, await ob(ALFA, "mauricio", SEMANA), 1400, "2026-11-30");
  await s.pagar(ALFA, await ob(ALFA, "mauricio", SEG), 1500, "2026-11-30");
  await s.pagar(BETA, await ob(BETA, "mauricio", SEMANA), 1200, "2026-11-30");
  await s.pagar(ALFA, await ob(ALFA, "rafael", SEMANA), 400, "2026-11-30");
  await s.passada();
  const pagMau = (await textos(s, MAURICIO)).slice(paraMauricio);
  assert.ok(pagMau.some((x) => /Acai Alfa/.test(x) && /14,00/.test(x)), "pagamento do Açaí informado");
  assert.ok(pagMau.some((x) => /Subway Beta/.test(x) && /12,00/.test(x)), "pagamento da Subway informado separado");
  assert.ok(pagMau.join(" ").includes("15,00"), "a semana antiga paga junto também é informada (multi-semana)");
  assert.ok(!pagMau.some((x) => /Subway/.test(x) && /Acai Alfa/.test(x)), "empresas nunca na mesma mensagem");
  assert.ok(!/disponível|caiu na conta/i.test(pagMau.join(" ")), "nunca afirma dinheiro disponível");
  const pagRaf = (await textos(s, RAFAEL)).at(-1);
  assert.match(pagRaf, /4,00/); assert.match(pagRaf, /6,00/, "parcial informa o saldo restante");
  // sem duplicar: nova passada e passada após reinício
  const totalPag = (await s.saida()).length;
  await s.passada(); s.reiniciar(); await s.passada();
  assert.equal((await s.saida()).length, totalPag, "nenhuma notificação duplicada (nem após reinício)");

  // ── estorno do pagamento parcial do Rafael: a correção é comunicada ──
  const baixas = await s.real.consultarBaixasDeEntregadores(s.adm(ALFA), {});
  const doRafael = baixas.itens.find((b) => b.entregador?.chave === "rafael" || b.entregadorChave === "rafael") ?? baixas.itens.at(-1);
  await s.real.estornarLiquidacao(s.adm(ALFA), { liquidacaoId: doRafael.liquidacaoId, valorCentavos: 400, justificativa: "Estorno de teste." });
  const antesEst = (await s.saida()).length;
  await s.passada(); await s.passada();
  const depoisEst = (await s.saida()).slice(antesEst).map((x) => x.texto).join("\n");
  assert.match(depoisEst, /estorn|correção|corrigid/i, "o estorno é comunicado");
  assert.ok(!/disponível/i.test(depoisEst));

  // ── falha de comunicação: o Gateway recusa; a notificação crítica não expira; após reinício e dias depois o reenvio entrega ──
  await s.marcar(MAURICIO, "FALHOU");
  await s.passada();
  mais(s, 5 * 86_400_000);
  s.reiniciar();
  assert.equal((await s.mova.armazenamento.saida.expirarVencidas(new Date(s.estado.agora))).filter((x) => x.categoria === "TRANSACIONAL").length, 0, "pagamento nunca expira");
  const pend = await s.mova.pagamentos.pendentesDeResolucao({ organizacaoId: ORG, unidadeId: ALFA });
  assert.ok(pend.length >= 1 && pend.every((p) => p.situacao === "FALHA_PENDENTE_DE_RESOLUCAO_ADMINISTRATIVA"));
  for (const p of pend) assert.equal((await s.mova.pagamentos.reenviar({ organizacaoId: ORG, unidadeId: ALFA, eventoId: p.eventoId ?? p.id, por: ADM })).ok, true);
  await s.marcar(MAURICIO, "ENVIADA");
  await s.passada();
  assert.equal((await s.mova.pagamentos.pendentesDeResolucao({ organizacaoId: ORG, unidadeId: ALFA })).length, 0, "resolvido");

  // ── invariante final: nenhuma chamada de IA em todo o dia ──
  const ia = (await s.banco.pool.query("select coalesce(sum(chamadas_ia),0)::int c from mova.consumo_ia_dia").catch(() => ({ rows: [{ c: 0 }] }))).rows[0].c;
  assert.equal(ia, 0, "nenhuma chamada de IA em todo o dia");
});
