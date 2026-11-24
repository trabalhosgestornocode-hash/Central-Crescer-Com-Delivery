# 18 — MOVA conversacional: diagnóstico e primeira entrega (24/11/2026)

## 1. Diagnóstico (estado na `main` be4b0b5)

| Pergunta | Achado |
|---|---|
| Modelo de IA | **`claude-haiku-5-5`**, exclusivo e sem fallback (`ia/provedorAnthropic.js`; outro modelo é recusado). Sem raciocínio, saída máx. 600 tokens. |
| Quando usa IA hoje | **Só documentos** (`MOVA_IA_SOMENTE_DOCUMENTOS`, padrão `true` → `extratorSoDeDocumentos`). Texto solto nunca chega ao Haiku em produção: depende de regra fixa. |
| Texto só por regra fixa | `aplicacao/comandos.js`: períodos/consultas por palavra-chave (hoje, semana, mês, "contas vencidas", "faturamento"…) e "explique a conta X". Qualquer frase fora disso cai em "não entendi". |
| Histórico | `mova.conversa_ativa`: por participante+conversa, janela de 10 min, guardava **só unidade e consulta** (sem período). "E a semana que vem?" funcionava; "só as vencidas", "e na Subway?", "detalha" não. |
| Ferramentas | Catálogo fechado e só-leitura em `aplicacao/ferramentas.js` (faturamento, DRE, fluxo, contas a pagar/receber, vencidas, por fornecedor, sem comprovante, a conciliar, entregadores agregados…). A IA só escolhe a consulta; o motor chama; os números vêm do Financeiro. |
| Permissões | Grupo/participante por LISTA, perfil por unidade (`CAPACIDADES`), unidade resolvida de forma determinística (`resolverUnidade`) só entre as unidades **da pessoa**; empresas diferentes nunca são somadas. |
| Limites de custo | `mova.orcamento_ia` + `mova.consumo_ia`: reserva antes da chamada, **teto total fixo no código US$ 10,00**, teto por chamada (`MOVA_IA_TETO_*`), desligável na hora pela tabela `mova.controle`. **Não alterado.** |
| Redação natural | `aplicacao/redator.js` (desligado; só reescreve os fatos calculados, valida números/links). Inalterado. |

## 2. O que esta entrega faz (sem custo novo de IA e sem tocar permissões/teto)

1. **Acompanhamento sem IA** (`comandos.js: interpretarSeguimento`): "só as vencidas", "agora por fornecedor", "nas duas (empresas/unidades)" e "e na <unidade>?" repetem a consulta da conversa, com o **mesmo período**.
2. **Período na conversa** (migração **0017**, coluna `contexto jsonb` em `conversa_ativa`): só `competencia/periodoInicio/periodoFim`, ≤ 512 bytes, expira junto (10 min). Nunca texto, valor ou nome. Nova consulta substitui o recorte.
3. **IA (quando o texto for liberado)**: o Haiku recebe uma linha compacta `CONTEXTO DA CONVERSA` (consulta, unidade, período — só da unidade que a pessoa pode tratar) e o novo campo `continuacao`. Se `continuacao=true` e sem consulta própria, o motor repete a consulta da conversa; outras intenções nunca são reescritas.
4. **Prompt**: instruções de conversa e de resistência a ordens embutidas ("ignore", "aja como", "mostre tudo", "pague") — tratadas como dado; pedido de pagamento continua `PEDIR_PAGAMENTO` (bloqueado).
5. **Métrica sem dado sensível**: evento `MOVA_IA_LEITURA` (`ok`, `ms`, `codigo`, `comContexto`, grupo mascarado). Custo/tokens seguem em `mova.consumo_ia`.
6. "detalha melhor isso" / "de onde saiu esse valor" deixam de ser lidos como busca de conta chamada "isso" e vão à IA com o contexto.

## 3. Garantias (cobertas por `test/mova-financeiro/conversa-inteligente.test.js`, 12 casos)

- O histórico **não abre outra unidade**: quem só tem a Alfa pede "e na Beta?" / "nas duas" → nenhuma leitura da Beta (CV-04, CV-09).
- Contexto **expira** (CV-05) e é **por participante** (conversas simultâneas não se misturam, CV-06).
- Instrução maliciosa e saída da IA com campo extra (`sql`, `unidadeId`) → nenhuma consulta (CV-10).
- IA fora do ar → nada lido nem inventado (CV-11); pedido de pagamento → nada executado (CV-12).
- Acompanhamento simples **não consome IA** (CV-01..03).
- Suíte completa do MOVA: **473/473** em PostgreSQL isolado. `A2-05` foi atualizado: "e da alfa?" agora responde direto (antes caía na IA simulada).

## 4. O que NÃO foi feito / depende de autorização

- **Migração 0017 não aplicada em produção**; pacote (`instalar.sql`/`atualizar.sql`) regenerado. Reversão: `recuperacao/reverter-0017.sql`.
- **Liberar texto para a IA em produção** = `MOVA_IA_SOMENTE_DOCUMENTOS=0` (hoje `true`): aumenta consumo; **mantém o teto de US$ 10**. Decisão do proprietário. Sem isso, só o acompanhamento determinístico acima funciona.
- Fora desta entrega (próximas etapas): fornecedor × mês ("quanto pagamos para esse fornecedor no mês passado"), "por que essa despesa aumentou" (comparativo de competências), entregadores sem nota (ferramenta nova), respostas redigidas pelo Haiku com validação (redator) e comparação entre unidades com escopo explícito. Cada uma exige ferramenta nova do catálogo fechado.
- Homologação com conversas reais autorizadas: pendente (precisa do usuário no WhatsApp).
- Nenhum merge, deploy, mudança de permissão, de teto ou do Gateway.

---

## 5. Fase 2 (24/11/2026, mesma branch) — ferramentas de conversa e validação com a API real

**Novas consultas (catálogo fechado, só leitura, por unidade autorizada)** — `aplicacao/ferramentasConversa.js`:

| Pergunta | Consulta | Observação |
|---|---|---|
| Quanto pagamos ao fornecedor X no mês passado? | `PAGAMENTOS_A_FORNECEDOR` | soma só pagamentos registrados no período; diz "registrado ≠ conciliado" e o que segue em aberto; nome ambíguo pede o nome completo |
| Quanto gastamos com a categoria Y? / como estão as despesas? | `DESPESAS_POR_CATEGORIA` | categoria por código **ou nome**; sem categoria = ranking; por competência (não é caixa) |
| Por que a despesa aumentou? | `COMPARATIVO_DE_DESPESAS` | competência × anterior; onde mais mudou (categoria ou fornecedor); **só fatos, sem afirmar causa**; avisa mês em andamento |
| Quais entregadores não enviaram nota? | `ENTREGADORES_SEM_NOTA` | contagem para todos; **nomes só com detalhe** (FINANCEIRO); nunca valor por pessoa |
| Quanto falta pagar aos entregadores? | `FECHAMENTO_ENTREGADORES` (já existia) | |
| Pagamentos aguardando conciliação / contas hoje, amanhã, semana / vencidas | `PAGAMENTOS_A_CONCILIAR`, `CONTAS_VENCENDO`, `CONTAS_VENCIDAS` (já existiam) | |
| Despesas do Açaí e da Subway | qualquer consulta + "nas duas": cada unidade/empresa **separada**, nunca somada | |

**Conversa**: o filtro (fornecedor/categoria) e o período acompanham as perguntas seguintes ("e este mês?", "e na Subway?", "só as vencidas"). Perguntas de **análise** ("por que aumentou", "comparado ao mês passado", "gastamos com…") deixaram de cair em palavra-chave (antes "despesa" virava DRE) e vão à IA quando liberada; sem IA o MOVA diz a limitação (nada inventado).

**Teto**: inalterado (US$ 10 fixo no código). Com o orçamento esgotado o texto livre recebe o aviso de pausa e os comandos determinísticos continuam (teste FI-03).

### Validação real (Claude Haiku 5.5, dados fictícios, teto do script 12 chamadas / US$ 0,25)
`node scripts/mova/validacaoConversaReal.mjs` (com `MOVA_ENV_ARQUIVO`): **8/8** cenários — pergunta determinística (0 IA), "e na beta?" (0 IA), fornecedor no mês passado (1 IA, R$ 1.000,00 correto), "e este mês?" mantendo o fornecedor (0 IA), "por que aumentou" (1 IA; o Financeiro mostrou que **caiu** 65% e o MOVA disse a verdade), tentativa de acessar outra empresa (bloqueada, 0 IA), saudação (0 IA), "paga essa conta" (1 IA → bloqueado). 3 chamadas, ~4,9 mil tokens de entrada e ~370 de saída cada; custo conservador (tabela US$ 4/20 por milhão) ≈ **US$ 0,027 por chamada** ⇒ o teto de US$ 10 comporta ≈ 370 perguntas livres; saudações, comandos e acompanhamentos não gastam.

### Checklist para ativar em produção (nada disto foi feito)
1. **Primeiro** aplicar a migração MOVA **0017** (aditiva; reversão `recuperacao/reverter-0017.sql`; `atualizar.sql` já regenerado). **A ordem importa:** o código novo grava a coluna `contexto` ao responder qualquer consulta; deploy sem a 0017 faria essa gravação falhar.
2. Merge do PR + deploy do backend (Render).
3. Render: `MOVA_IA_SOMENTE_DOCUMENTOS=0` (hoje padrão `true`). Pré-requisitos já existentes: `MOVA_IA_HABILITADA=1`, `ANTHROPIC_API_KEY`, orçamento em `mova.orcamento_ia`.
4. Homologar com conversas reais da gerência (grupo/privado autorizados) e acompanhar `MOVA_IA_LEITURA` (latência/falhas) e `mova.consumo_ia`.
5. Reversão imediata: `MOVA_IA_SOMENTE_DOCUMENTOS=1` ou desligar "ia" em `mova.controle`.

---

## 6. Fase 3 (24/11/2026, branch `feat/mova-despesa-ja-paga`, empilhada no PR #203) — compra nova já paga por comprovante

**Caso real (23/11):** comprovante Pix de **R$ 259,00** dos brownies + conta antiga em aberto "BROWNIE ANDRESSA" de **R$ 81,00**. O MOVA perguntou "a diferença são juros dessa conta?" e não entendeu "Outra compra". A intenção era **cadastrar uma compra nova e registrá-la paga no mesmo dia** — não conciliar a conta antiga.

**O que mudou na conversa (interpretação pelo sentido, não lista de palavras):**
- **Pergunta pendente como contexto da leitura.** Quando o MOVA espera resposta desta pessoa (`mova.mensagem_pendente`, 10 min), a mensagem seguinte é lida junto com o texto da pergunta (linha de sistema `PERGUNTA PENDENTE DO MOVA`). Vale só para mensagem **sem citação**; quem cita a pergunta do MOVA é retomado pela citação exata do PR #203, e citar outra mensagem nunca liga à pendência mais recente. A IA devolve dois campos novos do contrato estrito: `finalidadePagamento` (`COMPRA_NOVA` · `CONTA_EXISTENTE` · `JUROS` · `PARCIAL`) e `descricaoCompra` (até 6 palavras, da fala da pessoa, nunca o favorecido). O **backend** decide o desfecho (`desfechoPorFinalidade`): a IA nunca escolhe conta nem valor.
- **Determinístico primeiro (custo zero):** "Outra compra", "sim", "É uma compra nova", "Outra compra de brownies", "Compra de brownies", "juros", "é dessa conta", e descrição curta ("brownies") resolvem sem IA. Frases como "Lança como pago hoje", "Cadastra essa despesa", "Já foi pago pelo Pix", "Não tem conta cadastrada ainda", "Pode criar a conta e dar baixa" e "Comprei brownies e já paguei" (como resposta) vão a **uma** leitura de IA. Com pergunta pendente, os atalhos de consulta não capturam a frase ("Já foi pago pelo Pix" virava consulta da conta "pelo pix").
- **A mesma intenção na legenda do comprovante** (ou na leitura do documento) leva direto à despesa paga, sem pergunta.
- **Diferença grande demais para juros** (> 50% da conta; o caso real é 220%) ⇒ a pergunta passa a ser **"É uma compra nova, já paga?"**; diferenças plausíveis continuam com a pergunta de juros (e o teto de 10% do Financeiro para registrar juros sem revisão continua valendo).
- **Descrição ausente** (sem legenda e sem categoria) ⇒ "O que foi comprado?"; a descrição pode vir em mensagem posterior.
- **Valor igual não prova que é a mesma despesa.** Com compra nova declarada, a conta antiga do favorecido não é baixada e aparece no resumo ("Não mexi na conta em aberto de …"). Se já existe um **pagamento** igual (favorecido, valor e data), o MOVA pergunta antes de duplicar; o mesmo identificador de transação é barrado (`TRANSACAO_JA_RECEBIDA`).
- **Resumo consolidado** na proposta e na confirmação: descrição (só a lida e filtrada, nunca a legenda crua), data do pagamento + banco de origem + final da transação, favorecido, unidade, competência e categoria (do plano de contas da unidade, ou "a classificar na revisão").

**Financeiro 2.0 — operação atômica nova** `registrarDespesaPagaPorComprovante` (`financeiro-v2/aplicacao/despesaPagaPorComprovante.js`), composta dos serviços existentes numa **única transação**: registrar a obrigação (documental pela identidade operacional, ou humana) → guardar a ficha/vínculo do comprovante → `pagarPorComprovante` (liquidação integral, conciliação `PENDENTE`). Uma compra paga = **uma despesa + a sua baixa**; competência ≠ data do pagamento; **nenhuma saída bancária** é criada — o extrato posterior concilia sem duplicar (testes DP-4, A2-H9/H10). Falha em qualquer passo não deixa nada. Sem migração nova (as regras RLS da 0029/0030 já cobrem; conferido no PostgreSQL real, DP-7). O MOVA (`execucao.registrarDespesaPaga`) e a aprovação no Centro Financeiro passaram a usar essa operação.

**Permissões, confirmações e consumo:** inalterados. Escrita automática só com política `DESPESA_DOCUMENTAL` e as chaves de escrita; sem elas, só proposta para o Centro Financeiro (aprovação pelo grupo continua bloqueada). Teto de IA o mesmo (US$ 10); no máximo uma leitura por resposta.

**Chave nova (padrão DESLIGADA):** `MOVA_IA_RESPOSTAS_PENDENTES=1`. Em produção a IA lê só documentos (`MOVA_IA_SOMENTE_DOCUMENTOS` ligado); sem esta chave, as respostas livres que dependem de IA recebem "não entendi" e o caminho determinístico segue funcionando. Com ela, **só** o texto que responde a uma pergunta pendente vai à IA; texto solto continua sem IA.

**Testes:** `test/financeiro-v2/despesa-paga-por-comprovante.test.js` (DP-1..7) e `test/mova-financeiro/compra-nova-paga.test.js` (BR-1..12: caso real, as 9 frases como resposta e como legenda, descrição posterior curta/longa, valor igual, pagamento repetido, mensagem que não responde, regras puras e contrato).

**Para ativar em produção (nada feito, depende de autorização):** merge do PR #203 e deste PR (merge = deploy); chaves de escrita/política já são as do Exec.17 (hoje desligadas); opcional `MOVA_IA_RESPOSTAS_PENDENTES=1`. Pendência conhecida (anterior a esta mudança): A2-H9/H10 falham só no modo `FV2_REPOSITORIO=postgres`, também no commit base.
