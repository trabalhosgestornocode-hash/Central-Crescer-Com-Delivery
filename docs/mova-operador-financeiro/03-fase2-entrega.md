# MOVA Operador Financeiro Completo — 03. Fase 2: entrega (28/11/2026)

Base: `main` em `c140e39` (fase 1 no ar e homologada). Nada desta fase foi publicado, aplicado ou concedido.

## 1. O que o MOVA passa a fazer (pelo WhatsApp, sem IA)

| Pedido (exemplos) | Operação oficial do núcleo | Ação estreita (0037) | Abrangência |
|---|---|---|---|
| "altere a categoria do freezer para manutenção" | `reclassificarContaAPagar` (mesma regra da reclassificação 08C/0014) | `reclassificar_conta_a_pagar` | a COMPRA inteira (lançamento único) |
| "altere o valor da 2ª parcela do freezer para R$ 325,00" · "o valor correto da 2ª parcela é 325" | `ajustarValorDeContaAPagar` (= `registrarAjuste`) | `ajustar_conta_a_pagar` | UMA parcela |
| "mude a competência do freezer para novembro/2026" | `moverCompetenciaDeContaAPagar` (operação nova) | `mover_competencia_conta_a_pagar` | a compra (lançamento + parcelas) |
| "cancele a 3ª parcela do freezer" · "cancele a compra do freezer" | `cancelarContaAPagar` (PARCELA ou GRUPO) | `cancelar_conta_a_pagar` | a parcela OU a compra |

Fluxo idêntico ao homologado no bebedouro: identificação da conta (sem ID quando inequívoca; opções numeradas quando há
várias), contexto preservado, resumo ANTES → DEPOIS com o efeito na DRE, UMA confirmação de FINANCEIRO da unidade (identidade
canônica), execução atômica com versões conferidas, conferência na leitura oficial, auditoria. Saída no grupo só quando todos os
membros são FINANCEIRO nas unidades mostradas; senão, no privado. Chave própria: `MOVA_OPERACAO_OPERAR_CONTAS` (padrão desligada).

## 2. Implicações financeiras (o que cada operação faz na DRE e no caixa)

- **Reclassificação:** a categoria é do lançamento da compra — muda a linha da DRE da competência da compra pelo valor TOTAL
  (despesa → despesa: troca de linha; equipamento ↔ despesa: sai/entra no resultado). Valor, parcelas, vencimentos, competência e
  caixa não mudam. Compra com ajuste ou parcela cancelada ⇒ revisão humana (os ajustes ficariam na categoria antiga). Categoria
  que exige documento sem evidência ⇒ Central. Por parcela: nunca (fato econômico único).
- **Correção de valor:** sem teto fixo. O valor ORIGINAL nunca muda; a diferença (correto − anterior) vira AJUSTE documentado:
  lançamento próprio, MESMA categoria e competência da compra, com justificativa. Mostra anterior, correto e diferença. Recusa: valor
  correto ≤ já pago (ou igual — quitaria por ajuste), parcela quitada/cancelada, mudança de situação ⇒ revisão humana.
- **Competência:** move o lançamento e TODAS as parcelas entre dois períodos ABERTOS (ou preliminares). Na DRE, o valor sai de um mês
  e entra no outro; caixa realizado, datas bancárias, liquidações e vencimentos ficam iguais. Compra com pagamento, ajuste ou parcela
  cancelada ⇒ revisão humana (o ajuste ficaria no mês antigo).
- **Cancelamento da PARCELA:** a parcela fica CANCELADA com saldo zero por um AJUSTE negativo auditado do valor dela (mesma categoria e
  competência): a compra original fica registrada e a DRE fica líquida. As outras parcelas continuam. Única parcela ⇒ "cancele a compra".
- **Cancelamento da COMPRA:** parcelas vivas, lançamento e lançamentos de ajuste ficam CANCELADOS (nada é apagado). Com qualquer
  pagamento ⇒ revisão humana (estorno é tratamento especializado).
- Sempre: período homologado ou em fechamento com pendências ⇒ recusa; empréstimo, parcelamento tributário, entre empresas e outras
  patrimoniais ⇒ fora (proteções próprias).

## 3. Segurança no banco (0037)

Quatro ações novas, nenhuma concessão as recebe. A sessão operacional enxerga TODAS as ações da concessão (lição da 0036); por
isso cada barreira existente reconhece EXATAMENTE as formas novas e mais nada:
- posição da conta (0018/0031/0036): competência, ajuste (saldo > 0, soma dos ajustes conferida) e cancelamento — só nessas formas;
- encargo (0031) e contas estreitas (0030/0033/0035): o ajuste fora da categoria de juros é das barreiras novas;
- ações do lançamento (0014/0036) e correção do lançamento (0036, agora só quando a DESCRIÇÃO muda);
- novas: forma da alteração do lançamento (reclassificação/competência/cancelamento), inclusão do ajuste estreito (aponta para a conta
  e para o seu lançamento, mesma categoria/competência), e conferências no FIM da transação (competência da compra inteira;
  parcela cancelada com ajuste; lançamento de ajuste com o seu ajuste).

Regressões encontradas e corrigidas ANTES do PR (provadas por teste): (1) a barreira de lançamento da 0036 bloqueava
reclassificação/competência/cancelamento para quem tem a correção cadastral (o MOVA); (2) a primeira correção disso abria o VALOR do
lançamento para quem só tem `corrigir_conta_a_pagar` — o teste CC-4 da fase 1 pegou; fechado.

## 4. Testes (PostgreSQL isolado)

- F2-1..4 — núcleo: as quatro operações, versões/conjunto, períodos, pagamento ⇒ revisão humana, nada apagado.
- P13 — concessão de produção (9 ações) + 4 novas: baixa, juros, despesa paga, empréstimo, intercompany e correção da fase 1 SEM
  regressão; as 4 novas gravam; SQL cru indevido (competência de uma parcela, parcela cancelada sem ajuste, ajuste sem registro ou em
  outra categoria, valor/competência/cancelamento do lançamento, empréstimo) recusado pela regra.
- KIT-0037 — backup, reversão EXATA para a 0036 (ida e volta idêntica: políticas, funções, gatilhos, restrição), concessão protegida,
  isolamento, duplicidade, reversão que preserva alterações legítimas. KIT-0035/0036 adaptados (revertem a 0037 antes).
- OF2-1..5 + OF2-PG — conversa: as quatro operações, nunca presume todas, chave, travas, "não", concessão; ponta a ponta no PostgreSQL.
- Suítes com impacto: Financeiro v2 871/871 (3 pulados por desenho); MOVA afetados 30/30.

## 5. Publicação (só com autorização)

Kit `database/financeiro-v2/producao/operacoes-0037/`: 00 prévia → 01 backup → `../atualizar.sql` (base 0036; só a 0037) → 03 →
merge/deploy → 04 concessão (Açaí v6 e Subway v4: as 9 vigentes + as 4) → 03 → `MOVA_OPERACAO_OPERAR_CONTAS=1`.
Sem migração do MOVA (as operações usam o tipo `CORRECAO_DE_CONTA` da 0027; a 0026 segue reservada aos entregadores).
Reversão: 05 (A depois B).

## 6. Homologação sugerida (contas reais escolhidas por você; nada do bebedouro nem do BNB)

1. Cadastre uma compra de teste em 2–3 parcelas pela conversa (fluxo já homologado).
2. "altere a categoria da compra <x> para <categoria>" → confira a linha da DRE no Dashboard.
3. "altere o valor da 2ª parcela da compra <x> para R$ <valor>" → confira saldo e o ajuste no histórico.
4. "mude a competência da compra <x> para <mês/ano>" → confira os dois meses da DRE.
5. "cancele a 3ª parcela da compra <x>" e depois "cancele a compra <x>" → confira que nada sumiu (canceladas no histórico).
Cada passo: resumo → "sim" → "Feito … Conferido no Financeiro".
