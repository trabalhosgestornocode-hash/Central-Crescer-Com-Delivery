// SERVIDOR DE QA VISUAL (somente desenvolvimento). Serve o frontend REAL com um backend FALSO, 100% em loopback:
//   - substitui o supabase-js do CDN por um stub (sem Supabase, sem rede, sem credenciais);
//   - responde só o necessário para navegar: sessão, acessos, setores e /gestao-financeira/status;
//   - o resto da API devolve listas vazias (o Dashboard Operacional abre vazio — serve para conferir navegação/layout).
// NÃO valida segurança (isso é dos testes). Dados 100% fictícios.
//   node backend/testes-seguros/qa-visual/servidor-qa.mjs [porta]      (padrão 4173)
//   Cenários: GET/POST /qa/cenario?nome=<operacional|financeiro|ambos|nenhum|troca|impersonacao|exibicao|ambos-revogavel>
import express from "express";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(aqui, "..", "..", "..", "frontend");
const PORTA = Number(process.argv[2]) || 4173;

const estado = { cenario: "ambos", unidade: "uni-a", revogado: false, escritaLiberada: false };
const chamadas = [];   // corpo das escritas recebidas (só para conferir o que a tela envia)

const UNIDADES = [{ id: "uni-a", nome: "Unidade A (Centro)", ativo: true }, { id: "uni-b", nome: "Unidade B (Norte)", ativo: true }];
const TODAS = ["dashboard", "products_cmv", "ingredients", "sales", "ifood_dashboard", "monthly_bonus", "ifood", "inteligencia", "agente_ia", "parser_food_delivery"];
const PERM_OPERACIONAIS = ["dashboard.ver", "produtos.ver", "insumos.ver", "cmv.ver", "vendas.ver", "integracoes.ver", "dashboard_executivo.ver", "bonificacao_mensal.ver", "parser_food_delivery.ver", "checklist.visualizar"];

/** Setores por cenário e unidade. */
function setoresDe(cenario, unidade) {
  if (estado.revogado) return ["operacional"];
  switch (cenario) {
    case "operacional": return ["operacional"];
    case "financeiro": return ["financeiro"];
    case "nenhum": return [];
    case "troca": return unidade === "uni-a" ? ["financeiro", "operacional"] : ["operacional"];
    case "impersonacao": case "exibicao": return ["operacional"];
    default: return ["financeiro", "operacional"];
  }
}

function contexto() {
  const u = UNIDADES.find((x) => x.id === estado.unidade) ?? UNIDADES[0];
  const exib = estado.cenario === "exibicao";
  const imp = estado.cenario === "impersonacao";
  const agora = Date.now();
  return {
    contextToken: "qa-contexto", empresa: { id: "org-qa", nome: "Empresa QA (fictícia)", status: "ativa" },
    unidade: { id: u.id, nome: u.nome }, papel: exib ? "display_operator" : "organization_admin",
    papelRotulo: exib ? "Operador de Exibição" : "Administrador",
    permissoes: exib ? ["checklist.visualizar"] : PERM_OPERACIONAIS,
    modulos: exib ? ["ifood"] : TODAS, impersonando: imp,
    perfil: imp ? null : { id: "perfil-qa", nome: "Usuária QA" },
    expiraEm: new Date(agora + 8 * 3600e3).toISOString(), servidorEm: new Date(agora).toISOString(),
  };
}

const app = express();
app.use(express.json());

app.get("/api/config", (_q, r) => r.json({ supabaseUrl: "http://127.0.0.1:9", supabaseAnonKey: "anon-qa" }));
app.get("/qa/supabase-stub.js", (_q, r) => r.type("js").send(readFileSync(path.join(aqui, "supabase-stub.js"))));
app.all("/qa/cenario", (q, r) => {
  const nome = q.query.nome ?? q.body?.nome;
  if (nome) { estado.cenario = String(nome); estado.revogado = false; estado.unidade = "uni-a"; chamadas.length = 0; }
  r.json(estado);
});
app.all("/qa/escrita", (q, r) => { estado.escritaLiberada = q.query.on === "1"; r.json(estado); });
app.get("/qa/chamadas", (_q, r) => r.json(chamadas));
app.all("/qa/revogar", (_q, r) => { estado.revogado = true; r.json(estado); });
app.get("/qa/estado", (_q, r) => r.json(estado));

app.get(["/", "/index.html"], (_q, r) => {
  const html = readFileSync(path.join(frontend, "index.html"), "utf8")
    .replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2"><\/script>/, '<script src="/qa/supabase-stub.js"></script>');
  r.type("html").send(html);
});

const api = express.Router();
api.get("/me", (_q, r) => r.json({ data: { id: "u-qa", nome: "Usuária QA", email: "qa@exemplo.invalid", superadmin: estado.cenario === "superadmin", senhaProvisoria: false } }));
api.get("/sessao/perfis", (_q, r) => r.json({ data: [{ id: "perfil-qa", nome: "Usuária QA", temPin: false }] }));
api.get("/sessao/acessos", (_q, r) => r.json({ data: { opcoes: [{
  organizacaoId: "org-qa", unidadeId: "uni-a", empresaNome: "Empresa QA (fictícia)", unidadeNome: "Unidade A (Centro)",
  papel: "organization_admin", papelRotulo: "Administrador", acessivel: true, cidade: "—",
}].filter(() => estado.cenario !== "superadmin"), superadmin: estado.cenario === "superadmin", painelAdministrativo: false } }));
api.post("/sessao/selecionar", (_q, r) => r.json({ data: contexto() }));
api.get("/sessao/atual", (_q, r) => r.json({ data: contexto() }));
api.get("/sessao/unidades", (_q, r) => r.json({ data: { unidades: UNIDADES } }));
api.post("/sessao/trocar-unidade", (q, r) => { estado.unidade = q.body?.unidadeId ?? estado.unidade; r.json({ data: contexto() }); });
api.post("/sessao/encerrar", (_q, r) => r.json({ data: {} }));
api.get("/sessao/setores", (_q, r) => r.json({ data: { setores: setoresDe(estado.cenario, estado.unidade) } }));
api.get("/gestao-financeira/status", (_q, r) => {
  if (estado.revogado || !setoresDe(estado.cenario, estado.unidade).includes("financeiro")) {
    return r.status(403).json({ error: "Acesso ao Dashboard Financeiro não autorizado.", details: { codigo: "FINANCEIRO_SEM_CONCESSAO" } });
  }
  r.json({ data: { habilitado: true, nivel: "operador", permissoes: ["gestao_financeira.ver", "gestao_financeira.lancar"] } });
});
const P = "/plataforma/gestao-financeira/concessoes";
const agora = Date.now();
const concessoes = [
  { id: "c-1", organizacao_id: "org-qa", unidade_id: "uni-a", perfil_id: "perfil-1", perfil_nome: "Marina Souza", perfil_email: "marina@exemplo.invalid", nivel: "operador", somente_financeiro: false, motivo: "Contratação da analista financeira", concedida_em: new Date(agora - 9 * 864e5).toISOString(), expira_em: null, revogada_em: null, situacao: "ativa" },
  { id: "c-2", organizacao_id: "org-qa", unidade_id: "uni-a", perfil_id: "perfil-2", perfil_nome: "Paulo Lima", perfil_email: "paulo@exemplo.invalid", nivel: "leitura", somente_financeiro: true, motivo: "Contador externo, consulta mensal", concedida_em: new Date(agora - 60 * 864e5).toISOString(), expira_em: new Date(agora - 2 * 864e5).toISOString(), revogada_em: null, situacao: "expirada" },
  { id: "c-3", organizacao_id: "org-qa", unidade_id: "uni-a", perfil_id: "perfil-3", perfil_nome: "Rita Alves", perfil_email: "rita@exemplo.invalid", nivel: "gestor", somente_financeiro: false, motivo: "Gestora financeira da unidade", concedida_em: new Date(agora - 90 * 864e5).toISOString(), expira_em: null, revogada_em: new Date(agora - 5 * 864e5).toISOString(), motivo_revogacao: "Mudou de função na empresa", situacao: "revogada" },
];
api.get("/plataforma/empresas", (_q, r) => r.json({ data: [{ id: "org-qa", nome: "Empresa QA (fictícia)" }] }));
api.get("/plataforma/empresas/org-qa/unidades", (_q, r) => r.json({ data: UNIDADES }));
api.get(P + "/estado", (_q, r) => r.json({ data: estado.escritaLiberada ? { escritaLiberada: true } : { escritaLiberada: false, codigo: "CONCESSOES_BLOQUEADAS", mensagem: "A administração de concessões financeiras está bloqueada neste ambiente." } }));
api.get(P + "/perfis", (_q, r) => r.json({ data: [{ id: "perfil-4", nome: "Bruno Dias", email: "bruno@exemplo.invalid", propria: false }, { id: "perfil-su", nome: "Usuária QA", email: "qa@exemplo.invalid", propria: true }] }));
api.get(P + "/auditoria", (_q, r) => r.json({ data: [
  { id: 3, concessao_id: "c-3", perfil_id: "perfil-3-aaaaaaaa", evento: "revogada", nivel: "gestor", motivo: "Mudou de função na empresa", ocorreu_em: new Date(agora - 5 * 864e5).toISOString() },
  { id: 2, concessao_id: "c-1", perfil_id: "perfil-1-aaaaaaaa", evento: "concedida", nivel: "operador", motivo: "Contratação da analista financeira", ocorreu_em: new Date(agora - 9 * 864e5).toISOString() },
] }));
api.get(P, (q, r) => r.json({ data: q.query.incluirRevogadas === "true" ? concessoes : concessoes.filter((c) => !c.revogada_em) }));
api.post(P, (q, r) => { chamadas.push({ rota: "conceder", corpo: q.body }); r.status(estado.escritaLiberada ? 201 : 403).json(estado.escritaLiberada ? { data: { id: "c-novo" } } : { error: "bloqueado", details: { codigo: "CONCESSOES_BLOQUEADAS" } }); });
api.post(P + "/:id/revogar", (q, r) => { chamadas.push({ rota: "revogar", id: q.params.id, corpo: q.body }); r.status(estado.escritaLiberada ? 200 : 403).json(estado.escritaLiberada ? { data: { id: q.params.id } } : { error: "bloqueado", details: { codigo: "CONCESSOES_BLOQUEADAS" } }); });
api.use((_q, r) => r.json({ data: [] }));       // todo o resto: vazio
app.use("/api/v1", api);

app.use(express.static(frontend));
app.listen(PORTA, "127.0.0.1", () => console.log(`[qa-visual] http://127.0.0.1:${PORTA}  (cenário: ${estado.cenario})`));
