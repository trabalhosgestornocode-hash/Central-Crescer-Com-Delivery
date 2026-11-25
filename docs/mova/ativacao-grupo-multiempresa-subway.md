# Ativação — grupo compartilhado Subway/Açaí e escritas da Subway (para aprovação; NADA aplicado)

Ordem obrigatória. Cada passo exige autorização própria do proprietário.

## 1. Migração MOVA 0024 (grupo multiempresa)
`database/mova-financeiro/producao/aplicar-grupo-multiempresa.sql` — só acrescenta `grupo_autorizado.multiempresa` (padrão false). Exige 0001–0018, 0020, 0022 e 0023 com o mesmo sha256. Reversão: `recuperacao/reverter-0024.sql`. O código novo lê a coluna de forma tolerante (funciona antes e depois da migração).

## 2. Marcar o grupo e incluir a Subway (dados do MOVA, uma transação)
```sql
begin;
do $$ begin
  if not exists (select 1 from mova.mova_migracao where nome = '0024_mova_grupo_multiempresa.sql') then raise exception 'MOVA: 0024 não aplicada — nada feito'; end if;
end $$;
update mova.grupo_autorizado set multiempresa = true where grupo_jid = '120363021890052122@g.us';
insert into mova.grupo_unidade (grupo_jid, organizacao_id, unidade_id, nome, apelidos, documentos, fontes, empresa, pagadores)
select '120363021890052122@g.us', organizacao_id, unidade_id, nome, apelidos, documentos, fontes, empresa, pagadores
  from mova.unidade_sem_grupo where unidade_id = '00000000-0000-0000-0000-0000000000a1'
on conflict do nothing;
insert into mova.auditoria (acao, ator_tipo, ator_ref, alvo, dados) values ('CADASTRO_ACESSO_UNIDADE', 'USUARIO', 'proprietario', '120363021890052122@g.us',
  jsonb_build_object('multiempresa', true, 'unidadeIncluida', '00000000-0000-0000-0000-0000000000a1', 'motivo', 'Grupo Contas à Pagar Subway/Açaí atende as duas empresas (autorização do proprietário).'));
commit;
```
Os 3 participantes (FINANCEIRO, sem restrição de unidade) passam a ter as duas unidades no grupo e no privado. Vale no próximo reinício do MOVA.

## 3. Concessão operacional estreita na Subway (reaproveita a identidade 839a6da8…)
```
node scripts/fv2/pacoteProducao.mjs   # função sqlConcessaoOperacionalDoMova
  identidade 839a6da8-649d-4b6f-81c7-cb51c5c919cd, unidade 00000000-0000-0000-0000-0000000000a1,
  acoes [ver, enviar_documento, baixar_por_comprovante, registrar_obrigacao, registrar_juros]
```
Sem `vincular_pagamento`, sem `prestar_sangria` (Subway: sangrias via SWF), sem ação ampla.

## 4. Políticas de autonomia da Subway (limites A DEFINIR pelo proprietário; não copiados do Açaí)
```
node scripts/mova/politicasDaUnidade.mjs --organizacao 00000000-0000-0000-0000-000000000001 --unidade 00000000-0000-0000-0000-0000000000a1 \
  --criada-por <uuid do proprietário> --responsavel "<nome>" --vigente-de <data> --motivo "<aprovação>" \
  --politica DESPESA_DOCUMENTAL:APLICAR_AUTOMATICO:<limite> --politica BAIXA_DOCUMENTAL:APLICAR_AUTOMATICO:<limite> \
  --politica JUROS_DOCUMENTAL:APLICAR_AUTOMATICO:<encargo máximo>
```
Caso FIT (R$ 8.851,02; encargo R$ 179,21) exige DESPESA_DOCUMENTAL ≥ 885102 e JUROS_DOCUMENTAL ≥ 17921.

## 5. Açaí — encargos automáticos
Hoje a identidade operacional do Açaí NÃO tem `registrar_juros` e não existe política JUROS_DOCUMENTAL: comprovantes com juros/multa no Açaí ficam como proposta até essas duas aprovações (políticas atuais preservadas).

## 6. Chave
`MOVA_OPERACAO_REGISTRAR_JUROS=1` (com `MOVA_OPERACAO_PAGAMENTO_POR_COMPROVANTE` e `MOVA_OPERACAO_CRIAR_DESPESAS` já em uso). Deploy do PR antes.
