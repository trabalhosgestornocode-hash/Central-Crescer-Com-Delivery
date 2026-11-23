-- MOVA — Agente 2 (23/11/2026): ROTINA SEMANAL DOS ENTREGADORES — cadastro simples pelo gestor, leitura da nota fiscal,
-- aviso de liberação no grupo da unidade e relatório de quarta-feira. Nada é apagado; nenhum entregador é semeado.
--
--   * cadastro: o gestor informa o entregador OFICIAL (chave do fechamento do Financeiro) e o número; o backend confere a chave no
--     Financeiro antes de gravar. O papel da aplicação ganha INSERT e UPDATE só das colunas de revogação/verificação.
--   * nota: o resultado da leitura e da conferência (emitente, tomador, valor, período) fica na própria linha da nota.
--   * envios: tipos novos (aviso de liberação no grupo, relatório de quarta); a chave única continua impedindo repetição.
--   * automações: RELATÓRIO (quarta) e AVISO no grupo, com a mesma pausa individual por unidade.

-- Empresa exibida nas mensagens (nome da organização); opcional.
alter table mova.grupo_unidade add column empresa text check (empresa is null or length(btrim(empresa)) between 1 and 120);

alter table mova.entregador_autorizado add column cadastrado_por uuid, add column verificado_em timestamptz;
grant insert (organizacao_id, unidade_id, chave, telefone_e164, privado, ids, nome, cadastrado_por, verificado_em) on mova.entregador_autorizado to mova_app;
grant update (ativo, revogado_em, verificado_em) on mova.entregador_autorizado to mova_app;

alter table mova.nota_entregador add column leitura jsonb, add column conferencia text check (conferencia is null or conferencia in ('CONFERE', 'DIVERGENTE', 'INCONCLUSIVA'));
grant update (leitura, conferencia) on mova.nota_entregador to mova_app;

alter table mova.entregador_envio drop constraint entregador_envio_tipo_check;
alter table mova.entregador_envio add constraint entregador_envio_tipo_check check (tipo in ('SEMANAL', 'COBRANCA_NOTA', 'NOTA_RECEBIDA', 'AVISO_LIBERACAO', 'RELATORIO_QUARTA'));

alter table mova.automacao drop constraint automacao_nome_check;
alter table mova.automacao add constraint automacao_nome_check check (nome in ('ENTREGADORES_SEMANAL', 'ENTREGADORES_COBRANCA', 'RECONFERENCIA_EXTRATO', 'ENTREGADORES_RELATORIO', 'ENTREGADORES_AVISO_GRUPO'));
