# 39 — Canais de faturamento: diagnóstico (Fase 01)

> Documento público: **nenhum valor, pedido, cliente ou taxa real**. Os números do arquivo real ficam fora do Git.

## Objetivo da evolução

O faturamento deve vir de quatro canais separados, cada um da sua fonte:

| Canal | Fonte |
|---|---|
| Presencial | SAIPOS |
| Anota Aí | SAIPOS |
| iFood | relatórios oficiais do iFood |
| 99Food | relatórios oficiais da 99Food |

Também deve haver:
- taxas por operadora, com vigência;
- fechamento manual de caixa;
- cards expansíveis por modalidade e bandeira;
- consolidação na Visão Geral e na DRE.

## 1. O que já existe e será reaproveitado

| Necessidade | O que existe hoje | Situação |
|---|---|---|
| Canal da venda | `CANAL = BALCAO, IFOOD, ANOTA_AI, OUTRO` (`dominio/catalogos.js`). Categorias `VENDA_<CANAL>` no plano de contas | Falta 99Food como canal próprio (hoje cai em `OUTRO`). "Presencial" corresponde a `BALCAO` (só muda o rótulo) |
| Forma × processador × conta | Venda com pagamentos (`forma`, `processador`, `contaId`). Recebível nasce do processador | Reaproveitar. Falta a **bandeira** no pagamento e o processador `PAGBANK` |
| Taxas contratadas | `dominio/taxasContratadas.js` + `aplicacao/taxasContratadas.js` (doc 35): tabela por modalidade × bandeira, vigência, fonte, sem 0%, versões sem sobreposição, conferência transação a transação | **Só Stone** (`processador !== "STONE"` é recusado). Modalidades: débito, crédito à vista, Pix. Sem voucher. Sem tarifa fixa. Guardada na extensão da configuração da unidade (sem migração) |
| Taxas na DRE | doc 36: `reconhecerTaxasDoPeriodo` lança a soma exata cobrada pela Stone (`TAXAS_STONE`) uma vez por importação/competência | Reaproveitar. Base = taxa **cobrada** (relatório Stone), não estimada |
| iFood oficial | doc 38: `registrarDemonstrativoIfood` (receita iFood + recebível com comissões, taxas, mensalidade). Granularidade única: não convive com venda iFood vinda da SAIPOS | Reaproveitar. A regra "SAIPOS não alimenta iFood" **já era decisão do proprietário** |
| Importação | motor com prévia, impressão digital, deduplicação por identidade, confirmação, propostas, aprovação, aplicação, conflito de granularidade | Reaproveitar integralmente |
| Leitor SAIPOS por pedido | `SAIPOS_VENDAS` (`importacao/fontes/saipos.js`) | **Sintético: não lê o layout real** (ver §2) |
| Leitor SAIPOS formas de pagamento | `SAIPOS_FORMAS_PAGAMENTO` + vendas por dia × forma (PR #118) | O relatório **não informa o canal**. Mistura Presencial, Anota Aí, iFood e 99Food. Incompatível com a regra nova (ver §4) |
| Caixa físico | `fv2_sessao_caixa` (abrir/fechar caixa com contado × esperado) | Base para o fechamento manual. Falta a conferência por forma e bandeira |
| Visão Geral / DRE | composição por canal (Balcão, iFood, Anota AI, Outros) | Falta 99Food separado e o detalhamento por modalidade e bandeira |
| Menu | grupos Análise, Contas e caixa, Operação, Administração (`frontend/financeiro-v2/index.html`) | Falta o grupo **Canais de faturamento** |

## 2. Layout real do relatório "Vendas por período" (SAIPOS)

São 26 colunas, nesta ordem:
- Pedido
- Código da loja
- Nome da loja
- Tipo do pedido
- Turno
- Canal de venda
- Id do pedido no parceiro
- Número do pedido no parceiro
- Data da venda
- Consumidor
- Tem cupom
- Pagamento
- Está cancelado
- Motivo do cancelamento
- Itens
- Entrega
- Valor Entregador
- Entregador
- Bairro
- CEP
- Acréscimo
- Motivo de acréscimo
- Desconto
- Motivo do desconto
- Total
- Total taxa de serviço

Observações do arquivo real (sem valores):

- **Presencial:** `Canal de venda` vazio, `Tipo do pedido = F` (ficha) e `Pedido = "Ficha"`.
  - Não há identificador da venda nem código ou nome da loja.
  - Cada linha tem um único meio de pagamento.
- **Integrações:** `Canal de venda` = `iFood`, `Anota.ai` ou `99 Food`. `Tipo do pedido = D` (delivery) ou `B` (balcão).
  - Estas linhas têm `Id do pedido no parceiro` (UUID), que é um identificador confiável.
- **Cancelamento:** `Está cancelado = S/N`.
- **Pagamento:** pode ter várias descrições separadas por vírgula e **não há valor por meio**.
  - Exemplos: "Online iFood, Voucher Parceiro Desconto" e "Pago Online, Pago Online".
- **"Voucher Parceiro Desconto":** no período examinado aparece **somente em pedidos iFood**. É desconto de parceiro do iFood. Fica fora da apuração SAIPOS junto com o iFood.
- **"Pago Online via Pix":** aparece somente em fichas presenciais.
  - É Pix em maquininha na loja.
  - **A operadora está pendente de confirmação** (ver §5).
- **"Pix na Entrega":** no período, só em pedido iFood.
- Uma ficha presencial com pagamento "Online iFood" aparece como exceção e deve ir para conferência.
- **Fórmula do total:** `Itens − Desconto + Entrega + Acréscimo = Total` fechou em todas as fichas presenciais.

### Por que o leitor atual não serve

| Ponto | Leitor `SAIPOS_VENDAS` atual | Arquivo real |
|---|---|---|
| Data | espera "Data", "Data do pedido", "Data/Hora" | "Data da venda" → cabeçalho não reconhecido |
| Cancelamento | coluna "Situação/Status" obrigatória, texto "cancel…" | "Está cancelado" S/N |
| Canal vazio | vira pendência (`null`) | canal vazio = **Presencial** |
| 99 Food | não reconhecido | "99 Food" |
| Identificador | `idExterno = Pedido` | "Ficha" se repete centenas de vezes → as fichas colapsariam como duplicadas |
| Pagamento múltiplo | uma forma | lista sem valor por meio → não dividir; marcar pendente |

### Identidade das linhas (deduplicação)

- **Integrações:** `canal + Id do pedido no parceiro`.
- **Fichas:** não têm identificador. A identidade auditável é `data-hora (minuto) + total + pagamento + itens + desconto + entrega + acréscimo`.
  - Quando há repetição exata dentro do arquivo, o número da ocorrência entra na identidade (1ª, 2ª…) e a linha fica marcada como *indistinguível*.
  - Numa reimportação, linhas indistinguíveis só são reconhecidas pela mesma contagem por minuto. Se a contagem mudar, vai para revisão, nunca para soma silenciosa.

## 3. Respostas à auditoria do motor de taxas

1. **Onde estão as taxas?** Na extensão (`extras.taxasContratadas`) da configuração da unidade, versionadas pelo histórico da configuração.
2. **Associadas à operadora?** Sim, mas a operadora é fixa: só Stone.
3. **Histórico de vigência?** Sim, com início e fim sem sobreposição por processador. Não há encerramento de operadora nem operadoras simultâneas com escolha por data.
4. **A importação SAIPOS aplica as taxas?** Não. As taxas só são conferidas sobre o relatório de vendas **Stone**. A venda SAIPOS não calcula líquido esperado.
5. **A bandeira é identificada?** No relatório Stone, sim. Na SAIPOS, a bandeira está no texto do pagamento ("Débito Master") e hoje é descartada.
6. **O Pix usa a modalidade correta?** Na Stone, `PIX`. Na SAIPOS, "Pago Online via Pix" não tem operadora definida.
7. **O líquido está correto?** Na conferência Stone, sim (por transação, com centavo meio-para-cima). Não existe líquido esperado para a SAIPOS.
8. **Chega à Visão Geral e à DRE?** A tarifa cobrada entra na DRE pelo doc 36 (`TAXAS_STONE`). O líquido esperado não aparece em lugar nenhum.
9. **Há contagem dupla de taxas?** Há proteção: a taxa por venda (pagamento Stone aplicado) é excluída do total do período. Uma taxa **estimada** pela tabela não pode virar despesa junto com a taxa **cobrada** da Stone. A estimativa deve ser só informativa ou de conferência.
10. **A conciliação distingue estimativa de confirmado?** Sim: os estados vão de recebível a repasse informado, crédito em conta e conciliação. "Taxa calculada" ainda não é um estado próprio.

## 4. Conflitos com o que está em produção

1. **Importação de 16/11 (formas de pagamento → vendas):**
   - Ela gerou vendas iFood e 99Food a partir da SAIPOS.
   - Ela também gerou vendas de Balcão que incluem pagamentos de pedidos iFood: dinheiro, cartão e Pix pagos na entrega.
   - Isso contraria a regra (já existente no doc 38 e reafirmada agora): **SAIPOS não alimenta iFood nem 99Food**.
   - Correção proposta, que **depende de autorização**:
     - cancelar essas vendas pela rota existente `/vendas/cancelar`, com justificativa e trilha;
     - reimportar o período pelo relatório **por pedido**, que separa os canais.
   - O leitor de formas de pagamento passa a servir só para conferência do caixa.
2. **De-para de "Pago Online via Pix":**
   - Em 16/11 foi informado como "maquininha do iFood na loja".
   - O pedido atual diz que é Stone.
   - A classificação depende dessa confirmação. Até lá: **operadora pendente** (vai para conferência, sem taxa).

## 5. Decisões necessárias do proprietário

- **D1:** autorizar o cancelamento das vendas criadas em 16/11 pela importação de formas de pagamento e a reimportação pelo relatório por pedido.
- **D2:** confirmar a operadora de "Pago Online via Pix": Stone, maquininha do iFood ou outra.
- **D3:** fornecer as taxas reais de cada operadora (Stone e, se houver, PagBank). Sem elas, os cards mostram "Taxa não configurada".
- **D4:** amostras reais dos relatórios oficiais do iFood (repasse ou financeiro) e da 99Food, para os parsers.

## 6. Plano de implementação (local, sem produção)

- **Fase 02 — núcleo:**
  - canal `NOVENTA_E_NOVE_FOOD`;
  - operadoras cadastráveis (generalizar a tabela Stone para N operadoras com ativação, encerramento e vigência);
  - modalidades com voucher e tarifa fixa;
  - bandeira no pagamento;
  - cálculo do líquido esperado com a versão da taxa gravada na venda;
  - operadoras simultâneas → conferência.
- **Fase 03 — leitor real "Vendas por período":**
  - Presencial e Anota Aí entram como venda;
  - iFood e 99Food ficam como registro só de conferência;
  - deduplicação conforme §2;
  - pagamento múltiplo vai para pendência.
- **Fase 04 — fechamento manual:** sobre a sessão de caixa, por forma e bandeira, vários caixas no dia e comparação com a importação.
- **Fase 05 — tela SAIPOS (Presencial e Anota Aí):** cards expansíveis com bruto, taxa, percentual efetivo e líquido.
- **Fase 06 — Operadoras e Taxas:** tela de cadastro.
- **Fase 07 — iFood e 99Food:** áreas próprias com o que existe (demonstrativo iFood) e estrutura para os formatos reais.
- **Fase 08 — consolidação:** Visão Geral com os 4 canais e DRE com as taxas na classificação certa.
- **Fase 09 — homologação.**
