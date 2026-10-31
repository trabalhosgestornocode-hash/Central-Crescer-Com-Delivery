# 31 — Piloto da Central na unidade Subway Saci, trava por unidade e SAIR (Frente A)

Estado: **tudo desligado**. Esta entrega é código + testes + plano; nada foi aplicado em produção, nenhuma variável foi alterada.

## 1. O que foi implementado (branch `feat/central-piloto-unidade-sair`)
| Item | Como | Prova |
|---|---|---|
| **Trava de convites por unidade, no backend** | `exigirUnidadeDoPiloto` antes de qualquer leitura/gravação: lê a chave `convites_unidades_piloto`; **fail-closed por padrão** (sem a chave ninguém convida; `NOTIFICACOES_CONVITES_EXIGE_PILOTO=false` só para disponibilidade geral); lista vazia/inválida = ninguém | testes: piloto configurado/ausente/vazio/misto/maiúsculas, gerente de outra unidade, parsing do repositório |
| **Trava no banco** (migration **139**, não aplicada) | gatilho `BEFORE INSERT` em `comunicacao_convites`; mesma fonte (chave de `comunicacao_configuracoes`); ausente = sem restrição, presente = só as unidades listadas; vazio/objeto/elemento não-uuid = ninguém; só INSERT (nada existente é tocado); a migration **não liga** o piloto | PG descartável **23/23** (`piloto_139.sh`), rollback e rollback idempotente |
| **Allowlist por número obrigatória** | OTP **e** confirmação do SAIR recusam sem lista (`ALLOWLIST_OBRIGATORIA`) e fora dela; `NOTIFICACOES_OTP_BAILEYS_EXIGE_ALLOWLIST=false` (disponibilidade geral) é decisão própria | testes (lista ausente/ inválida / fora da lista) |
| **SAIR pelo WhatsApp (revogação)** | palavra exata (SAIR, PARAR, STOP, DESCADASTRAR — "cancelar" saiu por ser ambígua); mensagem ≤ 48 h; só número já cadastrado; idempotente (se já saiu de tudo, não grava nem confirma de novo); 1 processamento/10 min por número; auditoria por empresa sem telefone; **confirmação ao titular** só com `NOTIFICACOES_SAIR_CONFIRMACAO=true` + transporte baileys autorizado + lista; falha da confirmação nunca desfaz a revogação | 9 testes + PG: revogação isolada por número (2 empresas no mesmo contato de WhatsApp; outro número e a fila do D-1 intactos) |
| **Fluxo completo em ambiente isolado** | convite → OTP (Baileys simulado: 1 envio) → verificação (≠ consentimento) → termo aprovado → categorias → SAIR (confirmação) → auditoria sem número nem código | 1 teste de ponta a ponta |

Por padrão **nada novo é ativado**: `NOTIFICACOES_PALAVRA_CHAVE_SAIR` e `NOTIFICACOES_SAIR_CONFIRMACAO` seguem desligadas; OTP e convites desligados; M3 e corte do fuso desligados; LEGACY_ACTIVE preservado; D-1 e gateway intactos.

## 2. Piloto: Subway Saci
- Unidade: **Subway Saci — Matriz** (ativa, não é de teste). Vínculos hoje: 1 administrador da empresa, 1 gerente de unidade, 1 conta de TV de checklist e o perfil do responsável pelo sistema. O vínculo dos destinatários do D-1 é no nível da **empresa** (M3 desligada), então o piloto **não muda quem recebe o D-1**.
- **Depende de confirmação sua (bloqueios operacionais):** (1) o **gestor autorizado** do piloto (recomendo o gerente da unidade: só ele convida, e só para a própria unidade; o administrador da empresa também enxerga a empresa toda, mas a trava barra qualquer unidade fora do piloto); (2) os **números de teste** (E.164) que entram na lista; (3) o **termo v2 aprovado e publicado** (doc 30) — sem ele o consentimento é recusado e o piloto não fecha o ciclo.

## 3. Sequência de ativação do piloto (cada passo com autorização própria; reversão = desfazer o passo)
1. **Migration 139** em produção (gatilho). Reversão: `139_rollback.sql`.
2. **Dado**: `insert into comunicacao_configuracoes (chave, valor) values ('convites_unidades_piloto', '["<id da Subway Saci — Matriz>"]')`. Reversão: `delete` da chave (volta a "sem piloto" → o backend continua exigindo piloto por padrão).
3. **Termo v2** publicado (doc 30). Reversão: não se apaga (imutável); correção = versão 3.
4. **Render, num salvamento**: `NOTIFICACOES_OTP_TRANSPORTE=baileys`, `NOTIFICACOES_OTP_BAILEYS_AUTORIZADO=true`, `NOTIFICACOES_OTP_BAILEYS_ALLOWLIST_E164=<números de teste>`, `NOTIFICACOES_OTP_MAX_HORA=5`, `NOTIFICACOES_OTP_MAX_DIA=10`, `NOTIFICACOES_CONVITES_HABILITADOS=true` (e, se aprovado, `NOTIFICACOES_PALAVRA_CHAVE_SAIR=true` + `NOTIFICACOES_SAIR_CONFIRMACAO=true`). Reversão: remover/zerar as variáveis.
5. **Execução**: o gestor convida os números de teste → código chega → verificação → termo → categorias → 1 notificação autorizada → testar **SAIR** com um número de teste → conferir auditoria e reservas.
**Critérios de sucesso:** 0 `FALHOU/INCERTO` inesperados; hash dos 41 destinatários e fila do D-1 idênticos; nenhum convite fora da unidade piloto (testar uma tentativa para outra unidade: deve dar 403); SAIR revoga só o número testado.

## 4. Riscos conhecidos e mitigações
- `RATE_LIMIT` do D-1 (Frente B) não bloqueia o piloto, mas telefones repetidos entre empresas podem receber vários avisos/dia: o piloto usa só números de teste.
- O SAIR revoga **todas** as empresas que cadastraram o número e marca opt-out do contato de WhatsApp (também para o D-1): é o efeito de "sair de tudo" já previsto; deve constar no termo (cláusula 5).
- Palavras de saída em canal de operação: lista curta e exata para evitar revogação indevida; ampliar só com decisão jurídica (JUR-6).
