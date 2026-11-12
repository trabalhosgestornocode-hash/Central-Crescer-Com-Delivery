// GUARDA DE DESTINO do banco do Financeiro v2 nesta fase (Execução 01B).
//
// Enquanto a fundação não for homologada, o ÚNICO banco em que o Financeiro v2 pode executar SQL é o PostgreSQL local,
// exclusivo e descartável criado por backend/scripts/fv2-banco-teste.mjs. Tudo o mais é recusado — e recusar é o padrão:
// endereço ausente, desconhecido, remoto, com nome de máquina ou na porta padrão é BLOQUEADO.
//
// São duas barreiras, e as duas são obrigatórias:
//   1. exigirDestinoLocal(url)          → antes de conectar: confere o endereço DECLARADO (não confia em nome de variável).
//   2. comprovarDestinoIsolado(cliente) → depois de conectar e antes de qualquer outro SQL: confere o destino EFETIVO —
//      endereço real do servidor, marcador secreto gravado na criação do ambiente, e ausência de qualquer sinal de
//      banco compartilhado (esquemas/papéis de plataforma gerenciada, bancos que não são do Financeiro v2).
//
// Este módulo não lê variáveis de ambiente nem arquivos: quem chama entrega o endereço e o marcador.
import { CODIGO, falhar } from "../../dominio/erros.js";

const ENDERECOS_LOCAIS = Object.freeze(["127.0.0.1", "::1"]);
const PORTA_PADRAO = "5432";
const NOME_DE_BANCO = /^fv2_teste(_[a-z0-9_]{1,40})?$/;
const NOME_DE_USUARIO = /^fv2_[a-z0-9_]{1,40}$/;
const MARCADOR = /^[0-9a-f]{32,128}$/;
const PARAMETROS_ACEITOS = Object.freeze(["sslmode", "application_name"]);
export const PREFIXO_DO_MARCADOR = "FV2_ISOLADO_TESTE:";

/** Esquemas e papéis que só existem em bancos de plataforma gerenciada/compartilhada — nunca no ambiente isolado. */
const ESQUEMAS_ALHEIOS = Object.freeze(["auth", "storage", "realtime", "vault", "graphql", "graphql_public", "extensions", "pgbouncer", "net"]);
const PAPEIS_ALHEIOS = Object.freeze(["authenticator", "authenticated", "anon", "service_role", "dashboard_user", "pgbouncer", "rdsadmin", "cloudsqladmin", "azure_pg_admin"]);

const recusar = (motivo) => falhar(CODIGO.DESTINO_NAO_AUTORIZADO, `Destino de banco recusado: ${motivo}.`, { motivo });

/**
 * Confere o endereço declarado. Não conecta em nada.
 * @param {unknown} url endereço postgres://usuario:senha@127.0.0.1:PORTA/fv2_teste...
 * @returns {{endereco:string, porta:string, banco:string, usuario:string}} dados conferidos (sem a senha)
 */
export function exigirDestinoLocal(url) {
  if (typeof url !== "string" || url.trim() === "") recusar("endereço ausente");
  let u;
  try {
    u = new URL(url);
  } catch {
    recusar("endereço ilegível");
  }
  if (!["postgres:", "postgresql:"].includes(u.protocol)) recusar("protocolo que não é PostgreSQL");
  const endereco = u.hostname.replace(/^\[|\]$/g, "");
  // Só IP de loopback literal: nome de máquina (até "localhost") depende de resolução de nomes e não prova nada.
  if (!ENDERECOS_LOCAIS.includes(endereco)) recusar("servidor que não é o loopback desta máquina");
  if (!u.port) recusar("porta não informada");
  if (u.port === PORTA_PADRAO) recusar("porta padrão do PostgreSQL (a instância exclusiva usa porta própria)");
  const banco = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!NOME_DE_BANCO.test(banco)) recusar("banco que não é do ambiente de teste do Financeiro v2");
  const usuario = decodeURIComponent(u.username);
  if (!NOME_DE_USUARIO.test(usuario)) recusar("usuário que não é do ambiente de teste do Financeiro v2");
  for (const nome of u.searchParams.keys()) {
    // Parâmetros como host/hostaddr/service/options redirecionariam a conexão para outro servidor.
    if (!PARAMETROS_ACEITOS.includes(nome)) recusar("parâmetro de conexão não permitido");
  }
  return Object.freeze({ endereco, porta: u.port, banco, usuario });
}

/**
 * Confere o destino EFETIVO de uma conexão já aberta. Deve ser a primeira consulta de toda conexão nova.
 * @param {{query: Function}} cliente
 * @param {{marcador:string, declarado:{porta:string, banco:string, usuario:string}}} esperado
 */
export async function comprovarDestinoIsolado(cliente, { marcador, declarado }) {
  if (typeof marcador !== "string" || !MARCADOR.test(marcador)) recusar("marcador do ambiente isolado ausente ou inválido");
  if (!declarado?.banco || !declarado?.porta || !declarado?.usuario) recusar("endereço declarado não foi conferido");
  let linha;
  try {
    const { rows } = await cliente.query(
      `select current_database() as banco,
              current_user as usuario,
              host(inet_server_addr()) as endereco,
              inet_server_port()::text as porta,
              (select shobj_description(d.oid, 'pg_database') from pg_database d where d.datname = current_database()) as marcador,
              (select count(*)::int from pg_namespace where nspname = any($1::text[])) as esquemas_alheios,
              (select count(*)::int from pg_roles where rolname = any($2::text[])) as papeis_alheios,
              (select count(*)::int from pg_database where datname !~ '^fv2_' and datname not in ('postgres', 'template0', 'template1')) as bancos_alheios`,
      [ESQUEMAS_ALHEIOS, PAPEIS_ALHEIOS],
    );
    [linha] = rows;
  } catch {
    recusar("não foi possível comprovar o destino da conexão");
  }
  if (!linha) recusar("não foi possível comprovar o destino da conexão");
  if (!ENDERECOS_LOCAIS.includes(linha.endereco)) recusar("o servidor conectado não está no loopback desta máquina");
  if (linha.porta !== declarado.porta || linha.banco !== declarado.banco || linha.usuario !== declarado.usuario) {
    recusar("a conexão não chegou ao banco declarado");
  }
  if (linha.marcador !== `${PREFIXO_DO_MARCADOR}${marcador}`) recusar("o banco não tem o marcador do ambiente isolado do Financeiro v2");
  if (linha.esquemas_alheios !== 0 || linha.papeis_alheios !== 0) recusar("o servidor tem sinais de banco de plataforma compartilhada");
  if (linha.bancos_alheios !== 0) recusar("o servidor hospeda bancos que não são do Financeiro v2");
  return Object.freeze({ endereco: linha.endereco, porta: linha.porta, banco: linha.banco, usuario: linha.usuario });
}
