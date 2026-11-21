// MOVA — Execução 15A: DESCARTE auditável das respostas PENDENTES antigas (antes de ligar o envio da Fase D).
// Padrão = PRÉVIA (só leitura). Altera estado SÓ com --executar=<código de confirmação impresso na prévia>, exige o banco de
// HOMOLOGAÇÃO marcado e usa a operação `saida.suprimir` (estado SUPRIMIDA + auditoria; nunca DELETE).
//
//   node --env-file=<.env.execucao da homologação> scripts/mova/suprimirRespostas.mjs \
//        --criadas-ate=2026-11-21T19:00:00Z --motivo=TESTES_ANTERIORES_FASE_D --ator=<quem autorizou> [--executar=<código>]
import { createHash } from "node:crypto";
import pg from "pg";
import { criarArmazenamentoPostgres } from "../../src/modules/mova-financeiro/index.js";
import { exigirBancoDeHomologacao } from "../../src/modules/fv2-integracao/mova.js";

const arg = (n) => (process.argv.find((x) => x.startsWith(`--${n}=`)) ?? "").slice(n.length + 3);
const criadasAte = arg("criadas-ate"), motivo = arg("motivo"), ator = arg("ator");
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(criadasAte) || !/^[A-Z0-9_]{3,40}$/.test(motivo) || !ator) {
  console.error("uso: --criadas-ate=AAAA-MM-DDTHH:MM:SSZ --motivo=CODIGO --ator=<quem> [--executar=<código>]"); process.exit(1);
}
if (process.env.MOVA_MODO !== "HOMOLOGACAO" || !process.env.MOVA_HOMOLOGACAO_MARCADOR) { console.error("RECUSADO: não é o ambiente de homologação."); process.exit(1); }
const ca = process.env.MOVA_PG_CA ?? process.env.FV2_PG_CA ?? null;
const pool = new pg.Pool({ connectionString: process.env.MOVA_DATABASE_URL, max: 1, ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true } });
await exigirBancoDeHomologacao(pool, process.env.MOVA_HOMOLOGACAO_MARCADOR);

// Prévia: por destino (mascarado) e origem, sem texto.
const { rows } = await pool.query(`
  select regexp_replace(grupo_jid, '^(\\d{4})\\d+(\\d{4})', '\\1****\\2') as destino, count(*)::int as n, min(criada_em) as de, max(criada_em) as ate,
         string_agg(id::text, ',' order by seq) as ids
    from mova.resposta where estado = 'PENDENTE' and criada_em <= $1::timestamptz group by 1 order by 1`, [criadasAte]);
const total = rows.reduce((s, r) => s + r.n, 0);
const codigo = createHash("sha256").update(rows.map((r) => r.ids).join("|") + motivo + criadasAte).digest("hex").slice(0, 8);
for (const r of rows) console.log(`destino ${r.destino}: ${r.n} resposta(s), ${r.de.toISOString()} → ${r.ate.toISOString()}`);
console.log(`TOTAL a suprimir: ${total} | motivo ${motivo} | ator ${ator} | código de confirmação: ${codigo}`);

if (arg("executar")) {
  if (arg("executar") !== codigo) { console.error("RECUSADO: código de confirmação não confere (a lista mudou ou o código está errado)."); process.exit(1); }
  const r = await criarArmazenamentoPostgres({ pool }).saida.suprimir({ criadasAte, motivo, ator });
  console.log(`SUPRIMIDAS: ${r.suprimidas} (auditoria RESPOSTAS_SUPRIMIDAS registrada)`);
} else console.log("PRÉVIA: nada foi alterado. Para executar, repita com --executar=<código> após a aprovação.");
await pool.end();
