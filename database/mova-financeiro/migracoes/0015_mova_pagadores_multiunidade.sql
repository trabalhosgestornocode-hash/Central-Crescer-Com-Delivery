-- MOVA — 24/11/2026: IDENTIFICAÇÃO DA UNIDADE PELO PAGADOR e MOVA nas duas empresas (Açaí no Grau Saci + Subway Saci).
--
-- 1) `pagadores` no CADASTRO da unidade (grupo_unidade e unidade_sem_grupo): lista explícita dos titulares/documentos da CONTA
--    PAGADORA da unidade — ex.: [{"nome":"<titular da conta>"}] em cada unidade (valores reais só no cadastro, nunca no Git). O comprovante pago por essa conta
--    identifica a unidade (dominio/pagador.js). Nunca dá acesso: a conversa só atua nas unidades dela.
-- 2) Unidade SEM grupo (0014) ganha `participantes` (mesma forma da lista de um grupo: ids, telefones, perfil, privado, nome) e
--    `acesso_multiempresa` (padrão false). Com participantes, a pessoa ganha a unidade na conversa privada derivada; juntar duas
--    EMPRESAS na mesma conversa só com acesso_multiempresa = true (autorização explícita, com o motivo da linha).
-- 3) Conta a pagar NOVA (boleto/nota) pode ser AUTOMÁTICA quando uma política CONTA_A_PAGAR explícita o disser (antes era
--    proibido no banco). Nada é semeado: sem política, o MOVA só propõe — e a escrita ainda exige a concessão `registrar_obrigacao`
--    da identidade operacional na unidade (Financeiro v2 0030).
-- O app (mova_app) continua só LENDO o cadastro; gravar é ato do proprietário pelos kits (scripts/mova/*.mjs).

alter table mova.grupo_unidade add column pagadores jsonb not null default '[]'::jsonb
  check (jsonb_typeof(pagadores) = 'array' and jsonb_array_length(pagadores) <= 10);
alter table mova.unidade_sem_grupo add column pagadores jsonb not null default '[]'::jsonb
  check (jsonb_typeof(pagadores) = 'array' and jsonb_array_length(pagadores) <= 10);
alter table mova.unidade_sem_grupo add column participantes jsonb not null default '[]'::jsonb
  check (jsonb_typeof(participantes) = 'array' and jsonb_array_length(participantes) <= 50);
alter table mova.unidade_sem_grupo add column acesso_multiempresa boolean not null default false;

do $$ declare c text; begin
  select conname into c from pg_constraint
   where conrelid = 'mova.politica_autonomia'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) = 'CHECK ((NOT ((nivel = ''APLICAR_AUTOMATICO''::text) AND (operacao = ''CONTA_A_PAGAR''::text))))';
  if c is null then raise exception 'MOVA 0015: trava de conta a pagar automática não encontrada'; end if;
  execute format('alter table mova.politica_autonomia drop constraint %I', c);
end $$;

-- 4) Proposta VINCULO_DE_DOCUMENTO: nota fiscal de uma conta JÁ registrada — só anexa a nota à conta (nenhum valor muda).
do $$ declare c text; begin
  select conname into c from pg_constraint
   where conrelid = 'mova.proposta'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%BAIXA_DE_OBRIGACAO%SOLICITACAO_DE_REVISAO%';
  if c is null then raise exception 'MOVA 0015: lista de tipos de proposta não encontrada'; end if;
  execute format('alter table mova.proposta drop constraint %I', c);
end $$;
alter table mova.proposta add constraint proposta_tipo_check
  check (tipo in ('BAIXA_DE_OBRIGACAO','DESPESA_PAGA','NOVA_OBRIGACAO','SOLICITACAO_DE_REVISAO','VINCULO_DE_DOCUMENTO'));
