// Saldo de abertura NEGATIVO de ponta a ponta, pelos SERVIÇOS reais, em banco DESCARTÁVEL (dados 100% sintéticos).
//   PG_CLUSTER_DIR=<cluster> bash testes-seguros/financeiro-2-0/preparar_banco.sh fin20neg
//   PG_CLUSTER_DIR=<cluster> node testes-seguros/financeiro-2-0/abertura_negativa_integrado.mjs
// Cobre: abertura negativa, entradas/saídas seguintes, saldo final, fluxo mensal, conciliação, relatórios (visão geral, DRE,
// indicadores, categorias, extrato, tabelas), pré-fechamento, isolamento entre organizações e meses anterior/posterior.
process.env.SUPABASE_URL ??= "http://127.0.0.1:9"; process.env.SUPABASE_SERVICE_ROLE_KEY ??= "sb_fake_service_role_key_for_tests_0000000"; process.env.SUPABASE_ANON_KEY ??= "sb_fake_anon_key_for_tests_00000000000000000";
const { criarClienteLocal } = await import("../pg/postgrest_local.mjs");
const repo = await import("../../src/modules/gestao-financeira/dominio/repositorio.js");
const cad = await import("../../src/modules/gestao-financeira/dominio/cadastros.service.js");
const lanc = await import("../../src/modules/gestao-financeira/dominio/lancamentos.service.js");
const rel = await import("../../src/modules/gestao-financeira/dominio/relatorios.service.js");
const per = await import("../../src/modules/gestao-financeira/dominio/periodos.service.js");
const conc = await import("../../src/modules/gestao-financeira/dominio/conciliacao.service.js");
const tab = await import("../../src/modules/gestao-financeira/dominio/tabelas.service.js");
const db = criarClienteLocal({ banco: process.env.FIN20_BANCO ?? "fin20neg" });
const deps = { repo, db };
const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = { organizacaoId: u(1), unidadeId: u(2), usuarioId: u(901) }, B = { organizacaoId: u(4), unidadeId: u(5), usuarioId: u(902) };
let np = 0, nf = 0;
const ok = (id, cond, txt, extra = "") => { if (cond) { np++; console.log(`PASS ${id} ${txt}`); } else { nf++; console.log(`FAIL ${id} ${txt} :: ${extra}`); } };
const tenta = async (id, txt, fn) => { try { const r = await fn(); ok(id, true, txt); return r; } catch (e) { ok(id, false, txt, e.message); return null; } };

// ---- dados sintéticos ----
const rec = await cad.criarCategoria(A, { nome: "RECEITA SINT", tipo: "RECEITA", natureza: "VARIAVEL", papel: "receita_operacional" }, deps);
const desp = await cad.criarCategoria(A, { nome: "DESPESA SINT", tipo: "DESPESA", natureza: "FIXA", papel: "despesa_fixa" }, deps);
const banco = await cad.criarConta(A, { nome: "BANCO SINT", tipoConta: "banco" }, deps);
const plat = await cad.criarConta(A, { nome: "PLATAFORMA SINT", tipoConta: "carteira_plataforma" }, deps);
await cad.definirAbertura(A, { contaId: banco.id, dataReferencia: "2026-09-01", valor: "100,00" }, deps);
await tenta("N01", "abertura NEGATIVA aceita no cadastro (−524,33)", () => cad.definirAbertura(A, { contaId: plat.id, dataReferencia: "2026-09-01", valor: "-524,33" }, deps));
const L = (b) => lanc.criarLancamento(A, { status: "realizado", ...b }, deps);
await L({ contaId: plat.id, categoriaId: rec.id, descricao: "repasse", sentido: "entrada", valor: "524,34", dataMovimento: "2026-09-10" });
await L({ contaId: banco.id, categoriaId: desp.id, descricao: "aluguel", sentido: "saida", valor: "30,00", dataMovimento: "2026-09-15" });
await L({ contaId: banco.id, categoriaId: rec.id, descricao: "venda", sentido: "entrada", valor: "50,00", dataMovimento: "2026-10-05" });
await L({ contaId: plat.id, categoriaId: desp.id, descricao: "taxa", sentido: "saida", valor: "0,50", dataMovimento: "2026-10-06" });
// outra organização, com abertura positiva
const recB = await cad.criarCategoria(B, { nome: "RECEITA B", tipo: "RECEITA", natureza: "VARIAVEL", papel: "receita_operacional" }, deps);
const contaB = await cad.criarConta(B, { nome: "BANCO B", tipoConta: "banco" }, deps);
await cad.definirAbertura(B, { contaId: contaB.id, dataReferencia: "2026-09-01", valor: "7,77" }, deps);
await lanc.criarLancamento(B, { contaId: contaB.id, categoriaId: recB.id, descricao: "venda B", sentido: "entrada", valor: "1,00", dataMovimento: "2026-09-02", status: "realizado" }, deps);

const SET = { de: "2026-09-01", ate: "2026-09-30" }, OUT = { de: "2026-10-01", ate: "2026-10-31" }, AGO = { de: "2026-08-01", ate: "2026-08-31" };
const saldo = (vg, id) => vg?.saldosPorConta?.contas?.find((c) => c.contaId === id)?.saldoCentavos;

// ---- setembro (mês da abertura) ----
const vg = await tenta("N02", "visão geral de setembro não quebra", () => rel.visaoGeral(A, SET, deps));
ok("N03", saldo(vg, plat.id) === 1, "saldo da plataforma = −524,33 + 524,34 = 0,01", saldo(vg, plat.id));
ok("N04", saldo(vg, banco.id) === 7000 && vg?.saldosPorConta?.totalCentavos === 7001, "banco 70,00 e total consolidado 70,01", JSON.stringify(vg?.saldosPorConta?.totalCentavos));
const ind = await tenta("N05", "indicadores de setembro não quebram", () => rel.indicadores(A, SET, deps));
const iv = (id) => ind?.itens?.find((x) => x.id === id)?.valor?.centavos;
ok("N06", iv("saldoFinal") === 7001 && iv("variacaoCaixa") === 49434, "saldo final 70,01; variação do caixa 494,34 (exclui a abertura)", `${iv("saldoFinal")} / ${iv("variacaoCaixa")}`);
const dre = await tenta("N07", "DRE de setembro não quebra", () => rel.dre(A, SET, deps));
ok("N08", dre?.resumo?.ponteFecha === true, "ponte resultado → caixa fecha com abertura negativa", JSON.stringify(dre?.resumo));
ok("N09", dre?.linhas?.find((l) => l.id === "receita")?.centavos === 52434, "abertura NÃO entra como receita nem como despesa");
await tenta("N10", "ranking de categorias de setembro não quebra", () => rel.categorias(A, SET, deps));
const ext = await tenta("N11", "extrato da plataforma não quebra", () => rel.extratoConta(A, plat.id, SET, deps));
ok("N12", ext?.aberturaCentavos === -52433, "extrato mostra a abertura negativa como saldo inicial", ext?.aberturaCentavos);

// ---- outubro (posterior) e agosto (anterior) ----
const vgO = await tenta("N13", "visão geral de outubro (posterior à abertura) não quebra", () => rel.visaoGeral(A, OUT, deps));
ok("N14", saldo(vgO, plat.id) === -49 && saldo(vgO, banco.id) === 12000, "outubro: plataforma −0,49 e banco 120,00 (carregam a abertura)", `${saldo(vgO, plat.id)} / ${saldo(vgO, banco.id)}`);
await tenta("N15", "indicadores e DRE de outubro não quebram", async () => { await rel.indicadores(A, OUT, deps); await rel.dre(A, OUT, deps); });
const vgA = await tenta("N16", "agosto (anterior à abertura) não quebra", () => rel.visaoGeral(A, AGO, deps));
ok("N17", vgA != null, "agosto responde (sem lançamentos)");
await tenta("N18", "DRE de setembro comparado com outubro não quebra", () => rel.dre(A, { ...SET, compararDe: OUT.de, compararAte: OUT.ate }, deps));

// ---- fluxo mensal / tabelas, conciliação, pré-fechamento ----
const cat = await tab.catalogo(A);
const ids = (Array.isArray(cat) ? cat : cat?.itens ?? cat?.tabelas ?? []).map((t) => t.id ?? t).filter(Boolean);
let falhasTab = [];
for (const id of ids) { try { await tab.gerar(A, id, { ...SET }, deps); await tab.gerar(A, id, { ...OUT }, deps); } catch (e) { falhasTab.push(`${id}: ${e.message}`); } }
ok("N19", ids.length > 0 && falhasTab.length === 0, `todas as ${ids.length} tabelas (fluxo mensal, saldos…) geram em setembro e outubro`, falhasTab.join(" | "));
await tenta("N20", "conciliação de setembro calcula", () => conc.calcularMes(A, "2026-09", deps));
await tenta("N21", "pré-fechamento de setembro não quebra", () => per.preFechamento(A, "2026-09", deps));

// ---- isolamento ----
const vgB = await tenta("N22", "organização B consulta normalmente", () => rel.visaoGeral(B, SET, deps));
ok("N23", vgB?.saldosPorConta?.totalCentavos === 877 && vgB?.saldosPorConta?.contas?.length === 1, "B só vê a própria conta (7,77 + 1,00); nada da abertura negativa de A", JSON.stringify(vgB?.saldosPorConta?.totalCentavos));
ok("N24", !vg?.saldosPorConta?.contas?.some((c) => c.contaId === contaB.id), "A não vê a conta de B");
let negou = false; try { await rel.extratoConta(B, plat.id, SET, deps); } catch { negou = true; }
ok("N25", negou, "B não acessa o extrato da conta de A");

console.log(`\nRESUMO: ${np} PASS, ${nf} FAIL`); process.exit(nf ? 1 : 0);
