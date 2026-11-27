-- MOVA (27/11/2026): NOTIFICAÇÃO AUTOMÁTICA DE PAGAMENTO ao entregador + aviso consolidado no grupo financeiro + métricas de atendimento.
--
-- Arquitetura (Transactional Outbox "por leitura confirmada"): o fato é a LIQUIDAÇÃO persistida no Financeiro v2 (qualquer origem:
-- tela, comprovante no grupo, extrato, baixa agrupada, integração futura). O MOVA só lê fatos já confirmados (transação revertida
-- não deixa liquidação), grava aqui UM evento por baixa/destinatário (chave única) e só depois enfileira a mensagem. O estado
-- financeiro nunca depende do WhatsApp; o estado da mensagem (PENDENTE, ENFILEIRADO, ENVIADO, FALHOU...) é só deste módulo.
-- Nada é semeado e nenhuma automação é ligada aqui: sem ENTREGADORES_PAGAMENTO ativa na unidade nada é criado nem enviado.
-- Sem DELETE para o app (histórico auditável).

-- 1) Nova automação por unidade (liga/desliga e pausa individuais, como as demais).
alter table mova.automacao drop constraint automacao_nome_check;
alter table mova.automacao add constraint automacao_nome_check check (nome in ('ENTREGADORES_SEMANAL', 'ENTREGADORES_COBRANCA', 'RECONFERENCIA_EXTRATO', 'ENTREGADORES_RELATORIO', 'ENTREGADORES_AVISO_GRUPO', 'ENTREGADORES_PAGAMENTO'));

-- 2) Marco: a PRIMEIRA passada de uma unidade só fixa o instante; nada anterior vira mensagem (sem disparo retroativo).
create table mova.pagamento_marco (
  unidade_id      uuid primary key,
  organizacao_id  uuid not null,
  marco_em        timestamptz not null default now(),
  criado_em       timestamptz not null default now()
);
grant select, insert on mova.pagamento_marco to mova_app;
grant update (marco_em) on mova.pagamento_marco to mova_app; -- desligada/pausada: o marco acompanha o tempo (religar nao dispara o intervalo)

-- 3) Eventos de notificação (a "caixa de saída" persistente).
create table mova.notificacao_pagamento (
  id               uuid primary key default gen_random_uuid(),
  chave            text not null unique check (length(chave) between 10 and 300),   -- idempotência: fato + destinatário + tipo
  organizacao_id   uuid not null,
  unidade_id       uuid not null,
  entregador       text not null check (length(btrim(entregador)) between 1 and 200),
  destino          text not null check (destino in ('ENTREGADOR', 'GRUPO')),
  tipo             text not null check (tipo in ('PAGAMENTO', 'PAGAMENTO_PARCIAL', 'ESTORNO', 'AVISO_GRUPO')),
  -- PENDENTE: criado, ainda não enfileirado (pagamento com data futura nem chega a ser criado: espera a data) · AGUARDANDO_ENTREGADOR (só o aviso
  -- do grupo): espera o desfecho da mensagem do entregador · ENFILEIRADO: na fila de saída do MOVA · ENVIADO: o Gateway/WhatsApp
  -- aceitou a mensagem · FALHOU: desistência após as tentativas da fila · SEM_TELEFONE / SEM_GRUPO: sem destino cadastrado/autorizado.
  -- Não existe "ENTREGUE": o MOVA ainda não recebe o recibo de entrega do Gateway (ver docs).
  estado           text not null default 'PENDENTE' check (estado in ('PENDENTE', 'AGUARDANDO_ENTREGADOR', 'ENFILEIRADO', 'ENVIADO', 'FALHOU', 'SEM_TELEFONE', 'SEM_GRUPO', 'CANCELADO')),
  evento_pai_id    uuid references mova.notificacao_pagamento (id),     -- aviso do grupo → evento do entregador
  dados            jsonb not null check (jsonb_typeof(dados) = 'object'),  -- retrato persistido do pagamento (a mensagem sai SÓ daqui)
  resposta_id      uuid references mova.resposta (id),                   -- mensagem atual na fila de saída
  tentativas_envio integer not null default 0 check (tentativas_envio between 0 and 20),
  reenvios         integer not null default 0 check (reenvios between 0 and 5),
  ultimo_erro      text check (ultimo_erro is null or length(ultimo_erro) <= 120),
  enviado_em       timestamptz,
  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now(),
  check ((estado = 'ENVIADO') = (enviado_em is not null))
);
create index notificacao_pagamento_unidade on mova.notificacao_pagamento (unidade_id, criado_em desc);
create index notificacao_pagamento_pendentes on mova.notificacao_pagamento (estado) where estado in ('PENDENTE', 'AGUARDANDO_ENTREGADOR', 'ENFILEIRADO');
comment on table mova.notificacao_pagamento is 'Caixa de saída das notificações financeiras: uma linha por fato de pagamento e destinatário (chave única). Texto composto só de dados persistidos.';

-- 4) Cada FATO (liquidação + natureza) entra em UM evento só — mesmo que a leitura rode duas vezes ou em duas instâncias.
create table mova.notificacao_pagamento_item (
  liquidacao_id    uuid not null,
  fato             text not null check (fato ~ '^(BAIXA|ESTORNO:[0-9]{1,12})$'),
  unidade_id       uuid not null,
  evento_id        uuid not null references mova.notificacao_pagamento (id),
  criado_em        timestamptz not null default now(),
  primary key (liquidacao_id, fato)
);
create index notificacao_pagamento_item_evento on mova.notificacao_pagamento_item (evento_id);

-- 5) Métricas de atendimento (sem texto de conversa, sem dado financeiro): quanto foi resolvido sem IA.
create table mova.atendimento_metrica (
  dia              date not null,
  unidade_id       uuid not null,
  via              text not null check (via in ('DETERMINISTICA', 'IA', 'FALHA', 'BLOQUEADA')),
  intencao         text not null check (intencao ~ '^[A-Z_]{2,40}$'),
  respostas        integer not null default 0 check (respostas >= 0),
  chamadas_ia      integer not null default 0 check (chamadas_ia >= 0),
  tokens_entrada   bigint not null default 0 check (tokens_entrada >= 0),
  tokens_saida     bigint not null default 0 check (tokens_saida >= 0),
  atualizado_em    timestamptz not null default now(),
  primary key (dia, unidade_id, via, intencao)
);

grant select, insert on mova.notificacao_pagamento, mova.notificacao_pagamento_item, mova.atendimento_metrica to mova_app;
grant update (estado, resposta_id, tentativas_envio, reenvios, ultimo_erro, enviado_em, atualizado_em) on mova.notificacao_pagamento to mova_app;
grant update (respostas, chamadas_ia, tokens_entrada, tokens_saida, atualizado_em) on mova.atendimento_metrica to mova_app;
