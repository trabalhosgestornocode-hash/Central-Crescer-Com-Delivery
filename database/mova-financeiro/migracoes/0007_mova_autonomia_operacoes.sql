-- MOVA — Agente 2 (Frente C): POLÍTICAS DE AUTONOMIA e OPERAÇÕES EXECUTADAS (idempotência, auditoria e reversão).
--
-- APLICAR SOMENTE no PostgreSQL local de teste / homologação até a publicação coordenada (COORDENACAO-AGENTES.md).
-- Sem política cadastrada o MOVA só PROPÕE. Nenhuma política é semeada aqui. Pagamento bancário não existe como operação.

create table mova.politica_autonomia (
  id               uuid primary key default gen_random_uuid(),
  operacao         text not null check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO')),
  organizacao_id   uuid not null,
  unidade_id       uuid,                                -- null = todas as unidades da empresa (a da unidade prevalece)
  nivel            text not null check (nivel in ('SOMENTE_PROPOR','APLICAR_COM_CONFIRMACAO','APLICAR_AUTOMATICO')),
  limite_centavos  bigint not null check (limite_centavos >= 0),
  responsavel      text not null check (length(btrim(responsavel)) between 1 and 120),
  motivo           text not null check (length(btrim(motivo)) between 10 and 500),
  vigente_de       date not null,
  vigente_ate      date check (vigente_ate is null or vigente_ate >= vigente_de),
  criada_por       uuid not null,
  criada_em        timestamptz not null default now(),
  revogada_em      timestamptz,
  revogada_por     uuid,
  check (nivel = 'SOMENTE_PROPOR' or limite_centavos > 0),
  check (not (nivel = 'APLICAR_AUTOMATICO' and operacao = 'CONTA_A_PAGAR')),
  check ((revogada_em is null) = (revogada_por is null))
);
-- Uma política ATIVA por (operação, empresa, unidade). Trocar = revogar a anterior e criar outra (o histórico fica).
create unique index politica_autonomia_ativa on mova.politica_autonomia (operacao, organizacao_id, coalesce(unidade_id, '00000000-0000-0000-0000-000000000000'::uuid)) where revogada_em is null;

-- Cada execução automática (ou confirmada) de uma proposta: chave única = idempotência; estado final auditável; reversão
-- pelo serviço oficial (estorno) por responsável autorizado, registrada aqui (nunca apaga).
create table mova.operacao_executada (
  id                     uuid primary key default gen_random_uuid(),
  chave                  text not null unique,
  proposta_id            uuid not null references mova.proposta(id),
  organizacao_id         uuid not null,
  unidade_id             uuid not null,
  operacao               text not null check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO')),
  nivel                  text not null check (nivel in ('APLICAR_COM_CONFIRMACAO','APLICAR_AUTOMATICO')),
  politica_id            uuid references mova.politica_autonomia(id),
  estado                 text not null check (estado in ('EXECUTANDO','EXECUTADA','FALHOU','REVERTIDA')),
  valor_centavos         bigint not null check (valor_centavos > 0),
  executada_por          uuid not null,             -- identidade operacional (automático) ou a pessoa que confirmou
  resultado              jsonb,
  motivo                 text,
  criada_em              timestamptz not null default now(),
  atualizada_em          timestamptz not null default now(),
  revertida_por          uuid,
  revertida_em           timestamptz,
  justificativa_reversao text check (justificativa_reversao is null or length(btrim(justificativa_reversao)) >= 10),
  check ((estado = 'REVERTIDA') = (revertida_em is not null))
);
create index operacao_executada_unidade on mova.operacao_executada (organizacao_id, unidade_id, criada_em desc);

-- Estado final não volta: EXECUTADA só vira REVERTIDA; REVERTIDA e FALHOU são finais (nova tentativa = nova chave).
create or replace function mova.operacao_transicao() returns trigger language plpgsql as $$
begin
  if old.estado in ('REVERTIDA','FALHOU') or not ((old.estado = 'EXECUTANDO' and new.estado in ('EXECUTADA','FALHOU')) or (old.estado = 'EXECUTADA' and new.estado = 'REVERTIDA')) then
    raise exception 'MOVA: operação % → % inválida.', old.estado, new.estado using errcode = 'MV006';
  end if;
  new.atualizada_em := now();
  return new;
end $$;
create trigger operacao_executada_transicao before update on mova.operacao_executada for each row execute function mova.operacao_transicao();

grant select, insert on mova.politica_autonomia to mova_app;
grant update (revogada_em, revogada_por) on mova.politica_autonomia to mova_app;
grant select, insert, update on mova.operacao_executada to mova_app;
