-- Foody · verificações REPRODUZÍVEIS dos ciclos do agendador (SOMENTE LEITURA — nenhum comando altera dados).
-- Rodar no SQL Editor do Supabase (ou execute_sql) a cada ciclo observado. Substitua :desde pela hora de início do deploy
-- (ex.: '2026-11-05 03:05+00'). Ciclo = a cada 6 h; cada ciclo sincroniza D-1, D-2, D-3 da unidade da allowlist.

-- 1) SAÚDE — todas as execuções desde :desde. Esperado: status CONCLUIDA, erro_codigo nulo, origem 'agendado'.
select iniciado_em, competencia, origem, status, erro_codigo, inseridos, atualizados, inalterados, catalogo_versao,
       pedidos_triagem, fechamentos, fechamentos_pendentes
  from foody_sync_execucoes
 where iniciado_em >= '2026-11-05 03:05+00'
 order by iniciado_em;

-- 2) CONCORRÊNCIA — nunca duas execuções da mesma conexão sobrepostas. Esperado: 0 linhas.
select a.id as exec_a, b.id as exec_b, a.competencia, a.iniciado_em, a.concluido_em, b.iniciado_em as b_ini
  from foody_sync_execucoes a
  join foody_sync_execucoes b on a.conexao_id = b.conexao_id and a.id < b.id
   and a.iniciado_em < coalesce(b.concluido_em, now()) and b.iniciado_em < coalesce(a.concluido_em, now())
 where a.iniciado_em >= '2026-11-05 03:05+00';
-- ...e nenhuma execução presa. Esperado: 0 linhas (a migration 150 garante uma em andamento por conexão).
select id, competencia, status, iniciado_em from foody_sync_execucoes
 where concluido_em is null and iniciado_em < now() - interval '15 minutes';

-- 3) IDEMPOTÊNCIA — ciclo sem mudança no mundo real não cria versão nova. Esperado: no máximo 1 linha por (org, unidade, dia, versão).
select organizacao_id, unidade_id, competencia, versao, count(*) as copias
  from foody_fechamentos_logisticos
 group by 1,2,3,4 having count(*) > 1;
-- Versões por dia (versão sobe só quando o conteúdo muda; hash repetido entre versões vizinhas = anomalia). Esperado: 0 linhas.
select a.organizacao_id, a.competencia, a.versao as v, b.versao as v_seguinte
  from foody_fechamentos_logisticos a
  join foody_fechamentos_logisticos b on b.organizacao_id = a.organizacao_id and b.unidade_id = a.unidade_id
   and b.competencia = a.competencia and b.versao = a.versao + 1 and b.hash_conteudo = a.hash_conteudo;

-- 4) PRESERVAÇÃO DE VERSÕES — nenhum histórico some: cada dia mantém v1..vN sem buracos. Esperado: 0 linhas.
select organizacao_id, unidade_id, competencia, min(versao) as minv, max(versao) as maxv, count(*) as n
  from foody_fechamentos_logisticos
 group by 1,2,3 having min(versao) <> 1 or max(versao) <> count(*);

-- 5) ISOLAMENTO — pedido e fechamento só na organização da operação. Esperado: 0 linhas em cada consulta.
select p.id, p.organizacao_id, p.operacao
  from foody_pedidos p
 where p.roteamento_ativo and ((p.operacao = 'subway'       and p.organizacao_id <> '00000000-0000-0000-0000-000000000001')
                            or (p.operacao = 'acai_no_grau' and p.organizacao_id <> 'e7216085-1ece-45dc-bc41-d74f11a88e40'));
-- Pedido ativo duplicado (mesmo foody_uid ativo em mais de uma linha). Esperado: 0 linhas.
select foody_uid, count(*) from foody_pedidos where roteamento_ativo group by 1 having count(*) > 1;

-- 6) PARIDADE — recompor os totais de um dia e conferir com o Excel do suporte (ou com a execução anterior).
--    Troque as datas. Compare com: contagem, cancelados, soma taxa_entregador, soma taxa_entrega, soma valor_total.
select competencia, operacao, count(*) as pedidos,
       count(*) filter (where situacao = 'Cancelado') as cancelados,
       sum(taxa_entregador) as taxa_entregador, sum(taxa_entrega) as taxa_entrega, sum(valor_total) as valor_total
  from foody_pedidos
 where roteamento_ativo and competencia between '2026-10-31' and '2026-11-01'
 group by 1,2 order by 1,2;
-- Checksum linha a linha (mesmo formato do script de paridade de 05/11; deve ser idêntico ao do Excel enquanto o dia estiver congelado).
select count(*) as n, md5(string_agg(k, E'\n' order by k collate "C")) as hash from (
  select numero_pedido||'|'||to_char(data_hora,'DD/MM/YYYY HH24:MI:SS')||'|'||situacao||'|'||to_char(taxa_entregador,'FM999990.00')
         ||'|'||to_char(taxa_entrega,'FM999990.00')||'|'||to_char(valor_total,'FM999990.00') as k
    from foody_pedidos where roteamento_ativo and competencia between '2026-10-31' and '2026-11-01') t;

-- 7) TRIAGEM — pedidos aguardando decisão humana (mantêm o dia PRELIMINAR). Nada aqui é decidido automaticamente.
select competencia, foody_uid, numero_pedido, triagem_motivo, ponto_coleta, left(detalhes_pedido::text, 120) as itens
  from foody_pedidos where operacao = 'triagem' and roteamento_ativo order by competencia, numero_pedido;
