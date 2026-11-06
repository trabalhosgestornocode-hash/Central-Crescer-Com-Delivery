# 02 — Plano de implantação e reversão da migration 151 (produção `uqybgauuxcrqzquultfu`)

**Este plano não foi executado.** Cada passo marcado 🔒 exige autorização específica, escrita pelo proprietário com as próprias palavras.
Quem executa é um **operador autorizado, no próprio terminal**. Nenhum agente recebe, lê ou guarda a conexão de produção (prática dos docs 25 e 26 da Gestão Financeira).

## 0. Princípios

1. **A 151 é aditiva.** Cria 4 tabelas novas, gatilhos novos em `fin_lancamentos` e `fin_periodos` (que só agem sobre os dados novos ou na passagem de um período para "fechado") e acrescenta 2 níveis ao CHECK de concessões. Também redefine 2 funções compartilhadas: mantém o comportamento da 120 e só acrescenta as 3 tabelas novas à guarda de transferência.
2. **Nenhum dado existente é alterado.** O script prova isso comparando, antes e depois, a impressão digital (md5 calculado no próprio banco) de **toda** tabela `fin_*`, `gestao_financeira_*`, `organizacoes`, `unidades`, `organizacao_modulos` e `unidade_modulos`.
3. **Fail-closed em camadas:**
   - a migration roda numa transação com `lock_timeout` de 5 s, tem pós-condições e é desfeita inteira se algo falhar;
   - o feature flag `FINANCEIRO_2_ORGANIZACOES` começa vazio;
   - as rotas novas respondem 404 fora do flag, e o menu fica oculto.
4. **Rollback de schema não recupera dados.** A recuperação de dados tem procedimento próprio (§6).

## 1. Ordem obrigatória

| # | Passo | Quem | Efeito em clientes |
|---|---|---|---|
| 1 | Revisão independente aprovada (feita: 2 passadas) e decisão do proprietário sobre o relatório 01 | proprietário | nenhum |
| 2 | 🔒 **Backup**: no painel do Supabase → Database → Backups, conferir PITR ativo ou backup recente e anotar o horário | operador | nenhum |
| 3 | 🔒 **Exportação lógica** dos dados financeiros (§6.1), guardada fora do Git | operador | nenhum |
| 4 | **Preflight** somente leitura (`prod-migrar-151.mjs preflight`) | operador | nenhum |
| 5 | 🔒 **Aplicar** (`… aplicar`), em janela de pouco uso | operador | nenhum (as tabelas novas ficam vazias e o flag segue vazio) |
| 6 | **Verificar** (`… verificar`) | operador | nenhum |
| 7 | 🔒 **Publicar o backend** com o código do Financeiro 2.0. O merge na `main` publica o Render `crescercomdelivery`; o frontend estático não tem auto-deploy (memória `render-frontend-only-sem-autodeploy`). O flag continua **vazio**. | proprietário | nenhum: telas ocultas e rotas com 404 |
| 8 | Smoke do financeiro anterior em produção (Visão Geral, Fluxo de Caixa, Períodos) numa empresa real, **só leitura** | proprietário | nenhum |
| 9 | 🔒 **Criar a organização de QA** (§3) pela tela do SuperAdmin | proprietário | nenhum |
| 10 | 🔒 **Ligar o flag só para a organização de QA** (`FINANCEIRO_2_ORGANIZACOES=<uuid da QA>` no Render). É mudança de configuração de produção. | proprietário | nenhum: só a QA vê |
| 11 | Homologação (Etapa 3) só com dados sintéticos na QA; ao final, `… isolamento` com `PROD_QA_ORG=<uuid>` | operador | nenhum |

A ordem 5 → 7 importa: o backend novo **não depende** da 151 com o flag vazio (provas E40–E42 e `financeiro2FlagPreFechamento.test.js`). Mas a migration antes do código evita qualquer janela em que o SuperAdmin ofereça os níveis novos sem o CHECK existir.

## 2. Comandos do operador

```powershell
$env:PROD_CONN = "<conexão direta db.uqybgauuxcrqzquultfu.supabase.co:5432, usuário postgres>"   # nunca colar no chat
node backend/testes-seguros/producao/prod-migrar-151.mjs preflight
# ler a saída: "PREFLIGHT: OK" e PROD_IDENTIDADE=<…>. Qualquer "NÃO APLICAR" = parar.
$env:PROD_IDENTIDADE = "<valor impresso>"; $env:PROD_AUTORIZO = "SIM"; $env:PROD_BACKUP_CONFIRMADO = "SIM"
node backend/testes-seguros/producao/prod-migrar-151.mjs aplicar
node backend/testes-seguros/producao/prod-migrar-151.mjs verificar
```

**O preflight recusa (condições de parada):**
- conexão do projeto de testes ou porta 6543;
- arquivo diferente do revisado (sha256) ou com alteração não commitada;
- dependência da 120/121/122 ausente ou menos de 12 tabelas `fin_*`;
- objetos da 151 já existentes;
- funções compartilhadas **diferentes da versão da 120** (drift) ou papel que não as administra;
- CHECK de níveis ou nível em uso inesperado;
- transações com mais de 5 min ou travas aguardando.

O passo `aplicar` repete o preflight imediatamente antes e grava as evidências fora do Git (`%TEMP%\evidencias-prod`, sem a conexão).

**Ensaio executado** (`ensaio_prod_migrar_151.sh`, 14/14 sobre a cadeia real da `origin/main` + 120 → 126, com dados existentes): as recusas acima, aplicar com conteúdo existente inalterado, verificar, reaplicação recusada, isolamento OK/FALHA, reversão recusada com dados e OK sem dados, e drift recusado.

## 3. Organização de QA isolada (item 10 do GO)

1. Painel SuperAdmin → Empresas → nova empresa **"QA Financeiro 2.0 (sintética)"** e uma unidade **"Loja QA (sintética)"**. Usar o fluxo normal da plataforma, com auditoria, e **não** SQL.
2. Habilitar o módulo Financeiro **só** nessa empresa e unidade. Em Acesso Financeiro, conceder os níveis às contas de teste. Nenhum vínculo com empresas reais.
3. `FINANCEIRO_2_ORGANIZACOES=<uuid da empresa de QA>` e mais nada.
4. **Garantias de isolamento:**
   - os dados da 151 ficam presos ao par empresa + unidade por gatilho (provas I01–I08) e o contexto vem só do gate (provas E09–E11);
   - fornecedores são por empresa;
   - o passo `isolamento` conta os registros das 4 tabelas novas e da auditoria delas **fora** da QA, e precisa dar 0 (ensaio E09/E10).
5. **Nunca usar dados reais do Açaí no Grau nesta etapa**, nem copiar dados de outra empresa.

## 4. Regras operacionais do flag

- **Desligar o flag de uma empresa que já tem dados da 151 trava o fechamento dela.** O gatilho do banco continua bloqueando, mas as telas para resolver ficam ocultas (revisão, achado N2). Só desligar para empresas sem dados da 151, ou depois do expurgo da QA (§5).
- Antes de qualquer reversão de schema, **retirar todas as empresas do flag** e publicar.

## 5. Reversão (do menor ao maior impacto)

| Nível | Quando | Como | Perda |
|---|---|---|---|
| R1 — esconder | qualquer problema de interface ou regra | esvaziar `FINANCEIRO_2_ORGANIZACOES` (config do Render) | nenhuma; os dados de QA continuam no banco |
| R2 — código | defeito no backend novo | reverter o merge e publicar; o código anterior não conhece as tabelas novas | nenhuma |
| R3 — limpeza da QA | encerrar a homologação | `… limpar-qa` (doc 03, Passo 8.5): simula por padrão; com `PROD_FLAG_SEM_QA=SIM` e `PROD_AUTORIZO_LIMPEZA=SIM`, apaga **só** as linhas das 4 tabelas da 151 da organização de QA, numa transação que confere que nenhuma outra empresa mudou (ensaio E24–E29). **Não** apaga `fin_lancamentos`/`fin_periodos`/`fin_contas`/`fin_plano_contas` da QA (financeiro anterior, também sintético, que fica inerte), nem a `fin_auditoria` (imutável por desenho). | só dados sintéticos da QA |
| R4 — schema | abandonar a 151 **antes** de conceder os níveis novos | `… reverter` com `PROD_AUTORIZO_REVERSAO=SIM`. O rollback **recusa** se houver qualquer linha nas tabelas novas ou concessão com nível `contador`/`administrador`, inclusive revogada. Restaura literalmente as funções da 120 e o CHECK de níveis (ensaio E11–E13). **Limite:** concessões revogadas são imutáveis (120, `gfc_validar`) e nenhum procedimento revisado as remove. Por isso, **depois que a homologação conceder os níveis novos, o R4 deixa de estar disponível**: a reversão passa a ser R1/R2 (flag vazio = Financeiro 2.0 inerte para todas as empresas; o schema da 151 permanece, sem efeito sobre o financeiro anterior). Remover concessões exigiria um procedimento novo, revisado e autorizado à parte. | nenhuma |
| R5 — dados | dano a dados financeiros existentes (não esperado: a 151 não os escreve) | §6 | ver §6 |

## 6. Recuperação de dados

1. **Antes da janela (passo 3):**
   - `pg_dump --data-only --format=custom -t 'public.fin_*' -t 'public.gestao_financeira_*'`;
   - conferir com `pg_restore -l` que o dump lista **todas** as tabelas financeiras. O ensaio pegou exatamente um erro desse tipo, em que só 1 de 18 tabelas entrava;
   - guardar o arquivo fora do Git, com acesso restrito: contém dados financeiros reais.
2. **Restauração lógica** (ensaio `ensaio_recuperacao_151.sh`, 7/7): em banco com o mesmo schema, `pg_restore --data-only --disable-triggers --single-transaction`. O conteúdo fica idêntico por md5 em todas as tabelas, as travas voltam a valer e a auditoria não se duplica. **Ressalva:** no ensaio a restauração rodou como superusuário. No Supabase o `postgres` não é superusuário pleno, e `--disable-triggers` pode ser recusado. Esse caminho precisa ser ensaiado **no projeto de testes** antes de se contar com ele.
3. **PITR do Supabase:** é o caminho primário para desastre. Volta **o banco inteiro** ao horário escolhido e descarta tudo o que todas as empresas gravaram depois (pedidos, checklists, comunicação, financeiro). Por isso é o último recurso, e o horário anotado no passo 2 é obrigatório.
