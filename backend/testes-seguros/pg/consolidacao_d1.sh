#!/bin/bash
# D-1: PROPOSTA de consolidação por telefone — prova no PostgreSQL LOCAL DESCARTÁVEL (cluster com MARCADOR_DESCARTAVEL, 127.0.0.1:54321) de que as
# regras de AUTORIZAÇÃO de cada bloco (backend/src/modules/comunicacao/comunicacao.consolidacao.js#motivoDeExclusao) correspondem ao esquema REAL e que
# a seleção de candidatos é SOMENTE LEITURA, isolada por empresa e por telefone. Usa a cadeia da main (banco `nt_branch`, mantido por
# `MANTER_BANCOS=1 bash notificacoes_config2.sh`). Não altera cota, política, agendamento nem envio.
# Uso: PG_CLUSTER_DIR=<cluster> bash backend/testes-seguros/pg/consolidacao_d1.sh
set -u
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"; export PGCLIENTENCODING=UTF8
CLUSTER="${PG_CLUSTER_DIR:?defina PG_CLUSTER_DIR (cluster DESCARTÁVEL local)}"; H="-h 127.0.0.1 -p 54321"; DB=cons1
N_OK=0; N_F=0; ok() { echo "OK    $1"; N_OK=$((N_OK+1)); }; bad() { echo "FALHA $1"; N_F=$((N_F+1)); }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — esperado [$3], obtido [$2]"; fi; }
[ -f "$CLUSTER/MARCADOR_DESCARTAVEL" ] || { echo "RECUSADO: sem MARCADOR_DESCARTAVEL"; exit 2; }
psql $H -U postgres -tAc "show data_directory" | grep -qF "$CLUSTER" || { echo "RECUSADO: servidor não é o cluster descartável"; exit 2; }
psql $H -U postgres -tAc "select to_regclass('public.comunicacao_mensagens')" -d nt_branch 2>/dev/null | grep -q comunicacao_mensagens || { echo "falta nt_branch (rode notificacoes_config2.sh com MANTER_BANCOS=1)"; exit 2; }
q() { PGOPTIONS="-c lc_messages=C" psql $H -U postgres -X -tA -d $DB -c "$1" 2>&1; }
semear() { local r; r="$(q "$1")"; case "$r" in *ERROR*|*ERRO*) echo "SEED FALHOU: $r"; exit 2;; esac; }
psql $H -U postgres -X -q -d postgres -c "drop database if exists $DB" -c "create database $DB owner dono_sim template nt_branch" >/dev/null 2>&1 || { echo "não consegui clonar nt_branch"; exit 2; }

U() { printf '00000000-0000-4000-8000-%012d' "$1"; }
O1=$(U 7101); O2=$(U 7102); O3=$(U 7103); O4=$(U 7104); O5=$(U 7105); O6=$(U 7106); O7=$(U 7107); CWX=$(U 7201); CWY=$(U 7202)
semear "insert into organizacoes (id, nome, status) values ('$O1','[CONS] O1','ativa'),('$O2','[CONS] O2','ativa'),('$O3','[CONS] O3','ativa'),('$O4','[CONS] O4','ativa'),('$O5','[CONS] O5','ativa'),('$O6','[CONS] O6','ativa'),('$O7','[CONS] O7','ativa')"
semear "insert into comunicacao_habilitacoes (organizacao_id, habilitado, timezone) values ('$O1',true,'America/Fortaleza'),('$O2',true,'America/Fortaleza'),('$O3',true,'America/Fortaleza'),('$O4',true,'America/Fortaleza'),('$O5',true,'America/Fortaleza'),('$O6',true,'America/Fortaleza'),('$O7',true,'America/Fortaleza')"
semear "insert into contatos_whatsapp (id, telefone_e164, verificado, verificado_em, consentimento, consentimento_em, opt_out) values ('$CWX','+5511933330001',true,now(),true,now(),false),('$CWY','+5511933330002',true,now(),true,now(),false)"
# O banco só admite o mesmo telefone UMA vez por empresa (ux_contatos_empresa_telefone_ativo): os 7 registros do MESMO telefone X estão em 7 EMPRESAS distintas (o caso real: um responsável, 7 lojas); 1 registro de OUTRO telefone Y na O1
CE() { echo "$(U $((7300+$1)))"; }
cadastra() { semear "insert into comunicacao_contatos_empresa (id, organizacao_id, nome, telefone_e164, tipo, contato_whatsapp_id, whatsapp_status, whatsapp_validado_em, ativo) values ('$(CE $1)','$2','R$1','$4','$3','$5','VALIDADO',now(),true)"; }
cadastra 1 $O1 principal +5511933330001 $CWX; cadastra 2 $O2 principal +5511933330001 $CWX; cadastra 3 $O3 principal +5511933330001 $CWX; cadastra 4 $O4 principal +5511933330001 $CWX
cadastra 5 $O5 principal +5511933330001 $CWX; cadastra 6 $O6 principal +5511933330001 $CWX; cadastra 7 $O7 principal +5511933330001 $CWX
cadastra 8 $O1 secundario +5511933330002 $CWY
chk "o banco impede o mesmo telefone duas vezes na MESMA empresa (por isso são 7 empresas, não 7 registros em uma)" "$(q "insert into comunicacao_contatos_empresa (id, organizacao_id, nome, telefone_e164, tipo, contato_whatsapp_id, whatsapp_status, whatsapp_validado_em, ativo) values (gen_random_uuid(),'$O1','dup','+5511933330001','operacional','$CWX','VALIDADO',now(),true)" | grep -c 'ux_contatos_empresa_telefone_ativo')" "1"
semear "insert into comunicacao_destinatario_categorias (contato_empresa_id, organizacao_id, categoria, habilitado) select id, organizacao_id, 'pendencia_d1', true from comunicacao_contatos_empresa where id in ($(for i in 1 2 3 4 5 6 7 8; do printf "'%s'," "$(CE $i)"; done | sed 's/,$//'))"
semear "set session_replication_role = replica; insert into comunicacao_mensagens (id, organizacao_id, contato_id, contato_empresa_id, tipo, conteudo, idempotency_key, disponivel_em, status, direcao) select gen_random_uuid(), organizacao_id, contato_whatsapp_id, id, 'dashboard_ifood_d1', 'sintetico', 'cons-'||id, now() + interval '1 hour', 'SCHEDULED', 'saida' from comunicacao_contatos_empresa where id in ($(for i in 1 2 3 4 5 6 7 8; do printf "'%s'," "$(CE $i)"; done | sed 's/,$//'))"

# Seleção de candidatos: MESMAS regras do módulo (registro ativo, opt-out, categoria habilitada, empresa habilitada/pausada); só leitura.
CAND="select coalesce(string_agg(case when motivo is null then 'ok' else motivo end, ',' order by registro), '-') from (
  select m.contato_id, ce.id registro,
    case when ce.id is null or not ce.ativo then 'REGISTRO_INATIVO'
         when coalesce(cw.opt_out, true) then 'OPT_OUT'
         when coalesce(k.habilitado, false) is not true then 'CATEGORIA_DESABILITADA'
         when coalesce(h.habilitado, false) is not true then 'EMPRESA_NAO_HABILITADA'
         when h.pausado_ate is not null and h.pausado_ate > now() then 'EMPRESA_PAUSADA'
         else null end motivo
  from comunicacao_mensagens m
  left join comunicacao_contatos_empresa ce on ce.id = m.contato_empresa_id
  left join contatos_whatsapp cw on cw.id = m.contato_id
  left join comunicacao_categorias cat on cat.tipo_alerta = m.tipo
  left join comunicacao_destinatario_categorias k on k.contato_empresa_id = ce.id and k.categoria = cat.codigo
  left join comunicacao_habilitacoes h on h.organizacao_id = m.organizacao_id
  where m.status = 'SCHEDULED' and m.idempotency_key like 'cons-%%' and m.contato_id = '%s') x"
sel() { q "$(printf "$CAND" "$1")"; }
OKX="ok,ok,ok,ok,ok,ok,ok"

chk "base: os 7 registros do telefone X são autorizados (1 grupo = 1 mensagem consolidada)" "$(sel $CWX)" "$OKX"
chk "base: o outro telefone Y é independente (1 bloco)" "$(sel $CWY)" "ok"
chk "isolamento por empresa: cada mensagem é da MESMA empresa do seu registro (0 divergências)" "$(q "select count(*) from comunicacao_mensagens m join comunicacao_contatos_empresa ce on ce.id=m.contato_empresa_id where m.idempotency_key like 'cons-%' and ce.organizacao_id <> m.organizacao_id")" "0"
chk "a seleção roda em transação SOMENTE LEITURA (nenhuma escrita)" "$(PGOPTIONS='-c lc_messages=C' psql $H -U postgres -X -tA -d $DB -c "begin read only; $(printf "$CAND" $CWX); commit" 2>&1 | grep -E "^ok")" "$OKX"

# revogação por destinatário (RPC real, origem da página de gestão): só o registro 2 (empresa O2)
q "set role service_role; select comunicacao_revogar('$(printf 'c%.0s' {1..64})', array['$(CE 2)']::uuid[], null, null, 'pagina_gestao_otp', null, null, false, null)" >/dev/null
chk "revogação REAL de UM registro (empresa O2): o RPC cancela a mensagem pendente dele; as outras 6 empresas seguem autorizadas" "$(sel $CWX)" "ok,ok,ok,ok,ok,ok"
q "update comunicacao_mensagens set status='SCHEDULED', erro=null where contato_empresa_id='$(CE 2)' and idempotency_key like 'cons-%'" >/dev/null
chk "janela de corrida (mensagem ainda agendada, categoria já revogada): a REGRA exclui só o bloco da O2" "$(sel $CWX)" "ok,CATEGORIA_DESABILITADA,ok,ok,ok,ok,ok"
chk "a revogação de uma empresa não grava nada nas outras (livro-razão só da O2)" "$(q "select count(*) filter (where organizacao_id='$O2') || '/' || count(*) filter (where organizacao_id<>'$O2') from comunicacao_consentimentos where contato_empresa_id in ($(for i in 1 2 3 4 5 6 7; do printf "'%s'," "$(CE $i)"; done | sed 's/,$//'))")" "$(q "select count(*) from comunicacao_categorias")/0"
chk "revogar sem 'sair de tudo' NÃO põe o contato em opt-out (telefone e outros blocos intactos)" "$(q "select opt_out from contatos_whatsapp where id='$CWX'")" "f"
chk "o banco BARRA reativar uma categoria que o titular revogou (nem a consolidação nem um gestor desfazem a saída)" "$(q "update comunicacao_destinatario_categorias set habilitado = true where contato_empresa_id='$(CE 2)'" | grep -q -i "revog" && echo barrado)" "barrado"
q "set session_replication_role = replica; update comunicacao_destinatario_categorias set habilitado = true where contato_empresa_id='$(CE 2)'" >/dev/null   # só para restaurar o seed do teste

# empresa pausada / não habilitada: só os blocos DAQUELA empresa
q "update comunicacao_habilitacoes set pausado_ate = now() + interval '1 day' where organizacao_id='$O3'" >/dev/null
chk "empresa O3 pausada: só o bloco da O3 sai (as outras 6 intactas)" "$(sel $CWX)" "ok,ok,EMPRESA_PAUSADA,ok,ok,ok,ok"
q "update comunicacao_habilitacoes set pausado_ate = null where organizacao_id='$O3'" >/dev/null
q "update comunicacao_habilitacoes set habilitado = false where organizacao_id='$O5'" >/dev/null
chk "empresa O5 desabilitada: só o bloco da O5 sai" "$(sel $CWX)" "ok,ok,ok,ok,EMPRESA_NAO_HABILITADA,ok,ok"
q "update comunicacao_habilitacoes set habilitado = true where organizacao_id='$O5'" >/dev/null

# SAIR (opt-out do contato): todos os blocos DAQUELE telefone; o outro telefone não é afetado
q "update contatos_whatsapp set opt_out = true where id='$CWX'" >/dev/null
chk "opt-out do telefone X: os 7 blocos saem; o telefone Y segue (1 bloco)" "$(sel $CWX)/$(sel $CWY)" "OPT_OUT,OPT_OUT,OPT_OUT,OPT_OUT,OPT_OUT,OPT_OUT,OPT_OUT/ok"
q "update contatos_whatsapp set opt_out = false where id='$CWX'" >/dev/null
q "update comunicacao_contatos_empresa set ativo = false where id='$(CE 6)'" >/dev/null
chk "registro inativo: só o bloco dele" "$(sel $CWX)" "ok,ok,ok,ok,ok,REGISTRO_INATIVO,ok"
chk "estado restaurado e a seleção volta ao conjunto completo (idempotente: reprocessar dá o mesmo resultado)" "$(q "update comunicacao_contatos_empresa set ativo = true where id='$(CE 6)'" >/dev/null; sel $CWX)/$(sel $CWX)" "$OKX/$OKX"
chk "a seleção não criou nem enviou nada; a mensagem do registro revogado foi reposta pelo próprio teste; 8 agendadas, 0 canceladas, 0 enviadas" "$(q "select count(*) filter (where status='SCHEDULED') || '/' || count(*) filter (where status='CANCELLED' and erro='REVOGADO_PELO_TITULAR') || '/' || count(*) filter (where status in ('SENT','DELIVERED','READ')) from comunicacao_mensagens where idempotency_key like 'cons-%'")" "8/0/0"
psql $H -U postgres -X -q -d postgres -c "drop database if exists $DB" >/dev/null 2>&1
echo "== $N_OK ok, $N_F falhas =="; [ "$N_F" = 0 ]
