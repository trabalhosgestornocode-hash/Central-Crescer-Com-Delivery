-- MOVA — ATUALIZAÇÃO do schema `mova` em PRODUÇÃO (gerado por backend/scripts/mova/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como `postgres` numa ÚNICA transação, só com autorização específica. Qualquer falha desfaz tudo.
-- Já instaladas (conferidas por nome e sha256): 0001_mova_fundacao.sql, 0002_mova_operacao.sql, 0003_mova_homologacao_privada.sql, 0004_mova_controle_orcamento.sql, 0005_mova_grupos_reais.sql, 0006_mova_politica_resposta.sql, 0007_mova_autonomia_operacoes.sql, 0008_mova_entregadores_automacoes.sql, 0009_mova_baixa_documental.sql, 0010_mova_despesa_documental.sql, 0011_mova_entregadores_rotina.sql, 0012_mova_juros_documental.sql, 0013_mova_entregadores_cadastro.sql, 0014_mova_unidade_sem_grupo.sql, 0015_mova_pagadores_multiunidade.sql, 0016_mova_avisos_entregadores.sql, 0017_mova_conversa_contexto.sql, 0018_mova_orcamento_renovavel.sql, 0020_mova_core_propostas.sql, 0022_mova_orcamento_uso.sql, 0023_mova_politica_sangria.sql, 0024_mova_grupo_multiempresa.sql
-- Novas: 0025_mova_contas_relatadas_intercompany_avisos.sql, 0026_mova_entregador_notificacoes_pagamento.sql

do $$ begin
  if not exists (select 1 from pg_namespace where nspname = 'mova') then raise exception 'MOVA atualização: schema mova não existe — nada foi feito'; end if;
  if coalesce((select shobj_description(d.oid, 'pg_database') from pg_database d where d.datname = current_database()), '') like 'MOVA\_HOMOLOGACAO:%' then
    raise exception 'MOVA atualização: banco de HOMOLOGAÇÃO — nada foi feito';
  end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0001_mova_fundacao.sql' and sha256 = '1d4c349167cd023012a2878421a69785b2eeb7da56c6f08d10615e4e3d9180d8') then raise exception 'MOVA atualização: 0001_mova_fundacao.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0002_mova_operacao.sql' and sha256 = '5cdb1d34ae6435ea44d5bc8c36b93e9cf91ebb56e5d62396546f02ed0f5c1e0f') then raise exception 'MOVA atualização: 0002_mova_operacao.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0003_mova_homologacao_privada.sql' and sha256 = '9b090ae2228c673e7fcae0b4dd976e78641d1e580b1cbb6b64c72876d3697ed3') then raise exception 'MOVA atualização: 0003_mova_homologacao_privada.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0004_mova_controle_orcamento.sql' and sha256 = 'd8e3065c8d6603b5707b4b6399c014cfdd665cf13e77f6876fedbc1c135c0c00') then raise exception 'MOVA atualização: 0004_mova_controle_orcamento.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0005_mova_grupos_reais.sql' and sha256 = '2f16af94be7e7c0914fb2550465c6629470257b8aba1580c992e980dbc80a47d') then raise exception 'MOVA atualização: 0005_mova_grupos_reais.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0006_mova_politica_resposta.sql' and sha256 = '1ecdc2f473854479b10487eddb1d1d842683ff3d0cf63d486764a46818261113') then raise exception 'MOVA atualização: 0006_mova_politica_resposta.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0007_mova_autonomia_operacoes.sql' and sha256 = 'cb13d733182446a34947d1b781430af21f654d5bb0f62309aa3a568ae8f1979d') then raise exception 'MOVA atualização: 0007_mova_autonomia_operacoes.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0008_mova_entregadores_automacoes.sql' and sha256 = 'e66e9c662dbfd1c7ddd60092ff5cab082fa7dc230ca08da2524b46821feb6182') then raise exception 'MOVA atualização: 0008_mova_entregadores_automacoes.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0009_mova_baixa_documental.sql' and sha256 = 'b690cafc5aedd8e5bc553ca886690de5d6e61bc88b0f3c95881a725b9a3f2754') then raise exception 'MOVA atualização: 0009_mova_baixa_documental.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0010_mova_despesa_documental.sql' and sha256 = 'f3aab5fe0574e86779b873e263551ebb8577049e3c0d3f3b58e753b8f731673c') then raise exception 'MOVA atualização: 0010_mova_despesa_documental.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0011_mova_entregadores_rotina.sql' and sha256 = 'ff74849e1f40ea2f799ee3c8a5a5be8562bfebf9ecdbde59d6c9e24c3d2ee0ca') then raise exception 'MOVA atualização: 0011_mova_entregadores_rotina.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0012_mova_juros_documental.sql' and sha256 = 'eff9660cdfe1a5a1d969eb3a75e709b5d486a4df6d6e6bcd0555ee9cc8780bba') then raise exception 'MOVA atualização: 0012_mova_juros_documental.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0013_mova_entregadores_cadastro.sql' and sha256 = '6a4f9f8b4214a03602fa74ad573485a29a69056386882a6597310b71614dea3d') then raise exception 'MOVA atualização: 0013_mova_entregadores_cadastro.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0014_mova_unidade_sem_grupo.sql' and sha256 = '8c7631710233123f85a0c1cb2752dcbb115606be299269e68bb9294f631e203b') then raise exception 'MOVA atualização: 0014_mova_unidade_sem_grupo.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0015_mova_pagadores_multiunidade.sql' and sha256 = 'cbcd5e4421952a876fcd0b22ad8c0af582d757096baf3aface6ad43aefea5a96') then raise exception 'MOVA atualização: 0015_mova_pagadores_multiunidade.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0016_mova_avisos_entregadores.sql' and sha256 = '76b39b7b74f4b4284b87a07c52cc4a3761fe7f5f49b6950a44587f8a93c377dc') then raise exception 'MOVA atualização: 0016_mova_avisos_entregadores.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0017_mova_conversa_contexto.sql' and sha256 = 'b4950c5592e7e19a53fa2916e5b368272ea7712d4137799479349ec096eb9b69') then raise exception 'MOVA atualização: 0017_mova_conversa_contexto.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0018_mova_orcamento_renovavel.sql' and sha256 = '34c8aa11626450c39523155a0a5ed0b55dc60cf381aceb064c5d1a60371d0a87') then raise exception 'MOVA atualização: 0018_mova_orcamento_renovavel.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0020_mova_core_propostas.sql' and sha256 = '1b7bd5f36f302ec80af081f9f0a2c383ad4c4764d21315ec9967f6313f4a8bd8') then raise exception 'MOVA atualização: 0020_mova_core_propostas.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0022_mova_orcamento_uso.sql' and sha256 = '5bb150ede6656e4da81669299e1bc8dd61c0409cf53617f125498e4e71f758b9') then raise exception 'MOVA atualização: 0022_mova_orcamento_uso.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0023_mova_politica_sangria.sql' and sha256 = '7855261f01a9363397032937ea2dbf6cfb62a5f6cabedc2a5ffcda346c513631') then raise exception 'MOVA atualização: 0023_mova_politica_sangria.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if not exists (select 1 from mova.mova_migracao where nome = '0024_mova_grupo_multiempresa.sql' and sha256 = '441327e033f00fa8a032da0be652c747f45b509ebc3199ba0167a2ba4eff9c47') then raise exception 'MOVA atualização: 0024_mova_grupo_multiempresa.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if exists (select 1 from mova.mova_migracao where nome = '0025_mova_contas_relatadas_intercompany_avisos.sql') then raise exception 'MOVA atualização: 0025_mova_contas_relatadas_intercompany_avisos.sql já aplicada — nada foi feito'; end if;
  if exists (select 1 from mova.mova_migracao where nome = '0026_mova_entregador_notificacoes_pagamento.sql') then raise exception 'MOVA atualização: 0026_mova_entregador_notificacoes_pagamento.sql já aplicada — nada foi feito'; end if;
end $$;

-- ------------------------------------------------------------------------- 0025_mova_contas_relatadas_intercompany_avisos.sql (arquivo 3cbc7d7db7c79e6e159d309a950aa66071f2346dc4205538addfa81bd690209a)
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
insert into mova.mova_migracao (nome, sha256) values ('0025_mova_contas_relatadas_intercompany_avisos.sql', '3cbc7d7db7c79e6e159d309a950aa66071f2346dc4205538addfa81bd690209a');

-- ------------------------------------------------------------------------- 0026_mova_entregador_notificacoes_pagamento.sql (arquivo 20cd4a9e0005ed5610e18a506b1ee08b3c6c6c1935ebc8df465b06ba52fc2351)
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
insert into mova.mova_migracao (nome, sha256) values ('0026_mova_entregador_notificacoes_pagamento.sql', '20cd4a9e0005ed5610e18a506b1ee08b3c6c6c1935ebc8df465b06ba52fc2351');
