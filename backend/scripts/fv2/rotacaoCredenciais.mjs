// ROTAÇÃO das credenciais de conexão do Financeiro v2 (doc 31) — SEM interromper o módulo e SEM expor senha.
//
// Estratégia azul/verde: há dois pares de papéis de login (A = fv2_app_login/fv2_autoridade_login; B = os mesmos com "_b").
// A rotação cria (ou reativa) o par INATIVO com senhas novas, aponta o Render para ele, espera o deploy, confere que o
// serviço novo conecta pelo par novo e só então DESLIGA o par antigo (NOLOGIN + senha removida + conexões encerradas).
// Os papéis de grupo (fv2_app, fv2_autoridade) e todas as regras do banco não mudam; nada é excluído.
//
// A senha nasce na memória deste processo, vai ao banco só como verificador SCRAM-SHA-256 e ao Render só pela API
// (HTTPS). NUNCA é impressa, gravada em arquivo, registrada em log ou enviada por chat. Quem executa é o proprietário:
//
//   node --env-file=.env scripts/fv2/rotacaoCredenciais.mjs plano                       (só leitura; padrão)
//   node --env-file=.env scripts/fv2/rotacaoCredenciais.mjs criar --ca <arquivo.crt> --servico <srv-…> --confirmar
//   node --env-file=.env scripts/fv2/rotacaoCredenciais.mjs criar ... --retomar B --confirmar   (só se a anterior parou no meio)
//   node --env-file=.env scripts/fv2/rotacaoCredenciais.mjs validar
//   node --env-file=.env scripts/fv2/rotacaoCredenciais.mjs revogar-antigas --antigo A --confirmar
//
// Variáveis: DATABASE_URL (dono do projeto, do backend/.env) e, só em "criar", RENDER_API_KEY (chave do proprietário,
// digitada no próprio terminal: `$env:RENDER_API_KEY = Read-Host -MaskInput`). Nenhuma das duas é impressa.
import { randomBytes, pbkdf2Sync, createHmac, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const REF = "uqybgauuxcrqzquultfu";
export const POOLER = "aws-1-us-west-2.pooler.supabase.com";
export const PARES = Object.freeze({
  A: Object.freeze([{ login: "fv2_app_login", grupo: "fv2_app", limite: 4, variavel: "FV2_APP_DATABASE_URL" }, { login: "fv2_autoridade_login", grupo: "fv2_autoridade", limite: 2, variavel: "FV2_AUTORIDADE_DATABASE_URL" }]),
  B: Object.freeze([{ login: "fv2_app_login_b", grupo: "fv2_app", limite: 4, variavel: "FV2_APP_DATABASE_URL" }, { login: "fv2_autoridade_login_b", grupo: "fv2_autoridade", limite: 2, variavel: "FV2_AUTORIDADE_DATABASE_URL" }]),
});
const LOGINS = Object.freeze(Object.values(PARES).flat().map((p) => p.login));
const IDENTIFICADOR = /^fv2_(app|autoridade)_login(_b)?$/;

/** Verificador SCRAM-SHA-256 (o mesmo formato do `\password` do psql): o banco nunca recebe a senha em texto. */
export function verificadorScram(senha, sal = randomBytes(16)) {
  const salgada = pbkdf2Sync(senha, sal, 4096, 32, "sha256");
  const chaveCliente = createHmac("sha256", salgada).update("Client Key").digest();
  const guardada = createHash("sha256").update(chaveCliente).digest();
  const chaveServidor = createHmac("sha256", salgada).update("Server Key").digest();
  return `SCRAM-SHA-256$4096:${sal.toString("base64")}$${guardada.toString("base64")}:${chaveServidor.toString("base64")}`;
}

/**
 * Qual par está em uso e qual será o próximo. Em uso = o que tem LOGIN (e, se os dois tiverem, o que tem conexões).
 * @param {Array<{rolname:string, rolcanlogin:boolean, conexoes:number}>} papeis
 */
export function situacaoDosPares(papeis) {
  const de = (par) => PARES[par].map((p) => papeis.find((x) => x.rolname === p.login) ?? { rolname: p.login, existe: false, rolcanlogin: false, conexoes: 0 });
  const resumo = (par) => { const l = de(par); return { par, existe: l.every((x) => x.existe !== false), login: l.every((x) => x.rolcanlogin), conexoes: l.reduce((s, x) => s + Number(x.conexoes ?? 0), 0) }; };
  const a = resumo("A");
  const b = resumo("B");
  let ativo = null;
  if (a.login && !b.login) ativo = "A";
  else if (b.login && !a.login) ativo = "B";
  else if (a.login && b.login) ativo = a.conexoes >= b.conexoes ? "A" : "B"; // rotação em andamento
  return { A: a, B: b, ativo, proximo: ativo === "A" ? "B" : ativo === "B" ? "A" : null, emAndamento: a.login && b.login };
}

/** Comandos (sem a senha) para preparar um papel do par novo. O verificador entra só como literal validado. */
export function comandosDoPapel(p, existe, verificador) {
  if (!IDENTIFICADOR.test(p.login) || !/^fv2_(app|autoridade)$/.test(p.grupo)) throw new Error("papel fora da lista");
  if (!/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(verificador)) throw new Error("verificador inválido");
  return existe
    ? [`alter role ${p.login} login noinherit connection limit ${p.limite} password '${verificador}'`, `grant ${p.grupo} to ${p.login} with inherit true`, `alter role ${p.login} set search_path = financeiro_v2, pg_catalog`]
    : [`create role ${p.login} login noinherit connection limit ${p.limite} password '${verificador}'`, `grant ${p.grupo} to ${p.login} with inherit true`, `alter role ${p.login} set search_path = financeiro_v2, pg_catalog`];
}

/**
 * Revogar o par antigo só é seguro se CADA papel novo (app e autoridade, separadamente) já tem conexões: se o Render aceitou
 * só uma das variáveis, a outra credencial ainda é a antiga e desligá-la derrubaria o módulo.
 */
export function podeRevogar(papeis, antigo) {
  const novo = antigo === "A" ? "B" : "A";
  const faltando = PARES[novo].filter((p) => !(papeis.find((x) => x.rolname === p.login)?.rolcanlogin && Number(papeis.find((x) => x.rolname === p.login)?.conexoes ?? 0) > 0)).map((p) => p.login);
  return { ok: faltando.length === 0, faltando };
}

/** Desliga um papel antigo: sem login, sem senha, conexões encerradas. Não exclui nada. */
export function comandosDeRevogacao(p) {
  if (!IDENTIFICADOR.test(p.login)) throw new Error("papel fora da lista");
  return [`alter role ${p.login} nologin password null`, `select count(*)::int n from (select pg_terminate_backend(pid) from pg_stat_activity where usename = '${p.login}') t`];
}

export const urlDoPapel = (login, senha) => `postgresql://${login}.${REF}:${encodeURIComponent(senha)}@${POOLER}:5432/postgres`;

/** Atualiza UMA variável do serviço pela API do Render. Só o status volta para a tela. */
export async function gravarNoRender({ fetchFn = fetch, chave, servico, variavel, valor }) {
  if (!/^srv-[a-z0-9]+$/.test(servico)) throw new Error("serviço Render inválido");
  if (!/^FV2_(APP|AUTORIDADE)_DATABASE_URL$/.test(variavel)) throw new Error("variável fora da lista");
  const r = await fetchFn(`https://api.render.com/v1/services/${servico}/env-vars/${variavel}`, {
    method: "PUT", headers: { authorization: `Bearer ${chave}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ value: valor }),
  });
  if (!r.ok) throw new Error(`Render recusou ${variavel}: HTTP ${r.status}`);
  return r.status;
}
export async function dispararDeploy({ fetchFn = fetch, chave, servico }) {
  const r = await fetchFn(`https://api.render.com/v1/services/${servico}/deploys`, { method: "POST", headers: { authorization: `Bearer ${chave}`, "content-type": "application/json", accept: "application/json" }, body: "{}" });
  if (!r.ok) throw new Error(`Render recusou o deploy: HTTP ${r.status}`);
  return (await r.json().catch(() => ({})))?.id ?? null;
}

const CONSULTA_PAPEIS = `select r.rolname, r.rolcanlogin, (select count(*)::int from pg_stat_activity a where a.usename = r.rolname) conexoes,
  (select string_agg(distinct coalesce(a.application_name, ''), ',') from pg_stat_activity a where a.usename = r.rolname) aplicacoes
  from pg_roles r where r.rolname = any($1::text[]) order by r.rolname`;

async function principal(argv) {
  const [modo = "plano", ...resto] = argv;
  const opc = (n) => { const i = resto.indexOf(n); return i >= 0 ? resto[i + 1] : null; };
  const confirmado = resto.includes("--confirmar");
  const pare = (m) => { console.log("INTERROMPIDO:", m); process.exit(2); };
  const url = process.env.DATABASE_URL ?? "";
  if (!new RegExp(`@db\\.${REF}\\.supabase\\.co:5432/`).test(url)) pare("DATABASE_URL não aponta para o projeto esperado");
  const { createRequire } = await import("node:module");
  const pg = createRequire(fileURLToPath(new URL("../../package.json", import.meta.url)))("pg");
  const dono = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, application_name: "fv2-rotacao" });
  await dono.connect();
  try {
    const papeis = (await dono.query(CONSULTA_PAPEIS, [LOGINS])).rows.map((x) => ({ ...x, existe: true }));
    const s = situacaoDosPares(papeis);
    for (const x of papeis) console.log(`papel ${x.rolname}: login=${x.rolcanlogin} conexões=${x.conexoes} aplicações=${x.aplicacoes ?? "-"}`);
    console.log(`par em uso: ${s.ativo ?? "nenhum"} · próximo: ${s.proximo ?? "-"}${s.emAndamento ? " · ROTAÇÃO EM ANDAMENTO (os dois pares com login)" : ""}`);
    if (modo === "plano" || modo === "validar") {
      if (modo === "validar" && s.emAndamento) console.log(s[s.ativo === "A" ? "B" : "A"].conexoes > 0 ? "o par novo já tem conexões" : "o par novo ainda sem conexões: aguarde o deploy ficar 'live'");
      return;
    }
    if (!confirmado) pare("acrescente --confirmar para executar");
    if (modo === "criar") {
      // RETOMADA: rotação interrompida (ex.: o Render aceitou só uma variável). Gera senhas NOVAS para o MESMO par novo e regrava
      // as duas variáveis; o par antigo segue ativo até "revogar-antigas". Sem --retomar, uma rotação em andamento é recusada.
      const retomar = opc("--retomar");
      if (s.emAndamento && !retomar) pare("já há uma rotação em andamento: termine-a (validar + revogar-antigas) ou retome com --retomar <par novo>");
      if (retomar && (!s.emAndamento || !["A", "B"].includes(retomar))) pare("--retomar só vale com rotação em andamento e indica o par NOVO (A ou B)");
      const parNovo = retomar ?? s.proximo;
      const parAntigo = parNovo === "A" ? "B" : "A";
      if (!parNovo) pare("não encontrei o par em uso");
      const ca = readFileSync(opc("--ca") ?? pare("informe --ca <arquivo do certificado da CA>"), "utf8");
      const servico = opc("--servico") ?? pare("informe --servico <srv-…>");
      const chave = process.env.RENDER_API_KEY ?? pare("defina RENDER_API_KEY no próprio terminal");
      const novos = PARES[parNovo].map((p) => ({ ...p, senha: randomBytes(32).toString("base64url"), existe: papeis.some((x) => x.rolname === p.login) }));
      await dono.query("begin");
      try {
        for (const p of novos) for (const c of comandosDoPapel(p, p.existe, verificadorScram(p.senha))) await dono.query(c);
        await dono.query("commit");
      } catch (e) {
        await dono.query("rollback").catch(() => {});
        pare(`erro no banco — ROLLBACK, nada mudou: ${e.code ?? ""}`);
      }
      console.log(`1. par ${parNovo} pronto no banco (senha só como verificador)`);
      for (const p of novos) {
        const c = new pg.Client({ connectionString: urlDoPapel(p.login, p.senha), ssl: { ca, rejectUnauthorized: true }, connectionTimeoutMillis: 15000 });
        try { await c.connect(); const r = (await c.query("select current_user u, has_schema_privilege('financeiro_v2','usage') uso")).rows[0]; console.log(`2. ${p.login} conecta pelo pooler com TLS verificado: usuário=${r.u} uso=${r.uso}`); }
        catch (e) { pare(`${p.login} não conectou (${e.code ?? "erro"}); o Render NÃO foi alterado. Rode "revogar-antigas" só depois de uma rotação completa.`); }
        finally { await c.end().catch(() => {}); }
      }
      for (const p of novos) console.log(`3. Render ${p.variavel}: HTTP ${await gravarNoRender({ chave, servico, variavel: p.variavel, valor: urlDoPapel(p.login, p.senha) })}`);
      console.log(`4. deploy disparado: ${await dispararDeploy({ chave, servico }) ?? "(id não informado)"} — acompanhe até 'live', rode "validar" e depois "revogar-antigas --antigo ${parAntigo} --confirmar".`);
      return;
    }
    if (modo === "revogar-antigas") {
      if (!s.emAndamento) pare("não há rotação em andamento (só um par tem login)");
      // O par antigo é dito EXPLICITAMENTE (o pooler pode manter conexões ociosas do antigo por um tempo: contar não basta).
      const antigo = opc("--antigo");
      if (!["A", "B"].includes(antigo)) pare("informe --antigo A ou --antigo B (o par que o 'criar' indicou como antigo)");
      const r = podeRevogar(papeis, antigo);
      if (!r.ok) pare(`sem conexões pelo papel novo ${r.faltando.join(", ")}: o serviço ainda usa o antigo nessa credencial (variável não atualizada ou deploy não concluído). Nada foi revogado.`);
      for (const p of PARES[antigo]) {
        const [desligar, encerrar] = comandosDeRevogacao(p);
        await dono.query(desligar);
        console.log(`${p.login}: sem login e sem senha; conexões encerradas: ${(await dono.query(encerrar)).rows[0].n}`);
      }
      return;
    }
    pare(`modo desconhecido: ${modo}`);
  } finally {
    await dono.end().catch(() => {});
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  principal(process.argv.slice(2)).catch((e) => { console.log("FALHOU:", e?.code ?? e?.message?.slice(0, 120) ?? "erro"); process.exit(1); });
}
