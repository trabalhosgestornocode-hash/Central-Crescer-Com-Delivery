// LEITOR DO FINANCEIRO PARA O MOVA (Execução 16A — piloto de consultas com dados reais).
//
// O MOVA lê o Financeiro v2 por uma credencial PRÓPRIA (papel de login membro de fv2_leitor_mova, migração 0028):
//   - sessão de banco SÓ pela função fv2_abrir_sessao_mova (identidade técnica fixa, concessão exatamente
//     ["financeiro_v2.ver"], sem escrita, 5 min) — nunca a autoridade de sessões da plataforma;
//   - antes de montar, `verificar()` confere NO BANCO que a credencial não escreve, não é administrativa e não emite
//     sessão de outra pessoa. Qualquer sinal de privilégio a mais ⇒ recusa (o MOVA não sobe).
// A IA nunca escreve SQL: as consultas são as operações de leitura do núcleo (lista fechada da porta financeira).
import { criarRepositorioPostgres } from "../financeiro-v2/index.js";

/** Identidade técnica do MOVA no Financeiro v2 (a mesma fixada na migração 0028). */
export const IDENTIDADE_MOVA = "00000000-0000-4000-8000-00000000a0a0";

const erro = (codigo, detalhes) => Object.assign(new Error(codigo), { codigo, ...(detalhes ? { detalhes } : {}) });

/** Confere que a conexão é de um leitor puro. Lança `LEITOR_NAO_E_SOMENTE_LEITURA` com o motivo (sem dados sensíveis). */
export async function verificarLeitorSomenteLeitura(pool) {
  const { rows: [r] } = await pool.query(`
    select pg_has_role(current_user, 'fv2_leitor_mova', 'USAGE') as leitor,
           (select rolsuper or rolbypassrls or rolcreaterole or rolcreatedb from pg_roles where rolname = current_user) as administrativo,
           pg_has_role(current_user, 'fv2_app', 'USAGE') or pg_has_role(current_user, 'fv2_autoridade', 'USAGE')
             or pg_has_role(current_user, 'fv2_guardiao', 'USAGE') as papel_do_modulo,
           (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'financeiro_v2' and c.relkind in ('r', 'p')
               and (has_table_privilege(current_user, c.oid, 'INSERT') or has_table_privilege(current_user, c.oid, 'UPDATE')
                 or has_table_privilege(current_user, c.oid, 'DELETE') or has_table_privilege(current_user, c.oid, 'TRUNCATE')))::int as tabelas_com_escrita,
           has_function_privilege(current_user, 'financeiro_v2.fv2_abrir_sessao(uuid, uuid, uuid, integer, text)', 'EXECUTE') as emite_sessao_alheia,
           has_function_privilege(current_user, 'financeiro_v2.fv2_gravar_concessao(jsonb, integer)', 'EXECUTE') as grava_concessao,
           has_function_privilege(current_user, 'financeiro_v2.fv2_abrir_sessao_mova(uuid, uuid)', 'EXECUTE') as abre_sessao_mova,
           'financeiro_v2' = any (current_schemas(false)) as caminho_ok`);
  const motivos = [];
  if (!r.leitor) motivos.push("NAO_E_LEITOR_DO_MOVA");
  if (r.administrativo) motivos.push("CREDENCIAL_ADMINISTRATIVA");
  if (r.papel_do_modulo) motivos.push("PAPEL_DA_APLICACAO_OU_AUTORIDADE");
  if (r.tabelas_com_escrita > 0) motivos.push("TABELAS_COM_ESCRITA");
  if (r.emite_sessao_alheia) motivos.push("EMITE_SESSAO_DE_OUTRA_PESSOA");
  if (r.grava_concessao) motivos.push("GRAVA_CONCESSAO");
  if (!r.abre_sessao_mova) motivos.push("SEM_SESSAO_DO_MOVA");
  if (!r.caminho_ok) motivos.push("SEARCH_PATH_SEM_FINANCEIRO_V2");
  if (motivos.length) throw erro("LEITOR_NAO_E_SOMENTE_LEITURA", { motivos });
  return { ok: true };
}

/**
 * Repositório do Financeiro v2 sobre a credencial de leitura do MOVA.
 * @param {{pool: import("pg").Pool}} p
 */
export function criarLeitorFinanceiroMova({ pool }) {
  if (!pool?.query) throw new TypeError("leitor do MOVA exige um pool");
  const sessoes = Object.freeze({
    async emitir(e) {
      // Só a identidade do MOVA; qualquer outra (pessoa, outra automação) é recusada ANTES de ir ao banco.
      if (e?.usuarioId !== IDENTIDADE_MOVA) throw erro("LEITOR_SO_DA_IDENTIDADE_MOVA");
      const { rows } = await pool.query("select financeiro_v2.fv2_abrir_sessao_mova($1::uuid, $2::uuid) as t", [e.organizacaoId, e.unidadeId]);
      return rows[0].t;
    },
  });
  return Object.freeze({ repositorio: criarRepositorioPostgres({ pool, sessoes }), verificar: () => verificarLeitorSomenteLeitura(pool) });
}
