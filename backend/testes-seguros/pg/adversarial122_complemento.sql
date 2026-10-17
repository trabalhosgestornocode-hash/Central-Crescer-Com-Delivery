-- Complemento das provas adversariais: S7v/S7w (CHECK sem gatilhos), S8a e S10 corrigidos. Rodar DEPOIS de adversarial122.sql no mesmo banco 'sim'.
-- S7v: contornando os gatilhos (só superusuário de teste), o CHECK da tabela ainda barra JWT na evidência
set session_replication_role = replica;
select pg_temp.exp('S7v CHECK da tabela barra evidência com JWT (gatilhos desligados)', $q$ insert into fin_excecoes_fechamento(organizacao_id,unidade_id,mes,justificativa,pendencias,pendencias_hash,quantidade,aprovada_por,mfa_evidencia,expira_em) values ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','2027-09-01','justificativa longa o bastante aqui','[{"id":"x"}]',repeat('a',64),1,gen_random_uuid(),'{"aal":"aal2","em":"2027-01-01T00:00:00Z","metodo":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk"}',now()+interval '1 day') $q$, 'violates check');
select pg_temp.exp('S7w CHECK barra ids de conciliação malformados (gatilhos desligados)', $q$ insert into fin_excecoes_fechamento(organizacao_id,unidade_id,mes,justificativa,pendencias,pendencias_conciliacao_ids,pendencias_hash,quantidade,aprovada_por,mfa_evidencia,expira_em) values ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','2027-09-01','justificativa longa o bastante aqui','[]','{lixo}',repeat('a',64),0,gen_random_uuid(),'{"aal":"aal2","em":"2027-01-01T00:00:00Z"}',now()+interval '1 day') $q$, 'violates check');
set session_replication_role = origin;

create or replace function pg_temp.exp(label text, stmt text, esperado text) returns void language plpgsql as $$
declare estado text := 'ok'; msg text := '';
begin
  begin execute stmt; exception when others then estado := sqlstate; msg := sqlerrm; end;
  if (esperado = 'ok' and estado = 'ok') or (esperado = 'erro' and estado <> 'ok') or (esperado not in ('ok','erro') and msg like '%' || esperado || '%') then raise notice 'PASS  % [%]', label, case when estado = 'ok' then 'ok' else left(msg, 90) end;
  else raise notice 'FALHA % (esperado %, veio % %)', label, esperado, estado, left(msg, 140); end if;
end $$;
create or replace function pg_temp.fechar(p_uni uuid, p_mes date, p_ids text[], p_rec boolean) returns jsonb language plpgsql as $$
declare v int; fp text; o uuid := '00000000-0000-0000-0000-0000000000a1';
begin v := (fin_abrir_periodo(o, p_uni, '00000000-0000-0000-0000-000000000999', p_mes)->>'versao')::int; fp := fin_fingerprint_periodo(o, p_uni, p_mes);
  return fin_fechar_periodo(o, p_uni, '00000000-0000-0000-0000-000000000999', p_mes, v, fp, '{"t":1}', p_ids, p_rec); end $$;
create or replace function pg_temp.mfa() returns jsonb language sql as $$ select jsonb_build_object('aal','aal2','em', to_char(now() at time zone 'utc' - interval '20 seconds','YYYY-MM-DD"T"HH24:MI:SS"Z"')) $$;
set role service_role;
insert into fin_lancamentos(id,organizacao_id,unidade_id,conta_id,categoria_id,descricao,sentido,valor_centavos,data_movimento,classificacao_pendente) values
 ('00000000-0000-0000-0000-00000000d001','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000e1',null,'pend A','entrada',100,'2028-02-05',true),
 ('00000000-0000-0000-0000-00000000d002','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000000e4',null,'pend A2','entrada',100,'2028-02-05',true);
reset role;
set role dono_sim;
select (fin_conceder_excecao_fechamento('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-000000000888','2028-02-01','Justificativa suficientemente longa para o teste',7,'{}', pg_temp.mfa())) is not null as concedida_so_para_unidade_A;
reset role;
set role service_role;
select pg_temp.exp('S8a exceção da unidade A não vale para a unidade A2 no mesmo mês', $q$ select pg_temp.fechar('00000000-0000-0000-0000-0000000000a3','2028-02-01','{}',true) $q$, 'fin_periodo_pendencias');
select pg_temp.exp('S10b fecha A e falha depois na mesma transação (tudo desfeito)', $q$ do $d$ begin perform pg_temp.fechar('00000000-0000-0000-0000-0000000000a2','2028-02-01','{}',true); raise exception 'falha_simulada'; end $d$ $q$, 'falha_simulada');
reset role;
select 'S10c após o erro', (select string_agg(status,',') from fin_excecoes_fechamento where unidade_id='00000000-0000-0000-0000-0000000000a2' and mes='2028-02-01') as excecao, (select status from fin_periodos where unidade_id='00000000-0000-0000-0000-0000000000a2' and mes='2028-02-01') as periodo;
set role service_role;
select pg_temp.exp('S10d fechamento legítimo depois do erro funciona', $q$ select pg_temp.fechar('00000000-0000-0000-0000-0000000000a2','2028-02-01','{}',true) $q$, 'ok');
reset role;
select 'S10e após fechar', (select string_agg(status,',') from fin_excecoes_fechamento where unidade_id='00000000-0000-0000-0000-0000000000a2' and mes='2028-02-01') as excecao, (select status from fin_periodos where unidade_id='00000000-0000-0000-0000-0000000000a2' and mes='2028-02-01') as periodo;
