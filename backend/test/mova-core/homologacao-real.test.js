// MOVA CORE — 25/11/2026: REGRESSÃO das perguntas reais da 1ª homologação em produção (Açaí, 24–25/11), com dados SINTÉTICOS.
// Cada teste corresponde a um problema observado: lista parcial apresentada como completa e chamadas repetidas (69 contas),
// situação de vencimento decidida pelo modelo, total devido aos entregadores só da semana atual, histórico sem datas e sem
// resolver o nome, agrupamento inexistente, leituras paralelas sem fila (FINANCEIRO_INDISPONIVEL) e troca de instância no deploy.
import assert from "node:assert/strict";
import test from "node:test";
import { CATALOGO } from "../../src/modules/mova-core/catalogo.js";
import { criarExecutor, novaSessao } from "../../src/modules/mova-core/executor.js";
import { criarMemoriaDeConversas } from "../../src/modules/mova-core/conversa.js";
import { criarMovaCore, criarOrcamentoMemoria } from "../../src/modules/mova-core/index.js";
import { situacaoDoVencimento, itemAPagar, formatarListaDeContas } from "../../src/modules/mova-core/leituras.js";
import { criarTitularPorGeracao } from "../../src/modules/mova-financeiro/infra/postgres.js";
import { ErroTransitorio } from "../../src/modules/mova-financeiro/gateway/fila.js";
import { ORG_A, UNI_A, USUARIO, ctx, financeiroReal, clienteRoteirizado, usar, falar, UNIDADES, PERFIL_FIN } from "./helpers.js";

const HOJE = "2026-11-25";
const FORNECEDORES = ["Doce Brownie Ltda", "Açaí do Norte", "Embalagens Sol", "Gás Rápido", "Energia Ceará", "Limpeza Total"];

async function comContas(n) {
  const f = await financeiroReal();
  const forn = [];
  for (const nome of FORNECEDORES) forn.push(await f.m.nucleo.registrarContraparte(ctx(ORG_A, UNI_A), { tipo: "FORNECEDOR", nome }));
  for (let i = 0; i < n; i++) {
    const dia = String(1 + (i % 28)).padStart(2, "0"); const mes = i % 2 ? "11" : "12";
    await f.conta(10_000 + i * 100, `2026-${mes}-${dia}`, `Compra ${i + 1}`, `2026-${mes}`, UNI_A, forn[i % forn.length]);
  }
  return f;
}
function ambiente(f, porta = f.porta) {
  const auditoria = [];
  const executor = criarExecutor({ catalogo: CATALOGO, porta, auditoria: { registrar: (x) => auditoria.push(x) } });
  const conversa = criarMemoriaDeConversas().obter({ organizacaoId: ORG_A, conversaId: "g1", participanteId: "p1" });
  const sessao = () => novaSessao({ conversa, organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: USUARIO, unidadesPermitidas: UNIDADES, perfil: PERFIL_FIN, podeValores: true, requisicaoId: "r1", hoje: HOJE });
  void 0;
  const rodar = async (s, name, input = {}) => { const r = await executor.executar(s, { name, input }); return { ...r, json: JSON.parse(r.conteudo) }; };
  return { executor, sessao, rodar, auditoria };
}
const linhas = (blocos) => blocos.join("\n").split("\n").filter((l) => l.startsWith("• "));

// ---------------------------------------------------------------------------------------------- 1. listas completas
test("HR-01 'quero todas as 69 contas': TODAS saem (descrição, fornecedor, valor, vencimento, situação), em partes de até 25, com o total conferido", async () => {
  const f = await comContas(69);
  const a = ambiente(f);
  const s = a.sessao();
  const r = await a.rodar(s, "lista_completa_de_contas", {});
  assert.equal(r.ok, true, r.conteudo);
  assert.equal(r.json.entreguePeloServidor ?? r.json.dados?.entreguePeloServidor, true);
  const entrega = s.entregas[0];
  assert.equal(entrega.paginas, 1);
  assert.equal(entrega.blocos.length, 3, "69 contas = 3 mensagens (25 + 25 + 19)");
  const ls = linhas(entrega.blocos);
  assert.equal(ls.length, 69, "nenhuma conta fica de fora");
  for (const b of entrega.blocos) assert.ok(linhas([b]).length <= 25);
  for (let i = 1; i <= 69; i++) assert.ok(ls.some((l) => l.includes(`Compra ${i} `) || l.endsWith(`Compra ${i}`) || l.includes(`Compra ${i} —`)), `Compra ${i}`);
  for (const l of ls) assert.match(l, /^• venc\. \d{2}\/\d{2}\/2026 · .+ · Compra \d+ — R\$ [\d.]+,\d{2} · (vencida há \d+ dias?|vence hoje|a vencer)$/);
  assert.match(entrega.blocos.at(-1), /Total: 69 contas, R\$ [\d.]+,\d{2} em aberto \(R\$ [\d.]+,\d{2} vencido\)\. Lista completa \(69 contas\)\./);
  assert.match(entrega.blocos[0], /\(parte 1 de 3\)/);
});

test("HR-02 contas_a_pagar com muitas contas: totais e TODOS os fornecedores completos numa chamada; itens não cabem ⇒ orienta a lista completa (sem cortar o resultado)", async () => {
  const f = await comContas(69);
  const a = ambiente(f);
  const r = await a.rodar(a.sessao(), "contas_a_pagar", {});
  assert.equal(r.ok, true, r.conteudo);
  assert.ok(r.conteudo.length < 12_000, "cabe no limite: não é cortado (antes o corte fazia o modelo repetir a chamada)");
  const d = r.json.dados ?? r.json;
  assert.equal(d.totais.quantidade, 69);
  assert.equal(d.porFornecedor.length, FORNECEDORES.length);
  assert.equal(d.porFornecedor.reduce((x, g) => x + g.saldoCentavos, 0), d.totais.saldoCentavos, "soma por fornecedor = total");
  assert.equal(d.porFornecedor.reduce((x, g) => x + g.quantidade, 0), 69);
  assert.ok(!d.itens || d.itens.length === 0, "itens não vão truncados como se fossem todos");
  assert.match(JSON.stringify(d.comoMostrarTodos), /lista_completa_de_contas/);
});

test("HR-03 lista longa agrupada por fornecedor: página 1 diz quais faltam; 'continuar' traz o resto e fecha com 'Lista completa'", async () => {
  const f = await comContas(150);
  const a = ambiente(f);
  const s1 = a.sessao();
  await a.rodar(s1, "lista_completa_de_contas", { agruparPor: "FORNECEDOR" });
  const p1 = s1.entregas[0];
  assert.equal(p1.paginas, 2);
  assert.equal(linhas(p1.blocos).length, 120);
  assert.match(p1.blocos.at(-1), /Total de todas as contas do filtro: 150 contas.*Faltam as contas 121 a 150: peça "continuar"/s);
  assert.match(p1.blocos[0], /^\S.* — contas 1 a 120 de 150/);
  assert.ok(p1.blocos.some((b) => /\*Doce Brownie Ltda\* — \d+ contas, R\$/.test(b)), "cabeçalho por fornecedor com quantidade e saldo");
  const s2 = a.sessao();
  await a.rodar(s2, "lista_completa_de_contas", { agruparPor: "FORNECEDOR", pagina: 2 });
  assert.equal(linhas(s2.entregas[0].blocos).length, 30);
  assert.match(s2.entregas[0].blocos.at(-1), /Lista completa \(150 contas\)/);
});

test("HR-04 a MESMA leitura do Financeiro é feita UMA vez por mensagem, mesmo com várias ferramentas (contas + lista + paralelo)", async () => {
  const f = await comContas(30);
  const a = ambiente(f);
  const s = a.sessao();
  const antes = f.chamadas.filter((c) => c.nome === "consultarContasAPagar").length;
  await Promise.all([a.rodar(s, "contas_a_pagar", {}), a.rodar(s, "contas_a_pagar", { situacao: "VENCIDO" }), a.rodar(s, "lista_completa_de_contas", { situacao: "A_VENCER" })]);
  const lidas = f.chamadas.filter((c) => c.nome === "consultarContasAPagar").length - antes;
  assert.equal(lidas, 1, "30 contas = 1 página lida uma única vez");
  const s2 = a.sessao(); // mensagem seguinte lê de novo (nada fica velho)
  await a.rodar(s2, "contas_a_pagar", {});
  assert.equal(f.chamadas.filter((c) => c.nome === "consultarContasAPagar").length - antes, 2);
});

// ------------------------------------------------------------------------------------- 5. vencimento pelo CÓDIGO
test("HR-05 situação do vencimento calculada no servidor (Fortaleza): vencida, vence hoje, parcialmente paga vencida, quitada, a vencer, cancelada", () => {
  const t = (x) => situacaoDoVencimento({ situacao: "EM_ABERTO", saldoCentavos: 1000, ...x }, HOJE);
  assert.deepEqual(t({ vencimento: "2026-11-20" }), { situacaoDoVencimento: "VENCIDA", diasEmAtraso: 5 });
  assert.deepEqual(t({ vencimento: HOJE }), { situacaoDoVencimento: "VENCE_HOJE", diasEmAtraso: 0 });
  assert.equal(t({ vencimento: "2026-11-26" }).situacaoDoVencimento, "A_VENCER");
  assert.equal(t({ vencimento: "2026-11-01", situacao: "PARCIALMENTE_PAGO", pagoCentavos: 500 }).situacaoDoVencimento, "VENCIDA", "pago em parte continua vencido pelo saldo");
  assert.equal(t({ vencimento: "2026-11-01", saldoCentavos: 0 }).situacaoDoVencimento, "LIQUIDADA");
  assert.equal(t({ vencimento: "2026-11-01", situacao: "CANCELADO" }).situacaoDoVencimento, "CANCELADA");
  assert.equal(t({ vencimento: null }).situacaoDoVencimento, "SEM_VENCIMENTO");
  // o "vencido" do Financeiro (calculado em outro dia/fuso) não manda: vale a data de hoje
  const it = itemAPagar({ id: "x", situacao: "EM_ABERTO", vencimento: HOJE, saldoCentavos: 100, valorOriginalCentavos: 100, pagoCentavos: 0, vencido: true }, HOJE);
  assert.equal(it.situacaoDoVencimento, "VENCE_HOJE"); assert.equal(it.vencido, false);
  const lista = formatarListaDeContas([{ ...it, fornecedor: "X", descricao: "Gás" }, itemAPagar({ id: "y", situacao: "PARCIALMENTE_PAGO", vencimento: "2026-11-10", saldoCentavos: 4000, valorOriginalCentavos: 10000, pagoCentavos: 6000, fornecedor: { nome: "Y" }, descricao: "Brownies" }, HOJE)],
    { titulo: "Contas", totais: { quantidade: 2, saldoCentavos: 4100, vencidoCentavos: 4000 } });
  assert.match(lista.blocos[0], /venc\. 25\/11\/2026 · X · Gás — R\$ 1,00 · vence hoje/);
  assert.match(lista.blocos[0], /venc\. 10\/11\/2026 · Y · Brownies — R\$ 40,00 \(pago R\$ 60,00 de R\$ 100,00\) · vencida há 15 dias/);
});

test("HR-06 'quais contas estão vencidas?': o filtro VENCIDO é do servidor e nunca inclui a que vence hoje ou a vencer", async () => {
  const f = await comContas(20);
  const a = ambiente(f);
  const r = await a.rodar(a.sessao(), "contas_a_pagar", { situacao: "VENCIDO" });
  const d = r.json.dados ?? r.json;
  assert.ok(d.totais.quantidade > 0);
  for (const it of d.itens ?? []) { assert.equal(it.situacaoDoVencimento, "VENCIDA"); assert.ok(it.vencimento < HOJE); }
  assert.equal(d.totais.saldoCentavos, d.totais.vencidoCentavos);
});

// ------------------------------------------------------------------------------------------ 3–4. entregadores
/** Porta SINTÉTICA com o formato real do Financeiro v2 (painel de entregadores, contas, histórico, detalhe). */
function portaDeEntregadores({ falharVezes = 0 } = {}) {
  const leituras = [];
  const painel = (semana) => semana === "2026-11-09"
    ? { semana: { inicio: "2026-11-09", fim: "2026-11-15", rotulo: "09/11 a 15/11", situacao: "AGUARDANDO_FECHAMENTO", provisoria: true }, entregadores: [{ chave: "e-vitor", nome: "Vitor Silva", entregasSemana: 4, valorSemanaCentavos: 6000, aPagarCentavos: 0 }], semanas: [] }
    : { semana: { inicio: "2026-11-23", fim: "2026-11-29", rotulo: "23/11 a 29/11", situacao: "EM_ANDAMENTO", provisoria: true },
      indicadoresDaSemana: { devidoCentavos: 7500, pagoCentavos: 0, saldoCentavos: 7500 },
      entregadores: [{ chave: "e-vitor", nome: "Vitor Silva", entregasSemana: 3, valorSemanaCentavos: 4500, aPagarCentavos: 10000, aguardandoNota: 0 }, { chave: "e-ana", nome: "Ana Paula", entregasSemana: 2, valorSemanaCentavos: 3000, aPagarCentavos: 0 }],
      fechamentos: [{ id: "f1", semanaInicio: "2026-11-16", semanaFim: "2026-11-22", entregador: { chave: "e-vitor", nome: "Vitor Silva" } }],
      semanas: [{ inicio: "2026-11-16", semRegistro: false }, { inicio: "2026-11-09", semRegistro: true }] };
  const conta = (id, fornecedor, categoria, vencimento, valor, pago, descricao) => ({ id, fornecedor: { nome: fornecedor }, categoria: { codigo: categoria, nome: categoria }, descricao, vencimento, competencia: vencimento.slice(0, 7),
    valorOriginalCentavos: valor, pagoCentavos: pago, saldoCentavos: valor - pago, situacao: pago ? (pago >= valor ? "PAGO" : "PARCIALMENTE_PAGO") : "EM_ABERTO" });
  const contas = [conta("c1", "Vitor Silva", "ENTREGADORES_PROPRIOS", "2026-11-24", 15000, 5000, "Entregas 16/11 a 22/11"), conta("c2", "Ana Paula", "ENTREGADORES_PROPRIOS", "2026-11-24", 8000, 8000, "Entregas 16/11 a 22/11"),
    conta("c3", "Vitor Silva", "INSUMOS", "2026-11-30", 99900, 0, "Outra despesa com o mesmo nome")];
  let falhas = falharVezes; let simultaneas = 0; let pico = 0;
  const porta = {
    leituras, get pico() { return pico; },
    async permissoesDoUsuario() { return ["financeiro_v2.ver"]; },
    ehErroDeRegra: (e) => e?.regra === true,
    async ler(op, escopo, entrada) {
      leituras.push({ op, entrada }); simultaneas++; pico = Math.max(pico, simultaneas);
      try {
        await new Promise((ok) => { setTimeout(ok, 5); });
        if (falhas > 0) { falhas--; throw Object.assign(new ErroTransitorio("FINANCEIRO_INDISPONIVEL"), { causa: "53300" }); }
        if (op === "consultarEntregadoresProprios") return painel(entrada?.semana);
        if (op === "consultarContasAPagar") return { itens: contas, paginacao: { pagina: 1, paginas: 1 } };
        if (op === "consultarEntregador") {
          if (entrada.entregador !== "e-vitor") throw Object.assign(new Error("sem fechamentos"), { regra: true });
          return { chave: "e-vitor", nome: "Vitor Silva", totalCentavos: 27000, pagoCentavos: 17000, entregas: 18, fechamentos: [
            { semanaInicio: "2026-11-16", semanaFim: "2026-11-22", rotuloSemana: "16/11 a 22/11", vencimento: "2026-11-24", entregas: 10, valorCentavos: 15000, pagoCentavos: 5000, saldoCentavos: 10000, situacaoPagamento: "PARCIAL", situacaoDocumental: "NOTA_RECEBIDA", obrigacaoId: "c1" },
            { semanaInicio: "2026-11-02", semanaFim: "2026-11-08", rotuloSemana: "02/11 a 08/11", vencimento: "2026-11-10", entregas: 8, valorCentavos: 12000, pagoCentavos: 12000, saldoCentavos: 0, situacaoPagamento: "PAGO", situacaoDocumental: "NOTA_RECEBIDA", obrigacaoId: "c0" }] };
        }
        if (op === "detalharContaAPagar") return { titulo: { pagamentos: entrada.id === "c1" ? [{ data: "2026-11-24", valorCentavos: 5000 }] : [{ data: "2026-11-10", valorCentavos: 12000 }] } };
        throw new Error(`op inesperada ${op}`);
      } finally { simultaneas--; }
    },
  };
  return porta;
}

test("HR-07 'quanto devemos aos entregadores?': contas geradas em aberto (pagamento parcial descontado) + semanas NÃO fechadas como provisório; semana fechada não duplica; outra categoria fica fora", async () => {
  const porta = portaDeEntregadores();
  const a = ambiente({ porta }, porta);
  const r = await a.rodar(a.sessao(), "devido_aos_entregadores", {});
  assert.equal(r.ok, true, r.conteudo);
  const d = r.json.dados ?? r.json;
  const vitor = d.entregadores.find((x) => x.nome === "Vitor Silva");
  assert.equal(vitor.confirmadoEmAbertoCentavos, 10_000, "R$ 150 da semana 16/11 menos R$ 50 pagos");
  assert.equal(vitor.vencidoCentavos, 10_000, "venceu 24/11");
  assert.equal(vitor.provisorioCentavos, 4500 + 6000, "semana atual (23/11) + semana 09/11 encerrada sem fechamento");
  assert.equal(vitor.totalCentavos, 20_500);
  const ana = d.entregadores.find((x) => x.nome === "Ana Paula");
  assert.equal(ana.confirmadoEmAbertoCentavos, 0, "conta quitada não conta"); assert.equal(ana.provisorioCentavos, 3000);
  assert.equal(d.totais.totalCentavos, 23_500);
  assert.equal(d.totais.confirmadoEmAbertoCentavos, 10_000);
  assert.ok(!JSON.stringify(d).includes("99900"), "conta de INSUMOS com o mesmo nome não entra");
  assert.deepEqual(d.semanasProvisorias.map((w) => w.inicio), ["2026-11-23", "2026-11-09"]);
  // um entregador pelo apelido
  const so = await a.rodar(a.sessao(), "devido_aos_entregadores", { entregador: "vitor" });
  assert.deepEqual((so.json.dados ?? so.json).entregadores.map((x) => x.nome), ["Vitor Silva"]);
});

test("HR-08 'histórico do Vitor': resolve o nome, cita cada semana pelas DATAS, valor, pago, saldo, situação e data do pagamento; semana em apuração separada", async () => {
  const porta = portaDeEntregadores();
  const a = ambiente({ porta }, porta);
  const r = await a.rodar(a.sessao(), "historico_do_entregador", { entregador: "Vitor" });
  assert.equal(r.ok, true, r.conteudo);
  const d = r.json.dados ?? r.json;
  assert.equal(d.entregador, "Vitor Silva");
  assert.deepEqual(d.semanasFechadas.map((s) => [s.semanaInicio, s.semanaFim, s.valorApuradoCentavos, s.pagoCentavos, s.saldoCentavos, s.dataDoUltimoPagamento]),
    [["2026-11-16", "2026-11-22", 15000, 5000, 10000, "2026-11-24"], ["2026-11-02", "2026-11-08", 12000, 12000, 0, "2026-11-10"]]);
  assert.equal(d.semanasFechadas[0].origem, "FECHAMENTO_SEMANAL");
  const { valorApuradoEmReais: _r, ...apuracao } = d.semanaEmApuracao; void _r;
  assert.deepEqual(apuracao, { semanaInicio: "2026-11-23", semanaFim: "2026-11-29", entregas: 3, valorApuradoCentavos: 4500, situacao: "EM_ANDAMENTO", provisoria: true, origem: "APURACAO_FOODY" });
  assert.equal(d.ultimoPagamentoEm, "2026-11-24");
  assert.ok(!/outra semana/i.test(r.conteudo));
  const nenhum = await a.rodar(a.sessao(), "historico_do_entregador", { entregador: "Zé Ninguém" });
  assert.equal((nenhum.json.dados ?? nenhum.json).mensagem, "Nenhum entregador com o nome \"Zé Ninguém\" nesta unidade.");
});

test("HR-09 nome AMBÍGUO de entregador: pergunta qual (não soma nem escolhe sozinho)", async () => {
  const porta = portaDeEntregadores();
  const original = porta.ler.bind(porta);
  porta.ler = async (op, escopo, entrada) => {
    const r = await original(op, escopo, entrada);
    if (op === "consultarEntregadoresProprios" && !entrada?.semana) r.entregadores.push({ chave: "e-vitor2", nome: "Vitor Lima", entregasSemana: 1, valorSemanaCentavos: 1500, aPagarCentavos: 0 });
    return r;
  };
  const a = ambiente({ porta }, porta);
  for (const nome of ["historico_do_entregador", "devido_aos_entregadores"]) {
    const r = await a.rodar(a.sessao(), nome, { entregador: "Vitor" });
    const d = r.json.dados ?? r.json;
    assert.deepEqual([...d.ambiguidade.candidatos].sort(), ["Vitor Lima", "Vitor Silva"], nome);
  }
});

// -------------------------------------------------------------------------------------- 2. conexões e desempenho
test("HR-10 leituras paralelas: no máximo 2 ao mesmo tempo no Financeiro (o papel de leitura tem 2 conexões) e o painel pesado é lido uma vez", async () => {
  const porta = portaDeEntregadores();
  const a = ambiente({ porta }, porta);
  const s = a.sessao();
  await Promise.all([a.rodar(s, "devido_aos_entregadores", {}), a.rodar(s, "entregadores_da_semana", {}), a.rodar(s, "historico_do_entregador", { entregador: "Ana" }), a.rodar(s, "contas_a_pagar", {})]);
  assert.ok(porta.pico <= 2, `pico ${porta.pico}`);
  assert.equal(porta.leituras.filter((l) => l.op === "consultarEntregadoresProprios" && !l.entrada?.semana).length, 1, "o mesmo painel foi compartilhado");
  assert.equal(porta.leituras.filter((l) => l.op === "consultarContasAPagar").length, 1);
});

test("HR-11 falha TRANSITÓRIA (conexão recusada): uma nova tentativa curta resolve; a causa técnica fica na auditoria; falha persistente = FINANCEIRO_INDISPONIVEL com causa", async () => {
  const porta = portaDeEntregadores({ falharVezes: 1 });
  const a = ambiente({ porta }, porta);
  const r = await a.rodar(a.sessao(), "contas_a_pagar", {});
  assert.equal(r.ok, true, r.conteudo);
  const p2 = portaDeEntregadores({ falharVezes: 10 });
  const b = ambiente({ porta: p2 }, p2);
  const r2 = await b.rodar(b.sessao(), "contas_a_pagar", {});
  assert.equal(r2.ok, false); assert.equal(r2.codigo, "FINANCEIRO_INDISPONIVEL");
  assert.ok(JSON.stringify(b.auditoria).includes("53300"), "o SQLSTATE aparece no diagnóstico");
  assert.ok(!JSON.stringify(b.auditoria).includes("Vitor"), "nenhum dado vai junto");
});

// ------------------------------------------------------------------------------------------------- 7. agrupamentos
test("HR-12 agrupamentos: o esquema da análise diz as combinações válidas; pedido inválido explica quais métricas agrupam assim", async () => {
  const desc = CATALOGO.analisar.esquema.properties.agruparPor.description;
  assert.match(desc, /DESPESAS: NENHUM\/FORNECEDOR\/CATEGORIA\/UNIDADE/);
  assert.match(desc, /ENTREGAS: NENHUM\/ENTREGADOR\/UNIDADE/);
  const f = await comContas(3);
  const a = ambiente(f);
  const r = await a.rodar(a.sessao(), "analisar", { metrica: "VENDAS_BRUTAS", agruparPor: "FORNECEDOR", competencias: ["2026-11"] });
  assert.match(r.conteudo, /Métricas que agrupam por FORNECEDOR: DESPESAS, PAGAMENTOS, EM_ABERTO/);
});

// ------------------------------------------------------------------------------------------ 6. troca de instância
test("HR-13 deploy: a instância mais NOVA conectada assume a fila; a antiga para de pegar (aviso único) e volta se a nova cair; erro na conferência não trava", async () => {
  let maisNova = 0; let falhar = false; let t = 0;
  const pool = { async query(sql) { if (falhar) throw new Error("x"); assert.match(sql, /pg_stat_activity/); return { rows: [{ g: String(maisNova) }] }; } };
  const eventos = [];
  const antiga = criarTitularPorGeracao({ pool, geracao: 1_764_000_000_000, intervaloMs: 5000, relogio: () => t, registrar: (e) => eventos.push(e) });
  maisNova = 1_764_000_000_000;
  assert.equal(await antiga(), true, "sozinha: titular");
  maisNova = 1_764_000_120_000; t += 5000;
  assert.equal(await antiga(), false, "subiu uma mais nova: para de pegar");
  t += 5000; assert.equal(await antiga(), false);
  assert.deepEqual(eventos.map((e) => e.tipo), ["MOVA_WORKER_SUBSTITUIDO"], "avisa uma vez");
  t += 1000; maisNova = 1_764_000_000_000; assert.equal(await antiga(), false, "dentro do intervalo usa o último resultado");
  t += 5000; assert.equal(await antiga(), true, "a nova caiu: volta a atender");
  falhar = true; t += 5000; assert.equal(await antiga(), true, "falha na conferência = comportamento anterior");
  assert.throws(() => criarTitularPorGeracao({ pool, geracao: 0 }));
});

// ---------------------------------------------------------------------------- núcleo: entrega da lista + continuidade
test("HR-14 núcleo: a lista do servidor segue em mensagens próprias depois da introdução do modelo; 'continuar' pede a página seguinte com os mesmos filtros", async () => {
  const f = await comContas(150);
  const cliente = clienteRoteirizado([
    [usar("lista_completa_de_contas", { agruparPor: "FORNECEDOR" })], [falar("Seguem as contas em aberto, agrupadas por fornecedor.")],
    (req) => { assert.match(req.system.map((b) => b.text).join("\n"), /página 1 de 2.*pagina 2/s); return [usar("lista_completa_de_contas", { agruparPor: "FORNECEDOR", pagina: 2 })]; },
    [falar("Aqui está o restante.")],
  ]);
  const c = criarMovaCore({ porta: f.porta, cliente, orcamento: criarOrcamentoMemoria() });
  const perguntar = (texto) => c.responder({ organizacaoId: ORG_A, conversaId: "g", participanteId: "p", usuarioId: USUARIO, unidadeId: UNI_A, unidadesPermitidas: UNIDADES, perfil: PERFIL_FIN, podeValores: true, texto, hoje: HOJE });
  const r1 = await perguntar("me manda todas as contas por fornecedor");
  assert.equal(r1.texto, "Seguem as contas em aberto, agrupadas por fornecedor.");
  assert.equal(r1.blocos.length, 5, "120 contas da página 1 em 5 mensagens");
  assert.equal(linhas(r1.blocos).length, 120);
  const r2 = await perguntar("continuar");
  assert.equal(linhas(r2.blocos).length, 30);
  assert.match(r2.blocos.at(-1), /Lista completa \(150 contas\)/);
});

// ------------------------------------------------------------------- conexões: pool mínimo sem travar (25/11, auditoria)
test("HR-15 leitor com UMA conexão: leituras em paralelo sem token emitido não travam (antes: a transação segurava a conexão esperando a emissão do token, que precisava de outra)", async () => {
  const { criarRepositorioPostgres } = await import("../../src/modules/financeiro-v2/infra/postgres/repositorioPostgres.js");
  const { LEITOR_CONEXOES_POR_INSTANCIA } = await import("../../src/modules/fv2-integracao/mova.js");
  assert.equal(LEITOR_CONEXOES_POR_INSTANCIA * 2 <= 2, true, "duas instâncias no deploy cabem no limite 2 do papel de leitura");
  // pool falso com capacidade 1 e fila (como pg.Pool max 1, sem tempo-limite: a espera seria eterna)
  let livres = 1; let emUso = 0; let pico = 0; const fila = [];
  const pegar = async () => { if (livres > 0) livres--; else await new Promise((ok) => fila.push(ok)); emUso++; pico = Math.max(pico, emUso); };
  const soltar = () => { emUso--; const p = fila.shift(); if (p) p(); else livres++; };
  const E = { organizacaoId: ORG_A, unidadeId: UNI_A, usuarioId: USUARIO };
  const cliente = () => ({ async query(sql) { await new Promise((ok) => { setTimeout(ok, 2); });
    return /fv2_assumir_sessao/.test(sql) ? { rows: [{ u: E.usuarioId, o: E.organizacaoId, n: E.unidadeId }] } : { rows: [] }; }, release: soltar });
  const pool = { async connect() { await pegar(); return cliente(); }, async query() { await pegar(); try { return { rows: [{ t: "tok" }] }; } finally { soltar(); } } };
  let emissoes = 0;
  const repo = criarRepositorioPostgres({ pool, sessoes: { async emitir() { emissoes++; const r = await pool.query(); return r.rows[0].t; } } });
  const ler = () => repo.leitura(async () => "ok", { escopo: E });
  const tudo = Promise.all([ler(), ler(), ler()]);
  const r = await Promise.race([tudo, new Promise((_, n) => { setTimeout(() => n(new Error("TRAVOU: pool preso esperando a emissão do token")), 2000); })]);
  assert.deepEqual(r, ["ok", "ok", "ok"]);
  assert.equal(pico, 1, "nunca mais de uma conexão ao mesmo tempo");
  assert.equal(emissoes, 1, "o token é emitido uma vez e reaproveitado");
});
