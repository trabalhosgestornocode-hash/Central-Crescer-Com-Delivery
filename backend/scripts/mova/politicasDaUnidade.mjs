// KIT — POLÍTICAS DE AUTONOMIA de UMA unidade (por operação). GERA o SQL para o proprietário revisar e aplicar; não executa nada.
// Cada operação precisa de NÍVEL e LIMITE explícitos (em centavos): não existe padrão nem limite "ilimitado". Validado pelas MESMAS
// regras do MOVA (dominio/autonomia.js). Trocar = revogar a política vigente da mesma operação e criar a nova (o histórico fica).
// Juros/multa: o limite da política é o ENCARGO máximo por pagamento; o teto de 10% da conta continua no banco (FV2 0031).
//
// Uso (valores ilustrativos; os reais são decididos pelo proprietário):
//   node scripts/mova/politicasDaUnidade.mjs --organizacao <uuid> --unidade <uuid> --criada-por <uuid> --responsavel "Nome" \
//     --vigente-de 2026-11-24 --motivo "Política aprovada pelo proprietário em …" \
//     --politica CONTA_A_PAGAR:APLICAR_AUTOMATICO:2000000 --politica DESPESA_DOCUMENTAL:APLICAR_AUTOMATICO:300000 \
//     --politica BAIXA_DOCUMENTAL:APLICAR_AUTOMATICO:2000000 --politica ANEXAR_DOCUMENTO:APLICAR_AUTOMATICO:2000000 \
//     --politica JUROS_DOCUMENTAL:APLICAR_AUTOMATICO:5000 [--vigente-ate AAAA-MM-DD]
import { fileURLToPath } from "node:url";
import { OPERACAO, validarPoliticas } from "../../src/modules/mova-financeiro/dominio/autonomia.js";

const literal = (t) => `'${String(t).replace(/'/g, "''")}'`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Operações que dependem de uma migração do MOVA (precondição do SQL). */
const MIGRACAO = { DESPESA_DOCUMENTAL: "0010_mova_despesa_documental.sql", JUROS_DOCUMENTAL: "0012_mova_juros_documental.sql" };

/**
 * @param {{organizacaoId:string, unidadeId:string, criadaPor:string, responsavel:string, motivo:string, vigenteDe:string, vigenteAte?:string|null,
 *          politicas:{operacao:string, nivel:string, limiteCentavos:number}[]}} p
 */
export function sqlPoliticasDaUnidade({ organizacaoId, unidadeId, criadaPor, responsavel, motivo, vigenteDe, vigenteAte = null, politicas }) {
  if (![organizacaoId, unidadeId, criadaPor].every((x) => UUID.test(x ?? ""))) throw new Error("Empresa, unidade e autor precisam ser UUID.");
  if (!Array.isArray(politicas) || !politicas.length) throw new Error("Informe ao menos uma política (--politica OPERACAO:NIVEL:LIMITE_CENTAVOS).");
  const ops = politicas.map((x) => x.operacao);
  if (new Set(ops).size !== ops.length) throw new Error("Operação repetida.");
  for (const x of politicas) if (!Number.isSafeInteger(x.limiteCentavos) || x.limiteCentavos <= 0) throw new Error(`Limite explícito e positivo obrigatório para ${x.operacao} (não há limite ilimitado).`);
  const [o, u] = [organizacaoId.toLowerCase(), unidadeId.toLowerCase()];
  // Validação pelas regras do MOVA (operação conhecida, nível, responsável, motivo, vigência, sem sobreposição).
  const validas = validarPoliticas(politicas.map((x) => ({ operacao: x.operacao, organizacaoId: o, unidadeId: u, nivel: x.nivel, limiteCentavos: x.limiteCentavos,
    responsavel, motivo, vigenteDe, vigenteAte })));
  const precisa = new Set(validas.map((x) => MIGRACAO[x.operacao]).filter(Boolean));
  if (validas.some((x) => x.operacao === OPERACAO.CONTA_A_PAGAR && x.nivel === "APLICAR_AUTOMATICO")) precisa.add("0015_mova_pagadores_multiunidade.sql");
  const linhas = validas.map((x) => `-- ${x.operacao}: ${x.nivel}, limite ${x.limiteCentavos} centavos
update mova.politica_autonomia set revogada_em = now(), revogada_por = '${criadaPor.toLowerCase()}'
 where operacao = '${x.operacao}' and organizacao_id = '${o}' and unidade_id = '${u}' and revogada_em is null;
insert into mova.politica_autonomia (operacao, organizacao_id, unidade_id, nivel, limite_centavos, responsavel, motivo, vigente_de, vigente_ate, criada_por)
values ('${x.operacao}', '${o}', '${u}', '${x.nivel}', ${x.limiteCentavos}, ${literal(x.responsavel)}, ${literal(x.motivo)}, '${x.vigenteDe}', ${x.vigenteAte ? `'${x.vigenteAte}'` : "null"}, '${criadaPor.toLowerCase()}');`).join("\n");
  return `-- MOVA — POLÍTICAS DE AUTONOMIA da unidade ${u} (empresa ${o}). Revisar antes de aplicar. Vale na próxima operação.
begin;
do $$ begin
${[...precisa].map((m) => `  if not exists (select 1 from mova.mova_migracao where nome = '${m}') then raise exception 'MOVA: a migração ${m} não foi aplicada — nada foi feito'; end if;`).join("\n")}
  if not exists (select 1 from mova.grupo_unidade where unidade_id = '${u}' and organizacao_id = '${o}') and not exists (select 1 from mova.unidade_sem_grupo where unidade_id = '${u}' and organizacao_id = '${o}')
    then raise exception 'MOVA: unidade/empresa não cadastrada no MOVA — nada foi feito'; end if;
end $$;
${linhas}
insert into mova.auditoria (acao, ator_tipo, ator_ref, alvo, dados) values ('POLITICAS_DA_UNIDADE', 'USUARIO', '${criadaPor.toLowerCase()}', '${u}',
  ${literal(JSON.stringify({ politicas: validas.map((x) => ({ operacao: x.operacao, nivel: x.nivel, limiteCentavos: x.limiteCentavos })), vigenteDe, vigenteAte }))}::jsonb);
select operacao, nivel, limite_centavos, vigente_de, vigente_ate from mova.politica_autonomia where organizacao_id = '${o}' and unidade_id = '${u}' and revogada_em is null order by operacao;
commit;
`;
}

/** Desliga TODA a autonomia da unidade (revoga as políticas vigentes): o MOVA volta a só propor na hora. */
export function sqlRevogarPoliticasDaUnidade({ organizacaoId, unidadeId, revogadaPor }) {
  if (![organizacaoId, unidadeId, revogadaPor].every((x) => UUID.test(x ?? ""))) throw new Error("Empresa, unidade e autor precisam ser UUID.");
  const [o, u, a] = [organizacaoId.toLowerCase(), unidadeId.toLowerCase(), revogadaPor.toLowerCase()];
  return `begin;
update mova.politica_autonomia set revogada_em = now(), revogada_por = '${a}' where organizacao_id = '${o}' and unidade_id = '${u}' and revogada_em is null;
insert into mova.auditoria (acao, ator_tipo, ator_ref, alvo, dados) values ('POLITICAS_REVOGADAS', 'USUARIO', '${a}', '${u}', '{}'::jsonb);
commit;
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2);
  const todos = (k) => a.flatMap((x, i) => (x === k ? [a[i + 1]] : []));
  const um = (k) => todos(k)[0];
  try {
    if (a.includes("--revogar-todas")) process.stdout.write(sqlRevogarPoliticasDaUnidade({ organizacaoId: um("--organizacao"), unidadeId: um("--unidade"), revogadaPor: um("--criada-por") }));
    else process.stdout.write(sqlPoliticasDaUnidade({
      organizacaoId: um("--organizacao"), unidadeId: um("--unidade"), criadaPor: um("--criada-por"), responsavel: um("--responsavel"), motivo: um("--motivo"),
      vigenteDe: um("--vigente-de"), vigenteAte: um("--vigente-ate") ?? null,
      politicas: todos("--politica").map((t) => { const [operacao, nivel, limite] = String(t).split(":"); return { operacao, nivel, limiteCentavos: Number(limite) }; }),
    }));
  } catch (e) { process.stderr.write(`ERRO: ${e.message}\n`); process.exit(1); }
}
