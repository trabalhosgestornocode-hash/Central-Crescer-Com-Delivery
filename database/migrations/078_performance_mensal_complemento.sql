-- LOCAL: não aplicar em produção sem autorização específica.
-- Somente complementos; nenhum snapshot/cópia de indicadores oficiais.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS unidades_id_organizacao_performance_uidx
  ON public.unidades (id, organizacao_id);

CREATE TABLE public.performance_mensal_complemento (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id uuid NOT NULL REFERENCES public.organizacoes(id),
  unidade_id uuid NOT NULL,
  competencia date NOT NULL CHECK (extract(day FROM competencia) = 1),
  faturamento_ifood_manual numeric(14,2) CHECK (faturamento_ifood_manual >= 0 AND faturamento_ifood_manual <> 'NaN'::numeric),
  despesas_ifood_manual numeric(14,2) CHECK (despesas_ifood_manual >= 0 AND despesas_ifood_manual <> 'NaN'::numeric),
  pedidos_manual integer CHECK (pedidos_manual >= 0),
  novos_clientes_manual integer CHECK (novos_clientes_manual >= 0),
  conversao_manual numeric(7,4) CHECK (conversao_manual BETWEEN 0 AND 100),
  taxas_entregadores_ifood_manual numeric(14,2) CHECK (taxas_entregadores_ifood_manual >= 0 AND taxas_entregadores_ifood_manual <> 'NaN'::numeric),
  despesas_entregadores_externos_manual numeric(14,2) CHECK (despesas_entregadores_externos_manual >= 0 AND despesas_entregadores_externos_manual <> 'NaN'::numeric),
  status text NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho','fechado')),
  versao integer NOT NULL DEFAULT 1 CHECK (versao > 0),
  criado_em timestamptz NOT NULL DEFAULT now(),
  criado_por uuid NOT NULL REFERENCES public.perfis(id),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_por uuid NOT NULL REFERENCES public.perfis(id),
  fechado_em timestamptz,
  fechado_por uuid REFERENCES public.perfis(id),
  fechamento_hash text,
  CONSTRAINT performance_unidade_organizacao_fk FOREIGN KEY (unidade_id, organizacao_id)
    REFERENCES public.unidades(id, organizacao_id),
  CONSTRAINT performance_unidade_competencia_uk UNIQUE (unidade_id, competencia),
  CONSTRAINT performance_fechamento_consistente CHECK (
    (status = 'rascunho' AND fechado_em IS NULL AND fechado_por IS NULL AND fechamento_hash IS NULL)
    OR (status = 'fechado' AND fechado_em IS NOT NULL AND fechado_por IS NOT NULL AND fechamento_hash IS NOT NULL AND length(fechamento_hash) = 64)
  )
);
CREATE INDEX performance_organizacao_competencia_idx
  ON public.performance_mensal_complemento (organizacao_id, competencia);

-- Backend service_role acessa somente após gates administrativos e validação de escopo.
-- Nenhuma policy para acesso direto de anon/authenticated.
ALTER TABLE public.performance_mensal_complemento ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.performance_mensal_complemento FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.performance_mensal_complemento TO service_role;

CREATE FUNCTION public.performance_complemento_versionar() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.organizacao_id IS DISTINCT FROM OLD.organizacao_id
    OR NEW.unidade_id IS DISTINCT FROM OLD.unidade_id
    OR NEW.competencia IS DISTINCT FROM OLD.competencia THEN
    RAISE EXCEPTION 'Escopo do complemento é imutável';
  END IF;
  NEW.criado_em := OLD.criado_em;
  NEW.criado_por := OLD.criado_por;
  NEW.atualizado_em := now();
  NEW.versao := OLD.versao + 1;
  RETURN NEW;
END;
$$;
CREATE TRIGGER performance_complemento_versionar
  BEFORE UPDATE ON public.performance_mensal_complemento
  FOR EACH ROW EXECUTE FUNCTION public.performance_complemento_versionar();
COMMIT;
