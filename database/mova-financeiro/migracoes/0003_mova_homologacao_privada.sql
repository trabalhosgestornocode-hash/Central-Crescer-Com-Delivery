-- MOVA — Execução 04B: homologação em UMA conversa privada autorizada (além dos grupos).
-- APLICAR SOMENTE NO PostgreSQL LOCAL DE TESTE / ambiente de homologação. Nada aqui foi aplicado em produção.
-- O número do contato NUNCA é semeado aqui: entra pela configuração do ambiente de homologação.

alter table mova.grupo_autorizado drop constraint grupo_autorizado_grupo_jid_check;
alter table mova.grupo_autorizado add column tipo text not null default 'GRUPO' check (tipo in ('GRUPO','PRIVADO_HOMOLOGACAO'));
alter table mova.grupo_autorizado add constraint grupo_autorizado_jid_por_tipo check (
  (tipo = 'GRUPO' and grupo_jid ~ '^[0-9]{5,40}(-[0-9]{1,20})?@g\.us$')
  or (tipo = 'PRIVADO_HOMOLOGACAO' and grupo_jid ~ '^[1-9][0-9]{7,14}@s\.whatsapp\.net$'));
-- No máximo UMA conversa privada de homologação ativa por vez.
create unique index grupo_autorizado_um_privado_ativo on mova.grupo_autorizado ((tipo)) where tipo = 'PRIVADO_HOMOLOGACAO' and ativo;
grant select, insert, update on mova.grupo_autorizado to mova_app;
