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

## 2. Implicações financeiras (DRE, patrimônio, contas a pagar, fluxo previsto)

Regra geral: a NATUREZA da compra decide o efeito. DESPESA está na DRE; compra de equipamento (IMOBILIZADO) é PATRIMONIAL e não
entra na DRE — o MOVA nunca diz que ela "aumenta/reduz a DRE". Nenhuma operação muda o caixa realizado, datas bancárias ou pagamentos.

- **Reclassificação (compra inteira):** despesa → despesa: troca de linha na DRE (o resultado total não muda); equipamento → despesa:
  o valor passa a ser despesa na DRE do mês; despesa → equipamento: sai do resultado e vira patrimonial. Contas a pagar, vencimentos e
  fluxo previsto não mudam. Compra com ajuste ou parcela cancelada ⇒ revisão humana. Por parcela: nunca (fato econômico único).
- **Correção de valor (uma parcela):** sem teto fixo. O resumo mostra valor original, valor atual, novo valor, diferença, já pago,
  saldo anterior, novo saldo, a JUSTIFICATIVA real (perguntada se não foi dita) e o impacto: despesa ⇒ a despesa do mês aumenta/diminui
  a diferença; equipamento ⇒ "não afeta a DRE" (patrimonial); contas a pagar e fluxo previsto (no vencimento da parcela) ± diferença.
  O valor original nunca muda: a diferença é ajuste auditado. Novo valor ≤ já pago ⇒ revisão humana.
- **Competência (compra inteira, entre períodos abertos):** despesa ⇒ o valor sai de um mês e entra no outro na DRE; equipamento ⇒ não
  afeta a DRE (muda o mês de referência). Contas a pagar, vencimentos e fluxo previsto não mudam. Pagamento/ajuste/parcela cancelada ⇒
  revisão humana.
- **Cancelamento de PARCELA:** só a pedida (com justificativa); ajuste negativo auditado do valor dela; despesa ⇒ a despesa do mês
  diminui; equipamento ⇒ não afeta a DRE; contas a pagar e fluxo previsto −valor no vencimento dela. Se for a ÚLTIMA parcela restante,
  o MOVA explica e pede o pedido específico de cancelar a compra — nunca converte sozinho.
- **Cancelamento da COMPRA:** parcelas vivas, lançamento e ajustes cancelados (nada é apagado); com qualquer pagamento ⇒ revisão humana.
- **Integridade da confirmação:** a confirmação guarda as versões da(s) parcela(s) E do lançamento da compra (categoria, competência,
  valor). Se algo mudar entre o resumo e o "sim", a confirmação antiga é invalidada, nada é alterado e o MOVA apresenta um resumo
  ATUALIZADO para nova confirmação — nunca executa uma operação diferente da autorizada.
- Sempre: período homologado/com pendências ⇒ recusa; empréstimo, parcelamento tributário, entre empresas e outras patrimoniais ⇒ fora.

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
- OF2-1..8 + OF2-PG — conversa: as quatro operações, resumo completo do valor com justificativa real, despesa × equipamento, última parcela, confirmação invalidada e resumo atualizado, nunca presume todas, chave, travas; ponta a ponta no PostgreSQL.
- Suítes com impacto: Financeiro v2 871/871 (3 pulados por desenho); MOVA afetados 30/30.

## 5. Publicação (só com autorização)

Kit `database/financeiro-v2/producao/operacoes-0037/`: 00 prévia → 01 backup → `../atualizar.sql` (base 0036; só a 0037) → 03 →
merge/deploy → 04 concessão (Açaí v6 e Subway v4: as 9 vigentes + as 4) → 03 → `MOVA_OPERACAO_OPERAR_CONTAS=1`.
Sem migração do MOVA (as operações usam o tipo `CORRECAO_DE_CONTA` da 0027; a 0026 segue reservada aos entregadores).
Reversão: 05 (A depois B).

## 6. Homologação real (só operações reais que você escolher e autorizar, uma a uma)

Nada de contas fictícias no Financeiro real. Para UMA compra real elegível (despesa ou equipamento, sem pagamento, período aberto), na
ordem abaixo — a competência recusa compras com ajuste, por isso vem ANTES da correção de valor:
1. **Reclassificar a categoria:** "MOVA, altere a categoria da compra <x> para <categoria>" → confira a categoria (e a linha da DRE, se for despesa).
2. **Alterar a competência:** "MOVA, mude a competência da compra <x> para <mês/ano>" → confira o mês de referência (e os dois meses da DRE, se despesa).
3. **Corrigir o valor:** "MOVA, altere o valor da <n>ª parcela da compra <x> para R$ <valor> porque <motivo>" → confira saldo e o ajuste no histórico.
4. **Cancelar uma parcela:** "MOVA, cancele a <n>ª parcela da compra <x> porque <motivo>" → confira que as outras continuam.
5. **Cancelar a compra inteira:** "MOVA, cancele a compra <x> porque <motivo>" → confira que nada sumiu (canceladas no histórico).
Cada passo: resumo → conferência sua → "sim" → "Feito … Conferido no Financeiro". Não usar o bebedouro nem o BNB.
