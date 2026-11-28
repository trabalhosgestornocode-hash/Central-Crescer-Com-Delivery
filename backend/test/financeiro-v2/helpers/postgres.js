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
import { ACAO, criarRepositorioPostgres } from "../../../src/modules/financeiro-v2/index.js";
import { abrirPoolSeguro, anotarBancoDaExecucao, fixarSearchPathDoBanco, lerAmbiente, listarMigracoes, retirarBancosDaExecucao, urlDoBanco } from "../../../scripts/fv2/ambiente.mjs";

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
    // 23/11: modelo criado ANTES de uma migração nova (ex.: 0031) faz dezenas de testes falharem por "sem concessão" —
    // falso alarme de segurança. Modelo desatualizado é erro explícito (nunca pula em silêncio): rode `iniciar` de novo.
    if (carregado.disponivel) {
      const faltam = listarMigracoes().filter((m) => !String(a.migracoes ?? "").split("|").includes(`${m.nome}:${m.sha256}`)).map((m) => m.nome);
      if (faltam.length) throw new Error(`Financeiro v2: banco-modelo de teste DESATUALIZADO (sem ${faltam.join(", ")}). Rode: node scripts/fv2-banco-teste.mjs iniciar`);
    }
  }
  if (!carregado.disponivel && EXIGIR) throw new Error(`Financeiro v2: banco de teste exigido, mas ${carregado.motivo}.`);
  return carregado;
}

export const motivoParaPular = () => {
  const a = ambiente();
  if (a.disponivel) return false;
  // 27/11: teste de PostgreSQL NUNCA passa em silêncio sem o banco — sem ele, FALHA. Pular só com a escolha consciente TESTES_SEM_BANCO=1.
  if (process.env.TESTES_SEM_BANCO !== "1") throw new Error(`Financeiro v2: PostgreSQL de teste obrigatório indisponível — ${a.motivo}. Rode node scripts/fv2-banco-teste.mjs iniciar (ou TESTES_SEM_BANCO=1 para pular conscientemente).`);
  return `PostgreSQL local isolado indisponível: ${a.motivo}`;
};

const pools = new Set();
/** pool da aplicação → emissor de token do banco de teste correspondente (para os testes de SQL cru). */
const sessaoDoPool = new WeakMap();
const USUARIO_PADRAO = "cccccccc-0000-4000-8000-000000000001";
/** Token de sessão de banco para SQL cru no pool da aplicação. Pool desconhecido (ex.: o do dono) → sem sessão. */
export async function tokenDeTeste(pool, escopo) {
  const emitir = sessaoDoPool.get(pool);
  return emitir ? emitir({ usuarioId: USUARIO_PADRAO, ...escopo }) : null;
}
export async function abrirPool(url, opcoes) {
  const pool = await abrirPoolSeguro(url, ambiente().marcador, opcoes);
  pools.add(pool);
  return pool;
}

let admin;
const poolAdmin = async () => (admin ??= await abrirPool(ambiente().urlAdmin, { max: 2 }));

// 27/11 (PR #236): cada teste clonava um banco (~10 MB) e NENHUM era apagado — 7.235 bancos lotaram o disco.
// Agora todo banco descartável criado POR ESTE PROCESSO é registrado aqui e apagado no fim do arquivo de teste, inclusive
// quando o teste falha (o `after` roda mesmo assim). Só nomes do padrão de teste, nunca o modelo nem o banco de controle.
const NOME_DESCARTAVEL = /^fv2_teste_(?!modelo_|controle$)[0-9a-z_]+$/;
/** nome → exige o marcador do ambiente para apagar (só o teste que cria banco SEM marcador de propósito passa false) */
const descartaveis = new Map();
/**
 * Registra, ANTES do `create database`, um banco que este processo vai criar: entra na lista do processo
 * (<pasta>/execucoes/<pid>.lista — o `limpar` nunca apaga banco de processo vivo) e é apagado no fim do arquivo.
 */
export function registrarBancoDescartavel(nome, { semMarcador = false } = {}) {
  if (!NOME_DESCARTAVEL.test(nome ?? "")) throw new Error(`registrarBancoDescartavel: nome fora do padrão de teste (${nome})`);
  anotarBancoDaExecucao(nome);
  descartaveis.set(nome, !semMarcador);
}
/** Já apagado por quem criou (ex.: descartarBancoMova): sai do registro e da lista do processo. */
export function esquecerBancoDescartavel(nome) {
  descartaveis.delete(nome);
  retirarBancosDaExecucao([nome]);
}

/**
 * Apaga os bancos registrados. SEM `with (force)`: banco que ainda tenha conexão (de qualquer processo) NÃO é apagado —
 * fica com aviso, para o `limpar` do script (que também só apaga banco sem conexão). Chamado depois de fechar os pools.
 */
async function apagarDescartaveis() {
  if (!descartaveis.size || !carregado?.disponivel) return;
  const a = carregado;
  const adm = await abrirPoolSeguro(a.urlAdmin, a.marcador, { max: 1 });
  try {
    for (const [nome, exigirMarcador] of [...descartaveis]) {
      for (let tentativa = 1; ; tentativa++) {
        try {
          // confere o marcador do ambiente antes de apagar (banco sem marcador só se quem criou declarou)
          const { rows } = await adm.query("select shobj_description(oid, 'pg_database') as c from pg_database where datname = $1", [nome]);
          if (exigirMarcador && rows.length && rows[0].c !== `FV2_ISOLADO_TESTE:${a.marcador}`) { descartaveis.delete(nome); break; }
          await adm.query(`drop database if exists ${nome}`);
          esquecerBancoDescartavel(nome);
          break;
        } catch (e) {
          // 55006: ainda há sessão no banco (o pool acabou de fechar e o servidor demora a soltar) → espera um pouco
          if (e?.code === "55006" && tentativa < 5) { await new Promise((r) => setTimeout(r, 200 * tentativa)); continue; }
          process.stderr.write(`[fv2-teste] banco ${nome} não apagado (${e?.code ?? e?.message}); rode: node scripts/fv2-banco-teste.mjs limpar\n`);
          break;
        }
      }
    }
  } finally {
    await adm.end().catch(() => {});
  }
}

/**
 * Cria um banco NOVO, só deste teste, a partir do modelo já migrado (ou vazio, com `vazio: true`), com o marcador do
 * ambiente e os escopos sintéticos. Devolve as URLs de aplicação (papel sem privilégio de dono) e de administração.
 */
export async function criarBancoDeTeste(escopos = [], { vazio = false } = {}) {
  const a = ambiente();
  const banco = `fv2_teste_${randomBytes(6).toString("hex")}`;
  const adm = await poolAdmin();
  registrarBancoDescartavel(banco);
  await adm.query(`create database ${banco} template ${vazio ? "template0" : a.bancoModelo}`);
  await adm.query(`comment on database ${banco} is 'FV2_ISOLADO_TESTE:${a.marcador}'`);
  await fixarSearchPathDoBanco(adm, banco); // o módulo vive no schema dedicado (financeiro_v2)
  const urlAdmin = urlDoBanco(a.urlAdmin, banco);
  const urlApp = urlDoBanco(a.urlApp, banco);
  if (!a.urlAutoridade) throw new Error("Financeiro v2: ambiente sem a credencial da autoridade (rode: node scripts/fv2-banco-teste.mjs iniciar).");
  const urlAutoridade = urlDoBanco(a.urlAutoridade, banco);
  if (escopos.length) {
    const dono = await abrirPool(urlAdmin, { max: 1 });
    for (const e of escopos) {
      await dono.query("insert into fv2_escopo (organizacao_id, unidade_id, rotulo) values ($1, $2, $3)", [e.organizacaoId, e.unidadeId, "Escopo sintético de teste"]);
    }
  }
  return { banco, urlApp, urlAdmin, urlAutoridade };
}

/** Autor sintético das concessões-fixture (nunca é um usuário de teste). */
export const AUTOR_DA_FIXTURE = "f1f1f1f1-0000-4000-8000-0000000000f1";

/**
 * AUTORIDADE DE SESSÕES de teste (07B): faz o papel do gateway de autenticação, com a credencial PRÓPRIA da autoridade
 * (nunca a da aplicação). Emite sessões de banco e sessões de provisionamento pelas funções guardadas do banco.
 *
 * `espelharContexto` (padrão nos testes gerais): FIXTURE de teste — quando um usuário sintético opera pela primeira vez
 * numa unidade e ainda NÃO tem concessão gravada, o DONO do banco grava uma concessão com as ações do contexto
 * confiável do teste (como se ele tivesse sido provisionado antes). Nunca sobrescreve concessão existente: revogações
 * e concessões feitas pelo teste continuam valendo. Os testes de segurança desligam a fixture.
 */
export function criarAutoridadeDeTeste({ urlAutoridade, urlAdmin, espelharContexto = true, validadeSegundos = 3600 }) {
  let pool;
  let dono;
  const autoridade = async () => (pool ??= await abrirPool(urlAutoridade, { max: 4 }));
  const abrir = async (e) => (await (await autoridade()).query("select fv2_abrir_sessao($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::text) as t", [e.usuarioId, e.organizacaoId, e.unidadeId, validadeSegundos, "teste"])).rows[0].t;
  async function espelhar(e) {
    dono ??= await abrirPool(urlAdmin, { max: 1 });
    await dono.query(`with nova as (
        insert into fv2_concessao (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por,
                                   chave_idempotencia, impressao, extras, usuario_id, acoes, situacao, concedido_por, justificativa)
        select gen_random_uuid(), $1::uuid, $2::uuid, 1, now(), $4::uuid, now(), $4::uuid, 'concessao:' || $3, null, '{}'::jsonb,
               $3::uuid, $5::jsonb, 'ATIVA', $4::uuid, 'Fixture de teste: espelha o contexto confiável do teste.'
         where not exists (select 1 from fv2_concessao where organizacao_id = $1::uuid and unidade_id = $2::uuid and usuario_id = $3::uuid)
        on conflict do nothing
        returning *)
      insert into fv2_historico (id, organizacao_id, unidade_id, registro_tipo, registro_id, evento, antes, depois, justificativa, usuario_id, em)
      select gen_random_uuid(), organizacao_id, unidade_id, 'CONCESSAO', id, 'CRIACAO', null,
             jsonb_build_object('versao', 1, 'acoes', acoes, 'situacao', situacao), justificativa, concedido_por, now() from nova`,
    [e.organizacaoId, e.unidadeId, e.usuarioId, AUTOR_DA_FIXTURE, JSON.stringify([...new Set(e.permissoes)].sort())]);
  }
  return Object.freeze({
    autoridade,
    async emitir(e) {
      try {
        return await abrir(e);
      } catch (erro) {
        if (erro?.code !== "FV020" || !espelharContexto || !e.permissoes?.length) throw erro;
        try {
          await espelhar(e);
        } catch {
          throw erro;
        }
        return abrir(e);
      }
    },
    async emitirProvisionamento(a) {
      const { rows } = await (await autoridade()).query(
        "select fv2_abrir_sessao_de_provisionamento($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb, $6::text, $7::text, $8::text) as t",
        [a.atestanteId, a.usuarioId, a.organizacaoId, a.unidadeId, JSON.stringify(a.acoes), a.nivelAutenticacao ?? null, a.justificativa, a.evidencia],
      );
      return rows[0].t;
    },
  });
}

/** Repositório PostgreSQL sobre um banco novo. A criação do banco acontece na primeira transação (montar() é síncrono). */
export function repositorioPostgresDeTeste(escopos, { concessoesDeTeste = true } = {}) {
  let pronto;
  const iniciar = () => (pronto ??= (async () => {
    const { urlApp, urlAdmin, urlAutoridade, banco } = await criarBancoDeTeste(escopos);
    const pool = await abrirPool(urlApp);
    const sessoes = criarAutoridadeDeTeste({ urlAutoridade, urlAdmin, espelharContexto: concessoesDeTeste });
    sessaoDoPool.set(pool, (e) => sessoes.emitir({ permissoes: Object.values(ACAO), ...e }));
    return {
      repo: criarRepositorioPostgres({ pool, sessoes }), pool, sessoes, urlApp, urlAdmin, urlAutoridade, banco,
      dono: () => abrirPool(urlAdmin, { max: 1 }),
      /** Token de sessão de banco para SQL cru nos testes (como a aplicação faria). */
      sessao: (e) => sessoes.emitir({ permissoes: Object.values(ACAO), ...e }),
    };
  })());
  return Object.freeze({
    transacao: async (fn, opcoes) => (await iniciar()).repo.transacao(fn, opcoes),
    transacaoEntreEscopos: async (fn, opcoes) => (await iniciar()).repo.transacaoEntreEscopos(fn, opcoes),
    leitura: async (fn, opcoes) => (await iniciar()).repo.leitura(fn, opcoes),
    /** Acesso direto para os testes de banco (SQL cru como papel de aplicação ou como dono). */
    interno: iniciar,
  });
}

/**
 * SQL cru COMO A APLICAÇÃO, dentro de uma transação com a sessão de banco do escopo (token emitido pela autoridade).
 * `token: null` simula a aplicação sem sessão; um token qualquer simula sessão forjada.
 */
export async function comoAplicacao(interno, escopo, fn, { token } = {}) {
  const t = token === undefined ? await interno.sessao(escopo) : token;
  const cl = await interno.pool.connect();
  try {
    await cl.query("begin");
    await cl.query("select fv2_assumir_sessao($1)", [t]);
    const r = await fn(cl);
    await cl.query("commit");
    return r;
  } catch (e) {
    await cl.query("rollback").catch(() => {});
    throw e;
  } finally {
    cl.release();
  }
}

// Fecha todas as conexões ao fim de cada arquivo de teste (senão o processo não termina) e, em seguida, apaga os bancos
// descartáveis que este arquivo criou (também quando algum teste falhou).
after(async () => {
  for (const p of pools) await p.end().catch(() => {});
  pools.clear();
  admin = undefined;
  await apagarDescartaveis().catch((e) => process.stderr.write(`[fv2-teste] limpeza dos bancos falhou: ${e?.message}\n`));
});
