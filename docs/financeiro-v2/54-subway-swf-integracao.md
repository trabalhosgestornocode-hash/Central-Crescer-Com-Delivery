# 54 — Subway: integração SWF + iFood + 99Food (19/11/2026)

> Versão pública (repositório aberto): **sem valores financeiros reais, nomes de pessoas ou identificadores de loja**. Os números da homologação com os relatórios reais de 01–17/11/2026 ficam num relatório privado fora do repositório.

## 1. Fontes de faturamento por unidade

- Cada unidade usa **um** sistema de loja (SAIPOS **ou** SWF) e as plataformas iFood e 99Food, sempre pelas fontes oficiais. Sem configuração gravada vale o padrão histórico (SAIPOS + iFood + 99Food): nenhuma unidade existente muda.
- A configuração fica no registro da unidade (`CONFIGURACAO_UNIDADE.fontesDeFaturamento`, sem migração), exige a permissão "Configurar" e justificativa, e entra no histórico (antes/depois, quem, quando). Tela: **Configurações → Fontes de faturamento**.
- Relatório de um sistema que a unidade não usa é **recusado na entrada**. Para o SWF, a loja impressa no relatório precisa ser uma das lojas cadastradas na unidade (`lojasSwf`).
- Menu: a unidade SWF vê "SWF" e não vê "SAIPOS"; as demais, o contrário.

## 2. Leitores SWF (fonte gravada `OUTRO`, tipo `SWF_*`, sem migração)

| Relatório | Uso | Regra |
|---|---|---|
| 76 — Vendas por canais | **Receita do Balcão** | Total do período por canal. Só o Balcão vira faturamento (total do período, **nunca repartido por dia**). iFood e 99Food do SWF são só conferência. O 76 não imprime o período: fica divergência para conferir. |
| 03 — Formas de pagamento | Controle | Separa pago no app × recebido pela loja (balcão **ou** entrega). |
| 45 — Análise de faturamento | Controle | Total do dia de todos os canais, com composição conferida. |
| Sangrias | Despesa paga em dinheiro (etapa explícita) | Ver seção 4. |

Conferência 76 × 03 × 45 (`GET /conferencia-swf`): total do 76 × 03, formas recebidas pela loja × Balcão, iFood/99Food do 76 × pago no app, total do 76 × soma do 45. Diferença fica **pendente de investigação**, sem presumir causa (pedidos de plataforma pagos na entrega entram nas formas da loja).

## 3. Calendário

- Balcão da unidade SWF: dia coberto por um 76 aparece como importado com a cobertura do período (sem valor do dia); o 45 aparece como controle do dia; dia sem documento fica sem registro (nunca zero). Anota Aí: "canal não usado".
- Sangrias aparecem no **dia operacional** do fechamento, com data/hora real, forma DINHEIRO, origem Caixa SWF, categoria e situação.

## 4. Sangrias do caixa SWF

- Leitor: grupos por dia operacional, cabeçalho repetido e rodapé de página ignorados, subtotais diários e total impresso **conferidos**; linha não reconhecida vira erro. Data operacional (dia do grupo no SWF) e data/hora real ficam separadas; madrugada é sinalizada.
- Sugestão por **regras auditáveis** (código da regra gravado; regras recalculadas a cada leitura): diária, segurança, frete/taxa de compra, descartáveis, material de escritório, limpeza → despesa; VR/VT → benefício (seção 5); adiantamento, transferência e motivo desconhecido → **pendência**.
- Lançamento é etapa separada e confirmada; a pessoa escolhe as retiradas. Cada uma vira conta **paga** (nunca conta aberta): conta no dia operacional (calendário/Contas a Pagar), **pagamento na data real** (fluxo de caixa). Antes de lançar, cruza com contas já pagas em dinheiro pelo caixa no dia operacional **ou** na data real (1 para 1 e por soma) — não duplica.
- Arquivo corrigido só substitui linhas com aceite e justificativa; despesa lançada de uma retirada substituída trava o dia até ser estornada.

## 5. VR/VT (regra confirmada pelo dono em 19/11/2026)

- DRE: Despesas com Pessoal › **Benefícios de pessoal** › **Vale-refeição** / **Vale-transporte** (subcategorias novas no modelo de plano; sem elas, usa Benefícios de pessoal).
- Pago normalmente pelo banco; às vezes em dinheiro pela sangria. Antes de lançar: obrigação de benefício **aberta** compatível (valor e competência) → **baixa** pelo caixa, sem despesa nova; duas ou mais → desempate pelo nome do motivo ou escolha manual; benefício **já pago** (conta quitada ou saída do banco com indício) → **bloqueio** por possível duplicidade; nada → despesa de benefício já paga.
- Competência: a do dia operacional; quando o motivo diz "REFERENTE A <dia>" posterior ao dia do fechamento, a competência é **escolhida na confirmação** (mês anterior ou o do fechamento). Decisão registrada do dono para o caso de 01/11/2026: **outubro/2026**.

## 6. iFood da Subway (importador existente; nada classificado nem aplicado)

- O relatório de conciliação precisa ser importado com período que cubra todos os movimentos (há ocorrência datada de 31/10).
- Quatro descrições novas sem classificação (Ressarcimento iFood; Promoção custeada pela rede; …pela rede no delivery; Débito – itens não perecíveis em cancelamento sem coleta) **bloqueiam** a aplicação. Propostas em análise: subsídio da rede como subsídio de terceiro; ressarcimento como indenização de pedido cancelado; débito como redutor da indenização.
- Os pedidos com "composição negativa de entrega" têm todos promoção custeada pela rede (o subsídio não entra na fórmula); o bloqueio foi mantido.
- Anúncio datado de 31/10 21:00 segue a regra atual (data de faturamento) até comprovação de outra competência.

## 7. Testes

`swf-subway.test.js`, `swf-sangrias.test.js`, `swf-sangrias-beneficios.test.js` (dados sintéticos). Suíte do Financeiro v2 com o PostgreSQL local de testes: ver o PR.

## 8. Publicação e próximos passos

1. Publicar o código (sem migração).
2. Configurar as fontes da unidade Subway (SWF, iFood, 99Food e a loja do SWF) e implantar o modelo de plano (cria só o que falta: Vale-refeição e Vale-transporte).
3. Etapas separadas, cada uma com autorização: importar 76/03/45/sangrias; aplicar o Balcão; lançar as sangrias; decidir as descrições do iFood e aplicar o relatório; 99Food quando houver relatório oficial.
