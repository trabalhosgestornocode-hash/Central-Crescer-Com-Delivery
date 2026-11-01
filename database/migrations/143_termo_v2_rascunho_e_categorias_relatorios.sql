-- 143 — Termo v2 (RASCUNHO) e categorias dos relatórios operacionais selecionáveis no convite.
--
-- 1. Insere a VERSÃO 2 do termo (texto curto escolhido) como RASCUNHO (`rascunho = true`): termos são imutáveis e versionados; a v1 permanece no histórico e os
--    consentimentos já registrados continuam apontando para a versão/hash que aceitaram. Enquanto a versão vigente (maior versão) for rascunho, o consentimento REAL
--    continua recusado (409 TERMO_NAO_APROVADO): esta migration NÃO aprova o termo e NÃO registra consentimento algum. O texto traz, de propósito, um marcador visível
--    para a identificação da empresa responsável e o contato de privacidade (dados a verificar pelo jurídico — nada foi inventado).
-- 2. Categorias `fechamento_operacional_diario` e `resumo_semanal`: renomeia o rótulo/descrição para o que o titular lê e passa a `estado = 'ATIVA'` /
--    `transporte = 'baileys'` (selecionáveis no convite). `ativo` continua FALSE: o resolvedor do D-1 e o Painel ADM só enxergam categorias com ativo = true,
--    então nenhum destinatário legado ganha estas categorias por fora do fluxo de convite + OTP + consentimento.
-- 3. Pós-condição que ABORTA a migration se a categoria do D-1 (`pendencia_d1`) mudar em qualquer coluna.
-- Rollback: 143_rollback.sql (categorias; a linha da v2 é imutável por desenho e fica, inofensiva, como rascunho).
begin;
set local lock_timeout = '5s';

do $$ begin
  if to_regclass('public.comunicacao_termos') is null or to_regclass('public.comunicacao_categorias') is null then
    raise exception '143: exige a migration 134 (termos) e 133 (categorias)';
  end if;
  if not exists (select 1 from comunicacao_categorias where codigo in ('fechamento_operacional_diario', 'resumo_semanal') having count(*) = 2) then
    raise exception '143: categorias dos relatórios ausentes (migration 133)';
  end if;
end $$;

create temp table _d1_antes on commit drop as select md5(to_jsonb(c)::text) h from comunicacao_categorias c where codigo = 'pendencia_d1';

insert into comunicacao_termos (versao, texto, hash, rascunho)
select 2, t, encode(sha256(convert_to(t, 'UTF8')), 'hex'), true
  from (select $termo$Autorização de Notificações — Crescer com Delivery

Ao aceitar, você autoriza o recebimento de notificações pelo WhatsApp referentes às unidades às quais possui acesso.

Você poderá escolher receber:
- Relatório Operacional Diário.
- Resumo Operacional Semanal.

Seu número será confirmado por código de segurança. Utilizaremos seus dados apenas para gerenciar as comunicações, conforme nossa Política de Privacidade.

Você poderá cancelar o recebimento a qualquer momento pelas configurações do sistema ou pelo canal de cancelamento disponibilizado.

[PENDENTE DE VERIFICAÇÃO JURÍDICA: identificação da empresa responsável e contato de privacidade]

Ao aceitar, confirmo que li e autorizo o recebimento das categorias selecionadas.$termo$::text as t) x
on conflict (versao) do nothing;

update comunicacao_categorias set
    rotulo = 'Relatório Operacional Diário',
    descricao = 'Resumo do dia operacional já fechado, enviado pela manhã.',
    estado = 'ATIVA', transporte = 'baileys'
 where codigo = 'fechamento_operacional_diario' and ativo = false;
update comunicacao_categorias set
    rotulo = 'Resumo Operacional Semanal',
    descricao = 'Resumo da semana operacional encerrada, enviado às segundas-feiras.',
    estado = 'ATIVA', transporte = 'baileys'
 where codigo = 'resumo_semanal' and ativo = false;

do $$
declare antes text; depois text;
begin
  select h into antes from _d1_antes;
  select md5(to_jsonb(c)::text) into depois from comunicacao_categorias c where codigo = 'pendencia_d1';
  if antes is distinct from depois then raise exception '143: a categoria do D-1 (pendencia_d1) mudou — abortado'; end if;
  if (select count(*) from comunicacao_categorias where codigo in ('fechamento_operacional_diario', 'resumo_semanal') and ativo = false and estado = 'ATIVA' and transporte = 'baileys') <> 2 then
    raise exception '143: categorias dos relatórios fora do estado esperado';
  end if;
  if not exists (select 1 from comunicacao_termos where versao = 2 and rascunho = true) then raise exception '143: termo v2 ausente ou aprovado indevidamente'; end if;
  if exists (select 1 from comunicacao_termos where versao = 2 and rascunho = false) then raise exception '143: o termo v2 não pode nascer aprovado'; end if;
end $$;

commit;
