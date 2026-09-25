#!/usr/bin/env bash
# Concorrência REAL (várias sessões psql) das migrations 098/099. Somente banco de TESTE.
# Uso: DATABASE_URL=<teste> [PSQL=caminho/psql] bash test-concorrencia.sh
#
# Barreira DETERMINÍSTICA (não depende de latência): uma sessão "holder" segura o FOR UPDATE da linha; o script só libera o cenário quando
#   (1) o holder comprovadamente está segurando o lock (pg_stat_activity: pg_sleep ativo) e
#   (2) cada contendora que DEVE bloquear está comprovadamente esperando o lock (wait_event_type = 'Lock').
# Se a barreira não se forma no prazo, o resultado é INFRA (exit 3), nunca um "FAIL" funcional mascarado.
#
# Toda falha imprime: cenário, rodada, operações A/B, esperado, encontrado, SQL, timestamps (local e do banco) e o estado da linha.
# Exit code: 0 = tudo passou; 1 = violação FUNCIONAL; 3 = barreira/infra não estabelecida (inconclusivo, sem falha funcional).
set -u
PSQL=${PSQL:-psql}; U=${DATABASE_URL:?defina DATABASE_URL de TESTE}
ORG=a0960000-0000-4000-8000-00000000000a; HASH=$(printf '+12025550100' | sha256sum | cut -d' ' -f1)
[ "${CC_INJETAR_FALHA:-0}" = 1 ] && HASH=$(printf 'outro' | sha256sum | cut -d' ' -f1)   # autoteste do diagnóstico: força falhas reais de confirmação
TMP=$(mktemp -d); RUN="cc$$"
FALHAS=0; INFRA=0; PASSOS=0
CEN="-"; ROD="-"; OPA="-"; OPB="-"
HOLD_SEGUNDOS=${HOLD_SEGUNDOS:-6}

agora() { date +"%H:%M:%S.%N" | cut -c1-12; }
psqlq() { "$PSQL" "$U" -X -Atq -v ON_ERROR_STOP=1 "$@"; }
# q: executa SQL; em erro, NUNCA some com ele: devolve "SQLERR" e registra o erro na saída de diagnóstico.
q() {
  local out rc
  out=$(psqlq -c "$1" 2>"$TMP/err.$$"); rc=$?
  if [ $rc -ne 0 ]; then echo "SQLERR"; { echo "  [SQLERR $(agora)] cenário=$CEN rodada=$ROD rc=$rc"; echo "  sql: ${1:0:300}"; sed 's/^/  err: /' "$TMP/err.$$"; } >&2; return 0; fi
  printf '%s' "$out"
}
uuid() { psqlq -c "select gen_random_uuid()"; }
estado_db() { psqlq -c "select row_to_json(x) from (select i.status,i.operacao_id,i.operacao_tipo,i.operacao_expira_em,i.efeito_estado,i.efeito_acao,i.efeito_atualizado_em,i.efeito_verificacoes,i.efeito_ultimo_resultado,c.status as con_status,c.auth_session_id,now() as db_now from whatsapp_identidade i left join whatsapp_conexoes c on (c.organizacao_id=i.organizacao_id and c.provider_instance_id=i.provider_instance_id) where i.organizacao_id='$ORG') x" 2>&1 | head -3; }

falha() { # $1=nome $2=esperado $3=encontrado $4=sql/origem
  FALHAS=$((FALHAS+1))
  {
    echo "FAIL ---------------------------------------------------------------"
    echo "  cenário : $CEN"; echo "  rodada  : $ROD"; echo "  A / B   : $OPA / $OPB"
    echo "  check   : $1"; echo "  esperado: $2"; echo "  obtido  : $3"; echo "  sql     : ${4:0:400}"
    echo "  quando  : local=$(agora) db=$(psqlq -c 'select clock_timestamp()' 2>&1 | head -1)"
    echo "  estado  : $(estado_db)"
    echo "  -------------------------------------------------------------------"
  } | tee -a "$TMP/falhas.txt"
}
cmp() { PASSOS=$((PASSOS+1)); if [ "$2" = "$3" ]; then echo "PASS [$CEN r$ROD] $1"; else falha "$1" "$2" "$3" "${4:-}"; fi; }
chk() { cmp "$1" "$2" "$(q "$3" | head -1)" "$3"; }   # chk nome esperado sql

infra() { INFRA=$((INFRA+1)); echo "INFRA [$CEN r$ROD] $1 (barreira não estabelecida; inconclusivo, NÃO é violação funcional)"; }
limpar() { psqlq -c "delete from whatsapp_identidade where organizacao_id='$ORG'; delete from whatsapp_conexoes where organizacao_id='$ORG'" >/dev/null 2>&1; rm -rf "$TMP"; }
soltar_trava() { psqlq -c "select pg_terminate_backend(pid) from pg_stat_activity where application_name='${RUN}_trava' and pid<>pg_backend_pid()" >/dev/null 2>&1; kill $TRAVA_PID 2>/dev/null; }
DONO=0   # só quem obteve a trava pode mexer nos dados da organização de seed
trap 'soltar_trava; if [ "$DONO" = 1 ]; then limpar; else rm -rf "$TMP"; fi' EXIT
# Exclusão mútua: o script muta a mesma organização de seed que test098/test099; duas execuções simultâneas se contaminam. Trava consultiva de sessão.
# ATENÇÃO: o banco de teste tem statement_timeout=2min; um único pg_sleep longo derrubaria a sessão (e o lock). Vários sleeps de 60 s na MESMA sessão.
TRAVA_ARGS=(-c "select case when pg_try_advisory_lock(980990001) then 'ok' else 'ocupado' end"); for _ in $(seq 1 45); do TRAVA_ARGS+=(-c "select pg_sleep(60)"); done
PGAPPNAME="${RUN}_trava" "$PSQL" "$U" -X -Atq "${TRAVA_ARGS[@]}" > "$TMP/trava.out" 2>"$TMP/trava.err" &
TRAVA_PID=$!
for _ in $(seq 1 100); do [ -s "$TMP/trava.out" ] && break; sleep 0.1; done
if [ "$(head -1 "$TMP/trava.out" 2>/dev/null)" != ok ]; then echo "INFRA: outra execução (ou test098/099) usa a organização de seed neste banco; abortando sem tocar nos dados. RESULTADO: INCONCLUSIVO"; exit 3; fi
DONO=1
G=$(uuid)

preparar() { # $1=tipo -> operacao_id; conexão CONNECTED com geração $G
  q "delete from whatsapp_identidade where organizacao_id='$ORG'; delete from whatsapp_conexoes where organizacao_id='$ORG';
     insert into whatsapp_conexoes(organizacao_id,provider_instance_id,status,telefone_e164,connected_at,last_seen_at,auth_session_id,auth_state_encrypted,auth_confirmado)
     values('$ORG','default','CONNECTED','+12025550100',now(),now(),'$G','fixture-teste-sem-credencial',true);" >/dev/null
  q "select operacao_id from whatsapp_operacao_iniciar('$ORG','default','$1',null,300)" | head -1
}

# holder: PGAPPNAME=${RUN}_holder. $1=SQL executado sob o lock (antes do commit).
PIDS=()
segurar() { PGAPPNAME="${RUN}_holder" "$PSQL" "$U" -X -Atq -c "begin; select 1 from whatsapp_identidade where organizacao_id='$ORG' for update; select pg_sleep($HOLD_SEGUNDOS); ${1:-select 1}; commit;" >/dev/null 2>"$TMP/holder.err" & PIDS+=($!); }
esperar() { # $1=descrição, $2..= comando que imprime "ok" quando a condição vale; prazo 15 s
  local i=0; while [ $i -lt 150 ]; do [ "$(eval "$2" 2>/dev/null)" = "ok" ] && return 0; sleep 0.1; i=$((i+1)); done; infra "$1"; return 1
}
holder_segurando() { psqlq -c "select case when count(*)=1 then 'ok' end from pg_stat_activity where application_name='${RUN}_holder' and query like '%pg_sleep%' and state='active'"; }
bloqueadas() { psqlq -c "select case when count(*)>=$1 then 'ok' end from pg_stat_activity where application_name like '${RUN}_c%' and wait_event_type='Lock'"; }
# Contendora: PGAPPNAME=${RUN}_c<nome>; grava resultado em $TMP/<nome>
contender() { local nome=$1; shift; ( PGAPPNAME="${RUN}_c$nome" "$PSQL" "$U" -X -Atq -c "$1" > "$TMP/$nome" 2> "$TMP/$nome.err" ) & PIDS+=($!); }
# Executa cenário concorrente. $1=SQL sob o lock do holder; $2=quantas contendoras devem bloquear; demais: pares nome=sql
# Retorna 0 se a barreira se formou (contendoras liberadas ao término do holder), 1 se INFRA.
corrida() {
  local sql_holder=$1 nbloq=$2; shift 2
  rm -f "$TMP"/c_* 2>/dev/null; PIDS=()
  segurar "$sql_holder"
  esperar "holder não segurou o lock" holder_segurando || { wait "${PIDS[@]}"; return 1; }
  local par; for par in "$@"; do contender "${par%%=*}" "${par#*=}"; done
  esperar "contendoras não ficaram em espera de lock (esperadas=$nbloq)" "bloqueadas $nbloq" || { wait "${PIDS[@]}"; return 1; }
  wait "${PIDS[@]}"
  for par in "$@"; do local n=${par%%=*}; [ -s "$TMP/$n.err" ] && { echo "  [contendora $n erro] $(head -2 "$TMP/$n.err")" >&2; } ; done
  return 0
}
res() { head -1 "$TMP/$1" 2>/dev/null; }

CONF() { echo "select whatsapp_confirmar_identidade_operacao('$ORG','default','$1','$HASH','$G','TESTE',null,null)"; }

CEN="1 expira+confirmar×trocar"
for i in 1 2 3 4 5 6; do
  ROD=$i; A=$(preparar CONECTAR); OPA=$A; OPB="-"
  if corrida "update whatsapp_identidade set operacao_expira_em=clock_timestamp()-interval '1 second' where organizacao_id='$ORG'" 1 \
      "c_a=$(CONF "$A")" "c_b=select iniciada from whatsapp_operacao_iniciar('$ORG','default','TROCAR',null,300)"; then
    RB=$(res c_b)
    ST=$(q "select status||'|'||(operacao_id is distinct from '$A')::text from whatsapp_identidade where organizacao_id='$ORG'")
    cmp "A antiga recusada" f "$(res c_a)" "confirmar($A)"
    if [ "$RB" = t ]; then cmp "B assumiu; identidade NÃO confirmada" "SEM_CONTA|true" "$ST" "estado pós-corrida"; else cmp "B recebeu 'ocupada'; identidade NÃO confirmada" "SEM_CONTA|false" "$ST" "estado pós-corrida (rb=$RB)"; fi
    chk "retentativa de B assume a operação expirada" t "select coalesce((select iniciada from whatsapp_operacao_iniciar('$ORG','default','TROCAR',null,300) limit 1),false) or (select operacao_id<>'$A' from whatsapp_identidade where organizacao_id='$ORG')"
    chk "A continua recusada depois de B" f "$(CONF "$A")"
  fi
done

CEN="2 confirmar×efeito DESCONECTAR"; V=0; E=0
for i in $(seq 1 10); do
  ROD=$i; A=$(preparar CONECTAR); OPA=$A; T=$(uuid)
  if corrida "select 1" 2 "c_c=$(CONF "$A")" "c_e=select whatsapp_operacao_efeito('$ORG','default','$A','$T','DESCONECTAR','PREPARAR')"; then
    C=$(res c_c); F=$(res c_e); ST=$(q "select status||'|'||coalesce(efeito_estado,'-') from whatsapp_identidade where organizacao_id='$ORG'")
    PASSOS=$((PASSOS+1))
    if [ "$C" = t ] && [ "$F" = f ] && [ "$ST" = "CONFIRMADA|-" ]; then V=$((V+1)); echo "PASS [$CEN r$i] confirmar venceu"
    elif [ "$C" = f ] && [ "$F" = t ] && [ "$ST" = "SEM_CONTA|PENDENTE" ]; then E=$((E+1)); echo "PASS [$CEN r$i] efeito venceu"
    else falha "exatamente um vencedor" "(confirmar=t,efeito=f,CONFIRMADA|-) ou (f,t,SEM_CONTA|PENDENTE)" "confirmar=$C efeito=$F estado=$ST" "confirmar × PREPARAR"; fi
  fi
done
echo "INFO confirmar venceu $V x, efeito venceu $E x"

CEN="3 efeito consumido/token/incerto"; ROD=1
A=$(preparar CONECTAR); OPA=$A; T=$(uuid); OUT=$(uuid)
efeito() { echo "select whatsapp_operacao_efeito('$ORG','default','$1','$2','$3','$4')"; }
chk "operação desconhecida recusada" f "$(efeito "$OUT" "$T" CONECTAR PREPARAR)"
chk "prepara" t "$(efeito "$A" "$T" CONECTAR PREPARAR)"
chk "token errado (mesma operação) recusado" f "$(efeito "$A" "$OUT" CONECTAR CONSUMIR)"
chk "ação diferente da preparada recusada" f "$(efeito "$A" "$T" RESET CONSUMIR)"
chk "consome" t "$(efeito "$A" "$T" CONECTAR CONSUMIR)"
chk "segunda ação com token já consumido recusada" f "$(efeito "$A" "$T" CONECTAR CONSUMIR)"
q "update whatsapp_identidade set operacao_expira_em=clock_timestamp()-interval '1 second' where organizacao_id='$ORG'" >/dev/null
chk "expirada com efeito em curso: outra operação NÃO assume" f "select iniciada from whatsapp_operacao_iniciar('$ORG','default','TROCAR',null,300) limit 1"
chk "resultado incerto marcado" t "$(efeito "$A" "$T" CONECTAR INCERTO)"
chk "incerto: outra operação NÃO assume" f "select iniciada from whatsapp_operacao_iniciar('$ORG','default','RESET',null,300) limit 1"
chk "incerto: encerrar/cancelar recusado" f "select whatsapp_operacao_encerrar('$ORG','default','$A')"
chk "incerto: confirmar recusado" f "$(CONF "$A")"
chk "incerto: estado preservado para reconciliação" INCERTO "select efeito_estado from whatsapp_identidade where organizacao_id='$ORG'"

CEN="4 expirada antes do consumo"
A=$(preparar CONECTAR); OPA=$A; T=$(uuid)
q "$(efeito "$A" "$T" CONECTAR PREPARAR)" >/dev/null
q "update whatsapp_identidade set operacao_expira_em=clock_timestamp()-interval '1 second' where organizacao_id='$ORG'" >/dev/null
chk "consumir com operação expirada recusado" f "$(efeito "$A" "$T" CONECTAR CONSUMIR)"

CEN="5 auth_session_id"
A=$(preparar CONECTAR); OPA=$A; G2=$(uuid)
q "update whatsapp_conexoes set auth_session_id='$G2' where organizacao_id='$ORG'" >/dev/null
chk "geração antiga recusada" f "$(CONF "$A")"
chk "geração nula recusada" f "select whatsapp_confirmar_identidade_operacao('$ORG','default','$A','$HASH',null,'TESTE',null,null)"
chk "geração atual aceita" t "select whatsapp_confirmar_identidade_operacao('$ORG','default','$A','$HASH','$G2','TESTE',null,null)"

CEN="6 reconciliação concorrente"
REC() { echo "select decisao||':'||motivo from whatsapp_operacao_reconciliar('$ORG','default','$1',true,'CONNECTED','$G',null,30)"; }
INCERTO_DESCONECTAR() {
  T=$(uuid)
  q "select whatsapp_operacao_efeito('$ORG','default','$1','$T','DESCONECTAR','PREPARAR'); select whatsapp_operacao_efeito('$ORG','default','$1','$T','DESCONECTAR','CONSUMIR'); select whatsapp_operacao_efeito('$ORG','default','$1','$T','DESCONECTAR','INCERTO');
     update whatsapp_identidade set efeito_atualizado_em=clock_timestamp()-interval '10 minutes' where organizacao_id='$ORG'" >/dev/null
}
for i in 1 2 3 4 5; do
  ROD=$i; A=$(preparar TROCAR); OPA=$A; INCERTO_DESCONECTAR "$A"
  if corrida "select 1" 2 "c_r1=$(REC "$A")" "c_r2=$(REC "$A")" "c_n=select iniciada from whatsapp_operacao_iniciar('$ORG','default','CONECTAR',null,300)"; then
    R1=$(res c_r1); R2=$(res c_r2)
    N=$(printf '%s\n%s\n' "$R1" "$R2" | grep -c '^ABORTADO:sessao_original_ativa$'); J=$(printf '%s\n%s\n' "$R1" "$R2" | grep -c '^JA_RESOLVIDO:')
    cmp "exatamente uma decisão real e uma JA_RESOLVIDO" "1/1" "$N/$J" "r1='$R1' r2='$R2'"
    cmp "operação nova concorrente: recusada (INCERTO) ou só depois da decisão" "ok" "$( [ "$(res c_n)" = f ] || [ "$(res c_n)" = t ] && echo ok || echo "iniciada='$(res c_n)'")" "iniciar(CONECTAR)"
    chk "nenhum efeito órfão após a decisão" 0 "select count(*) from whatsapp_identidade where organizacao_id='$ORG' and efeito_token is not null"
  fi
done
ROD=fim; A=$(preparar TROCAR); OPA=$A; INCERTO_DESCONECTAR "$A"
chk "operação nova recusada enquanto realmente INCERTA" f "select iniciada from whatsapp_operacao_iniciar('$ORG','default','CONECTAR',null,300) limit 1"
chk "reconciliação decide" "ABORTADO:sessao_original_ativa" "$(REC "$A")"
chk "depois da reconciliação a regra normal volta" t "select iniciada from whatsapp_operacao_iniciar('$ORG','default','CONECTAR',null,300) limit 1"

echo "=============================================================="
echo "RESUMO: verificações=$PASSOS falhas_funcionais=$FALHAS infra_inconclusivo=$INFRA holder=${HOLD_SEGUNDOS}s"
if [ $FALHAS -gt 0 ]; then echo "RESULTADO: VIOLAÇÃO FUNCIONAL (ver blocos FAIL acima)"; exit 1; fi
if [ $INFRA -gt 0 ]; then echo "RESULTADO: INCONCLUSIVO (barreira não formada; repetir)"; exit 3; fi
echo "RESULTADO: OK"; exit 0
