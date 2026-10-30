# 06 — Arquitetura multi-tenant

## 1. Entidades: o que reaproveita e o que é novo

| Entidade | Tabela | Situação |
|---|---|---|
| Telefone (posse) | `contatos_whatsapp` (082) | **Reaproveita, sem reescrever o legado.** A posse por OTP fica no desafio consumido (`comunicacao_desafios_titular`), **não** nos campos globais. `verificado`/`consentimento`/`opt_out` continuam alimentando o D-1 dos legados exatamente como hoje; `opt_out` continua bloqueando para todos |
| Destinatário da empresa | `comunicacao_contatos_empresa` (100/104) | **Reaproveita**: nome, papel (`tipo`), ativo, FK composta `(id, organizacao_id)`. `whatsapp_status` passa a ser derivado do estado da Central |
| Catálogo de categorias | `comunicacao_categorias` (104) | **Estende**: `grupo`, `exige_consentimento`, `estado` (`ATIVA`/`EM_BREVE`/`INTERNA`), `fonte`, `prioridade` |
| Categorias por destinatário | `comunicacao_destinatario_categorias` (104) | **Mantida** e **intocada**: continua sendo a fonte do D-1 enquanto a nova seleção não for ativada (D-16, regra 12) |
| **Escopo destinatário × unidade × categoria** | `comunicacao_destinatario_escopos` | **NOVA** (estado **atual**, mutável). Campos:<br>• `(contato_empresa_id, organizacao_id)` com FK composta e `unidade_id` **obrigatório**: sem "todas as unidades" (D-16);<br>• `categoria`, `habilitado`;<br>• **`origem_autorizacao`** (`LEGACY_ACTIVE` \| `CONVITE_OTP`) e **`origem_vinculo`** (`SNAPSHOT_MIGRACAO` \| `INCLUSAO_ADMIN` \| `CONVITE`);<br>• `snapshot_id` (rastreabilidade), `suspenso_em/por/motivo`, `janela`/`silencio` (jsonb validado), `notificar_correcao`.<br>`CHECK`: `LEGACY_ACTIVE` só com `categoria = 'pendencia_d1'`. Único `(contato_empresa_id, unidade_id, categoria)` |
| **Snapshot dos vínculos legados** (D-16) | `comunicacao_legado_snapshot` | **NOVA, imutável** (trigger de imutabilidade; `service_role` só `SELECT, INSERT`). Uma linha por destinatário × empresa × unidade abrangida pela configuração anterior, gravada **na mesma transação da ativação da nova seleção**. Campos:<br>• `id`, `migracao_id`, `migrado_em`, `contato_empresa_id`, `organizacao_id`, `unidade_id`;<br>• origem: `autorizacao_registrada_em/por` (104) e `contato_whatsapp_id`;<br>• estado de envio no momento: `ativo`, `whatsapp_status`, opt-out, habilitação e envio automático da empresa;<br>• `hash_linha`.<br>É a prova do que a migração reconheceu. Nunca é editada; a mudança posterior fica no escopo + auditoria |
| **Convite** | `comunicacao_convites` | **NOVA**: `token_hash`, empresa, unidades e categorias pretendidas, `criado_por`, `expira_em`, `status` |
| **Desafio OTP / sessão do titular** | `comunicacao_desafios_titular` | **NOVA**: `tipo` (`verificacao`/`gestao`), `telefone_e164` (ou hash, decisão D-4), `codigo_hmac`, `tentativas`, `expira_em`, `consumido_em`, `invalidado_em`, `ultimo_envio_em`, `ip_hash` |
| **Consentimento** | `comunicacao_consentimentos` | **NOVA**, append-only (doc 05 §4.1) |
| **Termos** | `comunicacao_termos` | **NOVA**, versões imutáveis |
| Fuso/horário da unidade | `unidades.timezone`, `unidades.horario_funcionamento` (jsonb) | **Colunas novas** (sem tabela nova) |
| Mensagens, tentativas, alertas | `comunicacao_mensagens`/`_tentativas`/`_alertas` | **Reaproveita.** Fechamento = `alerta_id null`, `tipo = fechamento_operacional_diario`, `metadados.fonte = {fechamento_id, versao}`, chave única existente (`idempotency_key`) |
| Simulações do fechamento | `operacional_mensagens_simuladas` (130) | **Reaproveita** como histórico de simulação. O envio real vai para `comunicacao_mensagens` |

Total: **6 tabelas novas** (5 + o snapshot imutável do D-16) e colunas em 2 existentes. As alternativas descartadas (tabela de preferências separada do escopo, tabela de histórico de vínculo) foram absorvidas pelo escopo (com `updated_at` e auditoria) e pelo livro-razão.

## 2. Segurança no banco (padrão 129/130/131)

- **RLS** ligado em todas as tabelas novas, **sem policy**. `anon`/`authenticated` sem nenhum privilégio. Acesso só pelo backend (`service_role`), como toda a comunicação hoje (082: `revoke all … from authenticated, anon`).
- **`service_role`** só com o necessário:
  - livro-razão e termos: `SELECT, INSERT` (sem UPDATE/DELETE), com trigger de imutabilidade (padrão `operacional_registro_imutavel`);
  - desafios: `SELECT, INSERT` + UPDATE **por coluna** (`tentativas`, `consumido_em`, `invalidado_em`, `ultimo_envio_em`);
  - escopos/convites: CRUD **sem TRUNCATE**.
- Toda RPC com `SECURITY INVOKER` + `search_path` fixo + EXECUTE só para `service_role`. A exceção é o **consumo do desafio**, que pode ser `SECURITY DEFINER` com validação interna (como `operacional_fechamento_registrar`) para garantir atomicidade.
- **Coerência de tenant** por trigger: a unidade do escopo pertence à empresa do destinatário (padrão `operacional_validar_tenant`). A FK composta impede um escopo de destinatário de outra empresa.

## 3. Acesso por perfil — **D-3 APROVADA (30/10/2026)**

### 3.1 Permissões

| Permissão (nova) | Papéis |
|---|---|
| `notificacoes.ver` | organization_admin, unit_manager, finance (finance só leitura) |
| `notificacoes.gerenciar` | organization_admin (unidades a que tem acesso); **unit_manager (exclusivamente a própria unidade)** |
| Painel ADM (`requirePainelAdministrativo`) | equipe Crescer: visão cross-tenant, suspensão, registro de pedido do titular, apoio à adesão voluntária. **Não** autoriza destinatário novo por atestado |

Hoje o `unit_manager` não tem `configuracoes.gerenciar` (`permissoes.js`). Por isso `notificacoes.gerenciar` é uma **permissão própria**, que não amplia o que ele altera nas demais seções de Configurações.

### 3.2 Matriz (ação × papel)

Legenda: ✔ permitido · U = só na própria unidade · L = só leitura · ✘ negado.

| Ação | Admin da empresa | Gerente da unidade | Finance | Viewer / Operations | Titular (sem conta) |
|---|---|---|---|---|---|
| Ver destinatários, estados e pendências | ✔ (unidades com acesso) | U | L | ✘ | — |
| Ver número completo | ✔ só no formulário de edição (D-4) | U, idem | ✘ | ✘ | o próprio |
| Gerar convite (OTP) | ✔ | U | ✘ | ✘ | — |
| Configurar categorias e horários do escopo | ✔, ≤ consentimento | U, ≤ consentimento | ✘ | ✘ | restringe as próprias |
| Suspender / reativar escopo | ✔ | U | ✘ | ✘ | — |
| Remover vínculo com a unidade | ✔ | U | ✘ | ✘ | sai da unidade/empresa |
| Incluir legado em unidade **nova**, só D-1 | ✔ | U (a unidade dele) | ✘ | ✘ | — |
| Editar nome/papel do destinatário | ✔ | U **só se o destinatário não tiver escopo em outra unidade** | ✘ | ✘ | — |
| Trocar o número de um destinatário | ✘ (troca de número = destinatário novo + convite) | ✘ | ✘ | ✘ | — |
| Registrar pedido de revogação do titular | ✔ (escopo da empresa) | U (efeito só no escopo da unidade) | ✘ | ✘ | revoga tudo pelo link |
| Confirmar consentimento pelo titular | **✘ para todos** | ✘ | ✘ | ✘ | **só o titular** |
| Reativar consentimento revogado | **✘ para todos** | ✘ | ✘ | ✘ | **só o titular**, por novo aceite (OTP + texto) |
| Consultar histórico de mensagens | ✔ | U | L | ✘ | — |
| Consultar auditoria de notificações | ✔ (escopo da empresa) | U | ✘ | ✘ | — |

### 3.3 Onde cada regra é garantida

A interface **não** é fonte de segurança: tudo vale no backend **e** no banco.

| Restrição | Backend | Banco |
|---|---|---|
| Sem acesso entre empresas | `req.tenant.organizacaoId` em toda consulta; ids de outra empresa → 404 | FK composta `(contato_empresa_id, organizacao_id)` + trigger de coerência unidade ↔ empresa |
| Sem acesso indevido entre unidades | vínculo de **unidade** na sessão → filtro obrigatório `unidade_id = vínculo`; rotas aceitam só ids (nunca organização/unidade vindos do navegador) | RPCs de escrita recebem `p_unidade_permitida` (nulo só para vínculo de empresa) e recusam escopo fora dela (`42501`) |
| Número compartilhado não afeta outras unidades | o gerente edita só **escopos** da unidade; nome/papel só se o destinatário for exclusivo da unidade; o número é imutável no lugar | `comunicacao_contatos_empresa.telefone_e164` sem UPDATE para `service_role` após verificado (trigger); `contatos_whatsapp` (global) nunca é escrito por rota de gestor |
| Ninguém consente pelo titular nem reativa revogação | não existe rota de gestor que grave `CONCEDIDO` | `INSERT` de `CONCEDIDO` só pela RPC do titular, que exige desafio OTP consumido **e** `termo_hash` vigente; a RPC de gestor só aceita `acao = 'REVOGADO'` |
| Legado só D-1 | API recusa outra categoria | `CHECK (origem_autorizacao <> 'LEGACY_ACTIVE' or categoria = 'pendencia_d1')` |
| Auditoria das alterações sensíveis | `auditar()` em toda escrita (convite, escopo, suspensão, vínculo legado, pedido de revogação) | ver §3.4 |

### 3.4 Auditoria por unidade (sem quebrar a transferência)

- A auditoria vai para `plataforma_auditoria` (020: imutável, sem FK, `organizacao_id` e `perfil_id`), com a **unidade em `detalhes.unidade_id`** e índice de expressão `((detalhes->>'unidade_id'))` para filtro.
- **Não** se adiciona coluna `unidade_id` à tabela. Uma tabela imutável com `organizacao_id + unidade_id` entraria no remapeamento da transferência (054) e quebraria a transferência inteira, o mesmo defeito da 131.
- A rota de leitura para gestores (`GET /notificacoes/auditoria`):
  - filtra por empresa da sessão + entidades de notificação + unidade (quando o vínculo é de unidade);
  - devolve só data, ação, autor (nome/perfil), alvo mascarado e motivo;
  - **nunca** devolve IP, user-agent, e-mail de terceiros ou número completo.
- Eventos:
  - `NOTIFICACAO_CONVITE_CRIADO`;
  - `NOTIFICACAO_ESCOPO_ALTERADO`;
  - `NOTIFICACAO_ESCOPO_SUSPENSO`/`REATIVADO`;
  - `NOTIFICACAO_VINCULO_INCLUIDO`/`REMOVIDO` (legado D-1);
  - `NOTIFICACAO_REVOGACAO_REGISTRADA`;
  - `NOTIFICACAO_SELECAO_ATIVADA` (M3, com contagens e hash do snapshot);
  - `NOTIFICACAO_DESTINATARIO_EDITADO`.

- **Escopo de unidade no backend:** toda rota resolve `req.tenant`. Se o vínculo do usuário é de **unidade**, ele só vê e altera escopos daquela unidade. Destinatários com escopo também em outras unidades aparecem com o número mascarado e sem as ações que afetariam as outras unidades.
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
- **Snapshot do D-16 na transferência:** `comunicacao_legado_snapshot` também entra na lista de exclusão do remapeamento. Por ser imutável, o remapeamento quebraria a transferência; além disso, o snapshot registra o que valia **na empresa de origem** e deve continuar assim. O escopo legado da unidade transferida é suspenso pelo gatilho (acima), e a nova empresa não herda o legado.

## 4.1 Unidades criadas depois da migração (D-16, APROVADA)

- **Não herdam** destinatários legados: a nova seleção só lê escopos com `unidade_id` explícito.
- Aparecem na Central como **pendência**: "Nenhum destinatário configurado para o Dashboard iFood D-1". A rota de resumo da Central calcula isso: unidades ativas da empresa sem escopo habilitado de `pendencia_d1`.
- **Vincular um legado a uma unidade nova** é ação explícita de quem tem `notificacoes.gerenciar` na empresa (ou na unidade, conforme D-3):
  - cria escopo `LEGACY_ACTIVE`, `categoria = pendencia_d1`, `origem_vinculo = INCLUSAO_ADMIN`;
  - motivo obrigatório;
  - auditoria `NOTIFICACAO_VINCULO_INCLUIDO`;
  - **não** altera o snapshot.
- Remover vínculo: escopo `habilitado = false` + auditoria `NOTIFICACAO_VINCULO_REMOVIDO`, sem apagar o histórico.
- Só funciona para destinatário que **já é** `LEGACY_ACTIVE` na mesma empresa, e só para o D-1. Qualquer outra categoria exige o fluxo OTP + consentimento (regras 7 e 8).

## 5. Testes de isolamento exigidos (Etapa 5)

1. Usuário de unidade A1 não lista, não altera e não convida em A2. Usuário da empresa B não vê nada de A (404).
2. Escopo com unidade de outra empresa é recusado pelo banco (FK composta + trigger).
3. `anon`/`authenticated` sem privilégio em todas as tabelas novas (PostgREST real, como no doc 04 do Dashboard 2.0).
4. A transferência de unidade com escopos funciona (sem FK quebrada), suspende os escopos e não move consentimentos. Provar no harness `testes-seguros/pg` com a cadeia real da `main`.
5. As rotas públicas do titular: anti-enumeração (mesma resposta e tempo), limites, replay, concorrência no consumo do OTP (duas sessões reais no Postgres).
