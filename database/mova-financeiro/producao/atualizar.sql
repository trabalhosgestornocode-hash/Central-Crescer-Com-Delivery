-- MOVA — ATUALIZAÇÃO do schema `mova` em PRODUÇÃO (gerado por backend/scripts/mova/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como `postgres` numa ÚNICA transação, só com autorização específica. Qualquer falha desfaz tudo.
-- Já instaladas (conferidas por nome e sha256): 0001_mova_fundacao.sql, 0002_mova_operacao.sql, 0003_mova_homologacao_privada.sql, 0004_mova_controle_orcamento.sql, 0005_mova_grupos_reais.sql, 0006_mova_politica_resposta.sql, 0007_mova_autonomia_operacoes.sql, 0008_mova_entregadores_automacoes.sql
-- Novas: 0009_mova_baixa_documental.sql

do $$ begin
  if not exists (select 1 from pg_namespace where nspname = 'mova') then raise exception 'MOVA atualização: schema mova não existe — nada foi feito'; end if;
  if coalesce((select shobj_description(d.oid, 'pg_database') from pg_database d where d.datname = current_database()), '') like 'MOVA\_HOMOLOGACAO:%' then
    raise exception 'MOVA atualização: banco de HOMOLOGAÇÃO — nada foi feito';
  end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0001_mova_fundacao.sql' and sha256 = '1d4c349167cd023012a2878421a69785b2eeb7da56c6f08d10615e4e3d9180d8') then raise exception 'MOVA atualização: 0001_mova_fundacao.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0002_mova_operacao.sql' and sha256 = '5cdb1d34ae6435ea44d5bc8c36b93e9cf91ebb56e5d62396546f02ed0f5c1e0f') then raise exception 'MOVA atualização: 0002_mova_operacao.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0003_mova_homologacao_privada.sql' and sha256 = '9b090ae2228c673e7fcae0b4dd976e78641d1e580b1cbb6b64c72876d3697ed3') then raise exception 'MOVA atualização: 0003_mova_homologacao_privada.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0004_mova_controle_orcamento.sql' and sha256 = 'd8e3065c8d6603b5707b4b6399c014cfdd665cf13e77f6876fedbc1c135c0c00') then raise exception 'MOVA atualização: 0004_mova_controle_orcamento.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0005_mova_grupos_reais.sql' and sha256 = '2f16af94be7e7c0914fb2550465c6629470257b8aba1580c992e980dbc80a47d') then raise exception 'MOVA atualização: 0005_mova_grupos_reais.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0006_mova_politica_resposta.sql' and sha256 = '1ecdc2f473854479b10487eddb1d1d842683ff3d0cf63d486764a46818261113') then raise exception 'MOVA atualização: 0006_mova_politica_resposta.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0007_mova_autonomia_operacoes.sql' and sha256 = 'cb13d733182446a34947d1b781430af21f654d5bb0f62309aa3a568ae8f1979d') then raise exception 'MOVA atualização: 0007_mova_autonomia_operacoes.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0008_mova_entregadores_automacoes.sql' and sha256 = 'e66e9c662dbfd1c7ddd60092ff5cab082fa7dc230ca08da2524b46821feb6182') then raise exception 'MOVA atualização: 0008_mova_entregadores_automacoes.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if exists (select 1 from mova.mova_migracao where nome = '0009_mova_baixa_documental.sql') then raise exception 'MOVA atualização: 0009_mova_baixa_documental.sql já aplicada — nada foi feito'; end if;
end $$;

-- ------------------------------------------------------------------------- 0009_mova_baixa_documental.sql (arquivo b690cafc5aedd8e5bc553ca886690de5d6e61bc88b0f3c95881a725b9a3f2754)
-- MOVA — Agente 2 (Execução 17): operação BAIXA_DOCUMENTAL (pagamento registrado POR COMPROVANTE, conciliação pendente).
--
-- Só amplia a lista fechada de operações das políticas e das execuções. Nenhuma política é semeada: sem política cadastrada
-- o MOVA só PROPÕE. A escrita real continua exigindo política explícita + identidade operacional com concessão no Financeiro.
alter table mova.politica_autonomia drop constraint politica_autonomia_operacao_check;
alter table mova.politica_autonomia add constraint politica_autonomia_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL'));
alter table mova.operacao_executada drop constraint operacao_executada_operacao_check;
alter table mova.operacao_executada add constraint operacao_executada_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL'));
insert into mova.mova_migracao (nome, sha256) values ('0009_mova_baixa_documental.sql', 'b690cafc5aedd8e5bc553ca886690de5d6e61bc88b0f3c95881a725b9a3f2754');
