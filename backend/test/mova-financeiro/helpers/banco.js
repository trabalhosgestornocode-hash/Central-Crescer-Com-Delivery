// Banco de teste do MOVA: um database NOVO por chamada, no PostgreSQL LOCAL ISOLADO do Financeiro v2 (porta 54329, criado por
// scripts/fv2-banco-teste.mjs), com a migração do MOVA aplicada só ali. Nunca lê .env nem banco remoto (mesmas barreiras do
// helper do Financeiro v2). Sem o ambiente local: os testes de banco são PULADOS com aviso (MOVA_EXIGIR_BANCO=1 = falha).
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { abrirPool, ambiente, esquecerBancoDescartavel, registrarBancoDescartavel } from "../../financeiro-v2/helpers/postgres.js";
import { lerAmbiente, urlDoBanco } from "../../../scripts/fv2/ambiente.mjs";

const PASTA = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "database", "mova-financeiro", "migracoes");
export const MIGRACOES = readdirSync(PASTA).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();

export function motivoParaPularMova() {
  const a = lerAmbiente();
  const motivo = !a ? "PostgreSQL local isolado não iniciado (node scripts/fv2-banco-teste.mjs iniciar)" : null;
  if (motivo && process.env.MOVA_EXIGIR_BANCO === "1") throw new Error(`MOVA: banco de teste exigido, mas ${motivo}.`);
  return motivo ?? false;
}

let admin;
export async function criarBancoMova() {
  const a = ambiente();
  admin ??= await abrirPool(a.urlAdmin, { max: 2 });
  const banco = `fv2_teste_mova_${randomBytes(6).toString("hex")}`; // nome dentro da guarda de destino do ambiente isolado
  registrarBancoDescartavel(banco); // apagado no fim do arquivo se o teste não o descartar (inclusive quando falha)
  await admin.query(`create database ${banco} template template0`);
  await admin.query(`comment on database ${banco} is 'FV2_ISOLADO_TESTE:${a.marcador}'`);
  const pool = await abrirPool(urlDoBanco(a.urlAdmin, banco), { max: 8 });
  for (const f of MIGRACOES) await pool.query(readFileSync(join(PASTA, f), "utf8"));
  return { pool, banco };
}

/**
 * Agente 2: apaga UM banco criado por criarBancoMova NESTA execução (nunca um banco existente). Só nomes do padrão de teste.
 */
export async function descartarBancoMova({ pool, banco }) {
  if (!/^fv2_teste_mova_[0-9a-f]{12}$/.test(banco ?? "")) throw new Error("descartarBancoMova: nome fora do padrão de teste");
  await pool.end().catch(() => {});
  await admin.query(`drop database if exists ${banco} with (force)`);
  esquecerBancoDescartavel(banco);
}

/** Pool que falha como banco fora do ar enquanto `fora` for verdadeiro (interrupção simulada). */
export function poolInterrompivel(pool) {
  const estado = { fora: false };
  const falha = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:54329"), { code: "ECONNREFUSED" });
  return {
    estado,
    pool: {
      query: (...args) => (estado.fora ? Promise.reject(falha()) : pool.query(...args)),
      connect: async () => {
        if (estado.fora) throw falha();
        const c = await pool.connect();
        return { query: (...args) => (estado.fora ? Promise.reject(falha()) : c.query(...args)), release: () => c.release() };
      },
    },
  };
}
