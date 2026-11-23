-- MOVA — Agente 2 (23/11/2026): CADASTRO COMPLETO DOS ENTREGADORES (fonte ÚNICA de contatos, usada pelo Financeiro e pelo MOVA).
-- Nada é apagado e nenhum dado existente muda. Toda alteração (troca de número, nome de exibição, observação, desativação)
-- ENCERRA a linha vigente (ativo = false, quem, quando e por quê) e, quando for o caso, abre uma linha nova: o histórico é a
-- própria sequência de linhas (valor anterior e novo, ator e horário), sem UPDATE de dado cadastral.
--
--   * observacoes: anotação operacional (opcional, até 500 caracteres). CPF, Pix e afins NÃO têm coluna (não são pedidos).
--   * revogado_por / motivo_revogacao: quem encerrou a linha e por quê.

alter table mova.entregador_autorizado
  add column observacoes text check (observacoes is null or length(observacoes) <= 500),
  add column revogado_por uuid,
  add column motivo_revogacao text check (motivo_revogacao is null or motivo_revogacao in ('DESATIVADO', 'TROCA_DE_NUMERO', 'EDICAO'));

grant insert (observacoes) on mova.entregador_autorizado to mova_app;
grant update (revogado_por, motivo_revogacao) on mova.entregador_autorizado to mova_app;
