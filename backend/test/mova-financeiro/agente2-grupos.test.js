// MOVA — Agente 2, Frente A: GRUPOS REAIS (modo OPERACAO). Tudo SINTÉTICO (ver helpers/operacao.js). Nada é enviado ao WhatsApp.
import assert from "node:assert/strict";
import { ACAO } from "../../src/modules/financeiro-v2/index.js";
import { carregarConfiguracao, instalarConfiguracao, interpretarComando, validarConfiguracao } from "../../src/modules/mova-financeiro/index.js";
import { ALFA, BETA, CONFIG, CONS, DUAS_EMPRESAS, ESTRANHO, FIN, GRUPO, GRUPO_X, LID, LID_PRIVADO, OPER, ORG, ORG_X, SEM_PRIVADO, SO_ALFA, XIS, base, cenario, gw, t } from "./helpers/operacao.js";

t("A2-01 configuração da OPERACAO: só grupos por LISTA, conversas privadas DERIVADAS da lista e nunca entre duas empresas", () => {
  const cfg = validarConfiguracao(CONFIG);
  const privadas = cfg.gruposAutorizados.filter((g) => g.derivada).map((g) => g.grupoId).sort();
  // FIN, LID→privado, OPER, CONS, SO_ALFA: sim. SEM_PRIVADO (só LID): não. DUAS_EMPRESAS (duas organizações): não.
  assert.deepEqual(privadas, [FIN, LID_PRIVADO, OPER, CONS, SO_ALFA].sort());
  assert.deepEqual(cfg.gruposAutorizados.find((g) => g.grupoId === SO_ALFA).unidades, [ALFA]);
  assert.throws(() => validarConfiguracao({ ...CONFIG, gruposAutorizados: [{ grupoId: GRUPO, unidades: [ALFA], acesso: "ABERTO" }] }), /acesso/);
  assert.throws(() => validarConfiguracao({ ...CONFIG, gruposAutorizados: [{ grupoId: GRUPO, unidades: [ALFA] }] }), /participantes/);
  assert.throws(() => validarConfiguracao({ ...CONFIG, gruposAutorizados: [{ grupoId: GRUPO, unidades: [ALFA], participantes: [{ ids: [FIN], perfil: "FINANCEIRO", unidades: [XIS] }] }] }), /unidades/);
  assert.throws(() => validarConfiguracao({ ...CONFIG, gruposAutorizados: [{ grupoId: GRUPO, unidades: [ALFA], participantes: [{ ids: [FIN], perfil: "ADMIN" }] }] }), /perfil/);
  assert.throws(() => validarConfiguracao({ ...CONFIG, gruposAutorizados: [{ grupoId: FIN, unidades: [ALFA], participantes: [{ ids: [FIN], perfil: "FINANCEIRO" }] }] }), /grupoId/);
});

t("A2-02 desconhecido no grupo: descartado ANTES de guardar (nada de texto no banco, nenhuma resposta, nenhuma IA)", async () => {
  const s = await cenario();
  const r = await s.enviar(gw({ texto: "MOVA, quanto faturamos?", de: ESTRANHO }));
  assert.deepEqual([r.status, r.motivo], ["IGNORADO", "PARTICIPANTE_NAO_AUTORIZADO"]);
  assert.deepEqual([await s.contar("evento"), await s.contar("fila"), await s.contar("resposta"), await s.contar("participante"), s.cliente.pedidos.length], [0, 0, 0, 0, 0]);
});

t("A2-03 participante autorizado sem chamar o MOVA: não é guardado nem respondido", async () => {
  const s = await cenario();
  const r = await s.enviar(gw({ texto: "pessoal, alguém viu o boleto da luz?" }));
  assert.deepEqual([r.status, r.motivo], ["IGNORADO", "NAO_ACIONADO"]);
  assert.deepEqual([await s.contar("evento"), await s.contar("resposta"), s.cliente.pedidos.length], [0, 0, 0]);
});

t("A2-04 'MOVA, contas a pagar da semana': comando simples SEM IA; valor só no privado, aviso sem valor no grupo", async () => {
  const s = await cenario();
  await s.conta("2026-10-17", 30000);
  await s.conta("2026-11-30", 99900); // fora da semana
  await s.enviar(gw({ texto: "MOVA, contas a pagar da semana da alfa" }));
  assert.equal(s.cliente.pedidos.length, 0, "comando simples não chama a IA");
  const [privada, aviso] = await s.saida();
  assert.equal(privada.destino, FIN);
  assert.match(privada.texto, /Loja Alfa/);
  assert.match(privada.texto, /R\$ 300,00/);
  assert.doesNotMatch(privada.texto, /999,00/);
  assert.equal(aviso.destino, GRUPO);
  assert.doesNotMatch(aviso.texto, /R\$|\d{2},\d{2}/);
  assert.match(aviso.texto, /privado/);
  const h = await s.ultima();
  assert.deepEqual([h.decisao, h.motivo, h.interpretacao, h.respostaPrivada], ["CONSULTA", "CONTAS_VENCENDO", "COMANDO", "ENVIADA_NO_PRIVADO"]);
  // Toda leitura no Financeiro: só "ver" e só a unidade resolvida.
  assert.ok(s.chamadas.every((x) => x.unidadeId === ALFA && x.organizacaoId === ORG && x.permissoes.length === 1 && x.permissoes[0] === ACAO.VER));
});

t("A2-05 continuidade: logo depois da resposta, 'e a semana que vem?' sem o nome — mesma consulta e mesma unidade, sem IA", async () => {
  const s = await cenario();
  await s.conta("2026-10-21", 45000);
  await s.enviar(gw({ texto: "MOVA contas a pagar da semana da beta" }));
  await s.enviar(gw({ texto: "e da alfa?" })); // 24/11: acompanhamento de unidade é resolvido sem IA (mesma consulta e período)
  assert.equal((await s.ultima()).unidadeId, ALFA);
  const r = await s.enviar(gw({ texto: "e a semana que vem?" }));
  assert.equal(r.status, "ENFILEIRADO");
  const h = await s.ultima();
  assert.deepEqual([h.motivo.split(":")[0], h.interpretacao], ["CONTAS_VENCENDO", "CONTINUIDADE"]);
  // A unidade veio da conversa em andamento DESTA pessoa (a última consulta foi da Alfa, que ela mesma pediu).
  assert.equal(h.unidadeId, ALFA);
  // Outra pessoa sem conversa ativa e sem chamar o MOVA continua ignorada.
  assert.equal((await s.enviar(gw({ texto: "e a semana que vem?", de: LID }))).motivo, "NAO_ACIONADO");
});

t("A2-06 unidades da PESSOA: só Alfa ⇒ consulta sem unidade é da Alfa; pedir a Beta é recusado", async () => {
  const s = await cenario();
  await s.conta("2026-10-05", 1500);
  await s.enviar(gw({ texto: "MOVA contas vencidas", de: SO_ALFA }));
  assert.deepEqual([(await s.ultima()).motivo, (await s.ultima()).unidadeId], ["CONTAS_VENCIDAS", ALFA]);
  await s.enviar(gw({ texto: "MOVA contas vencidas da beta", de: SO_ALFA }));
  assert.equal((await s.ultima()).motivo, "UNIDADE_FORA_DO_GRUPO");
  assert.ok(s.chamadas.every((x) => x.unidadeId === ALFA));
});

t("A2-07 consulta SEM valores (pendências) sai no próprio grupo; FINANCEIRO sem conversa privada não vê valor no grupo", async () => {
  const s = await cenario();
  await s.enviar(gw({ texto: "MOVA pendências da alfa" }));
  const [g] = await s.saida();
  assert.equal(g.destino, GRUPO);
  assert.match(g.texto, /pendências de conferência/);
  await s.conta("2026-10-01", 7700);
  await s.enviar(gw({ texto: "MOVA contas vencidas da alfa", de: SEM_PRIVADO }));
  const depois = (await s.saida()).slice(1);
  assert.equal(depois.length, 1);
  assert.equal(depois[0].destino, GRUPO);
  assert.doesNotMatch(depois[0].texto, /R\$/);
  assert.equal((await s.ultima()).respostaPrivada, "SEM_CONVERSA_PRIVADA");
});

t("A2-08 LID com privado cadastrado: resposta vai ao número privado; perfil OPERACIONAL não consulta valores; CONSULTA não envia documento", async () => {
  const s = await cenario({ responder: () => base({ tipoDocumento: "BOLETO", intencao: "REGISTRAR_CONTA", valorCentavos: 5000, vencimento: "2026-10-30" }) });
  await s.conta("2026-10-02", 1000);
  await s.enviar(gw({ texto: "MOVA contas vencidas da alfa", de: LID }));
  assert.equal((await s.saida())[0].destino, LID_PRIVADO);
  await s.enviar(gw({ texto: "MOVA contas a pagar da alfa", de: OPER }));
  assert.equal((await s.ultima()).motivo, "PERFIL_SEM_CONSULTA");
  await s.enviar(gw({ texto: "MOVA boleto da alfa", de: CONS, doc: "%PDF sintético A2-08" }));
  assert.equal((await s.ultima()).motivo, "PERFIL_SEM_DOCUMENTOS");
  assert.equal(s.cliente.pedidos.length, 0, "documento de perfil sem documentos não vai à IA");
});

t("A2-09 conversa PRIVADA derivada: a pessoa conversa sem chamar o nome, só nas unidades dela; desconhecido no privado é ignorado", async () => {
  const s = await cenario();
  await s.conta("2026-10-03", 2500);
  await s.enviar(gw({ texto: "contas vencidas", grupo: SO_ALFA, de: SO_ALFA }));
  const [r] = await s.saida();
  assert.deepEqual([r.destino, /R\$ 25,00/.test(r.texto)], [SO_ALFA, true]);
  const fora = await s.enviar(gw({ texto: "contas vencidas", grupo: ESTRANHO, de: ESTRANHO }));
  assert.equal(fora.status, "IGNORADO");
  // Pessoa em grupos de duas empresas: sem conversa privada derivada (nunca mistura organizações).
  assert.equal((await s.enviar(gw({ texto: "contas vencidas", grupo: DUAS_EMPRESAS, de: DUAS_EMPRESAS }))).status, "IGNORADO");
});

t("A2-10 isolamento entre empresas: no grupo da outra empresa a mesma pessoa só alcança a unidade de lá", async () => {
  const s = await cenario();
  await s.enviar(gw({ texto: "MOVA contas vencidas", grupo: GRUPO_X, de: DUAS_EMPRESAS }));
  assert.equal((await s.ultima()).unidadeId, XIS);
  await s.enviar(gw({ texto: "MOVA contas vencidas da alfa", grupo: GRUPO_X, de: DUAS_EMPRESAS }));
  assert.equal((await s.ultima()).motivo, "UNIDADE_FORA_DO_GRUPO");
  assert.ok(s.chamadas.every((x) => x.organizacaoId === ORG_X && x.unidadeId === XIS));
  // Sem conversa privada (duas empresas): o valor não sai no grupo.
  assert.ok((await s.saida()).every((x) => x.destino === GRUPO_X && !/R\$/.test(x.texto)));
});

t("A2-11 citação de uma resposta do MOVA aciona; fechamento dos entregadores responde sem quebrar quando não há fechamento", async () => {
  const s = await cenario();
  await s.enviar(gw({ texto: "MOVA fechamento dos entregadores da alfa" }));
  const h = await s.ultima();
  assert.equal(h.motivo, "FECHAMENTO_ENTREGADORES:DADOS_INSUFICIENTES");
  await s.banco.pool.query("update mova.resposta set provider_message_id = 'MOVA-MSG-1', estado = 'ENVIADA' where grupo_jid = $1", [GRUPO]);
  await s.banco.pool.query("delete from mova.conversa_ativa");
  const r = await s.enviar(gw({ texto: "obrigado", de: LID, respostaA: "MOVA-MSG-1" }));
  assert.equal(r.status, "ENFILEIRADO");
});

t("A2-12 a lista vem do banco e é idempotente: reinstalar sem uma pessoa REVOGA (não apaga) e ela deixa de falar com o MOVA", async () => {
  const s = await cenario();
  const lida = validarConfiguracao(await carregarConfiguracao(s.banco.pool, { identidadeServico: CONFIG.identidadeServico, modo: "OPERACAO" }));
  assert.equal(lida.gruposAutorizados.find((g) => g.grupoId === GRUPO).participantes.length, 7);
  assert.deepEqual(lida.gruposAutorizados.filter((g) => g.derivada).map((g) => g.grupoId).sort(), s.cfg.gruposAutorizados.filter((g) => g.derivada).map((g) => g.grupoId).sort());
  await instalarConfiguracao(s.banco.pool, s.cfg); // de novo: nada muda
  assert.equal(await s.contar("participante_autorizado"), 8);
  const sem = { ...CONFIG, gruposAutorizados: CONFIG.gruposAutorizados.map((g) => (g.grupoId === GRUPO ? { ...g, participantes: g.participantes.filter((p) => p.ids[0] !== CONS) } : g)) };
  await instalarConfiguracao(s.banco.pool, validarConfiguracao(sem));
  const { rows } = await s.banco.pool.query("select ativo, revogado_em is not null as revogado from mova.participante_autorizado where $1 = any(ids)", [CONS]);
  assert.deepEqual(rows, [{ ativo: false, revogado: true }]);
  const recarregada = validarConfiguracao(await carregarConfiguracao(s.banco.pool, { identidadeServico: CONFIG.identidadeServico, modo: "OPERACAO" }));
  assert.equal(recarregada.gruposAutorizados.find((g) => g.grupoId === GRUPO).participantes.length, 6);
  // Fora da OPERACAO a privada derivada nunca é carregada como conversa avulsa.
  const sim = await carregarConfiguracao(s.banco.pool, { identidadeServico: CONFIG.identidadeServico, modo: "HOMOLOGACAO" });
  assert.ok(sim.gruposAutorizados.every((g) => g.grupoId.endsWith("@g.us")));
});

t("A2-13 interpretação de comandos simples: só o inequívoco; número, relato ou documento seguem para a IA", () => {
  const hoje = "2026-10-15";
  const c = (x) => interpretarComando(x, hoje);
  assert.equal(c("MOVA, contas a pagar da semana").saida.consulta, "CONTAS_VENCENDO");
  assert.equal(c("mova contas vencidas").saida.consulta, "CONTAS_VENCIDAS");
  assert.equal(c("faturamento do mês passado").saida.competencia, "2026-09");
  assert.equal(c("quanto faturamos em novembro?").saida.competencia, "2025-11"); // mês futuro = ano anterior
  assert.equal(c("mova custos e despesas do mês").saida.consulta, "DRE_RESUMO");
  assert.equal(c("MOVA fechamento dos entregadores").saida.consulta, "FECHAMENTO_ENTREGADORES");
  assert.equal(c("e a semana que vem?").soPeriodo, true);
  for (const x of ["paguei a luz ontem", "mova faturamento de 10/2026", "a conta de luz vence quando?", "oi mova", "MOVA registra o boleto da semana", "mova pix das contas a pagar"]) assert.equal(c(x), null, x);
});
