# 44 — Fases 07 e 08: iFood e 99Food pela fonte oficial, Visão Geral com quatro canais e faturamento manual provisório

> Documento público: **nenhum valor, taxa, nome ou pedido real**. Tudo o que está aqui foi conferido com dados sintéticos
> (testes `canais-plataforma`, `visao-geral-quatro-canais` e `fechamento-manual`) e, localmente, em memória, com o relatório real
> (só totais; ver doc 45).

## Fase 07 — iFood e 99Food só pela fonte oficial

### Regra
- A SAIPOS **não gera receita** de iFood nem de 99Food. O pedido desses canais lido da SAIPOS fica só como registro para conferência.
- **iFood:** a receita, as retenções (comissão e taxas) e o recebível líquido vêm do **demonstrativo oficial** do iFood.
  A comissão entra **uma vez** na DRE.
- **99Food:** canal próprio, com categoria de receita própria. Enquanto não houver arquivo oficial, a área mostra **"sem dados"**:
  nenhum valor é presumido e nada aparece como zero confirmado.

### Telas
- As áreas **iFood** e **99Food** do menu "Canais de faturamento" mostram o que veio da fonte oficial e o que está pendente.
- A conferência do caixa pode listar iFood e 99Food, mas só como conferência (nunca como faturamento).

## Fase 08 — Visão Geral, DRE e faturamento manual provisório

### Visão Geral com quatro canais
- Separa **Presencial (SAIPOS)**, **Anota Aí (SAIPOS)**, **iFood (oficial)** e **99Food**, sem somar nada duas vezes.
- Cada canal só aparece com o valor que a sua fonte entregou.

### DRE
- A **taxa estimada** (líquido esperado pela tabela de taxas) **não** vira despesa. Só a taxa **efetivamente cobrada** entra.
- Descontos sem financiador comprovado vão para "deduções a classificar".

### Faturamento manual provisório
- É uma **ação explícita**, separada do fechamento de caixa (o fechamento sozinho nunca cria receita).
- Cria uma venda marcada como **provisória** por dia × caixa × canal (Presencial ou Anota Aí), com formas, bandeiras, operadora e taxa estimada.
- **Bloqueios:**
  - recusado se o dia e o canal já têm vendas importadas da SAIPOS;
  - depois de registrado, a importação da SAIPOS do mesmo dia e canal é recusada até a **substituição auditada**.
- **Substituição auditada** (permissão de cancelar e justificativa):
  - cancela o provisório (não apaga) e estorna a entrada provisória em caixa, tudo com histórico;
  - libera a importação oficial.
- **Correção da Fase 09:** a substituição agora confere **antes de alterar qualquer coisa** se há repasse já recebido ou entrada já
  conciliada com o extrato. Nesse caso ela é recusada por inteiro, e nada fica meio estornado. Depois de estornar a liquidação,
  a substituição vale. Cobertura: teste "substituição: repasse já recebido recusa ANTES de alterar…".

## O que continua fora
- Nenhum arquivo oficial do iFood ou da 99Food real foi lido (depende da D4, doc 39).
- Nada foi publicado, migrado em produção ou gravado em dados reais.
