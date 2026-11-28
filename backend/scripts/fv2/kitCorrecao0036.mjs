// KIT — migração 0036 (`corrigir_conta_a_pagar`) em PRODUÇÃO. GERA os arquivos para revisar; NÃO executa nada.
//   node scripts/fv2/kitCorrecao0036.mjs   → database/financeiro-v2/producao/correcao-0036/{00..05}*.sql
// Ordem (com autorização): 00 prévia (só leitura) → 01 backup verificado → 02 ../atualizar.sql (base 0035; confere nome+hash das 35
// instaladas; aplica SÓ a 0036) → 03 conferência → deploy do código → 04 concessão (Açaí e Subway) → 03 de novo.
// Reversão: 05 (A: tira SÓ `corrigir_conta_a_pagar` das concessões; B: banco volta exatamente à 0035).
// Mesmas proteções do kit da 0035: 04 só ACRESCENTA a ação e RECUSA se a concessão vigente mudou desde a revisão (versão, situação ou
// ações); 05-A só RETIRA a ação de quem a tem e está ATIVA (não reativa revogada, não devolve ação retirada depois). Sangria fora.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ACOES_OPERACIONAIS_DO_MOVA as ACOES_ATUAIS, atualizar } from "./pacoteProducao.mjs";

/** A lista estreita como era quando este kit foi EXECUTADO (28/11): o kit fica idêntico ao que rodou em produção. */
const ACOES_OPERACIONAIS_DO_MOVA = Object.freeze(ACOES_ATUAIS.filter((a) => !/^financeiro_v2\.(reclassificar|ajustar|mover_competencia|cancelar)_conta_a_pagar$/.test(a)));
/** A atualização de produção de 28/11 (base 0035, só a 0036) — a que foi aplicada; usada no ensaio deste kit. */
export const atualizarAte0036 = () => atualizar("0035", "0036");

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "../../..");
const SAIDA = path.join(RAIZ, "database/financeiro-v2/producao/correcao-0036");
const MIGRACOES = path.join(RAIZ, "database/financeiro-v2/migracoes");
export const ACAO_0036 = "financeiro_v2.corrigir_conta_a_pagar";
const ACAO = ACAO_0036;
const MIGRACAO = "0036_corrigir_conta_a_pagar.sql";
const POLITICAS = [["fv2_obrigacao", "fv2_obrigacao_alterar"], ["fv2_lancamento", "fv2_lancamento_alterar"], ["fv2_contraparte", "fv2_contraparte_incluir"], ["fv2_historico", "fv2_historico_incluir"]];
const FUNCOES_NOVAS = ["fv2_so_corrige_conta", "fv2_conta_corrigivel", "fv2_correcao_de_conta", "fv2_correcao_de_lancamento"];
const FUNCOES_ALTERADAS = ["fv2_vinculo_extrato_posicao", "fv2_exigir_acao_do_lancamento"];

// Produção (lida em 28/11, só leitura, depois da concessão da 0035): identidade operacional do MOVA, proprietário e concessões vigentes.
export const PRODUCAO = Object.freeze({
  identidade: "839a6da8-649d-4b6f-81c7-cb51c5c919cd",
  proprietario: "63d66676-f042-4197-9b51-076f5145c1b9",
  unidades: [
    { nome: "Açaí no Grau Saci", organizacaoId: "e7216085-1ece-45dc-bc41-d74f11a88e40", unidadeId: "4d3b75bd-79b5-4335-ae5b-a183580c3555", versao: 5 },
    { nome: "Subway Saci", organizacaoId: "00000000-0000-0000-0000-000000000001", unidadeId: "00000000-0000-0000-0000-0000000000a1", versao: 3 },
  ],
  vigentes: ["financeiro_v2.baixar_por_comprovante", "financeiro_v2.enviar_documento", "financeiro_v2.registrar_conta_parcelada", "financeiro_v2.registrar_emprestimo",
    "financeiro_v2.registrar_intercompany", "financeiro_v2.registrar_juros", "financeiro_v2.registrar_obrigacao", "financeiro_v2.ver"],
});

const uuid = (v) => { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v))) throw new Error(`UUID inválido: ${v}`); return String(v).toLowerCase(); };
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const jsonLit = (v) => `${lit(JSON.stringify(v))}::jsonb`;
const sha = (t) => createHash("sha256").update(t).digest("hex");
const lerMigracao = (n) => fs.readFileSync(path.join(MIGRACOES, n), "utf8").replace(/\r\n/g, "\n");

/** Hash da 0036 (o mesmo que o atualizar.sql grava) — conferido contra o arquivo. */
export function hashDa0036() {
  const arquivo = sha(fs.readFileSync(path.join(MIGRACOES, MIGRACAO)));
  // 28/11: a 0036 já está em produção e o atualizar.sql passou a ter base 0036; confere pela atualização LIMITADA (a que foi aplicada)
  const m = new RegExp(`values \\('${MIGRACAO.replace(/\./g, "\\.")}', '([0-9a-f]{64})'`).exec(atualizarAte0036());
  if (!m) throw new Error("a atualização 0035→0036 não aplica a 0036");
  if (m[1] !== arquivo) throw new Error("hash da 0036 no atualizar.sql difere do arquivo da migração");
  return arquivo;
}

/** Recorta `create [or replace] function NOME() ... end $$;` de uma migração (texto exato do Git). */
function recortarFuncao(arquivo, nome) {
  const m = lerMigracao(arquivo);
  const ini = m.search(new RegExp(`create (or replace )?function ${nome}\\(\\)`));
  if (ini < 0) throw new Error(`${nome} não encontrada em ${arquivo}`);
  return m.slice(ini, m.indexOf("end $$;", ini) + "end $$;".length).replace(/^create function/, "create or replace function");
}

/** Gera o kit (texto SQL). Parametrizado para o ensaio em banco isolado com identificadores sintéticos. */
export function gerarKit({ identidade, proprietario, unidades, vigentes, data = "20261128", hash0036 = hashDa0036() }) {
  const p = uuid(identidade); const autor = uuid(proprietario);
  const lista = [...new Set(vigentes)].sort();
  const fora = lista.filter((a) => !ACOES_OPERACIONAIS_DO_MOVA.includes(a) || a === ACAO);
  if (fora.length) throw new Error(`ações vigentes fora da lista estreita: ${fora.join(", ")}`);
  if (lista.includes("financeiro_v2.prestar_sangria")) throw new Error("prestar_sangria não entra (sangrias suspensas)");
  const nova = [...lista, ACAO].sort();
  const estreitas = jsonLit(ACOES_OPERACIONAIS_DO_MOVA);
  const us = unidades.map((u) => ({ ...u, organizacaoId: uuid(u.organizacaoId), unidadeId: uuid(u.unidadeId), versao: Number(u.versao) }));
  const B = `backup_0036_${data}`;
  const naUnidade = (u) => `organizacao_id = '${u.organizacaoId}' and unidade_id = '${u.unidadeId}' and usuario_id = '${p}'`;
  const pares = us.map((u) => `('${u.organizacaoId}'::uuid, '${u.unidadeId}'::uuid)`).join(", ");
  const politicasSql = POLITICAS.map(([t, n]) => `('${t}', '${n}')`).join(", ");

  const previa = `-- 00 — PRÉVIA em produção (SOMENTE LEITURA). Esperado: 35 migrações (o 02 confere nome+hash e recusa se não); a 0036 ausente;
-- nenhuma concessão com corrigir_conta_a_pagar; as concessões do MOVA exatamente nas versões/ações abaixo (o 04 recusa se mudarem).
select (select count(*) from financeiro_v2.fv2_migracao) migracoes,
       (select count(*) from financeiro_v2.fv2_migracao where nome = '${MIGRACAO}') tem_0036,
       (select count(*) from financeiro_v2.fv2_concessao where acoes ? '${ACAO}') concessoes_com_a_acao,
       (select count(*) from pg_proc where proname in (${FUNCOES_NOVAS.map(lit).join(", ")})) funcoes_novas_presentes;
select organizacao_id, unidade_id, versao, situacao, acoes,
       (acoes @> ${jsonLit(lista)} and ${jsonLit(lista)} @> acoes) acoes_conferem
  from financeiro_v2.fv2_concessao where usuario_id = '${p}' order by organizacao_id, unidade_id;
-- esperado: ${us.map((u) => `${u.nome} versão ${u.versao}`).join("; ")}; ações = ${lista.join(", ")}
`;

  const backup = `-- 01 — BACKUP VERIFICADO antes da 0036 (só cópia; nada é alterado). Rodar como o dono do banco. Recusa se a cópia não bater.
begin;
create schema ${B};
create table ${B}.concessao_fv2 as select * from financeiro_v2.fv2_concessao;
create table ${B}.migracao_fv2 as select * from financeiro_v2.fv2_migracao;
create table ${B}.objetos as
  select 'funcao' tipo, p.proname nome, pg_get_functiondef(p.oid) definicao from pg_proc p where p.pronamespace = 'financeiro_v2'::regnamespace and p.proname in (${FUNCOES_ALTERADAS.map(lit).join(", ")})
  union all select 'restricao', c.conname, pg_get_constraintdef(c.oid) from pg_constraint c where c.conname = 'fv2_concessao_acoes_lista'
  union all select 'politica', p.polname, jsonb_build_object('tabela', c.relname, 'using', pg_get_expr(p.polqual, p.polrelid), 'check', pg_get_expr(p.polwithcheck, p.polrelid))::text
    from pg_policy p join pg_class c on c.oid = p.polrelid where c.relnamespace = 'financeiro_v2'::regnamespace and (c.relname, p.polname) in (${politicasSql});
do $$ begin
  if (select md5(coalesce(string_agg(to_jsonb(c)::text, '|' order by c.id), '')) from financeiro_v2.fv2_concessao c)
     <> (select md5(coalesce(string_agg(to_jsonb(c)::text, '|' order by c.id), '')) from ${B}.concessao_fv2 c) then raise exception '0036 backup: cópia das concessões não confere'; end if;
  if (select md5(coalesce(string_agg(nome || ':' || sha256, '|' order by nome), '')) from financeiro_v2.fv2_migracao)
     <> (select md5(coalesce(string_agg(nome || ':' || sha256, '|' order by nome), '')) from ${B}.migracao_fv2) then raise exception '0036 backup: cópia das migrações não confere'; end if;
  if (select count(*) from ${B}.objetos) <> ${FUNCOES_ALTERADAS.length + 1 + POLITICAS.length} then raise exception '0036 backup: funções, restrição e políticas não copiadas'; end if;
end $$;
select (select count(*) from ${B}.concessao_fv2) concessoes, (select count(*) from ${B}.migracao_fv2) migracoes, (select count(*) from ${B}.objetos) objetos,
       (select md5(coalesce(string_agg(to_jsonb(c)::text, '|' order by c.id), '')) from ${B}.concessao_fv2 c) hash_concessoes;
commit;
`;

  const conferencia = `-- 03 — CONFERÊNCIA (somente leitura). Depois do 02: 36 migrações; a 0036 com o hash do Git (aplicado = arquivo); a ação na lista;
-- as 4 funções e os 2 gatilhos novos. Depois do 04: SÓ as ${us.length} concessões do MOVA (${us.map((u) => u.nome).join(", ")}) com a ação; nenhuma com sangria.
select (select count(*) from financeiro_v2.fv2_migracao) migracoes,
       (select bool_or(nome = '${MIGRACAO}') from financeiro_v2.fv2_migracao) tem_0036,
       (select bool_and(sha256 = '${hash0036}' and sha256_aplicado = '${hash0036}') from financeiro_v2.fv2_migracao where nome = '${MIGRACAO}') hash_confere,
       (select pg_get_constraintdef(oid) like '%corrigir_conta_a_pagar%' from pg_constraint where conname = 'fv2_concessao_acoes_lista') acao_na_lista,
       (select count(*) from pg_proc where proname in (${FUNCOES_NOVAS.map(lit).join(", ")})) funcoes_novas,
       (select count(*) from pg_trigger where tgname in ('fv2_obrigacao_correcao_estreita', 'fv2_lancamento_correcao_estreita')) gatilhos_novos,
       (select count(*) from financeiro_v2.fv2_concessao where acoes ? '${ACAO}') concessoes_com_a_acao,
       (select count(*) from financeiro_v2.fv2_concessao where acoes ? '${ACAO}' and not (usuario_id = '${p}' and (organizacao_id, unidade_id) in (${pares}))) fora_do_alcance,
       (select count(*) from financeiro_v2.fv2_concessao where usuario_id = '${p}' and acoes ? 'financeiro_v2.prestar_sangria') com_sangria;
`;

  const concessao = `-- 04 — CONCESSÃO de corrigir_conta_a_pagar à identidade operacional do MOVA em ${us.map((u) => u.nome).join(" e ")}. Revisar antes de aplicar.
-- ALTERAÇÃO PROTEGIDA: mantém exatamente as ações vigentes e só acrescenta a nova. RECUSA (nada é feito) se a 0036 não estiver aplicada,
-- se a identidade tiver ação ampla, ou se qualquer concessão mudou desde a revisão (versão, situação ou ações). Uma transação; histórico gravado.
begin;
set local search_path = financeiro_v2, pg_catalog, public;
do $$ declare c record; begin
  if not exists (select 1 from fv2_migracao where nome = '${MIGRACAO}' and sha256 = '${hash0036}') then raise exception '0036: migração não aplicada (ou hash diferente) — nada foi feito'; end if;
  if exists (select 1 from fv2_concessao x where x.usuario_id = '${p}' and exists (select 1 from jsonb_array_elements_text(x.acoes) a where not ${estreitas} ? a)) then
    raise exception '0036: a identidade operacional tem ação AMPLA — nada foi feito'; end if;
${us.map((u) => `  select * into c from fv2_concessao where ${naUnidade(u)} for update;
  if not found or c.situacao <> 'ATIVA' then raise exception '0036: concessão de ${u.nome} ausente ou não ATIVA — nada foi feito'; end if;
  if c.versao <> ${u.versao} or not (c.acoes @> ${jsonLit(lista)} and ${jsonLit(lista)} @> c.acoes) then
    raise exception '0036: a concessão de ${u.nome} mudou desde a revisão (versão %) — nada foi feito; gerar o kit de novo', c.versao; end if;`).join("\n")}
end $$;
with alvo as (select * from fv2_concessao where usuario_id = '${p}' and situacao = 'ATIVA' and not acoes ? '${ACAO}'
                and (organizacao_id, unidade_id) in (${pares}) for update),
alterada as (
  update fv2_concessao c set acoes = ${jsonLit(nova)}, versao = c.versao + 1, atualizado_em = now(), atualizado_por = '${autor}', concedido_por = '${autor}',
         justificativa = ${lit("Correção cadastral de contas a pagar pelo MOVA (fornecedor, vencimento, descrição, observação, forma), só com confirmação no WhatsApp — autorizado pelo proprietário")}
    from alvo where c.id = alvo.id
  returning c.*, alvo.acoes as acoes_antes, alvo.versao as versao_antes, alvo.situacao as situacao_antes)
insert into fv2_historico (id, organizacao_id, unidade_id, registro_tipo, registro_id, evento, antes, depois, justificativa, usuario_id, em)
select gen_random_uuid(), organizacao_id, unidade_id, 'CONCESSAO', id, 'ALTERACAO', jsonb_build_object('versao', versao_antes, 'acoes', acoes_antes, 'situacao', situacao_antes),
       jsonb_build_object('versao', versao, 'acoes', acoes, 'situacao', situacao), justificativa, concedido_por, now() from alterada;
do $$ begin
  if (select count(*) from fv2_concessao where acoes ? '${ACAO}') <> ${us.length} then raise exception '0036: a ação ficou fora das ${us.length} concessões previstas — nada foi feito'; end if;
end $$;
select organizacao_id, unidade_id, versao, situacao, acoes from fv2_concessao where usuario_id = '${p}' order by organizacao_id, unidade_id;
commit;
`;

  const reversao = `-- 05 — REVERSÃO da 0036 (só se necessário; revisar antes).
-- ===================== A) concessões: tira SÓ corrigir_conta_a_pagar de quem a tem e está ATIVA (identidade do MOVA). Não reativa
-- concessão revogada, não devolve ação retirada depois, não toca outra identidade nem outra ação. Rodar de novo não faz nada.
begin;
set local search_path = financeiro_v2, pg_catalog, public;
with alvo as (select * from fv2_concessao where usuario_id = '${p}' and situacao = 'ATIVA' and acoes ? '${ACAO}' for update),
alterada as (
  update fv2_concessao c set acoes = c.acoes - '${ACAO}', versao = c.versao + 1, atualizado_em = now(), atualizado_por = '${autor}',
         justificativa = ${lit("Reversão da 0036: retirada só de corrigir_conta_a_pagar")}
    from alvo where c.id = alvo.id
  returning c.*, alvo.acoes as acoes_antes, alvo.versao as versao_antes, alvo.situacao as situacao_antes)
insert into fv2_historico (id, organizacao_id, unidade_id, registro_tipo, registro_id, evento, antes, depois, justificativa, usuario_id, em)
select gen_random_uuid(), organizacao_id, unidade_id, 'CONCESSAO', id, 'ALTERACAO', jsonb_build_object('versao', versao_antes, 'acoes', acoes_antes, 'situacao', situacao_antes),
       jsonb_build_object('versao', versao, 'acoes', acoes, 'situacao', situacao), justificativa, '${autor}', now() from alterada;
select organizacao_id, unidade_id, versao, situacao, acoes from fv2_concessao where usuario_id = '${p}' order by organizacao_id, unidade_id;
commit;
-- ===================== B) banco: volta EXATAMENTE à 0035 (funções da 0031/0014 recortadas do Git; políticas sem o termo da 0036)
begin;
set local search_path = financeiro_v2, pg_catalog, public;
do $$ begin
  if exists (select 1 from fv2_concessao where acoes ? '${ACAO}') then raise exception '0036: ainda há concessão com corrigir_conta_a_pagar (outra identidade?) — revise; nada foi feito'; end if;
end $$;
drop trigger fv2_obrigacao_correcao_estreita on fv2_obrigacao;
drop trigger fv2_lancamento_correcao_estreita on fv2_lancamento;
drop function fv2_correcao_de_conta();
drop function fv2_correcao_de_lancamento();
drop function fv2_conta_corrigivel(uuid, uuid, uuid);
${recortarFuncao("0031_registrar_juros_no_pagamento.sql", "fv2_vinculo_extrato_posicao")}
${recortarFuncao("0014_reclassificacao.sql", "fv2_exigir_acao_do_lancamento")}
drop function fv2_so_corrige_conta();
do $$ declare r record; termo text := ' OR \\( SELECT (financeiro_v2\\.)?fv2_tem_acao\\(ARRAY\\[''${ACAO}''::text\\]\\) AS fv2_tem_acao\\)'; q text; w text; begin
  for r in select c.relname tabela, p.polname politica, pg_get_expr(p.polqual, p.polrelid) q, pg_get_expr(p.polwithcheck, p.polrelid) w
             from pg_policy p join pg_class c on c.oid = p.polrelid where c.relnamespace = 'financeiro_v2'::regnamespace and (c.relname, p.polname) in (${politicasSql}) loop
    q := regexp_replace(r.q, termo, '');
    w := regexp_replace(r.w, termo, '');
    if r.q is not null and q is distinct from r.q then execute format('alter policy %I on %I using (%s)', r.politica, r.tabela, q); end if;
    if r.w is not null and w is distinct from r.w then execute format('alter policy %I on %I with check (%s)', r.politica, r.tabela, w); end if;
  end loop;
end $$;
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ ${lit(JSON.stringify(LISTA_0035).replace(/,/g, ", "))}::jsonb);
delete from fv2_migracao where nome = '${MIGRACAO}';
do $$ begin
  if exists (select 1 from pg_policy p join pg_class c on c.oid = p.polrelid where c.relnamespace = 'financeiro_v2'::regnamespace
              and (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) like '%corrigir_conta_a_pagar%')
     or exists (select 1 from pg_proc where pronamespace = 'financeiro_v2'::regnamespace and prosrc like '%corrigir_conta_a_pagar%') then
    raise exception '0036 reversão: ainda há referência a corrigir_conta_a_pagar — nada foi feito';
  end if;
end $$;
select count(*) migracoes from fv2_migracao;
commit;
`;
  return { "00-previa.sql": previa, "01-backup.sql": backup, "03-conferencia.sql": conferencia, "04-concessao.sql": concessao, "05-reversao.sql": reversao,
    "LEIA-ME.txt": `Ordem: 00-previa.sql (só leitura) → 01-backup.sql (verificado) → ../atualizar.sql (aplica SÓ a 0036; confere nome+hash das 35) →
03-conferencia.sql (hash da 0036) → deploy → 04-concessao.sql → 03-conferencia.sql. Reversão: 05-reversao.sql (A depois B).
Cada passo só com autorização própria. 04 e 05-A são alterações PROTEGIDAS (ver o topo de cada arquivo). Hash da 0036: ${hash0036}.
Gerado por backend/scripts/fv2/kitCorrecao0036.mjs.\n` };
}

const LISTA_0035 = ["financeiro_v2.ver", "financeiro_v2.registrar", "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar",
  "financeiro_v2.homologar", "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos",
  "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir", "financeiro_v2.reclassificar",
  "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento", "financeiro_v2.baixar_por_comprovante", "financeiro_v2.registrar_obrigacao",
  "financeiro_v2.registrar_juros", "financeiro_v2.prestar_sangria", "financeiro_v2.registrar_conta_parcelada", "financeiro_v2.registrar_intercompany",
  "financeiro_v2.registrar_emprestimo"];

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arquivos = gerarKit(PRODUCAO);
  fs.mkdirSync(SAIDA, { recursive: true });
  for (const [n, c] of Object.entries(arquivos)) fs.writeFileSync(path.join(SAIDA, n), c);
  console.log(Object.keys(arquivos).map((n) => path.join("database/financeiro-v2/producao/correcao-0036", n)).join("\n"));
}
