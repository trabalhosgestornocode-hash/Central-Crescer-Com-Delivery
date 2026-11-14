-- =====================================================================================================================
-- Financeiro v2 — migração 0010: auditoria integrada (Execução 07)
--
-- Só é aplicada no PostgreSQL local isolado (scripts/fv2-banco-teste.mjs). Não pertence a database/migrations/.
--
-- Achado da auditoria: um título (recebível/obrigação) de competência homologada pode ter o VALOR DEVIDO reduzido por um
-- fato POSTERIOR legítimo (estorno de pagamento de venda, taxa descoberta depois e reconhecida no mês em que foi
-- descoberta). Esses fatos gravam um registro em fv2_ajuste NA COMPETÊNCIA ABERTA do fato (o gatilho da 0009 recusa
-- ajuste em competência homologada) e mudam `ajustes_centavos` do título. Na 0009 essa coluna não era livre: o núcleo
-- permitia e o banco recusava — comportamento diferente entre memória e PostgreSQL.
--
-- Regra nova: em competência homologada, `ajustes_centavos` só muda se ficar IGUAL à soma dos registros de ajuste do
-- título (todos auditados, com histórico, e os novos necessariamente em competência aberta). Mudança "solta", sem o
-- registro correspondente, continua recusada (FV001). Nada mais foi liberado.
-- =====================================================================================================================

create or replace function fv2_posicao_em_homologada() returns trigger language plpgsql as $$
declare
  livres text[] := array['versao', 'atualizado_em', 'atualizado_por'];
  situacao_livre boolean := false;
  ajustes_livres boolean := false;
  soma bigint;
  i int;
begin
  perform fv2_trava_da_competencia(new.organizacao_id, new.unidade_id, new.competencia, false);
  if not fv2_homologada(new.organizacao_id, new.unidade_id, new.competencia) then return new; end if;
  if tg_op = 'INSERT' then
    raise exception 'Financeiro v2: a competência % está homologada.', new.competencia using errcode = 'FV001';
  end if;
  for i in 0 .. tg_nargs - 1 loop
    if tg_argv[i] = 'situacao_financeira' then situacao_livre := true;
    elsif tg_argv[i] = 'ajustes_registrados' then ajustes_livres := true;
    else livres := livres || tg_argv[i]; end if;
  end loop;
  if situacao_livre then livres := livres || 'situacao'::text; end if;
  if ajustes_livres and (to_jsonb(new)->>'ajustes_centavos') is distinct from (to_jsonb(old)->>'ajustes_centavos') then
    select coalesce(sum(a.valor_centavos), 0) into soma from fv2_ajuste a
     where a.organizacao_id = new.organizacao_id and a.unidade_id = new.unidade_id and a.alvo_id = new.id;
    if soma <> (to_jsonb(new)->>'ajustes_centavos')::bigint then
      raise exception 'Financeiro v2: ajuste de título de competência homologada sem o registro de ajuste correspondente.' using errcode = 'FV001';
    end if;
    livres := livres || 'ajustes_centavos'::text;
  end if;
  if (to_jsonb(old) - livres) is distinct from (to_jsonb(new) - livres)
     or (situacao_livre and (new.situacao = 'CANCELADA' or old.situacao = 'CANCELADA') and new.situacao is distinct from old.situacao) then
    raise exception 'Financeiro v2: registro de competência homologada só muda a posição financeira (pagamento, recebimento ou devolução posteriores).' using errcode = 'FV001';
  end if;
  return new;
end $$;

drop trigger fv2_obrigacao_homologada on fv2_obrigacao;
drop trigger fv2_recebivel_homologada on fv2_recebivel;
create trigger fv2_obrigacao_homologada before insert or update on fv2_obrigacao for each row execute function fv2_posicao_em_homologada('liquidado_centavos', 'saldo_centavos', 'situacao_financeira', 'ajustes_registrados');
create trigger fv2_recebivel_homologada before insert or update on fv2_recebivel for each row execute function fv2_posicao_em_homologada('liquidado_centavos', 'saldo_centavos', 'situacao_financeira', 'ajustes_registrados');
