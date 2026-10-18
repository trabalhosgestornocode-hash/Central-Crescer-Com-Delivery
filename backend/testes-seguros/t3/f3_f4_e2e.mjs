// T3 — F-3 (paridade fim-a-fim) e F-4 (limites de consulta) com o CÓDIGO REAL da aplicação contra um projeto Supabase DESCARTÁVEL.
//   F-3: para cada cenário semeado, o conjunto que a APLICAÇÃO calcula (calcularMes → conciliar(), com o carregamento real do repositório/PostgREST)
//        tem de ser IGUAL ao que o BANCO calcula (rpc fin_conciliacao_pendencias_ids).
//   F-4: com MAIS de 5 000 referências (ou resoluções) no mês, o repositório trunca (`.limit(5000)`): a aplicação e o banco podem divergir. O que se exige é
//        FALHA FECHADA: ou os dois conjuntos continuam iguais (limite corrigido), ou o fechamento é RECUSADO com 409 FIN_CONCILIACAO_DIVERGENTE e o mês segue aberto.
//        NUNCA pode fechar com lista incompleta.
//
// ESTE SCRIPT NÃO FOI EXECUTADO no desenvolvimento (não existe projeto descartável ainda): é parte do pacote do T3. Ele só roda com TODAS as travas abaixo.
// Pré-requisitos no projeto DESCARTÁVEL: migrations 120, 121 e 122 aplicadas; uma organização e uma unidade de teste já existentes (ids abaixo); a unidade NÃO pode ter dados reais.
//   T3_SUPABASE_URL=https://<ref>.supabase.co  T3_SERVICE_ROLE_KEY=<chave service_role do projeto DESCARTÁVEL>  T3_PROJECT_REF=<ref>
//   T3_CONFIRMO=ESTE_PROJETO_E_DESCARTAVEL  T3_ORG_ID=<uuid>  T3_UNIDADE_ID=<uuid>  [T3_USUARIO_ID=<uuid>]
//   node backend/testes-seguros/t3/f3_f4_e2e.mjs
// O script NUNCA lê backend/.env (que aponta para produção). A chave vem só das variáveis T3_*. As linhas semeadas não são apagadas (service_role não tem DELETE
// por desenho): descarte o projeto depois.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const E = process.env;
const faltam = ["T3_SUPABASE_URL", "T3_SERVICE_ROLE_KEY", "T3_PROJECT_REF", "T3_CONFIRMO", "T3_ORG_ID", "T3_UNIDADE_ID"].filter((k) => !E[k]);
if (faltam.length) { console.error(`Faltam variáveis: ${faltam.join(", ")}`); process.exit(2); }
if (E.T3_CONFIRMO !== "ESTE_PROJETO_E_DESCARTAVEL") { console.error("T3_CONFIRMO precisa ser exatamente ESTE_PROJETO_E_DESCARTAVEL"); process.exit(2); }
if (!E.T3_SUPABASE_URL.includes(E.T3_PROJECT_REF) || !/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(E.T3_SUPABASE_URL)) { console.error("T3_SUPABASE_URL não corresponde a T3_PROJECT_REF (ou formato inesperado)"); process.exit(2); }
// as camadas da aplicação importam config/supabase.js, que exige estas variáveis: apontam para o projeto DESCARTÁVEL (nunca para o .env)
process.env.SUPABASE_URL = E.T3_SUPABASE_URL; process.env.SUPABASE_SERVICE_ROLE_KEY = E.T3_SERVICE_ROLE_KEY; process.env.SUPABASE_ANON_KEY = E.T3_SERVICE_ROLE_KEY;

const aqui = path.dirname(fileURLToPath(import.meta.url));
const backend = path.resolve(aqui, "..", "..");
const req = createRequire(path.join(backend, "package.json"));
const { createClient } = req("@supabase/supabase-js");
const db = createClient(E.T3_SUPABASE_URL, E.T3_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const imp = (rel) => import(pathToFileURL(path.join(backend, "src", "modules", "gestao-financeira", "dominio", rel)).href);
const conc = await imp("conciliacao.service.js");
const per = await imp("periodos.service.js");
const repo = await imp("repositorio.js");
const repoConc = await imp("repositorio.conciliacao.js");
const repoPer = await imp("repositorio.periodos.js");
const repositorio = { ...repo, ...repoConc, ...repoPer };
const deps = { repo: repositorio, db };

const ORG = E.T3_ORG_ID, UNI = E.T3_UNIDADE_ID, USR = E.T3_USUARIO_ID ?? randomUUID();
const ctx = { organizacaoId: ORG, unidadeId: UNI, usuarioId: USR };
const resultados = []; let n = 0;
const registra = (nome, ok, detalhe = "") => { resultados.push({ nome, ok: !!ok, detalhe }); console.log(`${ok ? "PASS " : "FALHA"} ${nome}${ok || !detalhe ? "" : `  (${detalhe})`}`); };
const ins = async (tabela, linhas) => { const { error } = await db.from(tabela).insert(linhas); if (error) throw new Error(`${tabela}: ${error.message}`); };

// ---- base: categorias e contas de teste (idempotente por nome) ----
const sufixo = Date.now().toString(36);
const catId = { receita: randomUUID(), despesa: randomUUID() };
await ins("fin_plano_contas", [
  { id: catId.receita, organizacao_id: ORG, tipo: "RECEITA", natureza: "RECEBIMENTO", nome: `T3 REC ${sufixo}`, papel: "receita_operacional" },
  { id: catId.despesa, organizacao_id: ORG, tipo: "DESPESA", natureza: "FIXA", nome: `T3 DESP ${sufixo}`, papel: "despesa_fixa" },
]);
const contaId = { banco: randomUUID(), caixa: randomUUID() };
await ins("fin_contas", [
  { id: contaId.banco, organizacao_id: ORG, unidade_id: UNI, nome: `T3 BANCO ${sufixo}`, tipo_conta: "banco" },
  { id: contaId.caixa, organizacao_id: ORG, unidade_id: UNI, nome: `T3 CAIXA ${sufixo}`, tipo_conta: "caixa_fisico" },
]);

/** Cada cenário usa um MÊS próprio (a partir de 2040-01) para não misturar dados. */
const proximoMes = () => { n += 1; const m = ((n - 1) % 12) + 1; const a = 2040 + Math.floor((n - 1) / 12); return { mes: `${a}-${String(m).padStart(2, "0")}`, dia: (d) => `${a}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` }; };
const lanc = (c, M, d, conta, cat, sentido, valor, status = "realizado") => ({ organizacao_id: ORG, unidade_id: UNI, conta_id: contaId[conta], categoria_id: cat ? catId[cat] : null, descricao: `T3 ${c}`, sentido, valor_centavos: valor, data_movimento: M.dia(d), status, classificacao_pendente: !cat });
const ref = (M, d, tipo, valor, canal = null) => ({ organizacao_id: ORG, unidade_id: UNI, data: M.dia(d), tipo, canal, valor_centavos: valor, fonte: "t3" });

async function comparar(rotulo, M) {
  const app = (await conc.calcularMes(ctx, M.mes, deps)).resultado.resumo.pendenciasAbertasIds;
  const { data, error } = await db.rpc("fin_conciliacao_pendencias_ids", { p_org: ORG, p_unidade: UNI, p_mes: `${M.mes}-01` });
  if (error) { registra(`${rotulo}: rpc do banco`, false, error.message); return null; }
  const a = [...app].sort(), b = [...(data ?? [])].sort();
  registra(`${rotulo}: aplicação = banco`, JSON.stringify(a) === JSON.stringify(b), `app=${JSON.stringify(a)} banco=${JSON.stringify(b)}`);
  return { app: a, banco: b };
}

console.log("== F-3: paridade fim-a-fim (carregamento real da aplicação × função do banco) ==");
{ const M = proximoMes(); await comparar("vazio", M); }
{ const M = proximoMes(); await ins("fin_lancamentos", [lanc("rec", M, 3, "banco", "receita", "entrada", 90000)]); await ins("fin_referencias", [ref(M, 5, "venda", 100000), ref(M, 5, "taxa", 10000, "STONE")]); await comparar("ponte conciliada", M); }
{ const M = proximoMes(); await ins("fin_referencias", [ref(M, 5, "venda", 100000), ref(M, 5, "taxa", 10000, "STONE")]); await comparar("ponte aberta", M); }
{ const M = proximoMes(); await ins("fin_lancamentos", [lanc("cx", M, 4, "caixa", "receita", "entrada", 7000)]); await ins("fin_referencias", [ref(M, 4, "dinheiro", 6000)]); await comparar("caixa do dia aberto", M); }
{ const M = proximoMes(); await ins("fin_lancamentos", [lanc("sg", M, 6, "caixa", "despesa", "saida", 3000)]); await ins("fin_referencias", [ref(M, 6, "sangria", 2000)]); await comparar("sangria aberta", M);
  await ins("fin_sangria_excecoes", [{ organizacao_id: ORG, unidade_id: UNI, categoria_id: catId.despesa, motivo: "t3 categoria excepcionada", aprovada_por: USR }]); await comparar("sangria com exceção ativa", M); }
{ const M = proximoMes(); await ins("fin_lancamentos", [lanc("cx", M, 4, "caixa", "receita", "entrada", 7000)]); await ins("fin_referencias", [ref(M, 4, "dinheiro", 6000)]);
  await ins("fin_conciliacao_resolucoes", [{ organizacao_id: ORG, unidade_id: UNI, escopo: "caixa_dia", chave: M.dia(4), classificacao: "ajuste", valor_centavos: 400, diferenca_no_momento_centavos: 1000, nota: "parcial t3" }]); await comparar("resolução parcial", M); }
{ const M = proximoMes(); await ins("fin_lancamentos", [lanc("pr", M, 3, "caixa", "receita", "entrada", 500, "previsto"), lanc("cn", M, 3, "caixa", "receita", "entrada", 500, "cancelado")]); await ins("fin_referencias", [ref(M, 3, "dinheiro", 0)]); await comparar("previsto/cancelado ignorados", M); }

console.log("== F-4: limites de consulta (.limit(5000)) — falha fechada ==");
async function f4(rotulo, semear) {
  const M = proximoMes(); await semear(M);
  const r = await comparar(`${rotulo}: comparação`, M);
  if (!r) return;
  const pre = await per.preFechamento(ctx, M.mes, deps);
  let desfecho;
  try { await per.fechar(ctx, M.mes, { confirmo: true, versao: pre.periodo.versao, fingerprint: pre.fingerprint, reconhecoPendencias: false }, deps); desfecho = "fechou"; }
  catch (e) { desfecho = `${e.status ?? e.statusCode ?? "?"}:${e.details?.codigo ?? e.codigo ?? e.message}`; }
  const { data: p } = await db.from("fin_periodos").select("status").eq("unidade_id", UNI).eq("mes", `${M.mes}-01`).maybeSingle();
  const iguais = JSON.stringify(r.app) === JSON.stringify(r.banco);
  if (iguais) registra(`${rotulo}: limite não alterou o resultado (ou foi corrigido)`, true, `desfecho=${desfecho}`);
  else registra(`${rotulo}: DIVERGIU (app≠banco) ⇒ fechamento RECUSADO com 409 e mês aberto`, /409:FIN_CONCILIACAO_DIVERGENTE/.test(desfecho) && p?.status !== "fechado", `desfecho=${desfecho} status=${p?.status}`);
  if (desfecho === "fechou" && !iguais) registra(`${rotulo}: NUNCA fechar com lista incompleta`, false, "fechou com divergência");
}
// 5 001 referências de venda de 100 centavos = 500 100 vendidos; taxa 100; recebido 500 000 ⇒ residual 0 no BANCO; a aplicação lê só 5 000 ⇒ vê 100 a menos ⇒ ponte aberta
await f4("5 001 referências", async (M) => {
  await ins("fin_lancamentos", [lanc("rec", M, 3, "banco", "receita", "entrada", 500000)]);
  const refs = Array.from({ length: 5001 }, () => ref(M, 5, "venda", 100)); refs.push(ref(M, 5, "taxa", 100, "STONE"));
  for (let i = 0; i < refs.length; i += 1000) await ins("fin_referencias", refs.slice(i, i + 1000));
});
// ponte aberta (residual 5 001) com 5 001 resoluções vigentes de 1 centavo (soma 5 001 ⇒ banco: resolvida); a aplicação lê 5 000 ⇒ parcial ⇒ aberta
await f4("5 001 resoluções", async (M) => {
  await ins("fin_referencias", [ref(M, 5, "venda", 5001 + 100), ref(M, 5, "taxa", 100, "STONE")]);
  const rs = Array.from({ length: 5001 }, () => ({ organizacao_id: ORG, unidade_id: UNI, escopo: "ponte_mensal", chave: `${M.mes}-01`, classificacao: "ajuste", valor_centavos: 1, diferenca_no_momento_centavos: 5001, nota: "resolucao t3" }));
  for (let i = 0; i < rs.length; i += 1000) await ins("fin_conciliacao_resolucoes", rs.slice(i, i + 1000));
});

const falhas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - falhas.length}/${resultados.length} verificações OK`);
process.exit(falhas.length ? 1 : 0);
