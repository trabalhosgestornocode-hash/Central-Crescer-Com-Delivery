# QA visual local (sem Supabase, sem rede)

Serve o frontend REAL com um backend FALSO (dados fictícios, só loopback) e dirige um Chrome instalado.

```
cd backend
node testes-seguros/qa-visual/servidor-qa.mjs 4173            # terminal 1
# terminal 2 (playwright-core fora do repositório; use a pasta que preferir):
npm i playwright-core --prefix ~/qa-tmp --ignore-scripts
QA_MODULOS=~/qa-tmp node testes-seguros/qa-visual/qa-navegacao.mjs
QA_MODULOS=~/qa-tmp node testes-seguros/qa-visual/qa-admin.mjs
```
`QA_CHROME` aponta para o executável (padrão: Chrome do Windows). Capturas em `qa-visual/shots/` (ignoradas pelo git).
Cenários do servidor: `/qa/cenario?nome=operacional|financeiro|ambos|nenhum|troca|impersonacao|exibicao|superadmin`, `/qa/revogar`, `/qa/escrita?on=1`.

**Limites:** valida navegação, estados e layout. Não valida segurança (isso é dos testes) nem o conteúdo real do Dashboard Operacional (a API falsa devolve listas vazias).
