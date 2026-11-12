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
