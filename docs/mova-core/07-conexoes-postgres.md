# MOVA CORE — Conexões PostgreSQL (diagnóstico, proposta, simulação, margem, riscos e reversão)

Escopo: **somente análise**. Nenhuma configuração real de banco ou do Render foi alterada nesta execução. Números
levantados do código da branch `feat/mova-core-integrada` (24/11/2026). O total real de conexões em produção **não foi
medido** nesta execução (as consultas de conferência estão na seção 6, todas somente leitura).

## 1. Diagnóstico: quem abre conexão

| Processo | Pool | Máximo | Quando existe |
|---|---|---|---|
| backend | Financeiro v2 — aplicação | ≤ 4 (`FV2_APP_POOL_MAX`, padrão 4, com teto no código) | `FV2_HABILITADO=1` |
| backend | Financeiro v2 — autoridade | 2 | só modo `local` |
| backend | MOVA — principal (fila, auditoria, orçamento, conversa) | 4 (fixo no código) | MOVA ligado |
| backend | MOVA — leitor | 2 (`statement_timeout` 15 s) | modo PILOTO/OPERAÇÃO |
| backend | MOVA — relé | 2 | só homologação (`MOVA_RELE_DATABASE_URL`) |
| backend | MOVA — vínculo de WhatsApp | 1 (máx. 2, `MOVA_VINCULO_POOL_MAX`) | preguiçoso (1ª chamada) |
| gateway FV2 | autoridade | 2 (`FV2_AUTORIDADE_POOL_MAX`) | serviço próprio |

Todos com `idleTimeoutMillis` (10–30 s): conexão ociosa volta ao servidor sozinha.

**MOVA CORE (0019–0021: identidade, memória, propostas, conhecimento)** não abre pool próprio: os repositórios recebem
um `pool` por injeção. **Proposta:** reutilizar o pool principal do MOVA (4) — nenhum pool novo.

## 2. Configuração proposta (sem aplicar)

| Item | Hoje | Proposta | Por quê |
|---|---|---|---|
| Pool MOVA principal | 4 fixo | `MOVA_POOL_MAX` (padrão 4, teto 6) | tornar ajustável sem deploy de código |
| MOVA CORE | — | usa o pool principal | zero conexão nova |
| `statement_timeout` no pool principal | ausente | 15 s (igual ao leitor) | consulta presa não segura conexão |
| `connectionTimeoutMillis` | ausente | 5 s | falha rápida em vez de fila infinita na saturação |
| Conexão pelo pooler (Supavisor, transação) | conferir | preferir para o pool da aplicação | multiplexa conexões físicas |

## 3. Simulação de instâncias sobrepostas (deploy no Render)

No deploy, a instância nova sobe antes de a antiga terminar (o SIGTERM é tratado e o lease liberado — comprovado em
produção em 10/10 e 20/10). Durante a janela, as duas mantêm pools.

| Cenário | Backend (1 inst.) | Durante o deploy (2 inst.) | + gateway | Total no pior caso |
|---|---|---|---|---|
| A — hoje, MOVA em OPERAÇÃO (4 + 4 + 2 + 1) | 11 | 22 | 2 | **24** |
| B — A + MOVA CORE no pool principal | 11 | 22 | 2 | **24** (sem mudança) |
| C — B com `MOVA_POOL_MAX=6` | 13 | 26 | 2 | **28** |
| D — homologação completa (A + relé 2 + autoridade 2) | 15 | 30 | 2 | **32** |
| Errado — MOVA CORE com pool próprio de 4 | 15 | 30 | 2 | 32 (evitar) |

Pico real é menor: os pools só crescem sob carga simultânea; ociosos encolhem em 10–30 s.

## 4. Margem de segurança

Regra proposta: **pico do pior caso ≤ 60 % de (`max_connections` − `superuser_reserved_connections` − conexões de
plataforma)**. Exemplo: com 60 conexões disponíveis para aplicações, 60 % = 36 ⇒ o cenário B (24) cabe com folga; o D
(32) cabe, mas sem margem para um terceiro processo. **A conferência do número real é pré-condição da publicação** (seção 6).

## 5. Riscos e mitigação

| Risco | Efeito | Mitigação |
|---|---|---|
| Saturação no deploy | `too many clients` na instância nova | margem da seção 4; `connectionTimeoutMillis`; pooler |
| Consulta lenta presa | conexão retida, fila cresce | `statement_timeout` 15 s |
| Pool novo escondido em módulo novo | soma silenciosa | regra: repositório recebe pool injetado; revisão procura `new pg.Pool` |
| Instância antiga sem fechar | conexões órfãs até o timeout | SIGTERM tratado (`pool.end()`), já comprovado |
| Ataque de volume no WhatsApp | uso concorrente do pool | fila do MOVA serializa; teto diário de orçamento |

## 6. Conferência (somente leitura, antes de publicar)

```sql
show max_connections;
show superuser_reserved_connections;
select usename, application_name, state, count(*) from pg_stat_activity group by 1, 2, 3 order by 4 desc;
```

Executar durante e fora de um deploy; registrar os números no checklist de publicação.

## 7. Reversão

Nada novo a reverter enquanto MOVA CORE usa o pool principal. Se `MOVA_POOL_MAX` for criado e causar problema: remover
a variável (volta ao padrão 4) e reiniciar. Se `statement_timeout` derrubar uma consulta legítima: subir para 30 s no
pool afetado. Nenhuma das ações toca dados.
