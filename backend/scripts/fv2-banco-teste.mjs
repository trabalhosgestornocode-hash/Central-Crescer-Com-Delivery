#!/usr/bin/env node
// PostgreSQL LOCAL, EXCLUSIVO e DESCARTÁVEL do Financeiro v2 (Execução 01B).
//
//   node scripts/fv2-banco-teste.mjs iniciar    cria (se preciso) e liga o servidor; aplica as migrações no banco-modelo
//   node scripts/fv2-banco-teste.mjs estado     mostra se está ligado e onde
//   node scripts/fv2-banco-teste.mjs parar      desliga o servidor (os dados ficam)
//   node scripts/fv2-banco-teste.mjs derrubar   desliga ABRUPTAMENTE (modo imediato, como uma queda); os dados ficam
//   node scripts/fv2-banco-teste.mjs limpar     apaga os bancos descartáveis ÓRFÃOS (de execuções que travaram); mantém modelo e controle
//   node scripts/fv2-banco-teste.mjs destruir   desliga e APAGA a pasta do ambiente (só ela)
//
// O que este script faz e NÃO faz:
//   - Usa os binários do PostgreSQL já instalados na máquina (initdb, pg_ctl, psql). Não instala nada, não cria serviço
//     do Windows, não mexe no PostgreSQL que já roda na porta 5432 e não altera configuração do sistema.
//   - Cria um servidor PRÓPRIO, numa pasta fora do repositório, escutando SÓ em 127.0.0.1, em porta própria,
//     com usuários e senhas aleatórios gerados na hora (gravados apenas em <pasta>/ambiente.json).
//   - NÃO lê o .env do backend, NÃO usa variável do sistema atual e NÃO conecta em nenhum servidor remoto.
//   - Depois de ligado, todo SQL passa pela guarda de destino (endereço declarado + destino efetivo comprovado).
//
// Variáveis opcionais: FV2_PG_DIR (pasta do ambiente), FV2_PG_PORTA (porta, padrão 54329), FV2_PG_BIN (pasta dos binários).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, join } from "node:path";
import { ESQUEMA_FINANCEIRO, abrirPoolSeguro, aplicarMigracoes, arquivoDoAmbiente, lerAmbiente, listarMigracoes, pastaDoAmbiente, urlDoBanco } from "./fv2/ambiente.mjs";

const ENDERECO = "127.0.0.1";
const PORTA = process.env.FV2_PG_PORTA || "54329";
const PASTA = pastaDoAmbiente();
const DADOS = join(PASTA, "dados");
const EXE = process.platform === "win32" ? ".exe" : "";

const dizer = (...m) => process.stdout.write(`${m.join(" ")}\n`);
const parar = (mensagem) => { process.stderr.write(`ERRO: ${mensagem}\n`); process.exit(1); };

function pastaDosBinarios() {
  const candidatas = [];
  if (process.env.FV2_PG_BIN) candidatas.push(process.env.FV2_PG_BIN);
  for (const dir of (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":")) candidatas.push(dir);
  if (process.platform === "win32") {
    const raiz = join(process.env.ProgramFiles || "C:\\Program Files", "PostgreSQL");
    if (existsSync(raiz)) for (const v of readdirSync(raiz).sort().reverse()) candidatas.push(join(raiz, v, "bin"));
  }
  const achada = candidatas.find((d) => d && ["initdb", "pg_ctl", "psql"].every((b) => existsSync(join(d, b + EXE))));
  if (!achada) parar("binários do PostgreSQL (initdb, pg_ctl, psql) não encontrados. Instale o PostgreSQL ou informe FV2_PG_BIN. Nenhum banco remoto será usado como alternativa.");
  return achada;
}

function rodar(bin, args, { env = {}, tolerar = false, semSaida = false } = {}) {
  // `semSaida`: o servidor iniciado pelo pg_ctl herdaria os canais de saída e este script ficaria esperando para sempre.
  const r = spawnSync(join(pastaDosBinarios(), bin + EXE), args, { encoding: "utf8", windowsHide: true, env: { ...process.env, ...env }, stdio: semSaida ? "ignore" : "pipe" });
  if (r.status !== 0 && !tolerar) parar(`${bin} falhou${semSaida ? ` (veja ${join(PASTA, "servidor.log")})` : `:\n${r.stderr || r.stdout}`}`);
  return r;
}

const ligarServidor = () => rodar("pg_ctl", ["start", "-D", DADOS, "-l", join(PASTA, "servidor.log"), "-w"], { semSaida: true });

const portaOcupada = () => new Promise((resolver) => {
  const s = createConnection({ host: ENDERECO, port: Number(PORTA) });
  s.once("connect", () => { s.destroy(); resolver(true); });
  s.once("error", () => resolver(false));
});

const ligado = () => existsSync(join(DADOS, "PG_VERSION")) && rodar("pg_ctl", ["status", "-D", DADOS], { tolerar: true }).status === 0;

function exigirPastaPropria() {
  // Só se apaga uma pasta que este script reconhece como dele.
  if (!/fv2-pg-teste/.test(basename(PASTA)) || !existsSync(join(PASTA, "FV2_AMBIENTE_ISOLADO"))) {
    parar(`a pasta ${PASTA} não é reconhecida como ambiente isolado do Financeiro v2; nada foi apagado.`);
  }
}

async function iniciar() {
  let ambiente = lerAmbiente();
  if (!existsSync(join(DADOS, "PG_VERSION"))) {
    if (await portaOcupada()) parar(`a porta ${PORTA} já está em uso por outro programa. Informe FV2_PG_PORTA.`);
    mkdirSync(PASTA, { recursive: true });
    writeFileSync(join(PASTA, "FV2_AMBIENTE_ISOLADO"), "Ambiente de banco descartável do Financeiro v2. Dados sintéticos. Pode ser apagado.\n");
    const senhaAdmin = randomBytes(24).toString("hex");
    const senhaApp = randomBytes(24).toString("hex");
    const marcador = randomBytes(32).toString("hex");
    const arquivoDeSenha = join(PASTA, "senha.tmp");
    writeFileSync(arquivoDeSenha, `${senhaAdmin}\n`, { mode: 0o600 });
    dizer("Criando servidor PostgreSQL exclusivo em", DADOS);
    rodar("initdb", ["-D", DADOS, "-U", "fv2_admin", `--pwfile=${arquivoDeSenha}`, "--auth=scram-sha-256", "-E", "UTF8", "--locale=C"]);
    rmSync(arquivoDeSenha, { force: true });
    appendFileSync(join(DADOS, "postgresql.conf"), [
      "", "# --- Financeiro v2: servidor de teste exclusivo e descartável ---",
      `listen_addresses = '${ENDERECO}'`, `port = ${PORTA}`, "max_connections = 80",
      "fsync = off", "synchronous_commit = off", "full_page_writes = off", "",
    ].join("\n"));
    ligarServidor();
    const env = { PGPASSWORD: senhaAdmin };
    const psql = (sql) => rodar("psql", ["-h", ENDERECO, "-p", PORTA, "-U", "fv2_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], { env });
    psql("create database fv2_teste_controle template template0");
    psql(`comment on database fv2_teste_controle is 'FV2_ISOLADO_TESTE:${marcador}'`);
    psql(`create role fv2_teste_app login password '${senhaApp}'`);
    ambiente = {
      aviso: "Ambiente DESCARTÁVEL do Financeiro v2. Credenciais temporárias de um servidor local. Não versionar.",
      endereco: ENDERECO, porta: PORTA, marcador, criadoEm: new Date().toISOString(),
      urlAdmin: `postgres://fv2_admin:${senhaAdmin}@${ENDERECO}:${PORTA}/fv2_teste_controle`,
      urlApp: `postgres://fv2_teste_app:${senhaApp}@${ENDERECO}:${PORTA}/fv2_teste_controle`,
      bancoModelo: null, migracoes: null,
    };
    writeFileSync(arquivoDoAmbiente(), JSON.stringify(ambiente, null, 2), { mode: 0o600 });
  } else if (!ligado()) {
    if (!ambiente) parar(`há dados em ${DADOS}, mas falta ${arquivoDoAmbiente()}. Rode "destruir" e depois "iniciar".`);
    ligarServidor();
  }
  if (!ambiente) parar(`ambiente sem ${arquivoDoAmbiente()}. Rode "destruir" e depois "iniciar".`);

  // Banco-modelo: um por conjunto de migrações. Os testes clonam o modelo; nunca escrevem nele.
  // 10 (produção): o modelo é migrado no schema DEDICADO por um papel SEM superusuário (CREATEROLE + BYPASSRLS, como o
  // `postgres` do Supabase). O aplicador e o schema entram na assinatura: mudou → modelo novo.
  const assinatura = `schema:${ESQUEMA_FINANCEIRO}|migrador:fv2_teste_migrador|aplicador:3-a5|${listarMigracoes().map((m) => `${m.nome}:${m.sha256}`).join("|")}`;
  // 07B: papel de LOGIN da autoridade de sessões (o "gateway"), com credencial própria — separada da aplicação.
  if (!ambiente.urlAutoridade) {
    const controle = await abrirPoolSeguro(ambiente.urlAdmin, ambiente.marcador, { max: 1 });
    const senhaAutoridade = randomBytes(24).toString("hex");
    const { rows } = await controle.query("select 1 from pg_roles where rolname = 'fv2_teste_autoridade'");
    await controle.query(`${rows.length ? "alter" : "create"} role fv2_teste_autoridade login password '${senhaAutoridade}'`);
    await controle.end();
    ambiente = { ...ambiente, urlAutoridade: `postgres://fv2_teste_autoridade:${senhaAutoridade}@${ENDERECO}:${ambiente.porta ?? PORTA}/fv2_teste_controle`, migracoes: null };
    writeFileSync(arquivoDoAmbiente(), JSON.stringify(ambiente, null, 2), { mode: 0o600 });
  }
  if (ambiente.migracoes !== assinatura) {
    const controle = await abrirPoolSeguro(ambiente.urlAdmin, ambiente.marcador, { max: 1 });
    const modelo = `fv2_teste_modelo_${randomBytes(4).toString("hex")}`;
    const { rows: migrador } = await controle.query("select 1 from pg_roles where rolname = 'fv2_teste_migrador'");
    if (!migrador.length) await controle.query("create role fv2_teste_migrador nologin nosuperuser createrole bypassrls");
    // Papéis do módulo criados antes por um superusuário (ambientes antigos): o migrador recebe o mesmo ADMIN sem SET/
    // INHERIT que o PostgreSQL 16+ dá a quem cria o papel — nada além do que teria num ambiente novo.
    for (const r of ["fv2_app", "fv2_autoridade", "fv2_guardiao"]) {
      const { rows } = await controle.query("select 1 from pg_roles where rolname = $1", [r]);
      if (rows.length) await controle.query(`grant ${r} to fv2_teste_migrador with admin option, inherit false, set false`);
    }
    await controle.query(`create database ${modelo} owner fv2_teste_migrador template template0`);
    await controle.query(`comment on database ${modelo} is 'FV2_ISOLADO_TESTE:${ambiente.marcador}'`);
    const noModelo = await abrirPoolSeguro(urlDoBanco(ambiente.urlAdmin, modelo), ambiente.marcador, { max: 1 });
    const aplicadas = await aplicarMigracoes(noModelo, { papel: "fv2_teste_migrador" });
    await noModelo.query("grant fv2_app to fv2_teste_app");
    await noModelo.query("grant fv2_autoridade to fv2_teste_autoridade");
    await noModelo.end();
    await controle.end();
    ambiente = { ...ambiente, bancoModelo: modelo, migracoes: assinatura };
    writeFileSync(arquivoDoAmbiente(), JSON.stringify(ambiente, null, 2), { mode: 0o600 });
    dizer("Migrações aplicadas no banco-modelo", modelo, "→", aplicadas.join(", "));
  }
  dizer(`PostgreSQL isolado do Financeiro v2 ligado em ${ENDERECO}:${PORTA} (pasta ${PASTA}).`);
}

async function principal() {
  const comando = process.argv[2];
  if (comando === "iniciar") return iniciar();
  if (comando === "estado") {
    const a = lerAmbiente();
    return dizer(ligado() ? `LIGADO em ${ENDERECO}:${a?.porta ?? PORTA}` : "DESLIGADO", `| pasta: ${PASTA} | banco-modelo: ${a?.bancoModelo ?? "—"}`);
  }
  if (comando === "parar") {
    if (ligado()) rodar("pg_ctl", ["stop", "-D", DADOS, "-m", "fast", "-w"]);
    return dizer("Servidor desligado.");
  }
  // 08C: queda ABRUPTA (como falta de energia/crash), SEM apagar nada — só para testes de recuperação da instância própria.
  if (comando === "derrubar") {
    exigirPastaPropria();
    if (ligado()) rodar("pg_ctl", ["stop", "-D", DADOS, "-m", "immediate", "-w"]);
    return dizer("Servidor derrubado (modo imediato); os dados ficam na pasta:", PASTA);
  }
  // 17B: varre bancos descartáveis ÓRFÃOS (de execuções que travaram) sem destruir o ambiente. Mantém o modelo atual e o controle.
  if (comando === "limpar") {
    exigirPastaPropria();
    if (!ligado()) return parar("servidor desligado (rode: iniciar).");
    const a = lerAmbiente();
    const controle = await abrirPoolSeguro(a.urlAdmin, a.marcador, { max: 1 });
    const { rows } = await controle.query("select datname from pg_database where datname ~ '^fv2_teste_[a-z0-9_]+$' and datname !~ '^fv2_teste_modelo_' and datname <> 'fv2_teste_controle' and datname <> $1", [a.bancoModelo ?? ""]);
    let n = 0;
    for (const { datname } of rows) { await controle.query(`drop database if exists ${datname} with (force)`).then(() => { n += 1; }).catch(() => {}); }
    await controle.end();
    return dizer(`Bancos descartáveis apagados: ${n} de ${rows.length}.`);
  }
  if (comando === "destruir") {
    if (!existsSync(PASTA)) return dizer("Nada a destruir.");
    exigirPastaPropria();
    if (ligado()) rodar("pg_ctl", ["stop", "-D", DADOS, "-m", "immediate", "-w"]);
    rmSync(PASTA, { recursive: true, force: true });
    return dizer("Ambiente isolado apagado:", PASTA);
  }
  return parar("uso: node scripts/fv2-banco-teste.mjs iniciar | estado | parar | derrubar | limpar | destruir");
}

principal().catch((e) => parar(e?.message ?? String(e)));
