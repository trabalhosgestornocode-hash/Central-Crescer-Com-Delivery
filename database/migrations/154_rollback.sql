-- Rollback da 154. RECUSA se houver pagamento com origem diferente de 'conta' (voltar a exigir conta apagaria a informação).
begin;
set local lock_timeout = '5s';
do $$
declare n bigint;
begin
  select count(*) into n from fin_pagamentos where origem_pagamento <> 'conta';
  if n > 0 then raise exception 'ROLLBACK 154 RECUSADO: % pagamento(s) com origem pendente ou por terceiro', n; end if;
end $$;
drop trigger if exists trg_fin_conciliacao_saidas_origem on fin_conciliacao_saidas;
drop trigger if exists trg_fin_pagamentos_origem on fin_pagamentos;
drop function if exists fin2_conciliacao_origem_guarda();
drop function if exists fin2_pagamentos_origem_guarda();
alter table fin_pagamentos drop constraint if exists fin_pag_origem_documentada;
alter table fin_pagamentos drop constraint if exists fin_pag_origem_coerente;
alter table fin_pagamentos drop constraint if exists fin_pag_origem_valida;
drop index if exists ix_fin_pagamentos_divida;
alter table fin_pagamentos drop column if exists divida_id;
alter table fin_pagamentos drop column if exists terceiro_nome;
alter table fin_pagamentos drop column if exists origem_pagamento;
alter table fin_pagamentos alter column conta_id set not null;
commit;
