// MOVA (29/11/2026): reconciliação das notas antigas (registro do MOVA ainda PENDENTE_ANEXO, mas a nota já está anexada e aprovada no
// Financeiro). Dry-run por padrão, backup antes de escrever, revalidação por registro, idempotência, nenhuma escrita no Financeiro e
// nenhuma mensagem. Financeiro v2 real em memória, banco do MOVA isolado, dados sintéticos.
import assert from "node:assert/strict";
import { ALFA, ORG, t } from "./helpers/operacao.js";
import { MAURICIO, SEG, S2 } from "./helpers/cenarioEntregadores.js";
import { PREST_MAURICIO, TOM_ALFA, TOM_BETA, arquivoPdf, base, enviar, notas } from "./helpers/notasSinteticas.js";
import { RESULTADO, reconciliarNotasAntigas } from "../../src/modules/mova-financeiro/aplicacao/reconciliacaoNotasAntigas.js";

const ok = { prestador: PREST_MAURICIO, tomador: TOM_ALFA, valor: 600 };
const ITEM = { unidadeId: ALFA, entregador: "mauricio", numero: "321", semanaInicio: S2, valorCentavos: 600 };

/** Cenário: a nota chegou ANTES da identidade operacional (fica PENDENTE_ANEXO no MOVA); depois a nota foi anexada no Financeiro (já liberada para pagamento). */
async function cenarioAntigo({ anexar = true } = {}) {
  const s = await base({ operacional: false });
  await enviar(s, MAURICIO, arquivoPdf(ok));
  assert.equal((await notas(s)).at(-1).estado, "PENDENTE_ANEXO");
  if (anexar) {
    const c = s.adm(ALFA);
    await s.real.anexarDocumentoDoEntregador(c, { inicio: S2, entregador: "mauricio", tipoAnexo: "NOTA_FISCAL", arquivo: { conteudo: new Uint8Array(arquivoPdf(ok)), nome: "nf.pdf", tipoMime: "application/pdf" } });
  }
  const ler = async (esc, entregador, inicio) => {
    const c = s.adm(esc.unidadeId);
    const det = await s.real.detalharFechamentoDoEntregador(c, { inicio, entregador });
    const fechamento = (await s.real.consultarEntregador(c, { entregador })).fechamentos.find((f) => f.semanaInicio === inicio);
    return { fechamento, notas: det.notas ?? [] };
  };
  const args = (extra = {}) => ({ plano: [ITEM], ler, armazenamento: s.mova.armazenamento, escopoDe: (u) => ({ organizacaoId: ORG, unidadeId: u }), tomadorDe: () => TOM_ALFA, ...extra });
  const retrato = async () => JSON.stringify([(await s.real.consultarEntregador(s.adm(ALFA), { entregador: "mauricio" })).fechamentos.map((f) => [f.semanaInicio, f.valorCentavos, f.situacaoPagamento, f.situacaoDocumental]), (await detalheNotas(s)).length]);
  return { s, args, retrato };
}
const detalheNotas = async (s) => (await s.real.detalharFechamentoDoEntregador(s.adm(ALFA), { inicio: S2, entregador: "mauricio" })).notas ?? [];
const estado = async (s) => (await notas(s)).at(-1);

t("RC-1 dry-run (padrão): mostra antes/depois e NÃO escreve nada", async () => {
  const { s, args } = await cenarioAntigo();
  const r = await reconciliarNotasAntigas(args());
  assert.equal(r.executou, false);
  assert.deepEqual([r.resumo.prontas, r.resumo.paradas], [1, 0]);
  assert.equal(r.resultados[0].antes.estado, "PENDENTE_ANEXO");
  assert.equal(r.resultados[0].depois.estado, "ANEXADA");
  assert.equal(r.resultados[0].depois.conferencia, "CONFERE");
  assert.match(r.resultados[0].prestador, /^\*\*\.\*\*\*\./, "documento só mascarado");
  assert.equal((await estado(s)).estado, "PENDENTE_ANEXO", "nada mudou");
});

t("RC-2 executar sem backup é recusado antes de qualquer escrita", async () => {
  const { s, args } = await cenarioAntigo();
  await assert.rejects(() => reconciliarNotasAntigas(args({ executar: true })), (e) => e.codigo === "BACKUP_OBRIGATORIO");
  assert.equal((await estado(s)).estado, "PENDENTE_ANEXO");
});

t("RC-3 execução: só o registro do MOVA muda; backup ANTES; auditoria; Financeiro intacto; nenhuma mensagem; idempotente", async () => {
  const { s, args, retrato } = await cenarioAntigo();
  const financeiroAntes = await retrato();
  const filaAntes = (await s.saida(MAURICIO)).length;
  let backupFeito = null;
  const r = await reconciliarNotasAntigas(args({ executar: true, backup: async (linhas) => { backupFeito = { linhas, estadoNoMomento: (await estado(s)).estado }; } }));
  assert.equal(r.resumo.reconciliadas, 1);
  assert.equal(backupFeito.linhas.length, 1);
  assert.equal(backupFeito.estadoNoMomento, "PENDENTE_ANEXO", "o backup é tirado antes da escrita");
  const n = await estado(s);
  const doc = (await detalheNotas(s))[0].documentoId;
  assert.deepEqual([n.estado, n.conferencia, n.documento_id], ["ANEXADA", "CONFERE", doc]);
  assert.equal(await retrato(), financeiroAntes, "o Financeiro não foi tocado");
  assert.equal((await s.saida(MAURICIO)).length, filaAntes, "nenhuma notificação retroativa");
  const aud = (await s.banco.pool.query("select dados from mova.auditoria where acao = 'NOTA_ANTIGA_RECONCILIADA'")).rows;
  assert.equal(aud.length, 1);
  assert.ok(!JSON.stringify(aud[0].dados).includes(PREST_MAURICIO), "auditoria sem o documento completo");
  const de_novo = await reconciliarNotasAntigas(args({ executar: true, backup: async () => {} }));
  assert.deepEqual([de_novo.resumo.jaReconciliadas, de_novo.resumo.reconciliadas], [1, 0]);
  assert.equal((await s.banco.pool.query("select count(*)::int c from mova.auditoria where acao = 'NOTA_ANTIGA_RECONCILIADA'")).rows[0].c, 1, "idempotente: sem segunda auditoria");
});

t("RC-4 se algo mudou o registro PARA com o motivo e nada é escrito (valor, tomador, nota fora do Financeiro, registro inexistente)", async () => {
  const casos = [
    ["VALOR_DA_OBRIGACAO_MUDOU", { plano: [{ ...ITEM, valorCentavos: 650 }] }, {}],
    ["NOTA_NAO_CONFERE:TOMADOR_DE_OUTRA_EMPRESA", { tomadorDe: () => TOM_BETA }, {}],
    ["NOTA_NAO_ESTA_VIGENTE_NO_FINANCEIRO", {}, { anexar: false }],
    ["NOTA_DO_MOVA_NAO_ENCONTRADA", { plano: [{ ...ITEM, numero: "999" }] }, {}],
    ["TOMADOR_DA_UNIDADE_DESCONHECIDO", { tomadorDe: () => null }, {}],
  ];
  for (const [motivo, extra, opcoes] of casos) {
    const { s, args } = await cenarioAntigo(opcoes);
    const r = await reconciliarNotasAntigas(args({ ...extra, executar: true, backup: async () => {} }));
    assert.deepEqual([r.resultados[0].resultado, r.resultados[0].motivo], [RESULTADO.PARADA, motivo], motivo);
    assert.equal((await estado(s)).estado, "PENDENTE_ANEXO", `nada escrito: ${motivo}`);
  }
});

t("RC-5 lote: o registro que mudou para sozinho e os demais seguem; só a linha do plano é tocada", async () => {
  const { s, args } = await cenarioAntigo();
  const r = await reconciliarNotasAntigas(args({ plano: [{ ...ITEM, numero: "999" }, ITEM], executar: true, backup: async () => {} }));
  assert.deepEqual(r.resultados.map((x) => x.resultado), [RESULTADO.PARADA, RESULTADO.RECONCILIADA]);
  assert.equal((await notas(s)).filter((n) => n.estado === "ANEXADA").length, 1);
  assert.equal((await notas(s)).length, 1, "nenhuma nota criada nem apagada");
});

t("RC-6 CLI: dry-run por padrão; --executar exige backup e não sobrescreve backup existente; o backup é gravado antes", async () => {
  const { lerArgumentos, principal } = await import("../../scripts/mova/reconciliar-notas-antigas.mjs");
  const { mkdtempSync, writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  assert.throws(() => lerArgumentos([]), (e) => e.codigo === "SEM_PLANO");
  assert.throws(() => lerArgumentos(["--plano", "p.json", "--executar"]), (e) => e.codigo === "BACKUP_OBRIGATORIO");
  assert.throws(() => lerArgumentos(["--plano", "p.json", "--forcar"]), (e) => e.codigo === "ARGUMENTO_DESCONHECIDO");
  const dir = mkdtempSync(join(tmpdir(), "rc6-"));
  const planoArq = join(dir, "plano.json"), backupArq = join(dir, "backup.json");
  writeFileSync(planoArq, JSON.stringify([ITEM]));
  const { s, args } = await cenarioAntigo();
  const base = args();
  const adaptador = async () => ({ armazenamento: base.armazenamento, escopoDe: base.escopoDe, ler: base.ler, tomadorDe: base.tomadorDe });
  const saida = [];
  const seco = await principal({ argv: ["--plano", planoArq], adaptador, saida: (x) => saida.push(x) });
  assert.equal(seco.executou, false);
  assert.equal((await estado(s)).estado, "PENDENTE_ANEXO");
  assert.equal(existsSync(backupArq), false, "dry-run não grava backup");
  const real = await principal({ argv: ["--plano", planoArq, "--executar", "--backup", backupArq], adaptador, saida: (x) => saida.push(x) });
  assert.equal(real.resumo.reconciliadas, 1);
  assert.equal(JSON.parse(readFileSync(backupArq, "utf8")).linhas[0].estado, "PENDENTE_ANEXO", "backup com o estado anterior");
  assert.throws(() => lerArgumentos(["--plano", planoArq, "--executar", "--backup", backupArq]), (e) => e.codigo === "BACKUP_JA_EXISTE");
  assert.ok(!saida.join("\n").includes(PREST_MAURICIO), "saída sem documento completo");
});
