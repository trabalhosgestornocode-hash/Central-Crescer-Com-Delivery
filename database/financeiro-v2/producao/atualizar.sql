-- Financeiro v2 — ATUALIZAÇÃO do schema financeiro_v2 (gerado por backend/scripts/fv2/pacoteProducao.mjs; NÃO editar à mão).
-- Aplicar como `postgres` (não superusuário), numa ÚNICA transação, só com autorização específica. Qualquer falha desfaz tudo.
-- Já instaladas (conferidas por nome e hash): 0001_fundacao.sql, 0002_importacoes.sql, 0003_concessoes.sql, 0004_formacao.sql, 0005_composicao_venda.sql, 0006_tesouraria.sql, 0007_saldo_referencia.sql, 0008_conferencias_indices.sql, 0009_configuracoes_fechamento.sql, 0010_auditoria_posicao_posterior.sql, 0011_sessao_banco_e_concessoes.sql, 0012_permissao_por_acao.sql, 0013_acoes_granulares.sql, 0014_reclassificacao.sql, 0015_indices_carga_por_competencia.sql, 0016_envio_de_evidencias.sql, 0017_indices_seletivos.sql, 0018_fechamento_ressalvas_baixa_extrato.sql, 0019_com_pendencias_sem_contorno.sql, 0020_baixa_antecipada.sql, 0021_liberacao_por_unidade.sql, 0022_abertura_da_unidade.sql
-- Novas: 0023_administracao_corporativa.sql, 0024_canais_e_operadoras.sql

do $$ declare n int; begin
  if not exists (select 1 from pg_namespace where nspname = 'financeiro_v2') then raise exception 'FV2 atualização: schema financeiro_v2 não existe — nada foi feito'; end if;
  if (select rolsuper from pg_roles where rolname = current_user) then raise exception 'FV2 atualização: não aplicar como superusuário'; end if;
  if exists (select 1 from pg_publication where puballtables) then raise exception 'FV2 atualização: existe publicação FOR ALL TABLES — nada foi feito'; end if;
  select count(*) into n from financeiro_v2.fv2_migracao;
  if n <> 22 then raise exception 'FV2 atualização: % migrações registradas (esperado 22) — nada foi feito', n; end if;
  select count(*) into n from financeiro_v2.fv2_migracao m join (values ('0001_fundacao.sql', 'ef5d9f835541d6fce2807109be1a5737813084bd94130f9714e5105b0e361427'), ('0002_importacoes.sql', 'd49d3b6bd531bf2d031e86a0ca0245a28632a6fa177017bcd4ff9433807c088a'), ('0003_concessoes.sql', 'a6e58f09056935eb2414f5d2119433e92e9919930eb88eb0e16acbd4bd076ec9'), ('0004_formacao.sql', 'ce5b6ecf822b69f86a4a6cd190d6dcad52c59ad33a0df0f07b398e9dd3d5b9bf'), ('0005_composicao_venda.sql', '8dbbc4296a95cc46648a38fb69ae407d5a41efdf5d1ced2c96c7f5bd408472d8'), ('0006_tesouraria.sql', 'f4170c545e077e9d44fcd03bb21aa0c3712ec0c154e5e54ef6bcc53d5a0232a8'), ('0007_saldo_referencia.sql', 'e27550c85b6b1d5195e1986e750aa944b64372e1690c8ab9481a634b48e6e21a'), ('0008_conferencias_indices.sql', '25042551aa6730531d8ce9a460ab64660ef95e8f71da4fb2228a53e8279c22e9'), ('0009_configuracoes_fechamento.sql', '7d986399161f897288d31772d6774f586c86ab29366e4dd4a330990fcc5e7e05'), ('0010_auditoria_posicao_posterior.sql', '45714c799f03d562136b1038b6a91809bd0414adc71a5fd2541784f2af4cf7f6'), ('0011_sessao_banco_e_concessoes.sql', 'f89aba0ad79f4bef458751ed0468d85f7bc9d850872a905e3ffb1a2cb2610c5d'), ('0012_permissao_por_acao.sql', 'cd0f8f8e3e2d05beaef02a7832ffd32765f5aa9ed1067208239c8f3b430f6fa2'), ('0013_acoes_granulares.sql', '23482b0a571c0f212470443dc1eae001c67dd70b3e4bb4aed96d5b2b489b22cc'), ('0014_reclassificacao.sql', '598cd8c434a5987747a58f64010a84642747b22a42ff54453f666924f5323e68'), ('0015_indices_carga_por_competencia.sql', '314227f5309c2bf0917d27d39b4dac8b31a1aa249220fdfee041f0721db1976a'), ('0016_envio_de_evidencias.sql', '161206c52160277c846fe32a8de0908bf177357561945df19ff73b3ae766a918'), ('0017_indices_seletivos.sql', '01666ecf61be707c262bde5867dce5380595d9a81a4226f5778e862d4ecf1926'), ('0018_fechamento_ressalvas_baixa_extrato.sql', '7a312af6949f039bb6ec7a21e8488f06eaf7dad7756a618e995334448daeaeec'), ('0019_com_pendencias_sem_contorno.sql', 'ca7d6fd943a640ce83afa8d96f79b70e6662e62d86fc5cb8bfaca05f49a629e1'), ('0020_baixa_antecipada.sql', '719f956225b03eb1a40b4a97c53a1803517bf5bd8e927ab3ffda10c4b54d3254'), ('0021_liberacao_por_unidade.sql', 'b24ed9c2e8f18e4f881f76d3e7e7f3d2bb3eec24637c1a40189e75073c1a4b64'), ('0022_abertura_da_unidade.sql', '43de10df4e73e9d53ecd01cc2607dd2629f8ec665a4fd2ca865ffcd819394a21')) v(nome, sha) on v.nome = m.nome and v.sha = m.sha256;
  if n <> 22 then raise exception 'FV2 atualização: migrações instaladas diferem do Git (nome/hash) — nada foi feito'; end if;
end $$;
set local search_path = financeiro_v2, pg_catalog;

-- ------------------------------------------------------------------------- 0023_administracao_corporativa.sql (arquivo ddc2d8b28694ea3b982114e879474e16d5041277d1f2b6f5653f48768e47ca23)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0023: ADMINISTRAÇÃO CORPORATIVA (ativação simples por unidade, sem atestante em cada uma)
--
-- Só é aplicada no PostgreSQL local isolado e, depois de autorizada, no schema dedicado. Não pertence a database/migrations/.
--
-- O que muda (e o que NÃO muda):
--   * NOVO papel de autoridade: ADMINISTRADOR FINANCEIRO CORPORATIVO (por empresa). Quem é administrador é decidido por
--     outro administrador corporativo; a PRIMEIRA pessoa de uma empresa só entra pelo procedimento de infraestrutura
--     (autoridade + segundo fator recente, uma única vez por empresa). Ser administrador da plataforma NÃO basta.
--   * Liberar/desligar unidades e conceder/revogar acessos financeiros passam a ser feitos pelo administrador
--     corporativo SEM segundo atestante e SEM segundo fator a cada ato (a autenticação da sessão e a verificação no
--     backend continuam). Tudo grava ator, justificativa e histórico imutáveis.
--   * Separa DISPONIBILIDADE (fv2_liberacao.ativa: a interface do v2 aparece) de ESCRITA (escrita_ativa: a unidade aceita
--     lançamentos). Padrão: escrita DESLIGADA; as linhas existentes (Açaí) ficam como estão.
--   * Ninguém concede a si mesmo (a regra de tabela concedido_por <> usuario_id continua valendo).
--   * Nada é apagado: só colunas novas, tabelas novas e funções novas. O histórico anterior permanece.
-- =====================================================================================================================

-- 1) Administradores corporativos ----------------------------------------------------------------------------------
create table fv2_administrador_corporativo (
  organizacao_id uuid not null,
  conta_id       uuid not null,               -- a conta pessoal (a mesma que liberação e MFA usam como ator)
  ativo          boolean not null,
  versao         integer not null default 1,
  alterado_em    timestamptz not null default clock_timestamp(),
  alterado_por   uuid not null,
  justificativa  text not null check (length(btrim(justificativa)) >= 20),
  primary key (organizacao_id, conta_id)
);
create table fv2_administrador_corporativo_historico (
  seq            bigint generated always as identity primary key,
  organizacao_id uuid not null,
  conta_id       uuid not null,
  ativo_antes    boolean,
  ativo_depois   boolean not null,
  ator           uuid not null,
  origem         text not null check (origem in ('INFRAESTRUTURA', 'ADMINISTRADOR_CORPORATIVO')),
  justificativa  text not null,
  segundo_fator_em timestamptz,
  papel_de_banco text not null default session_user,
  em             timestamptz not null default clock_timestamp()
);
create trigger fv2_administrador_historico_imutavel before update or delete on fv2_administrador_corporativo_historico for each row execute function fv2_liberacao_historico_imutavel();
revoke all on fv2_administrador_corporativo, fv2_administrador_corporativo_historico from public;
grant select, insert, update on fv2_administrador_corporativo to fv2_guardiao;
grant select, insert on fv2_administrador_corporativo_historico to fv2_guardiao;
alter table fv2_administrador_corporativo enable row level security;
alter table fv2_administrador_corporativo_historico enable row level security;
create policy fv2_administrador_guardiao on fv2_administrador_corporativo to fv2_guardiao using (true) with check (true);
create policy fv2_administrador_historico_guardiao on fv2_administrador_corporativo_historico to fv2_guardiao using (true) with check (true);

-- 2) Liberação: escrita por unidade ----------------------------------------------------------------------------------
alter table fv2_liberacao add column escrita_ativa boolean not null default false;
alter table fv2_liberacao_historico add column escrita_antes boolean;
alter table fv2_liberacao_historico add column escrita_depois boolean;
alter table fv2_liberacao_historico add column origem text not null default 'SEGUNDO_FATOR';
alter table fv2_liberacao_historico alter column segundo_fator_em drop not null;

-- 2b) O guardião (dono das funções acima) grava SÓ o histórico de CONCESSÃO — o mesmo que a aplicação grava no provisionamento.
grant select, insert on fv2_historico to fv2_guardiao;
create policy fv2_historico_guardiao on fv2_historico to fv2_guardiao using (registro_tipo = 'CONCESSAO') with check (registro_tipo = 'CONCESSAO');
alter policy fv2_historico_incluir on fv2_historico with check (
  (select fv2_tem_acao(array['financeiro_v2.registrar', 'financeiro_v2.corrigir', 'financeiro_v2.cancelar', 'financeiro_v2.conciliar',
    'financeiro_v2.fechar', 'financeiro_v2.homologar', 'financeiro_v2.revisar', 'financeiro_v2.configurar', 'financeiro_v2.importar',
    'financeiro_v2.conceder', 'financeiro_v2.documentos', 'financeiro_v2.aprovar', 'financeiro_v2.aplicar', 'financeiro_v2.revogar',
    'financeiro_v2.confirmar_importacao', 'financeiro_v2.reabrir', 'financeiro_v2.reclassificar', 'financeiro_v2.enviar_documento',
    'financeiro_v2.vincular_pagamento']))
  or ((select fv2_em_provisionamento()) and registro_tipo = 'CONCESSAO')
  or (current_user = 'fv2_guardiao' and registro_tipo = 'CONCESSAO'));

-- 3) Auditoria de concessão sem sessão de banco (o ato do administrador corporativo não abre sessão) ---------------------
alter table fv2_auditoria_concessao alter column sessao_id drop not null;

-- 4) Funções ---------------------------------------------------------------------------------------------------------
create or replace function fv2_administrador_corporativo_ativo(p_organizacao uuid, p_conta uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
  select coalesce((select a.ativo from fv2_administrador_corporativo a where a.organizacao_id = p_organizacao and a.conta_id = p_conta), false)
$$;

-- Define (liga/desliga) um administrador corporativo.
--   * se a empresa JÁ tem administrador ativo: só outro administrador ativo faz (origem ADMINISTRADOR_CORPORATIVO), sem
--     segundo fator a cada ato; ninguém altera a si mesmo;
--   * se NÃO tem nenhum: só pelo procedimento de infraestrutura, com segundo fator recente do ator (uma vez por empresa).
create or replace function fv2_administrador_corporativo_definir(p_organizacao uuid, p_conta uuid, p_ativo boolean, p_ator uuid, p_justificativa text, p_segundo_fator_em timestamptz)
returns integer language plpgsql security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
declare
  antes boolean;
  v integer;
  origem text;
  tem_ativo boolean;
begin
  if p_organizacao is null or p_conta is null or p_ator is null or p_ativo is null then
    raise exception 'Financeiro v2: administrador corporativo exige empresa, conta, ator e estado.' using errcode = 'FV042';
  end if;
  if length(btrim(coalesce(p_justificativa, ''))) < 20 then
    raise exception 'Financeiro v2: administrador corporativo exige justificativa (mínimo 20 caracteres).' using errcode = 'FV042';
  end if;
  if not exists (select 1 from fv2_escopo e where e.organizacao_id = p_organizacao) then
    raise exception 'Financeiro v2: empresa fora dos escopos do banco financeiro.' using errcode = 'FV042';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('fv2_administrador_corporativo:' || p_organizacao::text, 0));
  select exists (select 1 from fv2_administrador_corporativo a where a.organizacao_id = p_organizacao and a.ativo) into tem_ativo;
  if tem_ativo then
    if p_ator = p_conta then
      raise exception 'Financeiro v2: ninguém altera a própria condição de administrador corporativo.' using errcode = 'FV043';
    end if;
    if not coalesce((select a.ativo from fv2_administrador_corporativo a where a.organizacao_id = p_organizacao and a.conta_id = p_ator), false) then
      raise exception 'Financeiro v2: só um administrador corporativo ativo altera administradores.' using errcode = 'FV043';
    end if;
    if not p_ativo and (select count(*) from fv2_administrador_corporativo a where a.organizacao_id = p_organizacao and a.ativo and a.conta_id <> p_conta) = 0 then
      raise exception 'Financeiro v2: a empresa não pode ficar sem administrador corporativo.' using errcode = 'FV043';
    end if;
    origem := 'ADMINISTRADOR_CORPORATIVO';
  else
    if not p_ativo then
      raise exception 'Financeiro v2: não há administrador corporativo ativo para desligar.' using errcode = 'FV043';
    end if;
    if p_segundo_fator_em is null or p_segundo_fator_em < clock_timestamp() - interval '10 minutes' or p_segundo_fator_em > clock_timestamp() + interval '1 minute' then
      raise exception 'Financeiro v2: o primeiro administrador corporativo exige segundo fator recente (10 minutos).' using errcode = 'FV043';
    end if;
    origem := 'INFRAESTRUTURA';
  end if;
  select a.ativo into antes from fv2_administrador_corporativo a where a.organizacao_id = p_organizacao and a.conta_id = p_conta for update;
  if found then
    update fv2_administrador_corporativo set ativo = p_ativo, versao = versao + 1, alterado_em = clock_timestamp(), alterado_por = p_ator, justificativa = p_justificativa
     where organizacao_id = p_organizacao and conta_id = p_conta returning versao into v;
  else
    insert into fv2_administrador_corporativo (organizacao_id, conta_id, ativo, alterado_por, justificativa) values (p_organizacao, p_conta, p_ativo, p_ator, p_justificativa) returning versao into v;
  end if;
  insert into fv2_administrador_corporativo_historico (organizacao_id, conta_id, ativo_antes, ativo_depois, ator, origem, justificativa, segundo_fator_em)
  values (p_organizacao, p_conta, antes, p_ativo, p_ator, origem, p_justificativa, case when origem = 'INFRAESTRUTURA' then p_segundo_fator_em end);
  return v;
end $$;

-- Estado de liberação passa a informar também a ESCRITA (mudou o tipo de retorno: recria).
drop function if exists fv2_liberacao_estado(uuid, uuid);
create function fv2_liberacao_estado(p_organizacao uuid, p_unidade uuid)
returns table (empresa boolean, unidade boolean, escrita boolean) language sql stable security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
  with e as (select coalesce((select l.ativa from fv2_liberacao l where l.organizacao_id = p_organizacao and l.unidade_id is null), false) as ativa),
       u as (select l.ativa, l.escrita_ativa from fv2_liberacao l where l.organizacao_id = p_organizacao and l.unidade_id = p_unidade)
  select e.ativa,
         e.ativa and coalesce((select u.ativa from u), false),
         e.ativa and coalesce((select u.ativa and u.escrita_ativa from u), false)
    from e
$$;
alter function fv2_liberacao_estado(uuid, uuid) owner to fv2_guardiao;
revoke all on function fv2_liberacao_estado(uuid, uuid) from public;
grant execute on function fv2_liberacao_estado(uuid, uuid) to fv2_app, fv2_autoridade;

-- Liberação EM LOTE pelo administrador corporativo (uma chamada, várias unidades, uma transação).
--   p_escrita null = não mexe na escrita; true/false = define. Ligar a escrita exige a unidade ligada.
create or replace function fv2_liberacao_alterar_lote(p_organizacao uuid, p_unidades uuid[], p_ativa boolean, p_escrita boolean, p_ator uuid, p_justificativa text)
returns integer language plpgsql security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
declare
  u uuid;
  antes boolean;
  esc_antes boolean;
  esc_depois boolean;
  n integer := 0;
begin
  if p_organizacao is null or p_ator is null or p_ativa is null or p_unidades is null or coalesce(array_length(p_unidades, 1), 0) = 0 then
    raise exception 'Financeiro v2: liberação em lote exige empresa, ator, estado e unidades.' using errcode = 'FV042';
  end if;
  if array_length(p_unidades, 1) > 50 then
    raise exception 'Financeiro v2: lote de liberação limitado a 50 unidades.' using errcode = 'FV042';
  end if;
  if length(btrim(coalesce(p_justificativa, ''))) < 20 then
    raise exception 'Financeiro v2: liberação exige justificativa (mínimo 20 caracteres).' using errcode = 'FV042';
  end if;
  if not fv2_administrador_corporativo_ativo(p_organizacao, p_ator) then
    raise exception 'Financeiro v2: só o administrador financeiro corporativo libera unidades.' using errcode = 'FV043';
  end if;
  if (not p_ativa) and coalesce(p_escrita, false) then
    raise exception 'Financeiro v2: unidade desligada não pode ficar com escrita ligada.' using errcode = 'FV042';
  end if;
  -- a empresa precisa estar ligada (a linha da empresa é criada junto, na primeira vez)
  if p_ativa then
    select l.ativa into antes from fv2_liberacao l where l.organizacao_id = p_organizacao and l.unidade_id is null for update;
    if not found then
      insert into fv2_liberacao (organizacao_id, unidade_id, ativa, alterada_por, justificativa) values (p_organizacao, null, true, p_ator, p_justificativa);
      insert into fv2_liberacao_historico (organizacao_id, unidade_id, ativa_antes, ativa_depois, ator, justificativa, segundo_fator_em, origem, escrita_depois)
      values (p_organizacao, null, null, true, p_ator, p_justificativa, null, 'ADMINISTRADOR_CORPORATIVO', false);
    elsif not antes then
      update fv2_liberacao set ativa = true, versao = versao + 1, alterada_em = clock_timestamp(), alterada_por = p_ator, justificativa = p_justificativa
       where organizacao_id = p_organizacao and unidade_id is null;
      insert into fv2_liberacao_historico (organizacao_id, unidade_id, ativa_antes, ativa_depois, ator, justificativa, segundo_fator_em, origem)
      values (p_organizacao, null, false, true, p_ator, p_justificativa, null, 'ADMINISTRADOR_CORPORATIVO');
    end if;
  end if;
  foreach u in array p_unidades loop
    if u is null or not exists (select 1 from fv2_escopo e where e.organizacao_id = p_organizacao and e.unidade_id = u) then
      raise exception 'Financeiro v2: unidade fora dos escopos do banco financeiro.' using errcode = 'FV042';
    end if;
    select l.ativa, l.escrita_ativa into antes, esc_antes from fv2_liberacao l where l.organizacao_id = p_organizacao and l.unidade_id = u for update;
    esc_depois := case when not p_ativa then false when p_escrita is null then coalesce(esc_antes, false) else p_escrita end;
    if found then
      update fv2_liberacao set ativa = p_ativa, escrita_ativa = esc_depois, versao = versao + 1, alterada_em = clock_timestamp(), alterada_por = p_ator, justificativa = p_justificativa
       where organizacao_id = p_organizacao and unidade_id = u;
    else
      insert into fv2_liberacao (organizacao_id, unidade_id, ativa, escrita_ativa, alterada_por, justificativa) values (p_organizacao, u, p_ativa, esc_depois, p_ator, p_justificativa);
    end if;
    insert into fv2_liberacao_historico (organizacao_id, unidade_id, ativa_antes, ativa_depois, ator, justificativa, segundo_fator_em, origem, escrita_antes, escrita_depois)
    values (p_organizacao, u, antes, p_ativa, p_ator, p_justificativa, null, 'ADMINISTRADOR_CORPORATIVO', esc_antes, esc_depois);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Concessão pelo administrador corporativo: acrescenta/retira ações de UMA pessoa em UMA unidade da empresa.
--   * ator = conta do administrador corporativo ativo; beneficiário = pessoa operacional (perfil) ≠ ator (sem autoconcessão);
--   * p_acoes vazio = revoga (situação REVOGADA); ações só do catálogo financeiro_v2.*;
--   * grava a auditoria de concessão (finalidade ADMINISTRACAO_CORPORATIVA) e encerra as sessões de banco do beneficiário.
create or replace function fv2_conceder_por_administrador(p_organizacao uuid, p_unidade uuid, p_usuario uuid, p_acoes jsonb, p_ator_conta uuid, p_ator_perfil uuid, p_justificativa text)
returns integer language plpgsql security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
declare
  atual fv2_concessao;
  v_acoes jsonb;
  v_situacao text;
  v integer;
  novo_id uuid;
begin
  if p_organizacao is null or p_unidade is null or p_usuario is null or p_ator_conta is null or p_ator_perfil is null then
    raise exception 'Financeiro v2: concessão exige empresa, unidade, beneficiário e ator.' using errcode = 'FV030';
  end if;
  if p_usuario = p_ator_perfil or p_usuario = p_ator_conta then
    raise exception 'Financeiro v2: ninguém concede nem revoga o próprio acesso.' using errcode = 'FV030';
  end if;
  if length(btrim(coalesce(p_justificativa, ''))) < 20 then
    raise exception 'Financeiro v2: concessão exige justificativa (mínimo 20 caracteres).' using errcode = 'FV030';
  end if;
  if jsonb_typeof(p_acoes) is distinct from 'array' then
    raise exception 'Financeiro v2: ações inválidas.' using errcode = 'FV030';
  end if;
  if not fv2_administrador_corporativo_ativo(p_organizacao, p_ator_conta) then
    raise exception 'Financeiro v2: só o administrador financeiro corporativo concede acessos por esta via.' using errcode = 'FV043';
  end if;
  if not exists (select 1 from fv2_escopo e where e.organizacao_id = p_organizacao and e.unidade_id = p_unidade) then
    raise exception 'Financeiro v2: unidade fora dos escopos do banco financeiro.' using errcode = 'FV030';
  end if;
  v_acoes := fv2__acoes_ordenadas(p_acoes);
  v_situacao := case when jsonb_array_length(v_acoes) > 0 then 'ATIVA' else 'REVOGADA' end;
  perform fv2__trava_concessoes(p_organizacao, p_unidade, true);
  select * into atual from fv2_concessao c where c.organizacao_id = p_organizacao and c.unidade_id = p_unidade and c.usuario_id = p_usuario;
  if atual.id is null then
    if v_situacao = 'REVOGADA' then
      return 0; -- nada a revogar
    end if;
    novo_id := gen_random_uuid();
    insert into fv2_concessao (id, organizacao_id, unidade_id, versao, criado_em, criado_por, atualizado_em, atualizado_por, chave_idempotencia, usuario_id, acoes, situacao, concedido_por, justificativa)
    values (novo_id, p_organizacao, p_unidade, 1, clock_timestamp(), p_ator_perfil, clock_timestamp(), p_ator_perfil, 'concessao:' || p_usuario::text, p_usuario, v_acoes, v_situacao, p_ator_perfil, btrim(p_justificativa));
    v := 1;
  else
    if atual.situacao = v_situacao and atual.acoes = v_acoes then
      return 0; -- sem mudança
    end if;
    update fv2_concessao c set versao = c.versao + 1, atualizado_em = clock_timestamp(), atualizado_por = p_ator_perfil, acoes = v_acoes, situacao = v_situacao,
           concedido_por = p_ator_perfil, justificativa = btrim(p_justificativa)
     where c.id = atual.id returning c.versao into v;
    novo_id := atual.id;
  end if;
  insert into fv2_historico (id, organizacao_id, unidade_id, registro_tipo, registro_id, evento, antes, depois, justificativa, usuario_id, em)
  values (gen_random_uuid(), p_organizacao, p_unidade, 'CONCESSAO', novo_id, case when atual.id is null then 'CRIACAO' else 'CORRECAO' end,
          case when atual.id is null then null else jsonb_build_object('versao', atual.versao, 'acoes', atual.acoes, 'situacao', atual.situacao) end,
          jsonb_build_object('versao', v, 'acoes', v_acoes, 'situacao', v_situacao), btrim(p_justificativa), p_ator_perfil, clock_timestamp());
  set constraints fv2_concessao_historico immediate;
  insert into fv2_auditoria_concessao (organizacao_id, unidade_id, concessao_id, usuario_alvo, ator, sessao_id, finalidade, operacao,
                                       acoes_antes, acoes_depois, situacao_depois, justificativa)
  values (p_organizacao, p_unidade, novo_id, p_usuario, p_ator_perfil, null, 'ADMINISTRACAO_CORPORATIVA',
          case when v_situacao = 'REVOGADA' then 'REVOGACAO' when atual.id is null then 'CONCESSAO' else 'CONCESSAO_E_REVOGACAO' end,
          case when atual.id is not null and atual.situacao = 'ATIVA' then atual.acoes else '[]'::jsonb end, v_acoes, v_situacao, btrim(p_justificativa));
  update fv2_sessao_banco b set revogada_em = clock_timestamp(), motivo_revogacao = 'concessão alterada pelo administrador corporativo'
   where b.usuario_id = p_usuario and b.organizacao_id = p_organizacao and b.unidade_id = p_unidade and b.revogada_em is null;
  return v;
end $$;

alter function fv2_administrador_corporativo_ativo(uuid, uuid) owner to fv2_guardiao;
alter function fv2_administrador_corporativo_definir(uuid, uuid, boolean, uuid, text, timestamptz) owner to fv2_guardiao;
alter function fv2_liberacao_alterar_lote(uuid, uuid[], boolean, boolean, uuid, text) owner to fv2_guardiao;
alter function fv2_conceder_por_administrador(uuid, uuid, uuid, jsonb, uuid, uuid, text) owner to fv2_guardiao;
revoke all on function fv2_administrador_corporativo_ativo(uuid, uuid) from public;
revoke all on function fv2_administrador_corporativo_definir(uuid, uuid, boolean, uuid, text, timestamptz) from public;
revoke all on function fv2_liberacao_alterar_lote(uuid, uuid[], boolean, boolean, uuid, text) from public;
revoke all on function fv2_conceder_por_administrador(uuid, uuid, uuid, jsonb, uuid, uuid, text) from public;
grant execute on function fv2_administrador_corporativo_ativo(uuid, uuid) to fv2_autoridade;
grant execute on function fv2_administrador_corporativo_definir(uuid, uuid, boolean, uuid, text, timestamptz) to fv2_autoridade;
grant execute on function fv2_liberacao_alterar_lote(uuid, uuid[], boolean, boolean, uuid, text) to fv2_autoridade;
grant execute on function fv2_conceder_por_administrador(uuid, uuid, uuid, jsonb, uuid, uuid, text) to fv2_autoridade;

-- Leituras para o painel do administrador corporativo (só ele lê; nenhum dado financeiro, só liberação e acessos).
create or replace function fv2_painel_liberacoes(p_organizacao uuid, p_ator uuid)
returns table (unidade_id uuid, rotulo text, ativa boolean, escrita_ativa boolean, empresa_ativa boolean) language plpgsql stable security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
begin
  if not fv2_administrador_corporativo_ativo(p_organizacao, p_ator) then
    raise exception 'Financeiro v2: só o administrador financeiro corporativo vê o painel de ativação.' using errcode = 'FV043';
  end if;
  return query
    select e.unidade_id, e.rotulo, coalesce(l.ativa, false), coalesce(l.ativa, false) and coalesce(l.escrita_ativa, false),
           coalesce((select x.ativa from fv2_liberacao x where x.organizacao_id = p_organizacao and x.unidade_id is null), false)
      from fv2_escopo e left join fv2_liberacao l on l.organizacao_id = e.organizacao_id and l.unidade_id = e.unidade_id
     where e.organizacao_id = p_organizacao order by e.rotulo;
end $$;

create or replace function fv2_painel_acessos(p_organizacao uuid, p_unidade uuid, p_ator uuid)
returns table (usuario_id uuid, acoes jsonb, situacao text, atualizado_em timestamptz) language plpgsql stable security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
begin
  if not fv2_administrador_corporativo_ativo(p_organizacao, p_ator) then
    raise exception 'Financeiro v2: só o administrador financeiro corporativo vê os acessos.' using errcode = 'FV043';
  end if;
  return query select c.usuario_id, c.acoes, c.situacao, c.atualizado_em from fv2_concessao c where c.organizacao_id = p_organizacao and c.unidade_id = p_unidade order by c.atualizado_em;
end $$;

alter function fv2_painel_liberacoes(uuid, uuid) owner to fv2_guardiao;
alter function fv2_painel_acessos(uuid, uuid, uuid) owner to fv2_guardiao;
revoke all on function fv2_painel_liberacoes(uuid, uuid) from public;
revoke all on function fv2_painel_acessos(uuid, uuid, uuid) from public;
grant execute on function fv2_painel_liberacoes(uuid, uuid) to fv2_autoridade;
grant execute on function fv2_painel_acessos(uuid, uuid, uuid) to fv2_autoridade;

create or replace function fv2_painel_administradores(p_organizacao uuid, p_ator uuid)
returns table (conta_id uuid, ativo boolean, alterado_em timestamptz) language plpgsql stable security definer set search_path = pg_catalog, financeiro_v2, pg_temp as $$
begin
  if not fv2_administrador_corporativo_ativo(p_organizacao, p_ator) then
    raise exception 'Financeiro v2: só o administrador financeiro corporativo vê os administradores.' using errcode = 'FV043';
  end if;
  return query select a.conta_id, a.ativo, a.alterado_em from fv2_administrador_corporativo a where a.organizacao_id = p_organizacao order by a.alterado_em;
end $$;
alter function fv2_painel_administradores(uuid, uuid) owner to fv2_guardiao;
revoke all on function fv2_painel_administradores(uuid, uuid) from public;
grant execute on function fv2_painel_administradores(uuid, uuid) to fv2_autoridade;
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0023_administracao_corporativa.sql', 'ddc2d8b28694ea3b982114e879474e16d5041277d1f2b6f5653f48768e47ca23', '7cf93b58ab340e8da8b4414205cac63155129e20bbf5525d8338fcdaa3514687');

-- ------------------------------------------------------------------------- 0024_canais_e_operadoras.sql (arquivo 72073c2d5864e050081f042722fb135be6e43756b9c2cb8f19eeb1530176e0a4)
grant fv2_guardiao to current_user; grant create on schema financeiro_v2 to fv2_guardiao;
-- =====================================================================================================================
-- Financeiro v2 — migração 0024: CANAL 99FOOD e OPERADORAS de pagamento (Fase 02, doc 40)
--
-- Só é aplicada no PostgreSQL local isolado e, depois de autorizada, no schema dedicado. Não pertence a database/migrations/.
--
-- O que muda (e o que NÃO muda):
--   * canal NOVENTA_E_NOVE_FOOD passa a ser aceito (lançamento, venda, recebível, cadastro de canais). Os canais existentes
--     continuam iguais e nenhum registro é alterado.
--   * processadores PAGBANK, MAQUININHA_IFOOD (maquininha do iFood usada no balcão: operadora, não canal) e
--     NOVENTA_E_NOVE_FOOD (repasse do marketplace 99Food) passam a ser aceitos (pagamento, recebível, cadastro).
--   * Operadoras, tabelas de taxas e taxa estimada vivem nas extensões (`extras`) já existentes: nenhuma coluna nova.
--   * Só troca restrições CHECK por versões mais amplas: nenhuma linha atual deixa de valer.
-- =====================================================================================================================

do $$
declare
  r record;
begin
  -- Remove as CHECK antigas de canal/processador (nomes gerados pelo PostgreSQL) — identificadas pela definição.
  for r in
    select c.conname, t.relname
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where c.contype = 'c'
       and n.nspname = current_schema()
       and t.relname in ('fv2_lancamento', 'fv2_venda', 'fv2_pagamento_venda', 'fv2_recebivel', 'fv2_canal_processador')
       and pg_get_constraintdef(c.oid) like '%ANOTA_AI%'
  loop
    execute format('alter table %I drop constraint %I', r.relname, r.conname);
  end loop;
end $$;

alter table fv2_lancamento add constraint fv2_lancamento_canal_valido
  check (canal is null or canal in ('BALCAO', 'IFOOD', 'ANOTA_AI', 'NOVENTA_E_NOVE_FOOD', 'OUTRO'));
alter table fv2_venda add constraint fv2_venda_canal_valido
  check (canal in ('BALCAO', 'IFOOD', 'ANOTA_AI', 'NOVENTA_E_NOVE_FOOD', 'OUTRO'));
alter table fv2_pagamento_venda add constraint fv2_pagamento_venda_processador_valido
  check (processador is null or processador in ('STONE', 'PAGBANK', 'MAQUININHA_IFOOD', 'IFOOD', 'ANOTA_AI', 'NOVENTA_E_NOVE_FOOD', 'OPERADORA_BENEFICIOS', 'MAQUINA_TERCEIROS', 'OUTRO'));
alter table fv2_recebivel add constraint fv2_recebivel_processador_valido
  check (processador is null or processador in ('STONE', 'PAGBANK', 'MAQUININHA_IFOOD', 'IFOOD', 'ANOTA_AI', 'NOVENTA_E_NOVE_FOOD', 'OPERADORA_BENEFICIOS', 'MAQUINA_TERCEIROS', 'OUTRO'));
alter table fv2_recebivel add constraint fv2_recebivel_canal_valido
  check (canal is null or canal in ('BALCAO', 'IFOOD', 'ANOTA_AI', 'NOVENTA_E_NOVE_FOOD', 'OUTRO'));
alter table fv2_canal_processador add constraint fv2_canal_processador_codigo_base_valido
  check ((papel = 'CANAL' and codigo_base in ('BALCAO', 'IFOOD', 'ANOTA_AI', 'NOVENTA_E_NOVE_FOOD', 'OUTRO'))
      or (papel = 'PROCESSADOR' and codigo_base in ('STONE', 'PAGBANK', 'MAQUININHA_IFOOD', 'IFOOD', 'ANOTA_AI', 'NOVENTA_E_NOVE_FOOD', 'OPERADORA_BENEFICIOS', 'MAQUINA_TERCEIROS', 'OUTRO')));
revoke create on schema financeiro_v2 from fv2_guardiao; revoke fv2_guardiao from current_user;
insert into financeiro_v2.fv2_migracao (nome, sha256, sha256_aplicado) values ('0024_canais_e_operadoras.sql', '72073c2d5864e050081f042722fb135be6e43756b9c2cb8f19eeb1530176e0a4', '72073c2d5864e050081f042722fb135be6e43756b9c2cb8f19eeb1530176e0a4');

do $$ declare f record; begin
  -- A5 (auditoria A-1): nenhuma função do módulo fica executável por PUBLIC (o padrão do PostgreSQL). Quem tinha o
  -- EXECUTE de PUBLIC passa a ter EXECUTE só para os três papéis do módulo; as funções protegidas já sem PUBLIC ficam
  -- exatamente como as migrações deixaram.
  for f in select p.oid::regprocedure as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'financeiro_v2' and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0 and x.privilege_type = 'EXECUTE') loop
    execute format('grant execute on function %s to fv2_app, fv2_autoridade, fv2_guardiao', f.fn);
    execute format('revoke execute on function %s from public', f.fn);
  end loop;
end $$;
grant fv2_guardiao to current_user;
do $$ declare r text; begin
  foreach r in array array['anon','authenticated','service_role','authenticator'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema financeiro_v2 from %I', r);
      execute format('revoke all on all sequences in schema financeiro_v2 from %I', r);
      execute format('revoke all on all functions in schema financeiro_v2 from %I', r);
    end if;
  end loop;
end $$;
revoke fv2_guardiao from current_user;
do $$ declare n int; txt text; begin
  select count(*) into n from financeiro_v2.fv2_migracao;
  if n <> 24 then raise exception 'FV2 pós: % migrações registradas (esperado 24)', n; end if;
  select string_agg(c.relname, ', ') into txt from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'financeiro_v2' and c.relkind = 'r' and c.relname <> 'fv2_migracao'
      and c.relname not in ('fv2_auditoria_concessao','fv2_liberacao','fv2_liberacao_historico','fv2_administrador_corporativo','fv2_administrador_corporativo_historico','fv2_provisionamento_inicial','fv2_sessao_banco')
      and not (c.relrowsecurity and c.relforcerowsecurity);
  if txt is not null then raise exception 'FV2 pós: tabelas sem RLS forçada: %', txt; end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace,
    lateral aclexplode(coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner))) x
    where s.nspname = 'financeiro_v2' and c.relkind in ('r','p','v','m','S') and (x.grantee = 0 or pg_get_userbyid(x.grantee) in ('anon','authenticated','service_role','authenticator'));
  if n > 0 then raise exception 'FV2 pós: % privilégio(s) de PUBLIC ou credencial comum em tabela do schema', n; end if;
  select count(*) into n from pg_publication_tables where schemaname = 'financeiro_v2';
  if n > 0 then raise exception 'FV2 pós: % tabela(s) do v2 em publicação de replicação', n; end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname <> 'financeiro_v2' and s.nspname not like 'pg\_%' and c.relname like 'fv2\_%';
  if n > 0 then raise exception 'FV2 pós: % relações fv2_* fora do schema', n; end if;
end $$;
