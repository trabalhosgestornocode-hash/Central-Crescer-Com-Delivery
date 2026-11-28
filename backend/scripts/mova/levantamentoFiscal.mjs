// MOVA — LEVANTAMENTO FISCAL SÓ-LEITURA (28/11/2026). Lê as notas que o Financeiro já guarda + as recebidas pelo WhatsApp, constrói a
// identidade fiscal de cada entregador e SIMULA a reconciliação das notas antigas. NUNCA escreve: a sessão é aberta como somente-leitura
// e o script recusa qualquer SQL que não comece por SELECT. Saída no terminal: só contagens e documentos MASCARADOS; o relatório completo
// (com nomes) vai para o arquivo indicado em --saida (fora do repositório).
//   node scripts/mova/levantamentoFiscal.mjs --env <caminho do .env com DATABASE_URL> [--saida <arquivo.json>]
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { lerPdf } from "../../src/modules/financeiro-v2/importacao/formatos/pdf.js";
import { lerNotaDeServico } from "../../src/modules/financeiro-v2/dominio/notaFiscalServico.js";
import { aprenderTomadores, avaliarNota, compararPrestador, consolidarIdentidades, FONTE, mascararDocumento, normalizarLeitura, SITUACAO_IDENTIDADE } from "../../src/modules/mova-financeiro/dominio/identidadeFiscal.js";

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : null; };
const envPath = arg("env"), saida = arg("saida");
if (!envPath) { console.error("uso: --env <.env com DATABASE_URL> [--saida <arquivo.json>]"); process.exit(2); }
const url = /^DATABASE_URL=(.*)$/m.exec(readFileSync(envPath, "utf8"))?.[1]?.trim().replace(/^["']|["']$/g, "");
if (!url) { console.error("DATABASE_URL não encontrada"); process.exit(2); }

const pool = new pg.Pool({ connectionString: url, max: 1, ssl: { rejectUnauthorized: false } });
const c = await pool.connect();
const consultar = async (sql, p = []) => { if (!/^\s*(with|select)\b/i.test(sql)) throw new Error("RECUSADO: só SELECT"); return (await c.query(sql, p)).rows; };
await c.query("begin read only");
await c.query("set local statement_timeout = '60s'");

const fechamentos = await consultar(`select unidade_id, organizacao_id, entregador_chave, entregador_nome, semana_inicio::text, semana_fim::text, valor_centavos::bigint v, dados from financeiro_v2.fv2_fechamento_entregador`);
const notasMova = await consultar(`select n.unidade_id, n.organizacao_id, n.entregador, n.semana_inicio::text, n.sha256, n.estado, n.conferencia, n.leitura, e.conteudo from mova.nota_entregador n left join mova.evidencia e on e.sha256 = n.sha256`);
const docsFinanceiro = await consultar(`select unidade_id, hash_sha256, id from financeiro_v2.fv2_documento where hash_sha256 is not null`);
await c.query("rollback");
c.release(); await pool.end();

const hashesDoFinanceiro = new Map(docsFinanceiro.map((d) => [`${d.unidade_id}|${d.hash_sha256}`, d.id]));
const nomeDe = new Map(fechamentos.map((f) => [f.entregador_chave, f.entregador_nome]));
const obrigacaoDe = new Map(fechamentos.map((f) => [`${f.unidade_id}|${f.entregador_chave}|${f.semana_inicio}`, { valorCentavos: Number(f.v), semanaInicio: f.semana_inicio, semanaFim: f.semana_fim }]));

// 1) notas históricas do Financeiro (já ligadas a uma obrigação)
const historicas = [];
for (const f of fechamentos) for (const n of f.dados?.notas ?? []) {
  historicas.push({ organizacaoId: f.organizacao_id, unidadeId: f.unidade_id, entregador: f.entregador_chave, semanaInicio: f.semana_inicio, sha256: null, documentoId: n.documentoId ?? null,
    leitura: n.leitura ?? null, situacao: n.situacao, vigente: n.vigente !== false, obrigacao: { valorCentavos: Number(f.v), semanaInicio: f.semana_inicio, semanaFim: f.semana_fim } });
}
const tomadores = aprenderTomadores(historicas);
const mapaTomador = new Map([...tomadores].filter(([, t]) => t.documento).map(([u, t]) => [u, t.documento]));
const r = consolidarIdentidades(historicas, mapaTomador);

// 2) as notas do WhatsApp (MOVA): leitura determinística do PDF original; nada é gravado
const simulacao = [];
for (const n of notasMova) {
  const alvo = obrigacaoDe.get(`${n.unidade_id}|${n.entregador}|${n.semana_inicio}`) ?? null;
  let lida = null, fonte = null, erro = null;
  if (n.conteudo) { try { lida = lerNotaDeServico(lerPdf(new Uint8Array(n.conteudo)).paginas.flatMap((p) => p.linhas)); fonte = FONTE.PDF_TEXTO; } catch (e) { erro = String(e?.message ?? e).slice(0, 80); } }
  const identidade = r.identidades.get(n.entregador) ?? null;
  const leitura = normalizarLeitura(lida, fonte ?? FONTE.PDF_TEXTO);
  const av = alvo && leitura ? avaliarNota({ nota: { leitura: lida, situacao: "RECEBIDA", vigente: true }, obrigacao: alvo, tomadorDaUnidade: mapaTomador.get(n.unidade_id) ?? null }) : null;
  const prest = compararPrestador(identidade, leitura);
  const outraUnidade = [...tomadores].filter(([u, t]) => u !== n.unidade_id && t.documento && leitura?.tomadorDocumento === t.documento).map(([u]) => u);
  const docFin = hashesDoFinanceiro.get(`${n.unidade_id}|${n.sha256}`) ?? null; const jaNoFinanceiro = Boolean(docFin);
  const correta = Boolean(av && av.forca === "FORTE" && prest.resultado === "CONFERE" && !outraUnidade.length);
  const plano = correta ? (jaNoFinanceiro ? { acao: "RECONCILIAR_REGISTRO_DO_MOVA", novoEstado: "ANEXADA", novaConferencia: "CONFERE", documentoFinanceiro: docFin.slice(0, 8), alteraValores: false, apagaDocumento: false, reenviaNota: false } : { acao: "ANEXAR_AO_FINANCEIRO_NA_PROXIMA_PASSADA", alteraValores: false }) : { acao: "REVISAO_MANUAL", motivo: av?.motivos ?? ["SEM_LEITURA"] };
  simulacao.push({ unidadeId: n.unidade_id, entregador: n.entregador, nome: nomeDe.get(n.entregador) ?? null, semana: n.semana_inicio, sha8: n.sha256.slice(0, 8), estadoAtual: n.estado, conferenciaAtual: n.conferencia,
    leituraDeterministica: Boolean(lida), erroDeLeitura: erro, numero: leitura?.numero ?? null, valorCentavos: leitura?.valorCentavos ?? null, valorDaObrigacao: alvo?.valorCentavos ?? null,
    prestador: mascararDocumento(leitura?.prestadorDocumento), tomador: mascararDocumento(leitura?.tomadorDocumento), tomadorDaUnidade: mascararDocumento(mapaTomador.get(n.unidade_id)),
    tomadorPertenceAOutraUnidade: outraUnidade.length > 0, prestadorContraHistorico: prest, avaliacao: av ? { forca: av.forca, motivos: av.motivos } : null, jaAnexadaNoFinanceiro: jaNoFinanceiro, plano });
}

const ids = [...r.identidades.values()];
const resumo = {
  geradoEm: new Date().toISOString(), somenteLeitura: true,
  fechamentos: fechamentos.length, notasHistoricas: historicas.length, comLeituraEstruturada: historicas.filter((h) => h.leitura).length, semLeitura: historicas.filter((h) => !h.leitura).length,
  notasDoWhatsapp: notasMova.length, entregadoresComNota: ids.length,
  identidades: { consolidadas: ids.filter((i) => i.situacao === SITUACAO_IDENTIDADE.CONSOLIDADA).length, emRevisao: ids.filter((i) => i.situacao === SITUACAO_IDENTIDADE.EM_REVISAO).length, semHistorico: ids.filter((i) => i.situacao === SITUACAO_IDENTIDADE.SEM_HISTORICO).length },
  entregadoresSemNenhumaNota: [...new Set(fechamentos.map((f) => f.entregador_chave))].filter((k) => !r.identidades.has(k)).length,
  tomadoresAprendidos: Object.fromEntries([...tomadores].map(([u, t]) => [u.slice(-4), { documento: mascararDocumento(t.documento), situacao: t.situacao, notas: t.notas, entregadores: t.entregadores }])),
  divergenciasDeNotasFracas: ids.reduce((t, i) => t + i.divergencias.length, 0),
  fracasPorMotivo: Object.fromEntries(Object.entries(r.avaliacoes.filter((a) => a.avaliacao.forca === "FRACA").flatMap((a) => a.avaliacao.motivos).reduce((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {}))),
};
const detalhe = ids.map((i) => ({ ent: i.entregador.slice(0, 8), nome: (nomeDe.get(i.entregador) ?? "").split(" ")[0], situacao: i.situacao, motivo: i.motivo, prestador: mascararDocumento(i.documento ?? i.candidatos[0]), unidades: i.unidades.map((u) => u.slice(-4)), fortes: i.notasFortes, analisadas: i.notasAnalisadas, divergencias: i.divergencias.length }));
console.log(JSON.stringify({ resumo, identidades: detalhe, simulacaoDasNotasDoWhatsapp: simulacao.map((s) => ({ ...s, entregador: s.entregador.slice(0, 8), nome: (s.nome ?? "").split(" ")[0], unidadeId: s.unidadeId.slice(-4) })) }, null, 1));
if (saida) writeFileSync(saida, JSON.stringify({ resumo, identidades: ids.map((i) => ({ ...i, nome: nomeDe.get(i.entregador) })), simulacao }, null, 1));
