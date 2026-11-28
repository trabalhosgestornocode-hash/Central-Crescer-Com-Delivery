# MOVA Operador Financeiro Completo — 01. Auditoria do núcleo (28/11/2026)

Base: `main` em `54926a4` (#248 no ar, 0035 aplicada). Nada aqui foi publicado.

## 1. O que o núcleo Financeiro v2 já faz (reutilizar; nenhum motor novo)

| Alteração pedida | Operação existente | Ação exigida hoje | Observação |
|---|---|---|---|
| Fornecedor | `corrigirObrigacao` (`mudancas.contraparteId`) | `corrigir` (AMPLA) | só a parcela indicada; histórico CORRECAO com justificativa; versão esperada opcional |
| Vencimento | `corrigirObrigacao` (`mudancas.vencimento`) | `corrigir` (AMPLA) | recusa vencimento antes da emissão |
| Descrição | `corrigirObrigacao` (`mudancas.descricao`) | `corrigir` (AMPLA) | leva junto a descrição do lançamento |
| Categoria | `reclassificarLancamento` (prévia + `versaoEsperada` obrigatória) | `reclassificar` (AMPLA) | o lançamento é do GRUPO (todas as parcelas) |
| Valor | `registrarAjuste` (ajuste documentado) | `corrigir` (AMPLA) | valor nunca é sobrescrito: vira ajuste com lançamento próprio |
| Competência | — (não existe) | — | hoje só por cancelamento + novo registro |
| Observações / forma de pagamento | gravadas em `obrigacao.extras` (`observacao`, `formaPagamento`) no cadastro | — | não há operação de alteração |
| Cancelamento | `cancelarObrigacao` (grupo inteiro; recusa com pagamento) | `cancelar` (AMPLA) | cancelamento lógico, lançamento e ajustes cancelados, histórico |

Todas exigem `competência editável` (mês homologado recusa) e gravam antes/depois no `fv2_historico`.

## 2. Barreiras do banco (o que impede o MOVA hoje — e deve continuar impedindo fora do que for concedido)

- O MOVA tem só ações estreitas (Açaí v5 / Subway v3): `ver, enviar_documento, baixar_por_comprovante, registrar_obrigacao,
  registrar_juros, registrar_conta_parcelada, registrar_intercompany, registrar_emprestimo`.
- `fv2_vinculo_extrato_posicao` (0018): qualquer identidade SEM ação ampla só altera numa conta a posição
  (`liquidado/saldo/situacao`) — nunca fornecedor, vencimento, descrição, valor ou competência.
- `fv2_obrigacao_documental` (0030/0033/0035): conta nova pela forma estreita nasce em aberto, sem repetição, no lançamento da mesma transação.
- `fv2_obrigacao_sem_automacao` (0026/0027): a identidade técnica de entregadores não altera contas.
- **Achado (baixo; precisado em 28/11 por teste de mutação):** `extras` está entre as colunas livres do `fv2_vinculo_extrato_posicao`.
  Reescrever `observacao`/`formaPagamento` SOZINHO já era recusado (a regra "a baixa só deixa a conta parcial ou quitada"); o caminho
  aberto era alterá-las JUNTO com uma baixa real, na mesma gravação. A aplicação nunca fez isso; a 0036 fecha esse caminho.

## 3. Lado MOVA (conversa)

- A IA já reconhece `PEDIR_CORRECAO` / `PEDIR_CLASSIFICACAO`, mas hoje ambos vão para a Central (`INTENCOES_DE_REVISAO`).
- Identificação da conta-alvo: reaproveitar a busca por fornecedor/valor/vencimento das baixas (`listarContasAPagar` +
  `detalharContaAPagar`) e a resposta citada (proposta original → `obrigacaoIds`).
- Confirmação: mesmo fluxo das contas relatadas (resumo antes/depois → "sim" de participante FINANCEIRO, identidade conferida
  pelo #250; conflito ⇒ bloqueio). Sem "sim", nada muda.

## 4. Desenho proposto (fase 1, só local)

1. **Migração 0036 (restritiva):** ação nova `financeiro_v2.corrigir_conta_a_pagar`.
   - Amplia `fv2_obrigacao_alterar`/`fv2_lancamento_alterar`/`fv2_historico_incluir` só com esta ação.
   - Gatilho próprio: quem só tem a ação estreita altera numa conta **apenas** `contraparte_id`, `vencimento`, `descricao` e as
     chaves `observacao`/`formaPagamento` de `extras`; conta ABERTA, sem liquidação, competência editável, não cancelada;
     categoria patrimonial fora (empréstimo, parcelamento tributário, intercompany ⇒ Central).
   - No lançamento: só `descricao`, e só junto da conta do mesmo grupo.
   - Fecha o achado do item 2 (extras).
2. **Núcleo:** `corrigirContaAPagarEstreita` = `corrigirObrigacao` com a ação estreita + `observacao`/`formaPagamento`
   (mesma validação, mesmo histórico). Sem duplicar regra.
3. **MOVA:** comando `ALTERAR_CONTA` (tipo de proposta `CORRECAO_DE_OBRIGACAO`), confirmação obrigatória, auditoria com antes/depois,
   idempotência pela proposta (repetir o "sim" não altera de novo; versão esperada da conta vista no resumo).
4. **Fase 2 (depois de homologar a 1):** categoria (reclassificação estreita com prévia), valor (ajuste documentado), competência,
   cancelamento auditado (só conta sem pagamento; grupo inteiro; motivo obrigatório).

**Primeiro caso de homologação:** fornecedor da 2ª parcela do bebedouro (proposta f8f15a27) — não alterar antes da homologação.

## 5. Fora do escopo

Sem publicação, migração em produção, concessão, mudança de limites/políticas/orçamento de IA, sangrias ou North Shopping.
