#!/usr/bin/env node
// RECUPERAÇÃO COM POSTGRESQL (Execução 08C) — somente numa instância PostgreSQL PRÓPRIA desta verificação, dados SINTÉTICOS.
//
//   FV2_PG_DIR=<pasta fv2-pg-teste-recuperacao-...> FV2_PG_PORTA=<porta> node scripts/fv2-recuperacao-pg.mjs
//
// Recusa rodar sem uma pasta própria (nunca reinicia o cluster de testes compartilhado nem outro PostgreSQL). Verifica:
//   1. reinício limpo com dados persistidos;          5. sessão de banco recuperada depois do reinício;
//   2. queda ABRUPTA durante operações financeiras;   6. integridade (conservação) depois de cada queda;
//   3. conexões derrubadas no meio da operação;       7. versão homologada reproduzida igual;
//   4. repetição após falha sem duplicidade e         8. auditoria e histórico preservados;
//      operações concorrentes atravessando a queda;   9. cofre documental íntegro.
// Nada é recriado vazio: o mesmo banco (e o mesmo cofre) é religado e conferido.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { ESCOPOS_PADRAO, ctx, montar, obrigacao } from "../test/financeiro-v2/helpers/cenario.js";
import { repositorioPostgresDeTeste } from "../test/financeiro-v2/helpers/postgres.js";
import { criarCofreDisco } from "../src/modules/financeiro-v2/index.js";

const PASTA = process.env.FV2_PG_DIR ?? "";
if (!/fv2-pg-teste-recuperacao/.test(basename(PASTA))) {
  console.error("Recusado: defina FV2_PG_DIR com uma pasta PRÓPRIA (nome contendo fv2-pg-teste-recuperacao) e FV2_PG_PORTA. O cluster compartilhado nunca é reiniciado por este script.");
  process.exit(2);
}
const banco = (acao) => {
  const r = spawnSync(process.execPath, ["scripts/fv2-banco-teste.mjs", acao], { encoding: "utf8", env: process.env, windowsHide: true });
  if (r.status !== 0) throw new Error(`fv2-banco-teste ${acao}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
};
const esperar = (ms) => new Promise((ok) => { setTimeout(ok, ms); });
const resultado = {};
const marcar = (item, ok, detalhe) => { resultado[item] = { situacao: ok ? "PASS" : "FAIL", ...detalhe }; };

banco("iniciar");
const c = ctx();
const repositorio = repositorioPostgresDeTeste(ESCOPOS_PADRAO);
const raizCofre = join(PASTA, "..", `${basename(PASTA)}-cofre`);
mkdirSync(raizCofre, { recursive: true });
const cofre = criarCofreDisco({ raiz: raizCofre });
const { nucleo: n } = montar({ repositorio, cofre });
/** Repetição após falha: a operação é refeita (mesma chave de idempotência) até o banco voltar. */
async function repetir(fn, { tentativas = 40, intervalo = 250 } = {}) {
  let ultima;
  for (let i = 0; i < tentativas; i += 1) {
    try { return { valor: await fn(), falhasAntes: i }; } catch (e) { ultima = e; await esperar(intervalo); }
  }
  throw ultima;
}

const interno = await repositorio.interno();
let dono = await interno.dono();
// Durabilidade de PRODUÇÃO nesta instância própria. O cluster de testes compartilhado roda com fsync/synchronous_commit
// desligados (velocidade): numa queda abrupta ele perde os últimos commits — isso não serve para testar recuperação.
for (const g of ["fsync = on", "synchronous_commit = on", "full_page_writes = on"]) await dono.query(`alter system set ${g}`);
banco("parar");
banco("iniciar");
dono = await interno.dono();
const durabilidade = (await repetir(() => dono.query("select current_setting('fsync') f, current_setting('synchronous_commit') s, current_setting('full_page_writes') p"))).valor.rows[0];

// ----------------------------------------------------------------------------------------------- dados sintéticos
const conta = await n.configurarContaFinanceira(c, { tipo: "BANCARIA", nome: "Banco sintético" });
const forn = await n.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Fornecedor sintético" });
for (let i = 0; i < 20; i += 1) {
  await n.registrarVenda(c, { canal: "BALCAO", dataVenda: `2026-08-${String(1 + i).padStart(2, "0")}`, brutoCentavos: 2000 + i, fonte: { sistema: "MANUAL", idExterno: `R-${i}` }, pagamentos: [{ forma: "PIX", valorCentavos: 2000 + i, contaId: conta.id }] });
}
await n.registrarObrigacao(c, obrigacao(forn.id, { competencia: "2026-08", dataEmissao: "2026-08-02", vencimento: "2026-08-20", fonte: { sistema: "MANUAL", idExterno: "OB-AGO" } }));
const g = await cofre.guardar(c, { conteudo: new TextEncoder().encode("%PDF-1.4\n% comprovante sintetico de recuperacao\n%%EOF\n"), tipoMime: "application/pdf" });
// Auditoria de concessões: uma concessão REAL pela função guardada (a fixture dos testes não passa por ela).
await n.concederAcesso(c, { usuarioId: "dddddddd-0000-4000-8000-000000000501", acoes: ["financeiro_v2.ver"], justificativa: "Leitura (recuperação sintética)." });
const { documento } = await n.registrarDocumento(c, { origem: "MANUAL", arquivoId: g.arquivoId, hashSha256: g.hashSha256, tipo: "COMPROVANTE", recebidoEm: "2026-08-25", competencia: "2026-08", descricao: "Comprovante sintético" });
await n.alterarEstadoDaCompetencia(c, { competencia: "2026-08", novoEstado: "FECHAMENTO_PRELIMINAR" });
await n.alterarEstadoDaCompetencia(c, { competencia: "2026-08", novoEstado: "FECHAMENTO_HOMOLOGADO", metodologia: "Homologação sintética (recuperação).", confirmar: true });

const contar = async (tabela) => Number((await dono.query(`select count(*)::int as n from ${tabela}`)).rows[0].n);
async function retrato() {
  const tipos = ["VENDA", "PAGAMENTO_VENDA", "LANCAMENTO", "OBRIGACAO", "MOVIMENTACAO", "DOCUMENTO", "COMPETENCIA", "VERSAO_FECHAMENTO"];
  const contagens = {};
  for (const t of tipos) contagens[t] = (await n.consultarRegistros(c, { tipo: t })).length;
  const ap = await n.apurarCompetencia(c, { competencia: "2026-08" });
  return {
    contagens, dre: ap.dre.linhas.map((l) => [l.codigo, l.valorCentavos]), versoes: await n.consultarVersoesDeFechamento(c, { competencia: "2026-08" }),
    historico: await contar("fv2_historico"), auditoria: await contar("fv2_auditoria_concessao"), conservacao: await n.verificarConservacao(c),
  };
}
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const antes = await retrato();

// 1. Reinício limpo (modo fast) com os dados persistidos; a primeira leitura depois volta sozinha ou após repetição.
banco("parar");
banco("iniciar");
const r1 = await repetir(() => retrato());
marcar("1_reinicio_limpo_dados_persistidos", igual(r1.valor, antes), { falhasAteVoltar: r1.falhasAntes });

// 2 + 4. Queda ABRUPTA durante 30 registros de obrigação (cada um atômico, com chave de idempotência); repetição depois.
const lote = Array.from({ length: 150 }, (_, i) => obrigacao(forn.id, { valorOriginalCentavos: 1000 + i, descricao: `Compra ${i}`, fonte: { sistema: "MANUAL", idExterno: `QUEDA-${i}` } }));
let concluidasAntesDaQueda = 0;
const corrida = (async () => {
  for (const o of lote) {
    try { await n.registrarObrigacao(c, o); concluidasAntesDaQueda += 1; } catch { /* queda: segue tentando os próximos, que também falham */ }
  }
})();
// Concorrência atravessando a queda: um segundo fluxo registra movimentações ao mesmo tempo.
const movs = Array.from({ length: 10 }, (_, i) => ({ contaId: conta.id, dataEfetiva: "2026-09-05", sentido: "SAIDA", valorCentavos: 100 + i, natureza: "PAGAMENTO", fonte: { sistema: "MANUAL", idExterno: `MOV-${i}` } }));
const corrida2 = (async () => { for (const mv of movs) { try { await n.registrarMovimentacao(c, mv); } catch { /* queda */ } } })();
await esperar(150);
banco("derrubar");
await Promise.all([corrida, corrida2]);
banco("iniciar");
const repeticoes = [];
for (const o of lote) repeticoes.push((await repetir(() => n.registrarObrigacao(c, o))).valor.repetido);
for (const mv of movs) await repetir(() => n.registrarMovimentacao(c, mv));
const obrigacoesDoLote = (await n.consultarRegistros(c, { tipo: "OBRIGACAO" })).filter((o) => /^QUEDA-/.test(o.fonte?.idExterno ?? ""));
const movsDoLote = (await n.consultarRegistros(c, { tipo: "MOVIMENTACAO" })).filter((m) => /^MOV-/.test(m.fonte?.idExterno ?? ""));
const lancs = await n.consultarRegistros(c, { tipo: "LANCAMENTO" });
const semLancamento = obrigacoesDoLote.filter((o) => !lancs.some((l) => l.id === o.lancamentoId));
marcar("2_queda_abrupta_durante_operacao", obrigacoesDoLote.length === 150 && semLancamento.length === 0 && concluidasAntesDaQueda < 150, { concluidasAntesDaQueda, repetidasNaRetomada: repeticoes.filter(Boolean).length, gravadasNaRetomada: repeticoes.filter((x) => !x).length, total: obrigacoesDoLote.length });
marcar("4_repeticao_e_concorrencia_sem_duplicidade", obrigacoesDoLote.length === 150 && movsDoLote.length === 10 && new Set(obrigacoesDoLote.map((o) => o.fonte.idExterno)).size === 150, { obrigacoes: obrigacoesDoLote.length, movimentacoes: movsDoLote.length });
const conservacao = await n.verificarConservacao(c);
marcar("6_integridade_apos_queda", conservacao.length === 0, { violacoes: conservacao.length });

// 3. Conexões da aplicação derrubadas NO MEIO de operações (pg_terminate_backend); a operação seguinte se recupera.
const extras = Array.from({ length: 10 }, (_, i) => obrigacao(forn.id, { valorOriginalCentavos: 500 + i, fonte: { sistema: "MANUAL", idExterno: `TERM-${i}` } }));
const derrubar = async () => (await dono.query("select count(pg_terminate_backend(pid))::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and usename <> current_user")).rows[0].n;
const corrida3 = Promise.allSettled(extras.map((o) => n.registrarObrigacao(c, o)));
await esperar(30);
const derrubadas = await derrubar();
const res3 = await corrida3;
for (const o of extras) await repetir(() => n.registrarObrigacao(c, o));
const term = (await n.consultarRegistros(c, { tipo: "OBRIGACAO" })).filter((o) => /^TERM-/.test(o.fonte?.idExterno ?? ""));
marcar("3_conexao_interrompida", term.length === 10 && (await n.verificarConservacao(c)).length === 0, { conexoesDerrubadas: derrubadas, falharamNaHora: res3.filter((x) => x.status === "rejected").length, total: term.length });

// 5. Sessão de banco recuperada: depois de tudo, o mesmo núcleo opera sem novo provisionamento.
const sessao = await repetir(() => n.registrarContraparte(c, { tipo: "FORNECEDOR", nome: "Depois da recuperação" }));
marcar("5_sessao_recuperada", Boolean(sessao.valor?.id), { falhasAteVoltar: sessao.falhasAntes });

// 7, 8, 9. Versão homologada, auditoria/histórico e cofre depois de mais uma queda abrupta.
const historicoAntes = await contar("fv2_historico");
const auditoriaAntes = await contar("fv2_auditoria_concessao");
banco("derrubar");
banco("iniciar");
const depois = (await repetir(() => retrato())).valor;
marcar("7_versao_homologada_reproduzida", igual(depois.versoes, antes.versoes) && igual(depois.dre, antes.dre), { versoes: (depois.versoes.versoes ?? depois.versoes).length });
marcar("8_auditoria_e_historico_preservados", depois.historico === historicoAntes && depois.auditoria === auditoriaAntes && auditoriaAntes > 0, { historicoAntes, historico: depois.historico, auditoriaAntes, auditoria: depois.auditoria });
const integridade = await repetir(() => n.verificarIntegridadeDoDocumento(c, { id: documento.id }));
const arquivo = await n.obterArquivoDoDocumento(c, { id: documento.id, finalidade: "BAIXAR" }).catch((e) => ({ erro: e.codigo }));
const hashLido = arquivo?.conteudo ? createHash("sha256").update(Buffer.from(arquivo.conteudo)).digest("hex") : null;
marcar("9_cofre_documental", integridade.valor?.conferido === true && (hashLido === null || hashLido === g.hashSha256), { conferido: integridade.valor?.conferido ?? null, hashConfere: hashLido === null ? "não lido" : hashLido === g.hashSha256, pastaDoCofre: existsSync(raizCofre) });

console.log(JSON.stringify({ instancia: { pasta: PASTA, porta: process.env.FV2_PG_PORTA ?? null, durabilidade }, resultado }, null, 2));
banco("parar");
process.exit(Object.values(resultado).every((x) => x.situacao === "PASS") ? 0 : 1);
