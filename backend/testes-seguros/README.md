# testes-seguros — T1 (testes unitários isolados)

Reconstruído em 2026-10-17 a partir do zero (a versão histórica se perdeu e **não** foi reproduzida pela descrição).

## Uso (a partir de `backend/`)
```
npm run test:seguro                    # toda a suíte test/*.test.js sob a guarda
npm run test:seguro -- test/x.test.js  # arquivos escolhidos
npm run test:seguro:provas             # provas de isolamento da própria guarda (27)
```
**Nunca** use `npm test` com um `backend/.env` apontando para produção: ele passa `--env-file-if-exists=.env`.

## O que o T1 garante
| Garantia | Como |
|---|---|
| Sem credenciais reais | `ambiente.mjs` **constrói** o ambiente do zero (lista de permissão `HERDAVEIS` + valores `FICTICIO`). Nada do shell chega ao teste. |
| `.env` nunca carregado | O executor não passa `--env-file`; a guarda aborta (exit 97) se `--env-file` aparecer em `execArgv`/`NODE_OPTIONS`; `fs.readFile*/open*/createReadStream/promises.*` e `process.loadEnvFile` recusam qualquer `.env*` (exceto `*.example`). |
| Falha fechada no arranque | A guarda aborta (97) se `TESTE_SEGURO!=1` ou se algum valor de ambiente parecer credencial/host real (JWT, `supabase.co`, URLs de banco não locais, chaves não fictícias). |
| Sem rede externa | Só loopback (`127/8`, `::1`, `localhost`). Bloqueia TCP (`net`), TLS, `http`/`https`, `http2`, `fetch`, UDP (`dgram`) e DNS (`lookup` por nome, `resolve*`, `Resolver`, `dns.promises`). |
| Subprocessos controlados | Só `node`, sempre com `--import guarda` e **ambiente fictício reimposto** (o `env` passado pelo código de teste é ignorado). `exec`/`execSync`/shell/`curl`/`psql`/etc. são recusados. `fork` idem. |
| Worker threads controlados | `Worker` herda a guarda e o ambiente fictício. **Atenção:** workers `eval` **não** executam pré-carregamentos no Node 20 (verificado); a guarda faz bootstrap explícito (`import(guarda)` antes do código). |
| Violação engolida não passa | Cada violação é gravada em `TESTE_SEGURO_LOG` e define `exitCode=1`; o executor também lê o log e termina com 1 e a lista de vetores, mesmo que o teste tenha capturado o erro. |

## Arquivos
- `ambiente.mjs` — funções puras: ambiente fictício, argumentos do node, detecção de credencial/loopback.
- `guarda.mjs` — pré-carregamento (`node --import`). Sem dependências do projeto.
- `executar.mjs` — executor (cria o log de violações, monta env/args, propaga o resultado).
- `provas/guarda.test.js` — provas reproduzíveis de cada vetor (rodam em modo de prova: violações são registradas e recusadas, sem derrubar o processo).

## Compatibilidade
Testado em Node 20.19.4 (Windows). `engines` do projeto: `>=20.12.0`. Usa só APIs estáveis (`--import`, `node:test`, `syncBuiltinESMExports`). Em Node 24 as provas devem ser reexecutadas (pendência registrada: não havia Node 24 neste computador).

## Limites conhecidos (honestidade)
- É isolamento **em processo** (monkey-patch dos módulos nativos), não um sandbox de SO/firewall. Um teste que carregue um addon nativo ou use `process.binding` pode contornar. Para garantia de SO, combine com T2/T3 (cluster descartável) ou execute em contêiner sem rede.
- Testes que dependem de `psql`/`postgres` (T2) são **recusados** aqui por design (subprocesso externo) e devem ir para o T2.
- `node executar.mjs --env-file=…`: o próprio Node interpreta a flag; o executor **nunca repassa** esse arquivo ao ambiente dos testes.
