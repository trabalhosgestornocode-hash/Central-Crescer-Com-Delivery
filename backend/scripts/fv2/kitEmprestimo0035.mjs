// KIT — migração 0035 (`registrar_emprestimo`) em PRODUÇÃO. GERA os arquivos para revisar; NÃO executa nada.
//   node scripts/fv2/kitEmprestimo0035.mjs   → database/financeiro-v2/producao/emprestimo-0035/{01..05}*.sql
// Ordem (cada passo com autorização própria): 01 backup → 02 atualizar.sql (já gerado pelo pacoteProducao, base 0034) →
// 03 conferência → 04 concessão (Açaí e Subway) — e, se preciso, 05 reversão.
// A concessão MANTÉM exatamente as ações vigentes da identidade operacional (lidas em produção em 27/11, só leitura) e só acrescenta
// `registrar_emprestimo`. `prestar_sangria` continua FORA (sangrias suspensas).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sqlConcessaoOperacionalDoMova } from "./pacoteProducao.mjs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "../../..");
const SAIDA = path.join(RAIZ, "database/financeiro-v2/producao/emprestimo-0035");
const IDENTIDADE = "839a6da8-649d-4b6f-81c7-cb51c5c919cd"; // identidade operacional do MOVA em produção
const PROPRIETARIO = "63d66676-f042-4197-9b51-076f5145c1b9";
const VIGENTES = ["financeiro_v2.baixar_por_comprovante", "financeiro_v2.enviar_documento", "financeiro_v2.registrar_conta_parcelada", "financeiro_v2.registrar_intercompany",
  "financeiro_v2.registrar_juros", "financeiro_v2.registrar_obrigacao", "financeiro_v2.ver"]; // Açaí v4 e Subway v2 (27/11)
const UNIDADES = [
  { nome: "Açaí no Grau Saci", organizacaoId: "e7216085-1ece-45dc-bc41-d74f11a88e40", unidadeId: "4d3b75bd-79b5-4335-ae5b-a183580c3555", versao: 4 },
  { nome: "Subway Saci", organizacaoId: "00000000-0000-0000-0000-000000000001", unidadeId: "00000000-0000-0000-0000-0000000000a1", versao: 2 },
];
const DATA = "20261127";

const backup = `-- 01 — BACKUP antes da 0035 (só cópia; nada é alterado). Revisar antes de aplicar.
begin;
create schema if not exists backup_0035_${DATA};
create table backup_0035_${DATA}.concessao_fv2 as select * from financeiro_v2.fv2_concessao;
create table backup_0035_${DATA}.migracao_fv2 as select * from financeiro_v2.fv2_migracao;
create table backup_0035_${DATA}.objetos as
  select 'funcao' tipo, p.proname nome, pg_get_functiondef(p.oid) definicao from pg_proc p where p.pronamespace = 'financeiro_v2'::regnamespace and p.proname in ('fv2_obrigacao_documental')
  union all select 'restricao', c.conname, pg_get_constraintdef(c.oid) from pg_constraint c where c.conname = 'fv2_concessao_acoes_lista';
select (select count(*) from backup_0035_${DATA}.concessao_fv2) concessoes, (select count(*) from backup_0035_${DATA}.migracao_fv2) migracoes, (select count(*) from backup_0035_${DATA}.objetos) objetos;
commit;
`;

const conferencia = `-- 03 — CONFERÊNCIA depois da 0035 (somente leitura). Esperado: 35 migrações; a ação na lista; a função nova; NENHUMA concessão com a ação.
select (select count(*) from financeiro_v2.fv2_migracao) migracoes,
       (select bool_or(nome = '0035_registrar_emprestimo.sql') from financeiro_v2.fv2_migracao) tem_0035,
       (select pg_get_constraintdef(oid) like '%registrar_emprestimo%' from pg_constraint where conname = 'fv2_concessao_acoes_lista') acao_na_lista,
       (select count(*) from pg_proc where proname = 'fv2_principal_de_emprestimo') funcao_nova,
       (select count(*) from financeiro_v2.fv2_concessao where acoes ? 'financeiro_v2.registrar_emprestimo') concessoes_com_a_acao;
`;

const concessao = UNIDADES.map((u) => `-- ${u.nome}: versão vigente ${u.versao} + registrar_emprestimo\n${sqlConcessaoOperacionalDoMova({ identidade: IDENTIDADE, organizacaoId: u.organizacaoId, unidadeId: u.unidadeId,
  acoes: [...VIGENTES, "financeiro_v2.registrar_emprestimo"], concedidoPor: PROPRIETARIO, justificativa: "Empréstimos e financiamentos (principal) pelo MOVA com confirmação no WhatsApp — autorizado pelo proprietário" })}`).join("\n");

// Reversão: volta a concessão às ações vigentes (sem a nova), a função da 0033 e a lista de ações da 0034; recusa se sobrar concessão.
const m0033 = fs.readFileSync(path.join(RAIZ, "database/financeiro-v2/migracoes/0033_registrar_conta_parcelada.sql"), "utf8");
const funcao0033 = m0033.slice(m0033.indexOf("create or replace function fv2_obrigacao_documental()"), m0033.indexOf("end $$;", m0033.indexOf("create or replace function fv2_obrigacao_documental()")) + "end $$;".length);
const reverterConcessao = UNIDADES.map((u) => sqlConcessaoOperacionalDoMova({ identidade: IDENTIDADE, organizacaoId: u.organizacaoId, unidadeId: u.unidadeId, acoes: VIGENTES, concedidoPor: PROPRIETARIO,
  justificativa: "Reversão da 0035: concessão volta às ações anteriores" })).join("\n");
const reversao = `-- 05 — REVERSÃO da 0035 (só se necessário; revisar antes). Passo A: concessões voltam às ações anteriores. Passo B: banco volta à 0034.
-- ===================== A) concessões (mesmo kit oficial, sem registrar_emprestimo)
${reverterConcessao}
-- ===================== B) banco
begin;
set local search_path = financeiro_v2, pg_catalog, public;
do $$ begin
  if exists (select 1 from fv2_concessao where acoes ? 'financeiro_v2.registrar_emprestimo') then raise exception '0035: ainda há concessão com registrar_emprestimo — rode o passo A antes'; end if;
end $$;
${funcao0033}
drop function if exists fv2_principal_de_emprestimo(text, text);
alter table fv2_concessao drop constraint fv2_concessao_acoes_lista;
alter table fv2_concessao add constraint fv2_concessao_acoes_lista check (acoes <@ '["financeiro_v2.ver", "financeiro_v2.registrar", "financeiro_v2.corrigir", "financeiro_v2.cancelar", "financeiro_v2.conciliar", "financeiro_v2.fechar", "financeiro_v2.homologar", "financeiro_v2.revisar", "financeiro_v2.configurar", "financeiro_v2.importar", "financeiro_v2.conceder", "financeiro_v2.documentos", "financeiro_v2.aprovar", "financeiro_v2.aplicar", "financeiro_v2.revogar", "financeiro_v2.confirmar_importacao", "financeiro_v2.reabrir", "financeiro_v2.reclassificar", "financeiro_v2.enviar_documento", "financeiro_v2.vincular_pagamento", "financeiro_v2.baixar_por_comprovante", "financeiro_v2.registrar_obrigacao", "financeiro_v2.registrar_juros", "financeiro_v2.prestar_sangria", "financeiro_v2.registrar_conta_parcelada", "financeiro_v2.registrar_intercompany"]'::jsonb);
delete from fv2_migracao where nome = '0035_registrar_emprestimo.sql';
select count(*) migracoes from fv2_migracao;
commit;
`;

fs.mkdirSync(SAIDA, { recursive: true });
const arquivos = { "01-backup.sql": backup, "03-conferencia.sql": conferencia, "04-concessao.sql": concessao, "05-reversao.sql": reversao,
  "LEIA-ME.txt": `Ordem: 01-backup.sql → ../atualizar.sql (aplica SÓ a 0035; base 0034) → 03-conferencia.sql → 04-concessao.sql. Reversão: 05-reversao.sql.\nCada passo só com autorização própria. Gerado por backend/scripts/fv2/kitEmprestimo0035.mjs.\n` };
for (const [n, c] of Object.entries(arquivos)) fs.writeFileSync(path.join(SAIDA, n), c);
console.log(Object.keys(arquivos).map((n) => path.join("database/financeiro-v2/producao/emprestimo-0035", n)).join("\n"));
