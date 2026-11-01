-- TERMO v3 — texto de apresentação aprovado (sem razão social/CNPJ/contato na tela de aceite; esses dados ficam na Política de Privacidade, acessível por link).
--
-- ⚠️  NÃO APLICAR antes de: (1) aprovação jurídica da versão final; (2) Política de Privacidade PUBLICADA com informações verificadas
--     (NOTIFICACOES_POLITICA_CONTROLADOR/CONTATO/RETENCAO/ATUALIZADA_EM definidas no Render e a página /notificacoes/privacidade.html exibindo o conteúdo).
-- Este arquivo fica FORA de database/migrations de propósito (não é aplicado por engano). Ao aprovar, ele é movido para uma migration numerada e aplicada
-- com autorização específica. Efeito: a versão VIGENTE passa a ser a v3 NÃO-rascunho, o que libera o consentimento REAL (deixa de responder 409 TERMO_NAO_APROVADO).
-- Termos são imutáveis: a v1 e a v2 (rascunho) permanecem no histórico; consentimentos já registrados continuam apontando para a versão/hash que aceitaram.
begin;
set local lock_timeout = '5s';

do $$ begin
  if not exists (select 1 from comunicacao_termos where versao = 2 and rascunho = true) then raise exception 'v3: esperado a v2 (rascunho) como base'; end if;
  if exists (select 1 from comunicacao_termos where versao >= 3) then raise exception 'v3: já existe uma versão >= 3'; end if;
end $$;

insert into comunicacao_termos (versao, texto, hash, rascunho)
select 3, t, encode(sha256(convert_to(t, 'UTF8')), 'hex'), false
  from (select $termo$Autorização de Notificações — Crescer com Delivery

Ao aceitar, você autoriza o recebimento de notificações pelo WhatsApp referentes às unidades às quais possui acesso.

Você poderá escolher receber:
- Relatório Operacional Diário.
- Resumo Operacional Semanal.

Seu número será confirmado por código de segurança. Utilizaremos seus dados apenas para gerenciar as comunicações, conforme nossa Política de Privacidade.

Você poderá cancelar o recebimento a qualquer momento pelas configurações do sistema ou pelo canal de cancelamento disponibilizado.

Ao aceitar, confirmo que li e autorizo o recebimento das categorias selecionadas.$termo$::text as t) x;

do $$ begin
  if (select count(*) from comunicacao_termos where versao = 3 and rascunho = false and hash = encode(sha256(convert_to(texto, 'UTF8')), 'hex')) <> 1 then raise exception 'v3: não registrada corretamente'; end if;
  if (select versao from comunicacao_termos order by versao desc limit 1) <> 3 then raise exception 'v3: deveria ser a vigente'; end if;
end $$;
commit;
