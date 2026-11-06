# 03 — Procedimento do operador: backups, exportação, preflight, aplicação e verificação da 151

Para ser executado **pelo operador autorizado, no próprio computador**, no PowerShell, a partir da pasta do repositório no commit revisado (`git status` limpo).
**Nunca cole conexão, senha ou token no chat.** Todos os segredos entram só como variáveis de ambiente da sessão do PowerShell e somem ao fechar a janela.
As evidências ficam em `%TEMP%\evidencias-prod`, fora do Git e sem a conexão. A exportação contém **dados financeiros reais**: não envie para lugar nenhum e não coloque no OneDrive compartilhado.

Pré-requisitos: PostgreSQL 17 client instalado (`psql`, `pg_dump` e `pg_restore` em `C:\Program Files\PostgreSQL\17\bin`), Node 20 e o repositório no commit revisado.

---

## Passo 1 — Backups/PITR de produção (obrigatório; a exportação lógica NÃO o substitui)

### 1A. Pelo painel (caminho principal)
1. https://supabase.com/dashboard → projeto **Crescer Com Delivery** (`uqybgauuxcrqzquultfu`) → **Database → Backups**.
2. Anote, em UTC:
   - **Tipo disponível:** "Point in Time" (PITR) ou "Scheduled backups" (diários).
   - **Horário do último backup válido:** no PITR, o horário mais recente até onde é possível restaurar; no diário, o horário do último backup com status concluído.
   - **Retenção:** até quando dá para voltar (quantos dias).
3. Se a aba disser que o plano **não tem backups restauráveis**: **PARE. NO-GO.** Avise o proprietário.

### 1B. Pela API de gestão (opcional, para registrar a evidência)
Use um *access token* pessoal (Account → Access Tokens), digitado só no seu terminal:
```powershell
$env:SUPABASE_ACCESS_TOKEN = Read-Host "token (não será exibido)" -AsSecureString | ForEach-Object { [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($_)) }
$r = Invoke-RestMethod -Headers @{ Authorization = "Bearer $env:SUPABASE_ACCESS_TOKEN" } -Uri "https://api.supabase.com/v1/projects/uqybgauuxcrqzquultfu/database/backups"
$r | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 "$env:TEMP\evidencias-prod\151-backups-$(Get-Date -Format yyyyMMdd-HHmmss).json"
$r.pitr_enabled; $r.backups | Select-Object -Last 3 inserted_at, status, is_physical_backup
Remove-Item Env:SUPABASE_ACCESS_TOKEN
```
Confira `pitr_enabled` e o `inserted_at` mais recente com `status = COMPLETED`.

### 1C. O que vale para o script
O `aplicar` exige estas três variáveis:
- `PROD_BACKUP_CONFIRMADO=SIM`;
- `PROD_BACKUP_TIPO=pitr` ou `diario`;
- `PROD_BACKUP_HORARIO=<AAAA-MM-DDTHH:MMZ, em UTC>`.

O horário precisa ser recente: **no máximo 1 h no PITR**, ou **26 h no diário**. Com backup diário, o ideal é aplicar logo depois de um backup concluído. Em caso de restauração, **tudo o que todas as empresas gravarem depois desse horário se perde.**

---

## Passo 2 — Conexão (só no seu terminal)
Conexão **direta**: host `db.uqybgauuxcrqzquultfu.supabase.co`, porta **5432**, usuário `postgres`. Também serve o pooler de **sessão** (5432, usuário `postgres.uqybgauuxcrqzquultfu`). **Nunca a porta 6543.**

Formato: `postgresql://postgres:<senha>@db.uqybgauuxcrqzquultfu.supabase.co:5432/postgres?sslmode=require`.
- Se a senha tiver caracteres especiais (`@ : / ? # % &`), ela precisa estar **URL-encoded** (ex.: `@` → `%40`).
- O script **recusa** qualquer parâmetro na URL além de `sslmode` (`host`, `hostaddr`, `port`, `service`…), lista de hosts e `sslmode` sem criptografia: esses parâmetros desviariam a conexão para outro servidor.
```powershell
$env:PROD_CONN = Read-Host "conexão postgres (não será exibida)" -AsSecureString | ForEach-Object { [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($_)) }
cd "<pasta do repositório>"
git status --short database/migrations/151_financeiro_2_contas_pagar.sql database/migrations/151_rollback.sql   # precisa sair vazio
```

## Passo 3 — Preflight (somente leitura)
```powershell
node backend/testes-seguros/producao/prod-migrar-151.mjs preflight
```
- Esperado: `PREFLIGHT: OK` e uma linha `PROD_IDENTIDADE=<…>`.
- Qualquer `PREFLIGHT: NÃO APLICAR` ou `RECUSADO` significa **PARAR** e me enviar só o texto das recusas, nunca a conexão.

O preflight confere:
- projeto de produção (recusa o de testes e a porta 6543);
- sha256 da 151 e do rollback revisados;
- 120, 121 e 122 presentes (≥ 12 tabelas `fin_*` e funções);
- **126 em vigor**;
- funções compartilhadas **idênticas às da 120**;
- CHECK e níveis de concessão;
- objetos da 151 ainda inexistentes;
- papel com leitura total (BYPASSRLS), necessário para a exportação;
- nenhuma transação longa nem trava aguardando.

```powershell
$env:PROD_IDENTIDADE = "<valor impresso pelo preflight>"
```

## Passo 4 — Exportação financeira e verificação da integridade (somente leitura)
```powershell
node backend/testes-seguros/producao/prod-migrar-151.mjs exportar
```
- Esperado: `EXPORTAÇÃO: OK — todas as tabelas financeiras presentes` e `PROD_EXPORTACAO=<sha256>`.
- O script roda `pg_dump --data-only` numa transação read-only, confere com `pg_restore -l` que **todas** as tabelas `fin_*` e `gestao_financeira_*` estão no arquivo e grava o manifesto (arquivo, sha256, horário, identidade do banco).

```powershell
$env:PROD_EXPORTACAO = "<sha256 impresso>"
```
Conferência manual opcional:
```powershell
& "C:\Program Files\PostgreSQL\17\bin\pg_restore.exe" -l (Get-Content "$env:TEMP\evidencias-prod\151-exportacao-manifesto.json" | ConvertFrom-Json).arquivo | Select-String "TABLE DATA"
```

## Passo 5 — Registro das evidências
Antes de aplicar, guarde (sem a conexão):
- a saída do preflight;
- a saída da exportação;
- o JSON ou a captura da aba Backups;
- o horário UTC anotado.

O script também grava `151-preflight-*.log` e `151-exportacao-manifesto.json` em `%TEMP%\evidencias-prod`.

## Passo 6 — Aplicação da 151 (SOMENTE depois da autorização explícita do proprietário)
```powershell
$env:PROD_BACKUP_CONFIRMADO = "SIM"; $env:PROD_BACKUP_TIPO = "pitr"        # ou "diario"
$env:PROD_BACKUP_HORARIO = "2026-11-06T03:00Z"                             # o horário UTC anotado no Passo 1
$env:PROD_AUTORIZO = "SIM"
node backend/testes-seguros/producao/prod-migrar-151.mjs aplicar
```
- Esperado: `RESULTADO: OK — 151 aplicada; NENHUMA tabela existente mudou de conteúdo; tabelas novas vazias`.
- O script repete o preflight e as conferências de backup e exportação **imediatamente antes**. Ele aplica em uma transação com `lock_timeout` de 5 s e compara a impressão digital do conteúdo de todas as tabelas financeiras e de plataforma antes e depois.
- `FALHA` significa que a transação foi desfeita e nada mudou.
- `DIVERGÊNCIA` significa **parar** e seguir o plano de reversão (doc 02 §5).

## Passo 7 — Verificação pós-migration (somente leitura)
```powershell
node backend/testes-seguros/producao/prod-migrar-151.mjs verificar
```
Esperado: `VERIFICAÇÃO: OK` (4 tabelas, RLS, gatilhos, funções compartilhadas na versão da 151, níveis novos).

Depois, ainda **com o flag vazio**, faça um smoke só de leitura do financeiro anterior numa empresa real: Visão Geral, Fluxo de Caixa e Períodos.

```powershell
Remove-Item Env:PROD_CONN, Env:PROD_AUTORIZO, Env:PROD_BACKUP_CONFIRMADO   # encerrar a sessão de produção
```

## Passo 8 — Ativação restrita da organização de QA (ETAPA POSTERIOR; exige autorização própria)
1. Publicar o backend do Financeiro 2.0 com `FINANCEIRO_2_ORGANIZACOES` **vazio**, depois do merge e do deploy autorizados.
2. Painel SuperAdmin:
   - criar a empresa "QA Financeiro 2.0 (sintética)" e a unidade "Loja QA (sintética)";
   - ligar o Financeiro só nelas;
   - em Acesso Financeiro, dar os níveis às contas de teste.
3. Render → serviço `crescercomdelivery` → Environment: `FINANCEIRO_2_ORGANIZACOES=<uuid da empresa de QA>` (somente ela) → salvar, o que reinicia o serviço.
4. Ao final da homologação:
   ```powershell
   $env:PROD_QA_ORG = "<uuid da empresa de QA>"
   node backend/testes-seguros/producao/prod-migrar-151.mjs isolamento
   ```
   Esperado: `ISOLAMENTO: OK — dados do Financeiro 2.0 só na organização de QA`.

5. **Limpeza da QA** ao encerrar a homologação (só dados sintéticos; exige autorização própria). Primeiro retire a QA de `FINANCEIRO_2_ORGANIZACOES` no Render.
   ```powershell
   $env:PROD_QA_NOME = "QA Financeiro 2.0 (sintética)"        # nome EXATO da organização no Painel
   node backend/testes-seguros/producao/prod-migrar-151.mjs limpar-qa        # SIMULAÇÃO: só mostra o que seria apagado
   $env:PROD_FLAG_SEM_QA = "SIM"; $env:PROD_AUTORIZO_LIMPEZA = "SIM"
   node backend/testes-seguros/producao/prod-migrar-151.mjs limpar-qa        # executa
   ```
   Esperado: `LIMPEZA: OK`. A limpeza apaga **apenas** as linhas das 4 tabelas da 151 da organização de QA, numa transação que confere que nenhuma outra empresa mudou. A auditoria da QA permanece, por desenho.

**Atenção:** o R4 (reverter o schema) só existe **antes** de conceder os níveis `contador`/`administrador`; depois disso a reversão é esvaziar o flag (doc 02 §5).

**Reverter** (se necessário, doc 02 §5): primeiro esvaziar o flag; o schema só volta com `PROD_AUTORIZO_REVERSAO=SIM node … reverter`, que recusa se houver qualquer dado da 151.
