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
