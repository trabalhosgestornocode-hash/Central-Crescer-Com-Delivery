# 32 — Abertura persistente, barreira contra duplicação e publicação com a escrita desligada

Branch de integração: `feat/financeiro-v2-integracao`, no worktree `C:\dev\fv2-integracao`, criada a partir de
`origin/main` (`892490d`). Ela junta:

- o visual (`feat/financeiro-v2-visual`, 4 commits próprios);
- a abertura operacional (`feat/financeiro-v2-abertura-operacional`, 5 commits desde `90ea03f`);
- as correções desta etapa.

Os dois merges foram feitos sem conflito. Nada foi publicado.

## 1. Abertura persistida por unidade (migração 0022, aditiva)

A tabela `fv2_abertura` guarda uma linha por unidade, com competência de início, data de corte (véspera do 1º dia),
situação (`CONFIGURADA` ou `CONCLUIDA`) e observação. Ela segue as mesmas regras das demais tabelas:

- versão, histórico obrigatório (gatilho adiado), sem exclusão;
- RLS forçada e as mesmas quatro políticas das tabelas de cadastro: escopo, leitura só com sessão operacional, inclusão
  e alteração só com `configurar`;
- `check` de coerência: o dia seguinte ao corte é o 1º dia da competência.

| Operação (rota) | Regras |
|---|---|
| `configurar` (`/abertura/configurar`) | Repetir a mesma competência não faz nada. A data de corte precisa ser um dia já encerrado. Recusa competência de início homologada e recusa abertura **incompatível**: qualquer lançamento de resultado com data até o corte, que seria contado de novo. Mudar a competência só é possível sem posições registradas, e com justificativa. |
| `concluir` (`/abertura/concluir`) | Depois da conferência. Concluída, nenhuma posição de abertura entra. |
| `reabrir` (`/abertura/reabrir`) | Ação sensível (`REABRIR`): na plataforma exige o código do autenticador nos últimos 10 minutos. |
| `/abertura/saldo`, `/abertura/obrigacao-anterior`, `/abertura/recebivel-anterior` | Não recebem competência: usam a abertura gravada. O saldo nasce marcado como posição de abertura (`aberturaId`). |
| consulta `/abertura` | Abertura, totais das posições e o necessário do roteiro (contas, plano). |

A operação direta do núcleo com a categoria patrimonial (ou com `anteriorAAbertura`) também exige a abertura configurada,
em andamento e na mesma competência. Não há atalho que contorne a regra.

**11/2026 continua sendo proposta**, não abertura executada: a tela traz o valor no campo, e nada é gravado sem
confirmação. Em produção, o Açaí tem 0 lançamentos, então 11/2026 é compatível.

## 2. Barreira contra duplicação por importações posteriores

- **Escopo:** efeitos econômicos importados (venda, venda agregada, pagamento Stone e obrigação de entregadores) cuja data
  é até o corte. Para entregadores, vale a data de **início** do período.
- **Tratamento:** vão para a conferência (`AGUARDANDO_REVISAO`, divergência `ANTERIOR_A_ABERTURA`).
- **Bloqueio:** aprovar e aplicar são recusados, inclusive para proposta aprovada antes de a abertura existir.
- **Fora da barreira:** a movimentação bancária do extrato continua entrando, porque é necessária para conciliar e nunca
  cria receita nem despesa.

Regra de correspondência, determinística:

1. Mesmo devedor ou credor (processador, ou entregador pelo nome) **e** identificador igual (pedido, Stone ID,
   autorização, ID do repasse, NF) → `COBERTO_POR_TITULO_ANTERIOR`.
2. Mesmo devedor ou credor **e** mesmo valor → `CORRESPONDENCIA_POSSIVEL`, que precisa de confirmação humana.
3. Nenhuma das duas → `SEM_CORRESPONDENCIA`.

Resolução:

- rejeitar a proposta com justificativa, porque o título de abertura segue valendo;
- ou, se o valor estava em aberto no corte e faltou, registrar o título anterior.

Os títulos anteriores aceitam `identificador` (normalizado sem espaços, em maiúsculas).

**Testado:**

- pedido iFood coberto pelo identificador, pedido sem título e pedido depois do corte (este aplicado normalmente);
- Stone com o mesmo valor (correspondência possível);
- recebimento posterior do título antigo pelo extrato;
- DRE de novembro só com a venda posterior ao corte, e outubro sem receita importada.

## 3. Publicação com a escrita desligada — operações exatas (cada uma exige autorização própria)

1. **Prévias de PR desligadas:** conferir no Render (`get_service`) que `crescercomdelivery` continua com as prévias de
   PR desligadas.
2. **Push:** `git push -u origin feat/financeiro-v2-integracao`.
3. **PR para `main`:** abrir sem merge.
4. **Migração em produção** (antes do deploy, porque a consulta `/abertura` lê `fv2_abertura`):
   - aplicar `database/financeiro-v2/producao/atualizar.sql` (sha256 `e733276d6340e01f6bda011b022ffe766cd1a80965027b82ea2b80efeea46bd3`)
     como `postgres`, numa transação;
   - o arquivo confere sozinho que as 21 migrações instaladas são idênticas às do Git: o resumo de produção, lido em
     15/11, bate (`4463a5db…`, 21/21);
   - foi validado no Supabase simulado (E5): aplica, mantém o sistema atual idêntico, reaplicar aborta e a tabela nova
     fica com RLS forçada.
   - Rodar `inventario.sql` antes e depois.
5. **Merge na `main`:** gera o deploy automático. Conferir que ficou `live` e com `/health` 200.
6. **Variáveis no Render:** **sem mudança**.
   - `FV2_ESCRITA_HABILITADA=0`, `FV2_HOMOLOGACAO_HABILITADA=0`, `FV2_PROVISIONAMENTO_HABILITADO=0`;
   - liberação só do Açaí (não muda);
   - cofre continua desligado.
7. **Validação:**
   - João abre o Financeiro: o visual novo aparece e as consultas respondem 200;
   - Configurações → Abertura financeira mostra "não configurada" e os formulários ficam ocultos, porque a escrita está
     desligada;
   - outra unidade continua no financeiro antigo.

**Reversão:**

- código: reverter o merge e fazer o deploy;
- banco: a 0022 é aditiva e, sem uso, não afeta nada. Não se apaga a tabela.

## 4. Para ligar a escrita depois (cada passo com autorização)

1. Fazer a rotação das credenciais (doc 31). O script foi revisado nesta etapa:
   - revoga conferindo **cada** papel novo;
   - retoma com `--retomar` se o Render aceitar só uma variável;
   - pede a chave sem eco no PowerShell 5.1.
2. Confirmar a competência de início e o validador (quem confere).
3. Ligar `FV2_ESCRITA_HABILITADA=1`.
4. Configurar a abertura e registrar as posições.
5. Fazer a conferência e concluir a abertura.
