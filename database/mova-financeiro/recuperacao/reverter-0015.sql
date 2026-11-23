-- MOVA — RECUPERAÇÃO da 0015_mova_pagadores_multiunidade (volta ao estado da 0014). Uma transação; só DEFINIÇÕES.
-- Aborta sem mudar nada se já houver dado que dependa da 0015 (pagador cadastrado, participante de unidade sem grupo, acesso
-- multiempresa ligado ou política CONTA_A_PAGAR automática): essas linhas não são apagadas por este arquivo — decidir antes.
do $$ begin
  if not exists (select 1 from mova.mova_migracao where nome = '0015_mova_pagadores_multiunidade.sql') then raise exception 'MOVA recuperação: 0015 não está aplicada — nada a desfazer'; end if;
  if exists (select 1 from mova.mova_migracao where nome > '0015_mova_pagadores_multiunidade.sql') then raise exception 'MOVA recuperação: há migrações depois da 0015'; end if;
  if exists (select 1 from mova.grupo_unidade where pagadores <> '[]'::jsonb) or exists (select 1 from mova.unidade_sem_grupo where pagadores <> '[]'::jsonb) then raise exception 'MOVA recuperação: há pagador cadastrado — nada foi feito'; end if;
  if exists (select 1 from mova.unidade_sem_grupo where participantes <> '[]'::jsonb or acesso_multiempresa) then raise exception 'MOVA recuperação: há participante/acesso multiempresa em unidade sem grupo — nada foi feito'; end if;
  if exists (select 1 from mova.proposta where tipo = 'VINCULO_DE_DOCUMENTO') then raise exception 'MOVA recuperação: existe proposta VINCULO_DE_DOCUMENTO — nada foi feito'; end if;
  if exists (select 1 from mova.politica_autonomia where nivel = 'APLICAR_AUTOMATICO' and operacao = 'CONTA_A_PAGAR') then raise exception 'MOVA recuperação: existe política CONTA_A_PAGAR automática — nada foi feito'; end if;
end $$;
alter table mova.proposta drop constraint proposta_tipo_check;
alter table mova.proposta add constraint proposta_tipo_check check (tipo in ('BAIXA_DE_OBRIGACAO','DESPESA_PAGA','NOVA_OBRIGACAO','SOLICITACAO_DE_REVISAO'));
alter table mova.politica_autonomia add constraint politica_autonomia_check2 check (not (nivel = 'APLICAR_AUTOMATICO' and operacao = 'CONTA_A_PAGAR'));
alter table mova.unidade_sem_grupo drop column acesso_multiempresa;
alter table mova.unidade_sem_grupo drop column participantes;
alter table mova.unidade_sem_grupo drop column pagadores;
alter table mova.grupo_unidade drop column pagadores;
delete from mova.mova_migracao where nome = '0015_mova_pagadores_multiunidade.sql';
