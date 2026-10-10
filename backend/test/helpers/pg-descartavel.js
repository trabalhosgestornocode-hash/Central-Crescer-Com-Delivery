// Auxiliar de testes — Postgres LOCAL e DESCARTÁVEL.
//
// Usa o `psql` (não há driver `pg` no projeto) contra um servidor Postgres local. Cada arquivo de teste cria o PRÓPRIO
// banco (`CREATE DATABASE`) e o derruba no fim: testes de arquivos diferentes nunca disputam as mesmas tabelas.
//
//   CHECKLIST_PERFIL_PG_URL=postgresql://postgres@127.0.0.1:55410/postgres node --test test/perfil-exibicao-*-pg.test.js
//   (EXIBICAO_PG_URL também é aceita, para reaproveitar o servidor dos testes do Checkpoint 5C.)
//
// SEGURANÇA: só roda se o host for LOCAL (127.0.0.1 / localhost / ::1). Qualquer outro host (Supabase, produção,
// rede) é RECUSADO e o teste é pulado. Sem a variável, o teste é pulado (não é falha).
import { spawnSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

export const URL_ADMIN = (process.env.CHECKLIST_PERFIL_PG_URL || process.env.EXIBICAO_PG_URL || "").trim();
const PSQL = process.env.EXIBICAO_PSQL || "psql";
const HOSTS_LOCAIS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const hostLocal = () => { try { return HOSTS_LOCAIS.has(new URL(URL_ADMIN).hostname); } catch { return false; } };

export const motivoPular = !URL_ADMIN
  ? "CHECKLIST_PERFIL_PG_URL ausente — precisa de um Postgres LOCAL descartável. PULADO (não é falha)."
  : !hostLocal()
    ? "A URL do Postgres não é local — RECUSADO (estes testes só rodam contra um banco local descartável). PULADO."
    : false;

const ENV = { ...process.env, PGOPTIONS: "-c lc_messages=C", PGCLIENTENCODING: "UTF8" };

/** SQL pela ENTRADA PADRÃO (UTF-8 intacto no Windows). Devolve { ok, out, err }. */
export function psqlSync(url, sql, { arquivo, formato = "-t -A" } = {}) {
  const args = [url, "-X", "-q", "-v", "ON_ERROR_STOP=1", ...formato.split(" "), ...(arquivo ? ["-f", arquivo] : ["-f", "-"])];
  const r = spawnSync(PSQL, args, { input: arquivo ? undefined : sql, encoding: "utf8", env: ENV, timeout: 120_000 });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

/** Como psqlSync, mas lança com a mensagem do banco se falhar. */
export function sql(url, texto, opts) {
  const r = psqlSync(url, texto, opts);
  if (!r.ok) throw new Error(r.err || "psql falhou");
  return r.out;
}

/** Assíncrono (concorrência real). */
export function psqlAsync(url, texto) {
  return new Promise((resolve) => {
    const p = spawn(PSQL, [url, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-f", "-"], { env: ENV });
    let out = ""; let err = "";
    p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { err += d; });
    p.on("close", (c) => resolve({ ok: c === 0, out: out.trim(), err: err.trim() }));
    p.stdin.end(texto, "utf8");
  });
}

/** Cria um banco novo e vazio. Devolve { nome, url, derrubar }. */
export function criarBancoDescartavel(prefixo) {
  const nome = `${prefixo}_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
  sql(URL_ADMIN, `create database ${nome}`);
  const u = new URL(URL_ADMIN); u.pathname = `/${nome}`;
  const url = u.toString();
  return {
    nome, url,
    derrubar() { try { psqlSync(URL_ADMIN, `drop database if exists ${nome} with (force)`); } catch { /* melhor esforço */ } },
  };
}
