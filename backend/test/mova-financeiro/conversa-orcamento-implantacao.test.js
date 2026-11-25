// 24/11/2026 — Publicação da conversa: (1) o orçamento da IA vale para TEXTO como vale para documento (teto, concorrência,
// falhas de contabilização, segredo fora de logs); (2) a migração 0017 aplicada ISOLADA, com o código antigo compatível e a ordem
// de implantação provada (migração ANTES do código novo). PostgreSQL local isolado; IA simulada; nada remoto.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { abrirPool, ambiente } from "../financeiro-v2/helpers/postgres.js";
import { urlDoBanco } from "../../scripts/fv2/ambiente.mjs";
import { gerarAplicarUnica, listarMigracoes } from "../../scripts/mova/pacoteProducao.mjs";
import { criarExtratorAnthropic } from "../../src/modules/mova-financeiro/ia/provedorAnthropic.js";
import { clienteComOrcamento, criarOrcamentoIa } from "../../src/modules/mova-financeiro/infra/operacao.js";
import { criarBancoMova, descartarBancoMova, motivoParaPularMova } from "./helpers/banco.js";
import { base, cenario, gw } from "./helpers/operacao.js";

const PULAR = motivoParaPularMova();
const t = (nome, fn) => test(nome, { skip: PULAR }, fn);
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "database", "mova-financeiro");
const criados = [];
after(async () => { for (const b of criados.splice(0)) await descartarBancoMova(b).catch(() => {}); for (const { pool, banco } of bancos.splice(0)) { await pool.end().catch(() => {}); await admin?.query(`drop database if exists ${banco} with (force)`).catch(() => {}); } });

// ------------------------------------------------------------------ 1. orçamento (texto = documento)
const RESPOSTA = { model: "claude-haiku-5-5", stop_reason: "end_turn", usage: { input_tokens: 5000, output_tokens: 350 }, content: [{ type: "text", text: JSON.stringify(base({ intencao: "CONSULTAR", consulta: "CONTAS_VENCIDAS" })) }] };
async function montar({ limiteChamadas, limiteCusto, falhaAoConcluir = false, atraso = 15, porta = null, api = async () => RESPOSTA } = {}) {
  const b = await criarBancoMova(); criados.push(b);
  if (limiteChamadas !== undefined) await b.pool.query("update mova.orcamento_ia set limite_chamadas = $1", [limiteChamadas]);
  if (limiteCusto !== undefined) await b.pool.query("update mova.orcamento_ia set limite_custo_microusd = $1", [limiteCusto]);
  const real = criarOrcamentoIa({ pool: b.pool });
  const orcamento = falhaAoConcluir ? { ...real, concluir: async () => { throw new Error("falha de contabilização"); } } : real;
  let chamadasApi = 0;
  const http = { beta: { messages: { async create(r) { chamadasApi += 1; await (porta ?? new Promise((x) => setTimeout(x, atraso))); return api(r); } } } };
  const extrator = criarExtratorAnthropic({ cliente: clienteComOrcamento(http, { orcamento }), obterEvidencia: async () => null });
  const perguntar = (i) => extrator.extrair({ texto: `pergunta livre ${i}`, tipo: "TEXTO", midia: null, contexto: {} });
  return { b, orcamento: real, perguntar, api: () => chamadasApi };
}
const linhas = async (b) => (await b.pool.query("select estado, custo_microusd::int as c from mova.consumo_ia order by id")).rows;

t("OR-01 concorrência: 12 perguntas de TEXTO ao mesmo tempo com limite de 4 chamadas ⇒ a API recebe exatamente 4; as demais param antes de chamar", async () => {
  const s = await montar({ limiteChamadas: 4 });
  const r = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => s.perguntar(i)));
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 4);
  assert.ok(r.filter((x) => x.status === "rejected").every((x) => x.reason?.codigo === "ORCAMENTO_ESGOTADO"));
  assert.equal(s.api(), 4, "nenhuma chamada paga além do limite");
  assert.equal((await linhas(s.b)).length, 4, "toda chamada de texto passou pelo registro de consumo");
  assert.ok((await linhas(s.b)).every((x) => x.c > 0));
});

t("OR-02 teto de custo sob concorrência: reservas EM VOO somadas nunca passam do limite (US$ 0,25 com reserva de US$ 0,10 ⇒ 2 chamadas simultâneas)", async () => {
  let abrir; const porta = new Promise((x) => { abrir = x; }); // as 2 chamadas aceitas ficam em voo até as demais serem recusadas (sem depender de tempo)
  const s = await montar({ limiteChamadas: 100, limiteCusto: 250_000, porta });
  let recusadas = 0;
  const todas = Array.from({ length: 8 }, (_, i) => s.perguntar(i).then((v) => ({ ok: v }), (e) => { recusadas += 1; return { erro: e }; }));
  const fim = Date.now() + 20_000;
  while (recusadas < 6 && Date.now() < fim) await new Promise((x) => setTimeout(x, 10));
  assert.equal(recusadas, 6, "6 recusadas enquanto as 2 reservas seguem em voo"); assert.equal(s.api(), 2);
  abrir();
  const r = await Promise.all(todas);
  assert.equal(r.filter((x) => x.ok).length, 2);
  assert.ok(r.filter((x) => x.erro).every((x) => x.erro?.codigo === "ORCAMENTO_ESGOTADO"));
});

t("OR-03 falha ao contabilizar depois da resposta: a reserva continua valendo como custo (nunca subestima) e o teto segue protegido", async () => {
  const s = await montar({ limiteChamadas: 100, limiteCusto: 250_000, falhaAoConcluir: true });
  for (let i = 0; i < 4; i++) await s.perguntar(i).catch(() => {});
  assert.equal(s.api(), 2, "com a contabilização falhando, as reservas ainda travam o teto");
  assert.ok((await linhas(s.b)).every((x) => x.estado === "RESERVADA" && x.c === 100_000));
});

t("OR-04 API sem resposta (tempo esgotado): possivelmente faturada ⇒ a reserva inteira fica como custo; com resposta de erro 4xx ⇒ custo 0", async () => {
  const s = await montar({ api: async () => { throw Object.assign(new Error("timeout"), { name: "APIConnectionTimeoutError" }); } });
  await s.perguntar(1).catch(() => {});
  assert.deepEqual((await linhas(s.b)).map((x) => [x.estado, x.c]), [["FALHOU", 100_000]]);
  const r4 = await montar({ api: async () => { throw Object.assign(new Error("invalid"), { status: 400 }); } });
  await r4.perguntar(1).catch(() => {});
  assert.deepEqual((await linhas(r4.b)).map((x) => [x.estado, x.c]), [["FALHOU", 0]]);
});

t("OR-05 teto TOTAL de US$ 10 é do código: mesmo com limite maior no banco, a reserva que passaria dele é recusada", async () => {
  const s = await montar({ limiteChamadas: 1000, limiteCusto: 999_000_000 });
  await s.b.pool.query("insert into mova.consumo_ia (estado, custo_microusd) values ('CONCLUIDA', 9950000)"); // US$ 9,95 já gastos
  await assert.rejects(s.perguntar(1), { codigo: "ORCAMENTO_ESGOTADO" });
  assert.equal(s.api(), 0);
});

t("OR-06 segredo fora de logs e erros: erro da API com a chave no texto não vaza; os registros do motor só têm códigos", async () => {
  const SEGREDO = "sk-ant-api03-SEGREDO-DE-TESTE-NAO-VAZAR";
  const logs = [];
  const s = await cenario({ responder: () => { throw Object.assign(new Error(`401 invalid x-api-key ${SEGREDO}`), { status: 401 }); }, extras: { registrar: (e) => logs.push(e) } });
  await s.enviar(gw({ texto: "MOVA por que a despesa da alfa aumentou?" }));
  const tudo = JSON.stringify([logs, await s.mova.armazenamento.historico.todos(), await s.saida()]);
  assert.ok(!tudo.includes(SEGREDO) && !/sk-ant/.test(tudo), "nenhum rastro do segredo");
  assert.ok(logs.some((l) => l.tipo === "MOVA_IA_LEITURA" && l.ok === false && l.codigo === "IA_SEM_AUTORIZACAO"), "a métrica registra só o código");
});

t("OR-07 o orçamento é um só: documento e texto somam no mesmo consumo (resumo)", async () => {
  const s = await montar({ limiteChamadas: 10 });
  await s.perguntar(1);
  const doc = criarExtratorAnthropic({ cliente: clienteComOrcamento({ beta: { messages: { create: async () => RESPOSTA } } }, { orcamento: s.orcamento }), obterEvidencia: async () => new Uint8Array(Buffer.from("%PDF-1.4\n%%EOF\n")) });
  await doc.extrair({ texto: "doc", tipo: "DOCUMENTO", midia: { mime: "application/pdf", referencia: "r" }, contexto: {} });
  assert.equal((await s.orcamento.resumo()).chamadas, 2);
});

// ------------------------------------------------------------------ 2. migração 0017 isolada e ordem de implantação
let admin = null;
const bancos = [];
async function bancoDeProducaoAntes() {
  const a = ambiente();
  admin ??= await abrirPool(a.urlAdmin, { max: 2 });
  const banco = `fv2_teste_mova_${randomBytes(6).toString("hex")}`;
  await admin.query(`create database ${banco} template template0`);
  await admin.query(`comment on database ${banco} is 'FV2_ISOLADO_TESTE:${a.marcador}'`);
  const pool = await abrirPool(urlDoBanco(a.urlAdmin, banco), { max: 1 });
  bancos.push({ pool, banco });
  // estado de produção ANTES: instalação completa e, em seguida, as reversões oficiais da 0017 e da 0016 ⇒ 0001–0015 registradas
  // com o sha do Git, sem 0016 e sem 0017 (a 0016 é de outra funcionalidade e NÃO pode ser arrastada).
  await pool.query(`begin;
${readFileSync(join(RAIZ, "producao", "instalar.sql"), "utf8")}
commit;`);
  // 24/11: migrações posteriores (0018+, ainda não aplicadas em produção) saem antes, pela reversão oficial de cada uma.
  await pool.query(readFileSync(join(RAIZ, "recuperacao", "reverter-0024.sql"), "utf8"));
  await pool.query(readFileSync(join(RAIZ, "recuperacao", "reverter-0023.sql"), "utf8"));
  await pool.query(readFileSync(join(RAIZ, "recuperacao", "reverter-0022.sql"), "utf8"));
  await pool.query(readFileSync(join(RAIZ, "recuperacao", "reverter-0021.sql"), "utf8"));
  await pool.query(readFileSync(join(RAIZ, "recuperacao", "reverter-0020.sql"), "utf8"));
  await pool.query(readFileSync(join(RAIZ, "recuperacao", "reverter-0019.sql"), "utf8"));
  await pool.query(readFileSync(join(RAIZ, "recuperacao", "reverter-0018.sql"), "utf8"));
  await pool.query(readFileSync(join(RAIZ, "recuperacao", "reverter-0017.sql"), "utf8"));
  await pool.query(readFileSync(join(RAIZ, "recuperacao", "reverter-0016.sql"), "utf8"));
  return pool;
}
const CODIGO_ANTIGO = { inserir: (p) => p.query("insert into mova.conversa_ativa (grupo_jid, participante_jid, ate, unidade_id, consulta) values ('g@g.us','p@lid', now() + interval '10 minutes', null, 'CONTAS_VENCIDAS') on conflict (grupo_jid, participante_jid) do update set consulta = excluded.consulta"),
  ler: async (p) => (await p.query("select unidade_id, consulta from mova.conversa_ativa where grupo_jid = 'g@g.us'")).rows[0] };
const CODIGO_NOVO = (p) => p.query("insert into mova.conversa_ativa (grupo_jid, participante_jid, ate, consulta, contexto) values ('g@g.us','p2@lid', now() + interval '10 minutes', 'CONTAS_VENCIDAS', '{\"competencia\":\"2026-10\"}'::jsonb)");

t("IM-01 ordem provada: ANTES da 0017 o código novo falha ao gravar o contexto; o código antigo funciona; aplicar-0017 isolada; o antigo continua; reaplicar aborta", async () => {
  const pool = await bancoDeProducaoAntes();
  await CODIGO_ANTIGO.inserir(pool);
  await assert.rejects(CODIGO_NOVO(pool), /contexto/, "deploy ANTES da migração quebraria a gravação — por isso a migração vem primeiro");
  const sql = readFileSync(join(RAIZ, "producao", "aplicar-0017.sql"), "utf8");
  assert.equal(sql, gerarAplicarUnica("0017", { tabelaExigida: "conversa_ativa" }), "arquivo versionado = gerado");
  assert.ok(!/0016_mova/.test(sql.replace(/-- Exige[^\n]*\n/, "")), "não arrasta a 0016");
  await pool.query(`begin;\n${sql}\ncommit;`);
  const reg = (await pool.query("select nome, sha256 from mova.mova_migracao where nome like '0017%' or nome like '0016%'")).rows;
  assert.deepEqual(reg, [{ nome: "0017_mova_conversa_contexto.sql", sha256: listarMigracoes().find((m) => m.nome.startsWith("0017")).sha256 }], "só a 0017 foi registrada");
  assert.equal((await pool.query("select count(*)::int n from information_schema.columns where table_schema='mova' and table_name='conversa_ativa' and column_name='contexto'")).rows[0].n, 1);
  assert.deepEqual(await CODIGO_ANTIGO.ler(pool), { unidade_id: null, consulta: "CONTAS_VENCIDAS" }, "linha do código antigo intacta (contexto nulo)");
  await CODIGO_ANTIGO.inserir(pool); // o código antigo segue gravando depois da migração
  await CODIGO_NOVO(pool);
  await assert.rejects(pool.query(`begin;\n${sql}\ncommit;`).catch(async (e) => { await pool.query("rollback"); throw e; }), /já aplicada/);
  // reversão: remove só a coluna e o registro
  await pool.query(readFileSync(join(RAIZ, "recuperacao", "reverter-0017.sql"), "utf8"));
  assert.equal((await pool.query("select count(*)::int n from mova.mova_migracao where nome like '0017%'")).rows[0].n, 0);
  await CODIGO_ANTIGO.inserir(pool);
});

t("IM-02 pré-condições: hash divergente de migração instalada e banco de HOMOLOGAÇÃO abortam sem mudar nada", async () => {
  const sql = readFileSync(join(RAIZ, "producao", "aplicar-0017.sql"), "utf8");
  const pool = await bancoDeProducaoAntes();
  await pool.query("update mova.mova_migracao set sha256 = repeat('a', 64) where nome like '0005%'");
  await assert.rejects(pool.query(`begin;\n${sql}\ncommit;`).catch(async (e) => { await pool.query("rollback"); throw e; }), /0005_mova_grupos_reais.sql ausente ou com outro conteúdo/);
  assert.equal((await pool.query("select count(*)::int n from information_schema.columns where table_schema='mova' and table_name='conversa_ativa' and column_name='contexto'")).rows[0].n, 0);
  await pool.query("update mova.mova_migracao set sha256 = (select sha256 from mova.mova_migracao where nome like '0004%') where nome like '0005%'"); // volta a algo válido, mas errado
  await assert.rejects(pool.query(`begin;
${sql}
commit;`).catch(async (e) => { await pool.query("rollback"); throw e; }), /0005_mova_grupos_reais.sql ausente ou com outro conteúdo/);
  const h = await bancoDeProducaoAntes();
  await h.query("select 1");
  await admin.query(`comment on database ${bancos.at(-1).banco} is 'MOVA_HOMOLOGACAO:marcador-teste-17'`);
  await assert.rejects(h.query(`begin;
${sql}
commit;`).catch(async (e) => { await h.query("rollback"); throw e; }), /banco de HOMOLOGAÇÃO/);
});

t("IM-03 o código NOVO convive com o banco SEM a 0017: continuidade funciona (sem o período) e passa a persistir o período depois da migração, sem reiniciar", async () => {
  const { criarArmazenamentoPostgres } = await import("../../src/modules/mova-financeiro/infra/postgres.js");
  const pool = await bancoDeProducaoAntes();
  const a = criarArmazenamentoPostgres({ pool });
  const chave = { grupoId: "g@g.us", participanteId: "p@lid" };
  await a.conversas.registrar({ ...chave, unidadeId: null, consulta: "CONTAS_VENCIDAS", contexto: { competencia: "2026-10" }, validadeMs: 600_000 });
  assert.deepEqual(await a.conversas.obter(chave), { unidadeId: null, consulta: "CONTAS_VENCIDAS", contexto: null }, "sem a coluna: consulta e unidade continuam, sem período");
  await pool.query(`begin;\n${readFileSync(join(RAIZ, "producao", "aplicar-0017.sql"), "utf8")}\ncommit;`);
  // a sonda reavalia a cada 60 s; aqui só confirmamos que, com a coluna, uma instância nova grava e lê o período
  const b = criarArmazenamentoPostgres({ pool });
  await b.conversas.registrar({ ...chave, unidadeId: null, consulta: "CONTAS_VENCIDAS", contexto: { competencia: "2026-10" }, validadeMs: 600_000 });
  assert.deepEqual((await b.conversas.obter(chave)).contexto, { competencia: "2026-10" });
});

// ------------------------------------------------------------------ 3. (25/11) orçamento renovável: só 0018 + 0022 sobre a produção real
t("IM-04 aplicar-orcamento-renovavel: sobre 0001–0017 aplica SÓ 0018 + 0022, não liga nada, o acumulado segue; reaplicar aborta; reversão oficial volta ao estado anterior", async () => {
  const { gerarAplicarOrcamento } = await import("../../scripts/mova/pacoteProducao.mjs");
  const { criarOrcamentoRenovavel } = await import("../../src/modules/mova-financeiro/infra/orcamentoRenovavel.js");
  const pool = await bancoDeProducaoAntes();
  // estado de produção conferido em 25/11: 0001–0017 (a função acima tira 0016/0017; recoloca pelas migrações oficiais)
  for (const p of ["0016", "0017"]) { const m = listarMigracoes().find((x) => x.nome.startsWith(p)); await pool.query(`begin;\n${m.sql}\ninsert into mova.mova_migracao (nome, sha256) values ('${m.nome}', '${m.sha256}');\ncommit;`); }
  const sql = readFileSync(join(RAIZ, "producao", "aplicar-orcamento-renovavel.sql"), "utf8");
  assert.equal(sql, gerarAplicarOrcamento(), "arquivo versionado = gerado");
  await criarOrcamentoIa({ pool }).reservar(); // consumo antigo, regime acumulado
  await pool.query(`begin;\n${sql}\ncommit;`);
  const nomes = (await pool.query("select nome from mova.mova_migracao where nome >= '0018' order by nome")).rows.map((x) => x.nome);
  assert.deepEqual(nomes, ["0018_mova_orcamento_renovavel.sql", "0022_mova_orcamento_uso.sql"], "não arrasta 0019/0020/0021");
  const pol = (await pool.query("select * from mova.orcamento_ia_politica")).rows[0];
  assert.equal(pol.ativo, false, "nada é ligado pela migração");
  assert.deepEqual([Number(pol.limite_mensal_microusd), Number(pol.limite_diario_microusd), Number(pol.limite_requisicao_microusd)], [10_000_000, 1_000_000, 100_000], "limites financeiros iguais aos aprovados");
  assert.deepEqual([Number(pol.reserva_documentos_mensal_microusd), Number(pol.reserva_documentos_diario_microusd), pol.limite_chamadas_conversa_diario], [2_000_000, 200_000, 300]);
  assert.equal((await criarOrcamentoIa({ pool }).resumo()).chamadas, 1, "o acumulado continua igual (o código atual não muda)");
  await assert.rejects(criarOrcamentoRenovavel({ pool }).reservar(), { codigo: "ORCAMENTO_INDISPONIVEL" }, "renovável desligado até a autorização");
  await assert.rejects(pool.query(`begin;\n${sql}\ncommit;`).catch(async (e) => { await pool.query("rollback"); throw e; }), /já aplicada/);
  await pool.query(readFileSync(join(RAIZ, "recuperacao", "reverter-0022.sql"), "utf8"));
  await pool.query(readFileSync(join(RAIZ, "recuperacao", "reverter-0018.sql"), "utf8"));
  assert.deepEqual((await pool.query("select nome from mova.mova_migracao where nome >= '0018'")).rows, []);
  assert.equal((await criarOrcamentoIa({ pool }).resumo()).chamadas, 1);
});

t("IM-05 aplicar-propostas-core (PR #223): sobre o estado de PRODUÇÃO (0001–0018 + 0022) aplica SÓ a 0020; o MOVA passa a achar o repositório; mova_app grava e não apaga; reaplicar aborta; a reversão de produção volta ao estado anterior (a genérica aborta por causa da 0022)", async () => {
  const { gerarAplicarOrcamento, gerarAplicarPropostas, gerarReverterPropostas } = await import("../../scripts/mova/pacoteProducao.mjs");
  const { repositorioDePropostasSeInstalado } = await import("../../src/modules/fv2-integracao/mova.js");
  const pool = await bancoDeProducaoAntes();
  for (const p of ["0016", "0017"]) { const m = listarMigracoes().find((x) => x.nome.startsWith(p)); await pool.query(`begin;\n${m.sql}\ninsert into mova.mova_migracao (nome, sha256) values ('${m.nome}', '${m.sha256}');\ncommit;`); }
  await pool.query(`begin;\n${gerarAplicarOrcamento()}\ncommit;`); // estado de produção de 25/11
  const sql = readFileSync(join(RAIZ, "producao", "aplicar-propostas-core.sql"), "utf8");
  const reverter = readFileSync(join(RAIZ, "producao", "reverter-propostas-core.sql"), "utf8");
  assert.equal(sql, gerarAplicarPropostas(), "arquivo versionado = gerado");
  assert.equal(reverter, gerarReverterPropostas(), "arquivo versionado = gerado");
  assert.equal(await repositorioDePropostasSeInstalado(pool), null, "antes: sem repositório (operações ficam desligadas)");
  await pool.query(`begin;\n${sql}\ncommit;`);
  const nomes = (await pool.query("select nome from mova.mova_migracao where nome >= '0018' order by nome")).rows.map((x) => x.nome);
  assert.deepEqual(nomes, ["0018_mova_orcamento_renovavel.sql", "0020_mova_core_propostas.sql", "0022_mova_orcamento_uso.sql"], "não arrasta 0019/0021");
  assert.ok(await repositorioDePropostasSeInstalado(pool), "depois: o MOVA acha o repositório");
  const priv = (await pool.query("select has_table_privilege('mova_app','mova.core_proposta','insert') i, has_table_privilege('mova_app','mova.core_proposta','delete') d")).rows[0];
  assert.deepEqual([priv.i, priv.d], [true, false]);
  await assert.rejects(pool.query(`begin;\n${sql}\ncommit;`).catch(async (e) => { await pool.query("rollback"); throw e; }), /já aplicada/);
  await assert.rejects(pool.query(readFileSync(join(RAIZ, "recuperacao", "reverter-0020.sql"), "utf8")), /migrações depois da 0020/, "a genérica não serve em produção");
  await pool.query(`begin;\n${reverter}\ncommit;`);
  assert.deepEqual((await pool.query("select nome from mova.mova_migracao where nome >= '0018' order by nome")).rows.map((x) => x.nome), ["0018_mova_orcamento_renovavel.sql", "0022_mova_orcamento_uso.sql"]);
  assert.equal((await pool.query("select to_regclass('mova.core_proposta') r")).rows[0].r, null);
});
