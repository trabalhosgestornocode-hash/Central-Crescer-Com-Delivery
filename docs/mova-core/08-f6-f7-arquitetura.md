# MOVA CORE — Arquitetura F6 (análise gerencial) e F7 (avisos proativos)

Documento de arquitetura. **Nada implementado nem ligado.** Nenhuma notificação real é enviada nesta etapa.

## Princípios que valem para as duas fases

1. O backend é o dono da verdade: todo número vem de um serviço oficial (as mesmas ferramentas de leitura do catálogo).
2. A IA interpreta, combina e explica; **não calcula por conta própria** — cálculo sai da ferramenta `calcular`/`analisar`
   (derivado conferível) e o verificador barra qualquer número sem fonte.
3. Conhecimento (F5) explica o porquê; consultas dão o quanto. Regra só vale se APROVADA.
4. Somente leitura. Nenhuma escrita nova nessas fases.

## F6 — Análises gerenciais e investigações

**Capacidades:** comparação entre meses e unidades; investigação ("por que a margem caiu?") decompondo a variação por
linha da DRE, canal, fornecedor e categoria; consultas cruzadas (financeiro × operação: entregas × custo de
entregadores; vendas × CMV; cancelamentos × faturamento); diagnóstico com hipóteses ordenadas por impacto; recomendações
citando o número consultado.

**Desenho:**

| Camada | O que faz |
|---|---|
| Plano de investigação | o modelo monta um plano curto (até 4 consultas) antes de consultar; o servidor limita passos e custo |
| `analisar` (existente) | agregações por dimensão com totais conferidos |
| `decompor_variacao` (nova, determinística) | variação entre dois períodos por linha → contribuição de cada item (soma = variação total) |
| Escalonamento (§4, homologação) | Sonnet só quando o Haiku falha por raciocínio (verificador reprovou, passos esgotados) |
| Resposta | conclusão primeiro, depois os 2–3 fatores com número e fonte; o que não está no sistema é dito como tal |

**Critérios de aceite:** decomposição soma exatamente a variação; nenhuma recomendação sem número de consulta;
conjunto cego próprio de investigações antes de qualquer ajuste.

## F7 — Avisos proativos (alertas)

**Sinais:** contas a vencer (D-3, D-1, D); pendências de entregadores (semana fechada sem baixa, NF faltando);
sangrias sem prestação de contas no prazo **aprovado**; divergências de conciliação abertas; fechamentos de mês
pendentes; aumento relevante de custo (fornecedor/categoria acima da média de 3 meses); indicadores fora do padrão.

**Desenho:**

| Componente | Responsabilidade |
|---|---|
| Detectores (determinísticos, agendados) | consultam os serviços oficiais e geram um **sinal** com chave idempotente `(tipo, unidade, referência, data)` |
| Política de aviso por unidade | o que avisar, a quem (perfil com permissão), canal, horário silencioso, agrupamento diário; aprovada por uma pessoa |
| Redator | o MOVA redige o texto a partir do sinal (sem consultar de novo); verificador confere os números |
| Fila de saída | a mesma fila durável do MOVA; deduplicação pela chave; teto diário de mensagens |
| Modo sombra | primeiro só grava os avisos que *seriam* enviados, para conferência humana |

**Garantias:** sem política aprovada, nada é avisado; aviso nunca contém dado de unidade sem permissão do destinatário;
o mesmo sinal não gera duas mensagens; desligamento imediato por chave.

**Ordem sugerida:** F7 em sombra para contas a vencer e sangrias atrasadas → conferência de 2 semanas → envio real
numa unidade piloto, com autorização específica.
