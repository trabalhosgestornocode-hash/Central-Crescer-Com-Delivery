// Banco de teste do MOVA: um database NOVO por chamada, no PostgreSQL LOCAL ISOLADO do Financeiro v2 (porta 54329, criado por
// scripts/fv2-banco-teste.mjs), com a migração do MOVA aplicada só ali. Nunca lê .env nem banco remoto (mesmas barreiras do
// helper do Financeiro v2). Sem o ambiente local: os testes de banco são PULADOS com aviso (MOVA_EXIGIR_BANCO=1 = falha).
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { abrirPool, ambiente, registrarBancoParaApagar } from "../../financeiro-v2/helpers/postgres.js";
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
  await admin.query(`create database ${banco} template template0`);
  registrarBancoParaApagar(banco); // 17B: apagado no fim do arquivo de teste (antes ficava para sempre)
  await admin.query(`comment on database ${banco} is 'FV2_ISOLADO_TESTE:${a.marcador}'`);
  const pool = await abrirPool(urlDoBanco(a.urlAdmin, banco), { max: 8 });
  for (const f of MIGRACOES) await pool.query(readFileSync(join(PASTA, f), "utf8"));
  return { pool, banco };
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
