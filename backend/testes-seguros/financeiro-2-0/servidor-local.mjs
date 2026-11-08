// APLICAÇÃO LOCAL do Financeiro 2.0 (somente desenvolvimento): frontend REAL + gate REAL + domínio REAL + PostgreSQL LOCAL DESCARTÁVEL.
// Dados 100% SINTÉTICOS, semeados pelos próprios serviços. Sessão/Supabase falsos e só loopback (como servidor-qa-integrado.mjs).
//   bash backend/testes-seguros/financeiro-2-0/preparar_banco.sh fin20app
//   PG_CLUSTER_DIR=~/pg-descartavel node backend/testes-seguros/financeiro-2-0/servidor-local.mjs [porta]    (padrão 4180)
//   Perfil: /qa/nivel?n=administrador|gestor|contador|operador|leitura      Unidade: troque no próprio app (Loja Centro tem dados; Loja Norte está vazia)
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_fake_service_role_key_for_tests_0000000";
process.env.SUPABASE_ANON_KEY = "sb_fake_anon_key_for_tests_00000000000000000";
// MODO DADOS EXISTENTES (só local): FIN20_BANCO=fin20xxx FIN20_ORG=<uuid> FIN20_UNIDADE=<uuid> FIN20_EMPRESA="nome" → usa o banco descartável já
// carregado (ex.: cópia local de uma empresa) SEM semear dados sintéticos. Sem essas variáveis, comportamento original (sintético).
const EXISTENTE = Boolean(process.env.FIN20_ORG && process.env.FIN20_UNIDADE);
if (EXISTENTE && !/^fin20[a-z0-9_]*$/.test(process.env.FIN20_BANCO ?? "")) { console.error("RECUSADO: modo dados existentes exige FIN20_BANCO=fin20*"); process.exit(2); }
process.env.FINANCEIRO_2_ORGANIZACOES = EXISTENTE ? process.env.FIN20_ORG : "00000000-0000-4000-8000-000000000001";   // feature flag: só a empresa sintética (/qa/fin2?on=0 desliga)
const { default: express } = await import("express");
const path = await import("node:path");
const { readFileSync } = await import("node:fs");
const { fileURLToPath } = await import("node:url");
const { requireFinanceiro, autorizarAcaoFinanceira, resolverAcessoFinanceiro } = await import("../../src/middlewares/financeiro.js");
const { PERM_FIN, permissoesDoNivelFinanceiro } = await import("../../src/shared/gestaoFinanceira.permissoes.js");
const { calcularSetores } = await import("../../src/shared/setores.js");
const { errorHandler } = await import("../../src/middlewares/errorHandler.js");
const { criarDominioRouter } = await import("../../src/modules/gestao-financeira/dominio/rotas.js");
const repositorio = await import("../../src/modules/gestao-financeira/dominio/repositorio.js");
const cadastros = await import("../../src/modules/gestao-financeira/dominio/cadastros.service.js");
const lanc = await import("../../src/modules/gestao-financeira/dominio/lancamentos.service.js");
const obr = await import("../../src/modules/gestao-financeira/dominio/obrigacoes.service.js");
const cs = await import("../../src/modules/gestao-financeira/dominio/conciliacaoSaidas.service.js");
const per = await import("../../src/modules/gestao-financeira/dominio/periodos.service.js");
const { criarClienteLocal } = await import("../pg/postgrest_local.mjs");
const { financeiro2Habilitado } = await import("../../src/shared/financeiro2.flag.js");

const aqui = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(aqui, "..", "..", "..", "frontend");
const PORTA = Number(process.argv[2]) || 4180;
const db = criarClienteLocal({ banco: process.env.FIN20_BANCO ?? "fin20app" });
// Relatório de vendas por canal (opcional, só local): FIN20_VENDAS_CANAIS=<arquivo.json> com { "AAAA-MM": [{ "origem": "...", "centavos": 123, "pedidos": 0 }] }.
// Sem o arquivo, a composição por canal fica indisponível (a tela explica o que falta). O arquivo fica FORA do repositório (valores reais).
const { existsSync } = await import("node:fs");
const arqCanais = process.env.FIN20_VENDAS_CANAIS;
const vendasPorCanal = arqCanais && existsSync(arqCanais) ? JSON.parse(readFileSync(arqCanais, "utf8")) : {};
// Referências oficiais (apresentação da contadora) só para COMPARAR na Central de Conferências: FIN20_REFERENCIAS_OFICIAIS=<arquivo.json> { "AAAA-MM": [{ indicador, rotulo, valorCentavos, fonte }] }. Fora do repositório.
const arqRefs = process.env.FIN20_REFERENCIAS_OFICIAIS;
const refsOficiais = arqRefs && existsSync(arqRefs) ? JSON.parse(readFileSync(arqRefs, "utf8")) : {};
const deps = { repo: { ...repositorio, listarVendasPorCanal: async (_c, { mes }) => vendasPorCanal[mes] ?? [], listarReferenciasOficiais: async (_c, { mes }) => refsOficiais[mes] ?? [] }, db };
const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = EXISTENTE ? process.env.FIN20_ORG : u(1), UNI_C = EXISTENTE ? process.env.FIN20_UNIDADE : u(2), UNI_N = u(3), USER = u(6), PERFIL = u(7);
const EMPRESA_SINT = "Açaí no Grau (dados SINTÉTICOS)";
const EMPRESA = EXISTENTE ? `${process.env.FIN20_EMPRESA ?? "Empresa"} (cópia LOCAL)` : EMPRESA_SINT;
const UNIDADES = EXISTENTE ? [{ id: UNI_C, nome: `${process.env.FIN20_EMPRESA ?? "Unidade"} (cópia local)`, ativo: true }] : [{ id: UNI_C, nome: "Loja Centro (sintética)", ativo: true }, { id: UNI_N, nome: "Loja Norte (sintética, vazia)", ativo: true }];
const estado = { unidade: UNI_C, nivel: "administrador" };
const ctxC = { organizacaoId: ORG, unidadeId: UNI_C, usuarioId: USER };
const PERMS_ADMIN = permissoesDoNivelFinanceiro("administrador"), PERMS_OPER = permissoesDoNivelFinanceiro("operador");

// ---------------------------------------------------------------- dados sintéticos (via serviços reais)
async function semear() {
  if ((await obr.listarFornecedores(ctxC, deps)).length) { console.log("[fin20] banco já semeado"); return; }
  const cat = async (tipo, natureza, nome, papel) => (await cadastros.criarCategoria(ctxC, { tipo, natureza, nome, papel }, deps)).id;
  const C = {
    vendas: await cat("RECEITA", "RECEBIMENTO", "VENDAS", "receita_operacional"), frutas: await cat("CUSTO", "VARIAVEL", "FRUTAS E POLPAS", "custo_variavel"),
    emb: await cat("DESPESA", "VARIAVEL", "EMBALAGENS", "despesa_variavel"), energia: await cat("DESPESA", "FIXA", "ENERGIA", "despesa_fixa"),
    aluguel: await cat("DESPESA", "FIXA", "ALUGUEL", "despesa_fixa"), folha: await cat("DESPESA", "PESSOAL", "FOLHA", "despesa_pessoal"),
    servicos: await cat("DESPESA", "FIXA", "SERVIÇOS E CONTABILIDADE", "despesa_fixa"), tarifas: await cat("DESPESA", "FINANCEIRA", "TARIFAS BANCÁRIAS", "despesa_financeira"),
    transf: await cat("TRANSFERENCIA", "ENTRE CONTAS", "ENTRE CONTAS", "transferencia"),
  };
  const conta = async (nome, tipoConta) => (await cadastros.criarConta(ctxC, { nome, tipoConta }, deps)).id;
  const K = { banco: await conta("BANCO SINTÉTICO", "banco"), stone: await conta("ADQUIRENTE SINTÉTICA", "adquirente"), caixa: await conta("CAIXA DA LOJA", "caixa_fisico") };
  await cadastros.definirAbertura(ctxC, { contaId: K.banco, dataReferencia: "2026-08-01", valor: 15000, nota: "saldo sintético" }, deps);
  const entrada = (data, valor) => lanc.criarLancamento(ctxC, { contaId: K.stone, categoriaId: C.vendas, descricao: "Repasse de vendas (sintético)", sentido: "entrada", valor, dataMovimento: data }, deps);
  const saida = (data, valor, contaId, categoriaId, descricao) => lanc.criarLancamento(ctxC, { contaId, categoriaId, descricao, sentido: "saida", valor, dataMovimento: data }, deps);
  /** Conta a pagar sintética: pagamentos [[data, valor, conta, extratoValor?, extratoData?]] (extratoValor=null => sem saída no extrato). */
  async function cp(f, categoria, descricao, comp, venc, valor, pags = [], { quitar = false, classif, operador = false } = {}) {
    const [p0, ...resto] = pags;
    const o = await obr.criar(ctxC, { fornecedorNome: f, categoriaId: C[categoria], descricao, competencia: comp, vencimento: venc, valorOriginal: valor,
      pagamento: p0 ? { data: p0[0], valor: p0[1], contaId: K[p0[2]] } : undefined }, deps, { permissoes: operador ? PERMS_OPER : PERMS_ADMIN });
    for (const p of resto) await obr.registrarPagamento(ctxC, o.id, { data: p[0], valor: p[1], contaId: K[p[2]] }, deps, { permissoes: PERMS_ADMIN });
    if (quitar) await obr.quitar(ctxC, o.id, deps);
    if (classif) await obr.classificar(ctxC, o.id, { classificacao: classif }, deps);
    for (const p of pags) if (p[3] !== null) await saida(p[4] ?? p[0], p[3] ?? p[1], K[p[2]], C[categoria], `PAGTO ${f.toUpperCase()} (extrato sintético)`);
    return o.id;
  }
  async function confirmarSugestoes(mes, manter = 0) {
    await cs.sugerir(ctxC, { mes }, deps);
    const p = await cs.painel(ctxC, { mes }, deps);
    for (const g of p.grupos.filter((x) => x.status === "sugerido").slice(manter)) await cs.confirmar(ctxC, g.grupo, {}, deps);
  }
  // ---- agosto (fechado ao final)
  for (const [d, v] of [["2026-08-04", "18200"], ["2026-08-11", "19400"], ["2026-08-18", "18900"], ["2026-08-25", "20300"]]) await entrada(d, v);
  await cp("Imobiliária Centro (sintética)", "aluguel", "Aluguel agosto", "2026-08", "2026-08-05", "3600", [["2026-08-05", "3600", "banco"]], { quitar: true });
  await cp("Distribuidora de Polpas (sintética)", "frutas", "Polpas e frutas", "2026-08", "2026-08-10", "4600", [["2026-08-10", "4600", "banco"]], { quitar: true });
  await cp("Cia de Energia (sintética)", "energia", "Energia agosto", "2026-08", "2026-08-20", "2100", [["2026-08-24", "2146,20", "banco"]], { quitar: true, classif: "juros" });
  await cp("Folha (sintética)", "folha", "Salários agosto", "2026-08", "2026-08-05", "10900", [["2026-08-05", "10900", "banco"]], { quitar: true });
  await confirmarSugestoes("2026-08");
  const pre = await per.preFechamento(ctxC, "2026-08", deps);
  if (pre.avaliacao.pode) await per.fechar(ctxC, "2026-08", { confirmo: true, versao: pre.periodo.versao, fingerprint: pre.fingerprint }, deps);
  else console.log("[fin20] agosto NÃO fechou:", JSON.stringify(pre.avaliacao.bloqueios));
  // ---- setembro (aberto, com divergências bloqueadoras para demonstração)
  for (const [d, v] of [["2026-09-03", "19800"], ["2026-09-10", "21200"], ["2026-09-17", "20600"], ["2026-09-24", "21600"]]) await entrada(d, v);
  await cp("Embalagens Brasil (sintética)", "emb", "Copos e tampas", "2026-09", "2026-09-12", "810,00", [["2026-09-18", "832,41", "banco"]], { quitar: true });
  await cp("Laticínios do Vale (sintético)", "frutas", "Coberturas (pago em duas vezes)", "2026-09", "2026-09-15", "2000", [["2026-09-10", "1200", "banco"], ["2026-09-25", "800", "banco"]], { quitar: true });
  await cp("Cia de Energia (sintética)", "energia", "Energia setembro", "2026-09", "2026-09-20", "1250", [["2026-09-28", "1293,75", "banco"]], { quitar: true, classif: "multa" });
  await cp("Banco Sintético", "tarifas", "Tarifa de cobrança", "2026-09", "2026-09-22", "90", [["2026-09-22", "98,50", "banco"]], { quitar: true, classif: "tarifa" });
  await cp("Imobiliária Centro (sintética)", "aluguel", "Aluguel setembro", "2026-09", "2026-09-05", "3600", [["2026-09-05", "3600", "banco"]], { quitar: true });
  const folhaSet = await cp("Folha (sintética)", "folha", "Salários setembro (pago parcialmente)", "2026-09", "2026-09-05", "1500", [["2026-09-05", "900", "caixa", null]]);
  await cp("Contabilidade Alfa (sintética)", "servicos", "Honorários setembro", "2026-09", "2026-09-15", "640", [["2026-09-15", "610", "banco"]], { quitar: true });
  await cp("Entregas Rápidas (sintética)", "emb", "Entregas semana 3 (registrada pelo operador)", "2026-09", "2026-09-24", "1380", [["2026-09-24", "1380", "caixa"]], { operador: true });
  await confirmarSugestoes("2026-09");
  const s912 = await saida("2026-09-06", "912,50", K.caixa, C.folha, "PAGTO FOLHA (extrato sintético, valor diferente)");
  const pg900 = (await obr.obter(ctxC, folhaSet, deps)).pagamentos[0].id;
  await cs.vincular(ctxC, { lancamentoId: s912.id, pagamentoIds: [pg900] }, deps);          // fica DIVERGENTE (bloqueia setembro)
  // ---- outubro (mês corrente dos dados: sugestões aguardando, pendentes, a identificar, contas a vencer)
  for (const [d, v] of [["2026-10-01", "20100"], ["2026-10-08", "22300"], ["2026-10-15", "21800"]]) await entrada(d, v);
  await cp("Imobiliária Centro (sintética)", "aluguel", "Aluguel outubro", "2026-10", "2026-10-05", "3600", [["2026-10-05", "3600", "banco"]], { quitar: true });
  await cp("Distribuidora de Polpas (sintética)", "frutas", "Polpas e frutas", "2026-10", "2026-10-10", "5300", [["2026-10-10", "5300", "banco", null]], { quitar: true });
  await cp("Hortifruti (sintético)", "frutas", "Frutas — nota 1", "2026-10", "2026-10-14", "300", [["2026-10-14", "300", "banco", null]], { quitar: true });
  await cp("Hortifruti (sintético)", "frutas", "Frutas — nota 2", "2026-10", "2026-10-14", "200", [["2026-10-14", "200", "banco", null]], { quitar: true });
  await saida("2026-10-15", "500", K.banco, C.frutas, "PIX HORTIFRUTI (extrato sintético, duas notas)");
  await cp("Laticínios do Vale (sintético)", "frutas", "Coberturas outubro", "2026-10", "2026-10-20", "3100");
  await cp("Folha (sintética)", "folha", "Salários outubro", "2026-10", "2026-11-05", "6000");
  await cp("Cia de Energia (sintética)", "energia", "Energia outubro", "2026-10", "2026-11-20", "1300");
  await lanc.criarLancamento(ctxC, { contaId: K.banco, descricao: "DÉBITO NÃO IDENTIFICADO (sintético)", sentido: "saida", valor: "187,90", dataMovimento: "2026-10-09" }, deps);
  await cs.sugerir(ctxC, { mes: "2026-10" }, deps);                                           // fica SUGERIDO, aguardando confirmação humana
  console.log("[fin20] dados sintéticos semeados (agosto fechado; setembro com divergências; outubro corrente)");
}
if (!EXISTENTE) await semear(); else console.log(`[fin20] modo dados existentes: banco ${process.env.FIN20_BANCO}, sem semear`);

// ---------------------------------------------------------------- sessão falsa + gate/domínio reais
const leitor = { moduloEmpresa: async () => true, moduloUnidade: async () => true,
  concessao: async () => ({ organizacao_id: ORG, unidade_id: estado.unidade, nivel: estado.nivel, somente_financeiro: false, revogada_em: null, expira_em: null }) };
const acesso = () => ({ perfilId: PERFIL, impersonando: false, papel: "organization_admin", permissoes: ["dashboard.ver"], modulos: ["dashboard"] });
const ROTULO_NIVEL = { administrador: "Administrador financeiro", gestor: "Gerente", contador: "Contadora", operador: "Operador", leitura: "Leitor" };
function contexto() {
  const un = UNIDADES.find((x) => x.id === estado.unidade) ?? UNIDADES[0]; const a = acesso(); const agora = Date.now();
  return { contextToken: "local-contexto", empresa: { id: ORG, nome: EMPRESA, status: "ativa" }, unidade: { id: un.id, nome: un.nome },
    papel: a.papel, papelRotulo: ROTULO_NIVEL[estado.nivel] ?? "—", permissoes: a.permissoes, modulos: a.modulos, impersonando: false,
    perfil: { id: PERFIL, nome: `Pessoa sintética (${ROTULO_NIVEL[estado.nivel]})` }, expiraEm: new Date(agora + 8 * 3600e3).toISOString(), servidorEm: new Date(agora).toISOString() };
}
const app = express();
app.use(express.json());
app.get("/api/config", (_q, r) => r.json({ supabaseUrl: "http://127.0.0.1:9", supabaseAnonKey: "anon-local" }));
app.get("/qa/supabase-stub.js", (_q, r) => r.type("js").send(readFileSync(path.join(aqui, "..", "qa-visual", "supabase-stub.js"))));
app.all("/qa/nivel", (q, r) => { const n = String(q.query.n ?? ""); if (ROTULO_NIVEL[n]) estado.nivel = n; r.json(estado); });
app.all("/qa/unidade", (q, r) => { if (UNIDADES.some((x) => x.id === q.query.id)) estado.unidade = q.query.id; r.json(estado); });
app.get("/health", (_q, r) => r.json({ ok: true, service: "fin20-local", versao: "local" }));
app.all("/qa/fin2", (q, r) => { process.env.FINANCEIRO_2_ORGANIZACOES = q.query.on === "0" ? "" : ORG; r.json({ financeiro2: process.env.FINANCEIRO_2_ORGANIZACOES === ORG }); });
app.get("/qa/estado", (_q, r) => r.json(estado));
app.get(["/", "/index.html"], (_q, r) => r.type("html").send(readFileSync(path.join(frontend, "index.html"), "utf8").replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2"><\/script>/, '<script src="/qa/supabase-stub.js"></script>')));
const api = express.Router();
api.get("/me", (_q, r) => r.json({ data: { id: USER, nome: "Pessoa sintética", email: "pessoa@exemplo.invalid", superadmin: false, senhaProvisoria: false } }));
api.get("/sessao/perfis", (_q, r) => r.json({ data: [{ id: PERFIL, nome: "Pessoa sintética", temPin: false }] }));
api.get("/sessao/acessos", (_q, r) => r.json({ data: { opcoes: [{ organizacaoId: ORG, unidadeId: UNI_C, empresaNome: EMPRESA, unidadeNome: UNIDADES[0].nome, papel: "organization_admin", papelRotulo: "Administrador", acessivel: true, cidade: "—" }], superadmin: false, painelAdministrativo: false } }));
api.post("/sessao/selecionar", (_q, r) => r.json({ data: contexto() }));
api.get("/sessao/atual", (_q, r) => r.json({ data: contexto() }));
api.get("/sessao/unidades", (_q, r) => r.json({ data: { unidades: UNIDADES } }));
api.post("/sessao/trocar-unidade", (q, r) => { if (UNIDADES.some((x) => x.id === q.body?.unidadeId)) estado.unidade = q.body.unidadeId; r.json({ data: contexto() }); });
api.post("/sessao/encerrar", (_q, r) => r.json({ data: {} }));
api.get("/sessao/setores", async (_q, r, next) => {
  try { const a = acesso(); const f = await resolverAcessoFinanceiro(a, { organizacaoId: ORG, unidadeId: estado.unidade }, leitor);
    r.json({ data: { setores: calcularSetores({ permissoes: a.permissoes, modulos: a.modulos, impersonando: false, financeiroOk: f.ok, somenteFinanceiro: true }) } }); } catch (e) { next(e); }
});
const fin = express.Router();
fin.use((req, _res, next) => { req.user = { id: USER }; req.tenant = { organizacaoId: ORG, unidadeId: estado.unidade }; req.acesso = acesso(); next(); });
fin.use(requireFinanceiro(leitor));
fin.get("/status", autorizarAcaoFinanceira(PERM_FIN.VER), (req, res) => res.json({ data: { habilitado: true, nivel: req.financeiro.nivel, permissoes: req.financeiro.permissoes, financeiro2: financeiro2Habilitado(req.financeiro.organizacaoId) } }));
fin.use(criarDominioRouter({ autorizar: autorizarAcaoFinanceira, deps }));
api.use("/gestao-financeira", fin);
api.use((_q, r) => r.json({ data: [] }));
app.use("/api/v1", api);
app.use("/api/v1", errorHandler);
app.use(express.static(frontend));
app.listen(PORTA, "127.0.0.1", () => console.log(`[fin20] http://127.0.0.1:${PORTA}  (gate+domínio REAIS, PostgreSQL descartável, ${EXISTENTE ? "cópia LOCAL de dados existentes" : "dados sintéticos"}) — perfil: ${estado.nivel}`));
