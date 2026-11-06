// E2E do Financeiro 2.0: HTTP → GATE REAL (requireFinanceiro + autorizarAcaoFinanceira) → ROTAS REAIS → SERVIÇOS REAIS → REPOSITÓRIO REAL
// → PostgreSQL LOCAL DESCARTÁVEL (cliente postgrest_local, como service_role). Dados 100% sintéticos. Só loopback.
// A "sessão" é simulada por cabeçalhos x-teste-* (só neste roteiro): o que se testa é o que vem DEPOIS dela (gate, matriz, domínio, banco).
//   bash backend/testes-seguros/financeiro-2-0/preparar_banco.sh fin20e2e
//   PG_CLUSTER_DIR=~/pg-descartavel node backend/testes-seguros/financeiro-2-0/e2e_http.mjs
process.env.SUPABASE_URL = "http://127.0.0.1:9";                       // nunca usado: o repositório recebe o cliente local por injeção
process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_fake_service_role_key_for_tests_0000000";
process.env.SUPABASE_ANON_KEY = "sb_fake_anon_key_for_tests_00000000000000000";
// feature flag: as DUAS empresas sintéticas ficam liberadas para as provas de isolamento (uma não pode ver a outra mesmo com o flag ligado);
// nas provas E40–E42 a Org B sai da lista (o flag é relido a cada requisição) para provar que, fora dela, as rotas novas não existem.
process.env.FINANCEIRO_2_ORGANIZACOES = "00000000-0000-4000-8000-000000000001,00000000-0000-4000-8000-000000000004";
const { default: express } = await import("express");
const { requireFinanceiro, autorizarAcaoFinanceira } = await import("../../src/middlewares/financeiro.js");
const { errorHandler } = await import("../../src/middlewares/errorHandler.js");
const { criarDominioRouter } = await import("../../src/modules/gestao-financeira/dominio/rotas.js");
const repositorio = await import("../../src/modules/gestao-financeira/dominio/repositorio.js");
const { criarClienteLocal } = await import("../pg/postgrest_local.mjs");

const db = criarClienteLocal({ banco: process.env.FIN20_BANCO ?? "fin20e2e" });
const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG_A = u(1), UNI_A = u(2), UNI_A2 = u(3), ORG_B = u(4), UNI_B = u(5);
const USUARIOS = { admin: u(91), gerente: u(92), contadora: u(93), operador: u(94), leitor: u(95) };
const NIVEL = { admin: "administrador", gerente: "gestor", contadora: "contador", operador: "operador", leitor: "leitura" };

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { id: req.get("x-teste-usuario") }; req.tenant = { organizacaoId: req.get("x-teste-org"), unidadeId: req.get("x-teste-unidade") };
  req.acesso = { perfilId: req.get("x-teste-usuario"), impersonando: false, papel: "organization_admin" };
  next();
});
app.use((req, res, next) => requireFinanceiro({
  moduloEmpresa: async () => true, moduloUnidade: async () => true,
  concessao: async () => ({ organizacao_id: req.tenant.organizacaoId, unidade_id: req.tenant.unidadeId, nivel: req.get("x-teste-nivel"), somente_financeiro: false, revogada_em: null, expira_em: null }),
})(req, res, next));
app.use(criarDominioRouter({ autorizar: autorizarAcaoFinanceira, deps: { repo: repositorio, db } }));
app.use(errorHandler);
const srv = app.listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

async function api(quem, metodo, caminho, corpo, { org = ORG_A, unidade = UNI_A } = {}) {
  const r = await fetch(BASE + caminho, { method: metodo, headers: { "content-type": "application/json", "x-teste-usuario": USUARIOS[quem], "x-teste-nivel": NIVEL[quem], "x-teste-org": org, "x-teste-unidade": unidade }, body: corpo ? JSON.stringify(corpo) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j.data, erro: j.error, codigo: j.codigo ?? j.details?.codigo ?? j.code };
}
let np = 0, nf = 0;
const ok = (id, desc, cond, info = "") => { if (cond) { np++; console.log(`PASS ${id} ${desc}`); } else { nf++; console.log(`FAIL ${id} ${desc} :: ${typeof info === "string" ? info : JSON.stringify(info).slice(0, 400)}`); } };
const espera = (r, st) => r.status === st;

// ---------------- cadastros (administrador) ----------------
const cat = async (nome, papel, tipo = "DESPESA", natureza = "VARIAVEL", ctx) => (await api("admin", "POST", "/plano-contas", { tipo, natureza, nome, papel }, ctx)).data?.id;
const CAT_EMB = await cat("EMBALAGENS", "despesa_variavel");
const CAT_INS = await cat("INSUMOS", "custo_variavel", "CUSTO");
await cat("ENTRE CONTAS", "transferencia", "TRANSFERENCIA", "ENTRE CONTAS");
const conta = async (nome, tipoConta, ctx) => (await api("admin", "POST", "/contas", { nome, tipoConta }, ctx)).data?.id;
const BANCO = await conta("BANCO SINTÉTICO", "banco");
const CAIXA = await conta("CAIXA SINTÉTICO", "caixa_fisico");
const CAT_B = await cat("INSUMOS B", "custo_variavel", "CUSTO", "VARIAVEL", { org: ORG_B, unidade: UNI_B });
const BANCO_B = await conta("BANCO B", "banco", { org: ORG_B, unidade: UNI_B });
ok("E00", "cadastros sintéticos criados pelos serviços reais", CAT_EMB && CAT_INS && BANCO && CAIXA && CAT_B && BANCO_B);

// ---------------- registro provisório e permissões ----------------
let r = await api("operador", "POST", "/contas-pagar", { fornecedorNome: "Embalagens Sintéticas", categoriaId: CAT_EMB, descricao: "Copos e tampas", competencia: "2026-09", vencimento: "2026-09-12", valorOriginal: "810,00", pagamento: { contaId: BANCO, data: "2026-09-18", valor: "832,41" } });
const CP1 = r.data?.id;
ok("E01", "operador registra conta + pagamento: nasce PROVISÓRIA, aberta, 'quitação pendente', sem diferença calculada", espera(r, 201) && r.data.provisoria === true && r.data.status === "aberta" && r.data.situacao === "quitacao_pendente" && r.data.diferencaCentavos === null, r);
ok("E01b", "(revisão #5) o PAGAMENTO registrado pelo operador também nasce provisório", r.data?.pagamentos?.[0]?.provisorio === true, r.data?.pagamentos);
r = await api("operador", "POST", "/contas-pagar", { fornecedorNome: "Embalagens Sintéticas", categoriaId: CAT_EMB, competencia: "2026-09", vencimento: "2026-09-12", valorOriginal: "10,00", quitar: true, pagamento: { contaId: BANCO, data: "2026-09-12", valor: "10,00" } });
ok("E02", "operador NÃO confirma quitação no cadastro (403)", espera(r, 403), r);
r = await api("operador", "POST", `/contas-pagar/${CP1}/quitar`);
ok("E02b", "operador NÃO quita (403 — falta 'conciliar')", espera(r, 403), r);
r = await api("gerente", "POST", `/contas-pagar/${CP1}/quitar`);
ok("E03", "gerente quita: 832,41 − 810,00 = R$ 22,41 (277 bps = 2,77%), 'juros/acréscimo presumido', registro confirmado", espera(r, 200) && r.data.status === "quitada" && r.data.provisoria === false && r.data.diferencaCentavos === 2241 && r.data.percentualBps === 277 && r.data.natureza === "presumido", r);
ok("E03b", "(revisão #5) a quitação pelo gerente confirma o pagamento provisório", r.data?.pagamentos?.every((p) => p.provisorio === false), r.data?.pagamentos);
r = await api("gerente", "POST", `/contas-pagar/${CP1}/classificar`, { classificacao: "juros" });
ok("E04", "gerente NÃO classifica acréscimo (403 — só contadora/administrador)", espera(r, 403), r);
r = await api("operador", "POST", `/contas-pagar/${CP1}/classificar`, { classificacao: "juros" });
ok("E04b", "operador NÃO classifica (403)", espera(r, 403), r);
r = await api("contadora", "POST", `/contas-pagar/${CP1}/classificar`, { classificacao: "juros" });
ok("E05", "contadora classifica como juros", espera(r, 200) && r.data.natureza === "juros", r);
r = await api("contadora", "POST", "/contas-pagar", { fornecedorNome: "X", categoriaId: CAT_EMB, competencia: "2026-09", vencimento: "2026-09-12", valorOriginal: "1,00" });
ok("E06", "contadora não registra contas (403 — sem 'lancar')", espera(r, 403), r);
const rl = await api("leitor", "GET", "/contas-pagar?mes=2026-09");
r = await api("leitor", "POST", "/contas-pagar", { fornecedorNome: "X", categoriaId: CAT_EMB, competencia: "2026-09", vencimento: "2026-09-12", valorOriginal: "1,00" });
ok("E07", "leitor consulta (200) mas não registra (403)", espera(rl, 200) && espera(r, 403), { rl: rl.status, r: r.status });
r = await api("admin", "POST", `/contas-pagar/${CP1}/classificar`, { classificacao: "multa" });
ok("E08", "administrador classifica (multa)", espera(r, 200) && r.data.natureza === "multa", r);

// ---------------- isolamento ----------------
r = await api("admin", "GET", `/contas-pagar/${CP1}`, null, { org: ORG_B, unidade: UNI_B });
const lb = await api("admin", "GET", "/contas-pagar", null, { org: ORG_B, unidade: UNI_B });
ok("E09", "outra EMPRESA não enxerga a conta (404) nem na lista", espera(r, 404) && lb.data.itens.every((i) => i.id !== CP1), { r: r.status, n: lb.data?.itens?.length });
r = await api("admin", "GET", `/contas-pagar/${CP1}`, null, { unidade: UNI_A2 });
const la2 = await api("admin", "GET", "/contas-pagar", null, { unidade: UNI_A2 });
ok("E10", "outra UNIDADE da mesma empresa não enxerga a conta (404) nem na lista", espera(r, 404) && la2.data.itens.length === 0, { r: r.status });
r = await api("admin", "POST", `/contas-pagar/${CP1}/quitar`, null, { org: ORG_B, unidade: UNI_B });
ok("E10b", "ação sobre conta de outro tenant: 404 (não revela existência)", espera(r, 404), r);
r = await api("operador", "POST", "/contas-pagar", { organizacaoId: ORG_B, unidadeId: UNI_B, fornecedorNome: "Forjado", categoriaId: CAT_EMB, competencia: "2026-09", vencimento: "2026-09-30", valorOriginal: "5,00" });
const lb2 = await api("admin", "GET", "/contas-pagar", null, { org: ORG_B, unidade: UNI_B });
const la = await api("admin", "GET", `/contas-pagar/${r.data?.id}`);
ok("E11", "organização/unidade no CORPO são ignoradas: grava no contexto do gate", espera(r, 201) && lb2.data.itens.length === 0 && espera(la, 200), { r: r.status, b: lb2.data?.itens?.length });
r = await api("operador", "POST", "/contas-pagar", { fornecedorNome: "Fornecedor B", categoriaId: CAT_B, competencia: "2026-09", vencimento: "2026-09-30", valorOriginal: "5,00" });
ok("E11b", "categoria de OUTRA empresa recusada", espera(r, 400), r);
r = await api("operador", "POST", "/contas-pagar", { fornecedorNome: "Y", categoriaId: CAT_EMB, competencia: "2026-09", vencimento: "2026-09-30", valorOriginal: "5,00", pagamento: { contaId: BANCO_B, data: "2026-09-30", valor: "5,00" } });
ok("E11c", "conta bancária de OUTRA empresa recusada (antes de gravar a obrigação)", espera(r, 400), r);

// ---------------- regras de cálculo pela API ----------------
r = await api("gerente", "POST", "/contas-pagar", { fornecedorNome: "Laticínios Sintéticos", categoriaId: CAT_INS, descricao: "Coberturas (duas parcelas)", competencia: "2026-09", vencimento: "2026-09-15", valorOriginal: "2000", pagamento: { contaId: BANCO, data: "2026-09-10", valor: "1200" } });
const CP2 = r.data?.id;
ok("E12a", "pagamento parcial de 1.200 sobre 2.000: aberta, saldo 800, SEM diferença", espera(r, 201) && r.data.saldoAbertoCentavos === 80000 && r.data.diferencaCentavos === null, r);
r = await api("gerente", "POST", `/contas-pagar/${CP2}/pagamentos`, { contaId: BANCO, data: "2026-09-25", valor: "800", quitar: true });
ok("E12b", "2º pagamento (800) com quitação: diferença ZERO, nada a classificar", espera(r, 201) && r.data.status === "quitada" && r.data.diferencaCentavos === 0 && r.data.natureza === null, r);
r = await api("gerente", "POST", "/contas-pagar", { fornecedorNome: "Folha Sintética", categoriaId: CAT_INS, descricao: "Diárias", competencia: "2026-09", vencimento: "2026-09-05", valorOriginal: "1500", pagamento: { contaId: CAIXA, data: "2026-09-05", valor: "900" } });
const CP3 = r.data?.id;
const l3 = (await api("gerente", "GET", "/contas-pagar?mes=2026-09")).data.itens.find((i) => i.id === CP3);
ok("E13", "parcial (900 de 1.500) vencido: 'parcial_vencida', nunca desconto", l3?.situacao === "parcial_vencida" && l3.natureza === null && l3.saldoAbertoCentavos === 60000, l3);
r = await api("gerente", "POST", "/contas-pagar", { fornecedorNome: "Contabilidade Sintética", categoriaId: CAT_EMB, competencia: "2026-09", vencimento: "2026-09-15", valorOriginal: "640", quitar: true, pagamento: { contaId: BANCO, data: "2026-09-15", valor: "610" } });
const CP4 = r.data?.id;
ok("E14a", "pago a menor e quitado: 'a verificar' (−30,00), não vira desconto sozinho", espera(r, 201) && r.data.natureza === "a_verificar" && r.data.diferencaCentavos === -3000, r);
r = await api("contadora", "POST", `/contas-pagar/${CP4}/classificar`, { classificacao: "juros" });
ok("E14b", "classificar pagamento a menor como juros: recusado pelo banco (400)", espera(r, 400) && /incompat/i.test(r.erro ?? ""), r);
r = await api("operador", "PATCH", `/contas-pagar/${CP2}`, { observacoes: "nota do operador" });
const r2 = await api("operador", "PATCH", `/contas-pagar/${CP3}`, { valorOriginal: "1600" });
ok("E15", "operador: observação não muda nada; alterar VALOR de conta confirmada a devolve a PROVISÓRIA", espera(r, 200) && r.data.provisoria === false && espera(r2, 200) && r2.data.provisoria === true, { a: r.data?.provisoria, b: r2.data?.provisoria });
r = await api("operador", "PATCH", `/contas-pagar/${CP1}`, { valorOriginal: "900" });
ok("E15b", "operador não altera valor de conta QUITADA (403); e nem o gerente (banco recusa: 400)", espera(r, 403) && espera(await api("gerente", "PATCH", `/contas-pagar/${CP1}`, { valorOriginal: "900" }), 400), r);

// ---------------- conciliação de saídas ----------------
const lanc = async (valor, data, conta = BANCO, categoriaId = CAT_EMB, descricao = "PIX FORNECEDOR (extrato sintético)") => (await api("admin", "POST", "/lancamentos", { contaId: conta, categoriaId, descricao, sentido: "saida", valor, dataMovimento: data })).data?.id;
const S1 = await lanc("832,41", "2026-09-18");               // exata (1:1)
await api("gerente", "POST", "/contas-pagar", { fornecedorNome: "Hortifruti Sintético", categoriaId: CAT_INS, competencia: "2026-09", vencimento: "2026-09-25", valorOriginal: "300", pagamento: { contaId: BANCO, data: "2026-09-25", valor: "300" }, quitar: true });
await api("gerente", "POST", "/contas-pagar", { fornecedorNome: "Hortifruti Sintético", categoriaId: CAT_INS, competencia: "2026-09", vencimento: "2026-09-25", valorOriginal: "200", pagamento: { contaId: BANCO, data: "2026-09-25", valor: "200" }, quitar: true });
const S2 = await lanc("500", "2026-09-26");                   // agrupada (300 + 200)
const S3 = await lanc("912,50", "2026-09-06", CAIXA);         // divergente do pagamento de 900
r = await api("operador", "POST", "/conciliacao-saidas/sugerir", { mes: "2026-09" });
ok("E19", "operador não roda sugestões (403)", espera(r, 403), r);
r = await api("gerente", "POST", "/conciliacao-saidas/sugerir", { mes: "2026-09" });
let p = (await api("gerente", "GET", "/conciliacao-saidas?mes=2026-09")).data;
ok("E16", "motor cria sugestões 1:1 e agrupada (2 grupos)", espera(r, 200) && r.data.sugestoesCriadas === 2 && p.grupos.some((g) => g.agrupado && g.saida.id === S2), r.data);
ok("E17", "NENHUMA sugestão nasce conciliada (contagem conciliado = 0)", p.contagem.conciliado === 0 && p.contagem.sugerido === 2, p.contagem);
r = await api("gerente", "POST", "/conciliacao-saidas/sugerir", { mes: "2026-09" });
ok("E18", "rodar de novo não duplica (0 novas) — idempotente", espera(r, 200) && r.data.sugestoesCriadas === 0, r.data);
const gExato = p.grupos.find((g) => g.saida.id === S1)?.grupo, gAgr = p.grupos.find((g) => g.saida.id === S2)?.grupo;
r = await api("leitor", "POST", `/conciliacao-saidas/${gExato}/confirmar`, {});
ok("E19b", "leitor não confirma (403)", espera(r, 403), r);
r = await api("gerente", "POST", `/conciliacao-saidas/${gExato}/confirmar`, {});
ok("E20", "gerente confirma: conciliado com evidência (id do extrato e do pagamento)", espera(r, 200) && r.data.evidencia?.lancamento?.id === S1 && r.data.evidencia?.pagamentos?.length === 1, r);
r = await api("contadora", "POST", `/conciliacao-saidas/${gAgr}/confirmar`, {});
ok("E20b", "contadora confirma o agrupado (1 dia de diferença está na tolerância)", espera(r, 200), r);
const pag900 = (await api("gerente", "GET", `/contas-pagar/${CP3}`)).data.pagamentos[0].id;
r = await api("gerente", "POST", "/conciliacao-saidas/vincular", { lancamentoId: S3, pagamentoIds: [pag900] });
const gDiv = r.data?.grupo;
ok("E21", "vínculo manual 900,00 × 912,50: fica DIVERGENTE (fora da tolerância)", espera(r, 201) && r.data.status === "divergente" && r.data.diferencaCentavos === 1250, r);
p = (await api("gerente", "GET", "/conciliacao-saidas?mes=2026-09")).data;
ok("E21b", "painel: 2 conciliados, 1 divergente", p.contagem.conciliado === 2 && p.contagem.divergente === 1, p.contagem);

// ---------------- fechamento ----------------
let pre = (await api("gerente", "GET", "/periodos/2026-09/pre-fechamento")).data;
const blq = pre?.avaliacao?.bloqueios?.find((b) => b.codigo === "DIVERGENCIAS_CONTAS_PAGAR");
ok("E22", "pré-fechamento lista as divergências bloqueadoras (divergência + a verificar + provisória)", pre?.avaliacao?.pode === false && blq && ["divergencia_conciliacao", "pago_a_menor_a_verificar", "registro_provisorio"].every((t) => blq.itens.some((i) => i.tipo === t)), blq);
r = await api("gerente", "POST", "/periodos/2026-09/fechar", { confirmo: true, versao: pre.periodo.versao, fingerprint: pre.fingerprint });
ok("E23", "fechar com divergências: o BANCO recusa (400 FIN2_DIVERGENCIAS_BLOQUEADORAS)", espera(r, 400) && r.codigo === "FIN2_DIVERGENCIAS_BLOQUEADORAS", r);
r = await api("gerente", "POST", `/conciliacao-saidas/${gDiv}/confirmar`, {});
ok("E24a", "confirmar divergência sem justificativa: recusado (400)", espera(r, 400) && r.codigo === "FIN2_JUSTIFICATIVA_OBRIGATORIA", r);
r = await api("gerente", "POST", `/conciliacao-saidas/${gDiv}/confirmar`, { justificativa: "Tarifa de saque de R$ 12,50 cobrada junto (comprovante anexo)" });
ok("E24b", "com justificativa: conciliado", espera(r, 200), r);
await api("contadora", "POST", `/contas-pagar/${CP4}/classificar`, { classificacao: "desconto" });
await api("gerente", "POST", `/contas-pagar/${CP3}/confirmar-registro`);
const restantes = (await api("admin", "GET", "/contas-pagar?mes=2026-09&situacao=provisoria")).data.itens;
for (const i of restantes) await api("gerente", "POST", `/contas-pagar/${i.id}/confirmar-registro`);
pre = (await api("gerente", "GET", "/periodos/2026-09/pre-fechamento")).data;
ok("E25a", "resolvidas as divergências, o pré-fechamento libera", pre?.avaliacao?.pode === true, pre?.avaliacao);
r = await api("gerente", "POST", "/periodos/2026-09/fechar", { confirmo: true, versao: pre.periodo.versao, fingerprint: pre.fingerprint });
ok("E25b", "setembro fecha", espera(r, 200) && r.data.status === "fechado", r);
r = await api("gerente", "POST", `/contas-pagar/${CP3}/pagamentos`, { contaId: CAIXA, data: "2026-09-29", valor: "100" });
ok("E26", "pagamento em mês FECHADO recusado pelo banco", espera(r, 400) && r.codigo === "FIN_PERIODO_FECHADO", r);
r = await api("admin", "POST", `/contas-pagar/${CP1}/classificar`, { classificacao: "tarifa" });
ok("E26b", "reclassificar acréscimo de mês fechado recusado", espera(r, 400) && r.codigo === "FIN_PERIODO_FECHADO", r);
r = await api("admin", "POST", "/periodos/2026-09/reabrir", { motivo: "Correção solicitada pela contadora" });
ok("E27", "não existe rota de reabertura (decisão LD-009 preservada): 404", espera(r, 404), r);
r = await api("gerente", "POST", `/contas-pagar/${CP3}/pagamentos`, { contaId: CAIXA, data: "2026-10-03", valor: "700", quitar: true });
ok("E27b", "conta de competência setembro (fechada) paga em outubro: aceito; acréscimo vai para outubro", espera(r, 201) && r.data.dataQuitacao === "2026-10-03" && r.data.diferencaCentavos === 0, r);

r = await api("admin", "POST", "/lancamentos", { contaId: BANCO, descricao: "DEBITO SEM IDENTIFICACAO (sintético)", sentido: "saida", valor: "187,90", dataMovimento: "2026-10-02" });
p = (await api("gerente", "GET", "/conciliacao-saidas?mes=2026-10")).data;
ok("E31", "saída do extrato sem pagamento e sem classificação aparece 'A identificar' (não é conciliada nem sugerida)", espera(r, 201) && p.contagem.aIdentificar === 1 && p.aIdentificar[0].valorCentavos === 18790 && p.contagem.sugerido === 0, p.contagem);

// ---------------- juros, resumo e auditoria ----------------
r = await api("leitor", "GET", "/contas-pagar/juros?de=2026-09&ate=2026-09");
ok("E28", "painel de juros (set): multa 22,41; separado de empréstimos; 1 conta paga com atraso", espera(r, 200) && r.data.totais.multaCentavos === 2241 && r.data.totais.presumidoCentavos === 0 && r.data.contasPagasComAtraso === 1 && r.data.natureza === "contas_a_pagar", r.data?.totais);
r = await api("leitor", "GET", "/contas-pagar/resumo?mes=2026-09");
ok("E29", "resumo do mês para a Visão Geral (sem bloqueios após o fechamento)", espera(r, 200) && Array.isArray(r.data.bloqueiosFechamento) && r.data.bloqueiosFechamento.length === 0 && r.data.juros.totalCentavos === 2241, r.data);
r = await api("gerente", "GET", `/contas-pagar/${CP1}`);
const acoes = (r.data?.historico ?? []).map((h) => h.acao);
ok("E30", "histórico de auditoria da conta: criação, quitação e classificações", espera(r, 200) && acoes.filter((a) => a === "fin_obrigacoes.update").length >= 3 && acoes.includes("fin_obrigacoes.insert"), acoes);
r = await api("operador", "GET", "/auditoria?entidade=fin_conciliacao_saidas");
ok("E30b", "trilha de auditoria da conciliação disponível (com evidência)", espera(r, 200) && r.data.some((a) => a.depois?.status === "conciliado" && a.depois?.evidencia), r.status);

// ---------------- feature flag ----------------
process.env.FINANCEIRO_2_ORGANIZACOES = ORG_A;
r = await api("admin", "GET", "/contas-pagar", null, { org: ORG_B, unidade: UNI_B });
const rf = await api("admin", "POST", "/conciliacao-saidas/sugerir", { mes: "2026-09" }, { org: ORG_B, unidade: UNI_B });
ok("E40", "empresa FORA do flag: rotas do Financeiro 2.0 respondem 404 (FINANCEIRO_2_DESABILITADO), leitura e escrita", espera(r, 404) && r.codigo === "FINANCEIRO_2_DESABILITADO" && espera(rf, 404), { r: r.status, rf: rf.status });
r = await api("admin", "GET", "/periodos/2026-09/pre-fechamento", null, { org: ORG_B, unidade: UNI_B });
ok("E41", "empresa FORA do flag: financeiro anterior intacto (pré-fechamento responde, sem consultar a 151)", espera(r, 200) && !r.data.avaliacao.bloqueios.some((b) => b.codigo === "DIVERGENCIAS_CONTAS_PAGAR"), r.status);
r = await api("admin", "GET", "/lancamentos", null, { org: ORG_B, unidade: UNI_B });
ok("E42", "empresa FORA do flag: lançamentos do financeiro anterior respondem normalmente", espera(r, 200), r.status);

srv.close();
console.log(`\nRESUMO: ${np} PASS, ${nf} FAIL`);
process.exit(nf ? 1 : 0);
