// Peças comuns do ambiente de banco ISOLADO do Financeiro v2 (script de infraestrutura e testes de integração).
//
// REGRAS (não negociáveis):
//   - Nada aqui lê o .env do backend nem variáveis do sistema atual. A única entrada é o arquivo `ambiente.json`
//     gerado por scripts/fv2-banco-teste.mjs, que fica FORA do repositório.
//   - Toda conexão passa pelas duas barreiras de src/modules/financeiro-v2/infra/postgres/destinoSeguro.js:
//     endereço declarado (antes de conectar) e destino efetivo (primeira consulta de cada conexão).
//   - Não existe caminho para banco remoto, nem "plano B": dúvida = erro.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { comprovarDestinoIsolado, exigirDestinoLocal } from "../../src/modules/financeiro-v2/index.js";

const aqui = dirname(fileURLToPath(import.meta.url));
export const PASTA_DE_MIGRACOES = resolve(aqui, "..", "..", "..", "database", "financeiro-v2", "migracoes");

/** Pasta do ambiente isolado: fora do repositório e fora de pastas sincronizadas com nuvem. */
export const pastaDoAmbiente = () => process.env.FV2_PG_DIR || join(process.env.LOCALAPPDATA || join(homedir(), ".local", "share"), "fv2-pg-teste");
export const arquivoDoAmbiente = () => join(pastaDoAmbiente(), "ambiente.json");

/** Lê o ambiente e já aplica a barreira 1 nos dois endereços. null quando o ambiente ainda não foi criado. */
export function lerAmbiente() {
  if (!existsSync(arquivoDoAmbiente())) return null;
  const a = JSON.parse(readFileSync(arquivoDoAmbiente(), "utf8"));
  exigirDestinoLocal(a.urlAdmin);
  exigirDestinoLocal(a.urlApp);
  if (a.urlAutoridade) exigirDestinoLocal(a.urlAutoridade);
  return a;
}

export const urlDoBanco = (base, banco) => {
  const u = new URL(base);
  u.pathname = `/${banco}`;
  return u.toString();
};

let pg;
/**
 * Pool cujas conexões só são entregues depois de comprovado o destino efetivo.
 * @param {string} url endereço local do ambiente isolado
 * @param {string} marcador segredo gravado no banco na criação do ambiente
 */
export async function abrirPoolSeguro(url, marcador, { max = 6 } = {}) {
  const declarado = exigirDestinoLocal(url);
  pg ??= (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 1000, allowExitOnIdle: true });
  pool.on("error", () => {});
  const comprovados = new WeakSet();
  const seguro = {
    declarado,
    async connect() {
      const cliente = await pool.connect();
      if (!comprovados.has(cliente)) {
        try {
          await comprovarDestinoIsolado(cliente, { marcador, declarado });
          comprovados.add(cliente);
        } catch (e) {
          cliente.release(true);
          throw e;
        }
      }
      return cliente;
    },
    async query(texto, valores) {
      const cliente = await seguro.connect();
      try {
        return await cliente.query(texto, valores);
      } finally {
        cliente.release();
      }
    },
    end: () => pool.end(),
  };
  return seguro;
}

export function listarMigracoes(pasta = PASTA_DE_MIGRACOES) {
  return readdirSync(pasta).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort().map((nome) => {
    const sql = readFileSync(join(pasta, nome), "utf8");
    return { nome, sql, sha256: createHash("sha256").update(sql).digest("hex") };
  });
}

/** Schema DEDICADO do Financeiro v2 (decisão de infraestrutura da 09C: projeto Supabase existente, schema próprio). */
export const ESQUEMA_FINANCEIRO = "financeiro_v2";
/** A5 — retira o EXECUTE de PUBLIC das funções do schema (idempotente). Usado pelo aplicador e pelo pacote de produção. */
export const sqlSemExecucaoPublica = (schema = ESQUEMA_FINANCEIRO) => `do $$ declare f record; begin
  -- A5 (auditoria A-1): nenhuma função do módulo fica executável por PUBLIC (o padrão do PostgreSQL). Quem tinha o
  -- EXECUTE de PUBLIC passa a ter EXECUTE só para os três papéis do módulo; as funções protegidas já sem PUBLIC ficam
  -- exatamente como as migrações deixaram.
  for f in select p.oid::regprocedure as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = '${schema}' and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0 and x.privilege_type = 'EXECUTE') loop
    execute format('grant execute on function %s to fv2_app, fv2_autoridade, fv2_guardiao', f.fn);
    execute format('revoke execute on function %s from public', f.fn);
  end loop;
end $$`;
/**
 * search_path das conexões ao banco do módulo. No ambiente isolado vai no BANCO (cada teste usa um banco novo); em
 * produção vai nos papéis de LOGIN do módulo (`alter role … set search_path`), nunca no banco inteiro da plataforma.
 */
export const SEARCH_PATH_DO_MODULO = `${ESQUEMA_FINANCEIRO}, pg_catalog`;
export const fixarSearchPathDoBanco = (poolControle, banco) => {
  if (!/^fv2_[a-z0-9_]+$/.test(banco)) throw new Error("Financeiro v2: nome de banco inesperado.");
  return poolControle.query(`alter database ${banco} set search_path = ${SEARCH_PATH_DO_MODULO}`);
};
const SEARCH_PATH_ORIGINAL = "set search_path = pg_catalog, public, pg_temp";
const PAPEIS_DO_MODULO = ["fv2_app", "fv2_autoridade", "fv2_guardiao"];

/**
 * Texto EFETIVAMENTE aplicado de uma migração no schema dedicado (A2): o search_path fixo das funções protegidas passa a
 * ser `pg_catalog, financeiro_v2, pg_temp`. O arquivo 0001–0021 não muda (o hash original continua sendo a identidade
 * da migração); o hash do texto aplicado também é registrado. Sobrou "public" num search_path → erro (nunca adivinha).
 */
export function textoAplicado(sql, schema = ESQUEMA_FINANCEIRO) {
  const t = sql.replaceAll(SEARCH_PATH_ORIGINAL, `set search_path = pg_catalog, ${schema}, pg_temp`);
  if (/search_path\s*=\s*[^;$]*\bpublic\b/i.test(t)) throw new Error("Financeiro v2: migração com search_path apontando para public que o aplicador não sabe adaptar.");
  return t;
}

/** A migração transfere ou recria função do guardião? (precisa da participação temporária A3) */
async function tocaFuncoesDoGuardiao(cliente, sql) {
  if (/owner\s+to\s+fv2_guardiao/i.test(sql)) return true;
  const { rows } = await cliente.query("select distinct p.proname from pg_proc p join pg_roles r on r.oid = p.proowner where r.rolname = 'fv2_guardiao'");
  return rows.some(({ proname }) => new RegExp(String.raw`create\s+or\s+replace\s+function\s+${proname}\s*\(`, "i").test(sql));
}

/**
 * Aplica as migrações pendentes NO SCHEMA DEDICADO, em ordem, cada uma em sua transação, e registra nome + hash do
 * arquivo + hash do texto aplicado. Migração já aplicada é pulada; se o arquivo de uma migração já aplicada mudou, PARA
 * (migração aplicada não se edita). Só aceita pool vindo de abrirPoolSeguro — ou seja, só roda no ambiente isolado.
 *
 * Adaptações para um papel de migração SEM superusuário (o `postgres` do Supabase), comprovadas pela sonda da 09C:
 *   A1 schema próprio sem acesso de PUBLIC; papéis do módulo criados antes, se faltarem (as migrações já usam "se não existir")
 *   A2 search_path das funções protegidas no schema dedicado (textoAplicado)
 *   A3 participação TEMPORÁRIA no guardião + CREATE temporário no schema, na MESMA transação da migração que transfere ou
 *      recria função dele; revogados antes do commit (o guardião termina sem membro utilizável)
 *   A4 USAGE no schema só para os três papéis do módulo
 * `papel`: executa como esse papel (SET ROLE), para reproduzir os privilégios do migrador gerenciado.
 */
export async function aplicarMigracoes(poolSeguro, { pasta = PASTA_DE_MIGRACOES, schema = ESQUEMA_FINANCEIRO, papel = null } = {}) {
  if (!poolSeguro?.declarado) throw new Error("Financeiro v2: migrações só rodam por conexão conferida pela guarda de destino.");
  if (!/^[a-z_][a-z0-9_]*$/.test(schema) || schema === "public") throw new Error("Financeiro v2: schema dedicado inválido.");
  if (papel !== null && !/^[a-z_][a-z0-9_]*$/.test(papel)) throw new Error("Financeiro v2: papel de migração inválido.");
  const cliente = await poolSeguro.connect();
  const aplicadas = [];
  try {
    if (papel) await cliente.query(`set role ${papel}`);
    await cliente.query("begin");
    try {
      await cliente.query(`create schema if not exists ${schema}`);
      await cliente.query(`revoke all on schema ${schema} from public`);
      await cliente.query(`do $$ begin
        ${PAPEIS_DO_MODULO.map((r) => `if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} nologin; end if;`).join("\n        ")}
      end $$`);
      await cliente.query(`grant usage on schema ${schema} to ${PAPEIS_DO_MODULO.join(", ")}`);
      await cliente.query(`create table if not exists ${schema}.fv2_migracao (nome text primary key, sha256 text not null, sha256_aplicado text, aplicada_em timestamptz not null default now())`);
      await cliente.query("commit");
    } catch (e) {
      await cliente.query("rollback");
      throw e;
    }
    await cliente.query(`set search_path = ${schema}, pg_catalog`);
    for (const m of listarMigracoes(pasta)) {
      const { rows } = await cliente.query("select sha256 from fv2_migracao where nome = $1", [m.nome]);
      if (rows.length) {
        if (rows[0].sha256 !== m.sha256) throw new Error(`Financeiro v2: a migração ${m.nome} já foi aplicada com outro conteúdo. Crie uma nova migração em vez de editar.`);
        continue;
      }
      const sql = textoAplicado(m.sql, schema);
      const sha256Aplicado = createHash("sha256").update(sql).digest("hex");
      await cliente.query("begin");
      try {
        const guardiao = await tocaFuncoesDoGuardiao(cliente, sql);
        if (guardiao) await cliente.query(`grant fv2_guardiao to current_user; grant create on schema ${schema} to fv2_guardiao`);
        await cliente.query(sql);
        if (guardiao) await cliente.query(`revoke create on schema ${schema} from fv2_guardiao; revoke fv2_guardiao from current_user`);
        await cliente.query("insert into fv2_migracao (nome, sha256, sha256_aplicado) values ($1, $2, $3)", [m.nome, m.sha256, sha256Aplicado]);
        await cliente.query("commit");
      } catch (e) {
        await cliente.query("rollback");
        throw e;
      }
      aplicadas.push(m.nome);
    }
    await cliente.query(sqlSemExecucaoPublica(schema)); // A5: sempre ao fim (inclusive sem migração nova)
  } finally {
    await cliente.query("reset search_path").catch(() => {});
    if (papel) await cliente.query("reset role").catch(() => {});
    cliente.release();
  }
  return aplicadas;
}
