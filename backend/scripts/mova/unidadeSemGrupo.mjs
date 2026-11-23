// KIT — unidade atendida pelo MOVA SEM grupo (0014). GERA o SQL para o proprietário revisar e aplicar; não executa nada.
// Valida pelas MESMAS regras da montagem do MOVA (validarConfiguracao): fontes de faturamento coerentes (SWF não tem Anota AI
// pela SAIPOS; iFood/99Food só como plataforma oficial). Recusa (no próprio SQL) se a 0014 não estiver aplicada ou se a
// unidade já estiver num grupo ativo. Nasce DESLIGADA salvo --ativar.
//
// Uso:
//   node scripts/mova/unidadeSemGrupo.mjs --organizacao <uuid> --unidade <uuid> --nome "Subway Saci" --empresa "Subway Saci" \
//     --sistema SWF --plataformas IFOOD,NOVENTA_E_NOVE_FOOD --motivo "Cadastro e rotina dos entregadores (autorizado em …)" [--apelidos subway] [--documentos <CNPJ>] [--ativar]
//   --desativar --unidade <uuid> --motivo "…"   → SQL que só desliga (nada é apagado)
import { fileURLToPath } from "node:url";
import { validarConfiguracao } from "../../src/modules/mova-financeiro/dominio/configuracao.js";

const literal = (t) => `'${String(t).replace(/'/g, "''")}'`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVICO_FICTICIO = "00000000-0000-4000-8000-000000000000";

/** SQL de cadastro (upsert) da unidade sem grupo. Lança se a entrada não passa na validação do MOVA. */
export function sqlUnidadeSemGrupo({ organizacaoId, unidadeId, nome, empresa = null, apelidos = [], documentos = [], fontes, motivo, ativar = false }) {
  if (!UUID.test(organizacaoId ?? "") || !UUID.test(unidadeId ?? "")) throw new Error("IDs de empresa/unidade inválidos.");
  if (typeof motivo !== "string" || motivo.trim().length < 10 || motivo.length > 300) throw new Error("Informe o motivo (10 a 300 caracteres).");
  if (typeof nome !== "string" || !nome.trim() || nome.length > 80) throw new Error("Nome da unidade inválido.");
  const cfg = validarConfiguracao({ modo: "OPERACAO", identidadeServico: { usuarioId: SERVICO_FICTICIO }, gruposAutorizados: [],
    unidades: [{ organizacaoId, unidadeId, nome, empresa, apelidos, documentos, fontes, semGrupo: true }] });
  const u = cfg.unidades[0];
  const f = u.fontes.situacao === "CONFIRMADA"
    ? { situacao: u.fontes.situacao, sistemaDeLoja: u.fontes.sistemaDeLoja, plataformas: [...u.fontes.plataformas], anotaAiPelaSaipos: u.fontes.anotaAiPelaSaipos }
    : { situacao: "A_CONFIRMAR" };
  const [o, id] = [organizacaoId.toLowerCase(), unidadeId.toLowerCase()];
  const arr = (xs) => `array[${xs.map(literal).join(", ")}]::text[]`;
  return `-- MOVA — unidade SEM grupo: ${nome.trim()} (${id}). Revisar antes de aplicar. Nenhum grupo é criado.
begin;
do $$ begin
  if not exists (select 1 from mova.mova_migracao where nome = '0014_mova_unidade_sem_grupo.sql') then raise exception 'MOVA: a 0014 não foi aplicada — nada foi feito'; end if;
  if exists (select 1 from mova.grupo_unidade gu join mova.grupo_autorizado g using (grupo_jid) where g.ativo and gu.unidade_id = '${id}') then raise exception 'MOVA: a unidade já está num grupo ativo — nada foi feito'; end if;
end $$;
insert into mova.unidade_sem_grupo (unidade_id, organizacao_id, nome, empresa, apelidos, documentos, fontes, ativo, motivo)
values ('${id}', '${o}', ${literal(nome.trim())}, ${empresa ? literal(empresa) : "null"}, ${arr(apelidos)}, ${arr(u.documentos ?? [])}, ${literal(JSON.stringify(f))}::jsonb, ${ativar ? "true" : "false"}, ${literal(motivo.trim())})
on conflict (unidade_id) do update set organizacao_id = excluded.organizacao_id, nome = excluded.nome, empresa = excluded.empresa, apelidos = excluded.apelidos, documentos = excluded.documentos,
  fontes = excluded.fontes, ativo = excluded.ativo, motivo = excluded.motivo, atualizado_em = now()
  where mova.unidade_sem_grupo.organizacao_id = excluded.organizacao_id;
select unidade_id, nome, fontes, ativo from mova.unidade_sem_grupo where unidade_id = '${id}';
commit;
`;
}

/** SQL que só desliga a unidade sem grupo (nada é apagado). */
export function sqlDesativarUnidadeSemGrupo({ unidadeId, motivo }) {
  if (!UUID.test(unidadeId ?? "")) throw new Error("Unidade inválida.");
  if (typeof motivo !== "string" || motivo.trim().length < 10 || motivo.length > 300) throw new Error("Informe o motivo (10 a 300 caracteres).");
  return `update mova.unidade_sem_grupo set ativo = false, motivo = ${literal(motivo.trim())}, atualizado_em = now() where unidade_id = '${unidadeId.toLowerCase()}' returning unidade_id, ativo;\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2);
  const val = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  try {
    if (a.includes("--desativar")) process.stdout.write(sqlDesativarUnidadeSemGrupo({ unidadeId: val("--unidade"), motivo: val("--motivo") }));
    else {
      const sistema = val("--sistema");
      const fontes = sistema ? { situacao: "CONFIRMADA", sistemaDeLoja: sistema, plataformas: (val("--plataformas") ?? "").split(",").map((x) => x.trim()).filter(Boolean) } : { situacao: "A_CONFIRMAR" };
      process.stdout.write(sqlUnidadeSemGrupo({ organizacaoId: val("--organizacao"), unidadeId: val("--unidade"), nome: val("--nome"), empresa: val("--empresa") ?? null,
        apelidos: (val("--apelidos") ?? "").split(",").map((x) => x.trim()).filter(Boolean), documentos: (val("--documentos") ?? "").split(",").map((x) => x.replace(/\D/g, "")).filter(Boolean), fontes, motivo: val("--motivo"), ativar: a.includes("--ativar") }));
    }
  } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
}
