// Executa SQL no banco de TESTE via `psql` — usado só para INJETAR FALHA (trigger temporário) em
// testes de atomicidade que o PostgREST não consegue simular. GUARDAS (todas obrigatórias):
//   1. conexão SÓ por DATABASE_TESTE_URL, validada por assertBancoDeTeste (recusa produção/placeholder);
//   2. o projeto da conexão TEM de ser o mesmo do SUPABASE_URL que os testes usam (senão a falha
//      seria injetada num banco diferente do que o teste observa);
//   3. NUNCA usa DATABASE_URL.
// Sem psql / sem DATABASE_TESTE_URL / guarda falhou -> `motivoIndisponivel()` devolve o motivo e o
// teste PULA (não é falha).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { assertBancoDeTeste, hostDe } from "./db-teste.js";

const CANDIDATOS_PSQL = [
  process.env.PSQL_PATH,
  "C:/Program Files/PostgreSQL/17/bin/psql.exe",
  "C:/Program Files/PostgreSQL/16/bin/psql.exe",
  "psql",
].filter(Boolean);

function acharPsql() {
  for (const c of CANDIDATOS_PSQL) {
    if (c === "psql") { if (spawnSync("psql", ["--version"], { encoding: "utf8" }).status === 0) return c; continue; }
    if (existsSync(c)) return c;
  }
  return null;
}

const refDoHost = (host) => host.replace(/^db\./, "").split(".")[0];

/**
 * Guardas. `assertBancoDeTeste` compara a URL de teste com DATABASE_URL e SUPABASE_URL para recusar
 * "produção" — mas aqui o SUPABASE_URL do processo JÁ é o do projeto de TESTE (é o que o
 * `motivoPularIntegracao` exige), então ele é excluído dessa comparação; a proteção contra produção
 * fica em (a) DATABASE_URL (produção, quando carregada), (b) a exigência de que o projeto da conexão
 * seja EXATAMENTE o do TEST_SUPABASE_URL/SUPABASE_URL que os testes usam.
 * @returns {string|false} motivo de indisponibilidade, ou `false` se pode injetar SQL com segurança
 */
export function motivoIndisponivel(env = process.env) {
  let alvo;
  try { alvo = assertBancoDeTeste({ ...env, SUPABASE_URL: "" }); } catch (e) { return `[SEM BANCO DE TESTE DIRETO] ${e.message}`; }
  const refConexao = (/postgres\.([a-z0-9]+)@/i.exec(alvo.url)?.[1]) || refDoHost(alvo.host);
  const refTestes = refDoHost(hostDe(env.SUPABASE_URL));
  const refTestUrl = refDoHost(hostDe(env.TEST_SUPABASE_URL));
  if (!refTestes || refConexao !== refTestes) return "[PROJETO DIVERGENTE] DATABASE_TESTE_URL não é o mesmo projeto do SUPABASE_URL dos testes — não vou injetar falha.";
  if (refTestUrl ? refConexao !== refTestUrl : env.INTEGRACAO_SUPABASE_DESCARTAVEL !== "1") {
    return "[ALVO NÃO CONFIRMADO COMO TESTE] o projeto da conexão não é o do TEST_SUPABASE_URL (nem há INTEGRACAO_SUPABASE_DESCARTAVEL=1) — não vou injetar falha.";
  }
  if (!acharPsql()) return "[PSQL AUSENTE] instale o psql (ou defina PSQL_PATH) para o teste de injeção de falha.";
  return false;
}

/** Roda SQL no banco de TESTE (falha se as guardas não passarem). @returns {{ok: boolean, stderr: string}} */
export function executarSqlNoBancoDeTeste(sql, env = process.env) {
  const motivo = motivoIndisponivel(env);
  if (motivo) throw new Error(motivo);
  const { url } = assertBancoDeTeste({ ...env, SUPABASE_URL: "" });
  const r = spawnSync(acharPsql(), [url, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-c", sql], { encoding: "utf8", env: { ...process.env, PGCLIENTENCODING: "UTF8" } });
  return { ok: r.status === 0, stderr: (r.stderr ?? "").replace(url, "<url-teste>") };
}
