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

/**
 * Aplica as migrações pendentes, em ordem, cada uma em sua transação, e registra nome + hash.
 * Migração já aplicada é pulada; se o arquivo de uma migração já aplicada mudou, PARA (migração aplicada não se edita).
 * Só aceita pool vindo de abrirPoolSeguro — ou seja, só roda no ambiente isolado.
 */
export async function aplicarMigracoes(poolSeguro, { pasta = PASTA_DE_MIGRACOES } = {}) {
  if (!poolSeguro?.declarado) throw new Error("Financeiro v2: migrações só rodam por conexão conferida pela guarda de destino.");
  const cliente = await poolSeguro.connect();
  const aplicadas = [];
  try {
    await cliente.query("create table if not exists fv2_migracao (nome text primary key, sha256 text not null, aplicada_em timestamptz not null default now())");
    for (const m of listarMigracoes(pasta)) {
      const { rows } = await cliente.query("select sha256 from fv2_migracao where nome = $1", [m.nome]);
      if (rows.length) {
        if (rows[0].sha256 !== m.sha256) throw new Error(`Financeiro v2: a migração ${m.nome} já foi aplicada com outro conteúdo. Crie uma nova migração em vez de editar.`);
        continue;
      }
      await cliente.query("begin");
      try {
        await cliente.query(m.sql);
        await cliente.query("insert into fv2_migracao (nome, sha256) values ($1, $2)", [m.nome, m.sha256]);
        await cliente.query("commit");
      } catch (e) {
        await cliente.query("rollback");
        throw e;
      }
      aplicadas.push(m.nome);
    }
  } finally {
    cliente.release();
  }
  return aplicadas;
}
