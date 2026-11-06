# 04 — Relatório final da Etapa 2: verificação final e preparação da migration 151

Data: 05/11/2026 · Branch local `feat/financeiro-2-0` @ `9bccfdd` (sem push, PR ou deploy) · **A migration 151 NÃO foi executada em produção.**
Destino: projeto **Crescer Com Delivery** — `uqybgauuxcrqzquultfu` (us-west-2, PostgreSQL 17.6).

## 1. Resultado da revisão independente final

A 3ª revisão foi feita por um revisor **novo**, que não participou das duas primeiras.

| Rodada | Veredito | O que encontrou |
|---|---|---|
| 3ª revisão (sobre `f5fd78e`) | **REPROVADO** | **A-1 (ALTO):** pela API, um vínculo "divergente" com justificativa conciliava R$ 10.100 de pagamentos contra uma saída de R$ 100. **M-1:** alocação parcial permitia conciliar R$ 200 de saídas com R$ 100 pagos. **M-2:** conta paga a menor num mês fechado ficava impossível de quitar. **B-1:** as invariantes falhavam em REPEATABLE READ. **B-2:** um teste do backend falhava. **B-3:** o preflight não conferia a ligação da guarda de transferência. **B-4:** a pós-condição não cobria os gatilhos de fornecedores. |
| Reverificação (sobre `e96854c`) | **APROVADO COM RESSALVAS** | A-1, M-1, M-2, B-2, B-3 e B-4 resolvidos; B-1 parcial. Duas ressalvas novas, BAIXAS: **NOVO-1** (saída vinculada editável em REPEATABLE READ) e **NOVO-2** (quitação deslocada caía num mês passado ainda aberto, e não no mês da decisão). Nenhum caminho restante para conciliar valor maior que o movimento bancário, inclusive com duas sessões concorrentes. |
| Correções finais (`9bccfdd`) | — | NOVO-1 e NOVO-2 corrigidos, com as provas Z09, Z10 e Z11. **Essas duas correções pequenas não passaram por nova reverificação do revisor.** |

Itens verificados pelo revisor sem achados:
- isolamento entre empresas e lojas;
- RLS e privilégios: a pós-condição detectou 6 de 6 mutações;
- permissões financeiras;
- transferência indevida de lojas: as funções compartilhadas mudam só por acréscimos em relação à 120;
- integridade dos pagamentos;
- fechamento mensal;
- feature flag desabilitada por padrão;
- compatibilidade com as migrations existentes.

Limites aceitos e documentados:
- as flags locais `fin2.*` podem ser forjadas por quem já tem SQL bruto como `service_role`. Esse caminho não existe pelo PostgREST e é o mesmo limite já documentado na 122;
- o backup é declarado pelo operador.

## 2. Resultado dos testes (versão final)

| Suíte | Resultado |
|---|---|
| Provas PG da 151 (inclui todas as provas dos achados das 3 revisões) | **148 / 0** |
| Suíte PG existente (120/121/122/126, com concorrência real) **com a 151 aplicada** | **todas OK** |
| Transferência/promoção de lojas na cadeia real da `origin/main` + 151 | **74 / 0** |
| Ensaio do script de produção | **23 / 0** |
| Ensaio de recuperação lógica de dados | **7 / 0** |
| E2E HTTP (gate → rotas → serviços → banco), inclui flag | **53 / 0** |
| Backend: testes do financeiro e da gestão financeira | **277 / 0** |
| Frontend | **1.663 / 0** |
| Navegador (5 perfis, celular escuro, flag desligado) | **34 / 0** |

As saídas completas estão em `docs/financeiro-2-0/implementacao/evidencias/`. A suíte completa do backend tem 16 falhas pré-existentes, todas sem relação com o Financeiro e idênticas na `origin/main` limpa (detalhes no doc 01, §5).

## 3. Situação dos backups

**NÃO CONFIRMADO.** Eu não tenho acesso ao painel nem ao catálogo de produção. O teste de recuperação lógica com dados sintéticos **não substitui** um backup recuperável do ambiente real.

O que falta (instruções no doc 03, Passo 1):
- conferir no painel (Database → Backups), ou pela API de gestão, se há PITR ou backup diário;
- anotar o **horário UTC do último backup válido** e a retenção.

O `aplicar` recusa se:
- faltar o tipo ou o horário do backup;
- o horário for antigo: mais de 1 h no PITR, mais de 26 h no diário.

## 4. Resultado das verificações de dependências

| Verificação | Situação |
|---|---|
| Identificação do projeto de produção | **Confirmada** pelos metadados da conta: "Crescer Com Delivery", `uqybgauuxcrqzquultfu` |
| 120, 121, 122 e 126 presentes em produção | **NÃO VERIFICADO.** A leitura do catálogo de produção foi negada pelo controle de permissões, e eu não tentei contornar. O registro de migrations do Supabase não as lista, porque foram aplicadas pelo operador via psql |
| Funções compartilhadas idênticas às da 120 | **NÃO VERIFICADO** (mesmo motivo) |
| Compatibilidade com as migrations do repositório | **Confirmada localmente**: nenhuma migration de 123 a 150 redefine as funções compartilhadas; a cadeia real + 151 está verde |

As duas verificações pendentes são **recusas automáticas do preflight**. Se a 120, 121, 122 ou 126 estiver ausente, ou se as funções compartilhadas (texto, atributos ou ligação com a transferência de lojas) divergirem, ele responde `PREFLIGHT: NÃO APLICAR` (ensaio E14, E15 e E23).

## 5. Comandos necessários para o operador

O procedimento completo, com os comandos exatos, está no doc **03-procedimento-operador.md**. Nenhuma credencial passa pela conversa: tudo entra por `Read-Host` no PowerShell do operador.

1. Backups/PITR: painel ou API → tipo e horário UTC.
2. `$env:PROD_CONN` (conexão direta, porta 5432, usuário `postgres`), digitado no terminal.
3. `node backend/testes-seguros/producao/prod-migrar-151.mjs preflight` → precisa dar `PREFLIGHT: OK` e imprime `PROD_IDENTIDADE`.
4. `… exportar` → `EXPORTAÇÃO: OK`. O comando confere todas as tabelas financeiras e imprime `PROD_EXPORTACAO=<sha256>`.
5. Guardar as evidências (`%TEMP%\evidencias-prod` e a captura da aba Backups).
6. **Só depois da sua autorização explícita:** `… aplicar`, com `PROD_IDENTIDADE`, `PROD_EXPORTACAO`, `PROD_BACKUP_CONFIRMADO`, `PROD_BACKUP_TIPO`, `PROD_BACKUP_HORARIO` e `PROD_AUTORIZO`.
7. `… verificar`.
8. Em etapa posterior, com autorização própria: organização de QA, flag só para ela, e `… isolamento`.

O preflight recusa automaticamente:
- projeto que não seja o de produção autorizado, inclusive o de testes, e a porta 6543;
- arquivo diferente do revisado (sha256) ou alterado localmente;
- 120, 121, 122 ou 126 ausentes ou incompatíveis;
- funções compartilhadas divergentes no texto ou nos atributos;
- guarda de transferência desligada ou desconectada do fluxo de transferência;
- níveis ou CHECK inesperados;
- objetos da 151 já existentes;
- papel sem leitura total (a exportação ficaria incompleta);
- transações longas ou travas aguardando.

O `aplicar` também recusa:
- backup sem confirmação, sem tipo, sem horário ou antigo;
- exportação ausente, adulterada, de outro banco ou com mais de 24 h;
- identidade divergente do preflight.

## 6. Pendências

1. **Backup/PITR de produção:** conferir e anotar o horário (operador).
2. **Exportação financeira:** executar e verificar (operador).
3. **Preflight** em produção (operador). Ele também confirma as dependências que eu não pude ler.
4. Reverificação das duas correções finais (NOVO-1 e NOVO-2) pelo revisor. Recomendada, não bloqueante; cobertas pelas provas Z09–Z11.
5. Script de expurgo restrito à organização de QA (reversão R3): ainda não escrito. Só é necessário antes de encerrar a homologação.
6. Restauração lógica no Supabase: ainda não ensaiada no projeto de testes (no ambiente local rodou como superusuário).
7. Pendências contábeis seguem abertas e registradas: **INC-012** (taxas Stone), **INC-013** (metodologia da DRE) e **INC-014** (diferenças na folha).

## 7. Recomendação

Aplicando os critérios de liberação do GO:

| Critério | Situação |
|---|---|
| Revisão independente final aprovada | **Atendido**: aprovado com ressalvas, e as ressalvas foram corrigidas com provas (item 6.4) |
| Testes relevantes aprovados | **Atendido** |
| Backup/PITR de produção confirmado | **Pendente** |
| Exportação financeira concluída e verificada | **Pendente** |
| Preflight retornando `PREFLIGHT: OK` | **Pendente** |
| Ausência de divergências nas dependências | **Pendente** (o preflight verifica) |
| Plano de recuperação disponível | **Atendido** (docs 02 e 03) |

### Resultado agora: **NO-GO** para aplicar a migration 151

O motivo é só um: três requisitos dependem do ambiente real e de credenciais, e ainda não foram cumpridos. Não há falha técnica conhecida em aberto.

### Passa a ser **GO** quando:
1. o backup/PITR estiver confirmado, com horário;
2. o passo `exportar` der `EXPORTAÇÃO: OK`;
3. o `preflight` der `PREFLIGHT: OK`;
4. você autorizar a aplicação com suas palavras.

Qualquer `RECUSADO` ou `NÃO APLICAR` mantém o NO-GO.

Continuam vetados nesta etapa:
- push, PR e deploy;
- ativar o Financeiro 2.0 para clientes;
- importar dados reais do Açaí no Grau.
