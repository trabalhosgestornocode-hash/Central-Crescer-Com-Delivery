-- Dados de TESTE (prefixo ZZVAL / UUIDs 0096...). Removidos por cleanup.sql.
begin;
insert into organizacoes (id, nome) values
 ('a0960000-0000-4000-8000-00000000000a','ZZVAL Org A'),
 ('b0960000-0000-4000-8000-00000000000b','ZZVAL Org B');
insert into unidades (id, organizacao_id, nome) values
 ('a1960000-0000-4000-8000-0000000000a1','a0960000-0000-4000-8000-00000000000a','ZZVAL A-Loja1'),
 ('a2960000-0000-4000-8000-0000000000a2','a0960000-0000-4000-8000-00000000000a','ZZVAL A-Loja2'),
 ('b1960000-0000-4000-8000-0000000000b1','b0960000-0000-4000-8000-00000000000b','ZZVAL B-Loja1');
insert into auth.users (id, email) values
 ('c0000000-0096-4000-8000-000000000001','zzval-a1@example.invalid'),
 ('c0000000-0096-4000-8000-000000000002','zzval-a2@example.invalid'),
 ('c0000000-0096-4000-8000-000000000003','zzval-b1@example.invalid'),
 ('c0000000-0096-4000-8000-000000000004','zzval-off@example.invalid'),
 ('c0000000-0096-4000-8000-000000000005','zzval-admin@example.invalid');
insert into perfis (id, nome) select id, 'ZZVAL '||split_part(email,'@',1) from auth.users where email like 'zzval-%@example.invalid';
-- perfis operacionais: poA1 (vínculo DIRETO só à Loja1), poA2 (sem vínculo direto ⇒ herda todas), poB1, poOff (INATIVO)
insert into perfis_operacionais (id, conta_id, nome, ativo) values
 ('d0000000-0096-4000-8000-0000000000a1','c0000000-0096-4000-8000-000000000001','ZZVAL PO A1',true),
 ('d0000000-0096-4000-8000-0000000000a2','c0000000-0096-4000-8000-000000000002','ZZVAL PO A2',true),
 ('d0000000-0096-4000-8000-0000000000b1','c0000000-0096-4000-8000-000000000003','ZZVAL PO B1',true),
 ('d0000000-0096-4000-8000-0000000000ff','c0000000-0096-4000-8000-000000000004','ZZVAL PO OFF',false),
 ('d0000000-0096-4000-8000-0000000000ad','c0000000-0096-4000-8000-000000000005','ZZVAL PO ADMIN',true);
insert into usuarios_organizacoes (usuario_id, organizacao_id, perfil_id, papel, ativo) values
 ('c0000000-0096-4000-8000-000000000001','a0960000-0000-4000-8000-00000000000a','d0000000-0096-4000-8000-0000000000a1','operations',true),
 ('c0000000-0096-4000-8000-000000000002','a0960000-0000-4000-8000-00000000000a','d0000000-0096-4000-8000-0000000000a2','operations',true),
 ('c0000000-0096-4000-8000-000000000003','b0960000-0000-4000-8000-00000000000b','d0000000-0096-4000-8000-0000000000b1','operations',true),
 ('c0000000-0096-4000-8000-000000000004','a0960000-0000-4000-8000-00000000000a','d0000000-0096-4000-8000-0000000000ff','operations',true);
insert into usuarios_unidades (usuario_id, unidade_id, perfil_id, papel, ativo) values
 ('c0000000-0096-4000-8000-000000000001','a1960000-0000-4000-8000-0000000000a1','d0000000-0096-4000-8000-0000000000a1','operations',true);
-- contatos
insert into contatos_whatsapp (id, telefone_e164, consentimento, verificado) values
 ('e0000000-0096-4000-8000-0000000000a1','+5511990960001',true,true),   -- poA1 (direto Loja1)
 ('e0000000-0096-4000-8000-0000000000a2','+5511990960002',true,true),   -- poA2 (herda Loja1+Loja2)
 ('e0000000-0096-4000-8000-0000000000b1','+5521990960003',true,true),   -- poB1
 ('e0000000-0096-4000-8000-0000000000ff','+5531990960004',true,true),   -- perfil INATIVO
 ('e0000000-0096-4000-8000-0000000000dd','+5541990960005',true,true),   -- vínculo contato↔perfil INATIVO
 ('e0000000-0096-4000-8000-0000000000ee','+5551990960006',true,true);   -- desconhecido (sem perfil)
insert into contatos_whatsapp_perfis (contato_id, perfil_operacional_id, ativo) values
 ('e0000000-0096-4000-8000-0000000000a1','d0000000-0096-4000-8000-0000000000a1',true),
 ('e0000000-0096-4000-8000-0000000000a2','d0000000-0096-4000-8000-0000000000a2',true),
 ('e0000000-0096-4000-8000-0000000000b1','d0000000-0096-4000-8000-0000000000b1',true),
 ('e0000000-0096-4000-8000-0000000000ff','d0000000-0096-4000-8000-0000000000ff',true),
 ('e0000000-0096-4000-8000-0000000000dd','d0000000-0096-4000-8000-0000000000a1',false);
commit;
