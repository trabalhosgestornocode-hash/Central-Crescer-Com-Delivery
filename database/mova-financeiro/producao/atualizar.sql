-- MOVA — ATUALIZAÇÃO do schema `mova` em PRODUÇÃO (gerado por backend/scripts/mova/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como `postgres` numa ÚNICA transação, só com autorização específica. Qualquer falha desfaz tudo.
-- Já instaladas (conferidas por nome e sha256): 0001_mova_fundacao.sql, 0002_mova_operacao.sql, 0003_mova_homologacao_privada.sql, 0004_mova_controle_orcamento.sql, 0005_mova_grupos_reais.sql, 0006_mova_politica_resposta.sql, 0007_mova_autonomia_operacoes.sql, 0008_mova_entregadores_automacoes.sql, 0009_mova_baixa_documental.sql
-- Novas: 0010_mova_despesa_documental.sql, 0011_mova_entregadores_rotina.sql, 0012_mova_juros_documental.sql

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
  if not exists (select 1 from mova.mova_migracao where nome = '0009_mova_baixa_documental.sql' and sha256 = 'b690cafc5aedd8e5bc553ca886690de5d6e61bc88b0f3c95881a725b9a3f2754') then raise exception 'MOVA atualização: 0009_mova_baixa_documental.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if exists (select 1 from mova.mova_migracao where nome = '0010_mova_despesa_documental.sql') then raise exception 'MOVA atualização: 0010_mova_despesa_documental.sql já aplicada — nada foi feito'; end if;
  if exists (select 1 from mova.mova_migracao where nome = '0011_mova_entregadores_rotina.sql') then raise exception 'MOVA atualização: 0011_mova_entregadores_rotina.sql já aplicada — nada foi feito'; end if;
  if exists (select 1 from mova.mova_migracao where nome = '0012_mova_juros_documental.sql') then raise exception 'MOVA atualização: 0012_mova_juros_documental.sql já aplicada — nada foi feito'; end if;
end $$;

-- ------------------------------------------------------------------------- 0010_mova_despesa_documental.sql (arquivo f3aab5fe0574e86779b873e263551ebb8577049e3c0d3f3b58e753b8f731673c)
-- MOVA — Agente 2 (23/11/2026): operação DESPESA_DOCUMENTAL (despesa sem conta prévia, paga por COMPROVANTE: registra a conta
-- a pagar pela ação estreita `registrar_obrigacao` do Financeiro e o pagamento por comprovante; conciliação pendente).
--
-- Só amplia a lista fechada de operações das políticas e das execuções. Nenhuma política é semeada: sem política cadastrada
-- o MOVA só PROPÕE (a pessoa aprova na Central).
alter table mova.politica_autonomia drop constraint politica_autonomia_operacao_check;
alter table mova.politica_autonomia add constraint politica_autonomia_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL','DESPESA_DOCUMENTAL'));
alter table mova.operacao_executada drop constraint operacao_executada_operacao_check;
alter table mova.operacao_executada add constraint operacao_executada_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL','DESPESA_DOCUMENTAL'));
insert into mova.mova_migracao (nome, sha256) values ('0010_mova_despesa_documental.sql', 'f3aab5fe0574e86779b873e263551ebb8577049e3c0d3f3b58e753b8f731673c');

-- ------------------------------------------------------------------------- 0011_mova_entregadores_rotina.sql (arquivo ff74849e1f40ea2f799ee3c8a5a5be8562bfebf9ecdbde59d6c9e24c3d2ee0ca)
-- MOVA — Agente 2 (23/11/2026): ROTINA SEMANAL DOS ENTREGADORES — cadastro simples pelo gestor, leitura da nota fiscal,
-- aviso de liberação no grupo da unidade e relatório de quarta-feira. Nada é apagado; nenhum entregador é semeado.
--
--   * cadastro: o gestor informa o entregador OFICIAL (chave do fechamento do Financeiro) e o número; o backend confere a chave no
--     Financeiro antes de gravar. O papel da aplicação ganha INSERT e UPDATE só das colunas de revogação/verificação.
--   * nota: o resultado da leitura e da conferência (emitente, tomador, valor, período) fica na própria linha da nota.
--   * envios: tipos novos (aviso de liberação no grupo, relatório de quarta); a chave única continua impedindo repetição.
--   * automações: RELATÓRIO (quarta) e AVISO no grupo, com a mesma pausa individual por unidade.

-- Empresa exibida nas mensagens (nome da organização); opcional.
alter table mova.grupo_unidade add column empresa text check (empresa is null or length(btrim(empresa)) between 1 and 120);

alter table mova.entregador_autorizado add column cadastrado_por uuid, add column verificado_em timestamptz;
grant insert (organizacao_id, unidade_id, chave, telefone_e164, privado, ids, nome, cadastrado_por, verificado_em) on mova.entregador_autorizado to mova_app;
grant update (ativo, revogado_em, verificado_em) on mova.entregador_autorizado to mova_app;

alter table mova.nota_entregador add column leitura jsonb, add column conferencia text check (conferencia is null or conferencia in ('CONFERE', 'DIVERGENTE', 'INCONCLUSIVA'));
grant update (leitura, conferencia) on mova.nota_entregador to mova_app;

alter table mova.entregador_envio drop constraint entregador_envio_tipo_check;
alter table mova.entregador_envio add constraint entregador_envio_tipo_check check (tipo in ('SEMANAL', 'COBRANCA_NOTA', 'NOTA_RECEBIDA', 'AVISO_LIBERACAO', 'RELATORIO_QUARTA'));

alter table mova.automacao drop constraint automacao_nome_check;
alter table mova.automacao add constraint automacao_nome_check check (nome in ('ENTREGADORES_SEMANAL', 'ENTREGADORES_COBRANCA', 'RECONFERENCIA_EXTRATO', 'ENTREGADORES_RELATORIO', 'ENTREGADORES_AVISO_GRUPO'));
insert into mova.mova_migracao (nome, sha256) values ('0011_mova_entregadores_rotina.sql', 'ff74849e1f40ea2f799ee3c8a5a5be8562bfebf9ecdbde59d6c9e24c3d2ee0ca');

-- ------------------------------------------------------------------------- 0012_mova_juros_documental.sql (arquivo eff9660cdfe1a5a1d969eb3a75e709b5d486a4df6d6e6bcd0555ee9cc8780bba)
-- MOVA (23/11/2026): operação JUROS_DOCUMENTAL — pagamento por comprovante COM juros/multa confirmados pela pessoa (ação estreita
-- `registrar_juros` do Financeiro, migração 0031). O limite da política é o ENCARGO máximo por pagamento.
--
-- Só amplia a lista fechada de operações das políticas e das execuções. Nenhuma política é semeada: sem política cadastrada
-- o MOVA só PROPÕE (o Financeiro aplica o pagamento com juros na Central).
alter table mova.politica_autonomia drop constraint politica_autonomia_operacao_check;
alter table mova.politica_autonomia add constraint politica_autonomia_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL','DESPESA_DOCUMENTAL','JUROS_DOCUMENTAL'));
alter table mova.operacao_executada drop constraint operacao_executada_operacao_check;
alter table mova.operacao_executada add constraint operacao_executada_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL','DESPESA_DOCUMENTAL','JUROS_DOCUMENTAL'));
insert into mova.mova_migracao (nome, sha256) values ('0012_mova_juros_documental.sql', 'eff9660cdfe1a5a1d969eb3a75e709b5d486a4df6d6e6bcd0555ee9cc8780bba');
