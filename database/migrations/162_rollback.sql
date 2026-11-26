-- Rollback da 162 — remove o Núcleo Mentorados (cadastros, importações, registros e apresentações se perdem).
-- Não toca em nenhuma tabela oficial (Dashboard iFood, Financeiro v2).
begin;
drop table if exists public.mentoria_apresentacoes;
drop table if exists public.mentoria_registros;
drop table if exists public.mentoria_historico_mensal;
drop table if exists public.mentoria_importacoes;
drop table if exists public.mentoria_participantes;
drop function if exists public.mentoria_apresentacao_imutavel();
drop function if exists public.mentoria_importar_historico(uuid, jsonb, jsonb);
commit;
