# 07 — Publicação do Financeiro 2.0: migrations 153 → 154 → 155, PR e flag

Estado de partida em produção: 120, 121, 122, 126, 151 **e 152 aplicadas**; flag `FINANCEIRO_2_ORGANIZACOES` **vazia**. Nada deste documento foi executado em produção.

## Garantias já verificadas (local)
- **Rotas:** com a flag desligada, TODA rota do Financeiro 2.0 (incluindo a conciliação 1:N) responde 404; nenhuma rota sem trava usa objetos das migrations 153–155 (`backend/test/financeiro/flagRotas2.test.js`). O backend novo é inerte para todos.
- **Migrations:** só DDL aditivo, idempotente, com rollback que recusa se houver dados; 154 só relaxa `conta_id` e acrescenta colunas/constraints que as linhas existentes já satisfazem. Ensaio completo (`ensaio_prod_migrar_fin2.sh`, 29 verificações): ordem obrigatória, backup/exportação/sha256, conteúdo existente idêntico antes × depois, reversão em ordem inversa, recusa com dados.
- **Compatibilidade nos dois sentidos:** backend antigo com o schema novo e backend novo com o schema antigo funcionam (rotas novas fechadas pela flag).

## Ordem segura (cada passo só com autorização própria)
**Fase A — antes da janela (sem produção):** revisar o PR; conferir `git status` limpo e os sha256 do script; confirmar no Render: `FINANCEIRO_2_ORGANIZACOES` vazia, **PR previews desligados**, e decidir se o auto-deploy da `main` será pausado até o fim da Fase B.

**Fase B — migrations (ANTES do merge, para o backend não subir antes delas):**
1. Backup/PITR atualizado (painel Supabase → Database → Backups); anote tipo e horário UTC.
2. Conexão só no terminal (`$env:PROD_CONN`, formato estrito; nada no chat).
3. **Conferência de partida (somente leitura):** `node backend/testes-seguros/producao/prod-migrar-fin2.mjs conferir` → guarde o caminho da evidência.
4. Para cada migration, nesta ordem **153, 154, 155** (`prod-migrar-fin2.mjs <passo> <n>`):
   - `preflight <n>` → `PREFLIGHT <n>: OK` + `PROD_IDENTIDADE` (recusa: ordem errada, objetos já existentes, lista de tabelas ou guarda diferentes, transação longa);
   - `exportar <n>` → `PROD_EXPORTACAO`;
   - `aplicar <n>` (com `PROD_BACKUP_*` e `PROD_AUTORIZO=SIM`) → `RESULTADO <n>: OK` (nenhuma tabela existente mudou; novas vazias);
   - `verificar <n>` → `VERIFICAÇÃO <n>: OK`.
5. **Conferência final (somente leitura):** `PROD_COMPARAR_COM=<evidência do passo 3> node …/prod-migrar-fin2.mjs conferir` → esperado `CONTEÚDO alterado: nenhuma`; tabelas novas: as 4 das migrations 153 e 155.

**Fase C — código:** merge do PR (o `crescercomdelivery` faz auto-deploy da `main` em ~30 s; o frontend é servido pelo próprio backend). Conferir `/health` e a versão do frontend. Flag continua vazia: nada muda para os usuários.

**Fase D — conferência de produção após o deploy (sem alterar dados):** repetir `conferir` com `PROD_COMPARAR_COM`; abrir o painel logado e confirmar que as telas antigas funcionam e que as rotas novas respondem 404 enquanto a flag estiver vazia. Nenhuma importação, nenhum lançamento.

**Fase E — NÃO faz parte desta publicação:** ligar a flag (decisão própria, organização por organização, só depois da importação autorizada e da decisão da contadora sobre rateios, juros e demais pendências).

## Reversão
- Sintoma antes do merge: parar; as migrations são aditivas. Reverter só com `PROD_AUTORIZO_REVERSAO=SIM … reverter <n>` **na ordem 155 → 154 → 153** (recusa se houver dados nas tabelas novas ou se a ordem for invertida).
- Sintoma depois do merge: o código é inerte com a flag vazia; reverter o deploy no Render para o commit anterior, sem tocar no banco.
- Dados alterados só se recuperam pelo backup/PITR.

## Pontos que exigem aprovação humana
1. Push da branch e abertura do PR (hoje nada foi publicado).
2. Janela e aplicação de cada migration (153, 154, 155), uma autorização por migration, com backup informado.
3. Merge do PR / deploy do backend (e eventual pausa do auto-deploy).
4. Importação de dados reais (autorização separada, modo `--producao` do importador).
5. Ligar a flag por organização.
6. Decisões da contadora (rateios, juros, ajuste iFood, origem do pagamento, contagem do caixa, classificação do Pix de 14/09).
