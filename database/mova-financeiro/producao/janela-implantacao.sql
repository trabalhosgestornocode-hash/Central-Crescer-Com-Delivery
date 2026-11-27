-- MOVA — JANELA DE IMPLANTAÇÃO (PR #236: FV2 0033/0034 + MOVA 0025). Revisar antes de aplicar; rodar UM bloco por vez.
-- Objetivo: nenhum processamento financeiro concorrente com as migrações, SEM descartar mensagem do WhatsApp.
-- Como: só `processamento` é desligado. O RECEBIMENTO continua: o Gateway entrega e cada evento fica na fila (mova.fila), intacto,
-- até religar (gateway/receptor.js: "eventos ficam na fila, intactos, até religar"). O controle tem cache de 5 s no worker.
-- Mesmo efeito de controle.alterar() (operacao.js): atualiza mova.controle e registra CONTROLE_ALTERADO na auditoria.

-- ============================================================ 1. PAUSAR (antes das migrações)
begin;
update mova.controle set processamento = false, motivo = 'Janela de implantação PR #236 (FV2 0033/0034 + MOVA 0025): processamento pausado; recebimento segue na fila',
       atualizado_por = 'implantacao-pr236', atualizado_em = now() where id;
insert into mova.auditoria (acao, ator_tipo, ator_ref, dados)
values ('CONTROLE_ALTERADO', 'USUARIO', 'implantacao-pr236', '{"processamento": false, "motivo": "janela de implantação PR #236"}'::jsonb);
commit;

-- ============================================================ 2. CONFERIR (repetir até as DUAS contagens darem zero; ~10 s)
-- processando_agora = itens que um worker tomou antes da pausa (o lease ainda vale). Esperar terminar antes de migrar.
select (select recebimento from mova.controle where id) as recebimento_ligado,
       (select processamento from mova.controle where id) as processamento_ligado,
       count(*) filter (where estado = 'PROCESSANDO' and lease_ate > now()) as processando_agora,
       (select count(*) from mova.resposta where estado = 'ENVIANDO' and lease_ate > now()) as respostas_enviando,
       count(*) filter (where estado = 'PENDENTE') as pendentes_guardados
  from mova.fila;

-- ============================================================ 3. MIGRAR (fora deste arquivo)
--   database/financeiro-v2/producao/atualizar.sql  (exige exatamente 0001–0032 com hash; aplica 0033 e 0034)
--   database/mova-financeiro/producao/atualizar.sql (exige as 22 instaladas com hash; aplica 0025; 0019/0021 seguem adiadas)
--   Depois: deploy do código (merge do PR #236) e conferir /health = versão nova e "mova":"ATIVO".

-- ============================================================ 4. RETOMAR (depois das migrações e do deploy no ar)
begin;
update mova.controle set processamento = true, motivo = 'Janela de implantação PR #236 encerrada: processamento retomado',
       atualizado_por = 'implantacao-pr236', atualizado_em = now() where id;
insert into mova.auditoria (acao, ator_tipo, ator_ref, dados)
values ('CONTROLE_ALTERADO', 'USUARIO', 'implantacao-pr236', '{"processamento": true, "motivo": "fim da janela de implantação PR #236"}'::jsonb);
commit;
-- Os eventos guardados na fila são processados na ordem de chegada (os pendentes da etapa 2 devem baixar a zero).
