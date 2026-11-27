-- MOVA (26/11/2026; revisada 27/11): (1) operações CONTA_A_PAGAR_RELATADA (conta ÚNICA relatada, sem documento), CONTA_PARCELADA_RELATADA
-- (2 a 24 parcelas; limite sobre a compra inteira) — ambas pela ação estreita
-- `registrar_conta_parcelada` do Financeiro, migração 0033) e OPERACAO_ENTRE_EMPRESAS (pagamento feito por outra empresa do grupo;
-- ação `registrar_intercompany`, migração 0034) nas listas fechadas das POLÍTICAS e das EXECUÇÕES. Nenhuma política é semeada: sem
-- política o MOVA só PROPÕE (as políticas existentes — conta por boleto/nota, despesa paga — NÃO cobrem estas operações).
-- (2) AVISO DIÁRIO de contas a pagar no grupo (10h/15h, America/Fortaleza): UMA linha por grupo + data + janela (chave única) — a
-- idempotência sobrevive a reinício e a mais de uma instância. Só metadados (contagens/totais por unidade); nada de texto livre.
alter table mova.politica_autonomia drop constraint politica_autonomia_operacao_check;
alter table mova.politica_autonomia add constraint politica_autonomia_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL','DESPESA_DOCUMENTAL','JUROS_DOCUMENTAL','PRESTACAO_DE_SANGRIA',
                      'CONTA_A_PAGAR_RELATADA','CONTA_PARCELADA_RELATADA','OPERACAO_ENTRE_EMPRESAS'));
alter table mova.operacao_executada drop constraint operacao_executada_operacao_check;
alter table mova.operacao_executada add constraint operacao_executada_operacao_check
  check (operacao in ('BAIXA_POR_EXTRATO','DESPESA_PAGA','CONTA_A_PAGAR','ANEXAR_DOCUMENTO','BAIXA_DOCUMENTAL','DESPESA_DOCUMENTAL','JUROS_DOCUMENTAL','PRESTACAO_DE_SANGRIA',
                      'CONTA_A_PAGAR_RELATADA','CONTA_PARCELADA_RELATADA','OPERACAO_ENTRE_EMPRESAS'));
alter table mova.proposta drop constraint proposta_tipo_check;
alter table mova.proposta add constraint proposta_tipo_check
  check (tipo in ('BAIXA_DE_OBRIGACAO','DESPESA_PAGA','NOVA_OBRIGACAO','SOLICITACAO_DE_REVISAO','VINCULO_DE_DOCUMENTO','CONTA_RELATADA','INTERCOMPANY'));

create table mova.aviso_diario (
  id uuid primary key default gen_random_uuid(),
  grupo_jid text not null references mova.grupo_autorizado (grupo_jid),
  data date not null,
  janela text not null check (janela ~ '^[0-2][0-9]:[0-5][0-9]$'),
  -- ENVIADO = mensagem na fila de saída (mesma transação); SEM_MENSAGEM = janela conferida sem nada a dizer (ex.: 15h sem contas)
  situacao text not null default 'RESERVADO' check (situacao in ('RESERVADO', 'ENVIADO', 'SEM_MENSAGEM', 'FALHOU')),
  check ((situacao = 'ENVIADO') = (resposta_id is not null)),
  resumo jsonb not null default '{}'::jsonb check (jsonb_typeof(resumo) = 'object'),
  resposta_id uuid references mova.resposta (id),
  tentativas integer not null default 1 check (tentativas between 1 and 20),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (grupo_jid, data, janela)
);
comment on table mova.aviso_diario is 'Aviso diário de contas a pagar no grupo: uma linha por grupo/data/janela (idempotência). Sem texto livre.';
grant select, insert on mova.aviso_diario to mova_app;
grant update (situacao, resumo, resposta_id, tentativas, atualizado_em) on mova.aviso_diario to mova_app;
-- sem DELETE para o app (histórico do que foi avisado)
