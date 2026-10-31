# 14 — Pré-voo de produção, procedimento de implantação e plano de recuperação

Data: 30/10/2026. PR #55 (`feat/configuracoes-2-central-notificacoes`). Tudo abaixo foi verificado **somente com leitura** em produção.
Nada foi aplicado, publicado ou alterado em produção.

## 1. Pré-voo de produção (somente leitura, só agregados)

| Verificação | Resultado |
|---|---|
| Projeto | `uqybgauuxcrqzquultfu` (produção), PostgreSQL 17.6 — mesma versão dos testes locais |
| Migrations registradas | até a **131** (`131_checklist_metas_transferencia_unidade`); a main também termina na 131 → 132–135 livres |
| Funções do D-1 e da transferência (`agendar`, `resolver_destinatarios`, `reservar_envio`, `claim_mensagens`, `remapear_organizacao…`) | **hash idêntico** ao da cadeia da main reconstruída no PostgreSQL descartável (5/5) |
| Objetos que 132–135 criam | nenhum existe (0 tabelas, 0 colunas, 0 funções) — aplicação limpa |
| Categorias | só `pendencia_d1` |
| Flag `selecao_por_escopo` | ausente (seleção por unidade desligada) |
| Destinatários do D-1 | 41 (41 com `pendencia_d1` habilitada) |
| Fila ativa no momento | 4 mensagens (operação normal) |
| Unidades | 53 |

**Compatibilidade código antigo × tabelas novas:** o código atual de produção não conhece as tabelas novas; as colunas novas de
`unidades` são nulas; o gatilho de `unidades` só valida as colunas novas; a única função existente substituída (`agendar`) muda uma
linha e, com a flag ausente, chama exatamente o resolvedor antigo (prova no PostgreSQL: mensagens idênticas, reagendamento
idempotente, fila com colunas/restrições/gatilhos idênticos). O gatilho novo em `comunicacao_destinatario_categorias` só barra
reativação de categoria **revogada pelo titular** — não há nenhuma revogação registrada hoje.

**Compatibilidade código novo × banco sem as migrations:** o app sobe; fuso cai no padrão (`obterFusoDaUnidade` → nulo), a tela da
unidade esconde a seção de fuso (`fusoDisponivel=false`), o aviso de fechamento simulado é `try/catch` e a Central responde erro/indisponível.
Ainda assim, **aplicar as migrations antes do merge** é a ordem recomendada.

**O segredo mestre não é necessário para iniciar** (app real iniciado sem `NOTIFICACOES_SEGREDO_MESTRE`: `/health` 200, páginas
públicas 200, rotas do titular 503 "indisponível"). Sem ele a Central fica em consulta.

**Cadastro de usuários (D-14) — impacto operacional:** depois do deploy, o admin da EMPRESA não cria mais conta com senha.
Conta existente → acesso na hora (como antes). Conta nova → sem o segredo: 503 "convites não habilitados"; com o segredo e sem SMTP:
convite registrado, e-mail **não** enviado (a tela avisa). Enquanto o SMTP não estiver configurado, contas novas continuam podendo
ser criadas pelo **Painel SuperAdmin** (`/api/v1/plataforma/usuarios`, inalterado).

**Deploy automático:** pelo último registro conhecido (07/10, não reconfirmado: o conector do Render desta sessão não acessa o
workspace do serviço), o serviço Render do backend (que também serve o frontend) faz auto-deploy a cada commit na `main` com mudança
em `backend/` — este PR tem mudanças em `backend/`, então **o merge do PR dispara o deploy**. Não há preview do Render no PR #55 (nenhum deployment/check do Render
no GitHub; confirmar no painel do Render, que esta sessão não acessa). O Vercel gera preview do PR, **protegido por login do
Vercel** (toda rota responde 302 para `vercel.com/sso-api`).

## 2. Procedimento de implantação (cada passo exige autorização própria)

1. **Janela:** fora do horário de agendamento do D-1. Conferir fila ativa e `selecao_por_escopo` ausente.
2. **Migrations em produção, em ordem, uma por vez:** 132 → 133 → 134 → 135. Depois de cada uma, rodar as consultas de verificação
   do fim do arquivo. Depois da 133: hash de `comunicacao_agendar_mensagens_alerta` deve ser `7b7c0a59654ab29890187c5727c91419`
   (o da branch no PostgreSQL 17) e os demais 4 hashes **inalterados**.
3. **Conferências pós-migration (leitura):** anon/authenticated sem privilégio nas 7 tabelas e sem EXECUTE nas funções novas;
   RLS ligada nas 7 tabelas; `resolver_destinatarios_unidade(org, unidade, 'dashboard_ifood_d1')` = `resolver_destinatarios(org, …)`
   para todas as unidades ativas.
4. **Merge do PR #55** (dispara o deploy do backend + frontend). Confirmar `/health` e a versão do `styles.css`/`configuracoes.css`.
5. **Variáveis** (opcional nesta fase): `NOTIFICACOES_SEGREDO_MESTRE` (≥ 32 caracteres aleatórios, guardado fora do repositório).
   **Nunca** definir `NOTIFICACOES_OTP_TRANSPORTE`, `NOTIFICACOES_AMBIENTE_ISOLADO` ou `NOTIFICACOES_M3_ATIVACAO_HABILITADA` em produção.
6. **Observação pós-deploy (24 h):** D-1 do dia seguinte com a mesma quantidade de mensagens/destinatários; nenhum erro novo no log.
7. **Fora desta implantação:** SMTP (DEP-2), corte de fuso (DEP-3), provedor oficial/termos (DEP-4/5), M3.

## 3. Plano de recuperação

| Situação | Ação | Efeito |
|---|---|---|
| Problema no código após o deploy | "Rollback" do deploy anterior no Render (ou `git revert -m 1 <merge>` na main, que redeploya) | Volta ao código anterior; as migrations podem ficar (o código antigo é compatível com elas — §1) |
| Problema nas migrations | Rodar `135_rollback.sql` → `134` → `133` → `132`, nesta ordem | Provado no PostgreSQL descartável: agendamento do D-1 idêntico ao da main, nenhuma tabela nova sobra, reaplicação idempotente. A 133_rollback restaura o corpo EXATO da 104 |
| Antes do rollback de migrations | Exportar `usuarios_convites`, `comunicacao_convites`, `comunicacao_consentimentos`, `comunicacao_destinatario_escopos` se houver linhas | O rollback **apaga** essas tabelas. Com o transporte desligado, em produção não haverá consentimento nem escopo novo |
| Segredo mestre | Guardar cópia segura; removê-lo só desliga a escrita da Central | Sem ele, convites cifrados existentes ficam ilegíveis (não afeta o D-1) |
| M3 | Não será ativada nesta implantação. Se um dia for: `comunicacao_desativar_selecao_por_escopo` | Volta ao resolvedor anterior |

**Ordem segura de recuperação total:** 1) reverter o código; 2) conferir o D-1; 3) só então, se necessário, os rollbacks 135→132.

## 4. Supabase de teste (`teste-multiempresarial`, `wiqqsxnysbzhcrzrrean`)

**Estado:** isolado da produção (projeto diferente). WhatsApp com 2 conexões DISCONNECTED; fila pendente 0.
Faltam objetos de 105, 109, 110, 116, 117, 118, 124, 127 e 131 (101–104 existem, embora não registrados em `schema_migrations`).
As 4 funções que 132–135 tocam ou de que dependem têm hash **idêntico** ao da main; `claim_mensagens` difere (não é tocada).
132–135 não referenciam nenhum objeto faltante.

**Por que não atualizar a cadeia inteira:** 116–118 e 124 pertencem à homologação do iFood, que usa este projeto e tem migrations
deliberadamente pendentes ali — aplicá-las mudaria o estado de outra frente.

**Tentativa e bloqueio:** a aplicação da 132 pelo conector exige **confirmação interativa por chamada** (2 minutos); a confirmação expirou
e **nada foi aplicado** (verificado: mesma impressão digital de colunas, 17 migrations registradas). O ciclo completo (aplicar 4,
reverter 4 para provar a recuperação, reaplicar 4) exige ~12 confirmações acompanhadas. **Bloqueio registrado; nada foi improvisado.**

**Procedimento pronto (para executar acompanhado):**
1. Impressão digital ANTES (já capturada em 30/10): colunas `d486de29fe78f7a4dedca432cd703aff`, funções `4a9dc2dadd47522cbd2b47cb44ee1c2e`,
   gatilhos `37cb1fd1295a29cd18b920c352b8d250`, políticas `c6eacacc84ca00f3f5a660ce5c682e95`, ACL/RLS `59d2e13e405bf96101f82a2bddbf0695`,
   config `f5ee7cc776dc4bb6d57d43e6dd4786b5`, dados (categorias, destinatário×categoria, unidades, contatos) e 17 migrations.
2. Aplicar 132 → 135 (`apply_migration`, sem as linhas `begin;`/`commit;`).
3. Validar: hashes (§2.2), privilégios, RLS, PostgREST com a chave **publicável** (anon) — `GET /rest/v1/<tabela nova>` e
   `POST /rest/v1/rpc/<função nova>` devem ser recusados —, e equivalência do D-1 com dados sintéticos dentro de um bloco que termina
   em `raise exception` (tudo desfeito).
4. Recuperação: 135_rollback → 132_rollback; remover as 4 linhas de `schema_migrations` criadas no passo 2; comparar a impressão digital com a do passo 1.
5. Reaplicar 132 → 135 e repetir a validação. Estado final: 132–135 aplicadas no teste.
