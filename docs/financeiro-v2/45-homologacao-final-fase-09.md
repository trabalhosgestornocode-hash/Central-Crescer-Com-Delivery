# 45 — Fase 09: homologação final local dos canais de faturamento

> Documento público: **nenhum valor, taxa, nome ou pedido real**. Os totais do relatório real foram conferidos só localmente,
> em memória, e batem com a contagem independente da planilha. Nada foi publicado, migrado em produção nem gravado em dados reais.

## 1. Estado
- Branch `feat/fv2-canais-faturamento`, partindo do commit `db48582` (árvore limpa na entrada).
- Migrações `0024` (canal 99Food e operadoras) e `0025` (fechamento manual de caixa): aplicadas **só** no PostgreSQL local isolado.
  Conferido em leitura no schema de produção: nenhuma das duas está lá.
- Nenhuma suíte ficou em execução de rodadas anteriores.

## 2. Testes (todos terminaram)
| Suíte | Total | Aprovados | Falhas | Ignorados |
|---|---|---|---|---|
| Backend em memória (`test/financeiro-v2`) | 487 | 487 | 0 | 0 |
| Backend no PostgreSQL local isolado (`FV2_REPOSITORIO=postgres`, banco exigido) | 487 | 487 | 0 | 0 |
| Frontend (`frontend/test`, todos) | 1995 | 1969 | 0 | 26 |

- Os 26 ignorados são testes de **navegador** (Playwright não configurado) de telas fora destes canais. As telas novas foram
  cobertas por testes de renderização com dados sintéticos (`financeiroV2Canais`).
- A suíte de isolamento entre empresas e unidades (`isolamento-autorizacao`, `isolamento-estatico` e o teste de isolamento de cada
  canal) está dentro dos 487.
- Os dois testes de frontend do doc 43 deixaram de falhar (commit `f625a69`).

## 3. Canais, operadoras, fechamento, provisório, Visão Geral e DRE
Homologados por teste sintético, sem alterar teste para esconder erro:
- **SAIPOS Presencial e Anota Aí:** layout real de 26 colunas, ficha sem canal = Presencial, duplicatas exatas continuam duas vendas,
  reimportação e período sobreposto sem duplicar, cancelado não vira venda, forma estranha e múltiplas formas viram conferência.
- **iFood e 99Food:** nunca viram venda pela SAIPOS; iFood só pelo demonstrativo oficial; 99Food sem dado = "sem dados".
- **Operadoras e taxas:** Stone, PagBank e maquininha do iFood; vigência na data da venda com a versão gravada; operadoras simultâneas
  viram ambiguidade; crédito sempre à vista; Pix da maquininha só no presencial; taxa desconhecida **nunca** vira zero.
- **Fechamento manual:** vários caixas por dia, esperado × informado, histórico de correção, comparação sem criar receita.
- **Provisório:** explícito, bloqueia importação conflitante, substituição auditada.
- **Visão Geral e DRE:** quatro canais sem duplicar; taxa estimada não vira despesa; comissão do iFood entra uma vez.

## 4. Relatório real "Vendas por período" (01 a 16/11/2026) — conferência local em memória
- O arquivo foi lido sem erros e sem divergências na leitura. Ficou **fora do Git**; só totais foram impressos.
- Os totais do sistema **bateram com a contagem independente** (feita à parte, com outra ferramenta):
  - **Presencial:** igual ao total esperado;
  - **Anota Aí:** bruto (itens + entrega) igual ao esperado, e descontos iguais ao esperado;
  - **iFood e 99Food:** nenhuma venda gerada pela SAIPOS.
- Quantidade de vendas formadas = fichas válidas + pedidos válidos do Anota Aí; cancelados ficaram de fora.
- Pendências geradas: 1 ficha com forma "Online iFood" (pagamento a evidenciar) e os descontos do Anota Aí sem financiador comprovado
  (vão para deduções a classificar).
- **Taxas:** sem operadoras e tabelas cadastradas (D3), o líquido esperado fica **PENDENTE** e o valor "sem cálculo" mostra o bruto
  sem taxa. Nunca aparece como zero confirmado.
- Reimportar o mesmo arquivo devolve a mesma importação e não altera nenhum total.
- A aplicação das propostas é feita em lotes de 400; foram necessárias 3 rodadas, todas sem falha.

## 5. Problema encontrado e corrigido
**Substituição do provisório deixava efeito parcial** (`aplicacao/fechamentoManual.js`):
- Cenário: o provisório tinha dinheiro em caixa e Pix da maquininha; o repasse do Pix já tinha sido recebido e conciliado.
- Antes: a substituição estornava o dinheiro em caixa e só depois era recusada ao tentar cancelar a venda. Resultado: venda ainda
  ativa, com o pagamento em dinheiro estornado.
- Agora: tudo o que impede a substituição (repasse já recebido ou entrada conciliada com o extrato) é conferido **antes** de
  qualquer alteração. A recusa é por inteiro e nada muda. Depois de estornar a liquidação, a substituição vale.
- Teste novo no `fechamento-manual.test.js`. Foi conferido que ele **falha sem a correção** e passa com ela.
- Lançamentos já conciliados não são tocados em nenhum caminho.

## 6. Segurança (auditoria local)
- Cada escrita nova passa pelo núcleo com a permissão da ação (registrar, cancelar, configurar); sem permissão, recusa.
- Unidade e empresa vêm da sessão. A unidade nunca vai no corpo da requisição, e os campos desconhecidos são recusados.
- Isolamento entre empresas e unidades: coberto por teste em cada canal, em memória e no PostgreSQL (RLS por escopo).
- Tabela nova (`fv2_fechamento_caixa`): RLS forçada, política por ação, sem exclusão, versão e histórico obrigatórios.
- A migração `0024` só amplia restrições CHECK: nenhuma linha atual deixa de valer.
- Nada foi habilitado: escrita em produção, permissões e liberações ficaram como estavam.

## 7. Reimportação de 16/11 — relatório de impacto e plano (não executado)
**Situação (em leitura, só contagens):** em produção, a importação por formas de pagamento criou vendas de iFood e de um canal
"outro" a partir da SAIPOS, e vendas de Balcão que incluem pedidos pagos na entrega do iFood. Isso contraria a regra "a SAIPOS não
alimenta iFood nem 99Food". Os valores exatos ficam fora deste documento público.

**Impacto da correção:**
- as vendas de iFood e "outro" vindas da SAIPOS saem da receita (cancelamento lógico, com histórico);
- o Balcão e o Anota Aí passam a refletir o relatório por pedido (o Anota Aí passa a incluir a entrega);
- recebíveis: as vendas de iFood da SAIPOS não têm repasse real. Antes de cancelar, conferir se algum recebível já foi
  liquidado ou conciliado (a substituição e o cancelamento recusam por inteiro se houver).

**Plano (depende da decisão D1 do proprietário):**
1. Congelar o estado: listar as vendas de formas de pagamento do período e seus recebíveis, só leitura.
2. **Antes de cancelar**, estornar as entradas em dinheiro no caixa dessas vendas pela rota de estorno de pagamento, com o motivo
   "correção de pagamento" (anula a entrada inteira; só vale se a entrada ainda não foi conciliada). O cancelamento da venda é
   **recusado** enquanto houver dinheiro já registrado em conta. *(Correção feita na Fase 10: a versão anterior deste plano não tinha este passo.)*
3. Cancelar pela rota existente `/vendas/cancelar` (justificativa e trilha), em lotes pequenos, conferindo o total a cada lote.
4. Importar o relatório por pedido do mesmo período (leitor `SAIPOS_VENDAS`), revisar as pendências, e aplicar as propostas em lotes de 400.
5. Conferir contra a contagem independente (Presencial, Anota Aí bruto e descontos, zero de iFood e 99Food pela SAIPOS).
6. Ensaiar tudo antes em cópia local sanitizada.

## 8. Pendências externas
- **D1:** autorização para cancelar as vendas de 16/11 e reimportar por pedido.
- **D3:** taxas reais e vigência de Stone, PagBank e maquininha do iFood. Sem elas, o líquido esperado fica pendente.
- **D4:** amostras reais oficiais do iFood (repasse ou financeiro) e da 99Food para os leitores.
- Autorização para aplicar as migrações 0024 e 0025 em produção, e para publicar.

## 9. Riscos de produção
- Publicar o código **sem** aplicar `0024`/`0025` quebra o canal 99Food e o fechamento manual: aplicar o pacote primeiro.
- Importar por pedido **antes** de resolver o 16/11 é recusado pelo conflito de granularidade (comportamento esperado).
- Sem taxas cadastradas, os cartões mostram "taxa pendente". Não é erro.
- Testes de navegador (26) não rodaram neste ambiente: conferir as telas novas no navegador antes de abrir ao uso.

## 10. Checklist para publicar (nada disso foi feito)
- [ ] Decisão explícita do proprietário para publicar.
- [ ] Backup verificado do schema dedicado.
- [ ] Aplicar `0024` e `0025` pelo pacote de produção (`atualizar.sql`), com inventário antes e depois.
- [ ] Publicar o backend (o mesmo serviço entrega o frontend) e conferir o status do módulo.
- [ ] Verificar as liberações por unidade (a escrita continua como está).
- [ ] Abrir as telas novas no navegador, em unidade de teste.
- [ ] Só então tratar D1 (16/11), D3 (taxas) e D4.

## 11. Plano de reversão
- **Código:** reverter o merge (ou publicar o commit anterior). As telas novas somem do menu.
- **Dados:** as tabelas e colunas novas não são lidas pelo código anterior. `fv2_fechamento_caixa` pode ficar sem uso. As
  restrições CHECK ampliadas de `0024` não impedem nenhuma linha antiga. Não apagar nada: o histórico é só de acréscimo.
- **Vendas provisórias:** a reversão é a substituição auditada (cancela e estorna a entrada, com histórico).
- **Reimportação de 16/11:** se algo divergir, cancelar o lote importado pela rota de cancelamento. As vendas já canceladas ficam
  canceladas, e a decisão de reativar é do proprietário.

## 12. Classificação
**GO CONDICIONAL.** A implementação está validada (487/487 nos dois bancos, 0 falhas no frontend, relatório real conferido, um
defeito encontrado e corrigido). Ficam as pendências específicas acima: D1, D3, D4, os testes de navegador e a autorização de
publicação.
