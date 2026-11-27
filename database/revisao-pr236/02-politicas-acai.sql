-- PR #236 — PREPARADO PARA REVISÃO, NÃO APLICADO. Aplicar só depois da MOVA 0025 e com autorização específica (ver README.md).
-- MOVA — POLÍTICAS DE AUTONOMIA da unidade 4d3b75bd-79b5-4335-ae5b-a183580c3555 (empresa e7216085-1ece-45dc-bc41-d74f11a88e40). Revisar antes de aplicar. Vale na próxima operação.
begin;
do $$ begin

  if not exists (select 1 from mova.grupo_unidade where unidade_id = '4d3b75bd-79b5-4335-ae5b-a183580c3555' and organizacao_id = 'e7216085-1ece-45dc-bc41-d74f11a88e40') and not exists (select 1 from mova.unidade_sem_grupo where unidade_id = '4d3b75bd-79b5-4335-ae5b-a183580c3555' and organizacao_id = 'e7216085-1ece-45dc-bc41-d74f11a88e40')
    then raise exception 'MOVA: unidade/empresa não cadastrada no MOVA — nada foi feito'; end if;
end $$;
-- CONTA_A_PAGAR_RELATADA: APLICAR_COM_CONFIRMACAO, limite 1000000 centavos
update mova.politica_autonomia set revogada_em = now(), revogada_por = '63d66676-f042-4197-9b51-076f5145c1b9'
 where operacao = 'CONTA_A_PAGAR_RELATADA' and organizacao_id = 'e7216085-1ece-45dc-bc41-d74f11a88e40' and unidade_id = '4d3b75bd-79b5-4335-ae5b-a183580c3555' and revogada_em is null;
insert into mova.politica_autonomia (operacao, organizacao_id, unidade_id, nivel, limite_centavos, responsavel, motivo, vigente_de, vigente_ate, criada_por)
values ('CONTA_A_PAGAR_RELATADA', 'e7216085-1ece-45dc-bc41-d74f11a88e40', '4d3b75bd-79b5-4335-ae5b-a183580c3555', 'APLICAR_COM_CONFIRMACAO', 1000000, 'João Pedro Pontes', 'Limites definidos pelo proprietário na revisão do PR #236 (27/11/2026); confirmação no WhatsApp obrigatória', '2026-11-27', null, '63d66676-f042-4197-9b51-076f5145c1b9');
-- CONTA_PARCELADA_RELATADA: APLICAR_COM_CONFIRMACAO, limite 1000000 centavos
update mova.politica_autonomia set revogada_em = now(), revogada_por = '63d66676-f042-4197-9b51-076f5145c1b9'
 where operacao = 'CONTA_PARCELADA_RELATADA' and organizacao_id = 'e7216085-1ece-45dc-bc41-d74f11a88e40' and unidade_id = '4d3b75bd-79b5-4335-ae5b-a183580c3555' and revogada_em is null;
insert into mova.politica_autonomia (operacao, organizacao_id, unidade_id, nivel, limite_centavos, responsavel, motivo, vigente_de, vigente_ate, criada_por)
values ('CONTA_PARCELADA_RELATADA', 'e7216085-1ece-45dc-bc41-d74f11a88e40', '4d3b75bd-79b5-4335-ae5b-a183580c3555', 'APLICAR_COM_CONFIRMACAO', 1000000, 'João Pedro Pontes', 'Limites definidos pelo proprietário na revisão do PR #236 (27/11/2026); confirmação no WhatsApp obrigatória', '2026-11-27', null, '63d66676-f042-4197-9b51-076f5145c1b9');
-- OPERACAO_ENTRE_EMPRESAS: APLICAR_COM_CONFIRMACAO, limite 1000000 centavos
update mova.politica_autonomia set revogada_em = now(), revogada_por = '63d66676-f042-4197-9b51-076f5145c1b9'
 where operacao = 'OPERACAO_ENTRE_EMPRESAS' and organizacao_id = 'e7216085-1ece-45dc-bc41-d74f11a88e40' and unidade_id = '4d3b75bd-79b5-4335-ae5b-a183580c3555' and revogada_em is null;
insert into mova.politica_autonomia (operacao, organizacao_id, unidade_id, nivel, limite_centavos, responsavel, motivo, vigente_de, vigente_ate, criada_por)
values ('OPERACAO_ENTRE_EMPRESAS', 'e7216085-1ece-45dc-bc41-d74f11a88e40', '4d3b75bd-79b5-4335-ae5b-a183580c3555', 'APLICAR_COM_CONFIRMACAO', 1000000, 'João Pedro Pontes', 'Limites definidos pelo proprietário na revisão do PR #236 (27/11/2026); confirmação no WhatsApp obrigatória', '2026-11-27', null, '63d66676-f042-4197-9b51-076f5145c1b9');
insert into mova.auditoria (acao, ator_tipo, ator_ref, alvo, dados) values ('POLITICAS_DA_UNIDADE', 'USUARIO', '63d66676-f042-4197-9b51-076f5145c1b9', '4d3b75bd-79b5-4335-ae5b-a183580c3555',
  '{"politicas":[{"operacao":"CONTA_A_PAGAR_RELATADA","nivel":"APLICAR_COM_CONFIRMACAO","limiteCentavos":1000000},{"operacao":"CONTA_PARCELADA_RELATADA","nivel":"APLICAR_COM_CONFIRMACAO","limiteCentavos":1000000},{"operacao":"OPERACAO_ENTRE_EMPRESAS","nivel":"APLICAR_COM_CONFIRMACAO","limiteCentavos":1000000}],"vigenteDe":"2026-11-27","vigenteAte":null}'::jsonb);
select operacao, nivel, limite_centavos, vigente_de, vigente_ate from mova.politica_autonomia where organizacao_id = 'e7216085-1ece-45dc-bc41-d74f11a88e40' and unidade_id = '4d3b75bd-79b5-4335-ae5b-a183580c3555' and revogada_em is null order by operacao;
commit;
