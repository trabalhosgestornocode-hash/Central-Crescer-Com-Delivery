// MOVA — Agente 2: "contas a pagar da semana" DETALHADA (conta, fornecedor, vencimento, saldo, situação) só quando todos os
// leitores são FINANCEIRO; teto de envios persistente com aviso. Tudo SINTÉTICO; comandos sem IA; nada vai ao WhatsApp.
import assert from "node:assert/strict";
import { BETA, CONFIG, CONS, FIN, GRUPO, ORG, cenario, gw, t } from "./helpers/operacao.js";
import { detalharContas } from "../../src/modules/mova-financeiro/aplicacao/ferramentas.js";
import { decidirSaidaNoGrupo } from "../../src/modules/mova-financeiro/dominio/participantes.js";
import { AVISO_TETO, criarEnviadorDeRespostas } from "../../src/modules/mova-financeiro/index.js";
import { AGORA } from "../financeiro-v2/helpers/cenario.js";

const SOCIO = "5500000000211@s.whatsapp.net";
const ESTRANHO = "5500000000299@s.whatsapp.net";
const grupoCom = (participantes, politicaResposta = "GRUPO_FINANCEIRO") => ({ ...CONFIG, gruposAutorizados: CONFIG.gruposAutorizados.map((g) => (g.grupoId === GRUPO ? { ...g, politicaResposta, participantes } : g)) });
const SO_FIN = [{ ids: [FIN], perfil: "FINANCEIRO" }, { ids: [SOCIO], perfil: "FINANCEIRO" }];
const COM_CONSULTA = [...SO_FIN, { ids: [CONS], perfil: "CONSULTA" }];
const retrato = (s, membros) => s.mova.armazenamento.membros.registrar({ grupoId: GRUPO, membros, verificadoEm: AGORA.toISOString() });
const PERGUNTA = "MOVA, contas a pagar da semana da alfa";
const doGrupo = async (s) => (await s.saida()).filter((x) => x.destino === GRUPO);

t("A2-D1 três contas com valores diferentes: lista por vencimento com fornecedor, saldo e situação; total igual à soma", async () => {
  const s = await cenario({ config: grupoCom(SO_FIN) });
  await s.conta("2026-10-17", 30000); await s.conta("2026-10-15", 12345); await s.conta("2026-10-20", 5050);
  await retrato(s, [FIN, SOCIO]);
  await s.enviar(gw({ texto: PERGUNTA }));
  const [r] = await doGrupo(s);
  assert.match(r.texto, /15\/10\/2026 a 21\/10\/2026: 3 contas, total R\$ 473,95/);
  const linhas = r.texto.split("\n").filter((l) => /^• \d\d\/\d\d · /.test(l));
  assert.deepEqual(linhas.map((l) => l.slice(2, 7)), ["15/10", "17/10", "20/10"], "ordem por vencimento");
  assert.match(linhas[0], /Fornecedor Sintético · Compra sintética — R\$ 123,45 \(aberta\)/);
  assert.match(linhas[1], /R\$ 300,00/); assert.match(linhas[2], /R\$ 50,50/);
  assert.match(r.texto, /Posição do Financeiro em/);
  assert.ok(r.texto.length < 4096);
});

t("A2-D2 ausência de contas: sem nenhuma conta ⇒ 'não há dados'; com contas fora da semana ⇒ 'nenhuma conta vencendo' (nunca R$ inventado)", async () => {
  const vazio = await cenario({ config: grupoCom(SO_FIN) });
  await retrato(vazio, [FIN, SOCIO]);
  await vazio.enviar(gw({ texto: PERGUNTA }));
  assert.doesNotMatch((await doGrupo(vazio))[0].texto, /R\$/);
  const fora = await cenario({ config: grupoCom(SO_FIN) });
  await fora.conta("2026-11-30", 99900);
  await retrato(fora, [FIN, SOCIO]);
  await fora.enviar(gw({ texto: PERGUNTA }));
  const tx = (await doGrupo(fora))[0].texto;
  assert.match(tx, /nenhuma conta a pagar vencendo de 15\/10\/2026 a 21\/10\/2026/);
  assert.doesNotMatch(tx, /999,00/);
});

t("A2-D3 membro CONSULTA no grupo (autorizado a ver totais) ⇒ resposta no grupo SÓ agregada, sem fornecedor nem lista", async () => {
  const s = await cenario({ config: grupoCom(COM_CONSULTA) });
  await s.conta("2026-10-17", 30000);
  await retrato(s, [FIN, SOCIO, CONS]);
  await s.enviar(gw({ texto: PERGUNTA }));
  const [r] = await doGrupo(s);
  assert.match(r.texto, /vencendo de 15\/10\/2026 a 21\/10\/2026: 1 contas, R\$ 300,00/);
  assert.doesNotMatch(r.texto, /Fornecedor Sintético/);
});

t("A2-D4 novo membro não autorizado ou retrato vencido ⇒ nada de lista no grupo (valores vão ao privado de quem é FINANCEIRO)", async () => {
  const s = await cenario({ config: grupoCom(SO_FIN) });
  await s.conta("2026-10-17", 30000);
  await retrato(s, [FIN, SOCIO, ESTRANHO]);
  await s.enviar(gw({ texto: PERGUNTA }));
  for (const x of await doGrupo(s)) { assert.doesNotMatch(x.texto, /Fornecedor Sintético/); assert.doesNotMatch(x.texto, /R\$/); }
  const priv = (await s.saida()).filter((x) => x.destino === FIN);
  assert.equal(priv.length, 1);
  assert.match(priv[0].texto, /Fornecedor Sintético/, "no privado de quem é FINANCEIRO a lista é permitida");
  assert.equal((await s.ultima()).politicaResposta, "MEMBRO_SEM_AUTORIZACAO");
  const velho = await cenario({ config: grupoCom(SO_FIN) });
  await velho.conta("2026-10-17", 30000);
  await velho.mova.armazenamento.membros.registrar({ grupoId: GRUPO, membros: [FIN, SOCIO], verificadoEm: new Date(AGORA.getTime() - 16 * 60_000).toISOString() });
  await velho.enviar(gw({ texto: PERGUNTA }));
  for (const x of await doGrupo(velho)) assert.doesNotMatch(x.texto, /Fornecedor Sintético|R\$/);
});

t("A2-D5 participante não autorizado pergunta ⇒ nada é respondido; CONSULTA no privado ⇒ só agregado", async () => {
  const s = await cenario({ config: grupoCom(SO_FIN) });
  await s.conta("2026-10-17", 30000);
  await retrato(s, [FIN, SOCIO, ESTRANHO]);
  const r = await s.enviar(gw({ texto: PERGUNTA, de: ESTRANHO }));
  assert.equal(r.motivo, "PARTICIPANTE_NAO_AUTORIZADO");
  assert.equal((await s.saida()).length, 0);
  const c = await cenario(); // CONFIG padrão: PRIVADO_RESTRITO, CONS tem perfil CONSULTA
  await c.conta("2026-10-17", 30000);
  await c.enviar(gw({ texto: PERGUNTA, de: CONS }));
  for (const x of await c.saida()) assert.doesNotMatch(x.texto, /Fornecedor Sintético/);
});

t("A2-D6 isolamento entre unidades: a lista da Alfa nunca traz conta ou fornecedor da Beta (o mesmo vale para a Subway em produção)", async () => {
  const s = await cenario({ config: grupoCom(SO_FIN) });
  await s.conta("2026-10-17", 30000);
  const outro = await s.m.nucleo.registrarContraparte(s.c(ORG, BETA), { tipo: "FORNECEDOR", nome: "Fornecedor Da Beta" });
  await s.conta("2026-10-18", 77700, BETA, outro);
  await retrato(s, [FIN, SOCIO]);
  await s.enviar(gw({ texto: PERGUNTA }));
  const [r] = await doGrupo(s);
  assert.match(r.texto, /1 conta, total R\$ 300,00/);
  assert.doesNotMatch(r.texto, /Fornecedor Da Beta|777,00/);
});

t("A2-D7 mensagem longa: 80 contas na semana ⇒ lista cortada com 'e mais N' e o restante somado; a mensagem cabe no WhatsApp", async () => {
  const s = await cenario({ config: grupoCom(SO_FIN) });
  for (let i = 0; i < 80; i++) await s.conta(`2026-10-${String(15 + (i % 7)).padStart(2, "0")}`, 1000 + i);
  await retrato(s, [FIN, SOCIO]);
  await s.enviar(gw({ texto: PERGUNTA }));
  const [r] = await doGrupo(s);
  assert.ok(r.texto.length < 4096, `tamanho ${r.texto.length}`);
  const mostradas = r.texto.split("\n").filter((l) => /^• \d\d\/\d\d · /.test(l)).length;
  const m = /… e mais (\d+) contas, R\$ ([\d.,]+)/.exec(r.texto);
  assert.ok(m, "linha 'e mais'");
  assert.equal(mostradas + Number(m[1]), 80);
  const total = 80 * 1000 + (79 * 80) / 2;
  assert.match(r.texto, new RegExp(`80 contas, total R\\$ ${(total / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 }).replace(".", "\\.")}`));
});

t("A2-D8 duplicidade: o mesmo evento reenviado não gera segunda lista", async () => {
  const s = await cenario({ config: grupoCom(SO_FIN) });
  await s.conta("2026-10-17", 30000);
  await retrato(s, [FIN, SOCIO]);
  const p = gw({ texto: PERGUNTA });
  await s.enviar(p);
  assert.equal((await s.enviar({ ...p })).status, "DUPLICADO");
  assert.equal((await doGrupo(s)).length, 1);
});

// ------------------------------------------------------------------ formato (função pura, dados no formato do Financeiro v2)
const titulo = (x) => ({ situacao: "EM_ABERTO", vencido: false, vencimento: "2026-10-16", valorOriginalCentavos: 10000, pagoCentavos: 0, saldoCentavos: 10000, fornecedor: { nome: "Distribuidora X" }, descricao: "Polpa", pendencias: [], ...x });
const fmt = (lista, todas = lista) => detalharContas({ todas, lista, de: "2026-10-15", ate: "2026-10-21" });

t("A2-D9 pagamento parcial: mostra o SALDO pendente (não o valor cheio) e quanto já foi pago; o total soma só saldos", () => {
  const l = fmt([titulo({ situacao: "PARCIALMENTE_PAGO", valorOriginalCentavos: 50000, pagoCentavos: 20000, saldoCentavos: 30000 }), titulo({ vencimento: "2026-10-18" })]);
  assert.match(l[0], /2 contas, total R\$ 400,00/);
  assert.match(l[1], /— R\$ 300,00 \(parcial, pago R\$ 200,00 de R\$ 500,00\)/);
  assert.doesNotMatch(l.join("\n"), /R\$ 500,00 \(/);
});

t("A2-D10 conta vencida (no período e antes dele) e situações do Financeiro: vencida, parcial vencida, aguardando classificação", () => {
  const antes = titulo({ vencimento: "2026-10-01", situacao: "VENCIDO", vencido: true, saldoCentavos: 4500 });
  const l = fmt([titulo({ situacao: "VENCIDO", vencido: true }), titulo({ situacao: "VENCIDO", vencido: true, pagoCentavos: 1000, saldoCentavos: 9000, vencimento: "2026-10-17" }), titulo({ situacao: "AGUARDANDO_CLASSIFICACAO_OU_EVIDENCIA", vencimento: "2026-10-19", pendencias: ["CLASSIFICACAO_PROVISORIA"] })],
    [antes, titulo({ situacao: "VENCIDO", vencido: true })]);
  assert.match(l[1], /\(vencida\)/);
  assert.match(l[2], /\(vencida, parcial, pago R\$ 10,00 de R\$ 100,00\)/);
  assert.match(l[3], /\(aberta, aguardando classificação\)/);
  assert.ok(l.includes("pendências: 1 com classificação provisória"));
  assert.ok(l.includes("também em aberto: 1 conta vencida antes de 15/10/2026, R$ 45,00"));
});

t("A2-D11 dados incompletos: sem fornecedor não se deduz nome; sem saldo não entra no total; sem vencimento é apontado; descrição repetida não duplica", () => {
  const l = fmt([titulo({ fornecedor: null }), titulo({ saldoCentavos: null }), titulo({ fornecedor: { nome: "Polpa" }, descricao: "polpa" }), titulo({ pendencias: ["SEM_DOCUMENTO"] })],
    [titulo({ vencimento: null })]);
  assert.match(l[0], /3 contas, total R\$ 300,00/);
  assert.ok(l.some((x) => /· fornecedor não informado · Polpa —/.test(x)));
  assert.ok(l.some((x) => /^16\/10 · Polpa — R\$ 100,00/.test(x)), "descrição igual ao fornecedor aparece uma vez");
  assert.ok(l.includes("pendências: 1 sem documento anexado; 1 sem saldo informado (fora do total)"));
  assert.ok(l.includes("1 conta em aberto sem vencimento cadastrado"));
});

t("A2-D12 regra pura do detalhe: todos FINANCEIRO ⇒ detalhe; um CONSULTA ⇒ sem detalhe (mas no grupo)", () => {
  const grupo = { grupoId: GRUPO, acesso: "LISTA", politicaResposta: "GRUPO_FINANCEIRO", consultasNoGrupo: [], unidades: ["u1"],
    participantes: [{ ids: [FIN], telefones: [], perfil: "FINANCEIRO", unidades: ["u1"] }, { ids: [CONS], telefones: [], perfil: "CONSULTA", unidades: ["u1"] }] };
  const r = (membros) => decidirSaidaNoGrupo({ grupo, consulta: "CONTAS_VENCENDO", unidades: ["u1"], retrato: { membros, verificadoEm: AGORA.toISOString() }, agora: AGORA });
  assert.deepEqual(r([FIN]), { saida: "GRUPO", motivo: "TODOS_OS_MEMBROS_AUTORIZADOS", detalhe: true });
  assert.deepEqual(r([FIN, CONS]), { saida: "GRUPO", motivo: "TODOS_OS_MEMBROS_AUTORIZADOS", detalhe: false });
});

// ------------------------------------------------------------------ teto de envios (persistente, com aviso e auditoria)
t("A2-D13 teto: contagem PERSISTENTE (enviador novo não zera), aviso nas últimas respostas, aviso final, excedente FALHOU com auditoria", async () => {
  const s = await cenario();
  const max = AVISO_TETO + 2; // 5
  for (let n = 1; n <= max + 2; n++) await s.mova.armazenamento.saida.enfileirar({ grupoId: GRUPO, respostaA: `T${n}`, texto: `r${n}`, eventoId: null });
  const enviados = [];
  const novo = () => criarEnviadorDeRespostas({ armazenamento: s.mova.armazenamento, habilitado: true, naoAntesDe: "2000-01-01T00:00:00Z", destinosPermitidos: [GRUPO], maximoDeEnvios: max, limitePorRodada: 2,
    enviar: async (r) => { enviados.push(r.texto); return { providerMessageId: `P${enviados.length}` }; } });
  await novo().enviarPendentes(); // 2 enviadas
  await novo().enviarPendentes(); // "reinício": continua de 2 (não de 0)
  await novo().enviarPendentes(); // chega a 5
  await novo().enviarPendentes(); // excedentes
  assert.equal(enviados.length, max, "nunca passa do teto, mesmo com enviadores novos");
  assert.equal(enviados[0], "r1", "longe do teto: texto intacto");
  assert.match(enviados[1], /^r2\n\nAviso: restam 3 respostas do MOVA antes do limite configurado\.$/);
  assert.match(enviados[2], /restam 2 respostas/);
  assert.match(enviados[3], /restam 1 resposta do MOVA/);
  assert.match(enviados[4], /⚠️ Limite de respostas do MOVA atingido \(5 de 5\)/);
  const { rows } = await s.banco.pool.query("select estado, ultimo_erro from mova.resposta order by seq");
  assert.deepEqual(rows.slice(max).map((r) => `${r.estado}/${r.ultimo_erro}`), ["FALHOU/TETO_DE_ENVIOS_DA_SESSAO", "FALHOU/TETO_DE_ENVIOS_DA_SESSAO"]);
  const aud = (await s.mova.armazenamento.auditoria.listar()).map((a) => a.acao);
  assert.equal(aud.filter((a) => a === "MOVA_ENVIO_TETO_PROXIMO").length, 1);
  assert.equal(aud.filter((a) => a === "MOVA_ENVIO_TETO_ATINGIDO").length, 1);
  assert.equal(aud.filter((a) => a === "MOVA_ENVIO_BLOQUEADO_PELO_TETO").length, 2);
});

t("A2-D14 falha de envio: erro do Gateway não consome o teto nem duplica; sem teto configurado o texto não muda", async () => {
  const s = await cenario();
  await s.mova.armazenamento.saida.enfileirar({ grupoId: GRUPO, respostaA: "F1", texto: "f1", eventoId: null });
  const e = criarEnviadorDeRespostas({ armazenamento: s.mova.armazenamento, habilitado: true, naoAntesDe: "2000-01-01T00:00:00Z", destinosPermitidos: [GRUPO], maximoDeEnvios: 1,
    enviar: async () => { const x = new Error("x"); x.codigo = "FALHA_NO_GATEWAY"; throw x; } });
  await e.enviarPendentes();
  assert.equal(await s.mova.armazenamento.saida.contarEnviadasDesde("2000-01-01T00:00:00Z"), 0);
  assert.equal((await s.banco.pool.query("select estado from mova.resposta")).rows[0].estado, "FALHOU");
  await s.mova.armazenamento.saida.enfileirar({ grupoId: GRUPO, respostaA: "F2", texto: "f2", eventoId: null });
  const textos = [];
  await criarEnviadorDeRespostas({ armazenamento: s.mova.armazenamento, habilitado: true, naoAntesDe: "2000-01-01T00:00:00Z", destinosPermitidos: [GRUPO],
    enviar: async (r) => { textos.push(r.texto); return { providerMessageId: "X" }; } }).enviarPendentes();
  assert.deepEqual(textos, ["f2"]);
});

t("A2-D15 descrição que repete o fornecedor: o nome sai da descrição (sem parênteses vazios); sem fornecedor, a descrição fica inteira", async () => {
  const { descricaoSemFornecedor } = await import("../../src/modules/mova-financeiro/aplicacao/ferramentas.js");
  assert.equal(descricaoSemFornecedor("MORANGOS (FULANO DE TAL)", "FULANO DE TAL"), "MORANGOS");
  assert.equal(descricaoSemFornecedor("Energia - Distribuidora X", "distribuidora x"), "Energia");
  assert.equal(descricaoSemFornecedor("Distribuidora X", "Distribuidora X"), null);
  assert.equal(descricaoSemFornecedor("Polpa (lote 3)", null), "Polpa (lote 3)");
  assert.equal(descricaoSemFornecedor(null, "X"), null);
});
