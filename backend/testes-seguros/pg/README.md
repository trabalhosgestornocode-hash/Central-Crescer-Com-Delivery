# Provas em PostgreSQL local DESCARTÁVEL (migrations 120/121/122)

**Nunca** aponte estes scripts para um banco que não seja um cluster local criado só para isto. Eles recusam rodar sem o arquivo
`MARCADOR_DESCARTAVEL` no diretório de dados e sem `data_directory` igual ao informado.

```bash
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"
initdb -D ~/pg-descartavel -U postgres -A trust --no-locale -E UTF8 && echo descartavel > ~/pg-descartavel/MARCADOR_DESCARTAVEL
pg_ctl -D ~/pg-descartavel -o "-p 54321 -c listen_addresses=127.0.0.1" -l ~/pg.log start
export PG_CLUSTER_DIR=~/pg-descartavel
bash backend/testes-seguros/pg/sim_supabase.sh            # privilégios estilo Supabase (dono não-superusuário, default privileges, service_role BYPASSRLS)
APLICAR_122B=1 bash backend/testes-seguros/pg/sim_supabase.sh   # idem, com a proposta de endurecimento 122b
psql -h 127.0.0.1 -p 54321 -U postgres -d sim -f backend/testes-seguros/pg/sondagem122.sql   # após o sim: período fechado, transferências, reabertura, FK de importação
bash backend/testes-seguros/pg/ciclo_120_121_122.sh        # aplica, idempotência, rollback na ordem inversa, janela do rollback da 122
bash backend/testes-seguros/pg/transferencia_unidades.sh   # cadeia REAL da origin/main + 120–122: transferência/promoção de unidades × Financeiro (doc 20)
```
Porta 54321 fixa nos scripts. A suíte do Agente 2 (`backend/testes-financeiro-pg/run.sh`, inclui concorrência real com duas sessões) usa `FIN_PG_DESCARTAVEL=1 FIN_PG_PORT=54321`.
O que isto NÃO prova (=> T3 no Supabase descartável): atributos reais dos papéis do Supabase, PostgREST/pg_graphql, owner real das tabelas, extensões.
