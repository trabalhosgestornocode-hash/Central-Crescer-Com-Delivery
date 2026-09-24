// TESTE ARQUITETURAL (D.3-B/D) — estático, sem banco. Complementa
// comunicacao-arquitetura-provider.test.js ("só whatsapp.service.js chama o
// provider") com as invariantes de FENCING e de fronteira de transporte:
//
//   1. nenhuma transição de estado de comunicacao_mensagens escapa do CAS:
//      fora do repositório da fila, ninguém faz UPDATE em comunicacao_mensagens;
//      dentro dele, só as funções conhecidas (agendar/cancelar SCHEDULED) fazem UPDATE direto;
//   2. as funções antigas, sem fencing, não existem mais;
//   3. o pipeline de envio (alertas.service) só usa as transições fenced;
//   4. o pipeline nunca conecta/reseta/desconecta o Gateway (nunca mexe no auth).
//
// Rodar: node --test test/comunicacao-arquitetura-fencing.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "src");
const COM = path.join(SRC, "modules", "comunicacao");
const FILA_REPO = path.join(COM, "comunicacao.fila.repo.js");
const SERVICE = path.join(COM, "comunicacao.alertas.service.js");

const semComentarios = (codigo) => codigo.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const ler = (arquivo) => semComentarios(readFileSync(arquivo, "utf8"));

function listar(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) out.push(...listar(full));
    else if (e.endsWith(".js")) out.push(full);
  }
  return out;
}

describe("arquitetura — fencing de comunicacao_mensagens", () => {
  test("nenhum arquivo FORA da fila.repo escreve em comunicacao_mensagens (update/insert/delete/upsert)", () => {
    const violacoes = [];
    for (const arquivo of listar(SRC)) {
      if (arquivo === FILA_REPO) continue;
      const codigo = ler(arquivo);
      if (/from\(\s*["'`]comunicacao_mensagens["'`]\s*\)\s*\.\s*(update|insert|delete|upsert)\s*\(/.test(codigo)) {
        violacoes.push(path.relative(SRC, arquivo));
      }
    }
    assert.deepEqual(violacoes, [], `escrita direta em comunicacao_mensagens fora do repositório:\n${violacoes.join("\n")}`);
  });

  test("dentro da fila.repo, só agendarMensagem/criarMensagemTeste (insert), cancelarPendentesPorAlerta (update guardado por SCHEDULED) e marcarAuditoriaTeste (update SÓ de metadados) escrevem direto", () => {
    const codigo = ler(FILA_REPO);
    const escritas = [...codigo.matchAll(/from\(\s*["'`]comunicacao_mensagens["'`]\s*\)\s*\.\s*(update|insert|delete|upsert)\s*\(/g)].map((m) => m[1]);
    // H.4-B.5: + criarMensagemTeste (INSERT de uma linha NOVA, sem alerta, já reivindicada por quem a cria) e marcarAuditoriaTeste (UPDATE só de metadados).
    // Central de Comunicação: + criarMensagemManual (INSERT de uma linha NOVA, sem alerta, já reivindicada por quem a cria — mesmo padrão do teste).
    assert.deepEqual(escritas.sort(), ["insert", "insert", "insert", "update", "update"], `escritas diretas inesperadas: ${escritas.join(",")}`);
    const marcar = codigo.slice(codigo.indexOf("export async function marcarAuditoriaTeste"));
    assert.match(marcar.slice(0, 1800), /\.update\(\{\s*metadados:\s*novo\s*\}\)/, "marcarAuditoriaTeste só pode atualizar metadados");
    assert.doesNotMatch(marcar.slice(0, 1800), /status\s*:/, "marcarAuditoriaTeste nunca toca status");

    // o único update direto precisa estar preso ao estado SCHEDULED (nunca toca linha que um worker segura)
    const bloco = codigo.slice(codigo.indexOf("export async function cancelarPendentesPorAlerta"));
    assert.match(bloco.slice(0, 500), /\.update\(\{\s*status:\s*STATUS_MENSAGEM\.CANCELLED\s*\}\)[\s\S]*\.eq\(\s*"status"\s*,\s*STATUS_MENSAGEM\.SCHEDULED\s*\)/);
  });

  test("as funções ANTIGAS sem fencing (marcar*) não existem mais em nenhum arquivo de src", () => {
    const proibidas = ["marcarEnviando", "marcarEnviado", "marcarFalha", "marcarBloqueado", "marcarEntregaIncerta"];
    const achados = [];
    for (const arquivo of listar(SRC)) {
      const codigo = ler(arquivo);
      for (const nome of proibidas) if (new RegExp(`\\b${nome}\\b`).test(codigo)) achados.push(`${path.relative(SRC, arquivo)}: ${nome}`);
    }
    assert.deepEqual(achados, [], `transição sem fencing reintroduzida:\n${achados.join("\n")}`);
  });

  test("a fila.repo expõe as transições fenced (+ a reserva da 088) e cada uma chama a RPC correspondente", () => {
    const codigo = ler(FILA_REPO);
    for (const [fn, rpc] of [["iniciarEnvio", "comunicacao_iniciar_envio"], ["finalizarEnvio", "comunicacao_finalizar_envio"], ["encerrarProcessamento", "comunicacao_encerrar_processamento"], ["reservarEnvio", "comunicacao_reservar_envio"]]) {
      assert.match(codigo, new RegExp(`export async function ${fn}\\b`), `falta ${fn}`);
      assert.ok(codigo.includes(`"${rpc}"`), `${fn} não chama ${rpc}`);
    }
  });
});

describe("arquitetura — o pipeline de envio", () => {
  test("processarJobReivindicado só chama o provider DEPOIS de reservarEnvio devolver INICIADO (ordem estática no código)", () => {
    const codigo = ler(SERVICE);
    const inicio = codigo.indexOf("filaRepo.reservarEnvio(");
    const envio = codigo.indexOf("whatsAppService.enviarTexto(");
    assert.ok(inicio > 0 && envio > 0, "não achei as duas chamadas");
    assert.ok(inicio < envio, "enviarTexto aparece ANTES de reservarEnvio");
    assert.equal(codigo.split("whatsAppService.enviarTexto(").length - 1, 1, "só pode existir UM ponto de envio no pipeline");
    // qualquer resultado diferente de INICIADO sai da função ANTES do envio (POSSE_PERDIDA/EXPIRADA/adiamento)
    assert.match(codigo.slice(inicio, envio), /reserva\.resultado\s*!==\s*RESULTADO_RESERVA\.INICIADO\s*\)\s*\{?\s*return/);
    assert.match(codigo.slice(inicio, envio), /reserva\.resultado\s*===\s*RESULTADO_RESERVA\.POSSE_PERDIDA\s*\)\s*return\s+POSSE_PERDIDA/);
  });

  test("o pipeline NÃO usa mais iniciarEnvio (sem reserva de capacidade): reservarEnvio é o único caminho PROCESSING -> SENDING", () => {
    assert.doesNotMatch(ler(SERVICE), /filaRepo\.iniciarEnvio\(/, "iniciarEnvio contornaria a reserva atômica de cooldown/cota/taxa");
  });

  test("a reserva recebe TODOS os limites (nunca null/ausente = sem limite) e o início do dia LOCAL da organização", () => {
    const codigo = ler(SERVICE);
    const chamada = codigo.slice(codigo.indexOf("filaRepo.reservarEnvio("), codigo.indexOf("filaRepo.reservarEnvio(") + 900);
    for (const campo of ["cooldownHoras", "maxPorContatoDia", "maxPorMinuto", "maxPorMinutoOrganizacao", "inicioDia"]) assert.match(chamada, new RegExp(`\\b${campo}\\s*:`), `reservarEnvio sem ${campo}`);
    assert.match(chamada, /inicioDoDiaLocal\(/, "a cota diária precisa usar o dia LOCAL da organização, não o do servidor");
  });

  test("toda transição do pipeline usa o token de CLAIM (…claim) ou de ATTEMPT (…attempt) — nenhuma chamada de transição sem ele", () => {
    const codigo = ler(SERVICE);
    for (const fn of ["encerrarProcessamento", "finalizarEnvio", "reservarEnvio"]) {
      const chamadas = [...codigo.matchAll(new RegExp(`filaRepo\\.${fn}\\(\\s*\\{([^}]*)\\}`, "g"))];
      assert.ok(chamadas.length > 0, `${fn} nunca é chamado`);
      for (const c of chamadas) assert.match(c[1], /\.\.\.(claim|attempt)\b/, `${fn}(...) sem o token de fencing: ${c[0].slice(0, 80)}`);
    }
  });

  test("resultado INCERTO nunca chama RETRY: a decisão RETRY só existe para RETRYAVEL", () => {
    const codigo = ler(SERVICE);
    assert.match(codigo, /classificacao === CLASSIFICACAO_ERRO\.INCERTO \? RESULTADO_FINAL_ENVIO\.DELIVERY_UNKNOWN/);
    // não pode haver nenhum outro caminho que use RESULTADO_FINAL_ENVIO.RETRY
    assert.equal(codigo.split("RESULTADO_FINAL_ENVIO.RETRY").length - 1, 2, "RETRY aparece fora da decisão classificada (esperado: 1 atribuição + 1 comparação)");
  });

  test("o pipeline (e o resto do módulo, salvo o provider) nunca chama connect/disconnect/reset do Gateway", () => {
    const violacoes = [];
    for (const arquivo of listar(COM)) {
      if (arquivo.includes(`${path.sep}providers${path.sep}`) || arquivo.endsWith("whatsapp.provider.js") || arquivo.endsWith("whatsapp.service.js")) continue;
      const codigo = ler(arquivo);
      if (/\.(connect|disconnect|reset)\s*\(/.test(codigo)) violacoes.push(path.relative(SRC, arquivo));
    }
    assert.deepEqual(violacoes, [], `o transporte/auth do Gateway só pode ser tocado por operação explícita:\n${violacoes.join("\n")}`);
  });

  test("a rota temporária de teste de envio NÃO voltou", () => {
    const achados = [];
    for (const arquivo of listar(SRC)) {
      if (/_teste-envio-whatsapp|teste-envio\.routes/.test(readFileSync(arquivo, "utf8"))) achados.push(path.relative(SRC, arquivo));
    }
    assert.deepEqual(achados, []);
  });
});

// ---------------------------------------------------------------------------
// Guardas estáticas sobre a migration 087 — as invariantes do modelo
// CLAIM × ATTEMPT não podem ser desfeitas por um refactor do SQL.
// ---------------------------------------------------------------------------
const MIGRATION_087 = path.join(__dirname, "..", "..", "database", "migrations", "087_comunicacao_fencing_envio.sql");

/** Corpo (entre os $$) da função SQL `nome` dentro da 087, sem comentários de linha. */
function corpoFuncao087(nome) {
  const sql = readFileSync(MIGRATION_087, "utf8");
  const ini = sql.indexOf(`create or replace function ${nome}(`);
  assert.ok(ini >= 0, `função ${nome} não encontrada na 087`);
  const a = sql.indexOf("$$", ini);
  const b = sql.indexOf("$$", a + 2);
  return sql.slice(a + 2, b).replace(/--.*$/gm, "");
}
/** Só a cláusula SET do UPDATE principal (procura a partir do `update`, pois o claim tem um `where` antes, no CTE). */
const soSet = (corpo) => {
  const resto = corpo.slice(corpo.indexOf("set ", corpo.search(/\bupdate\b/i)));
  const fim = resto.search(/\b(from|where)\b/i);
  return fim < 0 ? resto : resto.slice(0, fim);
};

describe("arquitetura — invariantes SQL do modelo CLAIM × ATTEMPT (migration 087)", () => {
  test("o CLAIM incrementa claim_geracao e NÃO incrementa tentativas (um deferimento não consome attempt)", () => {
    const set = soSet(corpoFuncao087("comunicacao_claim_mensagens"));
    assert.match(set, /claim_geracao\s*=\s*m\.claim_geracao\s*\+\s*1/);
    assert.doesNotMatch(set, /tentativas/, "o claim voltou a tocar em tentativas");
  });

  test("SÓ iniciar_envio incrementa tentativas (o attempt nasce na fronteira do envio) e exige status PROCESSING + claim + lease", () => {
    const corpo = corpoFuncao087("comunicacao_iniciar_envio");
    assert.match(soSet(corpo), /tentativas\s*=\s*tentativas\s*\+\s*1/);
    assert.match(corpo, /status\s*=\s*'PROCESSING'/);
    assert.match(corpo, /claimed_by\s*=\s*p_worker/);
    assert.match(corpo, /claim_geracao\s*=\s*p_claim_geracao/);
    assert.match(corpo, /claim_expira_em\s*>\s*now\(\)/);
    assert.match(corpo, /tentativas\s*<\s*max_tentativas/);
    for (const outra of ["comunicacao_finalizar_envio", "comunicacao_encerrar_processamento", "comunicacao_claim_mensagens"]) {
      assert.doesNotMatch(soSet(corpoFuncao087(outra)), /tentativas\s*=/, `${outra} não pode escrever em tentativas`);
    }
  });

  test("finalizar_envio exige o token do ATTEMPT (claim_geracao + tentativas) e o worker; encerrar_processamento exige o do CLAIM e PROCESSING", () => {
    const fin = corpoFuncao087("comunicacao_finalizar_envio");
    assert.match(fin, /m\.claimed_by\s*=\s*p_worker/);
    assert.match(fin, /m\.claim_geracao\s*=\s*p_claim_geracao/);
    assert.match(fin, /m\.tentativas\s*=\s*p_tentativa/);
    const enc = corpoFuncao087("comunicacao_encerrar_processamento");
    assert.match(enc, /m\.status\s*=\s*'PROCESSING'/);
    assert.match(enc, /m\.claimed_by\s*=\s*p_worker/);
    assert.match(enc, /m\.claim_geracao\s*=\s*p_claim_geracao/);
  });

  test("DELIVERY_UNKNOWN: a ÚNICA saída em finalizar_envio é SENT (confirmação tardia); nunca RETRY/FAILED", () => {
    const fin = corpoFuncao087("comunicacao_finalizar_envio");
    const ondeUnknown = fin.slice(fin.indexOf("m.status = 'SENDING'"));
    assert.match(ondeUnknown, /p_resultado\s*=\s*'SENT'\s+and\s+m\.status\s*=\s*'DELIVERY_UNKNOWN'/);
    assert.equal((fin.match(/DELIVERY_UNKNOWN'\s*\)/g) ?? []).length, 1, "mais de um caminho a partir de DELIVERY_UNKNOWN");
  });

  test("o claim só seleciona SCHEDULED e PROCESSING (nunca SENDING nem DELIVERY_UNKNOWN)", () => {
    const corpo = corpoFuncao087("comunicacao_claim_mensagens");
    assert.match(corpo, /status\s*=\s*'SCHEDULED'/);
    assert.match(corpo, /status\s*=\s*'PROCESSING'/);
    assert.doesNotMatch(corpo, /SENDING|DELIVERY_UNKNOWN/);
  });

  test("a 087 impõe a monotonicidade dos tokens por trigger", () => {
    const sql = readFileSync(MIGRATION_087, "utf8");
    assert.match(sql, /new\.claim_geracao\s*<\s*old\.claim_geracao/);
    assert.match(sql, /new\.tentativas\s*<\s*old\.tentativas/);
    assert.match(sql, /create trigger trg_comunicacao_mensagens_tokens_monotonicos\s+before update/);
  });

  test("a fila.repo passa p_claim_geracao nas transições fenced (iniciar/finalizar/encerrar + a reserva da 088) e não usa mais o número de tentativa para fenciar PROCESSING", () => {
    const codigo = ler(FILA_REPO);
    assert.equal((codigo.match(/p_claim_geracao/g) ?? []).length, 4);
    assert.doesNotMatch(codigo, /p_tentativa:\s*tentativa,\s*p_lease/);
  });
});
