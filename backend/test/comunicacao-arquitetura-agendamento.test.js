// TESTE ARQUITETURAL (D.3-D) — estático, sem banco. Trava as invariantes do agendamento
// seguro que um refactor do SQL/serviço não pode desfazer:
//
//   1. migration 088: habilitação fail-closed, alerta->mensagem atômico, reserva de
//      capacidade serializada, reconciliação humana sem retry, grants só service_role,
//      rollback que desfaz tudo;
//   2. o código do módulo não decide horário pela hora do servidor nem por Math.random;
//   3. NENHUMA automação sobe no boot (sem setInterval/cron/worker; server/app/routes não
//      importam o pipeline de alertas).
//
// Rodar: node --test test/comunicacao-arquitetura-agendamento.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "src");
const COM = path.join(SRC, "modules", "comunicacao");
const MIGRATIONS = path.join(__dirname, "..", "..", "database", "migrations");
const M088 = path.join(MIGRATIONS, "088_comunicacao_agendamento_seguro.sql");
const R088 = path.join(MIGRATIONS, "088_rollback.sql");

const semComentariosJs = (codigo) => codigo.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const semComentariosSql = (sql) => sql.replace(/--.*$/gm, "");
const lerJs = (arquivo) => semComentariosJs(readFileSync(arquivo, "utf8"));
const sql088 = () => semComentariosSql(readFileSync(M088, "utf8"));

/** Corpo (entre os $$) da função `nome` na 088. */
function corpo(nome) {
  const sql = sql088();
  const ini = sql.indexOf(`create or replace function ${nome}(`);
  assert.ok(ini >= 0, `função ${nome} não encontrada na 088`);
  const a = sql.indexOf("$$", ini);
  const b = sql.indexOf("$$", a + 2);
  return sql.slice(a + 2, b);
}
/** Só a cláusula SET do ÚLTIMO update do corpo (o que muda o estado). */
const ultimoSet = (c) => {
  const resto = c.slice(c.indexOf("set ", c.lastIndexOf("update comunicacao_mensagens")));
  const fim = resto.search(/\b(from|where)\b/i);
  return fim < 0 ? resto : resto.slice(0, fim);
};

const FUNCOES_DE_TRIGGER = new Set(["comunicacao_habilitacoes_valida", "comunicacao_mensagens_sincroniza_alerta"]); // returns trigger: não chamáveis por RPC
const funcoes088 = () => [...sql088().matchAll(/create or replace function (\w+)\(/g)].map((m) => m[1]);
/** Função da 088 que já existia em 082/087 (mesma assinatura): a 088 a SUBSTITUI. */
const funcaoJaExistia = (nome) => ["082_comunicacao_whatsapp_fundacao.sql", "087_comunicacao_fencing_envio.sql"]
  .some((f) => semComentariosSql(readFileSync(path.join(MIGRATIONS, f), "utf8")).includes(`create or replace function ${nome}(`));

describe("migration 088 — existência, rollback e numeração", () => {
  test("088 e 088_rollback existem e nenhuma migration > 088 apareceu junto", () => {
    assert.ok(existsSync(M088), "falta 088_comunicacao_agendamento_seguro.sql");
    assert.ok(existsSync(R088), "falta 088_rollback.sql");
    // Checkpoint F (inbound do WhatsApp) trouxe a 090 — outro checkpoint, não o D.3-D. O guarda continua valendo para o D.3-D: nada MAIS que a 088.
    // 089 = modelo logístico (outra frente); 092 = reforço do dia; 093 = habilitação atômica do piloto; 094 = primeiro aviso tardio D-1 (RPCs novas e independentes).
    const POSTERIORES_CONHECIDAS = ["089_modelo_logistico_vigencia.sql", "089_rollback.sql", "090_whatsapp_inbound_mensagens.sql", "090_rollback.sql", "092_comunicacao_reforco_alerta.sql", "092_rollback.sql", "093_comunicacao_habilitar_piloto.sql", "093_rollback.sql", "094_comunicacao_aviso_tardio_d1.sql", "094_rollback.sql", "095_comunicacao_status_provider.sql", "095_rollback.sql",
      // 096 = Central de Comunicação (conversas): view + tabelas novas, sem tocar o outbox, o claim nem os recibos.
      "096_comunicacao_central_conversas.sql", "096_rollback.sql",
      // 097 = aba Conexão (identidade do WhatsApp, permissão específica e trava de operação): tabelas novas, sem tocar whatsapp_conexoes/outbox/claim.
      "097_whatsapp_conexao_identidade.sql", "097_rollback.sql",
      // 098 = evolução da 097: confirmação atômica, fencing de efeitos externos e paginação da conversa (sem tocar o outbox/claim).
      "098_whatsapp_operacoes_atomicas.sql", "098_rollback.sql",
      // 099 = reconciliação oficial de efeitos externos incertos (colunas de metadados + RPC); sem tocar o outbox/claim.
      "099_whatsapp_reconciliacao_efeitos.sql", "099_rollback.sql",
      // 100 = responsável de comunicação POR EMPRESA (substitui o destinatário por perfil nas RPCs 088/092/093/094 e no roster 096).
      "100_comunicacao_responsavel_empresa.sql", "100_rollback.sql"];
    const acima = readdirSync(MIGRATIONS).filter((f) => /^\d{3}_/.test(f) && Number(f.slice(0, 3)) > 88 && !POSTERIORES_CONHECIDAS.includes(f));
    assert.deepEqual(acima, [], "o D.3-D usa UMA migration (088)");
  });

  test("o rollback desfaz cada objeto novo (funções e tabela) e restaura a varredura da 082", () => {
    const rb = semComentariosSql(readFileSync(R088, "utf8"));
    // função da 088 que JÁ existia em 082/087 (mesma assinatura) é SUBSTITUÍDA: o rollback a RESTAURA, não a dropa.
    const anteriores = ["082_comunicacao_whatsapp_fundacao.sql", "087_comunicacao_fencing_envio.sql"]
      .map((f) => semComentariosSql(readFileSync(path.join(MIGRATIONS, f), "utf8"))).join("\n");
    const substituidas = funcoes088().filter((f) => anteriores.includes(`create or replace function ${f}(`));
    for (const nome of funcoes088()) {
      if (substituidas.includes(nome)) {
        assert.ok(rb.includes(`create or replace function ${nome}(`), `o rollback não restaura ${nome} (substituída pela 088)`);
      } else {
        assert.match(rb, new RegExp(`drop function if exists ${nome}\\b`), `rollback não remove ${nome}`);
      }
    }
    assert.match(rb, /drop table if exists comunicacao_habilitacoes/);
    assert.match(rb, /drop column if exists expira_em/);
    assert.match(rb, /drop trigger if exists trg_comunicacao_mensagens_sincroniza_alerta/);
    // o claim volta EXATAMENTE ao corpo da 087 (sem o filtro expira_em)
    const claim087 = semComentariosSql(readFileSync(path.join(MIGRATIONS, "087_comunicacao_fencing_envio.sql"), "utf8"));
    const corpoClaim = (sql) => { const i = sql.indexOf("create or replace function comunicacao_claim_mensagens("); const a = sql.indexOf("$$", i); return sql.slice(a + 2, sql.indexOf("$$", a + 2)).replace(/\s+/g, " ").trim(); };
    assert.equal(corpoClaim(rb), corpoClaim(claim087), "o rollback da 088 precisa restaurar o claim IDÊNTICO ao da 087");
  });

  test("NEGÓCIO × TRANSPORTE: a 088 NÃO mexe no domínio de status do ALERTA (sem DELIVERY_UNKNOWN em comunicacao_alertas)", () => {
    const sql = sql088();
    assert.doesNotMatch(sql, /comunicacao_alertas_status_check/, "a 088 não pode redefinir o CHECK de status do alerta");
    assert.doesNotMatch(sql, /alter table comunicacao_alertas/i, "a 088 não altera o schema do alerta");
    assert.doesNotMatch(semComentariosSql(readFileSync(R088, "utf8")), /comunicacao_alertas/, "o rollback não tem nada a desfazer no alerta");
    assert.doesNotMatch(readFileSync(path.join(COM, "comunicacao.constants.js"), "utf8").match(/export const STATUS_ALERTA[\s\S]*?\}\);/)[0].replace(/\/\/.*$/gm, ""), /DELIVERY_UNKNOWN/, "STATUS_ALERTA não pode ter DELIVERY_UNKNOWN");
  });
});

describe("migration 088 — destinatário EXPLÍCITO (nada de \"primeiro contato\")", () => {
  test("a habilitação guarda o par (contato, perfil) com FK para contatos_whatsapp_perfis; habilitado exige destinatário; par completo ou vazio", () => {
    const sql = sql088();
    assert.match(sql, /destinatario_contato_id\s+uuid/);
    assert.match(sql, /destinatario_perfil_id\s+uuid/);
    assert.match(sql, /check \(not habilitado or destinatario_contato_id is not null\)/);
    assert.match(sql, /check \(\(destinatario_contato_id is null\) = \(destinatario_perfil_id is null\)\)/);
    assert.match(sql, /foreign key \(destinatario_contato_id, destinatario_perfil_id\)\s+references contatos_whatsapp_perfis \(contato_id, perfil_operacional_id\)/);
  });

  test("cross-org impossível: o trigger exige vínculo ATIVO do perfil com ESTA organização e par contato<->perfil ativo", () => {
    const c = corpo("comunicacao_habilitacoes_valida");
    assert.match(c, /usuarios_organizacoes uo[\s\S]*uo\.organizacao_id = new\.organizacao_id and uo\.ativo/);
    assert.match(c, /contatos_whatsapp_perfis cp[\s\S]*cp\.ativo/);
  });

  test("o agendamento NÃO recebe contato/perfil do chamador: lê da habilitação e revalida consentimento, verificação, opt-out, perfil ativo e vínculo", () => {
    const assinatura = sql088().match(/create or replace function comunicacao_agendar_mensagem_alerta\([^)]*\)/)[0];
    assert.doesNotMatch(assinatura, /p_contato|p_perfil|p_destinat/, "o destinatário não pode vir do chamador");
    const c = corpo("comunicacao_agendar_mensagem_alerta");
    assert.match(c, /from comunicacao_habilitacoes where organizacao_id = a\.organizacao_id/);
    assert.match(c, /h\.destinatario_contato_id/);
    for (const re of [/opt_out is not false/, /consentimento is not true/, /verificado is not true/, /perfis_operacionais where id = h\.destinatario_perfil_id and ativo/, /usuarios_organizacoes uo where uo\.perfil_id = h\.destinatario_perfil_id and uo\.organizacao_id = a\.organizacao_id and uo\.ativo/]) assert.match(c, re);
    for (const acao of ["NAO_HABILITADA", "TIPO_NAO_PERMITIDO", "SEM_DESTINATARIO", "DESTINATARIO_INELEGIVEL"]) assert.match(c, new RegExp(`'${acao}'`));
    assert.ok(c.indexOf("'DESTINATARIO_INELEGIVEL'") < c.indexOf("insert into comunicacao_mensagens"), "toda validação vem ANTES do INSERT");
    assert.doesNotMatch(c, /order by|limit 1/i, "nenhuma escolha por ordem/limite");
  });

  test("nenhuma organização é habilitada pela migration (seed/insert em comunicacao_habilitacoes)", () => {
    assert.doesNotMatch(sql088(), /insert into comunicacao_habilitacoes/i);
    assert.doesNotMatch(sql088(), /update\s+comunicacao_habilitacoes/i);
    assert.doesNotMatch(sql088(), /habilitado\s+boolean not null default true/i, "o default de habilitado é sempre false");
  });

  test("o código NÃO escolhe destinatário: sem resolverContatosDaUnidade, sem candidatos[0]/find no agendamento", () => {
    const repo = lerJs(path.join(COM, "comunicacao.contatos.repo.js"));
    assert.doesNotMatch(repo, /export async function resolverContatosDaUnidade/);
    const svc = lerJs(path.join(COM, "comunicacao.alertas.service.js"));
    assert.doesNotMatch(svc, /resolverContatosDaUnidade|candidatos\s*\[\s*0\s*\]|escolhido/);
    const fila = lerJs(path.join(COM, "comunicacao.fila.repo.js"));
    const rpc = fila.slice(fila.indexOf("comunicacao_agendar_mensagem_alerta"), fila.indexOf("comunicacao_agendar_mensagem_alerta") + 500);
    assert.doesNotMatch(rpc, /p_contato_id|p_perfil_id/);
  });
});

describe("migration 088 — TTL separa a vida da MENSAGEM da vida do ALERTA", () => {
  test("mensagem expirada (CANCELLED + EXPIRADA) devolve o alerta a DETECTED — nunca CANCELLED/RESOLVED", () => {
    const c = corpo("comunicacao_mensagens_sincroniza_alerta");
    assert.match(c, /new\.status = 'CANCELLED'[\s\S]*set status = 'DETECTED'[\s\S]*status in \('SCHEDULED', 'PROCESSING'\)/);
    assert.doesNotMatch(c.slice(0, c.indexOf("else")), /'CANCELLED', updated_at|status = 'CANCELLED',|status = 'RESOLVED'/);
    assert.match(sql088(), /new\.status = 'CANCELLED' and new\.erro = 'EXPIRADA'/);
  });

  test("DELIVERY_UNKNOWN da MENSAGEM não move o alerta (o trigger nem dispara para ele)", () => {
    const sql = sql088();
    const quando = sql.slice(sql.indexOf("create trigger trg_comunicacao_mensagens_sincroniza_alerta"), sql.indexOf("execute function comunicacao_mensagens_sincroniza_alerta"));
    assert.doesNotMatch(quando, /DELIVERY_UNKNOWN/);
    assert.match(quando, /new\.status in \('SENT', 'DELIVERED', 'READ', 'FAILED'\)/);
  });

  test("reagendar o evento cuja mensagem expirou NÃO cria outra (MENSAGEM_EXPIRADA); só há UMA chave :v1 por alerta na 088", () => {
    const c = corpo("comunicacao_agendar_mensagem_alerta");
    assert.match(c, /m\.status = 'CANCELLED' and m\.erro = 'EXPIRADA'[\s\S]*'MENSAGEM_EXPIRADA'/);
    assert.ok(c.indexOf("'MENSAGEM_EXPIRADA'") < c.indexOf("insert into comunicacao_mensagens"));
  });

  test("o claim ignora mensagem expirada", () => {
    const c = corpo("comunicacao_claim_mensagens");
    assert.match(c, /expira_em is null or expira_em > now\(\)/);
  });
});

describe("migration 088 — habilitação por organização (fail-closed, multi-tenant)", () => {
  const sql = () => sql088();

  test("habilitado nasce false; chave primária é a ORGANIZAÇÃO (nunca configuração global); RLS ligada e sem acesso anon/authenticated", () => {
    assert.match(sql(), /create table if not exists comunicacao_habilitacoes\s*\(\s*organizacao_id\s+uuid primary key references organizacoes\(id\)/);
    assert.match(sql(), /habilitado\s+boolean not null default false/);
    assert.match(sql(), /tipos_permitidos\s+text\[\]\s+not null default '\{\}'/, "sem tipos listados = nenhum tipo permitido");
    assert.match(sql(), /alter table comunicacao_habilitacoes enable row level security/);
    assert.match(sql(), /revoke all on comunicacao_habilitacoes from authenticated, anon/);
  });

  test("registro incompleto não pode estar habilitado (habilitado exige timezone) e timezone é validado contra o catálogo IANA", () => {
    assert.match(sql(), /check \(not habilitado or timezone is not null\)/);
    assert.match(sql(), /pg_timezone_names where name = new\.timezone/);
  });

  test("nenhum fallback silencioso para UTC: a migration não define timezone padrão", () => {
    assert.doesNotMatch(sql(), /timezone\s+text[^,\n]*default/i);
    // 'UTC' só pode aparecer como valor ACEITO na validação (nome IANA explícito), nunca como padrão/coalesce
    assert.doesNotMatch(sql(), /default\s+'?utc/i);
    assert.doesNotMatch(sql(), /coalesce\([^)]*timezone[^)]*utc/i);
    assert.doesNotMatch(sql(), /timezone\s*=\s*coalesce/i);
  });
});

describe("migration 088 — atomicidade alerta -> mensagem", () => {
  test("uma função só: trava o alerta (FOR UPDATE), cria a mensagem E move o alerta; org/unidade vêm do ALERTA, não do chamador", () => {
    const c = corpo("comunicacao_agendar_mensagem_alerta");
    assert.match(c, /from comunicacao_alertas where id = p_alerta_id for update/);
    assert.match(c, /insert into comunicacao_mensagens/);
    assert.match(c, /update comunicacao_alertas set status = 'SCHEDULED'/);
    assert.ok(c.indexOf("insert into comunicacao_mensagens") < c.lastIndexOf("update comunicacao_alertas set status = 'SCHEDULED'"), "o alerta só vira SCHEDULED DEPOIS da mensagem existir");
    assert.match(c, /values \(a\.id, a\.organizacao_id, a\.unidade_id,/);
    assert.doesNotMatch(sql088().match(/create or replace function comunicacao_agendar_mensagem_alerta\([^)]*\)/)[0], /p_organizacao|p_unidade/, "organização/unidade não podem vir do chamador (isolamento entre tenants)");
  });

  test("idempotência: a chave existente devolve a MESMA mensagem e não cria outra; chave de OUTRO alerta é recusada", () => {
    const c = corpo("comunicacao_agendar_mensagem_alerta");
    assert.match(c, /where idempotency_key = p_idempotency_key/);
    assert.match(c, /'JA_EXISTIA'/);
    assert.match(c, /m\.alerta_id is distinct from a\.id then return jsonb_build_object\('acao', 'CHAVE_EM_USO'\)/);
  });

  test("DELIVERY_UNKNOWN (e SENDING) do alerta impedem QUALQUER mensagem nova para o evento lógico", () => {
    const c = corpo("comunicacao_agendar_mensagem_alerta");
    assert.match(c, /alerta_id = a\.id and status in \('SENDING', 'DELIVERY_UNKNOWN'\)/);
    assert.ok(c.indexOf("'ENTREGA_DESCONHECIDA'") < c.indexOf("insert into comunicacao_mensagens"), "a checagem de UNKNOWN precisa vir antes do INSERT");
  });
});

describe("migration 088 — reserva atômica de capacidade (rate limit concorrente)", () => {
  const c = () => corpo("comunicacao_reservar_envio");

  test("o advisory lock é a PRIMEIRA coisa: nenhuma contagem acontece antes de serializar", () => {
    const corpoFn = c();
    const lock = corpoFn.indexOf("pg_advisory_xact_lock");
    assert.ok(lock >= 0, "sem advisory lock, dois workers veem 4/5 e ambos enviam");
    assert.ok(lock < corpoFn.indexOf("count(*)"), "o lock precisa vir ANTES de qualquer contagem");
    assert.ok(lock < corpoFn.indexOf("select * into m"), "o lock precisa vir antes de ler o estado");
  });

  test("consumo de capacidade = SENDING, SENT, DELIVERED, READ e DELIVERY_UNKNOWN; PROCESSING/SCHEDULED/CANCELLED/BLOCKED/FAILED não consomem", () => {
    const corpoFn = c();
    const listas = [...corpoFn.matchAll(/status in \(([^)]*)\)/g)].map((m) => m[1]);
    const consumo = listas.filter((l) => l.includes("'SENT'") && l.includes("'DELIVERY_UNKNOWN'"));
    assert.ok(consumo.length >= 2, "cota diária e taxa por minuto precisam contar o consumo completo");
    for (const l of consumo) for (const s of ["SENDING", "SENT", "DELIVERED", "READ", "DELIVERY_UNKNOWN"]) assert.ok(l.includes(`'${s}'`), `o consumo não conta ${s}`);
    for (const l of listas) for (const s of ["PROCESSING", "SCHEDULED", "CANCELLED", "BLOCKED", "FAILED"]) assert.ok(!l.includes(`'${s}'`), `${s} não pode consumir capacidade`);
  });

  test("DELIVERY_UNKNOWN/SENDING no cooldown contam SEM limite de tempo; SENT/DELIVERED/READ só dentro da janela", () => {
    const corpoFn = c();
    const cooldown = corpoFn.slice(corpoFn.indexOf("p_cooldown_horas is not null"), corpoFn.indexOf("p_max_por_contato_dia is not null"));
    assert.match(cooldown, /x\.status in \('SENDING', 'DELIVERY_UNKNOWN'\)/);
    assert.match(cooldown, /x\.status in \('SENT', 'DELIVERED', 'READ'\) and x\.enviado_em >= now\(\)/);
  });

  test("o cooldown opera por ORGANIZAÇÃO + UNIDADE + TIPO (nunca pelo telefone global)", () => {
    const corpoFn = c();
    const cooldown = corpoFn.slice(corpoFn.indexOf("p_cooldown_horas is not null"), corpoFn.indexOf("p_max_por_contato_dia is not null"));
    assert.match(cooldown, /x\.organizacao_id = m\.organizacao_id/);
    assert.match(cooldown, /x\.unidade_id is not distinct from m\.unidade_id/);
    assert.match(cooldown, /x\.tipo = m\.tipo/);
    assert.doesNotMatch(cooldown, /contato_id/);
  });

  test("DUAS camadas de taxa por minuto: organização E global, ambas sob o mesmo advisory lock, antes do SENDING", () => {
    const corpoFn = c();
    assert.match(sql088().match(/create or replace function comunicacao_reservar_envio\([^)]*\)/)[0], /p_max_por_minuto\s+integer,\s*p_max_por_minuto_org\s+integer/);
    const org = corpoFn.indexOf("p_max_por_minuto_org is not null");
    const global = corpoFn.indexOf("p_max_por_minuto is not null");
    assert.ok(org > 0 && global > 0, "faltou uma das camadas");
    const trechoOrg = corpoFn.slice(org, global);
    assert.match(trechoOrg, /x\.organizacao_id = m\.organizacao_id/, "a camada por organização precisa filtrar pela organização da mensagem");
    assert.match(trechoOrg, /'RATE_LIMIT_MINUTO_ORGANIZACAO'/);
    const trechoGlobal = corpoFn.slice(global, corpoFn.lastIndexOf("update comunicacao_mensagens"));
    assert.doesNotMatch(trechoGlobal.slice(0, trechoGlobal.indexOf("'RATE_LIMIT_MINUTO'")), /x\.organizacao_id = m\.organizacao_id/, "a camada GLOBAL não pode filtrar por organização");
    assert.ok(corpoFn.indexOf("pg_advisory_xact_lock") < org, "as duas camadas rodam DEPOIS do lock");
    assert.ok(Math.max(org, global) < corpoFn.lastIndexOf("update comunicacao_mensagens"), "o SENDING só depois das duas");
  });

  test("o início do envio mantém TODO o fencing da 087 (PROCESSING + worker + claim_geracao + lease + attempts) e é o único ponto que sobe `tentativas` na 088", () => {
    const corpoFn = c();
    const upd = corpoFn.slice(corpoFn.lastIndexOf("update comunicacao_mensagens"));
    for (const re of [/status = 'PROCESSING'/, /claimed_by = p_worker/, /claim_geracao = p_claim_geracao/, /claim_expira_em > now\(\)/, /tentativas < max_tentativas/]) assert.match(upd, re);
    assert.match(ultimoSet(corpoFn), /status = 'SENDING'/);
    assert.match(ultimoSet(corpoFn), /tentativas = tentativas \+ 1/);
    for (const nome of funcoes088().filter((f) => f !== "comunicacao_reservar_envio")) {
      if (FUNCOES_DE_TRIGGER.has(nome)) continue;
      assert.doesNotMatch(corpo(nome), /tentativas\s*=\s*(m\.)?tentativas\s*\+/, `${nome} não pode criar attempt`);
    }
  });

  test("TTL é avaliado no relógio do BANCO antes de qualquer contagem", () => {
    const corpoFn = c();
    assert.match(corpoFn, /m\.expira_em is not null and m\.expira_em <= now\(\)/);
    assert.ok(corpoFn.indexOf("'EXPIRADA'") < corpoFn.indexOf("count(*)"));
  });
});

describe("migration 088 — reconciliação humana de DELIVERY_UNKNOWN (contrato, sem retry)", () => {
  const c = () => corpo("comunicacao_reconciliar_entrega");

  test("exige operador, motivo (>= 5 caracteres) e resultado dentro de {ENVIADA, NAO_ENVIADA}", () => {
    assert.match(c(), /p_operador is null then raise exception/);
    assert.match(c(), /length\(trim\(p_motivo\)\) < 5/);
    assert.match(c(), /p_resultado not in \('ENVIADA', 'NAO_ENVIADA'\)/);
  });

  test("só age sobre DELIVERY_UNKNOWN; grava operador/motivo/instante; NUNCA devolve a mensagem a SCHEDULED/PROCESSING/SENDING", () => {
    const corpoFn = c();
    assert.match(corpoFn, /m\.status = 'DELIVERY_UNKNOWN'/);
    assert.match(corpoFn, /'operador', p_operador/);
    assert.match(corpoFn, /'motivo', p_motivo/);
    assert.match(corpoFn, /'em', now\(\)/);
    for (const proibido of ["'SCHEDULED'", "'PROCESSING'", "'SENDING'", "'DETECTED'", "insert into comunicacao_mensagens"]) {
      assert.ok(!corpoFn.includes(proibido), `reconciliar não pode produzir ${proibido}: outra mensagem é um NOVO evento explícito`);
    }
    assert.match(corpoFn, /case when p_resultado = 'ENVIADA' then 'SENT' else 'FAILED' end/);
  });
});

describe("migration 088 — segurança das funções", () => {
  test("toda função da 088 é SECURITY INVOKER, com search_path fixo, sem EXECUTE para public/anon/authenticated e com GRANT só para service_role", () => {
    const sql = sql088();
    const nomes = funcoes088();
    assert.ok(nomes.length >= 5, `esperava as funções da 088, achei: ${nomes.join(", ")}`);
    for (const nome of nomes) {
      const ini = sql.indexOf(`create or replace function ${nome}(`);
      const cabecalho = sql.slice(ini, sql.indexOf("$$", ini));
      if (!FUNCOES_DE_TRIGGER.has(nome)) assert.match(cabecalho, /security invoker/, `${nome}: deve ser SECURITY INVOKER`);
      assert.doesNotMatch(cabecalho, /security definer/i, `${nome}: nunca DEFINER`);
      assert.match(cabecalho, /set search_path = public/, `${nome}: search_path fixo`);
      // CREATE OR REPLACE de uma função que JÁ existe (082/087) preserva os grants dela (só service_role) — o
      // runtime é provado pela consulta de grants no banco de TESTE. As funções NOVAS precisam do REVOKE/GRANT.
      if (funcaoJaExistia(nome)) continue;
      assert.match(sql, new RegExp(`revoke all on function ${nome}\\([^)]*\\) from public, anon, authenticated`), `${nome}: falta o REVOKE`);
      if (!FUNCOES_DE_TRIGGER.has(nome)) {
        assert.match(sql, new RegExp(`grant execute on function ${nome}\\([^)]*\\) to service_role`), `${nome}: falta o GRANT para service_role`);
      }
    }
    assert.doesNotMatch(sql, /grant [^;]*\b(anon|authenticated|public)\b/i, "nenhum GRANT para anon/authenticated/public");
  });

  test("a 088 é determinística: sem random() e sem hora local do servidor", () => {
    assert.doesNotMatch(sql088(), /\brandom\(\)/i);
    assert.doesNotMatch(sql088(), /current_setting\('timezone'\)/i);
  });
});

describe("módulo de comunicação — horário e determinismo", () => {
  const ARQUIVOS = readdirSync(COM).filter((f) => f.endsWith(".js") && f !== "comunicacao.scheduler.js").map((f) => path.join(COM, f));

  test("nenhum arquivo do módulo decide horário pela hora LOCAL DO SERVIDOR (getHours/getDay/setHours/getMinutes) — só Intl com o timezone da organização", () => {
    const violacoes = [];
    for (const arq of ARQUIVOS) {
      if (/\.(getHours|getDay|setHours|getMinutes|getDate|setDate)\s*\(/.test(lerJs(arq))) violacoes.push(path.basename(arq));
    }
    assert.deepEqual(violacoes, [], "hora do servidor usada como regra de negócio (o Render roda em UTC)");
  });

  test("o antigo comunicacao.scheduler.js (hora do servidor) foi aposentado", () => {
    assert.ok(!existsSync(path.join(COM, "comunicacao.scheduler.js")), "comunicacao.scheduler.js decidia horário pela hora local do servidor — use comunicacao.horario.js");
  });

  test("nenhum Math.random no módulo (jitter e distribuição são determinísticos)", () => {
    const violacoes = ARQUIVOS.filter((arq) => /Math\.random\s*\(/.test(lerJs(arq))).map((a) => path.basename(a));
    assert.deepEqual(violacoes, []);
  });

  test("o offset fixo nunca é regra: nada de '-03:00' hardcoded no cálculo de horário", () => {
    assert.doesNotMatch(lerJs(path.join(COM, "comunicacao.horario.js")), /-03:00|UTC-3|\* ?3 ?\* ?60/);
  });
});

describe("habilitação por empresa — sem o gate temporário fixo", () => {
  test("o resolvedor lê comunicacao_habilitacoes, SEMPRE filtrando por organizacao_id, e não devolve mais `false` fixo", () => {
    const codigo = lerJs(path.join(COM, "comunicacao.habilitacao.js"));
    assert.doesNotMatch(codigo, /SEM_ESTRUTURA_DE_HABILITACAO/, "o gate temporário fixo continua no código");
    assert.match(codigo, /from\(\s*["'`]comunicacao_habilitacoes["'`]\s*\)/);
    const consultas = [...codigo.matchAll(/from\(\s*["'`]comunicacao_habilitacoes["'`]\s*\)[\s\S]{0,300}/g)].map((m) => m[0]);
    assert.ok(consultas.length > 0);
    for (const q of consultas) assert.match(q, /\.eq\(\s*["'`]organizacao_id["'`]/, "consulta de habilitação sem organizacao_id explícito");
  });
});

describe("NENHUMA automação indevida no boot (H.2-A: só o worker dedicado pode chamar o pipeline)", () => {
  const ORQUESTRACAO = ["comunicacao.alertas.service.js", "comunicacao.fila.repo.js", "comunicacao.habilitacao.js", "comunicacao.horario.js", "comunicacao.policy.js"];
  const WORKER_COMUNICACAO = path.join(SRC, "worker-comunicacao");

  test("o pipeline de alertas não tem setInterval/setTimeout/cron/loop de fundo", () => {
    const violacoes = [];
    for (const nome of ORQUESTRACAO) {
      const arq = path.join(COM, nome);
      if (!existsSync(arq)) continue;
      if (/\b(setInterval|setTimeout|setImmediate|node-cron|cron\.schedule|new CronJob)\b/.test(lerJs(arq))) violacoes.push(nome);
    }
    assert.deepEqual(violacoes, []);
  });

  test("server.js, app.js e routes.js NÃO importam o pipeline de alertas, o resolvedor de habilitação nem o horário", () => {
    for (const nome of ["server.js", "app.js", "routes.js"]) {
      const codigo = lerJs(path.join(SRC, nome));
      assert.doesNotMatch(codigo, /comunicacao\.alertas\.service|comunicacao\.habilitacao|comunicacao\.horario|comunicacao\.fila\.repo/, `${nome} ligou a automação de comunicação`);
    }
  });

  test("fora do módulo, só o worker de comunicação dedicado (worker-comunicacao/) importa o pipeline de alertas", () => {
    const violacoes = [];
    const varrer = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (full !== COM && full !== WORKER_COMUNICACAO) varrer(full); continue; }
        if (e.name.endsWith(".js") && /comunicacao\.alertas\.service/.test(readFileSync(full, "utf8"))) violacoes.push(path.relative(SRC, full));
      }
    };
    varrer(SRC);
    assert.deepEqual(violacoes, [], "algo fora do módulo e fora do worker dedicado importa o pipeline de alertas");
  });

  // Checkpoint H.2-A: o worker existe, mas fica atrás do gate de modo (comunicacao.config.js#modoAtual)
  // ANTES de chamar executarCiclo — ver loop.js. Ele é a ÚNICA exceção sancionada acima.
  test("o worker de comunicação dedicado existe e é o único ponto fora do módulo que chama executarCiclo", () => {
    const idx = path.join(WORKER_COMUNICACAO, "index.js");
    assert.ok(existsSync(idx), "esperava backend/src/worker-comunicacao/index.js (Checkpoint H.2-A)");
    assert.match(lerJs(idx), /comunicacao\.alertas\.service/);
    assert.match(lerJs(path.join(WORKER_COMUNICACAO, "loop.js")), /modoAtual/, "o worker precisa consultar o modo global antes de chamar executarCiclo");
  });
});
