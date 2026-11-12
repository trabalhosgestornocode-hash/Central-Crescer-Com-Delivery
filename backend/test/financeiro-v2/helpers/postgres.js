// Acesso ao PostgreSQL LOCAL ISOLADO do Financeiro v2 para os testes.
//
// REGRAS (não negociáveis):
//   - Este arquivo NUNCA lê o .env do backend nem variáveis do sistema atual (SUPABASE_*, DATABASE_URL...).
//     A única entrada é o ambiente gerado por scripts/fv2-banco-teste.mjs, que fica FORA do repositório.
//   - Toda conexão passa pelas duas barreiras de infra/postgres/destinoSeguro.js (scripts/fv2/ambiente.mjs).
//   - Sem ambiente local, os testes de banco são PULADOS com aviso explícito (nunca "passam" sem banco).
//     Com FV2_EXIGIR_BANCO=1 ou FV2_REPOSITORIO=postgres, a ausência do banco é FALHA.
import { randomBytes } from "node:crypto";
import { after } from "node:test";
import { criarRepositorioPostgres } from "../../../src/modules/financeiro-v2/index.js";
import { abrirPoolSeguro, lerAmbiente, urlDoBanco } from "../../../scripts/fv2/ambiente.mjs";

export const EM_POSTGRES = process.env.FV2_REPOSITORIO === "postgres";
const EXIGIR = process.env.FV2_EXIGIR_BANCO === "1" || EM_POSTGRES;

let carregado;
/** Ambiente conferido, ou { disponivel:false, motivo } quando não há banco local utilizável. */
export function ambiente() {
  if (!carregado) {
    const a = lerAmbiente();
    if (!a) carregado = { disponivel: false, motivo: "ambiente local não iniciado (rode: node scripts/fv2-banco-teste.mjs iniciar)" };
    else if (!a.bancoModelo) carregado = { disponivel: false, motivo: "banco-modelo ausente (rode: node scripts/fv2-banco-teste.mjs iniciar)" };
    else carregado = { disponivel: true, ...a };
  }
  if (!carregado.disponivel && EXIGIR) throw new Error(`Financeiro v2: banco de teste exigido, mas ${carregado.motivo}.`);
  return carregado;
}

export const motivoParaPular = () => {
  const a = ambiente();
  return a.disponivel ? false : `PostgreSQL local isolado indisponível: ${a.motivo}`;
};

const pools = new Set();
export async function abrirPool(url, opcoes) {
  const pool = await abrirPoolSeguro(url, ambiente().marcador, opcoes);
  pools.add(pool);
  return pool;
}

let admin;
const poolAdmin = async () => (admin ??= await abrirPool(ambiente().urlAdmin, { max: 2 }));

/**
 * Cria um banco NOVO, só deste teste, a partir do modelo já migrado (ou vazio, com `vazio: true`), com o marcador do
 * ambiente e os escopos sintéticos. Devolve as URLs de aplicação (papel sem privilégio de dono) e de administração.
 */
export async function criarBancoDeTeste(escopos = [], { vazio = false } = {}) {
  const a = ambiente();
  const banco = `fv2_teste_${randomBytes(6).toString("hex")}`;
  const adm = await poolAdmin();
  await adm.query(`create database ${banco} template ${vazio ? "template0" : a.bancoModelo}`);
  await adm.query(`comment on database ${banco} is 'FV2_ISOLADO_TESTE:${a.marcador}'`);
  const urlAdmin = urlDoBanco(a.urlAdmin, banco);
  const urlApp = urlDoBanco(a.urlApp, banco);
  if (escopos.length) {
    const dono = await abrirPool(urlAdmin, { max: 1 });
    for (const e of escopos) {
      await dono.query("insert into fv2_escopo (organizacao_id, unidade_id, rotulo) values ($1, $2, $3)", [e.organizacaoId, e.unidadeId, "Escopo sintético de teste"]);
    }
  }
  return { banco, urlApp, urlAdmin };
}

/** Repositório PostgreSQL sobre um banco novo. A criação do banco acontece na primeira transação (montar() é síncrono). */
export function repositorioPostgresDeTeste(escopos) {
  let pronto;
  const iniciar = () => (pronto ??= (async () => {
    const { urlApp, urlAdmin, banco } = await criarBancoDeTeste(escopos);
    const pool = await abrirPool(urlApp);
    return { repo: criarRepositorioPostgres({ pool }), pool, urlApp, urlAdmin, banco, dono: () => abrirPool(urlAdmin, { max: 1 }) };
  })());
  return Object.freeze({
    transacao: async (fn, opcoes) => (await iniciar()).repo.transacao(fn, opcoes),
    leitura: async (fn, opcoes) => (await iniciar()).repo.leitura(fn, opcoes),
    /** Acesso direto para os testes de banco (SQL cru como papel de aplicação ou como dono). */
    interno: iniciar,
  });
}

// Fecha todas as conexões ao fim de cada arquivo de teste (senão o processo não termina).
after(async () => {
  for (const p of pools) await p.end().catch(() => {});
  pools.clear();
  admin = undefined;
});
