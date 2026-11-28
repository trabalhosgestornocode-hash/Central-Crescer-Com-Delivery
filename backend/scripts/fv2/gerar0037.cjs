// Gera database/financeiro-v2/migracoes/0037_operacoes_de_conta_a_pagar.sql: cabeçalho escrito à mão + funções existentes COPIADAS
// do Git com alterações mínimas (cada troca confere que o trecho existe exatamente uma vez).
const fs = require("fs"); const path = require("path");
const M = path.join(__dirname, "../../../database/financeiro-v2/migracoes"); // uso: node scripts/fv2/gerar0037.cjs scripts/fv2/cabecalho0037.sql
const ler = (n) => fs.readFileSync(path.join(M, n), "utf8").replace(/\r\n/g, "\n");
function recortar(arquivo, nome) {
  const m = ler(arquivo); const i = m.search(new RegExp(`create (or replace )?function ${nome}\\(\\)`));
  if (i < 0) throw new Error(`${nome} em ${arquivo}`);
  return m.slice(i, m.indexOf("end $$;", i) + "end $$;".length).replace(/^create function/, "create or replace function");
}
const troca = (s, a, b) => { if (s.split(a).length !== 2) throw new Error("trecho não único: " + a.slice(0, 80)); return s.replace(a, b); };
const A = "'financeiro_v2.ajustar_conta_a_pagar'"; const C = "'financeiro_v2.cancelar_conta_a_pagar'";
const ESTREITA_AJ = `(fv2_pode_estreita(${A}) or fv2_pode_estreita(${C}))`;

let posicao = recortar("0036_corrigir_conta_a_pagar.sql", "fv2_vinculo_extrato_posicao");
posicao = troca(posicao, `  if not fv2_so_vincula() then
    return new;
  end if;
`, `  if not fv2_so_vincula() then
    return new;
  end if;
  -- 0037: operação ESTREITA de conta (competência, ajuste de valor, cancelamento) reconhecida na forma EXATA (fv2_forma_estreita_da_conta)
  if tg_table_name = 'fv2_obrigacao' then
    if fv2_forma_estreita_da_conta(old, new) is not null then
      return new;
    end if;
  end if;
`);

let acao = recortar("0036_corrigir_conta_a_pagar.sql", "fv2_exigir_acao_do_lancamento");
acao = troca(acao, `    if not fv2_tem_acao(array['financeiro_v2.cancelar', 'financeiro_v2.corrigir', 'financeiro_v2.revisar', 'financeiro_v2.corrigir_conta_a_pagar']) then`,
  `    -- 0037: + mover_competencia/cancelar_conta_a_pagar (a forma é conferida por fv2_lancamento_operacao_estreita)
    if not fv2_tem_acao(array['financeiro_v2.cancelar', 'financeiro_v2.corrigir', 'financeiro_v2.revisar', 'financeiro_v2.corrigir_conta_a_pagar',
                              'financeiro_v2.mover_competencia_conta_a_pagar', 'financeiro_v2.cancelar_conta_a_pagar']) then`);
acao = troca(acao, `  if not fv2_tem_acao(array['financeiro_v2.reclassificar']) then`,
  `  -- 0037: + reclassificar_conta_a_pagar (só a compra elegível: fv2_lancamento_operacao_estreita)
  if not fv2_tem_acao(array['financeiro_v2.reclassificar', 'financeiro_v2.reclassificar_conta_a_pagar']) then`);

let juros = recortar("0031_registrar_juros_no_pagamento.sql", "fv2_juros_documental");
juros = troca(juros, `    if new.origem->>'tipo' is distinct from 'AJUSTE' then
      return new; -- outros lançamentos são decididos pelas políticas/gatilhos das demais ações
    end if;`, `    if new.origem->>'tipo' is distinct from 'AJUSTE' then
      return new; -- outros lançamentos são decididos pelas políticas/gatilhos das demais ações
    end if;
    -- 0037: ajuste ESTREITO de valor/cancelamento (fora da categoria de juros): conferido pelos gatilhos da 0037
    if new.categoria_codigo <> 'JUROS_E_MULTAS_DE_FORNECEDORES' and ${ESTREITA_AJ} then
      return new;
    end if;`);
juros = troca(juros, `  -- fv2_ajuste
`, `  -- fv2_ajuste
  -- 0037: ajuste ESTREITO (lançamento fora da categoria de juros): conferido por fv2_ajuste_estreito
  if ${ESTREITA_AJ} and coalesce((select x.categoria_codigo from fv2_lancamento x where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.lancamento_id), '') <> 'JUROS_E_MULTAS_DE_FORNECEDORES' then
    return new;
  end if;
`);

let lancDesc = recortar("0036_corrigir_conta_a_pagar.sql", "fv2_correcao_de_lancamento");
lancDesc = troca(lancDesc, `  if (to_jsonb(old) - array['versao', 'atualizado_em', 'atualizado_por', 'descricao']) is distinct from (to_jsonb(new) - array['versao', 'atualizado_em', 'atualizado_por', 'descricao']) then`,
  `  -- 0037: a descrição NÃO mudou ⇒ não é correção cadastral (reclassificação, competência, cancelamento: conferidos pelas barreiras da 0037)
  if old.descricao is not distinct from new.descricao then
    return new;
  end if;
  if (to_jsonb(old) - array['versao', 'atualizado_em', 'atualizado_por', 'descricao']) is distinct from (to_jsonb(new) - array['versao', 'atualizado_em', 'atualizado_por', 'descricao']) then`);
let documental = recortar("0035_registrar_emprestimo.sql", "fv2_obrigacao_documental");
documental = troca(documental, `    if documental and new.origem->>'tipo' = 'AJUSTE' and fv2_tem_acao(array['financeiro_v2.registrar_juros']) then`,
  `    -- 0037: + ajuste ESTREITO de valor/cancelamento de parcela (forma conferida pelos gatilhos da 0037)
    if new.origem->>'tipo' = 'AJUSTE' and ((documental and fv2_tem_acao(array['financeiro_v2.registrar_juros'])) or ${ESTREITA_AJ}) then`);

const ajusteInsercao = `
-- 7) Inclusão do AJUSTE estreito: aponta para uma conta aberta/parcial da compra elegível e para o SEU lançamento (criado antes, mesma
--    transação), com o mesmo valor, a mesma categoria e a mesma competência da compra. Ajuste de juros segue a forma da 0031.
create or replace function fv2_ajuste_estreito() returns trigger language plpgsql as $$
declare
  ob record;
  lc record;
  la record;
begin
  if not ${ESTREITA_AJ} then
    return new;
  end if;
  select x.* into la from fv2_lancamento x where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.lancamento_id;
  if la.id is not null and la.categoria_codigo = 'JUROS_E_MULTAS_DE_FORNECEDORES' and fv2_so_registra_juros() then
    return new; -- encargo do pagamento: forma da 0031
  end if;
  select x.* into ob from fv2_obrigacao x where x.organizacao_id = new.organizacao_id and x.unidade_id = new.unidade_id and x.id = new.alvo_id;
  select x.* into lc from fv2_lancamento x where x.organizacao_id = ob.organizacao_id and x.unidade_id = ob.unidade_id and x.id = ob.lancamento_id;
  if new.alvo_tipo <> 'OBRIGACAO' or new.valor_centavos = 0 or la.id is null or la.origem->>'tipo' <> 'AJUSTE' or la.origem->>'id' <> new.id::text
     or la.valor_centavos <> new.valor_centavos or ob.id is null or ob.situacao not in ('ABERTA', 'PARCIAL') or lc.id is null
     or la.categoria_codigo <> lc.categoria_codigo or la.competencia <> lc.competencia or new.competencia <> lc.competencia
     or not fv2_compra_elegivel(lc.situacao, lc.origem, lc.natureza, lc.categoria_codigo) or not fv2_periodo_estreito(new.organizacao_id, new.unidade_id, new.competencia) then
    raise exception 'Financeiro v2: o ajuste estreito aponta para uma conta aberta da compra elegível e para o seu lançamento, na mesma categoria e competência.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger fv2_ajuste_estreito before insert on fv2_ajuste for each row execute function fv2_ajuste_estreito();

-- 8) Barreira de POSIÇÃO (0018/0031/0036): IDÊNTICA, reconhecendo as formas estreitas desta migração.
${posicao}

-- 9) Barreira de AÇÕES do lançamento (0014/0036): IDÊNTICA, com as ações estreitas desta migração nas listas.
${acao}

-- 10) Forma do ENCARGO (0031): IDÊNTICA, deixando o ajuste estreito (fora da categoria de juros) para os gatilhos desta migração.
${juros}

-- 12) Correção de lançamento (0036): IDÊNTICA, mas só atua quando a DESCRIÇÃO muda (as demais formas são das barreiras da 0037).
${lancDesc}

-- 11) Contas estreitas (0030/0033/0035): IDÊNTICA, aceitando o lançamento de AJUSTE estreito (conferido pelos gatilhos desta migração).
${documental}
`;
const cabecalho = fs.readFileSync(process.argv[2], "utf8").replace(/\r\n/g, "\n");
fs.writeFileSync(path.join(M, "0037_operacoes_de_conta_a_pagar.sql"), cabecalho + ajusteInsercao);
console.log("ok", (cabecalho + ajusteInsercao).length);
