# Financeiro v2 — 21. Fechamento com ressalvas e baixa por extrato bancário (Execução 08E)

Data: 14/11/2026. Branch local `feat/financeiro-v2-fechamento-baixa-bancaria`, derivada de `afeb853` (08D).

> **Homologação técnica SINTÉTICA, não autorização de produção.**
> - Identidades, empresa, unidades, contas, documentos (PDFs gerados para o teste) e valores são fictícios.
> - Tudo em 127.0.0.1: PostgreSQL 17 próprio e descartável (`fv2-pg-teste`, porta 54329), gateway sintético em processo
>   separado e cofre de teste em `%LOCALAPPDATA%\fv2-homologacao\cofre`. Credenciais geradas localmente, fora do Git.
> - Produção não foi acessada; `backend/.env` não foi lido (os testes rodaram com `node --test` direto, sem o
>   `npm test`, que carrega o `.env`); o financeiro antigo não foi tocado; nada foi publicado (sem push, merge ou deploy).
> - A integração com o login da plataforma **não** foi iniciada.

Commits locais desta execução (sem push):

| Commit | Conteúdo |
|---|---|
| `9d8e295` | Parte 1 — F-1 (homologação só com pendências tratadas, núcleo e banco 0018) e F-2 (baixa por saída já registrada) |
| `3da11ac` | Parte 2 — 13 testes F-1/F-2 em memória, PostgreSQL e barreiras do banco; correção da 0018 (coluna `situacao`) |
| `7d3fa62` | Parte 3 — interface: "Registrar pagamento" × "Vincular pagamento do extrato", prévia, documentação no painel, tela de fechamento separada |
| `d8255e7` | Parte 4 — **achado da jornada no navegador**: "com pendências documentadas" sem contorno (núcleo, prévia, banco 0019) |
| (este) | Fim de linha normalizado (LF), roteiro da jornada full stack, este documento |

---

## 1. Diagnóstico (Fase A)

Linha de base em `afeb853`: 332/332 testes do núcleo (memória e PostgreSQL); frontend 1942 aprovados, 26 pulados.

| Achado | Causa | Reprodução antes da correção |
|---|---|---|
| **F-1** — homologar direto do preliminar com pendências que exigem documentação | As pendências documentadas eram texto livre enviado na transição; a homologação só conferia os *impedimentos* (divergências), não as pendências | Roteiro sobre o núcleo de `afeb853`: competência preliminar com "conta sem comprovante" e "relatório que falta" → `FECHAMENTO_HOMOLOGADO` aceito |
| **F-2** — pagar uma conta cuja saída já está no extrato criava **outra** saída | Só existia "pagar" (saída nova + baixa numa transação). Não havia como ligar a conta a uma saída já importada | Mesmo roteiro: conta de R$ 618,50 + saída de R$ 618,50 já registrada → "pagar" gerou a 2ª saída de R$ 618,50 |
| **F-1b** (achado da jornada, 08E) — "com pendências documentadas" aceito com pendências não documentadas e bloqueantes | A regra nova conferia as pendências só na homologação; a passagem PRELIMINAR → COM_PENDENCIAS pedia apenas "uma pendência documentada" | Navegador, outubro sintético: 5 não documentadas + 2 bloqueantes → POST de `FECHAMENTO_COM_PENDENCIAS` = 200 |

O F-1b não permitia homologar indevidamente (a homologação reavaliava tudo), mas deixava a competência num estado que
afirmava algo falso e permitia "estacionar" pendências não tratadas — o que o enunciado proíbe.

## 2. Regra definitiva de homologação (Fase B) — decisão F-1

Módulo `dominio/ressalvas.js`. Cada pendência atual da competência recebe **uma** situação diante do fechamento:

| Situação | Quando |
|---|---|
| `RESOLVIDA` | Estava documentada e deixou de existir (a causa foi tratada) |
| `DOCUMENTADA_ADMISSIVEL` | Documentada (decisão + "o que falta" ou evidência) **e** admissível pela natureza e pelo impacto |
| `BLOQUEANTE` | Bloqueia por natureza, tem efeito **indeterminado** no resultado, ou é de efeito "conhecido" sem valor |
| `SEM_EVIDENCIA_SUFICIENTE` | Documentada, mas sem decisão, sem "o que falta"/evidência, ou o valor mudou depois da documentação |
| `NAO_DOCUMENTADA` | Exige documentação e não foi documentada |
| `NAO_EXIGE` | Acompanhamento (não altera o resultado nem exige documentação) |

**Admissibilidade decide-se pelas propriedades, nunca pelo texto.** Descrição, impacto e decisão são obrigatórios, mas não
transformam nada em admissível (provado no navegador: uma "despesa sem classificação" documentada com o texto "Nenhum,
com certeza absoluta" continuou `BLOQUEANTE`).

**Efeito no resultado por código** (`EFEITO_POR_CODIGO`; código desconhecido = `INDETERMINADO`, o lado seguro):

| Efeito | Códigos | Pode virar ressalva? |
|---|---|---|
| `SEM_EFEITO` — a receita/despesa já está reconhecida; falta conferência ou documentação | venda sem pagamento, recebível sem repasse/atrasado, correspondência a decidir, diferença de caixa, relatório que falta (`FONTE_SEM_DOCUMENTO`), importação com pendências… | Sim, documentada |
| `CONHECIDO` — efeito quantificado | conta sem comprovante (despesa reconhecida pelo valor da conta), taxa/valor divergente apurado, totais de relatórios diferentes **já justificados**, crédito não identificado e transação sem pedido (no pior caso, receita não registrada **até o valor**: resultado subestimado, nunca superestimado) | Sim, documentada e com valor |
| `INDETERMINADO` — pode distorcer o resultado de modo não esclarecido | despesa/desconto a classificar, **saída sem classificação** (possível despesa não reconhecida), proposta em aberto, importação a revisar, sobreposição agregado × pedidos, saldo divergente | **Nunca** — precisa ser resolvida |

Princípio conservador (sem política de materialidade quantitativa): ressalva só para o que, no pior caso, deixa o
resultado **subestimado** por valor conhecido. O que pode **superestimar** o resultado bloqueia. Nenhum valor é "pequeno
demais". Mudar esta tabela é decisão do responsável financeiro.

**Bloqueios obrigatórios** (além das pendências): os impedimentos do núcleo da 06D — divergência entre relatórios sem
justificativa, saldo de conta divergente, receita em duplicidade, conciliação divergente sem resolução, classificação
provisória e operações importadas pendentes.

**Banco (0018 e 0019)** — o PostgreSQL confere sozinho o que consegue, sem confiar na aplicação:
- a competência não nasce homologada nem "com pendências";
- homologar exige a avaliação (`homologacao.pendenciasNaoTratadas = 0`, `de` = estado anterior), não reescreve as
  pendências e, do preliminar, não aceita ressalvas;
- cada ressalva precisa estar documentada (decisão + "o que falta"/evidência) e ter efeito `SEM_EFEITO`/`CONHECIDO` com valor;
- verificações **objetivas**: nenhum lançamento ativo em categoria provisória e nenhuma saída do período sem vínculo —
  valem para homologar (0018) e para entrar em "com pendências" (0019);
- a classificação de admissibilidade de cada pendência (natureza × impacto) fica no núcleo: o banco não recalcula as
  pendências; ele recusa ressalva inadmissível, sem documentação ou vinda do preliminar.

## 3. Transições e homologação com ressalvas (Fase C)

| Transição | Condição (núcleo **e** prévia da tela) |
|---|---|
| Aberta → Preliminar | `fechar` |
| Preliminar → Com pendências documentadas | `fechar` **e** tudo o que resta são ressalvas admissíveis: nenhuma bloqueante, nenhuma por documentar, nenhuma insuficiente, nenhum impedimento, ao menos uma ressalva (`podeRegistrarComPendencias`) |
| Preliminar → Homologada (sem ressalvas) | `homologar` **e** nada impeditivo **e** nada a ressalvar |
| Com pendências documentadas → Homologada (com ressalvas) | `homologar` **e** nada impeditivo; as admissíveis viram ressalvas guardadas |
| Homologada → Aberta | `reabrir` + justificativa + confirmação; a versão homologada anterior fica registrada |

Compatibilidade: o estado continua um só (`FECHAMENTO_HOMOLOGADO`); a homologação ganhou o atributo versionado
`homologacao` (`comRessalvas`, `ressalvas[]`, `de`, `avaliadaEm`, `contagem`, `pendenciasNaoTratadas`, `resolvidas`),
gravado na competência e no retrato imutável da versão (`verificacoes.comRessalvas`, `verificacoes.ressalvas`). O
histórico distingue homologação com e sem ressalvas pela versão; a documentação de cada pendência é o evento
`DOCUMENTACAO_DE_PENDENCIA`. **Homologar não elimina pendências**: a lista documentada fica com a competência (e
sobrevive à reabertura).

A documentação passou a ser **uma pendência por vez, no painel dela** (`documentarPendenciaDoFechamento`, ação `fechar`),
ligada à chave real da pendência. A documentação em lote por texto livre na transição deixou de documentar qualquer coisa
(não liga às pendências reais): é recusada.

## 4. Baixa por saída já registrada (Fases D e E) — decisão F-2

Operação nova `vincularPagamentoDoExtrato` (`aplicacao/baixaPorExtrato.js`) com prévia `consultarVinculoDoExtrato`.

**Regra fundamental:** vincular **não** cria movimentação, **não** cria lançamento (despesa) e **não** cria conta. Grava
só: a liquidação (com a marca `origemDoVinculo: EXTRATO`), a posição da conta (pago, saldo, situação), o valor alocado da
saída, o vínculo documental da evidência e o histórico.

Fluxo na tela (Contas a Pagar → Detalhar):
1. "Como dar baixa nesta conta" explica **Registrar pagamento** (o pagamento ainda não está no sistema: cria a saída e a
   baixa juntas) × **Vincular pagamento do extrato** (a saída já está no sistema: usa essa saída, sem criar outra).
2. Lista de saídas elegíveis com conta, data, descrição e **disponível**; **nada pré-selecionado** (valor e data iguais
   não provam que é o mesmo pagamento).
3. Prévia (nada gravado): conta (original, pago, saldo, vencimento), saída (data, conta, valor, já vinculado, disponível),
   histórico da saída (baixas e conciliações anteriores) e o efeito em cada tela.
4. Confirmação com valor, documento comprobatório (ou conciliação confirmada com evidência), justificativa e caixa de
   confirmação.

**Controle de alocação** (núcleo + banco): cada saída tem `alocado_centavos`; disponível = valor − alocado.
- Uma saída → uma conta; uma saída → várias contas (agrupado); uma conta → várias saídas; parcial.
- Recusado: total acima do disponível, saldo negativo da conta, saída esgotada, saída de outra unidade (não existe no
  escopo), saída cancelada/estornada, transferência interna, devolução, saída que já é devolução de venda, repetição com
  outro valor.
- **Diferença não justificada:** nada é inventado (sem taxa, juro ou desconto automático). Sobra da saída continua
  "saída a classificar" (pendência bloqueante na competência dela); falta na conta continua saldo em aberto.
- **Competência posterior:** conta de setembro paga com saída de outubro → a baixa acontece em outubro; a versão
  homologada de setembro não muda. Saída de competência **homologada** não aceita baixa nova (aparece desabilitada).
- **Saída sem classificação** é exatamente o caso de uso: o vínculo a classifica como pagamento de conta.
- **Saída já classificada de outro modo** (devolução, transferência, devolução de venda) é recusada com a explicação —
  investigar antes. A saída do **caixa físico** ("Saída de dinheiro") é elegível: ela gera só a movimentação (natureza
  OUTRA), sem lançamento econômico, então pagar uma conta em dinheiro com ela não duplica despesa (conferido).

**Evidência suficiente:** documento comprobatório escolhido na confirmação **ou** conciliação CONFIRMADA, com evidência,
entre essa saída e essa conta. Sem um dos dois, recusado.

## 5. Efeitos financeiros (Fase F) — comprovados

Na suíte (memória e PostgreSQL) e no navegador (Cenário 2, R$ 618,50):

| Verificação | Resultado no navegador |
|---|---|
| DRE (resultado e despesas operacionais de outubro) | −3.447,30 → −3.447,30 (inalterado) |
| Movimentos de outubro / saídas do banco / saldo do banco | 7 → 7 / 4.628,50 → 4.628,50 / 20.045,40 → 20.045,40 |
| Fluxo realizado (saídas) | 5.643,50 → 5.643,50 |
| Fluxo previsto (saídas) | 10.550,90 → 9.932,40 (−618,50: a parcela paga sai do previsto) |
| Conta | QUITADA no núcleo / "Pago" na tela, "vinculado do extrato" |
| Repetição | `repetido: true`, todos os números idênticos |
| Central | "Saída bancária sem classificação" e "Conta sem comprovante — Energia" deixaram de existir |

Conciliação: a saída passa a `PAGAMENTO_DE_OBRIGACAO` com as contas vinculadas (agrupado quando há mais de uma). Uma
correspondência candidata antiga para o mesmo par continua "a decidir" até alguém decidir; confirmá-la depois do vínculo
só registra a conciliação (conferido: nenhuma segunda baixa, conta com 1 pagamento).

## 6. Permissões e concorrência (Fase G)

- Ação nova **`financeiro_v2.vincular_pagamento`**, separada de `registrar` (pagamento novo), `conciliar` e
  `reclassificar`. Migração restritiva: nenhuma concessão existente a recebeu.
- Quem só vincula, no banco (0018): não insere movimentação, lançamento nem conta; a liquidação precisa apontar para uma
  saída válida que já existia antes da transação, para uma conta a pagar, e carregar evidência; na saída só pode
  **aumentar** o alocado; na conta só muda a posição, e a situação só pode ficar parcial ou quitada.
- Transacional (uma transação), idempotente (chave = saída + alocações; repetir devolve `repetido`), auditável (histórico
  na conta, na saída e no vínculo documental), protegida por escopo (RLS por unidade), por **versão** da saída (a prévia
  carrega a versão; mudou → `FV2_CONFLITO_VERSAO`) e por trava da saída e das contas; competência homologada recusa.
- **Duas sessões, mesma saída** (navegador, Cenário 3):
  - mesmo vínculo confirmado ao mesmo tempo → uma grava, a outra recebe `repetido` (idempotência, sem efeito);
  - vínculos **diferentes** disputando os mesmos R$ 400,00 restantes (conta B × aluguel) → uma vence; a outra recebe
    **409 `FV2_CONFLITO_VERSAO`** — "A saída mudou desde a prévia (outra baixa, conciliação ou correção). Atualize e
    confira de novo." — sem efeito parcial (B continua com R$ 400,00 em aberto).
  - Na suíte, concorrência real no PostgreSQL (teste 18).

## 7. Interface (Fase H)

- Contas a Pagar: explicação Registrar × Vincular; seção "Vincular pagamento do extrato" só para quem tem a permissão;
  prévia em painel; detalhe com valor original, pago, saldo, vencimento, pagamentos (data, conta, "saída agrupada com N
  outra(s)", "vinculado do extrato"), documentos e histórico.
- Central de Conferências: a pendência mostra "como está no fechamento" (situação e motivo) e se documenta no próprio
  painel (só com `fechar`); a correspondência e o detalhe da saída mostram o vínculo.
- Fechamento: "Pendências diante da homologação" com **Bloqueantes**, **Precisam ser documentadas**, **Documentação
  insuficiente**, **Documentadas: ressalvas admissíveis**, **Resolvidas**, "O que impede homologar" e, na homologada,
  "Homologação registrada" (com/sem ressalvas e a lista aprovada). Ações com o motivo de estarem indisponíveis.
- A recusa da homologação por divergência agora lista as divergências (antes dizia só "não pode ser homologada").
- Sem links fictícios; auditor de acessibilidade sem problemas nos painéis novos; 390 px sem rolagem horizontal.

## 8. Jornadas no navegador (Fase I)

Roteiro `backend/scripts/fv2/jornada08e.mjs` (Playwright local, Chromium já instalado; senhas sintéticas lidas em tempo de
execução do arquivo fora do repositório). Toda ação passa pela tela; as únicas chamadas diretas são **tentativas de
contorno** (POST forjado com o CSRF da própria sessão) e leituras para conferir números. Preparação sintética por script
(`fv2-homologacao.mjs preparar`, que agora também cria o cenário agrupado de novembro). Nenhuma edição direta no banco.
Execução final contínua: Cenário 1 → Cenário 2 → fim do Cenário 1 → Cenário 3 → acessibilidade → reuso, **todas
aprovadas**. Capturas em `%LOCALAPPDATA%\fv2-homologacao\jornada-08e\` (fora do repositório).

**Cenário 1 — homologação indevida bloqueada (outubro)**

| Passo | Resultado |
|---|---|
| 1. Preliminar pela tela | 200; 2 bloqueantes, 6 por documentar, 1 impedimento |
| 2–3. Homologar | Botão desabilitado com os motivos; POST forjado → 409 `FV2_HOMOLOGACAO_BLOQUEADA` com o motivo |
| — "Com pendências" como atalho | Botão desabilitado; POST forjado → 409 `FV2_TRANSICAO_INVALIDA` |
| 4. Documentar "Falta: Vendas da Stone" | `DOCUMENTADA_ADMISSIVEL` |
| 5. Documentar a bloqueante com texto persuasivo | continua `BLOQUEANTE` |
| 6–7. Tentar de novo (homologar e "com pendências") | recusados na tela e no servidor, com motivos |
| 8. Resolver as impeditivas com evidência | saída sem classificação → Cenário 2; despesa a classificar → reclassificação com a nota fiscal sintética (despesas −3.447,30 → −3.637,20; banco intacto) |
| — Documentar as 4 restantes | todas `DOCUMENTADA_ADMISSIVEL`; do preliminar, homologar continua recusado ("passe por com pendências") |
| 9. Com pendências → homologar | 200; v3 `HOMOLOGADA`, `comRessalvas: true`, 5 ressalvas |
| 10. Versão, histórico e DRE | versões 1 PRELIMINAR, 2 COM_PENDENCIAS, 3 HOMOLOGADA (vigente); histórico com as 6 documentações e as 3 transições; DRE com versão homologada que reproduz, resultado CONFIRMADO; 6 pendências documentadas preservadas |

**Cenário 2 — baixa sem duplicidade (R$ 618,50):** ver § 5. Passos 1–12 executados; repetição sem efeito.

**Cenário 3 — pagamento agrupado (novembro, saída de R$ 1.000,00):** A (R$ 600,00) por duas sessões simultâneas → uma
grava, outra `repetido`; restante R$ 400,00 disputado por B × aluguel simultaneamente → um 200, um 409; saída com
R$ 0,00 disponível, 8 → 8 movimentos; detalhe de A mostra "saída agrupada" e "vinculado do extrato"; a tela não oferece
mais a saída esgotada; POST forjado com a **versão atual** → 409 `FV2_LIQUIDACAO_EXCEDE_MOVIMENTACAO`, sem efeito.

**Acessibilidade:** 390 × 844 sem rolagem horizontal (fechamento, conta, lista); teclado Tab → Enter abre o painel com o
foco no "Fechar"; Escape fecha e devolve o foco ao botão de origem.

## 9. Testes (Fase J)

| Suíte | `afeb853` | Final 08E |
|---|---|---|
| Núcleo em memória (`node --test test/financeiro-v2/*.test.js`) | 332/332 | **348/348** |
| Núcleo em PostgreSQL isolado (`FV2_REPOSITORIO=postgres`) | 332/332 | **348/348** |
| Núcleo só em memória, sem banco (condição equivalente nas duas árvores; `afeb853` num worktree temporário) | 276 aprovados, 56 pulados, 0 falhas | **289 aprovados, 59 pulados, 0 falhas** |
| Núcleo em memória, modo de conferência da carga (`FV2_CONFERIR_CARGA=1`) | 332/332 (08D) | **348/348** |

Comparação por nome: os 332 testes de `afeb853` continuam presentes e nenhum passou a falhar ou a ser pulado.
| Frontend (`node --test test/`) | 1942 aprovados, 26 pulados | **1949 aprovados, 26 pulados, 0 falhas** |

Novos (16 no núcleo + 2 no frontend) cobrem os 30 itens pedidos: avaliação (1, 3, 4, 5, 23), preliminar não documentado
(2), ressalvas e versão (3, 6, 7), bloqueante e reabertura (4, 8), baixa sem saída/despesa nova com DRE/banco/fluxo
(9–12, 24, 25), Central (26), parcial/agrupado/várias saídas/esgotada/duplicada (13–17), evidência (10, 23), permissão e
escopo (19, 22), competência homologada e entre períodos (20, 21), concorrência real (18), "com pendências" sem contorno
(1b, 1c), barreiras do banco 0018/0019, e no frontend a tela de conta a pagar, a prévia, o painel de pendência e a tela
de fechamento (com auditor de acessibilidade). Itens 27–30 (navegador, responsividade, teclado, regressão das sete
áreas): § 8 e a suíte do frontend.

Testes antigos ajustados (sem afrouxar regra): os que entravam em "com pendências" com texto livre ou com bloqueantes
passaram a documentar as pendências reais (ou a esperar a recusa); a semente da demonstração deixa setembro no
**preliminar** (tem bloqueantes) em vez de "com pendências" com texto livre.

**Mutação** (cópia de segurança + restauração conferida por hash; mutantes de banco reconstroem o banco-modelo):
**18/18 detectados**.

| Grupo pedido | Mutantes |
|---|---|
| Bypass da regra de homologação | M1 homologar sem avaliar; M2 ressalva direto do preliminar; M3 texto sem decisão vira ressalva; M4 saída sem vínculo vira ressalva; M5 gatilho 0018 desligado; M16 "com pendências" sem avaliar (núcleo); M17 bloqueante aceita em "com pendências" (domínio); M18 gatilho 0019 desligado |
| Dupla baixa da obrigação | M6 repetição sem idempotência; M7 saldo da conta não conferido |
| Dupla alocação bancária | M8 total acima do disponível; M9 saída esgotada aceita; M10 sem trava nem versão |
| Falta de permissão | M11 vincular com `ver`; M12 só-vincula pode criar saída (banco) |
| Alteração em competência homologada | M13 documentar em homologada; M14 homologar reescreve pendências |
| Evidência | M15 baixa sem evidência |

## 10. Desempenho e acessibilidade

- Nenhuma refatoração de desempenho. As otimizações da 08D foram preservadas; a suíte de equivalência dirigida × completa
  (`desempenho-equivalencia-competencia`) continua passando.
- A avaliação das pendências reutiliza a carga dirigida da competência; a transição para "com pendências" passou a
  calcular os impedimentos (uma apuração a mais por transição — custo pontual, não por tela).
- **Não executados (PENDENTES, não PASS):** leitor de tela real; medição de contraste; nova medição do crescimento
  residual de consultas observado na 08D (telas de posição lineares por natureza).

## 11. Riscos e pendências

1. **Tabela de efeito por código** é decisão de produto registrada aqui; precisa da validação do responsável financeiro
   antes do uso real (em especial: crédito não identificado como ressalva de efeito conhecido).
2. O banco não recalcula as pendências: confere a avaliação gravada e as verificações objetivas. Um núcleo comprometido
   poderia declarar uma pendência "sem efeito" que o banco não reconhece — limite aceito, mitigado pelas verificações
   objetivas e pela auditoria.
3. A lista de saídas elegíveis aceita uma saída **anterior** à emissão da conta (ex.: 21/09 para conta de outubro) — não
   há bloqueio por data, só a escolha humana com a data visível na prévia.
4. Correspondência candidata antiga para o mesmo par continua "a decidir" depois do vínculo (ruído, não erro).
5. Bancos de teste descartáveis criados no cluster isolado pelas preparações repetidas da jornada (sem uso).
6. Pendentes da Fase 13: leitor de tela, contraste, crescimento residual de consultas.

## 12. Confirmação

Produção intocada: nenhuma conexão ao Supabase, nenhum `.env` lido, nenhuma migração fora do PostgreSQL isolado,
nenhuma permissão real alterada, nenhum dado real, sem push/merge/deploy. As migrações 0018 e 0019 existem só em
`database/financeiro-v2/migracoes/` (fora de `database/migrations/`).
