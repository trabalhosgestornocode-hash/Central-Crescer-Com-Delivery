# MOVA CORE — Release Candidate (RC1, 25/11/2026)

Branch `feat/mova-core-integrada` (local; inclui todo o `main` até 320802d — #212, #216, #219, #220). **Nada publicado.**
Nenhum merge, deploy, migração em produção, mudança de orçamento, escrita financeira ou envio real foi feito.

## 1. O que o RC contém

| Bloco | Estado | Prova |
|---|---|---|
| F1–F3: laço de ferramentas, verificador, memória, conceitos, Agente Crescer | pronto (isolado) | suíte mova-core 141/141 (PostgreSQL isolado) |
| F2 vínculo WhatsApp ↔ plataforma + tela | pronto; **rotas já montáveis** por `MOVA_CORE_VINCULO_HABILITADO` | testes F2 + 0019 |
| F4 compra já paga + prestação de sangria (proposta → "sim" → execução pelo servidor) | pronto (isolado) | testes OP/SG (inclui OP-14..17); §9 real: 15/15 cenários aprovados ao menos uma vez pós-ajuste, 0 sucesso falso |
| Propostas persistentes (0020): reinício, várias instâncias, CAS, retomada | pronto | PP-1..5 em PostgreSQL |
| F5 conhecimento corporativo (0021) + corpo de 35 itens (PENDENTES) | pronto | CN-01..05 + CN-PG-1..3 |
| Escalonamento Sonnet (só homologação, desligado em produção) | pronto, **recomendado manter desligado** | ES-01..04 + avaliação |
| Integração do motor de conversa ao pipeline do WhatsApp (sombra/resposta) | **feito** (`MOVA_CORE_CONVERSA`, desligado por padrão) | MC-01..07 + conversa real pelo pipeline (doc 10) |

**Publicação controlada:** ver doc 10 (piloto Açaí, sem migração).

## 2. Ordem das migrações (schema `mova`)

| Ordem | Migração | Em produção? | Reversão |
|---|---|---|---|
| 1 | 0019 identidade + memória | **não** | `reverter-0019.sql` |
| 2 | 0020 propostas do MOVA CORE | **não** | `reverter-0020.sql` (aborta com proposta EXECUTANDO) |
| 3 | 0021 conhecimento | **não** | `reverter-0021.sql` (aborta com conhecimento APROVADO) |

O pacote `database/mova-financeiro/producao/` está regenerado e conferido (`pacoteProducao.mjs --conferir`). Aplicar
sempre com backup antes e o pré-voo somente leitura (inventário).

## 3. Configuração inicial (tudo desligado por padrão)

| Variável | Valor inicial | Observação |
|---|---|---|
| `MOVA_CORE_VINCULO_HABILITADO` | 0 → 1 só no piloto | rotas de vínculo |
| `MOVA_CORE_SOMBRA` (a criar com o adaptador) | 0 → 1 no piloto | só lê; nunca responde |
| `MOVA_CORE_RESPOSTA` (a criar) | 0 | responder pela nova IA |
| Operações (`operacoes` injetado) | **desligado** | 1ª publicação sem escrita nova |
| `MOVA_CORE_PROPOSTA_VALIDADE_MIN` | 30 | 5–120 |
| `MOVA_CORE_ESCALONAMENTO` | 0 | nunca em produção nesta etapa |
| Conhecimento | ligado só para leitura | corpo PENDENTE = "documentação em revisão" |

## 4. Estratégia de publicação (proposta)

1. **Etapa 0 — infraestrutura:** aplicar 0019–0021 (vazias), deploy com tudo desligado, health igual ao atual.
2. **Etapa 1 — vínculo:** ligar `MOVA_CORE_VINCULO_HABILITADO` numa unidade piloto; vincular 2–3 pessoas.
3. **Etapa 2 — sombra (depende do adaptador):** o motor roda ao lado do MOVA atual **somente leitura, sem resposta**,
   registrando rota, ferramentas, custo, latência e verificador. Dados reais na sombra **só com autorização específica**.
4. **Etapa 3 — conversa e conhecimento:** responder pela nova IA no piloto, só consultas + conhecimento; operações
   financeiras novas **desligadas**.
5. **Etapa 4 — operações:** compra já paga e prestação de sangria com confirmação, política aprovada por unidade.

## 5. Unidade piloto

Sugestão: **Açaí no Grau Saci** (já tem grupo FINANCEIRO, política de comprovante aprovada em 22/11 e histórico de
homologação). Decisão do proprietário.

## 6. Monitoramento

Eventos já emitidos: `MOVA_CORE_RESPOSTA`, `MOVA_CORE_FERRAMENTA`, `MOVA_CORE_VERIFICADOR_REPROVOU`, `MOVA_CORE_IA_FALHOU`,
`MOVA_CORE_SOMBRA`, `MOVA_CORE_OPERACAO`, `MOVA_CORE_IDENTIDADE`, `MOVA_CORE_CONHECIMENTO`, `MOVA_CORE_ESCALONAMENTO`.
Painel mínimo: respostas/dia, % verificador reprovou, % resposta parcial, custo/dia vs teto, latência p50/p95,
propostas por estado, escritas executadas vs confirmadas, conexões PostgreSQL (doc 07).

## 7. Testes de saúde (após cada etapa)

`/health` igual ao atual; inventário das migrações (sha256); vínculo: gerar código, vincular, revogar (efeito imediato);
sombra: 1 pergunta sintética com registro `MOVA_CORE_SOMBRA` e **nenhuma mensagem enviada**; orçamento: consumo
registrado e teto respeitado.

## 8. Vínculo de usuários (procedimento)

Configurações → Usuários e acesso → WhatsApp (MOVA) → "Gerar código" → na conversa **privada** com o MOVA:
`vincular <código>` (vale 10 min, uso único) → quem administra aprova o vínculo pessoa↔perfil → conferir na tela.
Revogação: botão na mesma tela (imediata).

## 9. Checklist de homologação no WhatsApp

- [ ] pessoa não vinculada recebe orientação de vínculo e nenhum dado
- [ ] pergunta de saldo/contas com valores exatos da Central
- [ ] unidade sem permissão: recusa sem dado
- [ ] perfil sem valores: resposta sem valores
- [ ] revogação no meio da conversa vale no turno seguinte
- [ ] pergunta de conhecimento ("como funciona a sangria?") cita "pela documentação do sistema"
- [ ] pergunta de regra pendente diz "proposta pendente", nunca "regra"
- [ ] (etapa 4) compra com comprovante: proposta → "sim" → conta na Central; "sim" de outra pessoa não executa
- [ ] nada é dito "registrado" antes da confirmação do backend

## 10. Reversão

Desligar a variável da etapa (efeito no próximo request); se preciso, redeploy do commit anterior. Migrações só pelos
scripts oficiais e só se vazias (os scripts recusam em caso contrário). Nenhuma reversão apaga dado financeiro.

## 11. Separação leitura/escrita

Leitura: porta somente leitura (`OPERACOES_PERMITIDAS`), sombra exige essa porta. Escrita: só pela lista fechada
`executorDaPessoa` (3 operações), só após "sim" determinístico da mesma pessoa, com permissão recalculada e política
vigente; a IA nunca chama escrita. Conhecimento: a IA só sugere (PENDENTE); aprovação humana.

## 12. Pendências materiais

1. Adaptador ao pipeline: feito (doc 10).
2. Migrações 0019–0021 não aplicadas em produção.
3. Corpo de conhecimento inteiro PENDENTE: precisa de revisão e aprovação humana (script de aprovação a fazer na Central).
4. Metas do conjunto cego não atingidas (ver relatório): decisão final e casos críticos abaixo da meta na rodada cega.
5. Ferramentas do Agente Crescer: só 3 das 12 avaliadas com o modelo real.
6. Conferência real de conexões PostgreSQL (doc 07, seção 6) antes da etapa 2.
