# Financeiro v2 — núcleo (fundação)

Módulo novo e **isolado**. Não é o `gestao-financeira` (o "Financeiro 2.0" antigo) e não compartilha código, tabelas,
permissões nem cálculos com ele.

- Não está montado em nenhuma rota. Não lê ambiente, banco ou rede.
- Não importa nada de fora desta pasta (exceto `node:crypto`).
- Dinheiro é sempre inteiro de centavos. Nada de `parseFloat`, `toFixed` ou divisão por 100.
- Não existe exclusão: corrigir, cancelar e estornar deixam histórico.

Camadas: `dominio/` (regras puras) ← `contratos/` (entradas e porta de persistência) ← `aplicacao/` (operações
atômicas) ← `infra/` (adaptadores; hoje só memória).

Testes: `node --test test/financeiro-v2/` a partir de `backend/`.

Documentação: `docs/financeiro-v2/`.

## Execução 01B — persistência

- Adaptador PostgreSQL em `infra/postgres/` (migração em `database/financeiro-v2/migracoes/`), com guarda de destino obrigatória (`infra/postgres/destinoSeguro.js`).
- Banco de teste local isolado: `node scripts/fv2-banco-teste.mjs iniciar` (em `backend/`). Nunca usa o `.env` nem banco remoto.
- Testes: `node --test test/financeiro-v2/` (memória + testes de banco; os de banco são pulados com aviso se o ambiente não existir) e `FV2_REPOSITORIO=postgres node --test --test-concurrency=2 test/financeiro-v2/` (suíte inteira no PostgreSQL).
- Detalhes: `docs/financeiro-v2/04-persistencia-e-seguranca.md`.

## Execução 02 — importações, cofre local e preparação da conciliação (12/11/2026)

- `importacao/`: leitor tabular estrito, motor genérico de prévia e 9 adaptadores (SAIPOS ×4, Stone ×2, iFood, Foody,
  Unicred). Todos com compatibilidade **SINTETICA** — nenhum conferido com amostra real ainda.
- `aplicacao/importacoes.js`: receber → prévia → confirmação autorizada (`financeiro_v2.importar` + impressão da prévia)
  → gravação atômica de `REGISTRO_FONTE` → relatório. Importar não cria venda, receita, despesa nem saldo.
- `aplicacao/sessao.js`: adaptador da sessão do app (`{ user, tenant, acesso }`) para o contexto; só concessões explícitas.
- `infra/cofreDisco.js`: cofre local privado (fora do Git e de pastas sincronizadas), sem sobrescrita, com auditoria de
  acessos negados sem conteúdo.
- Conciliação: candidatas automáticas com regra/força/evidência; confirmação ambígua recusada; `AGUARDANDO_DOCUMENTO`.
- Migração `0002_importacoes.sql` (só no PostgreSQL local isolado).
- Detalhes, contratos, idempotência, limitações: `docs/financeiro-v2/05-importacoes-e-fontes.md`.
