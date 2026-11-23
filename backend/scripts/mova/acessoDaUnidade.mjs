// KIT — PAGADORES e ACESSO de uma unidade do MOVA (0015). GERA o SQL para o proprietário revisar e aplicar; não executa nada.
// Valida pelas MESMAS regras da montagem (validarConfiguracao + dominio/pagador.js). Grava na linha da unidade:
//   - mova.grupo_unidade (unidade com grupo, ex.: Açaí): só `pagadores`;
//   - mova.unidade_sem_grupo (ex.: Subway): `pagadores`, `participantes` (quem pode enviar documentos no privado) e
//     `acesso_multiempresa` (juntar esta unidade, de outra EMPRESA, na mesma conversa privada da pessoa).
// Cada SQL registra a mudança em mova.auditoria (acao CADASTRO_ACESSO_UNIDADE, com o motivo). Recusa se a 0015 não estiver
// aplicada ou se a unidade não estiver cadastrada no MOVA.
//
// Uso:
//   node scripts/mova/acessoDaUnidade.mjs --unidade <uuid> --pagador "<titular>" [--pagador "..."] [--documento-pagador <cnpj>] \
//     --motivo "Titular da conta pagadora do Açaí confirmado pelo proprietário em …"
//   node scripts/mova/acessoDaUnidade.mjs --unidade <uuid> --sem-grupo --pagador "MP" \
//     --participante '{"ids":["55869...@s.whatsapp.net"],"perfil":"FINANCEIRO","privado":"55869...@s.whatsapp.net","nome":"..."}' \
//     [--multiempresa] --motivo "…"
import { fileURLToPath } from "node:url";
import { validarConfiguracao } from "../../src/modules/mova-financeiro/dominio/configuracao.js";

const literal = (t) => `'${String(t).replace(/'/g, "''")}'`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FICTICIO = "00000000-0000-4000-8000-000000000000";

/**
 * @param {{unidadeId:string, semGrupo?:boolean, pagadores?:{nome?:string, documento?:string}[], participantes?:object[], multiempresa?:boolean, motivo:string}} p
 * @returns {string} SQL (uma transação)
 */
export function sqlAcessoDaUnidade({ unidadeId, semGrupo = false, pagadores = [], participantes = [], multiempresa = false, motivo }) {
  if (!UUID.test(unidadeId ?? "")) throw new Error("ID da unidade inválido.");
  if (typeof motivo !== "string" || motivo.trim().length < 10 || motivo.length > 300) throw new Error("Informe o motivo (10 a 300 caracteres).");
  if (!semGrupo && (participantes.length || multiempresa)) throw new Error("Participantes e acesso multiempresa só na unidade SEM grupo (a do grupo usa a lista do grupo).");
  const id = unidadeId.toLowerCase();
  // Validação pelas regras da montagem (lança com o campo, nunca com o valor).
  validarConfiguracao({ modo: "OPERACAO", identidadeServico: { usuarioId: FICTICIO }, gruposAutorizados: [],
    unidades: [{ organizacaoId: FICTICIO, unidadeId: id, nome: "Unidade", semGrupo: true, fontes: { situacao: "A_CONFIRMAR" }, pagadores,
      ...(participantes.length ? { participantes } : {}), acessoMultiempresa: multiempresa }] });
  const json = (v) => `${literal(JSON.stringify(v))}::jsonb`;
  const auditoria = `insert into mova.auditoria (acao, ator_tipo, ator_ref, alvo, dados) values ('CADASTRO_ACESSO_UNIDADE', 'USUARIO', 'proprietario', '${id}',
  jsonb_build_object('pagadores', ${pagadores.length}, 'participantes', ${participantes.length}, 'multiempresa', ${multiempresa}, 'motivo', ${literal(motivo.trim())}));`;
  const pre = `do $$ begin
  if not exists (select 1 from mova.mova_migracao where nome = '0015_mova_pagadores_multiunidade.sql') then raise exception 'MOVA: a 0015 não foi aplicada — nada foi feito'; end if;
  if not exists (select 1 from mova.${semGrupo ? "unidade_sem_grupo" : "grupo_unidade"} where unidade_id = '${id}') then raise exception 'MOVA: unidade não cadastrada ${semGrupo ? "sem grupo" : "em grupo"} — nada foi feito'; end if;
end $$;`;
  const upd = semGrupo
    ? `update mova.unidade_sem_grupo set pagadores = ${json(pagadores)}, participantes = ${json(participantes)}, acesso_multiempresa = ${multiempresa}, motivo = ${literal(motivo.trim())}, atualizado_em = now() where unidade_id = '${id}';`
    : `update mova.grupo_unidade set pagadores = ${json(pagadores)} where unidade_id = '${id}';`;
  return `-- MOVA — acesso da unidade ${id}${semGrupo ? " (sem grupo)" : ""}. Revisar antes de aplicar. Vale no próximo reinício do MOVA.\nbegin;\n${pre}\n${upd}\n${auditoria}\ncommit;\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2);
  const todos = (k) => a.flatMap((x, i) => (x === k ? [a[i + 1]] : []));
  const um = (k) => todos(k)[0];
  try {
    process.stdout.write(sqlAcessoDaUnidade({
      unidadeId: um("--unidade"), semGrupo: a.includes("--sem-grupo"), multiempresa: a.includes("--multiempresa"), motivo: um("--motivo"),
      pagadores: [...todos("--pagador").map((nome) => ({ nome })), ...todos("--documento-pagador").map((documento) => ({ documento }))],
      participantes: todos("--participante").map((j) => JSON.parse(j)),
    }));
  } catch (e) { process.stderr.write(`ERRO: ${e.message}\n`); process.exit(1); }
}
