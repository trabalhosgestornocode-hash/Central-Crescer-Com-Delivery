begin;
delete from contatos_whatsapp where id::text like 'e0000000-0096-%';
delete from organizacoes where id in ('a0960000-0000-4000-8000-00000000000a','b0960000-0000-4000-8000-00000000000b');
delete from perfis_operacionais where id::text like 'd0000000-0096-%';
delete from perfis where id::text like 'c0000000-0096-%';
delete from auth.users where id::text like 'c0000000-0096-%';
delete from painel_adm_permissoes where usuario_id::text like 'c0000000-0096-%';
commit;
