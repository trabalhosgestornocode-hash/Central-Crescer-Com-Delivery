-- NOTA: S7v, S8a e S10b foram movidos (corrigidos) para adversarial122_complemento.sql, que roda DEPOIS deste. S11 PROVA o risco residual R-1 (fechamento sem ids de conciliação).
-- papel DONO das funções: local = dono_sim; no Supabase descartável use -v DONO=<dono real>
\if :{?DONO} \else \set DONO dono_sim \endif
-- Provas ADVERSARIAIS (Agente 1) da exceção de fechamento e do fechamento/reabertura diretos na 122 (cd35699).
-- Banco "sim": 120+121+122 aplicadas COMO dono_sim (não-superusuário) com default privileges do Supabase simulados. Dados sintéticos.
-- Papéis: service_role = backend; dono_sim = simula o FUTURO papel de plataforma que poderá conceder (hoje ninguém tem EXECUTE).
\set ON_ERROR_STOP off
\set O '00000000-0000-0000-0000-0000000000a1'
\set U '00000000-0000-0000-0000-0000000000a2'
\set OB '00000000-0000-0000-0000-0000000000b1'
\set UB '00000000-0000-0000-0000-0000000000b2'
\set U2 '00000000-0000-0000-0000-0000000000a3'
\set USR '00000000-0000-0000-0000-000000000999'
\set SA '00000000-0000-0000-0000-000000000888'
\set CONTA '00000000-0000-0000-0000-0000000000e1'
\set CAT '00000000-0000-0000-0000-0000000000f1'
\set CONTA_B '00000000-0000-0000-0000-0000000000e3'

insert into organizacoes(id,nome) values (:'OB','Org B') on conflict do nothing;
insert into unidades(id,organizacao_id,nome) values (:'UB',:'OB','UB') on conflict do nothing;
insert into unidades(id,organizacao_id,nome) values (:'U2',:'O','U2') on conflict do nothing;
insert into fin_plano_contas(id,organizacao_id,tipo,natureza,nome,papel) values (:'CAT',:'O','RECEITA','RECEBIMENTO','VENDAS','receita_operacional') on conflict do nothing;
insert into fin_contas(id,organizacao_id,unidade_id,nome) values (:'CONTA',:'O',:'U','A') on conflict do nothing;
insert into fin_contas(id,organizacao_id,unidade_id,nome) values (:'CONTA_B',:'OB',:'UB','X') on conflict do nothing;
insert into fin_contas(id,organizacao_id,unidade_id,nome) values ('00000000-0000-0000-0000-0000000000e4',:'O',:'U2','Y') on conflict do nothing;

-- helpers (criados como superusuário local do cluster descartável, usados sob os papéis)
create or replace function pg_temp.exp(label text, stmt text, esperado text) returns void language plpgsql as $$
declare estado text := 'ok'; msg text := '';
begin
  begin execute stmt; exception when others then estado := sqlstate; msg := sqlerrm; end;
  if (esperado = 'ok' and estado = 'ok') or (esperado = 'erro' and estado <> 'ok') or (esperado not in ('ok','erro') and msg like '%' || esperado || '%') then
    raise notice 'PASS  % [%]', label, case when estado = 'ok' then 'ok' else left(msg, 90) end;
  else raise notice 'FALHA % (esperado %, veio % %)', label, esperado, estado, left(msg, 140); end if;
end $$;
-- lançamento pendente em um mês
create or replace function pg_temp.pend(p_id uuid, p_uni uuid, p_conta uuid, p_data date) returns void language sql as $$
  insert into fin_lancamentos(id,organizacao_id,unidade_id,conta_id,categoria_id,descricao,sentido,valor_centavos,data_movimento,classificacao_pendente)
  values (p_id, case when p_uni = '00000000-0000-0000-0000-0000000000b2' then '00000000-0000-0000-0000-0000000000b1'::uuid else '00000000-0000-0000-0000-0000000000a1'::uuid end, p_uni, p_conta, null, 'pendente', 'entrada', 100, p_data, true)
$$;
-- fechar pelo caminho legítimo (lê versão e impressão digital correntes)
create or replace function pg_temp.fechar(p_uni uuid, p_mes date, p_ids text[], p_rec boolean) returns jsonb language plpgsql as $$
declare v int; fp text; o uuid := '00000000-0000-0000-0000-0000000000a1';
begin
  v := (fin_abrir_periodo(o, p_uni, '00000000-0000-0000-0000-000000000999', p_mes)->>'versao')::int;
  fp := fin_fingerprint_periodo(o, p_uni, p_mes);
  return fin_fechar_periodo(o, p_uni, '00000000-0000-0000-0000-000000000999', p_mes, v, fp, '{"t":1}', p_ids, p_rec);
end $$;
create or replace function pg_temp.mfa(p_seg int) returns jsonb language sql as $$
  select jsonb_build_object('aal','aal2','em', to_char(now() at time zone 'utc' - make_interval(secs => p_seg), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'metodo','totp', 'sessao_ref', encode(sha256('sessao-sintetica'::bytea),'hex'))
$$;
create or replace function pg_temp.conceder(p_uni uuid, p_mes date, p_ids text[], p_mfa jsonb) returns jsonb language sql as $$
  select fin_conceder_excecao_fechamento('00000000-0000-0000-0000-0000000000a1', p_uni, '00000000-0000-0000-0000-000000000888', p_mes, 'Justificativa suficientemente longa para o teste', 7, p_ids, p_mfa)
$$;
create or replace function pg_temp.estado_exc(p_uni uuid, p_mes date) returns text language sql as $$
  select coalesce(string_agg(status, ','), 'nenhuma') from fin_excecoes_fechamento where unidade_id = p_uni and mes = p_mes
$$;

\echo '=== S0. privilégios: service_role NÃO concede/revoga/reabre; assinaturas antigas inexistentes ==='
set role service_role;
select pg_temp.exp('S0a service_role não concede', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2','2027-01-01','{}', pg_temp.mfa(30)) $q$, 'permission denied');
select pg_temp.exp('S0b service_role não revoga', $q$ select fin_revogar_excecao_fechamento('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-000000000888', gen_random_uuid(), 'motivo longo o bastante') $q$, 'permission denied');
select pg_temp.exp('S0c service_role não reabre', $q$ select fin_reabrir_periodo('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-000000000999','2027-01-01',1,'motivo longo o bastante') $q$, 'permission denied');
select pg_temp.exp('S0d assinatura ANTIGA de fechar (int, boolean) não existe', $q$ select fin_fechar_periodo('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-000000000999','2027-01-01',1,'x','{}',0,false) $q$, 'does not exist');
select pg_temp.exp('S0e assinatura ANTIGA de conceder (int,int,jsonb) não existe', $q$ select fin_conceder_excecao_fechamento('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-000000000888','2027-01-01','justificativa longa o bastante aqui',7,1,'{}'::jsonb) $q$, 'does not exist');
select pg_temp.exp('S0f validadores puros não executáveis', $q$ select fin_mfa_evidencia_valida('{}'::jsonb) $q$, 'permission denied');
select pg_temp.exp('S0g escrita direta na tabela de exceções negada', $q$ insert into fin_excecoes_fechamento(organizacao_id,unidade_id,mes,justificativa,pendencias,pendencias_hash,quantidade,aprovada_por,mfa_evidencia,expira_em) values ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','2027-01-01','x','[]',repeat('a',64),1,gen_random_uuid(),'{}',now()+interval '1 day') $q$, 'permission denied');
reset role;
set role anon;
select pg_temp.exp('S0h anon não executa fechar', $q$ select fin_fechar_periodo('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-000000000999','2027-01-01',1,'x','{}',array[]::text[],false) $q$, 'permission denied');
reset role;
set role authenticated;
select pg_temp.exp('S0i authenticated não executa conceder', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2'::uuid,'2027-01-01','{}', pg_temp.mfa(30)) $q$, 'permission denied');
reset role;

\echo '=== S1-S4. pendência nova / substituída / resolvida; cobertura por subconjunto (mês 2027-01) ==='
set role service_role;
select pg_temp.pend('00000000-0000-0000-0000-00000000c101', :'U', :'CONTA', '2027-01-05');
select pg_temp.pend('00000000-0000-0000-0000-00000000c102', :'U', :'CONTA', '2027-01-06');
select pg_temp.exp('S1 sem exceção: fechar com pendência é recusado', $q$ select pg_temp.fechar('00000000-0000-0000-0000-0000000000a2','2027-01-01','{}',true) $q$, 'fin_periodo_pendencias');
reset role;
set role :"DONO";
select pg_temp.exp('S2 concede com MFA de 30 s', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2','2027-01-01','{}', pg_temp.mfa(30)) $q$, 'ok');
reset role;
select 'S2b evidência/ids gravados', mfa_evidencia ? 'sessao_ref' as tem_ref, mfa_evidencia::text ~ 'eyJ' as tem_jwt, quantidade, pendencias_hash ~ '^[0-9a-f]{64}$' as hash_ok, aprovada_por from fin_excecoes_fechamento where unidade_id = :'U' and mes = '2027-01-01';
set role service_role;
select pg_temp.pend('00000000-0000-0000-0000-00000000c103', :'U', :'CONTA', '2027-01-07');
select pg_temp.exp('S3 pendência NOVA após a concessão invalida a cobertura', $q$ select pg_temp.fechar('00000000-0000-0000-0000-0000000000a2','2027-01-01','{}',true) $q$, 'fin_periodo_excecao_insuficiente');
-- substituída: resolve c101 (categoria definida) e mantém c103 -> contagem igual (2), mas c103 não está coberta
update fin_lancamentos set categoria_id = :'CAT', classificacao_pendente = false, nota_revisao = 'resolvida para o teste adversarial' where id = '00000000-0000-0000-0000-00000000c101';
select pg_temp.exp('S4 pendência SUBSTITUÍDA por outra (mesmo total) é recusada', $q$ select pg_temp.fechar('00000000-0000-0000-0000-0000000000a2','2027-01-01','{}',true) $q$, 'fin_periodo_excecao_insuficiente');
select pg_temp.exp('S4b sem reconhecer pendências também recusa', $q$ select pg_temp.fechar('00000000-0000-0000-0000-0000000000a2','2027-01-01','{}',false) $q$, 'erro');
reset role;
select 'S4c exceção segue ATIVA e período aberto', pg_temp.estado_exc(:'U','2027-01-01'), (select status from fin_periodos where unidade_id = :'U' and mes = '2027-01-01');

\echo '=== S5. resolvida antes do fechamento (subconjunto) consome 1 vez (mês 2027-03) ==='
set role service_role;
select pg_temp.pend('00000000-0000-0000-0000-00000000c301', :'U', :'CONTA', '2027-03-05');
select pg_temp.pend('00000000-0000-0000-0000-00000000c302', :'U', :'CONTA', '2027-03-06');
reset role;
set role :"DONO"; select pg_temp.exp('S5a concede', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2','2027-03-01','{}', pg_temp.mfa(60)) $q$, 'ok'); reset role;
set role service_role;
update fin_lancamentos set categoria_id = :'CAT', classificacao_pendente = false, nota_revisao = 'resolvida antes do fechamento' where id = '00000000-0000-0000-0000-00000000c301';
select pg_temp.exp('S5b fecha com 1 pendência restante (coberta)', $q$ select pg_temp.fechar('00000000-0000-0000-0000-0000000000a2','2027-03-01','{}',true) $q$, 'ok');
select pg_temp.exp('S5c segundo fechamento do mesmo mês', $q$ select pg_temp.fechar('00000000-0000-0000-0000-0000000000a2','2027-03-01','{}',true) $q$, 'fin_periodo_ja_fechado');
select pg_temp.exp('S5d consumir direto sem flag', $q$ select fin_consumir_excecao_fechamento((select id from fin_excecoes_fechamento where unidade_id='00000000-0000-0000-0000-0000000000a2' and mes='2027-03-01'), '00000000-0000-0000-0000-000000000999') $q$, 'erro');
select pg_temp.exp('S5e UPDATE direto reativando a exceção consumida', $q$ update fin_excecoes_fechamento set status='ativa' where unidade_id='00000000-0000-0000-0000-0000000000a2' and mes='2027-03-01' $q$, 'permission denied');
reset role;
select 'S5f exceção consumida exatamente 1x e vinculada ao snapshot', e.status, e.consumida_por is not null as consumida, (p.snapshot->>'excecaoFechamentoId') = e.id::text as snapshot_vinculado, (p.snapshot->>'pendenciasNoFechamento') as pend_no_fechamento
  from fin_excecoes_fechamento e join fin_periodos p on p.unidade_id = e.unidade_id and p.mes = e.mes where e.unidade_id = :'U' and e.mes = '2027-03-01';

\echo '=== S6. exceção VENCIDA (mês 2027-04): data retroagida só por superusuário de teste ==='
set role service_role; select pg_temp.pend('00000000-0000-0000-0000-00000000c401', :'U', :'CONTA', '2027-04-05'); reset role;
set role :"DONO"; select pg_temp.exp('S6a concede', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2','2027-04-01','{}', pg_temp.mfa(10)) $q$, 'ok'); reset role;
set session_replication_role = replica;
update fin_excecoes_fechamento set aprovada_em = now() - interval '3 days', expira_em = now() - interval '1 day' where unidade_id = :'U' and mes = '2027-04-01';
set session_replication_role = origin;
set role service_role;
select pg_temp.exp('S6b exceção vencida não vale', $q$ select pg_temp.fechar('00000000-0000-0000-0000-0000000000a2','2027-04-01','{}',true) $q$, 'fin_periodo_pendencias');
reset role;

\echo '=== S7. MFA: fronteira de 10 min, formato e conteúdo proibido ==='
set role :"DONO";
select pg_temp.pend('00000000-0000-0000-0000-00000000c501', :'U', :'CONTA', '2027-05-05');
select pg_temp.exp('S7a MFA há 9 min 50 s aceita', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2','2027-05-01','{}', pg_temp.mfa(590)) $q$, 'ok');
reset role;
set role :"DONO";
select pg_temp.exp('S7b MFA há 10 min 5 s recusada', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2','2027-06-01','{}', pg_temp.mfa(605)) $q$, 'fin_excecao_mfa_invalida');
select pg_temp.exp('S7c MFA há 15 min recusada', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2','2027-06-01','{}', pg_temp.mfa(900)) $q$, 'fin_excecao_mfa_invalida');
select pg_temp.exp('S7d MFA no futuro (+120 s) recusada', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2','2027-06-01','{}', pg_temp.mfa(-120)) $q$, 'fin_excecao_mfa_invalida');
select pg_temp.exp('S7e aal1 recusada', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2','2027-06-01','{}', pg_temp.mfa(30) || '{"aal":"aal1"}') $q$, 'fin_excecao_mfa_invalida');
select pg_temp.exp('S7f sem "em" recusada', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2','2027-06-01','{}', pg_temp.mfa(30) - 'em') $q$, 'fin_excecao_mfa_invalida');
select pg_temp.exp('S7g chave extra (jwt) recusada', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2','2027-06-01','{}', pg_temp.mfa(30) || '{"jwt":"abc"}') $q$, 'fin_excecao_mfa_invalida');
select pg_temp.exp('S7h sessao_ref inválida (uuid cru) recusada', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2','2027-06-01','{}', pg_temp.mfa(30) || '{"sessao_ref":"6f1c2d3e-aaaa-bbbb-cccc-1234567890ab"}') $q$, 'fin_excecao_mfa_invalida');
select pg_temp.exp('S7i sessao_ref com 63 hex recusada', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2','2027-06-01','{}', pg_temp.mfa(30) || jsonb_build_object('sessao_ref', repeat('a',63))) $q$, 'fin_excecao_mfa_invalida');
select pg_temp.exp('S7j sessao_ref MAIÚSCULA recusada', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2','2027-06-01','{}', pg_temp.mfa(30) || jsonb_build_object('sessao_ref', repeat('A',64))) $q$, 'fin_excecao_mfa_invalida');
select pg_temp.exp('S7k JWT no campo metodo recusado', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2','2027-06-01','{}', pg_temp.mfa(30) || '{"metodo":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk"}') $q$, 'fin_excecao_mfa_invalida');
select pg_temp.exp('S7l metodo desconhecido recusado', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2','2027-06-01','{}', pg_temp.mfa(30) || '{"metodo":"sms"}') $q$, 'fin_excecao_mfa_invalida');
select pg_temp.exp('S7m "em" sem fuso recusado', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2','2027-06-01','{}', pg_temp.mfa(30) || '{"em":"2027-01-01T00:00:00"}') $q$, 'fin_excecao_mfa_invalida');
select pg_temp.exp('S7n "em" numérico recusado', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2','2027-06-01','{}', pg_temp.mfa(30) || '{"em":1792257394}') $q$, 'fin_excecao_mfa_invalida');
select pg_temp.exp('S7o "em" com data impossível falha fechada', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2','2027-06-01','{}', pg_temp.mfa(30) || '{"em":"2027-13-45T00:00:00Z"}') $q$, 'erro');
select pg_temp.exp('S7p MFA nulo recusado', $q$ select fin_conceder_excecao_fechamento('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-000000000888','2027-06-01','justificativa longa o bastante aqui',7,'{}',null) $q$, 'fin_excecao_mfa_invalida');
select pg_temp.exp('S7q validade 31 dias recusada', $q$ select fin_conceder_excecao_fechamento('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-000000000888','2027-05-01','justificativa longa o bastante aqui',31,'{}', pg_temp.mfa(30)) $q$, 'fin_excecao_validade_invalida');
select pg_temp.exp('S7r justificativa curta recusada', $q$ select fin_conceder_excecao_fechamento('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-000000000888','2027-05-01','curta',7,'{}', pg_temp.mfa(30)) $q$, 'fin_excecao_justificativa_obrigatoria');
select pg_temp.exp('S7s ids de conciliação malformados recusados', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2','2027-05-01', array['qualquer:coisa'], pg_temp.mfa(30)) $q$, 'fin_excecao_pendencias_invalidas');
select pg_temp.exp('S7t ids de conciliação repetidos recusados', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2','2027-05-01', array['caixa_dia:2027-05-02','caixa_dia:2027-05-02'], pg_temp.mfa(30)) $q$, 'fin_excecao_pendencias_invalidas');
select pg_temp.exp('S7u sem nenhuma pendência recusa conceder', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2','2027-07-01','{}', pg_temp.mfa(30)) $q$, 'fin_excecao_sem_pendencias');
reset role;
-- CHECK da tabela barra mesmo contornando a função (superusuário desliga só os gatilhos de teste)

\echo '=== S8. unidade/organização erradas ==='
set role service_role;
select pg_temp.pend('00000000-0000-0000-0000-00000000c801', :'U2', '00000000-0000-0000-0000-0000000000e4', '2027-08-05');
select pg_temp.exp('S8b fechar usando org B com unidade da org A', $q$ select fin_fechar_periodo('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-000000000999','2027-08-01',1,'x','{}',array[]::text[],true) $q$, 'erro');
reset role;
set role :"DONO";
select pg_temp.exp('S8c conceder com org B para unidade da org A', $q$ select fin_conceder_excecao_fechamento('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-000000000888','2027-08-01','justificativa longa o bastante aqui',7,'{}', pg_temp.mfa(30)) $q$, 'erro');
select pg_temp.exp('S8d revogar exceção de A informando org/unidade B (retorna false)', $q$ do $d$ begin if fin_revogar_excecao_fechamento('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-000000000888',(select id from fin_excecoes_fechamento where unidade_id='00000000-0000-0000-0000-0000000000a2' and mes='2027-05-01'),'motivo longo o bastante') then raise exception 'REVOGOU DE OUTRO TENANT'; end if; end $d$ $q$, 'ok');
reset role;
select 'S8e exceção de 2027-05 segue', pg_temp.estado_exc(:'U','2027-05-01');

\echo '=== S9. fechar / reabrir por SQL direto (service_role e dono) ==='
set role service_role;
select pg_temp.exp('S9a UPDATE direto fechando mês com pendência', $q$ update fin_periodos set status='fechado', fechado_por='00000000-0000-0000-0000-000000000999', fechado_em=now(), snapshot='{"x":1}' where unidade_id='00000000-0000-0000-0000-0000000000a2' and mes='2027-05-01' $q$, 'fin_fechamento_via_funcao');
select pg_temp.exp('S9b INSERT de período já fechado', $q$ insert into fin_periodos(organizacao_id,unidade_id,mes,status,fechado_por,fechado_em,snapshot) values ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','2030-01-01','fechado','00000000-0000-0000-0000-000000000999',now(),'{"x":1}') $q$, 'fin_fechamento_via_funcao');
select pg_temp.exp('S9c flag de OUTRO período não autoriza', $q$ select set_config('fin.fechando_periodo', gen_random_uuid()::text, true); update fin_periodos set status='fechado', fechado_por='00000000-0000-0000-0000-000000000999', fechado_em=now(), snapshot='{"x":1}' where unidade_id='00000000-0000-0000-0000-0000000000a2' and mes='2027-05-01' $q$, 'fin_fechamento_via_funcao');
select pg_temp.exp('S9d flag vazia após erro não vaza para a próxima transação', $q$ select 1 where coalesce(current_setting('fin.fechando_periodo', true),'') = '' $q$, 'ok');
select pg_temp.exp('S9e reabrir mês fechado (2027-03) por UPDATE', $q$ update fin_periodos set status='aberto' where unidade_id='00000000-0000-0000-0000-0000000000a2' and mes='2027-03-01' $q$, 'fin_reabertura_desabilitada');
select pg_temp.exp('S9f marcar como reaberto por UPDATE', $q$ update fin_periodos set status='reaberto' where unidade_id='00000000-0000-0000-0000-0000000000a2' and mes='2027-03-01' $q$, 'fin_reabertura_desabilitada');
select pg_temp.exp('S9g alterar snapshot do fechado', $q$ update fin_periodos set snapshot='{"adulterado":true}' where unidade_id='00000000-0000-0000-0000-0000000000a2' and mes='2027-03-01' $q$, 'erro');
select pg_temp.exp('S9h DELETE do período', $q$ delete from fin_periodos where unidade_id='00000000-0000-0000-0000-0000000000a2' and mes='2027-03-01' $q$, 'permission denied');
select pg_temp.exp('S9i lançamento em mês fechado', $q$ insert into fin_lancamentos(organizacao_id,unidade_id,conta_id,categoria_id,descricao,sentido,valor_centavos,data_movimento) values ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000f1','x','entrada',1,'2027-03-20') $q$, 'fin_periodo_fechado');
reset role;
set role :"DONO";
select pg_temp.exp('S9j até o DONO não reabre por UPDATE', $q$ update fin_periodos set status='aberto' where unidade_id='00000000-0000-0000-0000-0000000000a2' and mes='2027-03-01' $q$, 'fin_reabertura_desabilitada');
select pg_temp.exp('S9k dono executando fin_reabrir_periodo é barrado pelo gatilho', $q$ select fin_reabrir_periodo('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-000000000999','2027-03-01',(select versao from fin_periodos where unidade_id='00000000-0000-0000-0000-0000000000a2' and mes='2027-03-01'),'motivo longo o bastante') $q$, 'fin_reabertura_desabilitada');
reset role;

\echo '=== S10. falha na transação: fechamento + erro depois => nada consumido, período aberto (mês 2027-10) ==='
set role service_role; select pg_temp.pend('00000000-0000-0000-0000-00000000ca01', :'U', :'CONTA', '2027-10-05'); reset role;
set role :"DONO"; select pg_temp.exp('S10a concede', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2','2027-10-01','{}', pg_temp.mfa(20)) $q$, 'ok'); reset role;
set role service_role;
reset role;
select 'S10c após o erro', pg_temp.estado_exc(:'U','2027-10-01') as excecao, (select status from fin_periodos where unidade_id = :'U' and mes = '2027-10-01') as periodo;

\echo '=== S11. R-1 / M1: o BANCO determina as pendências de conciliação; lista omitida/fabricada/extra NÃO fecha ==='
-- mês com venda de R$ 1.000,00 + taxa de R$ 100,00 e SEM recebimento: o motor JS aponta ponte_mensal:2027-11-01 ABERTA (venda sozinha seria sem_referencia, não pendência)
set role service_role;
insert into fin_referencias(organizacao_id,unidade_id,data,tipo,canal,valor_centavos,fonte) values (:'O',:'U','2027-11-10','venda',null,100000,'manual'),(:'O',:'U','2027-11-10','taxa','STONE',10000,'manual');
select pg_temp.exp('S11a O BANCO calcula a ponte aberta', $q$ do $d$ begin if fin_conciliacao_pendencias_ids('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','2027-11-01') <> array['ponte_mensal:2027-11-01'] then raise exception 'conjunto inesperado'; end if; end $d$ $q$, 'ok');
select pg_temp.exp('S11b lista OMITIDA (R-1) é RECUSADA', $q$ select pg_temp.fechar('00000000-0000-0000-0000-0000000000a2','2027-11-01','{}',false) $q$, 'fin_conciliacao_divergente');
select pg_temp.exp('S11c lista OMITIDA com reconhecimento também', $q$ select pg_temp.fechar('00000000-0000-0000-0000-0000000000a2','2027-11-01','{}',true) $q$, 'fin_conciliacao_divergente');
select pg_temp.exp('S11d lista FABRICADA recusada', $q$ select pg_temp.fechar('00000000-0000-0000-0000-0000000000a2','2027-11-01', array['caixa_dia:2030-01-01'], true) $q$, 'fin_conciliacao_divergente');
select pg_temp.exp('S11e lista com id EXTRA recusada', $q$ select pg_temp.fechar('00000000-0000-0000-0000-0000000000a2','2027-11-01', array['ponte_mensal:2027-11-01','caixa_dia:2027-11-02'], true) $q$, 'fin_conciliacao_divergente');
select pg_temp.exp('S11f lista com id REPETIDO recusada', $q$ select pg_temp.fechar('00000000-0000-0000-0000-0000000000a2','2027-11-01', array['ponte_mensal:2027-11-01','ponte_mensal:2027-11-01'], true) $q$, 'fin_conciliacao_divergente');
select pg_temp.exp('S11g lista com NULO recusada', $q$ select pg_temp.fechar('00000000-0000-0000-0000-0000000000a2','2027-11-01', array['ponte_mensal:2027-11-01', null], true) $q$, 'fin_conciliacao_divergente');
select pg_temp.exp('S11h lista CORRETA, sem exceção: pendência impede', $q$ select pg_temp.fechar('00000000-0000-0000-0000-0000000000a2','2027-11-01', array['ponte_mensal:2027-11-01'], true) $q$, 'fin_periodo_pendencias');
reset role;
select 'S11i mês segue ABERTO após todas as tentativas', status from fin_periodos where unidade_id = :'U' and mes = '2027-11-01';
-- concessão: lista omitida/fabricada não vira evidência de cobertura
set role :"DONO";
select pg_temp.exp('S11j conceder com lista OMITIDA é recusado', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2','2027-11-01','{}', pg_temp.mfa(30)) $q$, 'fin_conciliacao_divergente');
select pg_temp.exp('S11k conceder com lista FABRICADA é recusado', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2','2027-11-01', array['caixa_dia:2030-01-01'], pg_temp.mfa(30)) $q$, 'fin_conciliacao_divergente');
select pg_temp.exp('S11l conceder com a lista CORRETA registra o conjunto do banco', $q$ select pg_temp.conceder('00000000-0000-0000-0000-0000000000a2','2027-11-01', array['ponte_mensal:2027-11-01'], pg_temp.mfa(30)) $q$, 'ok');
reset role;
select 'S11m evidência registrada pelo banco', pendencias_conciliacao_ids, quantidade from fin_excecoes_fechamento where unidade_id = :'U' and mes = '2027-11-01';
-- com a exceção, a mesma lista OMITIDA continua recusada (a exceção não "perdoa" lista incompleta)
set role service_role;
select pg_temp.exp('S11n exceção ativa + lista OMITIDA: recusado', $q$ select pg_temp.fechar('00000000-0000-0000-0000-0000000000a2','2027-11-01','{}',true) $q$, 'fin_conciliacao_divergente');
select pg_temp.exp('S11o exceção ativa + lista correta + reconhecimento: fecha', $q$ select pg_temp.fechar('00000000-0000-0000-0000-0000000000a2','2027-11-01', array['ponte_mensal:2027-11-01'], true) $q$, 'ok');
reset role;
select 'S11p fechado com a exceção consumida', (select status from fin_periodos where unidade_id = :'U' and mes = '2027-11-01') as periodo, pg_temp.estado_exc(:'U','2027-11-01') as excecao;

\echo '=== S12. privilégios da função autoritativa ==='
select 'S12a service_role executa', has_function_privilege('service_role','fin_conciliacao_pendencias_ids(uuid,uuid,date)','execute');
select 'S12b anon/authenticated NÃO executam', has_function_privilege('anon','fin_conciliacao_pendencias_ids(uuid,uuid,date)','execute') or has_function_privilege('authenticated','fin_conciliacao_pendencias_ids(uuid,uuid,date)','execute') as alguem_executa;
select 'S12c STABLE / search_path fixo / invoker', p.provolatile, p.proconfig, p.prosecdef from pg_proc p where p.oid = 'fin_conciliacao_pendencias_ids(uuid,uuid,date)'::regprocedure;
