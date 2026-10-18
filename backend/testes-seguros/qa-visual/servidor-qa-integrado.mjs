// QA VISUAL INTEGRADO (somente desenvolvimento): o frontend REAL + o GATE REAL (requireFinanceiro/autorizarAcaoFinanceira) + o
// DOMÍNIO REAL do Agente 2, com repositório em MEMÓRIA e dados 100% SINTÉTICOS. Sessão/Supabase continuam falsos (loopback).
//   node backend/testes-seguros/qa-visual/servidor-qa-integrado.mjs [porta]     (padrão 4174)
//   /qa/cenario?nome=ambos|financeiro|operacional|nenhum|impersonacao|exibicao   /qa/nivel?n=leitura|operador|gestor
//   /qa/revogar   /qa/vazio?on=1 (unidade sem dados)   /qa/falha?on=1 (a API financeira passa a responder 500)
import express from "express";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { requireFinanceiro, autorizarAcaoFinanceira, resolverAcessoFinanceiro } from "../../src/middlewares/financeiro.js";
import { PERM_FIN } from "../../src/shared/gestaoFinanceira.permissoes.js";
import { calcularSetores } from "../../src/shared/setores.js";
import { errorHandler } from "../../src/middlewares/errorHandler.js";
import { criarDominioRouter } from "../../src/modules/gestao-financeira/dominio/rotas.js";
import * as cadastros from "../../src/modules/gestao-financeira/dominio/cadastros.service.js";
import * as lanc from "../../src/modules/gestao-financeira/dominio/lancamentos.service.js";
import * as conc from "../../src/modules/gestao-financeira/dominio/conciliacao.service.js";
import * as per from "../../src/modules/gestao-financeira/dominio/periodos.service.js";
import { criarRepoMemoria } from "../../test/financeiro/helpers/repoMemoria.js";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(aqui, "..", "..", "..", "frontend");
const PORTA = Number(process.argv[2]) || 4174;
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = U(1), UNI_A = U(2), UNI_B = U(3), USER = U(6), PERFIL = U(7);
const UNIDADES = [{ id: UNI_A, nome: "Unidade A (Centro)", ativo: true }, { id: UNI_B, nome: "Unidade B (Norte)", ativo: true }];
const TODAS = ["dashboard", "products_cmv", "ingredients", "sales", "ifood_dashboard", "monthly_bonus", "ifood", "inteligencia", "agente_ia", "parser_food_delivery"];
const PERM_OP = ["dashboard.ver", "produtos.ver", "insumos.ver", "cmv.ver", "vendas.ver", "integracoes.ver", "dashboard_executivo.ver", "bonificacao_mensal.ver", "parser_food_delivery.ver", "checklist.visualizar"];

const estado = { cenario: "ambos", unidade: UNI_A, revogado: false, nivel: "gestor", vazio: false, falha: false };

// ---------------- dados sintéticos (via serviços REAIS do domínio) ----------------
const repo = criarRepoMemoria();
const deps = { repo, db: undefined };
const ctxA = { organizacaoId: ORG, unidadeId: UNI_A, usuarioId: USER };
const iso = (d) => d.toISOString().slice(0, 10);
async function semear() {
  const cat = async (tipo, natureza, nome, papel) => (await cadastros.criarCategoria(ctxA, { tipo, natureza, nome, papel }, deps)).id;
  const c = {
    balcao: await cat("RECEITA", "RECEBIMENTO", "VENDAS BALCÃO", "receita_operacional"), ifood: await cat("RECEITA", "RECEBIMENTO", "VENDAS IFOOD", "receita_operacional"),
    insumos: await cat("CUSTO", "VARIAVEL", "INSUMOS", "custo_variavel"), emb: await cat("DESPESA", "VARIAVEL", "EMBALAGENS", "despesa_variavel"),
    simples: await cat("TRIBUTO", "IMPOSTO", "SIMPLES NACIONAL", "tributo"), aluguel: await cat("DESPESA", "FIXA", "ALUGUEL", "despesa_fixa"),
    folha: await cat("DESPESA", "PESSOAL", "FOLHA", "despesa_pessoal"), tarifas: await cat("DESPESA", "FINANCEIRA", "TARIFAS BANCÁRIAS", "despesa_financeira"),
    transf: await cat("TRANSFERENCIA", "ENTRE CONTAS", "ENTRE CONTAS", "transferencia"),
  };
  const conta = async (nome, tipoConta) => (await cadastros.criarConta(ctxA, { nome, tipoConta }, deps)).id;
  const banco = await conta("BANCO PRINCIPAL", "banco"), adq = await conta("ADQUIRENTE", "adquirente"), caixa = await conta("CAIXA", "caixa_fisico");
  const hoje = new Date(); const hojeIso = iso(hoje);
  const mes = (off) => new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() + off, 1));
  await cadastros.definirAbertura(ctxA, { contaId: banco, dataReferencia: iso(mes(-2)), valor: 15000, nota: "saldo sintético" }, deps);   // só o banco tem abertura conhecida
  const mk = async (off, dia, contaId, categoriaId, descricao, sentido, valor) => {
    const d = iso(new Date(Date.UTC(mes(off).getUTCFullYear(), mes(off).getUTCMonth(), dia)));
    await lanc.criarLancamento(ctxA, { contaId, categoriaId, descricao, sentido, valor, dataMovimento: d, status: d <= hojeIso ? "realizado" : "previsto" }, deps);
  };
  for (const off of [-2, -1, 0]) {
    for (const [i, d] of [3, 8, 13, 18, 23, 28].entries()) await mk(off, d, adq, c.balcao, "Vendas balcão", "entrada", 4200 + i * 310 + off * 150);
    for (const [i, d] of [5, 12, 19, 26].entries()) await mk(off, d, adq, c.ifood, "Repasse iFood", "entrada", 3100 + i * 250 + off * 90);
    for (const [i, d] of [6, 15, 24].entries()) await mk(off, d, banco, c.insumos, "Compra de insumos", "saida", [5200, 4800, 5600][i]);
    await mk(off, 10, caixa, c.emb, "Embalagens", "saida", 980);
    await mk(off, 20, banco, c.simples, "DAS Simples Nacional", "saida", 1850);
    await mk(off, 5, banco, c.aluguel, "Aluguel", "saida", 4500);
    await mk(off, 28, banco, c.folha, "Folha de pagamento", "saida", 7400);
    await mk(off, 15, banco, c.tarifas, "Tarifas bancárias", "saida", 340);
  }
  await lanc.criarTransferencia(ctxA, { contaOrigemId: adq, contaDestinoId: banco, valor: 12000, data: iso(mes(-1)), descricao: "Repasse adquirente → banco" }, deps);
  await lanc.criarLancamento(ctxA, { contaId: banco, descricao: "PIX NÃO IDENTIFICADO", sentido: "entrada", valor: 230, dataMovimento: iso(mes(0)) <= hojeIso ? iso(mes(0)) : hojeIso }, deps); // sem categoria => classificação pendente
}
/** Conciliação e períodos sintéticos: canal vinculado EXPLICITAMENTE, um mês consistente (e FECHADO), um mês com diferença (pendente de identificação). */
async function semearConciliacao() {
  const hoje = new Date(); const mesDe = (off) => { const d = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() + off, 1)); return d.toISOString().slice(0, 7); };
  const [adq] = (await cadastros.listarContas(ctxA, deps)).filter((c) => c.nome === "ADQUIRENTE");
  await cadastros.atualizarConta(ctxA, adq.id, { canalReferencia: "STONE" }, deps);
  for (const [off, extra] of [[-2, 0], [-1, 800]]) {
    const mes = mesDe(off);
    const { resultado } = await conc.calcularMes(ctxA, mes, deps);
    const recebido = resultado.ponte.recebidoCentavos / 100; const taxa = 1500;
    await conc.registrarReferencias(ctxA, { itens: [{ data: `${mes}-28`, tipo: "venda", canal: "STONE", valor: recebido + taxa + extra }, { data: `${mes}-28`, tipo: "taxa", canal: "STONE", valor: taxa }] }, deps);
  }
  const m2 = mesDe(-2); const pre = await per.preFechamento(ctxA, m2, deps);
  if (pre.avaliacao.pode) await per.fechar(ctxA, m2, { confirmo: true, versao: pre.periodo.versao, fingerprint: pre.fingerprint }, deps);
}
await semear();
await semearConciliacao();

// ---------------- sessão falsa + gate/domínio reais ----------------
const concessao = () => {
  if (estado.revogado || ["operacional", "nenhum", "impersonacao", "exibicao"].includes(estado.cenario)) return null;
  return { organizacao_id: ORG, unidade_id: estado.unidade, nivel: estado.nivel, somente_financeiro: estado.cenario === "financeiro", revogada_em: null, expira_em: null };
};
const leitor = { moduloEmpresa: async () => true, moduloUnidade: async () => true, concessao: async () => concessao() };
const acessoMock = () => ({
  perfilId: PERFIL, impersonando: estado.cenario === "impersonacao", papel: estado.cenario === "exibicao" ? "display_operator" : "organization_admin",
  permissoes: estado.cenario === "exibicao" ? ["checklist.visualizar"] : (estado.cenario === "nenhum" ? [] : PERM_OP),
  modulos: estado.cenario === "exibicao" ? ["ifood"] : (estado.cenario === "nenhum" ? [] : TODAS),
});
function contexto() {
  const u = UNIDADES.find((x) => x.id === estado.unidade) ?? UNIDADES[0]; const a = acessoMock(); const agora = Date.now();
  return { contextToken: "qa-contexto", empresa: { id: ORG, nome: "Empresa QA (fictícia)", status: "ativa" }, unidade: { id: u.id, nome: u.nome },
    papel: a.papel, papelRotulo: a.papel === "display_operator" ? "Operador de Exibição" : "Administrador", permissoes: a.permissoes, modulos: a.modulos,
    impersonando: a.impersonando, perfil: a.impersonando ? null : { id: PERFIL, nome: "Usuária QA" },
    expiraEm: new Date(agora + 8 * 3600e3).toISOString(), servidorEm: new Date(agora).toISOString() };
}

const app = express();
app.use(express.json());
app.get("/api/config", (_q, r) => r.json({ supabaseUrl: "http://127.0.0.1:9", supabaseAnonKey: "anon-qa" }));
app.get("/qa/supabase-stub.js", (_q, r) => r.type("js").send(readFileSync(path.join(aqui, "supabase-stub.js"))));
app.all("/qa/cenario", (q, r) => { const n = q.query.nome ?? q.body?.nome; if (n) { estado.cenario = String(n); estado.revogado = false; estado.unidade = UNI_A; estado.falha = false; } r.json(estado); });
app.all("/qa/nivel", (q, r) => { estado.nivel = String(q.query.n ?? "gestor"); r.json(estado); });
app.all("/qa/revogar", (_q, r) => { estado.revogado = true; r.json(estado); });
app.all("/qa/vazio", (q, r) => { estado.vazio = q.query.on === "1"; r.json(estado); });
app.all("/qa/falha", (q, r) => { estado.falha = q.query.on === "1"; r.json(estado); });
// F-2 (somente QA): um mês ABERTO e LIMPO (sem pendências) para exercitar o pré-fechamento, e uma mudança REAL de dados entre a prévia e o fechamento
// (muda a impressão digital => o domínio responde 409 FIN_PERIODO_CONFLITO_DADOS de verdade, não simulado).
const lancQa = async (descricao, valor) => {
  const cats = await cadastros.listarPlanoContas(ctxA, deps); const contas = await cadastros.listarContas(ctxA, deps);
  const rec = cats.find((c) => c.papel === "receita_operacional"); const banco = contas.find((c) => c.nome === "BANCO PRINCIPAL");
  const h = new Date(); const d = new Date(Date.UTC(h.getUTCFullYear(), h.getUTCMonth() + (estado.qaOff ?? -3), estado.qaSeq = (estado.qaSeq ?? 9) + 1));
  await lanc.criarLancamento(ctxA, { contaId: banco.id, categoriaId: rec.id, descricao, sentido: "entrada", valor, dataMovimento: iso(d), status: "realizado" }, deps);
  return iso(d).slice(0, 7);
};
app.all("/qa/novo-mes", (_q, r) => { estado.qaOff = (estado.qaOff ?? -3) - 1; estado.mesLimpo = null; r.json(estado); });
app.all("/qa/mes-limpo", async (_q, r) => { if (!estado.mesLimpo) estado.mesLimpo = await lancQa("Venda do mês limpo (QA)", 1000); r.json({ mes: estado.mesLimpo }); });
app.all("/qa/mudar-dados", async (_q, r) => { if (!estado.mesLimpo) estado.mesLimpo = await lancQa("Venda do mês limpo (QA)", 1000); await lancQa("Lançamento feito por outra pessoa (QA)", 77); r.json({ mes: estado.mesLimpo, mudou: true }); });
app.get("/qa/estado", (_q, r) => r.json(estado));
app.get(["/", "/index.html"], (_q, r) => r.type("html").send(readFileSync(path.join(frontend, "index.html"), "utf8").replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2"><\/script>/, '<script src="/qa/supabase-stub.js"></script>')));

const api = express.Router();
api.get("/me", (_q, r) => r.json({ data: { id: USER, nome: "Usuária QA", email: "qa@exemplo.invalid", superadmin: false, senhaProvisoria: false } }));
api.get("/sessao/perfis", (_q, r) => r.json({ data: [{ id: PERFIL, nome: "Usuária QA", temPin: false }] }));
api.get("/sessao/acessos", (_q, r) => r.json({ data: { opcoes: [{ organizacaoId: ORG, unidadeId: UNI_A, empresaNome: "Empresa QA (fictícia)", unidadeNome: "Unidade A (Centro)", papel: "organization_admin", papelRotulo: "Administrador", acessivel: true, cidade: "—" }], superadmin: false, painelAdministrativo: false } }));
api.post("/sessao/selecionar", (_q, r) => r.json({ data: contexto() }));
api.get("/sessao/atual", (_q, r) => r.json({ data: contexto() }));
api.get("/sessao/unidades", (_q, r) => r.json({ data: { unidades: UNIDADES } }));
api.post("/sessao/trocar-unidade", (q, r) => { estado.unidade = q.body?.unidadeId ?? estado.unidade; r.json({ data: contexto() }); });
api.post("/sessao/encerrar", (_q, r) => r.json({ data: {} }));
// setores: calculados com o CÓDIGO REAL (resolverAcessoFinanceiro + calcularSetores)
api.get("/sessao/setores", async (_q, r, next) => {
  try {
    const a = acessoMock(); const fin = await resolverAcessoFinanceiro(a, { organizacaoId: ORG, unidadeId: estado.unidade }, leitor);
    r.json({ data: { setores: calcularSetores({ permissoes: a.permissoes, modulos: a.modulos, impersonando: a.impersonando, financeiroOk: fin.ok, somenteFinanceiro: fin.ok && fin.somenteFinanceiro }) } });
  } catch (e) { next(e); }
});

const fin = express.Router();
fin.use((req, res, next) => {
  if (estado.falha) return res.status(500).json({ error: "Falha simulada para QA." });
  req.user = { id: USER }; req.tenant = { organizacaoId: ORG, unidadeId: estado.unidade }; req.acesso = acessoMock(); next();
});
fin.use(requireFinanceiro(leitor));
// o mesmo /status do módulo real
fin.get("/status", autorizarAcaoFinanceira(PERM_FIN.VER), (req, res) => res.json({ data: { habilitado: true, nivel: req.financeiro.nivel, permissoes: req.financeiro.permissoes } }));
// unidade B (ou "vazio"): repositório sem dados — estados vazios reais do domínio
const repoVazio = criarRepoMemoria();
fin.use((req, _res, next) => { req._repo = (estado.vazio || req.tenant.unidadeId !== UNI_A) ? repoVazio : repo; next(); });
fin.use((req, res, next) => criarDominioRouter({ autorizar: autorizarAcaoFinanceira, deps: { repo: req._repo, db: undefined } })(req, res, next));
api.use("/gestao-financeira", fin);
api.use((_q, r) => r.json({ data: [] }));
app.use("/api/v1", api);
app.use("/api/v1", errorHandler);
app.use(express.static(frontend));
app.listen(PORTA, "127.0.0.1", () => console.log(`[qa-integrado] http://127.0.0.1:${PORTA}  (gate+domínio REAIS, dados sintéticos)`));
