# 06 — Migration 152 em produção: procedimento do operador

Pré-requisitos:
- a 151 aplicada e íntegra (o preflight confere);
- o código publicado com flag vazio;
- **autorização própria** do proprietário para esta migration.

O script é `backend/testes-seguros/producao/prod-migrar-152.mjs`, derivado do script da 151, com as mesmas travas de conexão, identidade, backup e exportação. Nenhuma credencial passa pelo chat.

1. **Backup/PITR:** painel do Supabase → Database → Backups. Anote o tipo e o horário UTC do último backup válido (doc 03, Passo 1).
2. **Conexão**, digitada só no terminal. Formato `postgresql://postgres:<senha codificada>@db.<ref>.supabase.co:5432/postgres?sslmode=require`:
   ```powershell
   $env:PROD_CONN = Read-Host "conexão (não será exibida)" -AsSecureString | ForEach-Object { [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($_)) }
   ```
3. **Preflight** (somente leitura):
   ```powershell
   node backend/testes-seguros/producao/prod-migrar-152.mjs preflight
   ```
   - Esperado: `PREFLIGHT: OK` e `PROD_IDENTIDADE=…`. Guarde o valor em `$env:PROD_IDENTIDADE`.
   - Ele recusa se:
     - faltar a 120, 121, 122, 126 ou 151;
     - a lista de tabelas da unidade não estiver exatamente na versão da 151;
     - a guarda de transferência estiver diferente;
     - os objetos da 152 já existirem;
     - o papel não tiver leitura total;
     - houver transação longa ou trava aguardando.
4. **Exportação** (somente leitura):
   ```powershell
   node backend/testes-seguros/producao/prod-migrar-152.mjs exportar
   ```
   - Esperado: `EXPORTAÇÃO: OK`. Guarde `$env:PROD_EXPORTACAO`.
5. **Aplicar** (só com autorização):
   ```powershell
   $env:PROD_BACKUP_CONFIRMADO="SIM"; $env:PROD_BACKUP_TIPO="pitr"; $env:PROD_BACKUP_HORARIO="AAAA-MM-DDTHH:MMZ"; $env:PROD_AUTORIZO="SIM"
   node backend/testes-seguros/producao/prod-migrar-152.mjs aplicar
   ```
   - `RESULTADO: OK`: nenhuma tabela existente mudou e as 6 tabelas novas estão vazias.
   - `FALHA`: a transação foi desfeita e nada mudou.
6. **Verificar:**
   ```powershell
   node backend/testes-seguros/producao/prod-migrar-152.mjs verificar
   ```
   - Esperado: `VERIFICAÇÃO: OK — 152 completa`.

**Reversão:**
- O código fica inerte com o flag vazio.
- O schema só volta com `PROD_AUTORIZO_REVERSAO=SIM … reverter`. A reversão **recusa** se houver dados nas tabelas da 152 e restaura a lista de tabelas da 151.
- Dados alterados só se recuperam pelo backup/PITR.

**Ensaio local** (reproduz a produção atual, com a 151 e dados sintéticos): `PG_CLUSTER_DIR=<cluster> bash backend/testes-seguros/producao/ensaio_prod_migrar_152.sh` → 15/0.
