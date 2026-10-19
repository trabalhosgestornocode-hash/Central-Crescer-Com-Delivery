# 25 — Procedimento de produção: migrations 120–122 e publicação do PR #49

Executado **somente por um operador autorizado**, no próprio terminal. Nenhum agente lê, recebe ou guarda a conexão de produção.
Ferramenta: `backend/testes-seguros/producao/prod-migrar.mjs` (ensaio: `ensaio_prod_migrar.sh`, 14/14 no cluster local descartável).

## 1. O merge é o deploy
| Serviço | Gatilho | Efeito do merge na `main` |
|---|---|---|
| Render `crescercomdelivery` (`subway-saci-adm.onrender.com`, `rootDir` = `backend`) | `autoDeploy: yes`, a cada commit | publica o backend **e** o frontend que ele serve |
| Vercel `subway-saci-adm` | Production a cada commit | publica arquivos estáticos sem backend (sem `/api/config`, sem chaves) |
| Render `gateway-whatsapp` | auto-deploy **desligado** | nenhum |

**Como impedir publicação antes do banco pronto** (escolher uma):
1. **Recomendado:** aplicar as migrations **antes** do merge (§3). Não exige mudar nada no Render.
2. Desligar o auto-deploy do serviço no painel do Render (Settings → Build & Deploy → Auto-Deploy: Off), fazer o merge e disparar o deploy manual depois do banco pronto; religar em seguida. É mudança de configuração de produção: exige autorização própria.
3. Fazer o merge com `[skip render]` na mensagem do commit de merge (o Render ignora o auto-deploy desse commit) e disparar o deploy manual depois. O Vercel não é afetado por essa marca, mas o deploy dele é inofensivo (estático).

Se o deploy acontecer antes das migrations: os demais módulos continuam funcionando (o gate financeiro responde 403 sem consultar tabelas novas); só a tela "Acesso Financeiro" do SuperAdmin falha até as migrations existirem.

## 2. Checklist do operador (antes de escrever)
- [ ] **Backup/PITR:** painel do Supabase do projeto `uqybgauuxcrqzquultfu` → Database → Backups: backup recente presente ou PITR ativo; anotar o horário.
- [ ] **Janela:** horário de pouco uso combinado; ninguém aplicando outra migration ao mesmo tempo.
- [ ] **Identidade:** conexão do projeto `uqybgauuxcrqzquultfu` — direta (`db.uqybgauuxcrqzquultfu.supabase.co`, usuário `postgres`, porta 5432) ou pooler de **sessão** (usuário `postgres.uqybgauuxcrqzquultfu`, porta 5432). Nunca a porta 6543.
- [ ] **Privilégios:** papel `postgres` (dono das tabelas do `public` e de `remapear_organizacao_em_tabelas_de_unidade`). O preflight mostra `quem_aplica_administra = t`.
- [ ] **Arquivos:** repositório no commit do PR #49 (ou posterior sem mudança nas migrations); o script confere o sha256 de 120, 121, 122 e do catálogo.
- [ ] **Preflight lido e aprovado** (§3, passo 1).

**Condições de interrupção (parar, não fazer o merge):**
- qualquer `RECUSADO` do script;
- preflight com `objetos_financeiros > 0` ou `modulo_financeiro_existe = t` (estado inesperado: alguém já aplicou algo);
- `quem_aplica_administra = f`, `anon_executa_transferir = t` ou `anon_le_view_115 = t` (a 115 não está em vigor);
- `transacoes_longas > 0` ou `locks_esperando > 0` (esperar e repetir o preflight);
- qualquer `FALHA` na aplicação, catálogo diferente de 23/23, ou `RESULTADO: DIVERGÊNCIA`.

## 3. Ordem exata
1. **Preflight (somente leitura):**
   ```powershell
   $env:PROD_CONN = "<conexão de produção, definida pelo operador>"
   node backend/testes-seguros/producao/prod-migrar.mjs preflight
   ```
   Conferir a saída com o checklist; guardar a `PROD_IDENTIDADE` impressa. Evidência em `%TEMP%\evidencias-prod\` (sem a conexão).
2. **Aplicação:**
   ```powershell
   $env:PROD_IDENTIDADE = "<valor do preflight>"; $env:PROD_AUTORIZO = "SIM"; $env:PROD_BACKUP_CONFIRMADO = "SIM"
   node backend/testes-seguros/producao/prod-migrar.mjs aplicar
   Remove-Item Env:PROD_CONN, Env:PROD_AUTORIZO, Env:PROD_BACKUP_CONFIRMADO
   ```
   Esperado: `OK` nas três, `catálogo: 23 t / 0 f`, só `modulos` com +1 linha e `RESULTADO: OK`.
3. **Merge do PR #49** (dispara o deploy). Não definir `FINANCEIRO_CONCESSOES_HABILITADAS`.
4. **Validação pós-deploy:** deploy do Render concluído; `GET /health` 200; login → unidade → setor → dashboard operacional normal; iFood, Checklist e WhatsApp normais; `/api/v1/gestao-financeira/*` responde 403; setor Financeiro invisível para todos. `prod-migrar.mjs verificar` → 23/23.
5. **Piloto** (autorização separada): ver doc 24 e a descrição do PR.

## 4. Contingência
- Falha numa migration: a transação dela é desfeita; as anteriores ficam (todas idempotentes). Corrigir a causa e repetir o passo 2.
- Problema depois do deploy: voltar ao deploy anterior no Render; o esquema financeiro fica inerte.
- Desfazer o banco só **sem** dados financeiros: `122_rollback.sql` → `121_rollback.sql` → `120_rollback.sql`.
