-- 150 — Camada central Foody: UMA execução EM_ANDAMENTO por unidade (trava de concorrência no banco).
--
-- ADITIVA sobre a 147. Só um índice único PARCIAL em foody_sync_execucoes; não muda dados, não liga coleta nem agendador.
-- Fecha a corrida residual da trava da aplicação (foody.trava.js: memória do processo + leitura de EM_ANDAMENTO recente):
-- duas instâncias (deploy sobreposto) que leiam "nenhuma em andamento" ao mesmo tempo não conseguem abrir duas execuções
-- da mesma unidade — a segunda recebe 23505, que a aplicação devolve como CONCORRENCIA (nada é gravado).
--
-- PRÉ-REQUISITO: nenhuma unidade com mais de uma execução EM_ANDAMENTO (a migration RECUSA, sem alterar nada). Se recusar,
-- encerre as antigas como FALHOU/ABANDONADA pela própria aplicação (sincronização manual faz isso após 1 h) e rode de novo.
-- Rollback: 150_rollback.sql (só remove o índice).

begin;
set local lock_timeout = '5s';

do $$ begin
  if to_regclass('public.foody_sync_execucoes') is null then
    raise exception '150: exige a migration 147 (camada central Foody)';
  end if;
  if exists (select 1 from foody_sync_execucoes where status = 'EM_ANDAMENTO' group by unidade_id having count(*) > 1) then
    raise exception '150 recusada: há unidade com mais de uma execução EM_ANDAMENTO — encerre-as antes' using errcode = '55000';
  end if;
end $$;

create unique index if not exists foody_sync_execucoes_uma_em_andamento
  on public.foody_sync_execucoes (unidade_id) where status = 'EM_ANDAMENTO';

comment on index public.foody_sync_execucoes_uma_em_andamento is
  'Uma coleta Foody por unidade por vez (sincronização manual e agendador). 23505 = CONCORRENCIA na aplicação.';

commit;
