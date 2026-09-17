-- =====================================================================
-- ROLLBACK da MIGRATION 082 — remove a fundação do módulo de Comunicação WhatsApp
-- =====================================================================
-- Tudo aqui é aditivo na migration 082 — nenhuma tabela existente foi
-- tocada, então o rollback é uma limpeza completa e segura, sem afetar
-- nenhum dado de negócio já existente no projeto.
-- COMO USAR: Supabase -> SQL Editor -> cole ESTE ARQUIVO INTEIRO e execute.
-- =====================================================================

begin;

-- Assinaturas antigas (pré-B.1) também cobertas, para reverter com
-- segurança um banco que só tenha a versão original de 082 aplicada.
drop function if exists comunicacao_claim_mensagens(integer, text, integer);
drop function if exists comunicacao_claim_mensagens(integer, text);
drop function if exists comunicacao_expirar_entregas_incertas(text);

drop trigger if exists trg_comunicacao_conversas_upd on comunicacao_conversas;
drop trigger if exists trg_comunicacao_mensagens_upd on comunicacao_mensagens;
drop trigger if exists trg_comunicacao_alertas_upd on comunicacao_alertas;
drop trigger if exists trg_contatos_whatsapp_perfis_upd on contatos_whatsapp_perfis;
drop trigger if exists trg_contatos_whatsapp_upd on contatos_whatsapp;

drop table if exists comunicacao_configuracoes;
drop table if exists comunicacao_conversas;
drop table if exists comunicacao_tentativas;
drop table if exists comunicacao_mensagens;
drop table if exists comunicacao_alertas;
drop table if exists contatos_whatsapp_perfis;
drop table if exists contatos_whatsapp;

commit;
