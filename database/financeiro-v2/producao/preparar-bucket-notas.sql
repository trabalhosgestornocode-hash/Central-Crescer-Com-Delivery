-- PREPARADO, NÃO EXECUTADO. Aplicar só com autorização específica, no projeto Supabase já usado pelo Crescer.
-- Bucket PRIVADO das notas de entregadores: até 10 MiB, só PDF, PNG e JPEG. Sem política para anon/authenticated:
-- o acesso acontece apenas pelo backend, depois de conferir empresa, unidade e permissão financeira.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fv2-notas-entregadores', 'fv2-notas-entregadores', false, 10485760, array['application/pdf', 'image/png', 'image/jpeg'])
on conflict (id) do nothing;
select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'fv2-notas-entregadores';
