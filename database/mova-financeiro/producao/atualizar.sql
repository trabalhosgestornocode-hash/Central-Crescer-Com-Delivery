-- MOVA — ATUALIZAÇÃO do schema `mova` em PRODUÇÃO (gerado por backend/scripts/mova/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como `postgres` numa ÚNICA transação, só com autorização específica. Qualquer falha desfaz tudo.
-- Já instaladas (conferidas por nome e sha256): 0001_mova_fundacao.sql, 0002_mova_operacao.sql, 0003_mova_homologacao_privada.sql, 0004_mova_controle_orcamento.sql, 0005_mova_grupos_reais.sql, 0006_mova_politica_resposta.sql, 0007_mova_autonomia_operacoes.sql, 0008_mova_entregadores_automacoes.sql, 0009_mova_baixa_documental.sql, 0010_mova_despesa_documental.sql, 0011_mova_entregadores_rotina.sql, 0012_mova_juros_documental.sql, 0013_mova_entregadores_cadastro.sql, 0014_mova_unidade_sem_grupo.sql, 0015_mova_pagadores_multiunidade.sql, 0016_mova_avisos_entregadores.sql, 0017_mova_conversa_contexto.sql, 0018_mova_orcamento_renovavel.sql, 0020_mova_core_propostas.sql, 0022_mova_orcamento_uso.sql, 0023_mova_politica_sangria.sql, 0024_mova_grupo_multiempresa.sql, 0025_mova_contas_relatadas_intercompany_avisos.sql
-- Novas: 0026_mova_entregador_notificacoes_pagamento.sql, 0027_mova_fila_prioridade_limites.sql, 0028_mova_identidade_fiscal.sql

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
  if not exists (select 1 from mova.mova_migracao where nome = '0025_mova_contas_relatadas_intercompany_avisos.sql' and sha256 = '3cbc7d7db7c79e6e159d309a950aa66071f2346dc4205538addfa81bd690209a') then raise exception 'MOVA atualização: 0025_mova_contas_relatadas_intercompany_avisos.sql ausente ou com outro conteúdo — nada foi feito'; end if;
  if exists (select 1 from mova.mova_migracao where nome = '0026_mova_entregador_notificacoes_pagamento.sql') then raise exception 'MOVA atualização: 0026_mova_entregador_notificacoes_pagamento.sql já aplicada — nada foi feito'; end if;
  if exists (select 1 from mova.mova_migracao where nome = '0027_mova_fila_prioridade_limites.sql') then raise exception 'MOVA atualização: 0027_mova_fila_prioridade_limites.sql já aplicada — nada foi feito'; end if;
  if exists (select 1 from mova.mova_migracao where nome = '0028_mova_identidade_fiscal.sql') then raise exception 'MOVA atualização: 0028_mova_identidade_fiscal.sql já aplicada — nada foi feito'; end if;
end $$;

-- ------------------------------------------------------------------------- 0026_mova_entregador_notificacoes_pagamento.sql (arquivo 287bd901d7f3fc90c826a9d1832b7091cd2d6ca22845b90184cda4802cac3fee)
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
insert into mova.mova_migracao (nome, sha256) values ('0026_mova_entregador_notificacoes_pagamento.sql', '287bd901d7f3fc90c826a9d1832b7091cd2d6ca22845b90184cda4802cac3fee');

-- ------------------------------------------------------------------------- 0027_mova_fila_prioridade_limites.sql (arquivo a2052ce4517b25a5d9fc028d77342dc3a7178602398b9103ceda05510aa48cc0)
-- MOVA (28/11/2026): FILA DE SAÍDA COM PRIORIDADE, CATEGORIAS, VALIDADE, ADIAMENTO E LIMITES CONFIGURÁVEIS (sem deploy).
--
-- Reaproveita a fila persistente que já existe (mova.resposta é a caixa de saída: estado, tentativas, lease, id do provedor).
-- Não cria uma segunda fila. Acrescenta, por mensagem: categoria, prioridade, validade, liberação (adiamento) e escopo (empresa/unidade).
-- Atingir um limite NÃO descarta: a mensagem continua PENDENTE com `liberar_em` no futuro; só expira (EXPIRADA, visível e auditável)
-- depois da validade da sua prioridade. Os limites ficam em tabela (por empresa, unidade, grupo e finalidade) e cada mudança é auditada.
-- Nada é semeado: sem regras na tabela valem os limites padrão do código (2.000 / 100 / 500, reserva para a prioridade crítica).
-- Sem DELETE para o app. Aditiva e reversível (recuperacao/reverter-0027.sql).

-- 1) Colunas da fila (defaults compatíveis com o que já existia).
alter table mova.resposta add column categoria text not null default 'PROATIVA'
  check (categoria in ('RESPOSTA', 'ERRO', 'TRANSACIONAL', 'PROATIVA', 'ADMINISTRATIVA', 'ACOMPANHAMENTO', 'REENVIO'));
alter table mova.resposta add column prioridade smallint not null default 1 check (prioridade between 0 and 2);   -- 0 crítica · 1 alta · 2 normal
alter table mova.resposta add column valida_ate timestamptz;                                                      -- após isto: EXPIRADA (nunca some em silêncio)
alter table mova.resposta add column liberar_em timestamptz;                                                      -- adiada até este instante (limite, ritmo, circuito, backoff)
alter table mova.resposta add column motivo_adiamento text check (motivo_adiamento is null or length(motivo_adiamento) <= 60);
alter table mova.resposta add column adiamentos integer not null default 0 check (adiamentos >= 0);
alter table mova.resposta add column organizacao_id uuid;
alter table mova.resposta add column unidade_id uuid;

alter table mova.resposta drop constraint resposta_estado_check;
alter table mova.resposta add constraint resposta_estado_check check (estado in ('PENDENTE', 'ENVIANDO', 'ENVIADA', 'FALHOU', 'SUPRIMIDA', 'EXPIRADA'));

-- A fila é lida por prioridade e depois por ordem de criação, só do que já pode sair.
create index resposta_fila_prioridade on mova.resposta (prioridade, seq) where estado = 'PENDENTE';
create index resposta_envio_dia on mova.resposta (criada_em, categoria) where estado in ('ENVIADA', 'ENVIANDO');

grant update (categoria, prioridade, valida_ate, liberar_em, motivo_adiamento, adiamentos, organizacao_id, unidade_id) on mova.resposta to mova_app;

-- 2) Limites configuráveis. Escopos: GLOBAL ('*'), EMPRESA (organizacao_id), UNIDADE (unidade_id), GRUPO (jid do destino), FINALIDADE (categoria).
create table mova.limite_envio (
  id             uuid primary key default gen_random_uuid(),
  escopo         text not null check (escopo in ('GLOBAL', 'EMPRESA', 'UNIDADE', 'GRUPO', 'FINALIDADE')),
  chave          text not null check (length(chave) between 1 and 120 and (escopo <> 'GLOBAL' or chave = '*')),
  campo          text not null check (campo ~ '^[A-Za-z]{3,40}$'),
  valor          text not null check (length(valor) between 1 and 40),
  ativo          boolean not null default true,
  atualizado_por text not null check (length(atualizado_por) between 1 and 80),
  atualizado_em  timestamptz not null default now(),
  unique (escopo, chave, campo)
);
create table mova.limite_envio_historico (
  seq            bigint generated always as identity primary key,
  escopo         text not null,
  chave          text not null,
  campo          text not null,
  valor_antes    text,
  valor_depois   text,
  ativo_depois   boolean not null,
  ator           text not null,
  justificativa  text not null check (length(btrim(justificativa)) >= 10),
  em             timestamptz not null default now()
);
-- 3) Alertas de uso (70/85/95%) e de represamento: um por faixa/escopo/dia.
create table mova.alerta_envio (
  dia            date not null,
  tipo           text not null check (tipo in ('USO_DIARIO', 'USO_CONVERSA', 'REPRESAMENTO', 'CIRCUITO', 'EXPIRADA')),
  chave          text not null check (length(chave) between 1 and 160),
  faixa          integer not null default 0,
  detalhe        jsonb not null default '{}'::jsonb,
  criado_em      timestamptz not null default now(),
  primary key (dia, tipo, chave, faixa)
);

grant select, insert on mova.limite_envio, mova.limite_envio_historico, mova.alerta_envio to mova_app;
grant update (valor, ativo, atualizado_por, atualizado_em) on mova.limite_envio to mova_app;
grant usage on all sequences in schema mova to mova_app;
comment on table mova.limite_envio is 'Limites de envio do WhatsApp por escopo. Sem linhas valem os padrões do código. Cada alteração grava mova.limite_envio_historico.';
insert into mova.mova_migracao (nome, sha256) values ('0027_mova_fila_prioridade_limites.sql', 'a2052ce4517b25a5d9fc028d77342dc3a7178602398b9103ceda05510aa48cc0');

-- ------------------------------------------------------------------------- 0028_mova_identidade_fiscal.sql (arquivo 97bafe89946451a198229db2f0da87d235c5dc92af1ad7ad6209ce6f2d5b6781)
-- MOVA (28/11/2026): IDENTIDADE FISCAL APRENDIDA DAS NOTAS (sem cadastro manual).
--
-- O MOVA passa a guardar, internamente, quem é o prestador (CPF/CNPJ) de cada entregador, deduzido das notas que o Financeiro já tem
-- ligadas às obrigações. Nada é digitado por gestor ou entregador; cada informação guarda a NOTA que a fundamentou (evidência).
--   identidade_fiscal            o prestador (CPF/CNPJ único) e o que se sabe dele (razão social, fantasia, município)
--   identidade_fiscal_vinculo    quem (unidade + entregador) usa esse prestador e em que situação (CONSOLIDADA | EM_REVISAO)
--   identidade_fiscal_evidencia  cada nota analisada: hash, número, chave, valor, tomador, avaliação FORTE/FRACA e motivos
--   identidade_fiscal_tomador    a empresa tomadora de cada unidade (configurada ou aprendida das notas aprovadas)
--   nota_leitura_fiscal          cache da leitura por hash: a mesma nota nunca é lida (nem paga em IA) duas vezes
-- Uma nota continua pertencendo SÓ à empresa tomadora da sua obrigação; o vínculo é por unidade. Sem DELETE para o app.
-- Aditiva e reversível (recuperacao/reverter-0028.sql). Não altera nenhum dado existente.

create table mova.identidade_fiscal (
  id uuid primary key default gen_random_uuid(),
  documento text not null unique check (documento ~ '^[0-9]{11}$' or documento ~ '^[0-9]{14}$'),
  tipo text not null check (tipo in ('CPF', 'CNPJ')),
  razao_social text check (razao_social is null or length(razao_social) <= 200),
  nome_fantasia text check (nome_fantasia is null or length(nome_fantasia) <= 200),
  municipio text check (municipio is null or length(municipio) <= 120),
  criada_em timestamptz not null default now(),
  atualizada_em timestamptz not null default now()
);

create table mova.identidade_fiscal_vinculo (
  id uuid primary key default gen_random_uuid(),
  identidade_id uuid references mova.identidade_fiscal (id),
  organizacao_id uuid not null,
  unidade_id uuid not null,
  entregador text not null check (length(entregador) between 1 and 200),
  situacao text not null check (situacao in ('CONSOLIDADA', 'EM_REVISAO')),
  motivo text check (motivo is null or length(motivo) <= 80),
  origem text not null check (origem in ('HISTORICO', 'PRIMEIRA_NOTA', 'NOTA_RECEBIDA', 'REVISAO_ADMINISTRATIVA')),
  candidatos text[] not null default '{}',   -- documentos em disputa (só quando EM_REVISAO)
  criada_em timestamptz not null default now(),
  atualizada_em timestamptz not null default now(),
  unique (unidade_id, entregador),
  check ((situacao = 'CONSOLIDADA') = (identidade_id is not null))
);
create index identidade_fiscal_vinculo_identidade on mova.identidade_fiscal_vinculo (identidade_id);
create index identidade_fiscal_vinculo_revisao on mova.identidade_fiscal_vinculo (organizacao_id) where situacao = 'EM_REVISAO';

create table mova.identidade_fiscal_evidencia (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null,
  unidade_id uuid not null,
  entregador text not null,
  semana_inicio date,
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),           -- a nota do Financeiro (histórico) pode não ter o hash do arquivo aqui
  documento_id uuid,
  chave_dedupe text not null check (length(chave_dedupe) between 5 and 100),   -- sha256 do arquivo ou 'doc:<id do documento>': uma nota, uma evidência por unidade
  numero text,
  chave_acesso text,
  prestador_documento text check (prestador_documento is null or prestador_documento ~ '^([0-9]{11}|[0-9]{14})$'),
  tomador_documento text check (tomador_documento is null or tomador_documento ~ '^([0-9]{11}|[0-9]{14})$'),
  valor_centavos bigint,
  competencia date,
  fonte text not null check (fonte in ('FINANCEIRO', 'XML', 'PDF_TEXTO', 'IA')),
  forca text not null check (forca in ('FORTE', 'FRACA')),
  motivos jsonb not null default '[]'::jsonb,
  criada_em timestamptz not null default now(),
  unique (unidade_id, chave_dedupe),
  check (sha256 is not null or documento_id is not null)
);
create index identidade_fiscal_evidencia_entregador on mova.identidade_fiscal_evidencia (unidade_id, entregador);
create index identidade_fiscal_evidencia_chave on mova.identidade_fiscal_evidencia (chave_acesso) where chave_acesso is not null;

create table mova.identidade_fiscal_tomador (
  unidade_id uuid primary key,
  organizacao_id uuid not null,
  documento text check (documento is null or documento ~ '^[0-9]{14}$'),
  situacao text not null check (situacao in ('CONFIGURADO', 'APRENDIDO', 'CONFLITO', 'EVIDENCIA_INSUFICIENTE')),
  notas integer not null default 0,
  entregadores integer not null default 0,
  atualizada_em timestamptz not null default now()
);

create table mova.nota_leitura_fiscal (
  sha256 text primary key check (sha256 ~ '^[0-9a-f]{64}$'),
  fonte text not null check (fonte in ('FINANCEIRO', 'XML', 'PDF_TEXTO', 'IA')),
  dados jsonb not null,
  chamadas_ia integer not null default 0,
  tokens_entrada integer not null default 0,
  tokens_saida integer not null default 0,
  criada_em timestamptz not null default now()
);

grant select, insert on mova.identidade_fiscal, mova.identidade_fiscal_vinculo, mova.identidade_fiscal_evidencia, mova.identidade_fiscal_tomador, mova.nota_leitura_fiscal to mova_app;
grant update (razao_social, nome_fantasia, municipio, atualizada_em) on mova.identidade_fiscal to mova_app;
grant update (identidade_id, situacao, motivo, origem, candidatos, atualizada_em) on mova.identidade_fiscal_vinculo to mova_app;
grant update (documento, situacao, notas, entregadores, atualizada_em) on mova.identidade_fiscal_tomador to mova_app;
insert into mova.mova_migracao (nome, sha256) values ('0028_mova_identidade_fiscal.sql', '97bafe89946451a198229db2f0da87d235c5dc92af1ad7ad6209ce6f2d5b6781');
