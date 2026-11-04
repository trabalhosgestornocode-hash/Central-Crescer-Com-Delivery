// Implantação CONTROLADA da camada Foody (147 → 148 → 149). Procedimento: docs/foody-implantacao-147-149.md
//
// Só um OPERADOR AUTORIZADO roda, no PRÓPRIO terminal. A conexão vem SÓ de FOODY_CONN (nunca lida de arquivo, impressa ou gravada);
// o alvo é declarado em FOODY_ALVO (local | teste | producao) e conferido contra o host/usuário da conexão.
//
//   node implantar.mjs pacote        regera o kit e confere o SHA-256 fixado (não conecta)
//   node implantar.mjs diagnostico   SOMENTE LEITURA: estado real (AUSENTE · COMPLETO_VAZIO · COMPLETO_COM_DADOS · PARCIAL)
//   node implantar.mjs prevoo        SOMENTE LEITURA: pré-voo + portões
//   FOODY_AUTORIZO=SIM FOODY_BACKUP_CONFIRMADO=SIM node implantar.mjs aplicar
//                                    kit + diagnóstico (AUSENTE) + pré-voo + aplicação (UMA transação) + pós-verificação + diagnóstico
//   node implantar.mjs validar       SOMENTE LEITURA: pós-verificação + diagnóstico
//   FOODY_AUTORIZO=SIM FOODY_ASSINATURA=<da pós-verificação> node implantar.mjs recuperar
//                                    só com estado COMPLETO_VAZIO e a MESMA assinatura; remove a camada e o registro; confere o resto
// Ensaio: FOODY_ALVO=local + FOODY_ENSAIO_LOCAL=1 aceita só 127.0.0.1/localhost. Evidências: FOODY_EVIDENCIAS (padrão: pasta temporária).
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gerarPacote } from "./gerar_pacote.mjs";
import * as C from "./sql_comum.mjs";

// SHA-256 do kit no commit revisado. Mudou um arquivo das migrations 147–149 ou do kit? Regenere e atualize AQUI, via PR.
export const SHA_ESPERADO = {
  "pacote_aplicar.sql": "feadfd822830431a01c8b28ca3aacce7cc28de48cfd7ec5232d370167ec122c5",
  "pacote_recuperar.sql": "30f52e64d759ad615bc7cfb9f1f03140a6e739770d5e8e4b73d21be40f82676f",
};
export const REF = { producao: "uqybgauuxcrqzquultfu", teste: "wiqqsxnysbzhcrzrrean" };
const UNIDADES_PILOTO = { subway_saci: "00000000-0000-0000-0000-0000000000a1", acai_no_grau_saci: "4d3b75bd-79b5-4335-ae5b-a183580c3555" };

// ------------------------------------------------------------------ travas de alvo
export function travasDeAlvo(env) {
  const e = [], alvo = env.FOODY_ALVO, conn = env.FOODY_CONN ?? "";
  if (!["local", "teste", "producao"].includes(alvo)) e.push("defina FOODY_ALVO = local | teste | producao");
  if (!conn) e.push("defina FOODY_CONN no seu terminal (não cole a conexão no chat)");
  let u; try { u = new URL(conn); } catch { if (conn) e.push("FOODY_CONN não é uma URL postgres"); }
  if (u && alvo) {
    const host = u.hostname, user = decodeURIComponent(u.username), porta = u.port || "5432";
    if (alvo === "local") {
      if (env.FOODY_ENSAIO_LOCAL !== "1") e.push("alvo local exige FOODY_ENSAIO_LOCAL=1");
      if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) e.push("alvo local: só 127.0.0.1/localhost");
    } else {
      const ref = REF[alvo], outro = REF[alvo === "producao" ? "teste" : "producao"];
      const direto = host === `db.${ref}.supabase.co` && user === "postgres";
      const pooler = /\.pooler\.supabase\.com$/.test(host) && user === `postgres.${ref}`;
      if (!direto && !pooler) e.push(`host/usuário não são do projeto ${alvo} (${ref})`);
      if (conn.includes(outro)) e.push(`a conexão cita o projeto ${alvo === "producao" ? "de TESTE" : "de PRODUÇÃO"}`);
      if (porta !== "5432") e.push("use a conexão direta ou o pooler de SESSÃO (porta 5432)");
    }
  }
  return e;
}

// ------------------------------------------------------------------ portões
const vazio = (x) => Array.isArray(x) && x.length === 0;
// `avisos` recebe o que NÃO bloqueia. Única regra: no TESTE (tráfego baixíssimo, o WAL pode passar horas sem fechar um segmento) a
// IDADE do último WAL arquivado é aviso — o backup do painel é confirmado pelo operador (FOODY_BACKUP_CONFIRMADO=SIM). archive_mode
// ligado e nenhuma falha depois do último sucesso continuam BLOQUEANTES. Em produção a idade (< 900 s) continua bloqueante.
export function avaliarPrevoo(p, alvo, avisos = []) {
  const e = [], d = p.dependencias ?? {}, c = p.concorrencia ?? {}, h = p.historico ?? {};
  if (p.identidade?.somente_leitura !== "on") e.push("sessão de pré-voo não está em somente leitura");
  if (p.identidade?.replica) e.push("conectado a uma réplica");
  if (!h.existe) e.push("histórico supabase_migrations.schema_migrations ausente");
  if (!vazio(h.foody_registradas)) e.push(`migrations Foody já registradas: ${JSON.stringify(h.foody_registradas)}`);
  if (!vazio(h.numeros_147_149_ocupados)) e.push(`números 147–149 já ocupados no histórico: ${JSON.stringify(h.numeros_147_149_ocupados)}`);
  if (!vazio(p.objetos_foody)) e.push(`objetos Foody já existem (estado parcial?): ${JSON.stringify(p.objetos_foody).slice(0, 300)}`);
  for (const [t, ok] of Object.entries(d.tabelas ?? {})) if (!ok) e.push(`tabela ausente: ${t}`);
  for (const [r, ok] of Object.entries(d.papeis ?? {})) if (!ok) e.push(`papel ausente: ${r}`);
  if (d.colunas_usuarios_organizacoes !== 4) e.push("usuarios_organizacoes sem perfil_id/organizacao_id/papel/ativo");
  if (!d.gen_random_uuid || !d.hashtextextended) e.push("gen_random_uuid/hashtextextended ausentes");
  if (d.remapear_descobre_por_colunas !== true) e.push("remapear_organizacao_em_tabelas_de_unidade não descobre tabelas por colunas (transferência deixaria foody_* para trás)");
  if (c.locks_aguardando !== 0) e.push(`locks aguardando: ${c.locks_aguardando}`);
  if (c.locks_fortes_unidades_organizacoes !== 0) e.push(`locks de escrita em unidades/organizacoes: ${c.locks_fortes_unidades_organizacoes}`);
  if (c.idle_in_transaction !== 0) e.push(`sessões idle in transaction: ${c.idle_in_transaction}`);
  if (!(c.transacao_mais_longa_s < 30)) e.push(`transação aberta há ${c.transacao_mais_longa_s}s`);
  if (alvo === "producao") {
    const u = p.unidades_piloto ?? {}, s = u.subway_saci, a = u.acai_no_grau_saci;
    if (!s?.existe || !a?.existe || !s.ativa || !a.ativa) e.push("unidades do piloto ausentes ou inativas");
    else if (s.organizacao_id === a.organizacao_id) e.push("Subway Saci e Açaí no Grau Saci na MESMA organização (o desenho exige duas)");
    if (h.termo_v3_registrado !== 1) e.push("registro 144_termo_v3_aprovado_internamente não encontrado (histórico diferente do vistoriado)");
  }
  if (alvo !== "local") {
    const w = p.arquivamento_wal ?? {};
    if (w.modo !== "on") e.push("archive_mode desligado");
    if (w.ultima_falha_depois_do_ultimo_ok) e.push("arquivamento de WAL falhando");
    if (!(w.segundos_desde_ultimo < 900)) (alvo === "teste" ? avisos : e).push(`último WAL arquivado há ${w.segundos_desde_ultimo}s`);
  }
  return e;
}

export function avaliarPos(p, { impressaoAntes, md5Arquivos } = {}) {
  const e = [], a = p.anon_authenticated ?? {}, s = p.service_role ?? {}, m = p.multi_tenant ?? {}, i = p.integridade ?? {};
  if (!p.tabelas?.ok) e.push(`tabelas ausentes: ${JSON.stringify(p.tabelas?.ausentes)}`);
  if (!p.rls?.ok) e.push("RLS desligado em tabela foody_*");
  if (p.rls?.policies !== 0) e.push(`policies em foody_*: ${p.rls?.policies}`);
  if (!vazio(a.tabelas_com_acesso)) e.push(`anon/authenticated com acesso: ${JSON.stringify(a.tabelas_com_acesso)}`);
  if (a.colunas_com_acesso !== 0) e.push(`anon/authenticated com acesso a colunas: ${a.colunas_com_acesso}`);
  if (!vazio(a.funcoes_executaveis)) e.push(`anon/authenticated executam: ${JSON.stringify(a.funcoes_executaveis)}`);
  if (!vazio(a.public_executa)) e.push(`PUBLIC executa: ${JSON.stringify(a.public_executa)}`);
  if (!vazio(s.privilegios_divergentes)) e.push(`service_role divergente: ${JSON.stringify(s.privilegios_divergentes)}`);
  if (!vazio(s.update_de_coluna_faltando)) e.push(`service_role sem UPDATE de coluna: ${JSON.stringify(s.update_de_coluna_faltando)}`);
  if (JSON.stringify(s.executa) !== JSON.stringify([...C.FUNCOES_SERVICE_ROLE].sort())) e.push(`service_role executa: ${JSON.stringify(s.executa)}`);
  if (JSON.stringify(p.security_definer) !== JSON.stringify([...C.FUNCOES_SECURITY_DEFINER].sort())) e.push(`SECURITY DEFINER: ${JSON.stringify(p.security_definer)}`);
  if (!vazio(m.tabelas_sem_gatilho_de_tenant)) e.push(`sem gatilho de tenant: ${JSON.stringify(m.tabelas_sem_gatilho_de_tenant)}`);
  if (!vazio(m.tabelas_fora_do_remapeamento)) e.push(`fora do remapeamento: ${JSON.stringify(m.tabelas_fora_do_remapeamento)}`);
  if (m.remapear_descobre_por_colunas !== true) e.push("remapeamento não descobre foody_*");
  if (i.restricoes_invalidas !== 0 || i.gatilhos_desligados !== 0) e.push("restrição não validada ou gatilho desligado");
  if (!(i.fks_para_unidades >= C.TABELAS.length) || !(i.fks_para_organizacoes >= C.TABELAS.length)) e.push("FKs de tenant faltando");
  const linhas = Object.values(i.linhas ?? {}).reduce((x, n) => x + Number(n), 0);
  if (linhas !== 0) e.push(`tabelas foody_* com ${linhas} linha(s) logo após a instalação`);
  const reg = p.historico?.registros ?? [];
  if (reg.length !== 3) e.push(`histórico: ${reg.length} registro(s) Foody`);
  if (md5Arquivos) for (const r of reg) if (md5Arquivos[r.name] !== r.md5) e.push(`histórico ${r.name}: conteúdo diferente do arquivo`);
  if (!/^[0-9a-f]{32}$/.test(p.assinatura ?? "")) e.push("assinatura estrutural ausente");
  if (impressaoAntes && JSON.stringify(p.impressao_fora_do_escopo) !== JSON.stringify(impressaoAntes)) e.push("IMPRESSÃO FORA DO ESCOPO MUDOU (algo além de foody_* foi alterado)");
  return e;
}

// ------------------------------------------------------------------ execução
const PSQL = process.env.FOODY_PSQL || "psql";
function psql(env, { arquivo, leitura, variaveis = {} }) {
  const conn = env.FOODY_CONN;
  const pg = { PGCLIENTENCODING: "UTF8", PGCONNECT_TIMEOUT: "15", PGAPPNAME: leitura ? "foody-147-149-leitura" : "foody-147-149-aplicacao",
    PGOPTIONS: leitura ? "-c default_transaction_read_only=on -c statement_timeout=60000 -c lock_timeout=2000" : "-c statement_timeout=300000" };
  const vars = Object.entries(variaveis).flatMap(([k, v]) => ["-v", `${k}=${v}`]);
  const r = spawnSync(PSQL, [conn, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-tA", ...vars, "-f", arquivo],
    { env: { ...process.env, ...pg }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const ocultar = (s) => String(s ?? "").split(conn).join("<conexão>");
  return { ok: r.status === 0, saida: ocultar(r.stdout), erro: ocultar(r.stderr) };
}
const jsonDe = (r, etapa) => { if (!r.ok) throw new Error(`${etapa}: ${r.erro.trim().split("\n").slice(0, 3).join(" | ")}`); return JSON.parse(r.saida); };

export function executar(modo, env = process.env, log = console.log) {
  const carimbo = new Date().toISOString().replace(/[:.]/g, "-");
  const evid = resolve(env.FOODY_EVIDENCIAS || join(tmpdir(), "evidencias-foody-147-149"), `${modo}-${carimbo}`);
  mkdirSync(evid, { recursive: true });
  const guardar = (nome, obj) => writeFileSync(join(evid, nome), typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
  const parar = (msg) => { guardar("PARADO.txt", msg); throw new Error(`PARADO: ${msg} (evidências: ${evid})`); };

  const { arquivos, sha, md5Arquivos } = gerarPacote();
  for (const [n, t] of Object.entries(arquivos)) writeFileSync(join(evid, n), t);
  const shaDiverge = Object.entries(SHA_ESPERADO).filter(([n, s]) => sha[n] !== s);
  // Sem válvula de escape: kit diferente do revisado nunca roda, em NENHUM alvo (mudou? regenere e fixe o SHA novo via PR).
  if (shaDiverge.length) parar(`SHA-256 do kit diverge do fixado: ${shaDiverge.map(([n]) => `${n}=${sha[n]}`).join(", ")}`);
  if (modo === "pacote") { log(JSON.stringify({ ok: true, sha, evidencias: evid })); return { sha, evid }; }

  const travas = travasDeAlvo(env);
  if (travas.length) parar(travas.join("; "));
  const ler = (n) => jsonDe(psql(env, { arquivo: join(evid, n), leitura: true }), n);

  if (modo === "diagnostico") { const d = ler("diagnostico.sql"); guardar("diagnostico.json", d); log(JSON.stringify(d)); return d; }
  if (modo === "prevoo") {
    const p = ler("prevoo.sql"); guardar("prevoo.json", p);
    const avisos = [], e = avaliarPrevoo(p, env.FOODY_ALVO, avisos); guardar("prevoo-portoes.json", { falhas: e, avisos });
    log(JSON.stringify({ ok: e.length === 0, falhas: e, avisos, evidencias: evid })); return { prevoo: p, falhas: e, avisos };
  }
  if (modo === "validar") {
    const p = ler("posverificacao.sql"), d = ler("diagnostico.sql"); guardar("posverificacao.json", p); guardar("diagnostico.json", d);
    const e = avaliarPos(p, { md5Arquivos }); log(JSON.stringify({ ok: e.length === 0, estado: d.estado, assinatura: p.assinatura, falhas: e, evidencias: evid }));
    return { pos: p, diag: d, falhas: e };
  }
  if (modo === "aplicar") {
    if (env.FOODY_AUTORIZO !== "SIM") parar("aplicar exige FOODY_AUTORIZO=SIM");
    if (env.FOODY_ALVO !== "local" && env.FOODY_BACKUP_CONFIRMADO !== "SIM") parar("aplicar exige FOODY_BACKUP_CONFIRMADO=SIM (backup do dia conferido e recuperável)");
    const d0 = ler("diagnostico.sql"); guardar("diagnostico-antes.json", d0);
    if (d0.estado !== "AUSENTE") parar(`estado ${d0.estado}: aplicar só a partir de AUSENTE — ${d0.acao}`);
    const p = ler("prevoo.sql"); guardar("prevoo.json", p);
    const avisos0 = [], e0 = avaliarPrevoo(p, env.FOODY_ALVO, avisos0); guardar("prevoo-portoes.json", { falhas: e0, avisos: avisos0 });
    if (e0.length) parar(`pré-voo reprovado: ${e0.join("; ")}`);
    const r = psql(env, { arquivo: join(evid, "pacote_aplicar.sql"), leitura: false }); guardar("aplicacao.log", `${r.saida}\n${r.erro}`);
    if (!r.ok) {
      const d1 = ler("diagnostico.sql"); guardar("diagnostico-apos-falha.json", d1);
      parar(`aplicação falhou e foi desfeita pelo banco (estado agora: ${d1.estado}): ${r.erro.trim().split("\n")[0]}`);
    }
    const pos = ler("posverificacao.sql"); guardar("posverificacao.json", pos);
    const d2 = ler("diagnostico.sql"); guardar("diagnostico-depois.json", d2);
    const e2 = avaliarPos(pos, { impressaoAntes: p.impressao_fora_do_escopo, md5Arquivos });
    if (d2.estado !== "COMPLETO_VAZIO") e2.push(`estado depois: ${d2.estado}`);
    if (d2.assinatura !== pos.assinatura) e2.push("assinatura do diagnóstico ≠ da pós-verificação");
    guardar("posverificacao-portoes.json", e2); guardar("ASSINATURA.txt", `${pos.assinatura}\n`);
    if (e2.length) parar(`APLICADO, mas a pós-verificação reprovou: ${e2.join("; ")}. Não use a camada; avalie a recuperação com FOODY_ASSINATURA=${pos.assinatura}`);
    log(JSON.stringify({ ok: true, estado: d2.estado, assinatura: pos.assinatura, avisos_prevoo: avisos0, evidencias: evid }));
    return { assinatura: pos.assinatura, evid };
  }
  if (modo === "recuperar") {
    if (env.FOODY_AUTORIZO !== "SIM") parar("recuperar exige FOODY_AUTORIZO=SIM");
    const esperada = env.FOODY_ASSINATURA ?? "";
    if (!/^[0-9a-f]{32}$/.test(esperada)) parar("recuperar exige FOODY_ASSINATURA = a assinatura registrada pela pós-verificação (ASSINATURA.txt)");
    const d0 = ler("diagnostico.sql"); guardar("diagnostico-antes.json", d0);
    if (d0.estado !== "COMPLETO_VAZIO") parar(`estado ${d0.estado}: a recuperação automática só vale para COMPLETO_VAZIO — ${d0.acao}`);
    if (d0.assinatura !== esperada) parar(`assinatura atual ${d0.assinatura} ≠ informada ${esperada}: a estrutura mudou depois da verificação; análise manual`);
    const p0 = ler("posverificacao.sql"); guardar("posverificacao-antes.json", p0);
    const r = psql(env, { arquivo: join(evid, "pacote_recuperar.sql"), leitura: false, variaveis: { assinatura: esperada } });
    guardar("recuperacao.log", `${r.saida}\n${r.erro}`);
    if (!r.ok) parar(`recuperação recusada/desfeita pelo banco: ${r.erro.trim().split("\n")[0]}`);
    const d1 = ler("diagnostico.sql"); guardar("diagnostico-depois.json", d1);
    const p1 = ler("prevoo.sql"); guardar("prevoo-depois.json", p1);
    const e = [];
    if (d1.estado !== "AUSENTE") e.push(`estado depois: ${d1.estado}`);
    if (JSON.stringify(p1.impressao_fora_do_escopo) !== JSON.stringify(p0.impressao_fora_do_escopo)) e.push("IMPRESSÃO FORA DO ESCOPO MUDOU");
    if (e.length) parar(`recuperação executada, mas a conferência reprovou: ${e.join("; ")}`);
    log(JSON.stringify({ ok: true, estado: d1.estado, evidencias: evid })); return { estado: d1.estado, evid };
  }
  parar(`modo desconhecido: ${modo}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { executar(process.argv[2]); } catch (err) { console.error(err.message); process.exit(1); }
}
