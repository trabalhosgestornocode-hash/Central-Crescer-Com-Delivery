// 26/11 — AVISO DIÁRIO de contas a pagar no grupo (10h e 15h, America/Fortaleza). Financeiro v2 REAL em memória, banco do MOVA no
// PostgreSQL local isolado (migração 0025: mova.aviso_diario), sem IA. Nada sai para o WhatsApp: a mensagem fica na fila de saída.
// Dados SINTÉTICOS (Loja Alfa = papel do Açaí, Loja Beta = papel da Subway).
import assert from "node:assert/strict";
import { ALFA, BETA, CONFIG, FIN, GRUPO, OPER, ORG, cenario, t } from "./helpers/operacao.js";
import { agoraLocal, normalizarJanelas } from "../../src/modules/mova-financeiro/aplicacao/avisosDiarios.js";

const SOCIO = "5500000000211@s.whatsapp.net";
const CONFIG_GRUPO = { ...CONFIG, gruposAutorizados: CONFIG.gruposAutorizados.map((g) => (g.grupoId === GRUPO ? { ...g, politicaResposta: "GRUPO_FINANCEIRO",
  participantes: [{ ids: [FIN], perfil: "FINANCEIRO" }, { ids: [SOCIO], perfil: "FINANCEIRO" }, { ids: [OPER], perfil: "OPERACIONAL" }] } : g)) };
// Fortaleza = UTC−3: 10h local = 13h UTC
const em = (hhmm, dia = "2026-10-15") => new Date(`${dia}T${String(Number(hhmm.slice(0, 2)) + 3).padStart(2, "0")}:${hhmm.slice(3)}:00.000Z`);

async function cena({ membros = [FIN, SOCIO], indisponivel = null, janelas, atualizarMembros, competenciaInicial } = {}) {
  const relogio = { agora: em("09:00") };
  const s = await cenario({
    config: CONFIG_GRUPO,
    extras: ({ nucleo }) => ({
      relogio: () => relogio.agora,
      avisosDiarios: { grupos: [GRUPO], ...(janelas ? { janelas } : {}), ...(competenciaInicial ? { competenciaInicial } : {}), ...(atualizarMembros ? { atualizarMembros: (g) => atualizarMembros(g, relogio.agora) } : {}) },
      // Financeiro fora do ar numa unidade: erro técnico (não de regra) ⇒ a porta traduz em FINANCEIRO_INDISPONIVEL
      nucleo: Object.fromEntries(Object.entries(nucleo).map(([k, f]) => [k, async (cx, ...a) => {
        if (indisponivel?.ativo && cx?.unidadeId === indisponivel.unidadeId) throw Object.assign(new Error("conexão recusada"), { code: "ECONNREFUSED" });
        return f(cx, ...a);
      }])),
    }),
  });
  const passo = async (hhmm, dia) => {
    relogio.agora = em(hhmm, dia);
    await s.mova.armazenamento.membros.registrar({ grupoId: GRUPO, membros, verificadoEm: relogio.agora.toISOString() }); // retrato recente
    return s.mova.avisos.passo();
  };
  /** 27/11: passo SEM mensagem recebida antes (o Gateway não mandou retrato novo): o retrato gravado é o da última conversa */
  const passoSemConversa = async (hhmm, dia) => { relogio.agora = em(hhmm, dia); return s.mova.avisos.passo(); };
  const textos = async () => (await s.saida()).filter((r) => r.destino === GRUPO).map((r) => r.texto);
  const avisos = async () => (await s.banco.pool.query("select to_char(data, 'YYYY-MM-DD') data, janela, situacao, resumo, resposta_id from mova.aviso_diario order by criado_em")).rows;
  const cxA = s.c(ORG, ALFA); const cxB = s.c(ORG, BETA);
  const fornB = await s.m.nucleo.registrarContraparte(cxB, { tipo: "FORNECEDOR", nome: "Distribuidora Beta Sintética" });
  const bancoA = await s.m.nucleo.configurarContaFinanceira(cxA, { tipo: "BANCARIA", nome: "Banco Alfa", instituicao: "Banco Teste" });
  const pagar = (o, data = "2026-10-15") => s.m.nucleo.pagarContaAPagar(cxA, { obrigacaoId: o.id, contaId: bancoA.id, dataEfetiva: data, valorCentavos: o.saldoCentavos });
  return { ...s, relogio, passo, passoSemConversa, textos, avisos, cxA, cxB, fornB, pagar };
}

t("AD-0 regra pura: hora local de Fortaleza (virada do dia em UTC), janelas configuráveis e validadas", () => {
  assert.deepEqual(agoraLocal(new Date("2026-10-16T02:30:00Z")), { data: "2026-10-15", minutos: 23 * 60 + 30 }, "23h30 em Fortaleza ainda é o dia 15");
  assert.deepEqual(normalizarJanelas(["15:00", "10:00", "10:00", "25:00", "x"]), ["10:00", "15:00"]);
  assert.deepEqual(normalizarJanelas([]), ["10:00", "15:00"], "padrão");
  assert.deepEqual(normalizarJanelas(["09:30", "16:00"]), ["09:30", "16:00"]);
});

t("AD-1 10h: só depois do horário; contas de HOJE por unidade (fornecedor, descrição, saldo, totais) e as vencidas em seção própria; nunca duplica (nem após reinício)", async () => {
  const s = await cena();
  const hoje = (await s.conta("2026-10-15", 19450)).obrigacoes[0];
  await s.conta("2026-10-10", 5000); // vencida em aberto
  await s.conta("2026-10-20", 7000); // futura: não entra
  void hoje;
  assert.deepEqual(await s.passo("09:59"), [], "antes das 10h nada sai");
  const [r] = await s.passo("10:05");
  assert.equal(r.enviado, true);
  const [texto] = await s.textos();
  assert.match(texto, /Contas a pagar — hoje, 15\/10\/2026/);
  assert.match(texto, /\*Loja Alfa\*\n• Fornecedor Sintético — Compra sintética — R\$ 194,50\nTotal: R\$ 194,50 \(1 conta\)/);
  assert.match(texto, /\*Loja Beta\*\nNenhuma conta vence hoje\./);
  assert.match(texto, /Vencidas em aberto[\s\S]*venceu 10\/10 — R\$ 50,00/);
  assert.doesNotMatch(texto, /R\$ 70,00/, "conta futura não entra");
  // repetir o passo e REINICIAR o processo (MOVA novo sobre o mesmo banco) não duplica
  await s.passo("10:10");
  s.reiniciar();
  await s.passo("10:15");
  assert.equal((await s.textos()).length, 1);
  const [a] = await s.avisos();
  assert.deepEqual([a.data, a.janela, a.situacao, a.resumo.porUnidade[ALFA].hoje, a.resumo.porUnidade[ALFA].hojeCentavos, a.resumo.valores], ["2026-10-15", "10:00", "ENVIADO", 1, 19450, true]);
  assert.ok(a.resposta_id, "a linha aponta a mensagem da fila (mesma transação)");
  assert.equal(JSON.stringify(a.resumo).includes("Fornecedor"), false, "o resumo guarda só contagens (nada de texto livre)");
});

t("AD-2 15h: consulta NOVA — a conta paga depois das 10h some; só o que AINDA está em aberto sai; tudo pago ⇒ confirmação baseada no Financeiro", async () => {
  const s = await cena();
  const a1 = (await s.conta("2026-10-15", 19450)).obrigacoes[0];
  const a2 = (await s.conta("2026-10-15", 26000)).obrigacoes[0];
  await s.passo("10:00");
  assert.match((await s.textos())[0], /Total: R\$ 454,50 \(2 contas\)/);
  await s.pagar(a1);
  await s.passo("15:01");
  const t15 = (await s.textos())[1];
  assert.match(t15, /Contas de hoje ainda em aberto — 15h/);
  assert.match(t15, /R\$ 260,00/);
  assert.doesNotMatch(t15, /R\$ 194,50/, "a paga não aparece às 15h");
  void a2;
});

t("AD-2b todas as contas de hoje pagas entre 10h e 15h ⇒ às 15h a confirmação vem do Financeiro (não de suposição)", async () => {
  const s = await cena();
  const a1 = (await s.conta("2026-10-15", 19450)).obrigacoes[0];
  const a2 = (await s.conta("2026-10-15", 26000)).obrigacoes[0];
  await s.passo("10:00");
  await s.pagar(a1); await s.pagar(a2);
  await s.passo("15:00");
  const textos = await s.textos();
  assert.equal(textos.length, 2);
  assert.match(textos[1], /✅ \*Contas de hoje \(15\/10\/2026\)\*: todas as que venciam hoje constam como pagas no Financeiro\./);
});

t("AD-3 15h sem nenhuma conta no dia: nada é enviado (sem ruído), mas a janela fica registrada e não reconsulta", async () => {
  const s = await cena();
  await s.passo("10:00");
  assert.match((await s.textos())[0], /Nenhuma conta vence hoje/);
  await s.passo("15:00");
  assert.equal((await s.textos()).length, 1);
  assert.deepEqual((await s.avisos()).map((a) => [a.janela, a.situacao]), [["10:00", "ENVIADO"], ["15:00", "SEM_MENSAGEM"]]);
});

t("AD-4 Financeiro INDISPONÍVEL numa unidade: espera e tenta de novo; depois avisa a indisponibilidade dela (nunca 'nenhuma conta'); a outra unidade sai normal", async () => {
  const indisponivel = { ativo: true, unidadeId: BETA };
  const s = await cena({ indisponivel });
  await s.conta("2026-10-15", 19450);
  const r1 = await s.passo("10:00");
  assert.deepEqual([r1[0]?.adiado, (await s.textos()).length], ["FINANCEIRO_INDISPONIVEL", 0], "nos primeiros 30 min, espera");
  await s.passo("10:35");
  const [texto] = await s.textos();
  assert.match(texto, /\*Loja Beta\*\n⚠️ Financeiro indisponível agora — não consegui conferir/);
  assert.doesNotMatch(texto, /Loja Beta\*\nNenhuma conta/);
  assert.match(texto, /\*Loja Alfa\*\n• Fornecedor Sintético/);
  // 15h com a Beta ainda fora e a Alfa paga: NÃO afirma que tudo foi pago
  const [conta] = (await s.m.nucleo.consultarRegistros(s.cxA, { tipo: "OBRIGACAO" }));
  await s.pagar(conta);
  await s.passo("15:40");
  const t15 = (await s.textos()).at(-1);
  assert.doesNotMatch(t15, /constam como pagas/);
  assert.match(t15, /Não dá para afirmar que tudo foi pago|Financeiro indisponível/);
});

t("AD-5 permissão dos destinatários: membro NÃO financeiro no retrato ⇒ aviso SEM valores nem fornecedores (só contagens), motivo no resumo", async () => {
  const s = await cena({ membros: [FIN, SOCIO, OPER] });
  await s.conta("2026-10-15", 19450);
  await s.passo("10:00");
  const [texto] = await s.textos();
  assert.doesNotMatch(texto, /R\$|Fornecedor Sintético/);
  assert.match(texto, /1 conta vence hoje/);
  assert.match(texto, /Valores e fornecedores: no Centro Financeiro/);
  const [a] = await s.avisos();
  assert.deepEqual([a.resumo.valores, a.resumo.motivoDetalhe], [false, "MEMBRO_SEM_AUTORIZACAO"]);
});

t("AD-6 contas ENTRE EMPRESAS em seção própria: devedora → credora, saldo, vencimento registrado (nunca inventado), cada vínculo uma vez", async () => {
  const s = await cena();
  const ob = (await s.m.nucleo.registrarObrigacao(s.cxB, { contraparteId: s.fornB.id, valorOriginalCentavos: 649560, categoria: "INSUMOS", descricao: "Distribuidora (sintético)",
    competencia: "2026-10", dataEmissao: "2026-10-05", vencimento: "2026-10-10" })).obrigacoes[0];
  // a Alfa pagou pela Beta ⇒ a Beta deve à Alfa (reembolso vence hoje)
  await s.m.nucleo.registrarPagamentoPorOutraEmpresa(s.cxB, s.cxA, { obrigacaoId: ob.id, valorCentavos: 649560, dataPagamento: "2026-10-10", descricao: "Distribuidora paga pela Alfa",
    vencimentoReembolso: "2026-10-15", nomeDevedora: "Loja Beta", nomeCredora: "Loja Alfa", chave: "MOVA:ad-6" });
  await s.passo("10:00");
  const [texto] = await s.textos();
  assert.match(texto, /Contas entre empresas \(reembolso — não é despesa nem receita\)/);
  assert.match(texto, /• Loja Beta deve à Loja Alfa — Distribuidora paga pela Alfa — saldo R\$ 6\.495,60 \(vence 15\/10\)/);
  assert.equal((texto.match(/deve à/g) ?? []).length, 1, "um vínculo = uma linha (não repete pelo lado credor)");
  assert.doesNotMatch(texto, /Vencidas em aberto/, "a conta do fornecedor foi liquidada pela outra empresa: não aparece como vencida");
});

// ------------------------------------------------------------------ 27/11 (PR #236): retrato dos membros VELHO numa manhã sem conversa
const retratoDe9h = async (s, membros = [FIN, SOCIO]) => s.mova.armazenamento.membros.registrar({ grupoId: GRUPO, membros, verificadoEm: em("09:00").toISOString() });

t("AD-7 retrato de 1h atrás e nenhuma conversa: o MOVA pede retrato NOVO ao Gateway antes das 10h; todos FINANCEIRO ⇒ aviso COM valores; o novo fica gravado", async () => {
  const pedidos = [];
  const s = await cena({ atualizarMembros: async (g, agora) => { pedidos.push(g); return { membros: [FIN, SOCIO], verificadoEm: agora.toISOString() }; } });
  await retratoDe9h(s);
  await s.conta("2026-10-15", 19450);
  await s.passoSemConversa("10:00");
  assert.deepEqual(pedidos, [GRUPO], "um pedido, só para o grupo do aviso");
  const [texto] = await s.textos();
  assert.match(texto, /R\$\s?194,50/);
  const [a] = await s.avisos();
  assert.equal(a.resumo.valores, true);
  const r = await s.mova.armazenamento.membros.obter(GRUPO);
  assert.equal(new Date(r.verificadoEm).toISOString(), em("10:00").toISOString(), "retrato do Gateway gravado");
});

t("AD-8 a proteção dos membros continua: retrato NOVO com alguém não FINANCEIRO ⇒ sem valores; Gateway fora (ou retrato vazio) ⇒ sem valores, mas o aviso sai com as contagens", async () => {
  const comOper = await cena({ atualizarMembros: async (g, agora) => ({ membros: [FIN, SOCIO, OPER], verificadoEm: agora.toISOString() }) });
  await retratoDe9h(comOper);
  await comOper.conta("2026-10-15", 19450);
  await comOper.passoSemConversa("10:00");
  assert.doesNotMatch((await comOper.textos())[0], /R\$/);
  assert.equal((await comOper.avisos())[0].resumo.motivoDetalhe, "MEMBRO_SEM_AUTORIZACAO");
  for (const atualizarMembros of [async () => { throw Object.assign(new Error("fora"), { codigo: "GATEWAY_INDISPONIVEL" }); }, async () => ({ membros: [], verificadoEm: new Date().toISOString() }), null]) {
    const s = await cena(atualizarMembros ? { atualizarMembros } : {});
    await retratoDe9h(s);
    await s.conta("2026-10-15", 19450);
    await s.passoSemConversa("10:00");
    const [texto] = await s.textos();
    assert.match(texto, /1 conta vence hoje/, "o aviso sai mesmo assim");
    assert.doesNotMatch(texto, /R\$|Fornecedor Sintético/, "retrato velho nunca libera valores");
    assert.equal((await s.avisos())[0].resumo.valores, false);
  }
});

t("AD-9 retrato recente (menos de 5 min): nenhum pedido ao Gateway", async () => {
  let pedidos = 0;
  const s = await cena({ atualizarMembros: async (g, agora) => { pedidos++; return { membros: [FIN, SOCIO], verificadoEm: agora.toISOString() }; } });
  await s.conta("2026-10-15", 19450);
  await s.passo("10:00"); // registra o retrato no próprio minuto
  assert.equal(pedidos, 0);
  assert.match((await s.textos())[0], /R\$\s?194,50/);
});

t("AD-10 competência inicial (pedido do proprietário, 28/11): contas de competência ANTERIOR (setembro) não entram no aviso — nem vencidas nem de hoje; as demais saem normalmente", async () => {
  const s = await cena({ competenciaInicial: "2026-10" });
  const setembro = (vencimento, valor) => s.m.nucleo.registrarObrigacao(s.cxA, { contraparteId: s.forn.id, valorOriginalCentavos: valor, categoria: "INSUMOS",
    descricao: "Conta importada de setembro", competencia: "2026-09", dataEmissao: "2026-09-01", vencimento });
  await setembro("2026-09-20", 33300); // vencida, competência 09
  await setembro("2026-10-15", 44400); // vence hoje, competência 09
  await s.conta("2026-10-10", 5000); // vencida, competência 10: entra
  await s.conta("2026-10-15", 19450); // hoje, competência 10: entra
  const [r] = await s.passo("10:05");
  assert.equal(r.enviado, true);
  const [texto] = await s.textos();
  assert.match(texto, /venceu 10\/10 — R\$ 50,00/);
  assert.match(texto, /Compra sintética — R\$ 194,50/);
  assert.doesNotMatch(texto, /importada de setembro|R\$ 333,00|R\$ 444,00/, "competência anterior não aparece");
  const [a] = await s.avisos();
  assert.deepEqual([a.resumo.porUnidade[ALFA].hoje, a.resumo.porUnidade[ALFA].vencidas], [1, 1]);
  // continuam no Contas a Pagar oficial: só o aviso as ignora
  const cap = await s.m.nucleo.consultarContasAPagar(s.cxA, { competencia: "2026-09" });
  assert.equal(cap.itens.length, 2);
});

t("AD-10b sem a configuração (ou inválida) nada muda: a conta de setembro aparece como antes", async () => {
  const s = await cena({ competenciaInicial: "setembro" });
  await s.m.nucleo.registrarObrigacao(s.cxA, { contraparteId: s.forn.id, valorOriginalCentavos: 33300, categoria: "INSUMOS",
    descricao: "Conta importada de setembro", competencia: "2026-09", dataEmissao: "2026-09-01", vencimento: "2026-09-20" });
  await s.passo("10:05");
  assert.match((await s.textos())[0], /importada de setembro[\s\S]*R\$ 333,00/);
});
