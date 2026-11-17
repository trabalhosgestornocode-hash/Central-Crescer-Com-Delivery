# 42 — Fechamento manual, área SAIPOS e Operadoras e Taxas (Fases 04, 05 e 06)

> Documento público: **nenhum valor, taxa ou nome real**. As telas foram conferidas no ambiente demonstrativo local
> (`scripts/fv2-demo-interface.mjs`, dados e taxas fictícios).

## Fase 04 — Fechamento manual de caixa

### O que é
- O registro do fechamento que a equipe envia. Há **um por dia × caixa**, e o mesmo dia pode ter vários caixas.
- É **conferência**: não cria receita, lançamento nem movimentação. O faturamento continua vindo das importações, então nada é somado duas vezes.

### Campos
- Data, caixa, responsáveis pela abertura e pelo fechamento, horários e observações.
- **Dinheiro:** abertura, vendas, reforços, retiradas, transferências e valor contado.
  - Esperado = abertura + vendas + reforços − retiradas − transferências.
  - Diferença = contado − esperado.
- **Formas (grade fixa):** cada uma com valor esperado (opcional) e informado.
  - crédito 1x por bandeira;
  - débito por bandeira;
  - Pix por operadora (maquininha do iFood, Stone, PagBank, Pix direto);
  - voucher por bandeira;
  - Anota Aí (separado), outras formas;
  - iFood e 99Food **só para conferência do caixa**.

### Regras
- Repetir o mesmo fechamento não faz nada.
- Mudar um fechamento já registrado é **correção**: exige justificativa, e a versão anterior fica no histórico.
- Data futura e competência homologada são recusadas.

### Comparação do dia
- O fechamento (soma dos caixas) é comparado com as vendas do dia (Presencial e Anota Aí) por forma, bandeira e operadora.
- Situações de cada linha: `CONFERE`, `DIVERGENTE`, `SO_MANUAL` (só no fechamento), `SO_IMPORTADO` (só na importação).
- Zero informado sem venda conta como "confere".
- Voucher importado **sem bandeira** (a SAIPOS diz só "Vale"): compara o total do voucher do dia, sem inventar bandeira.
- **Sem relatório importado:** o dia fica "sem relatório importado", com origem manual explícita, e **não** entra no faturamento.
- iFood e 99Food do caixa nunca entram na comparação de faturamento.

### Banco
- Migração `0025_fechamento_manual_caixa.sql` cria a tabela `fv2_fechamento_caixa`, com as proteções das demais:
  - RLS por empresa e unidade;
  - sem exclusão;
  - versão e histórico obrigatórios;
  - inserção só com `financeiro_v2.registrar`.
- Foi aplicada **somente** no PostgreSQL local isolado. O pacote de produção foi regenerado, e não foi aplicado.

### Rotas
- `/fechamento-manual/registrar` (ação).
- `/fechamento-manual` (consulta por período, com a comparação diária e as operadoras).

## Fase 05 — Área SAIPOS (menu "Canais de faturamento")

### Menu
- Novo grupo **Canais de faturamento**: SAIPOS, iFood, 99Food, Operadoras e Taxas.
- Os demais grupos foram mantidos.

### Abas da SAIPOS
Todas têm filtro de período; o padrão é o mês da competência, até a data-base.
- **Resumo:**
  - Presencial e Anota Aí, com vendas e dias;
  - pedidos iFood e 99Food do relatório **só para conferência**;
  - importações e pendências.
- **Presencial** e **Anota Aí:** cards separados por modalidade (crédito 1x, débito, Pix, dinheiro, voucher).
  - Cada card mostra: bruto, taxas estimadas, percentual efetivo, líquido esperado, recebido confirmado, diferença e situação.
  - Situações: pendente, aguardando extrato, parcial, conciliado, divergente.
  - **Expandir:** crédito e débito mostram as bandeiras; Pix mostra as operadoras.
  - "Ver lançamentos" abre os pagamentos e as vendas que compõem o total.
  - Taxa não configurada aparece como **"Taxa não configurada"** e fica fora do líquido. **Nunca aparece como zero.**
  - Recebido sem confirmação aparece como **"Não confirmado"**.
- **Importações:** relatórios SAIPOS que cobrem o período, com a prévia e as propostas no painel. Botão "Importar relatório".
- **Fechamento manual:** o formulário e, por dia, os caixas e a comparação com a importação.
- **Conferências:**
  - pendências das importações (agrupadas por código);
  - propostas não aplicadas;
  - pedidos iFood e 99Food do relatório SAIPOS (só conferência).

### iFood e 99Food
- Mostram o faturamento **da fonte oficial**. Sem dados oficiais, aparece "Sem dados da fonte oficial", nunca zero.
- O parser da 99Food aguarda uma amostra real (D4).

### Sem dinheiro calculado na tela
- Os totais dos cards, o líquido por pagamento e o percentual efetivo vêm do servidor.
- O teste `financeiroV2Canais` garante que a tela não soma valores.

## Fase 06 — Operadoras e Taxas
- **Cada operadora mostra:**
  - código, tipo, vigência, modalidades e situação;
  - **versões das tabelas de taxas** (vigência, modalidade, bandeira, percentual, tarifa fixa, fonte);
  - **histórico** (cadastro e alterações, com justificativa).
- **Ações** (só com `financeiro_v2.configurar`):
  - cadastrar operadora (Stone, PagBank, maquininha do iFood, máquina de terceiros, operadora de benefícios);
  - editar o nome;
  - ativar ou desativar;
  - encerrar a vigência;
  - registrar uma nova tabela de taxas: modalidades débito, crédito 1x, Pix e voucher; qualquer bandeira; tarifa fixa opcional.
- **O que não acontece:**
  - nada é apagado;
  - tabela nova não recalcula vendas já registradas, porque cada venda guarda a versão usada;
  - vigências da mesma operadora não se sobrepõem;
  - duas operadoras ativas para a mesma forma no mesmo dia mandam a venda para conferência.
- **Maquininha do iFood:** a taxa Pix informada pelo proprietário **não foi gravada em produção**, porque a vigência ainda depende de confirmação. Nos testes e na demonstração a taxa é fictícia.

## Testes
- **Backend:**
  - `fechamento-manual.test.js`: cálculo, vários caixas, correção auditada, sem relatório, comparação com importação, voucher, isolamento e permissão;
  - os existentes ajustados à tabela nova.
- **Frontend:** `financeiroV2Canais.test.js`:
  - taxa pendente nunca como zero;
  - "não confirmado";
  - bandeiras e Pix por operadora;
  - grade igual à do servidor;
  - permissões;
  - menu;
  - nenhuma soma de dinheiro na tela.
- **Navegador (demonstração local):**
  - cards e expansão por bandeira e operadora;
  - painel de lançamentos;
  - fechamento registrado pelo formulário com a comparação na hora;
  - cadastro de PagBank, nova tabela de taxas e desativação;
  - celular sem rolagem lateral.
