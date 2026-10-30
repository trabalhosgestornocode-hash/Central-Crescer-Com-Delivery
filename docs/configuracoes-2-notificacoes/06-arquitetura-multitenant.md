# 06 — Arquitetura multi-tenant

## 1. Entidades: o que reaproveita e o que é novo

| Entidade | Tabela | Situação |
|---|---|---|
| Telefone (posse) | `contatos_whatsapp` (082) | **Reaproveita, sem reescrever o legado.** A posse por OTP fica no desafio consumido (`comunicacao_desafios_titular`), **não** nos campos globais. `verificado`/`consentimento`/`opt_out` continuam alimentando o D-1 dos legados exatamente como hoje; `opt_out` continua bloqueando para todos |
| Destinatário da empresa | `comunicacao_contatos_empresa` (100/104) | **Reaproveita**: nome, papel (`tipo`), ativo, FK composta `(id, organizacao_id)`. `whatsapp_status` passa a ser derivado do estado da Central |
| Catálogo de categorias | `comunicacao_categorias` (104) | **Estende**: `grupo`, `exige_consentimento`, `estado` (`ATIVA`/`EM_BREVE`/`INTERNA`), `fonte`, `prioridade` |
| Categorias por destinatário | `comunicacao_destinatario_categorias` (104) | **Mantida** (compatibilidade do D-1). Backfill para escopos com `unidade_id = null`. Na Etapa 4 a resolução lê os escopos |
| **Escopo destinatário × unidade × categoria** | `comunicacao_destinatario_escopos` | **NOVA**. `(contato_empresa_id, organizacao_id) → FK composta`, `unidade_id` (nulo = todas), `categoria`, `habilitado`, **`origem_autorizacao` (`LEGACY_ACTIVE` \| `CONVITE_OTP`)**, `suspenso_em/por/motivo`, `janela`/`silencio` (jsonb validado), `notificar_correcao`. `CHECK`: `LEGACY_ACTIVE` só com `categoria = 'pendencia_d1'`. Único `NULLS NOT DISTINCT (contato_empresa_id, unidade_id, categoria)` |
| **Convite** | `comunicacao_convites` | **NOVA**: `token_hash`, empresa, unidades e categorias pretendidas, `criado_por`, `expira_em`, `status` |
| **Desafio OTP / sessão do titular** | `comunicacao_desafios_titular` | **NOVA**: `tipo` (`verificacao`/`gestao`), `telefone_e164` (ou hash, decisão D-4), `codigo_hmac`, `tentativas`, `expira_em`, `consumido_em`, `invalidado_em`, `ultimo_envio_em`, `ip_hash` |
| **Consentimento** | `comunicacao_consentimentos` | **NOVA**, append-only (doc 05 §4.1) |
| **Termos** | `comunicacao_termos` | **NOVA**, versões imutáveis |
| Fuso/horário da unidade | `unidades.timezone`, `unidades.horario_funcionamento` (jsonb) | **Colunas novas** (sem tabela nova) |
| Mensagens, tentativas, alertas | `comunicacao_mensagens`/`_tentativas`/`_alertas` | **Reaproveita.** Fechamento = `alerta_id null`, `tipo = fechamento_operacional_diario`, `metadados.fonte = {fechamento_id, versao}`, chave única existente (`idempotency_key`) |
| Simulações do fechamento | `operacional_mensagens_simuladas` (130) | **Reaproveita** como histórico de simulação. O envio real vai para `comunicacao_mensagens` |

Total: **5 tabelas novas** e colunas em 2 existentes. As alternativas descartadas (tabela de preferências separada do escopo, tabela de histórico de vínculo) foram absorvidas pelo escopo (com `updated_at` e auditoria) e pelo livro-razão.

## 2. Segurança no banco (padrão 129/130/131)

- **RLS** ligado em todas as tabelas novas, **sem policy**. `anon`/`authenticated` sem nenhum privilégio. Acesso só pelo backend (`service_role`), como toda a comunicação hoje (082: `revoke all … from authenticated, anon`).
- **`service_role`** só com o necessário:
  - livro-razão e termos: `SELECT, INSERT` (sem UPDATE/DELETE), com trigger de imutabilidade (padrão `operacional_registro_imutavel`);
  - desafios: `SELECT, INSERT` + UPDATE **por coluna** (`tentativas`, `consumido_em`, `invalidado_em`, `ultimo_envio_em`);
  - escopos/convites: CRUD **sem TRUNCATE**.
- Toda RPC com `SECURITY INVOKER` + `search_path` fixo + EXECUTE só para `service_role`. A exceção é o **consumo do desafio**, que pode ser `SECURITY DEFINER` com validação interna (como `operacional_fechamento_registrar`) para garantir atomicidade.
- **Coerência de tenant** por trigger: a unidade do escopo pertence à empresa do destinatário (padrão `operacional_validar_tenant`). A FK composta impede um escopo de destinatário de outra empresa.

## 3. Acesso por perfil

| Permissão (nova) | Papéis (proposta, decisão D-3) |
|---|---|
| `notificacoes.ver` | organization_admin, unit_manager, finance |
| `notificacoes.gerenciar` | organization_admin; **unit_manager só nas unidades do seu vínculo** (se aprovado) |
| Painel ADM (`requirePainelAdministrativo`) | equipe Crescer: visão cross-tenant e apoio à adesão voluntária dos legados |

- **Escopo de unidade no backend:** toda rota resolve `req.tenant`. Se o vínculo do usuário é de **unidade**, ele só vê e altera escopos daquela unidade e destinatários que tenham escopo nela. Destinatários "todas as unidades" aparecem só leitura para ele.
- **Múltiplos perfis do mesmo usuário:** a permissão vem do vínculo da sessão (`sessoes_contexto.permissoes`), como hoje. Trocar de empresa troca o escopo, e `carregarProtegido` evita mistura na tela.
- **Titular sem conta:** as rotas públicas `/notificacoes/convite/*` e `/notificacoes/gerenciar/*` ficam **fora** do `requireAuth`. Elas são protegidas por token de convite (hash) ou desafio consumido, com rate limit próprio e resposta anti-enumeração. Não recebem nem devolvem dados da unidade além de nome da empresa, unidades e categorias.

## 4. Transferência e promoção de unidade

- **Ponto crítico:** `remapear_organizacao_em_tabelas_de_unidade` (054, versão atual em produção) atualiza `organizacao_id` de **toda** tabela com `organizacao_id + unidade_id`, exceto as listadas em `gestao_financeira_tabelas_da_unidade()` e em três nomes fixos.
- `comunicacao_destinatario_escopos` teria `organizacao_id + unidade_id`. Por isso:
  1. O remapeamento tentaria mover o escopo para a nova empresa, e a **FK composta** com `comunicacao_contatos_empresa (id, organizacao_id)` falharia, quebrando a transferência inteira (o mesmo tipo de defeito que a 131 corrigiu).
  2. Mesmo sem a FK, mover o escopo **transportaria a autorização** dada por uma empresa para outra, o que é proibido pela missão.
- **Desenho:**
  - Excluir as tabelas novas do remapeamento: estender a lista de exclusão com uma função própria, `comunicacao_tabelas_fora_do_remapeamento()`, chamada pela 054 da mesma forma que a do Financeiro (exige recriar a 054; **decisão D-11**, com coordenação com a frente do Financeiro, dona da versão atual).
  - Na transferência, um gatilho em `unidades` (troca de `organizacao_id`) **suspende** os escopos da unidade (`suspenso_motivo = 'TRANSFERENCIA_DE_EMPRESA'`) e cancela mensagens agendadas dela.
  - A nova empresa precisa convidar de novo. Consentimentos são **por empresa** e não migram.
  - Histórico (`comunicacao_mensagens`/`alertas`) continua sendo remapeado como hoje, sem mudança de comportamento.
- **Promoção de unidade a empresa:** mesmo tratamento. Ela ainda falha por outro defeito preexistente (42P10), que é da frente do Financeiro.
- **Revogação de vínculo / desativação de usuário:** não afeta destinatários (doc 05 §6). Desativar a **unidade** (`unidades.ativo = false`) suspende os escopos dela.

## 5. Testes de isolamento exigidos (Etapa 5)

1. Usuário de unidade A1 não lista, não altera e não convida em A2. Usuário da empresa B não vê nada de A (404).
2. Escopo com unidade de outra empresa é recusado pelo banco (FK composta + trigger).
3. `anon`/`authenticated` sem privilégio em todas as tabelas novas (PostgREST real, como no doc 04 do Dashboard 2.0).
4. A transferência de unidade com escopos funciona (sem FK quebrada), suspende os escopos e não move consentimentos. Provar no harness `testes-seguros/pg` com a cadeia real da `main`.
5. As rotas públicas do titular: anti-enumeração (mesma resposta e tempo), limites, replay, concorrência no consumo do OTP (duas sessões reais no Postgres).
